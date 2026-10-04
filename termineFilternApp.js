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
    "Patienten Nr::Patienten_Vorname"
];

// Excel-Datei lesen und verarbeiten
document.getElementById('fileInput').addEventListener('change', (event) => {
    const file = event.target.files[0];

    // Überprüfe, ob eine Datei ausgewählt wurde
    if (!file) {
        const notificationDiv = document.getElementById('notification');
        notificationDiv.innerText = "Keine Datei ausgewählt. Bitte wähle eine gültige Excel-Datei aus.";
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
        notificationDiv.innerText = "Ungültiges Dateiformat. Bitte wähle eine gültige Excel-Datei aus.";
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
        const hasAppointmentLocation = ["Arzt Nr::Ort", "Arzt Nr::Stadt", "Ort", "Termin_Ort", "Stadt"]
            .some(header => actualHeaders.includes(header));
        if (!hasAppointmentLocation) missingHeaders.push("Arzt Nr::Ort (oder Ort / Stadt)");

        if (missingHeaders.length > 0) {
            const notificationDiv = document.getElementById('notification');
            notificationDiv.innerText = "Die Datei enthält nicht alle erforderlichen Spalten: " + missingHeaders.join(", ") + ". Bitte prüfe die Datei.";
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
        // Jeder Termin bekommt eine feste interne Kennung, damit das Live-Tracking ihn wiedererkennt.
        const importStamp = Date.now().toString(36);
        alleTermine.forEach((termin, index) => { termin._src = `${importStamp}-${index}`; });
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
// Stand der Regeln. Bei einer neuen Nummer werden gespeicherte Regeln einmalig angepasst.
const FILTER_RULES_VERSION = 2;
const defaultFilterRules = {
    alwaysKeep: ['Büro'],
    alwaysExclude: ['Auftrag'],
    includeContains: ['Hennef', 'Sieg', 'Bad Godesberg', 'Godesberg', 'Bonn', 'Köln', 'Wesseling', 'Sankt Augustin', 'Troisdorf', 'Asbach', 'Ahrweiler', 'Neuenahr', 'Remagen', 'Andernach'],
    includeWholeWords: ['Abdo', 'Adel', 'LM']
};
const filterRuleGroups = Object.keys(defaultFilterRules);
const sameRule = (left, right) => String(left).toLocaleLowerCase('de-DE') === String(right).toLocaleLowerCase('de-DE');

// Version 2: „Mona“ allein zählt nicht mehr (nur zusammen mit einem Ort der Region oder „Büro“),
// Flughäfen zählen nur noch mit „Büro“, Ahrweiler/Remagen/Andernach gehören zur Region.
function migrateFilterRules(rules) {
    const droppedWords = ['Mona', 'Flughafen Köln/Bonn', 'Flughafen Düsseldorf', 'Flughafen Frankfurt'];
    rules.includeWholeWords = rules.includeWholeWords.filter(rule => !droppedWords.some(word => sameRule(word, rule)));
    ['Ahrweiler', 'Neuenahr', 'Remagen', 'Andernach'].forEach(place => {
        if (!rules.includeContains.some(rule => sameRule(rule, place))) rules.includeContains.push(place);
    });
    if (!rules.alwaysKeep.some(rule => sameRule(rule, 'Büro'))) rules.alwaysKeep.unshift('Büro');
    return rules;
}

function readFilterRules() {
    try {
        const saved = JSON.parse(localStorage.getItem(FILTER_RULES_STORAGE_KEY) || '{}');
        const hasSavedRules = filterRuleGroups.some(group => Array.isArray(saved[group]));
        const rules = Object.fromEntries(filterRuleGroups.map(group => {
            const values = Array.isArray(saved[group]) ? saved[group] : defaultFilterRules[group];
            const cleaned = [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))].slice(0, 100);
            return [group, cleaned];
        }));
        if (hasSavedRules && Number(saved.version || 1) < FILTER_RULES_VERSION) {
            migrateFilterRules(rules);
            localStorage.setItem(FILTER_RULES_STORAGE_KEY, JSON.stringify({ ...rules, version: FILTER_RULES_VERSION }));
        }
        return rules;
    } catch (error) {
        return Object.fromEntries(filterRuleGroups.map(group => [group, [...defaultFilterRules[group]]]));
    }
}

let filterRules = readFilterRules();
// Merkt sich je Termin, warum er bleibt oder herausfällt (nur für die Anzeige, nicht für den Export).
const filterReasons = new WeakMap();

function saveFilterRules() {
    try {
        localStorage.setItem(FILTER_RULES_STORAGE_KEY, JSON.stringify({ ...filterRules, version: FILTER_RULES_VERSION }));
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
        const result = classifyTermin(termin);
        filterReasons.set(termin, result.reason);
        (result.keep ? gefilterteTermine : herausgefilterteTermine).push(termin);
    });

    renderTables();
}

// Entscheidet für einen Termin, ob er zu uns gehört – und nennt den Grund.
// Reihenfolge: 1. „Büro“ bleibt immer · 2. „Auftrag“ fällt raus ·
// 3. Flughafen ohne „Büro“ fällt raus · 4. Ort der Region oder ein Suchwort bleibt.
function classifyTermin(termin) {
    const lower = value => String(value || '').toLocaleLowerCase('de-DE');
    const arztName = String(termin['Arzt Nr::Name'] || '');
    const bemerkung = String(termin['Bemerkung'] || '');
    const arztOrt = String(termin['Arzt Nr::Ort'] || termin['Arzt Nr::Stadt']
        || termin.Ort || termin.Termin_Ort || termin.Stadt || '');

    const keepRule = filterRules.alwaysKeep.find(rule => lower(bemerkung).includes(lower(rule)));
    if (keepRule) return { keep: true, reason: `„${keepRule}“ in der Bemerkung` };

    const excludeRule = filterRules.alwaysExclude.find(rule => lower(bemerkung).includes(lower(rule)));
    if (excludeRule) return { keep: false, reason: `„${excludeRule}“ in der Bemerkung` };

    // Flughafen-Termine gehören nur mit „Büro“ in der Bemerkung zu uns (oben bereits geprüft).
    const isAirport = /flughafen|airport|abflug|ankunft/.test(lower(arztName))
        || /flughafen|airport/.test(lower(arztOrt))
        || /flughafen|airport/.test(lower(bemerkung));
    if (isAirport) return { keep: false, reason: 'Flughafen ohne „Büro“' };

    const place = filterRules.includeContains.find(rule =>
        matchesCriteria1(arztOrt, rule) || matchesCriteria1(bemerkung, rule));
    if (place) return { keep: true, reason: `Region: ${place}` };

    const word = filterRules.includeWholeWords.find(rule =>
        matchesCriteria2(bemerkung, rule) || matchesCriteria2(arztOrt, rule));
    if (word) return { keep: true, reason: `Suchwort: ${word}` };

    return { keep: false, reason: 'Kein Ort der Region' };
}

// Funktion für filterKriterien1 (Teilstringsuche)
function matchesCriteria1(text, kriterium) {
    return String(text || '').toLocaleLowerCase('de-DE').includes(String(kriterium || '').toLocaleLowerCase('de-DE'));
}

// Funktion für filterKriterien2 (ganzes Wort muss übereinstimmen)
function matchesCriteria2(text, criteria) {
    const lowerCaseText = String(text || '').toLocaleLowerCase('de-DE');
    const lowerCaseCriteria = String(criteria || '').toLocaleLowerCase('de-DE');
    const escapedCriteria = lowerCaseCriteria.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const regex = new RegExp(`(^|[^\\p{L}\\p{N}])${escapedCriteria}(?=$|[^\\p{L}\\p{N}])`, 'iu');
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
    'Arzt Nr::Vorname': 'Arzt Vorname',
    'Arzt Nr::Ort': 'Ort',
};

function renderTables() {
    const gefiltertTbody = document.querySelector('#gefiltert-tabelle tbody');
    const entferntTbody = document.querySelector('#entfernt-tabelle tbody');
    const tablesSection = document.querySelector('.tables-section');
    const actionSection = document.querySelector('.action-section');

    gefiltertTbody.innerHTML = '';
    entferntTbody.innerHTML = '';

    const renderRows = (termine, source) => termine.map((termin, index) => `
      <tr draggable="true" ondragstart="drag(event, '${source}', ${index})">
        <td>${escapeHtml(formatExcelTime(termin['Termin_Uhrzeit']))}</td>
        <td>${escapeHtml([termin['Patienten Nr::Patienten_Vorname'], termin['Patienten Nr::Patienten_Name']].filter(value => String(value || '').trim()).join(' '))}</td>
        <td>${escapeHtml(termin['Arzt Nr::Name'] ?? '')}</td>
        <td>${escapeHtml(termin['Bemerkung'] || '')}${filterReasons.get(termin) ? `<span class="filter-reason" data-kind="${source === 'gefiltert' ? 'keep' : 'drop'}">${escapeHtml(filterReasons.get(termin))}</span>` : ''}</td>
        <td>${escapeHtml(termin['Arzt Nr::Ort'] || termin.Ort || termin.Termin_Ort || termin.Stadt || '')}</td>
        <td class="move-cell"><button type="button" class="move-button" onclick="moveTermin('${source}', ${index})" title="${source === 'gefiltert' ? 'Herausfiltern' : 'Wieder aufnehmen'}" aria-label="${source === 'gefiltert' ? 'Termin herausfiltern' : 'Termin wieder aufnehmen'}">${source === 'gefiltert' ? '→' : '←'}</button></td>
      </tr>`).join('');
    gefiltertTbody.innerHTML = renderRows(gefilterteTermine, 'gefiltert');
    entferntTbody.innerHTML = renderRows(herausgefilterteTermine, 'entfernt');
    const keepCount = document.getElementById('keepCount');
    const dropCount = document.getElementById('dropCount');
    if (keepCount) keepCount.textContent = gefilterteTermine.length;
    if (dropCount) dropCount.textContent = herausgefilterteTermine.length;

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
            filterReasons.set(movedItem, 'Von Hand verschoben');
            herausgefilterteTermine.push(movedItem);
        } else if (draggedItem.sourceTable === 'entfernt' && targetTable === 'gefiltert') {
            const movedItem = herausgefilterteTermine.splice(draggedItem.index, 1)[0];
            filterReasons.set(movedItem, 'Von Hand verschoben');
            gefilterteTermine.push(movedItem);
        }

        renderTables();
        draggedItem = null;
    }
}

// Verschieben per Klick – schneller als Ziehen und auch per Tastatur bedienbar.
function moveTermin(sourceTable, index) {
    const moved = (sourceTable === 'gefiltert' ? gefilterteTermine : herausgefilterteTermine).splice(index, 1)[0];
    if (!moved) return;
    filterReasons.set(moved, 'Von Hand verschoben');
    (sourceTable === 'gefiltert' ? herausgefilterteTermine : gefilterteTermine).push(moved);
    renderTables();
}

// Weiter ins Live-Tracking. Läuft dort schon ein Tag (Status, Dolmetscher, Fahrzeuge),
// bleibt dieser Stand erhalten: neue Termine kommen dazu, herausgefilterte fallen weg.
function continueToTracking() {
    if (alleTermine.length === 0) {
        showWorkflowStatus('Bitte lade zuerst eine Excel-Datei mit Terminen.', 'error');
        return;
    }

    const workflow = readTerminWorkflow();
    let records = gefilterteTermine;
    if (workflow.step === 'tracking' && Array.isArray(workflow.records) && workflow.records.length) {
        const removedIds = new Set(herausgefilterteTermine.map(termin => termin._src).filter(Boolean));
        const kept = workflow.records.filter(record => !record._src || !removedIds.has(record._src));
        const knownIds = new Set(kept.map(record => record._src).filter(Boolean));
        records = [...kept, ...gefilterteTermine.filter(termin => !termin._src || !knownIds.has(termin._src))];
    }

    const saved = persistTerminRecords(records, 'tracking', {
        filtered: gefilterteTermine,
        removed: herausgefilterteTermine
    });
    if (saved) window.location.href = 'termineTracking.html';
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
    // Live-Tracking noch für WhatsApp verfügbar sind.
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
