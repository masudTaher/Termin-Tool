// Direkt nach einem Update kann der Browser für wenige Minuten noch die ältere Seite liefern, in der contactParse.js
// fehlt. Dann wird die Datei hier nachgeladen; bis sie da ist, hilft eine einfache Ersatzfassung (Adresse und
// Nummern bleiben zusammen in einer Zeile), damit nichts stehen bleibt.
if (!window.TerminContact) {
    const lines = value => String(value ?? '').replace(/\r\n?/g, '\n');
    const one = value => lines(value).replace(/\s*\n+\s*/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '');
    window.TerminContact = {
        standIn: true, normalizeLineBreaks: lines, singleLine: one,
        parsePatientContact: value => ({ address: one(value), extra: [], phones: [] }),
        parsePhones: value => /\d/.test(String(value || '')) ? [{ number: one(value), whatsapp: false, note: '' }] : [],
        whatsappNumber: () => '', isQatarNumber: () => false, dialNumber: number => String(number || '').replace(/[^\d+]/g, ''),
        mapQuery: address => one(address), formatPhone: phone => String(phone?.number || '')
    };
    const script = document.createElement('script');
    script.src = 'contactParse.js';
    script.addEventListener('load', () => window.dispatchEvent(new Event('termincontact-ready')));
    document.head.append(script);
}

let trackingData = [];
let workbook;
let activeWhatsAppAppointmentIndex = null;
let trackingStatusFilter = 'alle';
let trackingSearchTerm = '';
const TRACKING_UNDO_KEY = 'terminTool.trackingUndo.v1';
const TRACKING_UNDO_LIMIT = 3;

function ensureTrackingFields(records) {
    const interpreterHeaderPattern = /^(?:uebersetzer|dolmetscher|dolmetschername|uebersetzername|interpreter|interpretername)$/;
    return normalizeTerminRecords(records).map(record => {
        const interpreterAlias = Object.keys(record).find(key => interpreterHeaderPattern.test(normalizeAppointmentColumnName(key)));
        return {
            ...record,
            Übersetzer: String(record.Übersetzer || (interpreterAlias ? record[interpreterAlias] : '') || '').trim(),
            Status: String(record.Status || 'offen').trim() || 'offen'
        };
    });
}

function readTrackingUndoHistory() {
    try {
        const value = JSON.parse(sessionStorage.getItem(TRACKING_UNDO_KEY) || '[]');
        return Array.isArray(value) ? value.slice(-TRACKING_UNDO_LIMIT) : [];
    } catch (error) {
        return [];
    }
}

function updateUndoButton() {
    const button = document.getElementById('undoChangesButton');
    if (!button) return;
    const history = readTrackingUndoHistory();
    button.disabled = history.length === 0;
    button.textContent = history.length ? `Rückgängig (${history.length})` : 'Rückgängig';
}

function recordTrackingUndo(label) {
    const history = readTrackingUndoHistory();
    history.push({ label, records: JSON.parse(JSON.stringify(trackingData)) });
    try {
        sessionStorage.setItem(TRACKING_UNDO_KEY, JSON.stringify(history.slice(-TRACKING_UNDO_LIMIT)));
    } catch (error) {
        showWorkflowStatus('Die letzten Änderungen konnten nicht für „Rückgängig“ gesichert werden.', 'error');
    }
    updateUndoButton();
}

function undoLastTrackingChange() {
    const history = readTrackingUndoHistory();
    const snapshot = history.pop();
    if (!snapshot) return;
    trackingData = ensureTrackingFields(snapshot.records);
    sessionStorage.setItem(TRACKING_UNDO_KEY, JSON.stringify(history));
    renderTrackingTable(trackingData);
    persistTerminRecords(trackingData, 'tracking', { filtered: trackingData });
    showWorkflowStatus(`Rückgängig gemacht: ${snapshot.label}.`, 'info');
}

document.getElementById('undoChangesButton')?.addEventListener('click', undoLastTrackingChange);

window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.source !== 'termin-tool-whatsapp-extension') return;

    const status = document.getElementById('whatsappCopyStatus');
    if (event.data.type === 'opened') {
        status.textContent = event.data.reused
            ? 'WhatsApp Web wurde im bereits geöffneten Tab aufgerufen. Bitte Empfänger und Nachricht prüfen.'
            : 'WhatsApp Web wurde geöffnet. Bitte Empfänger und Nachricht prüfen.';
    } else if (event.data.type === 'error') {
        status.textContent = 'Die Erweiterung konnte WhatsApp nicht öffnen. Klicke noch einmal, um den normalen Browserweg zu verwenden.';
        updateWhatsAppBrowserHint();
    }
});

// Excel-Datei hochladen und einlesen
document.getElementById('trackingFile').addEventListener('change', handleFileUpload);

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file)
        return;

    event.target.value = '';

    if (typeof XLSX === 'undefined') {
        showWorkflowStatus('Die Excel-Funktion konnte nicht geladen werden. Bitte prüfe die Internetverbindung und lade die Seite erneut.', 'error');
        return;
    }

    showWorkflowStatus(`${file.name} wird geprüft …`);
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
        const data = new Uint8Array(e.target.result);
        workbook = XLSX.read(data, {
            type: 'array'
        });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        const importedRows = XLSX.utils.sheet_to_json(worksheet);
        const hasInterpreterColumn = importedRows.some(row => Object.keys(row).some(key => /^(?:uebersetzer|dolmetscher|dolmetschername|uebersetzername|interpreter|interpretername)$/.test(normalizeAppointmentColumnName(key))));
        trackingData = ensureTrackingFields(importedRows);
        if (trackingData.length === 0) {
            showWorkflowStatus('Die Excel-Datei enthält keine Termine.', 'error');
            return;
        }
        // Erste Zeile der Bemerkung = vorab eingetragener Dolmetscher (nur Namen aus der Dolmetscherliste).
        if (typeof assignInterpretersFromRemarks === 'function') {
            reportRemarkInterpreters(assignInterpretersFromRemarks(trackingData), () => {
                reportRemarkInterpreters({ ...assignInterpretersFromRemarks(trackingData), unknown: [] }, () => {});
                persistTerminRecords(trackingData, 'tracking');
                renderTrackingTable(trackingData);
            });
        }

        sessionStorage.removeItem(TRACKING_UNDO_KEY);

        renderTrackingTable(trackingData);
        persistTerminRecords(trackingData, 'tracking', { filtered: trackingData, removed: [] });
        showWorkflowStatus(`${trackingData.length} Termine geladen. ${hasInterpreterColumn ? 'Dolmetscher-Spalte gefunden.' : 'Keine Dolmetscher-Spalte in der Datei: Namen werden nicht mehr aus beliebigem Bemerkungstext geraten.'} Änderungen werden in diesem Browser-Tab zwischengespeichert.`);
        } catch (error) {
            console.error('Fehler beim Einlesen der Excel-Datei:', error);
            showWorkflowStatus('Die Excel-Datei konnte nicht verarbeitet werden. Bitte prüfe das Tabellenblatt und die Spaltenüberschriften.', 'error');
        }
    };
    reader.onerror = () => showWorkflowStatus('Die Excel-Datei konnte nicht gelesen werden. Bitte wähle sie erneut aus.', 'error');
    reader.readAsArrayBuffer(file);
}

function getTrackingStatusClass(termin) {
    const status = String(termin?.Status || 'offen').trim().toLocaleLowerCase('de-DE');
    if (status === 'beendet' || status === 'alleine') return 'tracking-status-completed';
    if (status === 'storniert') return 'tracking-status-cancelled';
    if (status === 'losgefahren') return 'tracking-status-departed';
    return 'tracking-status-open';
}

function applyTrackingStatusColor(row, termin) {
    row.classList.remove(
        'tracking-status-open',
        'tracking-status-departed',
        'tracking-status-completed',
        'tracking-status-cancelled'
    );
    row.classList.add(getTrackingStatusClass(termin));
}

function getTrackingStatusGroup(termin) {
    const status = String(termin?.Status || 'offen').trim().toLocaleLowerCase('de-DE');
    if (status === 'beendet' || status === 'alleine') return 'erledigt';
    if (status === 'storniert') return 'storniert';
    if (status === 'losgefahren') return 'unterwegs';
    return 'offen';
}

function getAppointmentLocation(termin) {
    return String(termin?.['Arzt Nr::Ort'] || termin?.Ort || termin?.Termin_Ort || termin?.Stadt || '').trim();
}

function isTrackingDayToday() {
    const date = trackingData.map(termin => termin.Termin_Datum).find(Boolean);
    if (!date || typeof normalizeFleetDate !== 'function') return false;
    return normalizeFleetDate(String(date)) === getLocalDateInputValue();
}

// Mehrere Termine desselben Patienten am selben Tag: Schlüssel und Hinweistext.
function getPatientDayKey(termin) {
    const number = String(termin?.Patient_Nr ?? '').trim();
    if (number) return `nr:${number}`;
    const name = [termin?.['Patienten Nr::Patienten_Vorname'], termin?.['Patienten Nr::Patienten_Name']]
        .map(value => String(value || '').trim().toLocaleLowerCase('de-DE')).filter(Boolean).join(' ');
    return name ? `name:${name}` : '';
}

function getPatientSiblings(termin, data = trackingData) {
    const key = getPatientDayKey(termin);
    if (!key) return [];
    return data.filter(other => other !== termin && getPatientDayKey(other) === key && getTrackingStatusGroup(other) !== 'storniert');
}

function renderPatientMore(termin, data = trackingData) {
    if (getTrackingStatusGroup(termin) === 'storniert') return '';
    const siblings = getPatientSiblings(termin, data);
    if (!siblings.length) return '';
    const parts = siblings.map(other => {
        const time = String(other.Termin_Uhrzeit || '').slice(0, 5) || 'ohne Zeit';
        const interpreter = String(other.Übersetzer || '').trim();
        return interpreter ? `${time} (${interpreter})` : time;
    });
    return `<span class="patient-tag patient-tag-count" title="Dieser Patient hat heute ${siblings.length + 1} Termine">${siblings.length + 1} Termine</span>`
        + `<span class="patient-more-times">auch ${escapeHtml(parts.join(', '))}</span>`;
}

// Aktualisiert nur die Hinweise, ohne die Tabelle neu aufzubauen (Eingabefelder behalten den Fokus).
function refreshPatientHints() {
    document.querySelectorAll('#tableBody .patient-more').forEach(element => {
        const termin = trackingData[Number(element.dataset.index)];
        if (termin) element.innerHTML = renderPatientMore(termin);
    });
}

function renderVehicleOptions(termin) {
    if (typeof readActiveFleetVehicles !== 'function') return '';
    const selectedKey = normalizeFleetPlateKey(termin.Fahrzeug);
    const openToday = new Map(getTodaysOpenFleetHandovers().map(item => [item.vehicleId, item.driver]));
    const interpreter = getAppointmentInterpreterName(termin);
    // Fahrzeuge in der Werkstatt oder gesperrte werden nicht angeboten (außer es ist bereits eingetragen).
    const vehicles = readActiveFleetVehicles().filter(vehicle => !vehicle.service || normalizeFleetPlateKey(vehicle.plate) === selectedKey);
    let hasSelected = !selectedKey;
    const options = vehicles.map(vehicle => {
        const selected = normalizeFleetPlateKey(vehicle.plate) === selectedKey;
        if (selected) hasSelected = true;
        const driver = openToday.get(vehicle.id);
        const busy = driver && !sameFleetDriver(driver, interpreter) ? ` (${driver})` : '';
        return `<option value="${escapeHtml(vehicle.plate)}" ${selected ? 'selected' : ''}>${escapeHtml(getFleetVehicleLabel(vehicle) + busy)}</option>`;
    }).join('');
    // Ein Kennzeichen aus einer importierten Datei bleibt erhalten, auch wenn es nicht im Fuhrpark steht.
    const unknown = hasSelected ? '' : `<option value="${escapeHtml(termin.Fahrzeug)}" selected>${escapeHtml(termin.Fahrzeug)}</option>`;
    return `<option value="">${vehicles.length ? 'Auto' : 'Kein Auto'}</option>${unknown}${options}`;
}

function renderTrackingTable(data) {
    const tableBody = document.getElementById('tableBody');
    const tablesSection = document.querySelector('.tables-section');
    const actionSection = document.querySelector('.action-section');

    sortTrackingDataByTime(data);
    updateAnzahlTermine(data);
    tableBody.innerHTML = '';

    if (data.length === 0) {
        tablesSection.style.display = 'none';
        actionSection.style.display = readTrackingUndoHistory().length ? 'flex' : 'none';
        document.getElementById('addRowButton').disabled = true;
        document.getElementById('saveChanges').disabled = true;
        document.getElementById('savePdfButton').disabled = true;
        updateUndoButton();
        updateTrackingOverview(data);
        return;
    }

    tablesSection.style.display = 'block';
    actionSection.style.display = 'flex';
    // Mit geladenen Terminen bleibt der Datei-Bereich eingeklappt, damit die Tabelle oben steht.
    const uploadPanel = document.getElementById('uploadPanel');
    if (uploadPanel && !uploadPanel.dataset.collapsed) { uploadPanel.open = false; uploadPanel.dataset.collapsed = 'true'; }
    document.getElementById('addRowButton').disabled = false;
    document.getElementById('saveChanges').disabled = false;
    document.getElementById('savePdfButton').disabled = false;

    const columnLabels = ['Nr.', 'Start', 'Pat.-Nr.', 'Patient', 'Bemerkung', 'Arzt', 'Ort', 'Dolmetscher / Auto', 'Status', 'Aktion'];
    const rowIcon = paths => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const ROW_ICONS = {
        chat: rowIcon('<path d="M21 11.5a8.5 8.5 0 0 1-12.6 7.4L3 20.5l1.7-5.1A8.5 8.5 0 1 1 21 11.5z"/>'),
        send: rowIcon('<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>'),
        trash: rowIcon('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="m19 6-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/>')
    };
    const cloudReady = typeof window.sendTrackingAssignment === 'function';
    const statusOptions = [['offen', 'Offen'], ['losgefahren', 'Losgefahren'], ['beendet', 'Beendet'], ['alleine', 'Alleine'], ['storniert', 'Storniert']];

    tableBody.innerHTML = data.map((termin, index) => {
        const patientName = [termin['Patienten Nr::Patienten_Vorname'], termin['Patienten Nr::Patienten_Name']]
            .map(value => String(value || '').trim()).filter(Boolean).join(' ');
        const gender = String(termin['Patienten Nr::Patienten_Geschlecht'] || '').trim().charAt(0).toLocaleUpperCase('de-DE');
        const status = String(termin.Status || 'offen').trim().toLocaleLowerCase('de-DE');
        const group = getTrackingStatusGroup(termin);
        const special = Number(termin.Sonderbetrag) > 0 ? Number(termin.Sonderbetrag) : 0;
        const quickStatus = group === 'offen'
            ? `<button type="button" class="quick-status quick-status-go" data-index="${index}" data-status="losgefahren" title="Status auf „Losgefahren“ setzen">Los</button>`
            : group === 'unterwegs'
                ? `<button type="button" class="quick-status quick-status-done" data-index="${index}" data-status="beendet" title="Status auf „Beendet“ setzen">Fertig</button>`
                : '';
        const cells = [
            `${index + 1}`,
            `<input class="time-input" type="time" data-index="${index}" value="${escapeHtml(String(termin.Termin_Uhrzeit || '').slice(0, 5))}" aria-label="Startzeit für Termin ${index + 1}">`,
            escapeHtml(termin.Patient_Nr ?? ''),
            `<span class="patient-name">${escapeHtml(patientName)}</span>${gender ? ` <span class="patient-tag" title="Geschlecht">${escapeHtml(gender)}</span>` : ''}<span class="patient-more" data-index="${index}">${renderPatientMore(termin, data)}</span>`,
            escapeHtml(termin.Bemerkung || ''),
            escapeHtml(termin['Arzt Nr::Name'] || ''),
            escapeHtml(getAppointmentLocation(termin)),
            `<div class="interpreter-line"><input class="interpreter-input" type="text" list="dolmetscherSuggestions" autocomplete="off" data-index="${index}" value="${escapeHtml(getAppointmentInterpreterName(termin))}" aria-label="Dolmetscher/in für Termin ${index + 1}" placeholder="Name eingeben"><span class="job-count" data-index="${index}" hidden></span></div>`
                + `<div class="vehicle-line"><select class="vehicle-select" data-index="${index}" aria-label="Fahrzeug für Termin ${index + 1}">${renderVehicleOptions(termin)}</select>`
                + `<button type="button" class="special-button${special ? ' has-value' : ''}" data-index="${index}" title="${special ? `Sonderkonditionen: ${special} €${termin.Sondergrund ? ` – ${escapeHtml(termin.Sondergrund)}` : ''} (ändern)` : 'Sonderkonditionen: Betrag in Euro, der für diesen Tag statt des Tagessatzes gilt'}" aria-label="Sonderkonditionen für Termin ${index + 1}${special ? `: ${special} Euro` : ''}">${special ? `${special}&nbsp;€` : 'Sonder'}</button></div>`
                + (termin['Rückmeldung'] ? `<span class="response-pill" data-response="${escapeHtml(String(termin['Rückmeldung']).split(' – ')[0])}" title="Rückmeldung aus dem Dolmetscher-Portal">${escapeHtml(termin['Rückmeldung'])}</span>` : ''),
            `<div class="status-cell"><select data-index="${index}" class="status-select" aria-label="Status für Termin ${index + 1}">${statusOptions.map(([value, label]) => `<option value="${value}" ${status === value ? 'selected' : ''}>${label}</option>`).join('')}</select>${quickStatus}</div>`
                + (termin.Losgefahren_um || termin.Beendet_um ? `<span class="status-times">${[termin.Losgefahren_um ? `los ${escapeHtml(termin.Losgefahren_um)}` : '', termin.Beendet_um ? `fertig ${escapeHtml(termin.Beendet_um)}` : ''].filter(Boolean).join(' · ')}</span>` : ''),
            `<div class="tracking-row-actions">`
                + `<button type="button" class="whatsapp-button" data-index="${index}" title="Nachricht an den Dolmetscher vorbereiten">${ROW_ICONS.chat}<span>WhatsApp</span></button>`
                + (cloudReady ? `<button type="button" class="assign-button" data-index="${index}" title="${termin['Rückmeldung'] ? 'Auftrag erneut ins Dolmetscher-Portal senden' : 'Auftrag ins Dolmetscher-Portal senden'}">${ROW_ICONS.send}<span>${termin['Rückmeldung'] ? 'Erneut' : 'Auftrag'}</span></button>` : '')
                + `<button type="button" class="delete-button" data-index="${index}" aria-label="Termin ${index + 1} löschen" title="Termin löschen (kann rückgängig gemacht werden)">${ROW_ICONS.trash}<span class="visually-hidden">Löschen</span></button>`
                + `</div>`
        ];
        return `<tr class="${getTrackingStatusClass(termin)}${special ? ' has-special' : ''}" data-index="${index}">${cells.map((cell, columnIndex) => `<td data-label="${columnLabels[columnIndex]}"><div class="cell-content">${cell}</div></td>`).join('')}</tr>`;
    }).join('');

    updateTrackingOverview(data);
    applyTrackingFilter();
    updateUndoButton();
    refreshInterpreterLoad();
    if (typeof refreshTrackingReminders === 'function') refreshTrackingReminders();
}

// ---------- Dolmetscher heute: wer ist frei, wer ist unterwegs, wie viele Aufträge hat jeder ----------
let activeInterpreterIndex = null;      // Termin, dessen Dolmetscher-Feld zuletzt angeklickt wurde
let peopleGenderFilter = '';            // '' = alle, sonst 'weiblich' oder 'männlich'
let showPeopleWithoutAccount = false;   // Namen aus der Terminliste ohne Portal-Konto mit anzeigen

function interpreterLoad(data = trackingData) {
    const load = new Map();
    data.forEach(termin => {
        const name = getAppointmentInterpreterName(termin);
        const group = getTrackingStatusGroup(termin);
        if (!name || group === 'storniert') return;
        const key = name.toLocaleLowerCase('de');
        const entry = load.get(key) || { name, total: 0, open: 0, running: 0, done: 0 };
        entry.total += 1;
        entry[group === 'offen' ? 'open' : group === 'unterwegs' ? 'running' : 'done'] += 1;
        load.set(key, entry);
    });
    return load;
}

const loadText = entry => `${entry.total} ${entry.total === 1 ? 'Auftrag' : 'Aufträge'} heute`
    + ` (${[entry.done ? `${entry.done} erledigt` : '', entry.running ? `${entry.running} unterwegs` : '', entry.open ? `${entry.open} offen` : ''].filter(Boolean).join(', ')})`;

function refreshInterpreterLoad() {
    const load = interpreterLoad();
    // Kleine Zahl neben jedem Namen: so viele Aufträge hat die Person heute schon.
    document.querySelectorAll('#tableBody .job-count').forEach(badge => {
        const termin = trackingData[Number(badge.dataset.index)];
        const entry = termin ? load.get(getAppointmentInterpreterName(termin).toLocaleLowerCase('de')) : null;
        badge.hidden = !entry;
        if (!entry) return;
        badge.textContent = String(entry.total);
        badge.title = `${entry.name}: ${loadText(entry)}`;
        badge.dataset.load = entry.total >= 4 ? 'hoch' : entry.total === 3 ? 'mittel' : 'normal';
    });

    const free = document.getElementById('peopleFree');
    const busy = document.getElementById('peopleBusy');
    if (!free || !busy) return;
    // Zu den Eingeteilten kommen Dolmetscher aus dem Portal, die heute arbeiten können (siehe cloudDaySync.js).
    const people = new Map([...load.values()].map(entry => [entry.name.toLocaleLowerCase('de'), { ...entry }]));
    (window.trackingPeopleOnline || []).forEach(person => {
        const key = String(person.name || '').toLocaleLowerCase('de');
        if (!key) return;
        const entry = people.get(key) || { name: person.name, total: 0, open: 0, running: 0, done: 0 };
        people.set(key, { ...entry, employment: person.employment, online: true });
    });
    // Dolmetscherin oder Dolmetscher? (aus dem Portal-Konto; wichtig, wenn ein Termin eine Frau oder einen Mann braucht)
    const genders = window.trackingPeopleGender instanceof Map ? window.trackingPeopleGender : new Map();
    people.forEach((entry, key) => { entry.gender = genders.get(key) || ''; });
    const knownGender = [...people.values()].some(entry => entry.gender);
    const genderBox = document.getElementById('peopleGender');
    if (genderBox) {
        genderBox.hidden = !knownGender;
        if (!knownGender) peopleGenderFilter = '';
        genderBox.querySelectorAll('[data-people-gender]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.peopleGender === peopleGenderFilter)));
    }
    // Gezeigt werden nur Personen mit freigeschaltetem Portal-Konto – sobald die Konten bekannt sind. Wer nur in der
    // Terminliste steht (ohne Konto), lässt sich weiter von Hand eintragen und über „Anzeigen“ einblenden.
    const registered = typeof readRegisteredInterpreters === 'function' ? readRegisteredInterpreters() : [];
    const accountKeys = new Set([...registered, ...(window.trackingPeopleStaff || [])].map(name => String(name).toLocaleLowerCase('de')));
    const withoutAccount = registered.length ? [...people.values()].filter(entry => !accountKeys.has(entry.name.toLocaleLowerCase('de'))) : [];
    const hiddenNote = document.getElementById('peopleHidden');
    if (hiddenNote) {
        hiddenNote.hidden = !withoutAccount.length;
        if (withoutAccount.length) {
            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'button-quiet people-hidden-toggle';
            toggle.textContent = showPeopleWithoutAccount ? 'Ausblenden' : 'Anzeigen';
            toggle.addEventListener('click', () => { showPeopleWithoutAccount = !showPeopleWithoutAccount; refreshInterpreterLoad(); });
            const count = withoutAccount.length;
            hiddenNote.replaceChildren(
                document.createTextNode(`Hier stehen die Dolmetscher mit Portal-Konto. ${count === 1 ? '1 weiterer Name' : `${count} weitere Namen`} aus der Terminliste ${count === 1 ? 'hat' : 'haben'} kein Konto${showPeopleWithoutAccount ? ` und ${count === 1 ? 'wird' : 'werden'} gerade mit angezeigt` : ''}. `),
                toggle);
        }
    }
    const hiddenKeys = new Set(showPeopleWithoutAccount ? [] : withoutAccount.map(entry => entry.name.toLocaleLowerCase('de')));
    const sorted = [...people.values()].filter(entry => !hiddenKeys.has(entry.name.toLocaleLowerCase('de')))
        .filter(entry => !peopleGenderFilter || entry.gender === peopleGenderFilter)
        .sort((left, right) => left.total - right.total || left.name.localeCompare(right.name, 'de'));
    const chip = entry => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'person-chip';
        button.dataset.name = entry.name;
        const vehicle = typeof getCurrentFleetVehicleForDriver === 'function' && isTrackingDayToday() ? getCurrentFleetVehicleForDriver(entry.name)?.plate : '';
        button.title = entry.total ? loadText(entry) : 'Heute noch kein Auftrag';
        const name = document.createElement('span');
        name.textContent = entry.name;
        const count = document.createElement('b');
        count.textContent = String(entry.total);
        count.dataset.load = entry.total >= 4 ? 'hoch' : entry.total === 3 ? 'mittel' : 'normal';
        button.append(name, count);
        if (entry.gender) {
            const sign = document.createElement('i');
            sign.className = 'person-gender';
            sign.textContent = entry.gender === 'weiblich' ? '♀' : '♂';
            sign.title = entry.gender === 'weiblich' ? 'Dolmetscherin' : 'Dolmetscher';
            sign.setAttribute('aria-label', sign.title);
            button.insertBefore(sign, count);
        }
        const meta = [entry.employment === 'fest' ? 'fest' : '', vehicle].filter(Boolean).join(' · ');
        if (meta) { const small = document.createElement('small'); small.textContent = meta; button.append(small); }
        button.addEventListener('click', () => assignFromPeoplePanel(entry.name));
        return button;
    };
    const freeList = sorted.filter(entry => !entry.running);
    const busyList = sorted.filter(entry => entry.running);
    const empty = text => { const note = document.createElement('p'); note.className = 'people-empty'; note.textContent = text; return note; };
    free.replaceChildren(...(freeList.length ? freeList.map(chip) : [empty(peopleGenderFilter ? 'In dieser Auswahl ist im Moment niemand frei.' : 'Im Moment ist niemand frei.')]));
    busy.replaceChildren(...(busyList.length ? busyList.map(chip) : [empty('Niemand ist gerade unterwegs.')]));
    // Abwesend (Urlaub, krank, Notfall): zur Auskunft – diese Namen lassen sich hier nicht eintragen.
    const awayList = (window.trackingPeopleAway || []).filter(person => !peopleGenderFilter || person.gender === peopleGenderFilter);
    const awayBox = document.getElementById('peopleAway');
    if (awayBox) {
        awayBox.hidden = !awayList.length;
        document.getElementById('peopleAwayHeading').hidden = !awayList.length;
        awayBox.replaceChildren(...awayList.map(person => {
            const node = document.createElement('span');
            node.className = 'person-chip is-away';
            const name = document.createElement('span');
            name.textContent = person.name;
            const reason = document.createElement('small');
            reason.textContent = person.reason;
            node.append(name, reason);
            return node;
        }));
    }
    document.getElementById('peopleSummary').textContent = sorted.length || awayList.length || (people.size && !withoutAccount.length)
        ? `${freeList.length} frei · ${busyList.length} unterwegs${awayList.length ? ` · ${awayList.length} abwesend` : ''}`
        : people.size ? 'noch niemand mit Portal-Konto eingeteilt' : 'noch niemand eingeteilt';
}
document.getElementById('peopleGender')?.addEventListener('click', event => {
    const button = event.target.closest('[data-people-gender]');
    if (!button) return;
    peopleGenderFilter = button.dataset.peopleGender;
    refreshInterpreterLoad();
});

function assignFromPeoplePanel(name) {
    const input = activeInterpreterIndex == null ? null : document.querySelector(`#tableBody .interpreter-input[data-index="${activeInterpreterIndex}"]`);
    if (!input) { showToast('Klicke zuerst in das Dolmetscher-Feld des Termins, dann auf den Namen.', 'info'); return; }
    input.value = name;
    updateInterpreterFromInput(input);
    showToast(`${name} für Termin ${activeInterpreterIndex + 1} eingetragen`, 'success');
}
document.getElementById('tableBody').addEventListener('focusin', event => {
    if (!event.target.classList?.contains('interpreter-input')) return;
    activeInterpreterIndex = Number(event.target.dataset.index);
    document.querySelectorAll('#tableBody tr.is-active-row').forEach(row => row.classList.remove('is-active-row'));
    event.target.closest('tr')?.classList.add('is-active-row');
});
window.refreshInterpreterLoad = refreshInterpreterLoad;

// Schnittstelle für den Online-Abgleich des Tagesstands (cloudDaySync.js).
window.getTrackingRecords = () => trackingData;
window.applyRemoteTrackingRecords = records => {
    trackingData.splice(0, trackingData.length, ...ensureTrackingFields(records));
    saveTerminRecords(trackingData, 'tracking', { filtered: trackingData });
    renderTrackingTable(trackingData);
};
window.refreshTrackingRows = () => {
    saveTerminRecords(trackingData, 'tracking');
    if (!document.activeElement?.matches?.('#tableBody input')) renderTrackingTable(trackingData);
};
document.getElementById('archiveDayButton')?.addEventListener('click', () => window.archiveTrackingDay?.());

// Nach einem Online-Abgleich (z. B. Übernahme im Dolmetscher-Portal) die Fahrzeuglisten auffrischen,
// ohne ein Feld zu stören, in dem gerade getippt wird.
document.addEventListener('fleet-synced', () => {
    applyCurrentVehicles();
    document.querySelectorAll('#tableBody .vehicle-select').forEach(select => {
        const termin = trackingData[Number(select.dataset.index)];
        if (termin && document.activeElement !== select) select.innerHTML = renderVehicleOptions(termin);
    });
    refreshInterpreterLoad();
});

// Hat ein Dolmetscher im Portal selbst ein Fahrzeug übernommen, steht es automatisch bei seinen heutigen
// offenen und laufenden Terminen – niemand muss es von Hand zuweisen.
function applyCurrentVehicles() {
    if (typeof getCurrentFleetVehicleForDriver !== 'function' || !isTrackingDayToday()) return false;
    let changed = false;
    trackingData.forEach(termin => {
        const name = getAppointmentInterpreterName(termin);
        const group = getTrackingStatusGroup(termin);
        if (!name || (group !== 'offen' && group !== 'unterwegs')) return;
        const plate = getCurrentFleetVehicleForDriver(name)?.plate;
        if (!plate || normalizeFleetPlateKey(plate) === normalizeFleetPlateKey(termin.Fahrzeug)) return;
        ensureVehicleColumn();
        termin.Fahrzeug = plate;
        changed = true;
    });
    if (changed) persistTerminRecords(trackingData, 'tracking');
    return changed;
}
window.applyCurrentVehicles = applyCurrentVehicles;

// Ein Satz Listener für die ganze Tabelle statt pro Zeile – bleibt auch bei vielen Terminen schnell.
(function bindTrackingTableEvents() {
    const tableBody = document.getElementById('tableBody');
    tableBody.addEventListener('click', event => {
        const button = event.target.closest('button');
        if (!button) return;
        const index = Number(button.dataset.index);
        if (button.classList.contains('whatsapp-button')) openWhatsAppModal(index);
        else if (button.classList.contains('delete-button')) deleteRow(index);
        else if (button.classList.contains('assign-button')) window.sendTrackingAssignment?.(index);
        else if (button.classList.contains('quick-status')) setTrackingStatus(index, button.dataset.status);
        else if (button.classList.contains('special-button')) openSpecialDialog(index);
    });
    tableBody.addEventListener('change', event => {
        const target = event.target;
        if (target.classList.contains('status-select')) setTrackingStatus(Number(target.dataset.index), target.value);
        else if (target.classList.contains('interpreter-input')) updateInterpreterFromInput(target);
        else if (target.classList.contains('vehicle-select')) updateVehicleFromSelect(target);
        else if (target.classList.contains('time-input')) updateTimeFromInput(target);
    });
    // Enter im Namensfeld springt zum nächsten sichtbaren Termin.
    tableBody.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !event.target.classList.contains('interpreter-input')) return;
        event.preventDefault();
        const inputs = [...tableBody.querySelectorAll('tr:not([hidden]) .interpreter-input')];
        const next = inputs[inputs.indexOf(event.target) + 1];
        if (next) { next.focus(); next.select(); } else event.target.blur();
    });
})();

function updateTrackingOverview(data) {
    const counts = { offen: 0, unterwegs: 0, erledigt: 0, storniert: 0 };
    data.forEach(item => { counts[getTrackingStatusGroup(item)] += 1; });
    const set = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = String(value); };
    set('overviewTotal', data.length);
    set('overviewOpen', counts.offen);
    set('overviewDeparted', counts.unterwegs);
    set('overviewDone', counts.erledigt);
    set('overviewCancelled', counts.storniert);
}

function applyTrackingFilter() {
    const term = trackingSearchTerm.trim().toLocaleLowerCase('de-DE');
    let visible = 0;
    document.querySelectorAll('#tableBody tr').forEach(row => {
        const termin = trackingData[Number(row.dataset.index)];
        if (!termin) return;
        const matchesStatus = trackingStatusFilter === 'alle' || getTrackingStatusGroup(termin) === trackingStatusFilter;
        const haystack = [
            termin.Termin_Uhrzeit, termin.Patient_Nr, termin['Patienten Nr::Patienten_Vorname'], termin['Patienten Nr::Patienten_Name'],
            termin.Bemerkung, termin['Arzt Nr::Name'], getAppointmentLocation(termin), termin.Übersetzer, termin.Fahrzeug, termin['Rückmeldung']
        ].map(value => String(value ?? '')).join(' ').toLocaleLowerCase('de-DE');
        const show = matchesStatus && (!term || haystack.includes(term));
        row.hidden = !show;
        if (show) visible += 1;
    });
    const filtered = trackingStatusFilter !== 'alle' || Boolean(term);
    const info = document.getElementById('trackingFilterInfo');
    if (info) info.textContent = filtered ? `${visible} von ${trackingData.length} Terminen` : '';
    const empty = document.getElementById('trackingEmptyFilter');
    if (empty) empty.hidden = !(filtered && visible === 0 && trackingData.length > 0);
    document.querySelectorAll('[data-status-filter]').forEach(button => {
        const active = button.dataset.statusFilter === trackingStatusFilter;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}

document.querySelectorAll('[data-status-filter]').forEach(button => {
    button.addEventListener('click', () => {
        trackingStatusFilter = button.dataset.statusFilter;
        applyTrackingFilter();
    });
});
document.getElementById('trackingSearch')?.addEventListener('input', event => {
    trackingSearchTerm = event.target.value;
    applyTrackingFilter();
});
// „/“ springt von überall ins Suchfeld.
document.addEventListener('keydown', event => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    document.getElementById('trackingSearch')?.focus();
});


function normalizeAppointmentColumnName(name) {
    return String(name || '')
        .toLocaleLowerCase('de-DE')
        .replace(/ß/g, 'ss')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
}

function getAppointmentContactEntries(termin, person, kind) {
    const keys = Object.keys(termin || {});
    const personPattern = person === 'patient' ? /patient/ : /arzt|praxis/;
    const kindPattern = kind === 'phone'
        ? /telefon|rufnummer|phone|handy|mobil|mobile|cell/
        : /adresse|anschrift|strasse|street|hausnummer|plz|postleitzahl|postal|zip|ort|stadt|city|str$/;

    return keys
        .filter(key => {
            const normalized = normalizeAppointmentColumnName(key);
            return personPattern.test(normalized) && kindPattern.test(normalized);
        })
        .map(key => ({ key, value: String(termin[key] ?? '').trim() }))
        .filter(entry => entry.value)
        .filter((entry, index, entries) => entries.findIndex(other =>
            other.value.toLocaleLowerCase('de-DE') === entry.value.toLocaleLowerCase('de-DE')
        ) === index);
}

function getAppointmentContactValues(termin, person, kind) {
    return getAppointmentContactEntries(termin, person, kind).map(entry => entry.value);
}

// Mehrere Telefonnummern in einem Feld einzeln aufführen – egal ob sie mit „/“, „;“, Komma,
// „oder“ getrennt sind oder einfach hintereinander stehen. So steht jede Nummer in einer eigenen Zeile.
// „0170/1234567“ bleibt eine Nummer (Vorwahl/Nummer), „0170 1234567 / 0228 123456“ sind zwei.
function splitPhoneNumbers(value) {
    const digits = text => (String(text).match(/\d/g) || []).length;
    const numbers = [];
    String(value || '').split(/\s*(?:[;|\n\r]+|,\s|\s+oder\s+|\s+und\s+)\s*/iu).forEach(chunk => {
        const tokens = chunk.trim().split(/\s+/).filter(Boolean);
        let current = '';
        let slashPending = false;
        const flush = () => { if (current) numbers.push(current); current = ''; };
        tokens.forEach((token, index) => {
            token.split('/').forEach((part, partIndex) => {
                if (partIndex > 0) slashPending = true;
                if (!part) return;
                let joiner = ' ';
                if (slashPending) {
                    if (digits(current) >= 7) flush(); else joiner = '/';
                    slashPending = false;
                } else if (partIndex === 0 && digits(current) >= 7
                    && (/^(?:\+|00)\d/.test(part) || (/^0\d/.test(part) && digits(current) >= 10 && digits(tokens.slice(index).join('')) >= 8))) {
                    flush();
                }
                current = current ? `${current}${joiner}${part}` : part;
            });
        });
        flush();
    });
    const seen = new Set();
    return numbers.map(number => number.replace(/[,;.\s]+$/g, '').trim()).filter(number => {
        const key = number.replace(/\D/g, '') || number.toLocaleLowerCase('de-DE');
        if (!number || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

// Adresse in Deutschland und Telefonnummern des Patienten.
// In der Terminliste steht oft alles in EINEM Feld („Anschrift Deutschland“: Adresse, darunter die Nummern, dazu
// Vermerke wie „wats“ oder „Vater“). Hier wird das getrennt: die Adresse (zum Öffnen in der Karte) und jede Nummer
// einzeln – die Hausnummer bleibt bei der Adresse. Die Anschrift in Katar wird nicht mitgeschickt: Für den Einsatz
// zählt nur die Adresse in Deutschland.
function getPatientContact(termin) {
    const contact = { address: '', extra: [], phones: [] };
    const known = new Map();
    const addPhone = phone => {
        const key = phone.number.replace(/\D/g, '').replace(/^00/, '');
        if (!key) return;
        const existing = known.get(key);
        if (existing) { existing.whatsapp = existing.whatsapp || phone.whatsapp; if (!existing.note) existing.note = phone.note; return; }
        const entry = { number: phone.number, whatsapp: Boolean(phone.whatsapp), note: phone.note || '' };
        known.set(key, entry);
        contact.phones.push(entry);
    };
    const street = [];
    let postalCode = '';
    let city = '';
    getAppointmentContactEntries(termin, 'patient', 'address').forEach(({ key, value }) => {
        const normalized = normalizeAppointmentColumnName(key);
        if (normalized.includes('qatar') || normalized.includes('katar')) return;
        const parsed = TerminContact.parsePatientContact(value);
        parsed.phones.forEach(addPhone);
        contact.extra.push(...parsed.extra);
        if (!parsed.address) return;
        if (/plz|postleitzahl|postal|zip/.test(normalized)) postalCode = postalCode || parsed.address;
        else if (/ort$|stadt$|city$/.test(normalized)) city = city || parsed.address;
        else street.push(parsed.address);
    });
    contact.address = formatWhatsAppAddress([street.join(', '), [postalCode, city].filter(Boolean).join(' ')].filter(Boolean).join(', '));
    getAppointmentContactValues(termin, 'patient', 'phone').forEach(value => TerminContact.parsePhones(value).forEach(addPhone));
    return contact;
}

function formatWhatsAppAddress(value) {
    return String(value || '')
        .replace(/\s*[\r\n]+\s*/g, ', ')
        .replace(/\s*,?\s*(?:Deutschland|Germany)\s*$/iu, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/\s*,\s*,/g, ',')
        .trim()
        .replace(/[,;\s]+$/g, '');
}

function getAppointmentPatientName(termin) {
    const firstNameKeys = [
        'Patienten Nr::Patienten_Vorname', 'Patienten_Vorname', 'Patient_Vorname',
        'Patienten Vorname', 'Patient Vorname', 'Vorname Patient', 'Patient First Name'
    ];
    const familyNameKeys = [
        'Patienten Nr::Patienten_Name', 'Patienten_Name', 'Patient_Name',
        'Patienten Nachname', 'Patient Nachname', 'Nachname Patient', 'Patient Last Name'
    ];
    const findValue = keys => {
        for (const key of keys) {
            const value = String(termin?.[key] || '').trim();
            if (value) return value;
        }
        return '';
    };

    const firstName = findValue(firstNameKeys);
    const familyName = findValue(familyNameKeys);
    if (firstName || familyName) return [firstName, familyName].filter(Boolean).join(' ');

    const normalizedKeys = Object.keys(termin || {}).map(key => ({
        key,
        normalized: normalizeAppointmentColumnName(key)
    }));
    const patientNameEntry = normalizedKeys.find(({ normalized }) =>
        /patient|pat/.test(normalized)
        && /patientenname|patientname|namepatient/.test(normalized)
        && !/vorname|nachname|status|geschlecht|nummer|nr/.test(normalized)
    );
    return patientNameEntry ? String(termin[patientNameEntry.key] || '').trim() : '';
}

function getDoctorAddress(termin) {
    const entries = getAppointmentContactEntries(termin, 'doctor', 'address');
    const findValue = pattern => entries.find(entry => pattern.test(normalizeAppointmentColumnName(entry.key)))?.value || '';
    const street = findValue(/strasse|street|hausnummer|adresse|anschrift/);
    const postalCode = findValue(/plz|postleitzahl|postal|zip/);
    const city = findValue(/ort$|stadt$|city$/);
    const locality = [postalCode, city].filter(Boolean).join(' ');
    const formattedAddress = [street, locality].filter(Boolean).join(', ');
    return formatWhatsAppAddress(formattedAddress || entries.map(entry => entry.value).join(', '));
}

function getWhatsAppDataHint(termin) {
    const missing = [];
    const remark = parseAppointmentRemark(termin.Bemerkung, termin.Übersetzer);
    const patientName = getAppointmentPatientName(termin) || remark.patientName;
    if (!patientName) missing.push('Patientenname');
    if (!getPatientRecordNumber(termin)) missing.push('Aktennummer');
    if (!termin.Termin_Datum) missing.push('Termindatum');
    if (!termin.Termin_Uhrzeit) missing.push('Uhrzeit');
    const patientContact = getPatientContact(termin);
    if (!patientContact.address) missing.push('Patientenadresse');
    if (!patientContact.phones.length) missing.push('Patiententelefonnummer');
    if (!getDoctorAddress(termin)) missing.push('Arztadresse');
    if (getAppointmentContactValues(termin, 'doctor', 'phone').length === 0) missing.push('Arzttelefonnummer');
    const interpreter = getAppointmentInterpreterName(termin);
    const guaranteeColumnKey = Object.keys(termin || {}).find(key =>
        normalizeAppointmentColumnName(key) === 'kostengarantiejanein'
    );
    const guaranteeColumnStatus = normalizeAppointmentColumnName(guaranteeColumnKey ? termin[guaranteeColumnKey] : '');
    const remarkHint = [
        remark.interpreterName && !String(termin.Übersetzer || '').trim() ? `Dolmetscher/in steht ausdrücklich in der Bemerkung: ${remark.interpreterName}.` : '',
        remark.companionNames.length ? `Weitere Namen als Begleitperson(en) erkannt: ${remark.companionNames.join(', ')}.` : '',
        remark.enteredBy ? `Eingetragen durch ${remark.enteredBy}.` : '',
        remark.doctorName || remark.doctorAddress || remark.doctorPhone ? 'Arztangaben aus der Bemerkung wurden zusätzlich ausgewertet.' : '',
        (remark.hasCostCoverage && ['nein', 'no', 'false', '0'].includes(guaranteeColumnStatus))
            || (remark.hasSelfPayer && ['ja', 'yes', 'true', '1'].includes(guaranteeColumnStatus))
            ? 'Achtung: Der Kostenmarker in der Bemerkung widerspricht der Kostengarantie-Spalte. Die Nachricht folgt dem Marker in der Bemerkung.'
            : ''
    ].filter(Boolean).join(' ');

    if (missing.length) {
        return `In der Datei fehlen eigene Spalten für: ${missing.join(', ')}. Dolmetscher/in: ${interpreter || 'nicht erkannt'}. „Patienten Nr“ wird nicht als Telefonnummer verwendet. Der Dolmetscher wird nie aus der Bemerkung geraten. ${remarkHint}`.trim();
    }
    return `Adressen und Telefonnummern kommen aus den Excel-Spalten. Dolmetscher/in: ${interpreter || 'bitte auswählen'}. Prüfe Empfänger und Text vor dem Senden. ${remarkHint}`.trim();
}

function formatWhatsAppDate(value) {
    if (value === null || value === undefined || value === '') return '';

    const numericValue = typeof value === 'number'
        ? value
        : (/^\d+(?:\.\d+)?$/.test(String(value).trim()) ? Number(value) : NaN);
    if (Number.isFinite(numericValue) && numericValue >= 1 && numericValue < 100000) {
        const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(numericValue) * 86400000);
        return `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.${date.getUTCFullYear()}`;
    }

    const text = String(value).trim();
    const germanDate = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
    if (germanDate) {
        const year = germanDate[3].length === 2 ? `20${germanDate[3]}` : germanDate[3];
        return `${germanDate[1].padStart(2, '0')}.${germanDate[2].padStart(2, '0')}.${year}`;
    }

    const isoDate = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoDate) return `${isoDate[3].padStart(2, '0')}.${isoDate[2].padStart(2, '0')}.${isoDate[1]}`;
    return text;
}

// Geburtsdatum des Patienten als TT.MM.JJJJ (Excel-Zahl, Datum oder Text). Zweistellige Jahre liegen nie in der Zukunft.
function formatBirthDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return `${String(value.getDate()).padStart(2, '0')}.${String(value.getMonth() + 1).padStart(2, '0')}.${value.getFullYear()}`;
    }
    const text = String(value ?? '').trim();
    const short = text.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2})(?!\d)/);
    if (short) {
        const year = Number(short[3]) + (Number(short[3]) > new Date().getFullYear() % 100 ? 1900 : 2000);
        return `${short[1].padStart(2, '0')}.${short[2].padStart(2, '0')}.${year}`;
    }
    const formatted = formatWhatsAppDate(value);
    return /^\d{2}\.\d{2}\.\d{4}$/.test(formatted) ? formatted : '';
}

function formatWhatsAppTime(value) {
    if (value === null || value === undefined || value === '') return '';

    const numericValue = typeof value === 'number'
        ? value
        : (/^\d*\.\d+$/.test(String(value).trim()) ? Number(value) : NaN);
    if (Number.isFinite(numericValue) && numericValue >= 0 && numericValue < 1) {
        const totalMinutes = Math.round(numericValue * 24 * 60) % (24 * 60);
        return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
    }

    const text = String(value).trim();
    const time = text.match(/^(\d{1,2})[:.](\d{2})/);
    return time ? `${time[1].padStart(2, '0')}:${time[2]}` : text;
}

function getPatientRecordNumber(termin) {
    const preferredKeys = [
        'Aktennummer', 'Patienten_Aktennummer', 'Patient_Aktennummer',
        'Patient_Nr', 'Patienten Nr', 'Pat. Nr'
    ];
    for (const key of preferredKeys) {
        const value = termin?.[key];
        if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
    }

    const matchingKey = Object.keys(termin || {}).find(key => {
        const normalized = normalizeAppointmentColumnName(key);
        return /patient|pat/.test(normalized)
            && /aktennummer|aktenzeichen|patientennr|patientnr|patnr/.test(normalized)
            && !/name|vorname|geschlecht|status/.test(normalized);
    });
    return matchingKey ? String(termin[matchingKey] ?? '').trim() : '';
}

function parseAppointmentRemark(value, assignedInterpreterName = '') {
    const lines = String(value || '').split(/\r\n|\n|\r/).map(line => line.trim()).filter(Boolean);
    const nonNameTerms = new Set([
        'abholung', 'ankunft', 'apotheke', 'arzt', 'bericht', 'bus', 'fahrt', 'fahrdienst',
        'flughafen', 'kontrolle', 'krankenhaus', 'lieferung', 'medikament', 'medikamente',
        'op', 'operation', 'optag', 'patient', 'patientin', 'praxis', 'station', 'tag',
        'termin', 'vorbereitung', 'abflug', 'ankunft', 'rueckfahrt'
    ]);

    let explicitInterpreter = '';
    let explicitEnteredBy = '';
    let explicitPatientName = '';
    let hasSelfPayer = false;
    let hasCostCoverage = false;
    let doctorName = '';
    let doctorAddress = '';
    let doctorPhone = '';
    let doctorLocation = '';
    let inDoctorBlock = false;
    const nameLines = [];
    const explicitCompanions = [];
    const noteLines = [];
    const doctorAddressParts = [];
    const doctorLocationParts = [];
    const knownNames = [
        ...(typeof knownInterpreterNames === 'function' ? knownInterpreterNames() : typeof readInterpreterDirectory === 'function' ? readInterpreterDirectory() : []),
        String(assignedInterpreterName || '').trim()
    ].filter(Boolean);
    const normalizedName = name => String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');

    for (let index = 0; index < lines.length; index += 1) {
        let line = lines[index];
        const explicitInterpreterMatch = line.match(/^(?:dolmetscher(?:\/in)?|uebersetzer(?:\/in)?|übersetzer(?:\/in)?)\s*:\s*(.+)$/iu);
        if (explicitInterpreterMatch) {
            explicitInterpreter = explicitInterpreterMatch[1].trim();
            continue;
        }
        const explicitEnteredByMatch = line.match(/^(?:eingetragen\s+durch|erfasst\s+durch)\s*:\s*(.+)$/iu);
        if (explicitEnteredByMatch) {
            const enteredByValue = explicitEnteredByMatch[1].trim();
            explicitEnteredBy = /\bBSL\b/iu.test(enteredByValue) ? 'Kollege Bartzell' : enteredByValue;
            continue;
        }
        const explicitPatientMatch = line.match(/^(?:patient(?:\/in)?|patientenname|name\s+patient)\s*[:\-]\s*(.+)$/iu);
        if (explicitPatientMatch) {
            explicitPatientName = explicitPatientMatch[1].trim();
            continue;
        }
        const explicitCompanion = line.match(/^(?:begleitperson(?:en)?|begleitung)\s*:\s*(.+)$/iu);
        if (explicitCompanion) {
            explicitCompanion[1].split(/[,;]+/).map(name => name.trim()).filter(Boolean)
                .forEach(name => explicitCompanions.push({ name, index }));
            continue;
        }

        const hasSelfPayerMarker = /\bSZ\b/iu.test(line);
        const hasCostCoverageMarker = /\bKG(?:\s+kontrolliert)?\b/iu.test(line)
            || /\bkostenübernahme\b/iu.test(line);
        hasSelfPayer ||= hasSelfPayerMarker;
        hasCostCoverage ||= hasCostCoverageMarker;
        line = line
            .replace(/\bKG\s+kontrolliert\b/giu, ' ')
            .replace(/\bSZ\b/giu, ' ')
            .replace(/\bKG\b/giu, ' ')
            .replace(/\bKostenübernahme\b/giu, ' ')
            .replace(/^[\s:;,|\-]+|[\s:;,|\-]+$/g, '')
            .trim();

        if (/\bBSL\b/iu.test(line)) {
            explicitEnteredBy ||= 'Kollege Bartzell';
            line = line.replace(/\bBSL\b/giu, ' ').replace(/^[\s:;,|\-]+|[\s:;,|\-]+$/g, '').trim();
        }
        if (!line) continue;

        const labelSeparator = line.match(/^([^:]{1,40})\s*:\s*(.+)$/u);
        const label = labelSeparator ? normalizeAppointmentColumnName(labelSeparator[1]) : '';
        const labelledValue = labelSeparator?.[2]?.trim() || '';
        const doctorNameLabel = /^(?:arzt|arztname|praxis|praxisname|klinik|klinikname|krankenhaus|krankenhausname|hospital|hospitalname)$/.test(label);
        const doctorSectionLabel = /^(?:arztdaten|arztpraxis|praxisdaten|arztpraxisdaten|klinikdaten|krankenhausdaten|hospital)$/.test(label)
            || /^(?:arzt|arztpraxis|praxis|klinik|krankenhaus|hospital)(?:\s*\/\s*(?:praxis|arzt))?$/.test(line.toLocaleLowerCase('de-DE'));
        const doctorAddressLabel = /^(?:(?:arzt|praxis|hospital|klinik|krankenhaus)?(?:adresse|anschrift|address|strasse|street|hausnummer)|(?:adresse|anschrift|address|strasse|street|hausnummer)(?:arzt|praxis|hospital|klinik|krankenhaus))$/.test(label);
        const doctorPhoneLabel = /^(?:(?:arzt|praxis|hospital|klinik|krankenhaus)?(?:telefon|telefonnummer|telephone|phone|tel|rufnummer|handy|mobil|mobile)|(?:telefon|telefonnummer|telephone|phone|tel|rufnummer|handy|mobil|mobile)(?:arzt|praxis|hospital|klinik|krankenhaus))$/.test(label);
        const doctorPostalLabel = /^(?:(?:arzt|praxis|hospital|klinik|krankenhaus)?(?:plz|postleitzahl|postalcode|postcode|zipcode|ort|stadt|city|town)|(?:plz|postleitzahl|postalcode|postcode|zipcode|ort|stadt|city|town)(?:arzt|praxis|hospital|klinik|krankenhaus))$/.test(label);

        if (doctorSectionLabel) {
            inDoctorBlock = true;
            if (labelledValue && !doctorName) doctorName = labelledValue;
            continue;
        }
        if (doctorNameLabel) {
            inDoctorBlock = true;
            doctorName ||= labelledValue;
            continue;
        }
        if (doctorAddressLabel && (inDoctorBlock || /arzt|praxis|hospital|klinik|krankenhaus/.test(label))) {
            inDoctorBlock = true;
            doctorAddressParts.push(labelledValue);
            continue;
        }
        if (doctorPhoneLabel && (inDoctorBlock || /arzt|praxis|hospital|klinik|krankenhaus/.test(label))) {
            inDoctorBlock = true;
            doctorPhone ||= labelledValue;
            continue;
        }
        if (doctorPostalLabel && (inDoctorBlock || /arzt|praxis|hospital|klinik|krankenhaus/.test(label))) {
            inDoctorBlock = true;
            if (/^(?:(?:arzt|praxis|hospital|klinik|krankenhaus)?(?:ort|stadt|city|town))$/.test(label)) {
                doctorLocationParts.push(labelledValue);
            } else {
                doctorAddressParts.push(labelledValue);
            }
            continue;
        }

        const genericDoctorAddressLabel = /^(?:adresse|anschrift|address|strasse|street|hausnummer)$/.test(label);
        const genericDoctorPhoneLabel = /^(?:telefon|telefonnummer|telephone|tel|rufnummer|handy|mobil|mobile|phone)$/.test(label);
        const genericDoctorPostalLabel = /^(?:plz|postleitzahl|postalcode|postcode|zipcode|ort|stadt|city|town)$/.test(label);
        if (inDoctorBlock && genericDoctorAddressLabel) {
            doctorAddressParts.push(labelledValue);
            continue;
        }
        if (inDoctorBlock && genericDoctorPhoneLabel) {
            doctorPhone ||= labelledValue;
            continue;
        }
        if (inDoctorBlock && genericDoctorPostalLabel) {
            if (/^(?:ort|stadt|city)$/.test(label)) doctorLocationParts.push(labelledValue);
            else doctorAddressParts.push(labelledValue);
            continue;
        }

        const explicitInterpreterValue = line.match(/^(?:dolmetscher(?:\/in)?|uebersetzer(?:\/in)?|übersetzer(?:\/in)?)\s*:\s*(.+)$/iu);
        if (explicitInterpreterValue) {
            explicitInterpreter = explicitInterpreterValue[1].trim();
            continue;
        }
        const explicitEnteredByValue = line.match(/^(?:eingetragen\s+durch|erfasst\s+durch)\s*:\s*(.+)$/iu);
        if (explicitEnteredByValue) {
            explicitEnteredBy = /\bBSL\b/iu.test(explicitEnteredByValue[1])
                ? 'Kollege Bartzell'
                : explicitEnteredByValue[1].trim();
            continue;
        }

        const directoryMatch = knownNames.find(name => normalizedName(name) === normalizedName(line));
        if (directoryMatch) {
            nameLines.push({ name: directoryMatch, index, knownInterpreter: true });
            continue;
        }

        if (inDoctorBlock && /^(?:dr|prof)\.?\s+/iu.test(line)) {
            doctorName ||= line;
            continue;
        }

        const words = line.split(/\s+/);
        const normalizedWords = words.map(normalizeAppointmentColumnName).filter(Boolean);
        const hasOperationalTerm = normalizedWords.some(word => nonNameTerms.has(word));
        const nameWordPattern = /^(?:\p{Lu}[\p{L}\p{M}'’.-]*|\p{Lo}[\p{L}\p{M}'’.-]*)$/u;
        const looksLikeName = words.length > 0
            && words.length <= 4
            && words.length >= 2
            && words.every(word => nameWordPattern.test(word))
            && !hasOperationalTerm;

        if (looksLikeName) nameLines.push({ name: line, index, knownInterpreter: false });
        else noteLines.push(line);
    }

    const uniqueDoctorAddressParts = doctorAddressParts.filter(Boolean).filter((part, index, parts) => parts.findIndex(value =>
        value.toLocaleLowerCase('de-DE') === part.toLocaleLowerCase('de-DE')
    ) === index);
    const doctorLocality = doctorLocationParts.filter(Boolean).join(' ');
    if (doctorLocality) {
        if (uniqueDoctorAddressParts.length) uniqueDoctorAddressParts[uniqueDoctorAddressParts.length - 1] += ` ${doctorLocality}`;
        else uniqueDoctorAddressParts.push(doctorLocality);
    }
    doctorAddress = doctorAddress || uniqueDoctorAddressParts.join(', ');
    doctorAddress = formatWhatsAppAddress(doctorAddress);
    doctorLocation = doctorLocationParts.join(' ');

    const lastNameLine = nameLines.at(-1);
    const lastLineIndex = lines.length - 1;
    const enteredByEntry = nameLines.length > 1 && lastNameLine?.index === lastLineIndex
        ? nameLines.pop()
        : null;
    const enteredBy = explicitEnteredBy || enteredByEntry?.name || '';
    const assignedName = String(assignedInterpreterName || '').trim();
    // Der Dolmetscher wird nie aus der Bemerkung geraten: Er kommt nur aus der Spalte
    // „Übersetzer“ oder aus einer ausdrücklichen Zeile „Dolmetscher: Name“.
    const interpreterEntry = nameLines.find(entry => assignedName && normalizedName(entry.name) === normalizedName(assignedName)) || null;
    const interpreterName = explicitInterpreter || interpreterEntry?.name || '';
    // Die erste namensähnliche Zeile ohne Zuordnung bleibt eine normale Notiz.
    const unassignedLead = !interpreterEntry && !explicitInterpreter ? nameLines[0] : null;
    const companions = [
        ...nameLines.filter(entry => entry !== interpreterEntry && entry !== unassignedLead
            && (!interpreterEntry || entry.index > interpreterEntry.index)),
        ...explicitCompanions
    ]
        .sort((left, right) => left.index - right.index);

    const recognizedIndexes = new Set([
        ...(interpreterEntry ? [interpreterEntry.index] : []),
        ...companions.map(entry => entry.index),
        ...(enteredByEntry ? [enteredByEntry.index] : [])
    ]);
    const retainedNotes = [
        ...noteLines,
        ...nameLines.filter(entry => !recognizedIndexes.has(entry.index)).map(entry => entry.name)
    ];

    return {
        interpreterName,
        companionNames: companions.map(entry => entry.name),
        companionName: companions[0]?.name || '',
        patientName: explicitPatientName,
        enteredBy,
        noteLines: retainedNotes,
        hasSelfPayer,
        hasCostCoverage,
        doctorName,
        doctorAddress,
        doctorPhone,
        doctorLocation
    };
}

function getAppointmentInterpreterName(termin) {
    return String(termin?.Übersetzer || '').trim() || parseAppointmentRemark(termin?.Bemerkung, termin?.Übersetzer).interpreterName;
}

function createWhatsAppAppointmentMessage(termin, includeNote) {
    const interpreter = getAppointmentInterpreterName(termin).replace(/[\r\n]+/g, ' ');
    const remark = parseAppointmentRemark(termin.Bemerkung, termin.Übersetzer);
    // Felder der Liste können einen Zeilenumbruch enthalten (z. B. der Name einer Praxis über zwei Zeilen) –
    // im Auftrag steht jedes Feld in einer Zeile.
    const oneLine = TerminContact.singleLine;
    const patientName = oneLine(getAppointmentPatientName(termin) || remark.patientName);
    const patientRecordNumber = getPatientRecordNumber(termin);
    const patientBirthDate = formatBirthDate(termin['Patienten Nr::Patienten_Geburtsdatum'] ?? termin.Patienten_Geburtsdatum ?? termin.Geburtsdatum);
    const isCompanionAppointment = remark.companionNames.length > 0;
    const doctorName = oneLine(remark.doctorName || termin['Arzt Nr::Name'] || '');
    const appointmentLocation = formatWhatsAppAddress(remark.doctorLocation || termin['Arzt Nr::Ort'] || termin.Ort || termin.Termin_Ort || termin.Stadt || '');
    // Adresse in Deutschland, dann jede Telefonnummer des Patienten in einer eigenen Zeile –
    // mit dem Vermerk „(WhatsApp)“ oder einem Zusatz wie „(Vater)“, wenn er in der Liste steht.
    const patientContact = getPatientContact(termin);
    const patientPhoneLabel = isCompanionAppointment ? 'Telefon Hauptpatient' : 'Telefon';
    const patientContactFields = [
        [isCompanionAppointment ? 'Patientenadresse (Hauptpatient)' : 'Patientenadresse', patientContact.address],
        ...patientContact.extra.map(text => ['Hinweis', text]),
        ...patientContact.phones.map((phone, index) => [
            patientContact.phones.length > 1 ? `${patientPhoneLabel} ${index + 1}` : patientPhoneLabel,
            TerminContact.formatPhone(phone)
        ])
    ];
    // Jede Telefonnummer bekommt eine eigene Zeile („Telefon 1“, „Telefon 2“ …).
    const phoneFields = (label, values) => {
        const numbers = [...new Set(values.flatMap(splitPhoneNumbers))];
        return numbers.map((number, index) => [numbers.length > 1 ? `${label} ${index + 1}` : label, number]);
    };
    const doctorAddress = formatWhatsAppAddress(remark.doctorAddress || getDoctorAddress(termin));
    const doctorPhones = remark.doctorPhone ? [remark.doctorPhone] : getAppointmentContactValues(termin, 'doctor', 'phone');
    const appointmentDate = formatWhatsAppDate(termin.Termin_Datum);
    const appointmentTime = formatWhatsAppTime(termin.Termin_Uhrzeit);
    // In the supplied FileMaker export the separate yes/no column conflicts
    // with SZ/KG written in Bemerkung. Follow the user's explicit note markers.
    const hasSelfPayer = remark.hasSelfPayer;
    const hasCostCoverage = remark.hasCostCoverage;
    const costStatus = hasSelfPayer && hasCostCoverage
        ? 'Bitte Kostenstatus vor dem Termin prüfen: In der Bemerkung stehen sowohl SZ als auch KG.'
        : hasSelfPayer
            ? 'Kostenstatus: Selbstzahler (keine Kostengarantie).'
            : hasCostCoverage
                ? 'Kostenübernahme: Bitte die Kostenübernahme/Kostengarantie zum Termin mitbringen.'
                : '';
    const keyFacts = [
        patientName ? `*${isCompanionAppointment ? 'Hauptpatient/in' : 'Patient/in'}: ${patientName}*` : '',
        patientBirthDate ? `*Geburtsdatum: ${patientBirthDate}*` : '',
        patientRecordNumber ? `*Aktennummer: ${patientRecordNumber}*` : '',
        appointmentDate || appointmentTime ? `*Termin: ${[appointmentDate, appointmentTime].filter(Boolean).join(' · ')}*` : '',
        appointmentLocation ? `*Ort: ${appointmentLocation}*` : '',
        interpreter ? `*Dolmetscher/in: ${interpreter}*` : '',
        ...(isCompanionAppointment ? [`*Termin für Begleitperson: ${remark.companionNames.join(', ')}*`] : []),
        ...(costStatus ? [`*${costStatus}*`] : [])
    ].filter(Boolean).map(oneLine);
    const sections = [
        {
            title: 'PATIENTENKONTAKT',
            fields: patientContactFields
        },
        {
            title: 'ARZT / PRAXIS',
            fields: [
                ['Name', doctorName],
                ['Adresse', doctorAddress],
                ...phoneFields('Telefon', doctorPhones)
            ]
        },
        ...(includeNote && remark.noteLines.length
            ? [{ title: 'WEITERE HINWEISE', fields: remark.noteLines.map(line => ['', line]) }]
            : []),
        ...(includeNote && remark.enteredBy
            ? [{ title: 'EINGETRAGEN DURCH', fields: [[ '', remark.enteredBy === 'Kollege Bartzell' ? 'Kollege Bartzell' : remark.enteredBy]] }]
            : [])
    ].map(section => ({
        ...section,
        fields: section.fields.filter(([, value]) => value)
    })).filter(section => section.fields.length > 0);

    const details = sections.flatMap(section => [
        `*${section.title}*`,
        ...section.fields.map(([label, value]) => label ? `${label}: ${oneLine(value)}` : oneLine(value)),
        ''
    ]);

    return [
        '*DOLMETSCHAUFTRAG*',
        ...keyFacts,
        ...(isCompanionAppointment
            ? ['', patientName
                ? 'Hinweis: Der Termin ist für die oben genannte Begleitperson. Die Aktennummer gehört zum Hauptpatienten.'
                : 'Hinweis: Der Termin ist für die in der Bemerkung genannte Begleitperson.'
            ]
            : []),
        '',
        'Guten Tag,',
        '',
        'bitte übernimm den folgenden Dolmetschauftrag:',
        '',
        ...details,
        'Bitte bestätige kurz den Erhalt des Auftrags. Vielen Dank.'
    ].join('\n').trim();
}

function updateWhatsAppMessagePreview() {
    const index = activeWhatsAppAppointmentIndex;
    const termin = Number.isInteger(index) ? trackingData[index] : null;
    if (!termin) return;

    document.getElementById('whatsappMessage').value = createWhatsAppAppointmentMessage(
        termin,
        document.getElementById('includeWhatsAppNote').checked
    );
    document.getElementById('whatsappDataHint').textContent = getWhatsAppDataHint(termin);
    document.getElementById('whatsappCopyStatus').textContent = '';
}

function openWhatsAppModal(index) {
    const termin = trackingData[index];
    if (!termin) return;

    const interpreter = getAppointmentInterpreterName(termin);
    if (!interpreter) {
        showToast('Bitte trage zuerst den Dolmetscher oder die Dolmetscherin in dieser Zeile ein.', 'error');
        document.querySelector(`#tableBody .interpreter-input[data-index="${index}"]`)?.focus();
        return;
    }

    activeWhatsAppAppointmentIndex = index;
    document.getElementById('whatsappRecipient').textContent = `Empfänger laut Terminplan: ${interpreter}. Wähle in WhatsApp Web denselben Namen aus.`;
    document.getElementById('includeWhatsAppNote').checked = true;
    updateWhatsAppBrowserHint();
    updateWhatsAppMessagePreview();

    const modal = document.getElementById('whatsappModal');
    modal.style.display = 'block';
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('whatsappMessage').focus();
}

function updateWhatsAppBrowserHint() {
    const hint = document.getElementById('whatsappBrowserHint');
    const button = document.getElementById('openWhatsAppButton');
    const extensionAvailable = document.documentElement.dataset.terminToolExtensionReady === 'true';
    hint.textContent = extensionAvailable
        ? 'Die Chrome-Erweiterung verwendet deinen bereits geöffneten WhatsApp-Web-Tab. Ohne Erweiterung kann ein neuer Tab aufgehen.'
        : 'Ohne die optionale Chrome-Erweiterung kann WhatsApp Web bei jedem Klick einen neuen Tab öffnen. Du kannst die Nachricht stattdessen kopieren und im bereits offenen WhatsApp-Tab einfügen.';
    button.textContent = extensionAvailable ? 'Im WhatsApp-Web-Tab öffnen' : 'WhatsApp Web öffnen';
}

function closeWhatsAppModal() {
    const modal = document.getElementById('whatsappModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    activeWhatsAppAppointmentIndex = null;
}

document.getElementById('includeWhatsAppNote').addEventListener('change', updateWhatsAppMessagePreview);
document.getElementById('closeWhatsAppModal').addEventListener('click', closeWhatsAppModal);
document.getElementById('cancelWhatsAppButton').addEventListener('click', closeWhatsAppModal);
document.getElementById('copyWhatsAppMessageButton').addEventListener('click', async () => {
    const textarea = document.getElementById('whatsappMessage');
    const status = document.getElementById('whatsappCopyStatus');
    try {
        await navigator.clipboard.writeText(textarea.value);
        status.textContent = 'Nachricht kopiert. Füge sie in WhatsApp mit Strg+V ein.';
    } catch (error) {
        textarea.focus();
        textarea.select();
        const copied = document.execCommand('copy');
        status.textContent = copied
            ? 'Nachricht kopiert. Füge sie in WhatsApp mit Strg+V ein.'
            : 'Kopieren nicht möglich. Markiere den Text und drücke Strg+C.';
    }
});
document.getElementById('whatsappModal').addEventListener('click', event => {
    if (event.target.id === 'whatsappModal') closeWhatsAppModal();
});
document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (document.getElementById('whatsappModal').style.display === 'block') closeWhatsAppModal();
    else if (document.getElementById('addRowModal').style.display === 'block') toggleAddRowModal();
});
document.getElementById('openWhatsAppButton').addEventListener('click', () => {
    const message = document.getElementById('whatsappMessage').value.trim();
    if (!message) {
        showToast('Bitte gib einen Nachrichtentext ein.', 'error');
        document.getElementById('whatsappMessage').focus();
        return;
    }

    // Ohne Chrome-Erweiterung bleibt dies der Browser-Fallback. encodeURIComponent
    // kodiert den Nachrichtentext als UTF-8 für WhatsApps Click-to-Chat.
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
    const whatsappWindow = window.open(whatsappUrl, 'terminToolWhatsApp');
    if (whatsappWindow) whatsappWindow.focus();
    closeWhatsAppModal();
});


function updateTimeFromInput(input) {
    const index = Number(input.dataset.index);
    const termin = trackingData[index];
    if (!termin) return;
    const newValue = input.value ? `${input.value}:00` : '';
    if (normalizeTerminUhrzeit(termin.Termin_Uhrzeit) === newValue) return;
    recordTrackingUndo('Startzeit geändert');
    termin.Termin_Uhrzeit = newValue;
    renderTrackingTable(trackingData);
    persistTerminRecords(trackingData, 'tracking');
    // Der Termin kann durch die neue Zeit an eine andere Stelle gerutscht sein.
    const newIndex = trackingData.indexOf(termin);
    document.querySelector(`#tableBody .time-input[data-index="${newIndex}"]`)?.focus();
}

// Löschen ohne Rückfrage: Die Einblendung bietet „Rückgängig“ an.
function deleteRow(index) {
    const termin = trackingData[index];
    if (!termin) return;
    recordTrackingUndo('Termin gelöscht');
    trackingData.splice(index, 1);
    updateAnzahlTermine(trackingData);
    renderTrackingTable(trackingData);
    persistTerminRecords(trackingData, 'tracking');
    const name = getAppointmentPatientName(termin) || `Termin ${index + 1}`;
    showToast(`Gelöscht: ${name}`, 'info', { actionLabel: 'Rückgängig', onAction: undoLastTrackingChange, duration: 8000 });
}

function formatTime(date) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function findVehiclePlateForInterpreter(name, exceptTermin) {
    if (!name) return '';
    const other = trackingData.find(termin => termin !== exceptTermin && termin.Fahrzeug
        && getAppointmentInterpreterName(termin).toLocaleLowerCase('de') === name.toLocaleLowerCase('de'));
    if (other) return other.Fahrzeug;
    if (typeof getCurrentFleetVehicleForDriver !== 'function') return '';
    const current = getCurrentFleetVehicleForDriver(name)?.plate;
    if (current) return current;
    // Fest angestellte Dolmetscher: ihr festes Fahrzeug aus der Online-Datenbank.
    return readActiveFleetVehicles().find(vehicle => sameFleetDriver(vehicle.assignedName, name))?.plate || '';
}

function ensureVehicleColumn() {
    // Die Spalte soll auch im Excel-Export in jeder Zeile vorhanden sein.
    trackingData.forEach(item => { if (!Object.prototype.hasOwnProperty.call(item, 'Fahrzeug')) item.Fahrzeug = ''; });
}

function updateInterpreterFromInput(input) {
    const index = Number(input.dataset.index);
    const termin = trackingData[index];
    const value = String(input.value || '').trim().replace(/\s+/g, ' ');
    if (!termin || termin.Übersetzer === value) return;
    recordTrackingUndo('Dolmetscher-Zuweisung geändert');
    termin.Übersetzer = value;
    if (value && typeof addInterpreterName === 'function') addInterpreterName(value);
    input.value = value;

    // Hat die Person heute schon ein Fahrzeug, wird es direkt vorgeschlagen.
    const vehicleSelect = input.closest('td').querySelector('.vehicle-select');
    if (value && !termin.Fahrzeug) {
        const plate = findVehiclePlateForInterpreter(value, termin);
        if (plate) {
            ensureVehicleColumn();
            termin.Fahrzeug = plate;
        }
    }
    if (vehicleSelect) vehicleSelect.innerHTML = renderVehicleOptions(termin);

    persistTerminRecords(trackingData, 'tracking');
    refreshPatientHints();
    applyTrackingFilter();
    refreshInterpreterLoad();
    if (typeof refreshTrackingReminders === 'function') refreshTrackingReminders();
    // Die Person hat an diesem Tag Urlaub, ist krank gemeldet oder hat einen Notfall: deutlich darauf hinweisen.
    const away = value ? (window.trackingPeopleAway || []).find(person => String(person.name).toLocaleLowerCase('de') === value.toLocaleLowerCase('de')) : null;
    if (away) showToast(`Achtung: ${away.name} ist an diesem Tag abwesend – ${away.reason}. Der Name wurde trotzdem eingetragen.`, 'error', { duration: 12000, target: input });
    offerInterpreterForSiblings(termin, value);
}

// Hat derselbe Patient heute weitere Termine ohne Dolmetscher, lässt sich der Name mit einem Klick übernehmen.
function offerInterpreterForSiblings(termin, interpreter) {
    if (!interpreter || typeof showToast !== 'function') return;
    const open = getPatientSiblings(termin).filter(other => !String(other.Übersetzer || '').trim());
    if (!open.length) return;
    const times = open.map(other => String(other.Termin_Uhrzeit || '').slice(0, 5) || 'ohne Zeit').join(', ');
    showToast(`${getAppointmentPatientName(termin) || 'Der Patient'} hat heute noch ${open.length === 1 ? 'einen Termin' : `${open.length} Termine`} ohne Dolmetscher (${times}).`, 'info', {
        duration: 12000,
        actionLabel: `Auch ${interpreter} eintragen`,
        onAction: () => {
            recordTrackingUndo('Dolmetscher für weitere Termine übernommen');
            open.forEach(other => { other.Übersetzer = interpreter; });
            persistTerminRecords(trackingData, 'tracking');
            renderTrackingTable(trackingData);
        }
    });
}

// Sondertag: Betrag, der für diesen Tag statt des normalen Tagessatzes gezahlt wird.
// Er erscheint in der Monatsabrechnung automatisch als Sondertag der eingetragenen Person.
// Sonderkonditionen sind selten: Ein Knopf je Termin öffnet ein kleines Fenster mit Betrag (in Euro, frei eingeben) und Grund.
const SPECIAL_QUICK_AMOUNTS = window.TERMIN_CLOUD_CONFIG?.specialAmounts || [100, 150, 200];
let specialDialogIndex = null;

function openSpecialDialog(index) {
    const termin = trackingData[index];
    const dialog = document.getElementById('specialDialog');
    if (!termin || !dialog) return;
    specialDialogIndex = index;
    const amount = Number(termin.Sonderbetrag) > 0 ? Number(termin.Sonderbetrag) : 0;
    document.getElementById('specialDialogInfo').textContent = [
        getAppointmentInterpreterName(termin) || 'noch kein Dolmetscher eingetragen',
        String(termin.Termin_Uhrzeit || '').slice(0, 5) ? `${String(termin.Termin_Uhrzeit).slice(0, 5)} Uhr` : '',
        termin['Arzt Nr::Name'] || ''
    ].filter(Boolean).join(' · ');
    document.getElementById('specialDialogAmount').value = amount || '';
    document.getElementById('specialDialogReason').value = termin.Sondergrund || '';
    document.getElementById('specialDialogRemove').hidden = !amount;
    document.getElementById('specialDialogQuick').replaceChildren(...SPECIAL_QUICK_AMOUNTS.map(value => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'special-quick-button';
        button.textContent = `${value} €`;
        button.addEventListener('click', () => { document.getElementById('specialDialogAmount').value = value; document.getElementById('specialDialogAmount').focus(); });
        return button;
    }));
    dialog.showModal();
    document.getElementById('specialDialogAmount').focus();
    document.getElementById('specialDialogAmount').select();
}

function setSpecial(index, amount, reason) {
    const termin = trackingData[index];
    if (!termin) return;
    const cleanReason = amount ? String(reason || '').trim() : '';
    if ((Number(termin.Sonderbetrag) || 0) === amount && String(termin.Sondergrund || '') === cleanReason) return;
    recordTrackingUndo('Sonderkonditionen geändert');
    trackingData.forEach(item => {
        if (!Object.prototype.hasOwnProperty.call(item, 'Sonderbetrag')) item.Sonderbetrag = '';
        if (!Object.prototype.hasOwnProperty.call(item, 'Sondergrund')) item.Sondergrund = '';
    });
    termin.Sonderbetrag = amount || '';
    termin.Sondergrund = cleanReason;
    persistTerminRecords(trackingData, 'tracking');
    renderTrackingTable(trackingData);
    if (!amount) showToast('Sonderkonditionen entfernt', 'success');
    else if (!getAppointmentInterpreterName(termin)) showToast(`Sonderbetrag ${amount} € gespeichert. Trage noch den Dolmetscher ein, damit der Tag in der Abrechnung landet.`, 'info');
    else showToast(`Sonderbetrag ${amount} € gespeichert`, 'success');
}

(function bindSpecialDialog() {
    const dialog = document.getElementById('specialDialog');
    if (!dialog) return;
    const amountInput = document.getElementById('specialDialogAmount');
    // Nur Ziffern: kein Zahlenfeld mit Pfeilen, sondern freie Eingabe.
    amountInput.addEventListener('input', () => { amountInput.value = amountInput.value.replace(/\D/g, '').slice(0, 5); });
    document.getElementById('specialDialogCancel').addEventListener('click', () => dialog.close());
    document.getElementById('specialDialogRemove').addEventListener('click', () => { dialog.close(); setSpecial(specialDialogIndex, 0, ''); });
    document.getElementById('specialDialogForm').addEventListener('submit', event => {
        event.preventDefault();
        const amount = Math.round(Number(amountInput.value) || 0);
        if (!(amount > 0)) { window.jumpToProblem?.('#specialDialogAmount'); showToast('Bitte trag den Betrag in Euro ein.', 'error', { target: '#specialDialogAmount' }); return; }
        dialog.close();
        setSpecial(specialDialogIndex, amount, document.getElementById('specialDialogReason').value);
    });
})();

function updateVehicleFromSelect(select) {
    const index = Number(select.dataset.index);
    const termin = trackingData[index];
    const plate = select.value;
    if (!termin || String(termin.Fahrzeug || '') === plate) return;
    recordTrackingUndo('Fahrzeug-Zuweisung geändert');
    ensureVehicleColumn();
    termin.Fahrzeug = plate;

    const interpreter = getAppointmentInterpreterName(termin);
    const vehicle = plate && typeof findFleetVehicleByPlate === 'function' ? findFleetVehicleByPlate(plate) : null;
    if (vehicle && interpreter && isTrackingDayToday()) {
        const result = assignFleetVehicleToDriver(vehicle.id, interpreter);
        if (result.changed) {
            showToast(result.previousDriver
                ? `${vehicle.plate}: von ${result.previousDriver} an ${interpreter} übergeben`
                : `${vehicle.plate} → ${interpreter} (im Fahrzeugprotokoll eingetragen)`, 'success');
        }
    }
    // Dieselbe Person fährt bei ihren weiteren offenen Terminen mit demselben Fahrzeug.
    if (plate && interpreter) {
        trackingData.forEach(item => {
            if (item !== termin && !item.Fahrzeug && getTrackingStatusGroup(item) === 'offen'
                && getAppointmentInterpreterName(item).toLocaleLowerCase('de') === interpreter.toLocaleLowerCase('de')) {
                item.Fahrzeug = plate;
            }
        });
    }
    persistTerminRecords(trackingData, 'tracking');
    renderTrackingTable(trackingData);
    document.querySelector(`#tableBody .vehicle-select[data-index="${index}"]`)?.focus();
}

// Merkt sich, wann losgefahren und wann beendet wurde (steht klein unter dem Status und im Tagesarchiv).
function stampStatusTime(termin, status, time = formatTime(new Date()).slice(0, 5)) {
    trackingData.forEach(item => {
        if (!Object.prototype.hasOwnProperty.call(item, 'Losgefahren_um')) item.Losgefahren_um = '';
        if (!Object.prototype.hasOwnProperty.call(item, 'Beendet_um')) item.Beendet_um = '';
    });
    if (status === 'losgefahren') { termin.Losgefahren_um = termin.Losgefahren_um || time; termin.Beendet_um = ''; }
    else if (status === 'beendet' || status === 'alleine') termin.Beendet_um = time;
    else if (status === 'offen') { termin.Losgefahren_um = ''; termin.Beendet_um = ''; }
}
window.stampTrackingStatusTime = stampStatusTime;

function setTrackingStatus(index, status) {
    const termin = trackingData[index];
    if (!termin || termin.Status === status) return;
    recordTrackingUndo('Terminstatus geändert');
    termin.Status = status;
    stampStatusTime(termin, status);
    persistTerminRecords(trackingData, 'tracking');
    renderTrackingTable(trackingData);
    const row = document.querySelector(`#tableBody tr[data-index="${index}"]`);
    if (row && !row.hidden) row.querySelector('.quick-status, .status-select')?.focus();
}

// Workbook mit aktualisierten Daten aktualisieren
function updateWorkbook() {
    const newWorkbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(stripInternalFields(trackingData));
    XLSX.utils.book_append_sheet(newWorkbook, worksheet, 'Tracking');
    workbook = newWorkbook;
}

// Funktion zum Speichern und Herunterladen der aktualisierten Excel-Datei
function saveAndDownloadExcel() {
    updateWorkbook();
    persistTerminRecords(trackingData, 'tracking');

    const excelData = XLSX.write(workbook, {
        bookType: 'xlsx',
        type: 'array'
    });
    const blob = new Blob([excelData], {
        type: 'application/octet-stream'
    });

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);

    // Find the first non-empty 'Termin_Datum'
    let firstTerminDatum = 'unbekannt';
    for (let i = 0; i < trackingData.length; i++) {
        if (trackingData[i]['Termin_Datum']) {
            firstTerminDatum = trackingData[i]['Termin_Datum'];
            break;
        }
    }

    // Ensure firstTerminDatum is treated as a string
    firstTerminDatum = firstTerminDatum ? firstTerminDatum : 'unbekannt';

    link.download = `${firstTerminDatum}_Tracking.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

// Event-Listener für den "Änderungen speichern" Button
document.getElementById('saveChanges').addEventListener('click', saveAndDownloadExcel);

document.getElementById('savePdfButton').addEventListener('click', () => {
    // Access jsPDF from the global scope
    const {
        jsPDF
    } = window.jspdf;
    const doc = new jsPDF('landscape');

    // Set up the table headers
    const headers = [["Datum", "Start", "Pat. Nr", "Patient", "Geschlecht", "Bemerkung", "Arzt", "Ort", "Übersetzer", "Fahrzeug", "Sonder €", "Anzahl Termine", "Status"]];
    const rows = trackingData.map(termin => {
        let endTimeFormatted = ''; // Initialize as empty

        if (termin.Termin_Uhrzeit) {
            const startTime = new Date(`1970-01-01T${termin.Termin_Uhrzeit}`);
            const durationMinutes = termin.Dauer * 60; // Assuming Dauer is in hours
            const endTime = new Date(startTime.getTime() + durationMinutes * 60000); // Calculate end time
            endTimeFormatted = formatTimePdf(`${endTime.getHours()}:${endTime.getMinutes()}:${endTime.getSeconds()}`); // Format end time
        }

        // Clean up the Bemerkung field by removing extra line breaks
        const bemerkung = termin['Bemerkung']
             ? String(termin['Bemerkung']).replace(/(\r\n|\n|\r)+/g, ' ').trim()
             : ''; // Replace line breaks with a space

        return [
            termin.Termin_Datum || '',
            String(termin.Termin_Uhrzeit || '').slice(0, 5),
            termin.Patient_Nr ?? '',
            getAppointmentPatientName(termin),
            String(termin['Patienten Nr::Patienten_Geschlecht'] || '').charAt(0),
            bemerkung,
            termin['Arzt Nr::Name'] || '',
            getAppointmentLocation(termin),
            getAppointmentInterpreterName(termin),
            termin.Fahrzeug || '',
            termin.Sonderbetrag || '',
            termin.Anzahl_Termine ?? '',
            termin.Status || 'offen'
        ];
    });

    // Generate the PDF table
    doc.autoTable({
        head: headers,
        body: rows,
        styles: { fontSize: 8, cellPadding: 1.5, overflow: 'linebreak' },
        headStyles: { fillColor: [23, 107, 159] },
        margin: { top: 10, right: 8, bottom: 10, left: 8 }
    });

    // Find the first non-empty 'Termin_Datum'
    let firstTerminDatum = 'unbekannt';
    for (let i = 0; i < trackingData.length; i++) {
        if (trackingData[i]['Termin_Datum']) {
            firstTerminDatum = trackingData[i]['Termin_Datum'];
            break;
        }
    }

    // Ensure firstTerminDatum is treated as a string
    firstTerminDatum = firstTerminDatum ? firstTerminDatum : 'unbekannt';

    // Save the PDF
    doc.save(`${firstTerminDatum}_Tracking.pdf`);

});

function formatTimePdf(timeString) {
    // Check if timeString is a valid string
    if (typeof timeString !== 'string') {
        console.error('Invalid input to formatTime:', timeString);
        return '00:00:00'; // Default to zero if format is invalid
    }

    // Trim whitespace
    timeString = timeString.trim();

    // Extract just the time part (hh:mm:ss)
    const timeOnly = timeString.split(' ')[0]; // Get the first part before the timezone info

    // Check if the timeOnly is in the correct format
    const timeParts = timeOnly.split(':');

    if (timeParts.length !== 3) { // Should have hours, minutes, and seconds
        console.error('Invalid time format:', timeOnly);
        return '00:00:00'; // Default to zero if format is invalid
    }

    // Ensure each part is two digits
    const [hours, minutes, seconds] = timeParts.map(part => String(part).padStart(2, '0'));

    return `${hours}:${minutes}:${seconds}`; // Return formatted time string
}


// Funktion zum Öffnen/Schließen des Modals
function toggleAddRowModal() {
    const modal = document.getElementById('addRowModal');
    const open = modal.style.display !== 'block';
    modal.style.display = open ? 'block' : 'none';
    modal.setAttribute('aria-hidden', String(!open));
    if (open) document.getElementById('terminUhrzeit').focus();
}

document.getElementById('addRowModal').addEventListener('click', event => {
    if (event.target.id === 'addRowModal') toggleAddRowModal();
});

  // Event-Listener für den Hinzufügen-Button
  document.getElementById('addRowButton').addEventListener('click', () => {
    toggleAddRowModal();
  });

// Event-Listener für den "Hinzufügen"-Button
document.getElementById('addRowForm').addEventListener('submit', event => {
    event.preventDefault();
    if (trackingData.length === 0) {
        showToast('Bitte lade zuerst eine Terminliste oder komm über die vorherigen Schritte hierher.', 'error');
        return;
    }

    const requiredFields = {
        'terminUhrzeit': 'Startzeit',
        'patientNr': 'Patienten-Nr.',
        'patientGeschlecht': 'Geschlecht',
        'patientName': 'Nachname',
        'patientVorname': 'Vorname'
    };

    for (const [field, label] of Object.entries(requiredFields)) {
        if (!document.getElementById(field).value) {
            showToast(`Bitte fülle das Pflichtfeld „${label}“ aus.`, 'error');
            document.getElementById(field).focus();
            return;
        }
    }

    // Datum des aktuellen Tagesplans übernehmen.
    let firstTerminDatum = 'unbekannt';
    for (let i = 0; i < trackingData.length; i++) {
        if (trackingData[i]['Termin_Datum']) {
            firstTerminDatum = trackingData[i]['Termin_Datum'];
            break;
        }
    }

    // Ensure firstTerminDatum is treated as a string
    firstTerminDatum = firstTerminDatum ? firstTerminDatum : 'unbekannt';
    const patientRecordNumber = String(document.getElementById('patientNr').value || '').trim();

    // Die bestehende Excel-Spaltenstruktur erhalten, ohne Daten eines anderen
    // Patienten in die neue Zeile zu kopieren.
    const newRow = Object.fromEntries(Object.keys(trackingData[0]).filter(header => !header.startsWith('_')).map(header => [header, '']));
    Object.assign(newRow, {
        "Termin_Datum": firstTerminDatum,
        "Termin_Uhrzeit": formatTimeToHHMMSS(document.getElementById('terminUhrzeit').value),
        "Patient_Nr": patientRecordNumber,
        "Patienten Nr::Patienten_Name": document.getElementById('patientName').value,
        "Arzt_Nr": '',
        "Arzt Nr::Name": document.getElementById('arztName').value,
        "Bemerkung": document.getElementById('bemerkung').value,
        "Kostengarantie Ja Nein": '',
        "Patienten Nr::Patienten_Geschlecht": document.getElementById('patientGeschlecht').value,
        "Patienten Nr::Patienten_Status": '',
        "Patienten Nr::Patienten_Vorname": document.getElementById('patientVorname').value,
        "Arzt Nr::Ort": document.getElementById('arztVorname').value,
        "Übersetzer": document.getElementById('uebersetzer').value.trim().replace(/\s+/g, ' '),
		"Status": 'offen'
    });
    if (Object.prototype.hasOwnProperty.call(newRow, 'Patienten Nr::Patienten_Nr')) {
        newRow['Patienten Nr::Patienten_Nr'] = patientRecordNumber;
    }
    if (Object.prototype.hasOwnProperty.call(trackingData[0], 'Dauer')) newRow.Dauer = '2';

    // Füge die neue Zeile zu trackingData hinzu
    recordTrackingUndo('Termin hinzugefügt');
    trackingData.push(newRow);

    // Zähle die Anzahl der Termine und aktualisiere die Anzahl_Termine-Spalte
    updateAnzahlTermine(trackingData);


    // Sortiere die trackingData nach Uhrzeit
    trackingData = sortTrackingDataByTime(trackingData);

    // Tabelle neu rendern
    renderTrackingTable(trackingData);

    persistTerminRecords(trackingData, 'tracking');
	
	// Leere die Eingabefelder im Modal
    document.getElementById('addRowForm').reset();

    // Schließe das Modal nach dem Hinzufügen
    toggleAddRowModal();
    showToast('Termin hinzugefügt', 'success', { actionLabel: 'Rückgängig', onAction: undoLastTrackingChange });
});


// Funktion zum Umwandeln des Datums in d.m.yyyy-Format
function formatDateToDMYYYY(dateString) {
    // Datum im ISO-Format (yyyy-mm-dd) wird aus dem Eingabefeld erhalten
    const date = new Date(dateString);

    // Überprüfen, ob das Datum gültig ist
    if (isNaN(date.getTime())) {
        return ''; // Rückgabe eines leeren Strings, wenn das Datum ungültig ist
    }

    // Datumsteile extrahieren
    const day = date.getDate();  // Tag ohne führende Null
    const month = date.getMonth() + 1;  // Monat (0-indexiert) ohne führende Null
    const year = date.getFullYear();  // Jahr

    // Rückgabe des formatierten Datums
    return `${day}.${month}.${year}`;
}

// Funktion zum Umwandeln der Uhrzeit in hh:mm:ss-Format
function formatTimeToHHMMSS(timeString) {
    // Der Wert ist im Format hh:mm, wir fügen die Sekunden hinzu
    return `${timeString}:00`; // Anhängen von ":00" für die Sekunden
}

function restoreTrackingWorkflow() {
    const savedRecords = readTerminRecords();
    if (!savedRecords || savedRecords.length === 0) return;

    trackingData = ensureTrackingFields(savedRecords.map(row => ({ Status: 'offen', ...row })));
    renderTrackingTable(trackingData);
    showWorkflowStatus(`${trackingData.length} Termine aus dem vorherigen Schritt geladen. Änderungen werden automatisch zwischengespeichert.`);
}

restoreTrackingWorkflow();


function sortTrackingDataByTime(data) {
    return data.sort((a, b) => {
        return compareTerminUhrzeit(a.Termin_Uhrzeit, b.Termin_Uhrzeit);
    });
}



function updateAnzahlTermine(data) {
    const countMap = data.reduce((acc, entry) => {
        const key = getPatientDayKey(entry);
        if (key) acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});

    // Anzahl der Termine je Patient am Tag (für die Excel- und PDF-Liste)
    data.forEach(entry => {
        const count = countMap[getPatientDayKey(entry)] || 1;
        if (entry.Anzahl_Termine !== count) entry.Anzahl_Termine = count;
    });
}
