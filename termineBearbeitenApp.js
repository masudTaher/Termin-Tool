// Globale Tabellendaten. Die Zeilenindizes in den Inline-Handlern beziehen sich auf die aktuelle Reihenfolge.
let tableData = [];

// Regeln für die minimale Übersetzeranzahl
const MAX_TERMINE_PRO_UEBERSETZER = 2;
const PHYSIO_TERMIN_GEWICHT = 0.5; // Physio-Termine zählen nur halb
const UEBERSETZER_BLOCKIERUNG_STUNDEN = 3; // So lange ist ein Übersetzer nach Terminbeginn nicht verfügbar

// Künstliche Anzeigespalten, die nicht in den Daten existieren
const LFD_NR_SPALTE = "Lfd. Nr.";
const VOLLNAME_SPALTE = "Patienten_Vollname";

// Spalten, die in der Tabelle nicht angezeigt werden (Vor- und Nachname erscheinen zusammengefasst als "Patient")
const ausgeblendeteSpalten = [
    "Termin_Datum",
    "Arzt_Nr",
    "Kostengarantie Ja Nein",
    "Patienten Nr::Patienten_Status",
    "Patienten Nr::Patienten_Vorname",
    "Patienten Nr::Patienten_Name"
];

const nichtEditierbareSpalten = ["Patient_Nr", VOLLNAME_SPALTE, "Arzt Nr::Name", "Arzt Nr::Vorname", "Anzahl_Termine", "Ende"];

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
    'Anzahl_Termine': 'Anzahl Termine',
    [VOLLNAME_SPALTE]: 'Patient'
};

// Geschlecht Optionen für das Dropdown
const genderOptions = ["F : Weiblich", "M : Männlich"];

// Farbzuordnung Patient_Nr -> Hintergrundfarbe für Patienten mit mehreren Terminen
const colorMapping = {};

// Excel-Datei hochladen und verarbeiten
document.getElementById('uploadButton').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) {
        alert('Keine Datei ausgewählt. Bitte wählen Sie eine gültige Excel-Datei aus.');
        return;
    }

    leseErstesTabellenblatt(file, (firstSheet) => {
        tableData = XLSX.utils.sheet_to_json(firstSheet);

        addUebersetzerPropertyIfMissing(tableData);
        addAnzahlTerminePropertyIfMissing(tableData);

        renderTable();
    });
});

function addUebersetzerPropertyIfMissing(data) {
    data.forEach(entry => {
        if (!entry.hasOwnProperty('Übersetzer')) {
            entry['Übersetzer'] = '';
        }
    });
}

// Eine bereits vorhandene 'Anzahl_Termine'-Spalte wird nicht überschrieben
function addAnzahlTerminePropertyIfMissing(data) {
    const anzahlProPatient = zaehleTermineProPatient(data);

    data.forEach(entry => {
        if (!entry.hasOwnProperty('Anzahl_Termine')) {
            entry['Anzahl_Termine'] = anzahlProPatient[entry.Patient_Nr];
        }
    });
}

// Erzeugt eine zufällige, helle Farbe, die noch nicht verwendet wird
function generateDistinctLightColor(existingColors) {
    const goldenRatioConjugate = 0.618033988749895; // Sorgt für eine gleichmäßige Verteilung auf dem Farbkreis
    let hue = Math.random();

    while (true) {
        hue += goldenRatioConjugate;
        hue %= 1;

        // Geringe Sättigung und hohe Helligkeit ergeben helle Farben
        const saturation = 0.3 + Math.random() * 0.2; // 0.3 bis 0.5
        const value = 0.9 + Math.random() * 0.1; // 0.9 bis 1

        const rgb = hsvToRgb(hue, saturation, value);
        const color = `#${rgb.r.toString(16).padStart(2, '0')}${rgb.g.toString(16).padStart(2, '0')}${rgb.b.toString(16).padStart(2, '0')}`;

        if (!existingColors.includes(color))
            return color;
    }
}

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

function createColorMapping(data) {
    const existingColors = [];

    data.forEach(entry => {
        if (entry.Anzahl_Termine > 1 && !colorMapping[entry.Patient_Nr]) {
            const color = generateDistinctLightColor(existingColors);
            colorMapping[entry.Patient_Nr] = color;
            existingColors.push(color);
        }
    });
}

// Anzuzeigende Spalten: Datenspalten ohne ausgeblendete, plus "Patient" nach Patient_Nr und "Lfd. Nr." vorne
function ermittleAnzeigeSpalten(datenSpalten) {
    const spalten = datenSpalten.filter(header => !ausgeblendeteSpalten.includes(header));

    const patientNrIndex = spalten.indexOf("Patient_Nr");
    if (patientNrIndex !== -1) {
        spalten.splice(patientNrIndex + 1, 0, VOLLNAME_SPALTE);
    }

    spalten.unshift(LFD_NR_SPALTE);
    return spalten;
}

function renderZelle(row, rowIndex, header) {
    if (header === LFD_NR_SPALTE) {
        return `<td>${rowIndex + 1}</td>`;
    }

    const cell = row[header];

    if (header === VOLLNAME_SPALTE) {
        const fullName = `${row["Patienten Nr::Patienten_Vorname"] || ''} ${row["Patienten Nr::Patienten_Name"] || ''}`.trim();
        return `<td>${fullName}</td>`;
    }
    if (header === "Patienten Nr::Patienten_Geschlecht") {
        return `<td>${renderDropdown(cell, rowIndex, header)}</td>`;
    }
    if (header === "Termin_Uhrzeit") {
        return `<td>${renderTimeInput(cell, rowIndex, header)}</td>`;
    }

    const isEditable = !nichtEditierbareSpalten.includes(header);
    return `<td contenteditable="${isEditable}" oninput="updateCell(${rowIndex}, '${header}', this.innerText)">${cell}</td>`;
}

function renderZeile(row, rowIndex, headers) {
    const backgroundColor = (row.Anzahl_Termine > 1 && colorMapping[row.Patient_Nr]) || '';
    const rowStyle = backgroundColor ? `style="background-color: ${backgroundColor};"` : '';

    return `<tr ${rowStyle}>` + headers.map(header => renderZelle(row, rowIndex, header)).join('') + '</tr>';
}

function renderTable() {
    const tableBody = document.getElementById('tableBody');
    const tableHead = document.querySelector('#dataTable thead');

    tableBody.innerHTML = '';
    tableHead.innerHTML = '';

    if (tableData.length > 0) {
        // Vor dem Rendern sortieren, damit die Zeilenindizes der Handler zur Array-Reihenfolge passen
        sortTableData();

        // Farben nur einmal erzeugen, damit sie beim erneuten Rendern stabil bleiben
        if (Object.keys(colorMapping).length === 0) {
            createColorMapping(tableData);
        }

        const headers = ermittleAnzeigeSpalten(Object.keys(tableData[0]));

        tableHead.innerHTML = '<tr>' + headers.map(header => `<th>${headerMapping[header] || header}</th>`).join('') + '</tr>';
        tableBody.innerHTML = tableData.map((row, rowIndex) => renderZeile(row, rowIndex, headers)).join('');
    }

    setzeSektionenSichtbar(tableData.length > 0);
}

// Dropdown für das Geschlecht rendern
function renderDropdown(selectedValue, rowIndex, header) {
    // Leerzeichen um ":" nur für den Vergleich entfernen (z. B. "F  : Weiblich" aus dem Tracking-Formular)
    const normalisiere = value => value.trim().replace(/\s*:\s*/g, ":");
    const cleanedValue = normalisiere(selectedValue || "");

    const options = genderOptions.map(option => {
        const selected = normalisiere(option) === cleanedValue ? 'selected' : '';
        return `<option value="${option}" ${selected}>${option}</option>`;
    }).join('');

    const placeholder = !cleanedValue ? '<option value="" selected>Bitte wählen</option>' : '<option value="">Bitte wählen</option>';

    return `<select onchange="updateCell(${rowIndex}, '${header}', this.value)">${placeholder}${options}</select>`;
}

// Nur leere Uhrzeiten sind editierbar; vorhandene Werte werden als Text angezeigt
function renderTimeInput(selectedValue, rowIndex, header) {
    if (!selectedValue) {
        return `<input type="text" value="" onchange="validateAndUpdateTime(${rowIndex}, '${header}', this)" placeholder="HH:mm:ss" />`;
    }
    return `<span>${selectedValue}</span>`;
}

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

function updateCell(rowIndex, header, newValue) {
    tableData[rowIndex][header] = newValue;
}

// Tabelle als Excel-Datei speichern (Export nach Uhrzeit sortiert, danach wieder Anzeige-Sortierung)
document.getElementById('saveExcelButton').addEventListener('click', () => {
    sortByTerminUhrzeit();

    const worksheet = XLSX.utils.json_to_sheet(tableData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Tabelle');

    XLSX.writeFile(workbook, `${findeErstesTerminDatum(tableData)}_Zuweisungen.xlsx`);

    sortTableData();
});

document.getElementById('minUeber').addEventListener('click', () => {
    const result = berechneMinimaleUebersetzer(tableData);

    // null bedeutet: es gibt Termine ohne Uhrzeit, der Hinweis wurde bereits angezeigt
    if (result) {
        const {
            maennlicheUebersetzer,
            weiblicheUebersetzer
        } = result;
        alert(`Mindestens ${maennlicheUebersetzer} männliche Übersetzer und ${weiblicheUebersetzer} weibliche Übersetzer werden benötigt.`);
    }
});

// Greedy-Zuweisung: Termine werden nach Startzeit dem ersten freien Übersetzer gleichen Geschlechts zugeordnet,
// sonst wird ein neuer Übersetzer angelegt.
function berechneMinimaleUebersetzer(termine, maxTermineProTag = MAX_TERMINE_PRO_UEBERSETZER) {
    const ungültigeTermine = termine.filter(termin => !termin.Termin_Uhrzeit || termin.Termin_Uhrzeit.trim() === "");

    if (ungültigeTermine.length > 0) {
        alert("Es gibt Termine ohne eine gesetzte 'Uhrzeit'. Bitte überprüfen Sie alle Einträge.");
        return null;
    }

    termine.sort((a, b) => new Date(`1970-01-01T${a.Termin_Uhrzeit}`) - new Date(`1970-01-01T${b.Termin_Uhrzeit}`));

    const uebersetzerList = [];

    termine.forEach(termin => {
        const start = new Date(`1970-01-01T${termin.Termin_Uhrzeit}`);

        // Nur der erste Buchstabe (M oder F) zählt; ohne Angabe wird 'M' angenommen
        const patientenGeschlecht = termin['Patienten Nr::Patienten_Geschlecht'] ? termin['Patienten Nr::Patienten_Geschlecht'].charAt(0) : 'M';

        const passenderUebersetzer = uebersetzerList.find(uebersetzer =>
                uebersetzer.geschlecht === patientenGeschlecht &&
                start >= new Date(`1970-01-01T${convertDayFractionToTime(uebersetzer.verfuegbarAb)}`) &&
                uebersetzer.maxTermine > 0);

        if (passenderUebersetzer) {
            passenderUebersetzer.addTermin(termin);
        } else {
            const neuerUebersetzer = createNewUebersetzer(uebersetzerList.length + 1, maxTermineProTag, patientenGeschlecht);
            neuerUebersetzer.addTermin(termin);
            uebersetzerList.push(neuerUebersetzer);
        }
    });

    const maennlicheUebersetzer = uebersetzerList.filter(u => u.geschlecht === 'M').length;
    const weiblicheUebersetzer = uebersetzerList.filter(u => u.geschlecht === 'F').length;

    // Die Berechnung hat tableData nach Uhrzeit sortiert; Anzeige-Sortierung wiederherstellen
    sortTableData();

    return {
        maennlicheUebersetzer,
        weiblicheUebersetzer
    };
}

function istPhysioTermin(termin) {
    return (termin['Arzt Nr::Name'] && termin['Arzt Nr::Name'].toLowerCase().includes("physio")) ||
    (termin['Arzt Nr::Vorname'] && termin['Arzt Nr::Vorname'].toLowerCase().includes("physio"));
}

function createNewUebersetzer(index, maxTermine, geschlecht) {
    return {
        name: `Übersetzer_${index}`,
        verfuegbarAb: 0, // Bruchteil eines Tages
        maxTermine: maxTermine, // verbleibende Kapazität
        geschlecht: geschlecht,
        termine: [],
        addTermin(termin) {
            this.termine.push(termin);

            this.maxTermine -= istPhysioTermin(termin) ? PHYSIO_TERMIN_GEWICHT : 1;

            const endTime = new Date(`1970-01-01T${termin.Termin_Uhrzeit}`);
            endTime.setMinutes(endTime.getMinutes() + UEBERSETZER_BLOCKIERUNG_STUNDEN * 60);
            // Der Umweg über Stunden und Tagesbruchteile ist Teil der bestehenden Logik
            // (Sekunden werden dabei verworfen) und bleibt deshalb unverändert.
            this.verfuegbarAb = convertHoursToDayFraction(convertTimeToHours(endTime.toTimeString().split(' ')[0]));
        }
    };
}

// "HH:mm[:ss]" -> Stunden als Dezimalzahl (Sekunden werden ignoriert)
function convertTimeToHours(timeString) {
    const [hours, minutes] = timeString.split(':').map(Number);
    return hours + minutes / 60;
}

// Stunden -> Bruchteil eines Tages
function convertHoursToDayFraction(hours) {
    return hours / 24;
}

// Bruchteil eines Tages -> "HH:mm:ss" (abgerundet auf ganze Sekunden)
function convertDayFractionToTime(decimal) {
    const totalSeconds = Math.floor(decimal * 24 * 60 * 60);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return [hours, minutes, seconds]
    .map(unit => String(unit).padStart(2, '0'))
    .join(':');
}

document.getElementById('savePdfButton').addEventListener('click', () => {
    sortByTerminUhrzeit();

    if (tableData.length === 0) {
        alert("Es gibt keine zu speichernden Daten.");
        return;
    }

    const {
        jsPDF
    } = window.jspdf;
    const doc = new jsPDF('landscape');

    const headers = [["Datum", "Start", "Pat. Nr", "Patient", "Geschlecht", "Bemerkung", "Arzt", "Ort", "Übersetzer", "Notiz"]];
    const rows = tableData.map(termin => [
            termin.Termin_Datum,
            termin.Termin_Uhrzeit ? formatTime(termin.Termin_Uhrzeit) : '',
            termin.Patient_Nr,
            termin['Patienten Nr::Patienten_Vorname'] + ' ' + termin['Patienten Nr::Patienten_Name'],
            termin['Patienten Nr::Patienten_Geschlecht'] ? termin['Patienten Nr::Patienten_Geschlecht'].charAt(0) : '',
            bereinigeBemerkung(termin['Bemerkung']),
            termin['Arzt Nr::Name'],
            termin['Arzt Nr::Vorname'],
            termin.Übersetzer,
            '' // Notiz: leere Spalte für handschriftliche Notizen
        ]);

    // Feste Breite für die Spalten "Übersetzer" (8) und "Notiz" (9)
    const columnStyles = {
        8: {
            cellWidth: 30
        },
        9: {
            cellWidth: 30
        }
    };

    doc.autoTable({
        head: headers,
        body: rows,
        columnStyles: columnStyles,
    });

    doc.save(`${findeErstesTerminDatum(tableData)}_Zuweisungen.pdf`);

    sortTableData();
});

function sortByTerminUhrzeit() {
    tableData.sort((a, b) => a.Termin_Uhrzeit.localeCompare(b.Termin_Uhrzeit));
}

// Anzeige-Sortierung: zuerst Patienten mit genau einem Termin (nach Uhrzeit),
// danach Patienten mit mehreren Terminen gruppiert nach Patient_Nr (innerhalb nach Uhrzeit)
function sortTableData() {
    tableData.sort((a, b) => {
        if (a.Anzahl_Termine === 1 && b.Anzahl_Termine > 1) {
            return -1;
        }
        if (a.Anzahl_Termine > 1 && b.Anzahl_Termine === 1) {
            return 1;
        }

        if (a.Anzahl_Termine > 1 && b.Anzahl_Termine > 1) {
            const patientComparison = String(a.Patient_Nr).localeCompare(String(b.Patient_Nr), undefined, { numeric: true });
            if (patientComparison === 0) {
                return a.Termin_Uhrzeit.localeCompare(b.Termin_Uhrzeit);
            }
            return patientComparison;
        }

        if (a.Anzahl_Termine === 1 && b.Anzahl_Termine === 1) {
            return a.Termin_Uhrzeit.localeCompare(b.Termin_Uhrzeit);
        }

        // Sonstige Fälle (z. B. Anzahl_Termine fehlt oder ist 0) bleiben in ihrer Reihenfolge
        return 0;
    });
}
