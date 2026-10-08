// Gemeinsame Stammdaten: Dolmetscherliste und Filterregeln liegen zusätzlich in der Datenbank.
// So haben Einsatzleitung und Sekretariat auf jedem PC denselben Stand, und nichts geht verloren,
// wenn der Browser geleert wird. Fahrzeuge gleicht cloudFleetSync.js ab.
// Ohne Anmeldung als Einsatzleitung/Sekretariat passiert nichts – dann bleibt alles lokal.
(function () {
    if (typeof TerminCloud === 'undefined' || !TerminCloud.available) return;
    const client = TerminCloud.client;
    const META_KEY = 'terminTool.settingsSync.v1';
    const ITEMS = [
        { key: 'interpreterDirectory', storage: 'terminTool.interpreterDirectory.v1', label: 'Dolmetscherliste' },
        { key: 'filterRules', storage: 'terminTool.filterRules.v1', label: 'Filterregeln' },
        { key: 'doctorDirectory', storage: 'terminTool.doctorDirectory.v1', label: 'Ärzteverzeichnis' },
        // Papierakte: was das Büro beim Einlesen bestätigt hat (Kopf eines Schriftstücks → Art, Arzt, Fachrichtung) – ohne Patientendaten
        { key: 'akteLearn', storage: 'terminTool.akteLearn.v1', label: 'Gelerntes zur Papierakte' }
    ];
    let busy = false;
    let staff = null;

    const readMeta = () => { try { return JSON.parse(localStorage.getItem(META_KEY) || '{}') || {}; } catch (error) { return {}; } };
    const writeMeta = meta => { try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (error) { /* dann wird beim nächsten Mal erneut abgeglichen */ } };
    const readLocal = item => { try { const raw = localStorage.getItem(item.storage); return raw == null ? null : JSON.parse(raw); } catch (error) { return null; } };
    const stable = value => JSON.stringify(value);

    // Nach einer Änderung aus der Datenbank die geöffnete Seite auffrischen.
    function refreshPage(item) {
        try {
            if (item.key === 'interpreterDirectory') {
                if (typeof renderInterpreterDirectory === 'function' && document.getElementById('interpreterDirectoryList')) renderInterpreterDirectory();
                if (typeof refreshInterpreterSuggestions === 'function') refreshInterpreterSuggestions();
            }
            if (item.key === 'doctorDirectory' && typeof window.renderDoctorDirectory === 'function') window.renderDoctorDirectory();
            if (item.key === 'filterRules' && typeof readFilterRules === 'function' && typeof renderFilterRules === 'function') {
                filterRules = readFilterRules();
                renderFilterRules();
            }
        } catch (error) { /* Die Daten sind gespeichert; die Anzeige folgt beim nächsten Laden. */ }
    }

    function mergeNames(local, remote) {
        const seen = new Set();
        return [...(Array.isArray(remote) ? remote : []), ...(Array.isArray(local) ? local : [])].filter(name => {
            const id = String(name || '').trim().toLocaleLowerCase('de');
            if (!id || seen.has(id)) return false;
            seen.add(id);
            return true;
        }).sort((left, right) => String(left).localeCompare(String(right), 'de'));
    }

    async function sync(pullRemote) {
        if (busy) return;
        busy = true;
        try {
            if (staff === null || pullRemote) {
                const profile = await TerminCloud.getProfile().catch(() => null);
                staff = TerminCloud.isStaff(profile) ? profile : false;
            }
            if (!staff) return;
            const meta = readMeta();
            // Nur wenn sich lokal etwas geändert hat oder der regelmäßige Abgleich ansteht, wird die Datenbank gefragt.
            const localChangedAny = ITEMS.some(item => { const local = readLocal(item); return local != null && stable(local) !== meta[item.key]?.local; });
            if (!pullRemote && !localChangedAny) return;
            const { data, error } = await client.from('tt_settings').select('*');
            if (error) return;   // Tabelle fehlt noch (Update 8) – dann bleibt alles lokal.
            for (const item of ITEMS) {
                const local = readLocal(item);
                const remote = data.find(row => row.key === item.key);
                const known = meta[item.key] || {};
                const localChanged = local != null && stable(local) !== known.local;
                const remoteChanged = Boolean(remote) && remote.updated_at !== known.remoteAt;
                let next = null;      // Wert, der danach überall gilt
                let push = false;
                if (remote && remoteChanged && localChanged) {
                    // Beide Seiten haben geändert: Namen werden zusammengeführt, bei Regeln gilt die eigene Änderung.
                    next = item.key === 'interpreterDirectory' ? mergeNames(local, remote.value?.data)
                        : item.key === 'doctorDirectory' && typeof ArztVerzeichnis !== 'undefined' ? ArztVerzeichnis.merge(local, remote.value?.data) : local;
                    push = stable(next) !== stable(remote.value?.data);
                } else if (remote && remoteChanged) {
                    next = remote.value?.data ?? null;
                } else if (localChanged || (!remote && local != null)) {
                    next = local;
                    push = true;
                } else continue;
                if (next == null) continue;
                let remoteAt = remote?.updated_at || null;
                if (push) {
                    remoteAt = new Date().toISOString();
                    const { error: saveError } = await client.from('tt_settings').upsert({ key: item.key, value: { data: next }, updated_at: remoteAt, updated_by: staff.full_name || '' }, { onConflict: 'key' });
                    if (saveError) continue;
                }
                if (stable(next) !== stable(local)) {
                    try { localStorage.setItem(item.storage, JSON.stringify(next)); } catch (storageError) { continue; }
                    refreshPage(item);
                }
                meta[item.key] = { local: stable(next), remoteAt };
            }
            writeMeta(meta);
        } finally {
            busy = false;
        }
    }

    window.syncSettingsNow = () => sync(true);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(true); });
    window.setInterval(() => sync(false), 5000);     // lokale Änderungen zügig hochladen
    window.setInterval(() => sync(true), 60000);     // Änderungen der anderen abholen
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => sync(true));
    else sync(true);
})();
