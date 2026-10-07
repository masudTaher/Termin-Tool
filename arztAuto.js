// Ärzte & Standorte von selbst: Fehlt zu einem Arzt aus den Terminlisten die Fachrichtung, wird sie – mit Gebäude und
// genauem Standort – im Internet gesucht (KI mit Websuche über die Server-Funktion) und ins Verzeichnis eingetragen.
// Gesendet werden nur Name und Adresse des Arztes, nie Patienten oder Termine. Läuft auf den Büro-Seiten im Hintergrund.
const ArztAuto = (() => {
    const STAMP_KEY = 'terminTool.doctorAuto.v1';
    const EVERY_MS = 5 * 60 * 1000;            // höchstens alle 5 Minuten nachsehen
    const OFF_MS = 6 * 60 * 60 * 1000;         // Suche nicht eingerichtet: erst in 6 Stunden wieder fragen
    const BATCH = 3;                           // Ärzte je Aufruf
    const MAX_BATCHES = 4;                     // je Durchlauf
    let running = false;
    let state = 'unbekannt';                   // 'aktiv' | 'aus' | 'unbekannt'
    const enabled = () => !window.__noDoctorAuto;
    const readStamp = () => { try { return JSON.parse(localStorage.getItem(STAMP_KEY) || '{}') || {}; } catch (error) { return {}; } };
    const writeStamp = value => { try { localStorage.setItem(STAMP_KEY, JSON.stringify(value)); } catch (error) { /* dann beim nächsten Laden */ } };
    const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const shift = days => { const date = new Date(); date.setDate(date.getDate() + days); return iso(date); };

    async function run(force) {
        if (!enabled() || running || typeof TerminCloud === 'undefined' || !TerminCloud.client || typeof ArztVerzeichnis === 'undefined') return state;
        const stamp = readStamp();
        if (stamp.off && Date.now() - stamp.off < OFF_MS && !force) { state = 'aus'; return state; }
        if (!force && stamp.at && Date.now() - stamp.at < EVERY_MS) return state;
        running = true;
        try {
            writeStamp({ ...stamp, at: Date.now() });
            const { data, error } = await TerminCloud.client.from('tt_days').select('date,records').gte('date', shift(-1)).lte('date', shift(14));
            if (error) return state;
            const records = data.flatMap(day => Array.isArray(day.records) ? day.records : []);
            for (let round = 0; round < MAX_BATCHES; round += 1) {
                const items = ArztVerzeichnis.toLookUp(records).slice(0, BATCH);
                if (!items.length) break;
                const answer = await TerminCloud.callFunction({ action: 'doctorInfo', doctors: items.map(item => ({ name: item.name, city: item.city, street: item.street, zip: item.zip })) });
                if (!answer.ok) break;
                if (answer.data?.configured === false) { state = 'aus'; writeStamp({ at: Date.now(), off: Date.now() }); break; }
                state = 'aktiv';
                writeStamp({ at: Date.now() });
                if ((answer.data?.results || []).every(result => result.error)) break;
                ArztVerzeichnis.applyLookUp(items, answer.data.results);
                window.renderDoctorDirectory?.();
                window.syncSettingsNow?.();
            }
        } catch (error) { /* beim nächsten Mal */ } finally { running = false; }
        return state;
    }

    return { run, enabled, state: () => state };
})();
