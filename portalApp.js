// Dolmetscher-Portal (Handy-App).
// Untere Leiste – temporär: Fahrzeug · Aufträge · Unterlagen · Arbeitstage · Abrechnung
//               – fest:     Fahrzeug · Aufträge · Unterlagen · Überstunden · Belege
// Unterlagen (Fotos → PDF) und der Bericht über den Tag stehen in portalDocs.js.
// Übernahme und Rückgabe laufen Schritt für Schritt, damit nichts vergessen wird.
// Ohne übernommenes Fahrzeug gibt es weder Schaden- noch Fehlermeldung.

// Direkt nach einem Update kann der Browser für wenige Minuten noch die ältere Seite liefern, in der contactParse.js
// fehlt. Dann wird die Datei hier nachgeladen; bis sie da ist, hilft eine einfache Ersatzfassung (Adresse und
// Nummern bleiben zusammen in einer Zeile), damit nichts stehen bleibt.
if (!window.TerminContact) {
    const lines = value => String(value ?? '').replace(/\r\n?/g, '\n');
    const one = value => lines(value).replace(/\s*\n+\s*/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '');
    window.TerminContact = {
        standIn: true, normalizeLineBreaks: lines, singleLine: one,
        parsePatientContact: value => ({ address: one(value), extra: [], phones: [] }),
        parsePhones: value => /\d/.test(String(value || '')) ? [{ number: one(value), whatsapp: false, note: '' }] : [],
        whatsappNumber: () => '', isQatarNumber: () => false, dialNumber: number => String(number || '').replace(/[^\d+]/g, ''),
        mapQuery: address => one(address), formatPhone: phone => String(phone?.number || '')
    };
    const script = document.createElement('script');
    script.src = 'contactParse.js';
    script.addEventListener('load', () => window.dispatchEvent(new Event('termincontact-ready')));
    document.head.append(script);
}

(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const config = window.TERMIN_CLOUD_CONFIG || {};
    // Wie eine App: Nach dem Öffnen oder Neuladen steht die Seite oben – außer die App macht dort weiter, wo man
    // zuletzt war (siehe lastViewState); dann wird die gemerkte Stelle von Hand wiederhergestellt.
    try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch (error) { /* ältere Browser */ }
    const FUEL = config.fuelLabels || ['Leer', '1/4', '1/2', '3/4', 'Voll'];
    const WORK_START = config.workStart || '09:00';
    const WORK_END = config.workEnd || '16:00';
    const DEFAULT_USER_LINE = 'Dolmetscher und Transport';
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
    // Der zuletzt offene Bereich (z. B. „Aufträge“) und die Stelle auf der Seite: Lädt das Handy die App im
    // Hintergrund neu, geht es genau dort weiter.
    const LAST_VIEW_KEY = 'terminTool.portal.lastView';
    const LAST_VIEW_MINUTES = 90;
    const RESTORABLE_VIEWS = ['vehicle', 'jobs', 'docs', 'workdays', 'overtime', 'statement', 'receiptsHome'];
    function rememberView(view, y = 0) {
        try { if (RESTORABLE_VIEWS.includes(view)) localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({ view, y, at: Date.now(), user: profile?.id || '' })); } catch (error) { /* ohne Speicher startet die App vorn */ }
    }
    function lastViewState() {
        try {
            const saved = JSON.parse(localStorage.getItem(LAST_VIEW_KEY) || 'null');
            if (!saved || saved.user !== (profile?.id || '') || !RESTORABLE_VIEWS.includes(saved.view)) return null;
            return Date.now() - Number(saved.at) < LAST_VIEW_MINUTES * 60000 ? { view: saved.view, y: Math.max(0, Number(saved.y) || 0) } : null;
        } catch (error) { return null; }
    }
    // Beim Verlassen der App die Stelle merken (nur in den Hauptbereichen).
    function rememberPlace() {
        if (profile?.active && !profile.must_change_password) rememberView(currentView, Math.round(window.scrollY));
    }
    let firstStart = true;
    let workedMonth = '';
    let overtimeMonth = '';
    let fuelCards = [];

    // Anzeige oben: grün = gespeichert oder gesendet (5 Sekunden), rot = Problem (bleibt länger).
    // Ein Tipp auf die rote Anzeige führt zur Stelle des Fehlers (target: Element oder CSS-Auswahl).
    let lastErrorText = '';   // letzte Fehlermeldung – kommt in eine Hilfe-Anfrage (Update 49)
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

    // action = { label, run }: zusätzlicher Knopf in der Anzeige, z. B. „Rückgängig“.
    function toast(message, kind = 'info', target = null, action = null) {
        const item = document.createElement('div');
        item.className = 'toast';
        item.dataset.kind = kind;
        item.insertAdjacentHTML('afterbegin', TOAST_ICONS[kind] || TOAST_ICONS.info);
        const text = document.createElement('span');
        text.textContent = message;
        item.append(text);
        if (kind === 'error') lastErrorText = `${message} (${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr)`;
        const duration = kind === 'error' ? 10000 : action ? 10000 : 5000;
        item.style.setProperty('--toast-time', `${duration}ms`);
        const problem = kind === 'error' ? (typeof target === 'function' ? target : findProblem(target)) : null;
        if (problem) {
            item.classList.add('has-target');
            item.setAttribute('role', 'button');
            item.tabIndex = 0;
            const hint = document.createElement('em');
            hint.className = 'toast-jump';
            hint.textContent = typeof target === 'function' ? 'Öffnen' : 'Zur Stelle';
            item.append(hint);
            const jump = () => { item.remove(); if (typeof target === 'function') target(); else jumpToProblem(target || problem); };
            item.addEventListener('click', jump);
            item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); } });
        } else {
            item.addEventListener('click', () => item.remove());
        }
        if (action) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = action.label;
            button.addEventListener('click', event => { event.stopPropagation(); item.remove(); action.run(); });
            item.append(button);
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
        // Das Konto der Pforte gehört auf die Anzeige der Pforte, nicht ins Portal der Dolmetscher.
        if (profile.role === 'pforte') { window.location.replace('pforte.html'); return; }
        if (profile.role === 'arzt' || profile.role === 'pr') { window.location.replace('arzt.html'); return; }
        $('portalUser').textContent = [profile.full_name || profile.email, isFest() ? 'fest angestellt' : ''].filter(Boolean).join(' · ');
        // Admins können zwischen der App der Dolmetscher und der Einsatzleitung wechseln.
        $('switchToOffice').hidden = $('officeCard').hidden = !TerminCloud.isAdmin(profile);
        $('accountInitials').textContent = String(profile.full_name || profile.email || '?').split(/\s+/).map(part => part[0]).slice(0, 2).join('').toLocaleUpperCase('de-DE');
        if (!profile.active) { show('pending'); return; }
        if (profile.must_change_password) { show('password'); return; }
        buildTabbar();
        show('app');
        await loadFleet();
        await Promise.all([loadJobs(), loadReceipts(), loadStatements(), loadMessages(), loadFuelCards(), isFest() ? loadOvertime() : loadWorkdays()]);
        window.PortalDocs?.load();
        window.PortalGate?.load();
        await window.PortalRequests?.load();
        await window.PortalPlan?.start();
        if (!isFest()) renderWorked();
        renderAccount();
        renderHome();
        showUrgent();
        // Direkter Sprung aus einer Mitteilung: portal.html?seite=nachrichten
        const wanted = new URLSearchParams(location.search).get('seite');
        if (wanted === 'nachrichten') { history.replaceState(null, '', location.pathname); goTo('messages'); }
        else if (wanted === 'auftraege') { history.replaceState(null, '', location.pathname); goTo('jobs'); }
        else if (wanted === 'rueckfragen') { history.replaceState(null, '', location.pathname); goTo('requests'); }
        else if (wanted === 'abrechnung') { history.replaceState(null, '', location.pathname); goTo('statement'); }
        else if (wanted === 'fahrzeug') { history.replaceState(null, '', location.pathname); goTo('vehicle'); window.requestAnimationFrame(() => $('driverNotesBox')?.scrollIntoView({ block: 'start', behavior: 'smooth' })); }
        else if (wanted === 'arbeitstage') { history.replaceState(null, '', location.pathname); goTo(isFest() ? 'overtime' : 'workdays'); }
        else if (wanted === 'zeiten') {
            // Antwort der Einsatzleitung auf einen Urlaubsantrag: direkt zu „Meine Anträge und Meldungen“
            history.replaceState(null, '', location.pathname);
            // portalPlan.js kann noch unterwegs sein – dann liest es den Wunsch beim Start (window.portalZeitenWanted).
            window.portalZeitenWanted = 'absence';
            goTo('overtime');
            window.PortalPlan?.showZeiten('absence');
        }
        else {
            const last = firstStart ? lastViewState() : null;
            goTo(last ? last.view : firstStart ? 'vehicle' : TAB_OF[currentView] ? currentView : 'vehicle');
            // Auch die Stelle auf der Seite: dort weiter, wo man war.
            if (last?.y && currentView === last.view) window.requestAnimationFrame(() => window.scrollTo({ top: last.y, behavior: 'instant' }));
        }
        firstStart = false;
    }

    // ---------- Bereiche ----------
    // Der erste Reiter ist die Startseite (Aufträge von heute und das Fahrzeug).
    const HOME_ICON = '<path d="M4 11.5 12 4.5l8 7"/><path d="M6.5 10v9.5h11V10"/><path d="M10 19.5v-5h4v5"/>';
    const ICONS = {
        vehicle: '<path d="M5 16.5V12l1.8-5a2 2 0 0 1 1.9-1.3h6.6A2 2 0 0 1 17.2 7L19 12v4.5"/><path d="M4 12h16"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/><path d="M9.3 16.5h5.4"/>',
        jobs: '<rect x="5" y="4.5" width="14" height="16" rx="2"/><path d="M9 4.5V3.5h6v1"/><path d="M8.5 12.5l2.3 2.3 4.7-4.8"/>',
        workdays: '<rect x="4" y="5.5" width="16" height="14.5" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>',
        overtime: '<circle cx="12" cy="12.5" r="8"/><path d="M12 8v4.5l3 2M9.5 2.5h5"/>',
        statement: '<path d="M17.5 6.5a6.5 6.5 0 1 0 0 11"/><path d="M4 10.5h9M4 13.5h9"/>',
        receiptsHome: '<path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2z"/><path d="M9 8.5h6M9 12.5h6"/>',
        docs: '<path d="M7.500 3.500H14l4.500 4.500V19a1.500 1.500 0 0 1-1.500 1.500H7.500A1.500 1.500 0 0 1 6 19V5a1.500 1.500 0 0 1 1.500-1.500z"/><path d="M14 3.500V8h4.500"/><path d="M9 12.500h6M9 16h4"/>'
    };
    const TABS_TEMP = [['vehicle', 'Start'], ['jobs', 'Aufträge'], ['docs', 'Unterlagen'], ['workdays', 'Arbeitstage'], ['statement', 'Abrechnung']];
    const TABS_FEST = [['vehicle', 'Start'], ['jobs', 'Aufträge'], ['docs', 'Unterlagen'], ['overtime', 'Zeiten'], ['receiptsHome', 'Belege']];
    // Unterseiten gehören zu einem Bereich der unteren Leiste.
    const TAB_OF = { vehicle: 'vehicle', take: 'vehicle', damage: 'vehicle', alert: 'vehicle', return: 'vehicle', requests: 'vehicle', jobs: 'jobs',
        docs: 'docs', docNew: 'docs', docReport: 'docs', appts: 'docs', apptNew: 'docs',
        workdays: 'workdays', overtime: 'overtime', statement: 'statement', receiptsHome: 'receiptsHome', receipts: 'receipts', messages: 'messages', account: 'account' };
    const NEEDS_VEHICLE = ['damage', 'alert', 'return'];

    function buildTabbar() {
        const tabs = isFest() ? TABS_FEST : TABS_TEMP;
        $('portalTabbar').replaceChildren(...tabs.map(([view, text]) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.view = view;
            button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${view === 'vehicle' ? HOME_ICON : ICONS[view]}</svg>`;
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
        updateAppBadge();
    }
    // Zahl am Symbol der App auf dem Handy (wie bei WhatsApp): ungelesene Nachrichten + Aufträge, die auf eine Antwort warten.
    // Die Zahl am App-Symbol (wie bei WhatsApp): nur Neues – Aufträge, die auf eine Antwort warten, und ungelesene Nachrichten.
    // Liegen gebliebene Aufträge früherer Tage stehen in der App, zählen hier aber nicht mit.
    let appBadgeOpen = 0;
    function updateAppBadge() {
        try {
            const messages = $('messagesBadge'); const total = appBadgeOpen + (messages && !messages.hidden ? Number(messages.textContent) || 0 : 0);
            if (total > 0) navigator.setAppBadge?.(total)?.catch?.(() => null); else navigator.clearAppBadge?.()?.catch?.(() => null);
        } catch (error) { /* nicht jedes Handy kann das */ }
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
        currentView = view;
        rememberView(view);
        const activeTab = view === 'receipts' ? (isFest() ? 'receiptsHome' : 'statement') : TAB_OF[view];
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
        if (view === 'appts') window.PortalAppointments?.open();
        if (view === 'requests') window.PortalRequests?.show();
        if (view === 'overtime') window.PortalPlan?.openAbsences();
    }
    document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', () => goTo(button.dataset.go)));
    $('openMessages').addEventListener('click', () => goTo('messages'));
    $('openAccount').addEventListener('click', () => goTo('account'));

    // ---------- Kein Internet: schmales Band oben (R74) ----------
    const showOffline = () => { const band = $('offlineBand'); if (band) band.hidden = navigator.onLine !== false; };
    window.addEventListener('online', showOffline); window.addEventListener('offline', showOffline); showOffline();

    // ---------- Schriftgröße: Normal / Größer – bleibt auf diesem Handy gespeichert (R74) ----------
    const TEXT_KEY = 'terminTool.portal.textSize';
    function applyTextSize(size) {
        document.documentElement.dataset.text = size === 'big' ? 'big' : '';
        $('textSizeNormal')?.setAttribute('aria-pressed', String(size !== 'big'));
        $('textSizeBig')?.setAttribute('aria-pressed', String(size === 'big'));
    }
    applyTextSize(localStorage.getItem(TEXT_KEY));
    $('textSizeNormal')?.addEventListener('click', () => { localStorage.setItem(TEXT_KEY, 'normal'); applyTextSize('normal'); });
    $('textSizeBig')?.addEventListener('click', () => { localStorage.setItem(TEXT_KEY, 'big'); applyTextSize('big'); });

    // ---------- Hell / Dunkel: Knopf oben neben der Glocke ----------
    // Die Wahl bleibt auf diesem Handy gespeichert. Ohne eigene Wahl gilt die Einstellung des Handys (siehe portal.html).
    const THEME_KEY = 'terminTool.portal.theme';
    function showTheme() {
        const dark = document.documentElement.dataset.theme === 'dark';
        const button = $('themeSwitch');
        if (!button) return;
        button.setAttribute('aria-pressed', String(dark));
        button.setAttribute('aria-label', dark ? 'Helle Ansicht einschalten' : 'Dunkle Ansicht einschalten');
        button.title = dark ? 'Zur hellen Ansicht' : 'Zur dunklen Ansicht';
    }
    $('themeSwitch')?.addEventListener('click', () => {
        const dark = document.documentElement.dataset.theme !== 'dark';
        if (dark) document.documentElement.dataset.theme = 'dark'; else delete document.documentElement.dataset.theme;
        try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (error) { /* gilt dann bis zum Neuladen */ }
        showTheme();
    });
    showTheme();
    $('messagesBack').addEventListener('click', () => goTo(previousView));
    $('accountBack').addEventListener('click', () => goTo(previousView));
    $('receiptBack').addEventListener('click', () => goTo(isFest() ? 'receiptsHome' : 'statement'));

    // ---------- Startseite (Fahrzeug) ----------
    function renderHome() {
        if (!profile?.active) return;
        const today = TerminCloud.todayIso();
        $('helloTitle').textContent = `Hallo ${String(profile.full_name || '').split(' ')[0] || ''}`.trim();
        $('helloDate').textContent = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long' });

        const open = jobsData.filter(item => item.date >= today && !item.cancelled && item.response === 'offen').length;
        const unread = unreadMessages();
        const notices = [];
        if (unread) notices.push([`${unread} neue ${unread === 1 ? 'Nachricht' : 'Nachrichten'} von der Einsatzleitung`, () => goTo('messages')]);
        const late = lateJobs().length;
        if (late) notices.push([late === 1 ? 'Ein Auftrag von einem früheren Tag ist noch nicht abgeschlossen – bitte abschließen' : `${late} Aufträge von früheren Tagen sind noch nicht abgeschlossen – bitte abschließen`, () => { goTo('jobs'); window.requestAnimationFrame(() => $('lateJobs')?.scrollIntoView({ block: 'start' })); }]);
        // Aufträge stehen jetzt im Abschnitt „Heute“ (nächster Auftrag groß, weitere als Zeilen) – nicht mehr als Textzeile.
        renderHomeJobs(today, open);
        const waiting = statementData.find(item => item.response === 'offen' && !item.data?.running);
        if (waiting && !isFest()) notices.push([`Deine Abrechnung für ${monthLabel(waiting.month)} wartet auf deine Bestätigung`, () => goTo('statement')]);
        const notes = unseenDriverNotes();
        if (notes.length) notices.unshift([notes.length === 1 ? `Meldung zu deiner Rückgabe von ${notes[0].plate || 'einem Fahrzeug'} (${DRIVER_NOTE_KIND[notes[0].kind] || 'Hinweis'}) – bitte ansehen` : `${notes.length} Meldungen zu deinen Rückgaben – bitte ansehen`, () => { goTo('vehicle'); window.requestAnimationFrame(() => $('driverNotesBox')?.scrollIntoView({ block: 'start', behavior: 'smooth' })); }]);
        // Anweisung eines Arztes: ganz oben, bis sie bestätigt ist.
        const orders = openOrders();
        if (orders.length) notices.unshift([orders.length === 1 ? `Anweisung von ${orders[0].doctor_name || 'einem Arzt'} – bitte lesen und bestätigen` : `${orders.length} Anweisungen von Ärzten – bitte lesen und bestätigen`, () => goTo('messages')]);
        // Berichtsanfrage der PR (Update 51): bleibt stehen, bis der Bericht hochgeladen ist.
        const asks = questionData.filter(item => questionKind(item) === 'bericht' && !item.acknowledged_at);
        if (asks.length) notices.unshift([asks.length === 1 ? `Bericht angefordert von ${asks[0].doctor_name || 'der PR'}${asks[0].patient_name ? ` (${asks[0].patient_name})` : ''} – bitte hochladen` : `${asks.length} Berichte angefordert – bitte hochladen`, () => goTo('messages')]);
        $('startNotices').replaceChildren(...notices.map(([text, action]) => {
            const item = document.createElement('li');
            const button = el('button', '', text);
            button.type = 'button';
            button.addEventListener('click', action);
            item.append(button);
            return item;
        }));
        appBadgeOpen = open;
        setBadge('jobs', open + late);
        setBadge('statement', waiting ? '!' : '');
        $('messagesBadge').hidden = !unread;
        $('messagesBadge').textContent = unread ? String(unread) : '';
        updateAppBadge();
        addPushNotice();
        refreshHomeBadge();
    }

    // ---------- Startseite: „Heute“ ----------
    // Oben der Auftrag, um den es jetzt geht (läuft gerade – sonst der nächste von heute), darunter die übrigen von heute.
    // Ohne Auftrag heute: der nächste kommende. Ein Tipp öffnet genau diesen Auftrag im Bereich „Aufträge“.
    function openJob(id) {
        jobOpenId = id;
        jobsRendered = '';
        goTo('jobs');
        loadJobs().then(() => {
            const card = [...document.querySelectorAll('#jobList .job-card, #lateJobs .late-row')].find(node => node.dataset.id === id);
            if (!card) return;
            const header = document.querySelector('.portal-header')?.getBoundingClientRect().bottom || 0;
            window.scrollTo({ top: window.scrollY + card.getBoundingClientRect().top - header - 12 });
        });
    }

    function homeJobText(item) {
        const parsed = parseJobMessage(item.message);
        const titleParts = String(item.title || '').split(' · ').filter(part => !/^\d{1,2}:\d{2}\s*Uhr$/.test(part));
        return {
            time: String(item.time || '').slice(0, 5),
            place: TerminContact.singleLine(parsed?.sections.find(section => /ARZT/.test(section.title))?.fields.find(([label]) => label === 'Name')?.[1]) || titleParts[0] || 'Auftrag',
            city: parsed?.facts['Ort'] || titleParts.slice(1).join(' · '),
            patient: parsed?.facts['Patient/in'] || parsed?.facts['Hauptpatient/in'] || ''
        };
    }

    function homeState(item) {
        if (jobStorno(item)) return ['bekannt', jobAlone(item) ? 'geht alleine' : 'fällt aus'];
        if (jobFinished(item)) return ['erledigt', item.finished_at ? `fertig ${clock(item.finished_at)}` : 'fertig'];
        if (jobStarted(item)) return ['in Arbeit', item.started_at ? `unterwegs seit ${clock(item.started_at)}` : 'unterwegs'];
        return [{ offen: 'in Arbeit', zugesagt: 'erledigt', vorbehalt: 'bekannt', abgesagt: 'offen' }[item.response], RESPONSE_LABEL[item.response]];
    }

    function renderHomeJobs(today, open) {
        const box = $('homeNext');
        if (!box) return;
        const active = jobsData.filter(item => !item.cancelled).sort(jobOrder);
        const todays = active.filter(item => item.date === today);
        const running = active.find(item => jobStarted(item) && !jobFinished(item) && item.date <= today);
        const nextToday = todays.find(item => !jobFinished(item) && !jobClosed(item));
        const upcoming = active.find(item => item.date > today && item.response !== 'abgesagt');
        const main = running || nextToday || null;
        $('homeTodayTitle').textContent = todays.length ? `Heute · ${todays.length} ${todays.length === 1 ? 'Auftrag' : 'Aufträge'}` : 'Heute';
        box.replaceChildren();
        if (main) {
            const info = homeJobText(main);
            const card = el('button', 'home-next');
            card.type = 'button';
            card.dataset.id = main.id;
            card.dataset.state = running ? 'unterwegs' : main.response;
            const [status, label] = homeState(main);
            const pill = el('span', 'status-pill', label);
            pill.dataset.status = status;
            const what = running ? 'Läuft gerade' : main.response === 'offen' ? 'Als Nächstes · bitte antworten' : 'Als Nächstes';
            const text = el('span', 'home-next-text');
            text.append(el('span', 'home-next-label', what), el('strong', 'home-next-time', info.time ? `${info.time} Uhr` : 'ohne Uhrzeit'), el('span', 'home-next-place', [info.place, info.city].filter(Boolean).join(' · ')));
            if (info.patient) text.append(el('span', 'home-next-patient', info.patient));
            text.append(pill);
            const action = el('span', 'home-next-action', running ? 'Fertig melden ›' : main.response === 'offen' ? 'Antworten ›' : 'Öffnen ›');
            card.append(text, action);
            card.addEventListener('click', () => openJob(main.id));
            box.append(card);
        } else {
            const empty = el('div', 'home-empty');
            const done = todays.filter(jobFinished).length;
            empty.append(el('strong', '', todays.length ? (done === todays.length ? 'Alle Aufträge von heute sind erledigt.' : 'Heute steht nichts mehr an.') : 'Heute hast du keinen Auftrag.'));
            if (upcoming) {
                const info = homeJobText(upcoming);
                const next = el('button', 'link-button home-upcoming', `Nächster Auftrag: ${new Date(`${upcoming.date}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })}${info.time ? ` · ${info.time} Uhr` : ''} · ${info.place}`);
                next.type = 'button';
                next.addEventListener('click', () => openJob(upcoming.id));
                empty.append(next);
            }
            box.append(empty);
        }
        // Die übrigen Aufträge von heute als kurze Zeilen
        $('homeJobs').replaceChildren(...todays.filter(item => item !== main).map(item => {
            const info = homeJobText(item);
            const row = el('li', 'home-job');
            const button = el('button', '');
            button.type = 'button';
            button.dataset.id = item.id;
            const [status, label] = homeState(item);
            const pill = el('span', 'status-pill', label);
            pill.dataset.status = status;
            button.append(el('strong', '', info.time || '–'), el('span', 'home-job-text', [info.place, info.patient].filter(Boolean).join(' · ')), pill);
            button.addEventListener('click', () => openJob(item.id));
            row.append(button);
            return row;
        }));
        // Offene Antworten an kommenden Tagen: ein Hinweis mit Zahl (die von heute stehen schon oben)
        const later = jobsData.filter(item => item.date > today && !item.cancelled && item.response === 'offen').length;
        const all = $('homeAllJobs');
        all.textContent = later ? `Alle Aufträge · ${later} offen` : 'Alle Aufträge';
        all.title = later ? `${later} ${later === 1 ? 'Auftrag an einem kommenden Tag wartet' : 'Aufträge an kommenden Tagen warten'} auf deine Antwort` : '';
        all.dataset.waiting = later ? 'ja' : '';
    }
    $('homeAllJobs')?.addEventListener('click', () => goTo('jobs'));

    // Fragen und Bitten der Einsatzleitung stehen auf der Startseite. Wer gerade in einem anderen Bereich ist (die App
    // öffnet dort, wo man zuletzt war), sieht an der Zahl am Reiter „Fahrzeug“, dass dort etwas auf ihn wartet.
    function refreshHomeBadge() {
        const waiting = ['planBanner', 'requestBanner'].reduce((sum, id) => { const node = $(id); return sum + (node && !node.hidden ? node.children.length : 0); }, 0);
        setBadge('vehicle', waiting || '');
    }
    if (typeof MutationObserver === 'function') ['planBanner', 'requestBanner'].forEach(id => {
        const node = $(id);
        if (node) new MutationObserver(refreshHomeBadge).observe(node, { childList: true, attributes: true, attributeFilter: ['hidden'] });
    });

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
        // „Später“: der Hinweis bleibt dann sieben Tage weg (Update 50 / R74).
        if (Number(localStorage.getItem('portal.pushNoticeLater') || 0) > Date.now()) return;
        const item = document.createElement('li');
        item.id = 'pushNotice';
        item.className = 'notice-row';
        const button = el('button', 'notice-soft', 'Mitteilungen einschalten – dann siehst du Aufträge und Nachrichten sofort');
        button.type = 'button';
        button.addEventListener('click', () => switchPush(true));
        const later = el('button', 'notice-later', 'Später');
        later.type = 'button';
        later.title = 'Den Hinweis sieben Tage lang nicht mehr zeigen';
        later.addEventListener('click', () => { localStorage.setItem('portal.pushNoticeLater', String(Date.now() + 7 * 24 * 60 * 60 * 1000)); item.remove(); });
        item.append(button, later);
        $('startNotices').append(item);
    }

    // ---------- Abrechnung ----------
    async function loadStatements() {
        const { data, error } = await client.from('tt_statements').select('*').eq('profile_id', profile.id).order('month', { ascending: false }).limit(24);
        // Eine Abrechnung gibt es erst, wenn das Büro sie am Monatsende gesendet hat (Reste früherer Zwischenstände zählen nicht).
        statementData = error ? [] : data.filter(item => !item.data?.paused && !item.data?.running);
        const select = $('statementMonth');
        const previous = select.value;
        const now = new Date();
        const recent = [0, 1, 2].map(offset => { const date = new Date(now.getFullYear(), now.getMonth() - offset, 1); return isoDate(date).slice(0, 7); });
        const months = [...new Set([...statementData.map(item => item.month), ...recent])].sort().reverse();
        select.replaceChildren(...months.map(month => {
            const option = document.createElement('option');
            option.value = month;
            const statement = statementData.find(item => item.month === month);
            option.textContent = monthLabel(month) + (statement ? { offen: ' · bitte prüfen', 'bestätigt': ' · abgeschlossen', einwand: ' · Korrektur angefragt' }[statement.response] : '');
            return option;
        }));
        select.value = months.includes(previous) ? previous : (statementData.find(item => item.response === 'offen' && !item.data?.running)?.month || months[0]);
        await renderStatement();
    }
    $('statementMonth').addEventListener('change', () => renderStatement());

    // „Meine Tage“: Die eigene Monatsübersicht – jederzeit sichtbar, ohne Freigabe. Jeder Tag mit einem beendeten Auftrag
    // zählt von selbst. Tage klein untereinander (antippen zeigt die Aufträge), Sondertage markiert, am Ende drei Summen.
    async function renderMyMonth(month, body, sent) {
        const dateShort = iso => new Date(`${iso}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
        let info = null;
        const answer = await client.rpc('tt_my_month', { p_month: month });
        if (!answer.error && answer.data) info = answer.data;
        if (!info) {
            // Ohne Update 27: aus den eigenen beendeten Aufträgen (ohne Sondertage).
            const byDate = new Map();
            jobsData.filter(item => !item.cancelled && item.work_status === 'beendet' && item.date.startsWith(month)).forEach(item => byDate.set(item.date, [...(byDate.get(item.date) || []), item.title || 'Auftrag']));
            info = { rate: 80, days: [...byDate.entries()].sort().map(([date, jobs]) => ({ date, jobs })), special: [], workdays: null };
        }
        const rate = Number(info.rate || 80);
        const special = new Map((info.special || []).map(item => [item.date, Number(item.amount)]));
        const days = new Map((info.days || []).map(item => [item.date, item.jobs || []]));
        const dates = [...new Set([...days.keys(), ...special.keys()])].sort();
        const workdays = info.workdays ?? days.size;
        const normal = Math.max(0, workdays - special.size);
        const specialSum = [...special.values()].reduce((sum, amount) => sum + amount, 0);
        const daySum = normal * rate + specialSum;
        const receiptsOfMonth = receiptData.filter(item => item.date.startsWith(month) && item.status !== 'abgelehnt').sort((left, right) => left.date.localeCompare(right.date));
        const receiptSum = receiptsOfMonth.reduce((sum, item) => sum + Number(item.amount), 0);

        const box = document.createElement('section');
        box.className = 'my-month';
        const head = document.createElement('h3');
        head.className = 'my-month-count';
        head.textContent = `${workdays} ${workdays === 1 ? 'Arbeitstag' : 'Arbeitstage'}`;
        const sub = document.createElement('span');
        sub.textContent = `${monthLabel(month)}${special.size ? ` · davon ${special.size} ${special.size === 1 ? 'Sondertag' : 'Sondertage'}` : ''}`;
        head.append(sub);
        const list = document.createElement('div');
        list.className = 'my-days';
        dates.forEach(date => {
            const item = document.createElement('details');
            item.className = `my-day${special.has(date) ? ' is-special' : ''}`;
            const summary = document.createElement('summary');
            const when = document.createElement('span');
            when.className = 'my-day-date';
            when.textContent = dateShort(date);
            const jobs = days.get(date) || [];
            const count = document.createElement('span');
            count.className = 'my-day-count';
            const isExtra = jobs.length === 1 && /^Zusätzlicher Tag/.test(jobs[0]);
            count.textContent = isExtra ? 'Zusatztag · bestätigt' : jobs.length ? `${jobs.length} ${jobs.length === 1 ? 'Auftrag' : 'Aufträge'}` : 'Sondertag';
            summary.append(when, count);
            if (special.has(date)) { const chip = document.createElement('span'); chip.className = 'my-day-chip'; chip.textContent = `Sondertag ${money(special.get(date))}`; summary.append(chip); }
            const detail = document.createElement('ul');
            detail.className = 'my-day-jobs';
            (jobs.length ? jobs : ['Sondertag – vom Büro eingetragen']).forEach(text => { const row = document.createElement('li'); row.textContent = text; detail.append(row); });
            item.append(summary, detail);
            list.append(item);
        });
        if (!dates.length) { const empty = document.createElement('p'); empty.className = 'directory-empty'; empty.textContent = 'In diesem Monat ist noch kein Auftrag beendet.'; list.append(empty); }

        // Fehlender Tag (Update 43): gemeldete und abgelehnte Tage stehen hier; ein Knopf meldet einen weiteren.
        const extra = Array.isArray(info.extra) ? info.extra : [];
        extra.forEach(item => {
            const row = document.createElement('div');
            row.className = `my-day my-extra-day is-${item.status}`;
            const when = document.createElement('span'); when.className = 'my-day-date'; when.textContent = dateShort(item.date);
            const state = document.createElement('span'); state.className = 'my-day-count';
            state.textContent = item.status === 'gemeldet' ? 'gemeldet – das Büro prüft' : `abgelehnt${item.office_note ? ` – „${item.office_note}“` : ''}`;
            row.append(when, state);
            if (item.note) { const note = document.createElement('span'); note.className = 'my-extra-note'; note.textContent = `Deine Begründung: „${item.note}“`; row.append(note); }
            if (item.status === 'gemeldet') {
                const undo = document.createElement('button'); undo.type = 'button'; undo.className = 'button-quiet my-extra-undo'; undo.textContent = 'Zurückziehen';
                undo.addEventListener('click', async () => {
                    const { error } = await client.from('tt_extra_days').delete().eq('id', item.id);
                    if (error) { toast(TerminCloud.germanError(error), 'error'); return; }
                    toast('Meldung zurückgezogen.', 'success');
                    await renderStatement();
                });
                row.append(undo);
            }
            list.append(row);
        });
        const report = document.createElement('details');
        report.className = 'my-extra-report';
        const reportHead = document.createElement('summary');
        reportHead.textContent = 'Ein Tag fehlt? Hier melden';
        const reportForm = document.createElement('form');
        reportForm.className = 'my-extra-form';
        reportForm.noValidate = true;
        // Kalender des Monats (R78): mehrere Tage antippen, dann einmal melden – statt jeden Tag einzeln.
        const monthEnd = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0);
        const todayIso = isoDate(new Date());
        const reported = new Map(extra.map(item => [item.date, item.status]));
        const picked = new Set();
        const calendar = document.createElement('div'); calendar.className = 'my-extra-calendar'; calendar.setAttribute('role', 'group'); calendar.setAttribute('aria-label', 'Fehlende Tage auswählen');
        const calendarHint = document.createElement('p'); calendarHint.className = 'my-extra-hint'; calendarHint.textContent = 'Tippe alle Tage an, die fehlen – du kannst mehrere auf einmal wählen.';
        ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'].forEach(name => { const head = document.createElement('span'); head.className = 'my-extra-weekday'; head.textContent = name; calendar.append(head); });
        const firstWeekday = (new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1).getDay() + 6) % 7;
        for (let blank = 0; blank < firstWeekday; blank++) { const gap = document.createElement('span'); gap.className = 'my-extra-gap'; calendar.append(gap); }
        const pickedInfo = document.createElement('p'); pickedInfo.className = 'my-extra-picked'; pickedInfo.setAttribute('role', 'status');
        const send = document.createElement('button'); send.type = 'submit'; send.className = 'button-primary'; send.textContent = 'Tag melden';
        const showPicked = () => {
            const chosen = [...picked].sort();
            pickedInfo.textContent = chosen.length ? `Ausgewählt: ${chosen.length === 1 ? '1 Tag' : `${chosen.length} Tage`} – ${chosen.map(dateShort).join(', ')}` : 'Noch kein Tag ausgewählt.';
            send.textContent = chosen.length > 1 ? `${chosen.length} Tage melden` : 'Tag melden';
        };
        for (let day = 1; day <= monthEnd.getDate(); day++) {
            const date = `${month}-${String(day).padStart(2, '0')}`;
            const cell = document.createElement('button'); cell.type = 'button'; cell.className = 'my-extra-day-pick'; cell.textContent = String(day); cell.dataset.date = date;
            const weekday = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, day).getDay();
            if (weekday === 0 || weekday === 6) cell.classList.add('is-weekend');
            if (days.has(date)) { cell.classList.add('is-counted'); cell.disabled = true; cell.title = 'Dieser Tag zählt schon'; cell.setAttribute('aria-label', `${dateShort(date)} – zählt schon`); }
            else if (reported.has(date)) { cell.classList.add(`is-${reported.get(date)}`); cell.disabled = true; cell.title = reported.get(date) === 'gemeldet' ? 'Schon gemeldet – das Büro prüft' : 'Abgelehnt'; }
            else if (date > todayIso) { cell.classList.add('is-future'); cell.disabled = true; cell.title = 'Liegt noch in der Zukunft'; }
            else {
                cell.setAttribute('aria-pressed', 'false');
                cell.setAttribute('aria-label', `${dateShort(date)} auswählen`);
                cell.addEventListener('click', () => { if (picked.has(date)) picked.delete(date); else picked.add(date); cell.classList.toggle('is-picked', picked.has(date)); cell.setAttribute('aria-pressed', String(picked.has(date))); showPicked(); });
            }
            calendar.append(cell);
        }
        showPicked();
        const noteInput = document.createElement('input'); noteInput.type = 'text'; noteInput.maxLength = 300; noteInput.placeholder = 'Was hast du an diesen Tagen gemacht? (z. B. Begleitung im Krankenhaus, Termin stand nicht im Plan)'; noteInput.setAttribute('aria-label', 'Begründung');
        const hint = document.createElement('p'); hint.className = 'my-extra-hint'; hint.textContent = 'Das Büro prüft jede Meldung. Bestätigt es den Tag, zählt er wie ein normaler Arbeitstag.';
        reportForm.append(calendarHint, calendar, pickedInfo, noteInput, send, hint);
        reportForm.addEventListener('submit', async event => {
            event.preventDefault();
            const dates = [...picked].sort();
            if (!dates.length) { toast('Bitte tippe im Kalender die fehlenden Tage an.', 'error'); return; }
            if (!noteInput.value.trim()) { toast('Bitte schreib kurz, was du an dem Tag gemacht hast.', 'error'); noteInput.focus(); return; }
            send.disabled = true;
            let sent = 0; let failed = '';
            for (const date of dates) {
                const { error } = await client.from('tt_extra_days').insert({ date, note: noteInput.value.trim() });
                if (!error) { sent += 1; continue; }
                if (/schon einen Eintrag/.test(error.message || '')) continue;      // schon gemeldet – überspringen
                failed = /does not exist|schema cache|relation|PGRST205/i.test(`${error.code || ''} ${error.message || ''}`) ? 'Dafür fehlt noch ein Datenbank-Update (Update 43). Bitte der Einsatzleitung Bescheid sagen.' : TerminCloud.germanError(error);
                break;
            }
            send.disabled = false;
            if (failed) { toast(failed, 'error'); if (!sent) return; }
            if (sent) {
                toast(sent === 1 ? 'Tag gemeldet – das Büro prüft ihn.' : `${sent} Tage gemeldet – das Büro prüft sie.`, 'success');
                TerminCloud.callFunction?.({ action: 'extraDay', date: dates[0], count: sent })?.catch?.(() => null);
            } else toast('Diese Tage hast du schon gemeldet.', 'info');
            await renderStatement();
        });
        report.append(reportHead, reportForm);
        list.append(report);

        const receipts = document.createElement('details');
        receipts.className = 'my-day my-receipts';
        const receiptHead = document.createElement('summary');
        const receiptTitle = document.createElement('span');
        receiptTitle.className = 'my-day-date';
        receiptTitle.textContent = `Belege (${receiptsOfMonth.length})`;
        const receiptTotal = document.createElement('span');
        receiptTotal.className = 'my-day-count';
        receiptTotal.textContent = money(receiptSum);
        receiptHead.append(receiptTitle, receiptTotal);
        const receiptList = document.createElement('ul');
        receiptList.className = 'my-day-jobs';
        receiptsOfMonth.forEach(item => { const row = document.createElement('li'); row.textContent = `${dateShort(item.date)} · ${item.place || item.kind || 'Beleg'} · ${money(item.amount)}${item.status === 'eingereicht' ? ' · wird noch geprüft' : ''}`; receiptList.append(row); });
        if (!receiptsOfMonth.length) { const row = document.createElement('li'); row.textContent = 'Kein Beleg hochgeladen.'; receiptList.append(row); }
        receipts.append(receiptHead, receiptList);

        const sums = document.createElement('div');
        sums.className = 'my-sums';
        const sumLine = (term, value, strong) => { const row = document.createElement('div'); row.className = `statement-line${strong ? ' is-total' : ''}`; const left = document.createElement('span'); left.textContent = term; const right = document.createElement('span'); right.textContent = value; row.append(left, right); return row; };
        sums.append(
            sumLine(`Tage (${normal} × ${money(rate)}${special.size ? ` + ${special.size} ${special.size === 1 ? 'Sondertag' : 'Sondertage'}` : ''})`, money(daySum)),
            sumLine(`Belege (${receiptsOfMonth.length})`, money(receiptSum)),
            sumLine('Zusammen', money(daySum + receiptSum), true));
        const note = document.createElement('p');
        note.className = 'fleet-footnote my-month-note';
        note.textContent = sent ? 'Die einzelnen Tage und Belege, wie sie heute im System stehen.'
            : `Jeder Tag zählt von selbst, sobald dein Auftrag beendet ist. Die Abrechnung für ${monthLabel(month)} bekommst du am Monatsende zum Bestätigen.`;
        if (info.workdays != null && info.workdays !== days.size) { const manual = document.createElement('p'); manual.className = 'fleet-footnote'; manual.textContent = `Vom Büro eingetragen: ${info.workdays} Arbeitstage.`; box.append(manual); }
        box.prepend(head);
        box.append(list, receipts, sums, note);
        if ($('statementMonth').value === month) body.append(box);
    }

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
            // Noch nichts gesendet: Die eigene Übersicht („Meine Tage“) steht gleich darunter.
        } else {
            // Kurz und deutlich: Arbeitstage × Tagessatz, Sondertage, Belege, Gesamtbetrag.
            const data = statement.data || {};
            const special = (Array.isArray(data.specialDays) ? data.specialDays : []).filter(item => item.counts === 'Ja' || item.counts == null);
            const receiptsOfMonth = Array.isArray(data.receipts) ? data.receipts : [];
            const normal = (data.workdays ?? 0) - (data.specialCount ?? 0);
            body.append(
                line(`${normal} ${normal === 1 ? 'Arbeitstag' : 'Arbeitstage'} × ${money(data.rate)}`, money(normal * Number(data.rate || 0))),
                ...special.map(item => line(`Sondertag ${dateText(item.date)}`, money(item.amount))),
                line(`Belege (${receiptsOfMonth.length})`, money(data.receiptSum)),
                line('Gesamtbetrag', money(data.total), true)
            );
            const state = document.createElement('p');
            state.className = 'statement-state';
            state.dataset.response = statement.response;
            state.textContent = { offen: 'Bitte prüfen und bestätigen.', 'bestätigt': `Abgeschlossen – von dir bestätigt am ${new Date(statement.responded_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}.`, einwand: `Korrektur angefragt: „${statement.response_note}“ – das Büro meldet sich.` }[statement.response];
            body.append(state);
            if (data.reply && statement.response === 'offen') {
                const reply = document.createElement('p');
                reply.className = 'statement-reply';
                reply.textContent = `Antwort des Büros: ${data.reply}`;
                body.append(reply);
            }
            if (statement.response !== 'bestätigt') {
                // Korrektur anfragen: betroffene Tage oder Belege antippen und kurz dazuschreiben, was nicht stimmt.
                const pick = document.createElement('div');
                pick.className = 'statement-pick';
                pick.hidden = true;
                const picked = new Set();
                const chip = (label, id) => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'statement-chip';
                    button.textContent = label;
                    button.setAttribute('aria-pressed', 'false');
                    button.addEventListener('click', () => { if (picked.has(id)) picked.delete(id); else picked.add(id); button.setAttribute('aria-pressed', String(picked.has(id))); });
                    return button;
                };
                const group = (title, chips) => { if (!chips.length) return; const head = document.createElement('p'); head.className = 'statement-pick-title'; head.textContent = title; const row = document.createElement('div'); row.className = 'statement-chips'; row.append(...chips); pick.append(head, row); };
                group('Welcher Tag stimmt nicht? (antippen)', [...new Set([...(data.dates || []), ...special.map(item => item.date)])].sort().map(date => chip(dateText(date), `Tag ${dateText(date)}`)));
                group('Welcher Beleg stimmt nicht?', receiptsOfMonth.map(item => chip(`${dateText(item.date)} · ${money(item.amount)}`, `Beleg ${dateText(item.date)} (${money(item.amount)})`)));
                group('Oder:', [chip('Ein Tag fehlt', 'Ein Arbeitstag fehlt'), chip('Ein Beleg fehlt', 'Ein Beleg fehlt')]);
                const note = document.createElement('textarea');
                note.rows = 2;
                note.maxLength = 500;
                note.hidden = true;
                note.placeholder = 'Was stimmt nicht? Kurz beschreiben (z. B. fehlender Arbeitstag am 12.09.)';
                note.setAttribute('aria-label', 'Korrektur zur Abrechnung');
                const buttons = document.createElement('div');
                buttons.className = 'job-buttons statement-buttons';
                const respond = async (response) => {
                    if (response === 'einwand' && !note.value.trim()) { toast('Bitte schreib kurz, was nicht stimmt.', 'error'); note.focus(); return; }
                    const about = picked.size ? `Betrifft: ${[...picked].join(', ')} – ` : '';
                    const { error } = await client.rpc('tt_respond_statement', { p_month: month, p_response: response, p_note: response === 'einwand' ? `${about}${note.value.trim()}`.slice(0, 500) : '' });
                    if (error) { toast(TerminCloud.germanError(error), 'error'); return; }
                    toast(response === 'bestätigt' ? 'Abrechnung bestätigt und abgeschlossen. Danke!' : 'Korrektur angefragt – das Büro meldet sich.', 'success');
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
                wrong.className = 'button-secondary statement-correct';
                wrong.textContent = 'Korrektur anfragen';
                // Erster Tipp öffnet das Textfeld, der zweite sendet die Anfrage.
                wrong.addEventListener('click', () => { if (note.hidden) { note.hidden = false; pick.hidden = false; wrong.textContent = 'Korrektur senden'; return; } respond('einwand'); });
                buttons.append(ok, wrong);
                body.append(pick, note, buttons);
            }
        }

        await renderMyMonth(month, body, Boolean(statement));
        if ($('statementMonth').value !== month) return;          // inzwischen wurde ein anderer Monat gewählt

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
    const ABSAGE_REASONS = ['Ich bin krank', 'Ich habe zur selben Zeit einen anderen Termin', 'Ich schaffe es zeitlich nicht', 'Privater Notfall', 'Kein Fahrzeug'];
    const WORK_LABEL = { beendet: 'gearbeitet', alleine: 'Patient ging alleine', storniert: 'storniert', losgefahren: 'unterwegs', offen: '' };
    let knownJobIds = null;

    // Was der Dolmetscher zuletzt eingestellt hat, bleibt – auch wenn er die App kurz verlässt (anrufen, Karte,
    // WhatsApp) und zurückkommt: aufgeklappte „Alle Angaben zum Auftrag“ und ein angefangener, noch nicht gesendeter Hinweis.
    const JOB_DETAILS_KEY = 'terminTool.portal.jobDetails';
    const jobDetailsOpen = (() => { try { const saved = JSON.parse(localStorage.getItem(JOB_DETAILS_KEY) || '{}'); return saved && typeof saved === 'object' ? saved : {}; } catch (error) { return {}; } })();
    const saveJobDetails = () => { try { localStorage.setItem(JOB_DETAILS_KEY, JSON.stringify(jobDetailsOpen)); } catch (error) { /* ohne Speicher gilt es bis zum Neuladen */ } };
    function rememberJobDetails(id, open) { jobDetailsOpen[id] = Boolean(open); saveJobDetails(); }
    const jobNoteDrafts = {};
    let jobsRendered = '';

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
    // Feldnamen in den Abschnitten „Patientenkontakt“ und „Arzt / Praxis“
    const JOB_FIELD_LABEL = /^(?:Patientenadresse|Adresse|Telefon|Hinweis|Name)(?:\s|$)/i;
    // Abschnitt „IM TEAM“ des Auftrags (zweite Person): { partner, partnerRole, ownRole, partnerCar, ownCar, phone } oder null.
    function jobTeam(parsed) {
        const section = parsed?.sections.find(item => /^IM TEAM$/.test(item.title));
        if (!section) return null;
        const field = label => section.fields.find(([name]) => name === label)?.[1] || '';
        const partner = field('Mit dir');
        return partner ? { partner, partnerRole: field('Aufgabe Kollege'), ownRole: field('Deine Aufgabe'), partnerCar: field('Fahrzeug Kollege'), ownCar: field('Dein Fahrzeug'), phone: field('Telefon Kollege') } : null;
    }

    function parseJobMessage(text) {
        // Zeilenumbrüche innerhalb eines Feldes der Terminliste kommen als einzelnes CR an – wie ein normaler Umbruch lesen.
        const lines = TerminContact.normalizeLineBreaks(text).split('\n').map(line => line.trim());
        if (!/^\*?DOLMETSCHAUFTRAG\*?$/i.test(lines[0] || '')) return null;
        const facts = {}; const notices = []; const sections = []; let cost = ''; let section = null;
        lines.slice(1).forEach(line => {
            if (!line || JOB_SKIP.some(pattern => pattern.test(line))) return;
            const starred = line.match(/^\*(.+)\*$/);
            const inner = starred ? starred[1].trim() : line;
            if (starred && !inner.includes(':') && inner === inner.toLocaleUpperCase('de-DE')) { section = { title: inner, fields: [] }; sections.push(section); return; }
            const pair = inner.match(/^([A-Za-zÄÖÜäöüß][^:]{1,40}):\s+(.+)$/);
            if (section) {
                // In „Patientenkontakt“ und „Arzt / Praxis“ gibt es nur feste Feldnamen. Jede andere Zeile ist die
                // Fortsetzung des Feldes davor (z. B. die Telefonnummern unter der Adresse).
                const last = section.fields[section.fields.length - 1];
                if (/KONTAKT|ARZT/.test(section.title) && last && last[0] && !(pair && JOB_FIELD_LABEL.test(pair[1].trim()))) { last[1] += `\n${inner}`; return; }
                section.fields.push(pair ? [pair[1].trim(), pair[2].trim()] : ['', inner]);
                return;
            }
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
        team: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8.500" r="3.200"/><path d="M3 20a6 6 0 0 1 12 0"/><circle cx="17" cy="9.500" r="2.500"/><path d="M16 14.500a5 5 0 0 1 5 5"/></svg>',
        clinic: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V6l8-3 8 3v15"/><path d="M9 21v-5h6v5"/><path d="M12 7v5M9.500 9.500h5"/></svg>',
        note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h5"/></svg>',
        camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.500A1.500 1.500 0 0 1 5.500 7H8l1.500-2.500h5L16 7h2.500A1.500 1.500 0 0 1 20 8.500V18a1.500 1.500 0 0 1-1.500 1.500h-13A1.500 1.500 0 0 1 4 18z"/><circle cx="12" cy="13" r="3.500"/></svg>',
        chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.500a7.500 7.500 0 0 1-11.200 6.500L4 19.500l1.500-4.300A7.500 7.500 0 1 1 20 11.500z"/></svg>'
    };
    const svgSpan = (className, markup) => { const node = el('span', className); node.innerHTML = markup; return node; };

    // Telefonnummer von Arzt oder Praxis: die Nummer ist der Knopf – ein Tipp ruft an.
    function phoneLink(number, text = number) {
        const link = el('a', 'job-phone');
        const dial = TerminContact.dialNumber(number);
        if (dial.replace(/\D/g, '').length >= 5) link.href = `tel:${dial}`;
        link.append(svgSpan('job-phone-icon', JOB_ICONS.phone), el('span', '', text));
        link.setAttribute('aria-label', `${number} anrufen`);
        return link;
    }
    // Telefonnummer des Patienten: die Nummer groß in einer Zeile, darunter „Anrufen“ und – wenn die Nummer dafür taugt
    // (katarische und andere Auslandsnummern, deutsche Handynummern) – der direkte WhatsApp-Chat.
    function phoneActions(phone) {
        const row = el('span', 'job-phone-row');
        row.append(phoneLink(phone.number, 'Anrufen'));
        const chat = TerminContact.whatsappNumber(phone.number);
        if (chat) {
            const link = el('a', 'job-whatsapp');
            link.href = `https://wa.me/${chat}`;
            link.target = '_blank';
            link.rel = 'noopener';
            link.append(svgSpan('job-whatsapp-icon', JOB_ICONS.chat), el('span', '', 'WhatsApp'));
            link.setAttribute('aria-label', `WhatsApp-Chat mit ${phone.number} öffnen`);
            row.append(link);
        }
        return row;
    }

    function jobField(label, value) {
        const row = el('div', 'job-field');
        if (label) row.append(el('span', 'job-field-label', label));
        if (/^telefon/i.test(label)) {
            const numbers = el('span', 'job-phones');
            splitPhoneNumbers(value).forEach(number => numbers.append(phoneLink(number)));
            row.append(numbers);
        } else if (/adresse/i.test(label)) {
            const text = String(value || '').replace(/\s*\n+\s*/g, ', ');
            const wrap = el('span', 'job-address');
            wrap.append(el('span', 'job-field-value', text));
            const map = el('a', 'job-map', 'In Karten öffnen');
            map.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(TerminContact.mapQuery(text) || text)}`;
            map.target = '_blank';
            map.rel = 'noopener';
            wrap.append(map);
            row.append(wrap);
        } else {
            row.append(el('span', 'job-field-value', String(value || '').replace(/\s*\n+\s*/g, ' · ')));
        }
        return row;
    }

    // Kontakt des Patienten: die Adresse in Deutschland (mit „In Karten öffnen“) und jede Telefonnummer einzeln.
    // In der Terminliste stehen Adresse und Nummern oft in einem Feld – sie werden hier getrennt, die Hausnummer bleibt
    // bei der Adresse. Die Anschrift in Katar wird nicht gezeigt: Für den Einsatz zählt nur die Adresse in Deutschland.
    function patientContactRows(fields) {
        const rows = [];
        const notes = [];
        const phones = [];
        const known = new Map();
        let phoneLabel = 'Telefon';
        const addPhone = phone => {
            const key = phone.number.replace(/\D/g, '').replace(/^00/, '');
            if (!key) return;
            const existing = known.get(key);
            if (existing) { existing.whatsapp = existing.whatsapp || phone.whatsapp; if (!existing.note) existing.note = phone.note; return; }
            const entry = { number: phone.number, whatsapp: Boolean(phone.whatsapp), note: phone.note || '' };
            known.set(key, entry);
            phones.push(entry);
        };
        fields.forEach(([label, value]) => {
            if (/katar|qatar/i.test(label)) return;
            if (/adresse/i.test(label)) {
                const parsed = TerminContact.parsePatientContact(value);
                if (parsed.address) rows.push(jobField(label, parsed.address));
                notes.push(...parsed.extra);
                parsed.phones.forEach(addPhone);
            } else if (/^telefon/i.test(label)) {
                phoneLabel = label.replace(/\s*\d+$/, '') || 'Telefon';
                TerminContact.parsePhones(value).forEach(addPhone);
            } else if (!label || /^hinweis/i.test(label)) notes.push(String(value || '').replace(/\s*\n+\s*/g, ' · '));
            else rows.push(jobField(label, value));
        });
        notes.filter(Boolean).forEach(text => rows.push(el('span', 'job-field-value job-contact-note', text)));
        phones.forEach((phone, index) => {
            const row = el('div', 'job-field job-field-phone');
            const head = el('span', 'job-phone-head');
            head.append(el('span', 'job-field-label', phones.length > 1 ? `${phoneLabel} ${index + 1}` : phoneLabel));
            // Vermerk aus der Terminliste, z. B. „WhatsApp-Nummer“ oder „Vater“
            const hint = [phone.whatsapp ? 'WhatsApp-Nummer' : '', phone.note].filter(Boolean).join(' · ');
            if (hint) head.append(el('small', 'job-phone-note', hint));
            row.append(head, el('strong', 'job-phone-number', phone.number), phoneActions(phone));
            rows.push(row);
        });
        return rows;
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
            if (facts['Geburtsdatum']) content.append(el('span', 'job-chip job-birth', `geb. ${facts['Geburtsdatum']}`));
            if (facts['Aktennummer']) content.append(el('span', 'job-chip', `Aktennummer ${facts['Aktennummer']}`));
            if (facts['Termin für Begleitperson']) content.append(jobField('Termin für Begleitperson', facts['Termin für Begleitperson']));
            const contact = sections.find(section => /PATIENTENKONTAKT/.test(section.title));
            if (contact) content.append(...patientContactRows(contact.fields));
            block.append(content);
            body.append(block);
        }
        const doctor = sections.find(section => /ARZT/.test(section.title));
        if (doctor?.fields.length) {
            const block = el('div', 'job-section');
            block.append(svgSpan('job-section-icon', JOB_ICONS.clinic));
            const content = el('div', 'job-section-content');
            content.append(el('span', 'job-section-title', 'Arzt / Praxis'));
            doctor.fields.forEach(([label, value]) => content.append(label === 'Name' ? el('strong', 'job-doctor', TerminContact.singleLine(value)) : jobField(label, value)));
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

    // ---------- Losfahren und Fertig: Der Dolmetscher meldet selbst, wann er startet und wann er fertig ist ----------
    const clock = value => new Date(value).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    const jobStarted = item => Boolean(item.started_at) || item.work_status === 'losgefahren';
    // Storniert: vom Dolmetscher gemeldet („Termin fällt aus“, mit Grund) oder von der Einsatzleitung im Tagesplan gesetzt.
    const jobStorno = item => Boolean(item.storno_at) || item.work_status === 'storniert';
    // „Patient geht alleine“: Der Termin findet statt, nur ohne Dolmetscher – das ist kein Ausfall.
    const jobAlone = item => Boolean(item.storno_at) && /geht\s+allein/i.test(item.storno_note || '');
    const jobDeclined = item => item.response === 'abgesagt' && !item.cancelled && !jobStorno(item);
    // Abgeschlossen ohne Einsatz: abgesagt oder ausgefallen – die Karte ist rot und zeigt „Abgesagt“.
    const jobClosed = item => jobDeclined(item) || jobStorno(item);
    // Reihenfolge: Tag, Uhrzeit – bei gleicher Uhrzeit steht der gültige Auftrag vor einem abgesagten,
    // und der zuletzt gesendete zuerst (der neueste ist der aktuelle).
    const jobOrder = (a, b) => `${a.date} ${String(a.time || '').slice(0, 5)}`.localeCompare(`${b.date} ${String(b.time || '').slice(0, 5)}`)
        || Number(jobClosed(a)) - Number(jobClosed(b))
        || String(b.sent_at || '').localeCompare(String(a.sent_at || ''));
    const jobFinished = item => Boolean(item.finished_at) || ['beendet', 'alleine'].includes(item.work_status) || jobStorno(item);

    async function setJobProgress(item, action, button) {
        const running = action === 'start' ? runningJobBeside(item) : null;
        if (running) { lockedToast(running); return; }
        if (action === 'start' && !myHandover) {
            toast('Bitte zuerst ein Fahrzeug übernehmen. Ohne Fahrzeug kann der Auftrag nicht gestartet werden.', 'error', () => goTo('vehicle'));
            return;
        }
        button.disabled = true;
        const { data, error } = await client.rpc('tt_assignment_progress', { p_id: item.id, p_action: action });
        if (error) {
            button.disabled = false;
            const noCar = /fahrzeug übernehmen/i.test(error.message || '');
            toast(/could not find the function|schema cache|does not exist/i.test(error.message || '') ? 'Diese Funktion ist in der Datenbank noch nicht eingerichtet (Update 12 fehlt).' : TerminCloud.germanError(error), 'error', noCar ? () => goTo('vehicle') : null);
            return;
        }
        const overtime = Number(data?.overtime_minutes || 0);
        // Fest Angestellte: „Jetzt losfahren“ meldet zugleich an die Pforte – sie bestätigt die Ausfahrt.
        const gated = action === 'start' ? await window.PortalGate?.autoReport().catch(() => false) : false;
        toast(action === 'start' ? (gated ? 'Gute Fahrt! Einsatzleitung und Pforte wissen Bescheid – bitte an der Pforte kurz bestätigen lassen.' : 'Gute Fahrt! Die Einsatzleitung sieht, dass du unterwegs bist.')
            : `Auftrag beendet. Die Einsatzleitung weiß, dass du wieder frei bist.${overtime ? ` Überstunden eingetragen: ${duration(overtime)}.` : ''}`, 'success');
        // Zusätzlich als Mitteilung an die Einsatzleitung (falls dort eingeschaltet).
        TerminCloud.callFunction({ action: 'progress', assignmentId: item.id }).catch(() => null);
        // Fertig: Die Karte klappt zu, der nächste Auftrag klappt von selbst auf.
        if (action === 'finish') jobOpenId = undefined;
        await loadJobs();
        if (isFest() && overtime) loadOvertime();
        renderHome();
        if (action === 'finish') maybeDayDone(item);
    }

    // ---------- „Bist du schon losgefahren?“ – eine halbe und eine Viertelstunde vor dem Termin ----------
    // Wer bis dahin nicht „Jetzt losfahren“ gedrückt hat, wird gefragt (einmal je Stufe und Auftrag). „Ja“ startet den Auftrag gleich.
    const DEPART_KEY = 'terminTool.portal.departAsked';
    let departAsking = false;
    function departStage(item, now = new Date()) {
        if (item.date !== TerminCloud.todayIso() || item.cancelled || jobStarted(item) || jobFinished(item) || jobClosed(item)) return 0;
        const match = /^(\d{1,2}):(\d{2})/.exec(String(item.time || ''));
        if (!match) return 0;
        const at = new Date(now);
        at.setHours(Number(match[1]), Number(match[2]), 0, 0);
        const minutes = (at - now) / 60000;
        return minutes <= 15 && minutes > -10 ? 15 : minutes <= 30 && minutes > 15 ? 30 : 0;
    }
    function departMemory() {
        let asked = null;
        try { asked = JSON.parse(localStorage.getItem(DEPART_KEY) || 'null'); } catch (error) { /* dann ohne Gedächtnis */ }
        return asked && asked.date === TerminCloud.todayIso() ? asked : { date: TerminCloud.todayIso(), asked: {}, told: {} };
    }
    async function checkDeparture() {
        if (departAsking || !profile?.active || profile.must_change_password || $('portalApp').hidden) return;
        try { if (localStorage.getItem('terminTool.portal.departAsk') === 'aus') return; } catch (error) { /* ohne Speicher: fragen */ }
        const memory = departMemory();
        const save = () => { try { localStorage.setItem(DEPART_KEY, JSON.stringify(memory)); } catch (error) { /* gilt dann nur bis zum Neuladen */ } };
        const waiting = jobsData.filter(item => departStage(item) && !runningJobBeside(item)).sort(jobOrder);
        const info = item => { const text = homeJobText(item); return `${text.time ? `${text.time} Uhr – ` : ''}${text.place}`; };
        // App im Hintergrund: eine Mitteilung des Handys (falls erlaubt) – die Frage selbst kommt, sobald die App wieder offen ist.
        if (document.hidden) {
            const item = waiting.find(job => (memory.told[job.id] || 99) > departStage(job));
            if (!item || !('Notification' in window) || Notification.permission !== 'granted') return;
            memory.told[item.id] = departStage(item);
            save();
            try { (await navigator.serviceWorker?.ready)?.showNotification('Bist du schon losgefahren?', { body: `${info(item)}. Bitte „Jetzt losfahren“ drücken.`, tag: `losfahren-${item.id}`, data: { url: 'portal.html' } }); } catch (error) { /* nur in der App */ }
            return;
        }
        if (document.querySelector('dialog[open], .scan-cam, .scan-review, .scan-adjust')) return;      // nicht mitten in etwas anderes hinein
        const due = waiting.find(job => (memory.asked[job.id] || 99) > departStage(job));
        if (!due) return;
        memory.asked[due.id] = departStage(due);
        memory.told[due.id] = Math.min(memory.told[due.id] || 99, memory.asked[due.id]);
        save();
        departAsking = true;
        try {
            const yes = await askYesNo({
                title: 'Bist du schon losgefahren?',
                text: `${info(due)}\n\nBitte drücke beim Losfahren immer „Jetzt losfahren“ – dann sieht die Einsatzleitung, dass du unterwegs bist.`,
                okLabel: 'Ja – Jetzt losfahren', cancelLabel: 'Noch nicht'
            });
            if (yes) await setJobProgress(due, 'start', el('button'));
        } finally { departAsking = false; }
    }
    window.setInterval(checkDeparture, 20000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) window.setTimeout(checkDeparture, 800); });

    // ---------- Liegen gebliebene Aufträge nachträglich abschließen ----------
    // Ein Auftrag von einem früheren Tag, der weder gestartet noch beendet, abgesagt, ausgefallen oder zurückgezogen ist.
    // Zurück bis zum Ersten des Vormonats – das sind die Monate, die noch abgerechnet werden.
    const lateFrom = () => { const now = new Date(); return isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)); };
    const jobLate = (item, today = TerminCloud.todayIso()) => !item.cancelled && item.date < today && item.date >= lateFrom()
        && !jobStarted(item) && !jobFinished(item) && item.response !== 'abgesagt';
    const lateJobs = () => jobsData.filter(item => jobLate(item)).sort(jobOrder);

    // Nach der Rückgabe des Fahrzeugs (fest angestellt): Überstunden gleich eintragen – Beginn vor 9 Uhr, Ende nach 16 Uhr,
    // am Wochenende die ganze Zeit. Vorgeschlagen werden die Übernahmezeit und „jetzt“. Nur gefragt, wenn es Überstunden geben kann
    // und für heute noch keine gemeldet sind. „Keine Überstunden“ schließt ohne Eintrag; nachträglich geht es weiter unter „Arbeitszeit“.
    async function askOvertimeAfterReturn(taken) {
        const today = TerminCloud.todayIso();
        const now = new Date();
        const nowTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const weekend = [0, 6].includes(now.getDay());
        const startGuess = taken && taken.date === today ? String(taken.start_time || '').slice(0, 5) : '';
        const possible = weekend || (startGuess && toMinutes(startGuess) < toMinutes(WORK_START)) || toMinutes(nowTime) > toMinutes(WORK_END);
        if (!possible) return;
        if (overtimeData.some(item => item.date === today && item.status !== 'abgelehnt')) return;
        const jobs = jobsData.filter(item => item.date === today && !item.cancelled && !jobClosed(item)).sort(jobOrder);
        const dialog = el('dialog', 'confirm-dialog yesno-dialog overtime-ask');
        const heading = el('h2', '', 'Überstunden heute?');
        heading.id = 'overtimeAskTitle';
        dialog.setAttribute('aria-labelledby', 'overtimeAskTitle');
        const text = el('p', '', weekend ? 'Samstag und Sonntag zählt jede Stunde. Trag ein, von wann bis wann du gearbeitet hast.' : `Vor ${WORK_START.replace(/^0/, '')} Uhr angefangen oder nach ${WORK_END} Uhr fertig? Dann trag die Zeiten ein – die Überstunden rechnet die App aus.`);
        const row = el('div', 'overtime-ask-row');
        const field = (id, label, value) => { const wrap = el('label', 'overtime-ask-field'); wrap.htmlFor = id; const input = el('input'); input.type = 'time'; input.id = id; input.value = value; wrap.append(el('span', '', label), input); return [wrap, input]; };
        const [startWrap, startInput] = field('overtimeAskStart', weekend ? 'Beginn' : `Beginn (vor ${WORK_START.replace(/^0/, '')} Uhr)`, startGuess);
        const [endWrap, endInput] = field('overtimeAskEnd', weekend ? 'Ende' : `Ende (nach ${WORK_END} Uhr)`, nowTime);
        row.append(startWrap, endWrap);
        const result = el('p', 'overtime-ask-result');
        result.setAttribute('role', 'status');
        const show = () => { const sum = computeOvertime(weekend, startInput.value, endInput.value); result.dataset.kind = sum.total ? 'ok' : 'warn'; result.textContent = sum.total ? `Überstunden: ${duration(sum.total)}` : sum.hasInput ? (weekend ? 'Bitte Beginn und Ende eintragen.' : `Das liegt in der normalen Arbeitszeit (${WORK_START} bis ${WORK_END} Uhr) – keine Überstunden.`) : 'Trag eine Uhrzeit ein.'; return sum; };
        startInput.addEventListener('input', show); endInput.addEventListener('input', show);
        show();
        const buttons = el('div', 'modal-buttons');
        const none = el('button', 'button-secondary', 'Keine Überstunden');
        none.type = 'button';
        const ok = el('button', 'button-primary', 'Eintragen');
        ok.type = 'button';
        buttons.append(none, ok);
        dialog.append(heading, text, row, result, el('p', 'field-hint', 'Du kannst Überstunden auch später unter „Arbeitszeit“ melden oder dort ändern.'), buttons);
        document.body.append(dialog);
        await new Promise(resolve => {
            none.addEventListener('click', () => dialog.close());
            ok.addEventListener('click', async () => {
                const sum = show();
                if (!sum.total) { toast(weekend ? 'Bitte Beginn und Ende eintragen.' : 'Diese Zeiten sind keine Überstunden.', 'error'); return; }
                ok.disabled = true;
                const main = jobs[jobs.length - 1] || null;
                const { error } = await client.from('tt_overtime').insert({
                    profile_id: profile.id, person_name: profile.full_name || profile.email, date: today,
                    start_time: toMinutes(startInput.value) != null && (sum.before || weekend) ? startInput.value : null,
                    end_time: toMinutes(endInput.value) != null && (sum.after || weekend) ? endInput.value : null,
                    minutes_before: sum.before, minutes_after: sum.after,
                    assignment_id: main ? main.id : null, appointment: main ? main.title : 'Arbeitstag', note: 'Nach der Fahrzeugrückgabe eingetragen', status: 'eingereicht'
                });
                ok.disabled = false;
                if (error) { toast(TerminCloud.germanError(error), 'error'); return; }
                toast(`${duration(sum.total)} Überstunden gemeldet.`, 'success');
                dialog.close();
                loadOvertime();
            });
            dialog.addEventListener('close', () => { dialog.remove(); resolve(); });
            dialog.showModal();
        });
    }

    // Kurze Rückfrage (Ja / Abbrechen) als eigenes Fenster – kein Dialog des Browsers.
    function askYesNo({ title, text, okLabel = 'Ja', cancelLabel = 'Abbrechen' }) {
        const dialog = el('dialog', 'confirm-dialog yesno-dialog');
        const heading = el('h2', '', title);
        heading.id = 'yesNoTitle';
        dialog.setAttribute('aria-labelledby', 'yesNoTitle');
        const buttons = el('div', 'modal-buttons');
        const cancel = el('button', 'button-secondary', cancelLabel);
        cancel.type = 'button';
        const ok = el('button', 'button-primary', okLabel);
        ok.type = 'button';
        buttons.append(cancel, ok);
        dialog.append(heading, el('p', '', text), buttons);
        document.body.append(dialog);
        return new Promise(resolve => {
            let result = false;
            ok.addEventListener('click', () => { result = true; dialog.close(); });
            cancel.addEventListener('click', () => dialog.close());
            dialog.addEventListener('close', () => { dialog.remove(); resolve(result); });
            dialog.showModal();
        });
    }

    async function finishLate(item, button) {
        const info = homeJobText(item);
        const when = new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });
        const sure = await askYesNo({
            title: 'Auftrag nachträglich abschließen',
            text: `${when}${info.time ? `, ${info.time} Uhr` : ''} – ${info.place}.\nHat der Termin stattgefunden und ist er erledigt?`,
            okLabel: 'Ja, abschließen'
        });
        if (!sure) return;
        button.disabled = true;
        const { error } = await client.rpc('tt_assignment_progress', { p_id: item.id, p_action: 'finish' });
        if (error) { button.disabled = false; toast(TerminCloud.germanError(error), 'error'); return; }
        toast(`Auftrag vom ${new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} abgeschlossen. Der Tag zählt jetzt.`, 'success');
        jobsRendered = '';
        await loadJobs();
        renderHome();
    }

    function renderLateJobs() {
        const box = $('lateJobs');
        if (!box) return;
        const late = lateJobs();
        box.hidden = !late.length;
        if (!late.length) { box.replaceChildren(); return; }
        const head = el('div', 'late-head');
        head.append(el('strong', '', `Noch nicht abgeschlossen (${late.length})`),
            el('span', '', late.length === 1 ? 'Dieser Auftrag von einem früheren Tag ist noch offen. Schließe ihn ab, damit der Tag zählt.' : 'Diese Aufträge von früheren Tagen sind noch offen. Schließe sie ab, damit die Tage zählen.'));
        const list = el('ul', 'late-list');
        late.forEach(item => {
            const info = homeJobText(item);
            const row = el('li', 'late-row');
            row.dataset.id = item.id;
            const text = el('div', 'late-text');
            const day = new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
            text.append(el('strong', '', `${day}${info.time ? ` · ${info.time} Uhr` : ''}`), el('span', '', [info.place, info.city].filter(Boolean).join(' · ')));
            if (info.patient) text.append(el('span', 'late-patient', info.patient));
            const done = el('button', 'button-primary late-done', 'Abschließen');
            done.type = 'button';
            done.addEventListener('click', () => finishLate(item, done));
            const gone = el('button', 'link-button late-gone', 'Fand nicht statt');
            gone.type = 'button';
            gone.addEventListener('click', () => stornoJob(item, gone));
            const buttons = el('div', 'late-buttons');
            buttons.append(done, gone);
            row.append(text, buttons);
            list.append(row);
        });
        box.replaceChildren(head, list);
    }

    // ---------- Letzter Auftrag des Tages erledigt: Erinnerung über den ganzen Bildschirm ----------
    function maybeDayDone(item) {
        const today = TerminCloud.todayIso();
        if (item.date !== today) return;
        const mine = jobsData.filter(job => job.date === today && !job.cancelled && job.response !== 'abgesagt');
        if (mine.some(job => !jobFinished(job))) return;                       // heute steht noch etwas an
        if (!mine.some(job => jobFinished(job) && !jobStorno(job))) return;
        showDayDone();
    }
    function showDayDone() {
        const dialog = $('dayDone');
        if (!dialog || dialog.open) return;
        const first = String(profile?.full_name || '').split(' ')[0];
        $('dayDoneLead').textContent = `Danke${first ? `, ${first}` : ''}! Bitte denk noch an diese Punkte:`;
        const go = view => () => { dialog.close(); goTo(view); };
        const entry = (state, title, hint, label, action) => {
            const row = el('li', 'day-done-row');
            row.dataset.state = state;
            const text = el('div', 'day-done-text');
            text.append(el('strong', '', title));
            if (hint) text.append(el('span', '', hint));
            row.append(svgSpan('day-done-mark', state === 'done' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/></svg>'), text);
            if (label) { const button = el('button', state === 'open' ? 'button-primary' : 'button-secondary', label); button.type = 'button'; button.addEventListener('click', action); row.append(button); }
            return row;
        };
        const missing = window.PortalDocs?.missingReports?.(TerminCloud.todayIso()) ?? 0;
        $('dayDoneList').replaceChildren(
            myHandover
                ? entry('open', 'Fahrzeug zurückgeben', [vehicleById(myHandover.vehicle_id)?.plate || '', 'Kilometer, Tank und Parkort eintragen'].filter(Boolean).join(' · '), 'Zurückgeben', go('return'))
                : entry('done', 'Fahrzeug', 'Du hast gerade kein Fahrzeug.'),
            missing
                ? entry('open', missing === 1 ? 'Bericht schreiben' : `${missing} Berichte schreiben`, 'Zu jedem Termin gehört ein kurzer Bericht.', 'Bericht schreiben', go('docReport'))
                : entry('done', 'Berichte', 'Zu jedem Termin von heute gibt es einen Bericht.'),
            entry('hint', 'Unterlagen scannen', 'Arztbericht, Rezept oder Überweisung – falls du welche bekommen hast.', 'Scannen', go('docNew')),
            entry('hint', 'Belege einreichen', 'Parkticket oder Tankbeleg – falls du etwas ausgelegt hast.', 'Beleg', go('receipts'))
        );
        dialog.showModal();
    }
    $('dayDoneClose')?.addEventListener('click', () => $('dayDone').close());

    // Es läuft immer nur EIN Auftrag: Der nächste lässt sich erst starten, wenn der laufende beendet (oder als ausgefallen gemeldet) ist.
    const runningJobBeside = item => jobsData.find(other => other.id !== item.id && !other.cancelled && jobStarted(other) && !jobFinished(other)) || null;
    const jobShort = item => { const info = homeJobText(item); return [info.time ? `${info.time} Uhr` : '', info.place].filter(Boolean).join(' · '); };
    function lockedToast(running) {
        toast(`Bitte beende zuerst den laufenden Auftrag (${jobShort(running)}) – tippe dort auf „Fertig“. Danach kannst du hier losfahren.`, 'info', null, { label: 'Zum laufenden Auftrag', run: () => openJob(running.id) });
    }
    // Die drei Schritte als kleine Leiste: erledigt ✓ – jetzt – kommt noch.
    const STEPS = [['antwort', 'Zusage'], ['los', 'Losfahren'], ['fertig', 'Fertig']];
    function stepTrack(stage) {
        const track = el('ol', 'job-track');
        const now = stage === 'beendet' ? STEPS.length : STEPS.findIndex(([key]) => key === stage);
        STEPS.forEach(([, label], index) => {
            const entry = el('li', '', label);
            entry.dataset.state = index < now ? 'done' : index === now ? 'now' : 'next';
            if (index === now) entry.setAttribute('aria-current', 'step');
            track.append(entry);
        });
        track.setAttribute('aria-label', stage === 'beendet' ? 'Alle Schritte erledigt' : `Schritt ${now + 1} von 3: ${STEPS[now][1]}`);
        return track;
    }

    // Nur am Tag des Auftrags (und danach, falls noch nicht beendet) – nicht bei Absage.
    function jobProgress(item) {
        if (jobStorno(item)) return stornoBox(item);
        if (jobDeclined(item)) return declinedBox(item);
        if (item.response === 'abgesagt' || item.date > TerminCloud.todayIso()) return null;
        const box = el('div', 'job-progress');
        const finished = jobFinished(item);
        const started = jobStarted(item);
        box.dataset.state = finished ? 'beendet' : started ? 'unterwegs' : 'offen';
        // Versehen lassen sich zurücknehmen (Update 37) – klein und ruhig, die Einsatzleitung bekommt einen Vermerk.
        const undoButton = (label, action) => { const undo = el('button', 'link-button job-undo', label); undo.type = 'button'; undo.dataset.undo = action; undo.addEventListener('click', () => undoProgress(item, action, undo)); return undo; };
        if (finished) {
            box.append(svgSpan('job-progress-icon', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.500l2.800 2.800L16.500 9.500"/></svg>'),
                el('span', 'job-progress-text', item.finished_at ? `Beendet um ${clock(item.finished_at)} Uhr` : 'Beendet'));
            if (item.finished_at && !jobStorno(item)) box.append(undoButton('Aus Versehen? „Fertig“ zurücknehmen', 'undo_finish'));
            return box;
        }
        if (started) box.append(el('span', 'job-progress-text', item.started_at ? `Unterwegs seit ${clock(item.started_at)} Uhr` : 'Unterwegs'), item.started_at ? undoButton('Doch nicht losgefahren? Zurücknehmen', 'undo_start') : '');
        const running = started ? null : runningJobBeside(item);
        const button = el('button', `job-progress-button ${started ? 'is-finish' : 'is-start'}`, started ? 'Fertig – Auftrag beenden' : 'Jetzt losfahren');
        button.type = 'button';
        if (running) {
            // Nicht ausgegraut-stumm: Ein Tipp erklärt, was zuerst zu tun ist, und führt zum laufenden Auftrag.
            box.dataset.state = 'gesperrt';
            button.classList.add('is-locked');
            button.setAttribute('aria-disabled', 'true');
            button.addEventListener('click', () => lockedToast(running));
            box.append(button, el('span', 'job-progress-text job-locked-text', `Erst den laufenden Auftrag beenden: ${jobShort(running)}`));
            return box;
        }
        button.addEventListener('click', () => setJobProgress(item, started ? 'finish' : 'start', button));
        box.append(button);
        return box;
    }

    // „Losfahren“ oder „Fertig“ zurücknehmen – mit kurzer Rückfrage; die Einsatzleitung sieht den Vermerk.
    async function undoProgress(item, action, button) {
        const yes = await askYesNo({
            title: action === 'undo_start' ? '„Jetzt losfahren“ zurücknehmen?' : '„Fertig“ zurücknehmen?',
            text: action === 'undo_start' ? 'Der Auftrag gilt dann wieder als noch nicht begonnen. Die Einsatzleitung bekommt einen Vermerk, dass du das zurückgenommen hast.'
                : 'Der Auftrag läuft dann wieder (unterwegs). Die Einsatzleitung bekommt einen Vermerk, dass du das zurückgenommen hast.',
            okLabel: 'Ja, zurücknehmen', cancelLabel: 'Abbrechen'
        });
        if (!yes) return;
        button.disabled = true;
        const { error } = await client.rpc('tt_assignment_progress', { p_id: item.id, p_action: action });
        button.disabled = false;
        if (error) { toast(/Unbekannte Aktion/i.test(error.message || '') ? 'Zurücknehmen ist in der Datenbank noch nicht eingerichtet (Update 37). Bitte sag der Einsatzleitung Bescheid.' : TerminCloud.germanError(error), 'error'); return; }
        toast(action === 'undo_start' ? '„Jetzt losfahren“ zurückgenommen – die Einsatzleitung weiß Bescheid.' : '„Fertig“ zurückgenommen – der Auftrag läuft wieder.', 'success');
        TerminCloud.callFunction({ action: 'progress', assignmentId: item.id }).catch(() => null);
        jobsRendered = '';
        await loadJobs();
        renderHome();
    }

    // ---------- Grund abfragen (Absage, „Termin fällt aus“) ----------
    // Ergebnis: der Text – oder null, wenn abgebrochen wurde.
    let reasonDialog = null;
    function askReason({ title, hint, reasons, okLabel, value = '' }) {
        reasonDialog?.remove();
        const dialog = reasonDialog = el('dialog', 'confirm-dialog reason-dialog');
        dialog.setAttribute('aria-labelledby', 'reasonDialogTitle');
        const heading = el('h2', '', title);
        heading.id = 'reasonDialogTitle';
        const chips = el('div', 'recipient-list reason-chips');
        const text = document.createElement('textarea');
        text.rows = 3;
        text.maxLength = 300;
        text.placeholder = 'Grund kurz aufschreiben';
        text.setAttribute('aria-label', 'Grund');
        text.value = value;
        const problem = el('p', 'reason-problem');
        problem.setAttribute('role', 'alert');
        problem.hidden = true;
        reasons.forEach(reason => {
            const chip = el('button', 'recipient-chip', reason);
            chip.type = 'button';
            chip.addEventListener('click', () => {
                const now = text.value.trim();
                text.value = !now ? reason : now.includes(reason) ? now : `${now}, ${reason}`;
                problem.hidden = true;
                text.focus({ preventScroll: true });
            });
            chips.append(chip);
        });
        const buttons = el('div', 'modal-buttons');
        const cancel = el('button', 'button-secondary', 'Abbrechen');
        cancel.type = 'button';
        const ok = el('button', 'button-primary', okLabel);
        ok.type = 'button';
        buttons.append(cancel, ok);
        dialog.append(heading, el('p', 'field-hint', hint), chips, text, problem, buttons);
        document.body.append(dialog);
        return new Promise(resolve => {
            let result = null;
            ok.addEventListener('click', () => {
                const reason = text.value.trim();
                if (reason.length < 3) { problem.textContent = 'Bitte schreib kurz den Grund – oder tippe einen Vorschlag an.'; problem.hidden = false; text.focus(); return; }
                result = reason;
                dialog.close();
            });
            cancel.addEventListener('click', () => dialog.close());
            text.addEventListener('input', () => { problem.hidden = true; });
            dialog.addEventListener('close', () => { dialog.remove(); if (reasonDialog === dialog) reasonDialog = null; resolve(result); });
            dialog.showModal();
            text.focus({ preventScroll: true });
        });
    }

    // ---------- „Termin fällt aus“: Stornierung durch den Dolmetscher, mit Grund ----------
    const STORNO_REASONS = ['Patient geht alleine', 'Patient ist nicht erschienen', 'Patient hat abgesagt', 'Praxis hat den Termin abgesagt', 'Termin wurde verschoben', 'Patient ist im Krankenhaus'];
    const stornoError = error => /tt_assignment_storno|schema cache|could not find/i.test(error?.message || '')
        ? 'Das ist in der Datenbank noch nicht eingerichtet (Update 20). Bitte sag der Einsatzleitung Bescheid.'
        : TerminCloud.germanError(error);
    async function stornoJob(item, button) {
        const reason = await askReason({
            title: 'Termin fällt aus oder Patient geht alleine',
            hint: jobStarted(item)
                ? 'Warum findet der Termin nicht statt? Der Auftrag wird damit abgeschlossen – die Einsatzleitung sieht den Grund und weiß, dass du wieder frei bist.'
                : 'Warum findet der Termin nicht statt? Die Einsatzleitung sieht den Grund sofort, der Termin steht bei ihr auf „Storniert“.',
            reasons: STORNO_REASONS, okLabel: 'Stornierung melden'
        });
        if (reason == null) return;
        button.disabled = true;
        const { error } = await client.rpc('tt_assignment_storno', { p_id: item.id, p_note: reason, p_undo: false });
        button.disabled = false;
        if (error) { toast(stornoError(error), 'error'); return; }
        TerminCloud.callFunction?.({ action: 'progress', assignmentId: item.id, kind: 'storno' })?.catch?.(() => null);
        toast(jobStarted(item) ? 'Stornierung gemeldet. Der Auftrag ist abgeschlossen – du bist wieder frei.' : 'Stornierung gemeldet. Die Einsatzleitung weiß Bescheid.', 'success');
        if (jobOpenId === item.id) jobOpenId = undefined;
        await loadJobs();
        renderHome();
    }
    async function undoStorno(item, button) {
        button.disabled = true;
        const { error } = await client.rpc('tt_assignment_storno', { p_id: item.id, p_note: '', p_undo: true });
        button.disabled = false;
        if (error) { toast(stornoError(error), 'error'); return; }
        TerminCloud.callFunction?.({ action: 'progress', assignmentId: item.id, kind: 'stornoUndo' })?.catch?.(() => null);
        toast('Stornierung zurückgenommen. Der Auftrag gilt wieder.', 'success');
        await loadJobs();
        renderHome();
    }
    function stornoBox(item) {
        const box = el('div', 'job-progress job-storno-box');
        box.dataset.state = 'storniert';
        const text = el('span', 'job-progress-text');
        if (item.storno_at) {
            text.append(el('strong', '', `${jobAlone(item) ? 'Patient geht alleine' : 'Termin fällt aus'} – gemeldet um ${clock(item.storno_at)} Uhr`), el('span', '', `Grund: ${item.storno_note || '–'}`), el('span', '', 'Auftrag abgeschlossen.'));
            const undo = el('button', 'link-button job-storno-undo', jobAlone(item) ? 'Meldung zurücknehmen' : 'Stornierung zurücknehmen');
            undo.type = 'button';
            undo.addEventListener('click', () => undoStorno(item, undo));
            box.append(text, undo);
        } else {
            text.append(el('strong', '', 'Von der Einsatzleitung storniert'), el('span', '', 'Der Termin findet nicht statt – du musst nichts weiter tun.'));
            box.append(text);
        }
        return box;
    }
    // Nach einer Absage ist der Auftrag für den Dolmetscher abgeschlossen. Korrigieren geht weiter über „Antwort ändern“ / „Antwort zurücknehmen“.
    function declinedBox(item) {
        const box = el('div', 'job-progress job-storno-box job-declined-box');
        box.dataset.state = 'abgesagt';
        const text = el('span', 'job-progress-text');
        text.append(el('strong', '', `Abgesagt${item.responded_at ? ` um ${clock(item.responded_at)} Uhr` : ''}`),
            el('span', '', `Grund: ${item.response_note || '–'}`),
            el('span', '', 'Der Auftrag ist für dich abgeschlossen – die Einsatzleitung plant neu.'));
        box.dataset.response = 'abgesagt';
        box.append(text);
        return box;
    }
    // Knopf „Termin fällt aus …“: bei jedem Auftrag, der noch nicht beendet, abgesagt oder storniert ist – auch nach dem Losfahren.
    function stornoButton(item) {
        if (item.response === 'abgesagt' || jobFinished(item) || item.cancelled) return null;
        const button = el('button', 'job-storno-button link-button', 'Termin fällt aus oder Patient geht alleine? Hier melden …');
        button.type = 'button';
        button.addEventListener('click', () => stornoJob(item, button));
        return button;
    }

    // ---------- Bemerkung der Einsatzleitung und Anhang (PDF) zum Auftrag ----------
    const CLIP_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.500 12.500 19a5 5 0 0 1-7-7l8-8a3.300 3.300 0 0 1 4.700 4.700l-8 8a1.700 1.700 0 0 1-2.400-2.400l7.200-7.200"/></svg>';
    // Der Tab entsteht sofort beim Tippen – nach dem Warten auf die Adresse würde ihn das Handy blockieren.
    async function openJobAttachment(item, button) {
        const tab = window.open('', '_blank');
        button.disabled = true;
        const { data, error } = await client.storage.from('dokumente').createSignedUrl(item.attachment_path, 600);
        button.disabled = false;
        if (error || !data?.signedUrl) {
            tab?.close();
            toast('Der Anhang konnte nicht geöffnet werden. Bitte sag der Einsatzleitung Bescheid.', 'error');
            return;
        }
        if (tab && !tab.closed) { tab.opener = null; tab.location.replace(data.signedUrl); }
        else toast('Der Browser hat das neue Fenster blockiert.', 'info', null, { label: 'Anhang öffnen', run: () => { window.location.href = data.signedUrl; } });
    }
    // Zweite Person im Auftrag: wer mit dabei ist und wer welche Aufgabe hat (eine Person fährt, eine dolmetscht – oder zwei
    // Fahrzeuge). Steht oben auf der Karte, nicht erst unter „Alle Angaben“.
    function jobTeamBox(item) {
        const team = jobTeam(parseJobMessage(item.message));
        if (!team) return null;
        const block = el('div', 'job-section job-team');
        block.append(svgSpan('job-section-icon', JOB_ICONS.team));
        const content = el('div', 'job-section-content');
        content.append(el('span', 'job-section-title', 'Im Team – ihr seid zu zweit'), el('strong', 'job-team-name', team.partner));
        if (team.partnerRole) content.append(el('span', 'job-chip', team.partnerRole));
        if (team.partnerCar) content.append(el('span', 'job-chip', `Fahrzeug ${team.partnerCar}`));
        if (team.ownRole) content.append(el('p', 'job-team-own', `Deine Aufgabe: ${team.ownRole}${team.ownCar ? ` · dein Fahrzeug ${team.ownCar}` : ''}`));
        if (team.phone) content.append(jobField(`Telefon ${team.partner.split(' ')[0]}`, team.phone));
        block.append(content);
        return block;
    }
    function jobOfficeNote(item) {
        if (!item.office_note && !item.attachment_path) return null;
        const box = el('div', 'job-office-note');
        box.append(el('strong', '', 'Hinweis der Einsatzleitung'));
        if (item.office_note) box.append(el('p', '', item.office_note));
        if (item.attachment_path) {
            const button = el('button', 'job-attachment');
            button.type = 'button';
            button.append(svgSpan('job-attachment-icon', CLIP_ICON), el('span', '', `Anhang öffnen${item.attachment_name ? `: ${item.attachment_name}` : ' (PDF)'}`));
            button.addEventListener('click', () => openJobAttachment(item, button));
            box.append(button);
        }
        return box;
    }

    // ---------- Frühere Unterlagen zum Patienten: zur Vorbereitung, sobald der Auftrag zugesagt ist ----------
    // Die Datenbank gibt sie nur dem Dolmetscher, dem der Auftrag gerade gehört – ab der Zusage, rund um den Termin,
    // und hält jeden Abruf fest. Geladen wird erst, wenn die Karte wirklich offen ist.
    const priorCache = new Map();    // Auftrag → { at, result } oder { pending }
    const priorOpen = new Map();     // Auftrag → vom Dolmetscher auf- oder zugeklappt
    const PRIOR_GROUPS = [
        ['Berichte der Dolmetscher', kind => kind === 'Dolmetscherbericht'],
        ['Arzt- und Krankenhausberichte', kind => kind === 'Arztbericht'],
        ['Befunde', kind => /^Befund/.test(kind)],
        ['Rezepte', kind => /^Rezept/.test(kind)],
        ['Überweisungen', kind => /^Überweisung/.test(kind)],
        ['Kosten', kind => /^Kosten/.test(kind)],
        ['Sonstiges', () => true]
    ];
    const PRIOR_INLINE = 12;          // bis zu so vielen Unterlagen steht die ganze Liste gleich in der Auftragskarte
    const PRIOR_NEWEST = 5;           // bei einer großen Akte: nur die neuesten – alles Weitere unter „Ganze Akte öffnen“
    const foldText = text => String(text || '').toLocaleLowerCase('de-DE').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    const priorWanted = item => ['zugesagt', 'vorbehalt'].includes(item.response) && !item.cancelled && !jobClosed(item);
    async function openStoredFile(path, button, failText) {
        // Der Tab entsteht sofort beim Tippen – nach dem Warten auf die Adresse würde ihn das Handy blockieren.
        const tab = window.open('', '_blank');
        button.disabled = true;
        const { data, error } = await client.storage.from('dokumente').createSignedUrl(path, 600);
        button.disabled = false;
        if (error || !data?.signedUrl) { tab?.close(); toast(failText, 'error'); return; }
        if (tab && !tab.closed) { tab.opener = null; tab.location.replace(data.signedUrl); }
        else toast('Der Browser hat das neue Fenster blockiert.', 'info', null, { label: 'Öffnen', run: () => { window.location.href = data.signedUrl; } });
    }
    function priorEntry(doc, jobDoctor) {
        const entry = el('li', 'job-prior-entry');
        entry.dataset.kind = doc.kind || 'Sonstiges';
        const head = el('span', 'job-prior-head');
        // Aus einer eingelesenen Papierakte: Überschrift („Arztbericht · Prof. Dr. … · Neurochirurgie“) und das Datum des Schriftstücks.
        const day = doc.date || (doc.status === 'archiv' ? '' : String(doc.created_at || '').slice(0, 10));
        const heading = String(doc.title || '').trim() || doc.kind || 'Unterlage';
        head.append(el('strong', '', heading), el('span', '', day ? new Date(`${day}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''));
        const sameDoctor = jobDoctor && doc.doctor && (foldText(doc.doctor).includes(foldText(jobDoctor)) || foldText(jobDoctor).includes(foldText(doc.doctor)));
        if (sameDoctor) head.append(el('em', 'chip chip-brand', 'gleiche Praxis'));
        entry.append(head);
        entry.append(el('small', '', [doc.doctor && !foldText(heading).includes(foldText(doc.doctor)) ? doc.doctor : '', doc.status === 'archiv' ? 'aus der Papierakte' : doc.mine ? 'von dir' : doc.uploader_name ? `von ${doc.uploader_name}` : '', doc.pages ? `${doc.pages} ${doc.pages === 1 ? 'Seite' : 'Seiten'}` : ''].filter(Boolean).join(' · ')));
        if (doc.note) entry.append(el('span', 'job-prior-note', doc.note));
        if (doc.body) {
            const full = String(doc.body).trim();
            const short = full.length > 220 ? `${full.slice(0, 220).trimEnd()} …` : full;
            const text = el('p', 'job-prior-body', short);
            entry.append(text);
            if (short !== full) {
                const more = el('button', 'link-button job-prior-more', 'Ganzen Bericht lesen');
                more.type = 'button';
                more.addEventListener('click', () => { const open = text.textContent !== full; text.textContent = open ? full : short; more.textContent = open ? 'Kürzer anzeigen' : 'Ganzen Bericht lesen'; });
                entry.append(more);
            }
        }
        if (doc.file_path) {
            const open = el('button', 'job-attachment job-prior-open');
            open.type = 'button';
            open.append(svgSpan('job-attachment-icon', CLIP_ICON), el('span', '', 'PDF öffnen'));
            open.addEventListener('click', () => openStoredFile(doc.file_path, open, 'Die Unterlage konnte nicht geöffnet werden. Bitte sag der Einsatzleitung Bescheid.'));
            entry.append(open);
        }
        return entry;
    }
    function priorBox(item, jobDoctor) {
        if (!priorWanted(item)) return null;
        const box = document.createElement('details');
        box.className = 'job-prior';
        box.hidden = true;                       // erscheint erst, wenn klar ist, dass es etwas zu zeigen gibt
        const summary = el('summary', '', 'Frühere Unterlagen zum Patienten');
        const count = el('b', 'count-badge job-prior-count');
        count.hidden = true;
        summary.append(count);
        const body = el('div', 'job-prior-body-wrap');
        box.append(summary, body);
        box.addEventListener('toggle', () => priorOpen.set(item.id, box.open));
        const show = result => {
            const docs = result?.documents || [];
            // Nicht erlaubt (z. B. Termin zu weit weg), keine Aktennummer, Funktion fehlt: einfach nichts anzeigen.
            if (!result || !result.allowed || !result.patient_nr) { box.hidden = true; return; }
            box.hidden = false;
            count.hidden = !docs.length;
            count.textContent = String(docs.length);
            if (!docs.length) { body.replaceChildren(el('p', 'job-prior-empty', 'Zu diesem Patienten gibt es noch keine früheren Unterlagen im Archiv.')); return; }
            // „die neueste vom …“: ein Schriftstück aus der Papierakte ohne Datum zählt dabei nicht (der Tag des Einlesens sagt nichts).
            const newest = docs.find(doc => doc.date || doc.status !== 'archiv');
            const last = newest ? newest.date || String(newest.created_at || '').slice(0, 10) : '';
            const nodes = [el('p', 'job-prior-intro', `Zur Vorbereitung: ${docs.length} ${docs.length === 1 ? 'Unterlage' : 'Unterlagen'} aus dem Archiv${last ? ` – die neueste vom ${new Date(`${last}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : ''}. Bitte vertraulich behandeln.`)];
            // Die ganze Akte groß: suchen, nach Datum / Fachrichtung / Arzt ordnen, ansehen, speichern, weiterleiten, drucken.
            const recordButton = () => {
                const button = el('button', 'button-secondary job-record-open', `Ganze Akte öffnen (${docs.length})`);
                button.type = 'button';
                button.addEventListener('click', () => {
                    const facts = parseJobMessage(item.message)?.facts || {};
                    window.PortalRecord?.open({ docs, patientNr: result.patient_nr, patientName: facts['Patient/in'] || facts['Hauptpatient/in'] || '', jobDoctor, toast });
                });
                return button;
            };
            if (window.PortalRecord) nodes.push(recordButton());
            // Ganz oben: der letzte Bericht eines Dolmetschers – wann, bei welchem Arzt / welcher Fachrichtung, von wem.
            const lastReport = docs.find(doc => doc.kind === 'Dolmetscherbericht' && String(doc.body || '').trim());
            if (lastReport) {
                const day = lastReport.date || String(lastReport.created_at || '').slice(0, 10);
                const card = el('div', 'job-prior-last');
                card.append(el('span', 'job-prior-last-kicker', 'Letzter Bericht'),
                    el('strong', '', [day ? new Date(`${day}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '', lastReport.mine ? 'von dir' : lastReport.uploader_name ? `von ${lastReport.uploader_name}` : ''].filter(Boolean).join(' · ')),
                    el('span', 'job-prior-last-where', `Arzt / Fachrichtung: ${lastReport.doctor || 'nicht angegeben'}`),
                    el('p', 'job-prior-body', String(lastReport.body).trim()));
                if (lastReport.note) card.append(el('span', 'job-prior-note', lastReport.note));
                nodes.push(card, el('h4', 'job-prior-title job-prior-all', `Ganze Akte (${docs.length})`));
            }
            if (docs.length > PRIOR_INLINE) {
                // Große Akte (z. B. eine eingelesene Papierakte): hier nur die neuesten – alles steht in der ganzen Akte.
                const list = el('ul', 'job-prior-list');
                list.append(...docs.slice(0, PRIOR_NEWEST).map(doc => priorEntry(doc, jobDoctor)));
                nodes.push(el('h4', 'job-prior-title', `Die neuesten ${PRIOR_NEWEST} von ${docs.length}`), list,
                    el('p', 'job-prior-intro job-prior-rest', `${docs.length - PRIOR_NEWEST} weitere Unterlagen stehen in der ganzen Akte (Knopf oben) – dort kannst du suchen und nach Fachrichtung oder Arzt ordnen.`));
            } else {
                const rest = [...docs];
                PRIOR_GROUPS.forEach(([title, test]) => {
                    const group = rest.filter(doc => test(doc.kind || ''));
                    if (!group.length) return;
                    group.forEach(doc => rest.splice(rest.indexOf(doc), 1));
                    const list = el('ul', 'job-prior-list');
                    list.append(...group.map(doc => priorEntry(doc, jobDoctor)));
                    nodes.push(el('h4', 'job-prior-title', `${title} (${group.length})`), list);
                });
            }
            body.replaceChildren(...nodes);
            // Von selbst aufgeklappt, solange der Auftrag noch bevorsteht – außer der Dolmetscher hat es selbst zugeklappt.
            box.open = priorOpen.has(item.id) ? priorOpen.get(item.id) : !jobStarted(item) && !jobFinished(item);
        };
        const ensure = async () => {
            const cached = priorCache.get(item.id);
            if (cached?.result && Date.now() - cached.at < 10 * 60 * 1000) { show(cached.result); return; }
            if (cached?.pending) { show(await cached.pending); return; }
            const pending = client.rpc('tt_patient_history', { p_assignment: item.id }).then(({ data, error }) => (error ? null : data)).catch(() => null);
            priorCache.set(item.id, { pending });
            const result = await pending;
            // Fehlt die Funktion (Update 23) oder gab es einen Fehler: nicht dauernd neu fragen.
            priorCache.set(item.id, { at: Date.now(), result: result || { allowed: false } });
            show(result);
        };
        const cached = priorCache.get(item.id);
        if (cached?.result) show(cached.result);
        return { node: box, ensure };
    }

    // Ab zwei Aufträgen ist immer nur einer aufgeklappt – die anderen sind eine kurze Zeile (Tag, Uhrzeit, Ort, Patient, Antwort).
    // jobOpenId: undefined = von selbst (der nächste anstehende Auftrag), '' = alle zu, sonst der vom Dolmetscher geöffnete.
    const JOB_FOLD_FROM = 2;
    let jobOpenId;
    const historyOpen = new Set();   // aufgeklappte Tage im Archiv
    const JOB_FOLD_KEY = 'terminTool.portal.jobsFold';
    let jobsFoldOff = (() => { try { return localStorage.getItem(JOB_FOLD_KEY) === 'aus'; } catch (error) { return false; } })();
    $('jobsFoldToggle')?.addEventListener('click', () => {
        jobsFoldOff = !jobsFoldOff;
        try { localStorage.setItem(JOB_FOLD_KEY, jobsFoldOff ? 'aus' : 'an'); } catch (error) { /* gilt dann bis zum Neuladen */ }
        jobsRendered = '';
        loadJobs();
    });
    let jobAutoOpenId = '';
    function jobCard(item, foldable = false) {
        const card = el('li', 'job-card');
        card.dataset.id = item.id;
        card.dataset.response = item.response;
        const date = new Date(`${item.date}T00:00:00`);
        const parsed = parseJobMessage(item.message);
        const titleParts = String(item.title || '').split(' · ');
        const time = String(item.time || '').slice(0, 5);
        const place = TerminContact.singleLine(parsed?.sections.find(section => /ARZT/.test(section.title))?.fields.find(([label]) => label === 'Name')?.[1])
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
        // Abgesagt (vom Dolmetscher) oder ausgefallen (Patient, Praxis, Einsatzleitung): deutlich rot „Abgesagt“.
        const closedLabel = jobStorno(item) ? (jobAlone(item) ? 'Patient geht alleine' : 'Abgesagt') : item.response === 'abgesagt' ? 'Abgesagt' : '';
        const state = el('span', 'status-pill', closedLabel || RESPONSE_LABEL[item.response]);
        state.dataset.status = closedLabel ? 'offen' : { offen: 'in Arbeit', zugesagt: 'erledigt', vorbehalt: 'bekannt', abgesagt: 'offen' }[item.response];
        top.append(day, main, state);

        // Offene Aufträge sind aufgeklappt. Hat der Dolmetscher selbst auf- oder zugeklappt, bleibt es dabei.
        const details = document.createElement('details');
        details.className = 'job-details';
        details.open = item.id in jobDetailsOpen ? jobDetailsOpen[item.id] : item.response === 'offen';
        const summary = el('summary', '', 'Alle Angaben zum Auftrag');
        summary.addEventListener('click', () => window.setTimeout(() => rememberJobDetails(item.id, details.open), 0));
        details.append(summary, jobBody(item));

        // Aufbau der Karte: oben der Kopf, darunter IMMER der nächste Schritt als ein klarer Knopf
        // (1 Zusage/Absage → 2 Jetzt losfahren → 3 Fertig), aufgeklappt dazu Angaben, Hinweis, Unterlagen.
        const answered = item.response !== 'offen';
        const started = jobStarted(item);
        const finished = jobFinished(item);
        const declined = jobDeclined(item);
        const saved = item.response_note || '';
        const answer = el('div', 'job-answer');
        const noteLabel = el('label', 'job-field-label job-note-label', 'Hinweis an die Einsatzleitung (freiwillig)');
        const noteRow = el('div', 'job-note-row');
        const note = document.createElement('input');
        note.type = 'text';
        note.id = `jobNote-${item.id}`;
        noteLabel.htmlFor = note.id;
        note.maxLength = 300;
        note.placeholder = 'z. B. komme 10 Minuten später';
        note.value = item.id in jobNoteDrafts ? jobNoteDrafts[item.id] : saved;
        note.enterKeyHint = 'send';
        const send = el('button', 'button-secondary job-note-send', 'Senden');
        send.type = 'button';
        const noteState = el('p', 'job-note-state');
        noteState.setAttribute('aria-live', 'polite');
        const showNoteState = () => {
            const text = note.value.trim();
            const changed = text !== saved;
            if (changed) jobNoteDrafts[item.id] = note.value; else delete jobNoteDrafts[item.id];
            send.disabled = !changed;
            send.textContent = !changed && saved ? 'Gesendet' : 'Senden';
            noteState.dataset.state = changed ? 'offen' : saved ? 'gesendet' : 'leer';
            noteState.textContent = changed
                ? (text ? 'Noch nicht gesendet – tippe auf „Senden“.' : 'Der Hinweis wird gelöscht – tippe auf „Senden“.')
                : saved ? `Hinweis gesendet${item.responded_at ? ` um ${clock(item.responded_at)} Uhr` : ''} – die Einsatzleitung sieht ihn.` : '';
        };
        // purpose: 'antwort' | 'hinweis' | 'zurueck' – nur für die passende Meldung, falls etwas nicht geht.
        const respond = async (response, text, purpose = 'antwort') => {
            const { error: rpcError } = await client.rpc('tt_respond_assignment', { p_id: item.id, p_response: response, p_note: text });
            if (!rpcError) { delete jobNoteDrafts[item.id]; return true; }
            // Ohne Update 16 kennt die Datenbank weder „Hinweis ohne Antwort“ noch „Antwort zurücknehmen“.
            toast(/unbekannte antwort/i.test(rpcError.message || '')
                ? (purpose === 'hinweis'
                    ? 'Bitte wähle zuerst Zusage oder Absage – dein Hinweis wird mitgeschickt.'
                    : 'Zurücknehmen ist in der Datenbank noch nicht eingerichtet (Update 16). Wähle einfach die richtige Antwort.')
                : TerminCloud.germanError(rpcError), 'error');
            return false;
        };
        const sendNote = async () => {
            if (send.disabled) return;
            send.disabled = true;
            const text = note.value.trim();
            if (!(await respond(item.response, text, 'hinweis'))) { showNoteState(); return; }
            toast(text ? 'Hinweis gesendet. Die Einsatzleitung sieht ihn jetzt.' : 'Hinweis gelöscht.', 'success');
            await loadJobs();
        };
        note.addEventListener('input', showNoteState);
        note.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); sendNote(); } });
        send.addEventListener('click', sendNote);
        noteRow.append(note, send);
        showNoteState();
        answer.append(noteLabel, noteRow, noteState);

        // Eine Antwort senden (Zusage, Unter Vorbehalt, Absage) – mit „Rückgängig“.
        const answerWith = async (value, text) => {
            let noteText = note.value.trim();
            if (item.response === value && noteText === saved) { toast(`„${text}“ ist schon deine Antwort.`, 'info'); return; }
            // Eine Absage geht nur mit Grund – erst recht, wenn vorher zugesagt war. Steht schon ein Hinweis im Feld, zählt er als Grund.
            if (value === 'abgesagt' && noteText.length < 3) {
                const reason = await askReason({
                    title: item.response === 'zugesagt' ? 'Zusage zurückziehen und absagen' : 'Auftrag absagen',
                    hint: 'Warum kannst du den Auftrag nicht übernehmen? Die Einsatzleitung sieht den Grund sofort und kann neu planen.',
                    reasons: ABSAGE_REASONS, okLabel: 'Absage senden', value: noteText
                });
                if (reason == null) return;
                noteText = reason;
            }
            const before = { response: item.response, note: saved, draft: note.value.trim() !== saved ? note.value : null };
            if (!(await respond(value, noteText))) return;
            // Abgesagt = abgeschlossen: Die Karte klappt zu, der nächste Auftrag klappt von selbst auf.
            if (value === 'abgesagt' && jobOpenId === item.id) jobOpenId = undefined;
            // Mitteilung „TERMIN · zugesagt / abgesagt …“ an die Einsatzleitung – getrennt von den Fahrzeug-Mitteilungen.
            TerminCloud.callFunction?.({ action: 'response', assignmentId: item.id })?.catch?.(() => null);
            // Wer gerade die Angaben liest, soll sie nach der Antwort weiter vor sich haben.
            if (details.open) rememberJobDetails(item.id, true);
            // Vertippt? „Rückgängig“ stellt den Stand von vorher wieder her (auch „noch keine Antwort“).
            toast(`${text} gesendet`, 'success', null, { label: 'Rückgängig', run: async () => {
                if (!(await respond(before.response, before.note, 'zurueck'))) return;
                // Ein Hinweis, der mit der Antwort verschickt wurde, steht danach wieder als Entwurf im Feld.
                if (before.draft != null) jobNoteDrafts[item.id] = before.draft;
                toast(before.response === 'offen' ? 'Zurückgenommen. Der Auftrag wartet wieder auf deine Antwort.' : `Zurückgenommen. Es gilt wieder „${RESPONSE_LABEL[before.response]}“.`, 'success');
                await loadJobs();
            } });
            await loadJobs();
        };
        const responseButtons = () => {
            const buttons = el('div', 'job-buttons');
            RESPONSES.forEach(([value, text]) => {
                const button = el('button', 'workday-button', text);
                button.type = 'button';
                button.dataset.response = value;
                button.setAttribute('aria-pressed', String(item.response === value));
                button.addEventListener('click', async () => {
                    if (button.disabled) return;
                    button.disabled = true;
                    try { await answerWith(value, text); } finally { button.disabled = false; }
                });
                buttons.append(button);
            });
            return buttons;
        };

        // ---------- Der nächste Schritt: immer genau ein klarer Knopf – auch auf der zugeklappten Karte ----------
        const stage = declined || jobStorno(item) ? 'zu' : finished ? 'beendet' : started ? 'fertig' : answered ? 'los' : 'antwort';
        const step = el('div', 'job-step');
        step.dataset.stage = stage;
        if (stage !== 'zu') step.append(stepTrack(stage));
        if (stage === 'antwort') {
            step.append(el('span', 'job-step-title', 'Kannst du den Auftrag übernehmen?'), responseButtons());
        } else {
            const progress = jobProgress(item);
            if (progress) step.append(progress);
            else {
                // Zugesagt, aber der Termin ist erst an einem anderen Tag: „Jetzt losfahren“ kommt von selbst.
                const wait = el('div', 'job-progress job-step-wait');
                wait.dataset.state = 'warten';
                wait.append(el('span', 'job-progress-text', `${RESPONSE_LABEL[item.response]} gespeichert. „Jetzt losfahren“ erscheint hier am ${date.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' })}.`));
                step.append(wait);
            }
        }

        const rest = el('div', 'job-rest');
        // Bemerkung der Einsatzleitung („CD mitnehmen“ …) und Anhang stehen ganz oben – das soll niemand übersehen.
        const officeNote = jobOfficeNote(item);
        if (officeNote) rest.append(officeNote);
        const teamBox = jobTeamBox(item);
        if (teamBox) rest.append(teamBox);
        rest.append(details, answer);
        // Zugesagt: frühere Unterlagen zum Patienten (Berichte der Kollegen, Arztberichte, Rezepte) – zur Vorbereitung.
        const prior = priorBox(item, place);
        if (prior) rest.insertBefore(prior.node, details);
        card.append(top, step, rest);
        if (declined || jobStorno(item)) card.classList.add('is-closed');
        if (foldable) {
            card.classList.add('is-foldable');
            const patientName = parsed?.facts['Patient/in'] || parsed?.facts['Hauptpatient/in'] || '';
            if (patientName) main.append(el('span', 'job-mini-patient', patientName));
            const miniTeam = jobTeam(parseJobMessage(item.message));
            if (item.office_note || item.attachment_path || miniTeam) main.append(el('span', 'job-mini-note', [miniTeam ? `mit ${miniTeam.partner}` : '', item.office_note ? 'Hinweis der Einsatzleitung' : '', item.attachment_path ? 'Anhang' : ''].filter(Boolean).join(' · ')));
            if (jobStorno(item)) main.append(el('span', 'job-mini-state job-mini-storno', jobAlone(item) ? 'Abgeschlossen' : 'Fällt aus · abgeschlossen'));
            else if (declined) main.append(el('span', 'job-mini-state job-mini-storno', 'Abgeschlossen'));
            else if (finished) main.append(el('span', 'job-mini-state', item.finished_at ? `Beendet ${clock(item.finished_at)}` : 'Beendet'));
            else if (started) main.append(el('span', 'job-mini-state', 'Unterwegs'));
            top.append(svgSpan('job-fold-icon', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'));
            top.setAttribute('role', 'button');
            top.tabIndex = 0;
            const setOpen = open => { card.dataset.open = String(open); top.setAttribute('aria-expanded', String(open)); rest.hidden = !open; if (open) prior?.ensure(); };
            setOpen((jobOpenId === undefined ? jobAutoOpenId : jobOpenId) === item.id);
            const toggle = () => {
                const open = card.dataset.open !== 'true';
                jobOpenId = open ? item.id : '';
                card.parentElement?.querySelectorAll('.job-card.is-foldable[data-open="true"]').forEach(other => { if (other !== card) { other.dataset.open = 'false'; other.querySelector('.job-top').setAttribute('aria-expanded', 'false'); other.querySelector('.job-rest').hidden = true; } });
                setOpen(open);
                if (open) window.requestAnimationFrame(() => { const header = document.querySelector('.portal-topbar, .portal-header')?.getBoundingClientRect().bottom || 0; const y = card.getBoundingClientRect().top; if (y < header + 8 || y > window.innerHeight * 0.5) window.scrollTo({ top: window.scrollY + y - header - 12 }); });
            };
            top.addEventListener('click', toggle);
            top.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
        }
        if (!foldable) prior?.ensure();
        // Ab dem Tag des Termins: Arztbericht, Rezept oder Überweisung direkt zu diesem Auftrag fotografieren.
        if (item.date <= TerminCloud.todayIso() && item.response !== 'abgesagt') {
            const docs = el('button', 'job-docs-button');
            docs.type = 'button';
            docs.append(svgSpan('job-docs-icon', JOB_ICONS.camera), el('span', '', 'Unterlagen scannen'));
            docs.addEventListener('click', () => window.PortalDocs?.startFor(item));
            rest.append(docs);
        }
        // Selten gebraucht, deshalb ganz unten und klein: Antwort ändern / zurücknehmen – solange der Auftrag noch nicht läuft.
        if (answered && !started && !finished) {
            const change = el('div', 'job-change');
            const toggleChange = el('button', 'link-button job-change-toggle', declined ? 'Doch übernehmen? Antwort ändern …' : 'Antwort ändern …');
            toggleChange.type = 'button';
            toggleChange.setAttribute('aria-expanded', 'false');
            const panel = el('div', 'job-change-panel');
            panel.hidden = true;
            const undo = el('button', 'link-button job-answer-undo', 'Antwort zurücknehmen');
            undo.type = 'button';
            undo.addEventListener('click', async () => {
                if (!(await respond('offen', '', 'zurueck'))) return;
                toast('Antwort zurückgenommen. Der Auftrag wartet wieder auf deine Antwort.', 'success');
                await loadJobs();
            });
            panel.append(el('span', 'job-answer-title', `Deine Antwort bisher: ${RESPONSE_LABEL[item.response]}`), responseButtons(), undo);
            toggleChange.addEventListener('click', () => { panel.hidden = !panel.hidden; toggleChange.setAttribute('aria-expanded', String(!panel.hidden)); });
            change.append(toggleChange, panel);
            rest.append(change);
        }
        // Ganz unten, weil selten gebraucht: „Termin fällt aus“.
        const storno = stornoButton(item);
        if (storno) rest.append(storno);
        return card;
    }

    // ---------- „Zusage für den ganzen Tag“ ----------
    // Hat ein Tag mehrere Aufträge, die noch auf eine Antwort warten, steht über dem ersten ein Knopf: ein Tipp sagt alle zu.
    function dayTitle(date) {
        const today = TerminCloud.todayIso();
        const next = new Date(`${today}T12:00:00`); next.setDate(next.getDate() + 1);
        const tomorrow = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
        const text = new Date(`${date}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });
        return `${date === today ? 'Heute · ' : date === tomorrow ? 'Morgen · ' : ''}${text}`;
    }

    async function acceptDay(date, items, button) {
        button.disabled = true;
        const before = items.map(item => ({ id: item.id, note: item.response_note || '', draft: item.id in jobNoteDrafts ? jobNoteDrafts[item.id] : null }));
        let done = 0;
        let failure = null;
        for (const item of items) {
            // Ein schon getippter, noch nicht gesendeter Hinweis geht mit – wie bei der einzelnen Zusage.
            const note = item.id in jobNoteDrafts ? String(jobNoteDrafts[item.id]).trim() : (item.response_note || '');
            const { error } = await client.rpc('tt_respond_assignment', { p_id: item.id, p_response: 'zugesagt', p_note: note });
            if (error) { failure = error; break; }
            delete jobNoteDrafts[item.id];
            done += 1;
        }
        const day = new Date(`${date}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });
        if (done) TerminCloud.callFunction?.({ action: 'response', assignmentIds: items.slice(0, done).map(item => item.id) })?.catch?.(() => null);
        if (failure) {
            toast(done ? `${done} von ${items.length} Aufträgen zugesagt. Dann ging es nicht weiter: ${TerminCloud.germanError(failure)}` : TerminCloud.germanError(failure), 'error');
        } else {
            // Vertippt? „Rückgängig“ setzt genau diese Aufträge wieder auf „Antwort offen“.
            toast(`Zusage für ${done} Aufträge am ${day} gesendet`, 'success', null, { label: 'Rückgängig', run: async () => {
                let undone = 0;
                for (const entry of before) {
                    const { error } = await client.rpc('tt_respond_assignment', { p_id: entry.id, p_response: 'offen', p_note: entry.note });
                    if (error) {
                        toast(/unbekannte antwort/i.test(error.message || '') ? 'Zurücknehmen ist in der Datenbank noch nicht eingerichtet (Update 16). Ändere die Antwort einfach am Auftrag.' : TerminCloud.germanError(error), 'error');
                        break;
                    }
                    // Was nur getippt und mit der Zusage verschickt wurde, steht danach wieder als Entwurf im Feld.
                    if (entry.draft != null && String(entry.draft).trim() !== entry.note) jobNoteDrafts[entry.id] = entry.draft;
                    undone += 1;
                }
                jobsRendered = '';
                if (undone) toast(undone === before.length ? 'Zurückgenommen. Die Aufträge warten wieder auf deine Antwort.' : `${undone} von ${before.length} Aufträgen zurückgenommen.`, 'success');
                await loadJobs();
                renderHome();
            } });
        }
        await loadJobs();
        renderHome();
    }

    function dayBanner(date, waiting) {
        const item = el('li', 'job-day');
        item.dataset.date = date;
        const text = el('div', 'job-day-text');
        text.append(el('strong', '', dayTitle(date)), el('span', '', `${waiting.length} Aufträge warten auf deine Antwort`));
        const button = el('button', 'button-primary job-day-accept', 'Zusage für den ganzen Tag');
        button.type = 'button';
        button.addEventListener('click', () => acceptDay(date, waiting, button));
        item.append(text, button);
        return item;
    }

    async function loadJobs() {
        const { data, error } = await client.from('tt_assignments').select('*').eq('interpreter_id', profile.id).order('date', { ascending: false }).limit(200);
        if (error) { $('jobsSummary').textContent = 'Aufträge konnten nicht geladen werden.'; return; }
        // Ältere Aufträge können im Titel noch einen Zeilenumbruch aus der Terminliste tragen (Name der Praxis).
        data.forEach(item => { item.title = TerminContact.singleLine(item.title); });
        jobsData = data;
        // Nachweis über zurückgezogene Aufträge (bleibt stehen, auch wenn der Termin danach an jemand anderen ging). Ohne Update 33: leer.
        const withdrawn = await client.from('tt_withdrawals').select('*').eq('interpreter_id', profile.id).order('withdrawn_at', { ascending: false }).limit(200).then(result => (result.error ? [] : result.data || []), () => []);
        window.PortalGate?.refresh();
        if (currentView === 'vehicle') renderHomeJobs(TerminCloud.todayIso());
        const today = TerminCloud.todayIso();
        // Oben stehen kommende Aufträge – und ältere, die gestartet, aber noch nicht beendet wurden.
        const isCurrent = item => !item.cancelled && (item.date >= today || (jobStarted(item) && !jobFinished(item)));
        const upcoming = data.filter(isCurrent).sort(jobOrder);
        const open = upcoming.filter(item => item.response === 'offen').length;
        $('jobsSummary').textContent = upcoming.length
            ? `${upcoming.length} ${upcoming.length === 1 ? 'Auftrag' : 'Aufträge'}${open ? `, ${open} ${open === 1 ? 'wartet' : 'warten'} auf deine Antwort` : ''}`
            : 'Im Moment hast du keine Aufträge.';
        appBadgeOpen = open;
        setBadge('jobs', open + lateJobs().length);
        renderLateJobs();
        window.setTimeout(checkDeparture, 1200);

        // Hinweis, wenn seit dem letzten Laden ein neuer Auftrag dazugekommen ist.
        const ids = new Set(upcoming.map(item => item.id));
        if (knownJobIds && [...ids].some(id => !knownJobIds.has(id))) toast('Du hast einen neuen Auftrag.', 'success');
        knownJobIds = ids;

        // Aufgeräumt wird nur, was es nicht mehr gibt.
        const allIds = new Set(data.map(item => item.id));
        let pruned = false;
        Object.keys(jobDetailsOpen).forEach(id => { if (!allIds.has(id)) { delete jobDetailsOpen[id]; pruned = true; } });
        if (pruned) saveJobDetails();
        Object.keys(jobNoteDrafts).forEach(id => { if (!allIds.has(id)) delete jobNoteDrafts[id]; });

        // Nur neu aufbauen, wenn sich etwas geändert hat. Sonst bleibt alles, wie es ist: Position, Eingaben, Aufgeklapptes.
        const signature = JSON.stringify([today, data, withdrawn]);
        if (signature === jobsRendered) return;
        jobsRendered = signature;
        const list = $('jobList');
        const position = window.scrollY;
        const focused = document.activeElement?.closest?.('.job-card input') ? document.activeElement : null;
        const focusedId = focused?.closest('.job-card')?.dataset.id;
        const caret = focused ? [focused.selectionStart, focused.selectionEnd] : null;
        list.replaceChildren();
        // Je Tag: Warten mindestens zwei Aufträge auf eine Antwort, kommt davor „Zusage für den ganzen Tag“.
        const waitingByDate = new Map();
        upcoming.forEach(item => {
            if (item.response !== 'offen' || item.date < today || jobStarted(item) || jobFinished(item)) return;
            if (!waitingByDate.has(item.date)) waitingByDate.set(item.date, []);
            waitingByDate.get(item.date).push(item);
        });
        const many = upcoming.length >= JOB_FOLD_FROM;
        const foldable = many && !jobsFoldOff;
        const foldToggle = $('jobsFoldToggle');
        if (foldToggle) { foldToggle.hidden = !many; foldToggle.textContent = jobsFoldOff ? 'Kurz anzeigen (nur einen Auftrag aufklappen)' : 'Alle Aufträge aufklappen'; }
        // Von selbst offen: der Auftrag, der gerade läuft – sonst der nächste, der noch ansteht.
        jobAutoOpenId = (upcoming.find(item => jobStarted(item) && !jobFinished(item)) || upcoming.find(item => !jobFinished(item) && item.response !== 'abgesagt') || {}).id || '';
        if (jobOpenId && !upcoming.some(item => item.id === jobOpenId)) jobOpenId = undefined;
        let shownDate = '';
        upcoming.forEach(item => {
            if (item.date !== shownDate) {
                shownDate = item.date;
                const waiting = waitingByDate.get(item.date) || [];
                if (waiting.length >= 2) list.append(dayBanner(item.date, waiting));
            }
            list.append(jobCard(item, foldable));
        });
        if (focusedId) {
            const again = [...list.querySelectorAll('.job-card')].find(card => card.dataset.id === focusedId)?.querySelector('.job-note-row input');
            if (again) { again.focus({ preventScroll: true }); try { again.setSelectionRange(caret[0], caret[1]); } catch (error) { /* Position ist nicht wichtig */ } }
        }
        if (position && Math.abs(window.scrollY - position) > 1) window.scrollTo({ top: position, behavior: 'instant' });

        const history = $('jobHistory');
        history.replaceChildren();
        // Ins Archiv gehören vergangene und zurückgezogene Aufträge. Für Zurückgezogenes gilt der Nachweis aus der Datenbank
        // (wann, von wem, was bis dahin geantwortet war) – die bloße Zeile „zurückgezogen“ nur, wenn es keinen Nachweis gibt.
        const proofs = withdrawn.map(log => ({ id: `nachweis-${log.id}`, date: log.date, time: log.time, title: TerminContact.singleLine(log.title), cancelled: true, response: log.response, withdrawal: log }));
        const past = [...data.filter(item => !isCurrent(item) && !(item.cancelled && withdrawn.some(log => log.assignment_id === item.id))), ...proofs];
        if (!past.length) {
            const empty = document.createElement('li');
            empty.className = 'directory-empty';
            empty.textContent = 'Noch keine vergangenen Aufträge.';
            history.append(empty);
        }
        // Archiv nach Tagen: je Tag eine Zeile mit Pfeil, darin die Aufträge des Tages nach Uhrzeit.
        const summaryNode = $('jobHistorySummary');
        if (summaryNode) summaryNode.textContent = past.length ? `Archiv: frühere Aufträge (${past.length})` : 'Archiv: frühere Aufträge';
        const byDay = new Map();
        past.forEach(item => { if (!byDay.has(item.date)) byDay.set(item.date, []); byDay.get(item.date).push(item); });
        [...byDay.keys()].sort().reverse().forEach(day => {
            const items = byDay.get(day).sort(jobOrder);
            const holder = document.createElement('li');
            holder.className = 'history-day';
            const fold = document.createElement('details');
            fold.dataset.date = day;
            fold.open = historyOpen.has(day);
            fold.addEventListener('toggle', () => { if (fold.open) historyOpen.add(day); else historyOpen.delete(day); });
            const head = document.createElement('summary');
            const valid = items.filter(item => !item.cancelled).length;
            head.append(el('strong', '', new Date(`${day}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })),
                el('span', '', valid === items.length ? `${items.length} ${items.length === 1 ? 'Auftrag' : 'Aufträge'}` : `${valid} ${valid === 1 ? 'Auftrag' : 'Aufträge'} · ${items.length - valid} zurückgezogen`));
            const inner = document.createElement('ul');
            inner.className = 'directory-list portal-list';
            items.forEach(item => {
                const entry = document.createElement('li');
                entry.className = 'directory-entry damage-entry';
                const text = document.createElement('span');
                text.className = 'directory-entry-name';
                text.textContent = item.title;
                const state = document.createElement('span');
                state.className = 'status-pill';
                state.dataset.status = item.cancelled ? 'bekannt' : { offen: 'in Arbeit', zugesagt: 'erledigt', vorbehalt: 'bekannt', abgesagt: 'offen' }[item.response];
                state.textContent = item.cancelled ? 'zurückgezogen' : [RESPONSE_LABEL[item.response], WORK_LABEL[item.work_status]].filter(Boolean).join(' · ');
                entry.append(text, state);
                if (item.withdrawal) {
                    const log = item.withdrawal;
                    const at = new Date(log.withdrawn_at);
                    const why = { 'neu vergeben': log.new_interpreter_name ? 'Der Termin ging an jemand anderen.' : 'Der Termin wurde neu vergeben.', 'gelöscht': 'Der Auftrag wurde gelöscht.' }[log.reason] || '';
                    const before = [log.started_at ? 'du warst schon losgefahren' : `deine Antwort bis dahin: ${RESPONSE_LABEL[log.response] || 'keine'}`,
                        { storniert: 'der Termin war storniert', alleine: 'der Patient ging alleine' }[log.work_status] || ''].filter(Boolean).join('; ');
                    entry.classList.add('history-entry-record');
                    const proof = el('span', 'history-proof', [`Zurückgezogen am ${at.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })} um ${at.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr${log.withdrawn_by ? ` von ${log.withdrawn_by}` : ''}.`, why, `(${before})`].filter(Boolean).join(' '));
                    entry.append(proof);
                }
                // Ausgefallen oder „Patient ging alleine“: Der Auftrag war bei dir – das bleibt als Nachweis stehen (wann gemeldet, warum).
                else if (!item.cancelled && ['storniert', 'alleine'].includes(item.work_status)) {
                    const alone = item.work_status === 'alleine';
                    const at = item.storno_at ? new Date(item.storno_at) : null;
                    const note = String(item.storno_note || '').trim();
                    entry.classList.add('history-entry-record');
                    entry.append(el('span', 'history-proof', [alone ? 'Der Patient ging alleine – der Auftrag war bei dir.' : 'Der Termin fiel aus (storniert) – der Auftrag war bei dir.',
                        at ? `Von dir gemeldet am ${at.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })} um ${at.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr.` : 'Von der Einsatzleitung eingetragen.',
                        note && !/^patient geht alleine$/i.test(note) ? `Grund: ${note}` : ''].filter(Boolean).join(' ')));
                }
                // Die Akte des Patienten bleibt auch im Archiv offen (nur für eigene, zugesagte Aufträge – jeder Abruf wird festgehalten).
                if (priorWanted(item) && window.PortalRecord) {
                    const parsed = parseJobMessage(item.message);
                    const facts = parsed?.facts || {};
                    const patient = facts['Patient/in'] || facts['Hauptpatient/in'] || '';
                    const number = facts['Aktennummer'] || '';
                    if (number) {
                        entry.classList.add('history-entry-record');
                        const line = el('span', 'history-record');
                        line.append(el('span', 'history-record-who', [patient, `Akte ${number}`].filter(Boolean).join(' · ')));
                        const open = el('button', 'button-secondary history-record-open', 'Akte öffnen');
                        open.type = 'button';
                        open.addEventListener('click', () => openArchiveRecord(item, patient, open));
                        line.append(open);
                        entry.append(line);
                    }
                }
                inner.append(entry);
            });
            fold.append(head, inner);
            holder.append(fold);
            history.append(holder);
        });
    }

    // Archiv: die ganze Akte des Patienten zu einem früheren Auftrag öffnen (Berichte, Rezepte, Überweisungen, Aktennummer).
    async function openArchiveRecord(item, patientName, button) {
        button.disabled = true;
        const { data, error } = await client.rpc('tt_patient_history', { p_assignment: item.id });
        button.disabled = false;
        if (error) { toast(TerminCloud.germanError(error), 'error'); return; }
        if (!data?.allowed) { toast('Die Akte ist für diesen Auftrag nicht freigegeben. Bitte frag bei der Einsatzleitung nach.', 'info'); return; }
        if (!data.patient_nr) { toast('Zu diesem Auftrag gibt es keine Aktennummer.', 'info'); return; }
        const docs = data.documents || [];
        if (!docs.length) { toast('Zu diesem Patienten gibt es noch keine Unterlagen in der Akte.', 'info'); return; }
        const doctor = TerminContact.singleLine(parseJobMessage(item.message)?.sections.find(section => /ARZT/.test(section.title))?.fields.find(([label]) => label === 'Name')?.[1]) || '';
        window.PortalRecord.open({ docs, patientNr: data.patient_nr, patientName, jobDoctor: doctor, toast });
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
        vehicles = vehicleResult.data.filter(vehicle => vehicle.station !== 'Heidelberg');   // Fahrzeuge der Kollegen in Heidelberg (Update 41) gehören nicht hierher
        openHandovers = handoverResult.data;
        // Mehrere offene Übernahmen (z. B. eine vom Büro im Live-Tracking eingetragene ohne Kilometer): Es gilt die mit Kilometerstand, sonst die neueste.
        myHandover = openHandovers.filter(item => item.driver_id === profile.id)
            .sort((left, right) => (Number(right.start_mileage != null) - Number(left.start_mileage != null)) || String(right.created_at || '').localeCompare(String(left.created_at || '')))[0] || null;
        const myVehicle = myHandover ? vehicleById(myHandover.vehicle_id) : null;
        const fixedVehicle = vehicles.find(vehicle => vehicle.assigned_to === profile.id) || null;
        const free = freeVehicles();

        $('noVehicle').hidden = Boolean(myHandover);
        $('hasVehicle').hidden = !myHandover;

        if (myHandover) {
            $('heroPlate').textContent = myVehicle?.plate || 'Fahrzeug';
            $('heroModel').textContent = myVehicle ? [myVehicle.brand, myVehicle.body, myVehicle.type].filter(Boolean).join(' · ') : '';
            const sinceDay = myHandover.date === TerminCloud.todayIso() ? 'heute' : new Date(`${myHandover.date}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
            $('heroSince').textContent = `übernommen ${sinceDay} um ${String(myHandover.start_time).slice(0, 5)} Uhr${myHandover.emergency ? ' · Notdienst' : keepsOvernight(myHandover) ? ' · bleibt über Nacht' : ''}`;
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
            $('damagePreviousRow').hidden = !myHandover.previous_driver_id;
            $('damagePreviousName').textContent = myHandover.previous_driver_name || 'unbekannt';
            $('alertVehicleLabel').textContent = `${label} – Warnleuchte oder Hinweis im Display.`;
            loadHeroDamages();
        } else {
            $('myVehicleInfo').textContent = !vehicles.length ? 'Es sind noch keine Fahrzeuge angelegt.'
                : !free.length ? 'Im Moment ist kein Fahrzeug frei.'
                : fixedVehicle && free.includes(fixedVehicle) ? `Dein festes Fahrzeug ${fixedVehicle.plate} ist frei.`
                : `${free.length} ${free.length === 1 ? 'Fahrzeug ist' : 'Fahrzeuge sind'} frei.`;
            $('startTake').disabled = !free.length;
        }

        // Ab 16 Uhr erinnern, wenn das Auto noch nicht zurückgegeben ist (außer im Notdienst oder „über Nacht behalten“).
        const overdue = myHandover && !myHandover.emergency && !keepsOvernight(myHandover) && (new Date().getHours() >= 16 || myHandover.date < TerminCloud.todayIso());
        $('returnReminder').hidden = !overdue;
        $('returnReminder').textContent = overdue ? 'Bitte gib dein Fahrzeug zurück, wenn du fertig bist.' : '';
        renderKeep();
        loadReturnNotes();
        // Unterseiten für Schaden, Meldung und Rückgabe gibt es nur mit Fahrzeug.
        if (NEEDS_VEHICLE.includes(currentView) && !myHandover) goTo('vehicle');
    }

    // ---------- Mein Fahrzeug antippen: Standort und Details – auch nach der Übernahme ----------
    async function openCarDetails() {
        if (!myHandover) return;
        const vehicle = vehicleById(myHandover.vehicle_id);
        const dialog = $('carDialog');
        $('carDialogTitle').textContent = vehicle?.plate || 'Fahrzeug';
        $('carDialogModel').textContent = vehicle ? [vehicle.brand, vehicle.body, vehicle.type, vehicle.label].filter(Boolean).join(' · ') : '';
        $('carDialogPlace').textContent = vehicle?.parking || 'nicht eingetragen';
        $('carDialogPlaceNote').textContent = vehicle?.parking
            ? 'Dort stand das Auto, als du es übernommen hast. Bei der Rückgabe trägst du ein, wo du es abstellst.'
            : 'Der letzte Fahrer hat keinen Parkort eingetragen. Bei der Rückgabe trägst du ein, wo du es abstellst.';
        const sinceDay = myHandover.date === TerminCloud.todayIso() ? 'heute' : new Date(`${myHandover.date}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
        fillStateList($('carDialogList'), [
            ['Übernommen', `${sinceDay} um ${String(myHandover.start_time).slice(0, 5)} Uhr`],
            ['Kilometer bei Übernahme', formatKm(myHandover.start_mileage)],
            ['Tank bei Übernahme', vehicle?.fuel == null ? 'unbekannt' : FUEL[vehicle.fuel]],
            ['Letzter Fahrer', myHandover.previous_driver_name || 'unbekannt'],
            ['Innen', cleanText(vehicle?.clean_inside)],
            ['Außen', cleanText(vehicle?.clean_outside)],
            ['Rückgabe', myHandover.emergency ? 'Notdienst – bleibt bei dir bis zur Rückgabe' : keepsOvernight(myHandover) ? 'bleibt über Nacht bei dir' : 'heute, wenn du fertig bist']
        ]);
        $('carDialogDamages').textContent = 'Bekannte Schäden werden geladen …';
        if (!dialog.open) dialog.showModal();
        try {
            const current = await currentDamages(myHandover.vehicle_id);
            $('carDialogDamages').textContent = current.length
                ? `${current.length} ${current.length === 1 ? 'Schaden ist' : 'Schäden sind'} für dieses Auto eingetragen.`
                : 'Für dieses Auto ist kein Schaden eingetragen.';
        } catch (error) {
            $('carDialogDamages').textContent = '';
        }
    }
    $('heroCard')?.addEventListener('click', openCarDetails);
    $('carDialogClose')?.addEventListener('click', () => $('carDialog').close());
    $('carDialogDamage')?.addEventListener('click', () => { $('carDialog').close(); goTo('damage'); });
    $('carDialog')?.addEventListener('click', event => { if (event.target === $('carDialog')) $('carDialog').close(); });

    // ---------- Auto über Nacht behalten ----------
    // Früher Termin (alle): nur diese Nacht – am nächsten Tag gilt es noch bis 16 Uhr, danach erinnert das Portal wieder.
    // Notdienst / Bereitschaft (nur Festangestellte): bis zur Rückgabe.
    function keepsOvernight(handover) { return TerminCloud.keepsOvernight(handover); }
    function renderKeep() {
        if (!myHandover) return;
        const kept = keepsOvernight(myHandover);
        const active = Boolean(myHandover.emergency) || kept;
        $('keepState').hidden = !active;
        $('keepButton').hidden = active;
        if (!active) return;
        const tomorrow = myHandover.keep_until > TerminCloud.todayIso();
        $('keepStateText').textContent = myHandover.emergency
            ? 'Notdienst / Bereitschaft: Das Auto bleibt bei dir, bis du es zurückgibst. Es kommt keine Erinnerung.'
            : `Das Auto bleibt über Nacht bei dir – früher Termin${tomorrow ? ' morgen' : ' heute'}. Bis ${tomorrow ? 'morgen' : 'heute'} 16 Uhr kommt keine Erinnerung an die Rückgabe.`;
        $('keepUndo').textContent = myHandover.emergency ? 'Notdienst beenden' : 'Doch nicht über Nacht behalten';
    }
    async function setKeep(reason, node) {
        if (node) node.disabled = true;
        const { data, error } = await client.rpc('tt_keep_vehicle', { p_reason: reason });
        if (node) node.disabled = false;
        if (error) {
            toast(/tt_keep_vehicle|schema cache|could not find/i.test(error.message || '')
                ? 'Das ist in der Datenbank noch nicht eingerichtet (Update 19). Bitte sag der Einsatzleitung Bescheid.'
                : TerminCloud.germanError(error), 'error');
            return;
        }
        if ($('keepDialog').open) $('keepDialog').close();
        if (data && myHandover) Object.assign(myHandover, data);
        // Mitteilung an die Einsatzleitung, klar getrennt von den Terminen.
        TerminCloud.callFunction?.({ action: 'vehicle', kind: 'keep' })?.catch?.(() => null);
        // Wer das Auto über Nacht behält, kommt heute nicht mehr ins Büro – das weiß dann auch die Pforte (Update 46).
        window.PortalGate?.markAway?.(reason === 'notdienst' ? 'bereitschaft' : reason === 'frueh' ? 'frueh' : '', 'Auto bleibt über Nacht')?.catch?.(() => null);
        toast(reason === 'notdienst' ? 'Notdienst eingetragen – das Auto bleibt bei dir.'
            : reason === 'frueh' ? 'Eingetragen – das Auto bleibt über Nacht bei dir.'
            : 'Zurückgenommen – bitte gib das Auto heute zurück.', 'success');
        await loadFleet();
    }
    $('keepButton').addEventListener('click', () => {
        const fest = isFest();
        $('keepDialogHint').textContent = fest
            ? 'Warum bleibt das Auto über Nacht bei dir? Die Einsatzleitung bekommt eine Mitteilung.'
            : 'Das geht nur, wenn du morgen einen frühen Termin hast. Die Einsatzleitung bekommt eine Mitteilung.';
        const options = fest
            ? [['notdienst', 'Notdienst / Bereitschaft', 'bis ich das Auto zurückgebe'], ['frueh', 'Früher Termin morgen', 'nur diese Nacht']]
            : [['frueh', 'Ja – früher Termin morgen', 'nur diese Nacht']];
        $('keepChoices').replaceChildren(...options.map(([reason, label, small]) => {
            const button = el('button', 'choice-button keep-choice');
            button.type = 'button';
            button.dataset.reason = reason;
            const text = el('span', '');
            text.append(el('strong', '', label), el('small', '', small));
            button.append(text);
            button.addEventListener('click', () => setKeep(reason, button));
            return button;
        }));
        $('keepDialog').showModal();
    });
    $('keepCancel').addEventListener('click', () => $('keepDialog').close());
    $('keepUndo').addEventListener('click', () => setKeep('', $('keepUndo')));

    function freeVehicles() {
        const taken = new Set(openHandovers.map(item => item.vehicle_id));
        // Das eigene feste Fahrzeug steht oben, danach diplomatische Fahrzeuge, dann Mietwagen.
        const rank = vehicle => vehicle.assigned_to === profile.id ? 0 : vehicle.type === 'Diplomatisch' ? 1 : vehicle.type === 'Mietwagen' ? 2 : 3;
        // Fest reservierte Fahrzeuge sieht nur die Person, für die sie reserviert sind – mit Namen ohne Konto (driver_note, Update 47) niemand.
        const mine = vehicle => vehicle.assigned_to ? vehicle.assigned_to === profile.id : !String(vehicle.driver_note || '').trim();
        // Fahrzeuge in der Werkstatt oder gesperrte werden gar nicht erst angeboten.
        return vehicles.filter(vehicle => !taken.has(vehicle.id) && mine(vehicle) && !vehicle.service_status).sort((left, right) => rank(left) - rank(right) || String(left.plate).localeCompare(String(right.plate), 'de'));
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

    // Meldung über den Vorfahrer (Update 42): Fotos hochladen, Eintrag anlegen, Mitteilung an Vorfahrer und Einsatzleitung.
    async function sendDriverNote({ handoverId = null, damageId = null, kind, text, files = [], paths = null }) {
        try {
            const photoPaths = paths || [];
            if (!paths) for (const file of files) photoPaths.push(await TerminCloud.uploadPhoto(file, profile.id));
            const { data, error } = await client.from('tt_driver_notes').insert({ handover_id: handoverId, damage_id: damageId, kind, text, photo_paths: photoPaths }).select().maybeSingle();
            if (error) {
                if (/does not exist|schema cache|relation|PGRST205/i.test(`${error.code || ''} ${error.message || ''}`)) return;   // Update 42 fehlt noch: nur der Hinweis an der Übergabe bleibt
                throw error;
            }
            TerminCloud.callFunction?.({ action: 'driverNote', noteId: data?.id })?.catch?.(() => null);
            toast(`Meldung an ${data?.driver_name || 'den letzten Fahrer'} und die Einsatzleitung gesendet.`, 'success');
        } catch (error) { toast(`Die Meldung an den letzten Fahrer ging nicht hinaus: ${TerminCloud.germanError(error)}`, 'error'); }
    }
    const DRIVER_NOTE_KIND = { unsauber: 'Nicht sauber', tank: 'Tank fast leer', schaden: 'Neuer Schaden', hinweis: 'Hinweis' };
    let driverNoteData = [];
    const unseenDriverNotes = () => driverNoteData.filter(item => !item.seen_at && !item.archived_at);
    async function loadDriverNotes() {
        const box = $('driverNotesBox');
        if (!box) return;
        const { data, error } = await client.from('tt_driver_notes').select('*').eq('driver_id', profile.id).order('created_at', { ascending: false }).limit(30);
        driverNoteData = error ? [] : (data || []);
        box.hidden = !driverNoteData.length;
        const list = $('driverNotesList');
        list.replaceChildren(...driverNoteData.map(item => {
            const entry = el('li', 'directory-entry damage-entry driver-note');
            entry.dataset.kind = item.kind;
            entry.dataset.seen = item.seen_at ? 'ja' : '';
            const main = el('div', 'driver-note-main');
            main.append(el('strong', '', `${DRIVER_NOTE_KIND[item.kind] || 'Hinweis'} · ${item.plate || 'Fahrzeug'}`),
                el('span', 'driver-note-meta', `${new Date(item.created_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })} ${clock(item.created_at)} Uhr · gemeldet von ${item.reporter_name || 'dem nächsten Fahrer'}`),
                el('p', 'driver-note-text', item.text ? `„${item.text}“` : ''));
            const photos = Array.isArray(item.photo_paths) ? item.photo_paths : [];
            if (photos.length) {
                const row = el('div', 'driver-note-photos');
                photos.forEach((path, index) => {
                    const open = el('button', 'button-secondary', photos.length > 1 ? `Foto ${index + 1}` : 'Foto');
                    open.type = 'button';
                    open.addEventListener('click', async () => { const url = await TerminCloud.photoUrl(path); if (!url) { toast('Das Foto konnte nicht geladen werden.', 'error'); return; } window.ScanCam?.look ? ScanCam.look({ url, title: `Foto ${index + 1}` }) : window.open(url, '_blank', 'noopener'); });
                    row.append(open);
                });
                main.append(row);
            }
            entry.append(main);
            if (item.archived_at) {
                // Update 50: Das Büro hat die Meldung geprüft und dir nicht zugeordnet – sie zählt nicht für dich.
                entry.dataset.seen = 'ja';
                entry.dataset.cleared = 'ja';
                entry.append(el('span', 'status-pill driver-note-cleared', 'geprüft – nicht dir zugeordnet'));
            } else if (!item.seen_at) {
                const seen = el('button', 'button-primary driver-note-seen', 'Gesehen');
                seen.type = 'button';
                seen.addEventListener('click', async () => {
                    seen.disabled = true;
                    const { error: seenError } = await client.from('tt_driver_notes').update({ seen_at: new Date().toISOString() }).eq('id', item.id);
                    if (seenError) { seen.disabled = false; toast(TerminCloud.germanError(seenError), 'error'); return; }
                    await loadDriverNotes();
                    renderHome();
                });
                entry.append(seen);
            } else entry.append(el('span', 'status-pill', 'gesehen'));
            return entry;
        }));
    }

    // Hinweise der Nachfolger zu den eigenen Rückgaben ("Tank war leer …").
    async function loadReturnNotes() {
        await loadDriverNotes();
        const list = $('returnNotes');
        const { data, error } = await client.from('tt_handovers').select('*').eq('previous_driver_id', profile.id).order('created_at', { ascending: false }).limit(20);
        list.replaceChildren();
        if (error) return;
        // Was schon als Meldung (mit Fotos und „Gesehen“) oben steht, erscheint hier nicht noch einmal.
        data.filter(item => item.start_note && !driverNoteData.some(note => note.handover_id === item.id)).slice(0, 3).forEach(item => {
            const entry = el('li', 'directory-entry damage-entry');
            entry.append(el('span', 'directory-entry-name', `Hinweis zu deiner Rückgabe (${vehicleById(item.vehicle_id)?.plate || 'Fahrzeug'}, ${new Date(item.created_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}): „${item.start_note}“ – ${item.driver_name}`));
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
    // Bei vielen freien Fahrzeugen wählt man zuerst die Art („Diplomatisch“ oder „Mietwagen“) – so bleibt die Liste kurz.
    // Die zuletzt gewählte Art ist beim nächsten Mal schon eingestellt.
    const takeTypeKey = () => `terminTool.portal.takeType.${profile?.id || ''}`;      // je Konto, falls sich zwei ein Handy teilen
    const TAKE_TYPES = ['Diplomatisch', 'Mietwagen'];
    const TAKE_TYPE_FROM = 6;          // ab so vielen freien Fahrzeugen (ohne das eigene feste) wird nach der Art gefragt
    const takeTypeOf = vehicle => vehicle.type === 'Mietwagen' ? 'Mietwagen' : 'Diplomatisch';
    let takeType = '';                 // gewählte Art; '' = noch keine
    let takeChoice = false;            // true: Die Art muss gewählt werden, bevor die Liste erscheint

    function applyTakeFilter() {
        const query = $('takeSearch').value.toLocaleLowerCase('de-DE').replace(/[\s-]/g, '');
        let shown = 0;
        $('takeCars').querySelectorAll('.car-card').forEach(card => {
            // Die Suche nach dem Kennzeichen findet jedes freie Auto – egal welche Art gerade gewählt ist.
            const byType = !takeChoice || card.dataset.own === '1' || card.dataset.type === takeType;
            card.hidden = query ? !card.dataset.search.includes(query) : !byType;
            if (!card.hidden) shown += 1;
        });
        $('takeNoMatch').hidden = !query || shown > 0;
        $('takeChoose').hidden = Boolean(query) || !takeChoice || Boolean(takeType);
        $('takeTypes').querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(!query && button.dataset.type === takeType)));
    }

    function startTake() {
        take.vehicle = null;
        $('takeVehicleForm').reset();
        $('takeStartNote').value = '';
        $('takeNotePhoto').value = ''; showTakeNotePicks?.();
        document.querySelectorAll('input[name="takeNoteKind"]').forEach(input => { input.checked = false; });
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
            card.dataset.search = `${vehicle.plate} ${vehicle.brand} ${vehicle.body}`.toLocaleLowerCase('de-DE').replace(/[\s-]/g, '');
            card.dataset.type = takeTypeOf(vehicle);
            if (vehicle.assigned_to === profile.id) card.dataset.own = '1';
            card.addEventListener('click', () => chooseTakeVehicle(vehicle));
            list.append(card);
        });
        // Art wählen: nur wenn es von beiden Arten freie Autos gibt und die Liste sonst lang wäre.
        const others = free.filter(vehicle => vehicle.assigned_to !== profile.id);
        const counts = Object.fromEntries(TAKE_TYPES.map(type => [type, others.filter(vehicle => takeTypeOf(vehicle) === type).length]));
        takeChoice = TAKE_TYPES.every(type => counts[type] > 0) && others.length >= TAKE_TYPE_FROM;
        let remembered = '';
        try { remembered = localStorage.getItem(takeTypeKey()) || ''; } catch (error) { /* dann wird jedes Mal gefragt */ }
        takeType = takeChoice && TAKE_TYPES.includes(remembered) ? remembered : '';
        const types = $('takeTypes');
        types.hidden = !takeChoice;
        types.replaceChildren(...(takeChoice ? TAKE_TYPES : []).map(type => {
            const button = el('button', 'car-type');
            button.type = 'button';
            button.dataset.type = type;
            button.append(el('strong', '', type), el('span', '', `${counts[type]} frei`));
            button.addEventListener('click', () => {
                takeType = type;
                try { localStorage.setItem(takeTypeKey(), type); } catch (error) { /* gilt dann nur für dieses Mal */ }
                $('takeSearch').value = '';
                applyTakeFilter();
            });
            return button;
        }));
        // Bei vielen Fahrzeugen hilft ein Suchfeld: Kennzeichen eintippen, die Liste wird sofort kürzer.
        $('takeSearch').value = '';
        $('takeSearchRow').hidden = free.length < 7;
        applyTakeFilter();
        takeWizard.show(1);
    }
    $('takeSearch').addEventListener('input', applyTakeFilter);

    async function chooseTakeVehicle(vehicle) {
        take.vehicle = vehicle;
        $('takeCarLabel').textContent = vehicleLabel(vehicle);
        fillStateList($('takeStateList'), [
            ['Letzter Fahrer', vehicle.state_updated_at ? `${vehicle.state_updated_by || 'unbekannt'}, ${new Date(vehicle.state_updated_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : 'noch keine Angaben'],
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
    const takeNoteKinds = () => [...document.querySelectorAll('input[name="takeNoteKind"]:checked')].map(input => input.value);
    const TAKE_KIND_TEXT = { unsauber_innen: 'innen nicht sauber', unsauber_aussen: 'außen nicht sauber', tank: 'Tank fast leer', schaden: 'neuer Schaden' };
    $('takeNoteNext').addEventListener('click', () => {
        if (!$('takeStartNote').value.trim() && !takeNoteKinds().length) { toast('Bitte wähle aus, was nicht stimmt, oder schreib es kurz.', 'error', '#takeStartNote'); $('takeStartNote').focus(); return; }
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
            const kinds = takeNoteKinds();
            const noteText = [kinds.map(kind => TAKE_KIND_TEXT[kind]).join(', '), $('takeStartNote').value.trim()].filter(Boolean).join(' – ');
            const { data: handover, error } = await client.rpc('tt_take_vehicle', {
                p_vehicle: take.vehicle.id, p_mileage: Number($('takeVehicleMileage').value), p_note: 'Im Portal übernommen',
                p_emergency: isFest() && $('takeEmergency').checked, p_start_note: noteText
            });
            if (error) {
                $('takeMileageError').hidden = false;
                $('takeMileageError').textContent = TerminCloud.germanError(error);
                return;
            }
            const plate = take.vehicle.plate;
            // Etwas stimmt nicht: Meldung mit Fotos an den letzten Fahrer und die Einsatzleitung – bleibt in seiner Akte (Update 42).
            if (noteText && handover?.previous_driver_id) await sendDriverNote({ handoverId: handover.id, kind: kinds.includes('schaden') ? 'schaden' : kinds.some(kind => /unsauber/.test(kind)) ? 'unsauber' : kinds.includes('tank') ? 'tank' : 'hinweis', text: noteText, files: [...($('takeNotePhoto').files || [])].slice(0, 3) });
            // Eigene Mitteilung „FAHRZEUG · übernommen“ an die Einsatzleitung (falls dort eingeschaltet).
            TerminCloud.callFunction?.({ action: 'vehicle', kind: 'take' })?.catch?.(() => null);
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
            const args = { p_mileage: back.mileage, p_fuel: back.fuel, p_parking: back.parking, p_clean_inside: back.inside, p_clean_outside: back.outside };
            // Genau die gezeigte Übernahme zurückgeben (Update 48) – ohne das Update kennt die Datenbank p_handover noch nicht.
            let { error } = await client.rpc('tt_return_vehicle', { ...args, p_handover: myHandover?.id || null });
            if (error && /could not find the function|p_handover/i.test(error.message || '')) ({ error } = await client.rpc('tt_return_vehicle', args));
            if (error) {
                const message = TerminCloud.germanError(error);
                // Klappt die Rückgabe nicht, kann die Person direkt um Hilfe bitten – als Eilmeldung an die Einsatzleitung (Update 49).
                toast(message, 'error', null, { label: 'Hilfe anfragen', run: () => openHelpSheet({ kind: 'hilfe', text: `Ich kann das Fahrzeug nicht zurückgeben. Meldung: ${message}` }) });
                if (/kilometer/i.test(error.message || '')) returnWizard.show(1);
                return;
            }
            const plate = myHandover ? vehicleById(myHandover.vehicle_id)?.plate : '';
            const taken = myHandover;
            TerminCloud.callFunction?.({ action: 'vehicle', kind: 'return' })?.catch?.(() => null);
            await loadFleet();
            await showSuccess(`${plate || 'Fahrzeug'} zurückgegeben`, 'Danke!');
            goTo('vehicle');
            // Festangestellte: Nach der Rückgabe gleich die Überstunden eintragen (vor 9 Uhr angefangen / nach 16 Uhr fertig / Wochenende).
            if (isFest()) await askOvertimeAfterReturn(taken);
        } finally {
            button.disabled = false;
        }
    });

    // ---------- Hilfe / Korrektur anfragen: Eilmeldung an die Einsatzleitung (Update 49) ----------
    // Etwas klappt nicht (z. B. Auto lässt sich nicht zurückgeben) oder etwas ist falsch eingetragen: Die Person schreibt kurz, was los ist.
    // Die Nachricht landet als EILMELDUNG bei Einsatzleitung und Sekretariat (Handy + rotes Band in allen Büro-Seiten, bis gelesen).
    const HELP_KINDS = [['hilfe', 'Technisches Problem', 'etwas klappt nicht – z. B. Auto lässt sich nicht zurückgeben'], ['korrektur', 'Korrektur anfragen', 'etwas ist falsch eingetragen – Zeit, Auto, Termin']];
    function helpContext() {
        const car = myHandover ? vehicleById(myHandover.vehicle_id) : null;
        return [car ? `Fahrzeug: ${car.plate}` : 'kein Fahrzeug übernommen', lastErrorText ? `Letzte Meldung der App: ${lastErrorText}` : ''].filter(Boolean).join(' · ');
    }
    function openHelpSheet(preset = {}) {
        const dialog = el('dialog', 'confirm-dialog gate-sheet help-sheet');
        dialog.setAttribute('aria-labelledby', 'helpTitle');
        const title = el('h2', '', 'Hilfe oder Korrektur anfragen');
        title.id = 'helpTitle';
        const hint = el('p', 'field-hint', 'Geht sofort als Eilmeldung an die Einsatzleitung. Schreib kurz, was nicht klappt oder was falsch eingetragen ist.');
        let chosen = preset.kind === 'korrektur' ? 'korrektur' : 'hilfe';
        const choices = el('div', 'gate-sheet-choices');
        const buttons = HELP_KINDS.map(([kind, label, small]) => {
            const choice = el('button', 'choice-button gate-away-choice help-choice');
            choice.type = 'button';
            choice.dataset.kind = kind;
            choice.setAttribute('aria-pressed', String(kind === chosen));
            const text = el('span', '');
            text.append(el('strong', '', label), el('small', '', small));
            choice.append(text);
            choice.addEventListener('click', () => { chosen = kind; buttons.forEach(item => item.setAttribute('aria-pressed', String(item.dataset.kind === chosen))); body.focus(); });
            return choice;
        });
        choices.append(...buttons);
        const label = el('label', 'field-label', 'Was ist los?');
        label.htmlFor = 'helpText';
        const body = el('textarea');
        body.id = 'helpText'; body.rows = 4; body.maxLength = 1500; body.placeholder = 'zum Beispiel: Die Rückgabe springt immer zurück zu Schritt 1.';
        body.value = preset.text || '';
        const context = el('p', 'help-context', helpContext());
        const status = el('p', 'gate-sheet-status');
        status.setAttribute('role', 'alert');
        const bar = el('div', 'modal-buttons');
        const cancel = el('button', 'button-secondary', 'Abbrechen');
        cancel.type = 'button';
        const ok = el('button', 'button-primary', 'Eilmeldung senden');
        ok.type = 'button';
        ok.id = 'helpSend';
        bar.append(cancel, ok);
        dialog.append(title, hint, choices, label, body, context, status, bar);
        document.body.append(dialog);
        cancel.addEventListener('click', () => dialog.close());
        dialog.addEventListener('close', () => dialog.remove());
        ok.addEventListener('click', async () => {
            const text = body.value.trim();
            if (text.length < 5) { status.textContent = 'Bitte schreib kurz, was los ist.'; body.focus(); return; }
            ok.disabled = true;
            const sent = await sendHelp(chosen, text);
            ok.disabled = false;
            if (sent) { dialog.close(); toast('Eilmeldung gesendet – die Einsatzleitung bekommt sie sofort.', 'success'); }
            else status.textContent = 'Nicht gesendet. Bitte noch einmal versuchen – oder ruf im Büro an.';
        });
        dialog.showModal();
        body.focus();
    }
    async function sendHelp(kind, text) {
        const full = `${text}\n\n(${helpContext()})`.slice(0, 2000);
        const row = { thread_id: profile.id, sender_id: profile.id, sender_name: profile.full_name || '', from_staff: false, body: full };
        let result = await client.from('tt_chat').insert({ ...row, urgent: true, kind }).select('id').single();
        // Ohne Update 49 kennt die Datenbank die Eilmeldung noch nicht: dann als normale Nachricht mit Kennzeichnung im Text.
        if (result.error && /urgent|kind/i.test(result.error.message || '')) result = await client.from('tt_chat').insert({ ...row, body: `EILMELDUNG (${kind === 'korrektur' ? 'Korrektur anfragen' : 'Hilfe'}): ${full}`.slice(0, 2000) }).select('id').single();
        if (result.error) { toast(`Nicht gesendet: ${TerminCloud.germanError(result.error)}`, 'error'); return false; }
        TerminCloud.callFunction?.({ action: 'chat', chatId: result.data.id })?.catch?.(() => null);
        return true;
    }
    $('helpOpen')?.addEventListener('click', () => openHelpSheet());
    window.PortalHelp = { open: openHelpSheet };

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
            // Der Schaden war schon da: Meldung an den letzten Fahrer (mit denselben Fotos) – bleibt in seiner Akte (Update 42).
            if ($('damagePrevious').checked && myHandover.previous_driver_id) {
                const { data: fresh } = await client.from('tt_damages').select('id').eq('vehicle_id', myHandover.vehicle_id).eq('reporter_id', profile.id).order('created_at', { ascending: false }).limit(1).maybeSingle();
                await sendDriverNote({ handoverId: myHandover.id, damageId: fresh?.id || null, kind: 'schaden', text: `${category}${description ? ` – ${description}` : ''} (bei der Übernahme vorgefunden)`, paths });
            }
            $('damagePrevious').checked = false;
            $('damageDescription').value = '';
            $('damagePhoto').value = '';
            showDamagePicks();
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
            entry.append(el('span', 'directory-entry-name', `${item.kind}${item.note ? ` – ${item.note}` : ''} · ${new Date(item.created_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`), state);
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

    // Gewählte Fotos (Schaden, Meldung im Auto) als kleine Bilder unter dem Feld: antippen = groß ansehen, × = wieder entfernen.
    function photoPicks(input, name) {
        const box = el('div', 'request-photos pick-photos');
        input.after(box);
        let urls = [];
        const removeAt = index => {
            const rest = new DataTransfer();
            [...input.files].forEach((file, at) => { if (at !== index) rest.items.add(file); });
            input.files = rest.files;
            render();
        };
        function render() {
            urls.forEach(url => URL.revokeObjectURL(url));
            urls = [];
            box.replaceChildren(...[...(input.files || [])].map((file, index) => {
                const url = URL.createObjectURL(file);
                urls.push(url);
                const wrap = el('span', 'request-thumb');
                const image = el('img');
                image.src = url;
                image.alt = `${name} ${index + 1}`;
                const open = el('button', 'request-thumb-open');
                open.type = 'button';
                open.setAttribute('aria-label', `${name} ${index + 1} groß ansehen`);
                open.addEventListener('click', async () => { if (await window.ScanCam?.look?.({ url, title: `${name} ${index + 1}`, removeLabel: 'Entfernen' }) === 'remove') removeAt([...input.files].indexOf(file)); });
                open.append(image);
                wrap.append(open);
                if (typeof DataTransfer === 'function') {
                    const remove = el('button', 'request-thumb-remove', '×');
                    remove.type = 'button';
                    remove.setAttribute('aria-label', `${name} ${index + 1} entfernen`);
                    remove.addEventListener('click', () => removeAt([...input.files].indexOf(file)));
                    wrap.append(remove);
                }
                return wrap;
            }));
        }
        input.addEventListener('change', render);
        input.form?.addEventListener('reset', () => window.setTimeout(render));
        return render;
    }
    const showDamagePicks = photoPicks($('damagePhoto'), 'Foto');
    const showTakeNotePicks = photoPicks($('takeNotePhoto'), 'Foto');
    photoPicks($('alertPhoto'), 'Foto');

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
            if (item.printed_at) side.prepend(el('span', 'status-pill receipt-printed', 'gedruckt'));
            entry.append(el('span', 'directory-entry-name', `${new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })} · ${item.place} · ${money(item.amount)}`), side);
            list.append(entry);
        });
    }

    // ---------- Alle Belege eines Monats als eine PDF-Datei ----------
    // Deckblatt (Datum, Ort, Art, Betrag, Stand, Summe) und dahinter jeder Beleg als Seite – zum Drucken oder Weiterschicken.
    function fillBundleMonths() {
        const select = $('receiptBundleMonth');
        if (!select || select.options.length) return;
        const now = new Date();
        for (let back = 0; back < 6; back++) {
            const date = new Date(now.getFullYear(), now.getMonth() - back, 1);
            const option = el('option', '', date.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }));
            option.value = isoDate(date).slice(0, 7);
            select.append(option);
        }
    }
    async function bundleReceipts(button) {
        const month = $('receiptBundleMonth').value;
        const kind = $('receiptBundleKind').value;
        const status = $('receiptBundleStatus');
        const monthName = new Date(`${month}-01T12:00:00`).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
        const kindName = kind === 'Parken' ? 'Parkbelege' : kind === 'Tanken' ? 'Tankbelege' : 'Park- und Tankbelege';
        button.disabled = true;
        status.textContent = 'Belege werden gesammelt …';
        try {
            const from = `${month}-01`;
            const end = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0);
            let query = client.from('tt_receipts').select('*').eq('profile_id', profile.id).gte('date', from).lte('date', isoDate(end)).order('date');
            if (kind) query = query.eq('kind', kind);
            const { data, error } = await query;
            if (error) throw error;
            const found = (data || []).filter(item => item.status !== 'abgelehnt');
            if (!found.length) { status.textContent = `Für ${monthName} gibt es keine ${kindName}.`; return; }
            // Vorschau: Was soll in die PDF? Belege, die man im Original hat, nimmt man heraus.
            status.textContent = 'Bitte auswählen, was in die PDF soll …';
            const shortDate = item => new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
            const chosen = await DocPdf.pick({
                title: `${kindName} ${monthName} – was soll in die PDF?`,
                hint: 'Hake ab, was in die PDF soll. Belege, die du im Original hast, nimm heraus – sie bleiben in der App gespeichert. Schon gedruckte Belege sind nicht angehakt.',
                rows: found.map(item => ({ id: item.id, label: `${shortDate(item)} · ${item.place || '–'} · ${item.kind}`, sub: item.status === 'geprüft' ? 'geprüft' : item.status, note: item.printed_at ? 'schon gedruckt' : (item.photo_path ? '' : 'ohne Foto'), amount: money(item.amount), checked: !item.printed_at })),
                confirm: 'PDF erstellen',
                sumOf: ids => money(found.filter(item => ids.includes(String(item.id))).reduce((total, item) => total + Number(item.amount), 0))
            });
            if (!chosen) { status.textContent = ''; return; }
            const list = found.filter(item => chosen.includes(String(item.id)));
            if (!list.length) { status.textContent = ''; return; }
            const items = [];
            for (const [index, item] of list.entries()) {
                status.textContent = `Beleg ${index + 1} von ${list.length} wird geladen …`;
                const label = `${new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })} · ${item.place || ''} · ${money(item.amount)} · ${item.kind}${item.status === 'geprüft' ? ' · geprüft' : ''}`;
                let bytes = null;
                let contentType = '';
                if (item.photo_path) {
                    const url = await TerminCloud.photoUrl(item.photo_path);
                    if (url) {
                        const response = await fetch(url).catch(() => null);
                        if (response?.ok) { bytes = await response.arrayBuffer(); contentType = response.headers.get('content-type') || (/\.pdf$/i.test(item.photo_path) ? 'application/pdf' : 'image/jpeg'); }
                    }
                }
                items.push(bytes ? { label, bytes, contentType } : { label, bytes: new ArrayBuffer(0), contentType: 'fehlt' });
            }
            status.textContent = 'PDF wird erstellt …';
            const sum = list.reduce((total, item) => total + Number(item.amount), 0);
            const stateText = { eingereicht: 'eingereicht', 'geprüft': 'geprüft', abgelehnt: 'abgelehnt' };
            const blob = await DocPdf.bundle({
                title: `${kindName} ${monthName}`,
                subtitle: `${profile.full_name || ''} · ${list.length} ${list.length === 1 ? 'Beleg' : 'Belege'} · erstellt am ${new Date().toLocaleDateString('de-DE')}`,
                rows: list.map(item => [new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }), item.place || '–', item.kind, money(item.amount), stateText[item.status] || item.status]),
                total: `Summe ${money(sum)}`,
                items, author: profile.full_name || '', subject: `${kindName} ${monthName}`, keywords: ['Belege', kindName, month]
            });
            const name = `${kindName.replace(/[^A-Za-z]+/g, '-').replace(/-+/g, '-')}_${month}_${(profile.full_name || 'Dolmetscher').replace(/[^A-Za-z0-9]+/g, '-')}.pdf`;
            const url = URL.createObjectURL(blob);
            const link = el('a');
            link.href = url;
            link.download = name;
            link.rel = 'noopener';
            document.body.append(link);
            link.click();
            link.remove();
            window.setTimeout(() => URL.revokeObjectURL(url), 60000);
            status.textContent = `Fertig: ${name} (${list.length} ${list.length === 1 ? 'Beleg' : 'Belege'}, ${money(sum)}). Die Datei liegt in deinen Downloads – zum Drucken dort öffnen.`;
            // Selbst ausgedruckt? Dann der Einsatzleitung melden – sie druckt die Belege dann nicht noch einmal.
            const unprinted = list.filter(item => !item.printed_at);
            if (unprinted.length) {
                const done = el('button', 'button-primary receipt-printed-button', `Ausgedruckt ✓ – der Einsatzleitung melden (${unprinted.length})`);
                done.type = 'button';
                done.addEventListener('click', async () => {
                    done.disabled = true;
                    const { error } = await client.rpc('tt_receipts_printed', { p_ids: unprinted.map(item => item.id), p_done: true });
                    done.disabled = false;
                    if (error) { toast(/could not find the function/i.test(error.message || '') ? 'Dafür fehlt noch ein Datenbank-Update (Update 41). Bitte sag der Einsatzleitung Bescheid.' : TerminCloud.germanError(error), 'error'); return; }
                    done.remove();
                    toast('Gemeldet: Die Belege gelten als ausgedruckt – die Einsatzleitung druckt sie nicht noch einmal.', 'success');
                    await loadReceipts();
                });
                status.append(' ', done);
            }
            toast('PDF mit allen Belegen erstellt.', 'success');
        } catch (error) {
            status.textContent = '';
            toast(error.message || TerminCloud.germanError(error), 'error');
        } finally { button.disabled = false; }
    }
    $('receiptBundle')?.addEventListener('click', () => bundleReceipts($('receiptBundle')));
    fillBundleMonths();

    // Sobald ein Foto gewählt ist, liest das Handy Betrag, Datum und Ort selbst aus.
    let scanToken = 0;
    // Der Beleg wird wie eine Unterlage gescannt (Kamera in der App, Rand erkannt, aufgehellt) und als PDF gespeichert.
    let receiptPage = null;       // { blob, width, height, file, source, settings } – der zugeschnittene Beleg (source = das Foto davor)
    let receiptFilled = {};       // was die Texterkennung eingetragen hat – wird mit dem Beleg wieder gelöscht, solange es unverändert ist
    function clearReceiptPage() {
        receiptPage = null;
        const image = $('receiptPreviewImage');
        if (image.src) URL.revokeObjectURL(image.src);
        image.removeAttribute('src');
        $('receiptPreview').hidden = true;
        $('receiptScanLabel').textContent = 'Beleg scannen';
    }
    $('receiptScanButton').addEventListener('click', async () => {
        if (!window.ScanCam?.supported()) { $('receiptPhoto').click(); return; }
        const result = await ScanCam.open({ title: 'Beleg scannen', single: true, shape: 'beleg', onCapture: (file, info) => useReceiptFile(file, info?.result, { settings: info?.settings }) });
        if (result.reason === 'galerie') $('receiptPhoto').click();
        else if (result.reason === 'fehler') { toast(`${result.error || 'Die Kamera konnte nicht gestartet werden.'} Wähle das Foto aus der Galerie oder nimm die Foto-App.`, 'info'); $('receiptPhoto').click(); }
    });
    $('receiptPhoto').addEventListener('change', () => { const file = $('receiptPhoto').files?.[0]; $('receiptPhoto').value = ''; if (file) useReceiptFile(file); });

    // ready = der Beleg ist schon aufbereitet und in der Vorschau bestätigt (Kamera in der App). Ein Foto aus der Galerie wird hier
    // aufbereitet und gezeigt: ansehen, vergrößern, Ecken anpassen.
    // read: false = nur das Bild wurde geändert (Ecken, Drehung) – die Angaben im Formular bleiben, wie sie sind.
    async function useReceiptFile(original, ready = null, { settings = null, read = true } = {}) {
        let file = original;
        const status = $('receiptScan');
        const token = ++scanToken;
        const before = { hidden: status.hidden, kind: status.dataset.kind, text: status.textContent };
        clearReceiptPage();
        if (read) forgetReceiptValues();
        status.hidden = false;
        status.dataset.kind = 'busy';
        status.textContent = 'Beleg wird zugeschnitten …';
        try {
            // Rand erkennen, gerade rücken, aufbereiten – wie bei den Unterlagen. Klappt das nicht, bleibt das Foto, wie es ist.
            let scanned = ready;
            if (!scanned && window.ScanCam?.prepareFull && window.DocScan) {
                const prepared = await ScanCam.prepareFull(original, { title: 'Beleg – Vorschau' });
                if (!prepared) { if (token === scanToken) status.hidden = true; return; }      // Vorschau geschlossen: nichts übernehmen
                scanned = prepared.result;
                settings = prepared.settings;
            } else if (!scanned && window.DocScan) scanned = await DocScan.process(original);
            if (token !== scanToken) return;
            if (scanned?.blob) {
                receiptPage = { blob: scanned.blob, width: scanned.width, height: scanned.height, cropped: Boolean(scanned.cropped) };
                window.DocScan?.release?.(scanned);
                file = new File([scanned.blob], 'beleg.jpg', { type: 'image/jpeg' });
            }
        } catch (error) { /* weiter mit dem Foto */ }
        if (!receiptPage) {
            const size = await new Promise(resolve => { const image = new Image(); image.onload = () => resolve([image.naturalWidth, image.naturalHeight]); image.onerror = () => resolve(null); image.src = URL.createObjectURL(original); });
            if (token !== scanToken) return;
            if (!size) { status.dataset.kind = 'warn'; status.textContent = 'Das Foto konnte nicht geöffnet werden. Bitte noch einmal scannen.'; return; }
            receiptPage = { blob: original, width: size[0], height: size[1], cropped: false };
        }
        receiptPage.file = file;
        receiptPage.source = original;
        receiptPage.settings = settings;
        $('receiptPreviewImage').src = URL.createObjectURL(receiptPage.blob);
        $('receiptPreviewInfo').textContent = receiptPage.cropped ? 'Beleg erkannt und zugeschnitten – wird als PDF gespeichert.' : 'Ganzes Foto – wird als PDF gespeichert.';
        $('receiptPreview').hidden = false;
        $('receiptScanLabel').textContent = 'Beleg neu scannen';
        if (!read) { status.hidden = before.hidden; status.dataset.kind = before.kind || ''; status.textContent = before.text; return; }
        if (typeof ReceiptReader === 'undefined') { status.hidden = true; return; }
        status.hidden = false;
        status.dataset.kind = 'busy';
        status.textContent = 'Beleg wird gelesen …';
        try {
            const found = await ReceiptReader.read(file, progress => {
                if (token === scanToken) status.textContent = `Beleg wird gelesen … ${Math.round(progress * 100)} %`;
            });
            if (token !== scanToken) return;
            const filled = [];
            if (found.amount) { $('receiptAmount').value = found.amount.toFixed(2); filled.push('Betrag'); receiptFilled.receiptAmount = $('receiptAmount').value; }
            if (found.date) { $('receiptDate').value = found.date; filled.push('Datum'); receiptFilled.receiptDate = found.date; }
            if (found.place && !$('receiptPlace').value) { $('receiptPlace').value = found.place; filled.push('Ort'); receiptFilled.receiptPlace = found.place; }
            if (found.note && !$('receiptNote').value) { $('receiptNote').value = found.note; receiptFilled.receiptNote = found.note; }
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
    }

    // Was die Texterkennung aus dem alten Beleg eingetragen hat, verschwindet mit ihm – was der Dolmetscher selbst geändert hat, bleibt.
    function forgetReceiptValues() {
        Object.entries(receiptFilled).forEach(([id, value]) => { if ($(id).value === value) $(id).value = id === 'receiptDate' ? TerminCloud.todayIso() : ''; });
        receiptFilled = {};
    }
    function removeReceipt() {
        scanToken += 1;
        clearReceiptPage();
        forgetReceiptValues();
        $('receiptScan').hidden = true;
        toast('Beleg gelöscht. Du kannst neu scannen.', 'info');
        $('receiptScanButton').focus({ preventScroll: true });
    }
    // „Ansehen“: der Beleg groß – zum Vergrößern, Ecken anpassen, Drehen, neu aufnehmen.
    let receiptViewing = false;
    async function viewReceipt() {
        const page = receiptPage;
        if (!page || receiptViewing) return;
        receiptViewing = true;
        try {
            if (!window.ScanCam?.review || !window.DocScan || !page.source) {
                if (await window.ScanCam?.look?.({ blob: page.blob, title: 'Beleg', removeLabel: 'Löschen' }) === 'remove' && receiptPage === page) removeReceipt();
                return;
            }
            const answer = await ScanCam.review({ file: page.source, settings: page.settings, title: 'Beleg', okLabel: 'Übernehmen' });
            if (receiptPage !== page) { if (answer.action === 'ok') window.DocScan?.release?.(answer.result); return; }
            if (answer.action === 'retake') { $('receiptScanButton').click(); return; }
            if (answer.action !== 'ok') return;
            if (page.settings && JSON.stringify(answer.settings) === JSON.stringify(page.settings)) { window.DocScan?.release?.(answer.result); return; }
            await useReceiptFile(page.source, answer.result, { settings: answer.settings, read: false });
        } finally { receiptViewing = false; }
    }
    $('receiptPreviewOpen').addEventListener('click', viewReceipt);
    $('receiptView').addEventListener('click', viewReceipt);
    $('receiptRetake').addEventListener('click', () => $('receiptScanButton').click());
    $('receiptRemove').addEventListener('click', removeReceipt);

    $('receiptForm').addEventListener('submit', async event => {
        event.preventDefault();
        const button = event.target.querySelector('button[type="submit"]');
        const amount = Number($('receiptAmount').value);
        if (!receiptPage) { toast('Bitte zuerst den Beleg scannen.', 'error', '#receiptScanButton'); return; }
        if (!(amount > 0)) { toast('Bitte trag den Betrag ein.', 'error', '#receiptAmount'); return; }
        if (!$('receiptDate').value) { toast('Bitte trag das Datum des Belegs ein.', 'error', '#receiptDate'); return; }
        if ($('receiptDate').value > TerminCloud.todayIso()) { toast('Das Datum liegt in der Zukunft.', 'error', '#receiptDate'); return; }
        button.disabled = true;
        try {
            const kind = radioValue('receiptKind');
            // Als PDF speichern (eine Seite). Gelingt das auf dem Gerät nicht, geht der Beleg wie früher als Foto hinaus.
            let photoPath = '';
            try {
                const pdf = await DocPdf.build({
                    pages: [{ blob: receiptPage.blob, width: receiptPage.width, height: receiptPage.height, words: [] }],
                    title: ['Beleg', kind, $('receiptPlace').value.trim(), `${amount.toFixed(2)} EUR`].filter(Boolean).join(' · '),
                    subject: `Beleg vom ${$('receiptDate').value.split('-').reverse().join('.')}`, author: profile.full_name || '', keywords: ['Beleg', kind]
                });
                photoPath = `${profile.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}-beleg.pdf`;
                const upload = await client.storage.from('schaeden').upload(photoPath, pdf, { contentType: 'application/pdf' });
                if (upload.error) throw upload.error;
            } catch (pdfError) {
                photoPath = await TerminCloud.uploadPhoto(receiptPage.file, profile.id);
            }
            const { error } = await client.from('tt_receipts').insert({
                person_name: profile.full_name || profile.email, profile_id: profile.id, date: $('receiptDate').value,
                place: $('receiptPlace').value.trim(), amount, kind, proof: kind === 'Tanken' ? 'Quittung' : 'Parkbeleg',
                note: $('receiptNote').value.trim(), photo_path: photoPath, status: 'eingereicht', source: 'portal'
            });
            if (error) throw error;
            scanToken += 1;
            event.target.reset();
            clearReceiptPage();
            receiptFilled = {};
            $('receiptScan').hidden = true;
            $('receiptDate').value = TerminCloud.todayIso();
            toast('Beleg eingereicht. Danke!', 'success');
            await loadReceipts();
            goTo(isFest() ? 'receiptsHome' : 'statement');
        } catch (error) {
            toast(TerminCloud.germanError(error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    // ---------- Arbeitstage ----------
    async function loadWorkdays() {
        // Zur Wahl steht immer nur die laufende Kalenderwoche. Die nächste Woche wird am Freitag um 13 Uhr freigegeben
        // (dann geht auch die Nachricht an die temporären Dolmetscher hinaus) und bleibt übers Wochenende offen.
        const now = new Date();
        const restOfWeek = 7 - ((now.getDay() + 6) % 7);
        const nextWeekOpen = (now.getDay() === 5 && now.getHours() >= 13) || now.getDay() === 6 || now.getDay() === 0;
        const days = Array.from({ length: restOfWeek + (nextWeekOpen ? 7 : 0) }, (_, offset) => { const date = new Date(); date.setDate(date.getDate() + offset); return date; });
        const { data, error } = await client.from('tt_workdays').select('*').eq('user_id', profile.id)
            .gte('date', isoDate(days[0])).lte('date', isoDate(days[days.length - 1]));
        if (error) { setStatus(TerminCloud.germanError(error), 'error'); return; }
        const statusByDate = new Map((data || []).map(item => [item.date, item.status]));
        const list = $('workdayList');
        list.replaceChildren();
        // Samstag und Sonntag stehen nur bei den Dolmetschern (männlich) zur Wahl.
        const weekend = profile.gender === 'männlich';
        let nextWeekShown = false;
        days.forEach((date, offset) => {
            if (!weekend && [0, 6].includes(date.getDay())) return;
            // Trennzeile vor dem ersten Tag der nächsten Woche (Montag oder – nach einem Wochenende – der erste gezeigte Tag danach)
            const sinceMonday = (new Date().getDay() + 6) % 7;
            if (!nextWeekShown && offset > 0 && offset >= 7 - sinceMonday) {
                nextWeekShown = true;
                const divider = document.createElement('li');
                divider.className = 'workday-divider';
                divider.id = 'nextWeekStart';
                divider.textContent = 'Nächste Woche';
                list.append(divider);
            }
            const iso = isoDate(date);
            const item = document.createElement('li');
            item.className = 'workday-item';
            item.dataset.date = iso;
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
        if (!nextWeekOpen) {
            const later = document.createElement('li');
            later.className = 'workday-later';
            later.id = 'nextWeekLater';
            later.textContent = 'Die nächste Woche wird am Freitag um 13 Uhr freigegeben. Du bekommst dann eine Nachricht.';
            list.append(later);
        }
    }

    async function toggleWorkday(date, status, wasActive) {
        const query = wasActive
            ? client.from('tt_workdays').delete().eq('user_id', profile.id).eq('date', date)
            : client.from('tt_workdays').upsert({ user_id: profile.id, date, status, note: '' }, { onConflict: 'user_id,date' });      // note: ein früherer Vermerk „eingetragen von …“ gilt nicht mehr
        const { error } = await query;
        if (error) { toast(TerminCloud.germanError(error), 'error'); return; }
        await loadWorkdays();
        // Die Fragen auf der Startseite („Kannst du morgen …“, Wochenplan) sind damit vielleicht schon beantwortet.
        window.PortalPlan?.load();
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

    const overtimeWeekend = () => { const date = $('overtimeDate').value; return Boolean(date) && [0, 6].includes(new Date(`${date}T00:00:00`).getDay()); };
    function overtimeTexts() {
        const weekend = overtimeWeekend();
        $('overtimeHint').textContent = weekend ? 'Samstag und Sonntag zählt jede Stunde als Überstunde. Trag ein, von wann bis wann du gearbeitet hast.'
            : `Arbeitszeit ist ${WORK_START.replace(/^0/, '')} bis ${WORK_END} Uhr. Alles davor oder danach zählt als Überstunden.`;
        $('overtimeStartHint').textContent = weekend ? 'Beginn – jede Uhrzeit' : `nur wenn vor ${WORK_START.replace(/^0/, '')} Uhr`;
        $('overtimeEndHint').textContent = weekend ? 'Ende – jede Uhrzeit' : `nur wenn nach ${WORK_END} Uhr`;
    }
    function overtimeMinutes() { return computeOvertime(overtimeWeekend(), $('overtimeStart').value, $('overtimeEnd').value); }
    function computeOvertime(weekend, startValue, endValue) {
        const start = toMinutes(startValue);
        const end = toMinutes(endValue);
        // Samstag und Sonntag ist keine normale Arbeitszeit: Dort zählt jede Stunde von Beginn bis Ende.
        if (weekend) {
            const whole = start != null && end != null && end > start ? roundUp(end - start) : 0;
            return { before: whole, after: 0, total: whole, hasInput: start != null || end != null, weekend: true, incomplete: start == null || end == null, wrongOrder: start != null && end != null && end <= start };
        }
        const before = start != null && start < toMinutes(WORK_START) ? roundUp(toMinutes(WORK_START) - start) : 0;
        const after = end != null && end > toMinutes(WORK_END) ? roundUp(end - toMinutes(WORK_END)) : 0;
        return { before, after, total: before + after, hasInput: start != null || end != null };
    }

    function updateOvertimeResult() {
        const result = overtimeMinutes();
        const box = $('overtimeResult');
        if (!result.hasInput) { box.dataset.kind = 'empty'; box.textContent = 'Trag eine Uhrzeit ein.'; return; }
        if (result.weekend && !result.total) { box.dataset.kind = 'warn'; box.textContent = result.wrongOrder ? 'Das Ende muss nach dem Beginn liegen.' : 'Wochenende: Bitte Beginn und Ende eintragen – die ganze Zeit zählt.'; return; }
        if (!result.total) { box.dataset.kind = 'warn'; box.textContent = `Das liegt in der normalen Arbeitszeit (${WORK_START} bis ${WORK_END} Uhr) – keine Überstunden.`; return; }
        box.dataset.kind = 'ok';
        box.textContent = `Überstunden: ${duration(result.total)}` + (result.weekend ? ' (Wochenende – die ganze Zeit zählt)' : '') + (result.before && result.after ? ` (${duration(result.before)} vorher, ${duration(result.after)} danach)` : '') + ' · auf volle 10 Minuten aufgerundet';
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
        // Am Termin steht gleich dabei, wann du laut App losgefahren und fertig geworden bist – so findest du den richtigen.
        const jobLabel = item => {
            const early = item.started_at && clock(item.started_at) < WORK_START;
            const late = item.finished_at && !item.storno_at && clock(item.finished_at) > WORK_END;
            return item.title + (early ? ` · früh losgefahren ${clock(item.started_at)}` : '') + (late ? ` · fertig ${clock(item.finished_at)}` : '');
        };
        select.replaceChildren(option('', 'Bitte wählen'), ...jobs.map(item => option(item.id, jobLabel(item))), option('other', jobs.length ? 'Anderer Termin / anderer Grund' : 'Termin von Hand eintragen'));
        select.value = previous && [...select.options].some(node => node.value === previous) ? previous : (jobs.length === 1 ? jobs[0].id : '');
        $('overtimeJobText').hidden = select.value !== 'other';
        $('overtimeJobText').required = select.value === 'other';
        renderOvertimeDays();
        suggestOvertimeTimes();
    }
    // Schnellwahl für den Tag: heute und die letzten sechs Tage – nachträglich eintragen ist ausdrücklich möglich.
    function renderOvertimeDays() {
        const box = $('overtimeDays');
        if (!box) return;
        const chosen = $('overtimeDate').value;
        const base = new Date(`${TerminCloud.todayIso()}T12:00:00`);
        box.replaceChildren(...[0, 1, 2, 3, 4, 5, 6].map(back => {
            const day = new Date(base); day.setDate(base.getDate() - back);
            const iso = isoDate(day);
            const jobsThatDay = jobsData.filter(item => item.date === iso && !item.cancelled).length;
            const label = back === 0 ? 'Heute' : back === 1 ? 'Gestern' : day.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
            const chip = el('button', 'recipient-chip', jobsThatDay ? `${label} · ${jobsThatDay} ${jobsThatDay === 1 ? 'Termin' : 'Termine'}` : label);
            chip.type = 'button';
            chip.dataset.date = iso;
            chip.setAttribute('aria-pressed', String(iso === chosen));
            chip.addEventListener('click', () => { $('overtimeDate').value = iso; fillOvertimeJobs(); });
            return chip;
        }));
    }
    // Termin gewählt: Die Zeiten aus der App (Losfahren / Fertig) werden vorgeschlagen, wenn sie außerhalb der Arbeitszeit liegen.
    // Selbst getippte Zeiten bleiben stehen.
    let overtimeTyped = false;
    function suggestOvertimeTimes() {
        const hint = $('overtimeJobHint');
        const job = jobsData.find(item => item.id === $('overtimeJob').value);
        if (!hint) return;
        if (!job) { hint.hidden = true; return; }
        const started = job.started_at ? clock(job.started_at) : '';
        const finished = job.finished_at && !job.storno_at ? clock(job.finished_at) : '';
        const booked = overtimeData.find(item => item.status !== 'abgelehnt' && (item.assignment_id === job.id || (item.date === job.date && item.appointment === job.title)));
        const parts = [];
        if (booked) parts.push(`Für diesen Termin sind schon ${duration(Number(booked.minutes_before || 0) + Number(booked.minutes_after || 0))} Überstunden eingetragen – du findest sie unten in der Liste.`);
        else {
            if (started) parts.push(`Laut App losgefahren um ${started} Uhr${started < WORK_START ? ' – vor der Arbeitszeit' : ''}.`);
            if (finished) parts.push(`Fertig um ${finished} Uhr${finished > WORK_END ? ' – nach der Arbeitszeit' : ''}.`);
            if (!started && !finished) parts.push('Für diesen Termin gibt es keine Zeiten aus der App – trag sie bitte selbst ein.');
            if (!overtimeTyped) {
                $('overtimeStart').value = started && started < WORK_START ? started : '';
                $('overtimeEnd').value = finished && finished > WORK_END ? finished : '';
                if ($('overtimeStart').value || $('overtimeEnd').value) parts.push('Die Zeiten sind eingetragen – bitte prüfen.');
                updateOvertimeResult();
            }
        }
        hint.textContent = parts.join(' ');
        hint.hidden = !parts.length;
    }
    ['overtimeStart', 'overtimeEnd'].forEach(id => $(id).addEventListener('input', () => { overtimeTyped = true; }));
    $('overtimeDate').addEventListener('change', () => { overtimeTexts(); fillOvertimeJobs(); updateOvertimeResult(); });
    $('overtimeJob').addEventListener('change', () => {
        $('overtimeJobText').hidden = $('overtimeJob').value !== 'other';
        $('overtimeJobText').required = $('overtimeJob').value === 'other';
        if ($('overtimeJob').value === 'other') $('overtimeJobText').focus();
        suggestOvertimeTimes();
    });

    function prepareOvertimeForm() {
        if (!$('overtimeDate').value) $('overtimeDate').value = TerminCloud.todayIso();
        overtimeTexts();
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
        if (!result.total) { updateOvertimeResult(); toast(result.weekend ? (result.wrongOrder ? 'Das Ende muss nach dem Beginn liegen.' : 'Am Wochenende bitte Beginn und Ende eintragen.') : result.hasInput ? 'Diese Zeiten sind keine Überstunden.' : 'Bitte trag mindestens eine Uhrzeit ein.', 'error'); return; }
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
                start_time: start != null && (result.before || result.weekend) ? $('overtimeStart').value : null,
                end_time: end != null && (result.after || result.weekend) ? $('overtimeEnd').value : null,
                minutes_before: result.before, minutes_after: result.after,
                assignment_id: job ? job.id : null, appointment, note: $('overtimeNote').value.trim(), status: 'eingereicht'
            });
            if (error) throw error;
            event.target.reset();
            overtimeTyped = false;
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

    // ---------- Nachrichten: Chat mit der Einsatzleitung ----------
    // Rundnachrichten (tt_messages) und das eigene Gespräch (tt_chat) stehen in einem Verlauf – wie in einem Messenger,
    // die neueste unten. Der Dolmetscher kann antworten; „gelesen“ wird in beide Richtungen angezeigt.
    let chatData = [];           // eigenes Gespräch, älteste zuerst
    let chatReady = true;        // false: die Tabelle fehlt noch (Update 21)
    let messagesShown = '';      // Stand der Anzeige – nur bei Änderungen wird neu gezeichnet
    let questionData = [];          // Fragen der Ärzte zu meinen Berichten (Update 36)
    // Art (Update 40): frage = antworten, info = „gelesen“ bestätigen, anweisung = „Verstanden“ bestätigen (groß und rot).
    // bericht (Update 51): die PR bittet um den Bericht zu einem Termin – erledigt, sobald er hochgeladen ist.
    const questionKind = item => ['frage', 'info', 'anweisung', 'bericht'].includes(item.kind) ? item.kind : 'frage';
    const questionOpen = item => questionKind(item) === 'frage' ? !item.answered_at && !item.seen_at : !item.acknowledged_at;
    const openOrders = () => questionData.filter(item => questionKind(item) === 'anweisung' && !item.acknowledged_at);
    const unreadQuestions = () => questionData.filter(questionOpen).length;
    const unreadMessages = () => messageData.filter(item => !readIds.has(item.id)).length + chatData.filter(item => item.from_staff && !item.read_at).length + unreadQuestions();
    async function loadMessages() {
        const [messages, reads, chat, questions] = await Promise.all([
            client.from('tt_messages').select('*').order('created_at', { ascending: false }).limit(50),
            client.from('tt_message_reads').select('message_id').eq('profile_id', profile.id),
            client.from('tt_chat').select('*').eq('thread_id', profile.id).order('created_at', { ascending: false }).limit(200),
            client.from('tt_doctor_questions').select('*').eq('interpreter_id', profile.id).order('created_at', { ascending: false }).limit(100)
        ]);
        const before = loadMessages.loaded ? unreadMessages() : 0;
        const questionsBefore = loadMessages.loaded ? unreadQuestions() : 0;
        questionData = questions.error ? [] : (questions.data || []);
        if (messages.error) messageData = [];
        else {
            // Nachrichten aus der Zeit vor dem eigenen Konto sind nicht mehr wichtig.
            messageData = messages.data.filter(item => !profile.created_at || item.created_at >= profile.created_at);
            readIds = new Set(reads.error ? [] : reads.data.map(item => item.message_id));
        }
        chatReady = !chat.error;
        chatData = chat.error ? [] : [...chat.data].reverse();
        const unread = unreadMessages();
        if (loadMessages.loaded && unread > before && currentView !== 'messages') toast(unreadQuestions() > questionsBefore ? (openOrders().length ? 'Ein Arzt hat dir eine Anweisung geschickt – bitte bestätigen.' : questionData.some(item => questionKind(item) === 'bericht' && questionOpen(item)) ? 'Ein Bericht wird angefordert – bitte hochladen.' : 'Ein Arzt hat dir zu deinem Bericht geschrieben.') : 'Neue Nachricht von der Einsatzleitung.', openOrders().length && unreadQuestions() > questionsBefore ? 'error' : 'success', null, { label: 'Lesen', run: () => goTo('messages') });
        const newQuestions = loadMessages.loaded && unreadQuestions() > questionsBefore;
        loadMessages.loaded = true;
        if (currentView === 'messages') { renderMessages(); markMessagesRead(); }
        syncUrgent();
        if (newQuestions) showUrgent({ newOnly: true });
    }

    const AUDIENCE_NOTE = { alle: 'an alle', fest: 'an alle Festangestellten', 'temporär': 'an alle Temporären' };
    function chatDay(iso) {
        const date = new Date(iso);
        const start = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
        const days = Math.round((start(new Date()) - start(date)) / 86400000);
        return days === 0 ? 'Heute' : days === 1 ? 'Gestern' : date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    // Fragen der Ärzte: Patient, Bericht und Datum stehen dabei – die Antwort geht direkt zurück auf die Anzeige des Arztes.
    function renderDoctorQuestions() {
        const box = $('doctorQuestions');
        if (!box) return;
        box.hidden = !questionData.length;
        const list = $('doctorQuestionList');
        const signature = JSON.stringify(questionData.map(item => [item.id, item.answer, item.seen_at, item.answered_at, item.acknowledged_at, item.kind]));
        if (list.dataset.signature === signature) return;
        list.dataset.signature = signature;
        const DAY = iso => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
        // Offene Anweisungen zuerst, dann offene Fragen und Infos, dann der Rest.
        list.replaceChildren(...sortedQuestions().map(item => questionCard(item)));
    }
    const questionWeight = item => (questionOpen(item) ? 0 : 2) + (questionKind(item) === 'anweisung' ? 0 : 1);
    const sortedQuestions = () => [...questionData].sort((left, right) => questionWeight(left) - questionWeight(right) || new Date(right.created_at) - new Date(left.created_at));
    // Eine Karte je Nachricht eines Arztes oder der PR – in „Nachrichten“ und in der Eilmeldung beim Start.
    function questionCard(item) {
        const DAY = iso => iso ? new Date(`${iso}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
        {
            const kind = questionKind(item);
            const card = el('li', 'doctor-question');
            card.dataset.id = item.id;
            card.dataset.kind = kind;
            card.dataset.state = (kind === 'frage' ? item.answered_at : item.acknowledged_at) ? 'beantwortet' : 'offen';
            const head = el('div', 'doctor-question-head');
            const who = item.doctor_name || (kind === 'bericht' ? 'PR' : 'Arzt');
            head.append(el('strong', '', kind === 'anweisung' ? `Anweisung von ${who}` : kind === 'info' ? `Info von ${who}` : kind === 'bericht' ? `${who} bittet um deinen Bericht` : `${who} fragt`), el('span', '', `${chatDay(item.created_at)} · ${clock(item.created_at)} Uhr`));
            const about = el('p', 'doctor-question-about', [item.patient_name ? `Patient/in: ${item.patient_name}` : '', item.patient_nr ? `Akte ${item.patient_nr}` : '', item.document_title || item.document_kind, item.document_date ? `${item.document_kind === 'Termin' ? 'am' : 'vom'} ${DAY(item.document_date)}` : ''].filter(Boolean).join(' · '));
            const question = el('p', 'doctor-question-text', item.question);
            card.append(head, about, question);
            if (kind === 'bericht') {
                // Erledigt, sobald der Bericht zu diesem Termin hochgeladen ist (Auslöser in der Datenbank).
                if (item.acknowledged_at) card.append(el('span', 'doctor-question-meta is-ok', `Bericht hochgeladen · ${chatDay(item.acknowledged_at)} ${clock(item.acknowledged_at)} Uhr`));
                else {
                    const job = item.assignment_id ? jobsData.find(other => other.id === item.assignment_id) : null;
                    const write = el('button', 'button-primary doctor-report-write', 'Bericht jetzt schreiben');
                    write.type = 'button';
                    if (job) write.addEventListener('click', () => { if ($('urgentDialog')?.open) $('urgentDialog').close(); window.PortalDocs?.reportFor(job.id); });
                    else { write.disabled = true; write.title = 'Dieser Termin ist nicht (mehr) in deiner Liste.'; }
                    card.append(write);
                }
                if (item.answered_at && !card.dataset.editing) {
                    const answer = el('p', 'doctor-question-answer', item.answer);
                    const meta = el('span', 'doctor-question-meta', `Deine Rückmeldung · ${chatDay(item.answered_at)} ${clock(item.answered_at)} Uhr`);
                    const change = el('button', 'link-button', 'Rückmeldung ändern');
                    change.type = 'button';
                    change.addEventListener('click', () => { card.dataset.editing = 'ja'; card.append(answerForm(item, card, 'Rückmeldung speichern')); change.remove(); });
                    card.append(meta, answer, change);
                } else if (!item.acknowledged_at) {
                    const reply = el('details', 'doctor-question-reply');
                    reply.append(el('summary', '', 'Rückmeldung schreiben (z. B. wann der Bericht kommt) …'), answerForm(item, card, 'Rückmeldung senden'));
                    card.append(reply);
                }
                return card;
            }
            if (kind !== 'frage') {
                // Info und Anweisung: bestätigen – bei einer Anweisung groß und deutlich. Eine Rückmeldung ist freiwillig.
                if (item.acknowledged_at) card.append(el('span', 'doctor-question-meta is-ok', `${kind === 'anweisung' ? 'Verstanden' : 'Gelesen'} · ${chatDay(item.acknowledged_at)} ${clock(item.acknowledged_at)} Uhr`));
                else {
                    const ok = el('button', kind === 'anweisung' ? 'button-primary doctor-order-ok' : 'button-secondary doctor-info-ok', kind === 'anweisung' ? 'Verstanden – wird gemacht' : 'Gelesen');
                    ok.type = 'button';
                    ok.addEventListener('click', async () => {
                        ok.disabled = true;
                        const now = new Date().toISOString();
                        const { error } = await client.from('tt_doctor_questions').update({ acknowledged_at: now, seen_at: item.seen_at || now }).eq('id', item.id);
                        ok.disabled = false;
                        if (error) { toast(/acknowledged_at|column/i.test(error.message || '') ? 'Dafür fehlt noch ein Datenbank-Update (Update 40). Bitte sag der Einsatzleitung Bescheid.' : TerminCloud.germanError(error), 'error'); return; }
                        toast(kind === 'anweisung' ? `Bestätigt – ${who} sieht dein „Verstanden“.` : 'Als gelesen bestätigt.', 'success');
                        await loadMessages();
                        renderHome();
                    });
                    card.append(ok);
                }
                if (item.answered_at && !card.dataset.editing) {
                    const answer = el('p', 'doctor-question-answer', item.answer);
                    const meta = el('span', 'doctor-question-meta', `Deine Rückmeldung · ${chatDay(item.answered_at)} ${clock(item.answered_at)} Uhr`);
                    const change = el('button', 'link-button', 'Rückmeldung ändern');
                    change.type = 'button';
                    change.addEventListener('click', () => { card.dataset.editing = 'ja'; card.append(answerForm(item, card, 'Rückmeldung speichern')); change.remove(); });
                    card.append(meta, answer, change);
                } else {
                    const reply = el('details', 'doctor-question-reply');
                    reply.append(el('summary', '', 'Rückfrage oder Rückmeldung schreiben …'), answerForm(item, card, 'Rückmeldung senden'));
                    card.append(reply);
                }
                return card;
            }
            if (item.answered_at && !card.dataset.editing) {
                const answer = el('p', 'doctor-question-answer', item.answer);
                const meta = el('span', 'doctor-question-meta', `Deine Antwort · ${chatDay(item.answered_at)} ${clock(item.answered_at)} Uhr`);
                const change = el('button', 'link-button', 'Antwort ändern');
                change.type = 'button';
                change.addEventListener('click', () => { card.dataset.editing = 'ja'; card.replaceChildren(head, about, question, answerForm(item, card)); });
                card.append(meta, answer, change);
            } else card.append(answerForm(item, card));
            return card;
        }
    }
    // Schnellantwort (R81): „Wird erledigt“, „In Bearbeitung“, „Kommt am …“ – dazu freiwillig eine Bemerkung. Die Antwort
    // steht als Text in der Datenbank (z. B. „Kommt am 30.10.2026, 14:00 Uhr – Arzt schickt den Bericht per Post“).
    const REPLY_STATUS = [['erledigt', 'Wird erledigt'], ['arbeit', 'In Bearbeitung'], ['kommt', 'Kommt am …']];
    const replyStatusOf = answer => { const text = String(answer || ''); return text.startsWith('Wird erledigt') ? 'erledigt' : text.startsWith('In Bearbeitung') ? 'arbeit' : /^Kommt am /.test(text) ? 'kommt' : ''; };
    // ---------- Eilmeldung (R81): offene Nachrichten der Ärzte und der PR – gleich beim Start, groß, mit Antwort ----------
    // „Offen“ heißt hier: noch nicht beantwortet bzw. bestätigt. Einmal gezeigt, kommt sie erst beim nächsten Start wieder –
    // oder sofort, wenn etwas Neues eintrifft.
    const urgentShown = new Set();
    const questionPending = item => { const kind = questionKind(item); return kind === 'frage' ? !item.answered_at : kind === 'bericht' ? !item.acknowledged_at && !item.answered_at : !item.acknowledged_at; };
    const pendingQuestions = () => sortedQuestions().filter(questionPending);
    function renderUrgent() {
        const items = pendingQuestions();
        $('urgentSub').textContent = items.length === 1 ? 'Eine Nachricht wartet auf deine Antwort – bitte gleich antworten.' : `${items.length} Nachrichten warten auf deine Antwort – bitte gleich antworten.`;
        $('urgentList').replaceChildren(...items.map(item => questionCard(item)));
        return items;
    }
    function showUrgent({ newOnly = false } = {}) {
        const dialog = $('urgentDialog');
        if (!dialog || !profile?.active || profile.must_change_password) return;
        const items = pendingQuestions();
        if (!items.length) { if (dialog.open) dialog.close(); return; }
        if (newOnly && !items.some(item => !urgentShown.has(item.id))) { if (dialog.open) renderUrgent(); return; }
        // Nicht mitten im Tippen oder über einem anderen Fenster
        if (document.querySelector('dialog[open]:not(#urgentDialog)') || ['docReport', 'docNew'].includes(currentView)) return;
        items.forEach(item => urgentShown.add(item.id));
        renderUrgent();
        if (!dialog.open) dialog.showModal();
        const unseen = items.filter(item => !item.seen_at);
        if (unseen.length) client.from('tt_doctor_questions').update({ seen_at: new Date().toISOString() }).in('id', unseen.map(item => item.id)).then(() => null, () => null);
    }
    function syncUrgent() {
        const dialog = $('urgentDialog');
        if (!dialog?.open) return;
        if (!pendingQuestions().length) { dialog.close(); toast('Alles beantwortet – danke!', 'success'); return; }
        renderUrgent();
    }
    $('urgentLater')?.addEventListener('click', () => $('urgentDialog').close());
    $('urgentDialog')?.addEventListener('close', () => $('urgentList').replaceChildren());   // geschlossen = leer (keine doppelten Karten im Dokument)
    $('urgentAll')?.addEventListener('click', () => { $('urgentDialog').close(); goTo('messages'); });
    function answerForm(item, card, label = '') {
        const form = el('form', 'doctor-question-form');
        form.noValidate = true;
        const text = el('textarea');
        const to = item.doctor_name || (questionKind(item) === 'bericht' ? 'die PR' : 'den Arzt');
        text.rows = 3; text.maxLength = 4000; text.placeholder = label ? `Deine Rückmeldung an ${to}` : `Deine Antwort an ${to}`; text.value = item.answer || '';
        text.setAttribute('aria-label', `Antwort an ${to}`);
        const send = el('button', 'button-primary', label || (item.answered_at ? 'Antwort speichern' : 'Antworten'));
        send.type = 'submit';
        // Schnellantwort: ein Tipp genügt – die Bemerkung ist freiwillig.
        const chips = el('div', 'reply-chips');
        chips.setAttribute('role', 'group'); chips.setAttribute('aria-label', 'Schnellantwort');
        const when = el('div', 'reply-when');
        const date = el('input'); date.type = 'date'; date.min = TerminCloud.todayIso(); date.setAttribute('aria-label', 'Datum');
        const time = el('input'); time.type = 'time'; time.setAttribute('aria-label', 'Uhrzeit');
        when.append(el('span', '', 'Kommt am'), date, time);
        when.hidden = true;
        let status = '';
        const existing = replyStatusOf(item.answer);
        if (existing) {
            status = existing;
            const rest = String(item.answer).replace(/^(Wird erledigt|In Bearbeitung|Kommt am [^–]*)\.?\s*(–\s*)?/, '');
            text.value = rest;
            const found = String(item.answer).match(/^Kommt am (\d{2})\.(\d{2})\.(\d{4})(?:, (\d{2}:\d{2}) Uhr)?/);
            if (found) { date.value = `${found[3]}-${found[2]}-${found[1]}`; time.value = found[4] || ''; }
        }
        const paint = () => { chips.querySelectorAll('button').forEach(button => button.classList.toggle('is-active', button.dataset.status === status)); when.hidden = status !== 'kommt'; text.placeholder = status ? 'Bemerkung (freiwillig)' : text.placeholder; };
        REPLY_STATUS.forEach(([key, word]) => {
            const chip = el('button', 'reply-chip', word);
            chip.type = 'button'; chip.dataset.status = key;
            chip.addEventListener('click', () => { status = status === key ? '' : key; paint(); if (status === 'kommt') date.focus(); });
            chips.append(chip);
        });
        paint();
        form.append(chips, when, text, send);
        form.addEventListener('submit', async event => {
            event.preventDefault();
            const note = text.value.trim();
            let answer = note;
            if (status === 'kommt') {
                if (!date.value) { toast('Bitte das Datum wählen, wann der Bericht kommt.', 'error'); date.focus(); return; }
                const [y, m, d] = date.value.split('-');
                answer = `Kommt am ${d}.${m}.${y}${time.value ? `, ${time.value} Uhr` : ''}${note ? ` – ${note}` : ''}`;
            } else if (status) answer = `${status === 'erledigt' ? 'Wird erledigt' : 'In Bearbeitung'}${note ? ` – ${note}` : ''}`;
            if (!answer) { toast('Bitte eine Antwort wählen oder schreiben.', 'error'); text.focus(); return; }
            send.disabled = true;
            const { error } = await client.from('tt_doctor_questions').update({ answer, seen_at: item.seen_at || new Date().toISOString() }).eq('id', item.id);
            send.disabled = false;
            if (error) { toast(TerminCloud.germanError(error), 'error'); return; }
            delete card.dataset.editing;
            toast(questionKind(item) === 'bericht' ? 'Rückmeldung gesendet – die PR sieht sie beim Termin.' : 'Antwort gesendet – der Arzt sieht sie bei seinem Bericht.', 'success');
            await loadMessages();
        });
        return form;
    }
    function renderMessages(force = false) {
        renderDoctorQuestions();
        const list = $('messageList');
        const items = [
            ...messageData.map(item => ({ id: `r-${item.id}`, at: item.created_at, mine: false, name: item.sender_name || 'Einsatzleitung', body: item.body, note: AUDIENCE_NOTE[item.audience] || '', fresh: !readIds.has(item.id) })),
            ...chatData.map(item => ({ id: item.id, at: item.created_at, mine: !item.from_staff, name: item.sender_name || 'Einsatzleitung', body: item.body, read: item.read_at, edited: Boolean(item.edited_at), fresh: item.from_staff && !item.read_at, row: item }))
        ].sort((left, right) => new Date(left.at) - new Date(right.at));
        const shown = JSON.stringify(items.map(item => [item.id, item.body, item.read || '', item.fresh, item.edited]));
        $('chatForm').hidden = !chatReady;
        $('chatMissing').hidden = chatReady;
        if (!force && shown === messagesShown) return;
        // Wer gerade unten mitliest, bleibt unten; wer nach oben geblättert hat, wird nicht gestört.
        const atBottom = !messagesShown || window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
        messagesShown = shown;
        $('messagesSummary').textContent = items.length ? 'Schreib der Einsatzleitung direkt. Unter deinen Nachrichten steht, ob sie gelesen wurden.' : 'Noch keine Nachrichten. Schreib der Einsatzleitung einfach hier.';
        const clock = iso => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        let lastDay = '';
        const nodes = [];
        items.forEach(item => {
            const day = chatDay(item.at);
            if (day !== lastDay) { nodes.push(el('li', 'chat-day', day)); lastDay = day; }
            const row = el('li', `chat-row ${item.mine ? 'is-me' : 'is-them'}${item.fresh ? ' is-new' : ''}`);
            row.dataset.id = item.id;
            const bubble = el('div', 'chat-bubble');
            if (!item.mine) bubble.append(el('span', 'chat-name', [item.name, item.note].filter(Boolean).join(' · ')));
            bubble.append(el('p', '', item.body));
            const meta = el('span', 'chat-meta', `${clock(item.at)}${item.edited ? ' · bearbeitet' : ''}`);
            if (item.mine) {
                const tick = el('span', `chat-tick${item.read ? ' is-read' : ''}`, item.read ? `✓✓ gelesen ${clock(item.read)}` : '✓ gesendet');
                tick.title = item.read ? 'Die Einsatzleitung hat die Nachricht gesehen' : 'Gesendet – noch nicht gelesen';
                meta.append(tick);
            }
            bubble.append(meta);
            row.append(bubble);
            if (item.mine) {
                // Eigene Nachricht antippen: „Löschen“ erscheint.
                const remove = el('button', 'link-button chat-delete', 'Nachricht löschen');
                remove.type = 'button';
                remove.hidden = true;
                bubble.tabIndex = 0;
                bubble.setAttribute('role', 'button');
                bubble.setAttribute('aria-label', 'Eigene Nachricht – antippen zum Löschen');
                const toggle = () => { remove.hidden = !remove.hidden; };
                bubble.addEventListener('click', toggle);
                bubble.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
                remove.addEventListener('click', async () => {
                    remove.disabled = true;
                    const { error } = await client.from('tt_chat').delete().eq('id', item.row.id);
                    if (error) { remove.disabled = false; toast(TerminCloud.germanError(error), 'error'); return; }
                    toast('Nachricht gelöscht.', 'success');
                    await loadMessages();
                });
                row.append(remove);
            }
            nodes.push(row);
        });
        list.replaceChildren(...nodes);
        if (atBottom) window.requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
    }

    // Gelesen melden – nur, wenn der Chat wirklich offen und sichtbar ist.
    async function markMessagesRead() {
        if (document.hidden || currentView !== 'messages') return;
        const unread = messageData.filter(item => !readIds.has(item.id));
        const unreadChat = chatData.some(item => item.from_staff && !item.read_at);
        // Fragen der Ärzte gelten als gesehen, sobald die Nachrichten offen sind (die Antwort kommt extra).
        const unseen = questionData.filter(item => !item.seen_at);
        if (unseen.length) {
            const now = new Date().toISOString();
            const seen = await client.from('tt_doctor_questions').update({ seen_at: now }).in('id', unseen.map(item => item.id));
            if (!seen.error) unseen.forEach(item => { item.seen_at = now; });
        }
        if (!unread.length && !unreadChat) { if (unseen.length) { const left = unreadMessages(); $('messagesBadge').hidden = !left; $('messagesBadge').textContent = left ? String(left) : ''; updateAppBadge(); } return; }
        const [reads, chat] = await Promise.all([
            // Nur einfügen, nie ändern: Auf tt_message_reads gibt es kein Änderungsrecht – ein „upsert“ mit Ändern schlug still fehl,
            // und die Nachrichten blieben für immer „neu“ (Zahl am App-Symbol zählte alle Nachrichten von Anfang an).
            unread.length ? client.from('tt_message_reads').upsert(unread.map(item => ({ message_id: item.id, profile_id: profile.id })), { onConflict: 'message_id,profile_id', ignoreDuplicates: true }) : { error: null },
            unreadChat ? client.rpc('tt_chat_read', { p_thread: null }) : { error: null }
        ]);
        if (!reads.error) unread.forEach(item => readIds.add(item.id));
        if (!chat.error && unreadChat) { const now = new Date().toISOString(); chatData.forEach(item => { if (item.from_staff && !item.read_at) item.read_at = now; }); }
        const left = unreadMessages();
        $('messagesBadge').hidden = !left;
        $('messagesBadge').textContent = left ? String(left) : '';
        updateAppBadge();
    }
    async function openMessages() {
        messagesShown = '';
        renderMessages(true);
        await markMessagesRead();
    }

    function growChatText() {
        const box = $('chatText');
        box.style.height = 'auto';
        box.style.height = `${Math.min(box.scrollHeight, 132)}px`;
    }
    $('chatText').addEventListener('input', growChatText);
    $('chatForm').addEventListener('submit', async event => {
        event.preventDefault();
        const box = $('chatText');
        const text = box.value.trim();
        if (!text) { box.focus(); return; }
        const button = $('chatSend');
        button.disabled = true;
        const { data, error } = await client.from('tt_chat').insert({ thread_id: profile.id, sender_id: profile.id, sender_name: profile.full_name || '', from_staff: false, body: text.slice(0, 2000) }).select('id').single();
        button.disabled = false;
        if (error) {
            toast(/tt_chat|schema cache|does not exist|could not find/i.test(error.message || '')
                ? 'Der Chat ist in der Datenbank noch nicht eingerichtet (Update 21). Bitte sag der Einsatzleitung Bescheid.'
                : `Nicht gesendet: ${TerminCloud.germanError(error)}`, 'error');
            return;
        }
        box.value = '';
        growChatText();
        // Mitteilung aufs Handy der Einsatzleitung.
        if (data?.id) TerminCloud.callFunction?.({ action: 'chat', chatId: data.id })?.catch?.(() => null);
        messagesShown = '';
        await loadMessages();
        window.scrollTo({ top: document.documentElement.scrollHeight });
        box.focus({ preventScroll: true });
    });
    // Solange der Chat offen ist, kommen neue Nachrichten und „gelesen“ alle paar Sekunden von selbst.
    window.setInterval(() => { if (currentView === 'messages' && !document.hidden && profile?.active && !profile.must_change_password) loadMessages(); }, 5000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && currentView === 'messages' && profile?.active) loadMessages(); });

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
            : state === 'unsupported' ? (isIos ? 'Auf dem iPhone gehen Mitteilungen erst, wenn du die App auf den Home-Bildschirm gelegt hast (siehe unten) und sie von dort öffnest.' : 'Dieser Browser unterstützt keine Mitteilungen. Öffne das Portal in Chrome.')
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
            const result = await TerminCloud.signUp($('signUpEmail').value.trim(), $('signUpPassword').value, $('signUpName').value.trim().replace(/\s+/g, ' '), $('signUpPhone').value.trim(), radioValue('signUpEmployment'), radioValue('signUpGender'));
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

    async function signOut() {
        await TerminCloud.signOut();
        currentView = 'vehicle';
        try { localStorage.removeItem(LAST_VIEW_KEY); } catch (error) { /* nichts gemerkt */ }
        loadMessages.loaded = false;
        await refresh();
    }
    $('portalSignOut').addEventListener('click', signOut);
    $('pendingSignOut').addEventListener('click', signOut);
    $('portalRecheck').addEventListener('click', refresh);
    const poll = () => { if (!document.hidden && profile?.active && !profile.must_change_password) Promise.all([loadJobs(), loadMessages(), window.PortalRequests?.load(), window.PortalPlan?.load()]).then(renderHome); };
    document.addEventListener('visibilitychange', () => { if (!document.hidden && profile?.active && !profile.must_change_password) { loadFleet(); poll(); } });
    document.addEventListener('visibilitychange', () => { if (document.hidden) rememberPlace(); });
    // contactParse.js wurde nachgeladen (siehe ganz oben): die Auftragskarten mit der richtigen Auswertung neu aufbauen.
    window.addEventListener('termincontact-ready', () => { jobsRendered = ''; if (profile?.active && !profile.must_change_password) loadJobs(); });
    window.addEventListener('pagehide', rememberPlace);
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
        client, config, toast, showSuccess, goTo, el, emptyItem, makeWizard, choiceButtons, parseJobMessage, isoDate, svgSpan, askYesNo, homeJobText,
        // Für „An die Pforte melden“ (portalGate.js): das übernommene Fahrzeug und die Aufträge dieser Ausfahrt –
        // alle von heute, die noch anstehen (und die, die erst nach der Abfahrt fertig wurden).
        myVehicle: () => myHandover ? vehicleById(myHandover.vehicle_id) || null : null,
        gateJobs: since => jobsData.filter(item => item.date === TerminCloud.todayIso() && !item.cancelled && item.response !== 'abgesagt' && !jobStorno(item)
            && (!jobFinished(item) || Boolean(since && item.finished_at && item.finished_at > since))).sort(jobOrder),
        profile: () => profile, jobs: () => jobsData, view: () => currentView,
        isFest: () => isFest(), refreshWorkdays: () => loadWorkdays(), refreshAccount: () => renderAccount(),
        setProfile: fields => { if (profile) Object.assign(profile, fields); }
    };

    refresh();
})();
