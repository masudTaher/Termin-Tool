// Kontrolle (R86 / Update 54): Nachverfolgung für die Einsatzleitung.
// Drei Fragen, drei Reiter: Wer war im Termin und hat keinen Bericht geschrieben? Bei welchem Termin fehlen Unterlagen?
// Wer hat sein Fahrzeug nach Dienstschluss nicht zurückgegeben? Dazu je Dolmetscher eine Zuverlässigkeits-Übersicht.
// Erinnern = Nachricht in den Chat der Person (tt_messages) + Mitteilung aufs Handy; der Stand steht in tt_followups.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const REPORT_KIND = 'Dolmetscherbericht';
    const CANCELLED = /storniert|abgesagt|ausgefallen|entf[aä]llt/i;
    const pad = value => String(value).padStart(2, '0');
    const isoOf = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const shiftIso = (iso, days) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + days); return isoOf(d); };
    const dayText = iso => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
    const stampText = iso => iso ? new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const clock = value => String(value || '').slice(0, 5);

    let profile = null;
    let people = [];
    let assignments = [];
    let documents = [];
    let dayRecords = new Map();     // appointment_id → Termin aus tt_days
    let followups = new Map();      // "kind:ref" → Eintrag
    let followupsReady = false;
    let handovers = [];             // offene Übernahmen
    let vehicles = new Map();
    let workEnd = '16:00';
    let tab = 'berichte';
    let showDone = false;

    function setStatus(message, kind = 'info') {
        const box = $('ctlStatus');
        box.hidden = !message;
        box.textContent = message || '';
        box.dataset.kind = kind;
    }
    const nameOf = id => people.find(person => person.id === id)?.full_name || '';
    const key = (kind, ref) => `${kind}:${ref}`;
    const followupOf = (kind, ref) => followups.get(key(kind, ref)) || null;
    const isSettled = item => item && (item.status === 'entschuldigt' || item.status === 'erledigt');
    const rangeDays = () => Number($('ctlRange').value) || 30;

    // Ab wann gilt ein Termin als „ohne Bericht“? Ab dem nächsten Morgen um 8 Uhr.
    function reportDueDate() {
        const now = new Date();
        const today = TerminCloud.todayIso();
        return now.getHours() >= 8 ? shiftIso(today, -1) : shiftIso(today, -2);
    }
    // Ein Fahrzeug gilt als nicht zurückgegeben, wenn die Übernahme nach Dienstschluss noch läuft (kein Notfall, keine erlaubte Übernachtung).
    function vehicleOverdue(item) {
        if (!item.driver_id || item.emergency || TerminCloud.keepsOvernight(item)) return false;
        const today = TerminCloud.todayIso();
        if (item.date < today) return true;
        const now = new Date();
        const [h, m] = workEnd.split(':').map(Number);
        return item.date === today && (now.getHours() > h || (now.getHours() === h && now.getMinutes() >= (m || 0)));
    }

    const recordOf = assignment => dayRecords.get(assignment.appointment_id) || null;
    const patientOf = assignment => {
        const record = recordOf(assignment);
        if (!record) return '';
        return [record['Patienten Nr::Patienten_Vorname'], record['Patienten Nr::Patienten_Name']].map(value => String(value || '').trim()).filter(Boolean).join(' ');
    };
    const attended = assignment => {
        if (assignment.cancelled || assignment.response === 'abgesagt') return false;
        if (CANCELLED.test(assignment.work_status || '')) return false;
        const record = recordOf(assignment);
        if (record && CANCELLED.test(String(record.Status || ''))) return false;
        return true;
    };
    const hasReport = assignment => documents.some(doc => doc.kind === REPORT_KIND && (doc.assignment_id === assignment.id
        || (doc.appointment_id && doc.appointment_id === assignment.appointment_id)
        || (!doc.assignment_id && !doc.appointment_id && doc.uploader_id === assignment.interpreter_id && doc.date === assignment.date)));
    const hasPapers = assignment => documents.some(doc => doc.kind !== REPORT_KIND && (doc.assignment_id === assignment.id
        || (doc.appointment_id && doc.appointment_id === assignment.appointment_id)
        || (!doc.assignment_id && !doc.appointment_id && doc.uploader_id === assignment.interpreter_id && doc.date === assignment.date)));

    // ---------- Laden ----------
    async function refresh() {
        setStatus('');
        if (!client) { setStatus('Die Verbindung zur Datenbank konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu.', 'error'); return; }
        try { profile = await TerminCloud.getProfile(true); } catch (error) { setStatus(error.message, 'error'); return; }
        if (!TerminCloud.isStaff(profile)) { $('ctlApp').hidden = true; setStatus('Bitte melde dich zuerst auf der Seite „Team“ als Einsatzleitung an.', 'error'); return; }
        const today = TerminCloud.todayIso();
        const since = shiftIso(today, -rangeDays());
        const sinceIso = new Date(`${since}T00:00:00`).toISOString();
        const [peopleResult, assignmentResult, dayResult, docResult, followupResult, handoverResult, vehicleResult, settingResult] = await Promise.all([
            client.from('tt_profiles').select('*').order('full_name'),
            client.from('tt_assignments').select('*').gte('date', since).lte('date', today).order('date', { ascending: false }),
            client.from('tt_days').select('date, records').gte('date', since),
            client.from('tt_documents').select('id, kind, assignment_id, appointment_id, date, uploader_id, created_at').or(`date.gte.${since},created_at.gte.${sinceIso}`),
            client.from('tt_followups').select('*'),
            client.from('tt_handovers').select('*').is('end_time', null),
            client.from('tt_vehicles').select('id, plate, brand, body'),
            client.from('tt_settings').select('value').eq('key', 'arbeitszeit').maybeSingle()
        ]);
        const failed = [peopleResult, assignmentResult, dayResult, docResult, handoverResult, vehicleResult].find(result => result.error);
        if (failed) { $('ctlApp').hidden = true; setStatus(TerminCloud.germanError(failed.error), 'error'); return; }
        people = peopleResult.data || [];
        assignments = assignmentResult.data || [];
        documents = docResult.data || [];
        dayRecords = new Map();
        (dayResult.data || []).forEach(day => (Array.isArray(day.records) ? day.records : []).forEach(record => { if (record?._id) dayRecords.set(record._id, record); if (record?._id2) dayRecords.set(record._id2, record); }));
        followupsReady = !followupResult.error;
        followups = new Map();
        (followupsReady ? followupResult.data : []).forEach(item => followups.set(key(item.kind, item.ref_id), item));
        handovers = handoverResult.data || [];
        vehicles = new Map((vehicleResult.data || []).map(vehicle => [vehicle.id, vehicle]));
        workEnd = settingResult.data?.value?.ende || '16:00';
        if (!followupsReady) setStatus('Erinnern und Entschuldigen sind noch nicht eingerichtet – dafür fehlt Update 54 in der Datenbank (supabase/update-54.sql). Die Listen funktionieren trotzdem.', 'info');
        $('ctlApp').hidden = false;
        await autoResolve();
        render();
    }

    // Was inzwischen nachgeholt wurde, wird automatisch als erledigt vermerkt – so stimmt die Zuverlässigkeit.
    async function autoResolve() {
        if (!followupsReady) return;
        const done = [];
        followups.forEach(item => {
            if (isSettled(item)) return;
            if (item.kind === 'bericht' || item.kind === 'unterlagen') {
                const assignment = assignments.find(entry => entry.id === item.ref_id);
                if (assignment && (item.kind === 'bericht' ? hasReport(assignment) : hasPapers(assignment))) done.push(item);
            } else if (item.kind === 'fahrzeug' && !handovers.some(entry => entry.id === item.ref_id)) done.push(item);
        });
        for (const item of done) {
            const changes = { status: 'erledigt', resolved_at: new Date().toISOString(), resolved_by: 'automatisch – nachgeholt', updated_at: new Date().toISOString() };
            const { error } = await client.from('tt_followups').update(changes).eq('id', item.id);
            if (!error) followups.set(key(item.kind, item.ref_id), { ...item, ...changes });
        }
    }

    // ---------- Listen ----------
    function openItems(kind) {
        const due = reportDueDate();
        return assignments.filter(assignment => assignment.date <= due && attended(assignment) && (kind === 'bericht' ? !hasReport(assignment) : !hasPapers(assignment)));
    }
    const overdueVehicles = () => handovers.filter(vehicleOverdue);

    function render() {
        const berichte = openItems('bericht');
        const unterlagen = openItems('unterlagen');
        const autos = overdueVehicles();
        const openOnly = (list, kind) => list.filter(item => !isSettled(followupOf(kind, item.id)));
        $('ctlCountBerichte').textContent = String(openOnly(berichte, 'bericht').length);
        $('ctlCountUnterlagen').textContent = String(openOnly(unterlagen, 'unterlagen').length);
        $('ctlCountFahrzeuge').textContent = String(openOnly(autos, 'fahrzeug').length);
        $('ctlCountPersonen').textContent = String(new Set(assignments.map(item => item.interpreter_id)).size);
        document.querySelectorAll('[data-ctl-tab]').forEach(button => { const active = button.dataset.ctlTab === tab; button.classList.toggle('is-active', active); button.setAttribute('aria-selected', String(active)); });
        document.querySelectorAll('[data-ctl-panel]').forEach(panel => { panel.hidden = panel.dataset.ctlPanel !== tab; });
        renderGroups('bericht', berichte, $('ctlBerichte'), $('ctlBerichteSummary'));
        renderGroups('unterlagen', unterlagen, $('ctlUnterlagen'), $('ctlUnterlagenSummary'));
        renderVehicles(autos);
        renderPeople(berichte, unterlagen, autos);
    }

    function pillFor(item) {
        if (!item || item.status === 'offen') return ['offen', 'offen'];
        if (item.status === 'erinnert') return ['in Arbeit', `erinnert${item.reminded_count > 1 ? ` ${item.reminded_count}×` : ''} · ${stampText(item.reminded_at)}`];
        if (item.status === 'entschuldigt') return ['bekannt', `geklärt${item.note ? ` – ${item.note}` : ''}`];
        return ['erledigt', `nachgeholt · ${stampText(item.resolved_at)}`];
    }
    function statusPill(status, text) { const node = el('span', 'status-pill', text); node.dataset.status = status; return node; }

    function renderGroups(kind, list, box, summary) {
        box.replaceChildren();
        const visible = list.filter(item => showDone || !isSettled(followupOf(kind, item.id)));
        const open = list.filter(item => !isSettled(followupOf(kind, item.id)));
        const persons = new Set(open.map(item => item.interpreter_id));
        summary.textContent = !list.length ? (kind === 'bericht' ? 'Zu jedem Termin im Zeitraum gibt es einen Bericht.' : 'Zu jedem Termin im Zeitraum gibt es Unterlagen.')
            : `${open.length} ${open.length === 1 ? 'Termin' : 'Termine'} offen bei ${persons.size} ${persons.size === 1 ? 'Person' : 'Personen'}${list.length - open.length ? ` · ${list.length - open.length} geklärt` : ''}`;
        if (!visible.length) { box.append(el('p', 'directory-empty', list.length ? 'Alles geklärt – „Geklärte auch zeigen“ blendet sie ein.' : 'Nichts offen.')); return; }
        const byPerson = new Map();
        visible.forEach(item => { if (!byPerson.has(item.interpreter_id)) byPerson.set(item.interpreter_id, []); byPerson.get(item.interpreter_id).push(item); });
        [...byPerson.entries()].sort((a, b) => b[1].filter(item => !isSettled(followupOf(kind, item.id))).length - a[1].filter(item => !isSettled(followupOf(kind, item.id))).length).forEach(([personId, items]) => {
            const openHere = items.filter(item => !isSettled(followupOf(kind, item.id)));
            const group = el('section', 'ctl-group');
            group.dataset.person = personId;
            const head = el('div', 'ctl-group-head');
            const title = el('div');
            title.append(el('strong', null, items[0].interpreter_name || nameOf(personId) || 'Unbekannt'), el('small', null, `${openHere.length} offen · ${items.length} im Zeitraum`));
            const actions = el('div', 'ctl-group-actions');
            if (openHere.length) {
                const all = el('button', 'button-primary', openHere.length === 1 ? 'Erinnern' : `Alle ${openHere.length} erinnern`);
                all.type = 'button';
                all.addEventListener('click', () => remind(kind, openHere, personId, all));
                actions.append(all);
            }
            const chat = el('a', 'button-quiet', 'Chat öffnen');
            chat.href = `nachrichten.html?an=${encodeURIComponent(personId)}`;
            actions.append(chat);
            head.append(title, actions);
            group.append(head);
            const rows = el('ul', 'directory-list');
            items.sort((a, b) => String(b.date).localeCompare(a.date) || String(b.time).localeCompare(a.time)).forEach(item => {
                const fu = followupOf(kind, item.id);
                const row = el('li', 'vehicle-entry ctl-item');
                row.dataset.settled = isSettled(fu) ? 'ja' : '';
                const [pillKind, pillText] = pillFor(fu);
                const meta = el('span');
                meta.append(el('strong', null, `${dayText(item.date)} · ${item.title || clock(item.time) + ' Uhr'}`));
                const patient = patientOf(item);
                const extra = [patient ? `Patient: ${patient}` : '', item.work_status && !/^offen$/i.test(item.work_status) ? `Status: ${item.work_status}` : '', kind === 'unterlagen' && hasReport(item) ? 'Bericht vorhanden' : '', kind === 'bericht' && hasPapers(item) ? 'Unterlagen vorhanden' : ''].filter(Boolean).join(' · ');
                if (extra) meta.append(el('small', null, extra));
                const buttons = el('span', 'vehicle-entry-actions');
                if (!isSettled(fu)) {
                    const remindOne = el('button', 'button-secondary', fu?.status === 'erinnert' ? 'Nochmal erinnern' : 'Erinnern');
                    remindOne.type = 'button';
                    remindOne.addEventListener('click', () => remind(kind, [item], personId, remindOne));
                    const excuse = el('button', 'button-quiet', kind === 'unterlagen' ? 'Nichts erwartet' : 'Entschuldigt');
                    excuse.type = 'button';
                    excuse.addEventListener('click', () => openExcuse(kind, item.id, personId, `${item.interpreter_name} · ${dayText(item.date)} · ${item.title || ''}`));
                    buttons.append(remindOne, excuse);
                } else {
                    const reopen = el('button', 'button-quiet', 'Wieder offen');
                    reopen.type = 'button';
                    reopen.addEventListener('click', () => setFollowup(kind, item.id, personId, { status: 'offen', note: '', resolved_at: null, resolved_by: '' }, reopen));
                    buttons.append(reopen);
                }
                row.append(statusPill(pillKind, pillText), meta, buttons);
                rows.append(row);
            });
            group.append(rows);
            box.append(group);
        });
    }

    function renderVehicles(list) {
        const box = $('ctlFahrzeuge');
        box.replaceChildren();
        const open = list.filter(item => !isSettled(followupOf('fahrzeug', item.id)));
        $('ctlFahrzeugeSummary').textContent = !list.length ? `Alle Fahrzeuge sind zurück (Dienstschluss ${workEnd} Uhr).` : `${open.length} ${open.length === 1 ? 'Fahrzeug' : 'Fahrzeuge'} nicht zurückgegeben${list.length - open.length ? ` · ${list.length - open.length} geklärt` : ''} · Dienstschluss ${workEnd} Uhr`;
        const visible = list.filter(item => showDone || !isSettled(followupOf('fahrzeug', item.id)));
        if (!visible.length) { box.append(el('li', 'directory-empty', 'Nichts offen.')); return; }
        visible.sort((a, b) => String(a.date).localeCompare(b.date) || String(a.start_time).localeCompare(b.start_time)).forEach(item => {
            const fu = followupOf('fahrzeug', item.id);
            const vehicle = vehicles.get(item.vehicle_id);
            const row = el('li', 'vehicle-entry ctl-item');
            row.dataset.settled = isSettled(fu) ? 'ja' : '';
            const [pillKind, pillText] = pillFor(fu);
            const meta = el('span');
            meta.append(el('strong', null, `${vehicle?.plate || 'Fahrzeug'} · ${item.driver_name || nameOf(item.driver_id)}`),
                el('small', null, [`übernommen ${dayText(item.date)} ${clock(item.start_time)} Uhr`, vehicle ? [vehicle.brand, vehicle.body].filter(Boolean).join(' ') : '', item.date < TerminCloud.todayIso() ? 'seit mindestens einem Tag offen' : `nach Dienstschluss ${workEnd} Uhr noch offen`].filter(Boolean).join(' · ')));
            const buttons = el('span', 'vehicle-entry-actions');
            if (!isSettled(fu)) {
                const remindOne = el('button', 'button-secondary', fu?.status === 'erinnert' ? 'Nochmal erinnern' : 'Erinnern');
                remindOne.type = 'button';
                remindOne.addEventListener('click', () => remind('fahrzeug', [item], item.driver_id, remindOne));
                const ret = el('a', 'button-primary fleet-end-button', 'Rückgabe eintragen');
                ret.href = `fahrzeugakte.html?rueckgabe=${encodeURIComponent(item.id)}`;
                const excuse = el('button', 'button-quiet', 'Entschuldigt');
                excuse.type = 'button';
                excuse.addEventListener('click', () => openExcuse('fahrzeug', item.id, item.driver_id, `${vehicle?.plate || 'Fahrzeug'} · ${item.driver_name} · seit ${dayText(item.date)} ${clock(item.start_time)} Uhr`));
                buttons.append(remindOne, ret, excuse);
            } else {
                const reopen = el('button', 'button-quiet', 'Wieder offen');
                reopen.type = 'button';
                reopen.addEventListener('click', () => setFollowup('fahrzeug', item.id, item.driver_id, { status: 'offen', note: '', resolved_at: null, resolved_by: '' }, reopen));
                buttons.append(reopen);
            }
            row.append(statusPill(pillKind, pillText), meta, buttons);
            box.append(row);
        });
    }

    function renderPeople(berichte, unterlagen, autos) {
        const table = $('ctlPersonen');
        const ids = new Set([...assignments.map(item => item.interpreter_id), ...[...followups.values()].map(item => item.profile_id).filter(Boolean)]);
        const rows = [...ids].map(id => {
            const mine = kind => [...followups.values()].filter(item => item.kind === kind && item.profile_id === id);
            const openReports = berichte.filter(item => item.interpreter_id === id);
            const openPapers = unterlagen.filter(item => item.interpreter_id === id);
            const vehicleIssues = new Set([...autos.filter(item => item.driver_id === id).map(item => item.id), ...mine('fahrzeug').map(item => item.ref_id)]).size;
            const reminders = ['bericht', 'unterlagen', 'fahrzeug'].reduce((sum, kind) => sum + mine(kind).reduce((inner, item) => inner + (item.reminded_count || 0), 0), 0);
            const openNow = openReports.filter(item => !isSettled(followupOf('bericht', item.id))).length + autos.filter(item => item.driver_id === id && !isSettled(followupOf('fahrzeug', item.id))).length;
            return { id, name: nameOf(id) || assignments.find(item => item.interpreter_id === id)?.interpreter_name || 'Unbekannt', jobs: assignments.filter(item => item.interpreter_id === id && attended(item)).length,
                reports: openReports.length, reportsExcused: openReports.filter(item => followupOf('bericht', item.id)?.status === 'entschuldigt').length, papers: openPapers.length, vehicles: vehicleIssues, reminders, openNow };
        }).sort((a, b) => b.openNow - a.openNow || (b.reports + b.vehicles) - (a.reports + a.vehicles) || a.name.localeCompare(b.name, 'de'));
        $('ctlPersonenSummary').textContent = `${rows.length} ${rows.length === 1 ? 'Dolmetscher' : 'Dolmetscher'} mit Terminen in den letzten ${rangeDays()} Tagen`;
        table.replaceChildren();
        const head = el('tr');
        ['Dolmetscher', 'Termine', 'Berichte fehlen', 'Unterlagen fehlen', 'Auto nicht zurück', 'Erinnerungen', ''].forEach(text => head.append(el('th', null, text)));
        table.append(head);
        rows.forEach(row => {
            const tr = el('tr');
            tr.dataset.open = row.openNow ? 'ja' : '';
            tr.append(el('td', null, row.name), el('td', 'num', String(row.jobs)),
                el('td', `num${row.reports ? ' is-bad' : ''}`, row.reports ? `${row.reports}${row.reportsExcused ? ` (${row.reportsExcused} geklärt)` : ''}` : '0'),
                el('td', `num${row.papers ? ' is-warn' : ''}`, String(row.papers)),
                el('td', `num${row.vehicles ? ' is-bad' : ''}`, String(row.vehicles)),
                el('td', 'num', String(row.reminders)));
            const td = el('td');
            const chat = el('a', 'button-quiet', 'Chat');
            chat.href = `nachrichten.html?an=${encodeURIComponent(row.id)}`;
            td.append(chat);
            tr.append(td);
            table.append(tr);
        });
    }

    // ---------- Erinnern / Entschuldigen ----------
    function reminderText(kind, items) {
        const lines = items.map(item => kind === 'fahrzeug'
            ? `${vehicles.get(item.vehicle_id)?.plate || 'Fahrzeug'} – übernommen am ${dayText(item.date)} um ${clock(item.start_time)} Uhr`
            : `${dayText(item.date)} · ${item.title || clock(item.time) + ' Uhr'}`);
        if (kind === 'bericht') return `Erinnerung der Einsatzleitung: Zu ${items.length === 1 ? 'diesem Termin fehlt' : 'diesen Terminen fehlt'} noch dein Bericht in der App:\n${lines.join('\n')}\nBitte schreib ihn heute nach – zu jedem Termin gehört ein kurzer Bericht.`;
        if (kind === 'unterlagen') return `Erinnerung der Einsatzleitung: Zu ${items.length === 1 ? 'diesem Termin wurden' : 'diesen Terminen wurden'} keine Unterlagen hochgeladen (Arztbericht, Rezept, Überweisung):\n${lines.join('\n')}\nFalls du etwas bekommen hast, bitte heute fotografieren und hochladen – sonst kurz antworten, dass es nichts gab.`;
        return `Erinnerung der Einsatzleitung: Dein Fahrzeug ist in der App noch nicht zurückgegeben:\n${lines.join('\n')}\nBitte gib es jetzt in der App zurück (Kilometer, Tank, Parkort) – solange steht es als „unterwegs“ und niemand kann es übernehmen.`;
    }
    async function remind(kind, items, personId, button) {
        if (!personId) { showToast('Diese Person hat kein Konto – Erinnerung nicht möglich.', 'error'); return; }
        if (!followupsReady) { showToast('Dafür fehlt noch das Datenbank-Update 54 (supabase/update-54.sql).', 'error'); return; }
        button.disabled = true;
        const body = reminderText(kind, items).slice(0, 1000);
        const message = await client.from('tt_messages').insert({ sender_id: profile.id, sender_name: profile.full_name || 'Einsatzleitung', audience: 'einzeln', recipient_ids: [personId], body });
        if (message.error) { button.disabled = false; showToast(TerminCloud.germanError(message.error), 'error'); return; }
        // Aufs Handy ohne Einzelheiten – keine Patienten- oder Termindaten in der Mitteilung.
        const push = await TerminCloud.callFunction({ action: 'notify', audience: 'einzeln', recipientIds: [personId], title: 'Erinnerung der Einsatzleitung', body: kind === 'fahrzeug' ? 'Bitte gib dein Fahrzeug in der App zurück.' : kind === 'bericht' ? `Bitte ${items.length === 1 ? 'deinen Bericht' : `${items.length} Berichte`} in der App nachschreiben.` : 'Bitte fehlende Unterlagen hochladen oder kurz antworten.', page: 'nachrichten' });
        const now = new Date().toISOString();
        for (const item of items) {
            const existing = followupOf(kind, item.id);
            const row = { kind, ref_id: item.id, profile_id: personId, profile_name: nameOf(personId), status: 'erinnert', reminded_at: now, reminded_count: (existing?.reminded_count || 0) + 1, updated_at: now };
            const { data, error } = await client.from('tt_followups').upsert(row, { onConflict: 'kind,ref_id' }).select().single();
            if (error) { showToast(TerminCloud.germanError(error), 'error'); break; }
            followups.set(key(kind, item.id), data);
        }
        button.disabled = false;
        showToast(`Erinnerung an ${nameOf(personId)} gesendet${push.ok && push.data?.sent ? ' – auch aufs Handy' : push.ok ? ' (steht in der App; Mitteilungen aufs Handy nicht eingeschaltet)' : ''}.`, 'success');
        render();
    }
    async function setFollowup(kind, refId, personId, changes, button) {
        if (!followupsReady) { showToast('Dafür fehlt noch das Datenbank-Update 54 (supabase/update-54.sql).', 'error'); return false; }
        if (button) button.disabled = true;
        const existing = followupOf(kind, refId);
        const row = { kind, ref_id: refId, profile_id: personId || null, profile_name: nameOf(personId), reminded_count: existing?.reminded_count || 0, reminded_at: existing?.reminded_at || null, ...changes, updated_at: new Date().toISOString() };
        const { data, error } = await client.from('tt_followups').upsert(row, { onConflict: 'kind,ref_id' }).select().single();
        if (button) button.disabled = false;
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return false; }
        followups.set(key(kind, refId), data);
        render();
        return true;
    }
    let excuse = null;
    function openExcuse(kind, refId, personId, info) {
        excuse = { kind, refId, personId };
        $('ctlExcuseTitle').textContent = kind === 'unterlagen' ? 'Nichts erwartet – als geklärt markieren' : 'Entschuldigt – als geklärt markieren';
        $('ctlExcuseInfo').textContent = info;
        $('ctlExcuseNote').value = '';
        $('ctlExcuseDialog').showModal();
        $('ctlExcuseNote').focus();
    }
    $('ctlExcuseCancel').addEventListener('click', () => $('ctlExcuseDialog').close());
    $('ctlExcuseForm').addEventListener('submit', async event => {
        event.preventDefault();
        if (!excuse) return;
        const ok = await setFollowup(excuse.kind, excuse.refId, excuse.personId, { status: 'entschuldigt', note: $('ctlExcuseNote').value.trim().slice(0, 300), resolved_at: new Date().toISOString(), resolved_by: profile.full_name || 'Einsatzleitung' }, $('ctlExcuseSave'));
        if (ok) { $('ctlExcuseDialog').close(); showToast('Als geklärt vermerkt.', 'success'); }
    });

    // Ältere Termine in einem Rutsch als geklärt markieren (z. B. Altbestand vor Einführung der Kontrolle)
    let bulkKind = 'bericht';
    const bulkCandidates = () => { const until = $('ctlBulkDate').value; return until ? openItems(bulkKind).filter(item => item.date <= until && !isSettled(followupOf(bulkKind, item.id))) : []; };
    function openBulk(kind) {
        if (!followupsReady) { showToast('Dafür fehlt noch das Datenbank-Update 54 (supabase/update-54.sql).', 'error'); return; }
        bulkKind = kind;
        $('ctlBulkInfo').textContent = kind === 'bericht' ? 'Nimmt alle älteren Termine ohne Bericht aus der Liste – sie bleiben in der Zuverlässigkeit als „geklärt“ sichtbar.' : 'Nimmt alle älteren Termine ohne Unterlagen aus der Liste.';
        $('ctlBulkDate').value = shiftIso(TerminCloud.todayIso(), -7);
        $('ctlBulkNote').value = '';
        $('ctlBulkCount').textContent = `${bulkCandidates().length} Termine betroffen`;
        $('ctlBulkDialog').showModal();
    }
    document.querySelectorAll('[data-ctl-bulk]').forEach(button => button.addEventListener('click', () => openBulk(button.dataset.ctlBulk)));
    $('ctlBulkDate').addEventListener('change', () => { $('ctlBulkCount').textContent = `${bulkCandidates().length} Termine betroffen`; });
    $('ctlBulkCancel').addEventListener('click', () => $('ctlBulkDialog').close());
    $('ctlBulkForm').addEventListener('submit', async event => {
        event.preventDefault();
        const items = bulkCandidates();
        if (!items.length) { showToast('Kein offener Termin bis zu diesem Datum.', 'info'); return; }
        $('ctlBulkSave').disabled = true;
        const now = new Date().toISOString();
        const note = $('ctlBulkNote').value.trim().slice(0, 120) || 'Sammel-Abschluss';
        const rows = items.map(item => { const existing = followupOf(bulkKind, item.id); return { kind: bulkKind, ref_id: item.id, profile_id: item.interpreter_id, profile_name: item.interpreter_name || nameOf(item.interpreter_id), status: 'entschuldigt', note, reminded_count: existing?.reminded_count || 0, reminded_at: existing?.reminded_at || null, resolved_at: now, resolved_by: profile.full_name || 'Einsatzleitung', updated_at: now }; });
        const { data, error } = await client.from('tt_followups').upsert(rows, { onConflict: 'kind,ref_id' }).select();
        $('ctlBulkSave').disabled = false;
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        (data || []).forEach(item => followups.set(key(item.kind, item.ref_id), item));
        $('ctlBulkDialog').close();
        showToast(`${items.length} Termine als geklärt markiert.`, 'success');
        render();
    });

    // ---------- Bedienung ----------
    document.querySelectorAll('[data-ctl-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.ctlTab; render(); }));
    $('ctlShowDone').addEventListener('change', () => { showDone = $('ctlShowDone').checked; render(); });
    $('ctlRange').addEventListener('change', () => refresh());
    $('ctlReload').addEventListener('click', () => refresh());
    const wanted = new URLSearchParams(location.search).get('reiter');
    if (['berichte', 'unterlagen', 'fahrzeuge', 'personen'].includes(wanted)) tab = wanted;
    window.KontrolleApp = { refresh, state: () => ({ assignments, documents, followups: [...followups.values()], handovers }) };
    refresh();
})();
