// Globale Variablen für die Tabelle und die Excel-Daten
let tableData = [];
let currentEditingRow = null;

// Funktionen zum Hochladen und Verarbeiten von Excel-Dateien
document.getElementById('uploadButton').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) {
        alert('Keine Datei ausgewählt. Bitte wählen Sie eine gültige Excel-Datei aus.');
        return;
    }

    const reader = new FileReader();
    reader.onload = function (event) {
        const data = new Uint8Array(event.target.result);
        const workbook = XLSX.read(data, {
            type: 'array'
        });
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet);

        tableData = jsonData;


        // Prüfen, ob die Spalte "Übersetzer" existiert, andernfalls hinzufügen
        addUebersetzerPropertyIfMissing(tableData);

        addAnzahlTerminePropertyIfMissing(tableData);

        renderTable();
    };
    reader.readAsArrayBuffer(file);
});

// Funktion zum Überprüfen, ob die "Dauer" Eigenschaft existiert, andernfalls hinzufügen
function addDurationPropertyIfMissing(data) {
    return data.map(entry => {
        if (!entry.hasOwnProperty('Dauer')) {
            entry['Dauer'] = '2';
        }
        return entry;
    });
}

// Funktion zum Überprüfen, ob die "Übersetzer" Eigenschaft existiert, andernfalls hinzufügen
function addUebersetzerPropertyIfMissing(data) {
    return data.map(entry => {
        if (!entry.hasOwnProperty('Übersetzer')) {
            entry['Übersetzer'] = '';
        }
        return entry;
    });
}

// Funktion zum Überprüfen und Hinzufügen der "Anzahl_Termine" Eigenschaft, falls sie fehlt
function addAnzahlTerminePropertyIfMissing(data) {
    // Zählen der Anzahl der Termine pro Patient
    const countMap = data.reduce((acc, entry) => {
        acc[entry.Patient_Nr] = (acc[entry.Patient_Nr] || 0) + 1;
        return acc;
    }, {});

    // Hinzufügen der "Anzahl_Termine" Eigenschaft, falls sie nicht existiert
    return data.map(entry => {
        if (!entry.hasOwnProperty('Anzahl_Termine')) {
            entry['Anzahl_Termine'] = countMap[entry.Patient_Nr];
        }
        return entry;
    });
}

// Mapping für Header-Namen, die anders dargestellt werden sollen
const headerMapping = {
    'Termin_Datum': 'Datum',
    'Termin_Uhrzeit': 'Start',
    'Patient_Nr': 'Pat. Nr',
    'Arzt_Nr': 'Arzt Nr',
    'Kostengarantie Ja Nein': 'Kostengarantie',
    'Patienten Nr::Patienten_Name': 'Pat. Name',
    'Patienten Nr::Patienten_Geschlecht': 'Geschlecht',
    'Arzt Nr::Name': 'Arzt',
    'Patienten Nr::Patienten_Status': 'Pat. Status',
    'Patienten Nr::Patienten_Vorname': 'Pat. Vorname',
    'Arzt Nr::Vorname': 'Ort',
    'Dauer': 'Dauer',
    'Patienten_Vollname': 'Patient'
};

// Geschlecht Optionen für das Dropdown
const genderOptions = ["F : Weiblich", "M : Männlich"];

// Globale Variable für die Farbkodierung
const colorMapping = {};

// Funktion zum Generieren einer zufälligen, hellen und verschiedenen Farbe
function generateDistinctLightColor(existingColors) {
    const goldenRatioConjugate = 0.618033988749895; // Mathematisches Verhältnis für optimale Verteilung
    let hue = Math.random(); // Zufälliger Startpunkt auf dem Farbkreis

    while (true) {
        hue += goldenRatioConjugate;
        hue %= 1; // Sicherstellen, dass der Wert zwischen 0 und 1 bleibt

        // Sättigung und Helligkeit angepasst für helle Farben
        const saturation = 0.3 + Math.random() * 0.2; // Bereich: 0.3 bis 0.5
        const value = 0.9 + Math.random() * 0.1; // Bereich: 0.9 bis 1

        // HSV (Hue, Saturation, Value) in RGB umwandeln
        const rgb = hsvToRgb(hue, saturation, value);

        // Farbcode erzeugen
        const color = `#${rgb.r.toString(16).padStart(2, '0')}${rgb.g.toString(16).padStart(2, '0')}${rgb.b.toString(16).padStart(2, '0')}`;

        // Wenn diese Farbe bereits existiert, erneut versuchen
        if (!existingColors.includes(color))
            return color;
    }
}

// Funktion zur Umwandlung von HSV nach RGB
function hsvToRgb(h, s, v) {
    let r,
    g,
    b;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);

    switch (i % 6) {
    case 0:
        r = v;
        g = t;
        b = p;
        break;
    case 1:
        r = q;
        g = v;
        b = p;
        break;
    case 2:
        r = p;
        g = v;
        b = t;
        break;
    case 3:
        r = p;
        g = q;
        b = v;
        break;
    case 4:
        r = t;
        g = p;
        b = v;
        break;
    case 5:
        r = v;
        g = p;
        b = q;
        break;
    }

    return {
        r: Math.floor(r * 255),
        g: Math.floor(g * 255),
        b: Math.floor(b * 255)
    };
}

// Funktion zum Erzeugen einer Farbzuordnung für Patienten mit mehr als einem Termin
function createColorMapping(data) {
    const existingColors = [];

    data.forEach(entry => {
        if (entry.Anzahl_Termine > 1 && !colorMapping[entry.Patient_Nr]) {
            const color = generateDistinctLightColor(existingColors);
            colorMapping[entry.Patient_Nr] = color;
            existingColors.push(color); // Hinzufügen zur Liste der verwendeten Farben
        }
    });
}

// Funktion zur Aktualisierung der Endzeit
function updateEndTime(rowIndex) {
    const row = tableData[rowIndex];
    let endTime = '';

    if (row["Termin_Uhrzeit"]) {
        const startTime = new Date(`1970-01-01T${row["Termin_Uhrzeit"]}`);
        const durationMinutes = (row["Dauer"] * 60) || 0;
        endTime = new Date(startTime.getTime() + durationMinutes * 60000);
    }

    // Update the "Ende" cell
    const formattedEndTime = endTime ? formatEndTime(endTime) : '';
    tableData[rowIndex]["Ende"] = formattedEndTime; // Update the "Ende" property in the data array

    // Render the table again to reflect the updated end time
    renderTable();
}

function renderTable() {
    const tableBody = document.getElementById('tableBody');
    const tableHead = document.querySelector('#dataTable thead');

    const tablesSection = document.querySelector('.tables-section');
    const actionSection = document.querySelector('.action-section');

    tableBody.innerHTML = '';
    tableHead.innerHTML = '';

    if (tableData.length > 0) {
		
		sortTableData();
	
        const headers = Object.keys(tableData[0]);
        const rows = tableData;

        // Generiere die Farbkodierung für Patienten mit Anzahl_Termine > 1 nur einmal
        if (Object.keys(colorMapping).length === 0) {
            createColorMapping(tableData);
        }

        // Filtere die Spalten
        const filteredHeaders = headers.filter(header =>
            header !== "Termin_Datum" &&
            header !== "Arzt_Nr" &&
            header !== "Kostengarantie Ja Nein" &&
            header !== "Patienten Nr::Patienten_Status" &&
            header !== "Patienten Nr::Patienten_Vorname" &&
            header !== "Patienten Nr::Patienten_Name"
        );

        // Füge den neuen Header für "Patienten_Vollname" hinzu
        const patientNrIndex = filteredHeaders.indexOf("Patient_Nr");
        if (patientNrIndex !== -1) {
            filteredHeaders.splice(patientNrIndex + 1, 0, "Patienten_Vollname");
        }

        // Füge "Laufende Nr." am Anfang der Kopfzeile hinzu
        filteredHeaders.unshift("Lfd. Nr.");


        // Header hinzufügen
        tableHead.innerHTML = '<tr>' +
            filteredHeaders.map(header => `<th>${header === "Anzahl_Termine" ? "Anzahl Termine" : (headerMapping[header] || header)}</th>`).join('') +
            '</tr>';

        // Datenzeilen hinzufügen
        rows.forEach((row, rowIndex) => {
            // Verwenden Sie die gespeicherten Farben
            const backgroundColor = (row.Anzahl_Termine > 1 && colorMapping[row.Patient_Nr]) || '';
            const rowStyle = backgroundColor ? `style="background-color: ${backgroundColor};"` : '';

            tableBody.innerHTML += `<tr ${rowStyle}>` +
                filteredHeaders.map(header => {
                    if (header === "Lfd. Nr.") {
                        // Erzeuge die laufende Nummer, beginnend mit 1
                        return `<td>${rowIndex + 1}</td>`;
                    }

                    const cell = row[header];

                    // Bestimme, ob die Zelle bearbeitbar ist
                    const isEditable = !["Patient_Nr", "Patienten_Vollname", "Arzt Nr::Name", "Arzt Nr::Vorname", "Anzahl_Termine", "Ende"].includes(header);

                    if (header === "Patienten_Vollname") {
                        // Kombiniere Vorname und Nachname
                        const fullName = `${row["Patienten Nr::Patienten_Vorname"] || ''} ${row["Patienten Nr::Patienten_Name"] || ''}`.trim();
                        return `<td>${fullName}</td>`;
                    } else if (header === "Patienten Nr::Patienten_Geschlecht") {
                        // Dropdown verwenden
                        return `<td>${renderDropdown(cell, rowIndex, header)}</td>`;
                    } else if (header === "Termin_Uhrzeit") {
                        // Text-Input für Uhrzeit
                        return `<td>${renderTimeInput(cell, rowIndex, header)}</td>`;
                    } else {
                        // Alle anderen Spalten sind contenteditable
                        return `<td contenteditable="${isEditable}" oninput="updateCell(${rowIndex}, '${header}', this.innerText)">${cell}</td>`;
                    }
                }).join('') +
                '</tr>';
        });
    }

    // Sichtbarkeit basierend auf der Anzahl der Einträge festlegen
    if (tableData.length > 0) {
        tablesSection.style.display = 'flex';
        actionSection.style.display = 'block';
    } else {
        tablesSection.style.display = 'none';
        actionSection.style.display = 'none';
    }
}



function formatEndTime(date) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

// Input für Datum rendern
function renderDateInput(selectedValue, rowIndex, header) {
    if (!selectedValue) {
        return `<input type="text" value="" onchange="validateAndUpdateDate(${rowIndex}, '${header}', this)" placeholder="d.m.yyyy" />`;
    } else {
        return `<span>${selectedValue}</span>`;
    }
}

// Validierung des Datums im Format "d.m.yyyy"
function validateAndUpdateDate(rowIndex, header, inputElement) {
    const dateValue = inputElement.value;
    const datePattern = /^([1-9]|[12]\d|3[01])\.([1-9]|1[012])\.\d{4}$/;

    if (datePattern.test(dateValue)) {
        updateCell(rowIndex, header, dateValue);
        inputElement.classList.remove("error");
    } else {
        alert("Bitte geben Sie ein gültiges Datum im Format d.m.yyyy ein.");
        inputElement.classList.add("error");
    }
}

// Dropdown für das Geschlecht rendern
function renderDropdown(selectedValue, rowIndex, header) {
    let options = genderOptions.map(option => {
        const selected = option === selectedValue ? 'selected' : '';
        return `<option value="${option}" ${selected}>${option}</option>`;
    }).join('');

    return `<select onchange="updateCell(${rowIndex}, '${header}', this.value)">${options}</select>`;
}

// Input für Uhrzeit (HH:mm:ss) rendern
function renderTimeInput(selectedValue, rowIndex, header) {
    if (!selectedValue) {
        return `<input type="text" value="" onchange="validateAndUpdateTime(${rowIndex}, '${header}', this)" placeholder="HH:mm:ss" />`;
    } else {
        return `<span>${selectedValue}</span>`;
    }
}

// Validierung der Uhrzeit im Format HH:mm:ss
function validateAndUpdateTime(rowIndex, header, inputElement) {
    const timeValue = inputElement.value;
    const timePattern = /^([01]\d|2[0-3]):([0-5]\d):([0-5]\d)$/;

    if (timePattern.test(timeValue)) {
        updateCell(rowIndex, header, timeValue);
        inputElement.style.borderColor = '';
    } else {
        alert("Bitte geben Sie eine gültige Uhrzeit im Format HH:mm:ss ein.");
        inputElement.style.borderColor = 'red';
    }
}

// Aktualisierung der Zelle
function updateCell(rowIndex, header, newValue) {
    tableData[rowIndex][header] = newValue;
    console.log(`Wert in Zeile ${rowIndex + 1}, Spalte ${header} aktualisiert: ${newValue}`);

    // Check if the updated header is "Termin_Uhrzeit" or "Dauer"
//    if (header === "Termin_Uhrzeit" || header === "Dauer") {
//        updateEndTime(rowIndex);
//    }
}

// Funktion zur Aktualisierung der Endzeit
function updateEndTime(rowIndex) {
    const row = tableData[rowIndex];
    let endTime = '';

    // Überprüfen, ob Termin_Uhrzeit nicht leer ist
    if (row["Termin_Uhrzeit"]) {
        const startTime = new Date(`1970-01-01T${row["Termin_Uhrzeit"]}`);
        const durationMinutes = (row["Dauer"] * 60) || 0; // Setze die Dauer in Minuten, falls nicht vorhanden
        endTime = new Date(startTime.getTime() + durationMinutes * 60000); // Dauer in Millisekunden

        // Update the "Ende" cell
        const formattedEndTime = formatEndTime(endTime);
        tableData[rowIndex]["Ende"] = formattedEndTime; // Update the "Ende" property in the data array
    } 

    // Render the table again to reflect the updated end time
    renderTable();
}




// Funktion zum Speichern der Tabelle als Excel-Datei
document.getElementById('saveExcelButton').addEventListener('click', () => {
	sortByTerminUhrzeit();
	
	const worksheet = XLSX.utils.json_to_sheet(tableData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Tabelle');
	
	
	// Find the first non-empty 'Termin_Datum'
    let firstTerminDatum = 'unbekannt';
    for (let i = 0; i < tableData.length; i++) {
        if (tableData[i]['Termin_Datum']) {
            firstTerminDatum = tableData[i]['Termin_Datum'];
            break;
        }
    }

    // Ensure firstTerminDatum is treated as a string
    firstTerminDatum = firstTerminDatum ? firstTerminDatum : 'unbekannt';

    // Save the file with the first non-empty 'Termin_Datum' as the filename
    XLSX.writeFile(workbook, `${firstTerminDatum}_Zuweisungen.xlsx`);	
	
	sortTableData();
});

// Funktion zur Formatierung von Excel-Daten als Datum
function formatExcelDate(serial) {
    if (serial === null || serial === undefined)
        return '';
    const utcDays = Math.floor(serial) - 25569;
    const utcValue = utcDays * 86400;
    const date = new Date(utcValue * 1000);
    return date.toLocaleDateString('de-DE'); // Format anpassen, falls nötig
}

document.getElementById('minUeber').addEventListener('click', () => {
    // Berechnung der minimalen Anzahl von Übersetzern
    const result = berechneMinimaleUebersetzer(tableData);

    // Nur Ergebnisse ausgeben, wenn keine ungültigen Termine gefunden wurden
    if (result) {
        const {
            maennlicheUebersetzer,
            weiblicheUebersetzer
        } = result;
        alert(`Mindestens ${maennlicheUebersetzer} männliche Übersetzer und ${weiblicheUebersetzer} weibliche Übersetzer werden benötigt.`);
    }
});

function berechneMinimaleUebersetzer(termine, maxTermineProTag = 2) {
    // Überprüfen, ob alle Termine eine gesetzte "Termin_Uhrzeit" haben
    const ungültigeTermine = termine.filter(termin => !termin.Termin_Uhrzeit || termin.Termin_Uhrzeit.trim() === "");

    if (ungültigeTermine.length > 0) {
        alert("Es gibt Termine ohne eine gesetzte 'Uhrzeit'. Bitte überprüfen Sie alle Einträge.");
        return null; // Rückgabe null, um anzuzeigen, dass ungültige Termine vorhanden sind
    }

    // Sortiere die Termine nach Startzeit
    termine.sort((a, b) => new Date(`1970-01-01T${a.Termin_Uhrzeit}`) - new Date(`1970-01-01T${b.Termin_Uhrzeit}`));

    const uebersetzerList = [];

    termine.forEach(termin => {
        const start = new Date(`1970-01-01T${termin.Termin_Uhrzeit}`);
        let zugewiesen = false;

        // Extrahiere das Geschlecht des Patienten (nur den ersten Buchstaben, M oder F)
        const patientenGeschlecht = termin['Patienten Nr::Patienten_Geschlecht'].charAt(0);

        // Versuche, einen vorhandenen Übersetzer mit passendem Geschlecht zu finden
        for (const uebersetzer of uebersetzerList) {
            if (
                uebersetzer.geschlecht === patientenGeschlecht && // Geschlecht muss übereinstimmen
                start >= new Date(`1970-01-01T${convertDecimalToTime(uebersetzer.verfuegbarAb)}`) &&
                uebersetzer.maxTermine > 0) {
                uebersetzer.addTermin(termin);
                zugewiesen = true;
                break;
            }
        }

        // Wenn kein Übersetzer verfügbar ist, erstelle einen neuen mit passendem Geschlecht
        if (!zugewiesen) {
            const neuerUebersetzer = createNewUebersetzer(uebersetzerList.length + 1, maxTermineProTag, patientenGeschlecht);
            neuerUebersetzer.addTermin(termin);
            uebersetzerList.push(neuerUebersetzer);
        }
    });

    // Zähle männliche und weibliche Übersetzer
    const maennlicheUebersetzer = uebersetzerList.filter(u => u.geschlecht === 'M').length;
    const weiblicheUebersetzer = uebersetzerList.filter(u => u.geschlecht === 'F').length;


	sortTableData();
    // Rückgabe als Objekt mit beiden Werten
    return {
        maennlicheUebersetzer,
        weiblicheUebersetzer
    };
}

// Hilfsfunktion zur Erstellung eines neuen Übersetzers mit Geschlecht
function createNewUebersetzer(index, maxTermine, geschlecht) {
    return {
        name: `Übersetzer_${index}`, // Eindeutiger Name
        verfuegbarAb: 0,
        maxTermine: maxTermine,
        geschlecht: geschlecht, // M oder F je nach dem Geschlecht des Patienten
        termine: [],
        addTermin(termin) {
            this.termine.push(termin);

            // Prüfen, ob der Termin mit Physio verbunden ist
            const isPhysio = (termin['Arzt Nr::Name'] && termin['Arzt Nr::Name'].toLowerCase().includes("physio")) ||
            (termin['Arzt Nr::Vorname'] && termin['Arzt Nr::Vorname'].toLowerCase().includes("physio"));

            // Reduziere maxTermine entsprechend
            this.maxTermine -= isPhysio ? 0.5 : 1;

            const durationMinutes = 3 * 60; // Dauer in Minuten
            const endTime = new Date(`1970-01-01T${termin.Termin_Uhrzeit}`);
            endTime.setMinutes(endTime.getMinutes() + durationMinutes);
            this.verfuegbarAb = convertTimeToDecimal2(convertTimeToDecimal1(endTime.toTimeString().split(' ')[0])); // Aktualisiere Verfügbarkeit
        }
    };
}

// Helper function to convert time to decimal format
function convertTimeToDecimal1(timeString) {
    const [hours, minutes] = timeString.split(':').map(Number);
    return hours + minutes / 60; // Convert to decimal
}

// Function to convert time in hours to decimal representation of the day
function convertTimeToDecimal2(hours) {
    // Ensure the input is treated as hours
    return hours / 24; // Convert hours to a fraction of a day
}

function convertDecimalToTime(decimal) {
    const totalSeconds = Math.floor(decimal * 24 * 60 * 60); // Total seconds in the day
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return [hours, minutes, seconds]
    .map(unit => String(unit).padStart(2, '0')) // Ensure two digits
    .join(':'); // Return formatted time string
}

document.getElementById('savePdfButton').addEventListener('click', () => {
	sortByTerminUhrzeit();

	
	if (tableData.length === 0) {
        alert("Es gibt keine zu speichernden Daten.");
        return;
    }

    // Access jsPDF from the global scope
    const {
        jsPDF
    } = window.jspdf;
    const doc = new jsPDF('landscape');

    // Set up the table headers
    const headers = [["Datum", "Start", "Pat. Nr","Patient", "Geschlecht", "Bemerkung", "Arzt", "Ort", "Übersetzer", "Notiz"]];
    const rows = tableData.map(termin => {
        let endTimeFormatted = ''; // Initialize as empty
        
        if (termin.Termin_Uhrzeit) {
            const startTime = new Date(`1970-01-01T${termin.Termin_Uhrzeit}`);
            const durationMinutes = termin.Dauer * 60; // Assuming Dauer is in hours
            const endTime = new Date(startTime.getTime() + durationMinutes * 60000); // Calculate end time
            endTimeFormatted = formatTime(`${endTime.getHours()}:${endTime.getMinutes()}:${endTime.getSeconds()}`); // Format end time
        }

        // Clean up the Bemerkung field by removing extra line breaks
        const bemerkung = termin['Bemerkung']
            ? termin['Bemerkung'].replace(/(\r\n|\n|\r)+/g, ' ').trim()
            : ''; // Replace line breaks with a space

        return [
            termin.Termin_Datum,
			termin.Termin_Uhrzeit ? formatTime(termin.Termin_Uhrzeit) : '', // Check if Termin_Uhrzeit is empty, if not, format it
            // endTimeFormatted, // Use the formatted end time
			termin.Patient_Nr,
            termin['Patienten Nr::Patienten_Vorname'] + ' ' + termin['Patienten Nr::Patienten_Name'],
            termin['Patienten Nr::Patienten_Geschlecht'].charAt(0),
            bemerkung,
            termin['Arzt Nr::Name'],
            termin['Arzt Nr::Vorname'],
            termin.Übersetzer,
            ''
        ];
    });

    // Define column styles with fixed width only for "Bemerkung"
    const columnStyles = {
        8: {
            cellWidth: 30
        }, // Bemerkung
        9: {
            cellWidth: 30
        } // Notiz
    };

    // Generate the PDF table
    doc.autoTable({
        head: headers,
        body: rows,
        columnStyles: columnStyles, // Apply fixed widths
    });

// Find the first non-empty 'Termin_Datum'
    let firstTerminDatum = 'unbekannt';
    for (let i = 0; i < tableData.length; i++) {
        if (tableData[i]['Termin_Datum']) {
            firstTerminDatum = tableData[i]['Termin_Datum'];
            break;
        }
    }

    // Ensure firstTerminDatum is treated as a string
    firstTerminDatum = firstTerminDatum ? firstTerminDatum : 'unbekannt';

    // Save the PDF
	doc.save(`${firstTerminDatum}_Zuweisungen.pdf`);
	
	sortTableData();
});

function formatTime(timeString) {
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



function sortByTerminUhrzeit() {
    tableData.sort((a, b) => {
        return a.Termin_Uhrzeit.localeCompare(b.Termin_Uhrzeit);
    });
}

function sortTableData() {
    tableData.sort((a, b) => {
        // Sort by Anzahl_Termine first (1 appointment first, then more than 1)
        if (a.Anzahl_Termine === 1 && b.Anzahl_Termine > 1) {
            return -1; // a comes first
        }
        if (a.Anzahl_Termine > 1 && b.Anzahl_Termine === 1) {
            return 1; // b comes first
        }

        // Both have more than one appointment
        if (a.Anzahl_Termine > 1 && b.Anzahl_Termine > 1) {
            const patientA = String(a.Patient_Nr);
            const patientB = String(b.Patient_Nr);
            const patientComparison = patientA.localeCompare(patientB, undefined, { numeric: true });

            if (patientComparison === 0) {
                // If Patient_Nr is equal, sort by Termin_Uhrzeit
                return a.Termin_Uhrzeit.localeCompare(b.Termin_Uhrzeit);
            }
            return patientComparison; // Return the comparison of Patient_Nr
        } 
        
        // Both have exactly one appointment
        if (a.Anzahl_Termine === 1 && b.Anzahl_Termine === 1) {
            // Only sort by Termin_Uhrzeit
            return a.Termin_Uhrzeit.localeCompare(b.Termin_Uhrzeit);
        }

        // Fallback for any cases not explicitly handled (like zero appointments)
        return 0;
    });
}



