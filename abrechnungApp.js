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
    const HIDDEN = Abrechnung.HIDDEN;
    let dayJobs = new Map();
    let openPerson = '';
    let personQuery = '';
    let pendingWrites = [];
    let autoTimer = null;
    let hiddenPeople = [];
    let autoNames = new Set();
    let tab = 'list';
    // Archiv: alle freigegebenen Abrechnungen über alle Monate (null = noch nicht geladen)
    let archive = null;
    let archiveQuery = '';
    const archiveOpen = new Set();

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
        archive = null;
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
        dayJobs = Abrechnung.dayJobs(dayResult.error ? [] : dayResult.data);
        $('payrollRate').value = rate;
        $('payrollCheckDate').value = checkDate;
        $('payrollApp').hidden = false;
        render();
    }

    function render() {
        const built = Abrechnung.buildRows({ month, rate, receipts, specialDays, trackingSpecial, payroll, profiles, autoWorkdays, statements });
        result = built.result;
        hiddenPeople = built.hiddenPeople;
        autoNames = built.autoNames;
        // Der laufende Stand steht von selbst im Portal (nur laufender Monat und der Monat davor).
        const writes = Abrechnung.planSync(result.rows, { month, rate, dayDates });
        pendingWrites = AbrechnungAuto.enabled() && Abrechnung.autoMonth(month) ? writes : [];
        queueAuto();
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
        renderArchive();
        // Das Archiv wird geholt, sobald der Reiter zum ersten Mal offen ist – und nach jeder Freigabe neu.
        if (tab === 'archive' && archive == null) loadArchive();
    }

    // ---------- Laufender Stand von selbst im Portal ----------
    function queueAuto() {
        clearTimeout(autoTimer);
        if (!pendingWrites.length) return;
        autoTimer = setTimeout(async () => {
            const writes = pendingWrites;
            pendingWrites = [];
            const forMonth = month;
            const done = await AbrechnungAuto.write(client, forMonth, writes);
            if (done <= 0 || forMonth !== month) return;
            const { data, error } = await client.from('tt_statements').select('*').eq('month', month);
            if (error) return;
            statements = data;
            archive = null;
            render();
        }, 500);
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

    // Eine ausgeblendete Person wieder in die Endliste holen (ihre Angaben waren nie gelöscht).
    async function showAgain(name) {
        const entry = payroll.find(item => item.person_name === name);
        if (!entry) return;
        const empty = entry.workdays == null && !entry.remark && !entry.profile_id && !entry.full_name;
        const { error } = empty ? await client.from('tt_payroll').delete().eq('month', month).eq('person_name', name)
            : await client.from('tt_payroll').update({ status: '' }).eq('month', month).eq('person_name', name);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        showToast(`${name} steht wieder in der Endliste.`, 'success');
        await refresh();
    }

    // Stand im Portal: [Text, Farbe des Schilds]
    function portalState(row) {
        const statement = row.statement;
        if (!row.profileId) return ['kein Portal-Konto', 'bekannt'];
        if (!statement) return ['noch nicht im Portal', 'bekannt'];
        if (statement.data?.paused) return ['im Portal ausgeblendet', 'bekannt'];
        if (statement.response === 'einwand') return ['Einwand', 'offen'];
        if (statement.data?.running) return ['läuft von selbst', 'in Arbeit'];
        return statement.response === 'bestätigt' ? ['bestätigt', 'erledigt'] : ['wartet auf Bestätigung', 'in Arbeit'];
    }
    const isClosed = row => Boolean(row.statement) && !row.statement.data?.running && !row.statement.data?.paused;
    const weekday = iso => new Date(`${iso}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
    const todayIso = () => { const now = new Date(); return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`; };

    function statementLine(term, value, total) {
        const line = el('div', `statement-line${total ? ' is-total' : ''}`);
        line.append(el('span', null, term), el('span', null, value));
        return line;
    }

    function payBox(title, ...nodes) {
        const box = el('section', 'pay-box');
        box.append(el('h3', null, title), ...nodes);
        return box;
    }

    function tabLink(text, target) {
        const button = el('button', 'button-quiet pay-link', text);
        button.type = 'button';
        button.addEventListener('click', () => { tab = target; render(); });
        return button;
    }

    // Alles zu einer Person: Rechnung, die einzelnen Tage mit ihren Terminen, Belege, Einstellungen und Aktionen.
    function personDetail(row) {
        const id = Abrechnung.key(row.name);
        const detail = el('div', 'pay-detail');
        const grid = el('div', 'pay-detail-grid');

        // 1 · Rechnung
        const normal = row.workdays == null ? null : row.workdays - row.specialCount;
        const bill = payBox('Rechnung',
            statementLine(`Normale Tage × ${euro(rate)}`, normal == null ? '–' : `${normal} ${normal === 1 ? 'Tag' : 'Tage'} = ${euro(normal * rate)}`),
            ...row.special.filter(item => item.counts !== 'Nein').map(item => statementLine(`Sondertag ${Abrechnung.shortDate(item.date)}${item.job ? ` · ${item.job}` : ''}`, `${euro(item.amount)}${item.counts === 'prüfen' ? ' (prüfen)' : ''}`)),
            statementLine('Salary', row.salary == null ? '–' : euro(row.salary)),
            statementLine(`Belege (${row.receiptCount})`, euro(row.receiptSum)),
            statementLine('Gesamt', row.total == null ? '–' : euro(row.total), true));

        // 2 · Arbeitstage mit den Terminen des Tages
        const days = dayJobs.get(id) || [];
        const specialByDate = new Map(row.special.filter(item => item.counts !== 'Nein').map(item => [item.date, item]));
        const dates = [...new Set([...days.map(day => day.date), ...specialByDate.keys()])].sort();
        const dayList = el('ul', 'pay-days');
        const today = todayIso();
        dates.forEach(date => {
            const day = days.find(item => item.date === date) || { done: [], open: [] };
            const special = specialByDate.get(date);
            const counts = day.done.length > 0;
            const item = el('li', counts ? 'pay-day' : special ? 'pay-day is-special-only' : 'pay-day is-open');
            item.append(el('span', 'pay-day-date', weekday(date)));
            const what = el('span', 'pay-day-jobs', (counts ? day.done : day.open.length ? day.open : [special?.job || 'Sondertag']).join('  ·  '));
            item.append(what);
            if (special) item.append(el('span', 'pay-chip is-special', `Sondertag ${euro(special.amount)}`));
            if (!counts && day.open.length) item.append(el('span', 'pay-chip', date > today ? 'geplant' : 'nicht beendet – zählt noch nicht'));
            dayList.append(item);
        });
        if (!dates.length) dayList.append(el('li', 'directory-empty', 'In diesem Monat gibt es noch keinen Termin für diese Person.'));
        const counted = row.workdaysAuto ?? 0;
        const dayNote = el('p', 'pay-hint', row.workdaysManual != null
            ? `Von Hand eingetragen: ${row.workdaysManual} ${row.workdaysManual === 1 ? 'Tag' : 'Tage'} – das gilt. Aus den beendeten Terminen wären es ${counted}.`
            : `Jeder Tag mit einem beendeten Termin zählt von selbst: ${counted} ${counted === 1 ? 'Tag' : 'Tage'}.`);
        const dayBox = payBox(`Arbeitstage (${row.workdays ?? '–'})`, dayNote, dayList, tabLink('Sondertag eintragen oder ändern', 'special'));

        // 3 · Belege
        const receiptList = el('ul', 'pay-days');
        row.receipts.slice().sort((a, b) => String(a.date).localeCompare(String(b.date))).forEach(item => {
            const line = el('li', 'pay-day');
            line.append(el('span', 'pay-day-date', weekday(item.date)), el('span', 'pay-day-jobs', [item.place || item.kind, item.status === 'eingereicht' ? 'noch nicht geprüft' : ''].filter(Boolean).join(' · ')), el('span', 'pay-day-amount', euro(item.amount)));
            receiptList.append(line);
        });
        if (!row.receipts.length) receiptList.append(el('li', 'directory-empty', 'Keine Belege in diesem Monat.'));
        const receiptBox = payBox(`Belege (${row.receiptCount})`, receiptList, tabLink('Belege prüfen oder ändern', 'receipts'));

        // 4 · Einstellungen: Arbeitstage von Hand, Bemerkung, Portal-Konto
        const daysField = el('label', 'pay-field');
        const daysInput = el('input');
        daysInput.type = 'number';
        daysInput.min = '0';
        daysInput.step = '1';
        daysInput.className = 'payroll-days';
        daysInput.value = row.workdaysManual ?? '';
        daysInput.placeholder = row.workdaysAuto != null ? `${row.workdaysAuto} (von selbst)` : '–';
        daysInput.setAttribute('aria-label', `Arbeitstage für ${row.name}`);
        daysInput.addEventListener('change', () => savePayroll(row.name, { workdays: daysInput.value === '' ? null : Math.max(0, Math.round(Number(daysInput.value))) }));
        daysField.append(el('span', null, 'Arbeitstage von Hand (leer = von selbst zählen)'), daysInput);
        const remarkField = el('label', 'pay-field');
        const remark = el('input');
        remark.type = 'text';
        remark.maxLength = 200;
        remark.value = row.remark;
        remark.setAttribute('aria-label', `Bemerkung für ${row.name}`);
        remark.addEventListener('change', () => savePayroll(row.name, { remark: remark.value.trim() }));
        remarkField.append(el('span', null, 'Bemerkung'), remark);
        const portalField = el('div', 'pay-field payroll-portal');
        const account = el('select');
        account.setAttribute('aria-label', `Portal-Konto für ${row.name}`);
        account.append(...[{ id: '', full_name: 'kein Konto' }, ...profiles.filter(item => item.active && item.role === 'dolmetscher')].map(item => {
            const option = el('option', null, item.full_name || '(ohne Namen)');
            option.value = item.id;
            return option;
        }));
        account.value = row.profileId || '';
        account.addEventListener('change', () => savePayroll(row.name, { profile_id: account.value || null }));
        const [stateText, stateKind] = portalState(row);
        const state = el('span', 'status-pill', stateText);
        state.dataset.status = stateKind;
        if (row.statement?.response_note) state.title = row.statement.response_note;
        portalField.append(el('span', null, 'Portal-Konto'), account, state);
        if (row.statement?.response === 'einwand') portalField.append(el('small', 'payroll-sub payroll-objection', `„${row.statement.response_note}“`));
        if (row.changedSince) portalField.append(el('small', 'payroll-sub payroll-changed', 'Seit dem Abschluss haben sich die Zahlen geändert – mit „Neu senden“ bekommt die Person den neuen Stand.'));
        const settings = payBox('Einstellungen', daysField, remarkField, portalField);

        grid.append(bill, dayBox, receiptBox, settings);

        // Aktionen
        const actionCell = el('div', 'payroll-actions');
        const mainActions = el('div', 'payroll-actions-main');
        const moreActions = el('div', 'payroll-actions-more');
        actionCell.append(mainActions, moreActions);
        const closed = isClosed(row);
        const release = el('button', 'button-primary fleet-end-button', closed ? 'Neu senden' : 'Zum Bestätigen senden');
        release.type = 'button';
        release.title = 'Abrechnung abschließen: Die Person prüft sie im Portal und bestätigt sie';
        release.disabled = !row.profileId || row.salary == null;
        release.addEventListener('click', async () => { if (await releaseStatement(row)) { showToast(`Abrechnung für ${row.name} zum Bestätigen gesendet – sie steht jetzt auch im Archiv unter diesem Namen`, 'success'); await refresh(); } });
        mainActions.append(release);
        const why = !row.profileId ? 'Im Portal zeigen geht erst mit Portal-Konto (unter „Einstellungen“).' : row.salary == null ? 'Im Portal zeigen geht erst mit Arbeitstagen.' : '';
        if (why) release.title = why;
        const print = el('button', 'button-secondary fleet-end-button payroll-icon-button');
        print.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8V4h10v4"/><rect x="4" y="8" width="16" height="8" rx="2"/><path d="M7 14h10v6H7z"/></svg><span>Drucken</span>';
        print.type = 'button';
        print.title = 'Abrechnung der Belege für diese Person drucken';
        print.setAttribute('aria-label', `Abrechnung für ${row.name} drucken`);
        print.addEventListener('click', () => printPerson(row));
        mainActions.append(print);
        // Jede Person lässt sich für diesen Monat aus der Liste nehmen. Steht sie von selbst in der Liste (Konto, Beleg,
        // Sondertag oder Arbeitstag im Archiv), wird sie ausgeblendet und kann unter der Liste wieder eingeblendet werden.
        const existing = payroll.find(item => Abrechnung.key(item.person_name) === id);
        const comesBack = autoNames.has(id);
        const remove = el('button', 'button-secondary fleet-end-button payroll-icon-button payroll-remove');
        remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5"/></svg><span>Entfernen</span>';
        remove.type = 'button';
        remove.title = 'Diese Person für diesen Monat aus der Liste nehmen';
        remove.setAttribute('aria-label', `${row.name} aus der Endliste nehmen`);
        remove.addEventListener('click', async () => {
            const label = Abrechnung.monthRange(month).label;
            const has = [row.workdays ? `${row.workdays} ${row.workdays === 1 ? 'Arbeitstag' : 'Arbeitstage'}` : '', row.receiptCount ? `${row.receiptCount} ${row.receiptCount === 1 ? 'Beleg' : 'Belege'}` : '', row.specialCount ? `${row.specialCount} ${row.specialCount === 1 ? 'Sondertag' : 'Sondertage'}` : ''].filter(Boolean).join(', ');
            const released = row.statement && !row.statement.data?.paused ? `\n\nDie Abrechnung steht schon im Portal – sie wird dabei dort herausgenommen.` : '';
            const text = comesBack
                ? `${row.name} für ${label} aus der Endliste nehmen?${has ? `\n\nFür diesen Monat steht bei dieser Person: ${has}. Das zählt dann nicht mehr in der Endliste mit.` : ''}${released}\n\nNichts wird gelöscht: Unter der Liste kannst du die Person jederzeit wieder einblenden.`
                : `${row.name} für ${label} aus der Endliste löschen (eingetragene Arbeitstage, Bemerkung, Konto-Verknüpfung)?${released}`;
            if (!await confirmDialog(text, 'Entfernen')) return;
            if (row.statement) {
                const { error } = await client.from('tt_statements').delete().eq('month', month).eq('profile_id', row.statement.profile_id);
                if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
            }
            const { error } = comesBack
                ? await client.from('tt_payroll').upsert({ month, person_name: existing?.person_name || row.name, full_name: existing?.full_name || '', workdays: existing?.workdays ?? null, remark: existing?.remark || '', profile_id: existing?.profile_id ?? null, status: HIDDEN }, { onConflict: 'month,person_name' })
                : await client.from('tt_payroll').delete().eq('month', month).eq('person_name', existing.person_name);
            if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
            showToast(comesBack ? `${row.name} steht für ${label} nicht mehr in der Endliste.` : `${row.name}: Einträge für diesen Monat gelöscht.`, 'success', comesBack ? { actionLabel: 'Rückgängig', onAction: () => showAgain(existing?.person_name || row.name) } : undefined);
            await refresh();
            window.refreshCloudInbox?.();
        });
        if (existing || comesBack) mainActions.append(remove);
        if (why) moreActions.append(el('small', 'payroll-sub payroll-why', why));
        const dropStatement = async () => {
            const { error } = await client.from('tt_statements').delete().eq('month', month).eq('profile_id', row.statement.profile_id);
            if (error) { showToast(TerminCloud.germanError(error), 'error'); return false; }
            return true;
        };
        // Ein Abschluss lässt sich zurückziehen (zu früh oder falsch gesendet) – danach läuft der Stand wieder von selbst.
        if (closed) {
            const withdraw = el('button', 'button-quiet-danger', 'Abschluss zurückziehen');
            withdraw.type = 'button';
            withdraw.addEventListener('click', async () => {
                const answered = row.statement.response !== 'offen' ? ` ${row.name} hat sie bereits ${row.statement.response === 'bestätigt' ? 'bestätigt' : 'mit einem Einwand beantwortet'} – auch diese Antwort wird gelöscht.` : '';
                if (!await confirmDialog(`Den Abschluss ${Abrechnung.monthRange(month).label} für ${row.name} zurückziehen?${answered}\n\nDie Zahlen hier bleiben erhalten; du kannst jederzeit neu senden.`, 'Abschluss zurückziehen')) return;
                if (!await dropStatement()) return;
                showToast(`Abschluss für ${row.name} zurückgezogen.`, 'success');
                await refresh();
                window.refreshCloudInbox?.();
            });
            moreActions.append(withdraw);
        }
        // Der laufende Stand lässt sich für eine Person im Portal ausblenden – und wieder zeigen.
        if (row.profileId && row.statement?.data?.paused) {
            const show = el('button', 'button-quiet pay-portal-show', 'Im Portal wieder zeigen');
            show.type = 'button';
            show.addEventListener('click', async () => { if (!await dropStatement()) return; showToast(`${row.name} sieht die Abrechnung wieder im Portal.`, 'success'); await refresh(); });
            moreActions.append(show);
        } else if (row.profileId && row.salary != null && !closed && AbrechnungAuto.enabled()) {
            const hide = el('button', 'button-quiet-danger pay-portal-hide', 'Im Portal ausblenden');
            hide.type = 'button';
            hide.title = 'Diese Person sieht den laufenden Stand dieses Monats dann nicht im Portal';
            hide.addEventListener('click', async () => {
                const { error } = await client.from('tt_statements').upsert({ month, profile_id: row.profileId, person_name: row.name, data: { paused: true, label: Abrechnung.monthRange(month).label },
                    released_at: new Date().toISOString(), released_by: profile.full_name || '', response: 'offen', response_note: '', responded_at: null }, { onConflict: 'month,profile_id' });
                if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                showToast(`${row.name} sieht die Abrechnung für diesen Monat nicht mehr im Portal.`, 'success', { actionLabel: 'Rückgängig', onAction: async () => { await client.from('tt_statements').delete().eq('month', month).eq('profile_id', row.profileId); await refresh(); } });
                await refresh();
            });
            moreActions.append(hide);
        }
        detail.append(grid, actionCell);
        return detail;
    }

    function renderList() {
        const body = $('payrollBody');
        body.replaceChildren();
        const fold = text => String(text || '').toLocaleLowerCase('de');
        const rows = result.rows.filter(row => !personQuery || fold(`${row.name} ${row.fullName}`).includes(fold(personQuery)));
        $('personSummary').textContent = `${result.rows.length} ${result.rows.length === 1 ? 'Person' : 'Personen'}${personQuery ? ` · ${rows.length} gefunden` : ''}`;
        if (!rows.length) body.append(el('p', 'directory-empty', result.rows.length ? 'Kein Name passt zur Suche.' : 'Für diesen Monat steht noch niemand in der Liste.'));
        rows.forEach(row => {
            const id = Abrechnung.key(row.name);
            const open = openPerson === id;
            const card = el('article', `pay-person${open ? ' is-open' : ''}${row.specialText ? ' payroll-special' : ''}`);
            card.dataset.person = id;
            const head = el('button', 'pay-head');
            head.type = 'button';
            head.setAttribute('aria-expanded', String(open));
            head.title = open ? 'Einzelheiten schließen' : 'Alle Einzelheiten zu dieser Person zeigen';
            const who = el('span', 'pay-who');
            who.append(el('strong', 'pay-name', row.name));
            if (row.fullName) who.append(el('small', 'payroll-sub', row.fullName));
            const cell = (label, text, extra) => { const node = el('span', `pay-cell${extra ? ` ${extra}` : ''}`, text); node.dataset.label = label; return node; };
            const [stateText, stateKind] = portalState(row);
            const state = el('span', 'status-pill', stateText);
            state.dataset.status = stateKind;
            const stateCell = el('span', 'pay-cell pay-state');
            stateCell.append(state);
            if (row.changedSince) stateCell.append(el('small', 'payroll-sub payroll-changed', 'geändert seit Abschluss'));
            head.append(el('span', 'pay-chevron'), who,
                cell('Arbeitstage', row.workdays == null ? '–' : String(row.workdays), 'pay-days-count'),
                cell('Sondertage', row.specialText || '–', 'pay-special'),
                cell('Belege', row.receiptCount ? `${euro(row.receiptSum)} (${row.receiptCount})` : '–', 'payroll-number'),
                cell('Salary', row.salary == null ? '–' : euro(row.salary), 'payroll-number'),
                cell('Gesamt', row.total == null ? '–' : euro(row.total), 'payroll-number payroll-total'),
                stateCell);
            head.addEventListener('click', () => { openPerson = open ? '' : id; renderList(); if (!open) document.querySelector(`.pay-person[data-person="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
            card.append(head);
            if (open) card.append(personDetail(row));
            body.append(card);
        });
        const hiddenBox = $('payrollHidden');
        hiddenBox.hidden = !hiddenPeople.length;
        hiddenBox.replaceChildren(el('span', null, `Für ${Abrechnung.monthRange(month).label} aus der Endliste genommen:`), ...hiddenPeople.map(item => {
            const button = el('button', 'button-secondary fleet-end-button payroll-show-again', `${item.person_name} wieder anzeigen`);
            button.type = 'button';
            button.addEventListener('click', () => showAgain(item.person_name));
            return button;
        }));
        const sumDays = result.rows.reduce((sum, row) => sum + (row.workdays || 0), 0);
        const sumSpecial = result.rows.reduce((sum, row) => sum + row.specialCount, 0);
        const foot = el('div', 'pay-head pay-foot-row');
        const footCell = (label, text, extra) => { const node = el('span', `pay-cell${extra ? ` ${extra}` : ''}`, text); node.dataset.label = label; return node; };
        const footWho = el('span', 'pay-who');
        footWho.append(el('strong', null, 'Summe'));
        foot.append(el('span', 'pay-chevron is-empty'), footWho, footCell('Arbeitstage', String(sumDays)), footCell('Sondertage', `${sumSpecial} Sondertage`), footCell('Belege', euro(result.totals.receipts), 'payroll-number'),
            footCell('Salary', euro(result.totals.salary), 'payroll-number'), footCell('Gesamt', euro(result.totals.total), 'payroll-number payroll-total'), el('span', 'pay-cell pay-state'));
        $('payrollFoot').replaceChildren(foot);
    }
    $('personSearch').addEventListener('input', () => { personQuery = $('personSearch').value.trim(); renderList(); });

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

    // Abschluss: fester Stand der Abrechnung, den die Person im Portal prüft und bestätigt.
    async function releaseStatement(row) {
        if (!row.profileId || row.salary == null) return false;
        const data = Abrechnung.statementData(row, { month, rate, dayDates, running: false });
        const { error } = await client.from('tt_statements').upsert({
            month, profile_id: row.profileId, person_name: row.name, data,
            released_at: new Date().toISOString(), released_by: profile.full_name || '',
            response: 'offen', response_note: '', responded_at: null
        }, { onConflict: 'month,profile_id' });
        if (error) { showToast(`${TerminCloud.germanError(error)} Falls die Tabelle fehlt: supabase/update-6.sql ausführen.`, 'error'); return false; }
        return true;
    }

    $('releaseAll').addEventListener('click', async () => {
        const closed = row => row.statement && !row.statement.data?.running && !row.statement.data?.paused;
        const ready = result.rows.filter(row => row.profileId && row.salary != null && !row.statement?.data?.paused && !(closed(row) && row.statement.response === 'bestätigt' && !row.changedSince) && !(closed(row) && row.statement.response === 'offen' && !row.changedSince));
        if (!ready.length) { showToast('Es gibt nichts zu senden: Entweder ist schon alles gesendet, oder es fehlen Portal-Konto und Arbeitstage.', 'info'); return; }
        const confirmed = await confirmDialog(`${Abrechnung.monthRange(month).label} abschließen und ${ready.length} ${ready.length === 1 ? 'Abrechnung' : 'Abrechnungen'} zum Bestätigen an die Dolmetscher senden?\n\nSchon bestätigte, unveränderte Abrechnungen bleiben, wie sie sind. Du kannst jeden Abschluss wieder zurückziehen.`, 'Abschließen und senden');
        if (!confirmed) return;
        let done = 0;
        for (const row of ready) { if (await releaseStatement(row)) done += 1; else break; }
        showToast(`${done} ${done === 1 ? 'Abrechnung' : 'Abrechnungen'} zum Bestätigen gesendet – zu finden im Archiv, je Dolmetscher unter seinem Namen`, 'success');
        await refresh();
    });

    $('addPersonForm').addEventListener('submit', async event => {
        event.preventDefault();
        const name = $('addPersonName').value.trim().replace(/\s+/g, ' ');
        if (name && await savePayroll(name, { status: '' })) { $('addPersonName').value = ''; $('personSearch').value = ''; personQuery = ''; renderList(); }
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
        // Belege aus dem Portal sind seit dem Scannen PDFs – die öffnen sich in einem neuen Tab.
        if (/\.pdf$/i.test(path || '')) { const link = await TerminCloud.photoUrl(path); if (link) window.open(link, '_blank', 'noopener'); else showToast('Der Beleg konnte nicht geöffnet werden.', 'error'); return; }
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
                const open = el('button', 'button-secondary fleet-end-button', /\.pdf$/i.test(item.photo_path) ? 'PDF' : 'Foto');
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

    // ---------- Archiv: Freigegebenes je Dolmetscher ----------
    // Jede Freigabe ist ein fester Stand (genau das, was die Person im Portal sieht). Hier stehen alle Freigaben aller
    // Monate, geordnet nach Person: so bleibt die Endliste des laufenden Monats übersichtlich und nichts geht verloren.
    const STATEMENT_STATE = { offen: 'freigegeben', 'bestätigt': 'bestätigt', einwand: 'Einwand' };
    const STATEMENT_PILL = { offen: 'in Arbeit', 'bestätigt': 'erledigt', einwand: 'offen' };
    const stamp = value => value ? new Date(value).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
    const statementLabel = item => item.data?.label || Abrechnung.monthRange(item.month).label;
    const statementName = item => profiles.find(person => person.id === item.profile_id)?.full_name || item.person_name || 'Ohne Namen';
    const own = data => Array.isArray(data?.receipts) ? data.receipts.length : 0;

    const releasedText = item => item.data?.running ? `Im Portal seit ${stamp(item.released_at)} · wird von selbst aktualisiert` : `Im Portal freigegeben am ${stamp(item.released_at)}${item.released_by ? ` von ${item.released_by}` : ''}`;

    async function loadArchive() {
        const { data, error } = await client.from('tt_statements').select('*').order('month', { ascending: false });
        archive = error ? [] : data.filter(item => !item.data?.paused);
        renderArchive();
        if (error) $('archiveSummary').textContent = TerminCloud.germanError(error);
    }

    function statementState(item) {
        if (item.data?.running && item.response !== 'einwand') return 'laufender Stand – wird von selbst aktualisiert';
        if (item.response === 'bestätigt') return `bestätigt am ${stamp(item.responded_at)}`;
        if (item.response === 'einwand') return `Einwand${item.response_note ? `: „${item.response_note}“` : ''}`;
        return 'freigegeben – wartet auf die Bestätigung';
    }

    // Zeilen einer Abrechnung, wie sie die Person im Portal sieht: [Bezeichnung, Angabe]
    function statementLines(item) {
        const data = item.data || {};
        const short = iso => Abrechnung.longDate(iso).slice(0, 6);
        const special = Array.isArray(data.specialDays) ? data.specialDays : [];
        const own = Array.isArray(data.receipts) ? data.receipts : [];
        return [
            ['Zeitraum', data.period || Abrechnung.monthRange(item.month).period],
            ['Arbeitstage', `${data.workdays ?? '–'}${data.dates?.length ? ` (${data.dates.map(short).join(', ')})` : ''}`],
            [`davon normale Tage × ${euro(data.rate || 0)}`, `${(data.workdays ?? 0) - (data.specialCount ?? 0)} Tage`],
            ...special.map(day => [`Sondertag ${short(day.date)}${day.job ? ` · ${day.job}` : ''}`, `${euro(day.amount)}${day.counts === 'prüfen' ? ' (wird geprüft)' : ''}`]),
            ['Salary', euro(data.salary || 0)],
            ...own.map(receipt => [`Beleg ${short(receipt.date)} · ${receipt.place || receipt.kind || ''}`, euro(receipt.amount)]),
            [`Belege gesamt (${own.length})`, euro(data.receiptSum || 0)],
            ...(data.remark ? [['Bemerkung', data.remark]] : [])
        ];
    }

    function printStatement(item) {
        const data = item.data || {};
        printSheet([
            el('h1', null, `Abrechnung ${statementLabel(item)}`),
            el('p', null, 'Temporäre Dolmetscher/innen · Arbeitstage, Sondertage und Belege'),
            el('p', 'print-meta', `Dolmetscher/in: ${statementName(item)}   ·   ${releasedText(item)}   ·   Stand: ${statementState(item)}`),
            printTable(['Position', 'Angabe / Betrag'], statementLines(item), ['Gesamtbetrag', euro(data.total || 0)])
        ]);
    }

    let shownStatement = null;
    function showStatement(item) {
        shownStatement = item;
        $('statementDialogTitle').textContent = `${statementName(item)} · ${statementLabel(item)}`;
        $('statementDialogMeta').textContent = `${releasedText(item)} · ${statementState(item)}`;
        const body = $('statementDialogBody');
        body.replaceChildren(...statementLines(item).map(([term, value]) => { const row = el('div', 'statement-line'); row.append(el('span', null, term), el('span', null, value)); return row; }));
        const total = el('div', 'statement-line is-total');
        total.append(el('span', null, 'Gesamtbetrag'), el('span', null, euro(item.data?.total || 0)));
        body.append(total);
        const dialog = $('statementDialog');
        if (!dialog.open) dialog.showModal();
    }
    $('statementDialogClose').addEventListener('click', () => $('statementDialog').close());
    $('statementDialogPrint').addEventListener('click', () => { if (shownStatement) { $('statementDialog').close(); printStatement(shownStatement); } });

    function renderArchive() {
        const list = $('archiveList');
        if (!list) return;
        if (archive == null) { $('archiveSummary').textContent = ''; list.replaceChildren(el('p', 'directory-empty', 'Das Archiv wird geladen …')); return; }
        // Je Person (Konto): Der Name kommt aus dem Konto – so stehen alle Monate unter einem Namen, auch nach einer Umbenennung.
        const groups = new Map();
        archive.forEach(item => {
            const key = item.profile_id || `name:${Abrechnung.key(item.person_name)}`;
            if (!groups.has(key)) groups.set(key, { key, name: statementName(item), items: [] });
            groups.get(key).items.push(item);
        });
        const persons = [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, 'de'));
        const fold = text => String(text || '').toLocaleLowerCase('de');
        const shown = persons.filter(person => !archiveQuery || fold(person.name).includes(fold(archiveQuery)));
        $('archiveSummary').textContent = archive.length
            ? `${archive.length} ${archive.length === 1 ? 'Abrechnung' : 'Abrechnungen'} · ${persons.length} ${persons.length === 1 ? 'Person' : 'Personen'}${archiveQuery ? ` · ${shown.length} gefunden` : ''}`
            : '';
        list.replaceChildren();
        if (!archive.length) { list.append(el('p', 'directory-empty', 'Noch nichts freigegeben. Sobald du eine Abrechnung im Portal freigibst, steht sie hier – unter dem Namen der Person.')); return; }
        if (!shown.length) { list.append(el('p', 'directory-empty', 'Kein Name passt zur Suche.')); return; }
        shown.forEach(person => {
            const items = [...person.items].sort((left, right) => String(right.month).localeCompare(String(left.month)));
            const box = el('details', 'archive-person');
            box.dataset.person = person.key;
            box.open = archiveOpen.has(person.key) || Boolean(archiveQuery) || shown.length === 1;
            box.addEventListener('toggle', () => { if (box.open) archiveOpen.add(person.key); else archiveOpen.delete(person.key); });
            const summary = el('summary');
            const waiting = items.filter(item => item.response === 'offen' && !item.data?.running).length;
            const objections = items.filter(item => item.response === 'einwand').length;
            const sum = items.reduce((total, item) => total + Number(item.data?.total || 0), 0);
            const info = el('span', 'archive-person-info', `${items.length} ${items.length === 1 ? 'Abrechnung' : 'Abrechnungen'} · zuletzt ${statementLabel(items[0])} · zusammen ${euro(sum)}`);
            summary.append(el('strong', 'archive-person-name', person.name), info);
            if (objections) { const pill = el('span', 'status-pill', objections === 1 ? 'Einwand' : `${objections} Einwände`); pill.dataset.status = 'offen'; summary.append(pill); }
            else if (waiting) { const pill = el('span', 'status-pill', waiting === 1 ? 'wartet auf Bestätigung' : `${waiting} warten auf Bestätigung`); pill.dataset.status = 'in Arbeit'; summary.append(pill); }
            const wrap = el('div', 'fleet-table-wrap');
            const table = el('table', 'fleet-table archive-table');
            const head = el('tr');
            ['Monat', 'Arbeitstage', 'Salary', 'Belege', 'Gesamt', 'Freigegeben', 'Stand im Portal', 'Aktion'].forEach(text => head.append(el('th', null, text)));
            const thead = el('thead');
            thead.append(head);
            const tbody = el('tbody');
            items.forEach(item => {
                const data = item.data || {};
                const tr = el('tr');
                tr.dataset.month = item.month;
                const live = item.data?.running && item.response !== 'einwand';
                const state = el('span', 'status-pill', live ? 'laufend' : STATEMENT_STATE[item.response] || item.response);
                state.dataset.status = live ? 'bekannt' : STATEMENT_PILL[item.response] || 'bekannt';
                const stateCell = el('td');
                stateCell.append(state);
                if (item.response === 'bestätigt') stateCell.append(el('small', 'payroll-sub', `am ${stamp(item.responded_at)}`));
                if (item.response === 'einwand' && item.response_note) stateCell.append(el('small', 'payroll-sub payroll-objection', `„${item.response_note}“`));
                const actions = el('td', 'archive-actions');
                const view = el('button', 'button-secondary fleet-end-button', 'Ansehen');
                view.type = 'button';
                view.setAttribute('aria-label', `Abrechnung ${statementLabel(item)} von ${person.name} ansehen`);
                view.addEventListener('click', () => showStatement(item));
                const print = el('button', 'button-secondary fleet-end-button', 'Drucken');
                print.type = 'button';
                print.setAttribute('aria-label', `Abrechnung ${statementLabel(item)} von ${person.name} drucken`);
                print.addEventListener('click', () => printStatement(item));
                const open = el('button', 'button-quiet', 'Zum Monat');
                open.type = 'button';
                open.title = 'Diesen Monat in der Endliste öffnen (zum Ändern oder neu Freigeben)';
                open.addEventListener('click', () => {
                    month = item.month;
                    try { sessionStorage.setItem(MONTH_KEY, month); } catch (error) { /* gilt dann nur bis zum Neuladen */ }
                    tab = 'list';
                    refresh();
                });
                actions.append(view, print, open);
                tr.append(el('td', null, statementLabel(item)), el('td', null, String(data.workdays ?? '–')), el('td', 'payroll-number', euro(data.salary || 0)),
                    el('td', 'payroll-number', own(data) ? `${euro(data.receiptSum || 0)} (${own(data)})` : '–'), el('td', 'payroll-number payroll-total', euro(data.total || 0)),
                    el('td', null, `${stamp(item.released_at)}${item.released_by ? ` · ${item.released_by}` : ''}`), stateCell, actions);
                tbody.append(tr);
            });
            table.append(thead, tbody);
            wrap.append(table);
            box.append(summary, wrap);
            list.append(box);
        });
    }
    $('archiveSearch').addEventListener('input', () => { archiveQuery = $('archiveSearch').value.trim(); renderArchive(); });

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
