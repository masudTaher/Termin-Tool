// Liest Park- und Tankbelege aus einem Foto (kostenlos, direkt auf dem Handy – das Foto wird dafür nirgends hingeschickt).
// Die Texterkennung (Tesseract) wird erst geladen, wenn wirklich ein Foto gewählt wurde.
// Das Ergebnis ist immer nur ein Vorschlag: Die Person prüft Betrag, Datum und Ort vor dem Einreichen.
const ReceiptReader = (() => {
    const LIBRARY = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    let libraryPromise = null;

    function loadLibrary() {
        if (window.Tesseract) return Promise.resolve(window.Tesseract);
        if (!libraryPromise) {
            libraryPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = LIBRARY;
                script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Texterkennung nicht verfügbar'));
                script.onerror = () => { libraryPromise = null; reject(new Error('Texterkennung konnte nicht geladen werden')); };
                document.head.append(script);
            });
        }
        return libraryPromise;
    }

    const toNumber = text => Number(String(text).replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
    const AMOUNT = /(?<![\d.,\/-])(\d{1,4}(?:[.,]\d{3})*[.,]\d{2})(?![.,\/-]?\d)/g;
    const TOTAL_WORDS = /(summe|gesamt|betrag|total|zu\s*zahlen|zahlbetrag|bezahlt|endbetrag|parkgeb|geb[üu]hr|entgelt|brutto|\beur\b|€)/i;
    const NOT_TOTAL = /(mwst|ust|steuer|netto|r[üu]ckgeld|gegeben|wechselgeld|liter|€\s*\/|\/\s*l\b|preis\s*\/)/i;
    const NOT_PLACE = /(beleg|quittung|rechnung|\bbon\b|\bkasse|datum|uhrzeit|summe|gesamt|betrag|mwst|\bust\b|steuer|\btel\b|\bfax\b|www\.|http|danke|kartenzahlung|girocard|\bvisa\b|mastercard|terminal|ta-?nr|trace|r[üu]ckgeld|gegeben|\beur\b|€|\d[.,]\d{2})/i;

    // Wandelt erkannten Text in Vorschläge um. today: 'JJJJ-MM-TT' (Datum darf nicht in der Zukunft liegen).
    function parse(text, today) {
        const lines = String(text || '').split(/\r?\n/).map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
        const result = { amount: null, date: '', place: '', kind: '', note: '' };

        // Betrag: zuerst Zeilen mit „Summe“, „Betrag“, „EUR“ …, sonst der größte Betrag auf dem Beleg.
        const candidates = [];
        lines.forEach((line, index) => {
            for (const match of line.matchAll(AMOUNT)) {
                const value = toNumber(match[1]);
                if (!(value > 0) || value >= 2000) continue;
                let score = 0;
                if (TOTAL_WORDS.test(line)) score += 3;
                if (index > 0 && TOTAL_WORDS.test(lines[index - 1]) && !/\d[.,]\d{2}/.test(lines[index - 1])) score += 2;
                if (/(summe|gesamt|zu\s*zahlen|zahlbetrag|endbetrag|total)/i.test(line)) score += 3;
                if (NOT_TOTAL.test(line)) score -= 4;
                candidates.push({ value, score });
            }
        });
        if (candidates.length) {
            candidates.sort((left, right) => right.score - left.score || right.value - left.value);
            result.amount = Math.round(candidates[0].value * 100) / 100;
        }

        // Datum: TT.MM.JJJJ, TT.MM.JJ oder JJJJ-MM-TT – nicht in der Zukunft, höchstens ein Jahr alt.
        // „Heute“ nach der Uhr des Handys (nicht nach Weltzeit – sonst gälte ein Beleg von kurz nach Mitternacht als „in der Zukunft“).
        const now = new Date();
        const limit = today || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const oldest = `${Number(limit.slice(0, 4)) - 1}${limit.slice(4)}`;
        const dates = [];
        const joined = lines.join('\n');
        for (const match of joined.matchAll(/(?<!\d)(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4}|\d{2})(?!\d)/g)) {
            const year = match[3].length === 2 ? `20${match[3]}` : match[3];
            dates.push(`${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`);
        }
        for (const match of joined.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) dates.push(`${match[1]}-${match[2]}-${match[3]}`);
        const valid = dates.filter(iso => {
            const [year, month, day] = iso.split('-').map(Number);
            const date = new Date(year, month - 1, day);
            return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day && iso <= limit && iso >= oldest;
        });
        if (valid.length) result.date = valid.sort().at(-1);

        // Art: Tankstelle oder Parken?
        if (/(tankstelle|diesel|super\s?e?\d*|benzin|kraftstoff|liter|\baral\b|\bshell\b|\besso\b|\bjet\b|totalenergies|zapfs[äa]ule)/i.test(joined)) result.kind = 'Tanken';
        else if (/(park|tiefgarage|garage|einfahrt|ausfahrt|stellplatz|apcoa|contipark|q-?park)/i.test(joined)) result.kind = 'Parken';

        // Ort: die erste Zeile, die wie ein Name aussieht (meist steht der Betreiber ganz oben).
        const place = lines.slice(0, 8).find(line => {
            const letters = (line.match(/\p{L}/gu) || []).length;
            return letters >= 5 && letters / line.length > 0.55 && !NOT_PLACE.test(line);
        });
        if (place) result.place = place.replace(/[|_*#~]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);

        // Parkdauer als Bemerkung: zwei Uhrzeiten auf dem Beleg.
        const times = [...new Set([...joined.matchAll(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/g)].map(match => `${match[1].padStart(2, '0')}:${match[2]}`))];
        if (result.kind !== 'Tanken' && times.length >= 2) result.note = `${times[0]}–${times[1]} Uhr`;
        return result;
    }

    // Liest das Foto. onProgress(0…1) meldet den Fortschritt. Wirft einen Fehler, wenn nichts erkannt werden kann.
    async function read(file, onProgress) {
        const Tesseract = await loadLibrary();
        const worker = await Tesseract.createWorker('deu', 1, {
            logger: message => { if (message.status === 'recognizing text' && typeof onProgress === 'function') onProgress(message.progress || 0); }
        });
        try {
            const { data } = await worker.recognize(file);
            return { text: data?.text || '', ...parse(data?.text || '', new Date().toLocaleDateString('sv-SE')) };
        } finally {
            await worker.terminate();
        }
    }

    return { read, parse };
})();
if (typeof module !== 'undefined') module.exports = ReceiptReader;
