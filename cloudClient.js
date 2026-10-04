// Online-Anbindung für Team-Seite, Dolmetscher-Portal und den Fuhrpark-Abgleich.
// Ohne Internet oder ohne Anmeldung arbeitet die App unverändert lokal weiter.
const TerminCloud = (() => {
    const config = window.TERMIN_CLOUD_CONFIG;
    const client = config?.url && config?.publishableKey && window.supabase?.createClient
        ? window.supabase.createClient(config.url, config.publishableKey)
        : null;
    let cachedProfile = null;

    const germanError = error => {
        const message = String(error?.message || error || '');
        if (/invalid login credentials/i.test(message)) return 'E-Mail oder Passwort stimmt nicht.';
        if (/already registered|already been registered/i.test(message)) return 'Mit dieser E-Mail gibt es schon ein Konto.';
        if (/password should be at least/i.test(message)) return 'Das Passwort ist zu kurz (mindestens 8 Zeichen).';
        if (/email not confirmed/i.test(message)) return 'Die E-Mail-Adresse ist noch nicht bestätigt.';
        if (/failed to fetch|networkerror|load failed/i.test(message)) return 'Keine Verbindung zur Datenbank. Prüfe das Internet.';
        if (/same password|different from the old/i.test(message)) return 'Das neue Passwort muss sich vom alten unterscheiden.';
        if (/relation .* does not exist|could not find the (table|function)|schema cache/i.test(message)) return 'Diese Funktion ist in der Datenbank noch nicht eingerichtet (Update 8 fehlt).';
        return message || 'Unbekannter Fehler.';
    };

    async function getSession() {
        if (!client) return null;
        const { data } = await client.auth.getSession();
        return data?.session || null;
    }

    async function getProfile(force = false) {
        const session = await getSession();
        if (!session) { cachedProfile = null; return null; }
        if (cachedProfile && cachedProfile.id === session.user.id && !force) return cachedProfile;
        const { data, error } = await client.from('tt_profiles').select('*').eq('id', session.user.id).maybeSingle();
        if (error) throw new Error(germanError(error));
        cachedProfile = data ? { ...data, email: session.user.email } : null;
        return cachedProfile;
    }

    // Einsatzleitung und Sekretariat dürfen alles sehen und bearbeiten; Konten verwaltet nur der Admin.
    const isStaff = profile => Boolean(profile?.active && ['admin', 'sekretariat'].includes(profile.role));
    const isAdmin = profile => Boolean(profile?.active && profile.role === 'admin');

    async function signIn(email, password) {
        const { error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw new Error(germanError(error));
        return getProfile(true);
    }

    async function signUp(email, password, fullName, phone, employment) {
        const { data, error } = await client.auth.signUp({
            email, password, options: { data: { full_name: fullName, phone: phone || '', employment: employment === 'fest' ? 'fest' : 'temporär' } }
        });
        if (error) throw new Error(germanError(error));
        // Ohne Sitzung verlangt das Projekt noch eine Bestätigungs-E-Mail.
        return { needsEmailConfirmation: !data?.session };
    }

    async function signOut() {
        cachedProfile = null;
        if (client) await client.auth.signOut();
    }

    // Handyfotos sind oft 5–10 MB groß; verkleinert reichen wenige hundert KB.
    function shrinkPhoto(file, maxSize = 1600) {
        return new Promise(resolve => {
            const image = new Image();
            const url = URL.createObjectURL(file);
            image.onload = () => {
                const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
                const canvas = document.createElement('canvas');
                canvas.width = Math.round(image.width * scale);
                canvas.height = Math.round(image.height * scale);
                canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
                URL.revokeObjectURL(url);
                canvas.toBlob(blob => resolve(blob || file), 'image/jpeg', 0.82);
            };
            image.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
            image.src = url;
        });
    }

    async function uploadPhoto(file, userId) {
        const blob = await shrinkPhoto(file);
        const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        const { error } = await client.storage.from('schaeden').upload(path, blob, { contentType: 'image/jpeg' });
        if (error) throw error;
        return path;
    }

    async function photoUrl(path) {
        const { data, error } = await client.storage.from('schaeden').createSignedUrl(path, 600);
        return error ? '' : (data?.signedUrl || '');
    }

    // Was braucht gerade Aufmerksamkeit? (für das Zählerschild in der Seitenleiste)
    async function inboxCounts() {
        const profile = await getProfile().catch(() => null);
        if (!isStaff(profile)) return null;
        const [notes, damages, alerts, accounts] = await Promise.all([
            client.from('tt_handovers').select('id, start_note').eq('note_seen', false),
            client.from('tt_damages').select('id').eq('status', 'offen'),
            client.from('tt_alerts').select('id').eq('status', 'offen'),
            client.from('tt_profiles').select('id').eq('active', false)
        ]);
        if (damages.error || alerts.error || accounts.error) return null;
        const openNotes = notes.error ? 0 : notes.data.filter(item => item.start_note).length;
        const [newReceipts, objections] = await Promise.all([
            client.from('tt_receipts').select('id').eq('status', 'eingereicht'),
            client.from('tt_statements').select('month').eq('response', 'einwand')
        ]);
        // Belege und Überstunden der Festangestellten haben eine eigene Seite.
        const [staffList, overtime, resets] = await Promise.all([
            client.from('tt_profiles').select('id, employment'),
            client.from('tt_overtime').select('id').eq('status', 'eingereicht'),
            client.from('tt_reset_requests').select('id').is('done_at', null)
        ]);
        const festIds = new Set((staffList.data || []).filter(item => item.employment === 'fest').map(item => item.id));
        const openReceipts = newReceipts.error ? [] : newReceipts.data;
        const festReceipts = openReceipts.filter(item => festIds.has(item.profile_id)).length;
        return { damages: damages.data.length, alerts: alerts.data.length + openNotes,
            accounts: isAdmin(profile) ? accounts.data.length + (resets.error ? 0 : resets.data.length) : 0,
            payroll: (openReceipts.length - festReceipts) + (objections.error ? 0 : objections.data.length),
            fest: festReceipts + (overtime.error ? 0 : overtime.data.length) };
    }

    // ---------- Server-Funktion (Mitteilungen aufs Handy, Passwort neu vergeben) ----------
    async function callFunction(body) {
        if (!client?.functions) return { ok: false, reason: 'nicht eingerichtet' };
        try {
            // Die Anmeldung reist in einem eigenen Kopf mit. So arbeitet die Funktion,
            // egal ob in Supabase der Schalter „Verify JWT“ an oder aus ist.
            const session = await getSession();
            const headers = session?.access_token
                ? { Authorization: `Bearer ${config.publishableKey}`, 'x-tt-auth': session.access_token }
                : undefined;
            const { data, error } = await client.functions.invoke(config.pushFunction || 'tt-push', { body, headers });
            if (error) {
                let detail = '';
                try { detail = (await error.context?.json?.())?.error || ''; } catch (parseError) { /* keine lesbare Antwort */ }
                return { ok: false, reason: detail || 'Die Server-Funktion ist noch nicht eingerichtet.' };
            }
            if (data?.error) return { ok: false, reason: data.error };
            return { ok: true, data };
        } catch (error) {
            return { ok: false, reason: germanError(error) };
        }
    }

    // ---------- Mitteilungen aufs Handy (Web-Push) ----------
    const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const keyToBytes = key => {
        const padded = (key + '='.repeat((4 - key.length % 4) % 4)).replace(/-/g, '+').replace(/_/g, '/');
        return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
    };

    // 'unsupported' | 'blocked' | 'on' | 'off'
    async function pushState() {
        if (!pushSupported()) return 'unsupported';
        if (Notification.permission === 'denied') return 'blocked';
        try {
            const registration = await navigator.serviceWorker.getRegistration();
            const subscription = await registration?.pushManager.getSubscription();
            return subscription && Notification.permission === 'granted' ? 'on' : 'off';
        } catch (error) {
            return 'off';
        }
    }

    async function enablePush() {
        if (!pushSupported()) throw new Error('Dieses Handy unterstützt Mitteilungen nur, wenn das Portal als App installiert ist.');
        const profile = await getProfile();
        if (!profile) throw new Error('Bitte zuerst anmelden.');
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') throw new Error('Mitteilungen wurden nicht erlaubt. Du kannst das in den Einstellungen des Handys ändern.');
        const key = await callFunction({ action: 'publicKey' });
        if (!key.ok || !key.data?.publicKey) throw new Error('Mitteilungen sind noch nicht eingerichtet. Bitte sag der Einsatzleitung Bescheid.');
        const registration = await navigator.serviceWorker.ready;
        let subscription = await registration.pushManager.getSubscription();
        if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key.data.publicKey) });
        const raw = subscription.toJSON();
        const { error } = await client.from('tt_push_subscriptions').upsert({
            endpoint: raw.endpoint, profile_id: profile.id, p256dh: raw.keys?.p256dh || '', auth: raw.keys?.auth || '',
            user_agent: navigator.userAgent.slice(0, 200)
        }, { onConflict: 'endpoint' });
        if (error) throw new Error(germanError(error));
        return true;
    }

    async function disablePush() {
        const registration = await navigator.serviceWorker.getRegistration();
        const subscription = await registration?.pushManager.getSubscription();
        if (!subscription) return;
        await client.from('tt_push_subscriptions').delete().eq('endpoint', subscription.endpoint);
        await subscription.unsubscribe();
    }

    // ---------- Speicherplatz ----------
    async function usage() {
        const profile = await getProfile().catch(() => null);
        if (!isStaff(profile)) return null;
        const { data, error } = await client.rpc('tt_usage');
        if (error || !data) return null;
        const limits = config.storageLimits || { databaseMb: 500, photosMb: 1024 };
        const mb = bytes => Math.round(Number(bytes || 0) / 1048576 * 10) / 10;
        return { databaseMb: mb(data.database_bytes), photosMb: mb(data.storage_bytes), photos: Number(data.photos || 0),
            databaseLimitMb: limits.databaseMb, photosLimitMb: limits.photosMb };
    }

    const todayIso = () => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    };
    const plateKey = plate => String(plate || '').replace(/[\s-]/g, '').toLocaleUpperCase('de-DE');
    const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
    const sameName = (left, right) => String(left || '').trim().toLocaleLowerCase('de') === String(right || '').trim().toLocaleLowerCase('de');

    // Gleicht den lokalen Fuhrpark (Fahrzeuge + heutige Übergaben) mit der Datenbank ab.
    // Nur für angemeldete Admins; alle anderen Fälle liefern { ok: false } ohne Fehler.
    async function syncFleet() {
        if (!client || typeof readFleetList !== 'function') return { ok: false, reason: 'offline' };
        let profile;
        try { profile = await getProfile(); } catch (error) { return { ok: false, reason: error.message }; }
        if (!isStaff(profile)) return { ok: false, reason: 'not-admin' };

        // --- Fahrzeuge: lokal ist die Vorlage, online fehlende kommen dazu ---
        const localVehicles = readFleetList(FLEET_VEHICLES_KEY);
        if (localVehicles.length) {
            const rows = localVehicles.filter(vehicle => plateKey(vehicle.plate)).map(vehicle => ({
                plate: vehicle.plate, plate_key: plateKey(vehicle.plate), brand: vehicle.brand || '', body: vehicle.body || '',
                type: vehicle.type || '', label: vehicle.label || '', active: vehicle.active !== false
            }));
            const { error } = await client.from('tt_vehicles').upsert(rows, { onConflict: 'plate_key' });
            if (error) return { ok: false, reason: germanError(error) };
        }
        const { data: cloudVehicles, error: vehicleError } = await client.from('tt_vehicles').select('*');
        if (vehicleError) return { ok: false, reason: germanError(vehicleError) };
        const localByKey = new Map(localVehicles.map(vehicle => [plateKey(vehicle.plate), vehicle]));
        let vehiclesChanged = false;
        cloudVehicles.forEach(cloud => {
            if (localByKey.has(cloud.plate_key)) return;
            const vehicle = { id: cloud.id, plate: cloud.plate, brand: cloud.brand, body: cloud.body, type: cloud.type, label: cloud.label, active: cloud.active, createdAt: cloud.created_at };
            localVehicles.push(vehicle);
            localByKey.set(cloud.plate_key, vehicle);
            vehiclesChanged = true;
        });
        // Fester Fahrer aus der Datenbank – dient im Live-Tracking als Vorschlag.
        const { data: profiles } = await client.from('tt_profiles').select('id, full_name');
        cloudVehicles.forEach(cloud => {
            const vehicle = localByKey.get(cloud.plate_key);
            const assignedName = (profiles || []).find(item => item.id === cloud.assigned_to)?.full_name || '';
            if (vehicle && (vehicle.assignedName || '') !== assignedName) { vehicle.assignedName = assignedName; vehiclesChanged = true; }
        });
        if (vehiclesChanged) saveFleetList(FLEET_VEHICLES_KEY, localVehicles);
        const cloudIdByKey = new Map(cloudVehicles.map(cloud => [cloud.plate_key, cloud.id]));
        const cloudVehicleById = new Map(cloudVehicles.map(cloud => [cloud.id, cloud]));
        const localVehicleById = new Map(localVehicles.map(vehicle => [vehicle.id, vehicle]));

        // --- Übergaben von heute in beide Richtungen ---
        const today = todayIso();
        const { data: cloudHandovers, error: handoverError } = await client.from('tt_handovers').select('*').eq('date', today);
        if (handoverError) return { ok: false, reason: germanError(handoverError) };
        const profileIdByName = name => (profiles || []).find(item => sameName(item.full_name, name))?.id || null;

        const allLocal = readFleetList(FLEET_HANDOVERS_KEY);
        let handoversChanged = false;
        allLocal.forEach(item => {
            if (normalizeFleetDate(item.date) === today && !isUuid(item.id)) { item.id = crypto.randomUUID(); handoversChanged = true; }
        });
        const localToday = allLocal.filter(item => normalizeFleetDate(item.date) === today);
        const cloudById = new Map(cloudHandovers.map(item => [item.id, item]));
        const localById = new Map(localToday.map(item => [item.id, item]));
        const toPush = [];

        localToday.forEach(item => {
            const cloud = cloudById.get(item.id);
            const vehicle = localVehicleById.get(item.vehicleId);
            const cloudVehicleId = cloudIdByKey.get(plateKey(vehicle?.plate || item.vehiclePlate));
            if (!cloudVehicleId) return;
            const row = {
                id: item.id, vehicle_id: cloudVehicleId, driver_id: cloud?.driver_id || profileIdByName(item.driver), driver_name: item.driver,
                date: today, start_time: item.startTime, end_time: item.endTime || null,
                start_mileage: item.startMileage === '' || item.startMileage == null ? null : Number(item.startMileage),
                end_mileage: item.endMileage === '' || item.endMileage == null ? null : Number(item.endMileage),
                note: item.note || ''
            };
            if (!cloud) toPush.push(row);
            else if (item.endTime && !cloud.end_time) toPush.push(row);                 // lokal beendet
            else if (cloud.end_time && !item.endTime) {                                  // online beendet (z. B. im Portal)
                item.endTime = String(cloud.end_time).slice(0, 5);
                if (cloud.end_mileage != null) item.endMileage = cloud.end_mileage;
                handoversChanged = true;
            }
        });
        cloudHandovers.forEach(cloud => {
            if (localById.has(cloud.id)) return;
            const cloudVehicle = cloudVehicleById.get(cloud.vehicle_id);
            const vehicle = cloudVehicle ? localByKey.get(cloudVehicle.plate_key) : null;
            if (!vehicle) return;
            allLocal.push({
                id: cloud.id, vehicleId: vehicle.id, vehiclePlate: vehicle.plate, vehicleType: vehicle.type || '',
                driver: cloud.driver_name, date: today, startTime: String(cloud.start_time).slice(0, 5),
                endTime: cloud.end_time ? String(cloud.end_time).slice(0, 5) : '',
                startMileage: cloud.start_mileage ?? '', endMileage: cloud.end_mileage ?? '', note: cloud.note || '',
                createdAt: cloud.created_at
            });
            handoversChanged = true;
        });
        if (toPush.length) {
            const { error } = await client.from('tt_handovers').upsert(toPush, { onConflict: 'id' });
            if (error) return { ok: false, reason: germanError(error) };
        }
        if (handoversChanged) saveFleetList(FLEET_HANDOVERS_KEY, allLocal);
        return { ok: true, changed: vehiclesChanged || handoversChanged, pushed: toPush.length };
    }

    return { client, available: Boolean(client), isStaff, isAdmin, germanError, getSession, getProfile, signIn, signUp, signOut, syncFleet, uploadPhoto, photoUrl, inboxCounts, todayIso, plateKey,
        callFunction, pushSupported, pushState, enablePush, disablePush, usage };
})();
