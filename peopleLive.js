// Wer arbeitet an einem Tag, wer ist unterwegs, wer ist frei, wer fehlt? Eine gemeinsame Auswertung für die
// Dolmetscher-Übersicht und die Startseite der Einsatzleitung („Heute live“).
// Quellen: Konten, Arbeitstage (Antwort auf „Kannst du arbeiten?“), Abwesenheiten der Festangestellten, der Tagesstand
// aus dem Live-Tracking, die gesendeten Aufträge und die ausgegebenen Fahrzeuge.
// Braucht cloudClient.js und absenceLogic.js. Nur für Einsatzleitung und Sekretariat.
window.PeopleLive = (function () {
    const logic = window.AbsenceLogic;
    const nameKey = name => String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');
    const clock = value => String(value || '').slice(0, 5);
    const STATES = ['unterwegs', 'frei', 'abwesend', 'nichtda', 'offen'];

    // Zustand eines Termins wie im Live-Tracking
    function recordGroup(record) {
        const status = String(record?.Status || 'offen').trim().toLocaleLowerCase('de-DE');
        if (status === 'beendet' || status === 'alleine') return 'erledigt';
        if (status === 'storniert') return 'storniert';
        if (status === 'losgefahren') return 'unterwegs';
        return 'offen';
    }
    const recordPlace = record => String(record?.['Arzt Nr::Ort'] || record?.Ort || record?.Termin_Ort || record?.Stadt || '').trim();
    const recordTitle = record => [String(record?.['Arzt Nr::Name'] || '').trim(), recordPlace(record)].filter(Boolean).join(' · ') || 'Termin';

    // „seit 09:12 Uhr“ → Minuten bis jetzt (nur für heute sinnvoll)
    function minutesSince(time) {
        if (!/^\d{1,2}:\d{2}/.test(String(time || ''))) return null;
        const now = new Date();
        const [hours, minutes] = String(time).split(':').map(Number);
        const diff = now.getHours() * 60 + now.getMinutes() - (hours * 60 + minutes);
        return diff >= 0 ? diff : null;
    }

    async function load(date) {
        const client = TerminCloud.client;
        const today = TerminCloud.todayIso();
        const isToday = date === today;
        const weekend = logic.isWeekend(date);
        const [profileResult, workdayResult, absenceResult, assignmentResult, handoverResult, vehicleResult, dayResult, requestResult, pushResult] = await Promise.all([
            client.from('tt_profiles').select('*').order('full_name'),
            client.from('tt_workdays').select('user_id, date, status, note').eq('date', date),
            client.from('tt_absences').select('*').lte('date_from', date).gte('date_to', date),
            client.from('tt_assignments').select('*').eq('date', date),
            isToday ? client.from('tt_handovers').select('id, vehicle_id, driver_id, driver_name, date, start_time, emergency, created_at').is('end_time', null) : Promise.resolve({ data: [] }),
            client.from('tt_vehicles').select('id, plate, brand, body, active, service_status, assigned_to'),
            client.from('tt_days').select('date, records').eq('date', date).maybeSingle(),
            client.from('tt_day_requests').select('*').eq('date', date).maybeSingle(),
            client.rpc('tt_push_profiles')
        ]);
        if (profileResult.error) throw new Error(TerminCloud.germanError(profileResult.error));
        // Fehlt Update 15 noch, gibt es weder Abwesenheiten noch Tagesanfragen – die Übersicht arbeitet dann ohne sie.
        const ready = !absenceResult.error && !requestResult.error;
        const profiles = profileResult.data || [];
        const workdays = workdayResult.error ? [] : workdayResult.data;
        const absences = absenceResult.error ? [] : absenceResult.data;
        const assignments = assignmentResult.error ? [] : assignmentResult.data.filter(item => !item.cancelled);
        const handovers = handoverResult.error ? [] : handoverResult.data || [];
        const vehicles = vehicleResult.error ? [] : vehicleResult.data;
        const records = !dayResult.error && Array.isArray(dayResult.data?.records) ? dayResult.data.records : [];
        const request = requestResult.error ? null : requestResult.data || null;
        const pushOn = new Set(pushResult.error ? [] : (pushResult.data || []).map(item => (typeof item === 'string' ? item : item?.tt_push_profiles || item?.profile_id)));
        const pushKnown = !pushResult.error;
        const plateOf = id => vehicles.find(vehicle => vehicle.id === id)?.plate || '';

        // Termine des Tages je Name (so, wie die Einsatzleitung sie im Live-Tracking eingeteilt hat)
        const recordsByName = new Map();
        records.forEach(record => {
            const key = nameKey(record?.Übersetzer);
            if (!key) return;
            if (!recordsByName.has(key)) recordsByName.set(key, { name: String(record.Übersetzer).trim().replace(/\s+/g, ' '), list: [] });
            recordsByName.get(key).list.push(record);
        });

        function build(profile, fallbackName) {
            const name = String(profile?.full_name || fallbackName || '').trim().replace(/\s+/g, ' ') || 'Unbekannt';
            const key = nameKey(name);
            const mine = recordsByName.get(key)?.list || [];
            const sent = profile ? assignments.filter(item => item.interpreter_id === profile.id) : [];
            const counted = mine.filter(record => recordGroup(record) !== 'storniert');
            const jobs = { total: counted.length, open: 0, running: 0, done: 0, cancelled: mine.length - counted.length };
            counted.forEach(record => { const group = recordGroup(record); jobs[group === 'offen' ? 'open' : group === 'unterwegs' ? 'running' : 'done'] += 1; });
            // Gibt es (noch) keinen Tagesstand, zählen die gesendeten Aufträge.
            if (!mine.length && sent.length) {
                sent.forEach(item => {
                    const status = String(item.work_status || '').toLocaleLowerCase('de-DE');
                    if (status === 'storniert') { jobs.cancelled += 1; return; }
                    jobs.total += 1;
                    jobs[item.finished_at || status === 'beendet' || status === 'alleine' ? 'done' : status === 'losgefahren' ? 'running' : 'open'] += 1;
                });
            }
            const responses = { offen: 0, zugesagt: 0, vorbehalt: 0, abgesagt: 0 };
            sent.forEach(item => { if (item.response in responses) responses[item.response] += 1; });
            const byTime = (left, right) => clock(left.Termin_Uhrzeit).localeCompare(clock(right.Termin_Uhrzeit));
            const running = counted.filter(record => recordGroup(record) === 'unterwegs').sort((left, right) => clock(left.Losgefahren_um).localeCompare(clock(right.Losgefahren_um)));
            const runningSent = sent.filter(item => String(item.work_status).toLocaleLowerCase('de-DE') === 'losgefahren' && !item.finished_at);
            const current = running.length
                ? { time: clock(running[0].Termin_Uhrzeit), title: recordTitle(running[0]), since: clock(running[0].Losgefahren_um) }
                : runningSent.length ? { time: clock(runningSent[0].time), title: String(runningSent[0].title || '').replace(/^\d{1,2}:\d{2} Uhr · /, ''), since: runningSent[0].started_at ? new Date(runningSent[0].started_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '' }
                : null;
            const open = counted.filter(record => recordGroup(record) === 'offen').sort(byTime);
            const next = open.length ? { time: clock(open[0].Termin_Uhrzeit), title: recordTitle(open[0]) } : null;
            const handover = isToday ? (profile && handovers.find(item => item.driver_id === profile.id)) || handovers.find(item => !item.driver_id && nameKey(item.driver_name) === key) || null : null;
            const vehicle = handover ? { plate: plateOf(handover.vehicle_id), since: clock(handover.start_time), date: handover.date, emergency: Boolean(handover.emergency), overnight: handover.date < today } : null;
            const own = profile ? absences.filter(item => item.profile_id === profile.id && item.status !== 'abgelehnt') : [];
            const absence = own.find(item => logic.blocksDay(item, date)) || null;
            const late = own.find(item => item.kind === 'verspätung' || ((item.kind === 'notfall' || item.kind === 'fehlstunden') && item.minutes)) || null;
            const vacationWaiting = own.find(item => item.kind === 'urlaub' && item.status === 'beantragt') || null;
            const answer = profile ? workdays.find(item => item.user_id === profile.id) || null : null;
            const employment = profile ? (profile.employment === 'fest' ? 'fest' : 'temporär') : '';
            const gender = profile?.gender || '';

            let state;
            if (current) state = 'unterwegs';
            else if (absence) state = 'abwesend';
            else if (!profile) state = 'frei';                                            // ohne Konto: steht im Tagesplan, also da
            else if (employment === 'fest' || profile.role !== 'dolmetscher') {
                state = answer?.status === 'nicht verfügbar' ? 'nichtda' : weekend && !jobs.total && !vehicle ? 'nichtda' : 'frei';
            } else if (answer?.status === 'verfügbar') state = 'frei';
            else if (answer?.status === 'nicht verfügbar') state = 'nichtda';
            else if (jobs.total || vehicle) state = 'frei';                               // eingeteilt oder mit Fahrzeug unterwegs: offensichtlich da
            else state = weekend && gender !== 'männlich' ? 'nichtda' : 'offen';

            return {
                id: profile?.id || null, key, name, phone: profile?.phone || '', role: profile?.role || '', employment, gender,
                noAccount: !profile, pushOn: profile ? pushOn.has(profile.id) : false, pushKnown,
                state, answer: answer?.status || '', answerNote: answer?.note || '', absence, late, vacationWaiting,
                jobs, responses, current, next, vehicle, sinceMinutes: current && isToday ? minutesSince(current.since) : null,
                records: mine, assignments: sent
            };
        }

        const everyone = [];
        const seen = new Set();
        profiles.filter(profile => profile.active && profile.role === 'dolmetscher').forEach(profile => { const person = build(profile); everyone.push(person); seen.add(person.key); });
        // Einsatzleitung oder Sekretariat, wenn sie an dem Tag selbst eingeteilt sind
        profiles.filter(profile => profile.active && profile.role !== 'dolmetscher' && recordsByName.has(nameKey(profile.full_name))).forEach(profile => { const person = build(profile); if (!seen.has(person.key)) { everyone.push(person); seen.add(person.key); } });
        // Namen aus dem Tagesplan ohne Portal-Konto
        recordsByName.forEach((entry, key) => { if (!seen.has(key)) { everyone.push(build(null, entry.name)); seen.add(key); } });

        // Gezeigt und gezählt werden die Personen mit Portal-Konto. Wer nur im Tagesplan steht (ohne Konto), wird
        // getrennt geführt und lässt sich in der Dolmetscher-Übersicht über „Ohne Konto“ einblenden.
        // Gibt es noch gar kein Konto, bleiben die Namen aus dem Tagesplan sichtbar.
        const withAccount = everyone.filter(person => !person.noAccount);
        const people = withAccount.length ? withAccount : everyone;
        const withoutAccount = withAccount.length ? everyone.filter(person => person.noAccount) : [];
        const counts = { all: people.length };
        STATES.forEach(state => { counts[state] = people.filter(person => person.state === state).length; });
        const dayCounts = { total: 0, offen: 0, unterwegs: 0, erledigt: 0, storniert: 0 };
        records.forEach(record => { dayCounts.total += 1; dayCounts[recordGroup(record)] += 1; });
        // Tagesanfrage: Wen betrifft sie, wer hat geantwortet?
        const eligible = people.filter(person => !person.noAccount && person.role === 'dolmetscher' && person.employment === 'temporär' && (!weekend || person.gender === 'männlich'));
        const ask = {
            eligible: eligible.length,
            yes: eligible.filter(person => person.answer === 'verfügbar').length,
            no: eligible.filter(person => person.answer === 'nicht verfügbar').length,
            open: eligible.filter(person => !person.answer)
        };
        const activeVehicles = vehicles.filter(vehicle => vehicle.active !== false);
        const outIds = new Set(handovers.map(item => item.vehicle_id));
        return {
            ok: true, ready, date, isToday, weekend, holiday: logic.holidayName(date), people, withoutAccount, counts, request, ask,
            gender: { weiblich: withAccount.filter(person => person.gender === 'weiblich').length, 'männlich': withAccount.filter(person => person.gender === 'männlich').length, unbekannt: withAccount.filter(person => !person.gender).length },
            employment: { fest: withAccount.filter(person => person.employment === 'fest').length, 'temporär': withAccount.filter(person => person.employment === 'temporär').length },
            day: records.length ? dayCounts : null,
            vehicles: isToday ? { total: activeVehicles.length, out: activeVehicles.filter(vehicle => outIds.has(vehicle.id)).length, service: activeVehicles.filter(vehicle => vehicle.service_status && !outIds.has(vehicle.id)).length,
                free: activeVehicles.filter(vehicle => !outIds.has(vehicle.id) && !vehicle.service_status).length } : null
        };
    }

    return { load, STATES, nameKey, recordGroup, recordTitle, minutesSince };
})();
