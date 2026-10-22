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

    // Die Pforte gibt es nur für fest Angestellte (und das Büro, wenn es die App der Dolmetscher benutzt). Temporäre brauchen sie nicht.
    const allowed = () => { const profile = core.profile(); return Boolean(profile?.active && (TerminCloud.isStaff(profile) || (profile.role === 'dolmetscher' && profile.employment === 'fest'))); };
    // Bestätigt ist die Ausfahrt erst, wenn die Pforte es eingetragen hat (vor Update 31 gab es das Feld nicht).
    const confirmedAt = row => ('out_confirmed_at' in row ? row.out_confirmed_at : row.out_at) || null;
    // Offen = draußen und nicht „kommt heute nicht mehr zurück“ (Update 46). Die abgeschlossene Meldung von heute zeigt die App trotzdem.
    const openRow = () => rows.find(row => !row.in_at && !row.away_reason) || null;
    const awayRow = () => rows.find(row => !row.in_at && row.away_reason && row.date === TerminCloud.todayIso()) || null;
    const AWAY = { bereitschaft: 'Bereitschaft / Notdienst', frueh: 'früher Termin morgen', sonstiges: 'sonstiges' };
    const lastBack = () => rows.filter(row => row.in_at).sort((left, right) => String(right.in_at).localeCompare(String(left.in_at)))[0] || null;

    // Die Aufträge dieser Ausfahrt: alle von heute, die noch anstehen. Was nach der Abfahrt fertig wurde, bleibt stehen –
    // die Pforte soll sehen, wo die Person überall war.
    function stopsNow(since) {
        return core.gateJobs(since).map(item => {
            const info = core.homeJobText(item);
            const parsed = core.parseJobMessage(item.message);
            // assignment_id und done: So erkennt die Pforte, welcher Termin schon erledigt ist (Update 38) – wer zwischendurch zurückkommt, wird richtig eingetragen.
            return { time: info.time || '', doctor: info.place || '', city: info.city || '', patient_name: info.patient || '', patient_nr: parsed?.facts['Aktennummer'] || '', assignment_id: item.id, done: item.finished_at || '' };
        });
    }
    function carNow() {
        const vehicle = core.myVehicle();
        return vehicle ? { plate: vehicle.plate || '', vehicle: [vehicle.brand, vehicle.body].filter(Boolean).join(' · ') } : { plate: '', vehicle: '' };
    }
    const stopLine = stop => [stop.time ? `${stop.time} Uhr` : '', stop.doctor, stop.city].filter(Boolean).join(' · ');

    function render() {
        box.hidden = !ready || !allowed();
        if (box.hidden) return;
        const row = openRow();
        const away = row ? null : awayRow();
        const back = lastBack();
        const confirmed = row && confirmedAt(row);
        box.dataset.state = row ? (confirmed ? 'draussen' : 'angemeldet') : away ? 'weg' : 'da';
        box.replaceChildren();
        const text = el('div', 'gate-box-text');
        if (away) {
            text.append(el('strong', '', `Du kommst heute nicht mehr ins Büro – ${AWAY[away.away_reason] || away.away_reason}${away.away_note ? `: ${away.away_note}` : ''}`),
                el('span', '', `Die Pforte weiß Bescheid (eingetragen ${clock(away.away_at)} Uhr). Deine Ausfahrt gilt als abgeschlossen.`));
            const undo = el('button', 'button-secondary gate-box-undo', 'Doch zurück ins Büro');
            undo.type = 'button';
            undo.addEventListener('click', () => setAway(away, '', '', undo));
            box.append(text, undo);
        } else if (row) {
            const stops = Array.isArray(row.stops) ? row.stops : [];
            const facts = el('span', '', [row.plate || 'ohne Dienstfahrzeug', stops.length ? `${stops.length} ${stops.length === 1 ? 'Auftrag' : 'Aufträge'}` : row.note].filter(Boolean).join(' · '));
            if (confirmed) {
                // Die Pforte hat die Ausfahrt bestätigt: Jetzt gilt die Person als draußen – zurücknehmen kann das nur noch die Pforte.
                text.append(el('strong', '', `Die Pforte hat deine Ausfahrt bestätigt · ${clock(confirmed)} Uhr`), facts, el('span', 'gate-box-hint', 'Wenn du zurück bist, trägt die Pforte das ein. Kommst du heute nicht mehr ins Büro (Bereitschaft, früher Termin morgen), sag es hier – dann bleibt nichts offen.'));
                const away = el('button', 'button-secondary gate-box-away', 'Komme heute nicht mehr ins Büro');
                away.type = 'button';
                away.addEventListener('click', () => openAwaySheet(row, away));
                box.append(text, away);
            } else {
                text.append(el('strong', '', `An die Pforte gemeldet · ${clock(row.out_at)} Uhr`), facts, el('span', 'gate-box-hint', 'Bitte an der Pforte kurz bestätigen lassen – erst dann giltst du als hinausgefahren.'));
                const undo = el('button', 'button-secondary gate-box-undo', 'Zurücknehmen');
                undo.type = 'button';
                undo.addEventListener('click', () => takeBack(row, undo));
                box.append(text, undo);
            }
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
            toast('Die Pforte weiß Bescheid – bitte dort kurz bestätigen lassen.', 'success');
            await load();
            button.focus?.();
        });
        dialog.showModal();
    }

    // „Komme heute nicht mehr ins Büro“ (Update 46): Bereitschaft / Notdienst, früher Termin morgen oder sonstiges mit Grund.
    async function setAway(row, reason, note, button) {
        if (button) button.disabled = true;
        const { error } = await client.rpc('tt_gate_away', { p_id: row.id, p_reason: reason, p_note: note });
        if (button) button.disabled = false;
        if (error) { toast(missing(error) || /could not find the function/i.test(error.message || '') ? 'Das ist in der Datenbank noch nicht eingerichtet (Update 46). Bitte sag der Einsatzleitung Bescheid.' : TerminCloud.germanError(error), 'error'); return false; }
        toast(reason ? 'Die Pforte weiß Bescheid – du kommst heute nicht mehr ins Büro.' : 'Zurückgenommen – die Pforte trägt deine Rückkehr ein, wenn du da bist.', 'success');
        await load();
        return true;
    }
    function openAwaySheet(row, button) {
        const dialog = el('dialog', 'confirm-dialog gate-sheet');
        dialog.setAttribute('aria-labelledby', 'gateAwayTitle');
        const title = el('h2', '', 'Komme heute nicht mehr ins Büro');
        title.id = 'gateAwayTitle';
        const hint = el('p', 'field-hint', 'Die Pforte sieht das sofort – deine Ausfahrt gilt dann als abgeschlossen und bleibt nicht bis morgen offen.');
        const choices = el('div', 'gate-sheet-choices');
        let chosen = 'bereitschaft';
        const options = [['bereitschaft', 'Bereitschaft / Notdienst', 'ich gehe direkt in den Dienst'], ['frueh', 'Früher Termin morgen', 'ich fahre morgen von zu Hause los'], ['sonstiges', 'Sonstiges', 'bitte kurz begründen']];
        const buttons = options.map(([reason, label, small]) => {
            const choice = el('button', 'choice-button gate-away-choice');
            choice.type = 'button';
            choice.dataset.reason = reason;
            choice.setAttribute('aria-pressed', String(reason === chosen));
            const text = el('span', '');
            text.append(el('strong', '', label), el('small', '', small));
            choice.append(text);
            choice.addEventListener('click', () => { chosen = reason; buttons.forEach(item => item.setAttribute('aria-pressed', String(item.dataset.reason === chosen))); note.focus(); });
            return choice;
        });
        choices.append(...buttons);
        const noteLabel = el('label', 'field-label', 'Bemerkung (bei „Sonstiges“ Pflicht)');
        noteLabel.htmlFor = 'gateAwayNote';
        const note = el('input');
        note.id = 'gateAwayNote';
        note.type = 'text';
        note.maxLength = 200;
        note.placeholder = 'zum Beispiel: Termin 7:30 in Köln';
        const status = el('p', 'gate-sheet-status');
        status.setAttribute('role', 'alert');
        const bar = el('div', 'modal-buttons');
        const cancel = el('button', 'button-secondary', 'Abbrechen');
        cancel.type = 'button';
        const ok = el('button', 'button-primary', 'Pforte Bescheid geben');
        ok.type = 'button';
        bar.append(cancel, ok);
        dialog.append(title, hint, choices, noteLabel, note, status, bar);
        document.body.append(dialog);
        cancel.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => dialog.remove());
        ok.addEventListener('click', async () => {
            if (chosen === 'sonstiges' && !note.value.trim()) { status.textContent = 'Bitte kurz angeben, warum du heute nicht mehr ins Büro kommst.'; note.focus(); return; }
            ok.disabled = true;
            const done = await setAway(row, chosen, note.value.trim(), null);
            ok.disabled = false;
            if (done) { dialog.close(); button?.focus?.(); }
        });
        dialog.showModal();
    }
    // Vom „Auto über Nacht behalten“ aus (portalApp.js): Notdienst → Bereitschaft, früher Termin → früher Termin; '' hebt auf.
    async function markAway(reason, note = '') {
        const row = reason ? (openRow() || null) : awayRow();
        if (!row) return false;
        const { error } = await client.rpc('tt_gate_away', { p_id: row.id, p_reason: reason, p_note: note });
        if (error) return false;
        await load();
        return true;
    }

    async function takeBack(row, button) {
        const yes = await core.askYesNo({ title: 'Meldung zurücknehmen?', text: 'Die Pforte sieht deine Meldung dann nicht mehr. Das ist richtig, wenn du doch nicht fährst oder dich vertippt hast.', okLabel: 'Zurücknehmen', cancelLabel: 'Abbrechen' });
        if (!yes) return;
        button.disabled = true;
        const { error } = await client.from('tt_gate').delete().eq('id', row.id);
        button.disabled = false;
        if (error) { toast(TerminCloud.germanError(error), 'error'); return; }
        await load();
        if (rows.some(item => item.id === row.id)) { toast('Die Pforte hat deine Ausfahrt schon bestätigt – zurücknehmen kann sie jetzt nur noch die Pforte.', 'info'); return; }
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

    // „Jetzt losfahren“ meldet zugleich an die Pforte (ohne Rückfrage) – wenn nicht schon eine Meldung offen ist.
    async function autoReport() {
        if (!ready || !allowed()) return false;
        await load();                                   // die Pforte kann die nächste Ausfahrt schon angemeldet haben („Fährt wieder raus“)
        if (openRow()) return false;
        const car = carNow();
        const stops = stopsNow(null);
        const first = stops[0] || {};
        const { error } = await client.from('tt_gate').insert({
            plate: car.plate, vehicle: car.vehicle, stops, note: '',
            appointment_time: first.time || '', doctor: first.doctor || '', city: first.city || '', patient_name: first.patient_name || '', patient_nr: first.patient_nr || ''
        });
        if (error) return false;
        await load();
        return true;
    }

    const missing = error => /does not exist|schema cache|relation|PGRST205|42P01/i.test(`${error?.code || ''} ${error?.message || ''}`);

    async function load() {
        const profile = core.profile();
        if (busy || !profile?.active || !allowed()) { render(); return; }
        busy = true;
        try {
            const today = TerminCloud.todayIso();
            const { data, error } = await client.from('tt_gate').select('*').eq('profile_id', profile.id).order('out_at', { ascending: false }).limit(20);
            if (error) { ready = false; render(); return; }      // Update 30 fehlt noch (oder kein Netz): kein Knopf, der nicht funktioniert
            ready = true;
            rows = data.filter(row => row.date === today || (!row.in_at && !row.away_reason));
            render();
            await keepCurrent();
        } finally { busy = false; }
    }

    window.PortalGate = { load, autoReport, markAway, refresh: () => { if (ready) { render(); keepCurrent(); } }, state: () => ({ rows, ready }) };
    window.setInterval(() => { if (!document.hidden && core.view() === 'vehicle') load(); }, 30000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    load();
})();
