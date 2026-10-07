// Gemeinsame Oberfläche aller Seiten: Seitenleiste, Hell/Dunkel, Einblendungen,
// Bestätigungsdialog und die Gesamtsicherung der Stammdaten.
(function () {
    const THEME_KEY = 'terminTool.theme';
    const MASTER_DATA_KEYS = [
        'terminTool.interpreterDirectory.v1',
        'terminTool.fleet.vehicles.v1',
        'terminTool.fleet.handovers.v1',
        'terminTool.fleet.drivers.v1',
        'terminTool.filterRules.v1'
    ];

    function readTheme() {
        try {
            return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light';
        } catch (error) {
            return 'light';
        }
    }

    function applyTheme(theme) {
        document.documentElement.dataset.theme = theme;
        const button = document.getElementById('themeToggle');
        if (button) {
            button.setAttribute('aria-pressed', String(theme === 'dark'));
            button.querySelector('span').textContent = theme === 'dark' ? 'Hell' : 'Dunkel';
        }
    }

    // Sofort setzen, damit die Seite nicht erst hell aufblitzt.
    applyTheme(readTheme());

    // Die Einsatzleitung lässt sich wie das Portal als App aufs Handy legen.
    (function addAppMeta() {
        const add = (tag, attributes) => { const node = document.createElement(tag); Object.entries(attributes).forEach(([key, value]) => node.setAttribute(key, value)); document.head.append(node); };
        add('link', { rel: 'manifest', href: 'manifest-admin.json' });
        add('meta', { name: 'theme-color', content: '#10243d' });
        add('meta', { name: 'mobile-web-app-capable', content: 'yes' });
        add('meta', { name: 'apple-mobile-web-app-capable', content: 'yes' });
        add('meta', { name: 'apple-mobile-web-app-title', content: 'Einsatzleitung' });
        add('meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' });
        add('link', { rel: 'apple-touch-icon', href: 'icon-admin-180.png' });
        add('link', { rel: 'icon', type: 'image/png', sizes: '192x192', href: 'icon-admin-192.png' });
    })();

    const icon = paths => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const ICONS = {
        pin: icon('<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>'),
        filter: icon('<path d="M4 5h16l-6 7.5V19l-4 1.5v-8z"/>'),
        tracking: icon('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
        people: icon('<circle cx="9" cy="8" r="3.2"/><path d="M3 19.5c0-3.2 2.7-5.5 6-5.5s6 2.3 6 5.5"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6"/><path d="M17.5 14.3c2 .7 3.5 2.6 3.5 5.2"/>'),
        car: icon('<path d="M5 16.5V12l1.8-5a2 2 0 0 1 1.9-1.3h6.6A2 2 0 0 1 17.2 7L19 12v4.500"/><path d="M4 12h16"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.500" cy="16.500" r="1.800"/><path d="M9.3 16.5h5.4"/>'),
        save: icon('<path d="M12 4v11"/><path d="M7.5 10.500 12 15l4.500-4.500"/><path d="M5 19.500h14"/>'),
        load: icon('<path d="M12 15V4"/><path d="M7.500 8.500 12 4l4.500 4.500"/><path d="M5 19.500h14"/>'),
        folder: icon('<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
        archive: icon('<rect x="3.5" y="5" width="17" height="4.5" rx="1.2"/><path d="M5 9.5V18a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 19 18V9.5"/><path d="M10 13.5h4"/>'),
        euro: icon('<path d="M17.5 6.5a6.5 6.5 0 1 0 0 11"/><path d="M4 10.5h9M4 13.5h9"/>'),
        cloud: icon('<path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.7 1.1A3.9 3.9 0 0 1 17 18.5z"/>'),
        moon: icon('<path d="M20 14.500A8 8 0 0 1 9.500 4a8 8 0 1 0 10.500 10.500z"/>'),
        home: icon('<path d="M4 11.5 12 5l8 6.500"/><path d="M6 10.500V19h4.500v-5h3v5H18v-8.500"/>'),
        menu: icon('<path d="M4 7h16M4 12h16M4 17h16"/>'),
        clock: icon('<circle cx="12" cy="12.500" r="8"/><path d="M12 8v4.500l3 2M9.500 2.500h5"/>'),
        message: icon('<path d="M4.500 6.500a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.500 3.500v-3.500a2 2 0 0 1-2-2z"/><path d="M8.500 9h7M8.500 12h4.500"/>'),
        calendar: icon('<rect x="4" y="5.5" width="16" height="14" rx="2"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/><path d="M12 12.5v4M10 14.5h4"/>'),
        patients: icon('<path d="M7.500 3.500H14l4.500 4.500V19a1.500 1.500 0 0 1-1.500 1.500H7.500A1.500 1.500 0 0 1 6 19V5a1.500 1.500 0 0 1 1.500-1.500z"/><path d="M14 3.500V8h4.500"/><path d="M9 12.500h6M9 16h4"/>')
    };

    // Vier Bereiche: Tagesablauf (Live-Tracking) · Patienten · Fahrzeuge · Dolmetscher – dazu die Verwaltung der Konten.
    const NAV = [
        { group: '', items: [
            { page: 'start', href: 'index.html', label: 'Übersicht', icon: ICONS.home }
        ] },
        { group: 'Tagesablauf', items: [
            { page: 'filtern', href: 'termineFiltern.html', label: 'Filtern', step: '1', icon: ICONS.filter },
            { page: 'tracking', href: 'termineTracking.html', label: 'Live-Tracking', step: '2', icon: ICONS.tracking },
            { page: 'archiv', href: 'archiv.html', label: 'Tagesarchiv', icon: ICONS.archive },
            { page: 'termine', href: 'neueTermine.html', label: 'Neue Termine', icon: ICONS.calendar },
            { page: 'berichte', href: 'neueBerichte.html', label: 'Neue Berichte', icon: ICONS.patients },
            { page: 'rezepte', href: 'neueRezepte.html', label: 'Neue Rezepte', icon: ICONS.patients }
        ] },
        { group: 'Patienten', items: [
            { page: 'patienten', href: 'patienten.html', label: 'Patientenakten', icon: ICONS.patients }
        ] },
        { group: 'Fahrzeuge', items: [
            { page: 'fahrzeugakte', href: 'fahrzeugakte.html', label: 'Fuhrpark', icon: ICONS.car },
            { page: 'fahrzeuge', href: 'fahrzeuge.html', label: 'Übergaben', icon: ICONS.folder }
        ] },
        { group: 'Dolmetscher', items: [
            { page: 'dolmetscher', href: 'dolmetscher.html', label: 'Dolmetscher', icon: ICONS.people },
            { page: 'aerzte', href: 'aerzte.html', label: 'Ärzte & Standorte', icon: ICONS.pin },
            { page: 'abrechnung', href: 'abrechnung.html', label: 'Abrechnung', icon: ICONS.euro },
            { page: 'fest', href: 'festangestellte.html', label: 'Festangestellte', icon: ICONS.clock },
            { page: 'nachrichten', href: 'nachrichten.html', label: 'Nachrichten', icon: ICONS.message }
        ] },
        { group: 'Verwaltung', items: [
            { page: 'team', href: 'team.html', label: 'Team', icon: ICONS.cloud }
        ] }
    ];

    function buildShell() {
        const current = document.body.dataset.page || '';
        const nav = document.createElement('aside');
        nav.className = 'app-nav';
        nav.innerHTML = `
            <a class="app-brand" href="index.html" aria-label="Medical Office Bonn – Übersicht">
                <span class="app-brand-mark" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M3 12.5h4l2-4.5 3.2 8.6 2.6-6.4 1.4 2.3H21"/></svg></span>
                <span class="app-brand-copy"><strong>Medical Office Bonn</strong><small>Transport und Dolmetscher</small></span>
            </a>
            <nav aria-label="Hauptnavigation">
                ${NAV.map(section => `
                    ${section.group ? `<p class="app-nav-group">${section.group}</p>` : ''}
                    ${section.items.map(item => `
                        <a class="app-nav-link" data-nav="${item.page}" href="${item.href}" title="${item.label}"${item.page === current ? ' aria-current="page"' : ''}>
                            ${item.icon}<span>${item.label}</span>${item.step ? `<em aria-hidden="true">${item.step}</em>` : ''}
                        </a>`).join('')}
                `).join('')}
            </nav>
            <div class="app-nav-footer">
                <div class="app-nav-tools">
                    <button type="button" class="app-nav-link" id="exportMasterData" title="Dolmetscher, Fahrzeuge, Übergaben und Filterregeln in eine Datei sichern">${ICONS.save}<span>Sichern</span></button>
                    <button type="button" class="app-nav-link" id="importMasterDataButton" title="Sicherungsdatei laden">${ICONS.load}<span>Laden</span></button>
                    <button type="button" class="app-nav-link" id="themeToggle" aria-pressed="false" title="Hell / Dunkel umschalten">${ICONS.moon}<span>Dunkel</span></button>
                </div>
                <input type="file" id="importMasterDataFile" accept=".json,application/json" hidden>
                <div class="app-nav-cloud" id="navCloud">
                    <a class="app-nav-note" id="navCloudState" href="team.html"><i aria-hidden="true"></i><span>Lokal gespeichert; mit Anmeldung unter „Team“ auch online</span></a>
                    <div id="navStorage" class="nav-storage" hidden></div>
                </div>
            </div>`;
        document.body.prepend(nav);

        // Handy: unten eine feste Leiste mit den wichtigsten Seiten, „Mehr“ öffnet das ganze Menü.
        const tabs = [
            { page: 'start', href: 'index.html', label: 'Übersicht', icon: ICONS.home },
            { page: 'tracking', href: 'termineTracking.html', label: 'Tag', icon: ICONS.tracking },
            { page: 'patienten', href: 'patienten.html', label: 'Patienten', icon: ICONS.patients },
            { page: 'fahrzeugakte', href: 'fahrzeugakte.html', label: 'Fuhrpark', icon: ICONS.car }
        ];
        const tabbar = document.createElement('nav');
        tabbar.className = 'app-tabbar';
        tabbar.setAttribute('aria-label', 'Schnellzugriff');
        tabbar.innerHTML = tabs.map(item => `<a class="app-tab" data-tab="${item.page}" href="${item.href}"${item.page === current ? ' aria-current="page"' : ''}>${item.icon}<span>${item.label}</span></a>`).join('')
            + `<button type="button" class="app-tab" id="appMenuToggle" aria-expanded="false" aria-controls="appNavDrawer">${ICONS.menu}<span>Mehr</span></button>`;
        nav.id = 'appNavDrawer';
        document.body.append(tabbar);
        const closeButton = document.createElement('button');
        closeButton.type = 'button';
        closeButton.className = 'app-nav-close';
        closeButton.setAttribute('aria-label', 'Menü schließen');
        closeButton.textContent = '×';
        nav.prepend(closeButton);
        const setMenu = open => {
            document.body.classList.toggle('nav-open', open);
            document.getElementById('appMenuToggle').setAttribute('aria-expanded', String(open));
        };
        document.getElementById('appMenuToggle').addEventListener('click', () => setMenu(!document.body.classList.contains('nav-open')));
        closeButton.addEventListener('click', () => setMenu(false));
        document.addEventListener('keydown', event => { if (event.key === 'Escape') setMenu(false); });

        const toasts = document.createElement('div');
        toasts.id = 'toastRegion';
        toasts.className = 'toast-region';
        toasts.setAttribute('role', 'status');
        toasts.setAttribute('aria-live', 'polite');
        toasts.setAttribute('popover', 'manual');      // damit Anzeigen auch über geöffneten Dialogen liegen
        document.body.append(toasts);

        applyTheme(readTheme());
        document.getElementById('themeToggle').addEventListener('click', () => {
            const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
            try { localStorage.setItem(THEME_KEY, next); } catch (error) { /* Auswahl gilt dann nur bis zum Neuladen. */ }
            applyTheme(next);
        });
        document.getElementById('exportMasterData').addEventListener('click', exportMasterData);
        document.getElementById('importMasterDataButton').addEventListener('click', () => document.getElementById('importMasterDataFile').click());
        document.getElementById('importMasterDataFile').addEventListener('change', importMasterData);
    }

    // Anzeige oben in der Mitte: grün = gespeichert (5 Sekunden), rot = Problem (bleibt länger).
    // Ein Tipp auf die rote Anzeige führt zur Stelle des Fehlers (options.target: Element oder CSS-Auswahl;
    // ohne Angabe das erste sichtbare Feld mit Fehlermeldung). Optional mit einer Aktion wie „Rückgängig“.
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

    window.jumpToProblem = function (target) {
        const node = findProblem(target);
        if (!node) return false;
        // Zugeklappte Bereiche öffnen, damit die Stelle sichtbar ist.
        for (let parent = node.parentElement; parent; parent = parent.parentElement) { if (parent.tagName === 'DETAILS') parent.open = true; }
        node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (node.matches('input, select, textarea, button, a[href], [tabindex]')) node.focus({ preventScroll: true });
        node.classList.add('is-flagged');
        window.setTimeout(() => node.classList.remove('is-flagged'), 2600);
        return true;
    };

    window.showToast = function (message, kind = 'info', options = {}) {
        const region = document.getElementById('toastRegion');
        if (!region) return;
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.dataset.kind = kind;
        toast.insertAdjacentHTML('afterbegin', TOAST_ICONS[kind] || TOAST_ICONS.info);
        const text = document.createElement('span');
        text.textContent = message;
        toast.append(text);
        const duration = options.duration || (kind === 'error' ? 10000 : 5000);
        toast.style.setProperty('--toast-time', `${duration}ms`);
        const remove = () => toast.remove();
        if (options.actionLabel && typeof options.onAction === 'function') {
            const action = document.createElement('button');
            action.type = 'button';
            action.textContent = options.actionLabel;
            action.addEventListener('click', event => { event.stopPropagation(); remove(); options.onAction(); });
            toast.append(action);
        }
        if (kind === 'error') {
            const target = findProblem(options.target);
            if (target) {
                toast.classList.add('has-target');
                toast.setAttribute('role', 'button');
                toast.tabIndex = 0;
                const hint = document.createElement('em');
                hint.className = 'toast-jump';
                hint.textContent = 'Zur Stelle';
                toast.append(hint);
                const jump = () => { remove(); window.jumpToProblem(options.target || target); };
                toast.addEventListener('click', jump);
                toast.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); } });
            } else {
                toast.addEventListener('click', remove);
            }
        } else if (!options.actionLabel) {
            toast.addEventListener('click', remove);
        }
        // Eine Anzeige je Art: Eine neue rote ersetzt die alte; sobald etwas geklappt hat, sind ältere Fehlermeldungen überholt.
        // Anzeigen mit einer Aktion („Rückgängig“) bleiben stehen, bis ihre Zeit abgelaufen ist.
        // options.keep: Meldungen von außen (ein Dolmetscher sagt zu, sagt ab, ist fertig …) – jede zählt. Sie werden
        // nicht von der nächsten Anzeige ersetzt, sondern stehen untereinander (höchstens fünf), bis ihre Zeit um ist.
        if (options.keep) toast.dataset.keep = '1';
        region.querySelectorAll(kind === 'error' ? '.toast[data-kind="error"]' : `.toast[data-kind="${kind}"], .toast[data-kind="error"]`)
            .forEach(old => { if (!old.querySelector('button') && !old.dataset.keep) old.remove(); });
        region.append(toast);
        const limit = region.querySelector('.toast[data-keep]') ? 5 : 3;
        while (region.children.length > limit) region.firstElementChild.remove();
        // Oberste Ebene des Browsers: so liegt die Anzeige auch über einem geöffneten Dialog.
        if (typeof region.showPopover === 'function') {
            try { if (region.matches(':popover-open')) region.hidePopover(); region.showPopover(); } catch (error) { /* ältere Browser: normale Ebene */ }
        }
        window.setTimeout(remove, duration);
    };

    // Ersatz für confirm(): liefert true/false als Promise.
    window.confirmDialog = function (message, okLabel = 'OK', cancelLabel = 'Abbrechen') {
        return new Promise(resolve => {
            const dialog = document.createElement('dialog');
            dialog.className = 'confirm-dialog';
            const text = document.createElement('p');
            text.textContent = message;
            const buttons = document.createElement('div');
            buttons.className = 'modal-buttons';
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'button-secondary';
            cancel.textContent = cancelLabel;
            const ok = document.createElement('button');
            ok.type = 'button';
            ok.className = 'button-primary';
            ok.textContent = okLabel;
            buttons.append(cancel, ok);
            dialog.append(text, buttons);
            document.body.append(dialog);
            const finish = result => { dialog.close(); dialog.remove(); resolve(result); };
            cancel.addEventListener('click', () => finish(false));
            ok.addEventListener('click', () => finish(true));
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
            dialog.showModal();
            ok.focus();
        });
    };

    function exportMasterData() {
        const data = {};
        MASTER_DATA_KEYS.forEach(key => {
            try {
                const raw = localStorage.getItem(key);
                if (raw !== null) data[key] = JSON.parse(raw);
            } catch (error) { /* Unlesbare Einträge werden übersprungen. */ }
        });
        if (!Object.keys(data).length) {
            showToast('Es gibt noch keine Stammdaten zum Sichern.', 'info');
            return;
        }
        const now = new Date();
        const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const blob = new Blob([JSON.stringify({ app: 'termin-tool', version: 1, exportedAt: now.toISOString(), data }, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `Medical-Office-Bonn_Stammdaten_${stamp}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        showToast('Dolmetscher, Fahrzeuge, Übergaben und Filterregeln wurden in eine Datei gesichert.', 'success');
    }

    async function importMasterData(event) {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        let backup;
        try {
            backup = JSON.parse(await file.text());
        } catch (error) {
            showToast('Die Datei ist keine gültige Sicherung dieser App.', 'error');
            return;
        }
        const entries = backup?.app === 'termin-tool' && backup.data && typeof backup.data === 'object'
            ? Object.entries(backup.data).filter(([key, value]) => MASTER_DATA_KEYS.includes(key) && value && typeof value === 'object')
            : [];
        if (!entries.length) {
            showToast('Die Datei ist keine gültige Sicherung dieser App.', 'error');
            return;
        }
        const confirmed = await confirmDialog('Die Sicherung ersetzt die Dolmetscher, Fahrzeuge, Übergaben und Filterregeln auf diesem Gerät. Fortfahren?', 'Sicherung laden');
        if (!confirmed) return;
        try {
            entries.forEach(([key, value]) => localStorage.setItem(key, JSON.stringify(value)));
        } catch (error) {
            showToast('Die Sicherung konnte nicht gespeichert werden. Prüfe den Browserspeicher.', 'error');
            return;
        }
        window.location.reload();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildShell);
    else buildShell();

    // Für Mitteilungen aufs Gerät der Einsatzleitung (z. B. „Dolmetscher wieder frei“) – der Rest der Seite braucht ihn nicht.
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('sw.js').catch(() => { /* ohne Service Worker gibt es nur die Anzeigen in der App */ });
    }
})();
