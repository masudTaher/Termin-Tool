// Berichte des Tages: Anzeige für die Ärztinnen und Ärzte im Haus (Rolle „Arzt“, Update 34; Fragen an Dolmetscher: Update 36).
// Links die Übersicht: Was ist noch nicht gelesen – gesamt und nach Tagen. Rechts die Unterlagen des gewählten Tages (oder alle
// offenen), nach Patient geordnet. Jeder Bericht lässt sich lesen bzw. als PDF öffnen, mit „Gelesen“ abhaken, die ganze Akte
// daneben öffnen – und zu einem Bericht lässt sich der Dolmetscher direkt fragen; die Antwort erscheint unter dem Bericht.
// Ärzte lesen nur: nichts hochladen, nichts ändern. „Gelesen“ und jeder Blick in eine Akte werden festgehalten (tt_doctor_marks).
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
    let known = null;
    let busy = false;
    const opened = new Set();

    const today = () => TerminCloud.todayIso();
    const canSee = account => Boolean(account?.active && ['arzt', 'admin', 'sekretariat'].includes(account.role));
    const isStaff = () => TerminCloud.isStaff(profile);
    const group = doc => (doc.kind === REPORT ? 'dolmetscher' : /^(Arztbericht|Befund)/.test(doc.kind) ? 'arzt' : 'rest');
    const readMarks = doc => marks.filter(mark => mark.action === 'gelesen' && mark.document_id === doc.id);
    const isRead = doc => readMarks(doc).length > 0;
    const patientKey = doc => clean(doc.patient_nr) || `name:${fold(doc.patient_name)}`;
    const questionsOf = doc => questions.filter(item => item.document_id === doc.id);
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
    function questionBlock(doc) {
        const box = el('div', 'doc-questions');
        questionsOf(doc).forEach(item => {
            const card = el('div', 'doc-question');
            card.dataset.state = item.answered_at ? 'beantwortet' : 'offen';
            card.append(el('span', 'doc-question-head', `${item.doctor_id === profile.id ? 'Deine Frage' : `Frage von ${item.doctor_name || 'Arzt'}`} · ${german(item.created_at)} ${clock(item.created_at)} Uhr`), el('p', 'doc-question-text', item.question));
            if (item.answered_at) card.append(el('span', 'doc-question-head', `Antwort von ${item.interpreter_name || 'Dolmetscher'} · ${german(item.answered_at)} ${clock(item.answered_at)} Uhr`), el('p', 'doc-question-answer', item.answer));
            else {
                const wait = el('span', 'doc-question-wait', item.seen_at ? 'Der Dolmetscher hat die Frage gesehen – noch keine Antwort.' : 'Noch nicht beantwortet.');
                card.append(wait);
                if (item.doctor_id === profile.id || isStaff()) {
                    const undo = el('button', 'gate-button gate-button-quiet doc-question-undo', 'Frage zurückziehen');
                    undo.type = 'button';
                    undo.addEventListener('click', async () => {
                        if (!(await ask('Die Frage zurückziehen? Der Dolmetscher sieht sie dann nicht mehr.', 'Zurückziehen'))) return;
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
    function openAsk(doc) {
        const dialog = $('docAsk');
        $('docAskTitle').textContent = clean(doc.title) || kindLabel(doc);
        $('docAskAbout').textContent = [clean(doc.patient_name), clean(doc.patient_nr) ? `Akte ${clean(doc.patient_nr)}` : '', doc.uploader_name ? `Dolmetscher/in: ${doc.uploader_name}` : '', doc.date ? `Termin ${german(doc.date)}` : ''].filter(Boolean).join(' · ');
        $('docAskText').value = '';
        $('docAskStatus').textContent = '';
        dialog.dataset.doc = doc.id;
        dialog.showModal();
        $('docAskText').focus();
    }
    $('docAskCancel').addEventListener('click', () => $('docAsk').close());
    $('docAskForm').addEventListener('submit', async event => {
        event.preventDefault();
        const text = $('docAskText').value.trim();
        if (!text) { $('docAskStatus').textContent = 'Bitte schreib deine Frage.'; $('docAskText').focus(); return; }
        const send = $('docAskSend');
        send.disabled = true;
        const { data, error } = await client.from('tt_doctor_questions').insert({ document_id: $('docAsk').dataset.doc, question: text }).select().maybeSingle();
        send.disabled = false;
        if (error) { $('docAskStatus').textContent = /keinen Dolmetscher/.test(error.message || '') ? 'Zu dieser Unterlage gibt es keinen Dolmetscher, den man fragen könnte.' : /does not exist|schema cache|relation/i.test(error.message || '') ? 'Dafür fehlt noch ein Datenbank-Update (Update 36). Bitte der Einsatzleitung Bescheid sagen.' : TerminCloud.germanError(error); return; }
        $('docAsk').close();
        // Mitteilung aufs Handy des Dolmetschers (falls eingerichtet) – die Frage selbst steht sicher in seiner App.
        TerminCloud.callFunction?.({ action: 'question', questionId: data?.id })?.catch?.(() => null);
        banner(`Frage an ${data?.interpreter_name || 'den Dolmetscher'} gesendet – die Antwort erscheint hier beim Bericht.`, 'info');
        window.setTimeout(() => { if (!$('docStatus').hidden && /Frage an/.test($('docStatus').textContent)) banner(''); }, 6000);
        await load();
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
            askButton.addEventListener('click', () => openAsk(doc));
            actions.append(askButton);
        }
        item.append(head, title, body, actions);
        return item;
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
        const askOpen = questions.filter(item => item.doctor_id === profile.id && !item.answered_at).length;
        $('docCountAsk').textContent = String(askOpen);
        $('docCountAskBox').dataset.open = askOpen ? 'ja' : '';
        $('docCountAskBox').classList.toggle('is-active', mode === 'ask');
        $('docCountUnread').textContent = String(unreadAll.length);
        $('docCountUnreadBox').dataset.open = unreadAll.length ? 'ja' : '';
        $('docCountUnreadBox').classList.toggle('is-active', mode === 'open');
    }

    function currentDocs() {
        if (mode === 'open') return all.filter(doc => !isRead(doc));
        if (mode === 'ask') { const ids = new Set(questions.filter(item => item.doctor_id === profile.id || isStaff()).map(item => item.document_id)); return [...all, ...extra].filter(doc => ids.has(doc.id)); }
        return (inWindow(day) ? all : extra).filter(doc => dayOf(doc) === day);
    }

    function render() {
        renderSide();
        const docs = currentDocs();
        const live = mode === 'day' && day === today();
        const list = $('docList');
        const needle = fold(search);
        const visible = docs.filter(doc => (filter === 'alle' || (filter === 'ungelesen' ? !isRead(doc) : group(doc) === filter))
            && (!needle || fold(`${doc.patient_name} ${doc.patient_nr} ${doc.title} ${doc.doctor} ${doc.uploader_name}`).includes(needle)));
        const todays = all.filter(doc => dayOf(doc) === today());
        $('docCountReports').textContent = String(todays.filter(doc => group(doc) === 'dolmetscher').length);
        $('docCountMedical').textContent = String(todays.filter(doc => group(doc) === 'arzt').length);
        $('docCountOther').textContent = String(todays.filter(doc => group(doc) === 'rest').length);
        const unread = docs.filter(doc => !isRead(doc)).length;
        $('docListTitle').textContent = mode === 'open' ? 'Alles, was noch nicht gelesen ist' : mode === 'ask' ? 'Meine Fragen an die Dolmetscher' : live ? 'Heute' : dayLong(day);
        $('docListSub').textContent = mode === 'open' ? `${docs.length} ${docs.length === 1 ? 'Unterlage' : 'Unterlagen'} der letzten ${WINDOW_DAYS} Tage · nach Patient` : mode === 'ask'
            ? `${questions.filter(item => !item.answered_at).length} offen · ${questions.filter(item => item.answered_at).length} beantwortet`
            : `${docs.length} ${docs.length === 1 ? 'Unterlage' : 'Unterlagen'}${docs.length ? ` · ${unread ? `${unread} noch nicht gelesen` : 'alle gelesen'}` : ''}`;
        $('docEmpty').hidden = visible.length > 0;
        $('docEmpty').textContent = mode === 'open' ? (docs.length ? 'Dazu gibt es nichts Ungelesenes.' : 'Alles gelesen – nichts offen.') : mode === 'ask' ? 'Du hast noch keine Frage gestellt.' : docs.length ? 'Dazu gibt es an diesem Tag nichts.' : live ? 'Heute ist noch nichts hereingekommen.' : `Am ${dayLong(day)} ist nichts hereingekommen.`;
        // Nach Patient: die neueste Unterlage bestimmt die Reihenfolge – was zuletzt kam, steht oben.
        const patients = new Map();
        visible.forEach(doc => { const key = patientKey(doc); if (!patients.has(key)) patients.set(key, []); patients.get(key).push(doc); });
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
                el('span', '', [clean(first.patient_nr) ? `Akte ${clean(first.patient_nr)}` : 'ohne Aktennummer', clean(first.patient_birth) ? `geb. ${first.patient_birth}` : '', `${items.length} ${items.length === 1 ? 'Unterlage' : 'Unterlagen'}${live ? ' heute' : ''}`, open ? `${open} ungelesen` : 'alles gelesen'].filter(Boolean).join(' · ')));
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
            const [docsResult, marksResult, questionResult] = await Promise.all([
                base().gte('created_at', from.toISOString()).limit(800),
                client.from('tt_doctor_marks').select('*').eq('action', 'gelesen').gte('at', from.toISOString()).limit(2000),
                client.from('tt_doctor_questions').select('*').order('created_at', { ascending: false }).limit(400)
            ]);
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
        profile = null; all = []; extra = []; marks = []; questions = [];
        show('auth');
    });
    $('docDay').addEventListener('change', () => { day = $('docDay').value || today(); mode = 'day'; known = null; load(); });
    $('docOpenAll').addEventListener('click', () => { mode = mode === 'open' ? 'day' : 'open'; render(); });
    $('docCountUnreadBox').addEventListener('click', () => { mode = mode === 'open' ? 'day' : 'open'; render(); });
    $('docCountAskBox').addEventListener('click', () => { mode = mode === 'ask' ? 'day' : 'ask'; render(); });
    $('docFull').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => null); });
    document.addEventListener('fullscreenchange', () => { $('docFull').textContent = document.fullscreenElement ? 'Vollbild beenden' : 'Vollbild'; });
    document.querySelectorAll('.doc-chip').forEach(chip => chip.addEventListener('click', () => {
        filter = chip.dataset.filter;
        document.querySelectorAll('.doc-chip').forEach(other => other.classList.toggle('is-active', other === chip));
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
    window.ArztApp = { state: () => ({ day, mode, docs: currentDocs(), all, marks, questions, profile }), load };
    start();
})();
