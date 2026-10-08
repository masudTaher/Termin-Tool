// Papierakte einlesen – die Seite dazu: Patient wählen, Scan-Datei einlesen, je Kategorie prüfen und bestätigen, in die Akte speichern.
// Das Einlesen selbst steht in akteImport.js, die Regeln zum Sortieren in akteLogic.js. Alles Erkannte ist nur ein Vorschlag:
// Jedes Schriftstück lässt sich ansehen, berichtigen, teilen, verbinden oder weglassen – gespeichert wird erst nach der Bestätigung.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const BUCKET = 'dokumente';
    const MAX_PDF_BYTES = 19 * 1024 * 1024;       // der Speicher nimmt höchstens 20 MB je Datei an
    const DEMO_FILE = 'beispielakte.pdf';
    const DEMO_PATIENT = { nr: 'BEISPIEL', name: 'Mustermann, Khalid', birth: '14.03.1968' };
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const clean = value => String(value ?? '').trim();
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    const formatDay = iso => { const match = clean(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return match ? `${match[3]}.${match[2]}.${match[1]}` : ''; };
    const uuid = () => crypto.randomUUID();

    let profile = null;
    let patient = { nr: '', name: '', birth: '' };
    let known = [];               // bekannte Patienten (Nummer, Name, Geburtsdatum) zum Vorschlagen
    let files = [];
    let run = null;               // laufendes Einlesen
    let pages = [];               // eingelesene Seiten + { removed, url }
    let docs = [];                // Schriftstücke: { id, pages: [Seitennummern], key, date, doctor, specialty, heading, title, manual: {}, unsure, hints, checked, dropped }
    let problems = [];
    let order = 'datum';
    const confirmed = new Set();  // bestätigte Kategorien
    let demo = false;
    let importId = '';
    let step = 1;
    let busy = false;
    let space = null;             // Speicherplatz: { freeMb, limitMb } – null, solange unbekannt
    const HANDOVER_KEY = 'terminTool.akte.patient';      // aus der Patientenakte übergeben: { nr, name, birth }
    // Platz sparen: Reine Textseiten werden als „Dokument“ gespeichert (16 Töne, etwa ein Drittel so groß – siehe DocScan.compact).
    // Seiten mit Fotos, Farbflächen oder grauen Feldern haben diese Form nicht und bleiben immer JPEG. Die Wahl merkt sich der Browser.
    const DUPLEX_KEY = 'terminTool.akte.duplex';        // „Vorder- und Rückseiten getrennt gescannt“ bleibt angekreuzt
    const LEARN_KEY = 'terminTool.akteLearn.v1';        // Gelerntes (siehe AkteLogic.learn) – wird über cloudSettingsSync.js geteilt
    let duplex = null;            // { sheets, printed, reversed } – wenn Vorder- und Rückseiten zusammengelegt wurden
    const readLearned = () => { try { const list = JSON.parse(localStorage.getItem(LEARN_KEY) || '[]'); return Array.isArray(list) ? list : []; } catch (error) { return []; } };
    const COMPACT_KEY = 'terminTool.akte.compact';
    let compactOn = true;
    try { compactOn = localStorage.getItem(COMPACT_KEY) !== '0'; } catch (error) { /* bleibt eingeschaltet */ }
    const stored = page => (compactOn && page.compact) || page.blob || null;      // in dieser Form wird die Seite gespeichert

    function setStatus(message, kind = 'info') {
        const status = $('akteStatus');
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }
    function show(next) {
        step = next;
        document.querySelectorAll('[data-akte-step]').forEach(node => { node.hidden = Number(node.dataset.akteStep) !== next; });
        document.querySelectorAll('.akte-steps li').forEach(node => {
            const number = Number(node.dataset.step);
            if (number === next) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
            node.dataset.state = number < next ? 'done' : number === next ? 'now' : 'next';
        });
        $('akteDemo').hidden = !demo;
        window.scrollTo({ top: 0 });
    }
    // Wer mitten in der Arbeit das Fenster schließt, verliert die eingelesenen Seiten – vorher nachfragen.
    window.addEventListener('beforeunload', event => { if ((step === 2 || step === 3 || busy) && !demo) { event.preventDefault(); event.returnValue = ''; } });

    // ---------- Schritt 1: Patient und Datei ----------
    async function loadKnownPatients() {
        const map = new Map();
        const add = (nr, name, birth) => {
            const key = clean(nr);
            if (!key) return;
            const item = map.get(key) || { nr: key, name: '', birth: '' };
            if (!item.name) item.name = clean(name);
            if (!item.birth) item.birth = clean(birth);
            map.set(key, item);
        };
        try {
            for (let from = 0; from < 20000; from += 1000) {
                const { data, error } = await client.from('tt_documents').select('patient_nr, patient_name, patient_birth').order('created_at', { ascending: false }).range(from, from + 999);
                if (error) break;
                data.forEach(row => add(row.patient_nr, row.patient_name, row.patient_birth));
                if (data.length < 1000) break;
            }
            const since = new Date(); since.setDate(since.getDate() - 120);
            const iso = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;
            const days = await client.from('tt_days').select('date, records').gte('date', iso).order('date', { ascending: false });
            (days.data || []).forEach(day => (Array.isArray(day.records) ? day.records : []).forEach(record => add(record?.Patient_Nr,
                [clean(record?.['Patienten Nr::Patienten_Name']), clean(record?.['Patienten Nr::Patienten_Vorname'])].filter(Boolean).join(', '), record?.['Patienten Nr::Patienten_Geburtsdatum'])));
        } catch (error) { /* Vorschläge sind nur eine Hilfe */ }
        known = [...map.values()].sort((left, right) => left.nr.localeCompare(right.nr, 'de', { numeric: true }));
        $('aktePatientList').replaceChildren(...known.slice(0, 2000).map(item => { const option = el('option'); option.value = item.nr; option.label = [item.name, item.birth ? `geb. ${item.birth}` : ''].filter(Boolean).join(' · '); return option; }));
        fillFromKnown();
    }
    function fillFromKnown() {
        const nr = clean($('aktePatientNr').value);
        const hit = known.find(item => item.nr.toLocaleLowerCase('de') === nr.toLocaleLowerCase('de'));
        const hint = $('aktePatientHint');
        if (hit) {
            if (!clean($('aktePatientName').value)) $('aktePatientName').value = hit.name;
            if (!clean($('aktePatientBirth').value)) $('aktePatientBirth').value = hit.birth;
            hint.textContent = `Bekannt: ${[hit.name || 'ohne Namen', hit.birth ? `geb. ${hit.birth}` : ''].filter(Boolean).join(' · ')}. Die Papierakte kommt zu den vorhandenen Unterlagen dazu.`;
        } else hint.textContent = nr ? 'Diese Nummer gibt es im Archiv noch nicht – es wird eine neue Akte angelegt.' : '';
        updateStart();
    }
    function updateStart() {
        $('akteStart').disabled = !(clean($('aktePatientNr').value) && files.length);
    }
    function setFiles(list) {
        files = [...list].filter(file => /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name) || /^image\/(jpeg|png)$/i.test(file.type) || /\.(jpe?g|png)$/i.test(file.name));
        const rejected = [...list].length - files.length;
        const box = $('akteFileList');
        box.hidden = !files.length;
        box.replaceChildren(...files.map(file => el('li', '', `${file.name} · ${file.size >= 1048576 ? `${(file.size / 1048576).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(file.size / 1024))} KB`}`)));
        if (rejected) showToast(`${plural(rejected, 'Datei wurde', 'Dateien wurden')} übergangen – es gehen nur PDF, JPG und PNG.`, 'error');
        updateStart();
    }
    $('aktePatientNr').addEventListener('input', fillFromKnown);
    $('akteFiles').addEventListener('change', event => setFiles(event.target.files));
    const drop = $('akteDrop');
    ['dragenter', 'dragover'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach(name => drop.addEventListener(name, event => { event.preventDefault(); drop.classList.remove('is-over'); }));
    drop.addEventListener('drop', event => { if (event.dataTransfer?.files?.length) setFiles(event.dataTransfer.files); });

    $('akteStartForm').addEventListener('submit', event => {
        event.preventDefault();
        const nr = clean($('aktePatientNr').value);
        const birth = clean($('aktePatientBirth').value);
        if (!nr) { showToast('Bitte die Patienten-Nr. eintragen.', 'error', { target: '#aktePatientNr' }); return; }
        if (birth && !/^\d{2}\.\d{2}\.\d{4}$/.test(birth)) { showToast('Bitte das Geburtsdatum als TT.MM.JJJJ schreiben (z. B. 14.03.1968) – oder das Feld leer lassen.', 'error', { target: '#aktePatientBirth' }); return; }
        if (!files.length) { showToast('Bitte zuerst die Scan-Datei auswählen.', 'error'); return; }
        patient = { nr, name: clean($('aktePatientName').value), birth };
        demo = false;
        try { localStorage.setItem(DUPLEX_KEY, $('akteDuplex').checked ? '1' : '0'); } catch (error) { /* gilt dann nur dieses Mal */ }
        startReading(files, { duplex: $('akteDuplex').checked });
    });
    $('akteDemoButton').addEventListener('click', async () => {
        const button = $('akteDemoButton');
        button.disabled = true;
        try {
            const response = await fetch(DEMO_FILE, { cache: 'no-cache' });
            if (!response.ok) throw new Error('nicht gefunden');
            const file = new File([await response.blob()], 'Beispielakte.pdf', { type: 'application/pdf' });
            patient = { ...DEMO_PATIENT };
            demo = true;
            startReading([file]);
        } catch (error) {
            showToast('Die Beispielakte konnte nicht geladen werden.', 'error');
        } finally { button.disabled = false; }
    });

    // ---------- Schritt 2: Einlesen ----------
    const minutes = seconds => seconds == null ? '' : seconds < 50 ? 'noch weniger als eine Minute' : `noch etwa ${plural(Math.max(1, Math.round(seconds / 60)), 'Minute', 'Minuten')}`;
    function startReading(list, options = {}) {
        releasePages();
        pages = []; docs = []; problems = []; confirmed.clear(); importId = uuid(); duplex = null;
        show(2);
        $('akteReadStrip').replaceChildren();
        $('akteProgressBar').style.width = '0%';
        $('akteProgressText').textContent = 'Die Datei wird geöffnet …';
        $('akteCancel').disabled = false;
        run = AkteImport.start(list, {
            onProgress: state => {
                const share = state.total ? Math.round(state.done / state.total * 100) : 0;
                $('akteProgressBar').style.width = `${share}%`;
                $('akteProgress').setAttribute('aria-valuenow', String(share));
                $('akteProgressText').textContent = state.phase === 'öffnen' ? 'Die Datei wird geöffnet …'
                    : `Seite ${Math.min(state.done + 1, state.total)} von ${state.total}${state.ocr === 'lädt' ? ' · die Texterkennung wird geladen' : ''}${state.seconds != null && state.done < state.total ? ` · ${minutes(state.seconds)}` : ''}`;
            },
            onPage: page => {
                if (!page?.thumb) return;
                const image = el('img');
                image.alt = `Seite ${page.index + 1}`;
                image.src = page.url = URL.createObjectURL(page.thumb);
                image.loading = 'lazy';
                if (page.blank) image.classList.add('is-blank');
                const strip = $('akteReadStrip');
                strip.append(image);
                while (strip.children.length > 40) strip.firstChild.remove();
            }
        });
        const mine = run;
        run.done.then(result => {
            if (run !== mine) return;
            run = null;
            pages = result.pages.map((page, at) => ({ ...page, scanAt: at, removed: false, url: page.url || (page.thumb ? URL.createObjectURL(page.thumb) : '') }));
            problems = result.problems;
            if (options.duplex) applyDuplex(null);
            buildDocuments();
            show(3);
            renderCheck();
        }, error => {
            if (run !== mine) return;
            run = null;
            show(1);
            if (error?.code !== 'cancelled') setStatus(error?.message || String(error), 'error');
        });
    }
    $('akteDuplexFlip').addEventListener('click', async () => {
        if (!duplex) return;
        const touched = docs.some(doc => doc.checked || Object.keys(doc.manual).length);
        if (touched && !(await confirmDialog('Die Rückseiten andersherum zuordnen?\n\nDie Schriftstücke werden neu sortiert – was du schon geprüft oder geändert hast, geht dabei verloren.', 'Neu zuordnen'))) return;
        const reversed = !duplex.reversed;
        problems = problems.filter(text => !/^Vorder- und Rückseiten/.test(text));
        applyDuplex(reversed);
        confirmed.clear();
        buildDocuments();
        renderCheck();
        showToast(reversed ? 'Die Rückseiten sind jetzt in umgekehrter Reihenfolge zugeordnet.' : 'Rückseite 1 gehört jetzt wieder zu Vorderseite 1.', 'success');
    });
    try { $('akteDuplex').checked = localStorage.getItem(DUPLEX_KEY) === '1'; } catch (error) { /* bleibt aus */ }
    $('akteCancel').addEventListener('click', () => { $('akteCancel').disabled = true; $('akteProgressText').textContent = 'Wird abgebrochen …'; run?.cancel(); });
    function releasePages() {
        pages.forEach(page => { if (page.url) URL.revokeObjectURL(page.url); if (page.fullUrl) URL.revokeObjectURL(page.fullUrl); });
    }

    // ---------- Schriftstücke aus den Seiten ----------
    const directory = () => { try { return window.ArztVerzeichnis ? ArztVerzeichnis.read() : []; } catch (error) { return []; } };
    const pageInput = () => pages.map(page => ({ text: page.text || '', blank: Boolean(page.blank || page.removed || !page.blob), qr: Boolean(page.qr), back: Boolean(page.back) }));

    // Vorder- und Rückseiten getrennt gescannt: Blatt für Blatt zusammenlegen (Vorderseite 1, Rückseite 1, Vorderseite 2 …).
    // reverse: null = selbst erkennen, sonst true/false. Passt die Zahl der Seiten nicht, bleibt die Reihenfolge des Scans.
    function applyDuplex(reverse) {
        const base = [...pages].sort((left, right) => left.scanAt - right.scanAt);
        base.forEach((page, at) => { page.index = at; page.back = false; });
        pages = base;
        duplex = null;
        const half = base.length / 2;
        const names = [...new Set(base.map(page => page.file || ''))];
        const fileSplit = names.length < 2 || (Number.isInteger(half) && base[half - 1].file !== base[half].file);
        if (base.length < 2 || base.length % 2 || !fileSplit) {
            const perFile = names.map(name => `„${name || 'Datei'}“: ${plural(base.filter(page => (page.file || '') === name).length, 'Seite', 'Seiten')}`).join(', ');
            problems.push(`Vorder- und Rückseiten ließen sich nicht zusammenlegen: Es müssen gleich viele Vorder- und Rückseiten sein (${perFile || plural(base.length, 'Seite', 'Seiten')}). Die Seiten stehen in der Reihenfolge des Scans – bitte fehlende Seite nachscannen und neu einlesen.`);
            return;
        }
        const found = AkteLogic.duplexOrder(base.map(page => ({ text: page.text || '', blank: Boolean(page.blank || !page.blob), qr: Boolean(page.qr) })), { reverse });
        if (!found) return;
        pages = found.order.map((from, at) => { const page = base[from]; page.index = at; page.back = found.backs.has(at); return page; });
        duplex = { sheets: half, printed: pages.filter(page => page.back && !page.blank && page.blob).length, reversed: found.reversed };
    }

    // Gelerntes anwenden: Kennt das Büro den Kopf dieses Schriftstücks schon (bestätigt oder von Hand verbessert), gilt das wieder.
    function applyLearned(doc) {
        doc.learned = false;
        const hit = AkteLogic.recall(pages[doc.pages[0]]?.text || '', readLearned());
        if (!hit) return;
        // Die Art gilt wieder, wenn das Programm selbst keine erkannt hat („Sonstiges“) – oder wenn das Büro sie bei diesem Kopf von Hand
        // verbessert hat. Vordrucke (Rezept, Überweisung, Terminzettel) haben überall denselben Kopf: Dort entscheidet immer der Inhalt.
        const form = key => AkteLogic.byKey(key).single;
        if (!doc.manual.key && hit.key !== doc.key && AkteLogic.byKey(hit.key).key === hit.key && (doc.key === 'sonst' || (hit.fixed && !form(doc.key) && !form(hit.key)))) { doc.key = hit.key; doc.learned = true; }
        if (!doc.manual.doctor && !doc.doctor && hit.doctor) { doc.doctor = hit.doctor; doc.learned = true; }
        if (!doc.manual.specialty && !doc.specialty && hit.specialty) { doc.specialty = hit.specialty; doc.learned = true; }
        if (doc.learned) {
            if (doc.key !== 'sonst') doc.hints = doc.hints.filter(hint => hint !== 'Die Art wurde nicht sicher erkannt.');
            if (!doc.manual.title) doc.title = AkteLogic.titleOf(doc);
        }
    }

    // Gehört das Schriftstück wirklich in diese Akte? Geprüft wird nur, was sich sicher sagen lässt:
    //   1. Steht ein Geburtsdatum darauf („geb. 02.05.1975“) und ist es ein anderes als das des Patienten? → deutlicher Hinweis.
    //      (Eine einzelne falsch gelesene Ziffer zählt nicht als Abweichung.)
    //   2. Bei Schriftstücken, die sonst immer den Namen tragen (Arztbrief, Befund, Rezept, Überweisung, Rechnung …):
    //      Steht der Name des Patienten nirgends? Namen werden großzügig verglichen – „Mansour“ und „Mansur“, „Al-Thani“ und
    //      „Althani“ gelten als gleich (nur die Mitlaute zählen). Ohne lesbaren Text gibt es keinen Hinweis.
    const NAME_PARTICLES = new Set(['al', 'el', 'bin', 'ben', 'ibn', 'abu', 'abd', 'von', 'van', 'der', 'den', 'de', 'dr', 'prof', 'herr', 'frau']);
    const UNNAMED_KINDS = new Set(['termin', 'sonst']);      // tragen oft keinen Namen (Terminzettel, Merkblätter, Formulare)
    const skeleton = word => AkteLogic.fold(word).replace(/[^a-z]/g, '').replace(/^(al|el)(?=[a-z]{4})/, '').replace(/[aeiouy]/g, '').replace(/(.)\1+/g, '$1');
    const NAME_HINT = 'Der Name des Patienten steht nicht auf diesem Schriftstück – bitte prüfen, ob es in diese Akte gehört.';
    const BIRTH_MARK = /(?:geb\.?|geboren|geburtsdatum|date of birth|born|\bdob\b|d\.o\.b\.?|\*)\s*:?\s*(?:am |on )?([0-3]?\d)\s?[.,/]\s?([01]?\d)\s?[.,/]\s?((?:19|20)\d{2}|\d{2})(?!\d)/g;
    const isPatientHint = hint => hint === NAME_HINT || /^Auf diesem Schriftstück steht ein anderes Geburtsdatum/.test(hint);
    function birthsIn(text) {
        const found = [], nowYear = new Date().getFullYear() % 100;
        for (const match of AkteLogic.fold(text).matchAll(BIRTH_MARK)) {
            const year = match[3].length === 2 ? `${Number(match[3]) > nowYear ? '19' : '20'}${match[3]}` : match[3];
            if (Number(match[1]) >= 1 && Number(match[1]) <= 31 && Number(match[2]) >= 1 && Number(match[2]) <= 12) found.push(`${match[1].padStart(2, '0')}.${match[2].padStart(2, '0')}.${year}`);
        }
        return [...new Set(found)];
    }
    const digitGap = (left, right) => [...left].filter((sign, index) => sign !== right[index]).length;
    function patientHint(doc) {
        const text = doc.pages.map(index => pages[index]?.text || '').join('\n');
        const birth = /^\d{2}\.\d{2}\.\d{4}$/.test(clean(patient.birth)) ? clean(patient.birth) : '';
        if (birth) {
            const births = birthsIn(text);
            if (births.some(day => digitGap(day, birth) <= 1)) return '';
            if (births.length) return `Auf diesem Schriftstück steht ein anderes Geburtsdatum (${births[0]}) als in der Akte (${birth}) – bitte prüfen, ob es zu diesem Patienten gehört.`;
            // das Geburtsdatum ohne „geb.“ davor – irgendwo im Text
            const [day, month, year] = birth.split('.');
            if (new RegExp(`(?<!\\d)0?${Number(day)}\\s?[.,/]\\s?0?${Number(month)}\\s?[.,/]\\s?(${year}|${year.slice(2)})(?!\\d)`).test(text) || text.includes(`${year}-${month}-${day}`)) return '';
        }
        if (UNNAMED_KINDS.has(doc.key)) return '';
        const keys = [...new Set(AkteLogic.fold(patient.name).split(/[^a-z]+/).filter(word => word.length >= 4 && !NAME_PARTICLES.has(word)).map(skeleton).filter(key => key.length >= 3))];
        if (!keys.length || AkteImport.goodWords(text) < 15) return '';          // nichts zum Vergleichen oder zu wenig lesbarer Text
        const found = new Set((AkteLogic.fold(text).match(/[a-z][a-z'’-]{3,}/g) || []).map(skeleton));
        return keys.some(key => found.has(key)) ? '' : NAME_HINT;
    }
    function addPatientHint(doc) {
        doc.hints = doc.hints.filter(hint => !isPatientHint(hint));
        const hint = patientHint(doc);
        if (!hint) return;
        doc.hints.push(hint);
        if (!doc.checked) doc.unsure = true;
    }
    function fromLogic(found) {
        const doc = { id: uuid(), pages: [...found.pages], key: found.key, date: found.date, doctor: found.doctor, specialty: found.specialty, heading: found.heading || '', title: found.title, manual: {}, unsure: Boolean(found.unsure), learned: false, hints: [...(found.hints || [])], checked: false, dropped: false };
        addPatientHint(doc);
        applyLearned(doc);
        return doc;
    }
    function buildDocuments() {
        const sorted = AkteLogic.sortPages(pageInput(), { today: new Date(), directory: directory() });
        docs = sorted.documents.map(fromLogic);
        // Seiten ohne lesbaren Text, die keine leeren Seiten sind, bleiben erhalten – als „Sonstiges“ zum Ansehen.
    }
    // Nach Teilen, Verbinden oder Entfernen: Angaben neu ableiten – was von Hand geändert wurde, bleibt.
    function refreshDoc(doc) {
        const found = AkteLogic.describe(doc.pages.map(index => pages[index].text || ''), { today: new Date(), directory: directory() });
        if (!doc.manual.key) doc.key = found.key;
        if (!doc.manual.date) doc.date = found.date;
        if (!doc.manual.doctor) doc.doctor = found.doctor;
        if (!doc.manual.specialty) doc.specialty = found.specialty;
        doc.heading = found.heading || '';
        doc.hints = found.hints;
        doc.unsure = found.unsure && !doc.checked;
        addPatientHint(doc);
        if (!doc.manual.title) doc.title = AkteLogic.titleOf(doc);
        applyLearned(doc);
    }
    const kindOf = doc => AkteLogic.byKey(doc.key);
    const groupOf = doc => kindOf(doc).group;
    const liveDocs = () => docs.filter(doc => !doc.dropped && doc.pages.length);
    const scanOrder = list => [...list].sort((left, right) => left.pages[0] - right.pages[0]);
    const sortedDocs = list => AkteLogic.sortDocuments(list, order);

    // ---------- Schritt 3: Prüfen ----------
    function counts() {
        const live = liveDocs();
        const inDocs = live.reduce((sum, doc) => sum + doc.pages.length, 0);
        const droppedPages = docs.filter(doc => doc.dropped).reduce((sum, doc) => sum + doc.pages.length, 0);
        const blank = pages.filter(page => page.blank && !page.restored).length;
        const removed = pages.filter(page => page.removed).length;
        const failed = pages.filter(page => !page.blob).length;
        return { total: pages.length, live: live.length, inDocs, droppedPages, blank, removed, failed, rest: pages.length - inDocs - droppedPages - blank - removed - failed };
    }
    function renderCheck() {
        const count = counts();
        $('aktePatientLine').textContent = [`Patient ${patient.nr}`, patient.name, patient.birth ? `geb. ${patient.birth}` : ''].filter(Boolean).join(' · ');
        const parts = [`${plural(count.inDocs, 'Seite', 'Seiten')} in ${plural(count.live, 'Schriftstück', 'Schriftstücken')}`];
        if (count.blank) parts.push(`${plural(count.blank, 'leere Seite', 'leere Seiten')}`);
        if (count.removed) parts.push(`${count.removed} entfernt`);
        if (count.droppedPages) parts.push(`${count.droppedPages} nicht übernommen`);
        if (count.failed) parts.push(`${count.failed} nicht lesbar`);
        const complete = count.rest === 0;
        const line = $('aktePageCount');
        line.dataset.state = complete ? 'ok' : 'fehlt';
        line.textContent = `${plural(count.total, 'Seite', 'Seiten')} eingelesen = ${parts.join(' + ')}${complete ? ' ✓ – keine Seite fehlt' : ` – ${plural(Math.abs(count.rest), 'Seite ist', 'Seiten sind')} nicht zugeordnet!`}`;

        $('akteDuplexInfo').hidden = !duplex;
        if (duplex) $('akteDuplexText').textContent = `Vorder- und Rückseiten zusammengelegt: ${plural(duplex.sheets, 'Blatt', 'Blätter')}, davon ${duplex.printed} mit bedruckter Rückseite. ${duplex.reversed ? 'Die Rückseiten wurden in umgekehrter Reihenfolge zugeordnet (letzte Rückseite zur ersten Vorderseite).' : 'Rückseite 1 gehört zu Vorderseite 1, Rückseite 2 zu Vorderseite 2 …'} Stimmt das nicht?`;
        const learnedCount = liveDocs().filter(doc => doc.learned).length;
        $('akteLearnInfo').hidden = !learnedCount;
        $('akteLearnInfo').textContent = learnedCount ? `${plural(learnedCount, 'Schriftstück wurde', 'Schriftstücke wurden')} wiedererkannt – so, wie du es bei früheren Akten bestätigt hast. Bitte trotzdem kurz prüfen.` : '';
        const box = $('akteProblems');
        box.hidden = !problems.length;
        box.replaceChildren(...problems.map(text => el('li', '', text)));

        // Kategorien in fester Reihenfolge; leere erscheinen nicht.
        const live = liveDocs();
        const groups = AkteLogic.GROUPS.map(([key, label]) => ({ key, label, docs: sortedDocs(live.filter(doc => groupOf(doc) === key)) })).filter(group => group.docs.length);
        [...confirmed].forEach(key => { if (!groups.some(group => group.key === key)) confirmed.delete(key); });
        $('akteGroups').replaceChildren(...groups.map(groupSection));
        const open = groups.filter(group => !confirmed.has(group.key)).length;
        $('akteConfirmState').textContent = !groups.length ? 'Es gibt kein Schriftstück zum Speichern.'
            : open ? `${groups.length - open} von ${plural(groups.length, 'Kategorie', 'Kategorien')} bestätigt – ${open === 1 ? 'eine fehlt' : `${open} fehlen`} noch.` : 'Alle Kategorien sind bestätigt.';
        // Platz im Speicher: Reicht er für diese Akte? Gerechnet wird mit der Form, in der die Seiten gespeichert werden.
        const livePages = live.flatMap(doc => doc.pages.map(index => pages[index]));
        const megabytesOf = pick => livePages.reduce((sum, page) => sum + (pick(page)?.size || 0), 0) * 1.03 / 1048576;
        const needMb = megabytesOf(stored), plainMb = megabytesOf(page => page.blob);
        const smallPages = livePages.filter(page => page.compact).length;
        const tight = space != null && needMb > space.freeMb;
        const megabytes = value => `${value < 10 ? value.toLocaleString('de-DE', { maximumFractionDigits: 1 }) : Math.round(value).toLocaleString('de-DE')} MB`;
        const room = $('akteSpace');
        room.hidden = !groups.length;
        room.dataset.state = tight ? 'voll' : 'ok';
        room.textContent = tight ? `Der Speicher reicht nicht: Diese Akte braucht etwa ${megabytes(needMb)}, frei sind nur noch ${megabytes(space.freeMb)}. Bitte Seiten weglassen – oder erst Platz schaffen.`
            : `Braucht etwa ${megabytes(needMb)} im Speicher${compactOn && smallPages && plainMb - needMb >= 0.05 ? ` statt ${megabytes(plainMb)}` : ''}${space != null ? ` – frei sind ${megabytes(space.freeMb)}` : ''}.`;
        // Der Schalter erscheint nur, wenn es etwas zu sparen gibt.
        $('akteCompactRow').hidden = !groups.length || !smallPages;
        $('akteCompact').checked = compactOn;
        $('akteCompactInfo').textContent = smallPages === livePages.length ? (smallPages === 1 ? 'Die Seite ist eine Textseite.' : `Alle ${smallPages} Seiten sind Textseiten.`)
            : `${smallPages} von ${plural(livePages.length, 'Seite', 'Seiten')} ${smallPages === 1 ? 'ist eine Textseite' : 'sind Textseiten'} – die übrigen (Fotos, Farbflächen) bleiben unverändert.`;
        $('akteSave').disabled = demo || !groups.length || open > 0 || !complete || tight;
        $('akteSave').textContent = demo ? 'Beispiel – wird nicht gespeichert' : `In die Akte speichern (${plural(count.live, 'Schriftstück', 'Schriftstücke')})`;
        document.querySelectorAll('[data-akte-order]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.akteOrder === order)));
        renderTray();
    }
    document.querySelectorAll('[data-akte-order]').forEach(button => button.addEventListener('click', () => { order = button.dataset.akteOrder; renderCheck(); }));
    $('akteCompact').addEventListener('change', event => {
        compactOn = event.target.checked;
        try { localStorage.setItem(COMPACT_KEY, compactOn ? '1' : '0'); } catch (error) { /* gilt dann nur für dieses Mal */ }
        renderCheck();
        if ($('akteDoc').open) renderDoc();
    });

    function groupSection(group) {
        const section = el('section', 'directory-card akte-group');
        section.dataset.group = group.key;
        const done = confirmed.has(group.key);
        section.dataset.state = done ? 'bestätigt' : 'offen';
        const pagesIn = group.docs.reduce((sum, doc) => sum + doc.pages.length, 0);
        const unsure = group.docs.filter(doc => doc.unsure && !doc.checked).length;
        const head = el('div', 'akte-group-head');
        const title = el('div', 'akte-group-title');
        title.append(el('h3', '', group.label), el('span', '', `${plural(group.docs.length, 'Schriftstück', 'Schriftstücke')} · ${plural(pagesIn, 'Seite', 'Seiten')}${unsure ? ` · ${unsure} bitte ansehen` : ''}`));
        const confirm = el('button', done ? 'button-secondary akte-confirm' : 'button-primary akte-confirm', done ? 'Bestätigt ✓' : 'Kategorie bestätigen');
        confirm.type = 'button';
        confirm.setAttribute('aria-pressed', String(done));
        confirm.addEventListener('click', async () => {
            if (done) { confirmed.delete(group.key); renderCheck(); return; }
            if (unsure && !(await confirmDialog(`${unsure === 1 ? 'Ein Schriftstück ist' : `${unsure} Schriftstücke sind`} in „${group.label}“ noch zum Ansehen markiert (gelb). Trotzdem bestätigen?`, 'Trotzdem bestätigen', 'Erst ansehen'))) return;
            confirmed.add(group.key);
            renderCheck();
        });
        head.append(title, confirm);
        const list = el('ul', 'akte-doc-list');
        list.append(...group.docs.map(docCard));
        section.append(head, list);
        return section;
    }
    function docCard(doc) {
        const item = el('li', 'akte-card');
        item.dataset.doc = doc.id;
        item.dataset.state = doc.checked ? 'geprüft' : doc.unsure ? 'unsicher' : 'offen';
        const open = el('button', 'akte-card-open');
        open.type = 'button';
        const first = pages[doc.pages[0]];
        const picture = el('span', 'akte-card-thumb');
        if (first?.url) { const image = el('img'); image.src = first.url; image.alt = ''; image.loading = 'lazy'; picture.append(image); }
        picture.append(el('b', '', plural(doc.pages.length, 'Seite', 'Seiten')));
        const text = el('span', 'akte-card-text');
        text.append(el('strong', '', doc.title || kindOf(doc).label), el('span', 'akte-card-date', doc.date ? formatDay(doc.date) : 'ohne Datum'));
        const marks = el('span', 'akte-card-marks');
        if (doc.learned) marks.append(el('em', 'chip chip-learned', 'wiedererkannt'));
        if (doc.checked) marks.append(el('em', 'chip chip-ok', 'geprüft ✓'));
        else if (doc.unsure) marks.append(el('em', 'chip chip-warn', 'bitte ansehen'));
        doc.hints.filter(hint => /fehl/i.test(hint)).forEach(hint => marks.append(el('em', 'chip chip-danger', hint.replace(/^Laut Seitenzähler /, '').replace(/\.$/, ''))));
        if (marks.children.length) text.append(marks);
        open.append(picture, text);
        open.addEventListener('click', () => openDoc(doc.id));
        item.append(open);
        return item;
    }

    function renderTray() {
        const out = pages.filter(page => (page.blank && !page.restored) || page.removed);
        const dropped = docs.filter(doc => doc.dropped && doc.pages.length);
        $('akteTray').hidden = !out.length && !dropped.length;
        $('akteTrayTitle').textContent = `Leere und entfernte Seiten (${out.length})${dropped.length ? ` · nicht übernommene Schriftstücke (${dropped.length})` : ''}`;
        const nodes = out.map(page => {
            const button = el('button', 'akte-tray-page');
            button.type = 'button';
            button.title = `Seite ${page.index + 1} doch übernehmen`;
            if (page.url) { const image = el('img'); image.src = page.url; image.alt = ''; image.loading = 'lazy'; button.append(image); }
            button.append(el('span', '', `Seite ${page.index + 1} · ${page.removed ? 'entfernt' : 'leer'}`));
            button.addEventListener('click', () => restorePage(page.index));
            return button;
        });
        dropped.forEach(doc => {
            const button = el('button', 'akte-tray-page akte-tray-doc');
            button.type = 'button';
            button.title = 'Doch übernehmen';
            const first = pages[doc.pages[0]];
            if (first?.url) { const image = el('img'); image.src = first.url; image.alt = ''; button.append(image); }
            button.append(el('span', '', `${doc.title || 'Schriftstück'} · ${plural(doc.pages.length, 'Seite', 'Seiten')} · nicht übernommen`));
            button.addEventListener('click', () => { doc.dropped = false; confirmed.delete(groupOf(doc)); renderCheck(); showToast('Das Schriftstück wird wieder übernommen.', 'success'); });
            nodes.push(button);
        });
        $('akteTrayList').replaceChildren(...nodes);
    }
    function restorePage(index) {
        const page = pages[index];
        page.removed = false;
        if (page.blank) page.restored = true;
        const fresh = fromLogic({ ...AkteLogic.describe([page.text || ''], { today: new Date(), directory: directory() }), pages: [index] });
        fresh.unsure = true;
        docs.push(fresh);
        confirmed.delete(groupOf(fresh));
        renderCheck();
        showToast(`Seite ${index + 1} ist wieder dabei – als eigenes Schriftstück unter „${AkteLogic.GROUPS.find(([key]) => key === groupOf(fresh))[1]}“.`, 'success');
    }
    $('akteRestart').addEventListener('click', async () => {
        if (!(await confirmDialog('Alles Eingelesene verwerfen und von vorn beginnen? Gespeichert ist noch nichts.', 'Verwerfen', 'Weiter prüfen'))) return;
        releasePages();
        pages = []; docs = []; files = []; demo = false;
        $('akteFiles').value = '';
        setFiles([]);
        show(1);
    });

    // ---------- Ein Schriftstück ansehen und berichtigen ----------
    let openId = '';
    let viewAt = 0;               // Seite innerhalb des Schriftstücks
    let zoomed = false;
    const currentDoc = () => docs.find(doc => doc.id === openId) || null;
    // Reihenfolge beim Durchblättern: wie auf der Seite – Kategorie für Kategorie, darin nach der gewählten Ordnung.
    const walkOrder = () => AkteLogic.GROUPS.flatMap(([key]) => sortedDocs(liveDocs().filter(doc => groupOf(doc) === key)));
    // Gezeigt wird die Seite in der Form, in der sie gespeichert wird.
    function fullUrl(page) {
        const picture = stored(page);
        if (page.fullOf !== picture) {
            if (page.fullUrl) URL.revokeObjectURL(page.fullUrl);
            page.fullUrl = picture ? URL.createObjectURL(picture) : '';
            page.fullOf = picture;
        }
        return page.fullUrl || page.url || '';
    }
    function fillKinds() {
        const select = $('akteDocKind');
        if (select.children.length) return;
        AkteLogic.GROUPS.forEach(([group, label]) => {
            const box = el('optgroup');
            box.label = label;
            AkteLogic.KINDS.filter(kind => kind.group === group).forEach(kind => { const option = el('option', '', kind.label); option.value = kind.key; box.append(option); });
            select.append(box);
        });
    }
    function fillLists() {
        const unique = values => [...new Set(values.map(clean).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'de'));
        $('akteDoctorList').replaceChildren(...unique(docs.map(doc => doc.doctor)).map(value => { const option = el('option'); option.value = value; return option; }));
        $('akteSpecialtyList').replaceChildren(...unique([...docs.map(doc => doc.specialty), ...directory().map(item => item.specialty)]).map(value => { const option = el('option'); option.value = value; return option; }));
    }
    function openDoc(id, at = 0) {
        openId = id;
        viewAt = at;
        zoomed = false;
        fillKinds();
        fillLists();
        renderDoc();
        const dialog = $('akteDoc');
        if (!dialog.open) dialog.showModal();
    }
    function renderDoc() {
        const doc = currentDoc();
        if (!doc) { $('akteDoc').close(); return; }
        const walk = walkOrder();
        const position = walk.findIndex(item => item.id === doc.id);
        viewAt = Math.max(0, Math.min(viewAt, doc.pages.length - 1));
        $('akteDocPos').textContent = `Schriftstück ${position + 1} von ${walk.length} · ${AkteLogic.GROUPS.find(([key]) => key === groupOf(doc))[1]}`;
        $('akteDocTitle').textContent = doc.title || kindOf(doc).label;
        const page = pages[doc.pages[viewAt]];
        const image = $('akteViewImage');
        image.src = fullUrl(page);
        image.alt = `Seite ${viewAt + 1} von ${doc.pages.length}`;
        $('akteViewFrame').classList.toggle('is-zoomed', zoomed);
        $('akteViewZoom').textContent = zoomed ? 'Kleiner' : 'Größer';
        $('akteViewPos').textContent = `Seite ${viewAt + 1} von ${doc.pages.length} (im Scan Seite ${page.index + 1})${compactOn && page.compact ? ' · Platz sparend' : ''}`;
        $('akteViewPrev').disabled = viewAt === 0;
        $('akteViewNext').disabled = viewAt >= doc.pages.length - 1;
        $('akteViewPages').replaceChildren(...doc.pages.map((index, at) => {
            const button = el('button', at === viewAt ? 'is-active' : '');
            button.type = 'button';
            button.setAttribute('aria-label', `Seite ${at + 1}`);
            if (at === viewAt) button.setAttribute('aria-current', 'true');
            if (pages[index].url) { const thumb = el('img'); thumb.src = pages[index].url; thumb.alt = ''; button.append(thumb); }
            button.append(el('span', '', String(at + 1)));
            button.addEventListener('click', () => { viewAt = at; renderDoc(); });
            return button;
        }));
        $('akteViewPages').hidden = doc.pages.length < 2;
        const hints = $('akteDocHints');
        hints.hidden = !doc.hints.length || doc.checked;
        hints.replaceChildren(...doc.hints.map(text => el('li', '', text)));
        $('akteDocKind').value = doc.key;
        $('akteDocDate').value = doc.date || '';
        $('akteDocDoctor').value = doc.doctor || '';
        $('akteDocSpecialty').value = doc.specialty || '';
        $('akteDocName').value = doc.title || '';
        $('aktePageSplit').disabled = viewAt === 0;
        $('aktePageSplit').textContent = viewAt === 0 ? 'Ab hier neues Schriftstück (erst ab Seite 2)' : `Ab Seite ${viewAt + 1} neues Schriftstück`;
        $('akteDocMerge').disabled = !previousInScan(doc);
        $('akteDocPrev').disabled = position <= 0;
        $('akteDocOk').textContent = position >= walk.length - 1 ? 'Stimmt ✓ – fertig' : 'Stimmt ✓ – weiter';
    }
    // Eingaben übernehmen (ohne zu schließen). Geänderte Felder gelten als von Hand gesetzt.
    function readForm() {
        const doc = currentDoc();
        if (!doc) return;
        const before = groupOf(doc);
        const next = { key: $('akteDocKind').value, date: $('akteDocDate').value, doctor: clean($('akteDocDoctor').value), specialty: clean($('akteDocSpecialty').value) };
        Object.entries(next).forEach(([field, value]) => { if (value !== (doc[field] || '')) { doc[field] = value; doc.manual[field] = true; } });
        const typed = clean($('akteDocName').value);
        const auto = AkteLogic.titleOf({ ...doc });
        if (typed && typed !== doc.title && typed !== auto) { doc.title = typed; doc.manual.title = true; }
        else if (!typed || !doc.manual.title) { doc.title = auto; doc.manual.title = false; }
        if (groupOf(doc) !== before) { confirmed.delete(before); confirmed.delete(groupOf(doc)); }
        addPatientHint(doc);      // ob der Name darauf stehen müsste, hängt von der Art ab
    }
    ['akteDocKind', 'akteDocDate', 'akteDocDoctor', 'akteDocSpecialty'].forEach(id => $(id).addEventListener('change', () => {
        const doc = currentDoc();
        if (!doc) return;
        readForm();
        if (!doc.manual.title) $('akteDocName').value = doc.title;
        $('akteDocTitle').textContent = doc.title;
    }));
    $('akteViewPrev').addEventListener('click', () => { viewAt -= 1; renderDoc(); });
    $('akteViewNext').addEventListener('click', () => { viewAt += 1; renderDoc(); });
    $('akteViewZoom').addEventListener('click', () => { zoomed = !zoomed; renderDoc(); });
    $('akteViewImage').addEventListener('click', () => { zoomed = !zoomed; renderDoc(); });
    const closeDoc = () => { readForm(); $('akteDoc').close(); };
    $('akteDocClose').addEventListener('click', closeDoc);
    $('akteDoc').addEventListener('cancel', event => { event.preventDefault(); closeDoc(); });
    $('akteDoc').addEventListener('close', () => { openId = ''; renderCheck(); });
    $('akteDocForm').addEventListener('submit', event => {
        event.preventDefault();
        const doc = currentDoc();
        if (!doc) return;
        readForm();
        doc.checked = true;
        doc.unsure = false;
        const walk = walkOrder();
        const position = walk.findIndex(item => item.id === doc.id);
        const next = walk[position + 1];
        if (next) openDoc(next.id); else $('akteDoc').close();
    });
    $('akteDocPrev').addEventListener('click', () => {
        readForm();
        const walk = walkOrder();
        const position = walk.findIndex(item => item.id === openId);
        if (position > 0) openDoc(walk[position - 1].id);
    });

    // Das Schriftstück, das im Scan direkt davor liegt.
    function previousInScan(doc) {
        const before = scanOrder(liveDocs()).filter(item => item.pages[0] < doc.pages[0]);
        return before[before.length - 1] || null;
    }
    $('aktePageSplit').addEventListener('click', () => {
        const doc = currentDoc();
        if (!doc || viewAt === 0) return;
        readForm();
        const rest = doc.pages.splice(viewAt);
        const fresh = fromLogic({ ...AkteLogic.describe(rest.map(index => pages[index].text || ''), { today: new Date(), directory: directory() }), pages: rest });
        docs.push(fresh);
        refreshDoc(doc);
        confirmed.delete(groupOf(doc)); confirmed.delete(groupOf(fresh));
        showToast(`Geteilt: ${plural(rest.length, 'Seite bildet', 'Seiten bilden')} jetzt ein eigenes Schriftstück.`, 'success');
        openDoc(fresh.id);
    });
    $('akteDocMerge').addEventListener('click', () => {
        const doc = currentDoc();
        const target = doc && previousInScan(doc);
        if (!target) return;
        readForm();
        const from = target.pages.length;
        target.pages = [...target.pages, ...doc.pages].sort((left, right) => left - right);
        doc.pages = [];
        docs = docs.filter(item => item !== doc);
        target.checked = false;
        refreshDoc(target);
        confirmed.delete(groupOf(doc)); confirmed.delete(groupOf(target));
        showToast('Verbunden mit dem vorherigen Schriftstück.', 'success');
        openDoc(target.id, from);
    });
    $('aktePageRemove').addEventListener('click', () => {
        const doc = currentDoc();
        if (!doc) return;
        readForm();
        const index = doc.pages[viewAt];
        doc.pages.splice(viewAt, 1);
        pages[index].removed = true;
        confirmed.delete(groupOf(doc));
        showToast(`Seite ${index + 1} entfernt.`, 'info', { actionLabel: 'Rückgängig', onAction: () => {
            pages[index].removed = false;
            doc.pages = [...doc.pages, index].sort((left, right) => left - right);
            if (!docs.includes(doc)) docs.push(doc);
            refreshDoc(doc);
            confirmed.delete(groupOf(doc));
            renderCheck();
            if ($('akteDoc').open) renderDoc();
        } });
        if (!doc.pages.length) { docs = docs.filter(item => item !== doc); $('akteDoc').close(); return; }
        refreshDoc(doc);
        renderDoc();
    });
    $('akteDocDrop').addEventListener('click', () => {
        const doc = currentDoc();
        if (!doc) return;
        readForm();
        const walk = walkOrder();
        const position = walk.findIndex(item => item.id === doc.id);
        const next = walk[position + 1] || walk[position - 1] || null;
        doc.dropped = true;
        confirmed.delete(groupOf(doc));
        showToast('Dieses Schriftstück wird nicht übernommen. Es steht unten bei den entfernten Seiten.', 'info', { actionLabel: 'Rückgängig', onAction: () => { doc.dropped = false; confirmed.delete(groupOf(doc)); renderCheck(); } });
        if (next) openDoc(next.id); else $('akteDoc').close();
    });
    // Seite um 90° drehen: Das Bild wird neu gespeichert. Die Lage der Wörter stimmt danach nicht mehr – der Text bleibt.
    $('aktePageTurn').addEventListener('click', async () => {
        const doc = currentDoc();
        if (!doc) return;
        const button = $('aktePageTurn');
        const page = pages[doc.pages[viewAt]];
        if (!page.blob) return;
        button.disabled = true;
        try {
            const turnedOf = async picture => {
                const bitmap = await createImageBitmap(picture);
                const canvas = Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
                canvas.getContext('2d').drawImage(bitmap, 0, 0);
                bitmap.close?.();
                return DocScan.turn(canvas, 1);
            };
            const turned = await turnedOf(page.blob);
            const toBlob = (source, quality) => new Promise(resolve => source.toBlob(resolve, 'image/jpeg', quality));
            const scale = Math.min(1, 300 / Math.max(turned.width, turned.height));
            const small = Object.assign(document.createElement('canvas'), { width: Math.round(turned.width * scale), height: Math.round(turned.height * scale) });
            small.getContext('2d').drawImage(turned, 0, 0, small.width, small.height);
            const [blob, thumb] = await Promise.all([toBlob(turned, 0.82), toBlob(small, 0.6)]);
            // Die Platz sparende Form wird aus sich selbst gedreht – ohne Umweg über das JPEG, also ohne Verlust.
            const compact = page.compact && DocScan.compact ? await DocScan.compact(await turnedOf(page.compact)) : null;
            if (page.url) URL.revokeObjectURL(page.url);
            if (page.fullUrl) URL.revokeObjectURL(page.fullUrl);
            Object.assign(page, { blob, thumb, compact, width: turned.width, height: turned.height, words: [], url: URL.createObjectURL(thumb), fullUrl: '', fullOf: null });
            renderDoc();
            renderCheck();
        } catch (error) {
            showToast('Die Seite konnte nicht gedreht werden.', 'error');
        } finally { button.disabled = false; }
    });

    // ---------- Schritt 4: Speichern ----------
    const safe = text => clean(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    let saveQueue = [];           // { doc, done, error, path }
    function documentRow(doc, part, parts, path, bytes, pageList) {
        const kind = kindOf(doc);
        const title = `${doc.title || kind.label}${parts > 1 ? ` (Teil ${part} von ${parts})` : ''}`;
        const text = pageList.map((index, at) => clean(pages[index].text) ? `--- Seite ${at + 1} ---\n${clean(pages[index].text)}` : '').filter(Boolean).join('\n\n').slice(0, 60000);
        return {
            id: uuid(), patient_nr: patient.nr, patient_name: patient.name, patient_birth: patient.birth, date: doc.date || null, doctor: doc.doctor || '',
            kind: kind.kind, title, specialty: doc.specialty || '', note: '', body: '', pages: pageList.length, file_path: path, file_bytes: bytes,
            text_content: text, warnings: doc.hints.filter(hint => /fehl/i.test(hint)), uploader_id: profile.id, uploader_name: profile.full_name || profile.email || '',
            status: 'archiv', import_id: importId, checked_at: new Date().toISOString(), checked_by: profile.full_name || ''
        };
    }
    async function buildPdf(doc, pageList) {
        return DocPdf.build({
            pages: pageList.map(index => ({ blob: stored(pages[index]), width: pages[index].width, height: pages[index].height, words: pages[index].words })),
            title: `${doc.title || kindOf(doc).label} · ${[patient.nr, patient.name].filter(Boolean).join(' ')}`,
            subject: [doc.date ? `vom ${formatDay(doc.date)}` : '', doc.doctor, doc.specialty].filter(Boolean).join(' · '),
            author: profile.full_name || '', keywords: [patient.nr, patient.name, kindOf(doc).kind, doc.specialty, 'Papierakte'].filter(Boolean)
        });
    }
    async function saveOne(entry, number) {
        const { doc } = entry;
        // Sehr lange Schriftstücke in Teilen speichern (höchstens 20 MB je Datei).
        const bytes = doc.pages.reduce((sum, index) => sum + (stored(pages[index])?.size || 0), 0);
        const parts = Math.max(1, Math.ceil(bytes / (MAX_PDF_BYTES * 0.9)));
        const per = Math.ceil(doc.pages.length / parts);
        entry.rows = entry.rows || [];
        for (let part = entry.rows.length + 1; part <= parts; part++) {
            const pageList = doc.pages.slice((part - 1) * per, part * per);
            if (!pageList.length) continue;
            const pdf = await buildPdf(doc, pageList);
            if (pdf.size > 20 * 1024 * 1024) throw new Error('Das Schriftstück ist zu groß für eine Datei. Bitte teile es beim Prüfen in kleinere Stücke.');
            const name = DocPdf.fileName({ patientNr: patient.nr, patientName: patient.name, kind: kindOf(doc).kind, date: doc.date || '' });
            const path = `akten/${safe(patient.nr) || 'ohne-nummer'}/${importId}/${String(number).padStart(3, '0')}${parts > 1 ? `-${part}` : ''}-${name}`;
            let upload = await client.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: false });
            if (upload.error && /exist|duplicate/i.test(String(upload.error.message || upload.error.error || ''))) {
                // Rest eines abgebrochenen Versuchs: erst entfernen, dann neu hochladen.
                await client.storage.from(BUCKET).remove([path]);
                upload = await client.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: false });
            }
            if (upload.error) throw upload.error;
            const row = documentRow(doc, part, parts, path, pdf.size, pageList);
            const { error } = await client.from('tt_documents').insert(row);
            if (error) { await client.storage.from(BUCKET).remove([path]); throw error; }
            entry.rows.push({ id: row.id, pages: pageList.length });
        }
        entry.done = true;
        entry.error = '';
    }
    async function runSave() {
        busy = true;
        $('akteSaveDone').hidden = true;
        $('akteSaveRetry').hidden = true;
        $('akteSaveProblems').hidden = true;
        const total = saveQueue.length;
        for (let index = 0; index < total; index++) {
            const entry = saveQueue[index];
            const share = Math.round(saveQueue.filter(item => item.done).length / total * 100);
            $('akteSaveBar').style.width = `${share}%`;
            $('akteSaveProgress').setAttribute('aria-valuenow', String(share));
            if (entry.done) continue;
            $('akteSaveText').textContent = `Schriftstück ${index + 1} von ${total} wird gespeichert: ${entry.doc.title}`;
            try { await saveOne(entry, index + 1); }
            catch (error) {
                entry.error = /does not exist|schema cache|column|violates check/i.test(String(error?.message || ''))
                    ? 'Die Datenbank kennt die Papierakte noch nicht (Update 29 fehlt). Bitte supabase/update-29.sql im SQL Editor ausführen.' : TerminCloud.germanError(error);
                if (/Update 29/.test(entry.error)) break;      // das trifft alle – nicht hundertmal versuchen
            }
        }
        busy = false;
        const done = saveQueue.filter(item => item.done);
        const failed = saveQueue.filter(item => !item.done);
        $('akteSaveBar').style.width = `${Math.round(done.length / total * 100)}%`;
        const savedPages = done.reduce((sum, item) => sum + item.rows.reduce((inner, row) => inner + row.pages, 0), 0);
        const wantedPages = saveQueue.reduce((sum, item) => sum + item.doc.pages.length, 0);
        if (failed.length) {
            $('akteSaveText').textContent = `${done.length} von ${total} Schriftstücken sind gespeichert – ${failed.length === 1 ? 'eines fehlt' : `${failed.length} fehlen`} noch.`;
            const box = $('akteSaveProblems');
            box.hidden = false;
            box.replaceChildren(...[...new Set(failed.map(item => item.error || 'Noch nicht gespeichert.'))].map(text => el('li', '', text)));
            $('akteSaveRetry').hidden = false;
            return;
        }
        // Zur Sicherheit nachzählen: Steht jede Seite in der Akte?
        const complete = savedPages === wantedPages;
        $('akteSaveText').textContent = '';
        $('akteDoneTitle').textContent = `${plural(done.length, 'Schriftstück', 'Schriftstücke')} mit ${plural(savedPages, 'Seite', 'Seiten')} gespeichert`;
        $('akteDoneText').textContent = `${complete ? 'Alle Seiten sind in der Akte – nachgezählt ✓.' : `Achtung: ${wantedPages - savedPages} Seiten fehlen!`} Patient ${patient.nr}${patient.name ? ` · ${patient.name}` : ''}. Die Dolmetscher sehen die Akte, sobald sie einen Auftrag für diesen Patienten zugesagt haben.`;
        $('akteOpenChart').href = `patienten.html?akte=${encodeURIComponent(patient.nr)}`;
        $('akteSaveDone').hidden = false;
        step = 4;
        // Anlernen: Was hier bestätigt wurde, gilt für die nächsten Akten (nur der Kopf des Schriftstücks – keine Patientendaten).
        try {
            let memory = readLearned();
            const day = new Date().toISOString().slice(0, 10);
            done.forEach(item => {
                const doc = item.doc, text = pages[doc.pages[0]]?.text || '';
                if (doc.key === 'sonst' && !doc.manual.key) return;      // nichts Sicheres zu lernen
                memory = AkteLogic.learn(memory, { text, key: doc.key, doctor: doc.doctor || '', specialty: doc.specialty || '', fixed: Boolean(doc.manual.key), exclude: [patient.name], day });
            });
            localStorage.setItem(LEARN_KEY, JSON.stringify(memory));
        } catch (error) { /* das Gelernte ist eine Hilfe – die Akte ist gespeichert */ }
        releasePages();
        pages = []; docs = [];
        loadSpace();
    }
    $('akteSave').addEventListener('click', async () => {
        if (demo) return;
        const live = sortedDocs(liveDocs());
        const count = counts();
        if (!(await confirmDialog(`${plural(count.live, 'Schriftstück', 'Schriftstücke')} mit ${plural(count.inDocs, 'Seite', 'Seiten')} in die Akte von Patient ${patient.nr}${patient.name ? ` (${patient.name})` : ''} speichern?`, 'Speichern', 'Noch nicht'))) return;
        // In der Akte neueste zuerst – gespeichert wird in der Reihenfolge des Scans (so bleiben die Dateien nachvollziehbar).
        saveQueue = scanOrder(live).map(doc => ({ doc, done: false, error: '', rows: [] }));
        show(4);
        await runSave();
    });
    $('akteRetry').addEventListener('click', () => runSave());
    $('akteBackToCheck').addEventListener('click', () => {
        // Schon Gespeichertes bleibt gespeichert und wird nicht noch einmal angeboten.
        const saved = new Set(saveQueue.filter(item => item.done).map(item => item.doc.id));
        docs = docs.filter(doc => !saved.has(doc.id));
        show(3);
        renderCheck();
    });
    $('akteAgain').addEventListener('click', () => {
        files = []; demo = false;
        $('akteFiles').value = '';
        ['aktePatientNr', 'aktePatientName', 'aktePatientBirth'].forEach(id => { $(id).value = ''; });
        setFiles([]);
        fillFromKnown();
        show(1);
    });

    // ---------- Start ----------
    async function init() {
        if (!client) { setStatus('Die Verbindung zur Datenbank konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu.', 'error'); return; }
        try { profile = await TerminCloud.getProfile(true); } catch (error) { setStatus(error.message, 'error'); return; }
        if (!TerminCloud.isStaff(profile)) { setStatus('Bitte melde dich zuerst auf der Seite „Team“ als Einsatzleitung an.', 'error'); return; }
        if (!window.DocScan || !window.AkteLogic || !window.AkteImport || !window.DocPdf) { setStatus('Ein Teil des Programms wurde nicht geladen. Bitte die Seite neu laden.', 'error'); return; }
        // Aus der Patientenakte geöffnet: Nummer, Name und Geburtsdatum stehen schon da (übergeben im Speicher dieses Tabs –
        // nicht in der Adresse, damit kein Name im Verlauf des Browsers landet). In der Adresse steht höchstens die Nummer.
        let handed = null;
        try { handed = JSON.parse(sessionStorage.getItem(HANDOVER_KEY) || 'null'); sessionStorage.removeItem(HANDOVER_KEY); } catch (error) { handed = null; }
        const query = new URLSearchParams(location.search);
        $('aktePatientNr').value = clean(handed?.nr) || clean(query.get('nr'));
        $('aktePatientName').value = clean(handed?.name);
        $('aktePatientBirth').value = /^\d{2}\.\d{2}\.\d{4}$/.test(clean(handed?.birth)) ? clean(handed.birth) : '';
        if (query.has('nr')) history.replaceState(null, '', location.pathname);
        $('akteApp').hidden = false;
        show(1);
        updateStart();
        loadKnownPatients();
        loadSpace();
        window.refreshCloudInbox?.();
    }
    async function loadSpace() {
        try {
            const usage = await TerminCloud.usage();
            space = usage ? { freeMb: Math.max(0, usage.photosLimitMb - usage.photosMb), limitMb: usage.photosLimitMb } : null;
        } catch (error) { space = null; }
        if (step === 3) renderCheck();
    }
    // Für Tests und zum Nachsehen in der Konsole
    window.AkteEinlesen = { applyLearned, state: () => ({ step, patient, pages, docs, confirmed: [...confirmed], order, demo, importId, saveQueue, space, compact: compactOn }), patientHint, refreshSpace: () => loadSpace() };
    init();
})();
