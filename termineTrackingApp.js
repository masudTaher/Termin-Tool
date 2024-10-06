let trackingData = [];
let workbook;

// Excel-Datei hochladen und einlesen
document.getElementById('trackingFile').addEventListener('change', handleFileUpload);

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file)
        return;

    const reader = new FileReader();
    reader.onload = (e) => {
        const data = new Uint8Array(e.target.result);
        workbook = XLSX.read(data, {
            type: 'array'
        });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        trackingData = XLSX.utils.sheet_to_json(worksheet);

        // Überprüfen, ob die Spalte "Status" vorhanden ist
        if (!trackingData[0] || !trackingData[0].hasOwnProperty('Status')) {
            trackingData = trackingData.map(row => ({
                        ...row,
                        Status: "offen"
                    }));
        }

        renderTrackingTable(trackingData);
        setInterval(() => updateAppointmentsStartingSoon(trackingData), 10000); // Check every 10 seconds
    };
    reader.readAsArrayBuffer(file);
}

// Function to update rows with appointments that are starting soon
function updateAppointmentsStartingSoon(data) {
    const tableBody = document.getElementById('tableBody');
    const rows = tableBody.querySelectorAll('tr');

    rows.forEach((row, index) => {
        const termin = data[index];

        // Check if the appointment is starting soon
        if (isAppointmentStartingSoonOrOngoing(termin) && termin.Status === "offen") {
            row.style.backgroundColor = '#cce5ff'; // Highlight rows that are starting soon with a light blue color
        } else if (termin.Status === "beendet" || termin.Status === "alleine") {
            row.style.backgroundColor = '#ddffdd'; // Green for completed appointments
        } else if (termin.Status === "storniert") {
            row.style.backgroundColor = '#ffdddd'; // Red for canceled appointments
        } else if (termin.Status === "losgefahren") {
            row.style.backgroundColor = '#ffffcc'; // Yellow for departed appointments
        } else {
            row.style.backgroundColor = ''; // Reset to default
        }
    });

    console.log("Appointments updated for those starting soon."); // Optional logging for debugging
}

// Render the tracking table
function renderTrackingTable(data) {
    const tableBody = document.getElementById('tableBody');
    const tablesSection = document.querySelector('.tables-section');
    const actionSection = document.querySelector('.action-section');

    tableBody.innerHTML = ''; // Clear previous content

    if (data.length === 0) {
        tablesSection.style.display = 'none';
        actionSection.style.display = 'none';
        return; // No data, exit the function
    }

    tablesSection.style.display = 'flex'; // Show the tables section
    actionSection.style.display = 'block'; // Show the action section

    data.forEach((termin, index) => {
        const row = document.createElement('tr');

        // Check if the appointment is starting soon
        if (isAppointmentStartingSoonOrOngoing(termin) && termin.Status === "offen") {
            row.style.backgroundColor = '#cce5ff'; // Highlight rows that are starting soon with a light blue color
        } else if (termin.Status === "beendet" || termin.Status === "alleine") {
            row.style.backgroundColor = '#ddffdd'; // Green for completed appointments
        } else if (termin.Status === "storniert") {
            row.style.backgroundColor = '#ffdddd'; // Red for canceled appointments
        } else if (termin.Status === "losgefahren") {
            row.style.backgroundColor = '#ffffcc'; // Yellow for departed appointments
        } else {
            row.style.backgroundColor = ''; // Reset to default
        }

        let endTime = '';
        if (termin.Termin_Uhrzeit) {
            const startTime = new Date(`1970-01-01T${termin.Termin_Uhrzeit}`);
            const durationMinutes = termin.Dauer * 60;
            endTime = new Date(startTime.getTime() + durationMinutes * 60000);
        }

        row.innerHTML = `
			            <td>${index + 1}</td> <!-- Add the Lfd. Nr. column -->

            <td>${termin.Termin_Uhrzeit || ''}</td>
			<td>${termin.Patient_Nr || ''}</td>

            <td>${termin['Patienten Nr::Patienten_Vorname'] + ' ' + termin['Patienten Nr::Patienten_Name'] || ''}</td>
			<td>${termin['Patienten Nr::Patienten_Geschlecht'].charAt(0) || ''}</td>
			            <td>${termin.Bemerkung || ''}</td>

            <td>${termin['Arzt Nr::Name'] || ''}</td>
			            <td>${termin['Arzt Nr::Vorname'] || ''}</td>

			<td contenteditable="true" oninput="updateCell(event, ${index}, 'Übersetzer')">${termin.Übersetzer || ''}</td>
            <td>${termin.Anzahl_Termine || ''}</td>
			<td>
                <select data-index="${index}" class="status-select">
                    <option value="offen" ${termin.Status === "offen" ? "selected" : ""}>Offen</option>
                    <option value="beendet" ${termin.Status === "beendet" ? "selected" : ""}>Beendet</option>
					<option value="alleine" ${termin.Status === "alleine" ? "selected" : ""}>Alleine</option>
                    <option value="storniert" ${termin.Status === "storniert" ? "selected" : ""}>Storniert</option>
                    <option value="losgefahren" ${termin.Status === "losgefahren" ? "selected" : ""}>Losgefahren</option>
                </select>
            </td>
			          <td><button class="delete-button" data-index="${index}">Löschen</button></td>


        `;
        tableBody.appendChild(row);
    });
	
	    // Event-Listener für den Löschen-Button hinzufügen
    document.querySelectorAll('.delete-button').forEach(button =>
        button.addEventListener('click', deleteRow));

    document.querySelectorAll('.status-select').forEach(select =>
        select.addEventListener('change', updateStatusFromSelect));
}


// Funktion zum Löschen einer Zeile
function deleteRow(event) {
    const index = event.target.dataset.index;

    // Bestätigungsdialog
    if (confirm('Sind Sie sicher, dass Sie diese Zeile löschen möchten?')) {
        // Zeile aus der Datenstruktur entfernen
        trackingData.splice(index, 1);

    // Zähle die Anzahl der Termine und aktualisiere die Anzahl_Termine-Spalte
    updateAnzahlTermine(trackingData);
	
        // Tabelle neu rendern
        renderTrackingTable(trackingData);
    }
}

function formatTime(date) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function updateCell(event, index, fieldName) {
    const newValue = event.target.innerText; // Get the new value from the cell

    // Check if the data array is valid
    if (trackingData && trackingData[index]) {
        trackingData[index][fieldName] = newValue; // Update the entry in the data array
    } else {
        console.error('trackingData array is not defined or index is out of bounds');
    }

    // Optionally save changes to backend
}

// Update status from select dropdown
function updateStatusFromSelect(event) {
    const index = event.target.dataset.index;
    trackingData[index].Status = event.target.value;

    const tableBody = document.getElementById('tableBody');
    const row = tableBody.querySelectorAll('tr')[index];

    // Update row background color based on the new status

    if (isAppointmentStartingSoonOrOngoing(trackingData[index]) && trackingData[index].Status === "offen") {
        row.style.backgroundColor = '#cce5ff'; // Highlight rows that are starting soon with a light blue color
    } else if (trackingData[index].Status === "beendet" || trackingData[index].Status === "alleine") {
        row.style.backgroundColor = '#ddffdd'; // Green for completed
    } else if (trackingData[index].Status === "storniert") {
        row.style.backgroundColor = '#ffdddd'; // Red for canceled
    } else if (trackingData[index].Status === "losgefahren") {
        row.style.backgroundColor = '#ffffcc'; // Yellow for departed
    } else {
        row.style.backgroundColor = ''; // Reset to default
    }
}

// Funktion zur Überprüfung, ob ein Termin in Kürze beginnt oder an diesem Tag noch stattfindet
function isAppointmentStartingSoonOrOngoing(termin) {
    const now = new Date();

    // Datumsformat anpassen (TT.MM.JJJJ -> JJJJ-MM-TT)
    const [day, month, year] = termin.Termin_Datum.split('.');

    // Füge führende Nullen hinzu, falls erforderlich
    const formattedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${termin.Termin_Uhrzeit}`;

    // Startzeit berechnen
    const startDateTime = new Date(formattedDate);

    // Ende des Tages berechnen (23:59:59 des gleichen Datums)
    const endOfDay = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T23:59:59`);

    // Eine Stunde vor Beginn des Termins berechnen
    const oneHourBeforeStart = new Date(startDateTime.getTime() - 60 * 60 * 1000); // Eine Stunde vorher

    // Überprüfen, ob 'now' zwischen einer Stunde vor 'startDateTime' und 'endOfDay' liegt
    return now >= oneHourBeforeStart;
}

// Workbook mit aktualisierten Daten aktualisieren
function updateWorkbook() {
    const newWorkbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(trackingData);
    XLSX.utils.book_append_sheet(newWorkbook, worksheet, 'Tracking');
    workbook = newWorkbook;
}

// Funktion zum Speichern und Herunterladen der aktualisierten Excel-Datei
function saveAndDownloadExcel() {
    updateWorkbook();

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
    const headers = [["Datum", "Start", "Pat. Nr", "Patient", "Geschlecht", "Bemerkung", "Arzt", "Ort", "Übersetzer", "Anzahl Termine", "Status"]];
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
             ? termin['Bemerkung'].replace(/(\r\n|\n|\r)+/g, ' ').trim()
             : ''; // Replace line breaks with a space

        return [
            termin.Termin_Datum,
            termin.Termin_Uhrzeit ? formatTimePdf(termin.Termin_Uhrzeit) : '', // Check if Termin_Uhrzeit is empty, if not, format it
			termin.Patient_Nr,
            termin['Patienten Nr::Patienten_Vorname'] + ' ' + termin['Patienten Nr::Patienten_Name'],
            termin['Patienten Nr::Patienten_Geschlecht'].charAt(0),
            bemerkung,
            termin['Arzt Nr::Name']? termin['Arzt Nr::Name'] : '',
            termin['Arzt Nr::Vorname'],
            termin.Übersetzer,
            termin.Anzahl_Termine,
            termin.Status
        ];
    });

    // Generate the PDF table
    doc.autoTable({
        head: headers,
        body: rows
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
    modal.style.display = modal.style.display === 'block' ? 'none' : 'block';
}

  // Event-Listener für den Hinzufügen-Button
  document.getElementById('addRowButton').addEventListener('click', () => {
    toggleAddRowModal();
  });

// Event-Listener für den "Hinzufügen"-Button
document.getElementById('confirmAddRowButton').addEventListener('click', () => {
    
// Pflichtfelder definieren
const requiredFields = {
    'terminUhrzeit': 'Termin Uhrzeit',
    'patientNr': 'Patienten Nr',
    'patientName': 'Patienten Name',
    'patientVorname': 'Patienten Vorname'
};

// Überprüfen, ob alle Pflichtfelder ausgefüllt sind
for (let field in requiredFields) {
    if (!document.getElementById(field).value) {
        alert(`Bitte füllen Sie das Feld "${requiredFields[field]}" aus.`); // Fehlermeldung anzeigen
        return; // Abbrechen, wenn ein Feld leer ist
    }
}
	
	
	// Dynamische Spalten aus der ersten Zeile holen (wenn vorhanden)
    const headers = Object.keys(trackingData[0]);


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

    // Erstelle eine neue Zeile basierend auf diesen Spalten
    let newRow = {
        "Termin_Datum": firstTerminDatum,
        "Termin_Uhrzeit": formatTimeToHHMMSS(document.getElementById('terminUhrzeit').value),
        "Patient_Nr": parseInt(document.getElementById('patientNr').value,10),
        "Patienten Nr::Patienten_Name": document.getElementById('patientName').value,
        "Arzt_Nr": document.getElementById('arztNr').value,
        "Arzt Nr::Name": parseInt(document.getElementById('arztName').value, 10),
        "Bemerkung": document.getElementById('bemerkung').value,
        "Kostengarantie Ja Nein": document.getElementById('kostengarantie').value,
        "Patienten Nr::Patienten_Geschlecht": document.getElementById('patientGeschlecht').value,
        "Patienten Nr::Patienten_Status": document.getElementById('patientStatus').value,
        "Patienten Nr::Patienten_Vorname": document.getElementById('patientVorname').value,
        "Arzt Nr::Vorname": document.getElementById('arztVorname').value,
        "Übersetzer": document.getElementById('uebersetzer').value,
		"Status": 'offen'
    };

    // Füge die neue Zeile zu trackingData hinzu
    trackingData.push(newRow);

    // Zähle die Anzahl der Termine und aktualisiere die Anzahl_Termine-Spalte
    updateAnzahlTermine(trackingData);


    // Sortiere die trackingData nach Uhrzeit
    trackingData = sortTrackingDataByTime(trackingData);

    // Tabelle neu rendern
    renderTrackingTable(trackingData);
	
	// Leere die Eingabefelder im Modal
    document.getElementById('addRowForm').reset();

    // Schließe das Modal nach dem Hinzufügen
    toggleAddRowModal();
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


function sortTrackingDataByTime(data) {
    return data.sort((a, b) => {
        const timeA = new Date(`1970-01-01T${a.Termin_Uhrzeit || '00:00:00'}`);
        const timeB = new Date(`1970-01-01T${b.Termin_Uhrzeit || '00:00:00'}`);
        return timeA - timeB; // Sortiere aufsteigend
    });
}



function updateAnzahlTermine(data) {
    const countMap = data.reduce((acc, entry) => {
        acc[entry.Patient_Nr] = (acc[entry.Patient_Nr] || 0) + 1;
        return acc;
    }, {});

    // Aktualisieren der Anzahl der Termine für jeden Eintrag in trackingData
    data.forEach(entry => {
        entry.Anzahl_Termine = countMap[entry.Patient_Nr] || 0;
    });
}
