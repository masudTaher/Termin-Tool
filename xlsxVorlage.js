// Excel-Vorlage der Monatsabrechnung vorausfüllen (vorlagen/Monatsabrechnung-Temporaer.xlsx).
// Die Vorlage bleibt unverändert: Es werden nur Werte in die vorbereiteten Zellen geschrieben
// (Monat, Prüfdatum, Tagessatz, Personen, Arbeitstage, Sondertage, Belege). Alle Formeln,
// Formate, Dropdowns und Prüfungen der Vorlage rechnen in Excel weiter.
// Ohne Fremdbibliothek: Die .xlsx-Datei ist ein ZIP-Archiv mit XML-Dateien.
const XlsxVorlage = (() => {
    'use strict';

    // ---------- ZIP lesen ----------
    const CRC_TABLE = (() => {
        const table = new Int32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c;
        }
        return table;
    })();
    const crc32 = bytes => {
        let crc = -1;
        for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ -1) >>> 0;
    };

    async function pipe(bytes, stream) {
        const response = new Response(new Blob([bytes]).stream().pipeThrough(stream));
        return new Uint8Array(await response.arrayBuffer());
    }
    const canStream = name => { try { return typeof CompressionStream === 'function' && Boolean(new CompressionStream(name)); } catch (error) { return false; } };

    async function unzip(buffer) {
        const bytes = new Uint8Array(buffer);
        const view = new DataView(buffer);
        let eocd = -1;
        for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 70000); i--) {
            if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) throw new Error('Die Vorlage ist keine gültige Excel-Datei.');
        const count = view.getUint16(eocd + 10, true);
        let offset = view.getUint32(eocd + 16, true);
        const decoder = new TextDecoder();
        const entries = new Map();
        for (let n = 0; n < count; n++) {
            if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('Die Vorlage ist beschädigt.');
            const method = view.getUint16(offset + 10, true);
            const compressed = view.getUint32(offset + 20, true);
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            const local = view.getUint32(offset + 42, true);
            const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
            const localName = view.getUint16(local + 26, true);
            const localExtra = view.getUint16(local + 28, true);
            const start = local + 30 + localName + localExtra;
            const data = bytes.slice(start, start + compressed);
            if (method === 0) entries.set(name, data);
            else if (method === 8) {
                if (!canStream('deflate-raw')) throw new Error('Dieser Browser kann die Vorlage nicht entpacken. Bitte einen aktuellen Browser (Chrome, Edge, Safari) verwenden.');
                entries.set(name, await pipe(data, new DecompressionStream('deflate-raw')));
            } else throw new Error('Die Vorlage verwendet eine unbekannte Komprimierung.');
            offset += 46 + nameLength + extraLength + commentLength;
        }
        return entries;
    }

    // ---------- ZIP schreiben ----------
    async function zip(entries) {
        const encoder = new TextEncoder();
        const deflate = canStream('deflate-raw');
        const parts = [];
        const directory = [];
        let offset = 0;
        for (const [name, raw] of entries) {
            const data = raw instanceof Uint8Array ? raw : encoder.encode(raw);
            const nameBytes = encoder.encode(name);
            const crc = crc32(data);
            let body = data;
            let method = 0;
            if (deflate && data.length > 64) {
                const packed = await pipe(data, new CompressionStream('deflate-raw'));
                if (packed.length < data.length) { body = packed; method = 8; }
            }
            const header = new DataView(new ArrayBuffer(30));
            header.setUint32(0, 0x04034b50, true);
            header.setUint16(4, 20, true);
            header.setUint16(6, 0x0800, true);          // UTF-8-Dateinamen
            header.setUint16(8, method, true);
            header.setUint16(10, 0, true); header.setUint16(12, 0x21, true);   // Zeit/Datum (1.1.1980)
            header.setUint32(14, crc, true);
            header.setUint32(18, body.length, true);
            header.setUint32(22, data.length, true);
            header.setUint16(26, nameBytes.length, true);
            header.setUint16(28, 0, true);
            parts.push(new Uint8Array(header.buffer), nameBytes, body);
            const central = new DataView(new ArrayBuffer(46));
            central.setUint32(0, 0x02014b50, true);
            central.setUint16(4, 20, true); central.setUint16(6, 20, true);
            central.setUint16(8, 0x0800, true);
            central.setUint16(10, method, true);
            central.setUint16(12, 0, true); central.setUint16(14, 0x21, true);
            central.setUint32(16, crc, true);
            central.setUint32(20, body.length, true);
            central.setUint32(24, data.length, true);
            central.setUint16(28, nameBytes.length, true);
            central.setUint32(42, offset, true);
            directory.push(new Uint8Array(central.buffer), nameBytes);
            offset += 30 + nameBytes.length + body.length;
        }
        const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, entries.size, true); end.setUint16(10, entries.size, true);
        end.setUint32(12, directorySize, true);
        end.setUint32(16, offset, true);
        return new Blob([...parts, ...directory, new Uint8Array(end.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    }

    // ---------- Zellen ----------
    const escapeXml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
    const serial = iso => {
        const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
        if (!match) return null;
        return Math.round((Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - Date.UTC(1899, 11, 30)) / 86400000);
    };

    // Schreibt einen Wert in eine vorhandene (formatierte) Zelle des Blattes. Leere Werte lassen die Zelle leer.
    function setCell(xml, ref, value, kind) {
        const pattern = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</c>)`);
        const match = pattern.exec(xml);
        if (!match) throw new Error(`In der Vorlage fehlt die Zelle ${ref}.`);
        const attributes = match[1].replace(/\s+t="[^"]*"/, '');
        let cell;
        if (value == null || value === '') cell = `<c r="${ref}"${attributes}/>`;
        else if (kind === 'date') { const days = serial(value); cell = days == null ? `<c r="${ref}"${attributes}/>` : `<c r="${ref}"${attributes}><v>${days}</v></c>`; }
        else if (kind === 'number') { const number = Number(value); cell = Number.isFinite(number) ? `<c r="${ref}"${attributes}><v>${number}</v></c>` : `<c r="${ref}"${attributes}/>`; }
        else cell = `<c r="${ref}"${attributes} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
        return xml.slice(0, match.index) + cell + xml.slice(match.index + match[0].length);
    }

    function sheetFiles(entries) {
        const decoder = new TextDecoder();
        const workbook = decoder.decode(entries.get('xl/workbook.xml'));
        const rels = decoder.decode(entries.get('xl/_rels/workbook.xml.rels'));
        const targets = new Map();
        for (const match of rels.matchAll(/<Relationship\b[^>]*>/g)) {
            const id = /Id="([^"]+)"/.exec(match[0])?.[1];
            const target = /Target="([^"]+)"/.exec(match[0])?.[1];
            if (id && target) targets.set(id, target.replace(/^\/?(xl\/)?/, 'xl/'));
        }
        const files = new Map();
        for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
            const name = /name="([^"]+)"/.exec(match[0])?.[1];
            const id = /r:id="([^"]+)"/.exec(match[0])?.[1];
            if (name && targets.has(id)) files.set(name.replace(/&amp;/g, '&'), targets.get(id));
        }
        return files;
    }

    // Größe der Tabellen aus den Tabellen-Dateien (z. B. tblEndliste B8:I49 → Datenzeilen 9–48).
    function tableRanges(entries) {
        const decoder = new TextDecoder();
        const ranges = {};
        for (const [name, data] of entries) {
            if (!/^xl\/tables\/table\d+\.xml$/.test(name)) continue;
            const xml = decoder.decode(data);
            const display = /displayName="([^"]+)"/.exec(xml)?.[1];
            const ref = /\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/.exec(xml);
            if (!display || !ref) continue;
            const totals = /totalsRowCount="(\d+)"/.exec(xml);
            ranges[display] = { first: Number(ref[2]) + 1, last: Number(ref[4]) - (totals ? Number(totals[1]) : 0) };
        }
        return ranges;
    }

    const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

    // data: { month: 'YYYY-MM', rate, checkDate, people: [{ name, fullName, workdays, remark, status, note }],
    //         special: [{ name, date, job, amount, counts, mark, hint }], receipts: [{ name, date, place, amount, proof, note }] }
    async function fill(templateBuffer, data) {
        const entries = await unzip(templateBuffer);
        const files = sheetFiles(entries);
        const ranges = tableRanges(entries);
        const decoder = new TextDecoder();
        const need = ['Endliste', 'Sondertage', 'Übersicht', 'Belege', 'Abrechnung'];
        for (const name of need) if (!files.has(name)) throw new Error(`In der Vorlage fehlt das Blatt „${name}“.`);
        const capacity = (table, label, count) => {
            const range = ranges[table];
            if (!range) throw new Error(`In der Vorlage fehlt die Tabelle ${table}.`);
            if (count > range.last - range.first + 1) throw new Error(`Die Vorlage hat Platz für ${range.last - range.first + 1} ${label} – es sind aber ${count}.`);
            return range;
        };
        const people = data.people || [];
        const special = data.special || [];
        const receipts = data.receipts || [];
        const [year, monthNumber] = String(data.month || '').split('-').map(Number);
        if (!year || !monthNumber) throw new Error('Der Abrechnungsmonat fehlt.');

        const write = (sheet, edits) => {
            const file = files.get(sheet);
            let xml = decoder.decode(entries.get(file));
            for (const [ref, value, kind] of edits) xml = setCell(xml, ref, value, kind);
            entries.set(file, new TextEncoder().encode(xml));
        };

        write('Übersicht', [
            ['C5', MONTHS[monthNumber - 1]], ['D5', year, 'number'], ['C6', data.checkDate || '', 'date'],
            ...people.flatMap((person, index) => {
                const row = capacity('tblDolmetscher', 'Personen', people.length).first + index;
                return [[`B${row}`, person.name], [`C${row}`, person.fullName || ''], [`F${row}`, person.status || ''], [`G${row}`, person.note || '']];
            })
        ]);
        write('Endliste', [
            ['C5', data.rate, 'number'],
            ...people.flatMap((person, index) => {
                const row = capacity('tblEndliste', 'Personen', people.length).first + index;
                return [[`B${row}`, person.name], [`C${row}`, person.workdays, 'number'], [`I${row}`, person.remark || '']];
            })
        ]);
        write('Sondertage', special.flatMap((item, index) => {
            const row = capacity('tblSonder', 'Sondertage', special.length).first + index;
            return [[`B${row}`, item.name], [`C${row}`, item.date, 'date'], [`D${row}`, item.job || ''], [`E${row}`, item.amount, 'number'],
                [`F${row}`, item.counts || 'prüfen'], [`G${row}`, item.mark || ''], [`H${row}`, item.hint || '']];
        }));
        write('Belege', receipts.flatMap((item, index) => {
            const row = capacity('tblBelege', 'Belege', receipts.length).first + index;
            return [[`B${row}`, item.name], [`C${row}`, item.date, 'date'], [`D${row}`, item.place || ''], [`E${row}`, item.amount, 'number'],
                [`F${row}`, item.proof || 'Parkbeleg'], [`G${row}`, item.note || '']];
        }));
        const firstWithReceipts = people.find(person => receipts.some(item => item.name === person.name)) || people[0];
        write('Abrechnung', [['D5', firstWithReceipts ? firstWithReceipts.name : '']]);
        return zip(entries);
    }

    const fileName = (month, kind = 'Temporär') => {
        const [year, monthNumber] = String(month || '').split('-').map(Number);
        return `${MONTHS[monthNumber - 1] || month} ${kind} ${year} (Medical Office Bonn).xlsx`;
    };

    return { fill, fileName, unzip, zip, setCell, serial, MONTHS };
})();

if (typeof module !== 'undefined') module.exports = XlsxVorlage;
