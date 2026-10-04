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

    const icon = paths => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const ICONS = {
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
        clock: icon('<circle cx="12" cy="12.500" r="8"/><path d="M12 8v4.500l3 2M9.500 2.500h5"/>'),
        message: icon('<path d="M4.500 6.500a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4.500 3.500v-3.500a2 2 0 0 1-2-2z"/><path d="M8.500 9h7M8.500 12h4.500"/>')
    };

    const NAV = [
        { group: '', items: [
            { page: 'start', href: 'index.html', label: 'Übersicht', icon: ICONS.home }
        ] },
        { group: 'Tagesablauf', items: [
            { page: 'filtern', href: 'termineFiltern.html', label: 'Filtern', step: '1', icon: ICONS.filter },
            { page: 'tracking', href: 'termineTracking.html', label: 'Live-Tracking', step: '2', icon: ICONS.tracking }
        ] },
        { group: 'Stammdaten', items: [
            { page: 'dolmetscher', href: 'dolmetscher.html', label: 'Dolmetscher', icon: ICONS.people },
            { page: 'fahrzeuge', href: 'fahrzeuge.html', label: 'Fahrzeuge', icon: ICONS.car }
        ] },
        { group: 'Online', items: [
            { page: 'fahrzeugakte', href: 'fahrzeugakte.html', label: 'Fahrzeugakten', icon: ICONS.folder },
            { page: 'archiv', href: 'archiv.html', label: 'Online-Archiv', icon: ICONS.archive },
            { page: 'abrechnung', href: 'abrechnung.html', label: 'Abrechnung', icon: ICONS.euro },
            { page: 'fest', href: 'festangestellte.html', label: 'Überstunden', icon: ICONS.clock },
            { page: 'nachrichten', href: 'nachrichten.html', label: 'Nachrichten', icon: ICONS.message },
            { page: 'team', href: 'team.html', label: 'Team', icon: ICONS.cloud }
        ] }
    ];

    function buildShell() {
        const current = document.body.dataset.page || '';
        const nav = document.createElement('aside');
        nav.className = 'app-nav';
        nav.innerHTML = `
            <a class="app-brand" href="index.html" aria-label="Botschaft Dolmetscher und Transport-App – Übersicht">
                <span class="app-brand-mark" aria-hidden="true">BD</span>
                <span class="app-brand-copy"><strong>Botschaft</strong><small>Dolmetscher und Transport-App</small></span>
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

        const toasts = document.createElement('div');
        toasts.id = 'toastRegion';
        toasts.className = 'toast-region';
        toasts.setAttribute('role', 'status');
        toasts.setAttribute('aria-live', 'polite');
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

    // Kurze Einblendung unten rechts; optional mit einer Aktion wie „Rückgängig“.
    window.showToast = function (message, kind = 'info', options = {}) {
        const region = document.getElementById('toastRegion');
        if (!region) return;
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.dataset.kind = kind;
        const text = document.createElement('span');
        text.textContent = message;
        toast.append(text);
        const remove = () => toast.remove();
        if (options.actionLabel && typeof options.onAction === 'function') {
            const action = document.createElement('button');
            action.type = 'button';
            action.textContent = options.actionLabel;
            action.addEventListener('click', () => { remove(); options.onAction(); });
            toast.append(action);
        }
        region.append(toast);
        while (region.children.length > 4) region.firstElementChild.remove();
        window.setTimeout(remove, options.duration || (kind === 'error' ? 8000 : 5000));
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
        link.download = `Botschaft-App_Stammdaten_${stamp}.json`;
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
})();
