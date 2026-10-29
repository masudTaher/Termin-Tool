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
            const checks = checkChips(item.checks);
            if (checks) main.append(checks);
            const side = el('div', 'tyre-side');
            if (item.done) {
                const edit = el('button', 'tyre-button tyre-button-quiet tyre-edit', 'Angaben ändern');
                edit.type = 'button';
                edit.addEventListener('click', () => openDone(item));
                const undo = el('button', 'tyre-button tyre-button-quiet tyre-undo', 'Doch nicht fertig');
                undo.type = 'button';
                undo.addEventListener('click', () => mark(item, false, undo));
                side.append(el('span', 'tyre-check', '✓'), edit, undo);
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

    // Prüfpunkte der Werkstatt (Update 52): AdBlue, Wischwasser, Check-up, Bremsen
    const CHECK_WORDS = [['adblue', 'AdBlue nachgefüllt'], ['wischwasser', 'Wischwasser nachgefüllt'], ['checkup', 'Check-up gemacht']];
    function checkChips(checks) {
        if (!checks || typeof checks !== 'object') return null;
        const chips = [];
        CHECK_WORDS.forEach(([key, word]) => { if (checks[key]) chips.push(el('span', 'tyre-chip is-ok', `✓ ${word}`)); });
        if (checks.bremsen === 'ok') chips.push(el('span', 'tyre-chip is-ok', '✓ Bremsen in Ordnung'));
        if (checks.bremsen === 'wechsel') chips.push(el('span', 'tyre-chip is-bad', '⚠ Bremsen: Wechsel nötig'));
        if (!chips.length) return null;
        const box = el('span', 'tyre-chips');
        box.append(...chips);
        return box;
    }
    const readChecks = () => ({ adblue: $('tyreChkAdblue').checked, wischwasser: $('tyreChkWasser').checked, checkup: $('tyreChkCheckup').checked, bremsen: document.querySelector('input[name=tyreChkBremsen]:checked')?.value || '' });
    function fillChecks(checks) {
        const value = checks && typeof checks === 'object' ? checks : {};
        $('tyreChkAdblue').checked = Boolean(value.adblue);
        $('tyreChkWasser').checked = Boolean(value.wischwasser);
        $('tyreChkCheckup').checked = Boolean(value.checkup);
        const brakes = ['ok', 'wechsel'].includes(value.bremsen) ? value.bremsen : '';
        document.querySelectorAll('input[name=tyreChkBremsen]').forEach(input => { input.checked = input.value === brakes; });
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
        fillChecks(item.checks);
        $('tyreDoneOk').textContent = item.done ? 'Angaben speichern' : 'Als erledigt markieren';
        $('tyreDone').showModal();
    }
    $('tyreDoneCancel').addEventListener('click', () => $('tyreDone').close());
    $('tyreDoneForm').addEventListener('submit', event => {
        event.preventDefault();
        const item = pending;
        $('tyreDone').close();
        if (item) mark(item, true, null, $('tyreDoneNote').value.trim(), readChecks());
    });

    async function mark(item, done, button, note = null, checks = null) {
        if (button) button.disabled = true;
        let { data: row, error } = await client.rpc('tt_tyre_mark', { p_token: token, p_item: item.id, p_done: done, p_by: whoName(), p_note: note, ...(checks ? { p_checks: checks } : {}) });
        // Ohne Update 52 kennt die Datenbank die Prüfpunkte noch nicht – dann wenigstens abhaken und Bemerkung speichern.
        let dropped = false;
        if (error && checks && missing(error)) { dropped = true; ({ data: row, error } = await client.rpc('tt_tyre_mark', { p_token: token, p_item: item.id, p_done: done, p_by: whoName(), p_note: note })); }
        if (button) button.disabled = false;
        if (error) { status(invalid(error) ? 'Dieser Link ist nicht mehr gültig – die Liste wurde geschlossen.' : TerminCloud.germanError(error), 'error'); await load(true); return; }
        const index = (data.items || []).findIndex(entry => entry.id === item.id);
        if (index >= 0) data.items[index] = row;
        const anyCheck = checks && (checks.adblue || checks.wischwasser || checks.checkup || checks.bremsen);
        status(dropped && anyCheck ? `${row.plate} ist eingetragen – die Prüfpunkte konnten noch nicht gespeichert werden (Update 52 fehlt). Bitte in die Bemerkung schreiben.` : done ? (item.done ? `${row.plate}: Angaben gespeichert.` : `${row.plate} ist als erledigt eingetragen.${checks?.bremsen === 'wechsel' ? ' Die Einsatzleitung sieht die Meldung zu den Bremsen.' : ''}`) : `${row.plate} steht wieder als offen.`, dropped && anyCheck ? 'error' : 'success');
        render();
    }

    $('tyreRefresh').addEventListener('click', () => load());
    window.setInterval(() => { if (!document.hidden) load(true); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
    window.ReifenApp = { state: () => data, load };
    load();
})();
