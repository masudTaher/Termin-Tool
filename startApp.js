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

    // ---------- Heute live: Stand aus der Datenbank (Termine, Dolmetscher, Fahrzeuge) und der Blick auf morgen ----------
    const liveEl = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const liveDuration = minutes => minutes == null ? '' : minutes < 1 ? 'gerade eben' : minutes < 60 ? `${minutes} Min` : `${Math.floor(minutes / 60)} Std ${String(minutes % 60).padStart(2, '0')} Min`;
    let liveBusy = false;
    async function loadLive(profile) {
        const section = $('startLive');
        if (!section || typeof PeopleLive === 'undefined' || !TerminCloud.isStaff(profile) || liveBusy) { if (section && !TerminCloud.isStaff(profile)) section.hidden = true; return; }
        liveBusy = true;
        try {
            const today = TerminCloud.todayIso();
            const tomorrow = AbsenceLogic.addDays(today, 1);
            const [live, next] = await Promise.all([PeopleLive.load(today), PeopleLive.load(tomorrow)]);
            section.hidden = false;
            // Die Zahlen des Tages kommen jetzt aus der Datenbank; die Anzeige aus dem Speicher dieses Geräts wäre doppelt.
            if (live.day) $('startDay').hidden = true;
            $('liveOpen').textContent = live.day ? String(live.day.offen) : '–';
            $('liveOpenSub').textContent = live.day ? `von ${plural(live.day.total, 'Termin', 'Terminen')} · ${live.day.erledigt} erledigt${live.day.storniert ? ` · ${live.day.storniert} storniert` : ''}` : 'der Tag ist noch nicht geladen';
            $('liveOut').textContent = String(live.counts.unterwegs);
            $('liveOutSub').textContent = live.day ? plural(live.day.unterwegs, 'Termin läuft', 'Termine laufen') : '';
            $('liveFree').textContent = String(live.counts.frei);
            const noJob = live.people.filter(person => person.state === 'frei' && !person.jobs.total).length;
            $('liveFreeSub').textContent = live.counts.frei ? `${noJob} ohne Auftrag` : '';
            $('liveAway').textContent = String(live.counts.abwesend);
            $('liveAwaySub').textContent = live.people.filter(person => person.state === 'abwesend').slice(0, 2).map(person => person.name.split(' ')[0]).join(', ') + (live.counts.abwesend > 2 ? ' …' : '');
            $('liveCars').textContent = String(live.vehicles?.out ?? 0);
            $('liveCarsSub').textContent = live.vehicles ? `${live.vehicles.free} frei${live.vehicles.service ? ` · ${live.vehicles.service} in der Werkstatt` : ''}` : '';
            // Gerade unterwegs: am längsten unterwegs zuerst
            const running = live.people.filter(person => person.state === 'unterwegs').sort((left, right) => (right.sinceMinutes ?? -1) - (left.sinceMinutes ?? -1));
            const list = $('liveRunning');
            list.replaceChildren(...running.slice(0, 8).map(person => {
                const item = liveEl('li', 'live-entry');
                const text = liveEl('span');
                text.append(liveEl('strong', null, person.name), liveEl('small', null, [person.current.time ? `${person.current.time} Uhr` : '', person.current.title].filter(Boolean).join(' · ')));
                const side = liveEl('span', 'live-side');
                side.append(liveEl('b', null, person.current.since ? `seit ${person.current.since}` : ''), liveEl('small', null, [liveDuration(person.sinceMinutes), person.vehicle?.plate].filter(Boolean).join(' · ')));
                item.append(text, side);
                return item;
            }));
            if (!running.length) list.append(liveEl('li', 'directory-empty', 'Gerade ist niemand unterwegs.'));
            if (running.length > 8) list.append(liveEl('li', 'directory-empty', `und ${running.length - 8} weitere – alle unter „Dolmetscher“`));
            // Morgen: wer kommt, wer fehlt, wer hat noch nicht geantwortet
            $('liveTomorrowTitle').textContent = `Morgen · ${AbsenceLogic.parse(tomorrow).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' })}`;
            const open = next.ask.open.length;
            $('liveTomorrow').textContent = next.people.length
                ? [`${next.counts.frei} ${next.counts.frei === 1 ? 'kommt' : 'kommen'}`, next.counts.abwesend ? `${next.counts.abwesend} abwesend` : '', next.counts.nichtda ? `${next.counts.nichtda} ${next.counts.nichtda === 1 ? 'kommt' : 'kommen'} nicht` : '',
                    open ? `${open} ohne Antwort${next.request ? ' (angefragt)' : ''}` : ''].filter(Boolean).join(' · ')
                : 'Noch keine freigeschalteten Dolmetscher.';
            $('liveTomorrowLink').textContent = open && !next.request ? `Für morgen anfragen (${open})` : 'Wer kommt morgen?';
            $('startLiveTime').textContent = `Stand ${new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`;
        } catch (error) {
            section.hidden = true;                    // ohne Verbindung bleibt die Seite wie bisher
        } finally {
            liveBusy = false;
        }
    }
    let liveProfile = null;
    $('startLiveReload')?.addEventListener('click', () => loadLive(liveProfile));
    window.setInterval(() => { if (!document.hidden && liveProfile) loadLive(liveProfile); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && liveProfile) loadLive(liveProfile); });

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
        liveProfile = TerminCloud.isStaff(profile) ? profile : null;
        loadLive(profile);
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
        const total = countsOnline.alerts + countsOnline.damages + countsOnline.payroll + countsOnline.accounts + (countsOnline.fest || 0) + (countsOnline.documents || 0) + (countsOnline.requests || 0);
        info.textContent = total ? `${plural(total, 'Punkt wartet', 'Punkte warten')} auf dich.` : 'Alles erledigt. Im Moment wartet nichts auf dich.';
        list.append(
            todoItem('Neue Unterlagen und Berichte der Dolmetscher', countsOnline.documents || 0, 'patienten.html'),
            todoItem('Meldungen und Hinweise aus Fahrzeugen', countsOnline.alerts, 'fahrzeugakte.html'),
            todoItem('Neue Schäden', countsOnline.damages, 'fahrzeugakte.html'),
            ...(countsOnline.requests ? [todoItem('Angeforderte Fotos sind da', countsOnline.requests, 'fahrzeugakte.html')] : []),
            todoItem('Abrechnung: neue Belege und Einwände', countsOnline.payroll, 'abrechnung.html'),
            todoItem('Festangestellte: Überstunden und Belege prüfen', (countsOnline.fest || 0) - (countsOnline.absences || 0), 'festangestellte.html'),
            ...(countsOnline.absences ? [todoItem('Urlaubsanträge und Krankmeldungen', countsOnline.absences, 'festangestellte.html?reiter=abwesenheiten')] : [])
        );
        if (TerminCloud.isAdmin(profile)) list.append(todoItem('Konten: Freischaltung oder Passwort vergessen', countsOnline.accounts, 'team.html'));
        const write = todoItem('Nachricht an die Dolmetscher schreiben', 0, 'nachrichten.html');
        write.querySelector('b').textContent = '→';
        list.append(write);
    }
    loadTodo();
})();
