// Reifenwechsel-Liste für die Werkstatt (ATU): reifen.html?k=<Schlüssel>. Ohne Anmeldung – der Schlüssel im Link ist der Zugang.
// Die Werkstatt sieht Kennzeichen, Modell und Kilometerstand der Fahrzeuge auf der Liste und hakt ab, was fertig ist (mit Name und
// Bemerkung). Die Einsatzleitung sieht denselben Stand im Fuhrpark. Daten: tt_tyre_list / tt_tyre_mark (supabase/update-39.sql).
// Update 53: drei Abschnitte je Fahrzeug – noch nicht bearbeitet → gerade in der Werkstatt (tt_tyre_shop) → fertig und zurückgebracht;
// Bremsen vorne/hinten, „wurden gewechselt“.
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

    // Wo steht das Fahrzeug? fertig (zurückgebracht) · werkstatt (gerade bei ATU) · offen (noch nicht bearbeitet)
    const stageOf = item => item.done ? 'fertig' : item.in_shop_at ? 'werkstatt' : 'offen';
    const STAGE_WORD = { offen: 'noch nicht bearbeitet', werkstatt: 'in der Werkstatt', fertig: 'fertig' };
    function render() {
        if (!data) return;
        const items = data.items || [];
        const count = { offen: 0, werkstatt: 0, fertig: 0 };
        items.forEach(item => { count[stageOf(item)] += 1; });
        const done = count.fertig;
        $('tyreTitle').textContent = data.title || 'Reifenwechsel';
        $('tyreSub').textContent = `${items.length} ${items.length === 1 ? 'Fahrzeug' : 'Fahrzeuge'} · Liste vom ${new Date(data.created_at).toLocaleDateString('de-DE')}${data.created_by ? ` · ${data.created_by}` : ''}`;
        const TYRES = { sommer: 'Sommerreifen', winter: 'Winterreifen', ganzjahr: 'Ganzjahresreifen' };
        const target = data.tyres_to ? `Nach dem Wechsel: ${TYRES[data.tyres_to] || data.tyres_to}.` : '';
        $('tyreNote').hidden = !data.note && !target;
        $('tyreNote').textContent = [target, data.note || ''].filter(Boolean).join(' ');
        $('tyreProgress').hidden = !items.length;
        $('tyreBar').style.width = `${items.length ? Math.round(done / items.length * 100) : 0}%`;
        $('tyreProgressText').textContent = done === items.length && items.length ? 'Alle Fahrzeuge fertig und zurückgebracht – danke!'
            : [`${done} fertig`, count.werkstatt ? `${count.werkstatt} in der Werkstatt` : '', `${count.offen} noch nicht bearbeitet`].filter(Boolean).join(' · ');
        document.title = `${done}/${items.length} · Reifenwechsel · Medical Office Bonn`;
        $('tyreTiles').hidden = !items.length;
        $('tyreCountOffen').textContent = String(count.offen);
        $('tyreCountWerkstatt').textContent = String(count.werkstatt);
        $('tyreCountFertig').textContent = String(count.fertig);
        document.querySelectorAll('.tyre-section').forEach(section => {
            const stage = section.dataset.stage;
            const list = items.filter(item => stageOf(item) === stage);
            section.hidden = !list.length;
            section.querySelector('[data-count]').textContent = String(list.length);
            section.querySelector('[data-list]').replaceChildren(...list.map(item => row(item, stage)));
        });
    }
    function row(item, stage) {
        const li = el('li', 'tyre-item');
        li.dataset.id = item.id;
        li.dataset.stage = stage;
        li.dataset.done = item.done ? 'ja' : '';
        const main = el('div', 'tyre-main');
        main.append(el('strong', 'tyre-plate', item.plate || '–'), el('span', 'tyre-model', [item.vehicle, item.vehicle_type, km(item.mileage)].filter(Boolean).join(' · ')));
        if (item.extra) main.append(el('span', 'tyre-item-extra', `Bitte außerdem: ${item.extra}`));
        if (stage === 'werkstatt') main.append(el('span', 'tyre-shop-text', `In der Werkstatt seit ${when(item.in_shop_at)}${item.in_shop_by ? ` · ${item.in_shop_by}` : ''}`));
        if (item.done) main.append(el('span', 'tyre-done-text', `Fertig und zurückgebracht ${when(item.done_at)}${item.done_by ? ` · ${item.done_by}` : ''}`));
        if (item.note) main.append(el('span', 'tyre-item-note', `„${item.note}“`));
        const checks = checkChips(item.checks);
        if (checks) main.append(checks);
        const side = el('div', 'tyre-side');
        const button = (className, text, handler) => { const node = el('button', `tyre-button ${className}`, text); node.type = 'button'; node.addEventListener('click', () => handler(node)); return node; };
        // R95: In jeder Stufe eine Bemerkung oder Prüfpunkte eintragen, ohne den Stand zu ändern („Reifen bestellt“, „Fahrzeug kam nicht“ …).
        if (stage !== 'fertig') side.append(button('tyre-button-quiet tyre-note', item.note ? 'Bemerkung ändern' : 'Bemerkung', () => openDone(item, { noteOnly: true })));
        if (stage === 'fertig') {
            side.append(el('span', 'tyre-check', '✓'), button('tyre-button-quiet tyre-edit', 'Angaben ändern', () => openDone(item)), button('tyre-button-quiet tyre-undo', 'Doch nicht fertig', node => mark(item, false, node)));
        } else if (stage === 'werkstatt') {
            side.append(button('tyre-button-main tyre-ok', 'Fertig – zurückgebracht', () => openDone(item)), button('tyre-button-quiet tyre-undo', 'Doch nicht bei uns', node => shop(item, false, node)));
        } else {
            side.append(button('tyre-button-shop tyre-ok', 'Ist jetzt bei uns', node => shop(item, true, node)), button('tyre-button-quiet', 'Gleich fertig melden', () => openDone(item)));
        }
        li.append(main, side);
        return li;
    }

    // Prüfpunkte der Werkstatt (Update 52): AdBlue, Wischwasser, Check-up, Bremsen
    const CHECK_WORDS = [['adblue', 'AdBlue nachgefüllt'], ['wischwasser', 'Wischwasser nachgefüllt'], ['checkup', 'Check-up gemacht']];
    function checkChips(checks) {
        if (!checks || typeof checks !== 'object') return null;
        const chips = [];
        CHECK_WORDS.forEach(([key, word]) => { if (checks[key]) chips.push(el('span', 'tyre-chip is-ok', `✓ ${word}`)); });
        const axle = checks.bremsen_vorne && checks.bremsen_hinten ? ' vorne und hinten' : checks.bremsen_vorne ? ' vorne' : checks.bremsen_hinten ? ' hinten' : '';
        if (checks.bremsen === 'ok') chips.push(el('span', 'tyre-chip is-ok', '✓ Bremsen in Ordnung'));
        if (checks.bremsen === 'wechsel') chips.push(el('span', 'tyre-chip is-bad', `⚠ Bremsen${axle}: Wechsel nötig`));
        if (checks.bremsen === 'gewechselt') chips.push(el('span', 'tyre-chip is-ok', `✓ Bremsen${axle} gewechselt`));
        if (!chips.length) return null;
        const box = el('span', 'tyre-chips');
        box.append(...chips);
        return box;
    }
    const brakeChoice = () => document.querySelector('input[name=tyreChkBremsen]:checked')?.value || '';
    const needsAxle = value => value === 'wechsel' || value === 'gewechselt';
    const readChecks = () => ({ adblue: $('tyreChkAdblue').checked, wischwasser: $('tyreChkWasser').checked, checkup: $('tyreChkCheckup').checked, bremsen: brakeChoice(),
        bremsen_vorne: needsAxle(brakeChoice()) && $('tyreChkBremsenVorne').checked, bremsen_hinten: needsAxle(brakeChoice()) && $('tyreChkBremsenHinten').checked });
    function fillChecks(checks) {
        const value = checks && typeof checks === 'object' ? checks : {};
        $('tyreChkAdblue').checked = Boolean(value.adblue);
        $('tyreChkWasser').checked = Boolean(value.wischwasser);
        $('tyreChkCheckup').checked = Boolean(value.checkup);
        const brakes = ['ok', 'wechsel', 'gewechselt'].includes(value.bremsen) ? value.bremsen : '';
        document.querySelectorAll('input[name=tyreChkBremsen]').forEach(input => { input.checked = input.value === brakes; });
        $('tyreChkBremsenVorne').checked = Boolean(value.bremsen_vorne);
        $('tyreChkBremsenHinten').checked = Boolean(value.bremsen_hinten);
        $('tyreBrakesWhere').hidden = !needsAxle(brakes);
    }
    document.querySelectorAll('input[name=tyreChkBremsen]').forEach(input => input.addEventListener('change', () => { $('tyreBrakesWhere').hidden = !needsAxle(brakeChoice()); }));
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

    let noteOnly = false;
    function openDone(item, options = {}) {
        if (!whoName()) { status('Bitte zuerst unten deinen Namen eintragen – dann steht er beim Abhaken dabei.', 'info'); $('tyreWho').focus(); return; }
        pending = item;
        noteOnly = Boolean(options.noteOnly);
        $('tyreDoneTitle').textContent = `${item.plate} · ${item.vehicle}${noteOnly ? ' – Bemerkung' : ''}`;
        $('tyreDoneNote').value = item.note || '';
        fillChecks(item.checks);
        $('tyreDoneOk').textContent = noteOnly ? 'Speichern' : item.done ? 'Angaben speichern' : 'Fertig – zurückgebracht';
        $('tyreDone').showModal();
        if (noteOnly) $('tyreDoneNote').focus();
    }
    $('tyreDoneCancel').addEventListener('click', () => $('tyreDone').close());
    $('tyreDoneForm').addEventListener('submit', event => {
        event.preventDefault();
        const item = pending;
        const checks = readChecks();
        if (needsAxle(checks.bremsen) && !checks.bremsen_vorne && !checks.bremsen_hinten) { $('tyreBrakesWhere').hidden = false; $('tyreChkBremsenVorne').focus(); status('Bitte bei den Bremsen noch „vorne“ und/oder „hinten“ ankreuzen.', 'info'); return; }
        $('tyreDone').close();
        if (item) mark(item, noteOnly ? Boolean(item.done) : true, null, $('tyreDoneNote').value.trim(), checks, noteOnly);
    });

    async function mark(item, done, button, note = null, checks = null, onlyNote = false) {
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
        status(dropped && anyCheck ? `${row.plate} ist eingetragen – die Prüfpunkte konnten noch nicht gespeichert werden (Update 52 fehlt). Bitte in die Bemerkung schreiben.` : onlyNote ? `${row.plate}: Bemerkung und Prüfpunkte gespeichert.` : done ? (item.done ? `${row.plate}: Angaben gespeichert.` : `${row.plate} ist als fertig und zurückgebracht eingetragen.${checks?.bremsen === 'wechsel' ? ' Die Einsatzleitung sieht die Meldung zu den Bremsen.' : ''}`) : `${row.plate} steht wieder als ${row.in_shop_at ? 'in der Werkstatt' : 'noch nicht bearbeitet'}.`, dropped && anyCheck ? 'error' : 'success');
        render();
    }

    // „Ist jetzt bei uns“ / „Doch nicht bei uns“ (Update 53): das Büro sieht das Fahrzeug dann als „Bei ATU / Werkstatt“.
    async function shop(item, inShop, button) {
        if (inShop && !whoName()) { status('Bitte zuerst unten deinen Namen eintragen – dann steht er dabei.', 'info'); $('tyreWho').focus(); return; }
        if (button) button.disabled = true;
        const { data: row, error } = await client.rpc('tt_tyre_shop', { p_token: token, p_item: item.id, p_in: inShop, p_by: whoName() });
        if (button) button.disabled = false;
        if (error) { status(invalid(error) ? 'Dieser Link ist nicht mehr gültig – die Liste wurde geschlossen.' : missing(error) ? 'Dieser Schritt ist in der Datenbank noch nicht eingerichtet (Update 53 fehlt). Bitte das Fahrzeug später direkt als fertig melden.' : TerminCloud.germanError(error), 'error'); await load(true); return; }
        const index = (data.items || []).findIndex(entry => entry.id === item.id);
        if (index >= 0) data.items[index] = row;
        status(inShop ? `${row.plate} steht jetzt als „in der Werkstatt“ – das Büro sieht das.` : `${row.plate} steht wieder als „noch nicht bearbeitet“.`, 'success');
        render();
    }

    $('tyreRefresh').addEventListener('click', () => load());
    window.setInterval(() => { if (!document.hidden) load(true); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true); });
    window.ReifenApp = { state: () => data, load };
    load();
})();
