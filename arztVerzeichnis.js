// Ärzteverzeichnis: Zu einem Arzt / einer Praxis stehen hier die Angaben, die in der Terminliste oft fehlen –
// Fachrichtung, Gebäude / genauer Standort (z. B. „Uniklinik Bonn, Gebäude 22“), Hinweis zum Weg und ein Karten-Link.
// Beim Senden eines Auftrags werden sie von selbst in den Abschnitt „ARZT / PRAXIS“ geschrieben.
// Gespeichert auf diesem Gerät und – über cloudSettingsSync.js – für das ganze Büro in der Datenbank.
const ArztVerzeichnis = (() => {
    const STORAGE = 'terminTool.doctorDirectory.v1';
    const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
    // „Dr. med. Ritter“, „Prof. Dr. Ritter“ und „Ritter“ sind derselbe Arzt.
    const TITLES = /\b(prof|professor|dr|med|dent|rer|nat|phil|habil|priv|doz|pd|dipl|psych|herr|frau|univ|mult|h\s?c)\b\.?/g;
    const normName = value => text(value).toLocaleLowerCase('de').replace(TITLES, ' ').replace(/[.,;:()\/\\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    // Vom Ort zählt nur der Name der Stadt („53127 Bonn“ → „bonn“, „Bonn-Venusberg“ → „bonn venusberg“).
    const normCity = value => text(value).toLocaleLowerCase('de').replace(/\b\d{4,5}\b/g, ' ').replace(/[.,;:()\/\\-]+/g, ' ').replace(/\s+/g, ' ').trim();
    const keyOf = (name, city) => `${normName(name)}|${normCity(city)}`;

    function read() {
        try {
            const list = JSON.parse(localStorage.getItem(STORAGE) || '[]');
            return Array.isArray(list) ? list.filter(item => item && normName(item.name)) : [];
        } catch (error) { return []; }
    }
    function write(list) {
        const sorted = [...list].sort((left, right) => text(left.name).localeCompare(text(right.name), 'de') || text(left.city).localeCompare(text(right.city), 'de'));
        try { localStorage.setItem(STORAGE, JSON.stringify(sorted)); } catch (error) { return false; }
        return true;
    }

    const clean = entry => ({
        name: text(entry.name), city: text(entry.city), specialty: text(entry.specialty), building: text(entry.building),
        hint: text(entry.hint), map: /^https?:\/\//i.test(text(entry.map)) ? text(entry.map) : '',
        source: text(entry.source), updated: entry.updated || new Date().toISOString()
    });
    const complete = entry => Boolean(entry && text(entry.specialty));

    // Passender Eintrag: erst Name + Stadt, sonst ein Eintrag mit demselben Namen ohne Stadt, sonst der einzige mit diesem Namen.
    function find(name, city, list = read()) {
        const wanted = normName(name);
        if (!wanted) return null;
        const same = list.filter(item => normName(item.name) === wanted);
        if (!same.length) return null;
        const town = normCity(city);
        return same.find(item => normCity(item.city) === town)
            || same.find(item => town && normCity(item.city) && (town.includes(normCity(item.city)) || normCity(item.city).includes(town)))
            || same.find(item => !normCity(item.city))
            || (same.length === 1 && !town ? same[0] : null);
    }

    function save(entry, previousKey) {
        const next = clean({ ...entry, updated: new Date().toISOString() });
        if (!normName(next.name)) return false;
        const id = keyOf(next.name, next.city);
        const list = read().filter(item => { const key = keyOf(item.name, item.city); return key !== id && key !== previousKey; });
        return write([...list, next]);
    }
    const remove = key => write(read().filter(item => keyOf(item.name, item.city) !== key));

    // Zeilen für den Auftrag: [Bezeichnung, Angabe]
    function messageFields(name, city, list) {
        const entry = find(name, city, list);
        if (!entry) return [];
        return [['Fachrichtung', entry.specialty], ['Gebäude / Standort', entry.building], ['Hinweis zum Weg', entry.hint], ['Karte', entry.map]].filter(([, value]) => value);
    }

    // Ärzte aus Terminlisten, zu denen die Fachrichtung noch fehlt – jeder nur einmal, die häufigsten zuerst.
    function missing(records, list = read()) {
        const found = new Map();
        (records || []).forEach(record => {
            const name = text([record['Arzt Nr::Vorname'], record['Arzt Nr::Name']].filter(Boolean).join(' '));
            const city = text(record['Arzt Nr::Ort'] || record['Arzt Nr::Stadt'] || '');
            if (!normName(name)) return;
            const id = keyOf(name, city);
            const known = find(name, city, list);
            if (complete(known)) return;
            const item = found.get(id) || { key: id, name, city, street: text(record['Arzt Nr::Strasse']), zip: text(record['Arzt Nr::PLZ']), count: 0, entry: known };
            item.count += 1;
            if (!item.street) item.street = text(record['Arzt Nr::Strasse']);
            if (!item.zip) item.zip = text(record['Arzt Nr::PLZ']);
            found.set(id, item);
        });
        return [...found.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'de'));
    }

    const addressOf = item => [item.street, [item.zip, item.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const searchUrl = item => `https://www.google.com/search?q=${encodeURIComponent([item.name, addressOf(item) || item.city, 'Fachrichtung'].filter(Boolean).join(' '))}`;

    // Liste zum Recherchieren (für die KI): eine Zeile je Arzt – ohne Patienten, ohne Termine.
    const exportText = items => items.map(item => [item.name, item.city, addressOf({ ...item, city: '' })].map(text).join(' | ')).join('\n');

    // Ergebnis einlesen: eine Zeile je Arzt „Name | Ort | Fachrichtung | Gebäude / Standort | Hinweis zum Weg | Karten-Link“.
    function parseImport(raw) {
        return String(raw || '').split(/\r\n|\n|\r/).map(line => line.trim()).filter(line => line && line.includes('|') && !/^name\s*\|/i.test(line) && !/^[\s|:-]+$/.test(line))
            .map(line => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(text))
            .map(([name, city, specialty, building, hint, map]) => clean({ name, city, specialty, building, hint, map, source: 'Recherche' }))
            .filter(entry => normName(entry.name) && (entry.specialty || entry.building || entry.hint || entry.map));
    }
    function importEntries(entries) {
        const byKey = new Map(read().map(item => [keyOf(item.name, item.city), item]));
        entries.forEach(entry => byKey.set(keyOf(entry.name, entry.city), entry));
        return write([...byKey.values()]) ? entries.length : 0;
    }

    // Zwei Stände zusammenführen (dieses Gerät ↔ Datenbank): je Arzt gilt der neuere Eintrag.
    function merge(local, remote) {
        const byKey = new Map();
        [...(Array.isArray(remote) ? remote : []), ...(Array.isArray(local) ? local : [])].forEach(item => {
            if (!item || !normName(item.name)) return;
            const id = keyOf(item.name, item.city);
            const other = byKey.get(id);
            if (!other || String(item.updated || '') >= String(other.updated || '')) byKey.set(id, item);
        });
        return [...byKey.values()].sort((left, right) => text(left.name).localeCompare(text(right.name), 'de') || text(left.city).localeCompare(text(right.city), 'de'));
    }

    return { STORAGE, normName, normCity, keyOf, read, write, find, save, remove, complete, messageFields, missing, addressOf, searchUrl, exportText, parseImport, importEntries, merge };
})();

if (typeof module !== 'undefined') module.exports = ArztVerzeichnis;
