// Festangestellte: Überstunden prüfen (bestätigen / ablehnen / korrigieren), Belege ansehen und korrigieren,
// Abwesenheiten führen – Urlaub, Krank, Verspätung, Fehlstunden und Notfall jeweils getrennt.
// Die Überstunden trägt jede Person im Portal selbst ein – mit dem Termin, wegen dem es länger ging.
// Urlaub beantragt die Person im Portal, Krankheit und Notfall meldet sie dort; Verspätung und Fehlstunden trägt die Einsatzleitung ein.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const logic = window.AbsenceLogic;
    const MONTH_KEY = 'terminTool.fest.month';
    const TAB_NAMES = { ueberstunden: 'overtime', belege: 'receipts', abwesenheiten: 'absences' };
    let profile = null;
    let month = '';
    let overtime = [];
    let receipts = [];
    let people = [];                 // alle Konten (für Namen und die Auswahl „Person“)
    let absences = [];               // Einträge des gewählten Jahres + alles, was noch auf eine Entscheidung wartet
    let absencesReady = true;        // false: Update 15 fehlt noch
    let absenceYear = new Date().getFullYear();
    let absencePerson = '';
    let absenceKind = '';
    let workHours = { start: '09:00', ende: '16:00' };
    let tab = TAB_NAMES[new URLSearchParams(location.search).get('reiter')] || 'overtime';

    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const euro = value => Number(value || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    const date = iso => { const [year, monthPart, day] = String(iso).split('-'); return `${day}.${monthPart}.${year}`; };
    const duration = minutes => logic.formatMinutes(minutes);
    const minutesOf = item => Number(item.minutes_before || 0) + Number(item.minutes_after || 0);
    const pill = (status, text) => { const node = el('span', 'status-pill', text || status); node.dataset.status = { eingereicht: 'in Arbeit', 'bestätigt': 'erledigt', 'geprüft': 'erledigt', abgelehnt: 'offen', beantragt: 'in Arbeit', genehmigt: 'erledigt' }[status] || status; return node; };
    const button = (className, text, onClick) => { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', onClick); return node; };

    function setStatus(message, kind = 'info') {
        const status = $('festStatus');
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    function defaultMonth() {
        try { const saved = sessionStorage.getItem(MONTH_KEY); if (/^\d{4}-\d{2}$/.test(saved || '')) return saved; } catch (error) { /* ohne Speicher: aktueller Monat */ }
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    function monthRange(value) {
        const [year, number] = value.split('-').map(Number);
        const last = new Date(year, number, 0).getDate();
        return { start: `${value}-01`, end: `${value}-${String(last).padStart(2, '0')}`, label: new Date(year, number - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }) };
    }

    async function refresh() {
        setStatus('');
        if (!client) { setStatus('Die Verbindung zur Datenbank konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu.', 'error'); return; }
        try { profile = await TerminCloud.getProfile(true); } catch (error) { setStatus(error.message, 'error'); return; }
        if (!TerminCloud.isStaff(profile)) { $('festApp').hidden = true; setStatus('Bitte melde dich zuerst auf der Seite „Team“ an.', 'error'); return; }
        if (!month) month = defaultMonth();
        $('festMonth').value = month;
        const range = monthRange(month);
        const [overtimeResult, receiptResult, profileResult, yearResult, waitingResult, hoursResult] = await Promise.all([
            client.from('tt_overtime').select('*').gte('date', range.start).lte('date', range.end).order('date'),
            client.from('tt_receipts').select('*').gte('date', range.start).lte('date', range.end).order('date'),
            client.from('tt_profiles').select('*').order('full_name'),
            client.from('tt_absences').select('*').lte('date_from', `${absenceYear}-12-31`).gte('date_to', `${absenceYear}-01-01`).order('date_from', { ascending: false }),
            client.from('tt_absences').select('*').eq('status', 'beantragt').order('created_at'),
            client.from('tt_settings').select('value').eq('key', 'arbeitszeit').maybeSingle()
        ]);
        if (window.PhotoRequest) await PhotoRequest.load().catch(() => []);
        if (overtimeResult.error) { $('festApp').hidden = true; setStatus(`${TerminCloud.germanError(overtimeResult.error)} Bitte supabase/update-8.sql im SQL Editor ausführen.`, 'error'); return; }
        people = profileResult.data || [];
        const festIds = new Set(people.filter(item => item.employment === 'fest').map(item => item.id));
        overtime = overtimeResult.data;
        receipts = receiptResult.error ? [] : receiptResult.data.filter(item => festIds.has(item.profile_id));
        absencesReady = !yearResult.error;
        const byId = new Map();
        [...(yearResult.error ? [] : yearResult.data), ...(waitingResult.error ? [] : waitingResult.data)].forEach(item => byId.set(item.id, item));
        absences = [...byId.values()];
        if (!hoursResult.error && hoursResult.data?.value) workHours = { ...workHours, ...hoursResult.data.value };
        $('festApp').hidden = false;
        render();
    }

    function render() {
        const range = monthRange(month);
        const sum = status => overtime.filter(item => item.status === status).reduce((total, item) => total + minutesOf(item), 0);
        const open = overtime.filter(item => item.status === 'eingereicht');
        const validReceipts = receipts.filter(item => item.status !== 'abgelehnt');
        const openReceipts = receipts.filter(item => item.status === 'eingereicht').length;
        const waiting = absences.filter(item => item.status === 'beantragt').length;
        $('sumConfirmed').textContent = duration(sum('bestätigt'));
        $('sumConfirmedPeople').textContent = `${new Set(overtime.filter(item => item.status === 'bestätigt').map(item => item.profile_id)).size} Personen · ${range.label}`;
        $('sumOpen').textContent = duration(sum('eingereicht'));
        $('sumOpenCount').textContent = `${open.length} ${open.length === 1 ? 'Meldung' : 'Meldungen'}`;
        $('sumFestReceipts').textContent = euro(validReceipts.reduce((total, item) => total + Number(item.amount), 0));
        $('sumFestReceiptCount').textContent = `${validReceipts.length} ${validReceipts.length === 1 ? 'Beleg' : 'Belege'}${openReceipts ? ` · ${openReceipts} noch zu prüfen` : ''}`;
        const check = $('festCheck');
        const todo = [open.length ? `${open.length} ${open.length === 1 ? 'Überstunden-Meldung' : 'Überstunden-Meldungen'} prüfen` : '', openReceipts ? `${openReceipts} ${openReceipts === 1 ? 'Beleg' : 'Belege'} prüfen` : ''].filter(Boolean);
        check.textContent = todo.length ? `Noch offen: ${todo.join(' · ')}` : 'Alles geprüft – für diesen Monat ist nichts offen.';
        check.dataset.kind = todo.length ? 'warn' : 'ok';
        [['festBadgeOvertime', open.length], ['festBadgeReceipts', openReceipts], ['festBadgeAbsences', waiting]].forEach(([id, count]) => { $(id).hidden = !count; $(id).textContent = String(count); });
        document.querySelectorAll('[data-fest-tab]').forEach(node => { node.classList.toggle('is-active', node.dataset.festTab === tab); node.setAttribute('aria-selected', String(node.dataset.festTab === tab)); });
        document.querySelectorAll('[data-fest-panel]').forEach(panel => { panel.hidden = panel.dataset.festPanel !== tab; });
        document.querySelectorAll('[data-fest-scope="month"]').forEach(node => { node.hidden = tab === 'absences'; });
        renderPersons();
        renderOvertime();
        renderReceipts();
        renderAbsences();
    }

    function emptyRow(body, columns, text) {
        const tr = el('tr');
        const td = el('td', null, text);
        td.colSpan = columns;
        tr.append(td);
        body.append(tr);
    }

    function personRows() {
        const byPerson = new Map();
        overtime.forEach(item => {
            const row = byPerson.get(item.profile_id) || { name: item.person_name, confirmed: 0, open: 0, rejected: 0, count: 0 };
            row.count += 1;
            if (item.status === 'bestätigt') row.confirmed += minutesOf(item);
            else if (item.status === 'eingereicht') row.open += minutesOf(item);
            else row.rejected += minutesOf(item);
            byPerson.set(item.profile_id, row);
        });
        return [...byPerson.values()].sort((left, right) => left.name.localeCompare(right.name, 'de'));
    }

    function renderPersons() {
        const body = $('personBody');
        body.replaceChildren();
        const rows = personRows();
        if (!rows.length) { emptyRow(body, 5, 'Für diesen Monat hat noch niemand Überstunden gemeldet.'); return; }
        rows.forEach(row => {
            const tr = el('tr');
            tr.append(el('td', null, row.name), el('td', null, duration(row.confirmed)), el('td', null, row.open ? duration(row.open) : '–'), el('td', null, row.rejected ? duration(row.rejected) : '–'), el('td', null, String(row.count)));
            body.append(tr);
        });
    }

    async function review(item, status, note) {
        const { error } = await client.from('tt_overtime').update({ status, review_note: note || '', reviewed_by: profile.full_name || '', reviewed_at: new Date().toISOString() }).eq('id', item.id);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        showToast(status === 'bestätigt' ? `Überstunden von ${item.person_name} bestätigt.` : status === 'abgelehnt' ? 'Überstunden abgelehnt.' : 'Zurück auf „zu prüfen“ gesetzt.', 'success');
        await refresh();
        window.refreshCloudInbox?.();
    }

    function askReject(text, placeholder) {
        return new Promise(resolve => {
            const dialog = $('rejectDialog');
            $('rejectText').textContent = text;
            $('rejectNote').value = '';
            $('rejectNote').placeholder = placeholder || 'Zum Beispiel: Termin war um 15:30 Uhr beendet';
            const finish = value => { dialog.close(); $('rejectForm').onsubmit = null; $('rejectCancel').onclick = null; resolve(value); };
            $('rejectForm').onsubmit = event => { event.preventDefault(); const note = $('rejectNote').value.trim(); if (note) finish(note); };
            $('rejectCancel').onclick = () => finish(null);
            dialog.oncancel = event => { event.preventDefault(); finish(null); };
            dialog.showModal();
            $('rejectNote').focus();
        });
    }

    function renderOvertime() {
        const body = $('overtimeBody');
        body.replaceChildren();
        if (!overtime.length) { emptyRow(body, 8, 'Keine Meldungen in diesem Monat.'); return; }
        // Offene Meldungen zuerst.
        [...overtime].sort((left, right) => Number(left.status !== 'eingereicht') - Number(right.status !== 'eingereicht') || String(left.date).localeCompare(String(right.date))).forEach(item => {
            const tr = el('tr', item.status === 'abgelehnt' ? 'payroll-rejected' : '');
            const times = [item.start_time ? `Beginn ${String(item.start_time).slice(0, 5)}` : '', item.end_time ? `Ende ${String(item.end_time).slice(0, 5)}` : ''].filter(Boolean).join(' · ');
            const parts = [item.minutes_before ? `${duration(item.minutes_before)} vorher` : '', item.minutes_after ? `${duration(item.minutes_after)} danach` : ''].filter(Boolean).join(', ');
            const amount = el('td');
            amount.append(el('strong', null, duration(minutesOf(item))), el('small', 'table-sub', parts));
            const note = el('td', null, [item.note, item.status === 'abgelehnt' && item.review_note ? `Abgelehnt: ${item.review_note}` : ''].filter(Boolean).join(' · ') || '–');
            const state = el('td');
            state.append(pill(item.status, item.status === 'eingereicht' ? 'zu prüfen' : item.status));
            const actions = el('td');
            const box = el('span', 'vehicle-entry-actions');
            if (item.status !== 'bestätigt') box.append(button('button-primary account-approve', 'Bestätigen', () => review(item, 'bestätigt', '')));
            if (item.status !== 'abgelehnt') {
                box.append(button('button-quiet-danger', 'Ablehnen', async () => {
                    const reason = await askReject(`Überstunden von ${item.person_name} am ${date(item.date)} (${duration(minutesOf(item))}) ablehnen?`);
                    if (reason) review(item, 'abgelehnt', reason);
                }));
            }
            const edit = button('button-quiet', 'Korrigieren', () => openOvertime(item));
            edit.setAttribute('aria-label', `Überstunden von ${item.person_name} am ${date(item.date)} korrigieren`);
            box.append(edit);
            actions.append(box);
            tr.append(el('td', null, date(item.date)), el('td', null, item.person_name), el('td', null, item.appointment || '–'), el('td', null, times || '–'), amount, note, state, actions);
            body.append(tr);
        });
    }

    // ---------- Überstunden korrigieren oder löschen ----------
    const toMinutes = time => Number(String(time).slice(0, 2)) * 60 + Number(String(time).slice(3, 5));
    const roundUp = minutes => Math.ceil(minutes / 10) * 10;
    let editedOvertime = null;
    function openOvertime(item) {
        editedOvertime = item;
        $('overtimeEditWho').textContent = `${item.person_name} · gemeldet am ${logic.stampDate(item.created_at)} · Arbeitszeit ${workHours.start} bis ${workHours.ende} Uhr`;
        $('overtimeEditDate').value = item.date;
        $('overtimeEditAppointment').value = item.appointment || '';
        $('overtimeEditStart').value = item.start_time ? String(item.start_time).slice(0, 5) : '';
        $('overtimeEditEnd').value = item.end_time ? String(item.end_time).slice(0, 5) : '';
        $('overtimeEditNote').value = item.note || '';
        $('overtimeEditDelete').hidden = !TerminCloud.isAdmin(profile);
        $('overtimeDialog').showModal();
    }
    $('overtimeEditCancel').addEventListener('click', () => $('overtimeDialog').close());
    $('overtimeEditForm').addEventListener('submit', async event => {
        event.preventDefault();
        const item = editedOvertime;
        const start = $('overtimeEditStart').value;
        const end = $('overtimeEditEnd').value;
        if (!$('overtimeEditDate').value) { showToast('Bitte wähle das Datum.', 'error', { target: '#overtimeEditDate' }); return; }
        const before = start && toMinutes(start) < toMinutes(workHours.start) ? roundUp(toMinutes(workHours.start) - toMinutes(start)) : 0;
        const after = end && toMinutes(end) > toMinutes(workHours.ende) ? roundUp(toMinutes(end) - toMinutes(workHours.ende)) : 0;
        if (before + after <= 0) { showToast(`Das sind keine Überstunden: Die Zeiten liegen innerhalb der Arbeitszeit (${workHours.start} bis ${workHours.ende} Uhr).`, 'error', { target: '#overtimeEditStart' }); return; }
        // Die Minuten rechnet die Datenbank selbst noch einmal aus – hier nur zur Anzeige mitgeschickt.
        const { error } = await client.from('tt_overtime').update({
            date: $('overtimeEditDate').value, appointment: $('overtimeEditAppointment').value.trim(), start_time: start ? `${start}:00` : null, end_time: end ? `${end}:00` : null,
            minutes_before: before, minutes_after: after, note: $('overtimeEditNote').value.trim()
        }).eq('id', item.id);
        if (error) { showToast(TerminCloud.germanError(error), 'error', { target: '#overtimeEditStart' }); return; }
        $('overtimeDialog').close();
        showToast(`Überstunden von ${item.person_name} korrigiert: ${duration(before + after)}.`, 'success');
        await refresh();
    });
    $('overtimeEditDelete').addEventListener('click', async () => {
        const item = editedOvertime;
        if (!await confirmDialog(`Überstunden von ${item.person_name} am ${date(item.date)} (${duration(minutesOf(item))}) endgültig löschen?\n\nDer Eintrag verschwindet auch im Portal der Person.`, 'Endgültig löschen')) return;
        const { data, error } = await client.from('tt_overtime').delete().eq('id', item.id).select();
        if (error || !data?.length) { showToast(error ? TerminCloud.germanError(error) : 'Der Eintrag konnte nicht gelöscht werden.', 'error'); return; }
        $('overtimeDialog').close();
        showToast('Überstunden gelöscht.', 'success');
        await refresh();
        window.refreshCloudInbox?.();
    });

    async function showPhoto(path) {
        // Belege aus dem Portal sind seit dem Scannen PDFs – die öffnen sich in einem neuen Tab.
        if (/\.pdf$/i.test(path || '')) { const link = await TerminCloud.photoUrl(path); if (link) window.open(link, '_blank', 'noopener'); else showToast('Der Beleg konnte nicht geöffnet werden.', 'error'); return; }
        const url = await TerminCloud.photoUrl(path);
        if (!url) { showToast('Das Foto konnte nicht geladen werden.', 'error'); return; }
        $('photoDialogImage').src = url;
        $('photoDialog').showModal();
    }
    $('photoDialogClose').addEventListener('click', () => $('photoDialog').close());

    function renderReceipts() {
        const body = $('festReceiptBody');
        body.replaceChildren();
        if (!receipts.length) { emptyRow(body, 9, 'Für diesen Monat haben die Festangestellten keine Belege eingereicht.'); return; }
        [...receipts].sort((left, right) => left.person_name.localeCompare(right.person_name, 'de') || String(left.date).localeCompare(String(right.date))).forEach(item => {
            const tr = el('tr', item.status === 'abgelehnt' ? 'payroll-rejected' : '');
            const photoCell = el('td');
            if (item.photo_path) photoCell.append(button('button-secondary fleet-end-button', /\.pdf$/i.test(item.photo_path) ? 'PDF' : 'Foto', () => showPhoto(item.photo_path)));
            else photoCell.textContent = '–';
            // Ist das Foto unleserlich (oder fehlt es), die Person um ein neues bitten.
            if (window.PhotoRequest && item.profile_id && item.source === 'portal') {
                photoCell.classList.add('photo-cell');
                photoCell.append(PhotoRequest.button({ kind: 'beleg', refId: item.id, profileId: item.profile_id, profileName: item.person_name,
                    title: ['Beleg', item.place, euro(item.amount), date(item.date)].filter(Boolean).join(' · '), paths: [item.photo_path] }, renderReceipts));
                const state = PhotoRequest.pill(item.id);
                if (state) photoCell.append(state);
            }
            const statusCell = el('td');
            const select = el('select');
            ['eingereicht', 'geprüft', 'abgelehnt'].forEach(value => { const option = el('option', null, value === 'eingereicht' ? 'zu prüfen' : value); option.value = value; select.append(option); });
            select.value = item.status;
            select.setAttribute('aria-label', `Status für Beleg von ${item.person_name}`);
            select.addEventListener('change', async () => {
                const { error } = await client.from('tt_receipts').update({ status: select.value }).eq('id', item.id);
                if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                showToast('Status gespeichert.', 'success');
                await refresh();
                window.refreshCloudInbox?.();
            });
            statusCell.append(select);
            const actions = el('td');
            const edit = button('button-quiet', 'Korrigieren', () => openReceipt(item));
            edit.setAttribute('aria-label', `Beleg von ${item.person_name} vom ${date(item.date)} korrigieren`);
            actions.append(edit);
            tr.append(el('td', null, date(item.date)), el('td', null, item.person_name), el('td', null, item.place || '–'), el('td', null, item.kind || '–'), el('td', null, euro(item.amount)), el('td', null, item.note || '–'), photoCell, statusCell, actions);
            body.append(tr);
        });
    }

    // ---------- Beleg korrigieren oder löschen ----------
    let editedReceipt = null;
    function openReceipt(item) {
        editedReceipt = item;
        $('receiptEditWho').textContent = `${item.person_name} · eingereicht am ${logic.stampDate(item.created_at)}`;
        $('receiptEditDate').value = item.date;
        $('receiptEditPlace').value = item.place || '';
        $('receiptEditKind').value = ['Parken', 'Tanken', 'Sonstiges'].includes(item.kind) ? item.kind : 'Sonstiges';
        $('receiptEditAmount').value = Number(item.amount || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        $('receiptEditNote').value = item.note || '';
        $('receiptEditDelete').hidden = !TerminCloud.isAdmin(profile);
        $('receiptDialog').showModal();
    }
    $('receiptEditCancel').addEventListener('click', () => $('receiptDialog').close());
    $('receiptEditForm').addEventListener('submit', async event => {
        event.preventDefault();
        const item = editedReceipt;
        // „12,50“ und „12.50“ sind beide erlaubt; Tausenderpunkte („1.234,50“) werden entfernt.
        const raw = $('receiptEditAmount').value.trim().replace(/\s|€/g, '');
        const amount = Number(/,/.test(raw) ? raw.replace(/\./g, '').replace(',', '.') : raw);
        if (!$('receiptEditDate').value) { showToast('Bitte wähle das Datum.', 'error', { target: '#receiptEditDate' }); return; }
        if (!raw || !Number.isFinite(amount) || amount < 0 || amount > 100000) { showToast('Bitte trag den Betrag in Euro ein, zum Beispiel 12,50.', 'error', { target: '#receiptEditAmount' }); return; }
        const { error } = await client.from('tt_receipts').update({
            date: $('receiptEditDate').value, place: $('receiptEditPlace').value.trim(), kind: $('receiptEditKind').value, amount: Math.round(amount * 100) / 100, note: $('receiptEditNote').value.trim()
        }).eq('id', item.id);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        $('receiptDialog').close();
        showToast(`Beleg von ${item.person_name} korrigiert.`, 'success');
        await refresh();
    });
    $('receiptEditDelete').addEventListener('click', async () => {
        const item = editedReceipt;
        if (!await confirmDialog(`Beleg von ${item.person_name} vom ${date(item.date)} (${euro(item.amount)}) endgültig löschen?\n\nAuch das Foto wird gelöscht.`, 'Endgültig löschen')) return;
        const { data, error } = await client.from('tt_receipts').delete().eq('id', item.id).select();
        if (error || !data?.length) { showToast(error ? TerminCloud.germanError(error) : 'Der Beleg konnte nicht gelöscht werden.', 'error'); return; }
        if (item.photo_path) await client.storage.from('schaeden').remove([item.photo_path]).catch(() => null);
        $('receiptDialog').close();
        showToast('Beleg gelöscht.', 'success');
        await refresh();
        window.refreshCloudInbox?.();
    });

    // =====================================================================
    // Abwesenheiten
    // =====================================================================
    const KIND_IDS = { urlaub: 'Urlaub', krank: 'Krank', 'verspätung': 'Verspaetung', fehlstunden: 'Fehlstunden', notfall: 'Notfall' };
    // Wie der Stand je Art heißt: Urlaub wird beantragt und genehmigt, Krankheit und Notfall werden gemeldet und eingetragen.
    function statusText(item) {
        if (item.kind === 'urlaub') return item.status;
        if (item.kind === 'krank' || item.kind === 'notfall') return { beantragt: 'gemeldet', genehmigt: 'eingetragen', abgelehnt: 'nicht anerkannt' }[item.status];
        return { beantragt: 'offen', genehmigt: 'eingetragen', abgelehnt: 'storniert' }[item.status];
    }
    const yearRange = () => [`${absenceYear}-01-01`, `${absenceYear}-12-31`];
    const inYear = item => item.date_from <= `${absenceYear}-12-31` && item.date_to >= `${absenceYear}-01-01`;
    const nameOf = item => people.find(person => person.id === item.profile_id)?.full_name || item.person_name || 'Unbekannt';
    const counts = item => item.status !== 'abgelehnt';
    const wholeDays = item => item.kind === 'urlaub' || item.kind === 'krank' || (item.kind === 'notfall' && !item.minutes);
    function amountText(item) {
        if (item.minutes) return duration(item.minutes);
        if (!wholeDays(item)) return '–';
        return `${logic.formatDays(logic.dayCount(item))}${item.days != null && item.days !== '' ? ' (korrigiert)' : ''}`;
    }

    // Summen einer Liste von Einträgen – für die Kacheln, die Zeilen je Person und die Excel-Datei.
    function totals(list) {
        const [start, end] = yearRange();
        const of = kind => list.filter(item => item.kind === kind && counts(item) && inYear(item));
        const days = items => items.reduce((sum, item) => sum + logic.dayCount(item, start, end), 0);
        const minutes = items => items.reduce((sum, item) => sum + Number(item.minutes || 0), 0);
        const vacation = of('urlaub');
        const emergencies = of('notfall');
        return {
            vacationDays: days(vacation.filter(item => item.status === 'genehmigt')),
            vacationWaiting: vacation.filter(item => item.status === 'beantragt').length,
            vacationWaitingDays: days(vacation.filter(item => item.status === 'beantragt')),
            sickDays: days(of('krank')), sickCount: of('krank').length,
            lateCount: of('verspätung').length, lateMinutes: minutes(of('verspätung')),
            missedMinutes: minutes(of('fehlstunden')), missedCount: of('fehlstunden').length,
            emergencyCount: emergencies.length, emergencyDays: days(emergencies.filter(item => !item.minutes)), emergencyMinutes: minutes(emergencies)
        };
    }

    function absenceRows() {
        const fest = people.filter(person => person.employment === 'fest' && person.role === 'dolmetscher' && person.active);
        const ids = new Set(fest.map(person => person.id));
        // Auch Personen, die nicht (mehr) fest angestellt sind, aber Einträge in diesem Jahr haben
        absences.filter(inYear).forEach(item => { if (!ids.has(item.profile_id)) { ids.add(item.profile_id); fest.push({ id: item.profile_id, full_name: nameOf(item), former: true }); } });
        return fest.map(person => ({ id: person.id, name: person.full_name || 'Unbekannt', former: Boolean(person.former), ...totals(absences.filter(item => item.profile_id === person.id)) }))
            .sort((left, right) => left.name.localeCompare(right.name, 'de'));
    }

    function renderAbsences() {
        $('absenceSetup').hidden = absencesReady;
        if (!absencesReady) { $('absenceInboxCard').hidden = true; }
        // Auswahl Jahr und Person
        const thisYear = new Date().getFullYear();
        const years = [...new Set([thisYear - 2, thisYear - 1, thisYear, thisYear + 1, absenceYear])].sort((left, right) => right - left);
        $('absenceYear').replaceChildren(...years.map(year => { const option = el('option', null, String(year)); option.value = String(year); return option; }));
        $('absenceYear').value = String(absenceYear);
        const rows = absenceRows();
        const personSelect = $('absencePerson');
        personSelect.replaceChildren(el('option', null, 'Alle Festangestellten'), ...rows.map(row => { const option = el('option', null, row.name); option.value = row.id; return option; }));
        personSelect.firstElementChild.value = '';
        if (absencePerson && !rows.some(row => row.id === absencePerson)) absencePerson = '';
        personSelect.value = absencePerson;

        // Kacheln: Summen für das Jahr (und die gewählte Person); ein Klick filtert die Liste nach der Art.
        const shown = absences.filter(item => inYear(item) && (!absencePerson || item.profile_id === absencePerson));
        const sum = totals(shown);
        $('absSumUrlaub').textContent = logic.formatDays(sum.vacationDays);
        $('absSubUrlaub').textContent = sum.vacationWaiting ? `genehmigt · ${sum.vacationWaiting} ${sum.vacationWaiting === 1 ? 'Antrag wartet' : 'Anträge warten'} (${logic.formatDays(sum.vacationWaitingDays)})` : 'genehmigt';
        $('absSumKrank').textContent = logic.formatDays(sum.sickDays);
        $('absSubKrank').textContent = `${sum.sickCount} ${sum.sickCount === 1 ? 'Krankmeldung' : 'Krankmeldungen'}`;
        $('absSumVerspaetung').textContent = `${sum.lateCount} ×`;
        $('absSubVerspaetung').textContent = sum.lateCount ? `${duration(sum.lateMinutes)} insgesamt` : 'keine';
        $('absSumFehlstunden').textContent = duration(sum.missedMinutes);
        $('absSubFehlstunden').textContent = `${sum.missedCount} ${sum.missedCount === 1 ? 'Eintrag' : 'Einträge'}`;
        $('absSumNotfall').textContent = `${sum.emergencyCount} ×`;
        $('absSubNotfall').textContent = sum.emergencyCount ? [sum.emergencyDays ? logic.formatDays(sum.emergencyDays) : '', sum.emergencyMinutes ? duration(sum.emergencyMinutes) : ''].filter(Boolean).join(' · ') || 'gemeldet' : 'keiner';
        document.querySelectorAll('[data-absence-kind]').forEach(node => { const active = node.dataset.absenceKind === absenceKind; node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active)); });

        // Übersicht pro Person
        $('absencePersonTitle').textContent = `Übersicht pro Person · ${absenceYear}`;
        const personBody = $('absencePersonBody');
        personBody.replaceChildren();
        const cell = (main, sub) => { const td = el('td'); td.append(el('strong', main === '–' ? 'is-zero' : null, main)); if (sub) td.append(el('small', 'table-sub', sub)); return td; };
        const visibleRows = rows.filter(row => !absencePerson || row.id === absencePerson);
        if (!visibleRows.length) emptyRow(personBody, 6, 'Es gibt noch keine fest angestellten Dolmetscher. Auf der Seite „Team“ lässt sich ein Konto als „fest“ markieren.');
        visibleRows.forEach(row => {
            const tr = el('tr');
            const name = el('td');
            const open = button('link-button absence-person-link', row.name, () => { absencePerson = absencePerson === row.id ? '' : row.id; renderAbsences(); });
            open.title = absencePerson === row.id ? 'Wieder alle Personen zeigen' : `Nur die Einträge von ${row.name} zeigen`;
            name.append(open);
            if (row.former) name.append(el('small', 'table-sub', 'nicht (mehr) fest angestellt'));
            tr.append(name,
                cell(row.vacationDays ? logic.formatDays(row.vacationDays) : '–', row.vacationWaiting ? `${row.vacationWaiting} beantragt (${logic.formatDays(row.vacationWaitingDays)})` : ''),
                cell(row.sickDays ? logic.formatDays(row.sickDays) : '–', row.sickCount > 1 ? `${row.sickCount} Krankmeldungen` : ''),
                cell(row.lateCount ? `${row.lateCount} ×` : '–', row.lateCount ? duration(row.lateMinutes) : ''),
                cell(row.missedMinutes ? duration(row.missedMinutes) : '–', row.missedCount > 1 ? `${row.missedCount} Einträge` : ''),
                cell(row.emergencyCount ? `${row.emergencyCount} ×` : '–', [row.emergencyDays ? logic.formatDays(row.emergencyDays) : '', row.emergencyMinutes ? duration(row.emergencyMinutes) : ''].filter(Boolean).join(' · ')));
            personBody.append(tr);
        });
        const foot = $('absencePersonFoot');
        foot.replaceChildren();
        if (visibleRows.length > 1) {
            const all = totals(absences.filter(inYear));
            const tr = el('tr', 'absence-total');
            tr.append(el('th', null, 'Alle zusammen'), el('td', null, logic.formatDays(all.vacationDays)), el('td', null, logic.formatDays(all.sickDays)), el('td', null, `${all.lateCount} × · ${duration(all.lateMinutes)}`), el('td', null, duration(all.missedMinutes)), el('td', null, `${all.emergencyCount} ×`));
            foot.append(tr);
        }

        // Alle Einträge (nach Art gefiltert)
        const listed = shown.filter(item => !absenceKind || item.kind === absenceKind)
            .sort((left, right) => Number(right.status === 'beantragt') - Number(left.status === 'beantragt') || String(right.date_from).localeCompare(String(left.date_from)));
        $('absenceListTitle').textContent = `${absenceKind ? logic.KINDS[absenceKind].plural : 'Alle Einträge'} · ${absenceYear}${absencePerson ? ` · ${rows.find(row => row.id === absencePerson)?.name || ''}` : ''} (${listed.length})`;
        const body = $('absenceBody');
        body.replaceChildren();
        if (!listed.length) emptyRow(body, 7, absenceKind || absencePerson ? 'Dazu gibt es in diesem Jahr keinen Eintrag.' : 'In diesem Jahr gibt es noch keinen Eintrag.');
        listed.forEach(item => {
            const tr = el('tr', item.status === 'abgelehnt' ? 'absence-rejected' : '');
            tr.dataset.absence = item.id;
            const when = el('td');
            when.append(el('strong', null, logic.rangeText(item)));
            if (item.kind === 'urlaub') when.append(el('small', 'table-sub', `beantragt am ${logic.stampDate(item.created_at)}`));
            const note = el('td', null, [item.note, item.status === 'abgelehnt' && item.review_note ? `Grund: ${item.review_note}` : '', item.created_by && item.created_by !== item.profile_id && item.created_by_name ? `eingetragen von ${item.created_by_name}` : ''].filter(Boolean).join(' · ') || '–');
            const state = el('td');
            state.append(pill(item.status, statusText(item)));
            if (item.reviewed_by && item.status !== 'beantragt') state.append(el('small', 'table-sub', `${item.reviewed_by}${item.reviewed_at ? ` · ${logic.stampDate(item.reviewed_at)}` : ''}`));
            const actions = el('td');
            const box = el('span', 'vehicle-entry-actions');
            if (item.status === 'beantragt') decisionButtons(item).forEach(node => box.append(node));
            const edit = button('button-quiet', 'Korrigieren', () => openAbsence(item));
            edit.setAttribute('aria-label', `${logic.KINDS[item.kind].label} von ${nameOf(item)} korrigieren`);
            box.append(edit);
            actions.append(box);
            tr.append(when, el('td', null, nameOf(item)), el('td', null, logic.KINDS[item.kind]?.label || item.kind), el('td', null, amountText(item)), note, state, actions);
            body.append(tr);
        });

        // Wartet auf dich: Urlaubsanträge und neue Meldungen – unabhängig vom gewählten Jahr
        const waiting = absences.filter(item => item.status === 'beantragt').sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
        $('absenceInboxCard').hidden = !waiting.length || !absencesReady;
        $('absenceInbox').replaceChildren(...waiting.map(item => {
            const row = el('li', 'vehicle-entry inbox-entry absence-waiting');
            row.dataset.absence = item.id;
            const meta = el('span');
            meta.append(el('strong', null, `${nameOf(item)} · ${item.kind === 'urlaub' ? 'Urlaubsantrag' : item.kind === 'krank' ? 'Krankmeldung' : 'Notfall'}`),
                el('small', null, [logic.rangeText(item), wholeDays(item) ? logic.formatDays(logic.dayCount(item), 'Arbeitstag', 'Arbeitstage') : '', item.note, `${item.kind === 'urlaub' ? 'beantragt' : 'gemeldet'} am ${logic.stampDate(item.created_at)}`].filter(Boolean).join(' · ')));
            const clash = item.kind === 'urlaub' ? overlapNote(item) : '';
            if (clash) meta.append(el('small', 'entry-warning', clash));
            const actions = el('span', 'vehicle-entry-actions');
            decisionButtons(item).forEach(node => actions.append(node));
            actions.append(button('button-quiet', 'Ansehen', () => openAbsence(item)));
            row.append(pill('beantragt', statusText(item)), meta, actions);
            return row;
        }));
    }

    // Hinweis beim Urlaubsantrag: Wer ist in diesem Zeitraum ebenfalls schon weg?
    function overlapNote(item) {
        const others = absences.filter(other => other.id !== item.id && other.profile_id !== item.profile_id && other.kind === 'urlaub' && other.status === 'genehmigt' && other.date_from <= item.date_to && other.date_to >= item.date_from);
        const names = [...new Set(others.map(nameOf))];
        return names.length ? `Im selben Zeitraum hat schon Urlaub: ${names.slice(0, 4).join(', ')}${names.length > 4 ? ' …' : ''}` : '';
    }

    function decisionButtons(item) {
        const approve = button('button-primary account-approve', item.kind === 'urlaub' ? 'Genehmigen' : 'Eintragen', () => decide(item, 'genehmigt', ''));
        const reject = button('button-quiet-danger', item.kind === 'urlaub' ? 'Ablehnen' : 'Nicht anerkennen', async () => {
            const kind = logic.KINDS[item.kind].label;
            const reason = await askReject(`${kind} von ${nameOf(item)} (${logic.rangeText(item)}) ${item.kind === 'urlaub' ? 'ablehnen' : 'nicht anerkennen'}?`, item.kind === 'urlaub' ? 'Zum Beispiel: In dieser Woche sind schon zwei Kollegen im Urlaub' : 'Zum Beispiel: Bitte Krankschreibung nachreichen');
            if (reason) decide(item, 'abgelehnt', reason);
        });
        return [approve, reject];
    }

    // Die Person bekommt die Entscheidung aufs Handy (Urlaub immer; Krankheit/Notfall nur, wenn nicht anerkannt).
    function tellPerson(item, status, note) {
        if (status === 'beantragt' || (item.kind !== 'urlaub' && status !== 'abgelehnt')) return;
        const kind = logic.KINDS[item.kind].label;
        TerminCloud.callFunction({
            action: 'notify', audience: 'einzeln', recipientIds: [item.profile_id], page: 'zeiten',
            title: item.kind === 'urlaub' ? (status === 'genehmigt' ? 'Urlaub genehmigt' : 'Urlaub abgelehnt') : `${kind}: nicht anerkannt`,
            body: `${logic.rangeText(item)}${status === 'genehmigt' ? ` · ${logic.formatDays(logic.dayCount(item), 'Arbeitstag', 'Arbeitstage')}` : ''}${note ? ` · ${note}` : ''}`
        });
    }

    async function decide(item, status, note) {
        const { data, error } = await client.from('tt_absences').update({ status, review_note: note || '', reviewed_by: profile.full_name || '', reviewed_at: new Date().toISOString() }).eq('id', item.id).select();
        if (error || !data?.length) { showToast(error ? TerminCloud.germanError(error) : 'Der Eintrag wurde inzwischen zurückgezogen.', 'error'); await refresh(); return; }
        tellPerson(item, status, note);
        const kind = logic.KINDS[item.kind].label;
        showToast(status === 'genehmigt' ? (item.kind === 'urlaub' ? `Urlaub von ${nameOf(item)} genehmigt.` : `${kind} von ${nameOf(item)} eingetragen.`) : `${kind} von ${nameOf(item)} ${item.kind === 'urlaub' ? 'abgelehnt' : 'nicht anerkannt'}.`, 'success');
        await refresh();
        window.refreshCloudInbox?.();
    }

    // ---------- Eintrag hinzufügen oder korrigieren ----------
    let editedAbsence = null;
    const editKind = () => document.querySelector('input[name=absenceEditKind]:checked')?.value || 'urlaub';
    const editStatus = () => document.querySelector('input[name=absenceEditStatus]:checked')?.value || 'genehmigt';
    const editMinutes = () => Number($('absenceEditHours').value || 0) * 60 + Number($('absenceEditMinutes').value || 0);

    function syncAbsenceForm() {
        const kind = editKind();
        const single = kind === 'verspätung' || kind === 'fehlstunden';
        const from = $('absenceEditFrom').value;
        if (single || !$('absenceEditTo').value || $('absenceEditTo').value < from) $('absenceEditTo').value = from;
        const to = $('absenceEditTo').value;
        $('absenceEditToBox').hidden = single;
        $('absenceEditFromLabel').textContent = single ? 'Am' : 'Von';
        $('absenceEditDurationRow').hidden = !(single || kind === 'notfall');
        $('absenceEditDurationLabel').textContent = kind === 'verspätung' ? 'Wie viel zu spät?' : kind === 'fehlstunden' ? 'Wie lange gefehlt?' : 'Dauer – leer lassen, wenn der ganze Tag ausfällt';
        $('absenceEditDaysRow').hidden = !(kind === 'urlaub' || kind === 'krank');
        const labels = kind === 'urlaub' ? ['beantragt', 'genehmigt', 'abgelehnt'] : kind === 'krank' || kind === 'notfall' ? ['gemeldet', 'eingetragen', 'nicht anerkannt'] : ['offen', 'eingetragen', 'storniert'];
        ['beantragt', 'genehmigt', 'abgelehnt'].forEach((status, index) => { document.querySelector(`[data-status-text="${status}"]`).textContent = labels[index]; });
        // „offen“ gibt es bei Verspätung und Fehlstunden nicht – die trägt die Einsatzleitung selbst ein.
        const waitingOption = document.querySelector('input[name=absenceEditStatus][value=beantragt]');
        waitingOption.closest('label').hidden = single;
        if (single && waitingOption.checked) document.querySelector('input[name=absenceEditStatus][value=genehmigt]').checked = true;
        const info = $('absenceEditInfo');
        if (!from) { info.dataset.kind = 'empty'; info.textContent = single ? 'Wähle den Tag.' : 'Wähle die Tage.'; return; }
        if (to < from) { info.dataset.kind = 'error'; info.textContent = 'Das Ende liegt vor dem Beginn.'; return; }
        const weekday = text => logic.parse(text).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
        if (single || (kind === 'notfall' && editMinutes())) {
            const minutes = editMinutes();
            info.dataset.kind = minutes ? 'ok' : 'empty';
            info.textContent = `${weekday(from)}${minutes ? ` · ${duration(minutes)}` : ' · bitte die Dauer eintragen'}`;
            return;
        }
        const automatic = logic.workingDays(from, to);
        const manual = $('absenceEditDays').value.trim();
        $('absenceEditDays').placeholder = `automatisch: ${String(automatic).replace('.', ',')}`;
        const holidays = [];
        for (let day = from; day <= to && holidays.length < 4; day = logic.addDays(day, 1)) { const name = logic.holidayName(day); if (name && !logic.isWeekend(day)) holidays.push(`${logic.dayMonth(day)} ${name}`); }
        info.dataset.kind = 'ok';
        info.textContent = `${from === to ? weekday(from) : `${logic.shortDate(from)} bis ${logic.shortDate(to)}`} · ${manual && kind !== 'notfall' ? `zählt als ${logic.formatDays(Number(manual.replace(',', '.')))} (automatisch wären es ${logic.formatDays(automatic)})` : logic.formatDays(automatic, 'Arbeitstag', 'Arbeitstage')}${holidays.length ? ` · Feiertag zählt nicht: ${holidays.join(', ')}` : ''}`;
    }

    function openAbsence(item) {
        editedAbsence = item;
        const festPeople = people.filter(person => person.employment === 'fest' && person.role === 'dolmetscher' && person.active);
        if (item && !festPeople.some(person => person.id === item.profile_id)) festPeople.push({ id: item.profile_id, full_name: nameOf(item) });
        if (!festPeople.length) { showToast('Es gibt noch keine fest angestellten Dolmetscher. Markiere zuerst auf der Seite „Team“ ein Konto als „fest“.', 'error'); return; }
        $('absenceDialogTitle').textContent = item ? 'Eintrag korrigieren' : 'Abwesenheit eintragen';
        const select = $('absenceEditPerson');
        select.replaceChildren(...festPeople.sort((left, right) => String(left.full_name).localeCompare(String(right.full_name), 'de')).map(person => { const option = el('option', null, person.full_name || 'Unbekannt'); option.value = person.id; return option; }));
        select.value = item?.profile_id || absencePerson || festPeople[0].id;
        const kind = item?.kind || absenceKind || 'urlaub';
        document.querySelector(`input[name=absenceEditKind][value="${kind}"]`).checked = true;
        $('absenceEditFrom').value = item?.date_from || logic.today();
        $('absenceEditTo').value = item?.date_to || logic.today();
        $('absenceEditHours').value = item?.minutes ? String(Math.floor(item.minutes / 60) || '') : '';
        $('absenceEditMinutes').value = item?.minutes ? String(item.minutes % 60 || '') : '';
        $('absenceEditDays').value = item?.days != null && item.days !== '' ? String(Number(item.days)).replace('.', ',') : '';
        $('absenceEditNote').value = item?.note || '';
        document.querySelector(`input[name=absenceEditStatus][value="${item?.status || 'genehmigt'}"]`).checked = true;
        $('absenceEditDelete').hidden = !item || !TerminCloud.isAdmin(profile);
        $('absenceEditSave').textContent = item ? 'Speichern' : 'Eintragen';
        syncAbsenceForm();
        $('absenceDialog').showModal();
    }
    document.querySelectorAll('input[name=absenceEditKind]').forEach(input => input.addEventListener('change', syncAbsenceForm));
    ['absenceEditFrom', 'absenceEditTo', 'absenceEditHours', 'absenceEditMinutes', 'absenceEditDays'].forEach(id => $(id).addEventListener('input', syncAbsenceForm));
    $('absenceEditCancel').addEventListener('click', () => $('absenceDialog').close());
    $('absenceAdd').addEventListener('click', () => openAbsence(null));

    $('absenceEditForm').addEventListener('submit', async event => {
        event.preventDefault();
        const item = editedAbsence;
        const kind = editKind();
        const single = kind === 'verspätung' || kind === 'fehlstunden';
        const personId = $('absenceEditPerson').value;
        const from = $('absenceEditFrom').value;
        const to = single ? from : $('absenceEditTo').value;
        const minutes = single || kind === 'notfall' ? editMinutes() : 0;
        const daysText = $('absenceEditDays').value.trim().replace(',', '.');
        const days = (kind === 'urlaub' || kind === 'krank') && daysText !== '' ? Number(daysText) : null;
        if (!from) { showToast(single ? 'Bitte wähle den Tag.' : 'Bitte wähle den ersten Tag.', 'error', { target: '#absenceEditFrom' }); return; }
        if (!to || to < from) { showToast('Der letzte Tag darf nicht vor dem ersten liegen.', 'error', { target: '#absenceEditTo' }); return; }
        if (single && !minutes) { showToast(kind === 'verspätung' ? 'Bitte trag ein, wie viel zu spät die Person war.' : 'Bitte trag ein, wie lange die Person gefehlt hat.', 'error', { target: '#absenceEditMinutes' }); return; }
        if (minutes < 0 || minutes > 1440 || !Number.isInteger(minutes)) { showToast('Die Dauer muss zwischen 1 Minute und 24 Stunden liegen.', 'error', { target: '#absenceEditHours' }); return; }
        if (kind === 'notfall' && minutes && to !== from) { showToast('Mit einer Dauer in Stunden gilt der Notfall für einen Tag. Lass die Dauer leer, wenn mehrere ganze Tage ausfallen.', 'error', { target: '#absenceEditTo' }); return; }
        if (days != null && (!Number.isFinite(days) || days < 0 || days > 366 || Math.round(days * 2) !== days * 2)) { showToast('Die Zahl der Tage muss eine Zahl sein – halbe Tage sind möglich (zum Beispiel 4,5).', 'error', { target: '#absenceEditDays' }); return; }
        const status = single && editStatus() === 'beantragt' ? 'genehmigt' : editStatus();
        // Doppelte Einträge vermeiden: dieselbe Person, dieselbe Art, überschneidender Zeitraum
        const { data: sameTime } = await client.from('tt_absences').select('id, date_from, date_to, status').eq('profile_id', personId).eq('kind', kind).lte('date_from', to).gte('date_to', from);
        const clash = (sameTime || []).find(other => other.id !== item?.id && other.status !== 'abgelehnt' && !single);
        if (clash) { showToast(`Für diese Person gibt es in diesem Zeitraum schon einen Eintrag „${logic.KINDS[kind].label}“ (${logic.rangeText(clash)}). Bitte den vorhandenen Eintrag korrigieren.`, 'error', { target: '#absenceEditFrom' }); return; }
        const person = people.find(entry => entry.id === personId);
        const decided = status !== 'beantragt';
        const changedDecision = !item || item.status !== status;
        const payload = {
            profile_id: personId, person_name: person?.full_name || item?.person_name || '', kind, date_from: from, date_to: to, minutes: minutes || null, days,
            note: $('absenceEditNote').value.trim(), status,
            ...(changedDecision ? { reviewed_by: decided ? profile.full_name || '' : '', reviewed_at: decided ? new Date().toISOString() : null } : {}),
            ...(status !== 'abgelehnt' ? { review_note: '' } : {})
        };
        const save = $('absenceEditSave');
        save.disabled = true;
        const result = item
            ? await client.from('tt_absences').update(payload).eq('id', item.id).select()
            : await client.from('tt_absences').insert({ ...payload, created_by_name: profile.full_name || '' }).select();
        save.disabled = false;
        if (result.error || !result.data?.length) { showToast(result.error ? TerminCloud.germanError(result.error) : 'Der Eintrag konnte nicht gespeichert werden.', 'error', { target: '#absenceEditSave' }); return; }
        // Wurde dabei über einen Antrag entschieden, erfährt es die Person.
        if (item && item.status === 'beantragt' && status !== 'beantragt') tellPerson({ ...item, ...payload }, status, '');
        $('absenceDialog').close();
        showToast(item ? 'Eintrag gespeichert.' : `${logic.KINDS[kind].label} für ${person?.full_name || 'die Person'} eingetragen.`, 'success');
        absenceYear = Number(from.slice(0, 4));
        await refresh();
        window.refreshCloudInbox?.();
    });

    $('absenceEditDelete').addEventListener('click', async () => {
        const item = editedAbsence;
        if (!item) return;
        if (!await confirmDialog(`${logic.KINDS[item.kind].label} von ${nameOf(item)} (${logic.rangeText(item)}) endgültig löschen?\n\nDer Eintrag verschwindet auch im Portal der Person. Soll er nur nicht mehr zählen, genügt der Stand „${statusText({ ...item, status: 'abgelehnt' })}“.`, 'Endgültig löschen')) return;
        const { data, error } = await client.from('tt_absences').delete().eq('id', item.id).select();
        if (error || !data?.length) { showToast(error ? TerminCloud.germanError(error) : 'Löschen darf nur der Admin.', 'error'); return; }
        $('absenceDialog').close();
        showToast('Eintrag gelöscht.', 'success');
        await refresh();
        window.refreshCloudInbox?.();
    });

    $('absenceYear').addEventListener('change', () => { absenceYear = Number($('absenceYear').value); refresh(); });
    $('absencePerson').addEventListener('change', () => { absencePerson = $('absencePerson').value; renderAbsences(); });
    document.querySelectorAll('[data-absence-kind]').forEach(node => node.addEventListener('click', () => { absenceKind = absenceKind === node.dataset.absenceKind ? '' : node.dataset.absenceKind; renderAbsences(); }));

    // ---------- Excel ----------
    function exportExcel() {
        if (typeof XLSX === 'undefined') { showToast('Die Excel-Funktion konnte nicht geladen werden. Prüfe das Internet.', 'error'); return; }
        const range = monthRange(month);
        const hours = minutes => Math.round(minutes / 60 * 100) / 100;
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
            ['Name', 'Bestätigt (Std)', 'Noch zu prüfen (Std)', 'Abgelehnt (Std)', 'Einträge'],
            ...personRows().map(row => [row.name, hours(row.confirmed), hours(row.open), hours(row.rejected), row.count])
        ]), 'Summe');
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
            ['Datum', 'Name', 'Termin', 'Beginn', 'Ende', 'Minuten vorher', 'Minuten danach', 'Überstunden (Std)', 'Bemerkung', 'Status', 'Geprüft von'],
            ...overtime.map(item => [date(item.date), item.person_name, item.appointment, item.start_time ? String(item.start_time).slice(0, 5) : '', item.end_time ? String(item.end_time).slice(0, 5) : '', item.minutes_before, item.minutes_after, hours(minutesOf(item)), item.note, item.status, item.reviewed_by || ''])
        ]), 'Überstunden');
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
            ['Datum', 'Name', 'Ort', 'Art', 'Betrag', 'Bemerkung', 'Status'],
            ...receipts.map(item => [date(item.date), item.person_name, item.place, item.kind, Number(item.amount), item.note, item.status])
        ]), 'Belege');
        // Abwesenheiten des gewählten Jahres: Summe je Person und alle Einträge
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
            ['Name', 'Urlaub genehmigt (Tage)', 'Urlaub beantragt (Tage)', 'Krank (Tage)', 'Verspätungen (Anzahl)', 'Verspätungen (Min)', 'Fehlstunden (Std)', 'Notfälle (Anzahl)'],
            ...absenceRows().map(row => [row.name, row.vacationDays, row.vacationWaitingDays, row.sickDays, row.lateCount, row.lateMinutes, hours(row.missedMinutes), row.emergencyCount])
        ]), `Abwesenheiten ${absenceYear} Summe`);
        XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([
            ['Von', 'Bis', 'Name', 'Art', 'Tage', 'Minuten', 'Hinweis', 'Stand', 'Beantragt / gemeldet am', 'Entschieden von', 'Grund'],
            ...absences.filter(inYear).sort((left, right) => String(left.date_from).localeCompare(String(right.date_from))).map(item => [date(item.date_from), date(item.date_to), nameOf(item), logic.KINDS[item.kind]?.label || item.kind,
                wholeDays(item) ? logic.dayCount(item) : '', item.minutes || '', item.note, statusText(item), logic.stampDate(item.created_at), item.reviewed_by || '', item.review_note || ''])
        ]), `Abwesenheiten ${absenceYear}`);
        XLSX.writeFile(book, `Festangestellte ${range.label} Überstunden, Belege, Abwesenheiten ${absenceYear}.xlsx`);
    }

    $('festMonth').addEventListener('change', () => {
        if (!/^\d{4}-\d{2}$/.test($('festMonth').value)) return;
        month = $('festMonth').value;
        try { sessionStorage.setItem(MONTH_KEY, month); } catch (error) { /* gilt dann bis zum Neuladen */ }
        refresh();
    });
    document.querySelectorAll('[data-fest-tab]').forEach(node => node.addEventListener('click', () => { tab = node.dataset.festTab; render(); }));
    $('festReload').addEventListener('click', refresh);
    $('festExport').addEventListener('click', exportExcel);
    refresh();
})();
