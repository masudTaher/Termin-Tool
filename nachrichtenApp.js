// Nachrichten der Einsatzleitung an die Dolmetscher: an alle, an eine Gruppe oder an Einzelne.
// Die Nachricht steht im Portal unter der Glocke; zusätzlich geht eine Mitteilung aufs Handy,
// wenn die Server-Funktion eingerichtet ist und die Person Mitteilungen eingeschaltet hat.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    let profile = null;
    let people = [];
    const picked = new Set();

    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const audienceValue = () => document.querySelector('input[name="audience"]:checked')?.value || 'alle';
    const AUDIENCE_LABEL = { alle: 'Alle', fest: 'Alle Festangestellten', 'temporär': 'Alle Temporären', einzeln: 'Einzelne' };

    function setStatus(message, kind = 'info') {
        const status = $('messageStatus');
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    // Wer bekommt die Nachricht? (Dolmetscher-Konten; die Einsatzleitung selbst zählt nicht mit.)
    function recipientsFor(audience, ids) {
        const interpreters = people.filter(person => person.active && person.id !== profile.id);
        if (audience === 'einzeln') return interpreters.filter(person => ids.includes(person.id));
        if (audience === 'fest' || audience === 'temporär') return interpreters.filter(person => person.role === 'dolmetscher' && person.employment === audience);
        return interpreters;
    }

    function renderAudience() {
        const audience = audienceValue();
        $('recipientBox').hidden = audience !== 'einzeln';
        const count = recipientsFor(audience, [...picked]).length;
        $('audienceInfo').textContent = audience === 'einzeln' && !count ? 'Noch niemand ausgewählt.' : `Geht an ${count} ${count === 1 ? 'Person' : 'Personen'}.`;
    }

    function renderRecipients() {
        const list = $('recipientList');
        list.replaceChildren(...people.filter(person => person.active && person.id !== profile.id).map(person => {
            const button = el('button', 'recipient-chip', person.full_name || '(ohne Namen)');
            button.type = 'button';
            button.setAttribute('aria-pressed', String(picked.has(person.id)));
            button.addEventListener('click', () => {
                if (picked.has(person.id)) picked.delete(person.id); else picked.add(person.id);
                button.setAttribute('aria-pressed', String(picked.has(person.id)));
                renderAudience();
            });
            return button;
        }));
        if (!list.children.length) list.append(el('p', 'directory-empty', 'Es gibt noch keine freigeschalteten Dolmetscher-Konten.'));
    }

    async function refresh() {
        setStatus('');
        if (!client) { setStatus('Die Verbindung zur Datenbank konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu.', 'error'); return; }
        try { profile = await TerminCloud.getProfile(true); } catch (error) { setStatus(error.message, 'error'); return; }
        if (!TerminCloud.isStaff(profile)) { $('messageApp').hidden = true; setStatus('Bitte melde dich zuerst auf der Seite „Team“ an.', 'error'); return; }
        const [peopleResult, messageResult, readResult] = await Promise.all([
            client.from('tt_profiles').select('*').order('full_name'),
            client.from('tt_messages').select('*').order('created_at', { ascending: false }).limit(60),
            client.from('tt_message_reads').select('*')
        ]);
        if (messageResult.error) { $('messageApp').hidden = true; setStatus(`${TerminCloud.germanError(messageResult.error)} Bitte supabase/update-8.sql im SQL Editor ausführen.`, 'error'); return; }
        people = peopleResult.data || [];
        $('messageApp').hidden = false;
        renderRecipients();
        renderAudience();
        renderSent(messageResult.data, readResult.error ? [] : readResult.data);
    }

    function renderSent(messages, reads) {
        $('sentSummary').textContent = messages.length ? `${messages.length} ${messages.length === 1 ? 'Nachricht' : 'Nachrichten'} · „gelesen“ zeigt, wer sie im Portal geöffnet hat` : 'Noch keine Nachricht gesendet.';
        const list = $('sentList');
        list.replaceChildren();
        messages.forEach(message => {
            const recipients = recipientsFor(message.audience, message.recipient_ids || []);
            const readBy = reads.filter(item => item.message_id === message.id).map(item => item.profile_id);
            const unreadNames = recipients.filter(person => !readBy.includes(person.id)).map(person => person.full_name);
            const item = el('li', 'vehicle-entry message-entry');
            const meta = el('span');
            const to = message.audience === 'einzeln' ? recipients.map(person => person.full_name).join(', ') || 'Einzelne' : AUDIENCE_LABEL[message.audience];
            meta.append(
                el('strong', null, `An: ${to}`),
                el('span', 'message-entry-body', message.body),
                el('small', null, `${new Date(message.created_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${message.sender_name || ''}`),
                el('small', unreadNames.length ? 'account-waiting' : 'vehicle-driver', recipients.length
                    ? `Gelesen von ${recipients.length - unreadNames.length} von ${recipients.length}${unreadNames.length && unreadNames.length <= 6 ? ` · noch nicht: ${unreadNames.join(', ')}` : ''}`
                    : 'Keine Empfänger')
            );
            const actions = el('span', 'vehicle-entry-actions');
            const remove = el('button', 'button-quiet-danger', 'Löschen');
            remove.type = 'button';
            remove.addEventListener('click', async () => {
                if (!await confirmDialog('Diese Nachricht löschen? Sie verschwindet dann auch im Portal der Dolmetscher.', 'Löschen')) return;
                const { error } = await client.from('tt_messages').delete().eq('id', message.id);
                if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                showToast('Nachricht gelöscht.', 'success');
                refresh();
            });
            actions.append(remove);
            item.append(meta, actions);
            list.append(item);
        });
    }

    document.querySelectorAll('input[name="audience"]').forEach(input => input.addEventListener('change', renderAudience));
    $('messageBody').addEventListener('input', () => { $('messageCount').textContent = `${$('messageBody').value.length} von 1000 Zeichen`; });

    $('messageForm').addEventListener('submit', async event => {
        event.preventDefault();
        const audience = audienceValue();
        const body = $('messageBody').value.trim();
        const ids = audience === 'einzeln' ? [...picked] : [];
        const recipients = recipientsFor(audience, ids);
        if (!body) return;
        if (!recipients.length) { showToast(audience === 'einzeln' ? 'Bitte wähle mindestens eine Person aus.' : 'Für diese Auswahl gibt es keine Empfänger.', 'error'); return; }
        const button = event.target.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            const { error } = await client.from('tt_messages').insert({ sender_id: profile.id, sender_name: profile.full_name || 'Einsatzleitung', audience, recipient_ids: ids, body });
            if (error) throw error;
            // Zusätzlich als Mitteilung aufs Handy – klappt nur, wenn die Server-Funktion eingerichtet ist.
            const push = await TerminCloud.callFunction({ action: 'notify', audience, recipientIds: ids, title: `Nachricht von ${profile.full_name || 'der Einsatzleitung'}`, body: body.slice(0, 200) });
            const pushText = !push.ok ? 'Im Portal sichtbar. Mitteilungen aufs Handy sind noch nicht eingerichtet.'
                : push.data.sent ? `Im Portal sichtbar und als Mitteilung auf ${push.data.sent} ${push.data.sent === 1 ? 'Handy' : 'Handys'} gesendet.`
                : 'Im Portal sichtbar. Noch niemand hat Mitteilungen aufs Handy eingeschaltet.';
            showToast(`Nachricht an ${recipients.length} ${recipients.length === 1 ? 'Person' : 'Personen'} gesendet. ${pushText}`, 'success', { duration: 9000 });
            event.target.reset();
            picked.clear();
            $('messageCount').textContent = '0 von 1000 Zeichen';
            await refresh();
        } catch (error) {
            showToast(TerminCloud.germanError(error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    $('messageReload').addEventListener('click', refresh);
    refresh();
})();
