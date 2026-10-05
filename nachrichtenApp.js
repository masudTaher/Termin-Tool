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

    // Bei vielen Personen hilft die Suche; schon Gewählte bleiben immer sichtbar.
    let recipientQuery = '';
    const foldName = text => String(text ?? '').toLocaleLowerCase('de-DE').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    function renderRecipients() {
        const list = $('recipientList');
        const all = people.filter(person => person.active && person.id !== profile.id);
        $('recipientSearch').hidden = all.length < 13;
        list.replaceChildren(...all.filter(person => !recipientQuery || picked.has(person.id) || foldName(person.full_name).includes(foldName(recipientQuery))).map(person => {
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
        if (!list.children.length) list.append(el('p', 'directory-empty', all.length ? 'Kein Name passt zur Suche.' : 'Es gibt noch keine freigeschalteten Dolmetscher-Konten.'));
    }
    $('recipientSearch').addEventListener('input', () => { recipientQuery = $('recipientSearch').value.trim(); renderRecipients(); });

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
        // Direkter Sprung aus der Dolmetscher-Übersicht: nachrichten.html?an=<Konto> wählt die Person schon aus.
        const wanted = new URLSearchParams(location.search).get('an');
        if (wanted) {
            history.replaceState(null, '', location.pathname);
            if (people.some(person => person.id === wanted && person.active && person.id !== profile.id)) {
                picked.clear();
                picked.add(wanted);
                document.querySelector('input[name="audience"][value="einzeln"]').checked = true;
                window.setTimeout(() => $('messageBody').focus(), 60);
            }
        }
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
            // Tippfehler? Der Text lässt sich direkt in der Liste korrigieren; im Portal steht danach der neue Text.
            const edit = el('button', 'button-quiet', 'Korrigieren');
            edit.type = 'button';
            edit.addEventListener('click', () => {
                if (item.classList.contains('is-editing')) return;
                item.classList.add('is-editing');
                const shown = meta.querySelector('.message-entry-body');
                const box = el('textarea', 'message-edit-box');
                box.value = message.body;
                box.maxLength = 1000;
                box.rows = 4;
                box.setAttribute('aria-label', 'Text der Nachricht korrigieren');
                const save = el('button', 'button-primary', 'Speichern');
                const cancel = el('button', 'button-quiet', 'Abbrechen');
                save.type = 'button';
                cancel.type = 'button';
                const row = el('span', 'message-edit-actions');
                row.append(save, cancel);
                shown.hidden = true;
                shown.after(box, row);
                box.focus();
                const close = () => { box.remove(); row.remove(); shown.hidden = false; item.classList.remove('is-editing'); };
                cancel.addEventListener('click', close);
                save.addEventListener('click', async () => {
                    const text = box.value.trim();
                    if (!text) { showToast('Der Text darf nicht leer sein. Zum Entfernen nimm „Löschen“.', 'error'); return; }
                    if (text === message.body) { close(); return; }
                    save.disabled = true;
                    const { error } = await client.from('tt_messages').update({ body: text }).eq('id', message.id);
                    save.disabled = false;
                    if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                    showToast('Text korrigiert. Im Portal steht jetzt der neue Text.', 'success');
                    refresh();
                });
            });
            actions.append(edit);
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
