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

    // ---------- Zwischen den Tagen wechseln (z. B. heute ↔ morgen) ----------
    // Sind online mehrere nicht abgeschlossene Tage ab heute vorhanden, steht über der Tabelle je Tag ein Knopf.
    // So lässt sich nachmittags schon der morgige Tag verteilen und mit einem Tipp zum heutigen zurückkehren.
    function daySwitch(rows, date) {
        let box = document.getElementById('cloudDaySwitch');
        const today = TerminCloud.todayIso();
        const days = [...new Set(rows.filter(row => !row.archived && (row.date >= today || row.date === date)).map(row => row.date))].sort();
        if (days.length < 2 || !days.includes(date)) { box?.remove(); return; }
        if (!box) {
            box = document.createElement('div');
            box.id = 'cloudDaySwitch';
            box.className = 'cloud-day-switch';
            box.setAttribute('role', 'group');
            box.setAttribute('aria-label', 'Zwischen den Tagen wechseln');
            (document.querySelector('.fleet-table-wrap, #dataTable')?.parentElement || document.querySelector('main')).prepend(box);
        }
        const tomorrowDate = new Date(`${today}T00:00:00`); tomorrowDate.setDate(tomorrowDate.getDate() + 1);
        const tomorrow = `${tomorrowDate.getFullYear()}-${String(tomorrowDate.getMonth() + 1).padStart(2, '0')}-${String(tomorrowDate.getDate()).padStart(2, '0')}`;
        const label = el => el === today ? 'Heute' : el === tomorrow ? 'Morgen' : new Date(`${el}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'long' });
        const title = document.createElement('span');
        title.className = 'cloud-day-switch-title';
        title.textContent = 'Tag:';
        box.replaceChildren(title, ...days.map(day => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'cloud-day-button';
            button.dataset.date = day;
            button.setAttribute('aria-pressed', String(day === date));
            button.textContent = `${label(day)} · ${formatFleetDate(day).slice(0, 6)}`;
            button.title = day === date ? 'Dieser Tag ist gerade geöffnet' : `Zum ${formatFleetDate(day)} wechseln – der jetzige Tag bleibt online gespeichert`;
            button.addEventListener('click', async () => {
                if (day === currentDate()) return;
                box.querySelectorAll('button').forEach(node => { node.disabled = true; });
                const from = currentDate();
                await syncDay();                                   // erst den offenen Tag sichern
                // Der verlassene Tag soll danach nicht als „neuerer Tagesstand“ gemeldet werden.
                try { sessionStorage.setItem(NEWER_SKIP_KEY, from); } catch (error) { /* dann erscheint der Hinweis einmal */ }
                if (await switchDay(day)) { newerBanner(null); newerChecked = 0; }
                box.querySelectorAll('button').forEach(node => { node.disabled = false; });
            });
            return button;
        }));
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
        daySwitch(data, date);
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
    // „Patient geht alleine“ ist kein Ausfall: Der Termin findet statt, nur ohne Dolmetscher → Status „alleine“ statt „storniert“.
    const stornoAlone = assignment => /geht\s+allein/i.test(assignment?.storno_note || '');
    const stornoStatus = assignment => stornoAlone(assignment) ? 'alleine' : 'storniert';
    function applyProgress(record, assignment) {
        const time = value => new Date(value).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const status = String(record.Status || 'offen').trim().toLocaleLowerCase('de-DE');
        let changed = false;
        // „Termin fällt aus“ aus dem Portal (mit Grund): Der Termin steht von selbst auf „Storniert“, der Dolmetscher ist frei.
        // Ein dabei gesetztes Ende (er war schon losgefahren) löst keine zweite Meldung „ist fertig“ aus.
        const stornoEnd = Boolean(assignment.storno_at) && assignment.finished_at === assignment.storno_at;
        const alone = stornoAlone(assignment);
        const closedStatus = stornoStatus(assignment);
        const closedLabel = alone ? 'Patient geht alleine' : 'Termin fällt aus';
        if (assignment.storno_at && record.Portal_Storno !== assignment.storno_at) {
            record.Portal_Storno = assignment.storno_at;
            if (!['offen', 'losgefahren', closedStatus].includes(status)) {
                // Der Termin steht hier schon auf einem anderen Endstand (z. B. „beendet“): nichts überschreiben, nur Bescheid geben.
                showToast(`Termin · ${assignment.interpreter_name} meldet „${alone ? 'Patient geht alleine' : 'fällt aus'}“ für ${assignment.title}${assignment.storno_note ? ` – „${assignment.storno_note}“` : ''}. Bei dir steht der Termin schon auf „${record.Status}“ – bitte prüfen.`, 'info', { duration: 20000, keep: true });
            } else if (status !== closedStatus) {
                record.Status = closedStatus;
                showToast(`${closedLabel} · ${assignment.interpreter_name}: ${assignment.title}${assignment.storno_note && !alone ? ` – „${assignment.storno_note}“` : ''}`, alone ? 'info' : 'error', { duration: 20000, keep: true });
                if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
                    try { new Notification(closedLabel, { body: `${assignment.interpreter_name}: ${assignment.title}${assignment.storno_note ? ` – ${assignment.storno_note}` : ''}` }); } catch (error) { /* nur als Einblendung */ }
                }
            }
            changed = true;
        } else if (!assignment.storno_at && record.Portal_Storno) {
            // Der Dolmetscher hat die Stornierung zurückgenommen: der Termin läuft weiter wie vorher.
            delete record.Portal_Storno;
            if (status === 'storniert' || status === 'alleine') {
                record.Status = assignment.finished_at ? 'beendet' : assignment.started_at ? 'losgefahren' : 'offen';
                showToast(`Termin · ${assignment.interpreter_name} hat die Stornierung zurückgenommen: ${assignment.title}`, 'info', { duration: 15000, keep: true });
            }
            changed = true;
        }
        if (stornoEnd) {
            if (assignment.started_at && record.Portal_Start !== assignment.started_at) { record.Portal_Start = assignment.started_at; changed = true; }
            if (record.Portal_Ende !== assignment.finished_at) { record.Portal_Ende = assignment.finished_at; changed = true; }
            return changed;
        }
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
            const text = assignment.storno_at
                ? (stornoAlone(assignment)
                    ? `Geht alleine${/^patient geht alleine$/i.test(String(assignment.storno_note).trim()) ? '' : ` – ${assignment.storno_note}`}`
                    : `Fällt aus${assignment.storno_note ? ` – ${assignment.storno_note}` : ''}`)
                : RESPONSE_TEXT[assignment.response] + (assignment.response_note ? ` – ${assignment.response_note}` : '');
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
            // Die Einsatzleitung hat einen im Portal stornierten Termin wieder geöffnet: Die Stornierung gilt nicht mehr.
            const reopened = Boolean(assignment.storno_at) && workStatus.trim().toLocaleLowerCase('de-DE') !== stornoStatus(assignment);
            if (reopened) { delete record.Portal_Storno; changed = true; }
            if (assignment.work_status !== workStatus || reopened) {
                const update = { work_status: workStatus };
                if (reopened) Object.assign(update, { storno_at: null, storno_note: '' }, assignment.finished_at === assignment.storno_at ? { finished_at: null } : {});
                // Von der Einsatzleitung auf „losgefahren“ gesetzt: ab jetzt läuft die Uhr für die Erinnerung „bitte Fertig melden“.
                if (workStatus.trim().toLocaleLowerCase('de-DE') === 'losgefahren' && 'started_at' in assignment && !assignment.started_at) {
                    update.started_at = new Date().toISOString();
                    record.Portal_Start = update.started_at;
                }
                await client.from('tt_assignments').update(update).eq('id', assignment.id);
            }
        }
        // Zweite Person im Auftrag: eigene Rückmeldung, eigenes „Losfahren“ und „Fertig“. Der Stand des Termins folgt der ersten Person.
        for (const record of records()) {
            if (!record._id2) continue;
            const assignment = byAppointment.get(record._id2);
            const clear = () => { if (record._zweitAntwort) { delete record._zweitAntwort; changed = true; } };
            if (!assignment || assignment.cancelled) { clear(); continue; }
            if (!record._zweit || !sameName(assignment.interpreter_name, record._zweit)) {
                await client.from('tt_assignments').update({ cancelled: true }).eq('id', assignment.id);
                clear();
                continue;
            }
            const text = assignment.storno_at ? `Fällt aus${assignment.storno_note ? ` – ${assignment.storno_note}` : ''}`
                : RESPONSE_TEXT[assignment.response] + (assignment.response_note ? ` – ${assignment.response_note}` : '');
            if (record._zweitAntwort !== text) { record._zweitAntwort = text; changed = true; }
            responses.set(assignment.appointment_id, assignment.response);
            const before = lastResponses ? lastResponses.get(assignment.appointment_id) : undefined;
            if (lastResponses && before !== assignment.response && assignment.response !== 'offen') {
                showToast(`Termin · ${assignment.interpreter_name} (2. Person, ${record._zweitAufgabe || 'Transport'}): ${RESPONSE_TEXT[assignment.response]} für ${assignment.title}${assignment.response_note ? ` – „${assignment.response_note}“` : ''}`, assignment.response === 'abgesagt' ? 'error' : 'success', { duration: 12000, keep: true });
            } else if (lastResponses && before && before !== 'offen' && assignment.response === 'offen') {
                showToast(`Termin · ${assignment.interpreter_name} (2. Person) hat die Antwort zurückgenommen: ${assignment.title}`, 'info', { duration: 12000, keep: true });
            }
            if (assignment.started_at && record._zweitStart !== assignment.started_at) {
                record._zweitStart = assignment.started_at;
                if (lastResponses) showToast(`${assignment.interpreter_name} (2. Person) ist losgefahren: ${assignment.title}`, 'info', { duration: 10000, keep: true });
                changed = true;
            }
            if (assignment.finished_at && record._zweitEnde !== assignment.finished_at) {
                record._zweitEnde = assignment.finished_at;
                if (lastResponses && !assignment.storno_at) showToast(`${assignment.interpreter_name} (2. Person) ist fertig und wieder frei: ${assignment.title}`, 'success', { duration: 12000, keep: true });
                changed = true;
            }
            if (assignment.storno_at && record._zweitStorno !== assignment.storno_at) {
                record._zweitStorno = assignment.storno_at;
                if (lastResponses) showToast(`Termin · ${assignment.interpreter_name} (2. Person) meldet „fällt aus“: ${assignment.title}${assignment.storno_note ? ` – „${assignment.storno_note}“` : ''}`, 'error', { duration: 20000, keep: true });
                changed = true;
            }
            // Ist der Termin hier abgeschlossen (beendet, storniert …), gilt das auch für die zweite Person; „losgefahren“ meldet sie selbst.
            const rowStatus = String(record.Status || 'offen').trim();
            const own = assignment.finished_at ? 'beendet' : assignment.started_at ? 'losgefahren' : 'offen';
            const wanted = ['offen', 'losgefahren'].includes(rowStatus.toLocaleLowerCase('de-DE')) ? own : rowStatus;
            if (!assignment.storno_at && String(assignment.work_status || 'offen') !== wanted && !(wanted === 'offen' && !assignment.work_status)) {
                await client.from('tt_assignments').update({ work_status: wanted }).eq('id', assignment.id);
            }
        }
        // Gelöschte Termine: Auftrag zurückziehen.
        const ids = new Set(records().flatMap(record => [record._id, record._id2].filter(Boolean)));
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

    // ---------- Bemerkung und Anhang (PDF) zu einem Auftrag ----------
    // Der Knopf „Bemerkung“ in der Zeile öffnet dieses Fenster; „Auftrag“ sendet wie bisher mit einem Klick –
    // eine schon gespeicherte Bemerkung und der Anhang gehen dabei wieder mit.
    const NOTE_CHIPS = ['CD mitnehmen', 'Arztbericht mitbringen', 'Überweisung mitnehmen', 'Vorbefunde mitnehmen', 'Versichertenkarte mitnehmen', 'Patient muss nüchtern sein'];
    const MAX_ATTACHMENT = 20 * 1024 * 1024;
    function assignmentDialog(record, name) {
        return new Promise(resolve => {
            const make = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
            const dialog = make('dialog', 'confirm-dialog assign-dialog');
            dialog.setAttribute('aria-labelledby', 'assignDialogTitle');
            const title = make('h2', '', `Auftrag an ${name} – Bemerkung und Anhang`);
            title.id = 'assignDialogTitle';
            const time = String(record.Termin_Uhrzeit || '').slice(0, 5);
            const about = make('p', 'field-hint', [time ? `${time} Uhr` : '', String(record['Arzt Nr::Name'] || '').replace(/\s+/g, ' ').trim(), getAppointmentLocation(record)].filter(Boolean).join(' · '));
            const chips = make('div', 'board-chips request-reasons');
            const label = make('label', '', 'Bemerkung für den Dolmetscher');
            label.htmlFor = 'assignNote';
            const note = make('textarea');
            note.id = 'assignNote';
            note.rows = 3;
            note.maxLength = 500;
            note.placeholder = 'Zum Beispiel: CD vom MRT mitnehmen, Bericht beim Empfang abgeben …';
            note.value = record._hinweis || '';
            NOTE_CHIPS.forEach(text => {
                const chip = make('button', 'board-chip', text);
                chip.type = 'button';
                chip.addEventListener('click', () => { const now = note.value.trim(); if (!now.includes(text)) note.value = now ? `${now}${/[.,;:]$/.test(now) ? ' ' : ', '}${text}` : text; note.focus(); });
                chips.append(chip);
            });
            // Anhang: vorhandene Datei behalten, entfernen oder durch eine neue ersetzen.
            let keep = Boolean(record._anhang);
            const fileLabel = make('label', '', 'Anhang (PDF, freiwillig)');
            fileLabel.htmlFor = 'assignFile';
            const current = make('p', 'assign-current');
            const currentName = make('span', '', `Angehängt: ${record._anhangName || 'Datei'}`);
            const drop = make('button', 'button-quiet-danger', 'Anhang entfernen');
            drop.type = 'button';
            current.append(currentName, drop);
            current.hidden = !keep;
            const file = make('input');
            file.type = 'file';
            file.id = 'assignFile';
            file.accept = '.pdf,application/pdf';
            const problem = make('p', 'workflow-status');
            problem.dataset.kind = 'error';
            problem.setAttribute('role', 'alert');
            problem.hidden = true;
            drop.addEventListener('click', () => { keep = false; current.hidden = true; });
            file.addEventListener('change', () => { problem.hidden = true; });
            const hint = make('p', 'field-hint', 'Der Dolmetscher sieht die Bemerkung oben im Auftrag und kann den Anhang dort öffnen. Später ändern oder entfernen: dieses Fenster noch einmal öffnen und erneut senden.');
            const buttons = make('div', 'modal-buttons');
            const cancel = make('button', 'button-secondary', 'Abbrechen');
            cancel.type = 'button';
            const ok = make('button', 'button-primary', 'Auftrag senden');
            ok.type = 'button';
            buttons.append(cancel, ok);
            dialog.append(title, about, chips, label, note, fileLabel, current, file, problem, hint, buttons);
            document.body.append(dialog);
            let result = null;
            cancel.addEventListener('click', () => dialog.close());
            ok.addEventListener('click', () => {
                const picked = file.files?.[0] || null;
                if (picked && !(picked.type === 'application/pdf' || /\.pdf$/i.test(picked.name))) { problem.textContent = 'Bitte eine PDF-Datei wählen.'; problem.hidden = false; return; }
                if (picked && picked.size > MAX_ATTACHMENT) { problem.textContent = 'Die Datei ist größer als 20 MB. Bitte eine kleinere PDF-Datei wählen.'; problem.hidden = false; return; }
                result = { note: note.value.trim(), file: picked, keep: keep && !picked };
                dialog.close();
            });
            dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
            dialog.showModal();
            note.focus();
        });
    }
    window.noteTrackingAssignment = async function (index) {
        const record = records()[index];
        if (!record) return;
        const name = getAppointmentInterpreterName(record);
        if (!name) { showToast('Bitte trage zuerst den Dolmetscher oder die Dolmetscherin ein.', 'error'); return; }
        const extra = await assignmentDialog(record, name);
        if (extra) await window.sendTrackingAssignment(records().indexOf(record), extra);
    };

    // extra (aus dem Fenster „Bemerkung“): { note, file, keep }. Ohne extra gilt, was am Termin schon gespeichert ist.
    window.sendTrackingAssignment = async function (index, extra = null) {
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
        // Bemerkung und Anhang: neu aus dem Fenster oder wie zuletzt am Termin gespeichert.
        const note = extra ? extra.note : String(record._hinweis || '');
        let attachment = { path: record._anhang || null, name: record._anhangName || '' };
        const oldPath = attachment.path;
        if (extra?.file) {
            const safe = extra.file.name.replace(/\.pdf$/i, '').normalize('NFD').replace(/[^A-Za-z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'anhang';
            const path = `auftraege/${record._id}/${Date.now()}-${safe}.pdf`;
            const upload = await client.storage.from('dokumente').upload(path, extra.file, { contentType: 'application/pdf' });
            if (upload.error) {
                showToast(/row-level security|policy/i.test(upload.error.message || '')
                    ? 'Der Anhang konnte nicht hochgeladen werden: In der Datenbank fehlt noch Update 22 (supabase/update-22.sql).'
                    : `Der Anhang konnte nicht hochgeladen werden: ${TerminCloud.germanError(upload.error)}`, 'error');
                return;
            }
            attachment = { path, name: extra.file.name.slice(0, 120) };
        } else if (extra && !extra.keep) attachment = { path: null, name: '' };
        const fields = {
            ...restart,
            appointment_id: record._id, date, time, interpreter_id: target.id, interpreter_name: target.full_name,
            title: [time ? `${time} Uhr` : '', doctorName, place].filter(Boolean).join(' · '),
            message: createWhatsAppAppointmentMessage(record, true) + teamBlock(record, false),
            response: 'offen', response_note: '', responded_at: null, cancelled: false,
            work_status: String(record.Status || 'offen'), sent_at: new Date().toISOString(), sent_by: profile.full_name || ''
        };
        const withExtra = { ...fields, office_note: note, attachment_path: attachment.path, attachment_name: attachment.name };
        let { error } = await client.from('tt_assignments').upsert(withExtra, { onConflict: 'appointment_id' });
        // Ohne Update 22 kennt die Datenbank die neuen Spalten noch nicht: Der Auftrag geht dann ohne Bemerkung hinaus.
        if (error && /office_note|attachment_/i.test(error.message || '')) {
            ({ error } = await client.from('tt_assignments').upsert(fields, { onConflict: 'appointment_id' }));
            if (!error && (note || attachment.path)) showToast('Bemerkung und Anhang wurden nicht gespeichert: In der Datenbank fehlt noch Update 22 (supabase/update-22.sql).', 'error', { duration: 14000 });
        }
        if (error) {
            if (extra?.file && attachment.path) await client.storage.from('dokumente').remove([attachment.path]).catch(() => null);
            showToast(TerminCloud.germanError(error), 'error');
            return;
        }
        // Eine ersetzte oder entfernte Datei wird nicht mehr gebraucht.
        if (oldPath && oldPath !== attachment.path) await client.storage.from('dokumente').remove([oldPath]).catch(() => null);
        if (note) record._hinweis = note; else delete record._hinweis;
        if (attachment.path) { record._anhang = attachment.path; record._anhangName = attachment.name; } else { delete record._anhang; delete record._anhangName; }
        record['Rückmeldung'] = RESPONSE_TEXT.offen;
        persistTerminRecords(records(), 'tracking');
        window.refreshTrackingRows?.();
        // Zweite Person im Auftrag (Transport / Dolmetschen / zweites Fahrzeug): Sie bekommt ihren eigenen Auftrag.
        const second = record._zweit ? await sendSecond(record) : '';
        showToast(`Auftrag an ${target.full_name}${second === 'gesendet' || second === 'gleich' ? ` und ${record._zweit}` : ''} gesendet${note && attachment.path ? ' – mit Bemerkung und Anhang' : note ? ' – mit Bemerkung' : attachment.path ? ' – mit Anhang' : ''}`, 'success');
        // Zusätzlich als Mitteilung aufs Handy (falls eingerichtet und von der Person eingeschaltet).
        TerminCloud.callFunction?.({ action: 'notify', audience: 'einzeln', recipientIds: [target.id], title: 'Neuer Auftrag', body: [date.split('-').reverse().join('.'), time ? `${time} Uhr` : '', doctorName, place, note ? `Hinweis: ${note}` : '', attachment.path ? 'mit Anhang' : ''].filter(Boolean).join(' · ').slice(0, 280) });
        syncDay();
    };

    // ---------- Zweite Person im Auftrag ----------
    // Der Abschnitt „IM TEAM“ steht am Ende des Auftrags: Die App zeigt daraus, wer mit im Auftrag ist und wer welche Aufgabe hat.
    function teamBlock(record, forSecond) {
        if (!record._zweit) return '';
        const role2 = ['Transport', 'Dolmetschen', 'Zweites Fahrzeug'].includes(record._zweitAufgabe) ? record._zweitAufgabe : 'Transport';
        const role1 = role2 === 'Transport' ? 'Dolmetschen' : role2 === 'Dolmetschen' ? 'Transport' : 'Zweites Fahrzeug';
        const label = role => role === 'Transport' ? 'Transport (fahren)' : role === 'Zweites Fahrzeug' ? 'Fahren mit eigenem Fahrzeug' : role;
        const first = getAppointmentInterpreterName(record);
        const partner = forSecond ? first : record._zweit;
        const person = profiles.find(item => item.active && sameName(item.full_name, partner));
        const car = forSecond ? String(record.Fahrzeug || '') : String(record._zweitAuto || '');
        const ownCar = forSecond ? String(record._zweitAuto || '') : String(record.Fahrzeug || '');
        const one = value => String(value || '').replace(/[\r\n]+/g, ' ').trim();
        return '\n\n' + ['*IM TEAM*',
            `Mit dir: ${one(partner)}`,
            `Deine Aufgabe: ${label(forSecond ? role2 : role1)}`,
            `Aufgabe Kollege: ${label(forSecond ? role1 : role2)}`,
            ownCar ? `Dein Fahrzeug: ${one(ownCar)}` : '',
            car ? `Fahrzeug Kollege: ${one(car)}` : '',
            person?.phone ? `Telefon Kollege: ${one(person.phone)}` : ''
        ].filter(Boolean).join('\n');
    }

    // Auftrag an die zweite Person: gesendet | gleich (stand schon so im Portal – ihre Antwort bleibt) | '' (ging nicht).
    async function sendSecond(record) {
        if (!record._zweit || !record._id2) return '';
        if (!profiles.some(item => 'phone' in item)) profiles = (await client.from('tt_profiles').select('*')).data || profiles;
        const target = profiles.find(item => item.active && sameName(item.full_name, record._zweit));
        if (!target) { showToast(`${record._zweit} (2. Person) hat kein freigeschaltetes Portal-Konto – an sie geht kein Auftrag. Konten schaltest du auf der Seite „Team“ frei.`, 'error', { duration: 12000 }); return ''; }
        const date = currentDate();
        const time = String(record.Termin_Uhrzeit || '').slice(0, 5);
        const oneLine = value => window.TerminContact ? TerminContact.singleLine(value) : String(value || '').trim();
        const doctorName = oneLine(record['Arzt Nr::Name']);
        const place = oneLine(getAppointmentLocation(record));
        const message = createWhatsAppAppointmentMessage(record, true) + teamBlock(record, true);
        const { data: previous } = await client.from('tt_assignments').select('*').eq('appointment_id', record._id2).maybeSingle();
        const note = String(record._hinweis || '');
        const same = previous && !previous.cancelled && previous.interpreter_id === target.id && previous.message === message && previous.date === date
            && String(previous.time || '').slice(0, 5) === time && String(previous.office_note || '') === note && (previous.attachment_path || null) === (record._anhang || null);
        if (same) return 'gleich';
        // Nur die Angaben zum Team haben sich geändert (dieselbe Person, derselbe Termin): Ihre Antwort bleibt stehen.
        const keep = previous && !previous.cancelled && previous.interpreter_id === target.id && previous.date === date && String(previous.time || '').slice(0, 5) === time;
        const restart = previous && 'started_at' in previous && previous.interpreter_id !== target.id ? { started_at: null, finished_at: null, reminded_at: null, reminder_count: 0 } : {};
        const fields = {
            ...restart,
            appointment_id: record._id2, date, time, interpreter_id: target.id, interpreter_name: target.full_name,
            title: [time ? `${time} Uhr` : '', doctorName, place].filter(Boolean).join(' · '), message,
            ...(keep ? {} : { response: 'offen', response_note: '', responded_at: null }), cancelled: false,
            ...(keep ? {} : { work_status: 'offen' }), sent_at: new Date().toISOString(), sent_by: profile.full_name || ''
        };
        let { error } = await client.from('tt_assignments').upsert({ ...fields, office_note: note, attachment_path: record._anhang || null, attachment_name: record._anhangName || '' }, { onConflict: 'appointment_id' });
        if (error && /office_note|attachment_/i.test(error.message || '')) ({ error } = await client.from('tt_assignments').upsert(fields, { onConflict: 'appointment_id' }));
        if (error) { showToast(`Auftrag an ${record._zweit} (2. Person): ${TerminCloud.germanError(error)}`, 'error'); return ''; }
        if (!keep) record._zweitAntwort = RESPONSE_TEXT.offen;
        delete record._zweitStorno;
        if (restart.reminder_count === 0) { delete record._zweitStart; delete record._zweitEnde; }
        const first = getAppointmentInterpreterName(record);
        TerminCloud.callFunction?.({ action: 'notify', audience: 'einzeln', recipientIds: [target.id], title: keep ? 'Auftrag geändert' : 'Neuer Auftrag',
            body: [date.split('-').reverse().join('.'), time ? `${time} Uhr` : '', doctorName, place, first ? `mit ${first}` : ''].filter(Boolean).join(' · ').slice(0, 280) });
        return 'gesendet';
    }

    // Die zweite Person wurde eingetragen, geändert oder entfernt, nachdem der Auftrag der ersten schon im Portal stand:
    // Die zweite bekommt ihren Auftrag (oder er wird zurückgezogen), bei der ersten ändert sich nur der Abschnitt „Im Team“ –
    // ihre Zusage bleibt stehen.
    window.syncSecondAssignment = async function (index) {
        const record = records()[index];
        if (!record || !record._id2) return;
        if (!(await loadProfile())) { showToast('Melde dich zuerst auf der Seite „Team“ als Einsatzleitung an, um Aufträge zu senden.', 'error'); return; }
        stamp();
        let result = '';
        if (record._zweit) result = await sendSecond(record);
        else {
            const { data: previous } = await client.from('tt_assignments').select('*').eq('appointment_id', record._id2).maybeSingle();
            if (previous && !previous.cancelled) {
                await client.from('tt_assignments').update({ cancelled: true }).eq('id', previous.id);
                TerminCloud.callFunction?.({ action: 'notify', audience: 'einzeln', recipientIds: [previous.interpreter_id], title: 'Auftrag zurückgezogen', body: `${formatFleetDate(previous.date)} · ${previous.title} – dieser Auftrag gilt nicht mehr.` });
                result = 'zurück';
            }
        }
        // Erste Person: nur der Text des Auftrags ändert sich.
        const { data: main } = await client.from('tt_assignments').select('*').eq('appointment_id', record._id).maybeSingle();
        const message = createWhatsAppAppointmentMessage(record, true) + teamBlock(record, false);
        if (main && !main.cancelled && main.message !== message && sameName(main.interpreter_name, record.Übersetzer)) {
            const { error } = await client.from('tt_assignments').update({ message }).eq('id', main.id);
            if (!error) TerminCloud.callFunction?.({ action: 'notify', audience: 'einzeln', recipientIds: [main.interpreter_id], title: 'Auftrag geändert',
                body: `${main.title}: ${record._zweit ? `${record._zweit} ist mit dir im Auftrag (${record._zweitAufgabe || 'Transport'}).` : 'Du bist jetzt allein im Auftrag.'}`.slice(0, 280) });
        }
        persistTerminRecords(records(), 'tracking');
        window.refreshTrackingRows?.();
        showToast(record._zweit
            ? (result ? `${record._zweit} ist als zweite Person im Auftrag (${record._zweitAufgabe || 'Transport'}) – beide sehen es in ihrer App.` : `${record._zweit} ist eingetragen, der Auftrag ging aber nicht hinaus.`)
            : 'Zweite Person entfernt – ihr Auftrag ist zurückgezogen.', result || !record._zweit ? 'success' : 'error', { duration: 10000 });
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

    // Kleines Fenster vor dem Erinnern: Text ändern oder leer lassen. Ergebnis: Text, '' (ohne eigene Nachricht) oder null (abgebrochen).
    function remindDialog(assignment, waiting) {
        return new Promise(resolve => {
            const dialog = document.createElement('dialog');
            dialog.className = 'confirm-dialog remind-dialog';
            const title = document.createElement('h2');
            title.textContent = `${assignment.interpreter_name} erinnern`;
            const info = document.createElement('p');
            info.textContent = `Auftrag ${assignment.title} · ${formatFleetDate(assignment.date)}`;
            const label = document.createElement('label');
            label.textContent = 'Deine Nachricht dazu (freiwillig)';
            const input = document.createElement('textarea');
            input.id = 'remindText';
            input.rows = 3;
            input.maxLength = 300;
            input.value = waiting ? 'Bitte sag den Auftrag zu oder ab.' : '';
            input.placeholder = 'z. B. Bitte zusagen – der Patient wartet auf Bestätigung';
            label.htmlFor = input.id;
            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons';
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'button-secondary';
            cancel.textContent = 'Abbrechen';
            const ok = document.createElement('button');
            ok.type = 'button';
            ok.className = 'button-primary';
            ok.textContent = 'Erinnerung senden';
            buttons.append(cancel, ok);
            dialog.append(title, info, label, input, buttons);
            document.body.append(dialog);
            const finish = result => { dialog.close(); dialog.remove(); resolve(result); };
            cancel.addEventListener('click', () => finish(null));
            ok.addEventListener('click', () => finish(input.value.trim().replace(/\s+/g, ' ')));
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
            dialog.showModal();
            input.focus();
            input.select();
        });
    }

    // Erinnern: Mitteilung aufs Handy und Nachricht im Portal – der Auftrag selbst bleibt unverändert.
    window.remindTrackingAssignment = async function (index, button) {
        if (button) button.disabled = true;
        try {
            const { assignment } = await sentAssignment(index);
            if (!assignment) return;
            const waiting = assignment.response === 'offen';
            // Eine kurze eigene Nachricht dazu (z. B. „Bitte zusagen“) – damit klar ist, was gemeint ist.
            const text = await remindDialog(assignment, waiting);
            if (text === null) return;
            const about = `${assignment.title} (${formatFleetDate(assignment.date)})`;
            const body = text ? `Erinnerung zum Auftrag ${about}: ${text}` : waiting ? `Erinnerung: Bitte antworte auf den Auftrag ${about}.` : `Erinnerung an deinen Auftrag ${about}.`;
            // Die Erinnerung steht im Chat der Person – dort kann sie gleich antworten. Ohne Update 21 wie früher als Nachricht.
            const pushTitle = waiting ? 'Erinnerung: Auftrag wartet auf Antwort' : 'Erinnerung an deinen Auftrag';
            const pushBody = `${text ? `${text} – ` : ''}${formatFleetDate(assignment.date)} · ${assignment.title}`.slice(0, 200);
            let sent = await TerminCloud.sendChat(assignment.interpreter_id, body, { title: pushTitle, pushBody });
            if (!sent.ok && sent.missing) {
                const { error } = await client.from('tt_messages').insert({ sender_id: profile.id, sender_name: profile.full_name || 'Einsatzleitung', audience: 'einzeln', recipient_ids: [assignment.interpreter_id], body });
                if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                const push = await TerminCloud.callFunction?.({ action: 'notify', audience: 'einzeln', recipientIds: [assignment.interpreter_id], title: pushTitle, body: pushBody });
                sent = { ok: true, pushed: Boolean(push?.ok && push.data?.sent) };
            }
            if (!sent.ok) { showToast(sent.message, 'error'); return; }
            showToast(`Erinnerung an ${assignment.interpreter_name} gesendet – ${sent.pushed ? 'als Mitteilung aufs Handy und als Nachricht im Portal.' : 'als Nachricht im Portal (Mitteilungen aufs Handy sind dort nicht eingeschaltet).'}`, 'success', { duration: 9000 });
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

    // ---------- „Übrige informieren“: Wer nicht eingeplant ist, muss nicht länger warten ----------
    // Alle temporären Dolmetscher, deren Name an diesem Tag in keinem Termin steht, bekommen eine kurze, freundliche
    // Nachricht (Portal + Mitteilung aufs Handy). Wer eingetragen ist, gilt als eingeplant – auch ohne gesendeten Auftrag.
    const NO_JOBS_KEY = 'terminTool.noJobsTold.v1';
    const toldOn = date => { try { return (JSON.parse(localStorage.getItem(NO_JOBS_KEY) || '{}') || {})[date] || []; } catch (error) { return []; } };
    const rememberTold = (date, ids) => { try { const all = JSON.parse(localStorage.getItem(NO_JOBS_KEY) || '{}') || {}; const kept = Object.fromEntries(Object.entries(all).filter(([day]) => day >= date).slice(-6)); kept[date] = [...new Set([...(kept[date] || []), ...ids])]; localStorage.setItem(NO_JOBS_KEY, JSON.stringify(kept)); } catch (error) { /* dann wird beim nächsten Mal erneut gefragt */ } };

    function noJobsText(date) {
        const today = TerminCloud.todayIso();
        const next = new Date(`${today}T00:00:00`); next.setDate(next.getDate() + 1);
        const tomorrow = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
        const day = new Date(`${date}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });
        const when = date === today ? `heute (${day})` : date === tomorrow ? `morgen (${day})` : day;
        return `Hallo zusammen,\n\ndie Termine für ${when} sind verteilt. Für dich ist diesmal leider kein Auftrag dabei – du musst also nicht weiter warten.\n\nVielen Dank, dass du dich bereitgehalten hast! Sollte sich kurzfristig noch etwas ergeben, melden wir uns sofort bei dir.\n\nViele Grüße\ndeine Einsatzleitung`;
    }

    function noJobsDialog(people, already, date) {
        return new Promise(resolve => {
            const dialog = document.createElement('dialog');
            dialog.className = 'confirm-dialog no-jobs-dialog';
            const title = document.createElement('h2');
            title.textContent = `Nicht eingeplant am ${formatFleetDate(date)}: ${people.length} ${people.length === 1 ? 'Person' : 'Personen'} informieren`;
            const names = document.createElement('p');
            names.className = 'no-jobs-names';
            names.textContent = people.map(item => item.full_name).join(', ');
            const hint = document.createElement('p');
            hint.className = 'field-hint';
            hint.textContent = `Temporäre Dolmetscher, deren Name an diesem Tag in keinem Termin steht.${already ? ` ${already} ${already === 1 ? 'Person wurde' : 'Personen wurden'} schon informiert und bekommen nichts doppelt.` : ''} Niemand muss darauf antworten. Du kannst den Text ändern:`;
            const text = document.createElement('textarea');
            text.maxLength = 1000;
            text.value = noJobsText(date);
            text.setAttribute('aria-label', 'Nachricht an die nicht eingeplanten Dolmetscher');
            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons';
            const cancel = document.createElement('button');
            cancel.type = 'button'; cancel.className = 'button-secondary'; cancel.textContent = 'Abbrechen';
            const send = document.createElement('button');
            send.type = 'button'; send.className = 'button-primary'; send.textContent = 'Nachricht senden';
            const done = value => { dialog.close(); dialog.remove(); resolve(value); };
            cancel.addEventListener('click', () => done(null));
            dialog.addEventListener('cancel', event => { event.preventDefault(); done(null); });
            send.addEventListener('click', () => { if (!text.value.trim()) { text.focus(); return; } done(text.value.trim()); });
            buttons.append(cancel, send);
            dialog.append(title, names, hint, text, buttons);
            document.body.append(dialog);
            dialog.showModal();
        });
    }

    window.tellNoJobs = async function () {
        if (!(await loadProfile())) { showToast('Dafür bitte zuerst online anmelden (Seite „Team“).', 'error'); return; }
        const date = currentDate();
        const list = records();
        if (!date || !list.length) { showToast('Es ist kein Tag geöffnet.', 'error'); return; }
        if (date < TerminCloud.todayIso()) { showToast('Dieser Tag liegt in der Vergangenheit.', 'error'); return; }
        const { data: people, error } = await client.from('tt_profiles').select('id, full_name, active, role, employment');
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        const planned = new Set(list.filter(record => String(record.Status || '').trim().toLocaleLowerCase('de') !== 'storniert').flatMap(record => [record.Übersetzer, record._zweit]).map(name => String(name || '').trim().toLocaleLowerCase('de')).filter(Boolean));
        const free = people.filter(item => item.active && item.role === 'dolmetscher' && item.employment !== 'fest' && String(item.full_name || '').trim() && !planned.has(String(item.full_name).trim().toLocaleLowerCase('de')))
            .sort((left, right) => left.full_name.localeCompare(right.full_name, 'de'));
        const told = new Set(toldOn(date));
        const fresh = free.filter(item => !told.has(item.id));
        const unnamed = list.filter(record => !String(record.Übersetzer || '').trim() && String(record.Status || '').trim().toLocaleLowerCase('de') !== 'storniert').length;
        if (!fresh.length) { showToast(free.length ? 'Alle nicht eingeplanten Dolmetscher wurden für diesen Tag schon informiert.' : 'Alle temporären Dolmetscher sind an diesem Tag eingeplant.', 'info'); return; }
        if (unnamed && !await confirmDialog(`Bei ${unnamed} ${unnamed === 1 ? 'Termin steht' : 'Terminen steht'} noch kein Dolmetscher. Wer jetzt die Nachricht bekommt, rechnet nicht mehr mit einem Auftrag.\n\nTrotzdem schon Bescheid geben?`, 'Trotzdem informieren')) return;
        const body = await noJobsDialog(fresh, free.length - fresh.length, date);
        if (!body) return;
        const ids = fresh.map(item => item.id);
        const { error: sendError } = await client.from('tt_messages').insert({ sender_id: profile.id, sender_name: profile.full_name || 'Einsatzleitung', audience: 'einzeln', recipient_ids: ids, body });
        if (sendError) { showToast(TerminCloud.germanError(sendError), 'error'); return; }
        rememberTold(date, ids);
        const push = await TerminCloud.callFunction?.({ action: 'notify', audience: 'einzeln', recipientIds: ids, title: 'Termine sind verteilt', body: 'Für dich ist diesmal kein Auftrag dabei – du musst nicht weiter warten.' });
        showToast(`${ids.length} ${ids.length === 1 ? 'Person' : 'Personen'} informiert – als Nachricht im Portal${push?.ok && push.data?.sent ? ' und als Mitteilung aufs Handy' : ''}.`, 'success', { duration: 9000 });
    };
    document.getElementById('noJobsButton')?.addEventListener('click', () => window.tellNoJobs());

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
