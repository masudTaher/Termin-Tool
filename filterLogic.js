// Filterregeln: Welche Termine gehören zu uns (Bonn und Region)? Gemeinsam genutzt vom Schritt „Filtern“
// (termineFilternApp.js) und von „Termine nachtragen“ im Live-Tracking (terminNachtrag.js).
// Die Regeln lassen sich im Schritt „Filtern“ anpassen und werden über cloudSettingsSync.js abgeglichen.

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
