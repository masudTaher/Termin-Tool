// Dolmetscher-Portal · Unterlagen: Arztbericht, Rezept oder Überweisung fotografieren → ein PDF für das Büro.
// Außerdem: der Bericht über Termin. Gehört zu portalApp.js (Schnittstelle window.PortalCore).
// Ablauf: 1 Termin wählen · 2 Art wählen · 3 Seiten fotografieren (Rand wird erkannt, Qualität geprüft) · 4 prüfen und senden.
// Alles läuft auf dem Handy: Zuschnitt, Prüfung, Texterkennung und PDF. Gesendet wird nur das fertige PDF.
window.PortalDocs = (function () {
    const core = window.PortalCore;
    const $ = id => document.getElementById(id);
    const { client, toast, el, svgSpan } = core;
    const KINDS = core.config.documentKinds || ['Arztbericht', 'Rezept Medikamente', 'Rezept Physiotherapie', 'Rezept Hilfsmittel', 'Überweisung Facharzt', 'Überweisung Radiologie', 'Sonstiges'];
    const REPORT_KIND = 'Dolmetscherbericht';
    const MAX_PAGES = 20;
    const MAX_PDF_BYTES = 19 * 1024 * 1024;      // der Speicher nimmt höchstens 20 MB je Datei an
    const OCR_LIBRARY = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    const OCR_TIMEOUT = 60000;
    const COLUMNS = 'id, created_at, patient_nr, patient_name, patient_birth, date, doctor, appointment_id, assignment_id, kind, note, body, pages, file_path, warnings, status';

    let documents = [];        // eigene Unterlagen und Berichte der letzten 30 Tage
    let draft = null;          // Unterlage, die gerade entsteht: { source, kind, pages: [], note }
    let pending = null;        // Auftrag, zu dem der Ablauf direkt starten soll (Knopf auf der Auftragskarte)
    let wizard = null;
    let pageCounter = 0;
    let busy = 0;              // Fotos, die gerade zugeschnitten und geprüft werden
    let replaceId = null;      // Seite, die das nächste Foto ersetzt („Neu aufnehmen“)
    let sending = false;

    const today = () => TerminCloud.todayIso();
    const dayText = iso => iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
    const shortDay = iso => new Date(`${iso}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
    const icon = paths => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
    const KIND_ICONS = {
        'Arztbericht': icon('<path d="M7.500 3.500H14l4.500 4.500V19a1.500 1.500 0 0 1-1.500 1.500H7.500A1.500 1.500 0 0 1 6 19V5a1.500 1.500 0 0 1 1.500-1.500z"/><path d="M14 3.500V8h4.500"/><path d="M9 12.500h6M9 16h4"/>'),
        'Rezept Medikamente': icon('<rect x="3.500" y="8.500" width="17" height="7" rx="3.500" transform="rotate(-45 12 12)"/><path d="M9.500 9.500l5 5"/>'),
        'Rezept Physiotherapie': icon('<circle cx="12" cy="5.500" r="2"/><path d="M5 10.500l7-1.500 7 1.500M12 9v6l-3.500 5M12 15l3.500 5"/>'),
        'Überweisung Facharzt': icon('<path d="M4 12h13M12.500 7.500 17 12l-4.500 4.500"/><path d="M20 5v14"/>'),
        'Rezept Hilfsmittel': icon('<circle cx="9" cy="16.500" r="4"/><path d="M9 12.500V5.500H6.500M9 9.500h5.500l2 6H19"/><circle cx="18.500" cy="18.500" r="1.500"/>'),
        'Überweisung Radiologie': icon('<rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="12" cy="12" r="3.500"/><path d="M12 5v2M12 17v2M4 12h2M18 12h2"/>'),
        'Sonstiges': icon('<path d="M3.500 7.500a2 2 0 0 1 2-2h4l2 2.200h7a2 2 0 0 1 2 2v7.800a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>')
    };
    // Kurze Erklärung unter der Art – damit die Unterlage in der richtigen Kategorie landet.
    const KIND_HINTS = {
        'Arztbericht': 'Befund, Arztbrief, Entlassbericht',
        'Rezept Medikamente': 'für die Apotheke',
        'Rezept Physiotherapie': 'Krankengymnastik, Massage, Lymphdrainage',
        'Rezept Hilfsmittel': 'z. B. Rollstuhl, Bandage, Einlagen',
        'Überweisung Facharzt': 'an einen anderen Arzt',
        'Überweisung Radiologie': 'MRT, CT, Röntgen'
    };
    const STATUS = { neu: ['in Arbeit', 'gesendet'], 'geprüft': ['erledigt', 'geprüft'], weitergeleitet: ['erledigt', 'weitergeleitet'] };
    const ISSUE_SHORT = { dunkel: 'ist zu dunkel', hell: 'ist überbelichtet', unscharf: 'ist unscharf', klein: 'ist sehr klein', kontrast: 'hat kaum erkennbare Schrift' };

    // ---------- Liste „Zuletzt gesendet“ ----------
    async function load() {
        const profile = core.profile();
        if (!profile?.active) return;
        const since = new Date(Date.now() - 30 * 86400000).toISOString();
        const { data, error } = await client.from('tt_documents').select(COLUMNS).eq('uploader_id', profile.id)
            .gte('created_at', since).order('created_at', { ascending: false }).limit(100);
        const list = $('docList');
        if (error) {
            documents = [];
            list.replaceChildren(core.emptyItem(/does not exist|schema cache|could not find/i.test(error.message || '')
                ? 'Die Unterlagen sind in der Datenbank noch nicht eingerichtet (Update 10 fehlt).'
                : 'Die Unterlagen konnten nicht geladen werden.'));
            return;
        }
        documents = data || [];
        renderList();
    }

    function renderList() {
        const list = $('docList');
        const todayCount = documents.filter(item => String(item.created_at).slice(0, 10) === new Date().toISOString().slice(0, 10)).length;
        $('docsSummary').textContent = todayCount
            ? `Heute hast du ${todayCount} ${todayCount === 1 ? 'Unterlage' : 'Unterlagen'} gesendet.`
            : 'Arztbericht, Rezept oder Überweisung scannen – daraus wird automatisch ein PDF für das Büro.';
        if (!documents.length) { list.replaceChildren(core.emptyItem('Du hast in den letzten 30 Tagen noch nichts gesendet.')); return; }
        list.replaceChildren(...documents.map(item => {
            const entry = el('li', 'directory-entry damage-entry sent-doc');
            const text = el('span', 'directory-entry-name');
            const isReport = item.kind === REPORT_KIND;
            const who = isReport ? [item.patient_name || '', item.patient_nr ? `Patient ${item.patient_nr}` : '', `Termin ${dayText(item.date)}`].filter(Boolean).join(' · ') : [item.patient_nr ? `Patient ${item.patient_nr}` : '', item.patient_name].filter(Boolean).join(' · ');
            text.append(el('strong', '', isReport ? (item.assignment_id ? 'Bericht über Termin' : 'Bericht über den Tag') : item.kind), el('small', '', [who, !isReport && item.date ? `Termin ${dayText(item.date)}` : '', item.pages ? `${item.pages} ${item.pages === 1 ? 'Seite' : 'Seiten'}` : ''].filter(Boolean).join(' · ')));
            if (item.warnings?.length) text.append(el('small', 'sent-doc-warning', item.warnings.join(' ')));
            const side = el('span', 'vehicle-entry-actions');
            const [status, label] = STATUS[item.status] || STATUS.neu;
            const state = el('span', 'status-pill', label);
            state.dataset.status = status;
            side.append(state);
            if (item.file_path) {
                const view = el('button', 'button-quiet', 'Ansehen');
                view.type = 'button';
                view.addEventListener('click', () => viewFile(item));
                side.append(view);
            }
            if (isReport && item.body) {
                // Eigener Bericht: als PDF öffnen (drucken oder speichern) und – mit Auftrag – jederzeit bearbeiten.
                const pdf = el('button', 'button-quiet doc-report-pdf', 'Ansehen · Drucken');
                pdf.title = 'Als PDF öffnen – ansehen, drucken oder speichern';
                pdf.type = 'button';
                pdf.addEventListener('click', () => openReportPdf(item, pdf));
                side.append(pdf);
                if (item.assignment_id) {
                    const edit = el('button', 'button-quiet doc-report-edit', 'Bearbeiten');
                    edit.type = 'button';
                    edit.addEventListener('click', () => { reportJobId = item.assignment_id; core.goTo('docReport'); });
                    side.append(edit);
                }
            }
            if (item.status === 'neu') {
                const remove = el('button', 'button-quiet-danger', 'Löschen');
                remove.type = 'button';
                remove.addEventListener('click', () => removeDocument(item, remove));
                side.append(remove);
            }
            entry.append(text, side);
            return entry;
        }));
    }

    // Bericht als PDF (gleiches Blatt wie im Büro): öffnet in einem neuen Fenster – dort drucken oder speichern.
    // Kann der Browser das Fenster nicht öffnen, wird die Datei gespeichert.
    async function openReportPdf(item, button) {
        const tab = window.open('', '_blank');
        if (button) button.disabled = true;
        try {
            const next = String(item.note || '').startsWith('Nächster Termin: ') ? String(item.note).slice('Nächster Termin: '.length) : '';
            const written = String(item.created_at || '').slice(0, 10);
            const { blob } = await DocPdf.report({
                organisation: 'Botschaft Katar · Medical Office Bonn · Abteilung Transport und Dolmetscher',
                title: 'Bericht über Termin',
                meta: [['Patient/in', item.patient_name || ''], ['Patientennummer', item.patient_nr || ''], ['Geburtsdatum', item.patient_birth || ''], ['Arzt / Praxis', item.doctor || ''],
                    ['Termin am', dayText(item.date)], ['Bericht vom', dayText(written)], ['Dolmetscher/in', core.profile()?.full_name || ''], ['Nächster Termin', next || 'keiner angegeben']],
                sections: [{ heading: 'Bericht', text: [String(item.body || '').trim(), next ? `Nächster Termin: ${next}` : ''].filter(Boolean).join('\n\n') }, { heading: 'Hinweis', text: next ? '' : (item.note || '') },
                    { heading: 'Unterschrift', text: `${core.profile()?.full_name || ''}\n${dayText(written)}` }],
                footer: 'Medical Office Bonn · Transport und Dolmetscher', author: core.profile()?.full_name || '', subject: 'Bericht über Termin'
            });
            const url = URL.createObjectURL(blob);
            const name = DocPdf.fileName({ patientNr: item.patient_nr || '', patientName: item.patient_name || '', kind: REPORT_KIND, date: item.date || written });
            if (tab && !tab.closed) { tab.location.replace(url); toast('Der Bericht ist als PDF geöffnet – dort kannst du drucken oder speichern.', 'success'); }
            else { const link = document.createElement('a'); link.href = url; link.download = name; link.click(); toast('Der Bericht wurde als PDF gespeichert.', 'success'); }
            window.setTimeout(() => URL.revokeObjectURL(url), 300000);
            return true;
        } catch (error) {
            tab?.close();
            toast(`Das PDF konnte nicht erstellt werden: ${error?.message || error}`, 'error');
            return false;
        } finally {
            if (button) button.disabled = false;
        }
    }

    async function viewFile(item) {
        const { data, error } = await client.storage.from('dokumente').createSignedUrl(item.file_path, 300);
        if (error || !data?.signedUrl) { toast('Das PDF konnte nicht geöffnet werden.', 'error'); return; }
        window.open(data.signedUrl, '_blank', 'noopener');
    }

    // Löschen geht, solange das Büro die Unterlage noch nicht geprüft hat. Zweiter Tipp bestätigt.
    async function removeDocument(item, button) {
        if (button.dataset.armed !== 'yes') {
            button.dataset.armed = 'yes';
            button.textContent = 'Wirklich löschen?';
            window.setTimeout(() => { button.dataset.armed = ''; button.textContent = 'Löschen'; }, 4000);
            return;
        }
        button.disabled = true;
        const { error } = await client.from('tt_documents').delete().eq('id', item.id);
        if (error) { toast(TerminCloud.germanError(error), 'error'); button.disabled = false; return; }
        if (item.file_path) await client.storage.from('dokumente').remove([item.file_path]);
        toast('Gelöscht.', 'success');
        await load();
    }

    function open() { load(); }

    // ---------- Schritt 1: Termin wählen ----------
    // Aus dem gesendeten Auftrag kommen Patient, Aktennummer und Arzt – so muss niemand etwas abtippen.
    function sourceOf(job) {
        const parsed = core.parseJobMessage(job.message);
        const facts = parsed?.facts || {};
        const doctor = parsed?.sections.find(section => /ARZT/.test(section.title))?.fields.find(([label]) => label === 'Name')?.[1] || '';
        return {
            assignmentId: job.id, appointmentId: job.appointment_id || null, date: job.date, time: String(job.time || '').slice(0, 5),
            patientNr: String(facts['Aktennummer'] || '').trim(), patientName: String(facts['Hauptpatient/in'] || facts['Patient/in'] || '').trim(),
            patientBirth: String(facts['Geburtsdatum'] || '').trim(),
            doctor: String(doctor || '').trim(), title: job.title || ''
        };
    }

    function recentJobs() {
        const from = core.isoDate(new Date(Date.now() - 7 * 86400000));
        return core.jobs().filter(job => !job.cancelled && job.response !== 'abgesagt' && job.date <= today() && job.date >= from)
            .sort((left, right) => right.date.localeCompare(left.date) || String(left.time).localeCompare(String(right.time)));
    }

    function startWizard() {
        if (!wizard) wizard = core.makeWizard('doc', 4, leaveWizard);
        stopOcr();
        draft = { source: null, kind: '', pages: [], note: '' };
        busy = 0;
        replaceId = null;
        sending = false;
        $('docNote').value = '';
        $('docManualForm').hidden = true;
        $('docManualForm').reset();
        wizard.show(1);
        renderPages();
        // Zuerst die Termine von heute (ob abgeschlossen oder nicht). Frühere Termine und „selbst eintippen“ stehen darunter.
        const list = $('docJobs');
        const all = recentJobs();
        const jobCard = job => {
            const source = sourceOf(job);
            const card = el('button', 'car-card doc-job');
            card.type = 'button';
            const main = el('span', 'car-card-main');
            main.append(el('strong', '', source.patientName || source.title || 'Termin'),
                el('span', '', [job.date === today() ? 'Heute' : shortDay(job.date), source.time ? `${source.time} Uhr` : '', source.doctor].filter(Boolean).join(' · ')));
            const chips = el('span', 'car-card-chips');
            if (source.patientNr) chips.append(el('em', 'chip chip-brand', `Nr. ${source.patientNr}`));
            const sent = documents.filter(item => item.assignment_id === job.id).length;
            if (sent) chips.append(el('em', 'chip', `${sent} schon gesendet`));
            card.append(main, chips, el('span', 'car-card-arrow', '›'));
            card.addEventListener('click', () => chooseSource(source));
            return card;
        };
        const todays = all.filter(job => job.date === today());
        const earlier = all.filter(job => job.date !== today());
        list.replaceChildren(...todays.map(jobCard));
        if (!todays.length) list.append(el('p', 'directory-empty doc-no-today', 'Für heute steht kein Termin in der App.'));
        if (earlier.length) {
            const more = el('button', 'link-button doc-earlier', `Termine der letzten Tage anzeigen (${earlier.length})`);
            more.type = 'button';
            more.addEventListener('click', () => { more.replaceWith(...earlier.map(jobCard)); });
            list.append(more);
        }
        const other = el('button', 'car-card doc-job doc-job-other');
        other.type = 'button';
        const otherMain = el('span', 'car-card-main');
        otherMain.append(el('strong', '', 'Termin nicht dabei'), el('span', '', 'Patient selbst eintippen'));
        other.append(otherMain, el('span', 'car-card-arrow', '›'));
        other.addEventListener('click', () => showManual({ date: today() }));
        list.append(other);
        const direct = pending;
        pending = null;
        if (direct?.retake) {
            // Die Einsatzleitung bittet um eine neue Aufnahme: Patient, Arzt, Datum und Art sind schon bekannt.
            const known = direct.retake.context || {};
            draft.requestId = direct.retake.id;
            draft.source = {
                assignmentId: known.assignment_id || null, appointmentId: known.appointment_id || null, date: known.date || today(), time: '',
                patientNr: String(known.patient_nr || '').trim(), patientName: String(known.patient_name || '').trim(), doctor: String(known.doctor || '').trim(), title: direct.retake.title || ''
            };
            if (KINDS.includes(known.kind)) {
                draft.kind = known.kind;
                $('docPatientLine').textContent = patientLine();
                $('docCameraLabel').textContent = 'Seite scannen';
                wizard.show(3);
            } else showKinds();
        } else if (direct) chooseSource(sourceOf(direct));
    }

    function leaveWizard() {
        stopOcr();
        draft = null;
        core.goTo('docs');
    }

    // Ohne Patientennummer und ohne Namen lässt sich die Unterlage im Büro nicht zuordnen.
    function chooseSource(source) {
        if (!source.patientNr) { showManual(source); return; }
        draft.source = source;
        showKinds();
    }

    function showManual(source) {
        draft.source = null;
        const form = $('docManualForm');
        form.hidden = false;
        form.dataset.assignment = source.assignmentId || '';
        form.dataset.appointment = source.appointmentId || '';
        $('docPatientNr').value = source.patientNr || '';
        $('docPatientName').value = source.patientName || '';
        $('docDoctor').value = source.doctor || '';
        form.dataset.birth = source.patientBirth || '';      // kommt nur aus einem Auftrag – von Hand wird kein Geburtsdatum abgefragt
        $('docDate').value = source.date || today();
        $('docDate').max = today();
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
        $('docPatientNr').focus({ preventScroll: true });
    }

    $('docManualForm').addEventListener('submit', event => {
        event.preventDefault();
        const form = event.target;
        const patientNr = $('docPatientNr').value.trim();
        const patientName = $('docPatientName').value.trim();
        if (!patientNr && !patientName) { toast('Bitte trag die Patientennummer oder den Namen ein.', 'error', '#docPatientNr'); return; }
        if (!$('docDate').value || $('docDate').value > today()) { toast('Bitte prüfe das Datum des Termins.', 'error', '#docDate'); return; }
        draft.source = { assignmentId: form.dataset.assignment || null, appointmentId: form.dataset.appointment || null, date: $('docDate').value, time: '',
            patientNr, patientName, patientBirth: form.dataset.birth || '', doctor: $('docDoctor').value.trim(), title: '' };
        showKinds();
    });

    // ---------- Schritt 2: Art der Unterlage ----------
    function patientLine() {
        const source = draft.source;
        return [source.patientNr ? `Patient ${source.patientNr}` : '', source.patientName, `Termin ${dayText(source.date)}`, source.doctor].filter(Boolean).join(' · ');
    }

    function showKinds() {
        $('docPatientLine').textContent = patientLine();
        $('docKinds').replaceChildren(...KINDS.map(kind => {
            const button = el('button', 'choice-button doc-kind');
            button.type = 'button';
            const label = el('span', 'doc-kind-text');
            label.append(el('strong', '', kind));
            if (KIND_HINTS[kind]) label.append(el('small', '', KIND_HINTS[kind]));
            button.append(svgSpan('doc-kind-icon', KIND_ICONS[kind] || KIND_ICONS.Sonstiges), label);
            button.addEventListener('click', () => {
                draft.kind = kind;
                $('docCameraLabel').textContent = 'Seite scannen';
                wizard.show(3);
            });
            return button;
        }));
        wizard.show(2);
    }

    // ---------- Schritt 3: Seiten fotografieren ----------
    // Je Seite bleiben nur das fertige Bild (JPEG) und eine kleine Vorschau im Speicher – große Zwischenbilder werden sofort verworfen.
    function thumbnail(canvas) {
        const scale = Math.min(1, 150 / Math.max(canvas.width, canvas.height));
        const small = document.createElement('canvas');
        small.width = Math.max(1, Math.round(canvas.width * scale));
        small.height = Math.max(1, Math.round(canvas.height * scale));
        small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
        return small;
    }

    function applyResult(page, result) {
        Object.assign(page, { blob: result.blob, width: result.width, height: result.height, cropped: Boolean(result.cropped),
            issues: result.issues || [], thumb: thumbnail(result.canvas), text: '', words: [], counter: null });
    }

    function setBusy(text) {
        $('docBusy').hidden = !text;
        $('docBusy').textContent = text || '';
        $('docPagesNext').disabled = busy > 0 || !draft?.pages.length;
    }

    async function addFiles(fileList) {
        const files = [...(fileList || [])].filter(file => /^image\//.test(file.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(file.name || ''));
        if (!files.length || !draft) return;
        const target = replaceId;
        replaceId = null;
        const session = draft;
        for (const [index, file] of files.entries()) {
            if (draft !== session) return;      // der Ablauf wurde inzwischen verlassen
            const replacing = index === 0 && target ? draft.pages.find(page => page.id === target) : null;
            if (!replacing && draft.pages.length >= MAX_PAGES) { toast(`Mehr als ${MAX_PAGES} Seiten passen nicht in ein PDF. Bitte sende den Rest als zweite Unterlage.`, 'error'); break; }
            busy += 1;
            setBusy(files.length > 1 ? `Foto ${index + 1} von ${files.length} wird geprüft …` : 'Foto wird geprüft …');
            try {
                const result = await DocScan.process(file);
                if (draft !== session) return;
                const page = replacing || { id: ++pageCounter, canCrop: false };
                page.file = file;
                page.canCrop = Boolean(result.cropped);
                applyResult(page, result);
                if (!replacing) draft.pages.push(page);
                queueOcr(page);
            } catch (error) {
                toast(error?.message || 'Das Foto konnte nicht geöffnet werden.', 'error', '#docCamera');
            } finally {
                busy -= 1;
            }
            renderPages();
        }
        setBusy('');
        renderPages();
        const bad = draft.pages.find(page => page.issues.length);
        if (bad && files.length === 1) toast(bad.issues[0].text, 'error', `#docPage${bad.id}`);
    }

    // Scannen mit der Kamera in der App (Rahmen, erkannte Kanten, Knopf „Scannen“). Geht das auf dem Gerät nicht
    // (keine Erlaubnis, sehr alter Browser), öffnet sich wie früher die Foto-App des Handys.
    let cameraOpen = false;
    async function openCamera() {
        if (cameraOpen) return;
        if (!window.ScanCam?.supported()) { $('docCamera').click(); return; }
        cameraOpen = true;
        const replacing = Boolean(replaceId);
        try {
            const result = await ScanCam.open({
                title: replacing ? 'Seite neu scannen' : 'Unterlage scannen', single: replacing,
                count: replacing ? 0 : (draft?.pages.length || 0),
                onCapture: file => addFiles([file])
            });
            if (result.reason === 'galerie') { $('docGallery').click(); return; }
            if (result.reason === 'fehler') {
                toast(`${result.error || 'Die Kamera konnte nicht gestartet werden.'} Es öffnet sich die Foto-App.`, 'info');
                $('docCamera').click();
            }
        } finally { cameraOpen = false; }
    }
    document.querySelector('label[for="docCamera"]')?.addEventListener('click', event => { event.preventDefault(); openCamera(); });

    $('docCamera').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; addFiles(files); });
    $('docGallery').addEventListener('change', event => { const files = [...event.target.files]; event.target.value = ''; replaceId = null; addFiles(files); });

    // Eine Vierteldrehung nach rechts (wenn das Blatt quer oder auf dem Kopf fotografiert wurde).
    async function rotatePage(page) {
        busy += 1;
        setBusy('Seite wird gedreht …');
        try {
            const bitmap = await createImageBitmap(page.blob);
            const canvas = document.createElement('canvas');
            canvas.width = bitmap.height;
            canvas.height = bitmap.width;
            const context = canvas.getContext('2d');
            context.translate(canvas.width, 0);
            context.rotate(Math.PI / 2);
            context.drawImage(bitmap, 0, 0);
            bitmap.close?.();
            const blob = await DocScan.toBlob(canvas);
            Object.assign(page, { blob, width: canvas.width, height: canvas.height, thumb: thumbnail(canvas), text: '', words: [], counter: null });
            queueOcr(page);
        } catch (error) {
            toast('Die Seite konnte nicht gedreht werden.', 'error');
        } finally {
            busy -= 1;
            setBusy('');
            renderPages();
        }
    }

    // Zuschnitt aus/an: Wenn der erkannte Rand nicht stimmt, lässt sich das ganze Foto verwenden.
    async function toggleCrop(page) {
        busy += 1;
        setBusy('Foto wird neu geprüft …');
        try {
            applyResult(page, await DocScan.process(page.file, { crop: !page.cropped }));
            queueOcr(page);
        } catch (error) {
            toast(error?.message || 'Das Foto konnte nicht geöffnet werden.', 'error');
        } finally {
            busy -= 1;
            setBusy('');
            renderPages();
        }
    }

    function movePage(page, step) {
        const from = draft.pages.indexOf(page);
        const to = from + step;
        if (to < 0 || to >= draft.pages.length) return;
        draft.pages.splice(to, 0, draft.pages.splice(from, 1)[0]);
        renderPages();
    }

    function pageAction(text, handler, className = 'button-quiet', label = '') {
        const button = el('button', className, text);
        button.type = 'button';
        if (label) button.setAttribute('aria-label', label);
        button.addEventListener('click', handler);
        return button;
    }

    function renderPages() {
        const list = $('docPages');
        const pages = draft?.pages || [];
        list.replaceChildren(...pages.map((page, index) => {
            const item = el('li', `doc-page${page.issues.length ? ' has-issue' : ''}`);
            item.id = `docPage${page.id}`;
            const picture = el('span', 'doc-page-thumb');
            picture.append(page.thumb);
            const body = el('div', 'doc-page-body');
            const head = el('div', 'doc-page-head');
            head.append(el('strong', '', `Seite ${index + 1}`));
            const good = el('span', 'status-pill', page.issues.length ? 'bitte prüfen' : 'gut lesbar');
            good.dataset.status = page.issues.length ? 'offen' : 'erledigt';
            head.append(good);
            body.append(head);
            page.issues.forEach(issue => body.append(el('p', 'doc-page-issue', issue.text)));
            const facts = [page.cropped ? 'Rand erkannt und begradigt' : 'ganzes Foto',
                page.ocr === 'läuft' ? 'Text wird erkannt …' : page.ocr === 'wartet' ? 'Texterkennung wartet' : page.ocr === 'fertig' ? (page.counter?.total ? `Seite ${page.counter.page} von ${page.counter.total} erkannt` : 'Text erkannt') : ''];
            body.append(el('small', 'doc-page-facts', facts.filter(Boolean).join(' · ')));
            const actions = el('div', 'doc-page-actions');
            actions.append(pageAction('Neu aufnehmen', () => { replaceId = page.id; openCamera(); }, page.issues.length ? 'button-secondary' : 'button-quiet'),
                pageAction('Drehen', () => rotatePage(page)));
            if (page.canCrop) actions.append(pageAction(page.cropped ? 'Ganzes Foto' : 'Zuschneiden', () => toggleCrop(page)));
            if (pages.length > 1) {
                if (index > 0) actions.append(pageAction('↑', () => movePage(page, -1), 'button-quiet', `Seite ${index + 1} nach oben`));
                if (index < pages.length - 1) actions.append(pageAction('↓', () => movePage(page, 1), 'button-quiet', `Seite ${index + 1} nach unten`));
            }
            actions.append(pageAction('Entfernen', () => { draft.pages.splice(draft.pages.indexOf(page), 1); renderPages(); }, 'button-quiet-danger'));
            body.append(actions);
            item.append(picture, body);
            return item;
        }));
        $('docCameraLabel').textContent = pages.length ? 'Nächste Seite scannen' : 'Seite scannen';
        $('docPagesNext').disabled = busy > 0 || !pages.length;
        $('docPagesNext').textContent = pages.length ? `Weiter mit ${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'}` : 'Weiter';
        if (wizard?.step === 4) renderCheck();
    }

    // ---------- Texterkennung (läuft im Hintergrund, eine Seite nach der anderen) ----------
    // Der erkannte Text macht das PDF durchsuchbar und verrät, ob eine Seite fehlt („Seite 2 von 3“).
    // Ohne Internet für die Erkennung geht alles genauso – nur ohne Text im PDF.
    let ocrLibrary = null;
    let ocrWorker = null;
    let ocrChain = Promise.resolve();
    let ocrOff = false;
    let ocrRun = 0;

    function loadOcr() {
        if (window.Tesseract) return Promise.resolve(window.Tesseract);
        if (!ocrLibrary) {
            ocrLibrary = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = OCR_LIBRARY;
                script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Texterkennung nicht verfügbar'));
                script.onerror = () => { ocrLibrary = null; reject(new Error('Texterkennung konnte nicht geladen werden')); };
                document.head.append(script);
            });
        }
        return ocrLibrary;
    }

    const within = (promise, ms) => Promise.race([promise, new Promise((_, reject) => window.setTimeout(() => reject(new Error('Zeit abgelaufen')), ms))]);

    function queueOcr(page) {
        page.ocr = ocrOff ? 'aus' : 'wartet';
        if (ocrOff) return;
        const run = ocrRun;
        ocrChain = ocrChain.then(() => recognise(page, run)).catch(() => null);
    }

    async function recognise(page, run) {
        if (run !== ocrRun || ocrOff || !draft?.pages.includes(page) || page.ocr !== 'wartet') return;
        const blob = page.blob;
        page.ocr = 'läuft';
        renderPages();
        try {
            if (!ocrWorker) ocrWorker = await within(loadOcr().then(Tesseract => Tesseract.createWorker('deu', 1)), OCR_TIMEOUT);
            const { data } = await within(ocrWorker.recognize(blob), OCR_TIMEOUT);
            if (run !== ocrRun || page.blob !== blob) return;      // inzwischen gedreht, ersetzt oder abgebrochen
            page.text = String(data?.text || '');
            page.words = (data?.words || []).filter(word => word?.text && word.bbox).map(word => ({ text: word.text, x0: word.bbox.x0, y0: word.bbox.y0, x1: word.bbox.x1, y1: word.bbox.y1 }));
            page.counter = DocScan.pageInfo(page.text);
            page.ocr = 'fertig';
        } catch (error) {
            if (run !== ocrRun) return;
            // Die Erkennung ist nicht erreichbar oder zu langsam: ohne sie weitermachen, niemanden aufhalten.
            ocrOff = true;
            draft?.pages.forEach(other => { if (other.ocr !== 'fertig') other.ocr = 'aus'; });
            try { await ocrWorker?.terminate(); } catch (ignored) { /* schon beendet */ }
            ocrWorker = null;
        }
        if (run === ocrRun) renderPages();
    }

    function stopOcr() {
        ocrRun += 1;
        ocrOff = false;
        ocrChain = Promise.resolve();
        const worker = ocrWorker;
        ocrWorker = null;
        if (worker) Promise.resolve().then(() => worker.terminate()).catch(() => null);
    }

    const ocrOpen = () => (draft?.pages || []).filter(page => page.ocr === 'wartet' || page.ocr === 'läuft').length;

    // ---------- Schritt 4: prüfen und senden ----------
    function warnings() {
        const list = [];
        draft.pages.forEach((page, index) => page.issues.forEach(issue => list.push({ kind: 'quality', text: `Seite ${index + 1} ${ISSUE_SHORT[issue.code] || 'bitte prüfen'}.` })));
        const texts = draft.pages.map(page => page.text || '');
        if (texts.some(Boolean)) DocScan.missingPages(texts).forEach(text => list.push({ kind: 'missing', text }));
        return list;
    }

    function renderCheck() {
        if (!draft?.source) return;
        const source = draft.source;
        const rows = [
            ['Patient/in', [source.patientNr ? `Nr. ${source.patientNr}` : '', source.patientName].filter(Boolean).join(' · ') || '–'],
            ['Termin', [dayText(source.date), source.doctor].filter(Boolean).join(' · ')],
            ['Unterlage', draft.kind],
            ['Seiten', String(draft.pages.length)]
        ];
        $('docSummary').replaceChildren(...rows.flatMap(([term, value]) => [el('dt', '', term), el('dd', '', value)]));
        const found = warnings();
        const box = $('docWarnings');
        box.hidden = !found.length;
        box.replaceChildren(...found.map(item => { const line = el('li', '', item.text); line.dataset.kind = item.kind; return line; }));
        if (found.length) {
            const back = el('li', 'doc-alerts-action');
            back.append(pageAction('Seiten noch einmal ansehen', () => wizard.show(3), 'button-secondary'));
            box.append(back);
        }
        const open = ocrOpen();
        $('docOcrState').hidden = !open && !sending;
        if (open) $('docOcrState').textContent = `Der Text wird noch erkannt (${draft.pages.length - open} von ${draft.pages.length} Seiten fertig). Du kannst schon senden.`;
        $('docSend').disabled = sending || !draft.pages.length;
    }

    $('docPagesNext').addEventListener('click', () => {
        if (!draft?.pages.length || busy > 0) return;
        wizard.show(4);
        renderCheck();
    });

    async function send() {
        if (sending || !draft?.pages.length) return;
        const session = draft;
        const profile = core.profile();
        const source = draft.source;
        sending = true;
        $('docSend').disabled = true;
        const state = $('docOcrState');
        state.hidden = false;
        try {
            // Auf die Texterkennung warten – außer die Person will sofort senden.
            if (ocrOpen()) {
                $('docSendNow').hidden = false;
                state.textContent = 'Der Text wird noch erkannt – einen Moment …';
                const skip = new Promise(resolve => { $('docSendNow').onclick = () => resolve('skip'); });
                const finished = (async () => { while (ocrOpen() && draft === session) await new Promise(resolve => window.setTimeout(resolve, 300)); })();
                await Promise.race([finished, skip]);
                $('docSendNow').hidden = true;
                if (draft !== session) return;
            }
            state.textContent = 'Das PDF wird erstellt …';
            const found = warnings().map(item => item.text);
            const name = DocPdf.fileName({ patientNr: source.patientNr, patientName: source.patientName, kind: draft.kind, date: source.date });
            const pdf = await DocPdf.build({
                pages: draft.pages.map(page => ({ blob: page.blob, width: page.width, height: page.height, words: page.words })),
                title: `${draft.kind} · ${[source.patientNr, source.patientName].filter(Boolean).join(' ')}`,
                subject: `Termin ${dayText(source.date)}${source.doctor ? ` · ${source.doctor}` : ''}`,
                author: profile.full_name || '', keywords: [source.patientNr, source.patientName, draft.kind].filter(Boolean)
            });
            if (pdf.size > MAX_PDF_BYTES) throw new Error('Das PDF ist zu groß. Bitte sende die Seiten als zwei Unterlagen.');
            state.textContent = 'Das PDF wird gesendet …';
            const path = `${profile.id}/${Date.now()}-${name}`;
            const upload = await client.storage.from('dokumente').upload(path, pdf, { contentType: 'application/pdf' });
            if (upload.error) throw upload.error;
            const text = draft.pages.map((page, index) => page.text ? `--- Seite ${index + 1} ---\n${page.text.trim()}` : '').filter(Boolean).join('\n\n').slice(0, 60000);
            const documentId = crypto.randomUUID();
            const { error } = await client.from('tt_documents').insert({
                id: documentId, patient_nr: source.patientNr, patient_name: source.patientName, patient_birth: source.patientBirth || '', date: source.date, doctor: source.doctor,
                appointment_id: source.appointmentId || null, assignment_id: source.assignmentId || null,
                kind: draft.kind, note: $('docNote').value.trim(), pages: draft.pages.length, file_path: path, file_bytes: pdf.size,
                text_content: text, warnings: found, uploader_id: profile.id, uploader_name: profile.full_name || profile.email || '', status: 'neu'
            });
            if (error) { await client.storage.from('dokumente').remove([path]); throw error; }
            const label = `${draft.kind}${source.patientName ? ` für ${source.patientName}` : ''}`;
            // War es eine erbetene neue Aufnahme? Dann ist die Bitte damit erledigt.
            const answered = session.requestId ? await window.PortalRequests?.answerDocument(session.requestId, documentId, $('docNote').value.trim()) : null;
            stopOcr();
            draft = null;
            await load();
            await core.showSuccess(session.requestId ? 'Danke!' : 'Gesendet', session.requestId ? 'Die neue Aufnahme ist angekommen.' : label);
            toast(answered ? 'Unterlage gesendet. Die Bitte der Einsatzleitung konnte aber nicht als erledigt gemeldet werden – bitte gib kurz Bescheid.' : 'Unterlage gesendet. Danke!', answered ? 'info' : 'success');
            core.goTo(session.requestId ? 'vehicle' : 'docs');
        } catch (error) {
            const message = /does not exist|schema cache|bucket not found/i.test(error?.message || '')
                ? 'Die Unterlagen sind in der Datenbank noch nicht eingerichtet (Update 10 fehlt). Bitte sag der Einsatzleitung Bescheid.'
                : TerminCloud.germanError(error);
            toast(`Nicht gesendet: ${message}`, 'error', '#docSend');
            state.textContent = 'Nicht gesendet. Bitte noch einmal versuchen.';
        } finally {
            sending = false;
            $('docSendNow').hidden = true;
            if (draft === session) $('docSend').disabled = false;
        }
    }
    $('docSend').addEventListener('click', send);

    // ---------- Bericht über Termin ----------
    // Ein Bericht gehört zu einem Auftrag: Patient, Patientennummer, Arzt und Datum kommen aus dem Auftrag,
    // unten stehen der Name des Dolmetschers als Unterschrift und das heutige Datum. Dazu – falls vereinbart –
    // Datum und Uhrzeit des nächsten Termins. Solange das Büro den Bericht nicht geprüft hat, lässt er sich ändern.
    // Der Entwurf bleibt auf dem Handy gespeichert, falls die App zwischendurch geschlossen wird.
    let reportJobId = '';         // Auftrag, zu dem direkt geöffnet werden soll („Ändern“ in der Liste)
    let reportSource = null;      // gewählter Auftrag (sourceOf)
    let reportExisting = null;
    const NEXT_PREFIX = 'Nächster Termin: ';
    const draftKey = () => `portal.reportDraft.${core.profile()?.id || ''}.${reportSource?.assignmentId || ''}`;
    const readDraft = () => { try { return JSON.parse(localStorage.getItem(draftKey()) || 'null'); } catch (error) { return null; } };
    const writeDraft = () => {
        const value = { body: $('reportBody').value, nextDate: $('reportNextDate').value, nextTime: $('reportNextTime').value };
        try { if (value.body || value.nextDate || value.nextTime) localStorage.setItem(draftKey(), JSON.stringify(value)); else localStorage.removeItem(draftKey()); } catch (error) { /* Entwurf gilt dann nur bis zum Schließen. */ }
    };
    const jobDone = job => Boolean(job.finished_at) || ['beendet', 'alleine'].includes(job.work_status);
    const reportOf = assignmentId => documents.find(item => item.kind === REPORT_KIND && item.assignment_id === assignmentId) || null;
    const nextText = () => {
        const date = $('reportNextDate').value;
        const time = $('reportNextTime').value;
        return date ? `${NEXT_PREFIX}${dayText(date)}${time ? `, ${time} Uhr` : ''}` : '';
    };

    // Zur Wahl stehen die Aufträge der letzten sieben Tage: zuerst die abgeschlossenen, dann die von heute, die noch laufen.
    function reportJobs() {
        const from = core.isoDate(new Date(Date.now() - 7 * 86400000));
        return core.jobs().filter(job => !job.cancelled && job.response !== 'abgesagt' && job.date <= today() && job.date >= from && (jobDone(job) || job.date === today()))
            .sort((left, right) => (Number(jobDone(right)) - Number(jobDone(left))) || `${right.date} ${right.time}`.localeCompare(`${left.date} ${left.time}`));
    }

    function renderReportPick() {
        reportSource = null;
        reportExisting = null;
        $('reportPick').hidden = false;
        $('reportForm').hidden = true;
        const jobs = reportJobs();
        $('reportNoJobs').hidden = jobs.length > 0;
        $('reportJobList').replaceChildren(...jobs.map(job => {
            const source = sourceOf(job);
            const existing = reportOf(job.id);
            const card = el('button', 'car-card report-job');
            card.type = 'button';
            card.dataset.id = job.id;
            const main = el('span', 'car-card-main');
            main.append(el('strong', '', source.patientName || source.title || 'Termin'),
                el('span', '', [job.date === today() ? 'Heute' : shortDay(job.date), source.time ? `${source.time} Uhr` : '', source.doctor].filter(Boolean).join(' · ')));
            const chips = el('span', 'car-card-chips');
            if (source.patientNr) chips.append(el('em', 'chip chip-brand', `Nr. ${source.patientNr}`));
            chips.append(el('em', `chip report-chip${existing ? ' is-sent' : ''}`, existing ? (existing.status === 'neu' ? 'Bericht gesendet – ändern' : 'Bericht geprüft') : jobDone(job) ? 'abgeschlossen' : 'läuft noch'));
            card.append(main, chips, el('span', 'car-card-arrow', '›'));
            card.addEventListener('click', () => openReportFor(job));
            return card;
        }));
    }

    function openReportFor(job) {
        const profile = core.profile();
        reportSource = sourceOf(job);
        reportExisting = reportOf(job.id);
        // Bearbeiten geht immer. War der Bericht schon geprüft, bekommt ihn das Büro danach noch einmal als „neu“.
        const checked = Boolean(reportExisting && reportExisting.status !== 'neu');
        const locked = false;
        $('reportPick').hidden = true;
        $('reportForm').hidden = false;
        const facts = [['Patient/in', reportSource.patientName], ['Patientennummer', reportSource.patientNr], ['Arzt / Praxis', reportSource.doctor],
            ['Termin', [dayText(reportSource.date), reportSource.time ? `${reportSource.time} Uhr` : ''].filter(Boolean).join(' · ')], ['Bericht vom', dayText(today())]];
        $('reportFacts').replaceChildren(...facts.filter(row => row[1]).flatMap(([term, value]) => [el('dt', '', term), el('dd', '', value)]));
        const saved = reportExisting ? { body: reportExisting.body || '', next: String(reportExisting.note || '').startsWith(NEXT_PREFIX) ? String(reportExisting.note).slice(NEXT_PREFIX.length) : '' } : null;
        const savedNext = saved?.next.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:, (\d{2}:\d{2}) Uhr)?/);
        const draftValue = locked ? null : readDraft();
        $('reportBody').value = draftValue?.body ?? saved?.body ?? '';
        $('reportNextDate').value = draftValue?.nextDate ?? (savedNext ? `${savedNext[3]}-${savedNext[2]}-${savedNext[1]}` : '');
        $('reportNextTime').value = draftValue?.nextTime ?? (savedNext?.[4] || '');
        $('reportNextDate').min = today();
        ['reportBody', 'reportNextDate', 'reportNextTime'].forEach(id => { $(id).disabled = locked; });
        $('reportSubmit').hidden = locked;
        $('reportSubmit').textContent = reportExisting ? 'Bericht aktualisieren' : 'Bericht senden';
        $('reportSign').replaceChildren(el('span', '', 'Unterschrift'), el('strong', '', profile.full_name || profile.email || ''), el('small', '', dayText(today())));
        if ($('reportPrint')) $('reportPrint').hidden = !reportExisting;
        $('reportState').textContent = checked ? 'Das Büro hat diesen Bericht schon geprüft. Du kannst ihn trotzdem ändern – das Büro bekommt ihn dann noch einmal als „neu“.'
            : reportExisting ? 'Zu diesem Termin hast du schon einen Bericht gesendet – du kannst ihn hier ändern.'
            : jobDone(job) ? '' : 'Dieser Termin läuft noch. Du kannst den Bericht schon schreiben und nach dem Termin senden.';
        if (!locked) $('reportBody').focus({ preventScroll: true });
        window.scrollTo({ top: 0 });
    }

    function openReport() {
        const direct = reportJobId && core.jobs().find(job => job.id === reportJobId);
        reportJobId = '';
        if (direct) { openReportFor(direct); return; }
        renderReportPick();
        // Genau ein abgeschlossener Termin ohne Bericht: direkt öffnen – das spart einen Tipp.
        const open = reportJobs().filter(job => jobDone(job) && !reportOf(job.id));
        if (open.length === 1 && reportJobs().length === 1) openReportFor(open[0]);
    }
    $('reportOther').addEventListener('click', renderReportPick);
    $('reportPrint')?.addEventListener('click', () => { if (reportExisting) openReportPdf({ ...reportExisting, body: $('reportBody').value.trim() || reportExisting.body }, $('reportPrint')); });
    ['reportBody', 'reportNextDate', 'reportNextTime'].forEach(id => $(id).addEventListener('input', writeDraft));

    $('reportForm').addEventListener('submit', async event => {
        event.preventDefault();
        const profile = core.profile();
        const source = reportSource;
        if (!source) { renderReportPick(); return; }
        const body = $('reportBody').value.trim();
        if (body.length < 20) { toast('Der Bericht ist noch sehr kurz. Bitte schreib ein paar Sätze.', 'error', '#reportBody'); return; }
        if ($('reportNextTime').value && !$('reportNextDate').value) { toast('Bitte gib zum nächsten Termin auch das Datum an.', 'error', '#reportNextDate'); return; }
        if ($('reportNextDate').value && $('reportNextDate').value < today()) { toast('Der nächste Termin liegt in der Vergangenheit. Bitte prüfe das Datum.', 'error', '#reportNextDate'); return; }
        const button = $('reportSubmit');
        button.disabled = true;
        try {
            const fields = { body, note: nextText(), patient_nr: source.patientNr, patient_name: source.patientName, patient_birth: source.patientBirth || '', doctor: source.doctor, date: source.date };
            // Ändern: Der Bericht steht danach wieder auf „neu“ (das Büro sieht „geändert“). Ohne Update 25 geht das nur vor dem Prüfen.
            const again = { ...fields, status: 'neu', checked_at: null, checked_by: '' };
            let changed = null;
            if (reportExisting) {
                changed = await client.from('tt_documents').update({ ...again, edited_at: new Date().toISOString() }).eq('id', reportExisting.id).select('id');
                if (changed.error && /edited_at/i.test(changed.error.message || '')) changed = await client.from('tt_documents').update(reportExisting.status === 'neu' ? fields : again).eq('id', reportExisting.id).select('id');
                if (!changed.error && !(changed.data || []).length) throw new Error('Das Büro hat diesen Bericht schon geprüft. Ändern ist in der Datenbank dafür noch nicht freigeschaltet (Update 25) – bitte sag der Einsatzleitung Bescheid.');
            }
            const result = reportExisting
                ? changed
                : await client.from('tt_documents').insert({ ...fields, kind: REPORT_KIND, pages: 0, assignment_id: source.assignmentId || null, appointment_id: source.appointmentId || null,
                    uploader_id: profile.id, uploader_name: profile.full_name || profile.email || '', status: 'neu' });
            if (result.error) throw result.error;
            try { localStorage.removeItem(draftKey()); } catch (error) { /* kein Entwurf gespeichert */ }
            const updated = Boolean(reportExisting);
            await load();
            await core.showSuccess(updated ? 'Bericht aktualisiert' : 'Bericht gesendet', [source.patientName, dayText(source.date)].filter(Boolean).join(' · '));
            toast('Bericht gesendet. Danke!', 'success');
            core.goTo('docs');
        } catch (error) {
            toast(`Nicht gesendet: ${TerminCloud.germanError(error)}`, 'error', '#reportSubmit');
        } finally {
            button.disabled = false;
        }
    });

    return { load, open, startWizard: () => startWizard(), startFor: item => { pending = item; core.goTo('docNew'); }, startRetake: request => { pending = { retake: request }; core.goTo('docNew'); }, openReport: () => openReport(), state: () => ({ documents, draft }),
        // Erledigte Termine eines Tages, zu denen noch kein Bericht geschrieben ist (ausgefallene zählen nicht).
        missingReports: date => core.jobs().filter(job => job.date === date && !job.cancelled && job.response !== 'abgesagt' && jobDone(job) && !job.storno_at && !['storniert', 'alleine'].includes(job.work_status) && !reportOf(job.id)).length };
})();
