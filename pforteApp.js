// Pforte: Anzeige für den großen Bildschirm. Wer hinausfährt, meldet sich in der App ab (portalApp.js, „An die Pforte melden“);
// hier steht jede Ausfahrt als großes Feld – Fahrer, Fahrzeug, Ziel, Termin, Patient – mit dem Knopf „Ist zurück“.
// Am Ende des Tages: „Tagesbericht drucken“ (alle Bewegungen des Tages). Daten: Tabelle tt_gate (supabase/update-30.sql).
(function () {
    const $ = id => document.getElementById(id);
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const client = typeof TerminCloud === 'undefined' ? null : TerminCloud.client;
    const clock = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const dayLong = iso => new Date(`${iso}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
    const span = (from, to) => { const minutes = Math.max(0, Math.round((new Date(to) - new Date(from)) / 60000)); return minutes < 60 ? `${minutes} Min.` : `${Math.floor(minutes / 60)} Std. ${String(minutes % 60).padStart(2, '0')} Min.`; };
    const FRESH = 90000;          // so lange leuchtet eine neue Meldung
    let profile = null;
    let rows = [];
    let jobs = [];                // Stand der Aufträge der gemeldeten Personen (Update 38): losgefahren / fertig / ausgefallen
    let day = '';
    let known = null;             // schon gesehene Meldungen (für das Aufleuchten und den Ton)
    let busy = false;
    let lastNudge = Date.now();
    let log = [];                 // Protokoll des Tages: Nachträge, Korrekturen, Bestätigungen (Update 45)
    let unreported = [];          // laut App unterwegs, aber nicht gemeldet (Update 45)
    let people = [];              // Personen für den Nachtrag
    let cars = [];                // Fahrzeuge für den Nachtrag
    let has45 = true;             // Update 45 vorhanden (Name der Pforte, Nachtrag, Korrektur, Protokoll)
    let fixRow = null;

    // Name der Person an der Pforte: Das Konto teilen sich mehrere – der Name steht bei jeder Bestätigung und im Bericht.
    // Das Büro ist mit eigenem Konto angemeldet – dessen Name gilt, wenn oben nichts steht.
    const who = () => $('gateWho').value.trim().replace(/\s+/g, ' ').slice(0, 80) || (isStaff() ? (profile?.full_name || '') : '');
    try { $('gateWho').value = localStorage.getItem('gate.who') || ''; } catch (error) { /* ohne Speicher */ }
    $('gateWho').addEventListener('change', () => { try { localStorage.setItem('gate.who', who()); } catch (error) { /* ohne Speicher */ } });
    function needName() {
        if (who()) return false;
        banner('Bitte zuerst oben deinen Namen eintragen – dann steht bei jeder Buchung, wer an der Pforte war.', 'error');
        $('gateWho').focus();
        return true;
    }
    // Aufruf einer Pforten-Funktion mit dem Namen der Pforte. Ohne Update 45 kennen die Funktionen p_by nicht – dann ohne.
    async function gateRpc(name, args) {
        if (has45) {
            const result = await client.rpc(name, { ...args, p_by: who() });
            if (!result.error || !/p_by|could not find the function|schema cache/i.test(result.error.message || '')) return result;
            has45 = false;
        }
        return client.rpc(name, args);
    }
    const pad = value => String(value).padStart(2, '0');
    const localStamp = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const fromLocal = value => { if (!value) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; };
    const dayShort = iso => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
    const stampText = iso => `${dayShort(iso)} ${clock(iso)}`;

    const today = () => TerminCloud.todayIso();
    const canGate = account => Boolean(account?.active && ['pforte', 'admin', 'sekretariat'].includes(account.role));
    const isStaff = () => TerminCloud.isStaff(profile);

    function show(view) {
        $('gateAuth').hidden = view !== 'auth';
        $('gateApp').hidden = view !== 'app';
    }
    let bannerTimer = 0;
    function banner(text, kind = 'info') {
        const box = $('gateStatus');
        box.hidden = !text;
        box.textContent = text || '';
        box.dataset.kind = kind;
        window.clearTimeout(bannerTimer);
        // Eine Erfolgsmeldung verschwindet von selbst; Fehler bleiben, bis es weitergeht.
        if (text && kind === 'success') bannerTimer = window.setTimeout(() => { if (box.dataset.kind === 'success') banner(''); }, 12000);
    }
    function ask(text, yesLabel = 'Ja') {
        const dialog = $('gateConfirm');
        $('gateConfirmText').textContent = text;
        $('gateConfirmYes').textContent = yesLabel;
        return new Promise(resolve => {
            let answer = false;
            const yes = () => { answer = true; dialog.close(); };
            const no = () => dialog.close();
            $('gateConfirmYes').addEventListener('click', yes, { once: true });
            $('gateConfirmNo').addEventListener('click', no, { once: true });
            dialog.addEventListener('close', () => { $('gateConfirmYes').removeEventListener('click', yes); $('gateConfirmNo').removeEventListener('click', no); resolve(answer); }, { once: true });
            dialog.showModal();
        });
    }
    // Kurzer Ton bei einer neuen Meldung (geht erst, nachdem einmal auf die Seite getippt wurde – so wollen es die Browser).
    let audio = null;
    function chime() {
        try {
            audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            [880, 1175].forEach((pitch, index) => {
                const tone = audio.createOscillator(), level = audio.createGain();
                tone.frequency.value = pitch;
                level.gain.setValueAtTime(0.0001, audio.currentTime + index * 0.18);
                level.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + index * 0.18 + 0.02);
                level.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + index * 0.18 + 0.32);
                tone.connect(level).connect(audio.destination);
                tone.start(audio.currentTime + index * 0.18);
                tone.stop(audio.currentTime + index * 0.18 + 0.35);
            });
        } catch (error) { /* ohne Ton */ }
    }

    function tick() {
        const now = new Date();
        $('gateClock').textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        $('gateDate').textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
        document.querySelectorAll('[data-since]').forEach(node => { node.textContent = `seit ${span(node.dataset.since, now)}`; });
        document.querySelectorAll('.gate-card[data-fresh]').forEach(card => { if (Date.now() - Number(card.dataset.fresh) > FRESH) delete card.dataset.fresh; });
    }

    // Alle Aufträge einer Ausfahrt (wer zwei Aufträge hat, fährt oft von draußen direkt zum zweiten). Ältere Meldungen tragen nur ein Ziel.
    const stopsOf = row => {
        const list = (Array.isArray(row.stops) ? row.stops : []).filter(stop => stop && (stop.doctor || stop.city || stop.time || stop.patient_name));
        return list.length ? list : (row.doctor || row.city || row.appointment_time || row.patient_name ? [{ time: row.appointment_time, doctor: row.doctor, city: row.city, patient_name: row.patient_name, patient_nr: row.patient_nr }] : []);
    };
    const stopPlace = stop => [stop.doctor, stop.city].filter(Boolean).join(' · ') || 'Ziel nicht angegeben';
    const stopPatient = stop => [stop.patient_name, stop.patient_nr ? `Nr. ${stop.patient_nr}` : ''].filter(Boolean).join(' · ');
    const stopTime = stop => stop.time ? `${String(stop.time).slice(0, 5)} Uhr` : '';
    // Erledigt ist ein Termin, wenn die App ihn als fertig mitschickt (done) oder die Datenbank es weiß (tt_gate_jobs, Update 38).
    // So erkennt die Pforte, dass jemand mit zwei Terminen nur zwischendurch zurückkommt.
    const jobOf = (row, stop) => stop.assignment_id ? jobs.find(job => job.assignment_id === stop.assignment_id) : jobs.find(job => job.profile_id === row.profile_id && job.appointment_time && String(job.appointment_time).slice(0, 5) === String(stop.time || '').slice(0, 5));
    const stopDoneAt = (row, stop) => { if (stop.done) return stop.done; const job = jobOf(row, stop); return job ? (job.finished_at || job.storno_at || (['beendet', 'alleine', 'storniert'].includes(job.work_status) ? row.out_at : null)) : null; };
    const openStops = row => stopsOf(row).filter(stop => !stopDoneAt(row, stop));
    const doneStops = row => stopsOf(row).filter(stop => Boolean(stopDoneAt(row, stop)));
    const destination = row => stopsOf(row).map(stop => [stopTime(stop), stopPlace(stop)].filter(Boolean).join(' ')).join('  →  ') || row.note || 'Ziel nicht angegeben';

    // Bestätigt die Pforte die Ausfahrt, gilt die Person als draußen. Vorher ist sie nur „angemeldet“.
    // (Meldungen aus der Zeit vor Update 31 kennen das Feld nicht – sie gelten als bestätigt.)
    const confirmedAt = row => ('out_confirmed_at' in row ? row.out_confirmed_at : row.out_at) || null;
    const leftAt = row => confirmedAt(row) || row.out_at;

    // Eine Person, ein Feld – auch wenn sie am Tag mehrmals hinaus- und hereinfährt (Update 38). Jede Fahrt ist eine Zeile in
    // tt_gate; hier werden die Zeilen einer Person zusammengefasst: Stand (angemeldet / draußen / im Haus / fertig), alle Termine
    // mit erledigt/offen und die Fahrten mit raus- und zurück-Zeiten.
    const personKey = row => row.profile_id || row.driver_name || row.id;
    function mergedStops(list) {
        const seen = new Map();
        list.forEach(row => stopsOf(row).forEach(stop => {
            const key = stop.assignment_id || `${String(stop.time || '').slice(0, 5)}|${stop.doctor || ''}|${stop.city || ''}`;
            const doneAt = stopDoneAt(row, stop);
            const known = seen.get(key);
            seen.set(key, { ...(known || {}), ...stop, doneAt: doneAt || known?.doneAt || null, row });
        }));
        return [...seen.values()].sort((left, right) => String(left.time || '').localeCompare(String(right.time || '')));
    }
    function groups() {
        const map = new Map();
        rows.forEach(row => { const key = personKey(row); if (!map.has(key)) map.set(key, []); map.get(key).push(row); });
        return [...map.values()].map(list => {
            list.sort((left, right) => String(left.out_at).localeCompare(String(right.out_at)));
            const current = list[list.length - 1];
            const stops = mergedStops(list);
            const open = stops.filter(stop => !stop.doneAt);
            const done = stops.filter(stop => Boolean(stop.doneAt));
            let state;
            // „Kommt heute nicht mehr ins Büro“ (Update 46): abgeschlossen, auch ohne Rückkehr.
            if (!current.in_at) state = current.away_reason ? 'weg' : confirmedAt(current) ? 'draussen' : 'angemeldet';
            else if (current.final || !open.length || current.date !== today()) state = 'fertig';
            else state = 'imhaus';
            return { key: personKey(current), list, current, stops, open, done, state, trips: list.filter(row => confirmedAt(row) || row.in_at) };
        });
    }
    const tripLine = (row, index, count) => {
        const label = count > 1 ? `${index + 1}. Fahrt: ` : '';
        if (!confirmedAt(row) && !row.in_at) return `${label}gemeldet ${clock(row.out_at)} – wartet auf Bestätigung`;
        return `${label}raus ${clock(leftAt(row))}${row.in_at ? ` → zurück ${clock(row.in_at)} (${span(leftAt(row), row.in_at)})` : row.away_reason ? ' → kommt nicht zurück' : ' → noch draußen'}`;
    };

    function render() {
        const everyone = groups();
        const order = { angemeldet: 0, imhaus: 1, draussen: 2 };
        // Fahrten früherer Tage, die nie als zurück eingetragen wurden, stehen in ihrem eigenen Block (nicht zwischen den heutigen).
        const old = everyone.filter(group => group.state !== 'fertig' && group.state !== 'weg' && group.current.date !== day).sort((left, right) => String(left.current.out_at).localeCompare(String(right.current.out_at)));
        const main = everyone.filter(group => group.state !== 'fertig' && group.state !== 'weg' && group.current.date === day).sort((left, right) => (order[left.state] - order[right.state]) || String(left.current.out_at).localeCompare(String(right.current.out_at)));
        const back = everyone.filter(group => group.state === 'fertig' || group.state === 'weg').sort((left, right) => String(right.current.in_at || right.current.away_at || '').localeCompare(String(left.current.in_at || left.current.away_at || '')));
        $('gateOldSection').hidden = !old.length;
        $('gateOldList').replaceChildren(...old.map(group => {
            const row = group.current;
            const card = el('li', 'gate-card');
            card.dataset.id = row.id;
            card.dataset.state = group.state;
            card.dataset.old = 'ja';
            const car = el('div', 'gate-car');
            car.append(el('strong', 'gate-driver', row.driver_name || 'Unbekannt'), el('span', 'gate-plate', row.plate || 'ohne Fahrzeug'), el('span', 'gate-model', row.vehicle || ''));
            const info = el('div', 'gate-info');
            info.append(el('span', 'gate-fact', destination(row)));
            info.append(el('span', 'gate-between', `Seit ${dayLong(row.date)} nicht als zurück eingetragen${confirmedAt(row) ? '' : ' (Ausfahrt nie bestätigt)'}`));
            const time = el('div', 'gate-time');
            time.append(el('span', 'gate-time-label', `raus am ${dayShort(leftAt(row))}`), el('strong', '', clock(leftAt(row))), el('span', 'gate-since', `vor ${span(leftAt(row), new Date())}`));
            const side = el('div', 'gate-side');
            if (has45) {
                const fix = el('button', 'gate-button gate-return gate-fix-old', 'Rückkehr nachtragen');
                fix.type = 'button';
                fix.addEventListener('click', () => openFix(row, true));
                side.append(fix);
            } else {
                const done = el('button', 'gate-button gate-return', 'Ist zurück');
                done.type = 'button';
                done.addEventListener('click', () => setBack(row, true, done));
                side.append(done);
            }
            if (!confirmedAt(row)) {
                const drop = el('button', 'gate-button gate-button-quiet gate-drop', 'Nicht gefahren');
                drop.type = 'button';
                drop.addEventListener('click', () => dropRow(row, drop));
                side.append(drop);
            }
            if (isStaff()) {
                const remove = el('button', 'gate-button gate-button-quiet gate-remove', 'Löschen');
                remove.type = 'button';
                remove.addEventListener('click', () => removeRow(row, remove));
                side.append(remove);
            }
            card.append(car, info, time, side);
            return card;
        }));
        // Laut App unterwegs, aber nicht gemeldet: ein Klick trägt die Ausfahrt mit allen bekannten Angaben ein.
        $('gateUnreported').hidden = !(unreported.length && day === today());
        $('gateUnreportedList').replaceChildren(...unreported.map(item => {
            const row = el('li', 'gate-unreported-item');
            row.dataset.profile = item.profile_id;
            const text = el('div', 'gate-unreported-text');
            text.append(el('strong', '', `${item.full_name}${item.plate ? ` · ${item.plate}` : ''}${item.vehicle ? ` (${item.vehicle})` : ''}`));
            text.append(el('span', '', `${item.source === 'auftrag' ? '„Losgefahren“ gedrückt' : item.source === 'beides' ? 'Fahrzeug übernommen und „Losgefahren“ gedrückt' : 'Fahrzeug in der App übernommen'}${item.since ? ` um ${clock(item.since)} Uhr` : ''}${item.jobs ? ` · Termine: ${item.jobs}` : ''}`));
            const add = el('button', 'gate-button gate-confirm-out gate-unreported-add', 'Ausfahrt eintragen');
            add.type = 'button';
            add.addEventListener('click', () => openManual(item));
            row.append(text, add);
            return row;
        }));
        const waiting = main.filter(group => group.state === 'angemeldet');
        const outside = [...main.filter(group => group.state === 'draussen'), ...old];
        const inside = main.filter(group => group.state === 'imhaus');
        $('gateCountWait').textContent = String(waiting.length);
        $('gateCountWaitBox').dataset.open = waiting.length ? 'ja' : '';
        $('gateCountOut').textContent = String(outside.length);
        $('gateCountBack').textContent = String(inside.length + back.length);
        const live = day === today();
        $('gateOutTitle').textContent = live ? [waiting.length ? 'Angemeldet' : '', inside.length ? 'im Haus (fährt noch einmal)' : '', 'draußen'].filter(Boolean).join(', ').replace(/^./, c => c.toUpperCase()) : `Noch offen am ${dayLong(day)}`;
        $('gateOutEmpty').hidden = main.length > 0 || old.length > 0;
        $('gateOutEmpty').textContent = live ? 'Im Moment ist niemand angemeldet und niemand draußen.' : 'An diesem Tag ist niemand mehr draußen.';
        $('gateBackTitle').textContent = live ? 'Heute fertig' : 'Zurück';
        $('gateBackEmpty').hidden = back.length > 0;
        $('gateOutList').replaceChildren(...main.map(group => {
            const row = group.current;
            const card = el('li', 'gate-card');
            card.dataset.id = row.id;
            card.dataset.state = group.state;
            if (group.state === 'draussen' && Date.now() - new Date(leftAt(row)) < FRESH) card.dataset.fresh = String(new Date(leftAt(row)).getTime());
            // Die Hauptrolle hat die Person: Name groß, darunter ihr Fahrzeug – daneben ihre Termine der Reihe nach.
            const car = el('div', 'gate-car');
            car.append(el('strong', 'gate-driver', row.driver_name || 'Unbekannt'), el('span', 'gate-plate', row.plate || 'ohne Fahrzeug'), el('span', 'gate-model', row.vehicle || ''));
            if (group.trips.length > 1) car.append(el('span', 'gate-trip-count', `${group.trips.length}. Fahrt heute`));
            const info = el('div', 'gate-info');
            const stops = group.stops;
            if (stops.length > 1) info.append(el('span', 'gate-stops-count', `${stops.length} Aufträge`));
            const list = el('ol', 'gate-stops');
            let nextMarked = false;
            stops.forEach((stop, index) => {
                const item = el('li', 'gate-stop');
                if (stop.doneAt) item.classList.add('is-done');
                else if ((group.done.length || group.state === 'imhaus') && !nextMarked) { item.classList.add('is-next'); nextMarked = true; }
                if (stops.length > 1) item.append(el('b', 'gate-stop-no', stop.doneAt ? '✓' : String(index + 1)));
                const text = el('div', 'gate-stop-text');
                text.append(el('strong', '', [stopTime(stop), stopPlace(stop)].filter(Boolean).join(' · ')));
                if (stopPatient(stop)) text.append(el('span', '', `Patient/in: ${stopPatient(stop)}`));
                if (stop.doneAt) text.append(el('span', 'gate-stop-done', `erledigt${typeof stop.doneAt === 'string' && /T/.test(stop.doneAt) ? ` um ${clock(stop.doneAt)} Uhr` : ''}`));
                else if (group.done.length) text.append(el('span', 'gate-stop-open', 'noch offen'));
                item.append(text);
                list.append(item);
            });
            // Ohne Auftrag steht das Ziel, das die Person selbst eingetragen hat, groß da.
            if (!stops.length) { const item = el('li', 'gate-stop'); const text = el('div', 'gate-stop-text'); text.append(el('strong', '', row.note || 'Ziel nicht angegeben')); item.append(text); list.append(item); }
            info.append(list);
            if (row.note && stops.length && !/^Weiterfahrt/.test(row.note)) info.append(el('span', 'gate-fact', row.note));
            // Erster Termin fertig, der nächste erst später: Die Person kommt vermutlich zwischendurch zurück.
            if (group.state === 'imhaus') info.append(el('span', 'gate-between', `Zwischendurch zurück – ${group.open.length === 1 ? 'noch ein Termin' : `noch ${group.open.length} Termine`}: fährt um ${stopTime(group.open[0]) || 'später'} wieder hinaus`));
            else if (group.done.length && group.open.length) info.append(el('span', 'gate-between', `${group.done.length} von ${stops.length} erledigt – kommt vermutlich zwischendurch zurück und fährt um ${stopTime(group.open[0]) || 'später'} wieder hinaus`));
            else if (stops.length && group.done.length === stops.length) info.append(el('span', 'gate-between is-all', stops.length > 1 ? 'Alle Termine erledigt – auf dem Rückweg' : 'Termin erledigt – auf dem Rückweg'));
            // Alle Fahrten des Tages mit raus- und zurück-Zeiten.
            if (group.list.length > 1 || group.trips.length) {
                const trips = el('ul', 'gate-trips');
                group.list.forEach((trip, index) => { const line = el('li', '', tripLine(trip, index, group.list.length)); if (trip === row) line.classList.add('is-current'); trips.append(line); });
                info.append(trips);
            }
            const time = el('div', 'gate-time');
            const since = el('span', 'gate-since', '');
            const otherDay = row.date !== today();
            const dayText = new Date(`${row.date}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
            if (group.state === 'imhaus') { since.dataset.since = row.in_at; time.append(el('span', 'gate-time-label', 'zurück um'), el('strong', '', clock(row.in_at)), since); }
            else { since.dataset.since = leftAt(row); time.append(el('span', 'gate-time-label', group.state === 'draussen' ? (otherDay ? `raus am ${dayText}` : 'raus um') : (otherDay ? `gemeldet am ${dayText}` : 'gemeldet um')), el('strong', '', clock(leftAt(row))), since); }
            if (otherDay) card.dataset.old = 'ja';
            const side = el('div', 'gate-side');
            if (group.state === 'draussen') {
                const done = el('button', 'gate-button gate-return', 'Ist zurück');
                done.type = 'button';
                done.addEventListener('click', () => setBack(row, true, done));
                side.append(done);
                if (has45) {
                    const away = el('button', 'gate-button gate-button-quiet gate-away', 'Kommt nicht zurück');
                    away.type = 'button';
                    away.addEventListener('click', () => openAway(row));
                    side.append(away);
                }
                if ('out_confirmed_at' in row) {
                    const unconfirm = el('button', 'gate-button gate-button-quiet gate-unconfirm', 'Doch nicht draußen');
                    unconfirm.type = 'button';
                    unconfirm.addEventListener('click', () => setOut(row, false, unconfirm));
                    side.append(unconfirm);
                }
            } else if (group.state === 'imhaus') {
                // Zwischendurch zurück: Die Person bleibt stehen – die nächste Ausfahrt wird hier angemeldet (oder der Tag ist doch zu Ende).
                side.append(el('span', 'gate-inside-label', 'Im Haus'));
                const again = el('button', 'gate-button gate-again', 'Fährt wieder raus');
                again.type = 'button';
                again.addEventListener('click', () => goAgain(row, group.open, again));
                const finish = el('button', 'gate-button gate-button-quiet gate-finish', 'Heute fertig');
                finish.type = 'button';
                finish.addEventListener('click', () => setDone(row, true, finish));
                const undo = el('button', 'gate-button gate-button-quiet gate-undo', 'Doch nicht zurück');
                undo.type = 'button';
                undo.addEventListener('click', () => setBack(row, false, undo));
                side.append(again, finish, undo);
            } else {
                // Erst die Pforte macht aus der Meldung eine Ausfahrt.
                side.append(el('span', 'gate-wait-label', 'Wartet auf dich'));
                const confirm = el('button', 'gate-button gate-confirm-out', 'Ausfahrt bestätigen');
                confirm.type = 'button';
                confirm.addEventListener('click', () => setOut(row, true, confirm));
                const drop = el('button', 'gate-button gate-button-quiet gate-drop', 'Nicht gefahren');
                drop.type = 'button';
                drop.addEventListener('click', () => dropRow(row, drop));
                side.append(confirm, drop);
            }
            if (has45 && (confirmedAt(row) || row.in_at)) {
                const fix = el('button', 'gate-button gate-button-quiet gate-fix', 'Zeiten korrigieren');
                fix.type = 'button';
                fix.addEventListener('click', () => openFix(row, false));
                side.append(fix);
            }
            if (isStaff()) {
                const remove = el('button', 'gate-button gate-button-quiet gate-remove', 'Löschen');
                remove.type = 'button';
                remove.addEventListener('click', () => removeRow(row, remove));
                side.append(remove);
            }
            if (row.by_gate || row.fixed_at) info.append(el('span', 'gate-fact gate-entered', `${row.by_gate ? `Nachgetragen von ${row.entered_by || 'der Pforte'}` : ''}${row.by_gate && row.fixed_at ? ' · ' : ''}${row.fixed_at ? `korrigiert von ${row.fixed_by || 'der Pforte'} (${stampText(row.fixed_at)})` : ''}`));
            card.append(car, info, time, side);
            return card;
        }));
        $('gateBackList').replaceChildren(...back.map(group => {
            const row = group.current;
            const item = el('li', 'gate-back-row');
            item.dataset.id = row.id;
            item.dataset.state = group.state;
            const text = el('div', 'gate-back-text');
            text.append(el('strong', '', `${row.driver_name || 'Unbekannt'} · ${row.plate || 'ohne Fahrzeug'}`));
            if (group.state === 'weg') {
                text.append(el('span', 'gate-away-text', `Kommt heute nicht zurück – ${AWAY[row.away_reason] || row.away_reason}${row.away_note ? `: ${row.away_note}` : ''} · eingetragen ${clock(row.away_at)} Uhr${row.away_by ? ` von ${row.away_by}` : ''}`));
                text.append(el('span', '', `${destination(row)} · raus ${clock(leftAt(row))}`));
            } else if (group.list.length > 1) { text.append(el('span', '', `${group.list.length} Fahrten: ${group.list.map((trip, index) => tripLine(trip, index, 1)).join(' · ')}`)); }
            else text.append(el('span', '', `${destination(row)} · raus ${clock(leftAt(row))} · zurück ${clock(row.in_at)} (${span(leftAt(row), row.in_at)})`));
            const side = el('div', 'gate-back-side');
            if (group.state === 'weg') {
                const back = el('button', 'gate-button gate-button-quiet gate-doch-zurueck', 'Ist doch zurück');
                back.type = 'button';
                back.addEventListener('click', () => setBack(row, true, back));
                const lift = el('button', 'gate-button gate-button-quiet gate-away-undo', 'Vermerk aufheben');
                lift.type = 'button';
                lift.addEventListener('click', () => setAway(row, '', '', lift));
                side.append(back, lift);
                if (has45) { const fix = el('button', 'gate-button gate-button-quiet gate-fix', 'Zeiten korrigieren'); fix.type = 'button'; fix.addEventListener('click', () => openFix(row, false)); side.append(fix); }
                item.append(text, side);
                return item;
            }
            if (row.final && group.open.length && row.date === today()) {
                text.append(el('span', 'gate-back-rest', `Noch offen: ${group.open.map(stop => [stopTime(stop), stopPlace(stop)].filter(Boolean).join(' ')).join('  →  ')}`));
                const reopen = el('button', 'gate-button gate-button-quiet gate-reopen', 'Fährt doch wieder raus');
                reopen.type = 'button';
                reopen.addEventListener('click', () => setDone(row, false, reopen));
                side.append(reopen);
            }
            const undo = el('button', 'gate-button gate-button-quiet gate-undo', 'Doch nicht zurück');
            undo.type = 'button';
            undo.addEventListener('click', () => setBack(row, false, undo));
            side.append(undo);
            if (has45) {
                const fix = el('button', 'gate-button gate-button-quiet gate-fix', 'Zeiten korrigieren');
                fix.type = 'button';
                fix.addEventListener('click', () => openFix(row, false));
                side.append(fix);
            }
            if (row.by_gate || row.fixed_at) text.append(el('span', 'gate-entered', `${row.by_gate ? `nachgetragen von ${row.entered_by || 'der Pforte'}` : ''}${row.by_gate && row.fixed_at ? ' · ' : ''}${row.fixed_at ? `korrigiert von ${row.fixed_by || 'der Pforte'}` : ''}`));
            item.append(text, side);
            return item;
        }));
        // Tagesbericht: jede Fahrt eine Zeile, nach Person und Zeit.
        const all = rows.filter(row => row.date === day).sort((left, right) => String(left.driver_name).localeCompare(String(right.driver_name), 'de') || String(left.out_at).localeCompare(String(right.out_at)));
        const tripNo = new Map();
        $('gateReportTitle').textContent = `Pforte – Bewegungen am ${dayLong(day)}`;
        $('gateReportSub').textContent = `Medical Office Bonn · gedruckt am ${new Date().toLocaleDateString('de-DE')} um ${clock(new Date())} Uhr${who() ? ` von ${who()} (Pforte)` : profile?.full_name ? ` von ${profile.full_name}` : ''}`;
        $('gateReportBody').replaceChildren(...all.map((row, index) => {
            const line = el('tr');
            const stops = stopsOf(row);
            const key = personKey(row);
            tripNo.set(key, (tripNo.get(key) || 0) + 1);
            const count = all.filter(other => personKey(other) === key).length;
            [String(index + 1), `${row.driver_name}${count > 1 ? ` (${tripNo.get(key)}. Fahrt)` : ''}`, [row.plate, row.vehicle].filter(Boolean).join(' · '), [...stops.map(stop => `${stopPlace(stop)}${stopDoneAt(row, stop) ? ' ✓' : ''}`), ...(row.note ? [stops.length ? `Bemerkung: ${row.note}` : row.note] : [])].join('\n'), stops.map(stopTime).join('\n'),
                stops.map(stopPatient).join('\n'), clock(row.out_at), confirmedAt(row) ? clock(confirmedAt(row)) : 'nicht bestätigt', row.in_at ? clock(row.in_at) : row.away_reason ? `kommt nicht zurück (${AWAY[row.away_reason] || row.away_reason})` : confirmedAt(row) ? 'noch draußen' : '', row.in_at ? span(leftAt(row), row.in_at) : '',
                [[...new Set([row.out_by, row.in_by].filter(Boolean))].join(' / '), row.by_gate ? `nachgetragen (${row.entered_by || 'Pforte'})` : '', row.fixed_at ? `korrigiert (${row.fixed_by || 'Pforte'})` : ''].filter(Boolean).join('\n')]
                .forEach(value => line.append(el('td', '', value || '')));
            return line;
        }));
        // Nachträge und Korrekturen des Tages (Protokoll, Update 45)
        const ACTION = { bestaetigt: 'Ausfahrt bestätigt', zurueck: 'Rückkehr eingetragen', nachtrag: 'Nachtrag', korrektur: 'Korrektur', wieder_raus: 'Fährt wieder raus', fertig: 'Heute fertig', nicht_gefahren: 'Nicht gefahren', zurueckgenommen: 'Zurückgenommen', nicht_zurueck: 'Kommt nicht zurück', doch_zurueck: 'Vermerk aufgehoben' };
        const important = log.filter(item => ['nachtrag', 'korrektur', 'nicht_gefahren', 'zurueckgenommen', 'nicht_zurueck', 'doch_zurueck'].includes(item.action));
        $('gateReportLogBox').hidden = !important.length;
        $('gateReportLog').replaceChildren(...important.map(item => {
            const line = el('tr');
            [clock(item.at), item.driver_name, item.plate, `${ACTION[item.action] || item.action}${item.detail ? `: ${item.detail}` : ''}`, item.by_name].forEach(value => line.append(el('td', '', value || '')));
            return line;
        }));
        if (!all.length) { const line = el('tr'); const cell = el('td', '', 'An diesem Tag gab es keine Ausfahrten.'); cell.colSpan = 11; line.append(cell); $('gateReportBody').append(line); }
        const older = main.filter(group => group.current.date !== day).length;
        $('gateReportSum').textContent = `${all.length} ${all.length === 1 ? 'Fahrt' : 'Fahrten'} · ${all.filter(row => row.in_at).length} zurück${all.some(row => !row.in_at && row.away_reason) ? ` · ${all.filter(row => !row.in_at && row.away_reason).length} kommt nicht zurück (Bereitschaft / früher Termin)` : ''} · ${all.filter(row => !row.in_at && !row.away_reason && confirmedAt(row)).length} noch draußen${all.some(row => !row.in_at && !confirmedAt(row)) ? ` · ${all.filter(row => !row.in_at && !confirmedAt(row)).length} gemeldet, von der Pforte nicht bestätigt` : ''}${older ? ` · dazu ${older} noch draußen von früheren Tagen` : ''}`;
        tick();
    }

    async function load() {
        if (busy || !profile) return;
        busy = true;
        try {
            let { data, error } = await client.from('tt_gate').select('*').eq('date', day).order('out_at');
            // Wer an einem früheren Tag hinausfuhr und nie als zurück eingetragen wurde, bleibt heute unter „Draußen“ stehen.
            if (!error && day === today()) {
                const earlier = await client.from('tt_gate').select('*').lt('date', day).is('in_at', null).order('out_at').limit(40);
                if (!earlier.error) data = [...earlier.data.filter(row => !row.away_reason), ...data];
            }
            if (error) {
                banner(/does not exist|schema cache|relation/i.test(error.message || '') ? 'Die Anzeige ist in der Datenbank noch nicht eingerichtet (Update 30 fehlt). Bitte der Einsatzleitung Bescheid sagen.' : `Keine Verbindung: ${TerminCloud.germanError(error)}`, 'error');
                return;
            }
            // Stand der Aufträge (Update 38) – fehlt die Funktion noch, zählt nur, was die App mitschickt.
            const progress = await client.rpc('tt_gate_jobs', { p_date: day });
            jobs = progress.error ? [] : (progress.data || []);
            // Protokoll des Tages und nicht gemeldete Fahrten (Update 45) – fehlt das Update, bleibt beides leer.
            if (has45) {
                const [logResult, missing] = await Promise.all([
                    client.from('tt_gate_log').select('*').eq('date', day).order('at'),
                    day === today() ? client.rpc('tt_gate_unreported', { p_date: day }) : Promise.resolve({ data: [] })
                ]);
                if (logResult.error && /does not exist|schema cache|relation/i.test(logResult.error.message || '')) has45 = false;
                log = logResult.error ? [] : logResult.data;
                unreported = missing.error ? [] : (missing.data || []);
            } else { log = []; unreported = []; }
            $('gateManualOpen').hidden = !has45;
            if ($('gateStatus').dataset.kind !== 'success') banner('');
            // Neue Meldung seit dem letzten Blick? Dann kurz aufleuchten lassen und einen Ton geben.
            const ids = new Set(data.map(row => row.id));
            if (known && day === today() && data.some(row => !known.has(row.id) && !row.in_at)) chime();
            else if (day === today() && data.some(row => !row.in_at && !confirmedAt(row)) && Date.now() - lastNudge > 60000) { lastNudge = Date.now(); if (known) chime(); }   // wartet noch jemand: jede Minute ein Ton
            known = ids;
            rows = data;
            render();
        } finally { busy = false; }
    }

    const need31 = error => /could not find the function|schema cache|does not exist/i.test(error?.message || '') ? 'Dafür fehlt noch ein Datenbank-Update (Update 31). Bitte der Einsatzleitung Bescheid sagen.' : TerminCloud.germanError(error);
    async function setOut(row, ok, button) {
        if (!ok && !(await ask(`${row.driver_name} (${row.plate || 'ohne Fahrzeug'}) ist doch nicht hinausgefahren?\n\nDie Meldung wartet dann wieder auf deine Bestätigung.`, 'Bestätigung zurücknehmen'))) return;
        if (needName()) return;
        button.disabled = true;
        const { error } = await gateRpc('tt_gate_out', { p_id: row.id, p_ok: ok });
        button.disabled = false;
        if (error) { banner(need31(error), 'error'); return; }
        await load();
    }
    async function dropRow(row, button) {
        if (!(await ask(`${row.driver_name} (${row.plate || 'ohne Fahrzeug'}) ist nicht gefahren?\n\nDie Meldung wird herausgenommen.`, 'Meldung herausnehmen'))) return;
        if (needName()) return;
        button.disabled = true;
        const { error } = await gateRpc('tt_gate_drop', { p_id: row.id });
        button.disabled = false;
        if (error) { banner(need31(error), 'error'); return; }
        await load();
    }

    async function setBack(row, back, button) {
        if (!back && !(await ask(`${row.driver_name} (${row.plate || 'ohne Fahrzeug'}) ist doch noch nicht zurück?`, 'Wieder nach „Draußen“'))) return;
        if (needName()) return;
        button.disabled = true;
        const { error } = await gateRpc('tt_gate_return', { p_id: row.id, p_back: back });
        button.disabled = false;
        if (error) { banner(TerminCloud.germanError(error), 'error'); return; }
        await load();
    }
    // „Fährt wieder raus“: neue Ausfahrt mit den noch offenen Terminen – sofort bestätigt, die Person sieht sie in ihrer App.
    async function goAgain(row, rest, button) {
        if (!(await ask(`${row.driver_name} (${row.plate || 'ohne Fahrzeug'}) fährt wieder hinaus?\n\nNächster Termin: ${rest.map(stop => [stopTime(stop), stopPlace(stop)].filter(Boolean).join(' ')).join(', ')}`, 'Ausfahrt eintragen'))) return;
        if (needName()) return;
        button.disabled = true;
        const { error } = await gateRpc('tt_gate_again', { p_id: row.id, p_stops: rest.map(stop => ({ ...stop, done: '' })) });
        button.disabled = false;
        if (error) { banner(/could not find the function|schema cache/i.test(error.message || '') ? 'Dafür fehlt noch ein Datenbank-Update (Update 38). Bitte der Einsatzleitung Bescheid sagen.' : TerminCloud.germanError(error), 'error'); return; }
        await load();
    }
    // „Heute fertig“ (p_done = true): Die Person ist zurück und fährt nicht mehr – auch wenn noch ein Termin offen steht.
    async function setDone(row, done, button) {
        if (needName()) return;
        button.disabled = true;
        const { error } = await gateRpc('tt_gate_done', { p_id: row.id, p_done: done });
        button.disabled = false;
        if (error) { banner(/could not find the function|schema cache/i.test(error.message || '') ? 'Dafür fehlt noch ein Datenbank-Update (Update 38). Bitte der Einsatzleitung Bescheid sagen.' : TerminCloud.germanError(error), 'error'); return; }
        await load();
    }
    async function removeRow(row, button) {
        if (!(await ask(`Die Meldung von ${row.driver_name} (${row.plate || 'ohne Fahrzeug'}, raus um ${clock(row.out_at)}) löschen?\n\nSie verschwindet dann auch aus dem Tagesbericht.`, 'Löschen'))) return;
        button.disabled = true;
        const { error } = await client.from('tt_gate').delete().eq('id', row.id);
        button.disabled = false;
        if (error) { banner(TerminCloud.germanError(error), 'error'); return; }
        await load();
    }

    // ---------- Nachtrag und Korrektur (Update 45) ----------
    const formStatus = (id, text, kind = 'error') => { const box = $(id); box.hidden = !text; box.textContent = text || ''; box.dataset.kind = kind; };
    async function loadChoices() {
        const [peopleResult, carResult] = await Promise.all([client.rpc('tt_gate_people'), client.rpc('tt_gate_vehicles')]);
        people = peopleResult.error ? [] : (peopleResult.data || []);
        cars = carResult.error ? [] : (carResult.data || []);
        return !peopleResult.error;
    }
    async function openManual(preset = null) {
        if (needName()) return;
        if (!(await loadChoices())) { banner('Dafür fehlt noch ein Datenbank-Update (Update 45). Bitte der Einsatzleitung Bescheid sagen.', 'error'); return; }
        $('gateManualPerson').replaceChildren(el('option', '', 'Bitte wählen …'), ...people.map(person => { const option = el('option', '', `${person.full_name}${person.role !== 'dolmetscher' ? ' (Büro)' : ''}`); option.value = person.id; return option; }));
        $('gateManualPerson').firstChild.value = '';
        $('gateManualVehicle').replaceChildren(el('option', '', 'Ohne Fahrzeug / zu Fuß'), ...cars.map(car => { const option = el('option', '', `${car.plate} · ${car.vehicle}${car.holder ? ` (laut App bei ${car.holder})` : ''}`); option.value = car.plate; option.dataset.vehicle = car.vehicle; return option; }));
        $('gateManualVehicle').firstChild.value = '';
        $('gateManualPerson').value = preset?.profile_id || '';
        $('gateManualVehicle').value = preset?.plate || '';
        $('gateManualNote').value = preset?.jobs ? `Termine: ${preset.jobs}` : '';
        $('gateManualOut').value = localStamp(preset?.since ? new Date(preset.since) : new Date());
        $('gateManualOut').max = localStamp(new Date());
        $('gateManualBack').checked = false;
        $('gateManualIn').value = ''; $('gateManualIn').disabled = true;
        $('gateManualHint').textContent = preset ? `${preset.full_name} ist laut App unterwegs, hat sich aber nicht an der Pforte gemeldet. Prüfe die Zeit und trag die Ausfahrt ein.` : 'Für Fahrten, die nicht in der App gemeldet wurden. Der Eintrag steht im Tagesbericht mit deinem Namen.';
        formStatus('gateManualStatus', '');
        $('gateManual').showModal();
        if (!preset) $('gateManualPerson').focus();
    }
    // Wird ein Fahrzeug gewählt, das laut App gerade jemand hat, wird die Person vorgeschlagen (und umgekehrt).
    $('gateManualVehicle').addEventListener('change', () => {
        const car = cars.find(item => item.plate === $('gateManualVehicle').value);
        if (car?.holder_id && !$('gateManualPerson').value) $('gateManualPerson').value = car.holder_id;
    });
    $('gateManualPerson').addEventListener('change', () => {
        const car = cars.find(item => item.holder_id && item.holder_id === $('gateManualPerson').value);
        if (car && !$('gateManualVehicle').value) $('gateManualVehicle').value = car.plate;
    });
    $('gateManualBack').addEventListener('change', () => { $('gateManualIn').disabled = !$('gateManualBack').checked; if ($('gateManualBack').checked && !$('gateManualIn').value) $('gateManualIn').value = localStamp(new Date()); });
    $('gateManualOpen').addEventListener('click', () => openManual(null));
    $('gateManualCancel').addEventListener('click', () => $('gateManual').close());
    $('gateManualForm').addEventListener('submit', async event => {
        event.preventDefault();
        const person = people.find(item => item.id === $('gateManualPerson').value);
        if (!person) { formStatus('gateManualStatus', 'Bitte die Person auswählen.'); $('gateManualPerson').focus(); return; }
        const out = fromLocal($('gateManualOut').value);
        if (!out) { formStatus('gateManualStatus', 'Bitte Datum und Uhrzeit der Ausfahrt eintragen.'); $('gateManualOut').focus(); return; }
        if (out > new Date(Date.now() + 5 * 60000)) { formStatus('gateManualStatus', 'Die Ausfahrt liegt in der Zukunft – bitte prüfen.'); $('gateManualOut').focus(); return; }
        const back = $('gateManualBack').checked ? fromLocal($('gateManualIn').value) : null;
        if ($('gateManualBack').checked && !back) { formStatus('gateManualStatus', 'Bitte Datum und Uhrzeit der Rückkehr eintragen.'); $('gateManualIn').focus(); return; }
        if (back && back < out) { formStatus('gateManualStatus', 'Die Rückkehr liegt vor der Ausfahrt – bitte Zeiten prüfen.'); $('gateManualIn').focus(); return; }
        const car = cars.find(item => item.plate === $('gateManualVehicle').value);
        $('gateManualSave').disabled = true;
        const { error } = await client.rpc('tt_gate_manual', { p_profile: person.id, p_plate: car?.plate || '', p_vehicle: car?.vehicle || '', p_note: $('gateManualNote').value.trim(), p_stops: [], p_out_at: out.toISOString(), p_in_at: back ? back.toISOString() : null, p_by: who() });
        $('gateManualSave').disabled = false;
        if (error) { formStatus('gateManualStatus', TerminCloud.germanError(error)); return; }
        $('gateManual').close();
        banner(`${person.full_name}: Ausfahrt ${dayShort(out)} ${clock(out)} Uhr eingetragen${back ? `, zurück ${clock(back)} Uhr` : ''} – von ${who()}.`, 'success');
        await load();
    });
    function openFix(row, backNow) {
        if (needName()) return;
        fixRow = row;
        $('gateFixTitle').textContent = backNow ? 'Rückkehr nachtragen' : 'Zeiten korrigieren';
        $('gateFixInfo').textContent = `${row.driver_name || 'Unbekannt'} · ${row.plate || 'ohne Fahrzeug'} · ${destination(row)} · bisher: raus ${stampText(leftAt(row))}${row.in_at ? `, zurück ${stampText(row.in_at)}` : ', noch draußen'}`;
        $('gateFixOut').value = localStamp(new Date(leftAt(row)));
        $('gateFixOut').max = localStamp(new Date());
        $('gateFixBack').checked = Boolean(row.in_at) || backNow;
        $('gateFixIn').disabled = !$('gateFixBack').checked;
        $('gateFixIn').value = row.in_at ? localStamp(new Date(row.in_at)) : backNow ? localStamp(new Date()) : '';
        $('gateFixReason').value = backNow ? 'Rückkehr an der Pforte nicht eingetragen' : '';
        formStatus('gateFixStatus', '');
        $('gateFix').showModal();
        (backNow ? $('gateFixIn') : $('gateFixReason')).focus();
    }
    $('gateFixBack').addEventListener('change', () => { $('gateFixIn').disabled = !$('gateFixBack').checked; if ($('gateFixBack').checked && !$('gateFixIn').value) $('gateFixIn').value = localStamp(new Date()); });
    $('gateFixCancel').addEventListener('click', () => $('gateFix').close());
    $('gateFixForm').addEventListener('submit', async event => {
        event.preventDefault();
        const row = fixRow;
        if (!row) return;
        const out = fromLocal($('gateFixOut').value);
        if (!out) { formStatus('gateFixStatus', 'Bitte Datum und Uhrzeit der Ausfahrt eintragen.'); $('gateFixOut').focus(); return; }
        const back = $('gateFixBack').checked ? fromLocal($('gateFixIn').value) : null;
        if ($('gateFixBack').checked && !back) { formStatus('gateFixStatus', 'Bitte Datum und Uhrzeit der Rückkehr eintragen.'); $('gateFixIn').focus(); return; }
        if (back && back < out) { formStatus('gateFixStatus', 'Die Rückkehr liegt vor der Ausfahrt – bitte Zeiten prüfen.'); $('gateFixIn').focus(); return; }
        if (!$('gateFixReason').value.trim()) { formStatus('gateFixStatus', 'Bitte einen Grund angeben – er steht im Protokoll.'); $('gateFixReason').focus(); return; }
        $('gateFixSave').disabled = true;
        const { error } = await client.rpc('tt_gate_fix', { p_id: row.id, p_out_at: out.toISOString(), p_in_at: back ? back.toISOString() : null, p_reason: $('gateFixReason').value.trim(), p_by: who() });
        $('gateFixSave').disabled = false;
        if (error) { formStatus('gateFixStatus', TerminCloud.germanError(error)); return; }
        $('gateFix').close();
        banner(`${row.driver_name}: Zeiten korrigiert – raus ${stampText(out)}${back ? `, zurück ${stampText(back)}` : ', noch draußen'} (${who()}).`, 'success');
        await load();
    });

    // ---------- „Kommt heute nicht mehr ins Büro“ (Update 46) ----------
    const AWAY = { bereitschaft: 'Bereitschaft / Notdienst', frueh: 'früher Termin morgen', sonstiges: 'sonstiges' };
    let awayRow = null;
    async function setAway(row, reason, note, button) {
        if (needName()) return;
        if (!reason && !(await ask(`Den Vermerk „kommt nicht zurück“ für ${row.driver_name} aufheben?\n\nDie Person steht dann wieder unter „Draußen“.`, 'Vermerk aufheben'))) return;
        if (button) button.disabled = true;
        const { error } = await client.rpc('tt_gate_away', { p_id: row.id, p_reason: reason, p_note: note, p_by: who() });
        if (button) button.disabled = false;
        if (error) { banner(/could not find the function|schema cache/i.test(error.message || '') ? 'Dafür fehlt noch ein Datenbank-Update (Update 46). Bitte der Einsatzleitung Bescheid sagen.' : TerminCloud.germanError(error), 'error'); return false; }
        banner(reason ? `${row.driver_name}: kommt heute nicht zurück – ${AWAY[reason]} (${who()}).` : `${row.driver_name}: Vermerk aufgehoben – wieder unter „Draußen“.`, 'success');
        await load();
        return true;
    }
    function openAway(row) {
        if (needName()) return;
        awayRow = row;
        $('gateAwayInfo').textContent = `${row.driver_name || 'Unbekannt'} · ${row.plate || 'ohne Fahrzeug'} · ${destination(row)} · raus ${clock(leftAt(row))} Uhr`;
        document.querySelectorAll('input[name=gateAwayReason]').forEach(input => { input.checked = input.value === 'bereitschaft'; });
        $('gateAwayNote').value = '';
        formStatus('gateAwayStatus', '');
        $('gateAway').showModal();
    }
    $('gateAwayCancel').addEventListener('click', () => $('gateAway').close());
    $('gateAwayForm').addEventListener('submit', async event => {
        event.preventDefault();
        const reason = document.querySelector('input[name=gateAwayReason]:checked')?.value || 'bereitschaft';
        const note = $('gateAwayNote').value.trim();
        if (reason === 'sonstiges' && !note) { formStatus('gateAwayStatus', 'Bitte kurz angeben, warum die Person nicht mehr kommt.'); $('gateAwayNote').focus(); return; }
        $('gateAwaySave').disabled = true;
        const ok = await setAway(awayRow, reason, note, null);
        $('gateAwaySave').disabled = false;
        if (ok) $('gateAway').close();
    });

    async function start() {
        if (!client) { show('auth'); $('gateAuthStatus').textContent = 'Die Verbindung zur Datenbank konnte nicht geladen werden. Bitte das Internet prüfen und die Seite neu laden.'; return; }
        try { profile = await TerminCloud.getProfile(true); } catch (error) { profile = null; }
        if (!profile) { show('auth'); return; }
        if (!canGate(profile)) {
            show('auth');
            $('gateAuthStatus').textContent = profile.active ? 'Dieses Konto ist nicht für die Pforte freigegeben. Bitte die Einsatzleitung fragen.' : 'Dieses Konto ist noch nicht freigeschaltet. Bitte die Einsatzleitung fragen.';
            return;
        }
        day = today();
        if (isStaff() && !$('gateWho').value) $('gateWho').placeholder = profile.full_name || 'Dein Name';
        $('gateDay').value = day;
        $('gateDay').max = day;
        $('gateOffice').hidden = !isStaff();
        known = null;
        show('app');
        await load();
    }

    $('gateSignIn').addEventListener('submit', async event => {
        event.preventDefault();
        const status = $('gateAuthStatus');
        status.textContent = 'Anmeldung läuft …';
        try {
            const result = await TerminCloud.signIn($('gateEmail').value.trim(), $('gatePassword').value);
            if (result?.error) throw new Error(TerminCloud.germanError(result.error));
            $('gatePassword').value = '';
            status.textContent = '';
            await start();
        } catch (error) { status.textContent = error.message || 'Die Anmeldung hat nicht geklappt.'; }
    });
    $('gateSignOut').addEventListener('click', async () => {
        if (!(await ask('Die Pforte abmelden?', 'Abmelden'))) return;
        await TerminCloud.signOut();
        profile = null; rows = [];
        show('auth');
    });
    $('gateDay').addEventListener('change', () => { day = $('gateDay').value || today(); known = null; load(); });
    $('gatePrint').addEventListener('click', () => { render(); window.print(); });
    $('gateFull').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => null); });
    document.addEventListener('fullscreenchange', () => { $('gateFull').textContent = document.fullscreenElement ? 'Vollbild beenden' : 'Vollbild'; });

    window.setInterval(tick, 1000);
    // Um Mitternacht springt die Anzeige von selbst auf den neuen Tag (wenn „heute“ gezeigt wurde).
    let shownToday = '';
    window.setInterval(() => {
        if (!profile || $('gateApp').hidden) return;
        const now = today();
        if (shownToday && shownToday !== now && day === shownToday) { day = now; $('gateDay').value = now; known = null; }
        shownToday = now;
        $('gateDay').max = now;
        load();
    }, 8000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    window.PforteApp = { state: () => ({ day, rows, profile, log, unreported, has45 }), load };
    start();
})();
