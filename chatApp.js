// Seite „Nachrichten“ · Chat mit den Dolmetschern (wie ein Messenger).
// Links die Personen (ungelesene zuerst), rechts das Gespräch. Einsatzleitung und Sekretariat schreiben gemeinsam,
// der Dolmetscher antwortet im Portal. Unter jeder eigenen Nachricht steht „gesendet“ oder „gelesen“ mit Uhrzeit;
// öffnet man ein Gespräch, sieht der Dolmetscher bei seinen Nachrichten ebenfalls „gelesen“.
// Jede Nachricht lässt sich korrigieren (eigene) oder löschen. Braucht supabase/update-21.sql.
(function () {
    const $ = id => document.getElementById(id);
    if (!$('chatOffice') || typeof TerminCloud === 'undefined') return;
    const client = TerminCloud.client;
    const POLL_MS = 5000;
    let profile = null;
    let people = [];
    let rows = [];            // alle Chat-Nachrichten, neueste zuerst
    let letters = [];         // frühere Einzelnachrichten (tt_messages, audience „einzeln“)
    let letterReads = [];
    let selected = '';
    let query = '';
    let shownPeople = '';
    let shownThread = '';
    let editing = '';         // Nachricht, die gerade korrigiert wird – dann wird nicht neu gezeichnet
    let knownUnread = null;   // thread → Anzahl ungelesen (für die Einblendung bei neuen Nachrichten)

    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const fold = text => String(text ?? '').toLocaleLowerCase('de-DE').normalize('NFD').replace(/[̀-ͯ]/g, '');
    const clock = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const startOf = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
    function dayLabel(iso) {
        const date = new Date(iso);
        const days = Math.round((startOf(new Date()) - startOf(date)) / 86400000);
        return days === 0 ? 'Heute' : days === 1 ? 'Gestern' : date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    const shortTime = iso => { const label = dayLabel(iso); return label === 'Heute' ? clock(iso) : label === 'Gestern' ? 'Gestern' : new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }); };
    const missing = error => /tt_chat|schema cache|does not exist|could not find/i.test(error?.message || '');

    // Alles, was zu einem Gespräch gehört, älteste zuerst: Chat-Nachrichten und frühere Einzelnachrichten.
    function timeline(threadId) {
        const chat = rows.filter(row => row.thread_id === threadId).map(row => ({
            id: row.id, table: 'tt_chat', at: row.created_at, staff: row.from_staff, name: row.sender_name, mine: row.sender_id === profile.id,
            body: row.body, read: row.read_at, edited: Boolean(row.edited_at)
        }));
        const old = letters.filter(item => (item.recipient_ids || []).includes(threadId)).map(item => ({
            id: item.id, table: 'tt_messages', at: item.created_at, staff: true, name: item.sender_name, mine: item.sender_id === profile.id,
            body: item.body, read: letterReads.find(read => read.message_id === item.id && read.profile_id === threadId)?.read_at || null, edited: false
        }));
        return [...chat, ...old].sort((left, right) => new Date(left.at) - new Date(right.at));
    }
    const unreadOf = threadId => rows.filter(row => row.thread_id === threadId && !row.from_staff && !row.read_at).length;

    // ---------- Personen ----------
    function threads() {
        const ids = new Set(people.filter(person => person.active && person.role === 'dolmetscher').map(person => person.id));
        rows.forEach(row => ids.add(row.thread_id));
        return [...ids].map(id => {
            const person = people.find(item => item.id === id) || { id, full_name: 'Gelöschtes Konto', employment: '', active: false };
            const all = timeline(id);
            return { person, last: all[all.length - 1] || null, unread: unreadOf(id) };
        }).sort((left, right) => (right.unread > 0) - (left.unread > 0)
            || new Date(right.last?.at || 0) - new Date(left.last?.at || 0)
            || String(left.person.full_name).localeCompare(String(right.person.full_name), 'de'));
    }

    function renderPeople() {
        const list = threads().filter(item => !query || item.person.id === selected || fold(item.person.full_name).includes(fold(query)));
        const total = rows.filter(row => !row.from_staff && !row.read_at).length;
        $('chatSummary').textContent = total
            ? `${total} ungelesene ${total === 1 ? 'Nachricht' : 'Nachrichten'}. Person anklicken, lesen und antworten.`
            : 'Person anklicken und schreiben. Unter deinen Nachrichten steht, ob sie gelesen wurden.';
        const signature = JSON.stringify([selected, query, list.map(item => [item.person.id, item.person.full_name, item.last?.id, item.last?.body, item.unread])]);
        if (signature === shownPeople) return;
        shownPeople = signature;
        const box = $('chatPeople');
        if (!list.length) { box.replaceChildren(el('li', 'directory-empty', query ? 'Kein Name passt zur Suche.' : 'Es gibt noch keine freigeschalteten Dolmetscher-Konten.')); return; }
        box.replaceChildren(...list.map(item => {
            const entry = el('li');
            const button = el('button', 'chat-person');
            button.type = 'button';
            button.dataset.id = item.person.id;
            button.setAttribute('aria-pressed', String(item.person.id === selected));
            const head = el('span', 'chat-person-head');
            head.append(el('strong', '', item.person.full_name || '(ohne Namen)'));
            if (item.last) head.append(el('small', '', shortTime(item.last.at)));
            const line = el('span', 'chat-person-line');
            line.append(el('span', '', item.last ? `${item.last.staff ? 'Du: ' : ''}${String(item.last.body).replace(/\s+/g, ' ').slice(0, 70)}` : (item.person.employment === 'fest' ? 'fest angestellt' : item.person.employment || 'noch keine Nachricht')));
            if (item.unread) { const badge = el('b', 'chat-unread', String(item.unread)); badge.title = `${item.unread} ungelesen`; line.append(badge); }
            button.append(head, line);
            button.addEventListener('click', () => open(item.person.id));
            entry.append(button);
            return entry;
        }));
    }

    // ---------- Gespräch ----------
    function renderThread(force = false) {
        const grid = $('chatGrid');
        grid.dataset.open = String(Boolean(selected));
        const person = people.find(item => item.id === selected);
        $('chatEmpty').hidden = Boolean(selected);
        $('chatOfficeForm').hidden = !selected;
        $('chatWindowHead').hidden = !selected;
        if (!selected) { $('chatMessages').replaceChildren(); shownThread = ''; return; }
        $('chatWith').textContent = person?.full_name || 'Gelöschtes Konto';
        $('chatWithInfo').textContent = person ? [person.employment === 'fest' ? 'fest angestellt' : person.employment, person.active ? '' : 'Konto gesperrt'].filter(Boolean).join(' · ') : '';
        const items = timeline(selected);
        const signature = JSON.stringify([selected, items.map(item => [item.id, item.body, item.read || '', item.edited])]);
        if (!force && (signature === shownThread || editing)) return;
        shownThread = signature;
        const list = $('chatMessages');
        const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 80 || !list.children.length;
        let lastDay = '';
        const nodes = [];
        if (!items.length) nodes.push(el('li', 'chat-day', 'Noch keine Nachrichten – schreib die erste.'));
        items.forEach(item => {
            const day = dayLabel(item.at);
            if (day !== lastDay) { nodes.push(el('li', 'chat-day', day)); lastDay = day; }
            const row = el('li', `chat-row ${item.staff ? 'is-me' : 'is-them'}${!item.staff && !item.read ? ' is-new' : ''}`);
            row.dataset.id = item.id;
            const bubble = el('div', 'chat-bubble');
            if (!item.staff) bubble.append(el('span', 'chat-name', item.name || person?.full_name || 'Dolmetscher'));
            else if (!item.mine && item.name) bubble.append(el('span', 'chat-name', item.name));
            const text = el('p', '', item.body);
            bubble.append(text);
            const meta = el('span', 'chat-meta', `${clock(item.at)}${item.edited ? ' · bearbeitet' : ''}`);
            if (item.staff) {
                const tick = el('span', `chat-tick${item.read ? ' is-read' : ''}`, item.read ? `✓✓ gelesen ${dayLabel(item.read) === 'Heute' ? '' : `${shortTime(item.read)} `}${clock(item.read)}` : '✓ gesendet');
                tick.title = item.read ? `${person?.full_name || 'Die Person'} hat die Nachricht gesehen` : 'Gesendet – noch nicht gelesen';
                meta.append(tick);
            }
            bubble.append(meta);
            // Nachricht anklicken: Korrigieren (eigene Texte der Einsatzleitung) und Löschen.
            const actions = el('span', 'chat-actions');
            actions.hidden = true;
            if (item.staff) {
                const edit = el('button', 'button-quiet', 'Korrigieren');
                edit.type = 'button';
                edit.addEventListener('click', () => startEdit(item, row, text, actions));
                actions.append(edit);
            }
            const remove = el('button', 'button-quiet-danger', 'Löschen');
            remove.type = 'button';
            remove.addEventListener('click', () => removeItem(item));
            actions.append(remove);
            bubble.tabIndex = 0;
            bubble.setAttribute('role', 'button');
            bubble.setAttribute('aria-label', 'Nachricht – anklicken für Korrigieren und Löschen');
            const toggle = () => { if (editing) return; actions.hidden = !actions.hidden; };
            bubble.addEventListener('click', toggle);
            bubble.addEventListener('keydown', event => { if (event.target === bubble && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(); } });
            row.append(bubble, actions);
            nodes.push(row);
        });
        list.replaceChildren(...nodes);
        if (atBottom || force) list.scrollTop = list.scrollHeight;
    }

    function startEdit(item, row, text, actions) {
        if (editing) return;
        editing = item.id;
        const box = el('textarea', 'message-edit-box');
        box.value = item.body;
        box.maxLength = item.table === 'tt_chat' ? 2000 : 1000;
        box.rows = 3;
        box.setAttribute('aria-label', 'Text der Nachricht korrigieren');
        const save = el('button', 'button-primary', 'Speichern');
        const cancel = el('button', 'button-quiet', 'Abbrechen');
        save.type = 'button';
        cancel.type = 'button';
        const buttons = el('span', 'message-edit-actions');
        buttons.append(save, cancel);
        text.hidden = true;
        actions.hidden = true;
        text.after(box, buttons);
        box.addEventListener('click', event => event.stopPropagation());
        buttons.addEventListener('click', event => event.stopPropagation());
        box.focus();
        const close = () => { editing = ''; box.remove(); buttons.remove(); text.hidden = false; };
        cancel.addEventListener('click', close);
        save.addEventListener('click', async () => {
            const body = box.value.trim();
            if (!body) { showToast('Der Text darf nicht leer sein. Zum Entfernen nimm „Löschen“.', 'error'); return; }
            if (body === item.body) { close(); return; }
            save.disabled = true;
            const { error } = await client.from(item.table).update(item.table === 'tt_chat' ? { body, edited_at: new Date().toISOString() } : { body }).eq('id', item.id);
            save.disabled = false;
            if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
            close();
            showToast('Text korrigiert. Im Portal steht jetzt der neue Text.', 'success');
            await refresh(true);
        });
    }

    async function removeItem(item) {
        if (!await confirmDialog(`Diese Nachricht löschen?\n„${String(item.body).slice(0, 140)}“\n\nSie verschwindet dann auch im Portal.`, 'Löschen')) return;
        const { error } = await client.from(item.table).delete().eq('id', item.id);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        showToast('Nachricht gelöscht.', 'success');
        await refresh(true);
    }

    // „Gelesen“ melden, sobald das Gespräch wirklich offen und sichtbar ist.
    async function markRead() {
        if (!selected || document.hidden || !unreadOf(selected)) return;
        const { error } = await client.rpc('tt_chat_read', { p_thread: selected });
        if (error) return;
        const now = new Date().toISOString();
        rows.forEach(row => { if (row.thread_id === selected && !row.from_staff && !row.read_at) { row.read_at = now; row.read_by = profile.full_name || ''; } });
        renderPeople();
        window.refreshCloudInbox?.();
    }

    async function open(id) {
        if (editing) return;
        selected = id;
        shownPeople = '';
        renderPeople();
        renderThread(true);
        await markRead();
        if (window.matchMedia('(min-width: 861px)').matches) $('chatOfficeText').focus({ preventScroll: true });
    }
    $('chatBack').addEventListener('click', () => { selected = ''; shownPeople = ''; renderPeople(); renderThread(true); });
    $('chatPeopleSearch').addEventListener('input', () => { query = $('chatPeopleSearch').value.trim(); renderPeople(); });

    // ---------- Schreiben ----------
    const input = $('chatOfficeText');
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 150)}px`; };
    input.addEventListener('input', grow);
    // Am Computer sendet Enter; Umschalt + Enter macht eine neue Zeile.
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('chatOfficeForm').requestSubmit(); } });
    $('chatOfficeForm').addEventListener('submit', async event => {
        event.preventDefault();
        const body = input.value.trim();
        if (!body || !selected) { input.focus(); return; }
        const button = $('chatOfficeSend');
        button.disabled = true;
        const result = await send(selected, body);
        button.disabled = false;
        if (!result.ok) { showToast(result.message, 'error'); return; }
        input.value = '';
        grow();
        await refresh(true);
        input.focus({ preventScroll: true });
    });

    // Eine Nachricht in das Gespräch einer Person schreiben (die gemeinsame Funktion steht in cloudClient.js).
    const send = (threadId, body) => TerminCloud.sendChat(threadId, body);

    // ---------- Laden ----------
    let loading = false;
    async function refresh(full = false) {
        if (loading) return;
        loading = true;
        try {
            if (!profile || full) {
                try { profile = await TerminCloud.getProfile(); } catch (error) { return; }
                if (!TerminCloud.isStaff(profile)) { $('chatOffice').hidden = true; return; }
                const [peopleResult, letterResult, readResult] = await Promise.all([
                    client.from('tt_profiles').select('*').order('full_name'),
                    client.from('tt_messages').select('*').eq('audience', 'einzeln').order('created_at', { ascending: false }).limit(300),
                    client.from('tt_message_reads').select('*')
                ]);
                people = peopleResult.data || [];
                letters = letterResult.error ? [] : letterResult.data;
                letterReads = readResult.error ? [] : readResult.data;
            }
            const { data, error } = await client.from('tt_chat').select('*').order('created_at', { ascending: false }).limit(2000);
            if (error) {
                $('chatOffice').hidden = false;
                $('chatGrid').hidden = true;
                $('chatSummary').textContent = missing(error) ? 'Der Chat ist in der Datenbank noch nicht eingerichtet. Bitte supabase/update-21.sql im SQL Editor ausführen.' : TerminCloud.germanError(error);
                return;
            }
            rows = data || [];
            $('chatOffice').hidden = false;
            $('chatGrid').hidden = false;
            // Neue Nachricht in einem anderen Gespräch: kurze Einblendung mit „Öffnen“.
            const counts = new Map();
            rows.forEach(row => { if (!row.from_staff && !row.read_at) counts.set(row.thread_id, (counts.get(row.thread_id) || 0) + 1); });
            if (knownUnread) {
                counts.forEach((count, threadId) => {
                    if (count > (knownUnread.get(threadId) || 0) && threadId !== selected) {
                        const name = people.find(person => person.id === threadId)?.full_name || 'einem Dolmetscher';
                        showToast(`Neue Nachricht von ${name}`, 'info', { actionLabel: 'Öffnen', onAction: () => open(threadId), duration: 12000 });
                    }
                });
            }
            knownUnread = counts;
            renderPeople();
            renderThread();
            await markRead();
        } finally {
            loading = false;
        }
    }

    window.ChatOffice = { open, send, refresh: () => refresh(true) };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
    window.setInterval(() => { if (!document.hidden) refresh(); }, POLL_MS);
    $('messageReload')?.addEventListener('click', () => refresh(true));

    // Direkter Sprung: nachrichten.html?an=<Konto> öffnet das Gespräch mit dieser Person.
    refresh(true).then(() => {
        const wanted = new URLSearchParams(location.search).get('an');
        if (!wanted) return;
        history.replaceState(null, '', location.pathname);
        if (people.some(person => person.id === wanted)) { open(wanted); $('chatOffice').scrollIntoView({ block: 'start' }); }
    });
})();
