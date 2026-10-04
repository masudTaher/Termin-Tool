// Rechenlogik der Monatsabrechnung für temporäre Dolmetscher – dieselben Regeln wie in der
// Excel-Vorlage „… Temporär ….xlsx“:  Salary = (Arbeitstage − Sondertage) × Tagessatz + Beträge der Sondertage,
// Total = Salary + Belege.  Ohne Seitenbezug, damit die Regeln einzeln prüfbar bleiben.
const Abrechnung = (() => {
    const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
    const key = name => String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');
    const round = value => Math.round((Number(value) || 0) * 100) / 100;
    const euro = value => `${round(value).toLocaleString('de-DE', { minimumFractionDigits: Number.isInteger(round(value)) ? 0 : 2, maximumFractionDigits: 2 })} €`;
    const shortDate = iso => { const [, month, day] = String(iso).split('-'); return `${day}.${month}.`; };
    const longDate = iso => { const [year, month, day] = String(iso).split('-'); return `${day}.${month}.${year}`; };

    function monthRange(month) {
        const [year, number] = month.split('-').map(Number);
        const last = new Date(year, number, 0).getDate();
        return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}`, label: `${MONTHS[number - 1]} ${year}`, period: `01.${String(number).padStart(2, '0')}.${year} – ${String(last).padStart(2, '0')}.${String(number).padStart(2, '0')}.${year}` };
    }

    // Arbeitstage aus dem Online-Archiv: Tage, an denen die Person mindestens einen beendeten Termin hatte.
    function countWorkdays(days) {
        const perPerson = new Map();
        (days || []).forEach(day => {
            const names = new Set();
            (Array.isArray(day.records) ? day.records : []).forEach(record => {
                if (String(record.Status || '').toLocaleLowerCase('de') === 'beendet' && key(record.Übersetzer)) names.add(key(record.Übersetzer));
            });
            names.forEach(name => perPerson.set(name, (perPerson.get(name) || 0) + 1));
        });
        return perPerson;
    }

    // Dieselbe Zählung mit den einzelnen Tagen – für die Abrechnung im Portal.
    function workdayDates(days) {
        const perPerson = new Map();
        (days || []).forEach(day => {
            const names = new Set();
            (Array.isArray(day.records) ? day.records : []).forEach(record => {
                if (String(record.Status || '').toLocaleLowerCase('de') === 'beendet' && key(record.Übersetzer)) names.add(key(record.Übersetzer));
            });
            names.forEach(name => perPerson.set(name, [...(perPerson.get(name) || []), day.date].sort()));
        });
        return perPerson;
    }

    // Sondertage aus dem Live-Tracking: Termine mit eingetragenem Sonderbetrag.
    // Pro Person und Tag zählt ein Sondertag (der höchste Betrag); ein von Hand eingetragener Sondertag hat Vorrang.
    function specialFromDays(days, storedSpecialDays) {
        const taken = new Set((storedSpecialDays || []).map(item => `${key(item.person_name)}|${item.date}`));
        const found = new Map();
        (days || []).forEach(day => {
            (Array.isArray(day.records) ? day.records : []).forEach(record => {
                const amount = Number(record.Sonderbetrag);
                const name = String(record.Übersetzer || '').trim().replace(/\s+/g, ' ');
                if (!(amount > 0) || !name || String(record.Status || '').toLocaleLowerCase('de') === 'storniert') return;
                const id = `${key(name)}|${day.date}`;
                if (taken.has(id) || (found.get(id)?.amount ?? 0) >= amount) return;
                found.set(id, {
                    id: null, person_name: name, date: day.date, amount: round(amount), counts: 'Ja', source: 'tracking',
                    job: [String(record.Termin_Uhrzeit || '').slice(0, 5), record['Arzt Nr::Name'], record['Arzt Nr::Ort'] || record.Ort].filter(Boolean).join(' · '),
                    mark: 'aus dem Live-Tracking', hint: ''
                });
            });
        });
        return [...found.values()];
    }

    function compute({ rate, receipts, specialDays, payroll, autoWorkdays, extraNames }) {
        const names = new Map();
        const remember = name => { if (key(name) && !names.has(key(name))) names.set(key(name), String(name).trim().replace(/\s+/g, ' ')); };
        (payroll || []).forEach(item => remember(item.person_name));
        (receipts || []).forEach(item => remember(item.person_name));
        (specialDays || []).forEach(item => remember(item.person_name));
        (extraNames || []).forEach(remember);

        const rows = [...names.entries()].map(([id, name]) => {
            const entry = (payroll || []).find(item => key(item.person_name) === id);
            const ownReceipts = (receipts || []).filter(item => key(item.person_name) === id && item.status !== 'abgelehnt');
            const ownSpecial = (specialDays || []).filter(item => key(item.person_name) === id).sort((a, b) => String(a.date).localeCompare(String(b.date)));
            const counted = ownSpecial.filter(item => item.counts === 'Ja');
            const auto = autoWorkdays?.get(id) ?? null;
            const workdays = entry?.workdays ?? auto;
            const specialSum = round(counted.reduce((sum, item) => sum + Number(item.amount), 0));
            const receiptSum = round(ownReceipts.reduce((sum, item) => sum + Number(item.amount), 0));
            const salary = workdays == null ? null : round((workdays - counted.length) * rate + specialSum);
            return {
                name, fullName: entry?.full_name || '', remark: entry?.remark || '', status: entry?.status || '',
                workdays, workdaysManual: entry?.workdays ?? null, workdaysAuto: auto,
                specialCount: counted.length, specialSum,
                specialText: ownSpecial.filter(item => item.counts !== 'Nein').map(item => `${shortDate(item.date)}: ${euro(item.amount)}${item.counts === 'prüfen' ? ' (prüfen)' : ''}`).join(' · '),
                receiptCount: ownReceipts.length, receiptSum,
                salary, total: salary == null ? null : round(salary + receiptSum)
            };
        }).sort((left, right) => left.name.localeCompare(right.name, 'de'));

        const active = (receipts || []).filter(item => item.status !== 'abgelehnt');
        const checks = [];
        const without = rows.filter(row => row.workdays == null || row.workdays === 0);
        const tooMany = rows.filter(row => row.workdays != null && row.specialCount > row.workdays);
        const toCheck = (specialDays || []).filter(item => item.counts === 'prüfen').length;
        const unreviewed = active.filter(item => item.status === 'eingereicht').length;
        if (unreviewed) checks.push(`${unreviewed} ${unreviewed === 1 ? 'Beleg ist' : 'Belege sind'} noch nicht geprüft`);
        if (toCheck) checks.push(`${toCheck} ${toCheck === 1 ? 'Sondertag' : 'Sondertage'} noch auf „prüfen“`);
        if (without.length) checks.push(`ohne Arbeitstage: ${without.map(row => row.name).join(', ')}`);
        if (tooMany.length) checks.push(`mehr Sondertage als Arbeitstage: ${tooMany.map(row => row.name).join(', ')}`);

        return {
            rows, checks,
            totals: {
                receipts: round(active.reduce((sum, item) => sum + Number(item.amount), 0)),
                receiptCount: active.length,
                personsWithReceipts: rows.filter(row => row.receiptCount > 0).length,
                salary: round(rows.reduce((sum, row) => sum + (row.salary || 0), 0)),
                total: round(rows.reduce((sum, row) => sum + (row.total || 0), 0))
            }
        };
    }

    // ---------- Excel-Vorlage einlesen ----------
    // `sheets` = { Blattname: Zeilen[][] } (SheetJS: sheet_to_json(..., { header: 1 })).
    const serialToIso = value => {
        if (value instanceof Date) return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
        if (typeof value === 'number' && Number.isFinite(value)) {
            const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
            return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
        }
        const text = String(value || '').trim();
        const german = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
        if (german) return `${german[3]}-${german[2].padStart(2, '0')}-${german[1].padStart(2, '0')}`;
        return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : '';
    };

    function readTable(rows, requiredHeaders) {
        const headerIndex = (rows || []).findIndex(row => requiredHeaders.every(header => (row || []).some(cell => String(cell ?? '').trim() === header)));
        if (headerIndex < 0) return [];
        const headers = rows[headerIndex].map(cell => String(cell ?? '').trim());
        const result = [];
        for (const row of rows.slice(headerIndex + 1)) {
            const record = {};
            headers.forEach((header, column) => { if (header) record[header] = row?.[column] ?? null; });
            if (!String(record[requiredHeaders[0]] ?? '').trim()) break;   // Tabelle endet an der ersten leeren Zeile
            result.push(record);
        }
        return result;
    }

    const findRight = (rows, label, offset = 1) => {
        for (const row of rows || []) {
            const column = (row || []).findIndex(cell => String(cell ?? '').trim() === label);
            if (column >= 0) return row[column + offset];
        }
        return null;
    };

    function parseWorkbook(sheets) {
        const overview = sheets['Übersicht'] || [];
        const monthName = String(findRight(overview, 'Abrechnungsmonat') || '').trim();
        const year = Number(findRight(overview, 'Abrechnungsmonat', 2));
        const monthNumber = MONTHS.indexOf(monthName) + 1;
        if (!monthNumber || !year) throw new Error('In der Datei fehlt der Abrechnungsmonat (Blatt „Übersicht“).');
        const month = `${year}-${String(monthNumber).padStart(2, '0')}`;
        const text = value => String(value ?? '').trim();

        const receipts = readTable(sheets['Belege'], ['Name', 'Datum', 'Betrag']).filter(row => typeof row.Betrag === 'number').map(row => ({
            person_name: text(row.Name), date: serialToIso(row.Datum), place: text(row.Ort), amount: round(row.Betrag),
            kind: /diesel|benzin|tank|aral|shell|esso|jet\b/i.test(text(row.Ort)) ? 'Tanken' : 'Parken',
            proof: text(row.Nachweis) || 'Parkbeleg', note: text(row.Bemerkung)
        }));
        const specialDays = readTable(sheets['Sondertage'], ['Name', 'Datum', 'Einsatz']).map(row => ({
            person_name: text(row.Name), date: serialToIso(row.Datum), job: text(row.Einsatz), amount: round(row['Betrag für den Tag']),
            counts: ['Ja', 'Nein', 'prüfen'].includes(text(row['Zählt'])) ? text(row['Zählt']) : 'prüfen',
            mark: text(row['Vermerk auf dem Tagesblatt']), hint: text(row.Hinweis)
        }));
        const people = new Map(readTable(overview, ['Name', 'Vollständiger Name', 'Belege']).map(row => [key(row.Name), row]));
        const payroll = readTable(sheets['Endliste'], ['Name of Employee', 'Arbeitstage'])
            .filter(row => !/^(summe|gesamt|total)$/i.test(text(row['Name of Employee']))).map(row => {
            const person = people.get(key(row['Name of Employee']));
            return {
                month, person_name: text(row['Name of Employee']), full_name: text(person?.['Vollständiger Name']),
                workdays: typeof row.Arbeitstage === 'number' ? Math.round(row.Arbeitstage) : null,
                status: text(person?.Status), remark: [text(row.Bemerkung), text(person?.Bemerkung)].filter(Boolean).join(' · ')
            };
        });
        // Personen, die nur in der Übersicht stehen (z. B. Belege, aber noch keine Arbeitstage).
        people.forEach((row, id) => {
            if (!payroll.some(item => key(item.person_name) === id)) {
                payroll.push({ month, person_name: text(row.Name), full_name: text(row['Vollständiger Name']), workdays: null, status: text(row.Status), remark: text(row.Bemerkung) });
            }
        });
        const rate = Number(findRight(sheets['Endliste'] || [], 'Tagessatz'));
        return { month, rate: Number.isFinite(rate) && rate > 0 ? rate : 80, checkDate: serialToIso(findRight(overview, 'Prüfdatum')), receipts, specialDays, payroll };
    }

    return { MONTHS, key, round, euro, shortDate, longDate, monthRange, countWorkdays, workdayDates, specialFromDays, compute, parseWorkbook };
})();

if (typeof module !== 'undefined') module.exports = Abrechnung;
