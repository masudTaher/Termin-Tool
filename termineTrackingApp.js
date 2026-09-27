let trackingData = [];

const AKTUALISIERUNG_INTERVALL_MS = 10000;
const HERVORHEBUNG_VORLAUF_MS = 60 * 60 * 1000; // "offen"-Termine werden ab 1 Stunde vor Beginn hervorgehoben

const FARBE_BALD_BEGINNEND = '#cce5ff'; // hellblau
const STATUS_FARBEN = {
    beendet: '#ddffdd', // grün
    alleine: '#ddffdd', // grün
    storniert: '#ffdddd', // rot
    losgefahren: '#ffffcc' // gelb
};

const STATUS_OPTIONEN = [
    { value: 'offen', label: 'Offen' },
    { value: 'beendet', label: 'Beendet' },
    { value: 'alleine', label: 'Alleine' },
    { value: 'storniert', label: 'Storniert' },
    { value: 'losgefahren', label: 'Losgefahren' }
];

// Pflichtfelder im Modal "Neue Zeile hinzufügen" (Element-ID -> Bezeichnung für die Fehlermeldung)
const PFLICHTFELDER = {
    'terminUhrzeit': 'Termin Uhrzeit',
    'patientNr': 'Patienten Nr',
    'patientName': 'Patienten Name',
    'patientVorname': 'Patienten Vorname'
};

// Excel-Datei hochladen und einlesen
document.getElementById('trackingFile').addEventListener('change', handleFileUpload);

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file)
        return;

    leseErstesTabellenblatt(file, (worksheet) => {
        trackingData = XLSX.utils.sheet_to_json(worksheet);

        // Ohne vorhandene Spalte "Status" starten alle Termine als "offen"
        if (!trackingData[0] || !trackingData[0].hasOwnProperty('Status')) {
            trackingData = trackingData.map(row => ({
                        ...row,
                        Status: "offen"
                    }));
        }

        renderTrackingTable(trackingData);
        // Die Hervorhebung hängt von der aktuellen Uhrzeit ab und wird deshalb regelmäßig aktualisiert
        setInterval(() => updateAppointmentsStartingSoon(trackingData), AKTUALISIERUNG_INTERVALL_MS);
    });
}

// Prüft, ob die aktuelle Zeit frühestens eine Stunde vor Terminbeginn liegt
// (auch bereits begonnene oder vergangene Termine liefern true)
function isAppointmentStartingSoonOrOngoing(termin) {
    const now = new Date();

    // Datumsformat d.m.yyyy -> yyyy-mm-dd
    const [day, month, year] = termin.Termin_Datum.split('.');
    const startDateTime = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${termin.Termin_Uhrzeit}`);

    return now >= new Date(startDateTime.getTime() - HERVORHEBUNG_VORLAUF_MS);
}

function ermittleZeilenfarbe(termin) {
    if (isAppointmentStartingSoonOrOngoing(termin) && termin.Status === "offen") {
        return FARBE_BALD_BEGINNEND;
    }
    return STATUS_FARBEN.hasOwnProperty(termin.Status) ? STATUS_FARBEN[termin.Status] : '';
}

function updateAppointmentsStartingSoon(data) {
    const rows = document.getElementById('tableBody').querySelectorAll('tr');

    rows.forEach((row, index) => {
        row.style.backgroundColor = ermittleZeilenfarbe(data[index]);
    });
}

function renderStatusSelect(termin, index) {
    const options = STATUS_OPTIONEN.map(({ value, label }) =>
            `<option value="${value}" ${termin.Status === value ? "selected" : ""}>${label}</option>`).join('');
    return `<select data-index="${index}" class="status-select">${options}</select>`;
}

function formatPatientenName(termin) {
    const vorname = termin['Patienten Nr::Patienten_Vorname'];
    const name = termin['Patienten Nr::Patienten_Name'];
    if (!vorname && !name)
        return '';
    return (vorname || '') + (name ? ' ' + name : '');
}

// Hinweis: In editierbaren Zellen darf kein Leerraum um den Wert stehen, da innerText übernommen bzw. validiert wird
function renderTrackingTable(data) {
    const tableBody = document.getElementById('tableBody');
    tableBody.innerHTML = '';

    if (data.length === 0) {
        setzeSektionenSichtbar(false);
        return;
    }

    setzeSektionenSichtbar(true);

    data.forEach((termin, index) => {
        const row = document.createElement('tr');
        row.style.backgroundColor = ermittleZeilenfarbe(termin);

        row.innerHTML = `
            <td>${index + 1}</td>
            <td contenteditable="true" onblur="updateTimeCell(event, ${index})">${termin.Termin_Uhrzeit || ''}</td>
            <td>${termin.Patient_Nr || ''}</td>
            <td>${formatPatientenName(termin)}</td>
            <td>${termin['Patienten Nr::Patienten_Geschlecht'] ? termin['Patienten Nr::Patienten_Geschlecht'].charAt(0) : ''}</td>
            <td>${termin.Bemerkung || ''}</td>
            <td>${termin['Arzt Nr::Name'] || ''}</td>
            <td>${termin['Arzt Nr::Vorname'] || ''}</td>
            <td contenteditable="true" oninput="updateCell(event, ${index}, 'Übersetzer')">${termin.Übersetzer || ''}</td>
            <td>${termin.Anzahl_Termine || ''}</td>
            <td>${renderStatusSelect(termin, index)}</td>
            <td><button class="delete-button" data-index="${index}">Löschen</button></td>
        `;
        tableBody.appendChild(row);
    });

    document.querySelectorAll('.delete-button').forEach(button =>
        button.addEventListener('click', deleteRow));

    document.querySelectorAll('.status-select').forEach(select =>
        select.addEventListener('change', updateStatusFromSelect));
}

// Wird über onblur der Uhrzeit-Zelle aufgerufen
function updateTimeCell(event, index) {
    const newValue = event.target.innerText;

    if (!/^\d{2}:\d{2}:\d{2}$/.test(newValue)) {
        alert("Bitte eine gültige Uhrzeit im Format HH:MM:SS eingeben.");
        return;
    }

    if (trackingData && trackingData[index]) {
        trackingData[index].Termin_Uhrzeit = newValue;
    } else {
        console.error('trackingData array is not defined or index is out of bounds');
    }

    sortTrackingDataByTime(trackingData);
    renderTrackingTable(trackingData);
}

// Wird über oninput der Übersetzer-Zelle aufgerufen
function updateCell(event, index, fieldName) {
    const newValue = event.target.innerText;

    if (trackingData && trackingData[index]) {
        trackingData[index][fieldName] = newValue;
    } else {
        console.error('trackingData array is not defined or index is out of bounds');
    }
}

function deleteRow(event) {
    const index = event.target.dataset.index;

    if (confirm('Sind Sie sicher, dass Sie diese Zeile löschen möchten?')) {
        trackingData.splice(index, 1);
        updateAnzahlTermine(trackingData);
        renderTrackingTable(trackingData);
    }
}

function updateStatusFromSelect(event) {
    const index = event.target.dataset.index;
    trackingData[index].Status = event.target.value;

    const row = document.getElementById('tableBody').querySelectorAll('tr')[index];
    row.style.backgroundColor = ermittleZeilenfarbe(trackingData[index]);
}

function saveAndDownloadExcel() {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(trackingData), 'Tracking');

    const excelData = XLSX.write(workbook, {
        bookType: 'xlsx',
        type: 'array'
    });
    const blob = new Blob([excelData], {
        type: 'application/octet-stream'
    });

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${findeErstesTerminDatum(trackingData)}_Tracking.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

document.getElementById('saveChanges').addEventListener('click', saveAndDownloadExcel);

document.getElementById('savePdfButton').addEventListener('click', () => {
    const {
        jsPDF
    } = window.jspdf;
    const doc = new jsPDF('landscape');

    const headers = [["Datum", "Start", "Pat. Nr", "Patient", "Geschlecht", "Bemerkung", "Arzt", "Ort", "Übersetzer", "Anzahl Termine", "Status"]];
    const rows = trackingData.map(termin => [
            termin.Termin_Datum,
            termin.Termin_Uhrzeit ? formatTime(termin.Termin_Uhrzeit) : '',
            termin.Patient_Nr,
            termin['Patienten Nr::Patienten_Vorname'] + ' ' + termin['Patienten Nr::Patienten_Name'],
            termin['Patienten Nr::Patienten_Geschlecht'] ? termin['Patienten Nr::Patienten_Geschlecht'].charAt(0) : '',
            bereinigeBemerkung(termin['Bemerkung']),
            termin['Arzt Nr::Name'] ? termin['Arzt Nr::Name'] : '',
            termin['Arzt Nr::Vorname'],
            termin.Übersetzer,
            termin.Anzahl_Termine,
            termin.Status
        ]);

    doc.autoTable({
        head: headers,
        body: rows
    });

    doc.save(`${findeErstesTerminDatum(trackingData)}_Tracking.pdf`);
});

// Modal öffnen/schließen (auch über Inline-Handler im HTML aufgerufen)
function toggleAddRowModal() {
    const modal = document.getElementById('addRowModal');
    modal.style.display = modal.style.display === 'block' ? 'none' : 'block';
}

document.getElementById('addRowButton').addEventListener('click', toggleAddRowModal);

function feldWert(id) {
    return document.getElementById(id).value;
}

document.getElementById('confirmAddRowButton').addEventListener('click', () => {
    for (const field in PFLICHTFELDER) {
        if (!feldWert(field)) {
            alert(`Bitte füllen Sie das Feld "${PFLICHTFELDER[field]}" aus.`);
            return;
        }
    }

    // Neue Einträge übernehmen das Datum der geladenen Datei
    const newRow = {
        "Termin_Datum": findeErstesTerminDatum(trackingData),
        "Termin_Uhrzeit": formatTimeToHHMMSS(feldWert('terminUhrzeit')),
        "Patient_Nr": parseInt(feldWert('patientNr'), 10),
        "Patienten Nr::Patienten_Name": feldWert('patientName'),
        "Arzt_Nr": feldWert('arztNr'),
        "Arzt Nr::Name": feldWert('arztName'),
        "Bemerkung": feldWert('bemerkung'),
        "Kostengarantie Ja Nein": feldWert('kostengarantie'),
        "Patienten Nr::Patienten_Geschlecht": feldWert('patientGeschlecht'),
        "Patienten Nr::Patienten_Status": feldWert('patientStatus'),
        "Patienten Nr::Patienten_Vorname": feldWert('patientVorname'),
        "Arzt Nr::Vorname": feldWert('arztVorname'),
        "Übersetzer": feldWert('uebersetzer'),
        "Status": 'offen'
    };

    trackingData.push(newRow);
    updateAnzahlTermine(trackingData);
    sortTrackingDataByTime(trackingData);
    renderTrackingTable(trackingData);

    document.getElementById('addRowForm').reset();
    toggleAddRowModal();
});

// <input type="time"> liefert "hh:mm"; die Daten verwenden "hh:mm:ss"
function formatTimeToHHMMSS(timeString) {
    return `${timeString}:00`;
}

// Sortiert das Array in-place aufsteigend nach Uhrzeit
function sortTrackingDataByTime(data) {
    return data.sort((a, b) => {
        const timeA = new Date(`1970-01-01T${a.Termin_Uhrzeit || '00:00:00'}`);
        const timeB = new Date(`1970-01-01T${b.Termin_Uhrzeit || '00:00:00'}`);
        return timeA - timeB;
    });
}

// Anders als in "Termine Bearbeiten" wird die Anzahl hier nach Hinzufügen/Löschen immer neu berechnet
function updateAnzahlTermine(data) {
    const anzahlProPatient = zaehleTermineProPatient(data);

    data.forEach(entry => {
        entry.Anzahl_Termine = anzahlProPatient[entry.Patient_Nr] || 0;
    });
}
