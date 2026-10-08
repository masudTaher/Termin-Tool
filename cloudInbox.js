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
        if (!counts) { BADGES.forEach(page => setBadge(page, 0)); const box = document.getElementById('navStorage'); if (box) box.hidden = true; return; }
        setBadge('abrechnung', counts.payroll);
        setBadge('fahrzeugakte', counts.damages + counts.alerts + (counts.requests || 0));
        setBadge('team', counts.accounts);
        setBadge('fest', counts.fest);
        setBadge('patienten', 0);
        setBadge('berichte', counts.reports ?? counts.documents ?? 0);
        setBadge('rezepte', counts.prescriptions || 0);
        setBadge('termine', counts.appointments || 0);
        setBadge('nachrichten', counts.chat || 0);
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
            if (counts.payroll > (seen.payroll || 0)) messages.push(['Abrechnung: neuer Beleg oder Einwand', 'abrechnung.html']);
            if ((counts.absences || 0) > (seen.absences || 0)) messages.push(['Festangestellte: neuer Urlaubsantrag oder neue Krank-/Notfallmeldung', 'festangestellte.html']);
            if (counts.fest - (counts.absences || 0) > (seen.fest || 0) - (seen.absences || 0)) messages.push(['Festangestellte: neue Überstunden oder Belege', 'festangestellte.html']);
            if ((counts.documents || 0) > (seen.documents || 0)) messages.push(['Neue Unterlage eines Dolmetschers', (counts.prescriptions || 0) > (seen.prescriptions || 0) ? 'neueRezepte.html' : 'neueBerichte.html']);
            if ((counts.requests || 0) > (seen.requests || 0)) messages.push(['Ein angefordertes Foto ist da (Fuhrpark)', 'fahrzeugakte.html']);
            if ((counts.appointments || 0) > (seen.appointments || 0)) messages.push(['Ein Dolmetscher hat einen neuen Termin gemeldet', 'neueTermine.html']);
            // Auf der Seite „Nachrichten“ meldet der Chat neue Nachrichten selbst (mit Namen).
            if ((counts.chat || 0) > (seen.chat || 0) && document.body.dataset.page !== 'nachrichten') messages.push(['Neue Nachricht eines Dolmetschers', 'nachrichten.html']);
        }
        try { localStorage.setItem(SEEN_KEY, JSON.stringify(counts)); } catch (error) { /* ohne Speicher gibt es nur die Schilder */ }
        // Zahl am Symbol der App (wie bei WhatsApp): alles, was gerade auf die Einsatzleitung wartet.
        try {
            const waitingTotal = ['payroll', 'damages', 'alerts', 'requests', 'accounts', 'fest', 'appointments', 'chat'].reduce((sum, key) => sum + (Number(counts[key]) || 0), 0) + (Number(counts.reports ?? counts.documents) || 0) + (Number(counts.prescriptions) || 0);
            if (waitingTotal > 0) navigator.setAppBadge?.(waitingTotal)?.catch?.(() => null); else navigator.clearAppBadge?.()?.catch?.(() => null);
        } catch (error) { /* nicht jeder Browser kann das */ }
        messages.forEach(([message, href]) => {
            // Wie eine Mitteilung auf dem Handy: erscheint oben, bleibt kurz stehen, ein Klick öffnet die Seite.
            if (typeof showToast === 'function') showToast(message, 'info', { duration: 9000, keep: true, href });
            if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
                try { new Notification('Medical Office Bonn', { body: message }); } catch (error) { /* manche Browser erlauben das nur mit Service Worker */ }
            }
        });
    }

    window.refreshCloudInbox = refreshCloudInbox;
    window.refreshCloudUsage = () => refreshUsage(true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCloudInbox(); });
    window.setInterval(refreshCloudInbox, 30000);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshCloudInbox);
    else refreshCloudInbox();
})();
