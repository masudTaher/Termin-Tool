// Berichte des Tages: Anzeige für die Ärztinnen und Ärzte im Haus (Rolle „Arzt“, Update 34; Fragen an Dolmetscher: Update 36).
// Links die Übersicht: Was ist noch nicht gelesen – gesamt und nach Tagen. Rechts die Unterlagen des gewählten Tages (oder alle
// offenen), nach Patient geordnet. Jeder Bericht lässt sich lesen bzw. als PDF öffnen, mit „Gelesen“ abhaken, die ganze Akte
// daneben öffnen – und zu einem Bericht lässt sich der Dolmetscher direkt fragen; die Antwort erscheint unter dem Bericht.
// Ärzte lesen nur: nichts hochladen, nichts ändern. „Gelesen“ und jeder Blick in eine Akte werden festgehalten (tt_doctor_marks).
// PR (Update 51): sieht dieselben Unterlagen und dazu „Wer ist wo“ – die Termine des Tages, knapp: Dolmetscher, Arzt, Patient,
// Stand, Bericht. Fehlt der Bericht, fordert die PR ihn beim Dolmetscher an; mit dem Hochladen gilt die Anfrage als erledigt.
(function () {
    const $ = id => document.getElementById(id);
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const client = typeof TerminCloud === 'undefined' ? null : TerminCloud.client;
    const REPORT = 'Dolmetscherbericht';
    const WINDOW_DAYS = 60;                 // so weit zurück reicht die Übersicht links (ältere Tage über das Datumsfeld)
    const clock = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const german = iso => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
    const short = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
    const dayLong = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const fold = value => clean(value).toLocaleLowerCase('de-DE').normalize('NFD').replace(/[̀-ͯ]/g, '');
    const isoOf = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const dayOf = doc => isoOf(new Date(doc.created_at));
    const FRESH = 120000;
    let profile = null;
    let day = '';                 // gewählter Tag
    let mode = 'day';             // 'day' = ein Tag, 'open' = alle ungelesenen, 'ask' = meine Fragen
    let all = [];                 // Unterlagen der letzten WINDOW_DAYS Tage
    let extra = [];               // Unterlagen eines älteren, eigens gewählten Tages
    let marks = [];
    let questions = [];
    let filter = 'alle';
    let search = '';
    let view = 'docs';            // 'docs' = Unterlagen, 'live' = Wer ist wo (PR und Büro)
    let live = [];                // Termine des gewählten Tages (tt_pr_live)
    let liveToday = [];           // Termine von heute (für die Zähler oben)
    let liveDay = '';             // für welchen Tag „live“ geladen ist
    let liveReady = true;
    let liveFilter = 'alle';
    let liveSearch = '';
    let known = null;
    let busy = false;
    const opened = new Set();

    const today = () => TerminCloud.todayIso();
    const canSee = account => Boolean(account?.active && ['arzt', 'pr', 'admin', 'sekretariat'].includes(account.role));
    const isStaff = () => TerminCloud.isStaff(profile);
    const canLive = () => Boolean(profile && (profile.role === 'pr' || isStaff()));
    const group = doc => (doc.kind === REPORT ? 'dolmetscher' : /^(Arztbericht|Befund)/.test(doc.kind) ? 'arzt' : 'rest');
    const readMarks = doc => marks.filter(mark => mark.action === 'gelesen' && mark.document_id === doc.id);
    const isRead = doc => readMarks(doc).length > 0;
    const patientKey = doc => clean(doc.patient_nr) || `name:${fold(doc.patient_name)}`;
    const questionsOf = doc => questions.filter(item => item.document_id === doc.id);
    const jobQuestionsOf = row => questions.filter(item => !item.document_id && item.assignment_id === row.id);
    const windowStart = () => { const from = new Date(); from.setDate(from.getDate() - WINDOW_DAYS); from.setHours(0, 0, 0, 0); return from; };
    const inWindow = iso => new Date(`${iso}T12:00:00`) >= windowStart();

    function show(view) { $('docAuth').hidden = view !== 'auth'; $('docApp').hidden = view !== 'app'; }
    function banner(text, kind = 'info', node = $('docStatus')) { node.hidden = !text; node.textContent = text || ''; node.dataset.kind = kind; }
    function ask(text, yesLabel = 'Ja') {
        const dialog = $('docConfirm');
        $('docConfirmText').textContent = text;
        $('docConfirmYes').textContent = yesLabel;
        return new Promise(resolve => {
            let answer = false;
            const yes = () => { answer = true; dialog.close(); };
            const no = () => dialog.close();
            $('docConfirmYes').addEventListener('click', yes, { once: true });
            $('docConfirmNo').addEventListener('click', no, { once: true });
            dialog.addEventListener('close', () => { $('docConfirmYes').removeEventListener('click', yes); $('docConfirmNo').removeEventListener('click', no); resolve(answer); }, { once: true });
            dialog.showModal();
        });
    }
    let audio = null;
    function chime() {
        try {
            audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            [784, 1047].forEach((pitch, index) => {
                const tone = audio.createOscillator(), level = audio.createGain();
                tone.frequency.value = pitch;
                level.gain.setValueAtTime(0.0001, audio.currentTime + index * 0.18);
                level.gain.exponentialRampToValueAtTime(0.2, audio.currentTime + index * 0.18 + 0.02);
                level.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + index * 0.18 + 0.3);
                tone.connect(level).connect(audio.destination);
                tone.start(audio.currentTime + index * 0.18);
                tone.stop(audio.currentTime + index * 0.18 + 0.32);
            });
        } catch (error) { /* ohne Ton */ }
    }
    function tick() {
        const now = new Date();
        $('docClock').textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        $('docDate').textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
        document.querySelectorAll('.doc-entry[data-fresh]').forEach(node => { if (Date.now() - Number(node.dataset.fresh) > FRESH) delete node.dataset.fresh; });
    }

    // PDF im neuen Tab öffnen (der Tab entsteht sofort beim Tippen – sonst blockiert ihn der Browser).
    async function openFile(path, button) {
        const tab = window.open('', '_blank');
        button.disabled = true;
        const { data, error } = await client.storage.from('dokumente').createSignedUrl(path, 600);
        button.disabled = false;
        if (error || !data?.signedUrl) { tab?.close(); banner(`Die Datei ließ sich nicht öffnen: ${TerminCloud.germanError(error || {})}`, 'error'); return; }
        if (tab && !tab.closed) { tab.opener = null; tab.location.replace(data.signedUrl); } else window.location.href = data.signedUrl;
    }

    const kindLabel = doc => (doc.kind === REPORT ? 'Dolmetscherbericht' : doc.kind || 'Unterlage');
    const fromLine = doc => [doc.uploader_name ? `von ${doc.uploader_name}` : '', clean(doc.doctor) ? (doc.kind === REPORT ? `Arzt/Praxis: ${clean(doc.doctor)}` : clean(doc.doctor)) : '', doc.date ? `Termin ${german(doc.date)}` : '']
        .filter(Boolean).join(' · ');

    // ---------- Fragen an den Dolmetscher ----------
    // Drei Arten (Update 40): Frage (Antwort), Info (zur Kenntnis), Anweisung (muss mit „Verstanden“ bestätigt werden).
    const KIND_WORD = { frage: 'Frage', info: 'Info', anweisung: 'Anweisung', bericht: 'Berichtsanfrage' };
    const kindOf = item => KIND_WORD[item.kind] ? item.kind : 'frage';
    const questionDone = item => (kindOf(item) === 'frage' ? Boolean(item.answered_at) : Boolean(item.acknowledged_at));
    function questionBlock(doc) { return questionCards(questionsOf(doc)); }
    function questionCards(items, { withAbout = false } = {}) {
        const box = el('div', 'doc-questions');
        items.forEach(item => {
            const kind = kindOf(item);
            const card = el('div', 'doc-question');
            card.dataset.kind = kind;
            const done = questionDone(item);
            card.dataset.state = done ? 'beantwortet' : 'offen';
            const mine = item.doctor_id === profile.id;
            card.append(el('span', 'doc-question-head', `${mine ? `Deine ${KIND_WORD[kind]}` : `${KIND_WORD[kind]} von ${item.doctor_name || 'Arzt'}`} · ${german(item.created_at)} ${clock(item.created_at)} Uhr`));
            if (withAbout) card.append(el('span', 'doc-question-about', [item.document_title, clean(item.patient_name), clean(item.patient_nr) ? `Akte ${clean(item.patient_nr)}` : '', item.interpreter_name ? `Dolmetscher/in: ${item.interpreter_name}` : '', item.document_date ? german(item.document_date) : ''].filter(Boolean).join(' · ')));
            card.append(el('p', 'doc-question-text', item.question));
            if (kind !== 'frage' && item.acknowledged_at) card.append(el('span', 'doc-question-head is-ok', `${kind === 'anweisung' ? 'Verstanden' : kind === 'bericht' ? 'Bericht hochgeladen' : 'Gelesen'}${kind === 'bericht' ? '' : ` von ${item.interpreter_name || 'Dolmetscher'}`} · ${german(item.acknowledged_at)} ${clock(item.acknowledged_at)} Uhr`));
            if (item.answered_at) card.append(el('span', 'doc-question-head', `${kind === 'frage' ? 'Antwort' : 'Rückmeldung'} von ${item.interpreter_name || 'Dolmetscher'} · ${german(item.answered_at)} ${clock(item.answered_at)} Uhr`), el('p', 'doc-question-answer', item.answer));
            if (!done) {
                const wait = el('span', 'doc-question-wait', kind === 'frage' ? (item.seen_at ? 'Der Dolmetscher hat die Frage gesehen – noch keine Antwort.' : 'Noch nicht beantwortet.') : kind === 'anweisung' ? (item.seen_at ? 'Der Dolmetscher hat die Anweisung gesehen – noch nicht bestätigt.' : 'Noch nicht bestätigt.') : kind === 'bericht' ? (item.seen_at ? 'Der Dolmetscher hat die Anfrage gesehen – Bericht noch nicht hochgeladen.' : 'Bericht noch nicht hochgeladen.') : (item.seen_at ? 'Gesehen – noch nicht als gelesen bestätigt.' : 'Noch nicht gelesen.'));
                card.append(wait);
                if (mine || isStaff()) {
                    const undo = el('button', 'gate-button gate-button-quiet doc-question-undo', `${KIND_WORD[kind]} zurückziehen`);
                    undo.type = 'button';
                    undo.addEventListener('click', async () => {
                        if (!(await ask(`Die ${KIND_WORD[kind]} zurückziehen? Der Dolmetscher sieht sie dann nicht mehr.`, 'Zurückziehen'))) return;
                        const { error } = await client.from('tt_doctor_questions').delete().eq('id', item.id);
                        if (error) { banner(TerminCloud.germanError(error), 'error'); return; }
                        await load();
                    });
                    card.append(undo);
                }
            }
            box.append(card);
        });
        return box;
    }
    const ASK_TEXT = {
        frage: { kicker: 'FRAGE AN DEN DOLMETSCHER', placeholder: 'Was möchtest du wissen? Der Dolmetscher sieht Patient, Bericht und Datum dazu.', send: 'Frage senden' },
        info: { kicker: 'INFO AN DEN DOLMETSCHER', placeholder: 'Was soll der Dolmetscher wissen? Er bestätigt, dass er es gelesen hat.', send: 'Info senden' },
        anweisung: { kicker: 'ANWEISUNG AN DEN DOLMETSCHER', placeholder: 'Was soll der Dolmetscher tun? Die Anweisung erscheint bei ihm groß und rot, er bestätigt mit „Verstanden“.', send: 'Anweisung senden' },
        bericht: { kicker: 'BERICHT ANFORDERN', placeholder: 'Wofür wird der Bericht gebraucht, bis wann? Der Dolmetscher sieht Patient und Termin dazu.', send: 'Bericht anfordern' }
    };
    const REPORT_REQUEST_TEXT = 'Bitte lade den Bericht zu diesem Termin hoch – er wird für das Visum gebraucht. Danke!';
    const askKind = () => document.querySelector('input[name=docAskKind]:checked')?.value || 'frage';
    function applyAskKind() {
        const kind = askKind();
        $('docAsk').dataset.kind = kind;
        $('docAskKicker').textContent = ASK_TEXT[kind].kicker;
        $('docAskText').placeholder = ASK_TEXT[kind].placeholder;
        $('docAskSend').textContent = ASK_TEXT[kind].send;
        if (kind === 'bericht' && !$('docAskText').value.trim()) $('docAskText').value = REPORT_REQUEST_TEXT;
        if (kind !== 'bericht' && $('docAskText').value === REPORT_REQUEST_TEXT) $('docAskText').value = '';
    }
    document.querySelectorAll('input[name=docAskKind]').forEach(input => input.addEventListener('change', applyAskKind));
    function openAsk(doc, kind = 'frage') {
        const dialog = $('docAsk');
        $('docAskKindReport').hidden = true;
        document.querySelector(`input[name=docAskKind][value="${kind}"]`).checked = true;
        $('docAskText').value = '';
        applyAskKind();
        $('docAskTitle').textContent = clean(doc.title) || kindLabel(doc);
        $('docAskAbout').textContent = [clean(doc.patient_name), clean(doc.patient_nr) ? `Akte ${clean(doc.patient_nr)}` : '', doc.uploader_name ? `Dolmetscher/in: ${doc.uploader_name}` : '', doc.date ? `Termin ${german(doc.date)}` : ''].filter(Boolean).join(' · ');
        $('docAskStatus').textContent = '';
        dialog.dataset.doc = doc.id;
        dialog.dataset.job = '';
        dialog.showModal();
        $('docAskText').focus();
    }
    // Zu einem Termin (Update 51): Bericht anfordern oder Frage, Info, Anweisung – ohne Unterlage.
    function openAskJob(row, kind = 'bericht') {
        const dialog = $('docAsk');
        $('docAskKindReport').hidden = false;
        document.querySelector(`input[name=docAskKind][value="${kind}"]`).checked = true;
        $('docAskText').value = '';
        applyAskKind();
        $('docAskTitle').textContent = jobTitle(row);
        $('docAskAbout').textContent = [clean(row.patient_name) || 'Patient ohne Namen', clean(row.patient_nr) ? `Akte ${clean(row.patient_nr)}` : '', row.interpreter_name ? `Dolmetscher/in: ${row.interpreter_name}` : '', row.date ? `Termin ${german(row.date)}` : ''].filter(Boolean).join(' · ');
        $('docAskStatus').textContent = '';
        dialog.dataset.doc = '';
        dialog.dataset.job = row.id;
        dialog.showModal();
        $('docAskText').focus();
        $('docAskText').select();
    }
    $('docAskCancel').addEventListener('click', () => $('docAsk').close());
    $('docAskForm').addEventListener('submit', async event => {
        event.preventDefault();
        const text = $('docAskText').value.trim();
        const kind = askKind();
        if (!text) { $('docAskStatus').textContent = kind === 'frage' ? 'Bitte schreib deine Frage.' : kind === 'info' ? 'Bitte schreib die Info.' : 'Bitte schreib die Anweisung.'; $('docAskText').focus(); return; }
        const send = $('docAskSend');
        send.disabled = true;
        const jobId = $('docAsk').dataset.job || '';
        const target = jobId ? { assignment_id: jobId } : { document_id: $('docAsk').dataset.doc };
        // Ohne Update 40 kennt die Datenbank die Spalte „kind“ noch nicht – dann geht der Text als Frage hinaus.
        let { data, error } = await client.from('tt_doctor_questions').insert({ ...target, question: text, kind }).select().maybeSingle();
        if (error && /kind|column/i.test(error.message || '') && kind !== 'frage' && !jobId) ({ data, error } = await client.from('tt_doctor_questions').insert({ ...target, question: text }).select().maybeSingle());
        send.disabled = false;
        if (error) { $('docAskStatus').textContent = /keinen Dolmetscher/.test(error.message || '') ? (jobId ? 'Zu diesem Termin gibt es keinen Dolmetscher, den man anschreiben könnte.' : 'Zu dieser Unterlage gibt es keinen Dolmetscher, den man fragen könnte.') : jobId && /assignment_id|column|check constraint|kind_check|Keine Unterlage/i.test(error.message || '') ? 'Dafür fehlt noch ein Datenbank-Update (Update 51). Bitte der Einsatzleitung Bescheid sagen.' : /does not exist|schema cache|relation/i.test(error.message || '') ? 'Dafür fehlt noch ein Datenbank-Update (Update 36). Bitte der Einsatzleitung Bescheid sagen.' : TerminCloud.germanError(error); return; }
        $('docAsk').close();
        // Mitteilung aufs Handy des Dolmetschers (falls eingerichtet) – die Frage selbst steht sicher in seiner App.
        TerminCloud.callFunction?.({ action: 'question', questionId: data?.id })?.catch?.(() => null);
        banner(kind === 'bericht' ? `Bericht bei ${data?.interpreter_name || 'dem Dolmetscher'} angefordert – sobald er ihn hochlädt, steht er hier.` : `${KIND_WORD[kind]} an ${data?.interpreter_name || 'den Dolmetscher'} gesendet – ${kind === 'frage' ? 'die Antwort' : 'die Bestätigung'} erscheint hier ${jobId ? 'beim Termin' : 'beim Bericht'}.`, 'info');
        window.setTimeout(() => { if (!$('docStatus').hidden && / an .* gesendet|angefordert –/.test($('docStatus').textContent)) banner(''); }, 6000);
        await load();
    });

    // ---------- Meldung an die Einsatzleitung (Update 42) ----------
    const TOPIC_WORD = { bericht: 'Bericht', termin: 'Termin', patient: 'Patient', sonstiges: 'Sonstiges' };
    let feedback = [];
    let feedbackReady = true;
    const newAnswers = () => feedback.filter(item => item.answered_at && !item.doctor_seen_at);
    const feedbackTopic = () => document.querySelector('input[name=docFeedbackTopic]:checked')?.value || 'sonstiges';
    function openFeedback(doc = null, topic = null) {
        const dialog = $('docFeedback');
        document.querySelector(`input[name=docFeedbackTopic][value="${topic || (doc ? 'bericht' : 'sonstiges')}"]`).checked = true;
        $('docFeedbackAbout').textContent = doc ? ['Zu: ' + (clean(doc.title) || kindLabel(doc)), clean(doc.patient_name), clean(doc.patient_nr) ? `Akte ${clean(doc.patient_nr)}` : '', doc.uploader_name ? `Dolmetscher/in: ${doc.uploader_name}` : '', doc.date ? `Termin ${german(doc.date)}` : ''].filter(Boolean).join(' · ') : 'Die Einsatzleitung sieht deine Meldung sofort auf ihrer Startseite und kann dir hier antworten.';
        $('docFeedbackRefRow').hidden = Boolean(doc);
        $('docFeedbackRef').value = '';
        $('docFeedbackText').value = '';
        $('docFeedbackStatus').textContent = !feedbackReady ? 'Dafür fehlt noch ein Datenbank-Update (Update 42). Bitte der Einsatzleitung Bescheid sagen.' : '';
        $('docFeedbackSend').disabled = !feedbackReady;
        dialog.dataset.doc = doc?.id || '';
        renderFeedbackList();
        dialog.showModal();
        $('docFeedbackText').focus();
    }
    function renderFeedbackList() {
        const list = $('docFeedbackList');
        $('docFeedbackHistory').hidden = !feedback.length;
        $('docFeedbackBadge').hidden = !newAnswers().length;
        $('docFeedbackBadge').textContent = String(newAnswers().length);
        list.replaceChildren(...feedback.slice(0, 20).map(item => {
            const entry = el('li', 'doc-feedback-item');
            entry.dataset.answered = item.answered_at ? 'ja' : '';
            entry.append(el('small', '', [`${TOPIC_WORD[item.topic] || 'Sonstiges'}`, item.document_title ? `zu „${item.document_title}“` : '', item.patient_name || item.patient_nr ? [item.patient_name, item.patient_nr ? `Akte ${item.patient_nr}` : ''].filter(Boolean).join(', ') : '', `${german(item.created_at)} ${clock(item.created_at)} Uhr`, item.seen_at ? 'von der Einsatzleitung gesehen' : 'noch nicht gesehen'].filter(Boolean).join(' · ')),
                el('p', '', item.text));
            if (item.answered_at) {
                const answer = el('div', 'doc-feedback-answer');
                answer.append(el('b', '', `Antwort von ${item.answered_by || 'der Einsatzleitung'} · ${german(item.answered_at)} ${clock(item.answered_at)} Uhr`), el('span', '', item.answer));
                entry.append(answer);
                if (!item.doctor_seen_at) {
                    const seen = el('button', 'gate-button gate-button-main doc-feedback-seen', 'Antwort gelesen');
                    seen.type = 'button';
                    seen.addEventListener('click', async () => {
                        seen.disabled = true;
                        const { error } = await client.from('tt_doctor_feedback').update({ doctor_seen_at: new Date().toISOString() }).eq('id', item.id);
                        if (error) { seen.disabled = false; banner(TerminCloud.germanError(error), 'error', $('docFeedbackStatus')); return; }
                        item.doctor_seen_at = new Date().toISOString();
                        renderFeedbackList();
                    });
                    entry.append(seen);
                }
            }
            if (!item.answered_at) {
                const undo = el('button', 'gate-button gate-button-quiet doc-feedback-undo', 'Zurückziehen');
                undo.type = 'button';
                undo.addEventListener('click', async () => {
                    if (!(await ask('Die Meldung zurückziehen? Die Einsatzleitung sieht sie dann nicht mehr.', 'Zurückziehen'))) return;
                    const { error } = await client.from('tt_doctor_feedback').delete().eq('id', item.id);
                    if (error) { banner(TerminCloud.germanError(error), 'error', $('docFeedbackStatus')); return; }
                    feedback = feedback.filter(other => other.id !== item.id);
                    renderFeedbackList();
                });
                entry.append(undo);
            }
            return entry;
        }));
    }
    $('docFeedbackOpen').addEventListener('click', () => openFeedback());
    $('docFeedbackCancel').addEventListener('click', () => $('docFeedback').close());
    $('docFeedbackForm').addEventListener('submit', async event => {
        event.preventDefault();
        const text = $('docFeedbackText').value.trim();
        if (!text) { $('docFeedbackStatus').textContent = 'Bitte schreib, was du melden möchtest.'; $('docFeedbackText').focus(); return; }
        const send = $('docFeedbackSend');
        send.disabled = true;
        const ref = $('docFeedbackRef').value.trim();
        const row = { topic: feedbackTopic(), text, document_id: $('docFeedback').dataset.doc || null, patient_nr: /^\d{2,}$/.test(ref) ? ref : '', patient_name: /^\d{2,}$/.test(ref) ? '' : ref };
        const { data, error } = await client.from('tt_doctor_feedback').insert(row).select().maybeSingle();
        send.disabled = false;
        if (error) { $('docFeedbackStatus').textContent = missing(error) ? 'Dafür fehlt noch ein Datenbank-Update (Update 42). Bitte der Einsatzleitung Bescheid sagen.' : TerminCloud.germanError(error); return; }
        if (data) feedback.unshift(data);
        $('docFeedbackText').value = '';
        $('docFeedbackStatus').textContent = '';
        renderFeedbackList();
        TerminCloud.callFunction?.({ action: 'doctorFeedback', feedbackId: data?.id })?.catch?.(() => null);
        $('docFeedback').close();
        banner('Meldung an die Einsatzleitung gesendet – die Antwort erscheint unter „An die Einsatzleitung“.', 'info');
        window.setTimeout(() => { if (!$('docStatus').hidden && /Meldung an die Einsatzleitung gesendet/.test($('docStatus').textContent)) banner(''); }, 6000);
    });

    function docEntry(doc, { inRecord = false, withDay = false } = {}) {
        const item = el('li', 'doc-entry');
        item.dataset.id = doc.id;
        item.dataset.group = group(doc);
        if (!inRecord && dayOf(doc) === today() && Date.now() - new Date(doc.created_at) < FRESH) item.dataset.fresh = String(new Date(doc.created_at).getTime());
        const read = readMarks(doc);
        item.dataset.read = read.length ? 'ja' : '';
        const head = el('div', 'doc-entry-head');
        head.append(el('span', 'doc-kind', kindLabel(doc)), el('strong', 'doc-time', inRecord ? (doc.date ? german(doc.date) : `hochgeladen ${german(doc.created_at)}`) : withDay ? `${short(dayOf(doc))} · ${clock(doc.created_at)} Uhr` : `${clock(doc.created_at)} Uhr`));
        const title = el('div', 'doc-entry-title');
        title.append(el('strong', '', clean(doc.title) || kindLabel(doc)), el('span', 'doc-from', fromLine(doc)));
        const body = el('div', 'doc-entry-body');
        const text = clean(doc.body) ? String(doc.body).trim() : '';
        if (text) {
            const paragraph = el('p', 'doc-text', text);
            const long = text.length > 420 && !opened.has(doc.id);
            if (long) {
                paragraph.textContent = `${text.slice(0, 400).trim()} …`;
                const more = el('button', 'gate-button gate-button-quiet doc-more', 'Ganzen Bericht lesen');
                more.type = 'button';
                more.addEventListener('click', () => { opened.add(doc.id); paragraph.textContent = text; more.remove(); });
                body.append(paragraph, more);
            } else body.append(paragraph);
        }
        if (clean(doc.note)) body.append(el('p', 'doc-note', `Bemerkung: ${clean(doc.note)}`));
        if ((doc.warnings || []).length) body.append(el('p', 'doc-note', `Hinweis: ${doc.warnings.join(' · ')}`));
        if (questionsOf(doc).length) body.append(questionBlock(doc));
        const actions = el('div', 'doc-entry-actions');
        if (doc.file_path) {
            const open = el('button', 'gate-button doc-open', doc.pages ? `PDF öffnen (${doc.pages} ${doc.pages === 1 ? 'Seite' : 'Seiten'})` : 'PDF öffnen');
            open.type = 'button';
            open.addEventListener('click', () => openFile(doc.file_path, open));
            actions.append(open);
        } else if (!text) actions.append(el('span', 'doc-from', 'Keine Datei hinterlegt.'));
        if (read.length) {
            actions.append(el('span', 'doc-read', `Gelesen: ${read.map(mark => `${mark.doctor_name || 'Arzt'} ${clock(mark.at)} Uhr`).join(', ')}`));
            const mine = read.find(mark => mark.doctor_id === profile.id && Date.now() - new Date(mark.at) < 24 * 3600 * 1000);
            if (mine) {
                const undo = el('button', 'gate-button gate-button-quiet doc-unread', 'Doch nicht gelesen');
                undo.type = 'button';
                undo.addEventListener('click', () => unmark(mine, undo));
                actions.append(undo);
            }
        } else {
            const mark = el('button', 'gate-button gate-button-main doc-mark', '✓ Gelesen');
            mark.type = 'button';
            mark.addEventListener('click', () => markRead(doc, mark));
            actions.append(mark);
        }
        if (doc.uploader_id && !inRecord) {
            const askButton = el('button', 'gate-button doc-ask-open', 'Dolmetscher fragen');
            askButton.type = 'button';
            askButton.addEventListener('click', () => openAsk(doc, 'frage'));
            const orderButton = el('button', 'gate-button doc-order-open', 'Anweisung');
            orderButton.type = 'button';
            orderButton.title = 'Eine Anweisung an den Dolmetscher – erscheint bei ihm groß und rot, er bestätigt mit „Verstanden“';
            orderButton.addEventListener('click', () => openAsk(doc, 'anweisung'));
            actions.append(askButton, orderButton);
        }
        if (!inRecord) {
            const officeButton = el('button', 'gate-button gate-button-quiet doc-feedback-open-doc', 'Einsatzleitung');
            officeButton.type = 'button';
            officeButton.title = 'Der Einsatzleitung etwas zu dieser Unterlage melden';
            officeButton.addEventListener('click', () => openFeedback(doc, 'bericht'));
            actions.append(officeButton);
        }
        item.append(head, title, body, actions);
        return item;
    }

    // ---------- Wer ist wo (Update 51): Termine des Tages, knapp ----------
    const jobTitle = row => ['Termin', row.time ? `${row.time} Uhr` : '', clean(row.doctor)].filter(Boolean).join(' · ');
    // Stand eines Termins: aus | fertig | unterwegs | geplant
    function jobState(row) {
        if (row.storno_at || ['storniert', 'alleine'].includes(row.work_status)) return { key: 'aus', label: row.work_status === 'alleine' ? 'Patient geht alleine' : 'Fällt aus', detail: clean(row.storno_note) };
        if (row.finished_at || row.work_status === 'beendet') return { key: 'fertig', label: row.finished_at ? `Fertig seit ${clock(row.finished_at)} Uhr` : 'Fertig', detail: '' };
        if (row.started_at || row.work_status === 'losgefahren') return { key: 'unterwegs', label: row.started_at ? `Unterwegs seit ${clock(row.started_at)} Uhr` : 'Unterwegs', detail: '' };
        return { key: 'geplant', label: row.response === 'zugesagt' ? 'Geplant' : row.response === 'vorbehalt' ? 'Unter Vorbehalt' : 'Noch nicht zugesagt', detail: '' };
    }
    const reportOwed = row => !row.report_id && jobState(row).key !== 'aus';          // Bericht steht noch aus (auch wenn der Termin noch läuft)
    const reportMissing = row => !row.report_id && jobState(row).key === 'fertig';    // Termin fertig, Bericht fehlt
    const STATE_ORDER = { unterwegs: 0, geplant: 1, fertig: 2, aus: 3 };
    const liveRunning = rows => rows.filter(row => jobState(row).key === 'unterwegs');
    const liveMissing = rows => rows.filter(reportMissing);

    // Der Bericht zu einem Termin: steht er schon in der Liste, sofort; sonst eigens holen.
    async function showReport(row, button) {
        let doc = [...all, ...extra].find(item => item.id === row.report_id) || null;
        if (!doc) {
            button.disabled = true;
            const result = await client.from('tt_documents').select('*').eq('id', row.report_id).maybeSingle();
            button.disabled = false;
            if (result.error || !result.data) { banner(result.error ? TerminCloud.germanError(result.error) : 'Der Bericht ließ sich nicht laden.', 'error'); return; }
            doc = result.data;
        }
        const dialog = $('docRecord');
        $('docRecordTitle').textContent = clean(doc.patient_name) || clean(row.patient_name) || 'Patient';
        $('docRecordSub').textContent = [jobTitle(row), row.interpreter_name ? `Dolmetscher/in: ${row.interpreter_name}` : '', row.date ? german(row.date) : ''].filter(Boolean).join(' · ');
        banner('', 'info', $('docRecordStatus'));
        const list = el('ul', 'doc-entries');
        list.append(docEntry(doc));
        $('docRecordBody').replaceChildren(el('h3', 'doc-record-group', 'Dolmetscherbericht'), list);
        dialog.showModal();
    }

    function liveRow(row) {
        const item = el('li', 'live-row');
        item.dataset.id = row.id;
        const state = jobState(row);
        item.dataset.state = state.key;
        item.dataset.report = row.report_id ? 'ja' : row.request_id && !row.request_done_at ? 'angefordert' : state.key === 'aus' ? '' : 'nein';
        const time = el('div', 'live-time');
        time.append(el('strong', '', row.time || '–'), el('span', '', 'Uhr'));
        const who = el('div', 'live-who');
        const avatar = el('span', 'doc-avatar', clean(row.interpreter_name).split(/[\s,]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toLocaleUpperCase('de-DE') || '?');
        avatar.setAttribute('aria-hidden', 'true');
        const whoText = el('div', 'live-who-text');
        whoText.append(el('span', 'live-label', 'Dolmetscher/in'), el('strong', '', row.interpreter_name || 'Ohne Namen'));
        const pill = el('span', 'live-state', state.label);
        if (state.detail) pill.title = state.detail;
        whoText.append(pill);
        who.append(avatar, whoText);
        const where = el('div', 'live-where');
        where.append(el('span', 'live-label', 'Arzt / Praxis'), el('strong', '', clean(row.doctor) || 'Ohne Angabe'), el('span', 'live-sub', clean(row.city)));
        const patient = el('div', 'live-patient');
        patient.append(el('span', 'live-label', 'Patient/in'), el('strong', '', clean(row.patient_name) || 'Ohne Namen'), el('span', 'live-sub', clean(row.patient_nr) ? `Akte ${clean(row.patient_nr)}` : ''));
        const report = el('div', 'live-report');
        if (row.report_id) {
            report.append(el('span', 'live-report-state is-ok', `Bericht da · ${clock(row.report_at)} Uhr${row.report_status && row.report_status !== 'neu' ? ' · geprüft' : ''}`));
            const read = el('button', 'gate-button gate-button-main live-report-open', 'Bericht lesen');
            read.type = 'button';
            read.addEventListener('click', () => showReport(row, read));
            report.append(read);
        } else if (state.key === 'aus') {
            report.append(el('span', 'live-report-state', 'Kein Bericht nötig'));
        } else {
            if (row.request_id && !row.request_done_at) report.append(el('span', 'live-report-state is-asked', `Angefordert ${clock(row.request_at)} Uhr${row.request_by ? ` von ${row.request_by}` : ''}`), el('span', 'live-sub', clean(row.request_answer) ? `Antwort: ${clean(row.request_answer)}` : state.key === 'fertig' ? 'Bericht noch nicht hochgeladen.' : 'Der Termin läuft noch.'));
            else report.append(el('span', 'live-report-state is-missing', state.key === 'fertig' ? 'Bericht fehlt' : 'Noch kein Bericht'));
            const askReport = el('button', `gate-button live-report-ask${row.request_id && !row.request_done_at ? ' gate-button-quiet' : ' gate-button-main'}`, row.request_id && !row.request_done_at ? 'Noch einmal anfordern' : 'Bericht anfordern');
            askReport.type = 'button';
            askReport.addEventListener('click', () => openAskJob(row, 'bericht'));
            report.append(askReport);
        }
        const message = el('button', 'gate-button gate-button-quiet live-message', 'Nachricht');
        message.type = 'button';
        message.title = 'Frage, Info oder Anweisung an den Dolmetscher zu diesem Termin';
        message.addEventListener('click', () => openAskJob(row, 'frage'));
        report.append(message);
        item.append(time, who, where, patient, report);
        const asked = jobQuestionsOf(row).filter(question => kindOf(question) !== 'bericht' || question.id !== row.request_id);
        if (asked.length) { const more = el('div', 'live-questions'); more.append(questionCards(asked)); item.append(more); }
        return item;
    }

    function renderLive() {
        const rows = [...live].sort((left, right) => (STATE_ORDER[jobState(left).key] - STATE_ORDER[jobState(right).key]) || String(left.time).localeCompare(String(right.time)) || String(left.interpreter_name).localeCompare(String(right.interpreter_name), 'de'));
        const needle = fold(liveSearch);
        const visible = rows.filter(row => (liveFilter === 'alle' || (liveFilter === 'unterwegs' ? jobState(row).key === 'unterwegs' : liveFilter === 'fertig' ? jobState(row).key === 'fertig' : reportOwed(row)))
            && (!needle || fold(`${row.interpreter_name} ${row.doctor} ${row.city} ${row.patient_name} ${row.patient_nr}`).includes(needle)));
        const isToday = day === today();
        $('docListTitle').textContent = isToday ? 'Wer ist wo · Heute' : `Wer ist wo · ${dayLong(day)}`;
        const running = liveRunning(rows).length; const done = rows.filter(row => jobState(row).key === 'fertig').length; const missing = liveMissing(rows).length;
        $('docListSub').textContent = !liveReady ? 'Dafür fehlt noch ein Datenbank-Update (Update 51). Bitte der Einsatzleitung Bescheid sagen.'
            : rows.length ? `${rows.length} ${rows.length === 1 ? 'Termin' : 'Termine'} · ${running} unterwegs · ${done} fertig · ${missing ? `${missing} fertig ohne Bericht` : done ? 'alle Berichte da' : 'noch kein Bericht fällig'}` : '';
        $('liveEmpty').hidden = visible.length > 0;
        $('liveEmpty').textContent = rows.length ? 'Dazu gibt es an diesem Tag nichts.' : isToday ? 'Heute stehen keine Termine an.' : `Am ${dayLong(day)} standen keine Termine an.`;
        $('liveList').replaceChildren(...visible.map(liveRow));
    }

    // ---------- Übersicht links: nach Tagen ----------
    function renderSide() {
        const unreadAll = all.filter(doc => !isRead(doc));
        const days = new Map();
        all.forEach(doc => { const key = dayOf(doc); if (!days.has(key)) days.set(key, { total: 0, unread: 0 }); days.get(key).total += 1; if (!isRead(doc)) days.get(key).unread += 1; });
        if (!days.has(today())) days.set(today(), { total: 0, unread: 0 });
        $('docOpenAllCount').textContent = String(unreadAll.length);
        const openDays = [...days.values()].filter(item => item.unread).length;
        $('docOpenAllDays').textContent = unreadAll.length ? `an ${openDays} ${openDays === 1 ? 'Tag' : 'Tagen'} · alle zeigen` : 'Alles gelesen – gut gemacht.';
        $('docOpenAll').classList.toggle('is-active', mode === 'open');
        $('docOpenAll').dataset.open = unreadAll.length ? 'ja' : '';
        const list = $('docDays');
        list.replaceChildren(...[...days.entries()].sort((left, right) => right[0].localeCompare(left[0])).map(([key, info]) => {
            const item = el('li');
            const button = el('button', 'doc-day');
            button.type = 'button';
            button.dataset.day = key;
            button.classList.toggle('is-active', mode === 'day' && day === key);
            button.dataset.unread = info.unread ? 'ja' : '';
            const label = el('span', 'doc-day-label');
            label.append(el('strong', '', key === today() ? 'Heute' : short(key)), el('small', '', key === today() ? short(key) : `${info.total} ${info.total === 1 ? 'Unterlage' : 'Unterlagen'}`));
            const count = el('span', 'doc-day-count', info.unread ? String(info.unread) : '✓');
            count.title = info.unread ? `${info.unread} noch nicht gelesen` : 'alles gelesen';
            button.append(label, count);
            button.addEventListener('click', () => { mode = 'day'; day = key; $('docDay').value = key; known = null; render(); });
            item.append(button);
            return item;
        }));
        const askOpen = questions.filter(item => item.doctor_id === profile.id && !questionDone(item)).length;
        $('docCountAsk').textContent = String(askOpen);
        $('docCountAskBox').dataset.open = askOpen ? 'ja' : '';
        $('docCountAskBox').classList.toggle('is-active', mode === 'ask');
        $('docCountUnread').textContent = String(unreadAll.length);
        $('docCountUnreadBox').dataset.open = unreadAll.length ? 'ja' : '';
        $('docCountUnreadBox').classList.toggle('is-active', mode === 'open');
        // PR und Büro: Zähler zu den Terminen von heute
        const liveOn = canLive();
        $('docCountLiveBox').hidden = $('docCountMissingBox').hidden = !liveOn;
        $('docTabs').hidden = !liveOn;
        if (liveOn) {
            const running = liveRunning(liveToday).length; const missing = liveMissing(liveToday).length;
            $('docCountLive').textContent = String(running);
            $('docCountLiveBox').dataset.open = running ? 'ja' : '';
            $('docCountLiveBox').classList.toggle('is-active', view === 'live' && mode === 'day' && day === today());
            $('docCountMissing').textContent = String(missing);
            $('docCountMissingBox').dataset.open = missing ? 'ja' : '';
            $('docCountMissingBox').classList.toggle('is-active', view === 'live' && mode === 'day' && day === today() && liveFilter === 'ohne');
            $('docTabLiveCount').hidden = !running;
            $('docTabLiveCount').textContent = String(running);
            $('docTabDocs').classList.toggle('is-active', view !== 'live' || mode !== 'day');
            $('docTabDocs').setAttribute('aria-selected', view !== 'live' || mode !== 'day' ? 'true' : 'false');
            $('docTabLive').classList.toggle('is-active', view === 'live' && mode === 'day');
            $('docTabLive').setAttribute('aria-selected', view === 'live' && mode === 'day' ? 'true' : 'false');
        }
    }

    function currentDocs() {
        if (mode === 'open') return all.filter(doc => !isRead(doc));
        if (mode === 'ask') { const ids = new Set(questions.filter(item => item.doctor_id === profile.id || isStaff()).map(item => item.document_id)); return [...all, ...extra].filter(doc => ids.has(doc.id)); }
        return (inWindow(day) ? all : extra).filter(doc => dayOf(doc) === day);
    }

    function render() {
        renderSide();
        const liveView = view === 'live' && mode === 'day' && canLive();
        $('liveFilters').hidden = !liveView;
        $('liveList').hidden = !liveView;
        $('docFilters').hidden = liveView;
        $('docList').hidden = liveView;
        $('docJobQuestions').hidden = true;
        if (liveView) {
            $('docEmpty').hidden = true;
            // Ein anderer Tag gewählt: die Termine dieses Tages eigens holen.
            if (liveDay !== day) { live = []; renderLive(); $('docListSub').textContent = 'Wird geladen …'; $('liveEmpty').hidden = true; load(); tick(); return; }
            renderLive(); tick(); return;
        }
        $('liveEmpty').hidden = true;
        const docs = currentDocs();
        const isToday = mode === 'day' && day === today();
        const list = $('docList');
        const needle = fold(search);
        const visible = docs.filter(doc => (filter === 'alle' || (filter === 'ungelesen' ? !isRead(doc) : group(doc) === filter))
            && (!needle || fold(`${doc.patient_name} ${doc.patient_nr} ${doc.title} ${doc.doctor} ${doc.uploader_name}`).includes(needle)));
        const todays = all.filter(doc => dayOf(doc) === today());
        $('docCountReports').textContent = String(todays.filter(doc => group(doc) === 'dolmetscher').length);
        $('docCountMedical').textContent = String(todays.filter(doc => group(doc) === 'arzt').length);
        $('docCountOther').textContent = String(todays.filter(doc => group(doc) === 'rest').length);
        const unread = docs.filter(doc => !isRead(doc)).length;
        $('docListTitle').textContent = mode === 'open' ? 'Alles, was noch nicht gelesen ist' : mode === 'ask' ? 'Meine Fragen an die Dolmetscher' : isToday ? 'Heute' : dayLong(day);
        $('docListSub').textContent = mode === 'open' ? `${docs.length} ${docs.length === 1 ? 'Unterlage' : 'Unterlagen'} der letzten ${WINDOW_DAYS} Tage · nach Patient` : mode === 'ask'
            ? `${questions.filter(item => !item.answered_at).length} offen · ${questions.filter(item => item.answered_at).length} beantwortet`
            : `${docs.length} ${docs.length === 1 ? 'Unterlage' : 'Unterlagen'}${docs.length ? ` · ${unread ? `${unread} noch nicht gelesen` : 'alle gelesen'}` : ''}`;
        $('docEmpty').hidden = visible.length > 0;
        $('docEmpty').textContent = mode === 'open' ? (docs.length ? 'Dazu gibt es nichts Ungelesenes.' : 'Alles gelesen – nichts offen.') : mode === 'ask' ? 'Du hast noch keine Frage gestellt.' : docs.length ? 'Dazu gibt es an diesem Tag nichts.' : isToday ? 'Heute ist noch nichts hereingekommen.' : `Am ${dayLong(day)} ist nichts hereingekommen.`;
        // Nach Patient: die neueste Unterlage bestimmt die Reihenfolge – was zuletzt kam, steht oben.
        const patients = new Map();
        visible.forEach(doc => { const key = patientKey(doc); if (!patients.has(key)) patients.set(key, []); patients.get(key).push(doc); });
        if (mode === 'ask') {
            const jobQuestions = questions.filter(item => !item.document_id && item.assignment_id && (item.doctor_id === profile.id || isStaff()));
            $('docJobQuestions').hidden = !jobQuestions.length;
            $('docJobQuestionList').replaceChildren(...jobQuestions.map(item => { const entry = el('li'); entry.append(questionCards([item], { withAbout: true })); return entry; }));
            if (jobQuestions.length && !visible.length) { $('docEmpty').hidden = true; }
        }
        list.replaceChildren(...[...patients.entries()].map(([key, items]) => {
            const card = el('li', 'doc-patient');
            card.dataset.patient = key;
            const first = items[0];
            const head = el('div', 'doc-patient-head');
            const who = el('div', 'doc-patient-who');
            const open = items.filter(item => !isRead(item)).length;
            card.dataset.unread = open ? 'ja' : '';
            const avatar = el('span', 'doc-avatar', clean(first.patient_name).split(/[\s,]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toLocaleUpperCase('de-DE') || '?');
            avatar.setAttribute('aria-hidden', 'true');
            who.append(el('strong', '', clean(first.patient_name) || 'Patient ohne Namen'),
                el('span', '', [clean(first.patient_nr) ? `Akte ${clean(first.patient_nr)}` : 'ohne Aktennummer', clean(first.patient_birth) ? `geb. ${first.patient_birth}` : '', `${items.length} ${items.length === 1 ? 'Unterlage' : 'Unterlagen'}${isToday ? ' heute' : ''}`, open ? `${open} ungelesen` : 'alles gelesen'].filter(Boolean).join(' · ')));
            const lead = el('div', 'doc-patient-lead');
            lead.append(avatar, who);
            head.append(lead);
            if (clean(first.patient_nr)) {
                const openRecord = el('button', 'gate-button doc-record-open', 'Ganze Akte');
                openRecord.type = 'button';
                openRecord.addEventListener('click', () => showRecord(first, openRecord));
                head.append(openRecord);
            }
            const inner = el('ul', 'doc-entries');
            items.forEach(doc => inner.append(docEntry(doc, { withDay: mode !== 'day' })));
            card.append(head, inner);
            return card;
        }));
        tick();
    }

    const missing = error => /does not exist|schema cache|relation|PGRST205|42P01/i.test(`${error?.code || ''} ${error?.message || ''}`);
    async function load() {
        if (busy || !profile) return;
        busy = true;
        try {
            const from = windowStart();
            const base = () => client.from('tt_documents').select('*').is('replaced_by', null).neq('status', 'archiv').order('created_at', { ascending: false });
            const [docsResult, marksResult, questionResult, feedbackResult] = await Promise.all([
                base().gte('created_at', from.toISOString()).limit(800),
                client.from('tt_doctor_marks').select('*').eq('action', 'gelesen').gte('at', from.toISOString()).limit(2000),
                client.from('tt_doctor_questions').select('*').order('created_at', { ascending: false }).limit(400),
                client.from('tt_doctor_feedback').select('*').order('created_at', { ascending: false }).limit(60)
            ]);
            feedbackReady = !feedbackResult.error;
            feedback = feedbackReady ? (feedbackResult.data || []) : [];
            if (!$('docFeedback').open) renderFeedbackList();
            if (docsResult.error) {
                banner(/row-level security|permission denied/i.test(docsResult.error.message || '') || missing(docsResult.error) ? 'Die Anzeige ist in der Datenbank noch nicht eingerichtet (Update 34 fehlt). Bitte der Einsatzleitung Bescheid sagen.' : `Keine Verbindung: ${TerminCloud.germanError(docsResult.error)}`, 'error');
                return;
            }
            if (!$('docStatus').hidden && /Keine Verbindung|nicht eingerichtet/.test($('docStatus').textContent)) banner('');
            all = docsResult.data || [];
            marks = marksResult.error ? [] : (marksResult.data || []);
            questions = questionResult.error ? [] : (questionResult.data || []);
            // Ein älterer Tag (außerhalb der Übersicht) wird eigens geholt.
            if (mode === 'day' && !inWindow(day)) {
                const start = new Date(`${day}T00:00:00`); const end = new Date(start); end.setDate(end.getDate() + 1);
                const older = await base().gte('created_at', start.toISOString()).lt('created_at', end.toISOString()).limit(300);
                extra = older.error ? [] : (older.data || []);
            } else extra = [];
            if (canLive()) {
                const [todayResult, dayResult] = await Promise.all([client.rpc('tt_pr_live', { p_date: today() }), day === today() ? null : client.rpc('tt_pr_live', { p_date: day })]);
                liveReady = !todayResult.error;
                liveToday = liveReady ? (todayResult.data || []) : [];
                live = day === today() ? liveToday : (dayResult && !dayResult.error ? (dayResult.data || []) : []);
                liveDay = day;
            } else { live = []; liveToday = []; liveDay = day; }
            const ids = new Set(all.map(doc => doc.id));
            if (known && all.some(doc => !known.has(doc.id) && dayOf(doc) === today())) chime();
            known = ids;
            render();
        } finally { busy = false; }
    }

    async function markRead(doc, button) {
        button.disabled = true;
        const { error } = await client.from('tt_doctor_marks').insert({ action: 'gelesen', document_id: doc.id, patient_nr: clean(doc.patient_nr) });
        button.disabled = false;
        if (error) { banner(missing(error) ? 'Dafür fehlt noch ein Datenbank-Update (Update 34).' : TerminCloud.germanError(error), 'error'); return; }
        await load();
    }
    async function unmark(mark, button) {
        if (!(await ask('Den Haken „Gelesen“ zurücknehmen?', 'Zurücknehmen'))) return;
        button.disabled = true;
        const { error } = await client.from('tt_doctor_marks').delete().eq('id', mark.id);
        button.disabled = false;
        if (error) { banner(TerminCloud.germanError(error), 'error'); return; }
        await load();
    }

    // ---------- Ganze Akte ----------
    async function showRecord(doc, button) {
        const nr = clean(doc.patient_nr);
        const dialog = $('docRecord');
        $('docRecordTitle').textContent = clean(doc.patient_name) || 'Patient';
        $('docRecordSub').textContent = [`Akte ${nr}`, clean(doc.patient_birth) ? `geb. ${doc.patient_birth}` : ''].filter(Boolean).join(' · ');
        $('docRecordBody').replaceChildren(el('p', 'doc-from', 'Die Akte wird geladen …'));
        banner('', 'info', $('docRecordStatus'));
        dialog.showModal();
        button.disabled = true;
        const [result] = await Promise.all([
            client.from('tt_documents').select('*').eq('patient_nr', nr).is('replaced_by', null).order('date', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(400),
            client.from('tt_doctor_marks').insert({ action: 'akte', patient_nr: nr })       // Jeder Blick in eine Akte wird festgehalten.
        ]);
        button.disabled = false;
        if (result.error) { banner(TerminCloud.germanError(result.error), 'error', $('docRecordStatus')); return; }
        const rows = result.data || [];
        const ids = rows.map(item => item.id);
        const markResult = ids.length ? await client.from('tt_doctor_marks').select('*').eq('action', 'gelesen').in('document_id', ids.slice(0, 200)) : { data: [] };
        if (!markResult.error) marks = [...marks.filter(mark => !ids.includes(mark.document_id)), ...(markResult.data || [])];
        $('docRecordSub').textContent += ` · ${rows.length} ${rows.length === 1 ? 'Unterlage' : 'Unterlagen'}`;
        if (!rows.length) { $('docRecordBody').replaceChildren(el('p', 'doc-from', 'Zu diesem Patienten gibt es noch keine Unterlagen.')); return; }
        const groups = [['dolmetscher', 'Dolmetscherberichte'], ['arzt', 'Arztberichte und Befunde'], ['rest', 'Rezepte, Überweisungen, Sonstiges']];
        const body = $('docRecordBody');
        body.replaceChildren();
        groups.forEach(([key, label]) => {
            const items = rows.filter(item => group(item) === key);
            if (!items.length) return;
            body.append(el('h3', 'doc-record-group', `${label} (${items.length})`));
            const list = el('ul', 'doc-entries');
            items.forEach(item => list.append(docEntry(item, { inRecord: true })));
            body.append(list);
        });
    }
    $('docRecordClose').addEventListener('click', () => $('docRecord').close());
    $('docRecord').addEventListener('close', () => render());

    async function start() {
        if (!client) { show('auth'); $('docAuthStatus').textContent = 'Die Verbindung zur Datenbank konnte nicht geladen werden. Bitte das Internet prüfen und die Seite neu laden.'; return; }
        try { profile = await TerminCloud.getProfile(true); } catch (error) { profile = null; }
        if (!profile) { show('auth'); return; }
        if (!canSee(profile)) {
            show('auth');
            $('docAuthStatus').textContent = profile.active ? 'Dieses Konto ist nicht für die Berichte-Anzeige freigegeben. Bitte die Einsatzleitung fragen.' : 'Dieses Konto ist noch nicht freigeschaltet. Bitte die Einsatzleitung fragen.';
            return;
        }
        day = today();
        mode = 'day';
        view = profile.role === 'pr' ? 'live' : 'docs';
        $('docDay').value = day;
        $('docDay').max = day;
        $('docOffice').hidden = !isStaff();
        known = null;
        show('app');
        await load();
    }

    $('docSignIn').addEventListener('submit', async event => {
        event.preventDefault();
        const status = $('docAuthStatus');
        status.textContent = 'Anmeldung läuft …';
        try {
            const result = await TerminCloud.signIn($('docEmail').value.trim(), $('docPassword').value);
            if (result?.error) throw new Error(TerminCloud.germanError(result.error));
            $('docPassword').value = '';
            status.textContent = '';
            await start();
        } catch (error) { status.textContent = error.message || 'Die Anmeldung hat nicht geklappt.'; }
    });
    $('docSignOut').addEventListener('click', async () => {
        if (!(await ask('Abmelden?', 'Abmelden'))) return;
        await TerminCloud.signOut();
        profile = null; all = []; extra = []; marks = []; questions = []; live = []; liveToday = [];
        show('auth');
    });
    $('docDay').addEventListener('change', () => { day = $('docDay').value || today(); mode = 'day'; known = null; load(); });
    $('docOpenAll').addEventListener('click', () => { mode = mode === 'open' ? 'day' : 'open'; render(); });
    $('docCountUnreadBox').addEventListener('click', () => { mode = mode === 'open' ? 'day' : 'open'; render(); });
    $('docCountAskBox').addEventListener('click', () => { mode = mode === 'ask' ? 'day' : 'ask'; render(); });
    // Wer ist wo (PR und Büro)
    const setLiveFilter = key => { liveFilter = key; document.querySelectorAll('#liveFilters .doc-chip').forEach(chip => chip.classList.toggle('is-active', chip.dataset.live === key)); };
    const goLive = (filterKey = null) => { view = 'live'; mode = 'day'; if (filterKey) setLiveFilter(filterKey); if (day !== today() && filterKey) { day = today(); $('docDay').value = day; known = null; load(); } render(); };
    $('docTabLive').addEventListener('click', () => goLive());
    $('docTabDocs').addEventListener('click', () => { view = 'docs'; mode = 'day'; render(); });
    $('docCountLiveBox').addEventListener('click', () => goLive('unterwegs'));
    $('docCountMissingBox').addEventListener('click', () => goLive('ohne'));
    document.querySelectorAll('#liveFilters .doc-chip').forEach(chip => chip.addEventListener('click', () => { setLiveFilter(chip.dataset.live); render(); }));
    $('liveSearch').addEventListener('input', () => { liveSearch = $('liveSearch').value; render(); });
    $('docFull').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => null); });
    document.addEventListener('fullscreenchange', () => { $('docFull').textContent = document.fullscreenElement ? 'Vollbild beenden' : 'Vollbild'; });
    document.querySelectorAll('#docFilters .doc-chip').forEach(chip => chip.addEventListener('click', () => {
        filter = chip.dataset.filter;
        document.querySelectorAll('#docFilters .doc-chip').forEach(other => other.classList.toggle('is-active', other === chip));
        render();
    }));
    $('docSearch').addEventListener('input', () => { search = $('docSearch').value; render(); });

    window.setInterval(tick, 1000);
    let shownToday = '';
    window.setInterval(() => {
        if (!profile || $('docApp').hidden) return;
        const now = today();
        if (shownToday && shownToday !== now && day === shownToday) { day = now; $('docDay').value = now; known = null; }
        shownToday = now;
        $('docDay').max = now;
        if (!$('docRecord').open && !$('docAsk').open) load();
    }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    window.ArztApp = { state: () => ({ day, mode, view, docs: currentDocs(), all, marks, questions, live, liveToday, profile }), load };
    start();
})();
