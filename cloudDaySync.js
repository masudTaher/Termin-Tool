// Live-Tracking online: gemeinsamer Tagesstand für alle Admins (z. B. Einsatzleitung und Sekretariat),
// Aufträge an Dolmetscher mit Rückmeldung und das Online-Archiv.
// Ohne Admin-Anmeldung passiert hier nichts – das Live-Tracking arbeitet dann wie bisher lokal.
(function () {
    if (typeof TerminCloud === 'undefined' || !TerminCloud.available) return;
    const client = TerminCloud.client;
    const RESPONSE_TEXT = { offen: 'gesendet', zugesagt: 'Zusage', vorbehalt: 'Unter Vorbehalt', abgesagt: 'Absage' };
    const known = new Map();      // _id -> Inhalt beim letzten Abgleich
    let deleted = {};             // _id -> Zeitpunkt des Löschens
    let profile = null;
    let profiles = [];
    let busy = false;
    let dayDate = '';
    let lastResponses = null;     // appointment_id -> response (für Hinweise bei neuen Antworten)
    let pushTimer = null;
    let conflictAsked = '';

    const records = () => window.getTrackingRecords();
    const contentKey = record => JSON.stringify(Object.keys(record).filter(key => !key.startsWith('_')).sort().map(key => [key, record[key]]));
    const sameName = (left, right) => String(left || '').trim().toLocaleLowerCase('de') === String(right || '').trim().toLocaleLowerCase('de');

    function setStatus(text, kind = 'info') {
        const status = document.getElementById('cloudDayStatus');
        if (!status) return;
        status.hidden = !text;
        status.textContent = text;
        status.dataset.kind = kind;
    }

    function currentDate() {
        const value = records().map(record => record.Termin_Datum).find(Boolean);
        return value ? normalizeFleetDate(String(value)) : '';
    }

    // Vergibt Kennungen und merkt sich, welche Termine sich geändert haben.
    function stamp() {
        const now = new Date().toISOString();
        const ids = new Set();
        records().forEach(record => {
            if (!record._id) record._id = crypto.randomUUID();
            ids.add(record._id);
            const key = contentKey(record);
            if (deleted[record._id]) { delete deleted[record._id]; record._updatedAt = now; }
            if (known.get(record._id) !== key) {
                if (known.has(record._id) || !record._updatedAt) record._updatedAt = now;
                known.set(record._id, key);
            }
        });
        [...known.keys()].forEach(id => { if (!ids.has(id)) { deleted[id] = now; known.delete(id); } });
    }

    function merge(local, cloudRecords, cloudDeleted) {
        const localById = new Map(local.map(record => [record._id, record]));
        const cloudById = new Map((cloudRecords || []).map(record => [record._id, record]));
        const tombstones = { ...cloudDeleted };
        Object.entries(deleted).forEach(([id, time]) => { if (!tombstones[id] || tombstones[id] < time) tombstones[id] = time; });
        const merged = [];
        let localChanged = false;
        let cloudChanged = JSON.stringify(tombstones) !== JSON.stringify(cloudDeleted || {});
        new Set([...localById.keys(), ...cloudById.keys()]).forEach(id => {
            const mine = localById.get(id);
            const theirs = cloudById.get(id);
            const pick = !theirs ? mine : !mine ? theirs : (String(theirs._updatedAt || '') > String(mine._updatedAt || '') ? theirs : mine);
            if (tombstones[id] && tombstones[id] >= String(pick._updatedAt || '')) {
                if (mine) localChanged = true;
                if (theirs) cloudChanged = true;
                return;
            }
            delete tombstones[id];
            merged.push(pick);
            if (!mine || String(pick._updatedAt || '') !== String(mine._updatedAt || '')) localChanged = true;
            if (!theirs || String(pick._updatedAt || '') !== String(theirs._updatedAt || '')) cloudChanged = true;
        });
        return { merged, tombstones, localChanged, cloudChanged };
    }

    function applyLocal(merged, tombstones) {
        // Nicht dazwischenfunken, solange in der Tabelle getippt wird – der nächste Durchlauf holt es nach.
        if (document.activeElement?.matches?.('#tableBody input') || document.querySelector('.modal[style*="block"]')) return false;
        deleted = tombstones;
        known.clear();
        merged.forEach(record => known.set(record._id, contentKey(record)));
        window.applyRemoteTrackingRecords(merged);
        return true;
    }

    async function loadProfile() {
        try { profile = await TerminCloud.getProfile(); } catch (error) { profile = null; }
        return TerminCloud.isStaff(profile);
    }

    async function syncDay() {
        if (busy) return;
        busy = true;
        try {
            if (!(await loadProfile())) { setStatus(''); return; }
            let date = currentDate();
            // Kein lokaler Stand: den heutigen Online-Stand übernehmen (so sieht z. B. das Sekretariat sofort alles).
            if (!records().length) {
                const { data, error } = await client.from('tt_days').select('*').eq('date', TerminCloud.todayIso()).maybeSingle();
                if (error) { setStatus(`Online-Abgleich nicht möglich: ${TerminCloud.germanError(error)}`, 'error'); return; }
                if (data?.records?.length) {
                    applyLocal(data.records, data.deleted || {});
                    showWorkflowStatus(`${data.records.length} Termine aus dem Online-Stand von heute geladen.`);
                    date = currentDate();
                } else { setStatus('Online: noch kein Tagesstand'); return; }
            }
            if (!date) { setStatus('Online: Termine ohne Datum werden nicht abgeglichen'); return; }
            if (date !== dayDate) { dayDate = date; lastResponses = null; }

            const { data: cloud, error } = await client.from('tt_days').select('*').eq('date', date).maybeSingle();
            if (error) { setStatus(`Online-Abgleich nicht möglich: ${TerminCloud.germanError(error)}`, 'error'); return; }

            // Frisch geladene Datei, online gibt es den Tag aber schon: einmal nachfragen statt doppelte Termine zu erzeugen.
            const fresh = records().every(record => !record._id);
            if (fresh && cloud?.records?.length && conflictAsked !== date) {
                conflictAsked = date;
                const useCloud = await confirmDialog(`Für den ${formatFleetDate(date)} gibt es schon einen Online-Stand mit ${cloud.records.length} Terminen. Welchen Stand möchtest du verwenden?`, 'Online-Stand laden', 'Meinen Stand hochladen');
                if (useCloud) { applyLocal(cloud.records, cloud.deleted || {}); }
                else {
                    stamp();
                    const replaced = {};
                    cloud.records.forEach(record => { replaced[record._id] = new Date().toISOString(); });
                    deleted = { ...(cloud.deleted || {}), ...replaced };
                }
            }

            stamp();
            const result = merge(records(), cloud?.records, cloud?.deleted || {});
            if (result.localChanged && !applyLocal(result.merged, result.tombstones)) { setStatus('Online: Änderungen warten, bis du fertig getippt hast'); return; }
            if (!result.localChanged) deleted = result.tombstones;
            await syncAssignments(date);
            stamp();
            const final = merge(records(), cloud?.records, cloud?.deleted || {});
            if (final.cloudChanged || !cloud) {
                const { error: pushError } = await client.from('tt_days').upsert({
                    date, records: final.merged, deleted: final.tombstones,
                    updated_at: new Date().toISOString(), updated_by: profile.full_name || ''
                }, { onConflict: 'date' });
                if (pushError) { setStatus(`Online-Speichern nicht möglich: ${TerminCloud.germanError(pushError)}`, 'error'); return; }
            }
            const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            setStatus(`Online gespeichert · ${time}${cloud?.archived ? ' · archiviert' : ''}`, 'success');
        } catch (error) {
            setStatus(`Online-Abgleich nicht möglich: ${TerminCloud.germanError(error)}`, 'error');
        } finally {
            busy = false;
        }
    }

    // ---------- Dolmetscher aus dem Portal ----------
    // Jeder freigeschaltete Dolmetscher steht automatisch in der Dolmetscherliste (Vorschläge beim Eintippen).
    // Wer heute arbeiten kann (fest angestellt oder Tag als „verfügbar“ gemeldet), erscheint unter „Dolmetscher heute“.
    // Wer an dem Tag Urlaub hat, krank ist oder einen Notfall gemeldet hat, steht dort unter „Abwesend“.
    function publishPeople(workdays, absences, date) {
        const available = new Map((workdays || []).map(item => [item.user_id, item.status]));
        const away = new Map();
        if (window.AbsenceLogic) (absences || []).forEach(item => { if (AbsenceLogic.blocksDay(item, date)) away.set(item.profile_id, item); });
        const interpreters = profiles.filter(item => item.active && item.role === 'dolmetscher' && String(item.full_name || '').trim());
        if (typeof addInterpreterName === 'function') interpreters.forEach(item => addInterpreterName(item.full_name));
        window.trackingPeopleOnline = interpreters
            .filter(item => !away.has(item.id))
            .filter(item => item.employment === 'fest' ? available.get(item.id) !== 'nicht verfügbar' : available.get(item.id) === 'verfügbar')
            .map(item => ({ name: String(item.full_name).trim(), employment: item.employment, gender: item.gender || '' }));
        window.trackingPeopleAway = interpreters.filter(item => away.has(item.id))
            .map(item => ({ name: String(item.full_name).trim(), gender: item.gender || '', reason: AbsenceLogic.awayText(away.get(item.id), date) }));
        // Angabe weiblich/männlich für alle Konten – auch für Personen, die heute nicht als verfügbar gemeldet sind
        window.trackingPeopleGender = new Map(interpreters.map(item => [String(item.full_name).trim().toLocaleLowerCase('de'), item.gender || '']));
        window.refreshInterpreterLoad?.();
    }

    // Übernimmt eine Meldung des Dolmetschers in den Termin. Die Uhrzeit der Meldung wird im Termin gemerkt,
    // damit sie nicht erneut greift, wenn die Einsatzleitung den Status danach von Hand ändert.
    function applyProgress(record, assignment) {
        const time = value => new Date(value).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const status = String(record.Status || 'offen').trim().toLocaleLowerCase('de-DE');
        let changed = false;
        if (assignment.started_at && record.Portal_Start !== assignment.started_at) {
            record.Portal_Start = assignment.started_at;
            if (status === 'offen') {
                record.Status = 'losgefahren';
                window.stampTrackingStatusTime?.(record, 'losgefahren', time(assignment.started_at));
                showToast(`${assignment.interpreter_name} ist losgefahren: ${assignment.title}`, 'info', { duration: 10000 });
            }
            changed = true;
        }
        if (assignment.finished_at && record.Portal_Ende !== assignment.finished_at) {
            record.Portal_Ende = assignment.finished_at;
            if (['offen', 'losgefahren'].includes(String(record.Status || 'offen').trim().toLocaleLowerCase('de-DE'))) {
                record.Status = 'beendet';
                window.stampTrackingStatusTime?.(record, 'beendet', time(assignment.finished_at));
                showToast(`${assignment.interpreter_name} ist fertig und wieder frei: ${assignment.title}`, 'success', { duration: 15000 });
                if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
                    try { new Notification('Dolmetscher wieder frei', { body: `${assignment.interpreter_name} ist fertig: ${assignment.title}` }); } catch (error) { /* nur als Einblendung */ }
                }
            }
            changed = true;
        }
        return changed;
    }

    // ---------- Aufträge ----------
    async function syncAssignments(date) {
        const [{ data: assignments, error }, profileResult, workdayResult, absenceResult] = await Promise.all([
            client.from('tt_assignments').select('*').eq('date', date),
            client.from('tt_profiles').select('*'),
            client.from('tt_workdays').select('user_id, status').eq('date', date),
            client.from('tt_absences').select('profile_id, kind, date_from, date_to, status, minutes').lte('date_from', date).gte('date_to', date)
        ]);
        if (error) return;
        profiles = profileResult.data || [];
        publishPeople(workdayResult.error ? [] : workdayResult.data, absenceResult.error ? [] : absenceResult.data, date);
        const byAppointment = new Map(assignments.map(item => [item.appointment_id, item]));
        const responses = new Map();
        let changed = false;
        for (const record of records()) {
            const assignment = byAppointment.get(record._id);
            if (!assignment || assignment.cancelled) {
                if (record['Rückmeldung']) { record['Rückmeldung'] = ''; changed = true; }
                continue;
            }
            // Dolmetscher wurde nach dem Senden geändert: der alte Auftrag gilt nicht mehr.
            if (!sameName(assignment.interpreter_name, record.Übersetzer)) {
                await client.from('tt_assignments').update({ cancelled: true }).eq('id', assignment.id);
                if (record['Rückmeldung']) { record['Rückmeldung'] = ''; changed = true; }
                continue;
            }
            const text = RESPONSE_TEXT[assignment.response] + (assignment.response_note ? ` – ${assignment.response_note}` : '');
            if (record['Rückmeldung'] !== text) { record['Rückmeldung'] = text; changed = true; }
            responses.set(assignment.appointment_id, assignment.response);
            if (lastResponses && lastResponses.get(assignment.appointment_id) !== assignment.response && assignment.response !== 'offen') {
                showToast(`${assignment.interpreter_name}: ${RESPONSE_TEXT[assignment.response]} für ${assignment.title}`, assignment.response === 'abgesagt' ? 'error' : 'success', { duration: 12000 });
            }
            // „Losfahren“ und „Fertig“ aus dem Portal: jede Meldung wird genau einmal in den Tagesstand übernommen.
            if (applyProgress(record, assignment)) changed = true;
            const workStatus = String(record.Status || 'offen');
            if (assignment.work_status !== workStatus) {
                const update = { work_status: workStatus };
                // Von der Einsatzleitung auf „losgefahren“ gesetzt: ab jetzt läuft die Uhr für die Erinnerung „bitte Fertig melden“.
                if (workStatus.trim().toLocaleLowerCase('de-DE') === 'losgefahren' && 'started_at' in assignment && !assignment.started_at) {
                    update.started_at = new Date().toISOString();
                    record.Portal_Start = update.started_at;
                }
                await client.from('tt_assignments').update(update).eq('id', assignment.id);
            }
        }
        // Gelöschte Termine: Auftrag zurückziehen.
        const ids = new Set(records().map(record => record._id));
        for (const assignment of assignments) {
            if (!assignment.cancelled && !ids.has(assignment.appointment_id)) await client.from('tt_assignments').update({ cancelled: true }).eq('id', assignment.id);
        }
        lastResponses = responses;
        if (changed) window.refreshTrackingRows?.();
    }

    window.sendTrackingAssignment = async function (index) {
        const record = records()[index];
        if (!record) return;
        if (!(await loadProfile())) { showToast('Melde dich zuerst auf der Seite „Team“ als Einsatzleitung an, um Aufträge zu senden.', 'error'); return; }
        const name = getAppointmentInterpreterName(record);
        if (!name) { showToast('Bitte trage zuerst den Dolmetscher oder die Dolmetscherin ein.', 'error'); return; }
        if (!profiles.length) profiles = (await client.from('tt_profiles').select('id, full_name, active, role, employment')).data || [];
        const target = profiles.find(item => item.active && sameName(item.full_name, name));
        if (!target) { showToast(`${name} hat kein freigeschaltetes Portal-Konto. Nutze für diesen Auftrag WhatsApp.`, 'error'); return; }
        const date = currentDate();
        if (!date) { showToast('Der Termin hat kein Datum – der Auftrag kann nicht gesendet werden.', 'error'); return; }
        stamp();
        const time = String(record.Termin_Uhrzeit || '').slice(0, 5);
        // Geht der Auftrag an eine andere Person als zuvor, beginnt er für sie neu (kein „schon losgefahren/fertig“ vom Vorgänger).
        const { data: previous } = await client.from('tt_assignments').select('*').eq('appointment_id', record._id).maybeSingle();
        const restart = previous && 'started_at' in previous && previous.interpreter_id !== target.id
            ? { started_at: null, finished_at: null, reminded_at: null, reminder_count: 0 } : {};
        if (restart.reminder_count === 0) { delete record.Portal_Start; delete record.Portal_Ende; }
        const { error } = await client.from('tt_assignments').upsert({
            ...restart,
            appointment_id: record._id, date, time, interpreter_id: target.id, interpreter_name: target.full_name,
            title: [time ? `${time} Uhr` : '', record['Arzt Nr::Name'], getAppointmentLocation(record)].filter(Boolean).join(' · '),
            message: createWhatsAppAppointmentMessage(record, true),
            response: 'offen', response_note: '', responded_at: null, cancelled: false,
            work_status: String(record.Status || 'offen'), sent_at: new Date().toISOString(), sent_by: profile.full_name || ''
        }, { onConflict: 'appointment_id' });
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        record['Rückmeldung'] = RESPONSE_TEXT.offen;
        persistTerminRecords(records(), 'tracking');
        window.refreshTrackingRows?.();
        showToast(`Auftrag an ${target.full_name} gesendet`, 'success');
        // Zusätzlich als Mitteilung aufs Handy (falls eingerichtet und von der Person eingeschaltet).
        TerminCloud.callFunction?.({ action: 'notify', audience: 'einzeln', recipientIds: [target.id], title: 'Neuer Auftrag', body: [date.split('-').reverse().join('.'), time ? `${time} Uhr` : '', record['Arzt Nr::Name'], getAppointmentLocation(record)].filter(Boolean).join(' · ') });
        syncDay();
    };

    window.archiveTrackingDay = async function () {
        if (!(await loadProfile())) { showToast('Melde dich zuerst auf der Seite „Team“ als Einsatzleitung an.', 'error'); return; }
        const date = currentDate();
        if (!date || !records().length) { showToast('Es gibt keinen Tag zum Archivieren.', 'error'); return; }
        await syncDay();
        const { error } = await client.from('tt_days').update({ archived: true, archived_at: new Date().toISOString(), archived_by: profile.full_name || '' }).eq('date', date);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        showToast(`Der ${formatFleetDate(date)} ist online archiviert (${records().length} Termine).`, 'success');
        setStatus(`Online gespeichert · archiviert`, 'success');
    };

    function formatFleetDate(value) {
        const [year, month, day] = String(value).split('-');
        return `${day}.${month}.${year}`;
    }

    // Jede lokale Änderung wird kurz danach hochgeladen.
    const originalPersist = window.persistTerminRecords;
    window.persistTerminRecords = function (...args) {
        const saved = originalPersist(...args);
        window.clearTimeout(pushTimer);
        pushTimer = window.setTimeout(syncDay, 1200);
        return saved;
    };

    window.syncTrackingDayNow = syncDay;
    window.refreshTrackingRows?.();   // blendet die „Auftrag“-Knöpfe ein
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncDay(); });
    window.setInterval(() => { if (!document.hidden) syncDay(); }, 8000);
    syncDay();
})();
