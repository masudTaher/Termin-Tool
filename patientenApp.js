// Patienten und Unterlagen: Eingang neuer Unterlagen, Archiv je Patient, Berichte der Dolmetscher
// und das Weiterleiten per E-Mail oder WhatsApp – mit allen Angaben zum Patienten in der Nachricht.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const BUCKET = 'dokumente';
    const REPORT_KIND = 'Dolmetscherbericht';
    // Arten von Unterlagen (wie im Portal) – ältere Bezeichnungen werden der heutigen Art zugeordnet.
    const KIND_ALIAS = { 'Überweisung MRT / CT / Röntgen': 'Überweisung Radiologie' };
    const kindKey = kind => { const text = String(kind ?? '').trim(); return KIND_ALIAS[text] || text; };
    const ALL_KINDS = [...new Set([...((window.TERMIN_CLOUD_CONFIG || {}).documentKinds || ['Arztbericht', 'Rezept Medikamente', 'Rezept Physiotherapie', 'Rezept Hilfsmittel', 'Überweisung Facharzt', 'Überweisung Radiologie', 'Sonstiges']), REPORT_KIND])];
    const RECIPIENT_KEY = 'document_recipients';
    const LINK_SECONDS = 60 * 60 * 24 * 7;      // Links in der Nachricht gelten 7 Tage
    const MAIL_LIMIT = 1800;                    // längere Texte nimmt nicht jedes E-Mail-Programm über „mailto:“ an
    const PAGE_SIZE = 1000;                     // so viele Zeilen liefert die Datenbank höchstens auf einmal
    const LIST_STEP = 60;
    const DAY_RANGE = 120;                      // Termine der letzten 120 Tage
    const ORGANISATION = 'Botschaft Katar · Medical Office Bonn · Abteilung Transport und Dolmetscher';
    const SIGNATURE = 'Medical Office Bonn · Transport und Dolmetscher';
    // „archiv“: aus einer eingelesenen Papierakte – steht nur in der Akte, nicht im Eingang.
    const DOC_STATUS = { neu: ['offen', 'Neu'], 'geprüft': ['in Arbeit', 'Geprüft'], weitergeleitet: ['erledigt', 'Weitergeleitet'], archiv: ['bekannt', 'Papierakte'] };
    // Geladen wird ohne den erkannten Text (text_content): Mit ganzen Papierakten wäre er für alle Unterlagen zusammen zu groß –
    // die Suche im Text läuft dann in der Datenbank (Update 29). Kennt die Datenbank die Spalten der Papierakte noch nicht,
    // wird wie früher alles geladen (fullText) und hier auf der Seite gesucht.
    const COLUMNS = 'id, created_at, patient_nr, patient_name, patient_birth, date, doctor, appointment_id, assignment_id, kind, note, body, pages, file_path, file_bytes, warnings, uploader_id, uploader_name, status, checked_at, checked_by, forwarded_at, forwarded_to, forwarded_by, replaced_by, edited_at, title, specialty, import_id, original_path, enhanced_at';
    const ORDER_KEY = 'terminTool.akte.order';
    const HANDOVER_KEY = 'terminTool.akte.patient';      // Übergabe an „Papierakte einlesen“ (bleibt in diesem Tab, steht nicht in der Adresse)
    const VISIT_STATUS = { offen: ['bekannt', 'offen'], losgefahren: ['in Arbeit', 'unterwegs'], beendet: ['erledigt', 'beendet'], alleine: ['erledigt', 'Patient ging alleine'], storniert: ['offen', 'storniert'] };
    let profile = null;
    let documents = [];
    let patients = [];
    let recipients = [];
    let fullText = false;          // true: Die Datenbank kennt Update 29 noch nicht – der Text der Unterlagen ist mitgeladen.
    // Vier Ansichten derselben Daten:
    //   berichte – Seite „Neue Berichte“ (Dolmetscher- und Krankenhausberichte): prüfen, weiterleiten
    //   rezepte  – Seite „Neue Rezepte“ (Rezepte, Überweisungen, Sonstiges – nach Kategorie)
    //   archiv   – Seite „Patientenakten“: nur die Patienten; ein Klick öffnet die ganze Akte
    //   alles    – die frühere Gesamtseite (patienten.html?ansicht=alles), bleibt als Reserve
    const VIEW = new URLSearchParams(location.search).get('ansicht') === 'alles' ? 'alles' : (document.body.dataset.view || 'alles');
    document.body.dataset.view = VIEW;
    const INBOX = VIEW === 'berichte' || VIEW === 'rezepte';
    let filter = VIEW === 'archiv' ? 'patienten' : 'neu';
    let shown = LIST_STEP;
    let openKey = '';              // geöffnete Akte: Patientennummer (ohne Nummer: „name:…“)
    let returnTop = null;          // Handy: Stelle der Seite, von der aus die Akte geöffnet wurde
    let daysPromise = null;        // Tagesstände, einmal je Seitenaufruf geladen
    const selected = new Set();    // angekreuzte Unterlagen (id)

    // ---------- Kleine Helfer ----------
    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };
    const clean = value => String(value ?? '').trim();
    const lower = value => clean(value).toLocaleLowerCase('de');
    const isReport = doc => doc.kind === REPORT_KIND;
    const isBericht = doc => isReport(doc) || kindKey(doc.kind) === 'Arztbericht';
    const inView = doc => VIEW === 'berichte' ? isBericht(doc) : VIEW === 'rezepte' ? !isBericht(doc) : true;
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    const isoDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    // „2026-10-05“ → „05.10.2026“ (ohne Umrechnung zwischen Zeitzonen)
    const formatDay = value => {
        const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
        return match ? `${match[3]}.${match[2]}.${match[1]}` : '';
    };
    const formatStamp = value => value ? new Date(value).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    // Tag einer Unterlage: ihr Datum – sonst der Tag, an dem sie hochgeladen wurde. Ein Schriftstück aus der Papierakte ohne Datum
    // hat keinen Tag (der Tag des Einlesens sagt nichts über das Schriftstück).
    const docDay = doc => clean(doc.date).slice(0, 10) || (doc.status === 'archiv' || doc.import_id ? '' : doc.created_at ? isoDay(new Date(doc.created_at)) : '');
    // Patienten erkennt die Seite an der Nummer; fehlt sie, am Namen.
    const patientKey = doc => clean(doc.patient_nr) || (clean(doc.patient_name) ? `name:${lower(doc.patient_name)}` : '');
    const patientLabel = doc => [clean(doc.patient_nr) ? `Patient ${clean(doc.patient_nr)}` : '', clean(doc.patient_name)].filter(Boolean).join(' · ');
    // Überschrift einer Unterlage: aus der Papierakte „Arztbericht · Prof. Dr. Goldbach · Neurochirurgie“, sonst die Art.
    const docTitle = doc => clean(doc.title) || doc.kind || 'Sonstiges';
    const isImported = doc => doc.status === 'archiv' || Boolean(doc.import_id);
    const isPdf = doc => !doc.file_path || /\.pdf$/i.test(clean(doc.file_path));
    // Vom Handy fotografiert und noch nicht nachträglich aufbereitet („Scan verbessern“ ist möglich)
    const canFix = doc => Boolean(window.ScanFix) && !fullText && Boolean(doc.file_path) && !doc.replaced_by && !isImported(doc) && !doc.original_path;
    const kindLabel = kind => (window.AkteLogic ? AkteLogic.byKind(kindKey(kind))?.label : '') || kindKey(kind);
    // Überschrift, wie sie von selbst entsteht: Art · Arzt · Fachrichtung.
    function autoTitle({ kind, doctor, specialty }) {
        const label = kindLabel(kind) || 'Unterlage';
        return [label, clean(doctor), clean(specialty) && !label.includes(clean(specialty)) ? clean(specialty) : ''].filter(Boolean).join(' · ');
    }
    // Fachrichtung: wie eingetragen – sonst aus dem Ärzteverzeichnis, wenn der Arzt dort mit Fachrichtung steht.
    let directoryCache = null;
    function specialtyOf(doc) {
        if (clean(doc.specialty)) return clean(doc.specialty);
        if (!window.ArztVerzeichnis || !clean(doc.doctor)) return '';
        try { directoryCache = directoryCache || ArztVerzeichnis.read(); return clean(ArztVerzeichnis.find(doc.doctor, '', directoryCache)?.specialty); } catch (error) { return ''; }
    }
    const surname = doctor => lower(doctor).replace(/\b(prof|dr|med|dent|pd)\b\.?/g, ' ').replace(/[,/].*$/, '').trim().split(/\s+/).pop() || '';
    const byDay = (left, right) => docDay(right).localeCompare(docDay(left)) || String(right.created_at).localeCompare(String(left.created_at));

    function setStatus(message, kind = 'info') {
        const status = $('patientStatus');
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    function pill(status, text) {
        const node = el('span', 'status-pill', text);
        node.dataset.status = status;
        return node;
    }

    function button(className, text, onClick) {
        const node = el('button', className, text);
        node.type = 'button';
        node.addEventListener('click', () => onClick(node));
        return node;
    }

    // Hinweis in einem Dialog (Einblendungen lägen hinter dem abgedunkelten Hintergrund).
    // Fehler und Erfolg rollen ins Bild – auf dem Handy ist der Dialog höher als der Bildschirm.
    function dialogStatus(id, message, kind = 'info') {
        const status = $(id);
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
        if (message && kind !== 'info') status.scrollIntoView({ block: 'nearest' });
    }

    // ---------- Laden ----------
    // Alle Unterlagen, neueste zuerst – in Blöcken, weil die Datenbank höchstens 1000 Zeilen auf einmal liefert.
    async function loadDocuments() {
        for (const columns of [COLUMNS, '*']) {
            const rows = [];
            let failed = null;
            for (let from = 0; ; from += PAGE_SIZE) {
                const { data, error } = await client.from('tt_documents').select(columns)
                    .order('created_at', { ascending: false }).order('id').range(from, from + PAGE_SIZE - 1);
                if (error) { failed = error; break; }
                rows.push(...data);
                if (data.length < PAGE_SIZE) break;
            }
            if (!failed) { fullText = columns === '*'; return { data: rows }; }
            // Spalten der Papierakte fehlen noch (Update 29)? Dann wie früher alles laden.
            if (columns === '*' || !/column|schema cache/i.test(String(failed.message || ''))) return { error: failed };
        }
        return { error: new Error('Die Unterlagen konnten nicht geladen werden.') };
    }

    // Gespeicherte Empfänger (tt_settings, Schlüssel „document_recipients“). null = Liste nicht lesbar.
    async function loadRecipients() {
        const { data, error } = await client.from('tt_settings').select('*').eq('key', RECIPIENT_KEY).maybeSingle();
        if (error) return null;
        return (Array.isArray(data?.value?.list) ? data.value.list : [])
            .map(item => ({ name: clean(item?.name), email: clean(item?.email), kinds: [...new Set((Array.isArray(item?.kinds) ? item.kinds : []).map(kindKey).filter(Boolean))] }))
            .filter(item => item.email);
    }

    // Tagesstände der letzten 120 Tage – einmal je Seitenaufruf („Aktualisieren“ lädt sie neu). null = nicht lesbar.
    function loadDays() {
        if (!daysPromise) {
            const from = new Date();
            from.setDate(from.getDate() - DAY_RANGE);
            daysPromise = Promise.resolve(client.from('tt_days').select('date, records').gte('date', isoDay(from)).order('date', { ascending: false }))
                .then(result => result.error || !Array.isArray(result.data) ? null : result.data, () => null);
        }
        return daysPromise;
    }

    async function refresh() {
        setStatus('');
        if (!client) { $('patientApp').hidden = true; setStatus('Die Verbindung zur Datenbank konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu.', 'error'); return; }
        try { profile = await TerminCloud.getProfile(true); } catch (error) { setStatus(error.message, 'error'); return; }
        if (!TerminCloud.isStaff(profile)) {
            $('patientApp').hidden = true;
            setStatus('Bitte melde dich zuerst auf der Seite „Team“ als Einsatzleitung an.', 'error');
            return;
        }
        let result;
        let recipientList;
        try {
            [result, recipientList] = await Promise.all([loadDocuments(), loadRecipients(), window.PhotoRequest ? PhotoRequest.load().catch(() => []) : null]);
        } catch (error) {
            result = { error };
        }
        if (result.error) {
            const missing = /does not exist|could not find the table|schema cache/i.test(String(result.error.message || ''));
            setStatus(missing ? 'Die Tabelle für die Unterlagen fehlt noch in der Datenbank. Bitte supabase/update-10.sql im SQL Editor ausführen.' : TerminCloud.germanError(result.error), 'error');
            return;
        }
        documents = result.data;
        directoryCache = null;
        textQuery = ''; textHits = null;
        recipients = recipientList;
        patients = buildPatients();
        const ids = new Set(documents.map(doc => doc.id));
        [...selected].forEach(id => { if (!ids.has(id)) selected.delete(id); });
        $('patientApp').hidden = false;
        render();
        window.refreshCloudInbox?.();
    }

    // ---------- Patienten aus den Unterlagen ableiten ----------
    function buildPatients() {
        const map = new Map();
        documents.forEach(doc => {      // neueste zuerst: Es gilt die jüngste Schreibweise des Namens.
            const key = patientKey(doc);
            if (!key) return;
            let patient = map.get(key);
            if (!patient) map.set(key, patient = { key, nr: clean(doc.patient_nr), name: '', birth: '', names: new Set(), days: new Set(), documents: [], reports: [], last: '' });
            if (!patient.birth) patient.birth = clean(doc.patient_birth);
            if (docDay(doc)) patient.days.add(docDay(doc));
            if (!patient.name) patient.name = clean(doc.patient_name);
            if (clean(doc.patient_name)) patient.names.add(lower(doc.patient_name));
            (isReport(doc) ? patient.reports : patient.documents).push(doc);
            if (docDay(doc) > patient.last) patient.last = docDay(doc);
        });
        // Nach Nummer geordnet (4103 vor 10200); Patienten ohne Nummer stehen am Ende.
        return [...map.values()].sort((left, right) => Boolean(left.nr) !== Boolean(right.nr) ? (left.nr ? -1 : 1)
            : left.nr.localeCompare(right.nr, 'de', { numeric: true }) || left.name.localeCompare(right.name, 'de'));
    }

    // Steht „word“ als eigenes Wort im Text? Zahlen in einem Datum oder einer Uhrzeit (05.10.2026, 9:30) zählen nicht.
    function hasWord(text, word) {
        const edge = /[\p{L}\p{N}]/u;
        for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + 1)) {
            const before = text.slice(Math.max(0, at - 2), at);
            const after = text.slice(at + word.length, at + word.length + 2);
            if (edge.test(before.slice(-1)) || edge.test(after.slice(0, 1))) continue;
            if (/\d[.:,/-]$/.test(before) || /^[.:,/-]\d/.test(after)) continue;
            return true;
        }
        return false;
    }

    // Nennt ein Bericht diesen Patienten? Entweder ist er ihm zugeordnet, oder im Text steht
    // die Patientennummer (ab drei Zeichen) bzw. der ganze Name.
    function mentions(doc, patient) {
        if (patientKey(doc) === patient.key) return true;
        const text = lower(`${doc.body || ''}\n${doc.note || ''}`);
        if (patient.nr.length >= 3 && hasWord(text, lower(patient.nr))) return true;
        const words = lower(patient.name).split(/[\s,]+/).filter(word => word.length > 1);
        return words.length > 1 && words.every(word => hasWord(text, word));
    }

    // Termine eines Patienten aus den Tagesständen: neuester Tag zuerst, innerhalb des Tages nach Uhrzeit.
    const visitTime = record => (typeof normalizeTerminUhrzeit === 'function' ? normalizeTerminUhrzeit(record.Termin_Uhrzeit) : clean(record.Termin_Uhrzeit)).slice(0, 5);
    function visitsFor(days, nr) {
        const visits = [];
        days.forEach(day => (Array.isArray(day.records) ? day.records : []).forEach(record => {
            if (record && clean(record.Patient_Nr) === nr) visits.push({ date: clean(day.date), record });
        }));
        return visits.sort((left, right) => right.date.localeCompare(left.date) || visitTime(left.record).localeCompare(visitTime(right.record)));
    }

    // ---------- Filterkacheln ----------
    const FILTERS = {
        neu: doc => doc.status === 'neu',
        'geprüft': doc => doc.status === 'geprüft',
        weitergeleitet: doc => doc.status === 'weitergeleitet',
        berichte: isReport
    };
    const SUMMARY = {
        neu: count => count ? `${plural(count, 'neuer Eingang', 'neue Eingänge')} – ansehen, prüfen und weiterleiten.` : 'Alles erledigt – es gibt nichts Neues.',
        'geprüft': count => count ? `${count} geprüft und noch nicht weitergeleitet.` : 'Nichts wartet auf das Weiterleiten.',
        weitergeleitet: count => count ? `${count} weitergeleitet.` : 'Noch nichts weitergeleitet.',
        berichte: count => count ? `${plural(count, 'Bericht', 'Berichte')} der Dolmetscher über ihren Tag.` : 'Noch keine Berichte der Dolmetscher.',
        patienten: count => count ? `${plural(count, 'Patient', 'Patienten')} mit Unterlagen – ein Tipp öffnet die Akte.` : 'Noch keine Patienten mit Unterlagen.'
    };
    const EMPTY = {
        neu: 'Keine neuen Unterlagen.',
        'geprüft': 'Keine geprüften Unterlagen, die noch weitergeleitet werden müssen.',
        weitergeleitet: 'Es wurde noch nichts weitergeleitet.',
        berichte: 'Es gibt noch keine Berichte der Dolmetscher.',
        patienten: 'Sobald Dolmetscher Unterlagen hochladen, erscheinen die Patienten hier.'
    };

    // ---------- Reiter nach Art: alle Unterlagen einer Art, egal ob neu, geprüft oder weitergeleitet ----------
    // '' = Eingang (dann gelten die Kacheln oben). Unter „Rezepte“ und „Überweisungen“ gibt es Kategorien.
    let typeTab = '';
    let subKind = '';
    const startsWith = prefix => doc => !isReport(doc) && kindKey(doc.kind).startsWith(prefix);
    const TYPE_TABS = {
        berichte: { test: isReport, one: 'Bericht', many: 'Berichte', text: 'der Dolmetscher – selbst geschrieben nach dem Termin.', empty: 'Es gibt noch keine Berichte der Dolmetscher.' },
        arzt: { test: doc => !isReport(doc) && kindKey(doc.kind) === 'Arztbericht', one: 'Krankenhausbericht', many: 'Krankenhausberichte', text: '(Arztbericht, Befund, Entlassbericht) – hochgeladen von den Dolmetschern.', empty: 'Es wurde noch kein Krankenhaus- oder Arztbericht hochgeladen.' },
        rezepte: { test: startsWith('Rezept'), prefix: 'Rezept', one: 'Rezept', many: 'Rezepte', text: '– wähle unten eine Kategorie.', empty: 'Es wurde noch kein Rezept hochgeladen.' },
        ueberweisung: { test: startsWith('Überweisung'), prefix: 'Überweisung', one: 'Überweisung', many: 'Überweisungen', text: '– wähle unten eine Kategorie.', empty: 'Es wurde noch keine Überweisung hochgeladen.' },
        sonstiges: { test: doc => !isReport(doc) && kindKey(doc.kind) !== 'Arztbericht' && !/^(Rezept|Überweisung)/.test(kindKey(doc.kind)), one: 'sonstige Unterlage', many: 'sonstige Unterlagen', text: '', empty: 'Keine sonstigen Unterlagen.' }
    };
    // In „Neue Berichte“ / „Neue Rezepte“ gelten Kachel (neu, geprüft, weitergeleitet) UND Reiter zusammen.
    const VIEW_TABS = { berichte: ['', 'berichte', 'arzt'], rezepte: ['', 'rezepte', 'ueberweisung', 'sonstiges'] }[VIEW] || null;
    const base = () => INBOX ? documents.filter(inView).filter(FILTERS[filter] || (() => true)) : documents;
    const typeRows = () => base().filter(typeTab ? TYPE_TABS[typeTab].test : () => true).filter(doc => !subKind || kindKey(doc.kind) === subKind);
    function renderTypeTabs() {
        document.querySelectorAll('[data-doc-type]').forEach(tab => {
            const name = tab.dataset.docType;
            const active = name === typeTab;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', String(active));
            const badge = tab.querySelector('b');
            tab.hidden = VIEW === 'archiv' || Boolean(VIEW_TABS && !VIEW_TABS.includes(name));
            if (!name && INBOX) tab.firstChild.textContent = 'Alle ';
            if (badge) badge.textContent = name ? String(base().filter(TYPE_TABS[name].test).length) : (INBOX ? String(base().length) : '');
        });
        // Kategorien: alle bekannten Arten mit diesem Anfang – und alles, was sonst noch so heißt.
        const box = $('docSubKinds');
        const prefix = typeTab ? TYPE_TABS[typeTab].prefix : '';
        box.hidden = !prefix;
        if (!prefix) return;
        const inTab = base().filter(TYPE_TABS[typeTab].test);
        const kinds = [...new Set([...ALL_KINDS.filter(kind => kind.startsWith(prefix)), ...inTab.map(doc => kindKey(doc.kind))])];
        const chip = (value, label, count) => {
            const node = button('recipient-chip', `${label} (${count})`, () => { subKind = value; shown = LIST_STEP; renderTypeTabs(); renderList(); updateSelection(); });
            node.dataset.subKind = value;
            node.setAttribute('aria-pressed', String(subKind === value));
            return node;
        };
        box.replaceChildren(chip('', `Alle ${TYPE_TABS[typeTab].many}`, inTab.length),
            ...kinds.map(kind => chip(kind, kind.slice(prefix.length).trim() || kind, inTab.filter(doc => kindKey(doc.kind) === kind).length)));
    }

    function renderTiles() {
        const count = name => String(documents.filter(inView).filter(FILTERS[name]).length);
        $('countNew').textContent = count('neu');
        $('countChecked').textContent = count('geprüft');
        $('countForwarded').textContent = count('weitergeleitet');
        $('countReports').textContent = count('berichte');
        $('countPatients').textContent = String(patients.length);
        document.querySelectorAll('[data-doc-filter]').forEach(tile => {
            const active = (INBOX || !typeTab) && tile.dataset.docFilter === filter;
            tile.classList.toggle('is-active', active);
            tile.setAttribute('aria-pressed', String(active));
        });
    }

    // ---------- Eine Unterlage als Listeneintrag (im Eingang und in der Akte gleich) ----------
    // Hinweise der automatischen Prüfung: Fehlt etwas, ist der Hinweis rot, sonst gelb.
    const warningPill = text => pill(/fehl|unvollständig|leer/i.test(text) ? 'offen' : 'in Arbeit', text);
    const excerpt = (text, length) => {
        const flat = clean(text).replace(/\s+/g, ' ');
        return flat.length > length ? `${flat.slice(0, length).trimEnd()} …` : flat;
    };

    function docEntry(doc, inList) {
        const row = el('li', 'vehicle-entry doc-entry');
        row.dataset.docId = doc.id;
        const check = el('label', 'doc-check');
        const box = el('input');
        box.type = 'checkbox';
        box.checked = selected.has(doc.id);
        box.setAttribute('aria-label', `${doc.kind || 'Unterlage'} auswählen`);
        box.addEventListener('change', () => toggleSelected(doc.id, box.checked));
        check.append(box);

        const meta = el('span', 'doc-meta');
        const head = el('span', 'doc-head');
        const [statusColor, statusText] = DOC_STATUS[doc.status] || ['bekannt', doc.status || '–'];
        head.append(el('strong', null, docTitle(doc)), pill(statusColor, statusText));
        if (doc.replaced_by) head.append(pill('bekannt', 'ersetzt durch neue Aufnahme'));
        if (doc.enhanced_at) head.append(pill('erledigt', 'Scan verbessert'));
        const requestPill = window.PhotoRequest?.pill(doc.id);
        if (requestPill) head.append(requestPill);
        meta.append(head);
        // Ein Tipp auf den Patienten öffnet seine Akte. In der Akte selbst steht er schon in der Überschrift –
        // dort erscheint die Zeile nur, wenn es um einen anderen Patienten geht.
        if (patientLabel(doc) && (inList || patientKey(doc) !== openKey)) {
            const link = button('doc-patient', patientLabel(doc), () => openPatient(patientKey(doc)));
            link.title = 'Akte öffnen';
            meta.append(link);
        }
        // Zweite Zeile: Art (wenn die Überschrift sie nicht nennt), Datum, Arzt und Fachrichtung (wenn sie nicht schon in der Überschrift stehen).
        const imported = isImported(doc);
        const title = lower(docTitle(doc));
        const said = text => !clean(text) || title.includes(lower(text));
        const visit = [
            clean(doc.title) && !said(doc.kind) && !said(kindLabel(doc.kind)) ? kindLabel(doc.kind) : '',
            doc.date ? `${imported ? 'Schriftstück vom' : isReport(doc) ? 'Bericht vom' : 'Termin'} ${formatDay(doc.date)}` : (imported ? 'ohne Datum' : ''),
            said(doc.doctor) ? '' : clean(doc.doctor), said(specialtyOf(doc)) ? '' : specialtyOf(doc)
        ].filter(Boolean).join(' · ');
        if (visit) meta.append(el('small', null, visit));
        meta.append(el('small', null, [
            imported ? `Aus der Papierakte · eingelesen von ${clean(doc.uploader_name) || 'unbekannt'} am ${formatStamp(doc.created_at)}`
                : `${isReport(doc) ? 'Geschrieben' : 'Fotografiert'} von ${clean(doc.uploader_name) || 'unbekannt'} am ${formatStamp(doc.created_at)}`,
            doc.pages ? plural(doc.pages, 'Seite', 'Seiten') : ''
        ].filter(Boolean).join(' · ')));
        if (isReport(doc) && clean(doc.body)) meta.append(el('span', 'doc-note', excerpt(doc.body, 200)));
        if (clean(doc.note)) meta.append(el('span', 'doc-note', clean(doc.note).startsWith('Nächster Termin: ') ? clean(doc.note) : `Hinweis: ${clean(doc.note)}`));
        const warnings = (Array.isArray(doc.warnings) ? doc.warnings : []).map(clean).filter(Boolean);
        if (warnings.length) {
            const wrap = el('span', 'doc-warnings');
            wrap.append(...warnings.map(warningPill));
            meta.append(wrap);
        }
        if (doc.edited_at) meta.append(el('small', 'doc-edited', `Vom Dolmetscher geändert am ${formatStamp(doc.edited_at)}`));
        // Aus der Papierakte: geprüft wurde beim Einlesen – das steht schon in der Zeile darüber.
        if (doc.checked_at && !imported) meta.append(el('small', null, `Geprüft am ${formatStamp(doc.checked_at)}${clean(doc.checked_by) ? ` von ${clean(doc.checked_by)}` : ''}`));
        if (doc.forwarded_at) meta.append(el('small', null, `Weitergeleitet am ${formatStamp(doc.forwarded_at)}${clean(doc.forwarded_to) ? ` an ${clean(doc.forwarded_to)}` : ''}${clean(doc.forwarded_by) ? ` (${clean(doc.forwarded_by)})` : ''}`));

        const actions = el('span', 'vehicle-entry-actions');
        actions.append(
            button('button-secondary fleet-end-button', 'Öffnen', node => openDocument(doc, node)),
            button('button-secondary fleet-end-button', 'Herunterladen', node => downloadDocument(doc, node))
        );
        // Drucken: Berichte der Dolmetscher (auch ohne Datei) und alles aus der Papierakte.
        if (isReport(doc) || (imported && doc.file_path && isPdf(doc))) actions.append(button('button-secondary fleet-end-button doc-print', 'Drucken', node => printDocument(doc, node)));
        if (doc.status === 'neu') actions.append(button('button-primary fleet-end-button', 'Geprüft ✓', node => markChecked(doc, node)));
        actions.append(button(`${doc.status === 'geprüft' ? 'button-primary' : 'button-secondary'} fleet-end-button`, 'Weiterleiten', () => startForward([doc])));
        // Unscharf, zu dunkel, Seite fehlt? Die Person, die fotografiert hat, um eine neue Aufnahme bitten.
        if (window.PhotoRequest && !isReport(doc) && !imported && doc.file_path && doc.uploader_id) {
            actions.append(PhotoRequest.button({
                kind: 'unterlage', refId: doc.id, profileId: doc.uploader_id, profileName: clean(doc.uploader_name), bucket: 'dokumente', paths: [doc.file_path],
                title: [doc.kind, patientLabel(doc)].filter(Boolean).join(' · '),
                picked: warnings.filter(text => /fehlt|dunkel|unscharf|überbelichtet|klein|Schrift|lesbar|abgeschnitten/i.test(text)),
                context: { patient_nr: clean(doc.patient_nr), patient_name: clean(doc.patient_name), doctor: clean(doc.doctor), date: doc.date || '', kind: doc.kind || '', assignment_id: doc.assignment_id || null, appointment_id: doc.appointment_id || null }
            }, render));
        }
        // Fotografierte Unterlagen nachträglich aufbereiten (zuschneiden, gerade rücken, weißes Papier) – das Original bleibt erhalten.
        if (window.ScanFix && !fullText && doc.file_path && !doc.replaced_by && doc.original_path) actions.append(button('button-quiet doc-restore', 'Original wiederherstellen', node => restoreOriginal(doc, node)));
        else if (canFix(doc)) actions.append(button('button-quiet doc-fix', 'Scan verbessern', () => ScanFix.open(doc, { profile, fileName: fileName(doc), onDone: refresh })));
        actions.append(button('button-quiet', 'Korrigieren', () => editDocument(doc)), button('button-quiet-danger', 'Löschen', node => deleteDocument(doc, node)));
        row.append(check, meta, actions);
        return row;
    }

    const fillList = (id, nodes, emptyText) => $(id).replaceChildren(...(nodes.length ? nodes : [el('li', 'directory-empty', emptyText)]));

    // ---------- Abschnitt „Unterlagen“: Liste zum gewählten Filter oder alle Patienten ----------
    function renderList() {
        renderTypeTabs();
        const showPatients = !typeTab && filter === 'patienten';
        $('docList').hidden = showPatients;
        $('patientList').hidden = !showPatients;
        if (showPatients) {
            $('docSummary').textContent = SUMMARY.patienten(patients.length);
            $('patientList').replaceChildren(...(patients.length ? patients.slice(0, shown).map(patient => patientCard(patient)) : [el('p', 'directory-empty', EMPTY.patienten)]));
            $('docMore').hidden = patients.length <= shown;
            return;
        }
        const tab = typeTab ? TYPE_TABS[typeTab] : null;
        const rows = tab || INBOX ? typeRows() : documents.filter(FILTERS[filter]);
        $('docSummary').textContent = tab
            ? (rows.length ? `${plural(rows.length, tab.one, tab.many)}${subKind ? ` · ${subKind}` : ` ${tab.text}`}`.trim() : (subKind ? `Keine Unterlagen in „${subKind}“.` : tab.empty))
            : INBOX ? (rows.length ? `${plural(rows.length, 'Unterlage', 'Unterlagen')} – ${{ neu: 'neu: ansehen, prüfen und weiterleiten', 'geprüft': 'geprüft, noch nicht weitergeleitet', weitergeleitet: 'weitergeleitet' }[filter]}.` : EMPTY[filter]) : SUMMARY[filter](rows.length);
        fillList('docList', rows.slice(0, shown).map(doc => docEntry(doc, true)), tab ? (subKind ? `Keine Unterlagen in „${subKind}“.` : tab.empty) : EMPTY[filter]);
        $('docMore').hidden = rows.length <= shown;
    }

    // ---------- Patientenkarten und Suche ----------
    function patientCard(patient, hint) {
        const card = el('button', `patient-card${patient.key === openKey ? ' is-active' : ''}`);
        card.type = 'button';
        card.dataset.patient = patient.key;
        card.append(
            el('strong', null, patient.nr || 'Ohne Nummer'),
            el('span', null, patient.name || 'Name nicht angegeben'),
            el('small', null, [plural(patient.documents.length, 'Unterlage', 'Unterlagen'), patient.reports.length ? plural(patient.reports.length, 'Bericht', 'Berichte') : ''].filter(Boolean).join(' · ')),
            el('small', null, patient.last ? `Zuletzt am ${formatDay(patient.last)}` : '')
        );
        if (VIEW === 'archiv') {
            // Von außen nur der Patient – alles Weitere steht in der Akte.
            card.classList.add('patient-card-plain');
            const initials = (patient.name || patient.nr || '?').split(/[\s,]+/).filter(Boolean).slice(0, 2).map(word => word[0].toLocaleUpperCase('de')).join('');
            card.replaceChildren(el('i', 'patient-avatar', initials), el('span', 'patient-card-text'));
            card.lastChild.append(el('strong', null, patient.name || 'Name nicht angegeben'), el('small', null, patient.nr ? `Akte ${patient.nr}` : 'ohne Nummer'));
        }
        if (patient.birth && VIEW !== 'archiv') card.querySelector('span').after(el('small', 'patient-birth', `geb. ${patient.birth}`));
        if (hint) card.append(el('em', 'chip chip-brand', hint));
        card.addEventListener('click', () => openPatient(patient.key));
        return card;
    }

    // Jedes Suchwort muss in Nummer oder Name vorkommen; ab drei Zeichen zählt auch der erkannte Text der Unterlagen.
    // Ein Datum (06.10., 06.10.2026 oder 6.10.26) findet Patienten nach Geburtsdatum oder nach dem Tag ihrer Unterlagen und Berichte.
    function searchByDate(query) {
        const match = query.trim().match(/^(\d{1,2})\.(\d{1,2})\.?(\d{2}|\d{4})?$/);
        if (!match) return null;
        const day = match[1].padStart(2, '0');
        const month = match[2].padStart(2, '0');
        const year = match[3] ? (match[3].length === 2 ? (Number(match[3]) > new Date().getFullYear() % 100 ? `19${match[3]}` : `20${match[3]}`) : match[3]) : '';
        const hits = [];
        patients.forEach(patient => {
            const birth = patient.birth.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
            const born = birth && birth[1] === day && birth[2] === month && (!match[3] || birth[3] === year || (match[3].length === 2 && birth[3].slice(2) === match[3]));
            const onDay = [...patient.days].some(iso => iso.slice(8, 10) === day && iso.slice(5, 7) === month && (!year || iso.slice(0, 4) === year || (match[3].length === 2 && iso.slice(2, 4) === match[3])));
            if (born) hits.push({ patient, rank: 0, inText: false, hint: 'Geburtsdatum' });
            else if (onDay) hits.push({ patient, rank: 1, inText: false, hint: `Unterlagen vom ${day}.${month}.` });
        });
        return hits.sort((left, right) => left.rank - right.rank || left.patient.nr.localeCompare(right.patient.nr, 'de', { numeric: true }));
    }

    // Treffer im erkannten Text der Unterlagen: Die Datenbank sucht (Update 29) und nennt die Patienten; hier steht das letzte Ergebnis.
    let textQuery = '';            // Suchtext, zu dem textHits gehört
    let textHits = null;           // Patienten (Schlüssel) mit Treffer im Text
    let textTimer = 0;
    let textRun = 0;
    function searchInText(phrase) {
        window.clearTimeout(textTimer);
        const run = ++textRun;
        textTimer = window.setTimeout(async () => {
            let rows = [];
            try { const { data, error } = await client.rpc('tt_document_search', { p_query: phrase }); rows = error ? [] : data || []; } catch (error) { rows = []; }
            if (run !== textRun || lower($('patientSearch').value) !== phrase) return;      // inzwischen wurde weitergetippt
            textQuery = phrase;
            textHits = new Set(rows.map(row => clean(row.patient_nr) || (clean(row.patient_name) ? `name:${lower(row.patient_name)}` : '')).filter(Boolean));
            renderSearch();
        }, 350);
    }
    const textPending = phrase => !fullText && phrase.length >= 3 && textQuery !== phrase;

    function searchPatients(query) {
        const dated = searchByDate(query);
        if (dated) return dated;
        const phrase = lower(query);
        const words = phrase.split(/\s+/).filter(Boolean);
        const hits = [];
        const inText = patient => phrase.length >= 3 && ([...patient.documents, ...patient.reports].some(doc => lower(doc.text_content).includes(phrase) || lower(doc.body).includes(phrase) || lower(doc.title).includes(phrase) || lower(doc.specialty).includes(phrase))
            || (textQuery === phrase && Boolean(textHits?.has(patient.key))));
        patients.forEach(patient => {
            const own = [lower(patient.nr), ...patient.names].join(' ');
            if (words.every(word => own.includes(word))) hits.push({ patient, rank: lower(patient.nr) === phrase ? 0 : lower(patient.nr).startsWith(phrase) ? 1 : 2, inText: false });
            else if (inText(patient)) hits.push({ patient, rank: 3, inText: true });
        });
        return hits.sort((left, right) => left.rank - right.rank);
    }

    function renderSearch() {
        const query = clean($('patientSearch').value);
        $('patientApp').classList.toggle('is-searching', Boolean(query));
        if (!query) {
            $('patientResults').replaceChildren();
            $('searchInfo').textContent = patients.length ? `${plural(patients.length, 'Patient', 'Patienten')} im Archiv. Tippe Nummer, Namen, Geburtsdatum oder einen Tag ein (z. B. 06.10.2026).` : 'Im Archiv gibt es noch keine Patienten.';
            return;
        }
        const hits = searchPatients(query);
        // Der Text der Unterlagen wird in der Datenbank durchsucht – das Ergebnis kommt einen Augenblick später dazu.
        const waiting = !searchByDate(query) && textPending(lower(query));
        if (waiting) searchInText(lower(query));
        $('searchInfo').textContent = !hits.length ? (waiting ? 'Der Text der Unterlagen wird durchsucht …' : 'Kein Patient gefunden. Prüfe die Nummer oder die Schreibweise.')
            : `${hits.length} Treffer${hits.length > 30 ? ' – die ersten 30 werden gezeigt. Tippe mehr Zeichen ein.' : ''}${waiting ? ' · der Text der Unterlagen wird noch durchsucht …' : ''}`;
        $('patientResults').replaceChildren(...hits.slice(0, 30).map(hit => patientCard(hit.patient, hit.hint || (hit.inText ? 'Treffer im Text' : ''))));
    }

    // ---------- Patientenakte ----------
    function visitEntry({ date, record }) {
        const row = el('li', 'vehicle-entry file-entry visit-entry');
        const [color, text] = VISIT_STATUS[lower(record.Status) || 'offen'] || ['bekannt', clean(record.Status)];
        const place = [clean(record['Arzt Nr::Name']), clean(record.Termin_Ort) || clean(record['Arzt Nr::Ort']) || clean(record.Ort) || clean(record.Stadt)].filter(Boolean).join(' · ');
        const meta = el('span');
        meta.append(
            el('strong', null, [formatDay(date), visitTime(record) ? `${visitTime(record)} Uhr` : ''].filter(Boolean).join(' · ')),
            el('small', null, place || 'Ort nicht angegeben'),
            el('small', null, `Dolmetscher/in: ${clean(record['Übersetzer']) || 'noch nicht eingeteilt'}`)
        );
        row.append(pill(color, text), meta);
        return row;
    }

    // ---------- Patientenakte im Archiv: Kopf mit Stammdaten, Reiter je Bereich, Übersicht als Zeitleiste ----------
    let chartTab = 'uebersicht';
    let chartVisits = null;        // Termine der offenen Akte (null = lädt noch)
    let chartReported = null;      // von Dolmetschern gemeldete neue Termine
    let chartViews = [];           // Abrufe der Akte durch Dolmetscher (tt_document_access), neueste zuerst
    let chartFor = '';
    // „Befunde“ und „Kosten“ kommen aus eingelesenen Papierakten – die Reiter erscheinen nur, wenn es dort etwas gibt.
    const CHART_TABS = [['uebersicht', 'Übersicht'], ['termine', 'Termine'], ['berichte', 'Dolmetscherberichte'], ['arzt', 'Krankenhausberichte'], ['befunde', 'Befunde'], ['rezepte', 'Rezepte'], ['ueberweisung', 'Überweisungen'], ['kosten', 'Kosten'], ['sonstiges', 'Sonstiges']];
    const CHART_EMPTY = { berichte: 'Kein Bericht eines Dolmetschers nennt diesen Patienten.', arzt: 'Für diesen Patienten gibt es noch keinen Krankenhaus- oder Arztbericht.', befunde: 'Keine Befunde (Labor, Bildgebung).',
        rezepte: 'Für diesen Patienten gibt es noch kein Rezept.', ueberweisung: 'Für diesen Patienten gibt es noch keine Überweisung.', kosten: 'Keine Rechnungen oder Kostenvoranschläge.', sonstiges: 'Keine sonstigen Unterlagen.' };
    const isBefund = doc => !isReport(doc) && kindKey(doc.kind).startsWith('Befund');
    const isKosten = doc => !isReport(doc) && kindKey(doc.kind).startsWith('Kosten');
    // Ordnen innerhalb der Akte: nach Datum (neueste zuerst), nach Fachrichtung oder nach Arzt – die Wahl bleibt gemerkt.
    const CHART_ORDERS = [['datum', 'Datum'], ['fach', 'Fachrichtung'], ['arzt', 'Arzt']];
    let chartOrder = (() => { try { const saved = localStorage.getItem(ORDER_KEY); return CHART_ORDERS.some(([key]) => key === saved) ? saved : 'datum'; } catch (error) { return 'datum'; } })();
    // Unterlagen eines Reiters in Abschnitten: [{ title, docs }] – je nach Ordnung nach Kategorie, Fachrichtung oder Arzt.
    function chartSections(docs, prefix) {
        const sorted = [...docs].sort(byDay);
        const grouped = (pick, missing, compare) => {
            const map = new Map();
            sorted.forEach(doc => { const key = pick(doc) || missing; if (!map.has(key)) map.set(key, []); map.get(key).push(doc); });
            return [...map.keys()].sort((left, right) => (left === missing) - (right === missing) || compare(left, right)).map(key => ({ title: `${key} (${map.get(key).length})`, docs: map.get(key) }));
        };
        if (chartOrder === 'fach') return grouped(specialtyOf, 'Ohne Fachrichtung', (left, right) => left.localeCompare(right, 'de'));
        if (chartOrder === 'arzt') return grouped(doc => clean(doc.doctor), 'Ohne Arzt', (left, right) => surname(left).localeCompare(surname(right), 'de') || left.localeCompare(right, 'de'));
        // nach Datum: Rezepte, Überweisungen, Befunde und Kosten bleiben nach Kategorie getrennt (Medikamente, Physiotherapie …)
        if (prefix && new Set(sorted.map(doc => kindKey(doc.kind))).size > 1) return grouped(doc => kindKey(doc.kind).slice(prefix.length).trim() || kindKey(doc.kind), 'Sonstiges', (left, right) => left.localeCompare(right, 'de'));
        if (prefix && sorted.length) return [{ title: `${kindKey(sorted[0].kind).slice(prefix.length).trim() || kindKey(sorted[0].kind)} (${sorted.length})`, docs: sorted }];
        return [{ title: '', docs: sorted }];
    }
    // Eingelesene Papierakten dieses Patienten: je Einlesen eine Zeile (lässt sich im Ganzen zurücknehmen).
    function importsOf(patient) {
        const map = new Map();
        [...patient.documents, ...patient.reports].forEach(doc => {
            if (!doc.import_id) return;
            const item = map.get(doc.import_id) || { id: doc.import_id, docs: [], pages: 0, at: doc.created_at, by: clean(doc.uploader_name) };
            item.docs.push(doc); item.pages += Number(doc.pages || 0);
            if (String(doc.created_at) < String(item.at)) item.at = doc.created_at;
            map.set(doc.import_id, item);
        });
        return [...map.values()].sort((left, right) => String(right.at).localeCompare(String(left.at)));
    }
    function renderChart(patient) {
        const box = $('fileChart');
        const reports = documents.filter(doc => isReport(doc) && mentions(doc, patient));
        const parts = { berichte: reports, arzt: patient.documents.filter(TYPE_TABS.arzt.test), befunde: patient.documents.filter(isBefund), rezepte: patient.documents.filter(TYPE_TABS.rezepte.test),
            ueberweisung: patient.documents.filter(TYPE_TABS.ueberweisung.test), kosten: patient.documents.filter(isKosten), sonstiges: patient.documents.filter(doc => TYPE_TABS.sonstiges.test(doc) && !isBefund(doc) && !isKosten(doc)) };
        if ((chartTab === 'befunde' || chartTab === 'kosten') && !parts[chartTab].length) chartTab = 'uebersicht';
        const today = isoDay(new Date());
        const visits = chartVisits || [];
        const reported = chartReported || [];
        const coming = [...visits.filter(visit => visit.date >= today).map(visit => `${visit.date} ${visitTime(visit.record)}`), ...reported.filter(item => item.date >= today).map(item => `${item.date} ${clean(item.time).slice(0, 5)}`)].sort()[0];
        const counts = { termine: visits.length + reported.length, berichte: parts.berichte.length, arzt: parts.arzt.length, befunde: parts.befunde.length, rezepte: parts.rezepte.length, ueberweisung: parts.ueberweisung.length, kosten: parts.kosten.length, sonstiges: parts.sonstiges.length };

        // Kopf
        const head = el('div', 'chart-head');
        const initials = (patient.name || patient.nr || '?').split(/[\s,]+/).filter(Boolean).slice(0, 2).map(word => word[0].toLocaleUpperCase('de')).join('');
        const id = el('div', 'chart-id');
        id.append(el('span', 'chart-kicker', 'Patientenakte'), el('strong', 'chart-name', patient.name || 'Name nicht angegeben'),
            el('span', 'chart-sub', [patient.nr ? `Patienten-Nr. ${patient.nr}` : 'ohne Patientennummer', patient.birth ? `geb. ${patient.birth}` : ''].filter(Boolean).join(' · ')));
        const facts = el('dl', 'chart-facts');
        const fact = (label, value) => { const item = el('div'); item.append(el('dt', null, label), el('dd', null, value)); facts.append(item); };
        fact('Nächster Termin', chartVisits == null ? '…' : coming ? `${formatDay(coming.slice(0, 10))}${coming.slice(11) ? ` · ${coming.slice(11)} Uhr` : ''}` : 'keiner bekannt');
        fact('Letzter Eintrag', patient.last ? formatDay(patient.last) : '–');
        fact('Unterlagen', String(patient.documents.length));
        fact('Berichte', String(reports.length));
        head.append(el('i', 'patient-avatar chart-avatar', initials), id, facts);
        // Papierakte dieses Patienten einlesen: Nummer, Name und Geburtsdatum gehen mit (im Speicher dieses Tabs, nicht in der Adresse).
        const importButton = button('button-secondary chart-import', 'Papierakte einlesen', () => {
            try { sessionStorage.setItem(HANDOVER_KEY, JSON.stringify({ nr: patient.nr, name: patient.name, birth: patient.birth })); } catch (error) { /* dann eben von Hand eintragen */ }
            window.location.href = 'akteEinlesen.html';
        });
        importButton.title = 'Die Papierakte dieses Patienten als Scan-Datei einlesen und sortiert in diese Akte legen';
        head.append(importButton);

        // Reiter
        const tabs = el('div', 'doc-type-tabs chart-tabs');
        tabs.setAttribute('role', 'tablist');
        CHART_TABS.forEach(([key, label]) => {
            if ((key === 'befunde' || key === 'kosten') && !counts[key]) return;
            const tab = button(key === chartTab ? 'is-active' : '', label, () => { chartTab = key; renderChart(patient); updateSelection(); });
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', String(key === chartTab));
            tab.dataset.chartTab = key;
            if (key !== 'uebersicht') tab.append(el('b', null, key === 'termine' && chartVisits == null ? '…' : String(counts[key])));
            tabs.append(tab);
        });

        // Inhalt
        const body = el('div', 'chart-body');
        const list = (docs, empty) => { const node = el('ul', 'directory-list file-list'); node.append(...(docs.length ? docs.map(doc => docEntry(doc, false)) : [el('li', 'directory-empty', empty)])); return node; };
        const reportedEntry = item => {
            const row = el('li', 'vehicle-entry file-entry visit-entry');
            const meta = el('span');
            meta.append(el('strong', null, [formatDay(item.date), clean(item.time) ? `${clean(item.time).slice(0, 5)} Uhr` : ''].filter(Boolean).join(' · ')),
                el('small', null, [clean(item.place), clean(item.city), clean(item.doctor)].filter(Boolean).join(' · ') || 'Ort nicht angegeben'),
                el('small', null, [clean(item.description), `gemeldet von ${clean(item.reporter_name) || 'unbekannt'}`].filter(Boolean).join(' · ')));
            row.append(pill(item.status === 'eingetragen' ? 'erledigt' : 'in Arbeit', item.status === 'eingetragen' ? 'gemeldet · eingetragen' : 'gemeldet · neu'), meta);
            return row;
        };
        if (chartTab === 'uebersicht') {
            // Alles in einer Zeitleiste, das Neueste oben: Termine, Berichte, Rezepte, Überweisungen.
            const events = [
                ...visits.map(visit => ({ day: visit.date, kind: 'Termin', tab: 'termine', text: [visitTime(visit.record) ? `${visitTime(visit.record)} Uhr` : '', clean(visit.record['Arzt Nr::Name']), clean(visit.record['Übersetzer']) ? `mit ${clean(visit.record['Übersetzer'])}` : ''].filter(Boolean).join(' · ') })),
                ...reported.map(item => ({ day: item.date, kind: 'Neuer Termin', tab: 'termine', text: [clean(item.time) ? `${clean(item.time).slice(0, 5)} Uhr` : '', clean(item.place), clean(item.description)].filter(Boolean).join(' · ') })),
                ...[...patient.documents, ...reports].map(doc => ({ day: docDay(doc), kind: docTitle(doc), tab: isReport(doc) ? 'berichte' : TYPE_TABS.arzt.test(doc) ? 'arzt' : isBefund(doc) ? 'befunde' : TYPE_TABS.rezepte.test(doc) ? 'rezepte' : TYPE_TABS.ueberweisung.test(doc) ? 'ueberweisung' : isKosten(doc) ? 'kosten' : 'sonstiges',
                    text: [lower(docTitle(doc)).includes(lower(doc.doctor)) ? '' : clean(doc.doctor), isReport(doc) ? excerpt(doc.body, 90) : clean(doc.note), isImported(doc) ? 'aus der Papierakte' : `von ${clean(doc.uploader_name) || 'unbekannt'}`].filter(Boolean).join(' · '), status: doc.status }))
            ].sort((left, right) => String(right.day).localeCompare(String(left.day)));
            if (chartVisits == null) body.append(el('p', 'field-hint', 'Termine werden geladen …'));
            if (!events.length && chartVisits != null) body.append(el('p', 'directory-empty', 'In dieser Akte steht noch nichts.'));
            const line = el('ol', 'chart-timeline');
            let lastYear = '';
            events.forEach(event => {
                const year = String(event.day).slice(0, 4);
                if (year !== lastYear) { line.append(el('li', 'chart-year', year || 'Ohne Datum')); lastYear = year; }
                const row = el('li', 'chart-event');
                row.dataset.tab = event.tab;
                const open = button('chart-event-button', '', () => { chartTab = event.tab; renderChart(patient); updateSelection(); });
                open.append(el('span', 'chart-event-day', event.day ? `${event.day.slice(8, 10)}.${event.day.slice(5, 7)}.` : '–'), el('strong', null, event.kind), el('span', 'chart-event-text', event.text));
                if (event.day > today) open.append(el('em', 'chip chip-brand', 'kommt noch'));
                else if (event.status === 'neu') open.append(el('em', 'chip', 'neu'));
                row.append(open);
                line.append(row);
            });
            body.append(line);
            // Fotografierte Unterlagen dieser Akte auf einmal aufbereiten (zuschneiden, aufhellen) – die Originale bleiben.
            const fixable = [...patient.documents, ...patient.reports].filter(canFix);
            if (fixable.length) {
                const row = el('div', 'chart-fix');
                row.append(el('span', null, `${plural(fixable.length, 'fotografierte Unterlage', 'fotografierte Unterlagen')} in dieser Akte ${fixable.length === 1 ? 'lässt' : 'lassen'} sich wie in einer Scan-App aufbereiten.`),
                    button('button-secondary chart-fix-button', `Scans dieser Akte verbessern (${fixable.length})`, () => ScanFix.batch(fixable, { label: [patient.nr ? `Patient ${patient.nr}` : '', patient.name].filter(Boolean).join(' · '), onDone: refresh })));
                body.append(row);
            }
            // Eingelesene Papierakten: wann, von wem, wie viel – und der Weg, ein Einlesen im Ganzen zurückzunehmen.
            const imports = importsOf(patient);
            if (imports.length) {
                const list = el('ul', 'chart-imports');
                imports.forEach(item => {
                    const row = el('li');
                    row.dataset.importId = item.id;
                    row.append(el('span', null, `Papierakte eingelesen am ${formatStamp(item.at)}${item.by ? ` von ${item.by}` : ''} · ${plural(item.docs.length, 'Schriftstück', 'Schriftstücke')} · ${plural(item.pages, 'Seite', 'Seiten')}`),
                        button('button-quiet-danger', 'Einlesen zurücknehmen', node => undoImport(patient, item, node)));
                    list.append(row);
                });
                body.append(el('h4', 'file-date', 'Eingelesene Papierakten'), list);
            }
            // Abrufe: welcher Dolmetscher hat die Akte wann geöffnet (zur Vorbereitung auf einen zugesagten Auftrag)?
            if (chartViews.length) {
                const list = el('ul', 'chart-imports chart-views');
                chartViews.forEach(view => list.append(el('li', null, `${formatStamp(view.at)} · ${clean(view.viewer_name) || 'unbekannt'} · ${plural(Number(view.documents || 0), 'Unterlage', 'Unterlagen')}`)));
                body.append(el('h4', 'file-date', 'Abrufe durch Dolmetscher'), list);
            }
        } else if (chartTab === 'termine') {
            if (!patient.nr) body.append(el('p', 'directory-empty', 'Ohne Patientennummer lassen sich keine Termine zuordnen.'));
            else if (chartVisits == null) body.append(el('p', 'field-hint', 'Termine werden geladen …'));
            else {
                if (reported.length) { const node = el('ul', 'directory-list file-list'); node.append(...reported.map(reportedEntry)); body.append(el('h4', 'file-date', 'Von Dolmetschern gemeldete neue Termine'), node); }
                const node = el('ul', 'directory-list file-list');
                node.append(...(visits.length ? visits.map(visitEntry) : [el('li', 'directory-empty', `In den letzten ${DAY_RANGE} Tagen gibt es keine Termine für diesen Patienten.`)]));
                body.append(el('h4', 'file-date', 'Termine aus dem Tagesplan'), node);
            }
        } else {
            // Unterlagen dieses Reiters – geordnet nach Datum, Fachrichtung oder Arzt.
            const docs = parts[chartTab];
            if (docs.length > 1) {
                const tools = el('div', 'chart-tools');
                const order = el('div', 'akte-order');
                order.setAttribute('role', 'group');
                order.setAttribute('aria-label', 'Ordnen nach');
                CHART_ORDERS.forEach(([key, label]) => {
                    const choice = button('', label, () => { chartOrder = key; try { localStorage.setItem(ORDER_KEY, key); } catch (error) { /* gilt dann bis zum Neuladen */ } renderChart(patient); updateSelection(); });
                    choice.dataset.chartOrder = key;
                    choice.setAttribute('aria-pressed', String(key === chartOrder));
                    order.append(choice);
                });
                tools.append(el('span', 'chart-tools-label', 'Ordnen nach'), order);
                body.append(tools);
            }
            const prefix = { rezepte: 'Rezept', ueberweisung: 'Überweisung', befunde: 'Befund', kosten: 'Kosten' }[chartTab] || '';
            if (!docs.length) body.append(prefix ? el('p', 'directory-empty', CHART_EMPTY[chartTab]) : list([], CHART_EMPTY[chartTab]));
            else chartSections(docs, prefix).forEach(section => {
                if (section.title) body.append(el('h4', 'file-date', section.title));
                body.append(list(section.docs, ''));
            });
        }
        box.replaceChildren(head, tabs, body);
        box.hidden = false;
    }
    // Termine und gemeldete Termine der Akte laden (einmal je geöffneter Akte).
    async function loadChart(patient) {
        if (chartFor === patient.key && chartVisits != null) return;
        chartFor = patient.key; chartVisits = null; chartReported = null; chartViews = [];
        const [loaded, reported, views] = await Promise.all([patient.nr ? loadDays() : null,
            patient.nr ? Promise.resolve(client.from('tt_new_appointments').select('*').eq('patient_nr', patient.nr).order('date', { ascending: false })).then(result => result.error ? [] : result.data || [], () => []) : [],
            // Wer hat die Akte zur Vorbereitung auf einen Auftrag abgerufen? (Die Datenbank hält jeden Abruf fest.)
            patient.nr ? Promise.resolve(client.from('tt_document_access').select('at, viewer_name, documents').eq('patient_nr', patient.nr).order('at', { ascending: false }).limit(12)).then(result => result.error ? [] : result.data || [], () => []) : []]);
        if (chartFor !== patient.key) return;
        chartVisits = loaded ? visitsFor(loaded, patient.nr) : [];
        chartReported = reported;
        chartViews = views;
        if (openKey === patient.key) { renderChart(patient); updateSelection(); }
    }

    async function renderFile() {
        const patient = patients.find(item => item.key === openKey);
        $('patientFile').hidden = !patient;
        $('patientApp').classList.toggle('has-file', Boolean(patient));
        // In der offenen Akte steht der Knopf „Papierakte einlesen“ im Kopf der Akte (für genau diesen Patienten).
        if (VIEW === 'archiv') {
            $('akteImportLink').hidden = Boolean(patient);
            const fixable = documents.filter(canFix);
            $('fixAllButton').hidden = Boolean(patient) || !fixable.length;
            $('fixAllButton').textContent = `Alle Scans verbessern (${fixable.length})`;
        }
        if (!patient) { openKey = ''; return; }
        if (VIEW === 'archiv') {
            $('fileTitle').textContent = 'Patientenakte';
            $('fileSubtitle').textContent = '';
            $('fileClose').textContent = '← Alle Patientenakten';
            renderChart(patient);
            loadChart(patient);
            return;
        }
        $('fileTitle').textContent = [patient.nr ? `Patient ${patient.nr}` : 'Ohne Patientennummer', patient.name, patient.birth ? `geb. ${patient.birth}` : ''].filter(Boolean).join(' · ');
        const reports = documents.filter(doc => isReport(doc) && mentions(doc, patient));
        $('fileSubtitle').textContent = [plural(patient.documents.length, 'Unterlage', 'Unterlagen'), plural(reports.length, 'Bericht', 'Berichte'), patient.last ? `zuletzt am ${formatDay(patient.last)}` : ''].filter(Boolean).join(' · ');

        // Unterlagen nach Termin: neuester Termin zuerst, ohne Datum am Ende.
        const groups = new Map();
        patient.documents.forEach(doc => {
            const day = clean(doc.date).slice(0, 10);
            if (!groups.has(day)) groups.set(day, []);
            groups.get(day).push(doc);
        });
        const days = [...groups.keys()].sort((left, right) => !left || !right ? (left ? -1 : right ? 1 : 0) : right.localeCompare(left));
        $('fileDocuments').replaceChildren(...days.flatMap(day => {
            const list = el('ul', 'directory-list file-list');
            list.append(...groups.get(day).map(doc => docEntry(doc, false)));
            const title = day ? new Date(`${day}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' }) : 'Ohne Termindatum';
            return [el('h4', 'file-date', title), list];
        }));
        if (!days.length) $('fileDocuments').append(el('p', 'directory-empty', 'Für diesen Patienten gibt es noch keine Unterlagen.'));
        fillList('fileReports', reports.map(doc => docEntry(doc, false)), 'Kein Bericht nennt diesen Patienten.');

        if (!patient.nr) { fillList('fileAppointments', [], 'Ohne Patientennummer lassen sich keine Termine zuordnen.'); return; }
        if (!$('fileAppointments').children.length) fillList('fileAppointments', [], 'Termine werden geladen …');
        const loaded = await loadDays();
        if (openKey !== patient.key) return;      // inzwischen ist eine andere Akte geöffnet
        if (!loaded) { fillList('fileAppointments', [], 'Termine konnten nicht geladen werden.'); return; }
        fillList('fileAppointments', visitsFor(loaded, patient.nr).map(visitEntry), `In den letzten ${DAY_RANGE} Tagen gibt es keine Termine für diesen Patienten.`);
    }

    // ---------- Auswahl mehrerer Unterlagen ----------
    function toggleSelected(id, on) {
        if (on) selected.add(id); else selected.delete(id);
        updateSelection();
    }

    // Zeigt die Auswahl überall gleich: Häkchen, Hervorhebung und die Zahl auf den Knöpfen.
    // Was nicht mehr zu sehen ist (anderer Filter, Akte geschlossen), fällt aus der Auswahl.
    function updateSelection() {
        const visible = new Set();
        document.querySelectorAll('.doc-entry').forEach(row => {
            const on = selected.has(row.dataset.docId);
            visible.add(row.dataset.docId);
            row.classList.toggle('is-selected', on);
            row.querySelector('.doc-check input').checked = on;
        });
        [...selected].forEach(id => { if (!visible.has(id)) selected.delete(id); });
        document.querySelectorAll('[data-forward-selected]').forEach(node => {
            node.textContent = `Auswahl weiterleiten (${selected.size})`;
            node.disabled = selected.size === 0;
        });
    }

    // Baut alle Listen neu auf. Dabei verschwindet oft genau der Knopf, der gerade den Fokus hat – der Browser
    // spränge dann an den Seitenanfang. Deshalb: Fokus vorher lösen und die Stelle auf der Seite (und in der Akte) halten.
    function render() {
        const top = window.scrollY;
        const fileTop = $('patientFile').scrollTop;
        const active = document.activeElement;
        if (active?.closest?.('.doc-entry, .patient-card')) active.blur();
        renderTiles();
        renderRequestNotes();
        renderList();
        renderSearch();
        renderFile();
        updateSelection();
        $('patientFile').scrollTop = fileTop;
        if (window.scrollY !== top) window.scrollTo(0, top);
    }

    // Auf Bitte neu fotografiert: Hinweis ganz oben – neue Aufnahme öffnen, alte löschen, als gesehen abhaken.
    function renderRequestNotes() {
        const list = $('requestNotes');
        const answered = window.PhotoRequest ? PhotoRequest.unseen().filter(item => item.kind === 'unterlage') : [];
        list.hidden = !answered.length;
        list.replaceChildren(...answered.map(request => {
            const fresh = documents.find(doc => doc.id === request.answer_ref);
            const old = documents.find(doc => doc.id === request.ref_id);
            const row = el('li', 'vehicle-entry request-note');
            const meta = el('span', 'doc-meta');
            meta.append(el('strong', null, `Neu fotografiert: ${request.title || 'Unterlage'}`),
                el('small', null, `von ${clean(request.profile_name) || 'unbekannt'} am ${formatStamp(request.answered_at)}${clean(request.answer_note) ? ` · „${clean(request.answer_note)}“` : ''}`));
            const actions = el('span', 'vehicle-entry-actions');
            if (fresh) actions.append(button('button-primary fleet-end-button', 'Neue Aufnahme öffnen', node => openDocument(fresh, node)));
            if (old) actions.append(button('button-quiet-danger', 'Alte löschen', node => deleteDocument(old, node)));
            actions.append(button('button-secondary fleet-end-button', 'Gesehen ✓', async node => {
                node.disabled = true;
                const error = await PhotoRequest.markSeen(request);
                if (error) { node.disabled = false; showToast(TerminCloud.germanError(error), 'error'); return; }
                render();
            }));
            row.append(pill('erledigt', 'Neue Aufnahme'), meta, actions);
            return row;
        }));
    }

    function openPatient(key) {
        const patient = patients.find(item => item.key === clean(key));
        if (!patient) { showToast('Zu diesem Patienten gibt es keine Unterlagen.', 'error'); return; }
        if (INBOX) { window.location.href = `patienten.html?akte=${encodeURIComponent(patient.key)}`; return; }
        if (VIEW === 'archiv') { openKey = patient.key; chartTab = 'uebersicht'; render(); window.scrollTo({ top: 0 }); return; }
        const from = window.scrollY;
        openKey = patient.key;
        render();
        // Handy: Die Akte steht unter der Liste – zu ihrem Anfang rollen und sich merken, woher man kam.
        // PC: Sie steht neben dem Eingang und bleibt beim Rollen stehen – höchstens so weit rollen,
        // bis die rechte Spalte ganz zu sehen ist (der Eingang behält seinen Platz).
        const side = $('patientFile').parentElement;
        const box = side.getBoundingClientRect();
        const below = box.left < side.previousElementSibling.getBoundingClientRect().right;
        returnTop = below ? from : null;
        $('patientFile').scrollTop = 0;
        if (below) $('patientFile').scrollIntoView({ behavior: 'smooth', block: 'start' });
        else if (box.bottom > window.innerHeight) window.scrollBy({ top: box.bottom - window.innerHeight, behavior: 'smooth' });
    }

    function closePatient() {
        openKey = '';
        render();
        if (returnTop != null) window.scrollTo({ top: returnTop, behavior: 'smooth' });      // Handy: zurück an die Stelle in der Liste
        returnTop = null;
    }

    // ---------- Aktionen an einer Unterlage ----------
    const fileError = error => /not found/i.test(String(error?.message || error || '')) ? 'Die Datei wurde im Speicher nicht gefunden.' : TerminCloud.germanError(error);
    // Einheitlicher Dateiname, z. B. „4103_Mansour-Layla_Rezept-Physiotherapie_2026-10-05.pdf“.
    const fileName = doc => DocPdf.fileName({
        patientNr: clean(doc.patient_nr),
        patientName: clean(doc.patient_name) || (isReport(doc) ? clean(doc.uploader_name) : ''),
        kind: doc.kind,
        date: docDay(doc),
        ext: (clean(doc.file_path).match(/\.(pdf|jpe?g|png)$/i) || [])[1] || 'pdf'
    });

    async function signedUrl(doc, seconds) {
        const { data, error } = await client.storage.from(BUCKET).createSignedUrl(doc.file_path, seconds);
        if (error || !data?.signedUrl) throw new Error(fileError(error || 'not found'));
        return data.signedUrl;
    }

    // Die Datei einer Unterlage. Ein Bericht ohne Datei wird hier im Browser als PDF gesetzt.
    async function fetchFile(doc) {
        if (!doc.file_path) {
            if (!isReport(doc)) throw new Error('Zu diesem Eintrag gibt es keine Datei.');
            const { blob } = await reportPdf(doc);
            return new File([blob], fileName(doc), { type: 'application/pdf' });
        }
        const { data, error } = await client.storage.from(BUCKET).download(doc.file_path);
        if (error || !data) throw new Error(fileError(error || 'not found'));
        return new File([data], fileName(doc), { type: data.type || 'application/pdf' });
    }

    function saveBlob(blob, name) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = name;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(link.href), 60000);
    }

    // Öffnet die Datei in einem neuen Tab. Der Tab entsteht sofort beim Klick – nach dem Warten auf
    // die Adresse würden ihn manche Browser (vor allem auf dem Handy) blockieren.
    async function openFile(doc, node) {
        const tab = window.open('', '_blank');
        node.disabled = true;
        try {
            const url = await signedUrl(doc, 600);
            if (tab && !tab.closed) {
                tab.opener = null;
                tab.location.replace(url);
            } else {
                showToast('Der Browser hat das neue Fenster blockiert.', 'info', { actionLabel: 'Datei öffnen', onAction: () => window.open(url, '_blank', 'noopener'), duration: 15000 });
            }
        } catch (error) {
            tab?.close();
            const message = `Die Datei konnte nicht geöffnet werden: ${error.message}`;
            // Über einem offenen Dialog wäre die Einblendung nicht zu lesen.
            if ($('reportDialog').open) dialogStatus('reportStatus', message, 'error'); else showToast(message, 'error');
        } finally {
            node.disabled = false;
        }
    }

    function openDocument(doc, node) {
        if (isReport(doc) && (clean(doc.body) || !doc.file_path)) { showReport(doc); return; }
        if (!doc.file_path) { showToast('Zu diesem Eintrag gibt es keine Datei.', 'error'); return; }
        openFile(doc, node);
    }

    // Direkt drucken: Das PDF (bei einem Bericht ohne Datei wird es hier gesetzt) öffnet unsichtbar und geht an den Drucker.
    let printFrame = null;
    async function printDocument(doc, node) {
        node.disabled = true;
        try {
            const file = await fetchFile(doc);
            printFrame?.remove();
            const frame = printFrame = document.createElement('iframe');
            frame.className = 'print-frame';
            frame.setAttribute('aria-hidden', 'true');
            const url = URL.createObjectURL(new Blob([file], { type: 'application/pdf' }));
            let started = false;
            const start = () => {
                if (started) return;
                started = true;
                try { frame.contentWindow.focus(); frame.contentWindow.print(); }
                catch (error) { window.open(url, '_blank', 'noopener'); showToast('Der Bericht ist in einem neuen Fenster geöffnet – dort mit Strg + P drucken.', 'info'); }
            };
            frame.addEventListener('load', () => window.setTimeout(start, 300));
            window.setTimeout(start, 3000);      // manche Browser melden das Laden eines PDFs nicht
            frame.src = url;
            document.body.append(frame);
            window.setTimeout(() => URL.revokeObjectURL(url), 300000);
        } catch (error) {
            showToast(`Drucken nicht möglich: ${error.message}`, 'error');
        } finally {
            node.disabled = false;
        }
    }

    async function downloadDocument(doc, node) {
        node.disabled = true;
        try {
            const file = await fetchFile(doc);
            saveBlob(file, file.name);
        } catch (error) {
            showToast(`Herunterladen nicht möglich: ${error.message}`, 'error');
        } finally {
            node.disabled = false;
        }
    }

    async function markChecked(doc, node) {
        node.disabled = true;
        // Nur, solange die Unterlage noch „neu“ ist – so überschreibt niemand den Stand einer Kollegin.
        const { error } = await client.from('tt_documents')
            .update({ status: 'geprüft', checked_at: new Date().toISOString(), checked_by: profile.full_name || '' })
            .eq('id', doc.id).eq('status', 'neu');
        if (error) { node.disabled = false; showToast(TerminCloud.germanError(error), 'error'); return; }
        showToast('Als geprüft markiert', 'success');
        await refresh();
    }

    // Erst die Datei, dann der Eintrag: Schlägt etwas fehl, bleibt der Eintrag sichtbar und lässt sich erneut löschen.
    async function deleteDocument(doc, node) {
        const what = [`„${doc.kind || 'Unterlage'}“`, patientLabel(doc)].filter(Boolean).join(' · ');
        if (!await confirmDialog(`${what} endgültig löschen? Eintrag und Datei lassen sich danach nicht wiederherstellen.`, 'Löschen')) return;
        node.disabled = true;
        const paths = [doc.file_path, doc.original_path].map(clean).filter(Boolean);      // auch das aufbewahrte Original („Scan verbessern“)
        if (paths.length) {
            const { error } = await client.storage.from(BUCKET).remove(paths);
            if (error) { node.disabled = false; showToast(`Die Datei konnte nicht gelöscht werden: ${TerminCloud.germanError(error)}`, 'error'); return; }
        }
        const { error } = await client.from('tt_documents').delete().eq('id', doc.id);
        if (error) { node.disabled = false; showToast(TerminCloud.germanError(error), 'error'); return; }
        selected.delete(doc.id);
        showToast('Unterlage gelöscht', 'success');
        await refresh();
    }

    // Ein ganzes Einlesen zurücknehmen: alle Schriftstücke dieser Papierakte samt Dateien. Erst die Dateien, dann die Einträge –
    // schlägt etwas fehl, bleiben die Einträge sichtbar und das Zurücknehmen lässt sich wiederholen.
    async function undoImport(patient, item, node) {
        const count = item.docs.length;
        const label = [patient.nr ? `Patient ${patient.nr}` : '', patient.name].filter(Boolean).join(' · ');
        if (!await confirmDialog(`Das Einlesen vom ${formatStamp(item.at)} zurücknehmen?\n\n${plural(count, 'Schriftstück', 'Schriftstücke')} mit ${plural(item.pages, 'Seite', 'Seiten')} aus der Papierakte von ${label || 'diesem Patienten'} werden endgültig gelöscht – Einträge und Dateien. Was die Dolmetscher selbst hochgeladen haben, bleibt.`, 'Endgültig löschen', 'Abbrechen')) return;
        node.disabled = true;
        const paths = item.docs.flatMap(doc => [doc.file_path, doc.original_path]).map(clean).filter(Boolean);
        for (let from = 0; from < paths.length; from += 100) {
            const { error } = await client.storage.from(BUCKET).remove(paths.slice(from, from + 100));
            if (error) { node.disabled = false; showToast(`Die Dateien konnten nicht gelöscht werden: ${TerminCloud.germanError(error)}`, 'error'); return; }
        }
        const { error } = await client.from('tt_documents').delete().eq('import_id', item.id);
        if (error) { node.disabled = false; showToast(TerminCloud.germanError(error), 'error'); return; }
        item.docs.forEach(doc => selected.delete(doc.id));
        showToast(`Einlesen zurückgenommen: ${plural(count, 'Schriftstück', 'Schriftstücke')} gelöscht`, 'success');
        await refresh();
    }

    // „Scan verbessern“ zurücknehmen: Die frühere Datei gilt wieder, die verbesserte wird gelöscht.
    async function restoreOriginal(doc, node) {
        if (!await confirmDialog(`Den verbesserten Scan von „${docTitle(doc)}“ verwerfen und das Original wiederherstellen?`, 'Original wiederherstellen', 'Abbrechen')) return;
        node.disabled = true;
        const improved = doc.file_path;
        const { data, error } = await client.from('tt_documents').update({ file_path: doc.original_path, original_path: null, enhanced_at: null, file_bytes: null }).eq('id', doc.id).eq('file_path', improved).select();
        if (error || !data?.length) { node.disabled = false; showToast(error ? TerminCloud.germanError(error) : 'Die Unterlage wurde inzwischen geändert. Bitte die Seite aktualisieren.', 'error'); return; }
        if (improved) await client.storage.from(BUCKET).remove([improved]);      // bleibt die Datei liegen, stört sie nicht – der Eintrag zeigt schon auf das Original
        showToast('Das Original ist wiederhergestellt', 'success');
        await refresh();
    }

    // ---------- Angaben einer Unterlage korrigieren (falsche Art, falscher Patient, falsches Datum …) ----------
    let editedDoc = null;
    function editDocument(doc) {
        editedDoc = doc;
        // Arten: die der Dolmetscher-App und die der Papierakte (Befund Labor, Kosten Rechnung, Terminzettel …).
        const paperKinds = window.AkteLogic && !fullText ? AkteLogic.KINDS.map(item => item.kind) : [];
        const kinds = isReport(doc) && !isImported(doc) ? [REPORT_KIND] : [...new Set([...ALL_KINDS.filter(kind => kind !== REPORT_KIND), ...paperKinds, kindKey(doc.kind) || 'Sonstiges'])];
        $('docEditKind').replaceChildren(...kinds.map(kind => { const option = el('option', null, kind); option.value = kind; return option; }));
        $('docEditKind').value = isReport(doc) ? REPORT_KIND : kindKey(doc.kind) || 'Sonstiges';
        $('docEditKind').disabled = isReport(doc) && !isImported(doc);
        $('docEditInfo').textContent = isImported(doc) ? `Aus der Papierakte · eingelesen von ${clean(doc.uploader_name) || 'unbekannt'} am ${formatStamp(doc.created_at)}`
            : `${isReport(doc) ? 'Geschrieben' : 'Fotografiert'} von ${clean(doc.uploader_name) || 'unbekannt'} am ${formatStamp(doc.created_at)}`;
        $('docEditDateLabel').textContent = isImported(doc) ? 'Datum des Schriftstücks' : 'Datum des Termins';
        // Überschrift und Fachrichtung gibt es erst mit Update 29.
        ['docEditHeading', 'docEditSpecialty'].forEach(id => { $(id).hidden = fullText; document.querySelector(`label[for="${id}"]`).hidden = fullText; });
        $('docEditHeading').value = clean(doc.title);
        $('docEditSpecialty').value = clean(doc.specialty);
        $('docEditStatus').querySelector('option[value="archiv"]').hidden = fullText;
        if (!fullText) $('docEditSpecialtyList').replaceChildren(...[...new Set(documents.map(specialtyOf).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'de')).map(value => { const option = el('option'); option.value = value; return option; }));
        $('docEditNr').value = clean(doc.patient_nr);
        $('docEditName').value = clean(doc.patient_name);
        $('docEditDate').value = clean(doc.date).slice(0, 10);
        $('docEditDoctor').value = clean(doc.doctor);
        $('docEditNote').value = clean(doc.note);
        $('docEditStatus').value = DOC_STATUS[doc.status] ? doc.status : 'neu';
        dialogStatus('docEditStatusLine', '');
        $('docEditDialog').showModal();
    }
    $('docEditCancel').addEventListener('click', () => $('docEditDialog').close());
    $('docEditForm').addEventListener('submit', async event => {
        event.preventDefault();
        const doc = editedDoc;
        const status = $('docEditStatus').value;
        if (!clean($('docEditNr').value) && !clean($('docEditName').value)) { dialogStatus('docEditStatusLine', 'Bitte gib die Patienten-Nr. oder den Namen an – sonst lässt sich die Unterlage keinem Patienten zuordnen.', 'error'); return; }
        const changes = {
            kind: $('docEditKind').value, patient_nr: clean($('docEditNr').value), patient_name: clean($('docEditName').value).replace(/\s+/g, ' '),
            date: $('docEditDate').value || null, doctor: clean($('docEditDoctor').value), note: clean($('docEditNote').value), status
        };
        if (!fullText) {
            // Überschrift: leer oder unverändert die selbst entstandene → sie folgt der neuen Art, dem Arzt und der Fachrichtung.
            const typed = clean($('docEditHeading').value);
            changes.specialty = clean($('docEditSpecialty').value);
            const fresh = autoTitle({ kind: changes.kind, doctor: changes.doctor, specialty: changes.specialty });
            changes.title = !typed ? (isImported(doc) || status === 'archiv' ? fresh : '') : typed === autoTitle(doc) ? fresh : typed;
        }
        // Stand zurückgesetzt: die Vermerke „geprüft“ / „weitergeleitet“ passen dann nicht mehr.
        if (status === 'neu') Object.assign(changes, { checked_at: null, checked_by: '', forwarded_at: null, forwarded_to: '', forwarded_by: '' });
        else if (status === 'geprüft') Object.assign(changes, { checked_at: doc.checked_at || new Date().toISOString(), checked_by: doc.checked_by || profile.full_name || '', forwarded_at: null, forwarded_to: '', forwarded_by: '' });
        else if (status === 'weitergeleitet' && !doc.forwarded_at) Object.assign(changes, { forwarded_at: new Date().toISOString(), forwarded_by: profile.full_name || '' });
        $('docEditSave').disabled = true;
        const { data, error } = await client.from('tt_documents').update(changes).eq('id', doc.id).select();
        $('docEditSave').disabled = false;
        if (error || !data?.length) { dialogStatus('docEditStatusLine', error ? TerminCloud.germanError(error) : 'Die Unterlage gibt es nicht mehr.', 'error'); return; }
        $('docEditDialog').close();
        showToast('Angaben gespeichert', 'success');
        await refresh();
        window.refreshCloudInbox?.();
    });

    // ---------- Bericht eines Dolmetschers: ganzer Text im Dialog, auf Wunsch als PDF ----------
    let reportDoc = null;
    // Ein „Bericht über Termin“ gehört zu einem Auftrag (Patient, Arzt, Termin); ältere Berichte galten für einen ganzen Tag.
    const NEXT_PREFIX = 'Nächster Termin: ';
    const forAppointment = doc => Boolean(doc.assignment_id || clean(doc.patient_name) || clean(doc.patient_nr));
    const nextOf = doc => clean(doc.note).startsWith(NEXT_PREFIX) ? clean(doc.note).slice(NEXT_PREFIX.length) : '';
    const reportText = doc => [clean(doc.body), nextOf(doc) ? `${NEXT_PREFIX}${nextOf(doc)}` : ''].filter(Boolean).join('\n\n');
    const reportRows = doc => forAppointment(doc) ? [
        ['Patient/in', clean(doc.patient_name)],
        ['Patientennummer', clean(doc.patient_nr)],
        ['Geburtsdatum', clean(doc.patient_birth)],
        ['Arzt / Praxis', clean(doc.doctor)],
        ['Termin am', formatDay(docDay(doc))],
        ['Bericht vom', formatDay(String(doc.created_at || '').slice(0, 10))],
        ['Dolmetscher/in', clean(doc.uploader_name)],
        ['Nächster Termin', nextOf(doc) || 'keiner angegeben']
    ] : [
        ['Datum', formatDay(docDay(doc))],
        ['Dolmetscher/in', clean(doc.uploader_name)],
        ['Patient/in', [clean(doc.patient_nr), clean(doc.patient_name)].filter(Boolean).join(' · ')]
    ];

    // Ergebnis: { blob, replaced } – replaced zählt Zeichen, die die PDF-Schrift nicht kennt (z. B. Arabisch).
    function reportPdf(doc) {
        const title = forAppointment(doc) ? 'Bericht über Termin' : 'Bericht des Dolmetschers';
        return DocPdf.report({
            organisation: ORGANISATION,
            title,
            meta: reportRows(doc),
            // Der nächste Termin steht mit Datum und Uhrzeit im Bericht selbst – direkt unter dem Text.
            sections: [{ heading: 'Bericht', text: reportText(doc) }, { heading: 'Hinweis', text: nextOf(doc) ? '' : doc.note },
                // Unterschrift: Name des Dolmetschers und Datum, an dem der Bericht geschrieben wurde.
                { heading: 'Unterschrift', text: forAppointment(doc) ? `${clean(doc.uploader_name)}\n${formatDay(String(doc.created_at || '').slice(0, 10))}` : '' }],
            footer: `Eingegangen am ${formatStamp(doc.created_at)} · ${SIGNATURE}`,
            author: clean(doc.uploader_name),
            subject: title
        });
    }

    function showReport(doc) {
        reportDoc = doc;
        $('reportMeta').replaceChildren(...reportRows(doc).filter(row => row[1]).flatMap(([term, value]) => [el('dt', null, term), el('dd', null, value)]));
        $('reportBody').textContent = reportText(doc) || 'Dieser Bericht enthält keinen Text.';
        $('reportFile').hidden = !doc.file_path;
        $('reportPdf').hidden = !clean(doc.body);
        dialogStatus('reportStatus', '');
        $('reportDialog').showModal();
    }

    // ---------- Weiterleiten: Empfänger, Betreff und Nachricht ----------
    const MAIL_PATTERN = /^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()".]{2,}$/;
    let forwardDocs = [];
    let forwardLinks = new Map();      // id → Link zur Datei (7 Tage gültig)
    let forwardFiles = null;           // vorbereitete Dateien für „PDF teilen“
    let forwardRun = 0;                // ändert sich, sobald der Dialog geschlossen oder neu geöffnet wird
    const picked = new Set();          // angekreuzte Empfänger (E-Mail in Kleinbuchstaben)
    let dutyEditor = '';               // E-Mail des Empfängers, dessen Zuständigkeit gerade bearbeitet wird
    const visitText = doc => [formatDay(doc.date), clean(doc.doctor) ? `bei ${clean(doc.doctor)}` : ''].filter(Boolean).join(' ');
    const sharedName = docs => docs.map(doc => clean(doc.patient_name)).find(Boolean) || '';

    // „Patient 4103 · Layla Mansour · Arztbericht + Rezept Medikamente · 05.10.2026“
    function buildSubject(docs) {
        const counts = new Map();
        docs.forEach(doc => counts.set(doc.kind, (counts.get(doc.kind) || 0) + 1));
        const kinds = [...counts].map(([kind, count]) => count > 1 ? `${count}× ${kind}` : kind).join(' + ');
        const days = [...new Set(docs.map(doc => formatDay(doc.date)).filter(Boolean))].join(', ');
        return [clean(docs[0].patient_nr) ? `Patient ${clean(docs[0].patient_nr)}` : '', sharedName(docs), kinds, days].filter(Boolean).join(' · ');
    }

    // Der Text der Nachricht. short = Kurzfassung für das E-Mail-Programm: je Unterlage nur Art und Link.
    function buildMessage(docs, short) {
        const nr = clean(docs[0].patient_nr);
        const name = sharedName(docs);
        const visits = [...new Set(docs.map(visitText))];
        const sameVisit = visits.length === 1 ? visits[0] : '';
        const lines = ['Guten Tag,', '', nr || name ? 'anbei die Unterlagen zu folgendem Patienten:' : 'anbei die folgenden Unterlagen:', ''];
        if (nr) lines.push(`Patientennummer: ${nr}`);
        if (name) lines.push(`Patient/in: ${name}`);
        if (sameVisit) lines.push(`${docs.every(doc => isReport(doc) || isImported(doc)) ? 'Datum' : 'Termin'}: ${sameVisit}`);
        if (nr || name || sameVisit) lines.push('');
        docs.forEach((doc, index) => {
            const link = forwardLinks.get(doc.id);
            if (short) { lines.push(`${index + 1}) ${docTitle(doc)}: ${link}`); return; }
            if (index) lines.push('');
            lines.push(`${index + 1}) ${docTitle(doc)}${doc.pages ? ` (${plural(doc.pages, 'Seite', 'Seiten')})` : ''}`);
            if (!sameVisit && visitText(doc)) lines.push(`   ${isReport(doc) || isImported(doc) ? 'Datum' : 'Termin'}: ${visitText(doc)}`);
            if (clean(doc.note)) lines.push(`   Hinweis: ${clean(doc.note)}`);
            if (link) lines.push(`   PDF (7 Tage gültig): ${link}`);
            else if (clean(doc.body)) lines.push(...clean(doc.body).split(/\r?\n/).map(line => `   ${line}`.trimEnd()));
        });
        lines.push('');
        const uploaders = [...new Set(docs.filter(doc => !isImported(doc)).map(doc => clean(doc.uploader_name)).filter(Boolean))];
        if (!short && uploaders.length) lines.push(`${docs.every(isReport) ? 'Geschrieben' : 'Fotografiert'} von: ${uploaders.join(', ')}`, '');
        lines.push(...['Mit freundlichen Grüßen', clean(profile.full_name), SIGNATURE].filter(Boolean));
        return lines.join('\n');
    }

    // Was bekommt das E-Mail-Programm? full = der ganze Text passt; short = Kurzfassung;
    // paste = auch die ist zu lang (oder ein Bericht hat keinen Link): Der Text reist über die Zwischenablage.
    function mailPlan() {
        const full = $('forwardMessage').value;
        if (full.length <= MAIL_LIMIT) return { mode: 'full', text: full };
        const short = forwardDocs.every(doc => forwardLinks.get(doc.id)) ? buildMessage(forwardDocs, true) : '';
        if (short && short.length <= MAIL_LIMIT) return { mode: 'short', text: short };
        return { mode: 'paste', text: 'Bitte hier den kopierten Text einfügen.' };
    }

    function renderForwardHint() {
        const length = $('forwardMessage').value.length;
        const mode = mailPlan().mode;
        $('forwardHint').textContent = mode === 'full' ? `${length} Zeichen`
            : `${length} Zeichen – zu lang für das E-Mail-Programm (höchstens ${MAIL_LIMIT}). ${mode === 'short'
                ? 'In die E-Mail kommt deshalb die Kurzfassung: je Unterlage nur Art und Link. WhatsApp und „Text kopieren“ verwenden den ganzen Text.'
                : '„E-Mail-Programm öffnen“ kopiert deshalb den Text – füge ihn dann in die E-Mail ein.'}`;
    }

    // Wer ist für welche Art von Unterlage zuständig? Damit geht z. B. „Rezept Medikamente“ von selbst an die richtige Stelle.
    const dutyText = item => item.kinds.length ? `Zuständig für: ${item.kinds.join(', ')}` : 'Noch keine Zuständigkeit festgelegt';

    // Kreuzt die Empfänger an, die für die Art der gewählten Unterlagen zuständig sind, und erklärt die Vorauswahl.
    function pickResponsible(tick = true) {
        const kinds = [...new Set(forwardDocs.map(doc => kindKey(doc.kind)).filter(Boolean))];
        const hint = $('recipientHint');
        if (!recipients || !recipients.length) { hint.textContent = ''; return; }
        const responsible = recipients.filter(item => item.kinds.some(kind => kinds.includes(kind)));
        if (tick) responsible.forEach(item => picked.add(lower(item.email)));
        const open = kinds.filter(kind => !recipients.some(item => item.kinds.includes(kind)));
        hint.textContent = [
            responsible.length ? `Vorausgewählt nach Art der Unterlage: ${responsible.map(item => item.name || item.email).join(', ')}.` : '',
            open.length ? `Für „${open.join('“, „')}“ ist noch niemand zuständig – wähle einen Empfänger und lege über „Zuständigkeit“ fest, wer diese Art künftig bekommt.` : ''
        ].filter(Boolean).join(' ');
    }

    async function toggleDuty(item, kind, node) {
        node.disabled = true;
        const failed = await changeRecipients(list => list.map(entry => lower(entry.email) !== lower(item.email) ? entry
            : { ...entry, kinds: entry.kinds.includes(kind) ? entry.kinds.filter(value => value !== kind) : ALL_KINDS.filter(value => value === kind || entry.kinds.includes(value)) }));
        if (failed) { node.disabled = false; dialogStatus('recipientStatus', failed, 'error'); return; }
        pickResponsible();             // wer gerade zuständig geworden ist, bekommt diese Unterlage gleich mit
        renderRecipients();
        dialogStatus('recipientStatus', `Zuständigkeit für ${item.name || item.email} gespeichert.`, 'success');
    }

    function renderRecipients() {
        const list = $('recipientList');
        if (list.contains(document.activeElement)) document.activeElement.blur();      // siehe render(): sonst springt der Dialog nach oben
        if (!recipients) { list.replaceChildren(el('li', 'recipient-empty', 'Die gespeicherten Empfänger konnten nicht geladen werden. Trage die Adresse unten von Hand ein.')); return; }
        list.replaceChildren(...recipients.map(item => {
            const row = el('li');
            const label = el('label');
            const box = el('input');
            box.type = 'checkbox';
            box.value = item.email;
            box.checked = picked.has(lower(item.email));
            box.addEventListener('change', () => { if (box.checked) picked.add(lower(item.email)); else picked.delete(lower(item.email)); });
            const text = el('span', null, item.name || item.email);
            text.append(el('small', null, item.email), el('small', item.kinds.length ? 'recipient-duty' : 'recipient-duty is-open', dutyText(item)));
            label.append(box, text);
            const editing = dutyEditor === lower(item.email);
            const dutyButton = button('button-quiet', editing ? 'Fertig' : 'Zuständigkeit', () => { dutyEditor = editing ? '' : lower(item.email); renderRecipients(); });
            dutyButton.setAttribute('aria-expanded', String(editing));
            row.append(label, dutyButton, button('button-quiet-danger', 'Entfernen', node => removeRecipient(item, node)));
            if (editing) {
                row.classList.add('has-duty-editor');
                const editor = el('div', 'recipient-duty-editor');
                editor.setAttribute('role', 'group');
                editor.setAttribute('aria-label', `Zuständigkeit von ${item.name || item.email}`);
                editor.append(el('span', 'recipient-duty-title', 'Bekommt automatisch:'), ...ALL_KINDS.map(kind => {
                    const chip = button('duty-chip', kind, node => toggleDuty(item, kind, node));
                    chip.setAttribute('aria-pressed', String(item.kinds.includes(kind)));
                    return chip;
                }));
                row.append(editor);
            }
            return row;
        }));
        if (!recipients.length) list.append(el('li', 'recipient-empty', 'Noch keine Empfänger gespeichert. Lege unten den ersten an.'));
    }

    // Liste frisch lesen, ändern und sofort speichern – so gehen Einträge von Kolleginnen nicht verloren.
    // change(liste) liefert die neue Liste oder einen Fehlertext. Ergebnis: Fehlertext oder ''.
    async function changeRecipients(change) {
        const fresh = await loadRecipients();
        if (!fresh) return 'Die gespeicherten Empfänger konnten nicht geladen werden. Bitte versuche es noch einmal.';
        const next = change(fresh);
        if (typeof next === 'string') { recipients = fresh; renderRecipients(); return next; }
        const { error } = await client.from('tt_settings').upsert({
            key: RECIPIENT_KEY, value: { list: next }, updated_at: new Date().toISOString(), updated_by: profile.full_name || ''
        }, { onConflict: 'key' });
        if (error) return TerminCloud.germanError(error);
        recipients = next;
        pickResponsible(false);
        renderRecipients();
        return '';
    }

    async function addRecipient(event) {
        event.preventDefault();
        const name = clean($('recipientName').value);
        const email = clean($('recipientEmail').value);
        if (!name) { dialogStatus('recipientStatus', 'Bitte trage einen Namen für den Empfänger ein.', 'error'); $('recipientName').focus(); return; }
        if (!MAIL_PATTERN.test(email)) { dialogStatus('recipientStatus', 'Bitte trage eine gültige E-Mail-Adresse ein, zum Beispiel name@example.de.', 'error'); $('recipientEmail').focus(); return; }
        const failed = await changeRecipients(list => list.some(item => lower(item.email) === lower(email))
            ? `${email} ist schon als Empfänger gespeichert.`
            : [...list, { name, email, kinds: [] }].sort((left, right) => left.name.localeCompare(right.name, 'de')));
        if (failed) { dialogStatus('recipientStatus', failed, 'error'); return; }
        picked.add(lower(email));      // wer gerade angelegt wurde, soll die Nachricht auch bekommen
        dutyEditor = lower(email);     // gleich fragen, wofür die neue Stelle zuständig ist
        $('recipientForm').reset();
        renderRecipients();
        dialogStatus('recipientStatus', `${name} ist als Empfänger gespeichert. Tippe an, welche Unterlagen diese Stelle künftig automatisch bekommt.`, 'success');
    }

    async function removeRecipient(item, node) {
        node.disabled = true;
        const failed = await changeRecipients(list => list.filter(entry => lower(entry.email) !== lower(item.email)));
        if (failed) { node.disabled = false; dialogStatus('recipientStatus', failed, 'error'); return; }
        picked.delete(lower(item.email));
        if (dutyEditor === lower(item.email)) dutyEditor = '';
        dialogStatus('recipientStatus', `${item.name || item.email} wurde aus der Empfängerliste entfernt.`, 'success');
    }

    // Gewählte Adressen: angekreuzte Empfänger plus die von Hand eingetragenen. null = Eingabe fehlt oder ist falsch.
    function chosenAddresses() {
        const extra = $('forwardExtra').value.split(/[,;\s]+/).map(clean).filter(Boolean);
        const wrong = extra.find(address => !MAIL_PATTERN.test(address));
        if (wrong) { dialogStatus('forwardStatus', `„${wrong}“ ist keine gültige E-Mail-Adresse.`, 'error'); return null; }
        const seen = new Set();
        const all = [...(recipients || []).filter(item => picked.has(lower(item.email))).map(item => item.email), ...extra]
            .filter(address => !seen.has(lower(address)) && seen.add(lower(address)));
        if (!all.length) { dialogStatus('forwardStatus', 'Bitte wähle mindestens einen Empfänger aus oder trage eine E-Mail-Adresse ein.', 'error'); return null; }
        return all;
    }

    // ---------- Weiterleiten: Dialog öffnen, Links erstellen, senden ----------
    const canShareFiles = () => {
        try {
            return typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
                && navigator.canShare({ files: [new File(['%PDF'], 'test.pdf', { type: 'application/pdf' })] });
        } catch (error) {
            return false;
        }
    };

    function setForwardReady(ready) {
        ['forwardMail', 'forwardWhatsApp', 'forwardCopy'].forEach(id => { $(id).disabled = !ready; });
        $('forwardMessage').readOnly = !ready;
    }

    function startForward(docs) {
        if (new Set(docs.map(patientKey)).size > 1) {
            showToast('Die Auswahl enthält Unterlagen verschiedener Patienten. Bitte leite die Unterlagen für jeden Patienten einzeln weiter.', 'error');
            return;
        }
        openForward(docs);
    }

    async function openForward(docs) {
        const run = ++forwardRun;
        forwardDocs = [...docs].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
        forwardLinks = new Map();
        forwardFiles = null;
        picked.clear();
        dutyEditor = '';
        pickResponsible();
        $('forwardTitle').textContent = forwardDocs.length === 1 ? 'Unterlage weiterleiten' : `${forwardDocs.length} Unterlagen weiterleiten`;
        $('forwardItems').replaceChildren(...forwardDocs.map((doc, index) => {
            const row = el('li');
            row.append(el('strong', null, `${index + 1}) ${docTitle(doc)}`), el('span', null, [patientLabel(doc), doc.pages ? plural(doc.pages, 'Seite', 'Seiten') : ''].filter(Boolean).join(' · ')));
            (Array.isArray(doc.warnings) ? doc.warnings : []).map(clean).filter(Boolean).forEach(text => row.append(warningPill(text)));
            return row;
        }));
        $('recipientForm').reset();
        $('forwardExtra').value = '';
        $('forwardSubject').value = buildSubject(forwardDocs);
        $('forwardMessage').value = '';
        $('forwardHint').textContent = '';
        $('forwardShare').hidden = !canShareFiles();
        $('forwardShare').disabled = true;
        renderRecipients();
        setForwardReady(false);
        dialogStatus('recipientStatus', '');
        dialogStatus('forwardStatus', 'Links werden erstellt …');
        if (!$('forwardDialog').open) $('forwardDialog').showModal();
        try {
            await Promise.all(forwardDocs.filter(doc => doc.file_path).map(async doc => { forwardLinks.set(doc.id, await signedUrl(doc, LINK_SECONDS)); }));
        } catch (error) {
            if (run === forwardRun) dialogStatus('forwardStatus', `Die Links konnten nicht erstellt werden: ${error.message} Bitte schließe das Fenster und versuche es noch einmal.`, 'error');
            return;
        }
        if (run !== forwardRun) return;      // inzwischen geschlossen
        $('forwardMessage').value = buildMessage(forwardDocs, false);
        setForwardReady(true);
        dialogStatus('forwardStatus', '');
        renderForwardHint();
        if ($('forwardShare').hidden) return;
        // Dateien schon jetzt holen: „Teilen“ muss direkt auf den Tipp folgen, sonst lehnt das Handy ab.
        try {
            const files = await Promise.all(forwardDocs.map(fetchFile));
            if (run !== forwardRun) return;
            if (navigator.canShare({ files })) { forwardFiles = files; $('forwardShare').disabled = false; } else $('forwardShare').hidden = true;
        } catch (error) {
            if (run === forwardRun) $('forwardShare').hidden = true;
        }
    }

    async function copyMessage() {
        const field = $('forwardMessage');
        try { await navigator.clipboard.writeText(field.value); return true; } catch (error) { /* älterer Weg: Text markieren und kopieren */ }
        field.focus();
        field.select();
        try { return document.execCommand('copy'); } catch (error) { return false; }
    }

    // Nach dem Senden nachfragen und die Unterlagen als weitergeleitet kennzeichnen.
    async function askForwarded(target) {
        const docs = forwardDocs;
        if (!await confirmDialog('Wurde die Nachricht gesendet? Dann markiere ich die Unterlagen als weitergeleitet.', 'Ja, weitergeleitet', 'Noch nicht')) return;
        // Unterlagen aus der Papierakte bleiben in der Akte („archiv“) – vermerkt wird nur, wann und an wen sie gingen.
        const mark = { forwarded_at: new Date().toISOString(), forwarded_to: target, forwarded_by: profile.full_name || '' };
        const inbox = docs.filter(doc => doc.status !== 'archiv').map(doc => doc.id);
        const paper = docs.filter(doc => doc.status === 'archiv').map(doc => doc.id);
        let error = null;
        if (inbox.length) ({ error } = await client.from('tt_documents').update({ status: 'weitergeleitet', ...mark }).in('id', inbox));
        if (!error && paper.length) ({ error } = await client.from('tt_documents').update(mark).in('id', paper));
        if (error) { dialogStatus('forwardStatus', TerminCloud.germanError(error), 'error'); return; }
        docs.forEach(doc => selected.delete(doc.id));
        if ($('forwardDialog').open) $('forwardDialog').close();
        showToast(`${plural(docs.length, 'Unterlage', 'Unterlagen')} als weitergeleitet markiert`, 'success');
        await refresh();
    }

    async function sendMail() {
        const to = chosenAddresses();
        if (!to) return;
        const plan = mailPlan();
        if (plan.mode === 'paste' && !await copyMessage()) {
            dialogStatus('forwardStatus', 'Der Text ist zu lang für das E-Mail-Programm und ließ sich nicht kopieren. Bitte leite weniger Unterlagen auf einmal weiter.', 'error');
            return;
        }
        // Empfänger, Betreff und Text reisen in der Adresse; Zeilenumbrüche nach Vorschrift als CR LF.
        const link = document.createElement('a');
        link.href = `mailto:${to.map(address => encodeURIComponent(address).replace(/%40/g, '@')).join(',')}`
            + `?subject=${encodeURIComponent(clean($('forwardSubject').value))}&body=${encodeURIComponent(plan.text.replace(/\r?\n/g, '\r\n'))}`;
        link.target = '_blank';
        link.rel = 'noopener';
        link.click();
        dialogStatus('forwardStatus', plan.mode === 'paste' ? 'Der Text ist kopiert – füge ihn in der E-Mail ein.'
            : plan.mode === 'short' ? 'Das E-Mail-Programm hat die Kurzfassung bekommen.' : '');
        await askForwarded(to.join(', '));
    }

    async function sendShare() {
        if (!forwardFiles) return;
        try {
            await navigator.share({ files: forwardFiles, title: clean($('forwardSubject').value), text: $('forwardMessage').value });
        } catch (error) {
            // AbortError: im Teilen-Fenster abgebrochen – dann gibt es nichts zu melden.
            if (error?.name !== 'AbortError') dialogStatus('forwardStatus', 'Teilen ist auf diesem Gerät gerade nicht möglich. Nutze stattdessen die E-Mail oder WhatsApp.', 'error');
            return;
        }
        await askForwarded('Geteilt');
    }

    async function sendWhatsApp() {
        window.open(`https://wa.me/?text=${encodeURIComponent($('forwardMessage').value)}`, '_blank', 'noopener');
        await askForwarded('WhatsApp');
    }

    // ---------- Ereignisse ----------
    document.querySelectorAll('[data-doc-type]').forEach(tab => tab.addEventListener('click', () => {
        typeTab = tab.dataset.docType;
        subKind = '';
        shown = LIST_STEP;
        renderTiles();
        renderList();
        updateSelection();
    }));
    document.querySelectorAll('[data-doc-filter]').forEach(tile => tile.addEventListener('click', () => {
        // Eine Kachel gehört zum Eingang: der Reiter springt zurück (in „Neue Berichte“ / „Neue Rezepte“ bleibt er stehen).
        if (!INBOX) { typeTab = ''; subKind = ''; }
        filter = tile.dataset.docFilter;
        shown = LIST_STEP;
        renderTiles();
        renderList();
        updateSelection();
    }));
    $('docMore').addEventListener('click', () => { shown += LIST_STEP; renderList(); updateSelection(); });
    $('patientSearch').addEventListener('input', renderSearch);
    // Handy: Die Suche steht unter der Liste – hinrollen und gleich tippen können.
    $('jumpSearch').addEventListener('click', () => {
        $('patientSearch').focus({ preventScroll: true });
        $('searchTitle').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.querySelectorAll('[data-forward-selected]').forEach(node => node.addEventListener('click', () => {
        const docs = documents.filter(doc => selected.has(doc.id));
        if (docs.length) startForward(docs);
    }));
    $('fileClose').addEventListener('click', closePatient);
    $('fixAllButton').addEventListener('click', () => { const fixable = documents.filter(canFix); if (fixable.length) ScanFix.batch(fixable, { label: 'alle Patientenakten', onDone: refresh }); });
    $('patientReload').addEventListener('click', () => { daysPromise = null; refresh(); });
    // Zurück im Tab: neue Unterlagen holen – aber nicht, solange ein Dialog offen ist.
    document.addEventListener('visibilitychange', () => { if (!document.hidden && !document.querySelector('dialog[open]')) refresh(); });

    $('reportClose').addEventListener('click', () => $('reportDialog').close());
    $('reportFile').addEventListener('click', () => { if (reportDoc?.file_path) openFile(reportDoc, $('reportFile')); });
    $('reportPdf').addEventListener('click', async () => {
        if (!reportDoc) return;
        $('reportPdf').disabled = true;
        try {
            const { blob, replaced } = await reportPdf(reportDoc);
            saveBlob(blob, fileName({ ...reportDoc, file_path: '' }));
            dialogStatus('reportStatus', replaced
                ? `PDF gespeichert. ${replaced === 1 ? 'Ein Zeichen' : `${replaced} Zeichen`} (z. B. arabische Schrift) kann die PDF-Schrift nicht setzen – dort steht ein „?“.`
                : 'PDF gespeichert.', replaced ? 'info' : 'success');
        } catch (error) {
            dialogStatus('reportStatus', error.message, 'error');
        } finally {
            $('reportPdf').disabled = false;
        }
    });

    $('recipientForm').addEventListener('submit', addRecipient);
    $('forwardMessage').addEventListener('input', renderForwardHint);
    $('forwardMail').addEventListener('click', sendMail);
    $('forwardShare').addEventListener('click', sendShare);
    $('forwardWhatsApp').addEventListener('click', sendWhatsApp);
    $('forwardCopy').addEventListener('click', async () => {
        const copied = await copyMessage();
        dialogStatus('forwardStatus', copied ? 'Der Text ist kopiert.' : 'Kopieren ist hier nicht möglich. Markiere den Text bitte selbst.', copied ? 'success' : 'error');
    });
    $('forwardClose').addEventListener('click', () => $('forwardDialog').close());
    // Auch nach „Esc“: Was noch lädt, gehört danach nicht mehr in den Dialog.
    $('forwardDialog').addEventListener('close', () => { forwardRun += 1; forwardDocs = []; forwardFiles = null; });

    const HEADINGS = {
        berichte: ['ONLINE · EINGANG', 'Neue Berichte', 'Berichte der Dolmetscher und hochgeladene Krankenhausberichte: ansehen, prüfen, weiterleiten. Danach liegen sie in der Patientenakte.'],
        rezepte: ['ONLINE · EINGANG', 'Neue Rezepte', 'Rezepte nach Kategorie (Medikamente, Physiotherapie, Hilfsmittel), dazu Überweisungen und Sonstiges: ansehen, prüfen, weiterleiten.'],
        alles: ['ONLINE · PATIENTEN', 'Patienten und Unterlagen', 'Arztberichte, Rezepte, Überweisungen und Berichte der Dolmetscher – nach Patient geordnet.']
    };
    if (HEADINGS[VIEW] && $('viewTitle')) { $('viewKicker').textContent = HEADINGS[VIEW][0]; $('viewTitle').textContent = HEADINGS[VIEW][1]; $('viewLead').textContent = HEADINGS[VIEW][2]; }
    if (VIEW === 'archiv') { $('docTitle').textContent = 'Alle Patientenakten'; $('searchTitle').textContent = 'Patientenakte suchen'; $('akteImportLink').hidden = false; }
    if (VIEW === 'rezepte') $('docTitle').textContent = 'Rezepte und Überweisungen';
    if (VIEW === 'berichte') $('docTitle').textContent = 'Berichte';
    // Sprung aus „Neue Berichte“ / „Neue Rezepte“: patienten.html?akte=4103 öffnet gleich die Akte.
    const wantedFile = VIEW === 'archiv' ? new URLSearchParams(location.search).get('akte') : '';
    if (wantedFile) history.replaceState(null, '', location.pathname);

    window.PatientenApp = { refresh, openPatient, view: VIEW, state: () => ({ documents, filter, selected: [...selected] }) };
    refresh().then(() => { if (wantedFile && patients.some(item => item.key === wantedFile)) openPatient(wantedFile); });
})();
