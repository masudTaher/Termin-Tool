// Dolmetscher-Portal (Handy-App).
// Untere Leiste – temporär: Fahrzeug · Aufträge · Unterlagen · Arbeitstage · Abrechnung
//               – fest:     Fahrzeug · Aufträge · Unterlagen · Überstunden · Belege
// Unterlagen (Fotos → PDF) und der Bericht über den Tag stehen in portalDocs.js.
// Übernahme und Rückgabe laufen Schritt für Schritt, damit nichts vergessen wird.
// Ohne übernommenes Fahrzeug gibt es weder Schaden- noch Fehlermeldung.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const config = window.TERMIN_CLOUD_CONFIG || {};
    const FUEL = config.fuelLabels || ['Leer', '1/4', '1/2', '3/4', 'Voll'];
    const WORK_START = config.workStart || '09:00';
    const WORK_END = config.workEnd || '16:00';
    const DEFAULT_USER_LINE = 'Medical Office Bonn · Transport und Dolmetscher';
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
    let messageData = [];
    let readIds = new Set();
    let overtimeData = [];
    let currentView = 'vehicle';
    let previousView = 'vehicle';
    let workedMonth = '';
    let overtimeMonth = '';
    let receiptOrigin = '';
    let fuelCards = [];

    // Anzeige oben: grün = gespeichert oder gesendet (5 Sekunden), rot = Problem (bleibt länger).
    // Ein Tipp auf die rote Anzeige führt zur Stelle des Fehlers (target: Element oder CSS-Auswahl).
    const TOAST_ICONS = {
        success: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.500l2.800 2.800L16.500 9.500"/></svg>',
        error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4 3 19.500h18z"/><path d="M12 10v4.500M12 17h.01"/></svg>',
        info: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>'
    };

    function findProblem(target) {
        if (typeof target === 'string') { try { target = document.querySelector(target); } catch (error) { target = null; } }
        if (target instanceof Element) return target;
        return [...document.querySelectorAll('.field-error:not([hidden]), [aria-invalid="true"]')].find(node => node.getClientRects().length) || null;
    }

    function jumpToProblem(target) {
        const node = findProblem(target);
        if (!node) return false;
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (node.matches('input, select, textarea, button, a[href], [tabindex]')) node.focus({ preventScroll: true });
        node.classList.add('is-flagged');
        window.setTimeout(() => node.classList.remove('is-flagged'), 2600);
        return true;
    }

    function toast(message, kind = 'info', target = null) {
        const item = document.createElement('div');
        item.className = 'toast';
        item.dataset.kind = kind;
        item.insertAdjacentHTML('afterbegin', TOAST_ICONS[kind] || TOAST_ICONS.info);
        const text = document.createElement('span');
        text.textContent = message;
        item.append(text);
        const duration = kind === 'error' ? 10000 : 5000;
        item.style.setProperty('--toast-time', `${duration}ms`);
        const problem = kind === 'error' ? findProblem(target) : null;
        if (problem) {
            item.classList.add('has-target');
            item.setAttribute('role', 'button');
            item.tabIndex = 0;
            const hint = document.createElement('em');
            hint.className = 'toast-jump';
            hint.textContent = 'Zur Stelle';
            item.append(hint);
            const jump = () => { item.remove(); jumpToProblem(target || problem); };
            item.addEventListener('click', jump);
            item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); } });
        } else {
            item.addEventListener('click', () => item.remove());
        }
        const region = $('toastRegion');
        // Immer nur eine Anzeige je Art; sobald etwas geklappt hat, sind ältere Fehlermeldungen überholt.
        region.querySelectorAll(kind === 'error' ? '.toast[data-kind="error"]' : `.toast[data-kind="${kind}"], .toast[data-kind="error"]`).forEach(old => old.remove());
        region.append(item);
        window.setTimeout(() => item.remove(), duration);
    }

    // Beim Wechsel der Seite oder des Schritts verschwinden rote Anzeigen – sie gehörten zur vorigen Stelle.
    function clearErrors() {
        document.querySelectorAll('#toastRegion .toast[data-kind="error"]').forEach(item => item.remove());
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
        $('portalNewPassword').hidden = view !== 'password';
        $('portalApp').hidden = view !== 'app';
        $('portalTabbar').hidden = view !== 'app';
        $('portalHeaderActions').hidden = view !== 'app';
        document.body.classList.toggle('has-tabbar', view === 'app');
    }

    // Kurze Bestätigung mit grünem Haken – danach geht es automatisch weiter.
    function showSuccess(title, text) {
        return new Promise(resolve => {
            $('successTitle').textContent = title;
            $('successText').textContent = text || '';
            $('successOverlay').hidden = false;
            window.setTimeout(() => { $('successOverlay').hidden = true; resolve(); }, 1700);
        });
    }

    const vehicleLabel = vehicle => [vehicle.plate, [vehicle.brand, vehicle.body].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    const vehicleById = id => vehicles.find(vehicle => vehicle.id === id);
    const isoDate = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const formatKm = value => value == null ? 'unbekannt' : `${Number(value).toLocaleString('de-DE')} km`;
    const radioValue = name => document.querySelector(`input[name="${name}"]:checked`)?.value ?? null;
    const cleanText = value => value == null ? 'unbekannt' : value ? 'sauber' : 'nicht sauber';
    const monthLabel = month => { const [year, number] = month.split('-').map(Number); return new Date(year, number - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }); };
    const money = value => Number(value || 0).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    const isFest = () => profile?.employment === 'fest';
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const duration = minutes => { const total = Math.max(0, Math.round(minutes)); const hours = Math.floor(total / 60); const rest = total % 60; return hours ? `${hours} Std${rest ? ` ${rest} Min` : ''}` : `${rest} Min`; };

    function fillStateList(list, rows) {
        list.replaceChildren(...rows.flatMap(([term, value]) => [el('dt', '', term), el('dd', '', value)]));
    }

    function buildSegmented(container, name, entries) {
        container.replaceChildren(...entries.map(([value, text]) => {
            const label = document.createElement('label');
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = name;
            input.value = value;
            input.required = true;
            label.append(input, el('span', '', text));
            return label;
        }));
    }

    function emptyItem(text) { return el('li', 'directory-empty', text); }

    async function refresh() {
        setStatus('');
        if (!client) {
            show('auth');
            setStatus('Keine Verbindung. Prüfe das Internet und lade die Seite neu.', 'error');
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
        $('portalUser').textContent = [profile.full_name || profile.email, isFest() ? 'fest angestellt' : ''].filter(Boolean).join(' · ');
        $('accountInitials').textContent = String(profile.full_name || profile.email || '?').split(/\s+/).map(part => part[0]).slice(0, 2).join('').toLocaleUpperCase('de-DE');
        if (!profile.active) { show('pending'); return; }
        if (profile.must_change_password) { show('password'); return; }
        buildTabbar();
        show('app');
        await loadFleet();
        await Promise.all([loadJobs(), loadReceipts(), loadStatements(), loadMessages(), loadFuelCards(), isFest() ? loadOvertime() : loadWorkdays()]);
        window.PortalDocs?.load();
        if (!isFest()) renderWorked();
        renderAccount();
        renderHome();
        // Direkter Sprung aus einer Mitteilung: portal.html?seite=nachrichten
        const wanted = new URLSearchParams(location.search).get('seite');
        if (wanted === 'nachrichten') { history.replaceState(null, '', location.pathname); goTo('messages'); }
        else goTo(TAB_OF[currentView] ? currentView : 'vehicle');
    }

    // ---------- Bereiche ----------
    const ICONS = {
        vehicle: '<path d="M5 16.5V12l1.8-5a2 2 0 0 1 1.9-1.3h6.6A2 2 0 0 1 17.2 7L19 12v4.5"/><path d="M4 12h16"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/><path d="M9.3 16.5h5.4"/>',
        jobs: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5V3.5h6v1"/><path d="M8.5 12.5l2.3 2.3 4.7-4.8"/>',
        workdays: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
        overtime: '<circle cx="12" cy="12.5" r="8"/><path d="M12 8v4.5l3 2M9.5 2.5h5"/>',
        statement: '<path d="M17.5 6.5a6.5 6.5 0 1 0 0 11"/><path d="M4 10.5h9M4 13.5h9"/>',
        receiptsHome: '<path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2z"/><path d="M9 8.5h6M9 12.5h6"/>',
        docs: '<path d="M7.500 3.500H14l4.500 4.500V19a1.500 1.500 0 0 1-1.500 1.500H7.500A1.500 1.500 0 0 1 6 19V5a1.500 1.500 0 0 1 1.500-1.500z"/><path d="M14 3.500V8h4.500"/><path d="M9 12.500h6M9 16h4"/>'
    };
    const TABS_TEMP = [['vehicle', 'Fahrzeug'], ['jobs', 'Aufträge'], ['docs', 'Unterlagen'], ['workdays', 'Arbeitstage'], ['statement', 'Abrechnung']];
    const TABS_FEST = [['vehicle', 'Fahrzeug'], ['jobs', 'Aufträge'], ['docs', 'Unterlagen'], ['overtime', 'Überstunden'], ['receiptsHome', 'Belege']];
    // Unterseiten gehören zu einem Bereich der unteren Leiste.
    const TAB_OF = { vehicle: 'vehicle', take: 'vehicle', damage: 'vehicle', alert: 'vehicle', return: 'vehicle', jobs: 'jobs',
        docs: 'docs', docNew: 'docs', docReport: 'docs',
        workdays: 'workdays', overtime: 'overtime', statement: 'statement', receiptsHome: 'receiptsHome', receipts: 'receipts', messages: 'messages', account: 'account' };
    const NEEDS_VEHICLE = ['damage', 'alert', 'return'];

    function buildTabbar() {
        const tabs = isFest() ? TABS_FEST : TABS_TEMP;
        $('portalTabbar').replaceChildren(...tabs.map(([view, text]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.view = view;
            button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[view]}</svg>`;
            button.append(el('span', '', text));
            const badge = el('em', 'tab-badge');
            badge.hidden = true;
            badge.id = `${view}Badge`;
            button.append(badge);
            button.addEventListener('click', () => goTo(view));
            return button;
        }));
    }

    function setBadge(view, value) {
        const badge = $(`${view}Badge`);
        if (!badge) return;
        badge.hidden = !value;
        badge.textContent = value ? String(value) : '';
    }

    function goTo(view) {
        const tabs = (isFest() ? TABS_FEST : TABS_TEMP).map(([name]) => name);
        if (!TAB_OF[view]) view = 'vehicle';
        // Bereiche der anderen Anstellungsart gibt es nicht.
        if (['workdays', 'overtime', 'statement', 'receiptsHome'].includes(view) && !tabs.includes(view)) view = 'vehicle';
        if (NEEDS_VEHICLE.includes(view) && !myHandover) { toast('Übernimm zuerst ein Fahrzeug.', 'info'); view = 'vehicle'; }
        if (view === 'take' && myHandover) view = 'vehicle';
        clearErrors();
        if (!['messages', 'account', 'receipts'].includes(view)) previousView = view;
        // Der Beleg (Parkticket) lässt sich auch aus „Unterlagen“ öffnen – „Zurück“ führt dann dorthin.
        if (view === 'receipts') receiptOrigin = currentView === 'docs' ? 'docs' : '';
        currentView = view;
        const activeTab = view === 'receipts' ? (receiptOrigin || (isFest() ? 'receiptsHome' : 'statement')) : TAB_OF[view];
        document.querySelectorAll('#portalTabbar button').forEach(button => {
            const active = button.dataset.view === activeTab;
            button.classList.toggle('is-active', active);
            if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
        });
        document.querySelectorAll('#portalApp > [data-panel]').forEach(panel => { panel.hidden = !panel.dataset.panel.split(' ').includes(view); });
        window.scrollTo({ top: 0 });
        if (view === 'vehicle') renderHome();
        if (view === 'take') startTake();
        if (view === 'return') startReturn();
        if (view === 'damage') loadDamages();
        if (view === 'alert') loadAlerts();
        if (view === 'workdays') renderWorked();
        if (view === 'overtime') prepareOvertimeForm();
        if (view === 'messages') openMessages();
        if (view === 'account') renderAccount();
        if (view === 'docs') window.PortalDocs?.open();
        if (view === 'docNew') window.PortalDocs?.startWizard();
        if (view === 'docReport') window.PortalDocs?.openReport();
    }
    document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => goTo(button.dataset.go)));
    $('openMessages').addEventListener('click', () => goTo('messages'));
    $('openAccount').addEventListener('click', () => goTo('account'));
    $('messagesBack').addEventListener('click', () => goTo(previousView));
    $('accountBack').addEventListener('click', () => goTo(previousView));
    $('receiptBack').addEventListener('click', () => goTo(receiptOrigin || (isFest() ? 'receiptsHome' : 'statement')));

    // ---------- Startseite (Fahrzeug) ----------
    function renderHome() {
        if (!profile?.active) return;
        const today = TerminCloud.todayIso();
        $('helloTitle').textContent = `Hallo ${String(profile.full_name || '').split(' ')[0] || ''}`.trim();
        $('helloDate').textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long' });

        const open = jobsData.filter(item => item.date >= today && !item.cancelled && item.response === 'offen').length;
        const unread = messageData.filter(item => !readIds.has(item.id)).length;
        const notices = [];
        if (unread) notices.push([`${unread} neue ${unread === 1 ? 'Nachricht' : 'Nachrichten'} von der Einsatzleitung`, () => goTo('messages')]);
        if (open) notices.push([`${open} ${open === 1 ? 'Auftrag wartet' : 'Aufträge warten'} auf deine Antwort`, () => goTo('jobs')]);
        const waiting = statementData.find(item => item.response === 'offen');
        if (waiting && !isFest()) notices.push([`Deine Abrechnung für ${monthLabel(waiting.month)} wartet auf deine Bestätigung`, () => goTo('statement')]);
        $('startNotices').replaceChildren(...notices.map(([text, action]) => {
            const item = document.createElement('li');
            const button = el('button', '', text);
            button.type = 'button';
            button.addEventListener('click', action);
            item.append(button);
            return item;
        }));
        setBadge('jobs', open);
        setBadge('statement', waiting ? '!' : '');
        $('messagesBadge').hidden = !unread;
        $('messagesBadge').textContent = unread ? String(unread) : '';
        addPushNotice();
    }

    // Tankkarte: Nur der Admin gibt sie aus und nimmt sie zurück – hier steht, welche Karte gerade bei mir ist.
    async function loadFuelCards() {
        const { data, error } = await client.from('tt_fuel_cards').select('*').eq('holder_id', profile.id).eq('active', true).order('number');
        fuelCards = error ? [] : (data || []);
        renderFuelCards();
    }

    function renderFuelCards() {
        const banner = $('fuelCardBanner');
        banner.hidden = !fuelCards.length;
        if (!fuelCards.length) { banner.replaceChildren(); return; }
        const numbers = fuelCards.map(card => card.number).join(', ');
        const since = fuelCards[0].assigned_at ? new Date(fuelCards[0].assigned_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '';
        const icon = svgSpan('fuel-card-icon', '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12.500" rx="2"/><path d="M3 10h18M7 14.500h4"/></svg>');
        const text = el('span', 'fuel-card-text');
        text.append(el('strong', '', `${fuelCards.length === 1 ? 'Tankkarte' : 'Tankkarten'} ${numbers}`),
            el('small', '', `${fuelCards.length === 1 ? 'ist' : 'sind'} bei dir${since ? ` (seit ${since})` : ''}. Bitte gib sie nach dem Einsatz im Büro zurück.`));
        banner.replaceChildren(icon, text);
    }

    // Einmaliger Hinweis auf der Startseite, solange Mitteilungen möglich, aber noch aus sind.
    async function addPushNotice() {
        if (await TerminCloud.pushState() !== 'off' || $('pushNotice')) return;
        const item = document.createElement('li');
        item.id = 'pushNotice';
        const button = el('button', 'notice-soft', 'Mitteilungen einschalten – dann siehst du Aufträge und Nachrichten sofort');
        button.type = 'button';
        button.addEventListener('click', () => switchPush(true));
        item.append(button);
        $('startNotices').append(item);
    }

    // ---------- Abrechnung ----------
    async function loadStatements() {
        const { data, error } = await client.from('tt_statements').select('*').eq('profile_id', profile.id).order('month', { ascending: false }).limit(24);
        statementData = error ? [] : data;
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

    // ---------- Auftrag als Karte: der gesendete Text wird in klare Felder zerlegt ----------
    function splitPhoneNumbers(value) {
        const digits = text => (String(text).match(/\d/g) || []).length;
        const numbers = [];
        String(value || '').split(/\s*(?:[;|\n\r]+|,\s|\s+oder\s+|\s+und\s+)\s*/iu).forEach(chunk => {
            const tokens = chunk.trim().split(/\s+/).filter(Boolean);
            let current = '';
            let slashPending = false;
            const flush = () => { if (current) numbers.push(current); current = ''; };
            tokens.forEach((token, index) => {
                token.split('/').forEach((part, partIndex) => {
                    if (partIndex > 0) slashPending = true;
                    if (!part) return;
                    let joiner = ' ';
                    if (slashPending) {
                        if (digits(current) >= 7) flush(); else joiner = '/';
                        slashPending = false;
                    } else if (partIndex === 0 && digits(current) >= 7
                        && (/^(?:\+|00)\d/.test(part) || (/^0\d/.test(part) && digits(current) >= 10 && digits(tokens.slice(index).join('')) >= 8))) {
                        flush();
                    }
                    current = current ? `${current}${joiner}${part}` : part;
                });
            });
            flush();
        });
        const seen = new Set();
        return numbers.map(number => number.replace(/[,;.\s]+$/g, '').trim()).filter(number => {
            const key = number.replace(/\D/g, '') || number.toLocaleLowerCase('de-DE');
            if (!number || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }

    const JOB_SKIP = [/^guten tag,?$/i, /^bitte übernimm den folgenden dolmetschauftrag:?$/i, /^bitte bestätige kurz den erhalt/i];
    function parseJobMessage(text) {
        const lines = String(text || '').split(/\r?\n/).map(line => line.trim());
        if (!/^\*?DOLMETSCHAUFTRAG\*?$/i.test(lines[0] || '')) return null;
        const facts = {}; const notices = []; const sections = []; let cost = ''; let section = null;
        lines.slice(1).forEach(line => {
            if (!line || JOB_SKIP.some(pattern => pattern.test(line))) return;
            const starred = line.match(/^\*(.+)\*$/);
            const inner = starred ? starred[1].trim() : line;
            if (starred && !inner.includes(':') && inner === inner.toLocaleUpperCase('de-DE')) { section = { title: inner, fields: [] }; sections.push(section); return; }
            const pair = inner.match(/^([A-Za-zÄÖÜäöüß][^:]{1,40}):\s+(.+)$/);
            if (section) { section.fields.push(pair ? [pair[1].trim(), pair[2].trim()] : ['', inner]); return; }
            if (/^(kostenstatus|kostenübernahme|bitte kostenstatus)/i.test(inner)) { cost = inner; return; }
            if (starred && pair) facts[pair[1].trim()] = pair[2].trim();
            else notices.push(inner.replace(/^Hinweis:\s*/i, ''));
        });
        return { facts, notices, sections, cost };
    }

    const JOB_ICONS = {
        phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h4l2 5-2.500 1.500a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
        pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s7-6.200 7-11.500A7 7 0 0 0 5 9.500C5 14.800 12 21 12 21z"/><circle cx="12" cy="9.500" r="2.500"/></svg>',
        person: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
        clinic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V6l8-3 8 3v15"/><path d="M9 21v-5h6v5"/><path d="M12 7v5M9.500 9.500h5"/></svg>',
        note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h5"/></svg>',
        camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.500A1.500 1.500 0 0 1 5.500 7H8l1.500-2.500h5L16 7h2.500A1.500 1.500 0 0 1 20 8.500V18a1.500 1.500 0 0 1-1.500 1.500h-13A1.500 1.500 0 0 1 4 18z"/><circle cx="12" cy="13" r="3.500"/></svg>'
    };
    const svgSpan = (className, markup) => { const node = el('span', className); node.innerHTML = markup; return node; };

    function jobField(label, value) {
        const row = el('div', 'job-field');
        if (label) row.append(el('span', 'job-field-label', label));
        if (/^telefon/i.test(label)) {
            const numbers = el('span', 'job-phones');
            splitPhoneNumbers(value).forEach(number => {
                const link = el('a', 'job-phone');
                const dial = number.replace(/[^\d+]/g, '');
                if (dial.length >= 5) link.href = `tel:${dial}`;
                link.append(svgSpan('job-phone-icon', JOB_ICONS.phone), el('span', '', number));
                numbers.append(link);
            });
            row.append(numbers);
        } else if (/adresse/i.test(label)) {
            const wrap = el('span', 'job-address');
            wrap.append(el('span', 'job-field-value', value));
            const map = el('a', 'job-map', 'In Karten öffnen');
            map.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(value)}`;
            map.target = '_blank';
            map.rel = 'noopener';
            wrap.append(map);
            row.append(wrap);
        } else {
            row.append(el('span', 'job-field-value', value));
        }
        return row;
    }

    function jobBody(item) {
        const body = el('div', 'job-body');
        const parsed = parseJobMessage(item.message);
        if (!parsed) { body.append(el('p', 'job-message', item.message || '')); return body; }
        const { facts, notices, sections, cost } = parsed;
        const patient = facts['Patient/in'] || facts['Hauptpatient/in'];
        if (patient) {
            const block = el('div', 'job-section job-section-patient');
            block.append(svgSpan('job-section-icon', JOB_ICONS.person));
            const content = el('div', 'job-section-content');
            content.append(el('span', 'job-section-title', facts['Hauptpatient/in'] ? 'Hauptpatient/in' : 'Patient/in'), el('strong', 'job-patient', patient));
            if (facts['Aktennummer']) content.append(el('span', 'job-chip', `Aktennummer ${facts['Aktennummer']}`));
            if (facts['Termin für Begleitperson']) content.append(jobField('Termin für Begleitperson', facts['Termin für Begleitperson']));
            const contact = sections.find(section => /PATIENTENKONTAKT/.test(section.title));
            contact?.fields.forEach(([label, value]) => content.append(jobField(label, value)));
            block.append(content);
            body.append(block);
        }
        const doctor = sections.find(section => /ARZT/.test(section.title));
        if (doctor?.fields.length) {
            const block = el('div', 'job-section');
            block.append(svgSpan('job-section-icon', JOB_ICONS.clinic));
            const content = el('div', 'job-section-content');
            content.append(el('span', 'job-section-title', 'Arzt / Praxis'));
            doctor.fields.forEach(([label, value]) => content.append(label === 'Name' ? el('strong', 'job-doctor', value) : jobField(label, value)));
            block.append(content);
            body.append(block);
        }
        if (cost) body.append(el('p', 'job-cost', cost));
        const extra = [...notices, ...sections.filter(section => /HINWEISE/.test(section.title)).flatMap(section => section.fields.map(([label, value]) => label ? `${label}: ${value}` : value))];
        if (extra.length) {
            const block = el('div', 'job-section');
            block.append(svgSpan('job-section-icon', JOB_ICONS.note));
            const content = el('div', 'job-section-content');
            content.append(el('span', 'job-section-title', 'Hinweise'));
            const notes = el('ul', 'job-notes');
            extra.forEach(text => notes.append(el('li', '', text)));
            content.append(notes);
            block.append(content);
            body.append(block);
        }
        const enteredBy = sections.find(section => /EINGETRAGEN/.test(section.title))?.fields.map(([, value]) => value).join(', ');
        if (enteredBy) body.append(el('p', 'job-entered', `Eingetragen durch ${enteredBy}`));
        return body;
    }

    function jobCard(item) {
        const card = el('li', 'job-card');
        card.dataset.response = item.response;
        const date = new Date(`${item.date}T00:00:00`);
        const parsed = parseJobMessage(item.message);
        const titleParts = String(item.title || '').split(' · ');
        const time = String(item.time || '').slice(0, 5);
        const place = parsed?.sections.find(section => /ARZT/.test(section.title))?.fields.find(([label]) => label === 'Name')?.[1]
            || titleParts.filter(part => !/^\d{1,2}:\d{2}\s*Uhr$/.test(part))[0] || 'Auftrag';
        const city = parsed?.facts['Ort'] || titleParts.filter(part => !/^\d{1,2}:\d{2}\s*Uhr$/.test(part)).slice(1).join(' · ');

        const top = el('div', 'job-top');
        const day = el('div', 'job-date');
        day.append(
            el('span', 'job-date-weekday', date.toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')),
            el('strong', '', String(date.getDate()).padStart(2, '0')),
            el('span', 'job-date-month', date.toLocaleDateString('de-DE', { month: 'short' }).replace('.', ''))
        );
        const main = el('div', 'job-main');
        if (time) main.append(el('span', 'job-time', `${time} Uhr`));
        main.append(el('strong', 'job-place', place));
        if (city) { const cityLine = el('span', 'job-city'); cityLine.append(svgSpan('job-city-icon', JOB_ICONS.pin), el('span', '', city)); main.append(cityLine); }
        const state = el('span', 'status-pill', RESPONSE_LABEL[item.response]);
        state.dataset.status = { offen: 'in Arbeit', zugesagt: 'erledigt', vorbehalt: 'bekannt', abgesagt: 'offen' }[item.response];
        top.append(day, main, state);

        // Offene Aufträge sind aufgeklappt; beantwortete lassen sich mit einem Tipp wieder öffnen.
        const details = document.createElement('details');
        details.className = 'job-details';
        details.open = item.response === 'offen';
        details.append(el('summary', '', 'Alle Angaben zum Auftrag'), jobBody(item));

        const answer = el('div', 'job-answer');
        answer.append(el('span', 'job-answer-title', item.response === 'offen' ? 'Deine Antwort' : 'Antwort ändern'));
        const note = document.createElement('input');
        note.type = 'text';
        note.maxLength = 300;
        note.placeholder = 'Hinweis an die Einsatzleitung (optional)';
        note.value = item.response_note || '';
        note.setAttribute('aria-label', 'Hinweis zur Antwort');
        const buttons = el('div', 'job-buttons');
        RESPONSES.forEach(([value, text]) => {
            const button = el('button', 'workday-button', text);
            button.type = 'button';
            button.dataset.response = value;
            button.setAttribute('aria-pressed', String(item.response === value));
            button.addEventListener('click', async () => {
                const { error: rpcError } = await client.rpc('tt_respond_assignment', { p_id: item.id, p_response: value, p_note: note.value.trim() });
                if (rpcError) { toast(TerminCloud.germanError(rpcError), 'error'); return; }
                toast(`${text} gesendet`, 'success');
                await loadJobs();
            });
            buttons.append(button);
        });
        answer.append(note, buttons);
        card.append(top, details, answer);
        // Ab dem Tag des Termins: Arztbericht, Rezept oder Überweisung direkt zu diesem Auftrag fotografieren.
        if (item.date <= TerminCloud.todayIso() && item.response !== 'abgesagt') {
            const docs = el('button', 'job-docs-button');
            docs.type = 'button';
            docs.append(svgSpan('job-docs-icon', JOB_ICONS.camera), el('span', '', 'Unterlagen fotografieren'));
            docs.addEventListener('click', () => window.PortalDocs?.startFor(item));
            card.append(docs);
        }
        return card;
    }

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
        setBadge('jobs', open);

        // Hinweis, wenn seit dem letzten Laden ein neuer Auftrag dazugekommen ist.
        const ids = new Set(upcoming.map(item => item.id));
        if (knownJobIds && [...ids].some(id => !knownJobIds.has(id))) toast('Du hast einen neuen Auftrag.', 'success');
        knownJobIds = ids;

        const list = $('jobList');
        list.replaceChildren();
        upcoming.forEach(item => list.append(jobCard(item)));

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
        myHandover = openHandovers.find(item => item.driver_id === profile.id) || null;
        const myVehicle = myHandover ? vehicleById(myHandover.vehicle_id) : null;
        const fixedVehicle = vehicles.find(vehicle => vehicle.assigned_to === profile.id) || null;
        const free = freeVehicles();

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
            loadHeroDamages();
        } else {
            $('myVehicleInfo').textContent = !vehicles.length ? 'Es sind noch keine Fahrzeuge angelegt.'
                : !free.length ? 'Im Moment ist kein Fahrzeug frei.'
                : fixedVehicle && free.includes(fixedVehicle) ? `Dein festes Fahrzeug ${fixedVehicle.plate} ist frei.`
                : `${free.length} ${free.length === 1 ? 'Fahrzeug ist' : 'Fahrzeuge sind'} frei.`;
            $('startTake').disabled = !free.length;
        }

        // Ab 16 Uhr erinnern, wenn das Auto noch nicht zurückgegeben ist (außer im Notdienst).
        const overdue = myHandover && !myHandover.emergency && (new Date().getHours() >= 16 || myHandover.date < TerminCloud.todayIso());
        $('returnReminder').hidden = !overdue;
        $('returnReminder').textContent = overdue ? 'Bitte gib dein Fahrzeug zurück, wenn du fertig bist.' : '';
        loadReturnNotes();
        // Unterseiten für Schaden, Meldung und Rückgabe gibt es nur mit Fahrzeug.
        if (NEEDS_VEHICLE.includes(currentView) && !myHandover) goTo('vehicle');
    }

    function freeVehicles() {
        const taken = new Set(openHandovers.map(item => item.vehicle_id));
        // Das eigene feste Fahrzeug steht oben, danach diplomatische Fahrzeuge, dann Mietwagen.
        const rank = vehicle => vehicle.assigned_to === profile.id ? 0 : vehicle.type === 'Diplomatisch' ? 1 : vehicle.type === 'Mietwagen' ? 2 : 3;
        // Fest reservierte Fahrzeuge sieht nur die Person, für die sie reserviert sind.
        const mine = vehicle => !vehicle.assigned_to || vehicle.assigned_to === profile.id;
        return vehicles.filter(vehicle => !taken.has(vehicle.id) && mine(vehicle)).sort((left, right) => rank(left) - rank(right) || String(left.plate).localeCompare(String(right.plate), 'de'));
    }

    function damageEntry(item, index) {
        const entry = el('li', 'directory-entry damage-entry');
        const state = el('span', 'status-pill', CarSketch.STATUS_LABELS[item.status] || item.status);
        state.dataset.status = item.status;
        const what = [item.category, item.description].filter((text, position, list) => text && list.indexOf(text) === position).join(' – ');
        entry.append(el('span', 'directory-entry-name', `${index + 1} · ${item.zone || 'ohne Position'} · ${what}`), state);
        return entry;
    }

    async function currentDamages(vehicleId) {
        const { data, error } = await client.from('tt_damages').select('*').eq('vehicle_id', vehicleId).order('created_at');
        if (error) throw error;
        return data.filter(item => item.status !== 'erledigt');
    }

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
            const entry = el('li', 'directory-entry damage-entry');
            entry.append(el('span', 'directory-entry-name', `Hinweis zu deiner Rückgabe (${vehicleById(item.vehicle_id)?.plate || 'Fahrzeug'}, ${new Date(item.created_at).toLocaleDateString('de-DE')}): „${item.start_note}“ – ${item.driver_name}`));
            list.append(entry);
        });
    }

    // Schritt-für-Schritt-Ablauf: zeigt immer genau einen Schritt und den Fortschritt.
    function makeWizard(name, total, onLeave) {
        let step = 1;
        const show = number => {
            if (number !== step) clearErrors();
            step = number;
            document.querySelectorAll(`[data-${name}-step]`).forEach(node => { node.hidden = Number(node.dataset[`${name}Step`]) !== number; });
            $(`${name}Count`).textContent = `Schritt ${number} von ${total}`;
            $(`${name}Progress`).style.width = `${Math.round(number / total * 100)}%`;
            window.scrollTo({ top: 0 });
        };
        $(`${name}Back`).addEventListener('click', () => { if (step > 1) show(step - 1); else onLeave(); });
        return { show, get step() { return step; } };
    }

    // ---------- Übernahme: 1 Auto wählen · 2 Zustand prüfen · 3 Kilometer ----------
    const take = { vehicle: null };
    const takeWizard = makeWizard('take', 3, () => goTo('vehicle'));

    function startTake() {
        take.vehicle = null;
        $('takeVehicleForm').reset();
        $('takeStartNote').value = '';
        $('takeNoteRow').hidden = true;
        $('takeMileageError').hidden = true;
        $('takeEmergencyRow').hidden = !isFest();
        const free = freeVehicles();
        const list = $('takeCars');
        list.replaceChildren();
        if (!free.length) list.append(el('p', 'directory-empty', vehicles.length ? 'Gerade ist kein Fahrzeug frei.' : 'Es sind noch keine Fahrzeuge angelegt.'));
        free.forEach(vehicle => {
            const card = el('button', 'car-card');
            card.type = 'button';
            card.dataset.vehicle = vehicle.id;
            const main = el('span', 'car-card-main');
            main.append(el('strong', '', vehicle.plate), el('span', '', [vehicle.brand, vehicle.body].filter(Boolean).join(' · ') || 'Fahrzeug'));
            const chips = el('span', 'car-card-chips');
            if (vehicle.assigned_to === profile.id) chips.append(el('em', 'chip chip-brand', 'Dein festes Fahrzeug'));
            if (vehicle.type) chips.append(el('em', 'chip', vehicle.type === 'Diplomatisch' ? 'Diplomatisch' : vehicle.type));
            if (vehicle.fuel != null) chips.append(el('em', 'chip', `Tank ${FUEL[vehicle.fuel]}`));
            if (vehicle.parking) chips.append(el('em', 'chip', `Steht: ${vehicle.parking}`));
            card.append(main, chips, el('span', 'car-card-arrow', '›'));
            card.addEventListener('click', () => chooseTakeVehicle(vehicle));
            list.append(card);
        });
        takeWizard.show(1);
    }

    async function chooseTakeVehicle(vehicle) {
        take.vehicle = vehicle;
        $('takeCarLabel').textContent = vehicleLabel(vehicle);
        fillStateList($('takeStateList'), [
            ['Letzter Fahrer', vehicle.state_updated_at ? `${vehicle.state_updated_by || 'unbekannt'}, ${new Date(vehicle.state_updated_at).toLocaleDateString('de-DE')}` : 'noch keine Angaben'],
            ['Kilometer', formatKm(vehicle.mileage)],
            ['Tank', vehicle.fuel == null ? 'unbekannt' : FUEL[vehicle.fuel]],
            ['Parkort', vehicle.parking || 'unbekannt'],
            ['Innen', cleanText(vehicle.clean_inside)],
            ['Außen', cleanText(vehicle.clean_outside)]
        ]);
        $('takeNoteRow').hidden = true;
        $('takeDamagesSummary').textContent = 'Bekannte Schäden werden geladen …';
        $('takeSketchWrap').hidden = true;
        $('takeDamageList').replaceChildren();
        $('takeMileageHint').textContent = vehicle.mileage != null ? `Lies den Stand vom Tacho ab. Letzter Stand: ${formatKm(vehicle.mileage)}` : 'Lies den Stand vom Tacho ab.';
        takeWizard.show(2);
        try {
            const current = await currentDamages(vehicle.id);
            if (take.vehicle !== vehicle) return;
            $('takeDamagesSummary').textContent = current.length ? `${current.length} ${current.length === 1 ? 'bekannter Schaden' : 'bekannte Schäden'}` : 'Keine Schäden eingetragen';
            $('takeSketchWrap').hidden = !current.length;
            if (current.length) {
                if (!takeSketch) takeSketch = CarSketch.create($('takeSketch'), {});
                takeSketch.setMarkers(current.map((item, index) => ({ id: item.id, x: item.pos_x, y: item.pos_y, status: item.status, label: item.description, number: index + 1 })));
            }
            $('takeDamageList').replaceChildren(...current.map(damageEntry));
        } catch (error) {
            $('takeDamagesSummary').textContent = 'Schäden konnten nicht geladen werden';
        }
    }

    $('takeAllFine').addEventListener('click', () => { $('takeStartNote').value = ''; takeWizard.show(3); $('takeVehicleMileage').focus(); });
    $('takeNotFine').addEventListener('click', () => { $('takeNoteRow').hidden = false; $('takeStartNote').focus(); });
    $('takeNoteNext').addEventListener('click', () => {
        if (!$('takeStartNote').value.trim()) { toast('Bitte schreib kurz, was nicht stimmt.', 'error', '#takeStartNote'); $('takeStartNote').focus(); return; }
        takeWizard.show(3);
        $('takeVehicleMileage').focus();
    });

    // Prüft den Kilometerstand sofort – so entsteht kein falscher Eintrag.
    function mileageProblem(value, last) {
        if (value === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return 'Bitte trag den Kilometerstand ein.';
        if (!Number.isInteger(Number(value))) return 'Bitte nur ganze Kilometer eintragen.';
        if (last != null && Number(value) < Number(last)) return `Das ist weniger als der letzte Stand (${formatKm(last)}). Bitte prüfe die Zahl.`;
        if (last != null && Number(value) - Number(last) > 3000) return `Das wären ${(Number(value) - Number(last)).toLocaleString('de-DE')} km mehr als der letzte Stand. Bitte prüfe die Zahl.`;
        return '';
    }

    $('takeVehicleForm').addEventListener('submit', async event => {
        event.preventDefault();
        if (!take.vehicle) { takeWizard.show(1); return; }
        const problem = mileageProblem($('takeVehicleMileage').value, take.vehicle.mileage);
        $('takeMileageError').hidden = !problem;
        $('takeMileageError').textContent = problem;
        if (problem) { $('takeVehicleMileage').focus(); return; }
        const button = event.target.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            const { error } = await client.rpc('tt_take_vehicle', {
                p_vehicle: take.vehicle.id, p_mileage: Number($('takeVehicleMileage').value), p_note: 'Im Portal übernommen',
                p_emergency: isFest() && $('takeEmergency').checked, p_start_note: $('takeStartNote').value.trim()
            });
            if (error) {
                $('takeMileageError').hidden = false;
                $('takeMileageError').textContent = TerminCloud.germanError(error);
                return;
            }
            const plate = take.vehicle.plate;
            await loadFleet();
            await showSuccess(`${plate} übernommen`, 'Gute Fahrt!');
            goTo('vehicle');
        } finally {
            button.disabled = false;
        }
    });

    // ---------- Rückgabe: 1 Kilometer · 2 Tank · 3 Parkort · 4 Sauberkeit · 5 Prüfen ----------
    const back = { mileage: null, fuel: null, parking: '', inside: null, outside: null };
    const returnWizard = makeWizard('return', 5, () => goTo('vehicle'));

    function choiceButtons(container, entries, onPick) {
        container.replaceChildren(...entries.map(([value, text, extra]) => {
            const button = el('button', 'choice-button');
            button.type = 'button';
            button.dataset.value = String(value);
            button.append(el('span', '', text));
            if (extra) button.append(extra);
            button.addEventListener('click', () => {
                container.querySelectorAll('.choice-button').forEach(other => other.classList.toggle('is-picked', other === button));
                onPick(value);
            });
            return button;
        }));
    }

    function startReturn() {
        Object.assign(back, { mileage: null, fuel: null, parking: '', inside: null, outside: null });
        const myVehicle = myHandover ? vehicleById(myHandover.vehicle_id) : null;
        $('returnMileageForm').reset();
        $('returnMileageError').hidden = true;
        $('returnMileageHint').textContent = `${myVehicle ? vehicleLabel(myVehicle) : 'Dein Fahrzeug'}${myVehicle?.mileage != null ? ` · letzter Stand: ${formatKm(myVehicle.mileage)}` : ''}`;
        choiceButtons($('returnFuel'), FUEL.map((text, index) => {
            const gauge = el('i', 'fuel-gauge');
            gauge.style.setProperty('--level', `${index * 25}%`);
            return [index, text, gauge];
        }), value => { back.fuel = value; returnWizard.show(3); });
        choiceButtons($('returnParking'), (config.parkingOptions || []).map(option => [option, option]), value => { back.parking = value; returnWizard.show(4); });
        document.querySelectorAll('[data-clean] .choice-button').forEach(button => button.classList.remove('is-picked'));
        $('returnCleanNext').disabled = true;
        returnWizard.show(1);
    }

    $('returnMileageForm').addEventListener('submit', event => {
        event.preventDefault();
        const myVehicle = myHandover ? vehicleById(myHandover.vehicle_id) : null;
        const problem = mileageProblem($('returnVehicleMileage').value, myVehicle?.mileage);
        $('returnMileageError').hidden = !problem;
        $('returnMileageError').textContent = problem;
        if (problem) { $('returnVehicleMileage').focus(); return; }
        back.mileage = Number($('returnVehicleMileage').value);
        returnWizard.show(2);
    });

    document.querySelectorAll('[data-clean]').forEach(row => {
        row.querySelectorAll('.choice-button').forEach(button => button.addEventListener('click', () => {
            row.querySelectorAll('.choice-button').forEach(other => other.classList.toggle('is-picked', other === button));
            back[row.dataset.clean] = button.dataset.value === 'yes';
            $('returnCleanNext').disabled = back.inside == null || back.outside == null;
        }));
    });
    $('returnCleanNext').addEventListener('click', () => {
        const myVehicle = myHandover ? vehicleById(myHandover.vehicle_id) : null;
        const driven = myHandover?.start_mileage != null ? back.mileage - myHandover.start_mileage : null;
        fillStateList($('returnSummary'), [
            ['Fahrzeug', myVehicle ? vehicleLabel(myVehicle) : 'Fahrzeug'],
            ['Kilometer', `${formatKm(back.mileage)}${driven != null && driven >= 0 ? ` (${driven.toLocaleString('de-DE')} km gefahren)` : ''}`],
            ['Tank', FUEL[back.fuel]],
            ['Parkort', back.parking],
            ['Innen', cleanText(back.inside)],
            ['Außen', cleanText(back.outside)]
        ]);
        returnWizard.show(5);
    });

    $('returnSubmit').addEventListener('click', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            const { error } = await client.rpc('tt_return_vehicle', {
                p_mileage: back.mileage, p_fuel: back.fuel, p_parking: back.parking,
                p_clean_inside: back.inside, p_clean_outside: back.outside
            });
            if (error) {
                toast(TerminCloud.germanError(error), 'error');
                if (/kilometer/i.test(error.message || '')) returnWizard.show(1);
                return;
            }
            const plate = myHandover ? vehicleById(myHandover.vehicle_id)?.plate : '';
            await loadFleet();
            await showSuccess(`${plate || 'Fahrzeug'} zurückgegeben`, 'Danke!');
            goTo('vehicle');
        } finally {
            button.disabled = false;
        }
    });

    // ---------- Schäden (nur für das übernommene Fahrzeug) ----------
    const NO_POSITION = 'Noch keine Stelle gewählt.';
    buildSegmented($('damageKinds'), 'damageKind', (config.damageKinds || ['Sonstiges']).map(kind => [kind, kind]));
    async function loadDamages() {
        if (!sketch) {
            sketch = CarSketch.create($('damageSketch'), {
                onPick: position => {
                    damagePosition = position;
                    $('damagePosition').textContent = `Gewählt: ${CarSketch.zoneLabel(position.x, position.y)}`;
                    $('damagePosition').dataset.kind = 'ok';
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
        if (!current.length) { list.append(emptyItem('Für dieses Fahrzeug ist noch kein Schaden eingetragen.')); return; }
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
        const category = radioValue('damageKind');
        const files = [...($('damagePhoto').files || [])].slice(0, 3);
        if (!myHandover) { goTo('vehicle'); return; }
        if (!damagePosition) {
            toast('Bitte tippe zuerst in der Skizze auf die Stelle des Schadens.', 'error', '#damageSketch');
            $('damageSketch').scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
        }
        if (!category) { toast('Bitte wähle aus, was für ein Schaden es ist.', 'error', '#damageKinds'); return; }
        if (!files.length) { toast('Bitte mach ein Foto vom Schaden. Ohne Foto kann der Schaden nicht gemeldet werden.', 'error', '#damagePhoto'); return; }
        button.disabled = true;
        try {
            const paths = [];
            for (const file of files) paths.push(await TerminCloud.uploadPhoto(file, profile.id));
            const { error } = await client.from('tt_damages').insert({
                vehicle_id: myHandover.vehicle_id, reporter_id: profile.id, reporter_name: profile.full_name || profile.email,
                category, description: description || category, pos_x: damagePosition.x, pos_y: damagePosition.y,
                zone: CarSketch.zoneLabel(damagePosition.x, damagePosition.y),
                photo_path: paths[0] || '', photo_paths: paths
            });
            if (error) throw error;
            $('damageDescription').value = '';
            $('damagePhoto').value = '';
            document.querySelectorAll('input[name="damageKind"]').forEach(input => { input.checked = false; });
            damagePosition = null;
            sketch.setPicked(null);
            $('damagePosition').textContent = NO_POSITION;
            delete $('damagePosition').dataset.kind;
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
            const entry = el('li', 'directory-entry');
            const state = el('span', 'status-pill', 'bereits gemeldet');
            state.dataset.status = 'bekannt';
            entry.append(el('span', 'directory-entry-name', `${item.kind}${item.note ? ` – ${item.note}` : ''} · ${new Date(item.created_at).toLocaleDateString('de-DE')}`), state);
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

    // ---------- Belege (mit automatischem Auslesen des Fotos) ----------
    async function loadReceipts() {
        if (!$('receiptDate').value) $('receiptDate').value = TerminCloud.todayIso();
        $('receiptDate').max = TerminCloud.todayIso();
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
            ? `Diesen Monat: ${current.length} ${current.length === 1 ? 'Beleg' : 'Belege'}, zusammen ${money(sum)}`
            : 'Beleg fotografieren – Betrag und Datum werden automatisch gelesen.';
        data.forEach(item => {
            const entry = el('li', 'directory-entry damage-entry');
            const side = el('span', 'vehicle-entry-actions');
            const state = el('span', 'status-pill', item.status);
            state.dataset.status = { eingereicht: 'in Arbeit', 'geprüft': 'erledigt', abgelehnt: 'offen' }[item.status];
            side.append(state);
            if (item.status === 'eingereicht') {
                const remove = el('button', 'button-quiet-danger', 'Löschen');
                remove.type = 'button';
                remove.addEventListener('click', async () => {
                    const { error: deleteError } = await client.from('tt_receipts').delete().eq('id', item.id);
                    if (deleteError) { toast(TerminCloud.germanError(deleteError), 'error'); return; }
                    await loadReceipts();
                });
                side.append(remove);
            }
            entry.append(el('span', 'directory-entry-name', `${new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE')} · ${item.place} · ${money(item.amount)}`), side);
            list.append(entry);
        });
    }

    // Sobald ein Foto gewählt ist, liest das Handy Betrag, Datum und Ort selbst aus.
    let scanToken = 0;
    $('receiptPhoto').addEventListener('change', async () => {
        const file = $('receiptPhoto').files?.[0];
        const status = $('receiptScan');
        const token = ++scanToken;
        if (!file) { status.hidden = true; return; }
        if (typeof ReceiptReader === 'undefined') return;
        status.hidden = false;
        status.dataset.kind = 'busy';
        status.textContent = 'Beleg wird gelesen …';
        try {
            const found = await ReceiptReader.read(file, progress => {
                if (token === scanToken) status.textContent = `Beleg wird gelesen … ${Math.round(progress * 100)} %`;
            });
            if (token !== scanToken) return;
            const filled = [];
            if (found.amount) { $('receiptAmount').value = found.amount.toFixed(2); filled.push('Betrag'); }
            if (found.date) { $('receiptDate').value = found.date; filled.push('Datum'); }
            if (found.place && !$('receiptPlace').value) { $('receiptPlace').value = found.place; filled.push('Ort'); }
            if (found.note && !$('receiptNote').value) $('receiptNote').value = found.note;
            if (found.kind) { const radio = document.querySelector(`input[name="receiptKind"][value="${found.kind}"]`); if (radio) radio.checked = true; }
            status.dataset.kind = filled.length ? 'ok' : 'warn';
            status.textContent = filled.length
                ? `Erkannt: ${filled.join(', ')}. Bitte kurz prüfen und bei Bedarf ändern.`
                : 'Auf dem Foto war nichts zu erkennen. Bitte trag die Angaben von Hand ein.';
        } catch (error) {
            if (token !== scanToken) return;
            status.dataset.kind = 'warn';
            status.textContent = 'Der Beleg konnte nicht automatisch gelesen werden. Bitte trag die Angaben von Hand ein.';
        }
    });

    $('receiptForm').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.target.querySelector('button[type="submit"]');
        const file = $('receiptPhoto').files?.[0];
        const amount = Number($('receiptAmount').value);
        if (!file || !(amount > 0)) return;
        if ($('receiptDate').value > TerminCloud.todayIso()) { toast('Das Datum liegt in der Zukunft.', 'error', '#receiptDate'); return; }
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
            scanToken += 1;
            event.target.reset();
            $('receiptScan').hidden = true;
            $('receiptDate').value = TerminCloud.todayIso();
            toast('Beleg eingereicht. Danke!', 'success');
            await loadReceipts();
            goTo(receiptOrigin || (isFest() ? 'receiptsHome' : 'statement'));
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

    // ---------- Überstunden (Festangestellte) ----------
    const toMinutes = time => { const match = String(time || '').match(/^(\d{1,2}):(\d{2})/); return match ? Number(match[1]) * 60 + Number(match[2]) : null; };

    // Überstunden werden auf volle 10 Minuten aufgerundet: 1 Std 13 Min → 1 Std 20 Min (die Datenbank rechnet genauso).
    const roundUp = minutes => Math.ceil(minutes / 10) * 10;

    function overtimeMinutes() {
        const start = toMinutes($('overtimeStart').value);
        const end = toMinutes($('overtimeEnd').value);
        const before = start != null && start < toMinutes(WORK_START) ? roundUp(toMinutes(WORK_START) - start) : 0;
        const after = end != null && end > toMinutes(WORK_END) ? roundUp(end - toMinutes(WORK_END)) : 0;
        return { before, after, total: before + after, hasInput: start != null || end != null };
    }

    function updateOvertimeResult() {
        const result = overtimeMinutes();
        const box = $('overtimeResult');
        if (!result.hasInput) { box.dataset.kind = 'empty'; box.textContent = 'Trag eine Uhrzeit ein.'; return; }
        if (!result.total) { box.dataset.kind = 'warn'; box.textContent = `Das liegt in der normalen Arbeitszeit (${WORK_START} bis ${WORK_END} Uhr) – keine Überstunden.`; return; }
        box.dataset.kind = 'ok';
        box.textContent = `Überstunden: ${duration(result.total)}` + (result.before && result.after ? ` (${duration(result.before)} vorher, ${duration(result.after)} danach)` : '') + ' · auf volle 10 Minuten aufgerundet';
    }
    $('overtimeStart').addEventListener('input', updateOvertimeResult);
    $('overtimeEnd').addEventListener('input', updateOvertimeResult);

    // Die Termine des gewählten Tages stehen zur Auswahl – so weiß das Sekretariat, weshalb es länger ging.
    function fillOvertimeJobs() {
        const date = $('overtimeDate').value;
        const select = $('overtimeJob');
        const previous = select.value;
        const jobs = jobsData.filter(item => item.date === date && !item.cancelled).sort((left, right) => String(left.time).localeCompare(String(right.time)));
        const option = (value, text) => { const node = document.createElement('option'); node.value = value; node.textContent = text; return node; };
        select.replaceChildren(option('', 'Bitte wählen'), ...jobs.map(item => option(item.id, item.title)), option('other', jobs.length ? 'Anderer Termin / anderer Grund' : 'Termin von Hand eintragen'));
        select.value = previous && [...select.options].some(node => node.value === previous) ? previous : (jobs.length === 1 ? jobs[0].id : '');
        $('overtimeJobText').hidden = select.value !== 'other';
        $('overtimeJobText').required = select.value === 'other';
    }
    $('overtimeDate').addEventListener('change', fillOvertimeJobs);
    $('overtimeJob').addEventListener('change', () => {
        $('overtimeJobText').hidden = $('overtimeJob').value !== 'other';
        $('overtimeJobText').required = $('overtimeJob').value === 'other';
        if ($('overtimeJob').value === 'other') $('overtimeJobText').focus();
    });

    function prepareOvertimeForm() {
        $('overtimeHint').textContent = `Arbeitszeit ist ${WORK_START.replace(/^0/, '')} bis ${WORK_END} Uhr. Alles davor oder danach zählt als Überstunden.`;
        $('overtimeStartHint').textContent = `nur wenn vor ${WORK_START.replace(/^0/, '')} Uhr`;
        $('overtimeEndHint').textContent = `nur wenn nach ${WORK_END} Uhr`;
        if (!$('overtimeDate').value) $('overtimeDate').value = TerminCloud.todayIso();
        $('overtimeDate').max = TerminCloud.todayIso();
        fillOvertimeJobs();
        updateOvertimeResult();
        renderOvertime();
    }

    async function loadOvertime() {
        const now = new Date();
        const from = isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
        const { data, error } = await client.from('tt_overtime').select('*').eq('profile_id', profile.id).gte('date', from).order('date', { ascending: false });
        overtimeData = error ? [] : data;
        if (error) $('overtimeSummary').textContent = TerminCloud.germanError(error);
        else renderOvertime();
    }

    function renderOvertime() {
        const now = new Date();
        const months = [0, 1].map(offset => isoDate(new Date(now.getFullYear(), now.getMonth() - offset, 1)).slice(0, 7));
        if (!months.includes(overtimeMonth)) overtimeMonth = months[0];
        $('overtimeMonths').replaceChildren(...months.map(month => {
            const button = el('button', month === overtimeMonth ? 'is-active' : '', monthLabel(month));
            button.type = 'button';
            button.addEventListener('click', () => { overtimeMonth = month; renderOvertime(); });
            return button;
        }));
        const entries = overtimeData.filter(item => item.date.startsWith(overtimeMonth));
        const sum = status => entries.filter(item => item.status === status).reduce((total, item) => total + item.minutes_before + item.minutes_after, 0);
        const confirmed = sum('bestätigt');
        const waiting = sum('eingereicht');
        $('overtimeSummary').textContent = entries.length
            ? `${monthLabel(overtimeMonth)}: ${duration(confirmed)} bestätigt${waiting ? `, ${duration(waiting)} noch offen` : ''}`
            : `${monthLabel(overtimeMonth)}: noch keine Überstunden gemeldet`;
        const list = $('overtimeList');
        list.replaceChildren();
        entries.forEach(item => {
            const entry = el('li', 'directory-entry damage-entry');
            const text = el('span', 'directory-entry-name');
            const times = [item.start_time ? `ab ${String(item.start_time).slice(0, 5)}` : '', item.end_time ? `bis ${String(item.end_time).slice(0, 5)}` : ''].filter(Boolean).join(', ');
            text.append(el('strong', '', `${new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })} · ${duration(item.minutes_before + item.minutes_after)}`),
                el('small', '', [times, item.appointment, item.note].filter(Boolean).join(' · ')));
            if (item.status === 'abgelehnt' && item.review_note) text.append(el('small', 'entry-warning', `Abgelehnt: ${item.review_note}`));
            const side = el('span', 'vehicle-entry-actions');
            const state = el('span', 'status-pill', item.status);
            state.dataset.status = { eingereicht: 'in Arbeit', 'bestätigt': 'erledigt', abgelehnt: 'offen' }[item.status];
            side.append(state);
            if (item.status === 'eingereicht') {
                const remove = el('button', 'button-quiet-danger', 'Löschen');
                remove.type = 'button';
                remove.addEventListener('click', async () => {
                    const { error } = await client.from('tt_overtime').delete().eq('id', item.id);
                    if (error) { toast(TerminCloud.germanError(error), 'error'); return; }
                    await loadOvertime();
                });
                side.append(remove);
            }
            entry.append(text, side);
            list.append(entry);
        });
    }

    $('overtimeForm').addEventListener('submit', async event => {
        event.preventDefault();
        const result = overtimeMinutes();
        const date = $('overtimeDate').value;
        if (!date || date > TerminCloud.todayIso()) { toast('Bitte wähle den Tag (heute oder früher).', 'error'); $('overtimeDate').focus(); return; }
        const jobId = $('overtimeJob').value;
        const job = jobsData.find(item => item.id === jobId);
        const appointment = job ? job.title : (jobId === 'other' ? $('overtimeJobText').value.trim() : '');
        if (!appointment) { toast('Bitte wähle den Termin oder trag ihn ein.', 'error'); (jobId === 'other' ? $('overtimeJobText') : $('overtimeJob')).focus(); return; }
        if (!result.total) { updateOvertimeResult(); toast(result.hasInput ? 'Diese Zeiten sind keine Überstunden.' : 'Bitte trag mindestens eine Uhrzeit ein.', 'error'); return; }
        if (overtimeData.some(item => item.date === date && item.status !== 'abgelehnt' && (item.appointment === appointment))) {
            toast('Für diesen Termin hast du schon Überstunden gemeldet.', 'error');
            return;
        }
        const button = event.target.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            const start = toMinutes($('overtimeStart').value);
            const end = toMinutes($('overtimeEnd').value);
            const { error } = await client.from('tt_overtime').insert({
                profile_id: profile.id, person_name: profile.full_name || profile.email, date,
                start_time: start != null && result.before ? $('overtimeStart').value : null,
                end_time: end != null && result.after ? $('overtimeEnd').value : null,
                minutes_before: result.before, minutes_after: result.after,
                assignment_id: job ? job.id : null, appointment, note: $('overtimeNote').value.trim(), status: 'eingereicht'
            });
            if (error) throw error;
            event.target.reset();
            $('overtimeDate').value = TerminCloud.todayIso();
            fillOvertimeJobs();
            updateOvertimeResult();
            toast(`${duration(result.total)} Überstunden gemeldet.`, 'success');
            await loadOvertime();
        } catch (error) {
            toast(TerminCloud.germanError(error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    // ---------- Nachrichten der Einsatzleitung ----------
    async function loadMessages() {
        const [messages, reads] = await Promise.all([
            client.from('tt_messages').select('*').order('created_at', { ascending: false }).limit(50),
            client.from('tt_message_reads').select('message_id').eq('profile_id', profile.id)
        ]);
        if (messages.error) { messageData = []; return; }
        // Nachrichten aus der Zeit vor dem eigenen Konto sind nicht mehr wichtig.
        messageData = messages.data.filter(item => !profile.created_at || item.created_at >= profile.created_at);
        const knownUnread = messageData.filter(item => !readIds.has(item.id)).length;
        readIds = new Set(reads.error ? [] : reads.data.map(item => item.message_id));
        const unread = messageData.filter(item => !readIds.has(item.id)).length;
        if (loadMessages.loaded && unread > knownUnread) toast('Neue Nachricht von der Einsatzleitung.', 'success');
        loadMessages.loaded = true;
        if (currentView === 'messages') renderMessages();
    }

    function renderMessages() {
        const list = $('messageList');
        list.replaceChildren();
        $('messagesSummary').textContent = messageData.length ? 'Von der Einsatzleitung. Die neueste steht oben.' : 'Noch keine Nachrichten.';
        messageData.forEach(item => {
            const entry = el('li', `message-card${readIds.has(item.id) ? '' : ' is-new'}`);
            const head = el('div', 'message-head');
            head.append(el('strong', '', item.sender_name || 'Einsatzleitung'), el('span', '', new Date(item.created_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })));
            entry.append(head, el('p', '', item.body));
            if (!readIds.has(item.id)) entry.append(el('em', 'chip chip-brand', 'Neu'));
            list.append(entry);
        });
    }

    async function openMessages() {
        renderMessages();
        const unread = messageData.filter(item => !readIds.has(item.id));
        if (!unread.length) return;
        const { error } = await client.from('tt_message_reads').upsert(unread.map(item => ({ message_id: item.id, profile_id: profile.id })), { onConflict: 'message_id,profile_id' });
        if (error) return;
        unread.forEach(item => readIds.add(item.id));
        $('messagesBadge').hidden = true;
    }

    // ---------- Mein Konto: Mitteilungen, Passwort, Installation ----------
    async function renderAccount() {
        if (!profile) return;
        fillStateList($('accountInfo'), [
            ['Name', profile.full_name || '–'],
            ['E-Mail', profile.email || '–'],
            ['Handy', profile.phone || '–'],
            ['Anstellung', isFest() ? 'fest angestellt' : 'temporär']
        ]);
        const state = await TerminCloud.pushState();
        const button = $('pushToggle');
        button.hidden = state === 'unsupported' || state === 'blocked';
        button.textContent = state === 'on' ? 'Mitteilungen ausschalten' : 'Mitteilungen einschalten';
        button.className = state === 'on' ? 'button-secondary portal-wide-button' : 'button-primary big-button';
        button.dataset.state = state;
        const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
        $('pushInfo').textContent = state === 'on' ? 'Eingeschaltet. Du bekommst eine Mitteilung bei neuen Aufträgen, Nachrichten und wenn das Auto nach 16 Uhr noch nicht zurück ist.'
            : state === 'blocked' ? 'Mitteilungen sind für diese Seite gesperrt. Erlaube sie in den Einstellungen des Handys (Mitteilungen → Dolmetscher).'
            : state === 'unsupported' ? (isIos ? 'Auf dem iPhone gehen Mitteilungen erst, wenn du das Portal als App auf den Home-Bildschirm gelegt hast (siehe unten) und es von dort öffnest.' : 'Dieser Browser unterstützt keine Mitteilungen. Öffne das Portal in Chrome.')
            : 'Du bekommst eine Mitteilung bei neuen Aufträgen, Nachrichten und wenn das Auto nach 16 Uhr noch nicht zurück ist.';
    }

    async function switchPush(enable) {
        try {
            if (enable) { await TerminCloud.enablePush(); toast('Mitteilungen sind eingeschaltet.', 'success'); }
            else { await TerminCloud.disablePush(); toast('Mitteilungen sind ausgeschaltet.', 'info'); }
        } catch (error) {
            toast(error.message, 'error');
        }
        $('pushNotice')?.remove();
        renderAccount();
    }
    $('pushToggle').addEventListener('click', () => switchPush($('pushToggle').dataset.state !== 'on'));

    async function savePassword(password) {
        const { error } = await client.auth.updateUser({ password });
        if (error) throw new Error(TerminCloud.germanError(error));
        await client.rpc('tt_password_changed');
    }

    $('changePasswordForm').addEventListener('submit', async event => {
        event.preventDefault();
        try {
            await savePassword($('changePassword').value);
            event.target.reset();
            toast('Passwort geändert.', 'success');
        } catch (error) {
            toast(error.message, 'error');
        }
    });

    $('newPasswordForm').addEventListener('submit', async event => {
        event.preventDefault();
        if ($('newPassword').value.length < 8) { setStatus('Das Passwort braucht mindestens 8 Zeichen.', 'error'); $('newPassword').focus(); return; }
        if ($('newPassword').value !== $('newPasswordRepeat').value) { setStatus('Die beiden Passwörter sind nicht gleich.', 'error'); $('newPasswordRepeat').focus(); return; }
        try {
            await savePassword($('newPassword').value);
            event.target.reset();
            await refresh();
            toast('Passwort gespeichert.', 'success');
        } catch (error) {
            setStatus(error.message, 'error');
        }
    });

    // ---------- Anmeldung ----------
    function switchTab(signUp) {
        $('signInForm').hidden = signUp;
        $('signUpForm').hidden = !signUp;
        $('forgotForm').hidden = true;
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
            currentView = 'vehicle';
            await refresh();
        } catch (error) {
            setStatus(error.message, 'error');
        }
    });

    // Passwort vergessen: Die Anfrage geht an den Admin, der ein vorläufiges Passwort vergibt.
    $('forgotToggle').addEventListener('click', () => {
        $('signInForm').hidden = true;
        $('forgotForm').hidden = false;
        $('forgotEmail').value = $('signInEmail').value;
        $('forgotEmail').focus();
        setStatus('');
    });
    $('forgotBack').addEventListener('click', () => switchTab(false));
    $('forgotForm').addEventListener('submit', async event => {
        event.preventDefault();
        const { error } = await client.rpc('tt_request_password_reset', { p_email: $('forgotEmail').value.trim() });
        if (error) { setStatus(TerminCloud.germanError(error), 'error'); return; }
        switchTab(false);
        setStatus('Anfrage gesendet. Die Einsatzleitung gibt dir ein neues Passwort. Melde dich damit an – danach legst du dein eigenes fest.', 'success');
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

    async function signOut() { await TerminCloud.signOut(); currentView = 'vehicle'; loadMessages.loaded = false; await refresh(); }
    $('portalSignOut').addEventListener('click', signOut);
    $('pendingSignOut').addEventListener('click', signOut);
    $('portalRecheck').addEventListener('click', refresh);
    const poll = () => { if (!document.hidden && profile?.active && !profile.must_change_password) Promise.all([loadJobs(), loadMessages()]).then(renderHome); };
    document.addEventListener('visibilitychange', () => { if (!document.hidden && profile?.active && !profile.must_change_password) { loadFleet(); poll(); } });
    window.setInterval(poll, 45000);

    // ---------- Als App installieren ----------
    // Android/Chrome bietet die Installation direkt an; auf dem iPhone geht es über „Teilen“.
    (function setupInstall() {
        const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
        if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
            navigator.serviceWorker.register('sw.js').catch(() => { /* Ohne Service Worker läuft das Portal normal im Browser. */ });
        }
        if (standalone) return;
        const card = $('installCard');
        const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
        const lines = isIos
            ? ['Öffne diese Seite in Safari.', 'Tippe unten auf das Teilen-Symbol (Quadrat mit Pfeil).', 'Wähle „Zum Home-Bildschirm“ und dann „Hinzufügen“.']
            : ['Öffne diese Seite in Chrome.', 'Tippe oben rechts auf die drei Punkte.', 'Wähle „App installieren“ oder „Zum Startbildschirm hinzufügen“.'];
        $('installSteps').replaceChildren(...lines.map(text => el('li', '', text)));
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

    // Schnittstelle für portalDocs.js (Unterlagen und Bericht über den Tag).
    window.PortalCore = {
        client, config, toast, showSuccess, goTo, el, emptyItem, makeWizard, choiceButtons, parseJobMessage, isoDate, svgSpan,
        profile: () => profile, jobs: () => jobsData, view: () => currentView
    };

    refresh();
})();
