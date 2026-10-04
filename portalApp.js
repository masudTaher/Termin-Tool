// Dolmetscher-Portal (Handy-App): vier Bereiche in der unteren Leiste –
// Fahrzeug · Aufträge · Arbeitstage · Abrechnung.
// Ohne übernommenes Fahrzeug ist nur die Übernahme möglich. Schaden, Meldung und
// Rückgabe erscheinen erst, wenn ein Fahrzeug übernommen wurde.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const config = window.TERMIN_CLOUD_CONFIG || {};
    const FUEL = config.fuelLabels || ['Leer', '1/4', '1/2', '3/4', 'Voll'];
    const DEFAULT_USER_LINE = 'Botschaft · Dolmetscher und Transport';
    let profile = null;
    let vehicles = [];
    let openHandovers = [];
    let myHandover = null;
    let sketch = null;
    let takeSketch = null;
    let damagePosition = null;
    let jobsData = [];
    let receiptData = [];
    let statementData = [];
    let currentView = 'vehicle';
    let workedMonth = '';

    function toast(message, kind = 'info') {
        const item = document.createElement('div');
        item.className = 'toast';
        item.dataset.kind = kind;
        item.textContent = message;
        $('toastRegion').append(item);
        window.setTimeout(() => item.remove(), kind === 'error' ? 9000 : 4500);
    }

    function setStatus(message, kind = 'info') {
        const status = $('portalStatus');
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    function show(view) {
        $('portalAuth').hidden = view !== 'auth';
        $('portalPending').hidden = view !== 'pending';
        $('portalApp').hidden = view !== 'app';
        $('portalTabbar').hidden = view !== 'app';
        $('portalSignOut').hidden = view === 'auth';
        document.body.classList.toggle('has-tabbar', view === 'app');
    }

    const vehicleLabel = vehicle => [vehicle.plate, [vehicle.brand, vehicle.body].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    const vehicleById = id => vehicles.find(vehicle => vehicle.id === id);
    const isoDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const formatKm = value => value == null ? 'unbekannt' : `${Number(value).toLocaleString('de-DE')} km`;
    const radioValue = name => document.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
    const cleanText = value => value == null ? 'unbekannt' : value ? 'sauber' : 'nicht sauber';
    const monthLabel = month => { const [year, number] = month.split('-').map(Number); return new Date(year, number - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }); };
    const money = value => Number(value || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

    function fillStateList(list, rows) {
        list.replaceChildren(...rows.flatMap(([term, value]) => {
            const dt = document.createElement('dt'); dt.textContent = term;
            const dd = document.createElement('dd'); dd.textContent = value;
            return [dt, dd];
        }));
    }

    function buildSegmented(container, name, entries) {
        container.replaceChildren(...entries.map(([value, text]) => {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = name;
            input.value = value;
            input.required = true;
            const span = document.createElement('span');
            span.textContent = text;
            label.append(input, span);
            return label;
        }));
    }

    async function refresh() {
        setStatus('');
        if (!client) {
            show('auth');
            setStatus('Die Verbindung zur Datenbank konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu.', 'error');
            return;
        }
        try {
            profile = await TerminCloud.getProfile(true);
        } catch (error) {
            show('auth');
            setStatus(error.message, 'error');
            return;
        }
        if (!profile) { show('auth'); $('portalUser').textContent = DEFAULT_USER_LINE; return; }
        $('portalUser').textContent = [profile.full_name || profile.email, profile.employment === 'fest' ? 'fest angestellt' : ''].filter(Boolean).join(' · ');
        if (!profile.active) { show('pending'); return; }
        show('app');
        await loadFleet();
        await Promise.all([loadJobs(), loadReceipts(), loadWorkdays(), loadStatements()]);
        renderWorked();
        renderHome();
    }

    // ---------- Bereiche ----------
    // Unterseiten gehören zu einem Bereich der unteren Leiste.
    const TAB_OF = { vehicle: 'vehicle', damage: 'vehicle', alert: 'vehicle', return: 'vehicle', jobs: 'jobs', workdays: 'workdays', statement: 'statement', receipts: 'statement' };
    const NEEDS_VEHICLE = ['damage', 'alert', 'return'];

    function goTo(view) {
        if (!TAB_OF[view]) view = 'vehicle';
        if (NEEDS_VEHICLE.includes(view) && !myHandover) {
            toast('Übernimm zuerst ein Fahrzeug.', 'info');
            view = 'vehicle';
        }
        currentView = view;
        document.querySelectorAll('#portalTabbar button').forEach(button => {
            const active = button.dataset.view === TAB_OF[view];
            button.classList.toggle('is-active', active);
            if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
        });
        document.querySelectorAll('#portalApp > [data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== view; });
        window.scrollTo({ top: 0 });
        if (view === 'vehicle') renderHome();
        if (view === 'damage') loadDamages();
        if (view === 'alert') loadAlerts();
        if (view === 'workdays') renderWorked();
    }
    document.querySelectorAll('#portalTabbar button').forEach(button => button.addEventListener('click', () => goTo(button.dataset.view)));
    document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => goTo(button.dataset.go)));

    // ---------- Startseite (Fahrzeug) ----------
    function renderHome() {
        if (!profile?.active) return;
        const today = TerminCloud.todayIso();
        $('helloTitle').textContent = `Hallo ${String(profile.full_name || '').split(' ')[0] || ''}`.trim();
        $('helloDate').textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long' });

        const open = jobsData.filter(item => item.date >= today && !item.cancelled && item.response === 'offen').length;
        const notices = [];
        const waiting = statementData.find(item => item.response === 'offen');
        if (waiting) notices.push([`Deine Abrechnung für ${monthLabel(waiting.month)} wartet auf deine Bestätigung.`, 'statement']);
        if (open) notices.push([`${open} ${open === 1 ? 'Auftrag wartet' : 'Aufträge warten'} auf deine Antwort.`, 'jobs']);
        $('startNotices').replaceChildren(...notices.map(([text, view]) => {
            const item = document.createElement('li');
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = text;
            button.addEventListener('click', () => goTo(view));
            item.append(button);
            return item;
        }));
    }

    // ---------- Abrechnung ----------
    async function loadStatements() {
        const { data, error } = await client.from('tt_statements').select('*').eq('profile_id', profile.id).order('month', { ascending: false }).limit(24);
        statementData = error ? [] : data;
        $('statementBadge').hidden = !statementData.some(item => item.response === 'offen');
        $('statementBadge').textContent = '!';
        const select = $('statementMonth');
        const previous = select.value;
        const now = new Date();
        const recent = [0, 1, 2].map(offset => { const date = new Date(now.getFullYear(), now.getMonth() - offset, 1); return isoDate(date).slice(0, 7); });
        const months = [...new Set([...statementData.map(item => item.month), ...recent])].sort().reverse();
        select.replaceChildren(...months.map(month => {
            const option = document.createElement('option');
            option.value = month;
            const statement = statementData.find(item => item.month === month);
            option.textContent = monthLabel(month) + (statement ? { offen: ' · bitte prüfen', 'bestätigt': ' · bestätigt', einwand: ' · Einwand gemeldet' }[statement.response] : '');
            return option;
        }));
        select.value = months.includes(previous) ? previous : (statementData.find(item => item.response === 'offen')?.month || months[0]);
        await renderStatement();
    }
    $('statementMonth').addEventListener('change', () => renderStatement());

    async function renderStatement() {
        const month = $('statementMonth').value;
        const statement = statementData.find(item => item.month === month);
        const body = $('statementBody');
        body.replaceChildren();
        const line = (term, value, strong) => {
            const row = document.createElement('div');
            row.className = `statement-line${strong ? ' is-total' : ''}`;
            const left = document.createElement('span'); left.textContent = term;
            const right = document.createElement('span'); right.textContent = value;
            row.append(left, right);
            return row;
        };
        const dateText = iso => new Date(`${iso}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        if (!statement) {
            const worked = [...new Set(jobsData.filter(item => !item.cancelled && item.work_status === 'beendet' && item.date.startsWith(month)).map(item => item.date))].sort();
            const receiptsOfMonth = receiptData.filter(item => item.date.startsWith(month) && item.status !== 'abgelehnt');
            const info = document.createElement('p');
            info.className = 'fleet-footnote';
            info.textContent = `Die Abrechnung für ${monthLabel(month)} ist noch nicht freigegeben. Vorläufig aus deinen Einträgen:`;
            body.append(info,
                line('Gearbeitete Tage laut Aufträgen', worked.length ? `${worked.length} (${worked.map(dateText).join(', ')})` : '0'),
                line('Eingereichte Belege', `${receiptsOfMonth.length} · ${money(receiptsOfMonth.reduce((sum, item) => sum + Number(item.amount), 0))}`));
        } else {
            const data = statement.data || {};
            const special = Array.isArray(data.specialDays) ? data.specialDays : [];
            const receiptsOfMonth = Array.isArray(data.receipts) ? data.receipts : [];
            body.append(
                line('Zeitraum', data.period || monthLabel(month)),
                line('Arbeitstage', `${data.workdays ?? '–'}${data.dates?.length ? ` (${data.dates.map(dateText).join(', ')})` : ''}`),
                line(`davon normale Tage × ${money(data.rate)}`, `${(data.workdays ?? 0) - (data.specialCount ?? 0)} Tage`),
                ...special.map(item => line(`Sondertag ${dateText(item.date)}${item.job ? ` · ${item.job}` : ''}`, `${money(item.amount)}${item.counts === 'prüfen' ? ' (wird geprüft)' : ''}`)),
                line('Salary', money(data.salary)),
                ...receiptsOfMonth.map(item => line(`Beleg ${dateText(item.date)} · ${item.place || item.kind}`, money(item.amount))),
                line(`Belege gesamt (${receiptsOfMonth.length})`, money(data.receiptSum)),
                line('Gesamtbetrag', money(data.total), true)
            );
            const state = document.createElement('p');
            state.className = 'statement-state';
            state.dataset.response = statement.response;
            state.textContent = { offen: 'Bitte prüfe die Abrechnung und bestätige sie.', 'bestätigt': `Von dir bestätigt am ${new Date(statement.responded_at).toLocaleDateString('de-DE')}.`, einwand: `Einwand gemeldet: „${statement.response_note}“ – die Einsatzleitung meldet sich.` }[statement.response];
            body.append(state);
            if (statement.response !== 'bestätigt') {
                const note = document.createElement('textarea');
                note.rows = 2;
                note.maxLength = 500;
                note.placeholder = 'Stimmt etwas nicht? Hier kurz beschreiben (z. B. fehlender Arbeitstag am 12.09.)';
                note.setAttribute('aria-label', 'Einwand zur Abrechnung');
                const buttons = document.createElement('div');
                buttons.className = 'job-buttons statement-buttons';
                const respond = async (response) => {
                    if (response === 'einwand' && !note.value.trim()) { toast('Bitte schreib kurz, was nicht stimmt.', 'error'); note.focus(); return; }
                    const { error } = await client.rpc('tt_respond_statement', { p_month: month, p_response: response, p_note: response === 'einwand' ? note.value.trim() : '' });
                    if (error) { toast(TerminCloud.germanError(error), 'error'); return; }
                    toast(response === 'bestätigt' ? 'Abrechnung bestätigt. Danke!' : 'Einwand gesendet.', 'success');
                    await loadStatements();
                    renderHome();
                };
                const ok = document.createElement('button');
                ok.type = 'button';
                ok.className = 'button-primary';
                ok.textContent = 'Stimmt – bestätigen';
                ok.addEventListener('click', () => respond('bestätigt'));
                const wrong = document.createElement('button');
                wrong.type = 'button';
                wrong.className = 'button-secondary';
                wrong.textContent = 'Stimmt nicht';
                wrong.addEventListener('click', () => respond('einwand'));
                buttons.append(ok, wrong);
                body.append(note, buttons);
            }
        }

        // Eigene Fahrzeuge im Monat
        const list = $('statementVehicles');
        list.replaceChildren();
        const [year, number] = month.split('-').map(Number);
        const end = isoDate(new Date(year, number, 0));
        const { data: handovers, error } = await client.from('tt_handovers').select('*').eq('driver_id', profile.id).gte('date', `${month}-01`).lte('date', end).order('date', { ascending: false });
        if (error || !handovers.length) {
            const empty = document.createElement('li');
            empty.className = 'directory-empty';
            empty.textContent = 'In diesem Monat hast du kein Fahrzeug übernommen.';
            list.append(empty);
            return;
        }
        handovers.forEach(item => {
            const entry = document.createElement('li');
            entry.className = 'directory-entry damage-entry';
            const text = document.createElement('span');
            text.className = 'directory-entry-name';
            const km = item.start_mileage != null && item.end_mileage != null ? ` · ${item.end_mileage - item.start_mileage} km` : '';
            text.textContent = `${dateText(item.date)} · ${vehicleById(item.vehicle_id)?.plate || 'Fahrzeug'} · ${String(item.start_time).slice(0, 5)}–${item.end_time ? String(item.end_time).slice(0, 5) : 'offen'}${km}${item.emergency ? ' · Notdienst' : ''}`;
            entry.append(text);
            list.append(entry);
        });
    }

    // ---------- Aufträge ----------
    const RESPONSES = [['zugesagt', 'Zusage'], ['vorbehalt', 'Unter Vorbehalt'], ['abgesagt', 'Absage']];
    const RESPONSE_LABEL = { offen: 'Antwort offen', zugesagt: 'Zusage', vorbehalt: 'Unter Vorbehalt', abgesagt: 'Absage' };
    const WORK_LABEL = { beendet: 'gearbeitet', alleine: 'Patient ging alleine', storniert: 'storniert', losgefahren: 'unterwegs', offen: '' };
    let knownJobIds = null;

    async function loadJobs() {
        const { data, error } = await client.from('tt_assignments').select('*').eq('interpreter_id', profile.id).order('date', { ascending: false }).limit(200);
        if (error) { $('jobsSummary').textContent = 'Aufträge konnten nicht geladen werden.'; return; }
        jobsData = data;
        const today = TerminCloud.todayIso();
        const upcoming = data.filter(item => item.date >= today && !item.cancelled).sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
        const open = upcoming.filter(item => item.response === 'offen').length;
        $('jobsSummary').textContent = upcoming.length
            ? `${upcoming.length} ${upcoming.length === 1 ? 'Auftrag' : 'Aufträge'}${open ? `, ${open} ${open === 1 ? 'wartet' : 'warten'} auf deine Antwort` : ''}`
            : 'Im Moment hast du keine Aufträge.';
        $('jobsBadge').hidden = !open;
        $('jobsBadge').textContent = open ? String(open) : '';

        // Hinweis, wenn seit dem letzten Laden ein neuer Auftrag dazugekommen ist.
        const ids = new Set(upcoming.map(item => item.id));
        if (knownJobIds && [...ids].some(id => !knownJobIds.has(id))) toast('Du hast einen neuen Auftrag.', 'success');
        knownJobIds = ids;

        const list = $('jobList');
        list.replaceChildren();
        upcoming.forEach(item => {
            const card = document.createElement('li');
            card.className = 'job-card';
            card.dataset.response = item.response;
            const head = document.createElement('div');
            head.className = 'job-head';
            const title = document.createElement('strong');
            title.textContent = `${new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })} · ${item.title}`;
            const state = document.createElement('span');
            state.className = 'status-pill';
            state.dataset.status = { offen: 'in Arbeit', zugesagt: 'erledigt', vorbehalt: 'bekannt', abgesagt: 'offen' }[item.response];
            state.textContent = RESPONSE_LABEL[item.response];
            head.append(title, state);
            const details = document.createElement('details');
            details.open = item.response === 'offen';
            const summary = document.createElement('summary');
            summary.textContent = 'Auftrag ansehen';
            const message = document.createElement('p');
            message.className = 'job-message';
            message.textContent = item.message;
            details.append(summary, message);
            const note = document.createElement('input');
            note.type = 'text';
            note.maxLength = 300;
            note.placeholder = 'Hinweis an die Einsatzleitung (optional)';
            note.value = item.response_note || '';
            note.setAttribute('aria-label', 'Hinweis zur Antwort');
            const buttons = document.createElement('div');
            buttons.className = 'job-buttons';
            RESPONSES.forEach(([value, text]) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'workday-button';
                button.dataset.response = value;
                button.textContent = text;
                button.setAttribute('aria-pressed', String(item.response === value));
                button.addEventListener('click', async () => {
                    const { error: rpcError } = await client.rpc('tt_respond_assignment', { p_id: item.id, p_response: value, p_note: note.value.trim() });
                    if (rpcError) { toast(TerminCloud.germanError(rpcError), 'error'); return; }
                    toast(`${text} gesendet`, 'success');
                    await loadJobs();
                });
                buttons.append(button);
            });
            card.append(head, details, note, buttons);
            list.append(card);
        });

        const history = $('jobHistory');
        history.replaceChildren();
        const past = data.filter(item => item.date < today || item.cancelled);
        if (!past.length) {
            const empty = document.createElement('li');
            empty.className = 'directory-empty';
            empty.textContent = 'Noch keine vergangenen Aufträge.';
            history.append(empty);
        }
        past.forEach(item => {
            const entry = document.createElement('li');
            entry.className = 'directory-entry damage-entry';
            const text = document.createElement('span');
            text.className = 'directory-entry-name';
            text.textContent = `${new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE')} · ${item.title}`;
            const state = document.createElement('span');
            state.className = 'status-pill';
            state.dataset.status = item.cancelled ? 'bekannt' : { offen: 'in Arbeit', zugesagt: 'erledigt', vorbehalt: 'bekannt', abgesagt: 'offen' }[item.response];
            state.textContent = item.cancelled ? 'zurückgezogen' : [RESPONSE_LABEL[item.response], WORK_LABEL[item.work_status]].filter(Boolean).join(' · ');
            entry.append(text, state);
            history.append(entry);
        });
    }

    // ---------- Fahrzeug ----------
    async function loadFleet() {
        const [vehicleResult, handoverResult] = await Promise.all([
            client.from('tt_vehicles').select('*').eq('active', true).order('plate'),
            client.from('tt_handovers').select('*').is('end_time', null)
        ]);
        if (vehicleResult.error || handoverResult.error) {
            setStatus(TerminCloud.germanError(vehicleResult.error || handoverResult.error), 'error');
            return;
        }
        vehicles = vehicleResult.data;
        openHandovers = handoverResult.data;
        const holderByVehicle = new Map(openHandovers.map(item => [item.vehicle_id, item]));
        myHandover = openHandovers.find(item => item.driver_id === profile.id) || null;
        const myVehicle = myHandover ? vehicleById(myHandover.vehicle_id) : null;
        const fixedVehicle = vehicles.find(vehicle => vehicle.assigned_to === profile.id) || null;

        $('noVehicle').hidden = Boolean(myHandover);
        $('hasVehicle').hidden = !myHandover;

        if (myHandover) {
            $('heroPlate').textContent = myVehicle?.plate || 'Fahrzeug';
            $('heroModel').textContent = myVehicle ? [myVehicle.brand, myVehicle.body, myVehicle.type].filter(Boolean).join(' · ') : '';
            const sinceDay = myHandover.date === TerminCloud.todayIso() ? 'heute' : new Date(`${myHandover.date}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
            $('heroSince').textContent = `übernommen ${sinceDay} um ${String(myHandover.start_time).slice(0, 5)} Uhr${myHandover.emergency ? ' · Notdienst' : ''}`;
            fillStateList($('vehicleState'), [
                ['Letzter Fahrer', myHandover.previous_driver_name || 'unbekannt'],
                ['Kilometer bei Übernahme', formatKm(myHandover.start_mileage)],
                ['Tank', myVehicle?.fuel == null ? 'unbekannt' : FUEL[myVehicle.fuel]],
                ['Parkort', myVehicle?.parking || 'unbekannt'],
                ['Innen', cleanText(myVehicle?.clean_inside)],
                ['Außen', cleanText(myVehicle?.clean_outside)]
            ]);
            const label = myVehicle ? vehicleLabel(myVehicle) : 'dein Fahrzeug';
            $('damageVehicleLabel').textContent = `${label} – schau zuerst, ob der Schaden schon markiert ist.`;
            $('alertVehicleLabel').textContent = `${label} – Warnleuchte oder Hinweis im Display.`;
            $('returnVehicleLabel').textContent = `${label} – bitte alle Angaben ausfüllen.`;
            $('returnMileageHint').textContent = myVehicle?.mileage != null ? `Letzter Stand: ${formatKm(myVehicle.mileage)}` : '';
            loadHeroDamages();
        } else {
            $('myVehicleInfo').textContent = fixedVehicle
                ? `Dein festes Fahrzeug ist ${vehicleLabel(fixedVehicle)}.`
                : 'Wähle ein freies Fahrzeug.';
        }

        // Ab 16 Uhr erinnern, wenn das Auto noch nicht zurückgegeben ist (außer im Notdienst).
        const overdue = myHandover && !myHandover.emergency && (new Date().getHours() >= 16 || myHandover.date < TerminCloud.todayIso());
        $('returnReminder').hidden = !overdue;
        $('returnReminder').textContent = overdue ? 'Bitte gib dein Fahrzeug zurück, wenn du fertig bist.' : '';
        $('takeEmergencyRow').hidden = profile.employment !== 'fest';
        loadReturnNotes();

        fillTakeSelect(holderByVehicle, !myHandover && fixedVehicle && !holderByVehicle.has(fixedVehicle.id) ? fixedVehicle.id : '');
        updateTakePreview();
        // Unterseiten für Schaden, Meldung und Rückgabe gibt es nur mit Fahrzeug.
        if (NEEDS_VEHICLE.includes(currentView) && !myHandover) goTo('vehicle');
    }

    // Nur freie Fahrzeuge, getrennt nach diplomatischen Fahrzeugen und Mietwagen.
    function fillTakeSelect(holderByVehicle, preferred) {
        const select = $('takeVehicleSelect');
        const previous = select.value;
        const free = vehicles.filter(vehicle => !holderByVehicle.has(vehicle.id));
        const empty = document.createElement('option');
        empty.value = '';
        empty.textContent = free.length ? 'Freies Fahrzeug wählen' : (vehicles.length ? 'Gerade ist kein Fahrzeug frei' : 'Noch keine Fahrzeuge angelegt');
        const groups = [['Diplomatische Fahrzeuge', vehicle => vehicle.type === 'Diplomatisch'], ['Mietwagen', vehicle => vehicle.type === 'Mietwagen'], ['Weitere Fahrzeuge', vehicle => !['Diplomatisch', 'Mietwagen'].includes(vehicle.type)]];
        select.replaceChildren(empty, ...groups.map(([label, matches]) => {
            const group = document.createElement('optgroup');
            group.label = label;
            free.filter(matches).forEach(vehicle => {
                const option = document.createElement('option');
                option.value = vehicle.id;
                option.textContent = vehicleLabel(vehicle) + (vehicle.assigned_to === profile.id ? ' (dein festes Fahrzeug)' : '');
                group.append(option);
            });
            return group;
        }).filter(group => group.children.length));
        select.value = free.some(vehicle => vehicle.id === previous) ? previous : (preferred || '');
    }

    function damageEntry(item, index) {
        const entry = document.createElement('li');
        entry.className = 'directory-entry damage-entry';
        const text = document.createElement('span');
        text.className = 'directory-entry-name';
        text.textContent = `${index + 1} · ${item.zone || 'ohne Position'} · ${item.description}`;
        const state = document.createElement('span');
        state.className = 'status-pill';
        state.dataset.status = item.status;
        state.textContent = CarSketch.STATUS_LABELS[item.status] || item.status;
        entry.append(text, state);
        return entry;
    }

    async function currentDamages(vehicleId) {
        const { data, error } = await client.from('tt_damages').select('*').eq('vehicle_id', vehicleId).order('created_at');
        if (error) throw error;
        return data.filter(item => item.status !== 'erledigt');
    }

    // Vor der Übernahme: letzter Stand vom vorherigen Fahrer und die bekannten Schäden.
    let previewToken = 0;
    async function updateTakePreview() {
        const vehicle = vehicleById($('takeVehicleSelect').value);
        $('takeMileageHint').textContent = vehicle?.mileage != null ? `Letzter Stand: ${formatKm(vehicle.mileage)}` : '';
        $('takeLastState').hidden = !vehicle;
        $('takeNoteRow').hidden = !vehicle;
        if (!vehicle) return;
        fillStateList($('takeStateList'), [
            ['Letzter Fahrer', vehicle.state_updated_at ? `${vehicle.state_updated_by || 'unbekannt'}, ${new Date(vehicle.state_updated_at).toLocaleDateString('de-DE')}` : 'noch keine Angaben'],
            ['Kilometer', formatKm(vehicle.mileage)],
            ['Tank', vehicle.fuel == null ? 'unbekannt' : FUEL[vehicle.fuel]],
            ['Parkort', vehicle.parking || 'unbekannt'],
            ['Innen', cleanText(vehicle.clean_inside)],
            ['Außen', cleanText(vehicle.clean_outside)]
        ]);
        const token = ++previewToken;
        $('takeDamagesSummary').textContent = 'Bekannte Schäden werden geladen …';
        try {
            const current = await currentDamages(vehicle.id);
            if (token !== previewToken) return;
            if (!takeSketch) takeSketch = CarSketch.create($('takeSketch'), {});
            takeSketch.setMarkers(current.map((item, index) => ({ id: item.id, x: item.pos_x, y: item.pos_y, status: item.status, label: item.description, number: index + 1 })));
            $('takeDamagesSummary').textContent = current.length
                ? `${current.length} ${current.length === 1 ? 'bekannter Schaden' : 'bekannte Schäden'} – ansehen`
                : 'Keine Schäden eingetragen';
            $('takeDamages').classList.toggle('is-empty', !current.length);
            if (!current.length) $('takeDamages').open = false;
            $('takeDamageList').replaceChildren(...current.map(damageEntry));
        } catch (error) {
            if (token === previewToken) $('takeDamagesSummary').textContent = 'Schäden konnten nicht geladen werden';
        }
    }
    $('takeVehicleSelect').addEventListener('change', updateTakePreview);

    async function loadHeroDamages() {
        if (!myHandover) return;
        try {
            const current = await currentDamages(myHandover.vehicle_id);
            $('heroDamages').textContent = current.length
                ? `${current.length} ${current.length === 1 ? 'Schaden ist' : 'Schäden sind'} für dieses Auto schon eingetragen. Unter „Schaden melden“ siehst du die Skizze.`
                : 'Für dieses Auto ist noch kein Schaden eingetragen.';
        } catch (error) {
            $('heroDamages').textContent = '';
        }
    }

    // Hinweise der Nachfolger zu den eigenen Rückgaben ("Tank war leer …").
    async function loadReturnNotes() {
        const list = $('returnNotes');
        const { data, error } = await client.from('tt_handovers').select('*').eq('previous_driver_id', profile.id).order('created_at', { ascending: false }).limit(20);
        list.replaceChildren();
        if (error) return;
        data.filter(item => item.start_note).slice(0, 3).forEach(item => {
            const entry = document.createElement('li');
            entry.className = 'directory-entry damage-entry';
            const text = document.createElement('span');
            text.className = 'directory-entry-name';
            text.textContent = `Hinweis zu deiner Rückgabe (${vehicleById(item.vehicle_id)?.plate || 'Fahrzeug'}, ${new Date(item.created_at).toLocaleDateString('de-DE')}): „${item.start_note}“ – ${item.driver_name}`;
            entry.append(text);
            list.append(entry);
        });
    }

    $('takeVehicleForm').addEventListener('submit', async event => {
        event.preventDefault();
        const vehicleId = $('takeVehicleSelect').value;
        if (!vehicleId) return;
        const button = event.target.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            const { error } = await client.rpc('tt_take_vehicle', {
                p_vehicle: vehicleId, p_mileage: Number($('takeVehicleMileage').value), p_note: 'Im Portal übernommen',
                p_emergency: profile.employment === 'fest' && $('takeEmergency').checked, p_start_note: $('takeStartNote').value.trim()
            });
            if (error) { toast(TerminCloud.germanError(error), 'error'); $('takeVehicleMileage').focus(); return; }
            event.target.reset();
            toast('Fahrzeug übernommen', 'success');
            await loadFleet();
            window.scrollTo({ top: 0 });
        } finally {
            button.disabled = false;
        }
    });

    buildSegmented($('returnFuel'), 'returnFuel', FUEL.map((text, index) => [String(index), text]));
    $('returnParking').replaceChildren(...[['', 'Bitte wählen'], ...(config.parkingOptions || []).map(option => [option, option])].map(([value, text]) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        return option;
    }));

    $('returnVehicleForm').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.target.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            const { error } = await client.rpc('tt_return_vehicle', {
                p_mileage: Number($('returnVehicleMileage').value),
                p_fuel: Number(radioValue('returnFuel')),
                p_parking: $('returnParking').value,
                p_clean_inside: radioValue('cleanInside') === 'yes',
                p_clean_outside: radioValue('cleanOutside') === 'yes'
            });
            if (error) { toast(TerminCloud.germanError(error), 'error'); $('returnVehicleMileage').focus(); return; }
            event.target.reset();
            toast('Fahrzeug zurückgegeben. Danke!', 'success');
            await loadFleet();
            goTo('vehicle');
        } finally {
            button.disabled = false;
        }
    });

    // ---------- Schäden (nur für das übernommene Fahrzeug) ----------
    async function loadDamages() {
        if (!sketch) {
            sketch = CarSketch.create($('damageSketch'), {
                onPick: position => {
                    damagePosition = position;
                    $('damagePosition').textContent = `Neue Markierung: ${CarSketch.zoneLabel(position.x, position.y)}`;
                },
                onMarker: marker => document.getElementById(`known-${marker.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            });
        }
        const list = $('knownDamages');
        list.replaceChildren();
        sketch.setMarkers([]);
        if (!myHandover) return;
        let current;
        try {
            current = await currentDamages(myHandover.vehicle_id);
        } catch (error) {
            setStatus(TerminCloud.germanError(error), 'error');
            return;
        }
        sketch.setMarkers(current.map((item, index) => ({ id: item.id, x: item.pos_x, y: item.pos_y, status: item.status, label: item.description, number: index + 1 })));
        if (!current.length) {
            const empty = document.createElement('li');
            empty.className = 'directory-empty';
            empty.textContent = 'Für dieses Fahrzeug ist noch kein Schaden eingetragen.';
            list.append(empty);
            return;
        }
        current.forEach((item, index) => {
            const entry = damageEntry(item, index);
            entry.id = `known-${item.id}`;
            list.append(entry);
        });
    }

    $('damageForm').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.target.querySelector('button[type="submit"]');
        const description = $('damageDescription').value.trim();
        if (!myHandover) { goTo('vehicle'); return; }
        if (!description) return;
        if (!damagePosition) {
            toast('Bitte tippe zuerst in der Skizze auf die Stelle des Schadens.', 'error');
            $('damageSketch').scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        button.disabled = true;
        try {
            const files = [...($('damagePhoto').files || [])].slice(0, 3);
            const paths = [];
            for (const file of files) paths.push(await TerminCloud.uploadPhoto(file, profile.id));
            const { error } = await client.from('tt_damages').insert({
                vehicle_id: myHandover.vehicle_id, reporter_id: profile.id, reporter_name: profile.full_name || profile.email,
                description, pos_x: damagePosition.x, pos_y: damagePosition.y,
                zone: CarSketch.zoneLabel(damagePosition.x, damagePosition.y),
                photo_path: paths[0] || '', photo_paths: paths
            });
            if (error) throw error;
            $('damageDescription').value = '';
            $('damagePhoto').value = '';
            damagePosition = null;
            sketch.setPicked(null);
            $('damagePosition').textContent = 'Tippe in der Skizze auf die Stelle des neuen Schadens.';
            toast('Schaden gemeldet. Danke!', 'success');
            await loadDamages();
            loadHeroDamages();
        } catch (error) {
            toast(TerminCloud.germanError(error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    // ---------- Meldungen im Auto (nur für das übernommene Fahrzeug) ----------
    buildSegmented($('alertKinds'), 'alertKind', (config.alertKinds || ['Sonstiges']).map(kind => [kind, kind]));

    async function loadAlerts() {
        const list = $('openAlerts');
        list.replaceChildren();
        if (!myHandover) return;
        const { data, error } = await client.from('tt_alerts').select('*').eq('vehicle_id', myHandover.vehicle_id).eq('status', 'offen').order('created_at');
        if (error || !data.length) return;
        data.forEach(item => {
            const entry = document.createElement('li');
            entry.className = 'directory-entry';
            const text = document.createElement('span');
            text.className = 'directory-entry-name';
            text.textContent = `${item.kind}${item.note ? ` – ${item.note}` : ''} · ${new Date(item.created_at).toLocaleDateString('de-DE')}`;
            const state = document.createElement('span');
            state.className = 'status-pill';
            state.dataset.status = 'bekannt';
            state.textContent = 'bereits gemeldet';
            entry.append(text, state);
            list.append(entry);
        });
    }

    $('alertForm').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.target.querySelector('button[type="submit"]');
        const kind = radioValue('alertKind');
        if (!myHandover) { goTo('vehicle'); return; }
        if (!kind) return;
        button.disabled = true;
        try {
            const file = $('alertPhoto').files?.[0];
            const photoPath = file ? await TerminCloud.uploadPhoto(file, profile.id) : '';
            const { error } = await client.from('tt_alerts').insert({
                vehicle_id: myHandover.vehicle_id, reporter_id: profile.id, reporter_name: profile.full_name || profile.email,
                kind, note: $('alertNote').value.trim(), photo_path: photoPath
            });
            if (error) throw error;
            event.target.reset();
            toast('Meldung gesendet. Danke!', 'success');
            await loadAlerts();
        } catch (error) {
            toast(TerminCloud.germanError(error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    // ---------- Belege ----------
    async function loadReceipts() {
        if (!$('receiptDate').value) $('receiptDate').value = TerminCloud.todayIso();
        const now = new Date();
        const from = isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
        const { data, error } = await client.from('tt_receipts').select('*').eq('profile_id', profile.id).gte('date', from).order('date', { ascending: false });
        const list = $('receiptList');
        list.replaceChildren();
        if (error) { $('receiptsSummary').textContent = 'Belege konnten nicht geladen werden.'; return; }
        receiptData = data;
        const thisMonth = TerminCloud.todayIso().slice(0, 7);
        const current = data.filter(item => item.date.startsWith(thisMonth) && item.status !== 'abgelehnt');
        const sum = current.reduce((total, item) => total + Number(item.amount), 0);
        $('receiptsSummary').textContent = current.length
            ? `Diesen Monat: ${current.length} ${current.length === 1 ? 'Beleg' : 'Belege'}, zusammen ${sum.toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`
            : 'Diesen Monat noch kein Beleg. Beleg fotografieren und eintragen.';
        data.forEach(item => {
            const entry = document.createElement('li');
            entry.className = 'directory-entry damage-entry';
            const text = document.createElement('span');
            text.className = 'directory-entry-name';
            text.textContent = `${new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE')} · ${item.place} · ${Number(item.amount).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })}`;
            const side = document.createElement('span');
            side.className = 'vehicle-entry-actions';
            const state = document.createElement('span');
            state.className = 'status-pill';
            state.dataset.status = { eingereicht: 'in Arbeit', 'geprüft': 'erledigt', abgelehnt: 'offen' }[item.status];
            state.textContent = item.status;
            side.append(state);
            if (item.status === 'eingereicht') {
                const remove = document.createElement('button');
                remove.type = 'button';
                remove.className = 'button-quiet-danger';
                remove.textContent = 'Löschen';
                remove.addEventListener('click', async () => {
                    const { error: deleteError } = await client.from('tt_receipts').delete().eq('id', item.id);
                    if (deleteError) { toast(TerminCloud.germanError(deleteError), 'error'); return; }
                    await loadReceipts();
                });
                side.append(remove);
            }
            entry.append(text, side);
            list.append(entry);
        });
    }

    $('receiptForm').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.target.querySelector('button[type="submit"]');
        const file = $('receiptPhoto').files?.[0];
        const amount = Number($('receiptAmount').value);
        if (!file || !(amount > 0)) return;
        if ($('receiptDate').value > TerminCloud.todayIso()) { toast('Das Datum liegt in der Zukunft.', 'error'); return; }
        button.disabled = true;
        try {
            const kind = radioValue('receiptKind');
            const photoPath = await TerminCloud.uploadPhoto(file, profile.id);
            const { error } = await client.from('tt_receipts').insert({
                person_name: profile.full_name || profile.email, profile_id: profile.id, date: $('receiptDate').value,
                place: $('receiptPlace').value.trim(), amount, kind, proof: kind === 'Tanken' ? 'Quittung' : 'Parkbeleg',
                note: $('receiptNote').value.trim(), photo_path: photoPath, status: 'eingereicht', source: 'portal'
            });
            if (error) throw error;
            event.target.reset();
            $('receiptDate').value = TerminCloud.todayIso();
            toast('Beleg eingereicht. Danke!', 'success');
            await loadReceipts();
            goTo('statement');
        } catch (error) {
            toast(TerminCloud.germanError(error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    // ---------- Arbeitstage ----------
    async function loadWorkdays() {
        const days = Array.from({ length: 14 }, (_, offset) => { const date = new Date(); date.setDate(date.getDate() + offset); return date; });
        const { data, error } = await client.from('tt_workdays').select('*').eq('user_id', profile.id)
            .gte('date', isoDate(days[0])).lte('date', isoDate(days[days.length - 1]));
        if (error) { setStatus(TerminCloud.germanError(error), 'error'); return; }
        const statusByDate = new Map((data || []).map(item => [item.date, item.status]));
        const list = $('workdayList');
        list.replaceChildren();
        days.forEach((date, offset) => {
            const iso = isoDate(date);
            const item = document.createElement('li');
            item.className = 'workday-item';
            const label = document.createElement('span');
            label.className = 'workday-date';
            label.textContent = offset === 0 ? `Heute, ${date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}`
                : offset === 1 ? `Morgen, ${date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}`
                : date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
            const buttons = document.createElement('span');
            buttons.className = 'workday-buttons';
            [['verfügbar', 'Kann'], ['nicht verfügbar', 'Kann nicht']].forEach(([status, text]) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'workday-button';
                button.dataset.status = status;
                button.textContent = text;
                button.setAttribute('aria-pressed', String(statusByDate.get(iso) === status));
                button.addEventListener('click', () => toggleWorkday(iso, status, statusByDate.get(iso) === status));
                buttons.append(button);
            });
            item.append(label, buttons);
            list.append(item);
        });
    }

    async function toggleWorkday(date, status, wasActive) {
        const query = wasActive
            ? client.from('tt_workdays').delete().eq('user_id', profile.id).eq('date', date)
            : client.from('tt_workdays').upsert({ user_id: profile.id, date, status }, { onConflict: 'user_id,date' });
        const { error } = await query;
        if (error) { toast(TerminCloud.germanError(error), 'error'); return; }
        await loadWorkdays();
    }

    // Gearbeitete Tage: aus der freigegebenen Abrechnung, sonst aus den beendeten Aufträgen.
    function renderWorked() {
        if (!profile?.active) return;
        const now = new Date();
        const months = [0, 1].map(offset => isoDate(new Date(now.getFullYear(), now.getMonth() - offset, 1)).slice(0, 7));
        if (!months.includes(workedMonth)) workedMonth = months[0];
        $('workedMonths').replaceChildren(...months.map(month => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = monthLabel(month);
            button.classList.toggle('is-active', month === workedMonth);
            button.addEventListener('click', () => { workedMonth = month; renderWorked(); });
            return button;
        }));
        const statement = statementData.find(item => item.month === workedMonth);
        const jobsOfMonth = jobsData.filter(item => !item.cancelled && item.work_status === 'beendet' && item.date.startsWith(workedMonth));
        const dates = statement && Array.isArray(statement.data?.dates) && statement.data.dates.length
            ? [...statement.data.dates].sort()
            : [...new Set(jobsOfMonth.map(item => item.date))].sort();
        const count = statement?.data?.workdays ?? dates.length;
        $('workedSummary').textContent = `${monthLabel(workedMonth)}: ${count} ${count === 1 ? 'Tag' : 'Tage'}${statement ? ' laut Abrechnung' : ' laut deinen Aufträgen'}`;
        const list = $('workedList');
        list.replaceChildren();
        if (!dates.length) {
            const empty = document.createElement('li');
            empty.className = 'directory-empty';
            empty.textContent = statement && count ? 'Die einzelnen Tage stehen in deiner Abrechnung.' : 'Für diesen Monat ist noch kein Arbeitstag gespeichert.';
            list.append(empty);
            return;
        }
        dates.forEach(date => {
            const entry = document.createElement('li');
            entry.className = 'directory-entry damage-entry';
            const text = document.createElement('span');
            text.className = 'directory-entry-name';
            const titles = jobsOfMonth.filter(item => item.date === date).map(item => item.title).filter(Boolean);
            text.textContent = new Date(`${date}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }) + (titles.length ? ` · ${titles.join(', ')}` : '');
            entry.append(text);
            list.append(entry);
        });
    }

    // ---------- Anmeldung ----------
    function switchTab(signUp) {
        $('signInForm').hidden = signUp;
        $('signUpForm').hidden = !signUp;
        $('tabSignIn').classList.toggle('is-active', !signUp);
        $('tabSignUp').classList.toggle('is-active', signUp);
        $('tabSignIn').setAttribute('aria-selected', String(!signUp));
        $('tabSignUp').setAttribute('aria-selected', String(signUp));
    }
    $('tabSignIn').addEventListener('click', () => switchTab(false));
    $('tabSignUp').addEventListener('click', () => switchTab(true));

    $('signInForm').addEventListener('submit', async event => {
        event.preventDefault();
        try {
            await TerminCloud.signIn($('signInEmail').value.trim(), $('signInPassword').value);
            $('signInPassword').value = '';
            await refresh();
        } catch (error) {
            setStatus(error.message, 'error');
        }
    });

    $('signUpForm').addEventListener('submit', async event => {
        event.preventDefault();
        try {
            const result = await TerminCloud.signUp($('signUpEmail').value.trim(), $('signUpPassword').value, $('signUpName').value.trim().replace(/\s+/g, ' '), $('signUpPhone').value.trim(), radioValue('signUpEmployment'));
            $('signUpPassword').value = '';
            if (result.needsEmailConfirmation) {
                switchTab(false);
                setStatus('Konto angelegt. Bitte bestätige den Link in der E-Mail und melde dich danach an.');
            } else {
                await refresh();
            }
        } catch (error) {
            setStatus(error.message, 'error');
        }
    });

    $('portalSignOut').addEventListener('click', async () => { await TerminCloud.signOut(); currentView = 'vehicle'; goTo('vehicle'); await refresh(); });
    $('portalRecheck').addEventListener('click', refresh);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && profile?.active) { loadFleet(); loadJobs().then(renderHome); } });
    window.setInterval(() => { if (!document.hidden && profile?.active) loadJobs().then(renderHome); }, 45000);

    // ---------- Als App installieren ----------
    // Android/Chrome bietet die Installation direkt an; auf dem iPhone geht es über „Teilen“.
    (function setupInstall() {
        const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
        if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
            navigator.serviceWorker.register('sw.js').catch(() => { /* Ohne Service Worker läuft das Portal normal im Browser. */ });
        }
        if (standalone) return;
        const card = $('installCard');
        const steps = $('installSteps');
        const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
        const lines = isIos
            ? ['Öffne diese Seite in Safari.', 'Tippe unten auf das Teilen-Symbol (Quadrat mit Pfeil).', 'Wähle „Zum Home-Bildschirm“ und dann „Hinzufügen“.']
            : ['Öffne diese Seite in Chrome.', 'Tippe oben rechts auf die drei Punkte.', 'Wähle „App installieren“ oder „Zum Startbildschirm hinzufügen“.'];
        steps.replaceChildren(...lines.map(text => { const item = document.createElement('li'); item.textContent = text; return item; }));
        card.hidden = false;
        let deferred = null;
        window.addEventListener('beforeinstallprompt', event => {
            event.preventDefault();
            deferred = event;
            $('installButton').hidden = false;
        });
        $('installButton').addEventListener('click', async () => {
            if (!deferred) return;
            deferred.prompt();
            await deferred.userChoice.catch(() => null);
            deferred = null;
            $('installButton').hidden = true;
        });
        window.addEventListener('appinstalled', () => { card.hidden = true; });
    })();

    refresh();
})();
