// Portal: „An die Pforte melden“. Bevor jemand hinausfährt, meldet er sich mit einem Tipp an der Pforte ab – das ersetzt die
// Kopie des Auftrags auf Papier. Die Meldung trägt das übernommene Fahrzeug und alle offenen Aufträge von heute (Uhrzeit, Arzt,
// Stadt, Patient/in). Die Pforte sieht sie auf ihrer Anzeige (pforte.html) und trägt ein, wann die Person zurück ist.
// Solange die Pforte das nicht getan hat, kann man die Meldung selbst zurücknehmen. Daten: Tabelle tt_gate (supabase/update-30.sql).
(function () {
    const core = window.PortalCore;
    const box = document.getElementById('gateBox');
    if (!core || !box) return;
    const { client, el, toast } = core;
    const clock = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    let rows = [];            // meine Meldungen von heute (und eine noch offene von früher)
    let ready = false;        // gibt es die Pforte in der Datenbank schon?
    let busy = false;

    const openRow = () => rows.find(row => !row.in_at) || null;
    const lastBack = () => rows.filter(row => row.in_at).sort((left, right) => String(right.in_at).localeCompare(String(left.in_at)))[0] || null;

    // Die Aufträge dieser Ausfahrt: alle von heute, die noch anstehen. Was nach der Abfahrt fertig wurde, bleibt stehen –
    // die Pforte soll sehen, wo die Person überall war.
    function stopsNow(since) {
        return core.gateJobs(since).map(item => {
            const info = core.homeJobText(item);
            const parsed = core.parseJobMessage(item.message);
            return { time: info.time || '', doctor: info.place || '', city: info.city || '', patient_name: info.patient || '', patient_nr: parsed?.facts['Aktennummer'] || '' };
        });
    }
    function carNow() {
        const vehicle = core.myVehicle();
        return vehicle ? { plate: vehicle.plate || '', vehicle: [vehicle.brand, vehicle.body].filter(Boolean).join(' · ') } : { plate: '', vehicle: '' };
    }
    const stopLine = stop => [stop.time ? `${stop.time} Uhr` : '', stop.doctor, stop.city].filter(Boolean).join(' · ');

    function render() {
        box.hidden = !ready;
        if (!ready) return;
        const row = openRow();
        const back = lastBack();
        box.dataset.state = row ? 'draussen' : 'da';
        box.replaceChildren();
        const text = el('div', 'gate-box-text');
        if (row) {
            const stops = Array.isArray(row.stops) ? row.stops : [];
            text.append(el('strong', '', `An der Pforte gemeldet · raus seit ${clock(row.out_at)} Uhr`),
                el('span', '', [row.plate || 'ohne Dienstfahrzeug', stops.length ? `${stops.length} ${stops.length === 1 ? 'Auftrag' : 'Aufträge'}` : row.note].filter(Boolean).join(' · ')),
                el('span', 'gate-box-hint', 'Wenn du zurück bist, trägt die Pforte das ein.'));
            const undo = el('button', 'button-secondary gate-box-undo', 'Zurücknehmen');
            undo.type = 'button';
            undo.addEventListener('click', () => takeBack(row, undo));
            box.append(text, undo);
        } else {
            text.append(el('strong', '', 'Fährst du hinaus?'),
                el('span', '', back ? `Zuletzt zurück um ${clock(back.in_at)} Uhr – für die nächste Fahrt wieder melden.` : 'Melde dich vor der Abfahrt an der Pforte – ein Tipp genügt, kein Zettel nötig.'));
            const report = el('button', 'button-primary gate-box-report', 'An die Pforte melden');
            report.type = 'button';
            report.addEventListener('click', () => openSheet(report));
            box.append(text, report);
        }
    }

    // Bestätigung vor dem Melden: Das sieht die Pforte. Ohne Auftrag heute fragt die App kurz nach dem Ziel.
    function openSheet(button) {
        const car = carNow();
        const stops = stopsNow(null);
        const dialog = el('dialog', 'confirm-dialog gate-sheet');
        dialog.setAttribute('aria-labelledby', 'gateSheetTitle');
        const title = el('h2', '', 'An die Pforte melden');
        title.id = 'gateSheetTitle';
        const list = el('dl', 'gate-sheet-list');
        const line = (label, value, cls) => { const dt = el('dt', '', label); const dd = el('dd', cls || ''); (Array.isArray(value) ? value : [value]).forEach(part => dd.append(el('span', '', part))); list.append(dt, dd); };
        line('Fahrzeug', car.plate ? [car.plate, car.vehicle].filter(Boolean).join(' · ') : 'kein Dienstfahrzeug übernommen', car.plate ? '' : 'gate-sheet-warn');
        if (stops.length) line(stops.length === 1 ? 'Auftrag' : `${stops.length} Aufträge`, stops.map((stop, index) => `${stops.length > 1 ? `${index + 1}. ` : ''}${stopLine(stop)}${stop.patient_name ? ` – ${stop.patient_name}` : ''}`));
        const noteLabel = el('label', 'field-label', stops.length ? 'Bemerkung für die Pforte (freiwillig)' : 'Wohin fährst du?');
        noteLabel.htmlFor = 'gateSheetNote';
        const note = el('input');
        note.id = 'gateSheetNote';
        note.type = 'text';
        note.maxLength = 160;
        note.placeholder = stops.length ? 'zum Beispiel: danach zur Apotheke' : 'zum Beispiel: Werkstatt, Flughafen Köln/Bonn';
        const hint = el('p', 'field-hint', car.plate ? 'Die Pforte sieht deinen Namen, das Fahrzeug und diese Angaben.' : 'Fährst du mit einem Dienstwagen? Dann übernimm ihn zuerst unter „Fahrzeug“ – so steht das Kennzeichen gleich dabei.');
        const status = el('p', 'gate-sheet-status');
        status.setAttribute('role', 'alert');
        const buttons = el('div', 'modal-buttons');
        const cancel = el('button', 'button-secondary', 'Abbrechen');
        cancel.type = 'button';
        const ok = el('button', 'button-primary', 'Jetzt melden');
        ok.type = 'button';
        buttons.append(cancel, ok);
        dialog.append(title, list, noteLabel, note, hint, status, buttons);
        document.body.append(dialog);
        cancel.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => dialog.remove());
        ok.addEventListener('click', async () => {
            const noteText = note.value.trim();
            if (!stops.length && !noteText) { status.textContent = 'Bitte trag kurz ein, wohin du fährst.'; note.focus(); return; }
            ok.disabled = true;
            const first = stops[0] || {};
            const { error } = await client.from('tt_gate').insert({
                plate: car.plate, vehicle: car.vehicle, stops, note: noteText,
                appointment_time: first.time || '', doctor: first.doctor || '', city: first.city || '', patient_name: first.patient_name || '', patient_nr: first.patient_nr || ''
            });
            ok.disabled = false;
            if (error) { status.textContent = missing(error) ? 'Die Pforte ist in der App noch nicht eingerichtet. Bitte sag der Einsatzleitung Bescheid.' : TerminCloud.germanError(error); return; }
            dialog.close();
            toast('Die Pforte weiß Bescheid. Gute Fahrt!', 'success');
            await load();
            button.focus?.();
        });
        dialog.showModal();
    }

    async function takeBack(row, button) {
        const yes = await core.askYesNo({ title: 'Meldung zurücknehmen?', text: 'Die Pforte sieht dich dann nicht mehr als „draußen“. Das ist richtig, wenn du doch nicht fährst oder dich vertippt hast.', okLabel: 'Zurücknehmen', cancelLabel: 'Abbrechen' });
        if (!yes) return;
        button.disabled = true;
        const { error } = await client.from('tt_gate').delete().eq('id', row.id);
        button.disabled = false;
        if (error) { toast(TerminCloud.germanError(error), 'error'); return; }
        toast('Die Meldung ist zurückgenommen.', 'success');
        await load();
    }

    // Kommt ein Auftrag dazu oder ändert sich etwas, während die Person draußen ist, zieht die Meldung von selbst nach.
    async function keepCurrent() {
        const row = openRow();
        if (!row) return;
        const stops = stopsNow(row.out_at);
        const car = carNow();
        const changes = {};
        if (stops.length && JSON.stringify(stops) !== JSON.stringify(row.stops || [])) changes.stops = stops;
        if (car.plate && car.plate !== row.plate) { changes.plate = car.plate; changes.vehicle = car.vehicle; }
        if (!Object.keys(changes).length) return;
        const { error } = await client.from('tt_gate').update(changes).eq('id', row.id);
        if (!error) { Object.assign(row, changes); render(); }
    }

    const missing = error => /does not exist|schema cache|relation|PGRST205|42P01/i.test(`${error?.code || ''} ${error?.message || ''}`);

    async function load() {
        const profile = core.profile();
        if (busy || !profile?.active || profile.role === 'pforte') return;
        busy = true;
        try {
            const today = TerminCloud.todayIso();
            const { data, error } = await client.from('tt_gate').select('*').eq('profile_id', profile.id).order('out_at', { ascending: false }).limit(20);
            if (error) { ready = false; render(); return; }      // Update 30 fehlt noch (oder kein Netz): kein Knopf, der nicht funktioniert
            ready = true;
            rows = data.filter(row => row.date === today || !row.in_at);
            render();
            await keepCurrent();
        } finally { busy = false; }
    }

    window.PortalGate = { load, refresh: () => { if (ready) { render(); keepCurrent(); } }, state: () => ({ rows, ready }) };
    window.setInterval(() => { if (!document.hidden && core.view() === 'vehicle') load(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    load();
})();
