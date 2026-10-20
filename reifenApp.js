// Reifenwechsel-Liste für die Werkstatt (ATU): reifen.html?k=<Schlüssel>. Ohne Anmeldung – der Schlüssel im Link ist der Zugang.
// Die Werkstatt sieht Kennzeichen, Modell und Kilometerstand der Fahrzeuge auf der Liste und hakt ab, was fertig ist (mit Name und
// Bemerkung). Die Einsatzleitung sieht denselben Stand im Fuhrpark. Daten: tt_tyre_list / tt_tyre_mark (supabase/update-39.sql).
(function () {
    const $ = id => document.getElementById(id);
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const client = typeof TerminCloud === 'undefined' ? null : TerminCloud.client;
    const token = new URLSearchParams(location.search).get('k') || '';
    const when = iso => new Date(iso).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '') + ' Uhr';
    const km = value => value == null ? '' : `${Number(value).toLocaleString('de-DE')} km`;
    let data = null;
    let busy = false;
    let pending = null;   // Fahrzeug, das gerade abgehakt wird

    function status(text, kind = 'info') {
        const box = $('tyreStatus');
        box.hidden = !text;
        box.textContent = text || '';
        box.dataset.kind = kind;
    }
    const whoName = () => $('tyreWho').value.trim();
    try { $('tyreWho').value = localStorage.getItem('tyre.who') || ''; } catch (error) { /* ohne Speicher */ }
    $('tyreWho').addEventListener('change', () => { try { localStorage.setItem('tyre.who', whoName()); } catch (error) { /* ohne Speicher */ } });

    function render() {
        if (!data) return;
        const items = data.items || [];
        const done = items.filter(item => item.done).length;
        $('tyreTitle').textContent = data.title || 'Reifenwechsel';
        $('tyreSub').textContent = `${items.length} ${items.length === 1 ? 'Fahrzeug' : 'Fahrzeuge'} · Liste vom ${new Date(data.created_at).toLocaleDateString('de-DE')}${data.created_by ? ` · ${data.created_by}` : ''}`;
        const TYRES = { sommer: 'Sommerreifen', winter: 'Winterreifen', ganzjahr: 'Ganzjahresreifen' };
        const target = data.tyres_to ? `Nach dem Wechsel: ${TYRES[data.tyres_to] || data.tyres_to}.` : '';
        $('tyreNote').hidden = !data.note && !target;
        $('tyreNote').textContent = [target, data.note || ''].filter(Boolean).join(' ');
        $('tyreProgress').hidden = !items.length;
        $('tyreBar').style.width = `${items.length ? Math.round(done / items.length * 100) : 0}%`;
        $('tyreProgressText').textContent = done === items.length && items.length ? 'Alle Fahrzeuge erledigt – danke!' : `${done} von ${items.length} erledigt · ${items.length - done} offen`;
        document.title = `${done}/${items.length} · Reifenwechsel · Medical Office Bonn`;
        $('tyreList').replaceChildren(...items.map(item => {
            const row = el('li', 'tyre-item');
            row.dataset.id = item.id;
            row.dataset.done = item.done ? 'ja' : '';
            const main = el('div', 'tyre-main');
            main.append(el('strong', 'tyre-plate', item.plate || '–'), el('span', 'tyre-model', [item.vehicle, item.vehicle_type, km(item.mileage)].filter(Boolean).join(' · ')));
            if (item.extra) main.append(el('span', 'tyre-item-extra', `Bitte außerdem: ${item.extra}`));
            if (item.done) main.append(el('span', 'tyre-done-text', `Erledigt ${when(item.done_at)}${item.done_by ? ` · ${item.done_by}` : ''}`));
            if (item.note) main.append(el('span', 'tyre-item-note', `„${item.note}“`));
            const side = el('div', 'tyre-side');
            if (item.done) {
                const undo = el('button', 'tyre-button tyre-button-quiet tyre-undo', 'Doch nicht fertig');
                undo.type = 'button';
                undo.addEventListener('click', () => mark(item, false, undo));
                side.append(el('span', 'tyre-check', '✓'), undo);
            } else {
                const ok = el('button', 'tyre-button tyre-button-main tyre-ok', 'Erledigt');
                ok.type = 'button';
                ok.addEventListener('click', () => openDone(item));
                side.append(ok);
            }
            row.append(main, side);
            return row;
        }));
    }

    const invalid = error => /nicht \(mehr\) gültig/.test(error?.message || '');
    const missing = error => /could not find the function|schema cache|does not exist/i.test(error?.message || '');
    async function load(quiet = false) {
        if (!client) { status('Die Verbindung zur Datenbank konnte nicht geladen werden. Bitte das Internet prüfen und die Seite neu laden.', 'error'); return; }
        if (!token) { $('tyreSub').textContent = ''; status('Dieser Link ist unvollständig. Bitte den Link aus der Nachricht der Einsatzleitung genau so öffnen.', 'error'); return; }
        if (busy) return;
        busy = true;
        try {
            const { data: result, error } = await client.rpc('tt_tyre_list', { p_token: token });
            if (error) {
                $('tyreSub').textContent = '';
                status(invalid(error) ? 'Dieser Link ist nicht mehr gültig – die Liste wurde geschlossen oder der Link ist falsch. Bitte bei der Einsatzleitung nachfragen.' : missing(error) ? 'Die Liste ist in der Datenbank noch nicht eingerichtet (Update 39 fehlt).' : `Keine Verbindung: ${TerminCloud.germanError(error)}`, 'error');
                return;
            }
            data = result;
            if (!quiet) status('');
            render();
        } finally { busy = false; }
    }

    function openDone(item) {
        if (!whoName()) { status('Bitte zuerst unten deinen Namen eintragen – dann steht er beim Abhaken dabei.', 'info'); $('tyreWho').focus(); return; }
        pending = item;
        $('tyreDoneTitle').textContent = `${item.plate} · ${item.vehicle}`;
        $('tyreDoneNote').value = item.note || '';
        $('tyreDone').showModal();
    }
    $('tyreDoneCancel').addEventListener('click', () => $('tyreDone').close());
    $('tyreDoneForm').addEventListener('submit', event => {
        event.preventDefault();
        const item = pending;
        $('tyreDone').close();
        if (item) mark(item, true, null, $('tyreDoneNote').value.trim());
    });

    async function mark(item, done, button, note = null) {
        if (button) button.disabled = true;
        const { data: row, error } = await client.rpc('tt_tyre_mark', { p_token: token, p_item: item.id, p_done: done, p_by: whoName(), p_note: note });
        if (button) button.disabled = false;
        if (error) { status(invalid(error) ? 'Dieser Link ist nicht mehr gültig – die Liste wurde geschlossen.' : TerminCloud.germanError(error), 'error'); await load(true); return; }
        const index = (data.items || []).findIndex(entry => entry.id === item.id);
        if (index >= 0) data.items[index] = row;
        status(done ? `${row.plate} ist als erledigt eingetragen.` : `${row.plate} steht wieder als offen.`, 'success');
        render();
    }

    $('tyreRefresh').addEventListener('click', () => load());
    window.setInterval(() => { if (!document.hidden) load(true); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
    window.ReifenApp = { state: () => data, load };
    load();
})();
