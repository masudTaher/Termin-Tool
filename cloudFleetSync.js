// Hält den lokalen Fuhrpark automatisch mit der Online-Datenbank gleich,
// sobald ein Admin angemeldet ist (Seite "Online-Team"). Ohne Anmeldung passiert nichts.
(function () {
    if (typeof TerminCloud === 'undefined' || !TerminCloud.available) return;
    let syncing = false;
    let timer = null;
    let lastProblem = '';

    async function syncFleetNow() {
        if (syncing) return;
        syncing = true;
        try {
            const result = await TerminCloud.syncFleet();
            if (result.ok && result.changed) document.dispatchEvent(new CustomEvent('fleet-synced'));
            // Eine Änderung an einem Fahrzeug konnte nicht online gespeichert werden (z. B. Kennzeichen doppelt): einmal melden.
            const problem = result.ok && result.problems?.length ? result.problems.join(' · ') : '';
            if (problem && problem !== lastProblem && typeof showToast === 'function') showToast(`Fahrzeug nicht online gespeichert – ${problem}`, 'error');
            lastProblem = problem;
        } catch (error) {
            console.warn('Fuhrpark-Abgleich nicht möglich:', error);
        } finally {
            syncing = false;
        }
    }

    // Jede lokale Änderung am Fuhrpark wird kurz danach hochgeladen.
    const originalSave = window.saveFleetList;
    if (typeof originalSave === 'function') {
        window.saveFleetList = function (key, value) {
            const saved = originalSave(key, value);
            if (!syncing) {
                window.clearTimeout(timer);
                timer = window.setTimeout(syncFleetNow, 1500);
            }
            return saved;
        };
    }

    window.syncFleetNow = syncFleetNow;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) syncFleetNow(); });
    window.setInterval(syncFleetNow, 60000);
    syncFleetNow();
})();
