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
    let day = '';
    let known = null;             // schon gesehene Meldungen (für das Aufleuchten und den Ton)
    let busy = false;

    const today = () => TerminCloud.todayIso();
    const canGate = account => Boolean(account?.active && ['pforte', 'admin', 'sekretariat'].includes(account.role));
    const isStaff = () => TerminCloud.isStaff(profile);

    function show(view) {
        $('gateAuth').hidden = view !== 'auth';
        $('gateApp').hidden = view !== 'app';
    }
    function banner(text, kind = 'info') {
        const box = $('gateStatus');
        box.hidden = !text;
        box.textContent = text || '';
        box.dataset.kind = kind;
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
    const destination = row => stopsOf(row).map(stop => [stopTime(stop), stopPlace(stop)].filter(Boolean).join(' ')).join('  →  ') || row.note || 'Ziel nicht angegeben';

    function render() {
        const out = rows.filter(row => !row.in_at).sort((left, right) => String(left.out_at).localeCompare(String(right.out_at)));
        const back = rows.filter(row => row.in_at).sort((left, right) => String(right.in_at).localeCompare(String(left.in_at)));
        $('gateCountOut').textContent = String(out.length);
        $('gateCountBack').textContent = String(back.length);
        const live = day === today();
        $('gateOutTitle').textContent = live ? 'Draußen' : `Noch draußen am ${dayLong(day)}`;
        $('gateOutEmpty').hidden = out.length > 0;
        $('gateOutEmpty').textContent = live ? 'Im Moment ist niemand draußen.' : 'An diesem Tag ist niemand mehr draußen.';
        $('gateBackEmpty').hidden = back.length > 0;
        $('gateOutList').replaceChildren(...out.map(row => {
            const card = el('li', 'gate-card');
            card.dataset.id = row.id;
            if (Date.now() - new Date(row.out_at) < FRESH) card.dataset.fresh = String(new Date(row.out_at).getTime());
            // Die Hauptrolle hat die Person: Name groß, darunter ihr Fahrzeug – daneben ihre Aufträge der Reihe nach.
            const car = el('div', 'gate-car');
            car.append(el('strong', 'gate-driver', row.driver_name || 'Unbekannt'), el('span', 'gate-plate', row.plate || 'ohne Fahrzeug'), el('span', 'gate-model', row.vehicle || ''));
            const info = el('div', 'gate-info');
            const stops = stopsOf(row);
            if (stops.length > 1) info.append(el('span', 'gate-stops-count', `${stops.length} Aufträge`));
            const list = el('ol', 'gate-stops');
            stops.forEach((stop, index) => {
                const item = el('li', 'gate-stop');
                if (stops.length > 1) item.append(el('b', 'gate-stop-no', String(index + 1)));
                const text = el('div', 'gate-stop-text');
                text.append(el('strong', '', [stopTime(stop), stopPlace(stop)].filter(Boolean).join(' · ')));
                if (stopPatient(stop)) text.append(el('span', '', `Patient/in: ${stopPatient(stop)}`));
                item.append(text);
                list.append(item);
            });
            // Ohne Auftrag steht das Ziel, das die Person selbst eingetragen hat, groß da.
            if (!stops.length) { const item = el('li', 'gate-stop'); const text = el('div', 'gate-stop-text'); text.append(el('strong', '', row.note || 'Ziel nicht angegeben')); item.append(text); list.append(item); }
            info.append(list);
            if (row.note && stops.length) info.append(el('span', 'gate-fact', row.note));
            const time = el('div', 'gate-time');
            const since = el('span', 'gate-since', '');
            since.dataset.since = row.out_at;
            const otherDay = row.date !== today();
            time.append(el('span', 'gate-time-label', otherDay ? `raus am ${new Date(`${row.date}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}` : 'raus um'), el('strong', '', clock(row.out_at)), since);
            if (otherDay) card.dataset.old = 'ja';
            const side = el('div', 'gate-side');
            const done = el('button', 'gate-button gate-return', 'Ist zurück');
            done.type = 'button';
            done.addEventListener('click', () => setBack(row, true, done));
            side.append(done);
            if (isStaff()) {
                const remove = el('button', 'gate-button gate-button-quiet gate-remove', 'Löschen');
                remove.type = 'button';
                remove.addEventListener('click', () => removeRow(row, remove));
                side.append(remove);
            }
            card.append(car, info, time, side);
            return card;
        }));
        $('gateBackList').replaceChildren(...back.map(row => {
            const item = el('li', 'gate-back-row');
            item.dataset.id = row.id;
            const text = el('div', 'gate-back-text');
            text.append(el('strong', '', `${row.driver_name || 'Unbekannt'} · ${row.plate || 'ohne Fahrzeug'}`), el('span', '', `${destination(row)} · raus ${clock(row.out_at)} · zurück ${clock(row.in_at)} (${span(row.out_at, row.in_at)})`));
            const undo = el('button', 'gate-button gate-button-quiet gate-undo', 'Doch nicht zurück');
            undo.type = 'button';
            undo.addEventListener('click', () => setBack(row, false, undo));
            item.append(text, undo);
            return item;
        }));
        // Tagesbericht
        const all = rows.filter(row => row.date === day).sort((left, right) => String(left.out_at).localeCompare(String(right.out_at)));
        $('gateReportTitle').textContent = `Pforte – Bewegungen am ${dayLong(day)}`;
        $('gateReportSub').textContent = `Medical Office Bonn · gedruckt am ${new Date().toLocaleDateString('de-DE')} um ${clock(new Date())} Uhr${profile?.full_name ? ` von ${profile.full_name}` : ''}`;
        $('gateReportBody').replaceChildren(...all.map((row, index) => {
            const line = el('tr');
            const stops = stopsOf(row);
            [String(index + 1), row.driver_name, [row.plate, row.vehicle].filter(Boolean).join(' · '), [...stops.map(stopPlace), ...(row.note ? [stops.length ? `Bemerkung: ${row.note}` : row.note] : [])].join('\n'), stops.map(stopTime).join('\n'),
                stops.map(stopPatient).join('\n'), clock(row.out_at), row.in_at ? clock(row.in_at) : 'noch draußen', row.in_at ? span(row.out_at, row.in_at) : '', row.in_by || '']
                .forEach(value => line.append(el('td', '', value || '')));
            return line;
        }));
        if (!all.length) { const line = el('tr'); const cell = el('td', '', 'An diesem Tag gab es keine Ausfahrten.'); cell.colSpan = 10; line.append(cell); $('gateReportBody').append(line); }
        const older = out.filter(row => row.date !== day).length;
        $('gateReportSum').textContent = `${all.length} ${all.length === 1 ? 'Ausfahrt' : 'Ausfahrten'} · ${all.filter(row => row.in_at).length} zurück · ${all.filter(row => !row.in_at).length} noch draußen${older ? ` · dazu ${older} noch draußen von früheren Tagen` : ''}`;
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
                if (!earlier.error) data = [...earlier.data, ...data];
            }
            if (error) {
                banner(/does not exist|schema cache|relation/i.test(error.message || '') ? 'Die Anzeige ist in der Datenbank noch nicht eingerichtet (Update 30 fehlt). Bitte der Einsatzleitung Bescheid sagen.' : `Keine Verbindung: ${TerminCloud.germanError(error)}`, 'error');
                return;
            }
            banner('');
            // Neue Meldung seit dem letzten Blick? Dann kurz aufleuchten lassen und einen Ton geben.
            const ids = new Set(data.map(row => row.id));
            if (known && day === today() && data.some(row => !known.has(row.id) && !row.in_at)) chime();
            known = ids;
            rows = data;
            render();
        } finally { busy = false; }
    }

    async function setBack(row, back, button) {
        if (!back && !(await ask(`${row.driver_name} (${row.plate || 'ohne Fahrzeug'}) ist doch noch nicht zurück?`, 'Wieder nach „Draußen“'))) return;
        button.disabled = true;
        const { error } = await client.rpc('tt_gate_return', { p_id: row.id, p_back: back });
        button.disabled = false;
        if (error) { banner(TerminCloud.germanError(error), 'error'); return; }
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
    window.PforteApp = { state: () => ({ day, rows, profile }), load };
    start();
})();
