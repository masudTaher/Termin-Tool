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
            // Gezählt werden die Personen mit Portal-Konto. Läuft gerade ein Termin von jemandem ohne Konto, steht das als Hinweis da.
            const others = (live.withoutAccount || []).filter(person => person.state === 'unterwegs').length;
            if (!running.length && !others) list.append(liveEl('li', 'directory-empty', 'Gerade ist niemand unterwegs.'));
            if (running.length > 8) list.append(liveEl('li', 'directory-empty', `und ${running.length - 8} weitere – alle unter „Dolmetscher“`));
            if (others) list.append(liveEl('li', 'directory-empty', `${running.length ? 'Dazu ' : ''}${others === 1 ? '1 Person' : `${others} Personen`} ohne Portal-Konto unterwegs – zu sehen unter „Dolmetscher“ → „Ohne Konto“`));
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
        const total = countsOnline.alerts + countsOnline.damages + countsOnline.payroll + countsOnline.accounts + (countsOnline.fest || 0) + (countsOnline.documents || 0) + (countsOnline.requests || 0) + (countsOnline.appointments || 0) + (countsOnline.chat || 0);
        info.textContent = total ? `${plural(total, 'Punkt wartet', 'Punkte warten')} auf dich.` : 'Alles erledigt. Im Moment wartet nichts auf dich.';
        list.append(
            ...(countsOnline.doctor ? [todoItem('Meldungen des Arztes ansehen und beantworten', countsOnline.doctor, '#arzt')] : []),
            ...(countsOnline.corrections ? [todoItem('Korrekturen der Dolmetscher ansehen', countsOnline.corrections, '#korrekturen')] : []),
            ...(countsOnline.chat ? [todoItem('Neue Nachrichten der Dolmetscher', countsOnline.chat, 'nachrichten.html')] : []),
            ...(countsOnline.appointments ? [todoItem('Neue Termine der Dolmetscher eintragen', countsOnline.appointments, 'neueTermine.html')] : []),
            todoItem('Neue Berichte (Dolmetscher, Krankenhaus)', countsOnline.reports ?? countsOnline.documents ?? 0, 'neueBerichte.html'),
            todoItem('Neue Rezepte und Überweisungen', countsOnline.prescriptions || 0, 'neueRezepte.html'),
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

    // ---------- Korrekturen der Dolmetscher (Update 37) ----------
    // Zurückgenommenes Losfahren/Fertig, geänderte Antworten, zurückgenommene Stornierungen, geänderte oder gelöschte Berichte:
    // Die Dolmetscher dürfen das ohne Rückfrage – hier steht, wer was wann korrigiert hat. „Gesehen“ räumt den Eintrag ab.
    const CORRECTION_LABEL = { losfahren_zurueck: 'Losfahren zurückgenommen', fertig_zurueck: 'Fertig zurückgenommen', antwort: 'Antwort geändert', storno_zurueck: 'Stornierung zurückgenommen', unterlage: 'Bericht/Unterlage geändert', unterlage_geloescht: 'Unterlage gelöscht' };
    async function loadCorrections() {
        const card = $('startCorrections');
        if (!card || typeof TerminCloud === 'undefined' || !TerminCloud.available) return;
        let profile = null;
        try { profile = await TerminCloud.getProfile(); } catch (error) { return; }
        if (!TerminCloud.isStaff(profile)) return;
        const { data, error } = await TerminCloud.client.from('tt_corrections').select('*').order('at', { ascending: false }).limit(60);
        if (error) return;                                        // Update 37 fehlt noch: Karte bleibt aus
        const rows = data || [];
        const unseen = rows.filter(item => !item.seen_at);
        card.hidden = !rows.length;
        $('startCorrectionsSeen').hidden = !unseen.length;
        $('startCorrectionsInfo').textContent = unseen.length ? `${plural(unseen.length, 'neue Korrektur', 'neue Korrekturen')} – die Dolmetscher dürfen das ohne Rückfrage, du siehst es hier.` : 'Alles gesehen. Die letzten Korrekturen bleiben zur Nachschau stehen.';
        const list = $('startCorrectionsList');
        list.replaceChildren(...rows.slice(0, unseen.length ? 60 : 15).map(item => {
            const row = document.createElement('li');
            row.className = 'start-correction';
            row.dataset.seen = item.seen_at ? 'ja' : '';
            row.dataset.kind = item.kind;
            const at = new Date(item.at);
            const text = document.createElement('div');
            const head = document.createElement('strong');
            head.textContent = `${item.person_name || 'Dolmetscher'} · ${CORRECTION_LABEL[item.kind] || item.kind}`;
            const sub = document.createElement('small');
            sub.textContent = [item.title && !String(item.detail || '').startsWith(item.title) ? item.title : '', item.date ? new Date(`${item.date}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '', item.detail].filter(Boolean).join(' · ');
            const when = document.createElement('small');
            when.className = 'start-correction-when';
            when.textContent = `${at.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })} ${at.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr${item.seen_at ? ` · gesehen${item.seen_by ? ` von ${item.seen_by}` : ''}` : ''}`;
            text.append(head, sub, when);
            row.append(text);
            if (!item.seen_at) {
                const seen = document.createElement('button');
                seen.type = 'button';
                seen.className = 'button-secondary start-correction-seen';
                seen.textContent = 'Gesehen';
                seen.addEventListener('click', () => markCorrectionsSeen([item.id], profile));
                row.append(seen);
            }
            return row;
        }));
    }
    async function markCorrectionsSeen(ids, profile) {
        const { error } = await TerminCloud.client.from('tt_corrections').update({ seen_at: new Date().toISOString(), seen_by: profile.full_name || '' }).in('id', ids);
        if (error) { window.showToast?.(TerminCloud.germanError(error), 'error'); return; }
        await loadCorrections();
        loadTodo();
        window.refreshCloudInbox?.();
    }
    $('startCorrectionsSeen')?.addEventListener('click', async () => {
        const profile = await TerminCloud.getProfile().catch(() => null);
        const { data } = await TerminCloud.client.from('tt_corrections').select('id').is('seen_at', null);
        if (profile && data?.length) await markCorrectionsSeen(data.map(item => item.id), profile);
    });
    loadCorrections();
    window.setInterval(() => { if (!document.hidden) loadCorrections(); }, 60000);

    // ---------- Meldungen des Arztes (Update 42) ----------
    // Der Arzt meldet der Einsatzleitung etwas (Bericht, Termin, Patient, Sonstiges) – hier abhaken und antworten.
    // Darunter: was er den Dolmetschern geschrieben hat (Frage, Info, Anweisung) und ob sie geantwortet/bestätigt haben.
    const TOPIC_WORD = { bericht: 'Bericht', termin: 'Termin', patient: 'Patient', sonstiges: 'Sonstiges' };
    const QUESTION_WORD = { frage: 'Frage', info: 'Info', anweisung: 'Anweisung' };
    let doctorAll = false;
    const stamp = iso => { const at = new Date(iso); return `${at.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })} ${at.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr`; };
    const node = (tag, className, text) => { const n = document.createElement(tag); if (className) n.className = className; if (text != null) n.textContent = text; return n; };
    async function loadDoctor() {
        const card = $('startDoctor');
        if (!card || typeof TerminCloud === 'undefined' || !TerminCloud.available) return;
        let profile = null;
        try { profile = await TerminCloud.getProfile(); } catch (error) { return; }
        if (!TerminCloud.isStaff(profile)) return;
        const [feedbackResult, questionResult] = await Promise.all([
            TerminCloud.client.from('tt_doctor_feedback').select('*').order('created_at', { ascending: false }).limit(80),
            TerminCloud.client.from('tt_doctor_questions').select('*').order('created_at', { ascending: false }).limit(40)
        ]);
        const feedback = feedbackResult.error ? [] : (feedbackResult.data || []);   // Update 42 fehlt noch: nur die Nachrichten an Dolmetscher
        const questions = questionResult.error ? [] : (questionResult.data || []);
        card.hidden = !feedback.length && !questions.length;
        if (card.hidden) return;
        const unseen = feedback.filter(item => !item.seen_at);
        $('startDoctorInfo').textContent = unseen.length ? `${plural(unseen.length, 'neue Meldung', 'neue Meldungen')} des Arztes – bitte ansehen und antworten.` : feedback.length ? 'Alle Meldungen gesehen. Die letzten bleiben zur Nachschau stehen.' : 'Keine Meldung des Arztes an die Einsatzleitung. Darunter: was er den Dolmetschern geschrieben hat.';
        const shown = doctorAll ? feedback : feedback.slice(0, unseen.length ? 80 : 6);
        $('startDoctorMore').hidden = feedback.length <= shown.length;
        $('startDoctorMore').textContent = doctorAll ? 'Weniger anzeigen' : 'Alle anzeigen';
        $('startDoctorList').replaceChildren(...shown.map(item => {
            const row = node('li', 'start-doctor-entry');
            row.dataset.seen = item.seen_at ? 'ja' : '';
            row.dataset.topic = item.topic;
            row.append(node('strong', '', `${item.doctor_name || 'Arzt'} · ${TOPIC_WORD[item.topic] || 'Sonstiges'}${item.document_title ? ` · „${item.document_title}“` : ''}`),
                node('span', 'start-doctor-meta', [item.patient_name || item.patient_nr ? [item.patient_name, item.patient_nr ? `Akte ${item.patient_nr}` : ''].filter(Boolean).join(', ') : '', item.interpreter_name ? `Dolmetscher/in: ${item.interpreter_name}` : '', item.document_date ? `Termin ${new Date(`${item.document_date}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : '', stamp(item.created_at), item.seen_at ? `gesehen${item.seen_by ? ` von ${item.seen_by}` : ''}` : 'neu'].filter(Boolean).join(' · ')),
                node('p', 'start-doctor-text', item.text));
            if (item.answered_at) row.append(node('span', 'start-doctor-reply', `Antwort von ${item.answered_by || 'Einsatzleitung'} (${stamp(item.answered_at)}${item.doctor_seen_at ? ', vom Arzt gelesen' : ''}): „${item.answer}“`));
            const actions = node('div', 'start-doctor-actions');
            if (!item.seen_at) {
                const seen = node('button', 'button-secondary', 'Gesehen');
                seen.type = 'button';
                seen.addEventListener('click', () => saveDoctor(item.id, { seen_at: new Date().toISOString(), seen_by: profile.full_name || '' }, seen));
                actions.append(seen);
            }
            const reply = node('button', 'button-quiet', item.answered_at ? 'Antwort ändern' : 'Antworten');
            reply.type = 'button';
            reply.addEventListener('click', () => {
                if (row.querySelector('.start-doctor-answer')) { row.querySelector('.start-doctor-answer').remove(); return; }
                const form = node('form', 'start-doctor-answer');
                const area = node('textarea');
                area.maxLength = 1000; area.placeholder = 'Deine Antwort an den Arzt'; area.value = item.answer || '';
                const buttons = node('div', 'start-doctor-actions');
                const send = node('button', 'button-primary', 'Antwort senden'); send.type = 'submit';
                const cancel = node('button', 'button-quiet', 'Abbrechen'); cancel.type = 'button';
                cancel.addEventListener('click', () => form.remove());
                buttons.append(send, cancel);
                form.append(area, buttons);
                form.addEventListener('submit', async event => {
                    event.preventDefault();
                    const text = area.value.trim();
                    if (!text) { area.focus(); return; }
                    const ok = await saveDoctor(item.id, { answer: text, seen_at: item.seen_at || new Date().toISOString(), seen_by: item.seen_by || profile.full_name || '' }, send);
                    if (ok) TerminCloud.callFunction?.({ action: 'doctorAnswer', feedbackId: item.id })?.catch?.(() => null);
                });
                row.append(form);
                area.focus();
            });
            actions.append(reply);
            if (TerminCloud.isAdmin(profile)) {
                const remove = node('button', 'button-quiet', 'Löschen');
                remove.type = 'button';
                remove.addEventListener('click', async () => {
                    // Zweiter Klick bestätigt – ohne Browser-Fenster.
                    if (remove.dataset.sure !== 'ja') { remove.dataset.sure = 'ja'; remove.textContent = 'Wirklich endgültig löschen?'; remove.classList.add('button-danger'); window.setTimeout(() => { remove.dataset.sure = ''; remove.textContent = 'Löschen'; remove.classList.remove('button-danger'); }, 5000); return; }
                    const { error } = await TerminCloud.client.from('tt_doctor_feedback').delete().eq('id', item.id);
                    if (error) { window.showToast?.(TerminCloud.germanError(error), 'error'); return; }
                    await loadDoctor();
                });
                actions.append(remove);
            }
            row.append(actions);
            return row;
        }));
        $('startDoctorToTitle').hidden = !questions.length;
        $('startDoctorToList').replaceChildren(...questions.slice(0, doctorAll ? 40 : 8).map(item => {
            const row = node('li', 'start-doctor-entry');
            const kind = QUESTION_WORD[item.kind] ? item.kind : 'frage';
            row.dataset.kind = kind;
            const done = kind === 'frage' ? Boolean(item.answered_at) : Boolean(item.acknowledged_at);
            row.dataset.seen = done ? 'ja' : '';
            row.append(node('strong', '', `${QUESTION_WORD[kind]} von ${item.doctor_name || 'Arzt'} an ${item.interpreter_name || 'Dolmetscher'}`),
                node('span', 'start-doctor-meta', [item.document_title ? `zu „${item.document_title}“` : '', item.patient_nr ? `Akte ${item.patient_nr}` : '', item.document_date ? `Termin ${new Date(`${item.document_date}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : '', stamp(item.created_at), done ? (kind === 'frage' ? `beantwortet ${stamp(item.answered_at)}` : kind === 'info' ? `gelesen ${stamp(item.acknowledged_at)}` : `„Verstanden“ ${stamp(item.acknowledged_at)}`) : item.seen_at ? 'vom Dolmetscher gesehen, noch nicht ' + (kind === 'frage' ? 'beantwortet' : 'bestätigt') : 'vom Dolmetscher noch nicht gesehen'].filter(Boolean).join(' · ')),
                node('p', 'start-doctor-text', item.question));
            if (item.answer) row.append(node('span', 'start-doctor-reply', `Antwort: „${item.answer}“`));
            return row;
        }));
    }
    async function saveDoctor(id, changes, button) {
        if (button) button.disabled = true;
        const { error } = await TerminCloud.client.from('tt_doctor_feedback').update(changes).eq('id', id);
        if (button) button.disabled = false;
        if (error) { window.showToast?.(TerminCloud.germanError(error), 'error'); return false; }
        await loadDoctor();
        window.refreshCloudInbox?.();
        return true;
    }
    $('startDoctorMore')?.addEventListener('click', () => { doctorAll = !doctorAll; loadDoctor(); });
    loadDoctor();
    window.setInterval(() => { if (!document.hidden) loadDoctor(); }, 60000);
})();
