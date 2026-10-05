const FLEET_UNDO_KEY = 'terminTool.fleet.undo.v1';

function readFleetUndoHistory() {
    try {
        const value = JSON.parse(sessionStorage.getItem(FLEET_UNDO_KEY) || '[]');
        return Array.isArray(value) ? value.slice(-3) : [];
    } catch (error) {
        return [];
    }
}

function updateFleetUndoButton() {
    const button = document.getElementById('undoFleetChange');
    if (!button) return;
    const history = readFleetUndoHistory();
    button.disabled = history.length === 0;
    button.textContent = history.length ? `Rückgängig (${history.length})` : 'Rückgängig';
}

function recordFleetUndo(label) {
    const history = readFleetUndoHistory();
    history.push({
        label,
        vehicles: readFleetList(FLEET_VEHICLES_KEY),
        handovers: readFleetList(FLEET_HANDOVERS_KEY),
        drivers: readFleetList(FLEET_DRIVERS_KEY)
    });
    try {
        sessionStorage.setItem(FLEET_UNDO_KEY, JSON.stringify(history.slice(-3)));
    } catch (error) {
        setFleetStatus('Der letzte Fuhrpark-Schritt konnte nicht für „Rückgängig“ gesichert werden.', 'error');
    }
    updateFleetUndoButton();
}

function undoLastFleetChange() {
    const history = readFleetUndoHistory();
    const previous = history.pop();
    if (!previous) return;
    // „dirty“: Der wiederhergestellte Stand gilt und wird beim nächsten Abgleich in die Datenbank geschrieben.
    saveFleetList(FLEET_VEHICLES_KEY, previous.vehicles.map(vehicle => ({ ...vehicle, dirty: true })));
    saveFleetList(FLEET_HANDOVERS_KEY, previous.handovers);
    saveFleetList(FLEET_DRIVERS_KEY, previous.drivers);
    sessionStorage.setItem(FLEET_UNDO_KEY, JSON.stringify(history));
    setFleetStatus(`Rückgängig gemacht: ${previous.label}.`);
    renderFleetPage();
}






function renderVehicleDirectory() {
    const vehicles = readActiveFleetVehicles();
    const openToday = new Map(getTodaysOpenFleetHandovers().map(item => [item.vehicleId, item.driver]));
    const list = document.getElementById('vehicleDirectoryList');
    const select = document.getElementById('handoverVehicle');
    list.replaceChildren();
    select.replaceChildren();

    if (!vehicles.length) {
        const empty = document.createElement('li');
        empty.className = 'directory-empty';
        empty.textContent = 'Noch keine Fahrzeuge erfasst.';
        list.append(empty);
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Zuerst ein Fahrzeug erfassen';
        select.append(option);
        select.disabled = true;
        return;
    }

    select.disabled = false;
    vehicles.forEach(vehicle => {
        const option = document.createElement('option');
        option.value = vehicle.id;
        option.textContent = [getFleetVehicleLabel(vehicle), vehicle.type].filter(Boolean).join(' — ');
        const serviceText = vehicle.service === 'werkstatt' ? 'in der Werkstatt' : vehicle.service === 'gesperrt' ? 'gesperrt' : '';
        if (serviceText) { option.disabled = true; option.textContent += ` — ${serviceText}`; }
        select.append(option);

        const item = document.createElement('li');
        item.className = 'vehicle-entry';
        const meta = document.createElement('span');
        const driver = openToday.get(vehicle.id);
        meta.innerHTML = `<strong>${escapeHtml(vehicle.plate)}</strong><small>${escapeHtml(getFleetVehicleDetails(vehicle))}</small>${driver ? `<small class="vehicle-driver">Heute bei ${escapeHtml(driver)}</small>` : ''}${serviceText ? `<small class="vehicle-driver">Zurzeit ${serviceText}</small>` : ''}`;
        const actions = document.createElement('span');
        actions.className = 'vehicle-entry-actions';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'button-quiet';
        edit.textContent = 'Bearbeiten';
        edit.setAttribute('aria-label', `${vehicle.plate} bearbeiten`);
        edit.addEventListener('click', () => startVehicleEdit(vehicle.id));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'button-quiet-danger';
        remove.textContent = 'Aus dem Fuhrpark nehmen';
        remove.title = 'Das Fahrzeug verschwindet auf allen Geräten aus der Liste; alte Fahrten bleiben erhalten. Endgültig löschen: Seite „Fuhrpark“.';
        remove.setAttribute('aria-label', `${vehicle.plate} aus dem Fuhrpark nehmen`);
        remove.addEventListener('click', () => archiveVehicle(vehicle.id));
        actions.append(edit, remove);
        item.append(meta, actions);
        list.append(item);
    });
}

function archiveVehicle(vehicleId) {
    const today = getLocalDateInputValue();
    const activeHandover = readFleetList(FLEET_HANDOVERS_KEY).find(item =>
        item.vehicleId === vehicleId
        && normalizeFleetDate(item.date) === today
        && !item.endTime
    );
    if (activeHandover) {
        setFleetStatus(`Fahrzeug ${activeHandover.vehiclePlate} ist heute noch ${activeHandover.driver} zugewiesen. Beende zuerst die Fahrt.`, 'error');
        return;
    }
    const vehicles = readFleetList(FLEET_VEHICLES_KEY);
    const updated = vehicles.map(vehicle => vehicle.id === vehicleId ? { ...vehicle, active: false, dirty: true } : vehicle);
    recordFleetUndo('Fahrzeug aus dem Fuhrpark genommen');
    if (saveFleetList(FLEET_VEHICLES_KEY, updated)) {
        setFleetStatus('Fahrzeug aus dem Fuhrpark genommen – auf allen Geräten. Alte Übergaben bleiben im Verlauf erhalten. Wiederherstellen oder endgültig löschen: Seite „Fuhrpark“.');
        renderFleetPage();
    }
}

function startVehicleEdit(vehicleId) {
    const vehicle = readFleetList(FLEET_VEHICLES_KEY).find(item => item.id === vehicleId);
    if (!vehicle) return;
    document.getElementById('vehicleEditId').value = vehicle.id;
    document.getElementById('vehiclePlate').value = vehicle.plate || '';
    document.getElementById('vehicleBrand').value = vehicle.brand || '';
    document.getElementById('vehicleBody').value = FLEET_BODY_TYPES.includes(vehicle.body) ? vehicle.body : '';
    document.getElementById('vehicleType').value = vehicle.type || 'Diplomatisch';
    document.getElementById('vehicleLabel').value = vehicle.label || '';
    document.getElementById('vehicleSubmitButton').textContent = 'Änderung speichern';
    document.getElementById('vehicleCancelEdit').hidden = false;
    document.getElementById('vehiclePlate').focus();
}

function resetVehicleForm() {
    document.getElementById('addVehicleForm').reset();
    document.getElementById('vehicleEditId').value = '';
    document.getElementById('vehicleSubmitButton').textContent = 'Fahrzeug speichern';
    document.getElementById('vehicleCancelEdit').hidden = true;
}

function addVehicle(event) {
    event.preventDefault();
    const editId = document.getElementById('vehicleEditId').value;
    const plate = document.getElementById('vehiclePlate').value.trim().toLocaleUpperCase('de-DE').replace(/\s+/g, ' ');
    const brand = document.getElementById('vehicleBrand').value.trim().replace(/\s+/g, ' ');
    const body = document.getElementById('vehicleBody').value;
    const type = document.getElementById('vehicleType').value;
    const label = document.getElementById('vehicleLabel').value.trim();
    const vehicles = readFleetList(FLEET_VEHICLES_KEY);
    const plateKey = normalizeFleetPlateKey(plate);
    if (!plateKey) return;
    const duplicate = vehicles.find(vehicle => vehicle.id !== editId && normalizeFleetPlateKey(vehicle.plate) === plateKey);
    if (duplicate && duplicate.active !== false) {
        setFleetStatus(`Das Kennzeichen ${plate} ist bereits erfasst.`, 'error');
        return;
    }

    let updated;
    if (editId) {
        recordFleetUndo('Fahrzeug geändert');
        updated = vehicles.map(vehicle => vehicle.id === editId ? { ...vehicle, plate, brand, body, type, label, dirty: true } : vehicle);
    } else if (duplicate) {
        // Ein früher ausgeblendetes Kennzeichen wird wieder aktiviert statt doppelt angelegt.
        recordFleetUndo('Fahrzeug wieder aktiviert');
        updated = vehicles.map(vehicle => vehicle.id === duplicate.id ? { ...vehicle, plate, brand, body, type, label, active: true, dirty: true } : vehicle);
    } else {
        recordFleetUndo('Fahrzeug hinzugefügt');
        updated = [...vehicles, { id: createFleetId(), plate, brand, body, type, label, active: true, createdAt: new Date().toISOString() }];
    }
    if (saveFleetList(FLEET_VEHICLES_KEY, updated)) {
        resetVehicleForm();
        setFleetStatus(`${plate} wurde im Fuhrpark gespeichert.`);
        if (typeof showToast === 'function') showToast(`${plate} gespeichert`, 'success');
        renderFleetPage();
        document.getElementById('vehiclePlate').focus();
    }
}

function addVehicleHandover(event) {
    event.preventDefault();
    const vehicleId = document.getElementById('handoverVehicle').value;
    const driver = document.getElementById('driverName').value.trim().replace(/\s+/g, ' ');
    const date = document.getElementById('handoverDate').value;
    const startTime = document.getElementById('handoverTime').value;
    const mileageText = document.getElementById('handoverMileage').value.trim();
    const mileage = mileageText ? Number(mileageText) : '';
    const note = document.getElementById('handoverNote').value.trim();
    if (!vehicleId || !driver || !date || !/^\d{2}:\d{2}$/.test(startTime)) return;

    const vehicles = readFleetList(FLEET_VEHICLES_KEY);
    const vehicle = vehicles.find(item => item.id === vehicleId);
    if (!vehicle) {
        setFleetStatus('Wähle bitte ein gespeichertes Fahrzeug.', 'error');
        return;
    }

    const entries = readFleetList(FLEET_HANDOVERS_KEY);
    const sameVehicleDay = entries.filter(item => item.vehicleId === vehicleId && normalizeFleetDate(item.date) === date)
        .sort((left, right) => left.startTime.localeCompare(right.startTime));
    const latest = sameVehicleDay[sameVehicleDay.length - 1];
    if (latest && startTime <= latest.startTime) {
        setFleetStatus(`Die neue Übergabe muss nach dem letzten Start um ${latest.startTime} liegen.`, 'error');
        return;
    }
    if (latest?.endTime && startTime < latest.endTime) {
        setFleetStatus(`Die neue Übergabe überschneidet sich mit der vorherigen Fahrt bis ${latest.endTime}.`, 'error');
        return;
    }

    const sameDriverOverlap = entries.find(item => item.driver.toLocaleLowerCase('de') === driver.toLocaleLowerCase('de')
        && normalizeFleetDate(item.date) === date
        && item.vehicleId !== vehicleId
        && item.startTime <= startTime
        && (!item.endTime || item.endTime > startTime));
    if (sameDriverOverlap) {
        const otherVehicle = vehicles.find(item => item.id === sameDriverOverlap.vehicleId);
        setFleetStatus(`${driver} ist laut Protokoll noch im Fahrzeug ${otherVehicle?.plate || ''}. Beende diese Nutzung zuerst.`, 'error');
        return;
    }

    const closedPreviousHandover = Boolean(latest && !latest.endTime);
    recordFleetUndo('Fahrzeugübergabe eingetragen');
    if (latest && !latest.endTime) {
        latest.endTime = startTime;
        if (mileage !== '') latest.endMileage = mileage;
    }
    const handover = {
        id: createFleetId(), vehicleId, vehiclePlate: vehicle.plate, vehicleType: vehicle.type,
        driver, date, startTime, endTime: '', startMileage: mileage, endMileage: '', note,
        createdAt: new Date().toISOString()
    };
    if (!saveFleetList(FLEET_HANDOVERS_KEY, [...entries.filter(item => item.id !== latest?.id), ...(latest ? [latest] : []), handover])) return;

    const drivers = readFleetList(FLEET_DRIVERS_KEY);
    if (!drivers.some(name => name.toLocaleLowerCase('de') === driver.toLocaleLowerCase('de'))) {
        saveFleetList(FLEET_DRIVERS_KEY, [...drivers, driver].sort((a, b) => a.localeCompare(b, 'de')));
    }
    document.getElementById('handoverNote').value = '';
    document.getElementById('handoverMileage').value = '';
    document.getElementById('fleetLogDate').value = date;
    setFleetStatus(closedPreviousHandover
        ? `${vehicle.plate}: vorherige Fahrt um ${startTime} beendet; ${driver} hat übernommen.`
        : `${driver} hat ${vehicle.plate} um ${startTime} übernommen.`);
    renderFleetPage();
}

function endVehicleHandover(id) {
    const entries = readFleetList(FLEET_HANDOVERS_KEY);
    const current = entries.find(item => item.id === id);
    if (!current || current.endTime) return;
    if (normalizeFleetDate(current.date) !== getLocalDateInputValue()) {
        setFleetStatus('Eine Fahrt aus einem vergangenen Tag kann hier nicht mit einer heutigen Rückgabezeit beendet werden.', 'error');
        return;
    }
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (currentTime <= current.startTime) {
        setFleetStatus('Die Rückgabezeit muss nach der Startzeit liegen.', 'error');
        return;
    }
    const endTime = currentTime;
    const mileageText = document.getElementById('handoverMileage').value.trim();
    recordFleetUndo('Fahrt beendet');
    current.endTime = endTime;
    current.endMileage = mileageText ? Number(mileageText) : '';
    if (saveFleetList(FLEET_HANDOVERS_KEY, entries)) {
        setFleetStatus(`${current.vehiclePlate}: Fahrt von ${current.driver} um ${endTime} beendet.`);
        renderFleetPage();
    }
}

function renderFleetLog() {
    const date = document.getElementById('fleetLogDate').value;
    const vehicles = readFleetList(FLEET_VEHICLES_KEY);
    const vehicleById = new Map(vehicles.map(vehicle => [vehicle.id, vehicle]));
    const allHandovers = readFleetList(FLEET_HANDOVERS_KEY);
    const rows = allHandovers.filter(item => normalizeFleetDate(item.date) === date)
        .sort((left, right) => left.startTime.localeCompare(right.startTime));
    const body = document.getElementById('fleetLogBody');
    body.replaceChildren();
    document.getElementById('fleetLogEmpty').hidden = rows.length > 0;
    document.getElementById('fleetLogSummary').textContent = `${rows.length} ${rows.length === 1 ? 'Fahrt/Übergabe' : 'Fahrten/Übergaben'} am ${formatFleetDate(date)}.`;

    rows.forEach(item => {
        const vehicle = vehicleById.get(item.vehicleId);
        const row = document.createElement('tr');
        const mileage = item.startMileage !== '' || item.endMileage !== ''
            ? `${item.startMileage === '' ? '–' : item.startMileage} → ${item.endMileage === '' ? '–' : item.endMileage}`
            : '–';
        const values = [vehicle ? getFleetVehicleLabel(vehicle) : item.vehiclePlate, vehicle?.type || item.vehicleType, item.driver, item.startTime, item.endTime || 'Unterwegs', mileage, item.note || '–'];
        values.forEach((value, index) => {
            const cell = document.createElement('td');
            cell.dataset.label = ['Fahrzeug', 'Fahrzeugart', 'Fahrer/in', 'Beginn', 'Übergabe / Ende', 'Kilometer', 'Notiz'][index];
            cell.textContent = String(value ?? '');
            row.append(cell);
        });
        const actionCell = document.createElement('td');
        actionCell.dataset.label = 'Aktion';
        if (!item.endTime && normalizeFleetDate(item.date) === getLocalDateInputValue()) {
            const end = document.createElement('button');
            end.type = 'button';
            end.className = 'button-secondary fleet-end-button';
            end.textContent = 'Fahrt beenden';
            end.addEventListener('click', () => endVehicleHandover(item.id));
            actionCell.append(end);
        } else {
            actionCell.append(document.createTextNode(item.endTime ? 'Abgeschlossen ' : 'Offen – vergangener Tag '));
        }
        // Jeder Eintrag lässt sich korrigieren (Zeiten, Kilometer, Fahrer, Notiz) oder löschen.
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.className = 'button-quiet';
        edit.textContent = 'Korrigieren';
        edit.setAttribute('aria-label', `Eintrag ${item.vehiclePlate} ${item.startTime} korrigieren`);
        edit.addEventListener('click', () => openHandoverEdit(item.id));
        actionCell.append(edit);
        row.append(actionCell);
        body.append(row);
    });

    document.getElementById('fleetHandoverCount').textContent = String(rows.length);
    const today = getLocalDateInputValue();
    document.getElementById('fleetActiveCount').textContent = String(allHandovers.filter(item =>
        normalizeFleetDate(item.date) === today && !item.endTime
    ).length);
}

// ---------- Einen Eintrag korrigieren oder löschen ----------
// Geändert wird der Eintrag auf diesem Gerät und – bei Online-Anmeldung – derselbe Eintrag in der Datenbank.
let editedHandoverId = null;
const isFleetUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));

function handoverEditStatus(message, kind = 'error') {
    const status = document.getElementById('handoverEditStatus');
    status.hidden = !message;
    status.textContent = message || '';
    status.dataset.kind = kind;
}

function openHandoverEdit(id) {
    const item = readFleetList(FLEET_HANDOVERS_KEY).find(entry => entry.id === id);
    if (!item) return;
    editedHandoverId = id;
    document.getElementById('handoverEditInfo').textContent = `${item.vehiclePlate} · ${formatFleetDate(normalizeFleetDate(item.date))}`;
    document.getElementById('handoverEditDriver').value = item.driver || '';
    document.getElementById('handoverEditStart').value = item.startTime || '';
    document.getElementById('handoverEditEnd').value = item.endTime || '';
    document.getElementById('handoverEditStartKm').value = item.startMileage === '' || item.startMileage == null ? '' : String(item.startMileage);
    document.getElementById('handoverEditEndKm').value = item.endMileage === '' || item.endMileage == null ? '' : String(item.endMileage);
    document.getElementById('handoverEditNote').value = item.note || '';
    handoverEditStatus('');
    document.getElementById('handoverEditDialog').showModal();
}

// Liefert das angemeldete Profil der Einsatzleitung – oder null, wenn offline bzw. nicht angemeldet.
async function fleetStaffProfile() {
    if (typeof TerminCloud === 'undefined' || !TerminCloud.available) return null;
    try { const profile = await TerminCloud.getProfile(); return TerminCloud.isStaff(profile) ? profile : null; } catch (error) { return null; }
}

async function saveHandoverEdit(event) {
    event.preventDefault();
    const entries = readFleetList(FLEET_HANDOVERS_KEY);
    const item = entries.find(entry => entry.id === editedHandoverId);
    if (!item) { document.getElementById('handoverEditDialog').close(); return; }
    const driver = document.getElementById('handoverEditDriver').value.trim().replace(/\s+/g, ' ');
    const startTime = document.getElementById('handoverEditStart').value;
    const endTime = document.getElementById('handoverEditEnd').value;
    const number = id => { const text = document.getElementById(id).value.trim(); return text === '' ? '' : Number(text); };
    const startMileage = number('handoverEditStartKm');
    const endMileage = number('handoverEditEndKm');
    if (!driver) { handoverEditStatus('Bitte trag den Namen ein.'); return; }
    if (!/^\d{2}:\d{2}$/.test(startTime)) { handoverEditStatus('Bitte trag die Uhrzeit des Beginns ein.'); return; }
    if (endTime && endTime <= startTime) { handoverEditStatus('Das Ende muss nach dem Beginn liegen.'); return; }
    if ([startMileage, endMileage].some(value => value !== '' && (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)))) { handoverEditStatus('Kilometer bitte als ganze Zahl eintragen.'); return; }
    if (startMileage !== '' && endMileage !== '' && endMileage < startMileage) { handoverEditStatus(`Der Kilometerstand am Ende (${endMileage}) ist kleiner als bei Beginn (${startMileage}).`); return; }
    const note = document.getElementById('handoverEditNote').value.trim();
    const save = document.getElementById('handoverEditSave');
    save.disabled = true;
    // Online zuerst: gelingt die Änderung in der Datenbank nicht, bleibt auch hier alles beim Alten.
    const profile = isFleetUuid(item.id) ? await fleetStaffProfile() : null;
    if (profile) {
        const client = TerminCloud.client;
        const { data: cloud } = await client.from('tt_handovers').select('id, driver_name, driver_id').eq('id', item.id).maybeSingle();
        if (cloud) {
            const changes = { driver_name: driver, start_time: `${startTime}:00`, end_time: endTime ? `${endTime}:00` : null, start_mileage: startMileage === '' ? null : startMileage, end_mileage: endMileage === '' ? null : endMileage, note };
            if (endTime && !item.endTime) changes.end_date = normalizeFleetDate(item.date);
            // Anderer Name: das passende Portal-Konto suchen (oder die Verknüpfung lösen).
            if (driver.toLocaleLowerCase('de') !== String(cloud.driver_name || '').toLocaleLowerCase('de')) {
                const { data: people } = await client.from('tt_profiles').select('id, full_name');
                changes.driver_id = (people || []).find(person => String(person.full_name || '').trim().toLocaleLowerCase('de') === driver.toLocaleLowerCase('de'))?.id || null;
            }
            const { error } = await client.from('tt_handovers').update(changes).eq('id', item.id);
            if (error) { save.disabled = false; handoverEditStatus(`Online konnte der Eintrag nicht geändert werden: ${TerminCloud.germanError(error)}`); return; }
        }
    }
    Object.assign(item, { driver, startTime, endTime: endTime || '', startMileage, endMileage, note });
    save.disabled = false;
    if (!saveFleetList(FLEET_HANDOVERS_KEY, entries)) { handoverEditStatus('Der Eintrag konnte auf diesem Gerät nicht gespeichert werden.'); return; }
    document.getElementById('handoverEditDialog').close();
    setFleetStatus(`${item.vehiclePlate}: Eintrag von ${driver} korrigiert.`);
    renderFleetPage();
}

async function deleteHandoverEntry() {
    const entries = readFleetList(FLEET_HANDOVERS_KEY);
    const item = entries.find(entry => entry.id === editedHandoverId);
    if (!item) { document.getElementById('handoverEditDialog').close(); return; }
    if (!await confirmDialog(`Den Eintrag ${item.vehiclePlate} · ${item.driver} · ${item.startTime} Uhr endgültig löschen?\n\nEr verschwindet aus dem Protokoll – auch online, also auf allen Geräten und in der Fahrzeugakte.`, 'Eintrag löschen')) return;
    const profile = isFleetUuid(item.id) ? await fleetStaffProfile() : null;
    if (profile) {
        const client = TerminCloud.client;
        const { data: cloud } = await client.from('tt_handovers').select('id').eq('id', item.id).maybeSingle();
        if (cloud) {
            if (!TerminCloud.isAdmin(profile)) { handoverEditStatus('Fahrten, die online gespeichert sind, darf nur der Admin löschen.'); return; }
            const { data, error } = await client.from('tt_handovers').delete().eq('id', item.id).select();
            if (error || !data?.length) { handoverEditStatus(`Online konnte der Eintrag nicht gelöscht werden${error ? `: ${TerminCloud.germanError(error)}` : '.'}`); return; }
        }
    }
    if (!saveFleetList(FLEET_HANDOVERS_KEY, entries.filter(entry => entry.id !== item.id))) return;
    document.getElementById('handoverEditDialog').close();
    setFleetStatus(`${item.vehiclePlate}: Eintrag von ${item.driver} gelöscht.`);
    renderFleetPage();
}

function formatFleetDate(value) {
    if (!value) return 'heute';
    const [year, month, day] = value.split('-');
    return `${day}.${month}.${year}`;
}

function refreshDriverSuggestions() {
    const datalist = document.getElementById('knownDrivers');
    if (!datalist) return;
    // Vorgeschlagen werden die Dolmetscher mit Portal-Konto (ohne Konten: die eigene Namensliste) und wer schon gefahren ist.
    const interpreters = typeof interpreterSuggestionNames === 'function' ? interpreterSuggestionNames() : typeof readInterpreterDirectory === 'function' ? readInterpreterDirectory() : [];
    const drivers = [...readFleetList(FLEET_DRIVERS_KEY), ...interpreters]
        .filter((name, index, names) => names.findIndex(other => sameFleetDriver(other, name)) === index)
        .sort((a, b) => a.localeCompare(b, 'de'));
    datalist.replaceChildren(...drivers.map(driver => {
        const option = document.createElement('option');
        option.value = driver;
        return option;
    }));
}

function exportFleetLog() {
    const date = document.getElementById('fleetLogDate').value;
    const vehicles = new Map(readFleetList(FLEET_VEHICLES_KEY).map(vehicle => [vehicle.id, vehicle]));
    const records = readFleetList(FLEET_HANDOVERS_KEY).filter(item => normalizeFleetDate(item.date) === date);
    if (!records.length) {
        setFleetStatus('Für den gewählten Tag gibt es kein Protokoll zum Exportieren.');
        return;
    }
    const csvValue = value => {
        let text = String(value ?? '');
        if (/^[=+@-]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
    };
    const headers = ['Datum', 'Kennzeichen', 'Marke', 'Bauart', 'Fahrzeugart', 'Fahrer/in', 'Beginn', 'Übergabe/Ende', 'KM Beginn', 'KM Ende', 'Notiz'];
    const lines = [headers, ...records.map(item => {
        const vehicle = vehicles.get(item.vehicleId);
        return [formatFleetDate(date), vehicle?.plate || item.vehiclePlate, vehicle?.brand || '', vehicle?.body || '', vehicle?.type || item.vehicleType, item.driver, item.startTime, item.endTime, item.startMileage, item.endMileage, item.note];
    })].map(row => row.map(csvValue).join(';'));
    const blob = new Blob([`\ufeff${lines.join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${date}_Fahrzeugprotokoll.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
    setFleetStatus('Das Tagesprotokoll wurde exportiert.');
}

function renderFleetPage() {
    const vehicles = readActiveFleetVehicles();
    document.getElementById('fleetVehicleCount').textContent = String(vehicles.length);
    renderVehicleDirectory();
    refreshDriverSuggestions();
    renderFleetLog();
}

document.getElementById('addVehicleForm').addEventListener('submit', addVehicle);
document.getElementById('vehicleCancelEdit').addEventListener('click', resetVehicleForm);
document.getElementById('addHandoverForm').addEventListener('submit', addVehicleHandover);
document.getElementById('fleetLogDate').addEventListener('change', renderFleetLog);
document.getElementById('exportFleetLog').addEventListener('click', exportFleetLog);
document.getElementById('undoFleetChange').addEventListener('click', undoLastFleetChange);
document.getElementById('handoverEditForm').addEventListener('submit', saveHandoverEdit);
document.getElementById('handoverEditCancel').addEventListener('click', () => document.getElementById('handoverEditDialog').close());
document.getElementById('handoverEditDelete').addEventListener('click', deleteHandoverEntry);

const today = getLocalDateInputValue();
document.getElementById('handoverDate').value = today;
document.getElementById('fleetLogDate').value = today;
document.getElementById('handoverTime').value = getLocalTimeInputValue();
renderFleetPage();
updateFleetUndoButton();
document.addEventListener('fleet-synced', renderFleetPage);
