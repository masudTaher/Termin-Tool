// Monatsabrechnung: Endliste, Sondertage und Belege der temporären Dolmetscher.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const MONTH_KEY = 'terminTool.payroll.month';
    let profile = null;
    let month = '';
    let rate = 80;
    let checkDate = '';
    let receipts = [];
    let specialDays = [];
    let trackingSpecial = [];
    let statements = [];
    let dayDates = new Map();
    let payroll = [];
    let profiles = [];
    let autoWorkdays = new Map();
    let result = null;
    let tab = 'list';

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };
    const euro = Abrechnung.euro;

    function setStatus(message, kind = 'info') {
        const status = $('payrollStatus');
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    function defaultMonth() {
        try { const saved = sessionStorage.getItem(MONTH_KEY); if (/^\d{4}-\d{2}$/.test(saved || '')) return saved; } catch (error) { /* ohne Speicher: aktueller Monat */ }
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    async function refresh() {
        setStatus('');
        if (!client) { setStatus('Die Verbindung zur Datenbank konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu.', 'error'); return; }
        try { profile = await TerminCloud.getProfile(true); } catch (error) { setStatus(error.message, 'error'); return; }
        if (!TerminCloud.isStaff(profile)) { $('payrollApp').hidden = true; setStatus('Bitte melde dich zuerst auf der Seite „Team“ an.', 'error'); return; }
        if (!month) month = defaultMonth();
        $('payrollMonth').value = month;
        const range = Abrechnung.monthRange(month);
        const [receiptResult, specialResult, payrollResult, monthResult, dayResult, profileResult] = await Promise.all([
            client.from('tt_receipts').select('*').gte('date', range.start).lte('date', range.end).order('date'),
            client.from('tt_special_days').select('*').gte('date', range.start).lte('date', range.end).order('date'),
            client.from('tt_payroll').select('*').eq('month', month),
            client.from('tt_payroll_months').select('*').eq('month', month).maybeSingle(),
            client.from('tt_days').select('*').gte('date', range.start).lte('date', range.end),
            client.from('tt_profiles').select('*').order('full_name')
        ]);
        if (window.PhotoRequest) await PhotoRequest.load().catch(() => []);
        const statementResult = await client.from('tt_statements').select('*').eq('month', month);
        statements = statementResult.error ? [] : statementResult.data;
        const failed = [receiptResult, specialResult, payrollResult, monthResult].find(item => item.error);
        if (failed) { setStatus(`${TerminCloud.germanError(failed.error)} Falls Tabellen fehlen: supabase/update-5.sql im SQL Editor ausführen.`, 'error'); return; }
        // Belege der Festangestellten gehören nicht in die Abrechnung der Temporären – sie stehen unter „Überstunden & Belege“.
        const festIds = new Set((profileResult.data || []).filter(item => item.employment === 'fest').map(item => item.id));
        receipts = receiptResult.data.filter(item => !festIds.has(item.profile_id));
        specialDays = specialResult.data;
        payroll = payrollResult.data;
        rate = Number(monthResult.data?.daily_rate ?? 80);
        checkDate = monthResult.data?.check_date || '';
        profiles = profileResult.data || [];
        autoWorkdays = Abrechnung.countWorkdays(dayResult.error ? [] : dayResult.data);
        dayDates = Abrechnung.workdayDates(dayResult.error ? [] : dayResult.data);
        trackingSpecial = Abrechnung.specialFromDays(dayResult.error ? [] : dayResult.data, specialDays);
        $('payrollRate').value = rate;
        $('payrollCheckDate').value = checkDate;
        $('payrollApp').hidden = false;
        render();
    }

    function render() {
        // Zeilen der Endliste können mit einem Portal-Konto verknüpft sein (Name auf dem Tagesblatt ↔ Konto).
        // Belege aus dem Portal zählen dann zu dieser Zeile, auch wenn der Name anders geschrieben ist.
        const linkedName = new Map(payroll.filter(item => item.profile_id).map(item => [item.profile_id, item.person_name]));
        const receiptsByRow = receipts.map(item => linkedName.has(item.profile_id) ? { ...item, person_name: linkedName.get(item.profile_id) } : item);
        // Temporäre Dolmetscher mit Portal-Konto stehen automatisch in der Liste (erst ab dem Monat, in dem das Konto angelegt wurde).
        const temporary = profiles.filter(item => item.active && item.role === 'dolmetscher' && item.employment !== 'fest' && item.full_name
            && !linkedName.has(item.id) && (!item.created_at || String(item.created_at).slice(0, 7) <= month)).map(item => item.full_name);
        result = Abrechnung.compute({ rate, receipts: receiptsByRow, specialDays: [...specialDays, ...trackingSpecial], payroll, autoWorkdays, extraNames: temporary });
        result.rows.forEach(row => {
            const entry = payroll.find(item => Abrechnung.key(item.person_name) === Abrechnung.key(row.name));
            row.profileId = entry?.profile_id || profiles.find(item => Abrechnung.key(item.full_name) === Abrechnung.key(row.name))?.id || null;
            row.statement = statements.find(item => item.profile_id === row.profileId) || null;
            row.receipts = receiptsByRow.filter(item => Abrechnung.key(item.person_name) === Abrechnung.key(row.name) && item.status !== 'abgelehnt');
        });
        const objections = result.rows.filter(row => row.statement?.response === 'einwand');
        if (objections.length) result.checks.unshift(`Einwand von: ${objections.map(row => row.name).join(', ')}`);
        const range = Abrechnung.monthRange(month);
        $('sumReceipts').textContent = euro(result.totals.receipts);
        $('sumReceiptCount').textContent = `${result.totals.receiptCount} Belege · ${result.totals.personsWithReceipts} Personen`;
        $('sumSalary').textContent = euro(result.totals.salary);
        $('sumPersons').textContent = `${result.rows.length} Personen · ${range.label}`;
        $('sumTotal').textContent = euro(result.totals.total);
        const check = $('payrollCheck');
        // Bei vielen Personen wird die Namensliste gekürzt (die volle Liste steht im Hinweis beim Darüberfahren und unten in der Endliste).
        const compactCheck = text => {
            const cut = text.indexOf(': ');
            if (cut < 0) return text;
            const names = text.slice(cut + 2).split(', ');
            return names.length > 6 ? `${text.slice(0, cut)}: ${names.length} Personen (${names.slice(0, 3).join(', ')} und ${names.length - 3} weitere)` : text;
        };
        check.textContent = result.checks.length ? `Noch offen: ${result.checks.map(compactCheck).join(' · ')}` : 'Alles in Ordnung – alle Personen haben Arbeitstage, alle Belege und Sondertage sind geklärt.';
        check.title = result.checks.length ? result.checks.join('\n') : '';
        check.dataset.kind = result.checks.length ? 'warn' : 'ok';

        $('payrollNames').replaceChildren(...result.rows.map(row => { const option = el('option'); option.value = row.name; return option; }));
        $('payrollPlaces').replaceChildren(...[...new Set(receipts.map(item => item.place).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de')).map(place => { const option = el('option'); option.value = place; return option; }));
        document.querySelectorAll('[data-payroll-tab]').forEach(button => button.classList.toggle('is-active', button.dataset.payrollTab === tab));
        document.querySelectorAll('[data-payroll-panel]').forEach(panel => { panel.hidden = panel.dataset.payrollPanel !== tab; });
        renderList();
        renderSpecial();
        renderReceipts();
    }

    // ---------- Endliste ----------
    async function savePayroll(name, changes) {
        const existing = payroll.find(item => Abrechnung.key(item.person_name) === Abrechnung.key(name));
        const row = { month, person_name: existing?.person_name || name, full_name: existing?.full_name || '', workdays: existing?.workdays ?? null, status: existing?.status || '', remark: existing?.remark || '', profile_id: existing?.profile_id ?? null, ...changes };
        const { error } = await client.from('tt_payroll').upsert(row, { onConflict: 'month,person_name' });
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return false; }
        if (existing) Object.assign(existing, row); else payroll.push(row);
        render();
        return true;
    }

    function renderList() {
        const body = $('payrollBody');
        body.replaceChildren();
        result.rows.forEach(row => {
            const tr = el('tr', row.specialText ? 'payroll-special' : '');
            const nameCell = el('td');
            nameCell.append(el('strong', null, row.name));
            if (row.fullName) nameCell.append(el('small', 'payroll-sub', row.fullName));
            const daysCell = el('td');
            const days = el('input');
            days.type = 'number';
            days.min = '0';
            days.step = '1';
            days.className = 'payroll-days';
            days.value = row.workdaysManual ?? '';
            days.placeholder = row.workdaysAuto != null ? `${row.workdaysAuto} (online)` : '–';
            days.setAttribute('aria-label', `Arbeitstage für ${row.name}`);
            days.addEventListener('change', () => savePayroll(row.name, { workdays: days.value === '' ? null : Math.max(0, Math.round(Number(days.value))) }));
            daysCell.append(days);
            const remarkCell = el('td');
            const remark = el('input');
            remark.type = 'text';
            remark.maxLength = 200;
            remark.value = row.remark;
            remark.setAttribute('aria-label', `Bemerkung für ${row.name}`);
            remark.addEventListener('change', () => savePayroll(row.name, { remark: remark.value.trim() }));
            remarkCell.append(remark);
            const portalCell = el('td', 'payroll-portal');
            const account = el('select');
            account.setAttribute('aria-label', `Portal-Konto für ${row.name}`);
            account.append(...[{ id: '', full_name: 'kein Konto' }, ...profiles.filter(item => item.active && item.role === 'dolmetscher')].map(item => {
                const option = el('option', null, item.full_name || '(ohne Namen)');
                option.value = item.id;
                return option;
            }));
            account.value = row.profileId || '';
            account.addEventListener('change', () => savePayroll(row.name, { profile_id: account.value || null }));
            const state = el('span', 'status-pill', !row.statement ? 'nicht freigegeben' : { offen: 'freigegeben', 'bestätigt': 'bestätigt', einwand: 'Einwand' }[row.statement.response]);
            state.dataset.status = !row.statement ? 'bekannt' : { offen: 'in Arbeit', 'bestätigt': 'erledigt', einwand: 'offen' }[row.statement.response];
            if (row.statement?.response_note) state.title = row.statement.response_note;
            portalCell.append(account, state);
            if (row.statement?.response === 'einwand') portalCell.append(el('small', 'payroll-sub payroll-objection', `„${row.statement.response_note}“`));
            // Zwei Zeilen statt vier: oben die beiden Hauptknöpfe nebeneinander, darunter klein die Korrekturen.
            const actionCell = el('td', 'payroll-actions');
            const mainActions = el('div', 'payroll-actions-main');
            const moreActions = el('div', 'payroll-actions-more');
            actionCell.append(mainActions, moreActions);
            const release = el('button', 'button-primary fleet-end-button', row.statement ? 'Neu freigeben' : 'Freigeben');
            release.type = 'button';
            release.title = 'Abrechnung für diese Person im Portal sichtbar machen';
            release.disabled = !row.profileId || row.salary == null;
            release.addEventListener('click', async () => { if (await releaseStatement(row)) { showToast(`Abrechnung für ${row.name} freigegeben`, 'success'); await refresh(); } });
            mainActions.append(release);
            // Drucken und Entfernen als Symbol-Knöpfe: so bleibt jede Person eine flache Zeile (wichtig bei 40 Namen).
            const print = el('button', 'button-secondary fleet-end-button payroll-icon-button');
            print.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8V4h10v4"/><rect x="4" y="8" width="16" height="8" rx="2"/><path d="M7 14h10v6H7z"/></svg><span class="visually-hidden">Abrechnung</span>';
            print.type = 'button';
            print.title = 'Abrechnung der Belege für diese Person drucken';
            print.setAttribute('aria-label', `Abrechnung für ${row.name} drucken`);
            print.addEventListener('click', () => printPerson(row));
            mainActions.append(print);
            // Eine freigegebene Abrechnung lässt sich wieder aus dem Portal nehmen (z. B. wenn sie zu früh oder falsch freigegeben wurde).
            if (row.statement) {
                const withdraw = el('button', 'button-quiet-danger', 'Freigabe zurückziehen');
                withdraw.type = 'button';
                withdraw.addEventListener('click', async () => {
                    const answered = row.statement.response !== 'offen' ? ` ${row.name} hat sie bereits ${row.statement.response === 'bestätigt' ? 'bestätigt' : 'mit einem Einwand beantwortet'} – auch diese Antwort wird gelöscht.` : '';
                    if (!await confirmDialog(`Die Abrechnung ${Abrechnung.monthRange(month).label} für ${row.name} wieder aus dem Portal nehmen?${answered}\n\nDie Zahlen hier bleiben erhalten; du kannst jederzeit neu freigeben.`, 'Freigabe zurückziehen')) return;
                    const { error } = await client.from('tt_statements').delete().eq('month', month).eq('profile_id', row.statement.profile_id);
                    if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                    showToast(`Freigabe für ${row.name} zurückgezogen.`, 'success');
                    await refresh();
                    window.refreshCloudInbox?.();
                });
                moreActions.append(withdraw);
            }
            // Eine von Hand hinzugefügte Person (oder ihre Einträge für diesen Monat) wieder aus der Endliste nehmen.
            if (payroll.some(item => Abrechnung.key(item.person_name) === Abrechnung.key(row.name))) {
                const remove = el('button', 'button-quiet-danger payroll-icon-button');
                remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5"/></svg><span class="visually-hidden">Entfernen</span>';
                remove.type = 'button';
                remove.title = 'Arbeitstage, Bemerkung und Konto-Verknüpfung dieser Person für diesen Monat löschen';
                remove.setAttribute('aria-label', `${row.name} aus der Endliste nehmen`);
                remove.addEventListener('click', async () => {
                    const stays = row.workdaysAuto ? `\n\n${row.name} bleibt in der Liste, weil im Tagesarchiv ${row.workdaysAuto} ${row.workdaysAuto === 1 ? 'Arbeitstag steht' : 'Arbeitstage stehen'} – es werden nur die hier eingetragenen Angaben gelöscht.` : '';
                    if (!await confirmDialog(`Die Einträge für ${row.name} im ${Abrechnung.monthRange(month).label} löschen (eingetragene Arbeitstage, Bemerkung, Konto-Verknüpfung)?${stays}\n\nBelege und Sondertage bleiben erhalten.`, 'Entfernen')) return;
                    const existing = payroll.find(item => Abrechnung.key(item.person_name) === Abrechnung.key(row.name));
                    const { error } = await client.from('tt_payroll').delete().eq('month', month).eq('person_name', existing.person_name);
                    if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                    showToast(`${row.name}: Einträge für diesen Monat gelöscht.`, 'success');
                    await refresh();
                });
                mainActions.append(remove);
            }
            tr.append(nameCell, daysCell, el('td', null, row.specialText || '–'), el('td', 'payroll-number', row.receiptCount ? `${euro(row.receiptSum)} (${row.receiptCount})` : '–'),
                el('td', 'payroll-number', row.salary == null ? '–' : euro(row.salary)), el('td', 'payroll-number payroll-total', row.total == null ? '–' : euro(row.total)), remarkCell, portalCell, actionCell);
            body.append(tr);
        });
        const foot = $('payrollFoot');
        const sumDays = result.rows.reduce((sum, row) => sum + (row.workdays || 0), 0);
        const sumSpecial = result.rows.reduce((sum, row) => sum + row.specialCount, 0);
        const footRow = el('tr');
        footRow.append(el('td', null, 'Summe'), el('td', null, String(sumDays)), el('td', null, `${sumSpecial} Sondertage`), el('td', 'payroll-number', euro(result.totals.receipts)), el('td', 'payroll-number', euro(result.totals.salary)), el('td', 'payroll-number payroll-total', euro(result.totals.total)), el('td'), el('td'), el('td'));
        foot.replaceChildren(footRow);
    }

    // Namen der Endliste in die Dolmetscherliste dieses Geräts übernehmen (Vorschläge beim Zuweisen).
    function copyNamesToDirectory(names, quiet) {
        if (typeof readInterpreterDirectory !== 'function' || typeof writeInterpreterDirectory !== 'function') return 0;
        const before = readInterpreterDirectory();
        const known = new Set(before.map(Abrechnung.key));
        const fresh = names.filter(name => name && !known.has(Abrechnung.key(name)));
        if (fresh.length) writeInterpreterDirectory([...before, ...fresh]);
        if (!quiet) showToast(fresh.length ? `${fresh.length} ${fresh.length === 1 ? 'Name' : 'Namen'} in die Dolmetscherliste übernommen` : 'Alle Namen stehen schon in der Dolmetscherliste.', 'success');
        return fresh.length;
    }
    $('copyNames').addEventListener('click', () => copyNamesToDirectory(result.rows.map(row => row.name), false));

    // Fester Stand der Abrechnung für das Portal: genau das, was die Person sehen und bestätigen soll.
    async function releaseStatement(row) {
        if (!row.profileId || row.salary == null) return false;
        const range = Abrechnung.monthRange(month);
        const own = [...specialDays, ...trackingSpecial].filter(item => Abrechnung.key(item.person_name) === Abrechnung.key(row.name) && item.counts !== 'Nein');
        const data = {
            label: range.label, period: range.period, rate,
            workdays: row.workdays, dates: dayDates.get(Abrechnung.key(row.name)) || [],
            specialDays: own.map(item => ({ date: item.date, job: item.job, amount: Number(item.amount), counts: item.counts })),
            specialCount: row.specialCount, specialSum: row.specialSum,
            receipts: row.receipts.map(item => ({ date: item.date, place: item.place, amount: Number(item.amount), kind: item.kind })),
            receiptSum: row.receiptSum, salary: row.salary, total: row.total, remark: row.remark
        };
        const { error } = await client.from('tt_statements').upsert({
            month, profile_id: row.profileId, person_name: row.name, data,
            released_at: new Date().toISOString(), released_by: profile.full_name || '',
            response: 'offen', response_note: '', responded_at: null
        }, { onConflict: 'month,profile_id' });
        if (error) { showToast(`${TerminCloud.germanError(error)} Falls die Tabelle fehlt: supabase/update-6.sql ausführen.`, 'error'); return false; }
        return true;
    }

    $('releaseAll').addEventListener('click', async () => {
        const ready = result.rows.filter(row => row.profileId && row.salary != null && row.statement?.response !== 'bestätigt');
        if (!ready.length) { showToast('Es gibt nichts freizugeben: Verknüpfe zuerst Personen mit ihrem Portal-Konto und trage Arbeitstage ein.', 'info'); return; }
        const confirmed = await confirmDialog(`${ready.length} ${ready.length === 1 ? 'Abrechnung' : 'Abrechnungen'} für ${Abrechnung.monthRange(month).label} im Portal freigeben? Bereits bestätigte bleiben unverändert.`, 'Freigeben');
        if (!confirmed) return;
        let done = 0;
        for (const row of ready) { if (await releaseStatement(row)) done += 1; else break; }
        showToast(`${done} ${done === 1 ? 'Abrechnung' : 'Abrechnungen'} freigegeben`, 'success');
        await refresh();
    });

    $('addPersonForm').addEventListener('submit', async event => {
        event.preventDefault();
        const name = $('addPersonName').value.trim().replace(/\s+/g, ' ');
        if (name && await savePayroll(name, {})) $('addPersonName').value = '';
    });

    // ---------- Sondertage ----------
    function editButton(label, onEdit) {
        const button = el('button', 'button-quiet', 'Korrigieren');
        button.type = 'button';
        button.setAttribute('aria-label', label);
        button.addEventListener('click', onEdit);
        return button;
    }

    function deleteButton(label, onDelete) {
        const button = el('button', 'button-quiet-danger', 'Löschen');
        button.type = 'button';
        button.setAttribute('aria-label', label);
        button.addEventListener('click', onDelete);
        return button;
    }

    function renderSpecial() {
        const body = $('specialBody');
        body.replaceChildren();
        const all = [...specialDays, ...trackingSpecial];
        if (!all.length) { const tr = el('tr'); const td = el('td', null, 'Für diesen Monat sind keine Sondertage eingetragen.'); td.colSpan = 7; tr.append(td); body.append(tr); return; }
        all.sort((a, b) => a.person_name.localeCompare(b.person_name, 'de') || String(a.date).localeCompare(String(b.date))).forEach(item => {
            const tr = el('tr');
            if (item.source === 'tracking') {
                // Kommt aus dem Sonderbetrag eines Termins – dort ändern oder hier einen eigenen Sondertag für denselben Tag anlegen.
                tr.append(el('td', null, item.person_name), el('td', null, Abrechnung.longDate(item.date)), el('td', null, item.job || '–'), el('td', 'payroll-number', euro(item.amount)), el('td', null, 'Ja'), el('td', null, item.mark), el('td', null, 'im Live-Tracking ändern'));
                body.append(tr);
                return;
            }
            const countsCell = el('td');
            const select = el('select');
            ['Ja', 'Nein', 'prüfen'].forEach(value => { const option = el('option', null, value); option.selected = item.counts === value; select.append(option); });
            select.setAttribute('aria-label', 'Zählt als Sondertag');
            select.addEventListener('change', async () => {
                const { error } = await client.from('tt_special_days').update({ counts: select.value }).eq('id', item.id);
                if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                item.counts = select.value;
                render();
            });
            countsCell.append(select);
            const actionCell = el('td');
            actionCell.append(editButton(`Sondertag von ${item.person_name} korrigieren`, () => editSpecial(item)), deleteButton(`Sondertag von ${item.person_name} löschen`, async () => {
                if (!await confirmDialog(`Den Sondertag von ${item.person_name} am ${Abrechnung.longDate(item.date)} (${euro(item.amount)}) löschen?`, 'Löschen')) return;
                const { error } = await client.from('tt_special_days').delete().eq('id', item.id);
                if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                specialDays = specialDays.filter(other => other.id !== item.id);
                if (editingSpecial === item.id) cancelSpecialEdit();
                render();
            }));
            tr.append(el('td', null, item.person_name), el('td', null, Abrechnung.longDate(item.date)), el('td', null, item.job || '–'), el('td', 'payroll-number', euro(item.amount)), countsCell, el('td', null, [item.mark, item.hint].filter(Boolean).join(' · ') || '–'), actionCell);
            body.append(tr);
        });
    }

    // Korrigieren: Der Eintrag wird ins Formular darüber geladen und beim Speichern geändert statt neu angelegt.
    let editingSpecial = null;
    function editSpecial(item) {
        editingSpecial = item.id;
        $('specialName').value = item.person_name;
        $('specialDate').value = item.date;
        $('specialJob').value = item.job || '';
        $('specialAmount').value = String(Number(item.amount));
        $('specialCounts').value = item.counts;
        $('specialHint').value = item.hint || '';
        $('specialSubmit').textContent = 'Änderung speichern';
        $('specialEditCancel').hidden = false;
        $('specialForm').classList.add('is-editing');
        $('specialForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
        $('specialAmount').focus({ preventScroll: true });
    }
    function cancelSpecialEdit() {
        editingSpecial = null;
        $('specialForm').reset();
        $('specialSubmit').textContent = 'Sondertag speichern';
        $('specialEditCancel').hidden = true;
        $('specialForm').classList.remove('is-editing');
    }
    $('specialEditCancel').addEventListener('click', cancelSpecialEdit);

    $('specialForm').addEventListener('submit', async event => {
        event.preventDefault();
        const row = { person_name: $('specialName').value.trim().replace(/\s+/g, ' '), date: $('specialDate').value, job: $('specialJob').value.trim(), amount: Number($('specialAmount').value), counts: $('specialCounts').value, hint: $('specialHint').value.trim() };
        const range = Abrechnung.monthRange(month);
        if (row.date < range.start || row.date > range.end) { showToast(`Das Datum liegt nicht im ${range.label}.`, 'error'); return; }
        const { error } = editingSpecial
            ? await client.from('tt_special_days').update(row).eq('id', editingSpecial)
            : await client.from('tt_special_days').insert({ ...row, source: 'manuell' });
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        const changed = Boolean(editingSpecial);
        cancelSpecialEdit();
        showToast(changed ? 'Sondertag geändert' : 'Sondertag gespeichert', 'success');
        await refresh();
    });

    // ---------- Belege ----------
    async function showPhoto(path) {
        const url = await TerminCloud.photoUrl(path);
        if (!url) { showToast('Das Foto konnte nicht geladen werden.', 'error'); return; }
        $('photoDialogImage').src = url;
        $('photoDialog').showModal();
    }
    $('photoDialogClose').addEventListener('click', () => $('photoDialog').close());

    function renderReceipts() {
        const body = $('receiptBody');
        body.replaceChildren();
        if (!receipts.length) { const tr = el('tr'); const td = el('td', null, 'Für diesen Monat sind keine Belege eingetragen.'); td.colSpan = 9; tr.append(td); body.append(tr); return; }
        [...receipts].sort((a, b) => a.person_name.localeCompare(b.person_name, 'de') || String(a.date).localeCompare(String(b.date))).forEach(item => {
            const tr = el('tr', item.status === 'abgelehnt' ? 'payroll-rejected' : '');
            const photoCell = el('td');
            if (item.photo_path) {
                const open = el('button', 'button-secondary fleet-end-button', 'Foto');
                open.type = 'button';
                open.addEventListener('click', () => showPhoto(item.photo_path));
                photoCell.append(open);
            } else photoCell.textContent = '–';
            // Beleg aus dem Portal: Ist das Foto unleserlich (oder fehlt es), die Person um ein neues bitten.
            if (window.PhotoRequest && item.profile_id && item.source === 'portal') {
                photoCell.classList.add('photo-cell');
                photoCell.append(PhotoRequest.button({ kind: 'beleg', refId: item.id, profileId: item.profile_id, profileName: item.person_name,
                    title: ['Beleg', item.place, euro(item.amount), Abrechnung.longDate(item.date)].filter(Boolean).join(' · '), paths: [item.photo_path] }, render));
                const state = PhotoRequest.pill(item.id);
                if (state) photoCell.append(state);
            }
            const statusCell = el('td');
            const select = el('select');
            [['eingereicht', 'Eingereicht'], ['geprüft', 'Geprüft'], ['abgelehnt', 'Abgelehnt']].forEach(([value, text]) => { const option = el('option', null, text); option.value = value; option.selected = item.status === value; select.append(option); });
            select.setAttribute('aria-label', 'Status des Belegs');
            select.addEventListener('change', async () => {
                const { error } = await client.from('tt_receipts').update({ status: select.value }).eq('id', item.id);
                if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                item.status = select.value;
                render();
            });
            statusCell.append(select);
            const actionCell = el('td');
            actionCell.append(editButton(`Beleg von ${item.person_name} korrigieren`, () => editReceipt(item)), deleteButton(`Beleg von ${item.person_name} löschen`, async () => {
                if (!await confirmDialog(`Den Beleg von ${item.person_name} vom ${Abrechnung.longDate(item.date)} (${euro(item.amount)}) löschen?${item.photo_path ? ' Auch das Foto wird gelöscht.' : ''}`, 'Löschen')) return;
                const { error } = await client.from('tt_receipts').delete().eq('id', item.id);
                if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                if (item.photo_path) await client.storage.from('schaeden').remove([item.photo_path]).catch(() => null);
                receipts = receipts.filter(other => other.id !== item.id);
                if (editingReceipt === item.id) cancelReceiptEdit();
                render();
                window.refreshCloudInbox?.();
            }));
            tr.append(el('td', null, item.person_name), el('td', null, Abrechnung.longDate(item.date)), el('td', null, item.place || '–'), el('td', 'payroll-number', euro(item.amount)), el('td', null, [item.kind, item.proof].filter(Boolean).join(' · ')), el('td', null, item.note || '–'), photoCell, statusCell, actionCell);
            body.append(tr);
        });
    }

    // Korrigieren: Der Beleg wird ins Formular darüber geladen und beim Speichern geändert statt neu angelegt.
    let editingReceipt = null;
    function editReceipt(item) {
        editingReceipt = item.id;
        $('receiptName').value = item.person_name;
        $('receiptDate').value = item.date;
        $('receiptPlace').value = item.place || '';
        $('receiptAmount').value = String(Number(item.amount));
        $('receiptKind').value = item.kind;
        if ([...$('receiptProof').options].some(option => option.value === item.proof)) $('receiptProof').value = item.proof;
        $('receiptNote').value = item.note || '';
        $('receiptSubmit').textContent = 'Änderung speichern';
        $('receiptEditCancel').hidden = false;
        $('receiptForm').classList.add('is-editing');
        $('receiptForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
        $('receiptAmount').focus({ preventScroll: true });
    }
    function cancelReceiptEdit() {
        editingReceipt = null;
        $('receiptForm').reset();
        $('receiptSubmit').textContent = 'Beleg speichern';
        $('receiptEditCancel').hidden = true;
        $('receiptForm').classList.remove('is-editing');
    }
    $('receiptEditCancel').addEventListener('click', cancelReceiptEdit);

    $('receiptForm').addEventListener('submit', async event => {
        event.preventDefault();
        const name = $('receiptName').value.trim().replace(/\s+/g, ' ');
        const row = { person_name: name, profile_id: profiles.find(item => Abrechnung.key(item.full_name) === Abrechnung.key(name))?.id || null, date: $('receiptDate').value, place: $('receiptPlace').value.trim(), amount: Number($('receiptAmount').value), kind: $('receiptKind').value, proof: $('receiptProof').value, note: $('receiptNote').value.trim(), status: 'geprüft', source: 'manuell' };
        const range = Abrechnung.monthRange(month);
        if (row.date < range.start || row.date > range.end) { showToast(`Das Datum liegt nicht im ${range.label}.`, 'error'); return; }
        // Beim Korrigieren bleiben Status, Herkunft und Foto des Belegs, wie sie sind.
        const changes = { person_name: row.person_name, profile_id: row.profile_id, date: row.date, place: row.place, amount: row.amount, kind: row.kind, proof: row.proof, note: row.note };
        const { error } = editingReceipt
            ? await client.from('tt_receipts').update(changes).eq('id', editingReceipt)
            : await client.from('tt_receipts').insert(row);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        const changed = Boolean(editingReceipt);
        const keepName = name;
        cancelReceiptEdit();
        if (!changed) $('receiptName').value = keepName;
        showToast(changed ? 'Beleg geändert' : 'Beleg gespeichert', 'success');
        await refresh();
    });

    // ---------- Einstellungen ----------
    async function saveMonthSettings() {
        rate = Math.max(0, Number($('payrollRate').value) || 0);
        checkDate = $('payrollCheckDate').value;
        const { error } = await client.from('tt_payroll_months').upsert({ month, daily_rate: rate, check_date: checkDate || null }, { onConflict: 'month' });
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        render();
    }
    $('payrollRate').addEventListener('change', saveMonthSettings);
    $('payrollCheckDate').addEventListener('change', saveMonthSettings);
    $('payrollMonth').addEventListener('change', () => {
        if (!/^\d{4}-\d{2}$/.test($('payrollMonth').value)) return;
        month = $('payrollMonth').value;
        try { sessionStorage.setItem(MONTH_KEY, month); } catch (error) { /* gilt dann nur bis zum Neuladen */ }
        refresh();
    });
    document.querySelectorAll('[data-payroll-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.payrollTab; render(); }));

    // ---------- Excel ----------
    $('payrollImportFile').addEventListener('change', async event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        if (typeof XLSX === 'undefined') { showToast('Die Excel-Funktion konnte nicht geladen werden. Prüfe die Internetverbindung.', 'error'); return; }
        let parsed;
        try {
            const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
            const sheets = Object.fromEntries(workbook.SheetNames.map(name => [name, XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, raw: true, defval: null })]));
            parsed = Abrechnung.parseWorkbook(sheets);
        } catch (error) {
            showToast(error.message || 'Die Datei konnte nicht gelesen werden.', 'error');
            return;
        }
        const range = Abrechnung.monthRange(parsed.month);
        const confirmed = await confirmDialog(`${file.name}: ${range.label} mit ${parsed.payroll.length} Personen, ${parsed.receipts.length} Belegen und ${parsed.specialDays.length} Sondertagen importieren? Ein früherer Import dieses Monats wird ersetzt; Belege aus dem Portal bleiben erhalten.`, 'Importieren');
        if (!confirmed) return;
        setStatus('Import läuft …');
        const steps = [
            () => client.from('tt_receipts').delete().eq('source', 'import').gte('date', range.start).lte('date', range.end),
            () => client.from('tt_special_days').delete().eq('source', 'import').gte('date', range.start).lte('date', range.end),
            () => parsed.receipts.length ? client.from('tt_receipts').insert(parsed.receipts.map(item => ({ ...item, profile_id: null, status: 'geprüft', source: 'import' }))) : { error: null },
            () => parsed.specialDays.length ? client.from('tt_special_days').insert(parsed.specialDays.map(item => ({ ...item, source: 'import' }))) : { error: null },
            () => parsed.payroll.length ? client.from('tt_payroll').upsert(parsed.payroll, { onConflict: 'month,person_name' }) : { error: null },
            () => client.from('tt_payroll_months').upsert({ month: parsed.month, daily_rate: parsed.rate, check_date: parsed.checkDate || null }, { onConflict: 'month' })
        ];
        for (const step of steps) {
            const { error } = await step();
            if (error) { setStatus(`Import abgebrochen: ${TerminCloud.germanError(error)}`, 'error'); return; }
        }
        month = parsed.month;
        try { sessionStorage.setItem(MONTH_KEY, month); } catch (error) { /* unkritisch */ }
        await refresh();
        const added = copyNamesToDirectory(parsed.payroll.map(item => item.person_name), true);
        showToast(`${range.label} importiert${added ? ` · ${added} Namen in die Dolmetscherliste übernommen` : ''}`, 'success');
    });

    $('payrollExport').addEventListener('click', () => {
        if (typeof XLSX === 'undefined') { showToast('Die Excel-Funktion konnte nicht geladen werden. Prüfe die Internetverbindung.', 'error'); return; }
        const range = Abrechnung.monthRange(month);
        const date = iso => iso ? new Date(`${iso}T00:00:00`) : '';
        const book = XLSX.utils.book_new();
        const sheet = rows => XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
        XLSX.utils.book_append_sheet(book, sheet([
            [`Endliste · Temporäre Dolmetscher/innen · ${range.label}`], [`Zeitraum ${range.period} · Tagessatz ${rate} €`], [],
            ['Name of Employee', 'Arbeitstage', 'Sondertage', 'Parkgebühr', 'Salary', 'Total Amount', 'davon Sondertage', 'Bemerkung'],
            ...result.rows.map(row => [row.name, row.workdays ?? '', row.specialText, row.receiptSum, row.salary ?? '', row.total ?? '', row.specialCount, row.remark]),
            ['Summe', result.rows.reduce((sum, row) => sum + (row.workdays || 0), 0), '', result.totals.receipts, result.totals.salary, result.totals.total]
        ]), 'Endliste');
        XLSX.utils.book_append_sheet(book, sheet([['Name', 'Datum', 'Einsatz', 'Betrag für den Tag', 'Zählt', 'Vermerk auf dem Tagesblatt', 'Hinweis'], ...[...specialDays, ...trackingSpecial].map(item => [item.person_name, date(item.date), item.job, Number(item.amount), item.counts, item.mark, item.hint])]), 'Sondertage');
        XLSX.utils.book_append_sheet(book, sheet([['Name', 'Datum', 'Ort', 'Betrag', 'Nachweis', 'Bemerkung', 'Art', 'Status'], ...receipts.filter(item => item.status !== 'abgelehnt').map(item => [item.person_name, date(item.date), item.place, Number(item.amount), item.proof, item.note, item.kind, item.status])]), 'Belege');
        XLSX.writeFile(book, `${range.label.split(' ')[0]} Temporär ${range.label.split(' ')[1]} (Medical Office Bonn).xlsx`);
    });

    // ---------- Druck ----------
    function printSheet(nodes) {
        $('printArea').replaceChildren(...nodes);
        document.body.classList.add('is-printing-sheet');
        const done = () => { document.body.classList.remove('is-printing-sheet'); window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        window.print();
    }

    function printTable(headers, rows, footer) {
        const table = el('table', 'print-table');
        const head = el('tr');
        headers.forEach(text => head.append(el('th', null, text)));
        const thead = el('thead');
        thead.append(head);
        const tbody = el('tbody');
        rows.forEach(cells => { const tr = el('tr'); cells.forEach(text => tr.append(el('td', null, String(text)))); tbody.append(tr); });
        table.append(thead, tbody);
        if (footer) { const tfoot = el('tfoot'); const tr = el('tr'); footer.forEach(text => tr.append(el('td', null, String(text)))); tfoot.append(tr); table.append(tfoot); }
        return table;
    }

    function printPerson(row) {
        const range = Abrechnung.monthRange(month);
        const own = receipts.filter(item => Abrechnung.key(item.person_name) === Abrechnung.key(row.name) && item.status !== 'abgelehnt').sort((a, b) => String(a.date).localeCompare(String(b.date)));
        printSheet([
            el('h1', null, 'Abrechnung Parkgebühren'),
            el('p', null, 'Temporäre Dolmetscher/innen · Erstattung von Parkgebühren'),
            el('p', 'print-meta', `Dolmetscher/in: ${row.fullName || row.name}   ·   Monat: ${range.label}   ·   Zeitraum: ${range.period}   ·   Belege: ${own.length}`),
            printTable(['Nr.', 'Datum', 'Ort / Parkplatz', 'Nachweis', 'Betrag'], own.map((item, index) => [index + 1, Abrechnung.longDate(item.date), item.place, item.proof, euro(item.amount)]), ['', '', '', 'Gesamtbetrag', euro(row.receiptSum)])
        ]);
    }

    $('payrollPrint').addEventListener('click', () => {
        const range = Abrechnung.monthRange(month);
        const signature = el('div', 'print-signature');
        signature.append(el('p', null, 'Sachlich und rechnerisch richtig.'), el('p', 'print-sign-line', `${checkDate ? Abrechnung.longDate(checkDate) : '____________'}        ______________________________`), el('p', 'print-sign-caption', 'Datum                       Unterschrift Prüfer/in'));
        printSheet([
            el('h1', null, 'Endliste · Temporäre Dolmetscher/innen'),
            el('p', 'print-meta', `Arbeitstage und Parkgebühren · ${range.label} · Zeitraum ${range.period} · Tagessatz ${euro(rate)}`),
            printTable(['Name of Employee', 'Arbeitstage', 'Sondertage', 'Parkgebühr', 'Salary', 'Total Amount', 'Bemerkung'],
                result.rows.map(row => [row.fullName || row.name, row.workdays ?? '–', row.specialText || '', euro(row.receiptSum), row.salary == null ? '–' : euro(row.salary), row.total == null ? '–' : euro(row.total), row.remark]),
                ['Summe', result.rows.reduce((sum, row) => sum + (row.workdays || 0), 0), '', euro(result.totals.receipts), euro(result.totals.salary), euro(result.totals.total), '']),
            signature
        ]);
    });

    refresh();
})();
