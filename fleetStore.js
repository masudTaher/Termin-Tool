// Gemeinsamer Fuhrpark-Speicher für die Fahrzeugseite und das Live-Tracking.
// Alles bleibt im Browser dieses Geräts (localStorage).
const FLEET_VEHICLES_KEY = 'terminTool.fleet.vehicles.v1';
const FLEET_HANDOVERS_KEY = 'terminTool.fleet.handovers.v1';
const FLEET_DRIVERS_KEY = 'terminTool.fleet.drivers.v1';
const FLEET_BODY_TYPES = ['Kombi', 'Limousine', 'Bus'];

function readFleetList(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(value) ? value : [];
    } catch (error) {
        return [];
    }
}

function saveFleetList(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch (error) {
        setFleetStatus('Speichern im Browser war nicht möglich. Prüfe den verfügbaren Browserspeicher.', 'error');
        return false;
    }
}

function setFleetStatus(message, kind = 'info') {
    const status = document.getElementById('fleetStatus');
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind;
}

function getLocalDateInputValue(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getLocalTimeInputValue(date = new Date()) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function createFleetId() {
    return globalThis.crypto?.randomUUID?.() || `fleet-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeFleetDate(value) {
    if (!value) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const match = String(value).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    return match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : '';
}

function normalizeFleetPlateKey(plate) {
    return String(plate || '').replace(/[\s-]/g, '').toLocaleUpperCase('de-DE');
}

// „BN AB 123 · Toyota Kombi“ – kurz genug für Auswahllisten.
function getFleetVehicleLabel(vehicle) {
    const description = [vehicle.brand, vehicle.body].filter(Boolean).join(' ') || vehicle.label || '';
    return [vehicle.plate, description].filter(Boolean).join(' · ');
}

function getFleetVehicleDetails(vehicle) {
    return [vehicle.brand, vehicle.body, vehicle.type, vehicle.label].filter(Boolean).join(' · ');
}

function readActiveFleetVehicles() {
    return readFleetList(FLEET_VEHICLES_KEY)
        .filter(vehicle => vehicle.active !== false)
        .sort((left, right) => String(left.plate).localeCompare(String(right.plate), 'de'));
}

// Fahrzeuge, die man heute ausgeben kann: im Fuhrpark und weder in der Werkstatt noch gesperrt.
function readAvailableFleetVehicles() {
    return readActiveFleetVehicles().filter(vehicle => !vehicle.service);
}

function findFleetVehicleByPlate(plate) {
    const key = normalizeFleetPlateKey(plate);
    if (!key) return null;
    return readFleetList(FLEET_VEHICLES_KEY).find(vehicle => normalizeFleetPlateKey(vehicle.plate) === key) || null;
}

function sameFleetDriver(left, right) {
    return String(left || '').trim().toLocaleLowerCase('de') === String(right || '').trim().toLocaleLowerCase('de');
}

// Offene Nutzungen von heute: Kennzeichen-Schlüssel → Fahrer/in.
function getTodaysOpenFleetHandovers() {
    const today = getLocalDateInputValue();
    return readFleetList(FLEET_HANDOVERS_KEY).filter(item => normalizeFleetDate(item.date) === today && !item.endTime);
}

function getCurrentFleetVehicleForDriver(driver) {
    if (!String(driver || '').trim()) return null;
    const open = getTodaysOpenFleetHandovers().find(item => sameFleetDriver(item.driver, driver));
    if (!open) return null;
    return readFleetList(FLEET_VEHICLES_KEY).find(vehicle => vehicle.id === open.vehicleId) || null;
}

// Schnelle Übernahme aus dem Live-Tracking: beendet die bisherige Nutzung des
// Fahrzeugs und ein anderes Fahrzeug derselben Person und trägt die neue ein.
function assignFleetVehicleToDriver(vehicleId, driver, note = 'Im Live-Tracking zugewiesen') {
    const name = String(driver || '').trim().replace(/\s+/g, ' ');
    const vehicle = readFleetList(FLEET_VEHICLES_KEY).find(item => item.id === vehicleId);
    if (!vehicle || !name) return { ok: false, changed: false };

    const today = getLocalDateInputValue();
    const now = getLocalTimeInputValue();
    const entries = readFleetList(FLEET_HANDOVERS_KEY);
    const isOpenToday = item => normalizeFleetDate(item.date) === today && !item.endTime;
    if (entries.some(item => isOpenToday(item) && item.vehicleId === vehicleId && sameFleetDriver(item.driver, name))) {
        return { ok: true, changed: false, vehicle };
    }

    let previousDriver = '';
    entries.forEach(item => {
        if (!isOpenToday(item)) return;
        if (item.vehicleId === vehicleId) {
            previousDriver = item.driver;
            item.endTime = now;
        } else if (sameFleetDriver(item.driver, name)) {
            item.endTime = now;
        }
    });
    entries.push({
        id: createFleetId(), vehicleId, vehiclePlate: vehicle.plate, vehicleType: vehicle.type,
        driver: name, date: today, startTime: now, endTime: '', startMileage: '', endMileage: '', note,
        createdAt: new Date().toISOString()
    });
    if (!saveFleetList(FLEET_HANDOVERS_KEY, entries)) return { ok: false, changed: false };

    const drivers = readFleetList(FLEET_DRIVERS_KEY);
    if (!drivers.some(existing => sameFleetDriver(existing, name))) {
        saveFleetList(FLEET_DRIVERS_KEY, [...drivers, name].sort((a, b) => a.localeCompare(b, 'de')));
    }
    return { ok: true, changed: true, vehicle, previousDriver };
}
