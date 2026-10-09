// Berichte des Tages: Anzeige für die Ärztinnen und Ärzte im Haus (Rolle „Arzt“, Update 34).
// Alles, was an einem Tag hereinkommt – Dolmetscherberichte, Arztberichte, Rezepte, Überweisungen – nach Patient geordnet.
// Jeder Bericht lässt sich lesen bzw. als PDF öffnen und mit „Gelesen“ abhaken; die ganze Akte eines Patienten öffnet sich daneben.
// Ärzte lesen nur: nichts hochladen, nichts ändern. „Gelesen“ und jeder Blick in eine Akte werden festgehalten (tt_doctor_marks).
(function () {
    const $ = id => document.getElementById(id);
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const client = typeof TerminCloud === 'undefined' ? null : TerminCloud.client;
    const REPORT = 'Dolmetscherbericht';
    const clock = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const german = iso => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
    const dayLong = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const fold = value => clean(value).toLocaleLowerCase('de-DE').normalize('NFD').replace(/[̀-ͯ]/g, '');
    const FRESH = 120000;
    let profile = null;
    let day = '';
    let docs = [];
    let marks = [];
    let filter = 'alle';
    let search = '';
    let known = null;
    let busy = false;
    let opened = new Set();          // aufgeklappte Berichte

    const today = () => TerminCloud.todayIso();
    const canSee = account => Boolean(account?.active && ['arzt', 'admin', 'sekretariat'].includes(account.role));
    const isStaff = () => TerminCloud.isStaff(profile);
    const group = doc => (doc.kind === REPORT ? 'dolmetscher' : /^(Arztbericht|Befund)/.test(doc.kind) ? 'arzt' : 'rest');
    const readMarks = doc => marks.filter(mark => mark.action === 'gelesen' && mark.document_id === doc.id);
    const isRead = doc => readMarks(doc).length > 0;
    const patientKey = doc => clean(doc.patient_nr) || `name:${fold(doc.patient_name)}`;

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

    function docEntry(doc, { inRecord = false } = {}) {
        const item = el('li', 'doc-entry');
        item.dataset.id = doc.id;
        item.dataset.group = group(doc);
        if (!inRecord && day === today() && Date.now() - new Date(doc.created_at) < FRESH) item.dataset.fresh = String(new Date(doc.created_at).getTime());
        const read = readMarks(doc);
        item.dataset.read = read.length ? 'ja' : '';
        const head = el('div', 'doc-entry-head');
        head.append(el('span', 'doc-kind', kindLabel(doc)), el('strong', 'doc-time', inRecord ? (doc.date ? german(doc.date) : `hochgeladen ${german(doc.created_at)}`) : `${clock(doc.created_at)} Uhr`));
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
        const actions = el('div', 'doc-entry-actions');
        if (doc.file_path) {
            const open = el('button', 'gate-button doc-open', doc.pages ? `PDF öffnen (${doc.pages} ${doc.pages === 1 ? 'Seite' : 'Seiten'})` : 'PDF öffnen');
            open.type = 'button';
            open.addEventListener('click', () => openFile(doc.file_path, open));
            actions.append(open);
        } else if (!text) actions.append(el('span', 'doc-from', 'Keine Datei hinterlegt.'));
        if (read.length) {
            const who = el('span', 'doc-read', `Gelesen: ${read.map(mark => `${mark.doctor_name || 'Arzt'} ${clock(mark.at)} Uhr`).join(', ')}`);
            actions.append(who);
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
        item.append(head, title, body, actions);
        return item;
    }

    function render() {
        const live = day === today();
        const list = $('docList');
        const needle = fold(search);
        const visible = docs.filter(doc => (filter === 'alle' || (filter === 'ungelesen' ? !isRead(doc) : group(doc) === filter))
            && (!needle || fold(`${doc.patient_name} ${doc.patient_nr} ${doc.title} ${doc.doctor} ${doc.uploader_name}`).includes(needle)));
        $('docCountUnread').textContent = String(docs.filter(doc => !isRead(doc)).length);
        $('docCountUnreadBox').dataset.open = docs.some(doc => !isRead(doc)) ? 'ja' : '';
        $('docCountReports').textContent = String(docs.filter(doc => group(doc) === 'dolmetscher').length);
        $('docCountMedical').textContent = String(docs.filter(doc => group(doc) === 'arzt').length);
        $('docCountOther').textContent = String(docs.filter(doc => group(doc) === 'rest').length);
        $('docEmpty').hidden = visible.length > 0;
        $('docEmpty').textContent = docs.length ? 'Dazu gibt es an diesem Tag nichts.' : live ? 'Heute ist noch nichts hereingekommen.' : `Am ${dayLong(day)} ist nichts hereingekommen.`;
        // Nach Patient: die neueste Unterlage bestimmt die Reihenfolge – was zuletzt kam, steht oben.
        const patients = new Map();
        visible.forEach(doc => { const key = patientKey(doc); if (!patients.has(key)) patients.set(key, []); patients.get(key).push(doc); });
        list.replaceChildren(...[...patients.entries()].map(([key, items]) => {
            const card = el('li', 'doc-patient');
            card.dataset.patient = key;
            const first = items[0];
            const head = el('div', 'doc-patient-head');
            const who = el('div', 'doc-patient-who');
            const unread = items.filter(item => !isRead(item)).length;
            card.dataset.unread = unread ? 'ja' : '';
            const avatar = el('span', 'doc-avatar', clean(first.patient_name).split(/[\s,]+/).filter(Boolean).slice(0, 2).map(part => part[0]).join('').toLocaleUpperCase('de-DE') || '?');
            avatar.setAttribute('aria-hidden', 'true');
            who.append(el('strong', '', clean(first.patient_name) || 'Patient ohne Namen'),
                el('span', '', [clean(first.patient_nr) ? `Akte ${clean(first.patient_nr)}` : 'ohne Aktennummer', clean(first.patient_birth) ? `geb. ${first.patient_birth}` : '', `${items.length} ${items.length === 1 ? 'Unterlage' : 'Unterlagen'}${live ? ' heute' : ''}`, unread ? `${unread} ungelesen` : 'alles gelesen'].filter(Boolean).join(' · ')));
            const lead = el('div', 'doc-patient-lead');
            lead.append(avatar, who);
            head.append(lead);
            if (clean(first.patient_nr)) {
                const open = el('button', 'gate-button doc-record-open', 'Ganze Akte');
                open.type = 'button';
                open.addEventListener('click', () => openRecord(first, open));
                head.append(open);
            }
            const inner = el('ul', 'doc-entries');
            items.forEach(doc => inner.append(docEntry(doc)));
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
            const from = new Date(`${day}T00:00:00`); const to = new Date(from); to.setDate(to.getDate() + 1);
            const { data, error } = await client.from('tt_documents').select('*').gte('created_at', from.toISOString()).lt('created_at', to.toISOString())
                .is('replaced_by', null).neq('status', 'archiv').order('created_at', { ascending: false }).limit(300);
            if (error) {
                banner(/row-level security|permission denied/i.test(error.message || '') || missing(error) ? 'Die Anzeige ist in der Datenbank noch nicht eingerichtet (Update 34 fehlt). Bitte der Einsatzleitung Bescheid sagen.' : `Keine Verbindung: ${TerminCloud.germanError(error)}`, 'error');
                return;
            }
            banner('');
            const ids = data.map(doc => doc.id);
            const markResult = ids.length ? await client.from('tt_doctor_marks').select('*').eq('action', 'gelesen').in('document_id', ids) : { data: [] };
            marks = markResult.error ? [] : (markResult.data || []);
            if (known && day === today() && data.some(doc => !known.has(doc.id))) chime();
            known = new Set(ids);
            docs = data;
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
    async function openRecord(doc, button) {
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
        const all = result.data || [];
        const ids = all.map(item => item.id);
        const markResult = ids.length ? await client.from('tt_doctor_marks').select('*').eq('action', 'gelesen').in('document_id', ids) : { data: [] };
        if (!markResult.error) marks = [...marks.filter(mark => !ids.includes(mark.document_id)), ...(markResult.data || [])];
        $('docRecordSub').textContent += ` · ${all.length} ${all.length === 1 ? 'Unterlage' : 'Unterlagen'}`;
        if (!all.length) { $('docRecordBody').replaceChildren(el('p', 'doc-from', 'Zu diesem Patienten gibt es noch keine Unterlagen.')); return; }
        // Nach Art geordnet: zuerst die Berichte der Dolmetscher, dann Arztberichte und Befunde, dann der Rest – je Gruppe das Neueste oben.
        const groups = [['dolmetscher', 'Dolmetscherberichte'], ['arzt', 'Arztberichte und Befunde'], ['rest', 'Rezepte, Überweisungen, Sonstiges']];
        const body = $('docRecordBody');
        body.replaceChildren();
        groups.forEach(([key, label]) => {
            const items = all.filter(item => group(item) === key);
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
        profile = null; docs = []; marks = [];
        show('auth');
    });
    $('docDay').addEventListener('change', () => { day = $('docDay').value || today(); known = null; load(); });
    $('docToday').addEventListener('click', () => { day = today(); $('docDay').value = day; known = null; load(); });
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
        if (!$('docRecord').open) load();
    }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    window.ArztApp = { state: () => ({ day, docs, marks, profile }), load };
    start();
})();
