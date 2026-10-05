// Gemeinsame Regeln für Abwesenheiten und Arbeitstage – für das Portal und für die Einsatzleitung.
// Arbeitstage sind Montag bis Freitag ohne die gesetzlichen Feiertage in Nordrhein-Westfalen.
// Die Zahl der Tage eines Eintrags kann die Einsatzleitung von Hand korrigieren (Feld „days“, auch halbe Tage).
window.AbsenceLogic = (function () {
    const pad = value => String(value).padStart(2, '0');
    const iso = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const parse = text => { const [year, month, day] = String(text).slice(0, 10).split('-').map(Number); return new Date(year, month - 1, day); };
    const addDays = (text, count) => { const date = parse(text); date.setDate(date.getDate() + count); return iso(date); };
    const today = () => iso(new Date());

    // Ostersonntag (gregorianischer Kalender)
    function easter(year) {
        const a = year % 19, b = Math.floor(year / 100), c = year % 100, d = Math.floor(b / 4), e = b % 4;
        const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
        const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
        const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
        return `${year}-${pad(month)}-${pad(day)}`;
    }

    const holidayCache = new Map();
    function holidays(year) {
        if (!holidayCache.has(year)) {
            const sunday = easter(year);
            holidayCache.set(year, new Map([
                [`${year}-01-01`, 'Neujahr'], [addDays(sunday, -2), 'Karfreitag'], [addDays(sunday, 1), 'Ostermontag'],
                [`${year}-05-01`, 'Tag der Arbeit'], [addDays(sunday, 39), 'Christi Himmelfahrt'], [addDays(sunday, 50), 'Pfingstmontag'],
                [addDays(sunday, 60), 'Fronleichnam'], [`${year}-10-03`, 'Tag der Deutschen Einheit'], [`${year}-11-01`, 'Allerheiligen'],
                [`${year}-12-25`, '1. Weihnachtstag'], [`${year}-12-26`, '2. Weihnachtstag']
            ]));
        }
        return holidayCache.get(year);
    }
    const holidayName = text => holidays(Number(String(text).slice(0, 4))).get(String(text).slice(0, 10)) || '';
    const isWeekend = text => [0, 6].includes(parse(text).getDay());
    const isWorkday = text => !isWeekend(text) && !holidayName(text);

    // Arbeitstage zwischen zwei Daten (einschließlich); optional nur der Teil, der in einen Zeitraum fällt.
    function workingDays(from, to, rangeStart, rangeEnd) {
        let start = String(from).slice(0, 10);
        let end = String(to).slice(0, 10);
        if (rangeStart && rangeStart > start) start = rangeStart;
        if (rangeEnd && rangeEnd < end) end = rangeEnd;
        let count = 0;
        for (let day = start; day <= end; day = addDays(day, 1)) if (isWorkday(day)) count += 1;
        return count;
    }

    // Gezählte Tage eines Eintrags (Urlaub, Krank, ganztägiger Notfall). Eine von Hand korrigierte Zahl geht vor;
    // fällt nur ein Teil des Eintrags in den Zeitraum, zählt der passende Anteil.
    function dayCount(item, rangeStart, rangeEnd) {
        const inRange = workingDays(item.date_from, item.date_to, rangeStart, rangeEnd);
        if (item.days == null || item.days === '') return inRange;
        const all = workingDays(item.date_from, item.date_to);
        const outside = (rangeStart && rangeStart > item.date_from) || (rangeEnd && rangeEnd < item.date_to);
        if (!outside) return Number(item.days);
        return all ? Math.round(Number(item.days) * inRange / all * 10) / 10 : 0;
    }

    const KINDS = {
        urlaub: { label: 'Urlaub', plural: 'Urlaub', unit: 'tage' },
        krank: { label: 'Krank', plural: 'Krankheit', unit: 'tage' },
        'verspätung': { label: 'Verspätung', plural: 'Verspätungen', unit: 'minuten' },
        fehlstunden: { label: 'Fehlstunden', plural: 'Fehlstunden', unit: 'minuten' },
        notfall: { label: 'Notfall', plural: 'Notfälle', unit: 'mal' }
    };
    const KIND_ORDER = ['urlaub', 'krank', 'verspätung', 'fehlstunden', 'notfall'];

    const number = value => Number(value).toLocaleString('de-DE', { maximumFractionDigits: 1 });
    const formatDays = (count, one = 'Tag', many = 'Tage') => `${number(count)} ${Number(count) === 1 ? one : many}`;
    function formatMinutes(minutes) {
        const total = Math.max(0, Math.round(Number(minutes) || 0));
        const hours = Math.floor(total / 60);
        const rest = total % 60;
        return hours ? `${hours} Std${rest ? ` ${rest} Min` : ''}` : `${rest} Min`;
    }
    const shortDate = text => { const [year, month, day] = String(text).slice(0, 10).split('-'); return `${day}.${month}.${year}`; };
    const dayMonth = text => { const [, month, day] = String(text).slice(0, 10).split('-'); return `${day}.${month}.`; };
    // Zeitstempel aus der Datenbank → 05.10.2026 (in der Zeit des Geräts)
    const stampDate = value => { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : shortDate(iso(date)); };
    const rangeText = item => item.date_from === item.date_to ? shortDate(item.date_from) : `${dayMonth(item.date_from)} bis ${shortDate(item.date_to)}`;

    const covers = (item, date) => item.date_from <= date && item.date_to >= date;
    // Fehlt die Person an diesem Tag ganz? Genehmigter Urlaub, eine Krankmeldung oder ein Notfall ohne Stundenangabe.
    // (Eine Krankmeldung zählt sofort – auch bevor die Einsatzleitung sie gesehen hat.)
    function blocksDay(item, date) {
        if (!covers(item, date) || item.status === 'abgelehnt') return false;
        if (item.kind === 'urlaub') return item.status === 'genehmigt';
        if (item.kind === 'krank') return true;
        return item.kind === 'notfall' && !item.minutes;
    }
    // „Urlaub bis 16.10.“ · „Krank seit 05.10.“ · „Notfall heute“
    function awayText(item, date) {
        const label = KINDS[item.kind]?.label || item.kind;
        if (item.date_from === item.date_to) return `${label}${item.date_from === today() ? ' heute' : ` am ${dayMonth(item.date_from)}`}`;
        if (item.kind === 'krank' && item.date_from < date) return `${label} seit ${dayMonth(item.date_from)} · bis ${dayMonth(item.date_to)}`;
        return `${label} bis ${dayMonth(item.date_to)}`;
    }

    return { iso, parse, addDays, today, easter, holidays, holidayName, isWeekend, isWorkday, workingDays, dayCount, KINDS, KIND_ORDER,
        formatDays, formatMinutes, shortDate, dayMonth, stampDate, rangeText, covers, blocksDay, awayText };
})();
