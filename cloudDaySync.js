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
    let lastNotes = null;         // appointment_id -> Hinweis des Dolmetschers (für die Anzeige eines neuen Hinweises)
    let pushTimer = null;
    let conflictAsked = '';
    let lastTyped = 0;            // letzter Tastendruck in der Tabelle (solange getippt wird, wird nicht dazwischen aufgefrischt)
    let newerChecked = 0;
    let closedSeen = '';
    const openState = {};         // Datum → war der Tag beim ersten Abgleich schon archiviert?
    const NEWER_SKIP_KEY = 'terminTool.cloudDay.skipNewer';
    document.addEventListener('input', event => { if (event.target?.closest?.('#tableBody')) lastTyped = Date.now(); }, true);
    document.addEventListener('keydown', event => { if (event.target?.closest?.('#tableBody')) lastTyped = Date.now(); }, true);
    let idsUnsaved = false;       // neue Kennungen sind noch nicht im Arbeitsstand dieses Tabs gespeichert

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
            if (!record._id) { record._id = crypto.randomUUID(); idsUnsaved = true; }
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
        // Steht der Cursor nur in einem Feld (seit 15 Sekunden nichts getippt), wird trotzdem aufgefrischt – sonst bliebe die Tabelle alt.
        const typing = document.activeElement?.matches?.('#tableBody input') && Date.now() - lastTyped < 15000;
        if (typing || document.querySelector('.modal[style*="block"]')) return false;
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

    // ---------- Arbeitet jemand anderes schon an einem neueren Tag? ----------
    // Jedes Gerät gleicht den Tag ab, der bei ihm geöffnet ist. Hat die Einsatzleitung inzwischen einen neuen Tag geladen,
    // sähe das Sekretariat sonst weiter die alte Tabelle. Ein vergangener Tag wird deshalb von selbst durch den aktuellen
    // ersetzt; bei zwei aktuellen Tagen (z. B. heute und morgen) erscheint ein Hinweis mit Knopf.
    function newerBanner(row) {
        let box = document.getElementById('cloudDayNewer');
        if (!row) { box?.remove(); return; }
        if (!box) {
            box = document.createElement('div');
            box.id = 'cloudDayNewer';
            box.className = 'cloud-day-newer';
            box.setAttribute('role', 'status');
            (document.querySelector('.fleet-table-wrap, #dataTable')?.parentElement || document.querySelector('main')).prepend(box);
        }
        const clock = new Date(row.updated_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const text = document.createElement('span');
        text.textContent = `Online gibt es einen neueren Tagesstand: ${formatFleetDate(row.date)} – zuletzt geändert um ${clock} Uhr${row.updated_by ? ` von ${row.updated_by}` : ''}. Du siehst gerade den ${formatFleetDate(currentDate())}.`;
        const load = document.createElement('button');
        load.type = 'button';
        load.className = 'button-primary';
        load.textContent = `Tag ${formatFleetDate(row.date)} laden`;
        load.addEventListener('click', async () => { load.disabled = true; if (await switchDay(row.date)) newerBanner(null); else load.disabled = false; });
        const stay = document.createElement('button');
        stay.type = 'button';
        stay.className = 'button-secondary';
        stay.textContent = 'Hier bleiben';
        stay.addEventListener('click', () => { try { sessionStorage.setItem(NEWER_SKIP_KEY, row.date); } catch (error) { /* gilt dann bis zum Neuladen */ } newerBanner(null); });
        box.replaceChildren(text, load, stay);
    }

    async function switchDay(date) {
        const { data, error } = await client.from('tt_days').select('*').eq('date', date).maybeSingle();
        if (error || !data?.records?.length) { if (error) showToast(TerminCloud.germanError(error), 'error'); return false; }
        lastTyped = 0;
        if (!applyLocal(data.records, data.deleted || {})) { showToast('Bitte zuerst das offene Fenster schließen – dann wird der Tag geladen.', 'info'); return false; }
        dayDate = ''; lastResponses = null; lastNotes = null; conflictAsked = date;
        showToast(`Tagesstand vom ${formatFleetDate(date)} geladen (${data.records.length} Termine).`, 'success', { duration: 9000 });
        window.setTimeout(syncDay, 300);
        return true;
    }

    async function checkNewerDay(date) {
        if (Date.now() - newerChecked < 6000) return;
        newerChecked = Date.now();
        const { data: rows, error } = await client.from('tt_days').select('date, updated_at, updated_by, archived').order('updated_at', { ascending: false }).limit(8);
        const data = (rows || []).filter(row => !row.archived || row.date === date);
        if (error || !data?.length) return;
        const today = TerminCloud.todayIso();
        const mine = data.find(row => row.date === date);
        // „Abgeschlossen“ zählt nur, wenn es passiert ist, während der Tag hier offen war. Wer einen archivierten Tag
        // bewusst aus dem Tagesarchiv öffnet, darf darin weiterarbeiten.
        if (!(date in openState)) openState[date] = Boolean(mine?.archived);
        const closedNow = Boolean(mine?.archived) && openState[date] === false;
        // Der zuletzt bearbeitete Tag – nur wenn er nicht in der Vergangenheit liegt und neuer ist als der Stand dieses Geräts.
        const newest = data.find(row => row.date !== date && !row.archived && row.date >= today && (!mine || row.updated_at > mine.updated_at || date < today || closedNow));
        if (!newest) {
            newerBanner(null);
            // Jemand hat diesen Tag abgeschlossen: hier ebenfalls schließen, damit niemand im archivierten Tag weiterarbeitet.
            if (closedNow && closedSeen !== `${date} ${mine.updated_at}`) {
                closedSeen = `${date} ${mine.updated_at}`;
                if (document.querySelector('.modal[style*="block"]')) { closedSeen = ''; return; }
                leaveDay();
                setStatus('Online: Tag abgeschlossen');
                showToast(`Der ${formatFleetDate(date)} wurde${mine.updated_by ? ` von ${mine.updated_by}` : ''} abgeschlossen und archiviert. Er steht im Tagesarchiv.`, 'info', { duration: 15000, keep: true });
            }
            return;
        }
        // Das Sekretariat folgt der Einsatzleitung: Lädt sie eine neue Datei oder einen neuen Tag, erscheint er hier von selbst.
        const follows = profile?.role === 'sekretariat' && !sameName(newest.updated_by, profile.full_name);
        if ((date < today && !mine?.archived) || closedNow || follows) {
            if (document.activeElement?.matches?.('#tableBody input') && Date.now() - lastTyped < 15000) { newerChecked = 0; return; }   // erst zu Ende tippen lassen
            // Alter oder schon abgeschlossener Tag auf diesem Gerät: Der ist schon online gesichert – den aktuellen Tag direkt zeigen.
            if (await switchDay(newest.date)) newerBanner(null);
            return;
        }
        let skipped = '';
        try { skipped = sessionStorage.getItem(NEWER_SKIP_KEY) || ''; } catch (error) { /* ohne Speicher wird erneut gefragt */ }
        if (skipped === newest.date) return;
        newerBanner(newest);
    }

    async function syncDay() {
        if (busy) return;
        busy = true;
        try {
            if (!(await loadProfile())) { setStatus(''); return; }
            let date = currentDate();
            // Kein lokaler Stand: den heutigen Online-Stand übernehmen (so sieht z. B. das Sekretariat sofort alles).
            if (!records().length) {
                let { data, error } = await client.from('tt_days').select('*').eq('date', TerminCloud.todayIso()).maybeSingle();
                // Für heute gibt es nichts, aber für einen kommenden Tag schon (z. B. der Plan für morgen): den zuletzt bearbeiteten zeigen.
                // Ein abgeschlossener (archivierter) Tag wird nicht von selbst wieder geöffnet – der steht im Tagesarchiv.
                if (!error && (!data?.records?.length || data.archived)) {
                    const next = await client.from('tt_days').select('*').gte('date', TerminCloud.todayIso()).order('updated_at', { ascending: false }).limit(6);
                    data = next.error ? null : (next.data || []).find(row => !row.archived && row.records?.length) || null;
                }
                if (error) { setStatus(`Online-Abgleich nicht möglich: ${TerminCloud.germanError(error)}`, 'error'); return; }
                if (data?.records?.length) {
                    applyLocal(data.records, data.deleted || {});
                    showWorkflowStatus(`${data.records.length} Termine aus dem Online-Stand vom ${formatFleetDate(data.date)} geladen.`);
                    date = currentDate();
                } else { setStatus('Online: noch kein Tagesstand'); return; }
            }
            if (!date) { setStatus('Online: Termine ohne Datum werden nicht abgeglichen'); return; }
            if (date !== dayDate) { dayDate = date; lastResponses = null; lastNotes = null; }

            const { data: cloud, error } = await client.from('tt_days').select('*').eq('date', date).maybeSingle();
            if (error) { setStatus(`Online-Abgleich nicht möglich: ${TerminCloud.germanError(error)}`, 'error'); return; }

            if (!(date in openState)) openState[date] = Boolean(cloud?.archived);
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
            // Die neu vergebenen Kennungen auch im Arbeitsstand dieses Tabs merken. Sonst gilt der Tag nach einem
            // Seitenwechsel wieder als „frisch geladen“ und es erscheint die Frage nach dem Online-Stand, obwohl
            // beide Stände gleich sind.
            if (idsUnsaved) { idsUnsaved = false; saveTerminRecords(records(), 'tracking'); }
            const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            setStatus(`Online gespeichert · ${time}${cloud?.archived ? ' · archiviert' : ''}`, 'success');
            await checkNewerDay(date);
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
        // Einsatzleitung und Sekretariat haben auch ein Konto – stehen sie selbst im Tagesplan, erscheinen sie unter „Dolmetscher heute“.
        window.trackingPeopleStaff = profiles.filter(item => item.active && item.role !== 'dolmetscher' && String(item.full_name || '').trim()).map(item => String(item.full_name).trim());
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
                showToast(`${assignment.interpreter_name} ist losgefahren: ${assignment.title}`, 'info', { duration: 10000, keep: true });
            }
            changed = true;
        }
        if (assignment.finished_at && record.Portal_Ende !== assignment.finished_at) {
            record.Portal_Ende = assignment.finished_at;
            if (['offen', 'losgefahren'].includes(String(record.Status || 'offen').trim().toLocaleLowerCase('de-DE'))) {
                record.Status = 'beendet';
                window.stampTrackingStatusTime?.(record, 'beendet', time(assignment.finished_at));
                showToast(`${assignment.interpreter_name} ist fertig und wieder frei: ${assignment.title}`, 'success', { duration: 15000, keep: true });
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
        // Vorschläge beim Eintragen eines Dolmetschers: nur registrierte, freigeschaltete Dolmetscher-Konten.
        window.setRegisteredInterpreters?.(profiles.filter(person => person.active && person.role === 'dolmetscher').map(person => person.full_name));
        publishPeople(workdayResult.error ? [] : workdayResult.data, absenceResult.error ? [] : absenceResult.data, date);
        const byAppointment = new Map(assignments.map(item => [item.appointment_id, item]));
        const responses = new Map();
        const notes = new Map();
        const accepted = new Map();   // Name → Aufträge, die in diesem Durchlauf zugesagt wurden („Zusage für den ganzen Tag“ = eine Anzeige)
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
            notes.set(assignment.appointment_id, assignment.response_note || '');
            const responseBefore = lastResponses ? lastResponses.get(assignment.appointment_id) : undefined;
            const noteText = assignment.response_note ? ` – „${assignment.response_note}“` : '';
            if (lastResponses && responseBefore !== assignment.response && assignment.response === 'zugesagt' && !assignment.response_note) {
                accepted.set(assignment.interpreter_name, [...(accepted.get(assignment.interpreter_name) || []), assignment.title]);
            } else if (lastResponses && responseBefore !== assignment.response && assignment.response !== 'offen') {
                showToast(`Termin · ${assignment.interpreter_name}: ${RESPONSE_TEXT[assignment.response]} für ${assignment.title}${noteText}`, assignment.response === 'abgesagt' ? 'error' : 'success', { duration: 12000, keep: true });
            } else if (lastResponses && responseBefore && responseBefore !== 'offen' && assignment.response === 'offen') {
                // Der Dolmetscher hat sich vertippt und seine Antwort zurückgenommen.
                showToast(`Termin · ${assignment.interpreter_name} hat die Antwort zurückgenommen: ${assignment.title}`, 'info', { duration: 12000, keep: true });
            } else if (lastNotes && lastNotes.has(assignment.appointment_id) && lastNotes.get(assignment.appointment_id) !== (assignment.response_note || '') && assignment.response_note) {
                // Neuer Hinweis, ohne dass sich die Antwort geändert hat (z. B. „Pat geht alleine“).
                showToast(`Termin · Hinweis von ${assignment.interpreter_name}: „${assignment.response_note}“ – ${assignment.title}`, 'info', { duration: 15000, keep: true });
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
        // Mehrere Zusagen derselben Person auf einmal (z. B. „Zusage für den ganzen Tag“) stehen in EINER Anzeige.
        accepted.forEach((titles, name) => {
            if (titles.length === 1) { showToast(`Termin · ${name}: ${RESPONSE_TEXT.zugesagt} für ${titles[0]}`, 'success', { duration: 12000, keep: true }); return; }
            const short = titles.map(title => title.split(' · ').slice(0, 2).join(' · '));
            showToast(`Termin · ${name}: Zusage für ${titles.length} Aufträge – ${short.slice(0, 4).join('; ')}${short.length > 4 ? ` und ${short.length - 4} weitere` : ''}`, 'success', { duration: 15000, keep: true });
        });
        lastResponses = responses;
        lastNotes = notes;
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
        if (!target) { showToast(`${name} hat kein freigeschaltetes Portal-Konto – der Auftrag kann nicht in die App gesendet werden. Konten schaltest du auf der Seite „Team“ frei.`, 'error'); return; }
        const date = currentDate();
        if (!date) { showToast('Der Termin hat kein Datum – der Auftrag kann nicht gesendet werden.', 'error'); return; }
        stamp();
        const time = String(record.Termin_Uhrzeit || '').slice(0, 5);
        // Der Name der Praxis kann in der Liste über zwei Zeilen gehen – in Titel und Mitteilung steht er in einer.
        const oneLine = value => window.TerminContact ? TerminContact.singleLine(value) : String(value || '').trim();
        const doctorName = oneLine(record['Arzt Nr::Name']);
        const place = oneLine(getAppointmentLocation(record));
        // Geht der Auftrag an eine andere Person als zuvor, beginnt er für sie neu (kein „schon losgefahren/fertig“ vom Vorgänger).
        const { data: previous } = await client.from('tt_assignments').select('*').eq('appointment_id', record._id).maybeSingle();
        const restart = previous && 'started_at' in previous && previous.interpreter_id !== target.id
            ? { started_at: null, finished_at: null, reminded_at: null, reminder_count: 0 } : {};
        if (restart.reminder_count === 0) { delete record.Portal_Start; delete record.Portal_Ende; }
        const { error } = await client.from('tt_assignments').upsert({
            ...restart,
            appointment_id: record._id, date, time, interpreter_id: target.id, interpreter_name: target.full_name,
            title: [time ? `${time} Uhr` : '', doctorName, place].filter(Boolean).join(' · '),
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
        TerminCloud.callFunction?.({ action: 'notify', audience: 'einzeln', recipientIds: [target.id], title: 'Neuer Auftrag', body: [date.split('-').reverse().join('.'), time ? `${time} Uhr` : '', doctorName, place].filter(Boolean).join(' · ') });
        syncDay();
    };

    // Gesendeten Auftrag dieses Termins holen (nur der gültige, nicht zurückgezogene).
    async function sentAssignment(index) {
        const record = records()[index];
        if (!record) return {};
        if (!(await loadProfile())) { showToast('Melde dich zuerst auf der Seite „Team“ als Einsatzleitung an.', 'error'); return {}; }
        const { data: assignment, error } = await client.from('tt_assignments').select('*').eq('appointment_id', record._id).maybeSingle();
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return {}; }
        if (!assignment || assignment.cancelled) { showToast('Für diesen Termin ist kein Auftrag (mehr) im Portal.', 'info'); record['Rückmeldung'] = ''; persistTerminRecords(records(), 'tracking'); window.refreshTrackingRows?.(); return {}; }
        return { record, assignment };
    }

    // Erinnern: Mitteilung aufs Handy und Nachricht im Portal – der Auftrag selbst bleibt unverändert.
    window.remindTrackingAssignment = async function (index, button) {
        if (button) button.disabled = true;
        try {
            const { assignment } = await sentAssignment(index);
            if (!assignment) return;
            const waiting = assignment.response === 'offen';
            const body = waiting ? `Erinnerung: Bitte antworte auf den Auftrag ${assignment.title} (${formatFleetDate(assignment.date)}).` : `Erinnerung an deinen Auftrag ${assignment.title} (${formatFleetDate(assignment.date)}).`;
            const { error } = await client.from('tt_messages').insert({ sender_id: profile.id, sender_name: profile.full_name || 'Einsatzleitung', audience: 'einzeln', recipient_ids: [assignment.interpreter_id], body });
            if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
            const push = await TerminCloud.callFunction?.({ action: 'notify', audience: 'einzeln', recipientIds: [assignment.interpreter_id], title: waiting ? 'Erinnerung: Auftrag wartet auf Antwort' : 'Erinnerung an deinen Auftrag', body: `${formatFleetDate(assignment.date)} · ${assignment.title}` });
            showToast(`Erinnerung an ${assignment.interpreter_name} gesendet – ${push?.ok && push.data?.sent ? 'als Mitteilung aufs Handy und als Nachricht im Portal.' : 'als Nachricht im Portal (Mitteilungen aufs Handy sind dort nicht eingeschaltet).'}`, 'success', { duration: 9000 });
        } finally { if (button) button.disabled = false; }
    };

    // Zurückziehen: Der Auftrag verschwindet im Portal. Der Termin und der eingetragene Name bleiben in der Liste.
    window.withdrawTrackingAssignment = async function (index, button) {
        const { record, assignment } = await sentAssignment(index);
        if (!assignment) return;
        const running = assignment.started_at && !assignment.finished_at;
        const answer = { zugesagt: ' Er wurde schon zugesagt.', vorbehalt: ' Er wurde unter Vorbehalt angenommen.', abgesagt: ' Er wurde abgesagt.' }[assignment.response] || '';
        if (!await confirmDialog(`Den Auftrag ${assignment.title} von ${assignment.interpreter_name} zurückziehen?${answer}${running ? `\n\n${assignment.interpreter_name} ist für diesen Auftrag schon losgefahren.` : ''}\n\nDer Auftrag verschwindet im Portal, ${assignment.interpreter_name} bekommt eine Mitteilung. Der Termin bleibt in deiner Liste.`, 'Auftrag zurückziehen')) return;
        const { error } = await client.from('tt_assignments').update({ cancelled: true }).eq('id', assignment.id);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        const before = record['Rückmeldung'];
        record['Rückmeldung'] = '';
        persistTerminRecords(records(), 'tracking');
        window.refreshTrackingRows?.();
        TerminCloud.callFunction?.({ action: 'notify', audience: 'einzeln', recipientIds: [assignment.interpreter_id], title: 'Auftrag zurückgezogen', body: `${formatFleetDate(assignment.date)} · ${assignment.title} – dieser Auftrag gilt nicht mehr.` });
        showToast(`Auftrag von ${assignment.interpreter_name} zurückgezogen.`, 'success', { duration: 12000, actionLabel: 'Rückgängig', onAction: async () => {
            const { error: undoError } = await client.from('tt_assignments').update({ cancelled: false }).eq('id', assignment.id);
            if (undoError) { showToast(TerminCloud.germanError(undoError), 'error'); return; }
            record['Rückmeldung'] = before;
            persistTerminRecords(records(), 'tracking');
            window.refreshTrackingRows?.();
            showToast(`Der Auftrag steht wieder im Portal von ${assignment.interpreter_name}.`, 'success');
            syncDay();
        } });
        syncDay();
    };

    // Tag abschließen: online archivieren, hier schließen – danach ist Platz für die nächste Excel-Datei.
    window.closeTrackingDay = async function () {
        if (!(await loadProfile())) { showToast('Zum Abschließen bitte zuerst online anmelden (Seite „Team“).', 'error'); return; }
        const date = currentDate();
        const list = records();
        if (!date || !list.length) { showToast('Es gibt keinen Tag zum Abschließen.', 'error'); return; }
        const group = record => String(record.Status || 'offen').trim().toLocaleLowerCase('de-DE');
        const open = list.filter(record => group(record) === 'offen').length;
        const running = list.filter(record => group(record) === 'losgefahren').length;
        const rest = [open ? `${open} ${open === 1 ? 'Termin ist' : 'Termine sind'} noch offen` : '', running ? `${running} ${running === 1 ? 'ist' : 'sind'} noch unterwegs` : ''].filter(Boolean).join(', ');
        if (!await confirmDialog(`Den ${formatFleetDate(date)} abschließen (${list.length} Termine)?${rest ? `\n\nAchtung: ${rest}.` : ''}\n\nDer Tag wird online archiviert und verschwindet hier – auch bei den anderen Geräten. Du findest ihn weiter im Tagesarchiv. Danach kannst du eine neue Excel-Datei laden.`, 'Tag abschließen')) return;
        await syncDay();
        const { error } = await client.from('tt_days').update({ archived: true, archived_at: new Date().toISOString(), archived_by: profile.full_name || '', updated_at: new Date().toISOString(), updated_by: profile.full_name || '' }).eq('date', date);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        leaveDay();
        try { sessionStorage.setItem('terminTool.dayClosed', `Der ${formatFleetDate(date)} ist abgeschlossen und archiviert (${list.length} Termine). Du kannst jetzt eine neue Excel-Datei laden.`); } catch (error) { /* dann ohne Meldung auf der nächsten Seite */ }
        location.href = 'termineFiltern.html';
    };

    // Tabelle auf diesem Gerät leeren (der Tag bleibt online erhalten).
    function leaveDay() {
        deleted = {};
        known.clear();
        dayDate = ''; lastResponses = null; lastNotes = null;
        window.applyRemoteTrackingRecords([]);
        try { const flow = JSON.parse(sessionStorage.getItem('terminTool.workflow.v1') || '{}'); sessionStorage.setItem('terminTool.workflow.v1', JSON.stringify({ step: flow.step })); } catch (error) { /* nichts gespeichert */ }
    }

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
