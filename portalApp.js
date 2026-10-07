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

    // action = { label, run }: zusätzlicher Knopf in der Anzeige, z. B. „Rückgängig“.
    function toast(message, kind = 'info', target = null, action = null) {
        const item = document.createElement('div');
        item.className = 'toast';
        item.dataset.kind = kind;
        item.insertAdjacentHTML('afterbegin', TOAST_ICONS[kind] || TOAST_ICONS.info);
        const text = document.createElement('span');
        text.textContent = message;
        item.append(text);
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
        $('portalUser').textContent = [profile.full_name || profile.email, isFest() ? 'fest angestellt' : ''].filter(Boolean).join(' · ');
        $('accountInitials').textContent = String(profile.full_name || profile.email || '?').split(/\s+/).map(part => part[0]).slice(0, 2).join('').toLocaleUpperCase('de-DE');
        if (!profile.active) { show('pending'); return; }
        if (profile.must_change_password) { show('password'); return; }
        buildTabbar();
        show('app');
        await loadFleet();
        await Promise.all([loadJobs(), loadReceipts(), loadStatements(), loadMessages(), loadFuelCards(), isFest() ? loadOvertime() : loadWorkdays()]);
        window.PortalDocs?.load();
        await window.PortalRequests?.load();
        await window.PortalPlan?.start();
        if (!isFest()) renderWorked();
        renderAccount();
        renderHome();
        // Direkter Sprung aus einer Mitteilung: portal.html?seite=nachrichten
        const wanted = new URLSearchParams(location.search).get('seite');
        if (wanted === 'nachrichten') { history.replaceState(null, '', location.pathname); goTo('messages'); }
        else if (wanted === 'auftraege') { history.replaceState(null, '', location.pathname); goTo('jobs'); }
        else if (wanted === 'rueckfragen') { history.replaceState(null, '', location.pathname); goTo('requests'); }
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
        rememberView(view);
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
        if (view === 'appts') window.PortalAppointments?.open();
        if (view === 'requests') window.PortalRequests?.show();
        if (view === 'overtime') window.PortalPlan?.openAbsences();
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
        const unread = unreadMessages();
        const notices = [];
        if (unread) notices.push([`${unread} neue ${unread === 1 ? 'Nachricht' : 'Nachrichten'} von der Einsatzleitung`, () => goTo('messages')]);
        // Aufträge stehen jetzt im Abschnitt „Heute“ (nächster Auftrag groß, weitere als Zeilen) – nicht mehr als Textzeile.
        renderHomeJobs(today, open);
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
            const card = [...document.querySelectorAll('#jobList .job-card')].find(node => node.dataset.id === id);
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
            state.textContent = { offen: 'Bitte prüfe die Abrechnung und bestätige sie.', 'bestätigt': `Von dir bestätigt am ${new Date(statement.responded_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}.`, einwand: `Einwand gemeldet: „${statement.response_note}“ – die Einsatzleitung meldet sich.` }[statement.response];
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
        toast(action === 'start' ? 'Gute Fahrt! Die Einsatzleitung sieht, dass du unterwegs bist.'
            : `Auftrag beendet. Die Einsatzleitung weiß, dass du wieder frei bist.${overtime ? ` Überstunden eingetragen: ${duration(overtime)}.` : ''}`, 'success');
        // Zusätzlich als Mitteilung an die Einsatzleitung (falls dort eingeschaltet).
        TerminCloud.callFunction({ action: 'progress', assignmentId: item.id }).catch(() => null);
        // Fertig: Die Karte klappt zu, der nächste Auftrag klappt von selbst auf.
        if (action === 'finish') jobOpenId = undefined;
        await loadJobs();
        if (isFest() && overtime) loadOvertime();
        renderHome();
    }

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
        if (finished) {
            box.append(svgSpan('job-progress-icon', '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.500l2.800 2.800L16.500 9.500"/></svg>'),
                el('span', 'job-progress-text', item.finished_at ? `Beendet um ${clock(item.finished_at)} Uhr` : 'Beendet'));
            return box;
        }
        if (started) box.append(el('span', 'job-progress-text', item.started_at ? `Unterwegs seit ${clock(item.started_at)} Uhr` : 'Unterwegs'));
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
        ['Rezepte', kind => /^Rezept/.test(kind)],
        ['Überweisungen', kind => /^Überweisung/.test(kind)],
        ['Sonstiges', () => true]
    ];
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
        const day = doc.date || String(doc.created_at || '').slice(0, 10);
        head.append(el('strong', '', doc.kind || 'Unterlage'), el('span', '', day ? new Date(`${day}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''));
        const sameDoctor = jobDoctor && doc.doctor && (foldText(doc.doctor).includes(foldText(jobDoctor)) || foldText(jobDoctor).includes(foldText(doc.doctor)));
        if (sameDoctor) head.append(el('em', 'chip chip-brand', 'gleiche Praxis'));
        entry.append(head);
        entry.append(el('small', '', [doc.doctor, doc.mine ? 'von dir' : doc.uploader_name ? `von ${doc.uploader_name}` : '', doc.pages ? `${doc.pages} ${doc.pages === 1 ? 'Seite' : 'Seiten'}` : ''].filter(Boolean).join(' · ')));
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
            const last = docs[0].date || String(docs[0].created_at || '').slice(0, 10);
            const nodes = [el('p', 'job-prior-intro', `Zur Vorbereitung: ${docs.length} ${docs.length === 1 ? 'Unterlage' : 'Unterlagen'} aus dem Archiv${last ? ` – die neueste vom ${new Date(`${last}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : ''}. Bitte vertraulich behandeln.`)];
            const rest = [...docs];
            PRIOR_GROUPS.forEach(([title, test]) => {
                const group = rest.filter(doc => test(doc.kind || ''));
                if (!group.length) return;
                group.forEach(doc => rest.splice(rest.indexOf(doc), 1));
                const list = el('ul', 'job-prior-list');
                list.append(...group.map(doc => priorEntry(doc, jobDoctor)));
                nodes.push(el('h4', 'job-prior-title', `${title} (${group.length})`), list);
            });
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
            if (item.office_note || item.attachment_path) main.append(el('span', 'job-mini-note', [item.office_note ? 'Hinweis der Einsatzleitung' : '', item.attachment_path ? 'Anhang' : ''].filter(Boolean).join(' · ')));
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
        if (currentView === 'vehicle') renderHomeJobs(TerminCloud.todayIso());
        const today = TerminCloud.todayIso();
        // Oben stehen kommende Aufträge – und ältere, die gestartet, aber noch nicht beendet wurden.
        const isCurrent = item => !item.cancelled && (item.date >= today || (jobStarted(item) && !jobFinished(item)));
        const upcoming = data.filter(isCurrent).sort(jobOrder);
        const open = upcoming.filter(item => item.response === 'offen').length;
        $('jobsSummary').textContent = upcoming.length
            ? `${upcoming.length} ${upcoming.length === 1 ? 'Auftrag' : 'Aufträge'}${open ? `, ${open} ${open === 1 ? 'wartet' : 'warten'} auf deine Antwort` : ''}`
            : 'Im Moment hast du keine Aufträge.';
        setBadge('jobs', open);

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
        const signature = JSON.stringify([today, data]);
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
        const past = data.filter(item => !isCurrent(item));
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
                inner.append(entry);
            });
            fold.append(head, inner);
            holder.append(fold);
            history.append(holder);
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
        // Fest reservierte Fahrzeuge sieht nur die Person, für die sie reserviert sind.
        const mine = vehicle => !vehicle.assigned_to || vehicle.assigned_to === profile.id;
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

    // Hinweise der Nachfolger zu den eigenen Rückgaben ("Tank war leer …").
    async function loadReturnNotes() {
        const list = $('returnNotes');
        const { data, error } = await client.from('tt_handovers').select('*').eq('previous_driver_id', profile.id).order('created_at', { ascending: false }).limit(20);
        list.replaceChildren();
        if (error) return;
        data.filter(item => item.start_note).slice(0, 3).forEach(item => {
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
            TerminCloud.callFunction?.({ action: 'vehicle', kind: 'return' })?.catch?.(() => null);
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
            entry.append(el('span', 'directory-entry-name', `${new Date(`${item.date}T00:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })} · ${item.place} · ${money(item.amount)}`), side);
            list.append(entry);
        });
    }

    // Sobald ein Foto gewählt ist, liest das Handy Betrag, Datum und Ort selbst aus.
    let scanToken = 0;
    // Der Beleg wird wie eine Unterlage gescannt (Kamera in der App, Rand erkannt, aufgehellt) und als PDF gespeichert.
    let receiptPage = null;       // { blob, width, height, file } – der zugeschnittene Beleg
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
        const result = await ScanCam.open({ title: 'Beleg scannen', single: true, shape: 'beleg', onCapture: file => useReceiptFile(file) });
        if (result.reason === 'galerie') $('receiptPhoto').click();
        else if (result.reason === 'fehler') { toast(`${result.error || 'Die Kamera konnte nicht gestartet werden.'} Wähle das Foto aus der Galerie oder nimm die Foto-App.`, 'info'); $('receiptPhoto').click(); }
    });
    $('receiptPhoto').addEventListener('change', () => { const file = $('receiptPhoto').files?.[0]; $('receiptPhoto').value = ''; if (file) useReceiptFile(file); });

    async function useReceiptFile(original) {
        let file = original;
        const status = $('receiptScan');
        const token = ++scanToken;
        clearReceiptPage();
        status.hidden = false;
        status.dataset.kind = 'busy';
        status.textContent = 'Beleg wird zugeschnitten …';
        try {
            // Rand erkennen, gerade rücken, aufhellen – wie bei den Unterlagen. Klappt das nicht, bleibt das Foto, wie es ist.
            const scanned = window.DocScan ? await DocScan.process(original) : null;
            if (token !== scanToken) return;
            if (scanned?.blob) {
                receiptPage = { blob: scanned.blob, width: scanned.width, height: scanned.height, cropped: Boolean(scanned.cropped) };
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
        $('receiptPreviewImage').src = URL.createObjectURL(receiptPage.blob);
        $('receiptPreviewInfo').textContent = receiptPage.cropped ? 'Beleg erkannt und zugeschnitten – wird als PDF gespeichert.' : 'Ganzes Foto – wird als PDF gespeichert.';
        $('receiptPreview').hidden = false;
        $('receiptScanLabel').textContent = 'Beleg neu scannen';
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
    }

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
    $('overtimeDate').addEventListener('change', fillOvertimeJobs);
    $('overtimeJob').addEventListener('change', () => {
        $('overtimeJobText').hidden = $('overtimeJob').value !== 'other';
        $('overtimeJobText').required = $('overtimeJob').value === 'other';
        if ($('overtimeJob').value === 'other') $('overtimeJobText').focus();
        suggestOvertimeTimes();
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
    const unreadMessages = () => messageData.filter(item => !readIds.has(item.id)).length + chatData.filter(item => item.from_staff && !item.read_at).length;
    async function loadMessages() {
        const [messages, reads, chat] = await Promise.all([
            client.from('tt_messages').select('*').order('created_at', { ascending: false }).limit(50),
            client.from('tt_message_reads').select('message_id').eq('profile_id', profile.id),
            client.from('tt_chat').select('*').eq('thread_id', profile.id).order('created_at', { ascending: false }).limit(200)
        ]);
        const before = loadMessages.loaded ? unreadMessages() : 0;
        if (messages.error) messageData = [];
        else {
            // Nachrichten aus der Zeit vor dem eigenen Konto sind nicht mehr wichtig.
            messageData = messages.data.filter(item => !profile.created_at || item.created_at >= profile.created_at);
            readIds = new Set(reads.error ? [] : reads.data.map(item => item.message_id));
        }
        chatReady = !chat.error;
        chatData = chat.error ? [] : [...chat.data].reverse();
        const unread = unreadMessages();
        if (loadMessages.loaded && unread > before && currentView !== 'messages') toast('Neue Nachricht von der Einsatzleitung.', 'success', null, { label: 'Lesen', run: () => goTo('messages') });
        loadMessages.loaded = true;
        if (currentView === 'messages') { renderMessages(); markMessagesRead(); }
    }

    const AUDIENCE_NOTE = { alle: 'an alle', fest: 'an alle Festangestellten', 'temporär': 'an alle Temporären' };
    function chatDay(iso) {
        const date = new Date(iso);
        const start = value => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
        const days = Math.round((start(new Date()) - start(date)) / 86400000);
        return days === 0 ? 'Heute' : days === 1 ? 'Gestern' : date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    function renderMessages(force = false) {
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
        if (!unread.length && !unreadChat) return;
        const [reads, chat] = await Promise.all([
            unread.length ? client.from('tt_message_reads').upsert(unread.map(item => ({ message_id: item.id, profile_id: profile.id })), { onConflict: 'message_id,profile_id' }) : { error: null },
            unreadChat ? client.rpc('tt_chat_read', { p_thread: null }) : { error: null }
        ]);
        if (!reads.error) unread.forEach(item => readIds.add(item.id));
        if (!chat.error && unreadChat) { const now = new Date().toISOString(); chatData.forEach(item => { if (item.from_staff && !item.read_at) item.read_at = now; }); }
        const left = unreadMessages();
        $('messagesBadge').hidden = !left;
        $('messagesBadge').textContent = left ? String(left) : '';
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
        client, config, toast, showSuccess, goTo, el, emptyItem, makeWizard, choiceButtons, parseJobMessage, isoDate, svgSpan,
        profile: () => profile, jobs: () => jobsData, view: () => currentView,
        isFest: () => isFest(), refreshWorkdays: () => loadWorkdays(), refreshAccount: () => renderAccount(),
        setProfile: fields => { if (profile) Object.assign(profile, fields); }
    };

    refresh();
})();
