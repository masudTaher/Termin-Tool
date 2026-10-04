// Übersicht: zeigt auf einen Blick, wo der Tag steht und was online zu erledigen ist.
(function () {
    const $ = id => document.getElementById(id);
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

    // ---------- Begrüßung ----------
    const now = new Date();
    const hour = now.getHours();
    $('startGreeting').textContent = hour < 11 ? 'Guten Morgen' : hour < 18 ? 'Guten Tag' : 'Guten Abend';
    $('startToday').textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

    // ---------- Tagesablauf ----------
    const workflow = typeof readTerminWorkflow === 'function' ? readTerminWorkflow() : {};
    const records = Array.isArray(workflow.records) ? workflow.records : [];
    const step = workflow.step || '';
    const filteredCount = Array.isArray(workflow.filtered) ? workflow.filtered.length : 0;
    const removedCount = Array.isArray(workflow.removed) ? workflow.removed.length : 0;
    const statusGroup = item => {
        const status = String(item?.Status || 'offen').trim().toLocaleLowerCase('de-DE');
        if (status === 'beendet' || status === 'alleine') return 'erledigt';
        if (status === 'storniert') return 'storniert';
        if (status === 'losgefahren') return 'unterwegs';
        return 'offen';
    };
    const counts = { offen: 0, unterwegs: 0, erledigt: 0, storniert: 0 };
    records.forEach(item => { counts[statusGroup(item)] += 1; });

    $('flowFilternState').textContent = filteredCount || removedCount
        ? `${plural(filteredCount, 'Termin', 'Termine')} für uns, ${removedCount} herausgefiltert`
        : 'Hier beginnt der Tag';
    $('flowTrackingState').textContent = step === 'tracking' && records.length
        ? `${counts.offen} offen · ${counts.unterwegs} unterwegs · ${counts.erledigt} erledigt`
        : 'Nach dem Filtern';

    // Der nächste sinnvolle Schritt wird hervorgehoben.
    const inTracking = step === 'tracking' && records.length > 0;
    $(inTracking ? 'flowTracking' : 'flowFiltern').classList.add('is-next');
    $('flowFiltern').classList.toggle('is-done', inTracking);

    if (step === 'tracking' && records.length) {
        $('startDay').hidden = false;
        $('dayTotal').textContent = String(records.length);
        $('dayOpen').textContent = String(counts.offen);
        $('dayDeparted').textContent = String(counts.unterwegs);
        $('dayDone').textContent = String(counts.erledigt);
        $('dayCancelled').textContent = String(counts.storniert);
    }

    // ---------- Stammdaten ----------
    $('masterInterpreters').textContent = String(typeof readInterpreterDirectory === 'function' ? readInterpreterDirectory().length : 0);
    $('masterVehicles').textContent = String(typeof readActiveFleetVehicles === 'function' ? readActiveFleetVehicles().length : 0);

    // ---------- Portal-Link ----------
    const config = window.TERMIN_CLOUD_CONFIG || {};
    const runsLocally = ['127.0.0.1', 'localhost'].includes(location.hostname) || location.protocol === 'file:';
    $('startPortalLink').value = runsLocally && config.portalUrl ? config.portalUrl : new URL('portal.html', location.href).href;
    $('startCopyLink').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText($('startPortalLink').value);
            showToast('Link kopiert.', 'success');
        } catch (error) {
            $('startPortalLink').select();
            showToast('Link ist markiert – mit Strg+C kopieren.', 'info');
        }
    });

    // ---------- Mitteilungen auf diesem Gerät (Dolmetscher losgefahren / fertig und wieder frei) ----------
    const PUSH_WHAT = 'Du bekommst eine Mitteilung, wenn ein Dolmetscher losfährt oder fertig und wieder frei ist – auch wenn die App geschlossen ist.';
    async function renderPush(profile) {
        const info = $('startPushInfo');
        const button = $('startPushToggle');
        button.hidden = true;
        if (!profile) {
            info.textContent = 'Nach der Online-Anmeldung kannst du hier Mitteilungen für dieses Gerät einschalten.';
            return;
        }
        if (!TerminCloud.isStaff(profile)) {
            info.textContent = 'Mitteilungen gibt es hier nur für Einsatzleitung und Sekretariat.';
            return;
        }
        let state = 'unsupported';
        try { state = location.protocol.startsWith('http') ? await TerminCloud.pushState() : 'unsupported'; } catch (error) { /* bleibt „nicht möglich“ */ }
        const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
        info.textContent = state === 'on' ? `Eingeschaltet. ${PUSH_WHAT}`
            : state === 'blocked' ? 'Mitteilungen sind für diese Seite gesperrt. Erlaube sie in den Einstellungen des Browsers oder des Handys und lade die Seite neu.'
            : state === 'unsupported' ? (isIos
                ? 'Auf dem iPhone gehen Mitteilungen erst, wenn du die App auf den Home-Bildschirm gelegt hast und sie von dort öffnest.'
                : 'Auf diesem Gerät sind Mitteilungen nicht möglich. Öffne die App über die Internet-Adresse in Chrome, Edge oder Safari.')
            : PUSH_WHAT;
        button.hidden = state === 'unsupported' || state === 'blocked';
        button.textContent = state === 'on' ? 'Mitteilungen ausschalten' : 'Mitteilungen einschalten';
        button.className = state === 'on' ? 'button-secondary' : 'button-primary';
        button.dataset.state = state;
    }
    $('startPushToggle').addEventListener('click', async () => {
        const button = $('startPushToggle');
        const enable = button.dataset.state !== 'on';
        button.disabled = true;
        try {
            if (enable) { await TerminCloud.enablePush(); showToast('Mitteilungen sind auf diesem Gerät eingeschaltet.', 'success'); }
            else { await TerminCloud.disablePush(); showToast('Mitteilungen sind auf diesem Gerät ausgeschaltet.', 'info'); }
        } catch (error) {
            showToast(error.message || 'Mitteilungen konnten nicht umgeschaltet werden.', 'error', { target: '#startPushToggle' });
        }
        button.disabled = false;
        let profile = null;
        try { profile = await TerminCloud.getProfile(); } catch (error) { /* wie nicht angemeldet */ }
        renderPush(profile);
    });

    // ---------- Online: was zu erledigen ist ----------
    function todoItem(text, count, href) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = href;
        const label = document.createElement('span');
        label.textContent = text;
        const badge = document.createElement('b');
        badge.textContent = String(count);
        if (count > 0) badge.dataset.open = 'true';
        link.append(label, badge);
        item.append(link);
        return item;
    }

    async function loadTodo() {
        const info = $('startTodoInfo');
        const list = $('startTodo');
        list.replaceChildren();
        if (typeof TerminCloud === 'undefined' || !TerminCloud.available) {
            info.textContent = 'Die Online-Datenbank ist gerade nicht erreichbar. Lokal kannst du normal weiterarbeiten.';
            $('startPushInfo').textContent = 'Mitteilungen brauchen die Online-Datenbank. Sie ist gerade nicht erreichbar.';
            return;
        }
        let profile = null;
        try { profile = await TerminCloud.getProfile(); } catch (error) { /* wie nicht angemeldet */ }
        renderPush(profile);
        if (!profile) {
            info.textContent = 'Du bist nicht online angemeldet. Mit Anmeldung siehst du hier Meldungen, Schäden und die Abrechnung.';
            list.append(todoItem('Online anmelden', 0, 'team.html'));
            list.querySelector('b').textContent = '→';
            return;
        }
        let countsOnline = null;
        try { countsOnline = await TerminCloud.inboxCounts(); } catch (error) { /* unten behandelt */ }
        if (!countsOnline) {
            info.textContent = 'Für dieses Konto gibt es hier nichts zu erledigen.';
            return;
        }
        const total = countsOnline.alerts + countsOnline.damages + countsOnline.payroll + countsOnline.accounts + (countsOnline.fest || 0) + (countsOnline.documents || 0);
        info.textContent = total ? `${plural(total, 'Punkt wartet', 'Punkte warten')} auf dich.` : 'Alles erledigt. Im Moment wartet nichts auf dich.';
        list.append(
            todoItem('Neue Unterlagen und Berichte der Dolmetscher', countsOnline.documents || 0, 'patienten.html'),
            todoItem('Meldungen und Hinweise aus Fahrzeugen', countsOnline.alerts, 'fahrzeugakte.html'),
            todoItem('Neue Schäden', countsOnline.damages, 'fahrzeugakte.html'),
            todoItem('Abrechnung: neue Belege und Einwände', countsOnline.payroll, 'abrechnung.html'),
            todoItem('Festangestellte: Überstunden und Belege prüfen', countsOnline.fest || 0, 'festangestellte.html')
        );
        if (TerminCloud.isAdmin(profile)) list.append(todoItem('Konten: Freischaltung oder Passwort vergessen', countsOnline.accounts, 'team.html'));
        const write = todoItem('Nachricht an die Dolmetscher schreiben', 0, 'nachrichten.html');
        write.querySelector('b').textContent = '→';
        list.append(write);
    }
    loadTodo();
})();
