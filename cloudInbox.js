// Zählerschilder in der Seitenleiste und Hinweise bei neuen Meldungen (nur für angemeldete Admins).
// Benachrichtigungen erscheinen, solange die App in einem Browser-Tab geöffnet ist.
(function () {
    if (typeof TerminCloud === 'undefined' || !TerminCloud.available) return;
    const SEEN_KEY = 'terminTool.cloudInbox.seen.v1';

    function setBadge(page, count) {
        const link = document.querySelector(`.app-nav-link[data-nav="${page}"]`);
        if (!link) return;
        let badge = link.querySelector('.nav-badge');
        if (!count) { badge?.remove(); return; }
        if (!badge) {
            badge = document.createElement('b');
            badge.className = 'nav-badge';
            link.append(badge);
        }
        badge.textContent = String(count);
        badge.title = `${count} offen`;
    }

    async function refreshCloudInbox() {
        let counts;
        try { counts = await TerminCloud.inboxCounts(); } catch (error) { return; }
        if (!counts) { setBadge('fahrzeugakte', 0); setBadge('team', 0); setBadge('abrechnung', 0); return; }
        setBadge('abrechnung', counts.payroll);
        setBadge('fahrzeugakte', counts.damages + counts.alerts);
        setBadge('team', counts.accounts);

        let seen = null;
        try { seen = JSON.parse(localStorage.getItem(SEEN_KEY) || 'null'); } catch (error) { /* erster Aufruf */ }
        const messages = [];
        if (seen) {
            if (counts.alerts > seen.alerts) messages.push('Neue Meldung aus einem Fahrzeug');
            if (counts.damages > seen.damages) messages.push('Neuer Schaden gemeldet');
            if (counts.accounts > seen.accounts) messages.push('Ein neues Konto wartet auf Freischaltung');
            if (counts.payroll > (seen.payroll || 0)) messages.push('Abrechnung: neuer Beleg oder Einwand');
        }
        try { localStorage.setItem(SEEN_KEY, JSON.stringify(counts)); } catch (error) { /* ohne Speicher gibt es nur die Schilder */ }
        messages.forEach(message => {
            if (typeof showToast === 'function') showToast(message, 'info', { duration: 10000 });
            if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
                try { new Notification('Botschaft Dolmetscher und Transport-App', { body: message }); } catch (error) { /* manche Browser erlauben das nur mit Service Worker */ }
            }
        });
    }

    window.refreshCloudInbox = refreshCloudInbox;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshCloudInbox(); });
    window.setInterval(refreshCloudInbox, 60000);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshCloudInbox);
    else refreshCloudInbox();
})();
