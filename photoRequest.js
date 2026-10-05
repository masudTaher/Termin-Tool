// Einsatzleitung · „Foto neu anfordern“: Ist ein Foto unscharf, zu dunkel oder unvollständig, bittet die
// Einsatzleitung die Person um ein neues. Die Person bekommt eine Mitteilung aufs Handy und sieht im Portal
// ganz oben das bisherige Foto mit dem Hinweis. Das neue Foto landet direkt beim Schaden, bei der Meldung,
// beim Beleg – oder als neu fotografierte Unterlage in der Patientenakte.
// Braucht supabase/update-14.sql. Seiten: Fuhrpark, Patienten, Abrechnung, Festangestellte.
window.PhotoRequest = (function () {
    const client = TerminCloud.client;
    const REASONS = {
        schaden: ['Das Foto ist unscharf.', 'Das Foto ist zu dunkel.', 'Der Schaden ist nicht zu erkennen.', 'Bitte näher heran.', 'Bitte das ganze Bauteil zeigen.'],
        meldung: ['Das Foto ist unscharf.', 'Das Foto ist zu dunkel.', 'Die Anzeige ist nicht lesbar.', 'Bitte das ganze Display zeigen.'],
        beleg: ['Der Betrag ist nicht lesbar.', 'Das Datum ist nicht lesbar.', 'Der Beleg ist abgeschnitten.', 'Das Foto ist unscharf.'],
        unterlage: ['Es fehlt eine Seite.', 'Der Text ist nicht lesbar.', 'Das Foto ist zu dunkel.', 'Das Blatt ist abgeschnitten.', 'Das ist die falsche Unterlage.']
    };
    const CLOSING = { schaden: 'Bitte nimm ein neues Foto auf.', meldung: 'Bitte nimm ein neues Foto auf.', beleg: 'Bitte fotografiere den Beleg noch einmal.', unterlage: 'Bitte fotografiere die Unterlage noch einmal vollständig.' };
    let requests = [];        // alle Bitten der letzten Zeit (für Schildchen und „Darum musst du dich kümmern“)
    let ready = true;         // false: Tabelle fehlt noch (Update 14)
    let dialog = null;

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };

    async function load() {
        const since = new Date(Date.now() - 45 * 86400000).toISOString();
        const { data, error } = await client.from('tt_requests').select('*').gte('created_at', since).order('created_at', { ascending: false }).limit(500);
        ready = !error;
        requests = error ? [] : data;
        return requests;
    }

    // Stand zu einem Schaden, einer Meldung, einem Beleg oder einer Unterlage
    const openFor = refId => requests.find(item => item.ref_id === refId && item.status === 'offen') || null;
    const answeredFor = refId => requests.find(item => item.ref_id === refId && item.status === 'erledigt' && !item.seen_at) || null;
    const unseen = () => requests.filter(item => item.status === 'erledigt' && !item.seen_at);
    const waiting = () => requests.filter(item => item.status === 'offen');

    // Schildchen für die Zeile: „Neues Foto angefordert“ (wartet) oder „Neues Foto da“ (Antwort noch nicht gesehen)
    function pill(refId) {
        const answered = answeredFor(refId);
        const open = openFor(refId);
        if (!answered && !open) return null;
        const node = el('span', 'status-pill request-pill', answered ? 'Neues Foto da' : 'Neues Foto angefordert');
        node.dataset.status = answered ? 'erledigt' : 'in Arbeit';
        node.title = answered ? `Geschickt von ${answered.profile_name}${answered.answer_note ? ` – „${answered.answer_note}“` : ''}` : `Angefordert bei ${open.profile_name}: ${open.message}`;
        return node;
    }

    async function markSeen(request) {
        const { error } = await client.from('tt_requests').update({ seen_at: new Date().toISOString() }).eq('id', request.id);
        if (!error) request.seen_at = new Date().toISOString();
        return error || null;
    }

    async function withdraw(request) {
        const { error } = await client.from('tt_requests').update({ status: 'zurückgezogen' }).eq('id', request.id);
        if (!error) request.status = 'zurückgezogen';
        return error || null;
    }

    function buildDialog() {
        dialog = el('dialog', 'confirm-dialog request-dialog');
        dialog.setAttribute('aria-labelledby', 'requestDialogTitle');
        dialog.innerHTML = `
            <form class="fleet-form" novalidate>
               <h2 id="requestDialogTitle">Neues Foto anfordern</h2>
               <p class="field-hint" data-part="who"></p>
               <span class="field-label" id="requestReasonLabel">Was stimmt nicht?</span>
               <div class="board-chips request-reasons" role="group" aria-labelledby="requestReasonLabel" data-part="reasons"></div>
               <label for="requestDialogMessage">Nachricht an die Person</label>
               <textarea id="requestDialogMessage" rows="3" maxlength="400"></textarea>
               <p class="field-hint">Die Person bekommt eine Mitteilung aufs Handy und sieht im Portal ganz oben das bisherige Foto mit deinem Hinweis.</p>
               <div class="modal-buttons"><button type="button" class="button-secondary" data-part="cancel">Abbrechen</button><button type="submit" class="button-primary" data-part="submit">Anfordern</button></div>
            </form>`;
        document.body.append(dialog);
        dialog.querySelector('[data-part=cancel]').addEventListener('click', () => dialog.close('cancel'));
    }

    // options: { kind, refId, profileId, profileName, title, bucket, paths, picked: [Gründe], context }
    // Ergebnis: true, wenn die Bitte angelegt wurde.
    function ask(options) {
        if (!dialog) buildDialog();
        const part = name => dialog.querySelector(`[data-part=${name}]`);
        const message = dialog.querySelector('#requestDialogMessage');
        const isDocument = options.kind === 'unterlage';
        dialog.querySelector('#requestDialogTitle').textContent = isDocument ? 'Unterlage neu anfordern' : 'Neues Foto anfordern';
        part('who').textContent = `An ${options.profileName || 'die Person'} · ${options.title || ''}`;
        const chosen = new Set((options.picked || []).filter(Boolean));
        let touched = false;      // hat die Einsatzleitung den Text selbst geändert? Dann bleibt er stehen.
        const compose = () => { if (!touched) message.value = [...chosen, CLOSING[options.kind]].join(' '); };
        const reasons = [...new Set([...(options.picked || []).filter(Boolean), ...(REASONS[options.kind] || [])])];
        part('reasons').replaceChildren(...reasons.map(text => {
            const chip = el('button', 'board-chip', text.replace(/\.$/, ''));
            chip.type = 'button';
            chip.setAttribute('aria-pressed', String(chosen.has(text)));
            chip.addEventListener('click', () => {
                if (chosen.has(text)) chosen.delete(text); else chosen.add(text);
                chip.setAttribute('aria-pressed', String(chosen.has(text)));
                compose();
            });
            return chip;
        }));
        message.oninput = () => { touched = true; };
        compose();
        const form = dialog.querySelector('form');
        const submit = part('submit');
        submit.disabled = false;
        return new Promise(resolve => {
            let done = false;
            form.onsubmit = async event => {
                event.preventDefault();
                const text = message.value.trim();
                if (!text) { showToast('Bitte schreib kurz, was am Foto nicht stimmt.', 'error', { target: message }); return; }
                submit.disabled = true;
                const profile = await TerminCloud.getProfile().catch(() => null);
                const existing = openFor(options.refId);
                const row = {
                    created_by: profile?.id || null, created_by_name: profile?.full_name || '', profile_id: options.profileId, profile_name: options.profileName || '',
                    kind: options.kind, ref_id: options.refId, title: String(options.title || '').slice(0, 200), message: text,
                    photo_bucket: options.bucket || 'schaeden', photo_paths: (options.paths || []).filter(Boolean).slice(0, 6), context: options.context || {}
                };
                // Läuft zu diesem Eintrag schon eine Bitte, wird sie mit dem neuen Hinweis aktualisiert (keine doppelten Bitten).
                const result = existing
                    ? await client.from('tt_requests').update({ message: text, photo_paths: row.photo_paths, context: row.context, created_at: new Date().toISOString() }).eq('id', existing.id).select()
                    : await client.from('tt_requests').insert(row).select();
                if (result.error || !result.data?.length) {
                    submit.disabled = false;
                    showToast(result.error && /tt_requests|schema cache|does not exist/i.test(result.error.message || '')
                        ? 'Dafür fehlt noch das Datenbank-Update 14 (supabase/update-14.sql).'
                        : result.error ? TerminCloud.germanError(result.error) : 'Die Bitte konnte nicht gespeichert werden.', 'error');
                    return;
                }
                requests = [result.data[0], ...requests.filter(item => item.id !== result.data[0].id)];
                done = true;
                dialog.close('sent');
                const push = await TerminCloud.callFunction({ action: 'notify', audience: 'einzeln', recipientIds: [options.profileId], page: 'rueckfragen',
                    title: isDocument ? 'Bitte neu fotografieren' : 'Bitte neues Foto', body: `${options.title ? `${options.title}: ` : ''}${text}`.slice(0, 300) });
                showToast(push.ok && push.data?.sent
                    ? `Bitte an ${options.profileName} gesendet – mit Mitteilung aufs Handy.`
                    : `Bitte an ${options.profileName} gespeichert. Sie steht im Portal ganz oben (Mitteilungen aufs Handy sind dort nicht eingeschaltet).`, 'success');
                resolve(true);
            };
            dialog.onclose = () => { if (!done) resolve(false); };
            dialog.showModal();
            message.focus();
        });
    }

    // Knopf für eine Zeile. onDone wird nach dem Anfordern aufgerufen (z. B. Liste neu zeichnen).
    function button(options, onDone) {
        const open = openFor(options.refId);
        const node = el('button', 'button-quiet request-button', open ? 'Erneut anfordern' : (options.kind === 'unterlage' ? 'Neu anfordern' : 'Foto neu anfordern'));
        node.type = 'button';
        node.title = open ? `Angefordert bei ${open.profile_name} am ${new Date(open.created_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}: ${open.message}` : 'Die Person um ein neues Foto bitten';
        node.addEventListener('click', async () => { if (await ask(options)) onDone?.(); });
        return node;
    }

    return { load, ask, button, pill, openFor, answeredFor, unseen, waiting, markSeen, withdraw, isReady: () => ready, all: () => requests };
})();
