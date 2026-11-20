// Seitenleiste online: Zählerschilder, Anmeldestatus und Speicheranzeige (unten links)
// sowie Hinweise bei neuen Meldungen – nur für angemeldete Einsatzleitung / Sekretariat.
// Benachrichtigungen erscheinen, solange die App in einem Browser-Tab geöffnet ist.
(function () {
    if (typeof TerminCloud === 'undefined' || !TerminCloud.available) return;
    const SEEN_KEY = 'terminTool.cloudInbox.seen.v1';
    const BADGES = ['fahrzeugakte', 'team', 'abrechnung', 'fest', 'patienten', 'berichte', 'rezepte', 'termine', 'nachrichten'];

    function setBadge(page, count) {
        // Seitenleiste und – auf dem Handy – die untere Leiste bekommen dasselbe Zählerschild.
        document.querySelectorAll(`.app-nav-link[data-nav="${page}"], .app-tab[data-tab="${page}"]`).forEach(link => {
            let badge = link.querySelector('.nav-badge');
            if (!count) { badge?.remove(); return; }
            if (!badge) {
                badge = document.createElement('b');
                badge.className = 'nav-badge';
                link.append(badge);
            }
            badge.textContent = String(count);
            badge.title = `${count} offen`;
        });
    }

    // ---------- Eilmeldungen (Update 49): rotes Band oben auf jeder Büro-Seite, bis die Nachricht gelesen ist ----------
    const KIND_TEXT = { hilfe: 'Hilfe', korrektur: 'Korrektur anfragen' };
    let lastUrgentIds = '';
    function renderUrgent(list) {
        let band = document.getElementById('urgentBand');
        if (!list.length) { band?.remove(); lastUrgentIds = ''; return; }
        if (!band) {
            band = document.createElement('div');
            band.id = 'urgentBand';
            band.className = 'urgent-band';
            band.setAttribute('role', 'alert');
            document.body.prepend(band);
        }
        band.replaceChildren(...list.map(item => {
            const link = document.createElement('a');
            link.className = 'urgent-band-item';
            link.href = `nachrichten.html?an=${encodeURIComponent(item.threadId)}`;
            const when = item.at ? new Date(item.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : '';
            const label = document.createElement('strong');
            label.textContent = `EILMELDUNG · ${item.name}${KIND_TEXT[item.kind] ? ` · ${KIND_TEXT[item.kind]}` : ''}${when ? ` · ${when} Uhr` : ''}`;
            const text = document.createElement('span');
            text.textContent = item.text;
            const open = document.createElement('em');
            open.textContent = 'Öffnen ›';
            link.append(label, text, open);
            return link;
        }));
        const ids = list.map(item => item.id).join(',');
        // Neue Eilmeldung: zusätzlich eine Meldung wie auf dem Handy (nur einmal je Nachricht).
        if (ids !== lastUrgentIds && lastUrgentIds !== null) {
            list.filter(item => !lastUrgentIds.includes(item.id)).forEach(item => {
                if (typeof showToast === 'function') showToast(`EILMELDUNG von ${item.name}: ${item.text}`, 'error', { duration: 20000, keep: true, href: `nachrichten.html?an=${encodeURIComponent(item.threadId)}` });
                if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
                    try { new Notification(`EILMELDUNG · ${item.name}`, { body: item.text, requireInteraction: true }); } catch (error) { /* nicht überall erlaubt */ }
                }
            });
        }
        lastUrgentIds = ids;
    }

    // ---------- Anmeldestatus ----------
    function renderState(profile) {
        // Wechsel zur App der Dolmetscher: nur für Admins (sie testen und betreuen beide Seiten).
        document.querySelectorAll('[data-admin-switch]').forEach(node => { node.hidden = !(profile && TerminCloud.isAdmin(profile)); });
        const state = document.getElementById('navCloudState');
        if (!state) return;
        const text = state.querySelector('span');
        state.dataset.state = profile ? (TerminCloud.isStaff(profile) ? 'online' : 'waiting') : 'offline';
        text.textContent = !profile ? 'Nicht online angemeldet – hier anmelden'
            : TerminCloud.isStaff(profile) ? `Online: ${profile.full_name || profile.email} · alles wird in der Datenbank gespeichert`
            : 'Konto wartet auf Freischaltung';
    }

    // ---------- Speicheranzeige ----------
    const size = megabytes => megabytes >= 1000 ? `${(megabytes / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} GB` : `${megabytes.toLocaleString('de-DE', { maximumFractionDigits: megabytes < 10 ? 1 : 0 })} MB`;

    function meter(label, used, limit, detail) {
        const share = limit > 0 ? Math.min(1, used / limit) : 0;
        const row = document.createElement('div');
        row.className = 'nav-meter';
        row.dataset.level = share >= 0.9 ? 'full' : share >= 0.7 ? 'high' : 'ok';
        row.title = `${label}: ${size(used)} von ${size(limit)} belegt, ${size(Math.max(0, limit - used))} frei${detail ? ` · ${detail}` : ''}`;
        const head = document.createElement('span');
        head.className = 'nav-meter-head';
        const name = document.createElement('b');
        name.textContent = label;
        const value = document.createElement('span');
        value.textContent = `${size(Math.max(0, limit - used))} frei`;
        head.append(name, value);
        const bar = document.createElement('span');
        bar.className = 'nav-meter-bar';
        const fill = document.createElement('i');
        fill.style.width = `${Math.max(2, Math.round(share * 100))}%`;
        bar.append(fill);
        const foot = document.createElement('small');
        foot.textContent = `${size(used)} von ${size(limit)} belegt`;
        row.append(head, bar, foot);
        return row;
    }

    let lastUsage = 0;
    async function refreshUsage(force) {
        const box = document.getElementById('navStorage');
        if (!box) return;
        if (!force && Date.now() - lastUsage < 5 * 60000) return;
        lastUsage = Date.now();
        let usage = null;
        try { usage = await TerminCloud.usage(); } catch (error) { /* Anzeige bleibt dann ausgeblendet */ }
        box.hidden = !usage;
        if (!usage) return;
        box.replaceChildren(
            meter('Datenbank', usage.databaseMb, usage.databaseLimitMb),
            meter('Fotos & Unterlagen', usage.photosMb, usage.photosLimitMb, `${usage.photos} ${usage.photos === 1 ? 'Foto' : 'Fotos'}, ${usage.documents || 0} ${usage.documents === 1 ? 'Unterlage' : 'Unterlagen'}`)
        );
        if (usage.databaseMb / usage.databaseLimitMb >= 0.9 || usage.photosMb / usage.photosLimitMb >= 0.9) {
            if (typeof showToast === 'function' && !refreshUsage.warned) showToast('Der Online-Speicher ist fast voll. Bitte alte Fotos löschen oder den Tarif erhöhen.', 'error', { duration: 12000 });
            refreshUsage.warned = true;
        }
    }

    const loadScript = src => new Promise((resolve, reject) => { const node = document.createElement('script'); node.src = src; node.onload = resolve; node.onerror = reject; document.head.append(node); });

    // ---------- Ärzte & Standorte: fehlende Fachrichtung / Gebäude von selbst im Internet suchen ----------
    let doctorLoading = null;
    function autoDoctors() {
        if (window.__noDoctorAuto) return;
        if (!doctorLoading) doctorLoading = (async () => {
            if (typeof ArztVerzeichnis === 'undefined') await loadScript('arztVerzeichnis.js');
            if (typeof ArztAuto === 'undefined') await loadScript('arztAuto.js');
        })().catch(() => { doctorLoading = null; });
        Promise.resolve(doctorLoading).then(() => { if (typeof ArztAuto !== 'undefined') ArztAuto.run(false); });
    }

    // ---------- Zähler und Hinweise ----------
    async function refreshCloudInbox() {
        let profile = null;
        try { profile = await TerminCloud.getProfile(); } catch (error) { /* wie nicht angemeldet */ }
        renderState(profile);
        let counts;
        try { counts = await TerminCloud.inboxCounts(); } catch (error) { return; }
        if (!counts) { renderUrgent([]); BADGES.forEach(page => setBadge(page, 0)); const box = document.getElementById('navStorage'); if (box) box.hidden = true; return; }
        setBadge('abrechnung', counts.payroll);
        setBadge('fahrzeugakte', counts.damages + counts.alerts + (counts.requests || 0));
        setBadge('team', counts.accounts);
        setBadge('fest', counts.fest);
        setBadge('patienten', 0);
        setBadge('berichte', counts.reports ?? counts.documents ?? 0);
        setBadge('rezepte', counts.prescriptions || 0);
        setBadge('termine', counts.appointments || 0);
        setBadge('nachrichten', counts.chat || 0);
        renderUrgent(Array.isArray(counts.urgent) ? counts.urgent : []);
        const popupShown = TerminCloud.isStaff(profile) ? renderStartPopup(counts, profile) : false;
        refreshUsage(false);
        if (TerminCloud.isStaff(profile)) autoDoctors();

        let seen = null;
        try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null'); } catch (error) { /* erster Aufruf */ }
        const messages = [];
        if (seen) {
            // Jede Meldung führt mit einem Klick zur passenden Seite.
            if (counts.alerts > seen.alerts) messages.push(['Neue Meldung aus einem Fahrzeug', 'fahrzeugakte.html']);
            if (counts.damages > seen.damages) messages.push(['Neuer Schaden gemeldet', 'fahrzeugakte.html']);
            if (counts.accounts > seen.accounts) messages.push(['Ein Konto wartet: neue Anmeldung oder Passwort vergessen', 'team.html']);
            if (counts.payroll > (seen.payroll || 0)) messages.push([(counts.extraDays || 0) > (seen.extraDays || 0) ? 'Abrechnung: ein Dolmetscher meldet einen fehlenden Arbeitstag' : 'Abrechnung: neuer Beleg oder Einwand', 'abrechnung.html']);
            if ((counts.absences || 0) > (seen.absences || 0)) messages.push(['Festangestellte: neuer Urlaubsantrag oder neue Krank-/Notfallmeldung', 'festangestellte.html']);
            if (counts.fest - (counts.absences || 0) > (seen.fest || 0) - (seen.absences || 0)) messages.push(['Festangestellte: neue Überstunden oder Belege', 'festangestellte.html']);
            if ((counts.documents || 0) > (seen.documents || 0)) messages.push(['Neue Unterlage eines Dolmetschers', (counts.prescriptions || 0) > (seen.prescriptions || 0) ? 'neueRezepte.html' : 'neueBerichte.html']);
            if ((counts.requests || 0) > (seen.requests || 0)) messages.push(['Ein angefordertes Foto ist da (Fuhrpark)', 'fahrzeugakte.html']);
            if ((counts.appointments || 0) > (seen.appointments || 0)) messages.push(['Ein Dolmetscher hat einen neuen Termin gemeldet', 'neueTermine.html']);
            // Auf der Seite „Nachrichten“ meldet der Chat neue Nachrichten selbst (mit Namen).
            if ((counts.chat || 0) > (seen.chat || 0) && document.body.dataset.page !== 'nachrichten') messages.push(['Neue Nachricht eines Dolmetschers', 'nachrichten.html']);
            if ((counts.corrections || 0) > (seen.corrections || 0)) messages.push(['Ein Dolmetscher hat etwas zurückgenommen oder korrigiert', 'index.html#korrekturen']);
            if ((counts.driverNotes || 0) > (seen.driverNotes || 0)) messages.push(['Meldung über einen Vorfahrer (nicht sauber, Tank leer oder Schaden)', 'fahrzeugakte.html']);
            if ((counts.doctor || 0) > (seen.doctor || 0)) messages.push(['Neue Meldung des Arztes an die Einsatzleitung', 'index.html#arzt']);
        }
        try { localStorage.setItem(SEEN_KEY, JSON.stringify(counts)); } catch (error) { /* ohne Speicher gibt es nur die Schilder */ }
        // Zahl am Symbol der App (wie bei WhatsApp): alles, was gerade auf die Einsatzleitung wartet.
        try {
            const waitingTotal = ['payroll', 'damages', 'alerts', 'requests', 'accounts', 'fest', 'appointments', 'chat'].reduce((sum, key) => sum + (Number(counts[key]) || 0), 0) + (Number(counts.reports ?? counts.documents) || 0) + (Number(counts.prescriptions) || 0);
            if (waitingTotal > 0) navigator.setAppBadge?.(waitingTotal)?.catch?.(() => null); else navigator.clearAppBadge?.()?.catch?.(() => null);
        } catch (error) { /* nicht jeder Browser kann das */ }
        // Zeigt das Pop-up beim Start schon alles, braucht es die einzelnen Hinweise oben nicht noch einmal.
        (popupShown ? [] : messages).forEach(([message, href]) => {
            // Wie eine Mitteilung auf dem Handy: erscheint oben, bleibt kurz stehen, ein Klick öffnet die Seite.
            if (typeof showToast === 'function') showToast(message, 'info', { duration: 9000, keep: true, href });
            if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
                try { new Notification('Medical Office Bonn', { body: message }); } catch (error) { /* manche Browser erlauben das nur mit Service Worker */ }
            }
        });
    }

    // ---------- R97: Pop-up beim Start – was wartet, direkt anklickbar ----------
    // Erscheint auf der Startseite, sobald etwas Neues da ist (je Stand einmal; „Später“ legt es für diese Sitzung weg).
    const POPUP_KEY = 'office.startPopup.seen';
    function renderStartPopup(counts, profile) {
        if (document.body.dataset.page !== 'start') return false;
        if (document.querySelector('dialog[open]')) return false;
        const items = [];
        const add = (key, title, text, href, action) => items.push({ key, title, text, href, action });
        (counts.urgent || []).forEach(item => add(`urgent:${item.id}`, `EILMELDUNG · ${item.name}`, item.text, `nachrichten.html?an=${encodeURIComponent(item.threadId)}`));
        (counts.fuelReturns || []).forEach(item => add(`fuel:${item.id}`, `Tankkarte abgegeben · ${item.name}`, item.text, `nachrichten.html?an=${encodeURIComponent(item.threadId)}`,
            TerminCloud.isAdmin(profile) && item.refId ? { label: 'Karte ins Büro zurücknehmen', run: () => takeBackFuelCard(item) } : null));
        (counts.replies || []).forEach(item => add(`reply:${item.id}`, `Stellungnahme · ${item.name}`, `Zur Meldung „${{ unsauber: 'nicht sauber', tank: 'Tank fast leer', schaden: 'neuer Schaden', hinweis: 'Hinweis' }[item.kind] || 'Hinweis'}“ ${item.plate ? `am ${item.plate} ` : ''}– bitte bestätigen oder verwerfen.`, 'fahrzeugakte.html?ansicht=fahrerakte'));
        if ((counts.driverNotes || 0) > (counts.replies || []).length) add(`notes:${counts.driverNotes}`, 'Meldungen über Vorfahrer', `${counts.driverNotes - (counts.replies || []).length} neu (nicht sauber, Tank leer oder Schaden)`, 'fahrzeugakte.html?ansicht=fahrerakte');
        if (counts.damages) add(`damages:${counts.damages}`, 'Schäden', `${counts.damages} ${counts.damages === 1 ? 'offener Schaden' : 'offene Schäden'}`, 'fahrzeugakte.html?ansicht=uebersicht');
        if (counts.requests) add(`requests:${counts.requests}`, 'Angeforderte Fotos', `${counts.requests} ${counts.requests === 1 ? 'Foto ist' : 'Fotos sind'} da`, 'fahrzeugakte.html?ansicht=uebersicht');
        if (counts.accounts) add(`accounts:${counts.accounts}`, 'Konten', `${counts.accounts} ${counts.accounts === 1 ? 'wartet' : 'warten'}: Anmeldung oder Passwort`, 'team.html');
        if (counts.documents) add(`documents:${counts.documents}`, 'Neue Unterlagen', `${counts.documents} neu (Berichte, Rezepte, Überweisungen)`, (counts.prescriptions || 0) ? 'neueRezepte.html' : 'neueBerichte.html');
        if (counts.appointments) add(`appointments:${counts.appointments}`, 'Neue Termine', `${counts.appointments} von Dolmetschern gemeldet`, 'neueTermine.html');
        const otherChat = (counts.chat || 0) - (counts.fuelReturns || []).length - (counts.urgent || []).length;
        if (otherChat > 0) add(`chat:${otherChat}`, 'Nachrichten', `${otherChat} ungelesen`, 'nachrichten.html');
        if (counts.payroll) add(`payroll:${counts.payroll}`, 'Abrechnung', `${counts.payroll} offen (Belege, Einwände, Arbeitstage)`, 'abrechnung.html');
        if (counts.fest) add(`fest:${counts.fest}`, 'Festangestellte', `${counts.fest} offen (Urlaub, Krank, Überstunden, Belege)`, 'festangestellte.html');
        const existing = document.getElementById('startPopup');
        if (!items.length) { existing?.remove(); return false; }
        const stamp = items.map(item => item.key).join('|');
        let seen = '';
        try { seen = sessionStorage.getItem(POPUP_KEY) || ''; } catch (error) { /* dann jedes Mal */ }
        if (seen === stamp) return false;
        if (existing) existing.remove();
        const dialog = document.createElement('dialog');
        dialog.id = 'startPopup';
        dialog.className = 'confirm-dialog start-popup';
        dialog.setAttribute('aria-labelledby', 'startPopupTitle');
        const title = document.createElement('h2'); title.id = 'startPopupTitle'; title.textContent = `Was wartet (${items.length})`;
        const hint = document.createElement('p'); hint.className = 'field-hint'; hint.textContent = 'Ein Klick öffnet die Stelle direkt. „Später“ legt die Liste bis zur nächsten Änderung weg.';
        const list = document.createElement('ul'); list.className = 'start-popup-list';
        items.slice(0, 12).forEach(item => {
            const row = document.createElement('li');
            row.dataset.key = item.key.split(':')[0];
            row.dataset.fullKey = item.key;
            const link = document.createElement('a'); link.href = item.href; link.className = 'start-popup-link';
            const strong = document.createElement('strong'); strong.textContent = item.title;
            const small = document.createElement('span'); small.textContent = item.text;
            link.append(strong, small);
            row.append(link);
            if (item.action) {
                const button = document.createElement('button'); button.type = 'button'; button.className = 'button-primary start-popup-action'; button.textContent = item.action.label;
                button.addEventListener('click', async () => { button.disabled = true; const ok = await item.action.run(); if (ok) row.remove(); else button.disabled = false; if (!list.children.length) dialog.close(); });
                row.append(button);
            }
            list.append(row);
        });
        const buttons = document.createElement('div'); buttons.className = 'modal-buttons';
        const later = document.createElement('button'); later.type = 'button'; later.className = 'button-secondary'; later.textContent = 'Später';
        later.addEventListener('click', () => dialog.close());
        buttons.append(later);
        dialog.append(title, hint, list, buttons);
        dialog.addEventListener('close', () => {
            // Gemerkt wird der Stand der noch offenen Punkte – was hier erledigt wurde, zählt nicht mehr dazu.
            const left = items.filter(item => [...list.children].some(row => row.dataset.fullKey === item.key)).map(item => item.key).join('|');
            try { sessionStorage.setItem(POPUP_KEY, left); } catch (error) { /* dann beim nächsten Mal wieder */ }
            dialog.remove();
        });
        document.body.append(dialog);
        dialog.showModal();
        return true;
    }
    // Tankkarte vom Dolmetscher nehmen (Admin): zurück ins Büro, Nachricht als gelesen vermerken.
    async function takeBackFuelCard(item) {
        const client = TerminCloud.client;
        const { error } = await client.rpc('tt_fuel_card_set', { p_card: item.refId, p_profile: null, p_place: '' });
        if (error) { if (typeof showToast === 'function') showToast(TerminCloud.germanError(error), 'error'); return false; }
        await client.from('tt_chat').update({ read_at: new Date().toISOString() }).eq('id', item.id);
        if (typeof showToast === 'function') showToast(`Tankkarte ist wieder im Büro – ${item.name} steht nicht mehr als Inhaber.`, 'success');
        window.setTimeout(refreshCloudInbox, 500);
        return true;
    }

    window.refreshCloudInbox = refreshCloudInbox;
    window.refreshCloudUsage = () => refreshUsage(true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCloudInbox(); });
    window.setInterval(refreshCloudInbox, 30000);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshCloudInbox);
    else refreshCloudInbox();
})();
