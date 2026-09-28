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

    // Erlaubt, dieselbe Datei später erneut auszuwählen.
    event.target.value = '';

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

    if (typeof XLSX === 'undefined') {
        showWorkflowStatus('Die Excel-Funktion konnte nicht geladen werden. Bitte prüfe die Internetverbindung und lade die Seite erneut.', 'error');
        resetAttributes();
        return;
    }

    showWorkflowStatus(`${file.name} wird geprüft …`);
    const reader = new FileReader();

    reader.onload = function (event) {
        try {
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

        if (!Array.isArray(actualHeaders)) {
            resetAttributes();
            showWorkflowStatus('Die erste Tabelle in der Excel-Datei ist leer.', 'error');
            return;
        }

        // Fehlende Header identifizieren
        const missingHeaders = expectedHeaders.filter(header => !actualHeaders.includes(header));

        if (missingHeaders.length > 0) {
            const notificationDiv = document.getElementById('notification');
            notificationDiv.innerText = "Die Datei enthält nicht alle erforderlichen Spalten: " + missingHeaders.join(", ") + ". Bitte überprüfen Sie die Datei.";
            notificationDiv.style.display = 'block'; // Zeige die Fehlermeldung an
            showWorkflowStatus('In der Datei fehlen benötigte Spalten: ' + missingHeaders.join(', '), 'error');

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
        alleTermine = normalizeTerminRecords(XLSX.utils.sheet_to_json(firstSheet));
        // Eine neu hochgeladene Datei beginnt einen frischen Filterlauf.
        saveTerminWorkflow({ step: 'filtern' });

        // Filterfunktion anwenden
        filterTermine();
        } catch (error) {
            console.error('Fehler beim Einlesen der Excel-Datei:', error);
            resetAttributes();
            showWorkflowStatus('Die Excel-Datei konnte nicht verarbeitet werden. Prüfe, ob es der aktuelle FileMaker-Export ist und die Datei nicht beschädigt ist.', 'error');
        }
    };

    reader.onerror = () => {
        resetAttributes();
        showWorkflowStatus('Die Excel-Datei konnte nicht gelesen werden. Bitte wähle sie erneut aus.', 'error');
    };

    reader.readAsArrayBuffer(file);
});

// Funktion zur Formatierung von Excel-Daten als Datum
function formatExcelDate(serial) {
    return normalizeTerminDatum(serial);
}

// Funktion zur Formatierung von Excel-Zeitwerten
function formatExcelTime(value) {
    return normalizeTerminUhrzeit(value);
}

// Filterregeln lassen sich in der Oberfläche anpassen und bleiben lokal auf diesem PC.
const FILTER_RULES_STORAGE_KEY = 'terminTool.filterRules.v1';
const defaultFilterRules = {
    alwaysKeep: ['Büro'],
    alwaysExclude: ['Auftrag'],
    includeContains: ['Hennef', 'Sieg', 'Bad Godesberg', 'Godesberg', 'Bonn', 'Köln', 'Wesseling', 'Sankt Augustin', 'Troisdorf', 'Asbach'],
    includeWholeWords: ['Mona', 'Abdo', 'Adel', 'LM', 'Flughafen Köln/Bonn', 'Flughafen Düsseldorf', 'Flughafen Frankfurt']
};
const filterRuleGroups = Object.keys(defaultFilterRules);

function readFilterRules() {
    try {
        const saved = JSON.parse(localStorage.getItem(FILTER_RULES_STORAGE_KEY) || '{}');
        return Object.fromEntries(filterRuleGroups.map(group => {
            const values = Array.isArray(saved[group]) ? saved[group] : defaultFilterRules[group];
            const cleaned = [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 100);
            return [group, cleaned];
        }));
    } catch (error) {
        return Object.fromEntries(filterRuleGroups.map(group => [group, [...defaultFilterRules[group]]]));
    }
}

let filterRules = readFilterRules();

function saveFilterRules() {
    try {
        localStorage.setItem(FILTER_RULES_STORAGE_KEY, JSON.stringify(filterRules));
        return true;
    } catch (error) {
        const status = document.getElementById('filterRuleStatus');
        if (status) status.textContent = 'Regeln konnten in diesem Browser nicht gespeichert werden.';
        return false;
    }
}

function renderFilterRules() {
    filterRuleGroups.forEach(group => {
        const list = document.getElementById(`${group}Rules`);
        if (!list) return;
        list.replaceChildren();
        filterRules[group].forEach(rule => {
            const chip = document.createElement('span');
            chip.className = 'rule-chip';
            const label = document.createElement('span');
            label.textContent = rule;
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = '×';
            remove.title = `Regel „${rule}“ entfernen`;
            remove.setAttribute('aria-label', `Regel „${rule}“ entfernen`);
            remove.dataset.removeRule = group;
            remove.dataset.rule = rule;
            chip.append(label, remove);
            list.append(chip);
        });
    });
}

function addFilterRule(group) {
    if (!filterRuleGroups.includes(group)) return;
    const input = document.getElementById(`${group}Input`);
    const rule = input?.value.trim();
    const status = document.getElementById('filterRuleStatus');
    if (!rule) {
        status.textContent = 'Gib zuerst einen Begriff ein.';
        input?.focus();
        return;
    }
    if (filterRules[group].some(existing => existing.toLocaleLowerCase('de-DE') === rule.toLocaleLowerCase('de-DE'))) {
        status.textContent = 'Diese Regel ist bereits vorhanden.';
        input.focus();
        return;
    }
    if (filterRules[group].length >= 100) {
        status.textContent = 'Pro Regelgruppe sind höchstens 100 Begriffe möglich.';
        return;
    }
    filterRules[group].push(rule);
    input.value = '';
    renderFilterRules();
    if (saveFilterRules()) status.textContent = 'Regel gespeichert. Klicke auf „Auf aktuelle Datei anwenden“, wenn du sie sofort nutzen möchtest.';
}

document.querySelectorAll('[data-add-rule]').forEach(button => {
    button.addEventListener('click', () => addFilterRule(button.dataset.addRule));
});
document.querySelectorAll('.rule-add input').forEach(input => {
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
            event.preventDefault();
            const group = input.id.replace(/Input$/, '');
            addFilterRule(group);
        }
    });
});
document.getElementById('filterRulesPanel')?.addEventListener('click', event => {
    const button = event.target.closest('[data-remove-rule]');
    if (!button) return;
    const group = button.dataset.removeRule;
    filterRules[group] = filterRules[group].filter(rule => rule !== button.dataset.rule);
    renderFilterRules();
    if (saveFilterRules()) document.getElementById('filterRuleStatus').textContent = 'Regel entfernt. Nutze „Auf aktuelle Datei anwenden“, um die Liste neu zu berechnen.';
});
document.getElementById('reapplyFilterRules')?.addEventListener('click', () => {
    if (alleTermine.length === 0) {
        document.getElementById('filterRuleStatus').textContent = 'Lade zuerst eine Excel-Datei.';
        return;
    }
    filterTermine();
    document.getElementById('filterRuleStatus').textContent = 'Die aktuelle Datei wurde mit den gespeicherten Regeln neu gefiltert.';
});
document.getElementById('resetFilterRules')?.addEventListener('click', () => {
    filterRules = Object.fromEntries(filterRuleGroups.map(group => [group, [...defaultFilterRules[group]]]));
    renderFilterRules();
    if (saveFilterRules()) document.getElementById('filterRuleStatus').textContent = 'Standardregeln wiederhergestellt. Klicke auf „Auf aktuelle Datei anwenden“, um neu zu filtern.';
});

renderFilterRules();


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
        const bemerkungText = String(bemerkung || '');
        const containsBueroInBemerkung = filterRules.alwaysKeep.some(rule =>
            bemerkungText.toLocaleLowerCase('de-DE').includes(rule.toLocaleLowerCase('de-DE'))
        );
        if (containsBueroInBemerkung) {
            gefilterteTermine.push(termin); // Termin bleibt
            return; // Termin ist verarbeitet, keine weitere Prüfung erforderlich
        }

        // Wenn "Auftrag" irgendwo vorkommt, wird der Termin sofort herausgefiltert
        const containsAuftrag = filterRules.alwaysExclude.some(rule =>
            bemerkungText.toLocaleLowerCase('de-DE').includes(rule.toLocaleLowerCase('de-DE'))
        );
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
        const match1 = filterRules.includeContains.some(kriterium =>
                (bemerkung && matchesCriteria1(bemerkung, kriterium)) ||
                (arztVorname && matchesCriteria1(arztVorname, kriterium)));
				
				const match2 = filterRules.includeWholeWords.some(kriterium =>
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
    const lowerCaseText = String(text || '').toLocaleLowerCase('de-DE');
    const lowerCaseCriteria = String(criteria || '').toLocaleLowerCase('de-DE');
    const escapedCriteria = lowerCaseCriteria.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const regex = new RegExp(`(^|\\s)${escapedCriteria}(\\s|$)`, 'i');
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

// Fülle die gefilterte Tabelle, wenn es Einträge gibt
gefilterteTermine.forEach((termin, index) => {
    gefiltertTbody.innerHTML += `
      <tr draggable="true" ondragstart="drag(event, 'gefiltert', ${index})">
        <td>${escapeHtml(formatExcelTime(termin['Termin_Uhrzeit']))}</td>
        <td>${escapeHtml((termin['Patienten Nr::Patienten_Vorname'] || '') + (termin['Patienten Nr::Patienten_Name'] || ''))}</td>
        <td>${escapeHtml(termin['Arzt Nr::Name'] ?? '')}</td>
        <td>${escapeHtml(termin['Bemerkung'] || '')}</td>
        <td>${escapeHtml(termin['Arzt Nr::Vorname'] ?? '')}</td>
      </tr>
    `;
});

// Fülle die entfernte Tabelle, wenn es Einträge gibt
herausgefilterteTermine.forEach((termin, index) => {
    entferntTbody.innerHTML += `
      <tr draggable="true" ondragstart="drag(event, 'entfernt', ${index})">
        <td>${escapeHtml(formatExcelTime(termin['Termin_Uhrzeit']))}</td>
        <td>${escapeHtml((termin['Patienten Nr::Patienten_Vorname'] || '') + (termin['Patienten Nr::Patienten_Name'] || ''))}</td>
        <td>${escapeHtml(termin['Arzt Nr::Name'] ?? '')}</td>
        <td>${escapeHtml(termin['Bemerkung'] || '')}</td>
        <td>${escapeHtml(termin['Arzt Nr::Vorname'] ?? '')}</td>
      </tr>
    `;
});

    // Sichtbarkeit basierend auf der Anzahl der Einträge festlegen
    if (gefilterteTermine.length > 0 || herausgefilterteTermine.length > 0) {
        tablesSection.style.display = 'grid';
        actionSection.style.display = 'flex';
    } else {
        tablesSection.style.display = 'none';
        actionSection.style.display = 'none';
    }

    const workflow = readTerminWorkflow();
    const keepLaterStep = ['bearbeiten', 'tracking'].includes(workflow.step) && Array.isArray(workflow.records);
    const saved = saveTerminWorkflow({
        records: keepLaterStep ? workflow.records : gefilterteTermine,
        filtered: gefilterteTermine,
        removed: herausgefilterteTermine,
        step: keepLaterStep ? workflow.step : 'filtern'
    });
    if (saved) {
        showWorkflowStatus(`${gefilterteTermine.length} Termine bleiben im Ablauf, ${herausgefilterteTermine.length} wurden herausgefiltert. Änderungen werden in diesem Browser-Tab zwischengespeichert.`);
    } else {
        showWorkflowStatus('Der Browser konnte den Arbeitsstand nicht zwischenspeichern. Bitte lade vor dem Seitenwechsel die Excel-Datei herunter.', 'error');
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

function continueToBearbeiten() {
    if (alleTermine.length === 0) {
        showWorkflowStatus('Bitte lade zuerst eine Excel-Datei mit Terminen.', 'error');
        return;
    }

    const saved = persistTerminRecords(gefilterteTermine, 'bearbeiten', {
        filtered: gefilterteTermine,
        removed: herausgefilterteTermine
    });
    if (saved) window.location.href = 'termineBearbeiten.html';
}

function restoreFilterSession() {
    const workflow = readTerminWorkflow();
    if (!Array.isArray(workflow.filtered) && !Array.isArray(workflow.removed)) return;

    gefilterteTermine = Array.isArray(workflow.filtered) ? workflow.filtered : [];
    herausgefilterteTermine = Array.isArray(workflow.removed) ? workflow.removed : [];
    alleTermine = [...gefilterteTermine, ...herausgefilterteTermine];
    renderTables();
}

restoreFilterSession();

function saveToExcel() {
    const newWorkbook = XLSX.utils.book_new();

    // Die bekannten Terminspalten bleiben vorne. Kontaktangaben aus dem
    // FileMaker-Export werden zusätzlich mitgespeichert, damit sie im
    // Bearbeitungs- und Tracking-Schritt noch für WhatsApp verfügbar sind.
    const baseHeaders = [
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

    const sourceHeaders = [...new Set([
        ...gefilterteTermine,
        ...herausgefilterteTermine
    ].flatMap(row => Object.keys(row || {})))];
    const contactHeaderPattern = /anschrift|adresse|strasse|hausnummer|plz|postleitzahl|postal|zip|ort|stadt|city|telefon|rufnummer|phone|handy|mobil|mobile|cell/;
    const personHeaderPattern = /patient|arzt|praxis/;
    const contactHeaders = sourceHeaders.filter(header => {
        const normalized = String(header || '')
            .toLocaleLowerCase('de-DE')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]/g, '');
        return (personHeaderPattern.test(normalized) && contactHeaderPattern.test(normalized)) || normalized === 'ubersetzer';
    });
    const headers = [...baseHeaders, ...contactHeaders.filter(header => !baseHeaders.includes(header))];

    function formatData(data) {
        return data.map(row => {
            const formattedRow = {
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
            contactHeaders.forEach(header => {
                formattedRow[header] = row[header] ?? '';
            });
            return formattedRow;
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
