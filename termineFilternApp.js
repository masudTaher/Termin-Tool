let gefilterteTermine = [];
let herausgefilterteTermine = [];
let alleTermine = [];
let draggedItem = null;

// Erwartete Spalten des Rohdaten-Exports. Die Reihenfolge ist zugleich die Spaltenreihenfolge beim Speichern.
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

const NOTIFICATION_DAUER_MS = 5000;

// Schlüsselwörter für die Filterung (geprüft gegen Bemerkung und Ort)
const filterKriterienTeilstring = ["Hennef", "Sieg", "Bad Godesberg", "Godesberg", "Bonn", "Köln", "Wesseling", "Sankt Augustin", "Troisdorf", "Asbach"];
const filterKriterienGanzesWort = ["Mona", "Abdo", "Adel", "LM", "Flughafen Köln/Bonn", "Flughafen Düsseldorf", "Flughafen Frankfurt"];

// Flughafen-Regeln greifen nur, wenn "Arzt Nr::Name" einen dieser Begriffe enthält
const flughafenBegriffe = ["flughafen", "abflug", "ankunft"];
const flughafenZieleBleiben = ["nach bonn", "nach köln"];
const flughafenZieleEntfernen = ["nach heidelberg", "nach mannheim", "nach frankfurt", "ftt"];
const flughafenStaedte = ["köln", "bonn", "düsseldorf", "frankfurt"];

function resetAttributes() {
    gefilterteTermine = [];
    herausgefilterteTermine = [];
    alleTermine = [];
    draggedItem = null;

    setzeSektionenSichtbar(false);
}

function zeigeFehlermeldung(text) {
    const notificationDiv = document.getElementById('notification');
    notificationDiv.innerText = text;
    notificationDiv.style.display = 'block';

    setTimeout(() => {
        notificationDiv.style.display = 'none';
    }, NOTIFICATION_DAUER_MS);

    resetAttributes();
}

// Excel-Datei lesen und verarbeiten
document.getElementById('fileInput').addEventListener('change', (event) => {
    const file = event.target.files[0];

    if (!file) {
        zeigeFehlermeldung("Keine Datei ausgewählt. Bitte wählen Sie eine gültige Excel-Datei aus.");
        return;
    }

    if (!(file instanceof Blob)) {
        zeigeFehlermeldung("Ungültiges Dateiformat. Bitte wählen Sie eine gültige Excel-Datei aus.");
        return;
    }

    leseErstesTabellenblatt(file, (firstSheet) => {
        // Zuerst als Array von Zeilen lesen, um die Header (erste Zeile) prüfen zu können
        alleTermine = XLSX.utils.sheet_to_json(firstSheet, {
            header: 1
        });

        const actualHeaders = alleTermine[0];
        const missingHeaders = expectedHeaders.filter(header => !actualHeaders.includes(header));

        if (missingHeaders.length > 0) {
            zeigeFehlermeldung("Die Datei enthält nicht alle erforderlichen Spalten: " + missingHeaders.join(", ") + ". Bitte überprüfen Sie die Datei.");
            return;
        }

        document.getElementById('notification').style.display = 'none';

        // Erneut als Objekte (Header als Schlüssel) lesen
        alleTermine = XLSX.utils.sheet_to_json(firstSheet);

        filterTermine();
    });
});

// Wandelt eine Excel-Datums-Seriennummer in einen de-DE-Datumsstring (d.m.yyyy) um
function formatExcelDate(serial) {
    if (serial === null || serial === undefined)
        return '';
    const utcDays = Math.floor(serial) - 25569; // 25569 = Tage zwischen Excel-Epoche (1900) und Unix-Epoche (1970)
    const date = new Date(utcDays * 86400 * 1000);
    return date.toLocaleDateString('de-DE');
}

// Wandelt einen Excel-Zeitwert (Bruchteil eines Tages) in "HH:mm:ss" um
function formatExcelTime(decimal) {
    if (decimal === null || decimal === undefined)
        return '';

    const totalSeconds = Math.round(decimal * 24 * 60 * 60); // Rundung auf nächste Sekunde
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Teilstringsuche ohne Beachtung der Groß-/Kleinschreibung; leere Felder sind nie ein Treffer
function enthaeltTeilstring(text, kriterium) {
    return Boolean(text) && text.toLowerCase().includes(kriterium.toLowerCase());
}

// Das Kriterium muss als ganzes Wort (durch Leerzeichen oder Textanfang/-ende begrenzt) vorkommen
function enthaeltGanzesWort(text, kriterium) {
    if (!text)
        return false;
    const regex = new RegExp(`(^|\\s)${kriterium.toLowerCase()}(\\s|$)`, 'i');
    return regex.test(text.toLowerCase());
}

// Entscheidet, ob ein Termin bleibt (true) oder entfernt wird (false).
// Die Regeln werden in fester Reihenfolge geprüft; die erste zutreffende Regel entscheidet.
function bleibtTermin(termin) {
    const {
        'Arzt Nr::Name': arztName,
        'Bemerkung': bemerkung,
        'Arzt Nr::Vorname': ort
    } = termin;

    // „Büro“ in der Bemerkung: Termin bleibt immer, unabhängig vom Ort
    if (enthaeltTeilstring(bemerkung, "büro"))
        return true;

    // „Auftrag“ in der Bemerkung: Termin wird immer entfernt
    if (enthaeltTeilstring(bemerkung, "auftrag"))
        return false;

    if (flughafenBegriffe.some(begriff => enthaeltTeilstring(arztName, begriff))) {
        if (flughafenZieleBleiben.some(ziel => enthaeltTeilstring(bemerkung, ziel)))
            return true;

        if (flughafenZieleEntfernen.some(ziel => enthaeltTeilstring(bemerkung, ziel)))
            return false;

        // Beide Prüfungen werden bewusst vollständig ausgewertet (wie im ursprünglichen Ablauf)
        const nameMatch = flughafenStaedte.some(stadt => enthaeltTeilstring(arztName, stadt));
        const ortMatch = flughafenStaedte.some(stadt => enthaeltTeilstring(ort, stadt));
        if (nameMatch || ortMatch)
            return true;
    }

    // Termin bleibt, wenn eines der Filterkriterien in Bemerkung oder Ort vorkommt
    const matchTeilstring = filterKriterienTeilstring.some(kriterium =>
            enthaeltTeilstring(bemerkung, kriterium) || enthaeltTeilstring(ort, kriterium));
    const matchGanzesWort = filterKriterienGanzesWort.some(kriterium =>
            enthaeltGanzesWort(bemerkung, kriterium) || enthaeltGanzesWort(ort, kriterium));

    return matchTeilstring || matchGanzesWort;
}

function filterTermine() {
    gefilterteTermine = [];
    herausgefilterteTermine = [];

    alleTermine.forEach(termin => {
        if (bleibtTermin(termin)) {
            gefilterteTermine.push(termin);
        } else {
            herausgefilterteTermine.push(termin);
        }
    });

    renderTables();
}

// Der Index im ondragstart-Handler bezieht sich auf die aktuelle Position im jeweiligen Array
function renderTerminZeile(termin, tabelle, index) {
    return `
      <tr draggable="true" ondragstart="drag(event, '${tabelle}', ${index})">
        <td>${formatExcelTime(termin['Termin_Uhrzeit'])}</td>
        <td>${(termin['Patienten Nr::Patienten_Vorname'] || '') + (termin['Patienten Nr::Patienten_Name'] || '')}</td>
        <td>${termin['Arzt Nr::Name'] !== undefined ? termin['Arzt Nr::Name'] : ''}</td>
        <td>${termin['Bemerkung'] || ''}</td>
        <td>${termin['Arzt Nr::Vorname'] !== undefined ? termin['Arzt Nr::Vorname'] : ''}</td>
      </tr>
    `;
}

function renderTables() {
    document.getElementById('gefiltert-tbody').innerHTML =
        gefilterteTermine.map((termin, index) => renderTerminZeile(termin, 'gefiltert', index)).join('');
    document.getElementById('entfernt-tbody').innerHTML =
        herausgefilterteTermine.map((termin, index) => renderTerminZeile(termin, 'entfernt', index)).join('');

    setzeSektionenSichtbar(gefilterteTermine.length > 0 || herausgefilterteTermine.length > 0);
}

// Drag-and-Drop Funktionen (werden über Inline-Handler im HTML aufgerufen)
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
    if (!draggedItem)
        return;

    if (draggedItem.sourceTable === 'gefiltert' && targetTable === 'entfernt') {
        herausgefilterteTermine.push(gefilterteTermine.splice(draggedItem.index, 1)[0]);
    } else if (draggedItem.sourceTable === 'entfernt' && targetTable === 'gefiltert') {
        gefilterteTermine.push(herausgefilterteTermine.splice(draggedItem.index, 1)[0]);
    }

    renderTables();
    draggedItem = null;
}

// Wandelt Datum und Uhrzeit von Excel-Seriennummern in Strings um (d.m.yyyy / HH:mm:ss),
// die von "Termine Bearbeiten" und "Termine Tracking" erwartet werden, und sortiert nach Uhrzeit
function formatiereFuerExport(termine) {
    return termine.map(row => {
        const zeile = {};
        expectedHeaders.forEach(header => {
            zeile[header] = row[header];
        });
        zeile['Termin_Datum'] = formatExcelDate(row['Termin_Datum']);
        zeile['Termin_Uhrzeit'] = formatExcelTime(row['Termin_Uhrzeit']);
        zeile['Bemerkung'] = row['Bemerkung'] || '';
        return zeile;
    }).sort((a, b) => {
        const timeA = a['Termin_Uhrzeit'] ? new Date(`1970-01-01T${a['Termin_Uhrzeit']}Z`).getTime() : -Infinity;
        const timeB = b['Termin_Uhrzeit'] ? new Date(`1970-01-01T${b['Termin_Uhrzeit']}Z`).getTime() : -Infinity;
        return timeA - timeB;
    });
}

// Spaltenbreite an den längsten Zellinhalt anpassen
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
            sheet['!cols'].push({
                wch: Math.max(...columns[col]) + 2 // 2 Zeichen Innenabstand
            });
        }
    }
}

function erstelleSheet(termine) {
    const sheet = XLSX.utils.json_to_sheet(formatiereFuerExport(termine), {
        header: expectedHeaders
    });
    adjustColumnWidths(sheet);
    return sheet;
}

function saveToExcel() {
    const newWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(newWorkbook, erstelleSheet(gefilterteTermine), 'Gefilterte Termine');
    XLSX.utils.book_append_sheet(newWorkbook, erstelleSheet(herausgefilterteTermine), 'Entfernte Termine');

    // Das Rohdatum ist eine Excel-Seriennummer und wird für den Dateinamen formatiert.
    // Hinweis: Auch der Fallback 'unbekannt' durchläuft formatExcelDate (bestehendes Verhalten).
    const erstesDatum = String(formatExcelDate(findeErstesTerminDatum(alleTermine)));
    const formattedDate = erstesDatum.replace(/[/\s:]/g, '-'); // Im Dateinamen ungültige Zeichen ersetzen

    XLSX.writeFile(newWorkbook, `${formattedDate}_gefilterte_Termine.xlsx`);
}
