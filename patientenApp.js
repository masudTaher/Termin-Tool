// Patienten und Unterlagen: Eingang neuer Unterlagen, Archiv je Patient, Berichte der Dolmetscher
// und das Weiterleiten per E-Mail oder WhatsApp – mit allen Angaben zum Patienten in der Nachricht.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const BUCKET = 'dokumente';
    const REPORT_KIND = 'Dolmetscherbericht';
    const RECIPIENT_KEY = 'document_recipients';
    const LINK_SECONDS = 60 * 60 * 24 * 7;      // Links in der Nachricht gelten 7 Tage
    const MAIL_LIMIT = 1800;                    // längere Texte nimmt nicht jedes E-Mail-Programm über „mailto:“ an
    const PAGE_SIZE = 1000;                     // so viele Zeilen liefert die Datenbank höchstens auf einmal
    const LIST_STEP = 60;
    const DAY_RANGE = 120;                      // Termine der letzten 120 Tage
    const ORGANISATION = 'Botschaft Katar · Medical Office Bonn · Abteilung Transport und Dolmetscher';
    const SIGNATURE = 'Medical Office Bonn · Transport und Dolmetscher';
    const DOC_STATUS = { neu: ['offen', 'Neu'], 'geprüft': ['in Arbeit', 'Geprüft'], weitergeleitet: ['erledigt', 'Weitergeleitet'] };
    const VISIT_STATUS = { offen: ['bekannt', 'offen'], losgefahren: ['in Arbeit', 'unterwegs'], beendet: ['erledigt', 'beendet'], alleine: ['erledigt', 'Patient ging alleine'], storniert: ['offen', 'storniert'] };
    let profile = null;
    let documents = [];
    let patients = [];
    let recipients = [];
    let filter = 'neu';
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
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    const isoDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    // „2026-10-05“ → „05.10.2026“ (ohne Umrechnung zwischen Zeitzonen)
    const formatDay = value => {
        const match = clean(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
        return match ? `${match[3]}.${match[2]}.${match[1]}` : '';
    };
    const formatStamp = value => value ? new Date(value).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
    const docDay = doc => clean(doc.date).slice(0, 10) || (doc.created_at ? isoDay(new Date(doc.created_at)) : '');
    // Patienten erkennt die Seite an der Nummer; fehlt sie, am Namen.
    const patientKey = doc => clean(doc.patient_nr) || (clean(doc.patient_name) ? `name:${lower(doc.patient_name)}` : '');
    const patientLabel = doc => [clean(doc.patient_nr) ? `Patient ${clean(doc.patient_nr)}` : '', clean(doc.patient_name)].filter(Boolean).join(' · ');

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
        const rows = [];
        for (let from = 0; ; from += PAGE_SIZE) {
            const { data, error } = await client.from('tt_documents').select('*')
                .order('created_at', { ascending: false }).order('id').range(from, from + PAGE_SIZE - 1);
            if (error) return { error };
            rows.push(...data);
            if (data.length < PAGE_SIZE) return { data: rows };
        }
    }

    // Gespeicherte Empfänger (tt_settings, Schlüssel „document_recipients“). null = Liste nicht lesbar.
    async function loadRecipients() {
        const { data, error } = await client.from('tt_settings').select('*').eq('key', RECIPIENT_KEY).maybeSingle();
        if (error) return null;
        return (Array.isArray(data?.value?.list) ? data.value.list : [])
            .map(item => ({ name: clean(item?.name), email: clean(item?.email) })).filter(item => item.email);
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
            [result, recipientList] = await Promise.all([loadDocuments(), loadRecipients()]);
        } catch (error) {
            result = { error };
        }
        if (result.error) {
            const missing = /does not exist|could not find the table|schema cache/i.test(String(result.error.message || ''));
            setStatus(missing ? 'Die Tabelle für die Unterlagen fehlt noch in der Datenbank. Bitte supabase/update-10.sql im SQL Editor ausführen.' : TerminCloud.germanError(result.error), 'error');
            return;
        }
        documents = result.data;
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
            if (!patient) map.set(key, patient = { key, nr: clean(doc.patient_nr), name: '', names: new Set(), documents: [], reports: [], last: '' });
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

    function renderTiles() {
        const count = name => String(documents.filter(FILTERS[name]).length);
        $('countNew').textContent = count('neu');
        $('countChecked').textContent = count('geprüft');
        $('countForwarded').textContent = count('weitergeleitet');
        $('countReports').textContent = count('berichte');
        $('countPatients').textContent = String(patients.length);
        document.querySelectorAll('[data-doc-filter]').forEach(tile => {
            const active = tile.dataset.docFilter === filter;
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
        head.append(el('strong', null, doc.kind || 'Sonstiges'), pill(statusColor, statusText));
        meta.append(head);
        // Ein Tipp auf den Patienten öffnet seine Akte. In der Akte selbst steht er schon in der Überschrift –
        // dort erscheint die Zeile nur, wenn es um einen anderen Patienten geht.
        if (patientLabel(doc) && (inList || patientKey(doc) !== openKey)) {
            const link = button('doc-patient', patientLabel(doc), () => openPatient(patientKey(doc)));
            link.title = 'Akte öffnen';
            meta.append(link);
        }
        const visit = [doc.date ? `${isReport(doc) ? 'Bericht vom' : 'Termin'} ${formatDay(doc.date)}` : '', clean(doc.doctor)].filter(Boolean).join(' · ');
        if (visit) meta.append(el('small', null, visit));
        meta.append(el('small', null, [
            `${isReport(doc) ? 'Geschrieben' : 'Fotografiert'} von ${clean(doc.uploader_name) || 'unbekannt'} am ${formatStamp(doc.created_at)}`,
            doc.pages ? plural(doc.pages, 'Seite', 'Seiten') : ''
        ].filter(Boolean).join(' · ')));
        if (isReport(doc) && clean(doc.body)) meta.append(el('span', 'doc-note', excerpt(doc.body, 200)));
        if (clean(doc.note)) meta.append(el('span', 'doc-note', `Hinweis: ${clean(doc.note)}`));
        const warnings = (Array.isArray(doc.warnings) ? doc.warnings : []).map(clean).filter(Boolean);
        if (warnings.length) {
            const wrap = el('span', 'doc-warnings');
            wrap.append(...warnings.map(warningPill));
            meta.append(wrap);
        }
        if (doc.checked_at) meta.append(el('small', null, `Geprüft am ${formatStamp(doc.checked_at)}${clean(doc.checked_by) ? ` von ${clean(doc.checked_by)}` : ''}`));
        if (doc.forwarded_at) meta.append(el('small', null, `Weitergeleitet am ${formatStamp(doc.forwarded_at)}${clean(doc.forwarded_to) ? ` an ${clean(doc.forwarded_to)}` : ''}${clean(doc.forwarded_by) ? ` (${clean(doc.forwarded_by)})` : ''}`));

        const actions = el('span', 'vehicle-entry-actions');
        actions.append(
            button('button-secondary fleet-end-button', 'Öffnen', node => openDocument(doc, node)),
            button('button-secondary fleet-end-button', 'Herunterladen', node => downloadDocument(doc, node))
        );
        if (doc.status === 'neu') actions.append(button('button-primary fleet-end-button', 'Geprüft ✓', node => markChecked(doc, node)));
        actions.append(
            button(`${doc.status === 'geprüft' ? 'button-primary' : 'button-secondary'} fleet-end-button`, 'Weiterleiten', () => startForward([doc])),
            button('button-quiet-danger', 'Löschen', node => deleteDocument(doc, node))
        );
        row.append(check, meta, actions);
        return row;
    }

    const fillList = (id, nodes, emptyText) => $(id).replaceChildren(...(nodes.length ? nodes : [el('li', 'directory-empty', emptyText)]));

    // ---------- Abschnitt „Unterlagen“: Liste zum gewählten Filter oder alle Patienten ----------
    function renderList() {
        const showPatients = filter === 'patienten';
        $('docList').hidden = showPatients;
        $('patientList').hidden = !showPatients;
        if (showPatients) {
            $('docSummary').textContent = SUMMARY.patienten(patients.length);
            $('patientList').replaceChildren(...(patients.length ? patients.slice(0, shown).map(patient => patientCard(patient)) : [el('p', 'directory-empty', EMPTY.patienten)]));
            $('docMore').hidden = patients.length <= shown;
            return;
        }
        const rows = documents.filter(FILTERS[filter]);
        $('docSummary').textContent = SUMMARY[filter](rows.length);
        fillList('docList', rows.slice(0, shown).map(doc => docEntry(doc, true)), EMPTY[filter]);
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
        if (hint) card.append(el('em', 'chip chip-brand', hint));
        card.addEventListener('click', () => openPatient(patient.key));
        return card;
    }

    // Jedes Suchwort muss in Nummer oder Name vorkommen; ab drei Zeichen zählt auch der erkannte Text der Unterlagen.
    function searchPatients(query) {
        const phrase = lower(query);
        const words = phrase.split(/\s+/).filter(Boolean);
        const hits = [];
        patients.forEach(patient => {
            const own = [lower(patient.nr), ...patient.names].join(' ');
            if (words.every(word => own.includes(word))) hits.push({ patient, rank: lower(patient.nr) === phrase ? 0 : lower(patient.nr).startsWith(phrase) ? 1 : 2, inText: false });
            else if (phrase.length >= 3 && [...patient.documents, ...patient.reports].some(doc => lower(doc.text_content).includes(phrase) || lower(doc.body).includes(phrase))) hits.push({ patient, rank: 3, inText: true });
        });
        return hits.sort((left, right) => left.rank - right.rank);
    }

    function renderSearch() {
        const query = clean($('patientSearch').value);
        if (!query) {
            $('patientResults').replaceChildren();
            $('searchInfo').textContent = patients.length ? `${plural(patients.length, 'Patient', 'Patienten')} im Archiv. Tippe die Nummer oder den Namen ein.` : 'Im Archiv gibt es noch keine Patienten.';
            return;
        }
        const hits = searchPatients(query);
        $('searchInfo').textContent = !hits.length ? 'Kein Patient gefunden. Prüfe die Nummer oder die Schreibweise.'
            : `${hits.length} Treffer${hits.length > 30 ? ' – die ersten 30 werden gezeigt. Tippe mehr Zeichen ein.' : ''}`;
        $('patientResults').replaceChildren(...hits.slice(0, 30).map(hit => patientCard(hit.patient, hit.inText ? 'Treffer im Text' : '')));
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

    async function renderFile() {
        const patient = patients.find(item => item.key === openKey);
        $('patientFile').hidden = !patient;
        if (!patient) { openKey = ''; return; }
        $('fileTitle').textContent = [patient.nr ? `Patient ${patient.nr}` : 'Ohne Patientennummer', patient.name].filter(Boolean).join(' · ');
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
        renderList();
        renderSearch();
        renderFile();
        updateSelection();
        $('patientFile').scrollTop = fileTop;
        if (window.scrollY !== top) window.scrollTo(0, top);
    }

    function openPatient(key) {
        const patient = patients.find(item => item.key === clean(key));
        if (!patient) { showToast('Zu diesem Patienten gibt es keine Unterlagen.', 'error'); return; }
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
        if (doc.file_path) {
            const { error } = await client.storage.from(BUCKET).remove([doc.file_path]);
            if (error) { node.disabled = false; showToast(`Die Datei konnte nicht gelöscht werden: ${TerminCloud.germanError(error)}`, 'error'); return; }
        }
        const { error } = await client.from('tt_documents').delete().eq('id', doc.id);
        if (error) { node.disabled = false; showToast(TerminCloud.germanError(error), 'error'); return; }
        selected.delete(doc.id);
        showToast('Unterlage gelöscht', 'success');
        await refresh();
    }

    // ---------- Bericht eines Dolmetschers: ganzer Text im Dialog, auf Wunsch als PDF ----------
    let reportDoc = null;
    const reportRows = doc => [
        ['Datum', formatDay(docDay(doc))],
        ['Dolmetscher/in', clean(doc.uploader_name)],
        ['Patient/in', [clean(doc.patient_nr), clean(doc.patient_name)].filter(Boolean).join(' · ')]
    ];

    // Ergebnis: { blob, replaced } – replaced zählt Zeichen, die die PDF-Schrift nicht kennt (z. B. Arabisch).
    function reportPdf(doc) {
        return DocPdf.report({
            organisation: ORGANISATION,
            title: 'Bericht des Dolmetschers',
            meta: reportRows(doc),
            sections: [{ heading: 'Bericht', text: doc.body }, { heading: 'Hinweis', text: doc.note }],
            footer: `Eingegangen am ${formatStamp(doc.created_at)} · ${SIGNATURE}`,
            author: clean(doc.uploader_name),
            subject: 'Bericht des Dolmetschers'
        });
    }

    function showReport(doc) {
        reportDoc = doc;
        $('reportMeta').replaceChildren(...reportRows(doc).filter(row => row[1]).flatMap(([term, value]) => [el('dt', null, term), el('dd', null, value)]));
        $('reportBody').textContent = clean(doc.body) || 'Dieser Bericht enthält keinen Text.';
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
        if (sameVisit) lines.push(`${docs.every(isReport) ? 'Datum' : 'Termin'}: ${sameVisit}`);
        if (nr || name || sameVisit) lines.push('');
        docs.forEach((doc, index) => {
            const link = forwardLinks.get(doc.id);
            if (short) { lines.push(`${index + 1}) ${doc.kind}: ${link}`); return; }
            if (index) lines.push('');
            lines.push(`${index + 1}) ${doc.kind}${doc.pages ? ` (${plural(doc.pages, 'Seite', 'Seiten')})` : ''}`);
            if (!sameVisit && visitText(doc)) lines.push(`   ${isReport(doc) ? 'Datum' : 'Termin'}: ${visitText(doc)}`);
            if (clean(doc.note)) lines.push(`   Hinweis: ${clean(doc.note)}`);
            if (link) lines.push(`   PDF (7 Tage gültig): ${link}`);
            else if (clean(doc.body)) lines.push(...clean(doc.body).split(/\r?\n/).map(line => `   ${line}`.trimEnd()));
        });
        lines.push('');
        const uploaders = [...new Set(docs.map(doc => clean(doc.uploader_name)).filter(Boolean))];
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
            text.append(el('small', null, item.email));
            label.append(box, text);
            row.append(label, button('button-quiet-danger', 'Entfernen', node => removeRecipient(item, node)));
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
            : [...list, { name, email }].sort((left, right) => left.name.localeCompare(right.name, 'de')));
        if (failed) { dialogStatus('recipientStatus', failed, 'error'); return; }
        picked.add(lower(email));      // wer gerade angelegt wurde, soll die Nachricht auch bekommen
        $('recipientForm').reset();
        renderRecipients();
        dialogStatus('recipientStatus', `${name} ist als Empfänger gespeichert.`, 'success');
    }

    async function removeRecipient(item, node) {
        node.disabled = true;
        const failed = await changeRecipients(list => list.filter(entry => lower(entry.email) !== lower(item.email)));
        if (failed) { node.disabled = false; dialogStatus('recipientStatus', failed, 'error'); return; }
        picked.delete(lower(item.email));
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
        $('forwardTitle').textContent = forwardDocs.length === 1 ? 'Unterlage weiterleiten' : `${forwardDocs.length} Unterlagen weiterleiten`;
        $('forwardItems').replaceChildren(...forwardDocs.map((doc, index) => {
            const row = el('li');
            row.append(el('strong', null, `${index + 1}) ${doc.kind}`), el('span', null, [patientLabel(doc), doc.pages ? plural(doc.pages, 'Seite', 'Seiten') : ''].filter(Boolean).join(' · ')));
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
        const { error } = await client.from('tt_documents')
            .update({ status: 'weitergeleitet', forwarded_at: new Date().toISOString(), forwarded_to: target, forwarded_by: profile.full_name || '' })
            .in('id', docs.map(doc => doc.id));
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
    document.querySelectorAll('[data-doc-filter]').forEach(tile => tile.addEventListener('click', () => {
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

    window.PatientenApp = { refresh, openPatient, state: () => ({ documents, filter, selected: [...selected] }) };
    refresh();
})();
