let gefilterteTermine = [];
let herausgefilterteTermine = [];
let alleTermine = [];
let draggedItem = null;

function resetAttributes() {
    gefilterteTermine = [];
    herausgefilterteTermine = [];
    alleTermine = [];
    draggedItem = null;

    // Verstecke Tabellen und Aktionen
    document.querySelector('.tables-section').style.display = 'none';
    document.querySelector('.action-section').style.display = 'none';
}

// Erwartete Header (Spaltennamen)
const expectedHeaders = [
    "Termin_Datum",
    "Termin_Uhrzeit",
    "Patient_Nr",
    "Patienten Nr::Patienten_Name",
    "Arzt_Nr",
    "Arzt Nr::Name",
    "Bemerkung",
    "Kostengarantie Ja Nein",
    "Patienten Nr::Patienten_Geschlecht",
    "Patienten Nr::Patienten_Status",
    "Patienten Nr::Patienten_Vorname",
    "Arzt Nr::Vorname"
];

// Excel-Datei lesen und verarbeiten
document.getElementById('fileInput').addEventListener('change', (event) => {
    const file = event.target.files[0];

    // Überprüfe, ob eine Datei ausgewählt wurde
    if (!file) {
        const notificationDiv = document.getElementById('notification');
        notificationDiv.innerText = "Keine Datei ausgewählt. Bitte wählen Sie eine gültige Excel-Datei aus.";
        notificationDiv.style.display = 'block'; // Zeige die Fehlermeldung an

        // Fehlermeldung nach 5 Sekunden ausblenden
        setTimeout(() => {
            notificationDiv.style.display = 'none';
        }, 5000);

        resetAttributes();
        return; // Beende die Verarbeitung, da keine Datei ausgewählt wurde
    }

    // Überprüfe, ob das ausgewählte Objekt vom Typ Blob ist
    if (!(file instanceof Blob)) {
        const notificationDiv = document.getElementById('notification');
        notificationDiv.innerText = "Ungültiges Dateiformat. Bitte wählen Sie eine gültige Excel-Datei aus.";
        notificationDiv.style.display = 'block'; // Zeige die Fehlermeldung an

        // Fehlermeldung nach 5 Sekunden ausblenden
        setTimeout(() => {
            notificationDiv.style.display = 'none';
        }, 5000);

        resetAttributes();
        return; // Beende die Verarbeitung, da das Objekt nicht vom Typ Blob ist
    }

    const reader = new FileReader();

    reader.onload = function (event) {
        const data = new Uint8Array(event.target.result);
        const workbook = XLSX.read(data, {
            type: 'array'
        });

        // Die erste Tabelle auswählen
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

        // Daten in JSON-Format umwandeln
        alleTermine = XLSX.utils.sheet_to_json(firstSheet, {
            header: 1
        }); // Header einschließen

        // Prüfe die Header
        const actualHeaders = alleTermine[0]; // Erste Zeile enthält die Header

        // Fehlende Header identifizieren
        const missingHeaders = expectedHeaders.filter(header => !actualHeaders.includes(header));

        if (missingHeaders.length > 0) {
            const notificationDiv = document.getElementById('notification');
            notificationDiv.innerText = "Die Datei enthält nicht alle erforderlichen Spalten: " + missingHeaders.join(", ") + ". Bitte überprüfen Sie die Datei.";
            notificationDiv.style.display = 'block'; // Zeige die Fehlermeldung an

            // Fehlermeldung nach 5 Sekunden ausblenden
            setTimeout(() => {
                notificationDiv.style.display = 'none';
            }, 5000);

            resetAttributes();
            return; // Verarbeite die Datei nicht weiter, wenn Spalten fehlen
        }

        // Fehlermeldung ausblenden, wenn keine Spalten fehlen
        document.getElementById('notification').style.display = 'none';

        // Entferne die Header-Zeile für die weitere Verarbeitung
        alleTermine = XLSX.utils.sheet_to_json(firstSheet);

        // Filterfunktion anwenden
        filterTermine();
    };

    reader.readAsArrayBuffer(file);
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

// Funktion zur Formatierung von Excel-Zeitwerten
function formatExcelTime(decimal) {
    if (decimal === null || decimal === undefined)
        return '';

    // Berechnung der Stunden, Minuten und Sekunden
    const totalSeconds = Math.round(decimal * 24 * 60 * 60); // Rundung auf nächste Sekunde
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Schlüsselwörter für die Filterung
const filterKriterien1 = ["Hennef", "Sieg", "Bad Godesberg", "Godesberg", "Bonn", "Köln", "Wesseling", "Sankt Augustin", "Troisdorf", "Asbach"];
const filterKriterien2 = ["Mona", "Abdo", "Adel", "LM", "Flughafen Köln/Bonn", "Flughafen Düsseldorf", "Flughafen Frankfurt"];


// Filterfunktion
function filterTermine() {
    gefilterteTermine = [];
    herausgefilterteTermine = [];

    alleTermine.forEach(termin => {

        const {
            'Arzt Nr::Name': arztName,
            'Bemerkung': bemerkung,
            'Arzt Nr::Vorname': arztVorname
        } = termin;

        // Wenn im Bemerkungsfeld „Büro“ steht (unabhängig vom Ort), bleibt der Termin immer.
        const containsBueroInBemerkung = (bemerkung && bemerkung.toLowerCase().includes("büro"));
        if (containsBueroInBemerkung) {
            gefilterteTermine.push(termin); // Termin bleibt
            return; // Termin ist verarbeitet, keine weitere Prüfung erforderlich
        }

        // Wenn "Auftrag" irgendwo vorkommt, wird der Termin sofort herausgefiltert
        const containsAuftrag = (bemerkung && bemerkung.toLowerCase().includes("auftrag"));
        if (containsAuftrag) {
            herausgefilterteTermine.push(termin);
            return; // Termin wird übersprungen und nicht weiter verarbeitet
        }

        // Prüfen, ob das Wort "Flughafen" im Arzt Nr::Name vorkommt
        const containsFlughafen = arztName &&
            (arztName.toLowerCase().includes("flughafen") || arztName.toLowerCase().includes("abflug") || arztName.toLowerCase().includes("ankunft"));

        if (containsFlughafen) {

            const airportCitiesNachBleiben = ["nach bonn", "nach köln"];
            const citieMatchBleiben = airportCitiesNachBleiben.some(city => bemerkung && bemerkung.toLowerCase().includes(city));
            if (citieMatchBleiben) {
                gefilterteTermine.push(termin); // Termin bleibt
                return; // Termin ist verarbeitet, keine weitere Prüfung erforderlich
            }

            const airportCitiesNachHerausfiltern = ["nach heidelberg", "nach mannheim", "nach frankfurt", "ftt"];
            const citieMatchHerausfiltern = airportCitiesNachHerausfiltern.some(city => bemerkung && bemerkung.toLowerCase().includes(city));
            if (citieMatchHerausfiltern) {
                herausgefilterteTermine.push(termin);
                return; // Termin wird übersprungen und nicht weiter verarbeitet
            }

            // Prüfen, ob "Köln", "Bonn", "Düsseldorf" oder "Frankfurt" sowohl in Arzt Nr::Name als auch in Arzt Nr::Vorname vorkommen
            const airportCities = ["köln", "bonn", "düsseldorf", "frankfurt"];

            const nameMatch = airportCities.some(city => arztName && arztName.toLowerCase().includes(city));
            const vornameMatch = airportCities.some(city => arztVorname && arztVorname.toLowerCase().includes(city));

            if (nameMatch || vornameMatch) {
                gefilterteTermine.push(termin); // Termin bleibt, da Flughafen und die Städte gefunden wurden
                return; // Termin ist verarbeitet, keine weitere Prüfung erforderlich
            }
        }

        // Wenn eines der Filterkriterien enthalten ist, bleibt der Termin
        const match1 = filterKriterien1.some(kriterium =>
                (bemerkung && matchesCriteria1(bemerkung, kriterium)) ||
                (arztVorname && matchesCriteria1(arztVorname, kriterium)));
				
				const match2 = filterKriterien2.some(kriterium =>
                (bemerkung && matchesCriteria2(bemerkung, kriterium)) ||
                (arztVorname && matchesCriteria2(arztVorname, kriterium)));

		// Wenn ein Treffer in einer der beiden Listen gefunden wurde, bleibt der Termin
		if (match1 || match2) {
            gefilterteTermine.push(termin);
        } else {
            herausgefilterteTermine.push(termin);
        }
    });

    renderTables();
}

// Funktion für filterKriterien1 (Teilstringsuche)
function matchesCriteria1(text, kriterium) {
    return text.toLowerCase().includes(kriterium.toLowerCase());
}

// Funktion für filterKriterien2 (ganzes Wort muss übereinstimmen)
function matchesCriteria2(text, criteria) {
    const lowerCaseText = text.toLowerCase();
    const lowerCaseCriteria = criteria.toLowerCase();
	const regex = new RegExp(`(^|\\s)${lowerCaseCriteria}(\\s|$)`, 'i'); // Anpassung des Regex, um sicherzustellen, dass das Kriterium alleine steht
    return regex.test(lowerCaseText);
}

// Mapping für Header-Namen, die anders dargestellt werden sollen
const headerMapping = {
    'Termin_Datum': 'Datum',
    'Termin_Uhrzeit': 'Uhrzeit',
    'Patient_Nr': 'Pat. Nr',
    'Arzt_Nr': 'Arzt Nr',
    'Kostengarantie Ja Nein': 'Kostengarantie',
    'Patienten Nr::Patienten_Name': 'Pat. Name',
    'Patienten Nr::Patienten_Geschlecht': 'Pat. Geschlecht',
    'Arzt Nr::Name': 'Arzt Name',
    'Patienten Nr::Patienten_Status': 'Pat. Status',
    'Patienten Nr::Patienten_Vorname': 'Pat. Vorname',
    'Arzt Nr::Vorname': 'Ort',
};

function renderTables() {
    const gefiltertTbody = document.querySelector('#gefiltert-tabelle tbody');
    const entferntTbody = document.querySelector('#entfernt-tabelle tbody');
    const tablesSection = document.querySelector('.tables-section');
    const actionSection = document.querySelector('.action-section');

    gefiltertTbody.innerHTML = '';
    entferntTbody.innerHTML = '';

    console.log('Gefilterte Termine:', gefilterteTermine);
    console.log('Herausgefilterte Termine:', herausgefilterteTermine);

// Fülle die gefilterte Tabelle, wenn es Einträge gibt
gefilterteTermine.forEach((termin, index) => {
    gefiltertTbody.innerHTML += `
      <tr draggable="true" ondragstart="drag(event, 'gefiltert', ${index})">
        <td>${formatExcelTime(termin['Termin_Uhrzeit'])}</td>
        <td>${(termin['Patienten Nr::Patienten_Vorname'] || '') + (termin['Patienten Nr::Patienten_Name'] || '')}</td>
        <td>${termin['Arzt Nr::Name'] !== undefined ? termin['Arzt Nr::Name'] : ''}</td>
        <td>${termin['Bemerkung'] || ''}</td>
        <td>${termin['Arzt Nr::Vorname'] !== undefined ? termin['Arzt Nr::Vorname'] : ''}</td>
      </tr>
    `;
});

// Fülle die entfernte Tabelle, wenn es Einträge gibt
herausgefilterteTermine.forEach((termin, index) => {
    entferntTbody.innerHTML += `
      <tr draggable="true" ondragstart="drag(event, 'entfernt', ${index})">
        <td>${formatExcelTime(termin['Termin_Uhrzeit'])}</td>
        <td>${(termin['Patienten Nr::Patienten_Vorname'] || '') + (termin['Patienten Nr::Patienten_Name'] || '')}</td>
        <td>${termin['Arzt Nr::Name'] !== undefined ? termin['Arzt Nr::Name'] : ''}</td>
        <td>${termin['Bemerkung'] || ''}</td>
        <td>${termin['Arzt Nr::Vorname'] !== undefined ? termin['Arzt Nr::Vorname'] : ''}</td>
      </tr>
    `;
});

    // Sichtbarkeit basierend auf der Anzahl der Einträge festlegen
    if (gefilterteTermine.length > 0 || herausgefilterteTermine.length > 0) {
        tablesSection.style.display = 'flex';
        actionSection.style.display = 'block';
    } else {
        tablesSection.style.display = 'none';
        actionSection.style.display = 'none';
    }
}



// Drag-and-Drop Funktionen
function allowDrop(event) {
    event.preventDefault();
}

function drag(event, sourceTable, index) {
    draggedItem = {
        sourceTable,
        index
    };
}

function drop(event, targetTable) {
    event.preventDefault();
    if (draggedItem) {
        if (draggedItem.sourceTable === 'gefiltert' && targetTable === 'entfernt') {
            const movedItem = gefilterteTermine.splice(draggedItem.index, 1)[0];
            herausgefilterteTermine.push(movedItem);
        } else if (draggedItem.sourceTable === 'entfernt' && targetTable === 'gefiltert') {
            const movedItem = herausgefilterteTermine.splice(draggedItem.index, 1)[0];
            gefilterteTermine.push(movedItem);
        }

        renderTables();
        draggedItem = null;
    }
}

function saveToExcel() {
    const newWorkbook = XLSX.utils.book_new();

    // Spaltenreihenfolge festlegen
    const headers = [
        'Termin_Datum',
        'Termin_Uhrzeit',
        'Patient_Nr',
        'Patienten Nr::Patienten_Name',
        'Arzt_Nr',
        'Arzt Nr::Name',
        'Bemerkung',
        'Kostengarantie Ja Nein',
        'Patienten Nr::Patienten_Geschlecht',
        'Patienten Nr::Patienten_Status',
        'Patienten Nr::Patienten_Vorname',
        'Arzt Nr::Vorname'
    ];

    function formatData(data) {
        return data.map(row => {
            return {
                'Termin_Datum': formatExcelDate(row['Termin_Datum']),
                'Termin_Uhrzeit': formatExcelTime(row['Termin_Uhrzeit']),
                'Patient_Nr': row['Patient_Nr'],
                'Patienten Nr::Patienten_Name': row['Patienten Nr::Patienten_Name'],
                'Arzt_Nr': row['Arzt_Nr'],
                'Arzt Nr::Name': row['Arzt Nr::Name'],
                'Bemerkung': row['Bemerkung'] || '',
                'Kostengarantie Ja Nein': row['Kostengarantie Ja Nein'],
                'Patienten Nr::Patienten_Geschlecht': row['Patienten Nr::Patienten_Geschlecht'],
                'Patienten Nr::Patienten_Status': row['Patienten Nr::Patienten_Status'],
                'Patienten Nr::Patienten_Vorname': row['Patienten Nr::Patienten_Vorname'],
                'Arzt Nr::Vorname': row['Arzt Nr::Vorname']
            };
        }).sort((a, b) => {
            // Uhrzeiten extrahieren
            const timeA = a['Termin_Uhrzeit'] ? new Date(`1970-01-01T${a['Termin_Uhrzeit']}Z`).getTime() : -Infinity;
            const timeB = b['Termin_Uhrzeit'] ? new Date(`1970-01-01T${b['Termin_Uhrzeit']}Z`).getTime() : -Infinity;
            return timeA - timeB;
        });
    }

    const formattedGefilterteTermine = formatData(gefilterteTermine);
    const formattedHerausgefilterteTermine = formatData(herausgefilterteTermine);

    // Spaltenreihenfolge beibehalten
    const gefilterteSheet = XLSX.utils.json_to_sheet(formattedGefilterteTermine, {
        header: headers
    });
    const entfernteSheet = XLSX.utils.json_to_sheet(formattedHerausgefilterteTermine, {
        header: headers
    });

    // Funktion zum automatischen Anpassen der Spaltenbreite
    function adjustColumnWidths(sheet) {
        const columns = {};
        sheet['!cols'] = [];
        for (const key in sheet) {
            if (sheet.hasOwnProperty(key) && key[0] !== '!') {
                const cell = sheet[key];
                const col = key.match(/^[A-Z]+/)[0];
                if (!columns[col])
                    columns[col] = [];
                columns[col].push(cell.v ? cell.v.toString().length : 0);
            }
        }
        for (const col in columns) {
            if (columns.hasOwnProperty(col)) {
                const maxLength = Math.max(...columns[col]) + 2; // 2 extra characters for padding
                sheet['!cols'].push({
                    wch: maxLength
                });
            }
        }
    }

    adjustColumnWidths(gefilterteSheet);
    adjustColumnWidths(entfernteSheet);

    // Blätter hinzufügen
    XLSX.utils.book_append_sheet(newWorkbook, gefilterteSheet, 'Gefilterte Termine');
    XLSX.utils.book_append_sheet(newWorkbook, entfernteSheet, 'Entfernte Termine');


	// Find the first non-empty 'Termin_Datum'
    let firstTerminDatum = 'unbekannt';
    for (let i = 0; i < alleTermine.length; i++) {
        if (alleTermine[i]['Termin_Datum']) {
            firstTerminDatum = alleTermine[i]['Termin_Datum'];
            break;
        }
    }

    // Ensure firstTerminDatum is treated as a string
    firstTerminDatum = firstTerminDatum ? String(formatExcelDate(firstTerminDatum)) : 'unbekannt';
    const formattedDate = firstTerminDatum.replace(/[/\s:]/g, '-'); // Replace invalid filename characters

    // Save the file with the first non-empty 'Termin_Datum' as the filename
    XLSX.writeFile(newWorkbook, `${formattedDate}_gefilterte_Termine.xlsx`);
}