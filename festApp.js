// Festangestellte: Überstunden prüfen (bestätigen / ablehnen) und Belege ansehen.
// Die Überstunden trägt jede Person im Portal selbst ein – mit dem Termin, wegen dem es länger ging.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const MONTH_KEY = 'terminTool.fest.month';
    let profile = null;
    let month = '';
    let overtime = [];
    let receipts = [];
    let tab = 'overtime';

    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const euro = value => Number(value || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    const date = iso => { const [year, monthPart, day] = String(iso).split('-'); return `${day}.${monthPart}.${year}`; };
    const duration = minutes => { const total = Math.max(0, Math.round(minutes)); const hours = Math.floor(total / 60); const rest = total % 60; return hours ? `${hours} Std${rest ? ` ${rest} Min` : ''}` : `${rest} Min`; };
    const minutesOf = item => Number(item.minutes_before || 0) + Number(item.minutes_after || 0);
    const pill = (status, text) => { const node = el('span', 'status-pill', text || status); node.dataset.status = { eingereicht: 'in Arbeit', 'bestätigt': 'erledigt', 'geprüft': 'erledigt', abgelehnt: 'offen' }[status] || status; return node; };

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
        const [overtimeResult, receiptResult, profileResult] = await Promise.all([
            client.from('tt_overtime').select('*').gte('date', range.start).lte('date', range.end).order('date'),
            client.from('tt_receipts').select('*').gte('date', range.start).lte('date', range.end).order('date'),
            client.from('tt_profiles').select('*').order('full_name')
        ]);
        if (overtimeResult.error) { $('festApp').hidden = true; setStatus(`${TerminCloud.germanError(overtimeResult.error)} Bitte supabase/update-8.sql im SQL Editor ausführen.`, 'error'); return; }
        const festIds = new Set((profileResult.data || []).filter(item => item.employment === 'fest').map(item => item.id));
        overtime = overtimeResult.data;
        receipts = receiptResult.error ? [] : receiptResult.data.filter(item => festIds.has(item.profile_id));
        $('festApp').hidden = false;
        render();
    }

    function render() {
        const range = monthRange(month);
        const sum = status => overtime.filter(item => item.status === status).reduce((total, item) => total + minutesOf(item), 0);
        const open = overtime.filter(item => item.status === 'eingereicht');
        const validReceipts = receipts.filter(item => item.status !== 'abgelehnt');
        const openReceipts = receipts.filter(item => item.status === 'eingereicht').length;
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
        document.querySelectorAll('[data-fest-tab]').forEach(button => button.classList.toggle('is-active', button.dataset.festTab === tab));
        document.querySelectorAll('[data-fest-panel]').forEach(panel => { panel.hidden = panel.dataset.festPanel !== tab; });
        renderPersons();
        renderOvertime();
        renderReceipts();
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

    function askReject(item) {
        return new Promise(resolve => {
            const dialog = $('rejectDialog');
            $('rejectText').textContent = `Überstunden von ${item.person_name} am ${date(item.date)} (${duration(minutesOf(item))}) ablehnen?`;
            $('rejectNote').value = '';
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
            if (item.status !== 'bestätigt') {
                const ok = el('button', 'button-primary account-approve', 'Bestätigen');
                ok.type = 'button';
                ok.addEventListener('click', () => review(item, 'bestätigt', ''));
                box.append(ok);
            }
            if (item.status !== 'abgelehnt') {
                const reject = el('button', 'button-quiet-danger', 'Ablehnen');
                reject.type = 'button';
                reject.addEventListener('click', async () => { const reason = await askReject(item); if (reason) review(item, 'abgelehnt', reason); });
                box.append(reject);
            }
            actions.append(box);
            tr.append(el('td', null, date(item.date)), el('td', null, item.person_name), el('td', null, item.appointment || '–'), el('td', null, times || '–'), amount, note, state, actions);
            body.append(tr);
        });
    }

    async function showPhoto(path) {
        const url = await TerminCloud.photoUrl(path);
        if (!url) { showToast('Das Foto konnte nicht geladen werden.', 'error'); return; }
        $('photoDialogImage').src = url;
        $('photoDialog').showModal();
    }
    $('photoDialogClose').addEventListener('click', () => $('photoDialog').close());

    function renderReceipts() {
        const body = $('festReceiptBody');
        body.replaceChildren();
        if (!receipts.length) { emptyRow(body, 8, 'Für diesen Monat haben die Festangestellten keine Belege eingereicht.'); return; }
        [...receipts].sort((left, right) => left.person_name.localeCompare(right.person_name, 'de') || String(left.date).localeCompare(String(right.date))).forEach(item => {
            const tr = el('tr', item.status === 'abgelehnt' ? 'payroll-rejected' : '');
            const photoCell = el('td');
            if (item.photo_path) {
                const open = el('button', 'button-secondary fleet-end-button', 'Foto');
                open.type = 'button';
                open.addEventListener('click', () => showPhoto(item.photo_path));
                photoCell.append(open);
            } else photoCell.textContent = '–';
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
            tr.append(el('td', null, date(item.date)), el('td', null, item.person_name), el('td', null, item.place || '–'), el('td', null, item.kind || '–'), el('td', null, euro(item.amount)), el('td', null, item.note || '–'), photoCell, statusCell);
            body.append(tr);
        });
    }

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
        XLSX.writeFile(book, `Festangestellte ${range.label} Überstunden und Belege.xlsx`);
    }

    $('festMonth').addEventListener('change', () => {
        if (!/^\d{4}-\d{2}$/.test($('festMonth').value)) return;
        month = $('festMonth').value;
        try { sessionStorage.setItem(MONTH_KEY, month); } catch (error) { /* gilt dann bis zum Neuladen */ }
        refresh();
    });
    document.querySelectorAll('[data-fest-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.festTab; render(); }));
    $('festReload').addEventListener('click', refresh);
    $('festExport').addEventListener('click', exportExcel);
    refresh();
})();
