// Bericht als Word-Datei (.docx) – entsteht direkt im Browser, ohne Server und ohne fremde Bibliothek (R75).
//   DocWord.report(options)  → Blob  (gleiche Angaben wie DocPdf.report: organisation, title, meta, sections, footer, author)
// Word zeigt arabischen Text von sich aus richtig; jeder Absatz bekommt seine Schreibrichtung (rechts-nach-links, wenn er
// mit arabischer Schrift beginnt). Die Datei ist ein ZIP-Archiv ohne Kompression – das kann jedes Word öffnen.
window.DocWord = (function () {
    const FONT = 'Arial';
    const INK = '0F1E33';
    const GREY = '64748B';
    const LINE = 'D8DEE6';

    // ---------- ZIP (nur „gespeichert“, ohne Kompression) ----------
    const CRC = (() => {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
            table[n] = c >>> 0;
        }
        return bytes => {
            let crc = 0xFFFFFFFF;
            for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
            return (crc ^ 0xFFFFFFFF) >>> 0;
        };
    })();

    function zip(files) {
        const encoder = new TextEncoder();
        const parts = [];
        const central = [];
        let offset = 0;
        const now = new Date();
        const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
        const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
        const u16 = value => [value & 0xFF, (value >>> 8) & 0xFF];
        const u32 = value => [value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF];
        for (const [name, content] of files) {
            const nameBytes = encoder.encode(name);
            const data = typeof content === 'string' ? encoder.encode(content) : content;
            const crc = CRC(data);
            const local = new Uint8Array([...u32(0x04034B50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0)]);
            parts.push(local, nameBytes, data);
            central.push(new Uint8Array([...u32(0x02014B50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nameBytes.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), nameBytes);
            offset += local.length + nameBytes.length + data.length;
        }
        const centralSize = central.reduce((sum, part) => sum + part.length, 0);
        const end = new Uint8Array([...u32(0x06054B50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(offset), ...u16(0)]);
        return new Blob([...parts, ...central, end], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    }

    // ---------- Word-XML ----------
    const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const tidy = value => String(value ?? '').replace(/\r\n?|[\v\f\u2028\u2029]/g, '\n').replace(/[\p{Cc}\p{Cf}]/gu, char => char === '\n' ? char : '').replace(/[ \t]+/g, ' ').trim();
    const rtl = text => window.DocPdf?.directionOf ? DocPdf.directionOf(text) === 'rtl' : /^[^A-Za-zÀ-ɏ]*[֐-ࣿ]/u.test(text);

    function run(text, { bold = false, size = 22, color = INK, italic = false } = {}) {
        const props = `<w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/>${bold ? '<w:b/><w:bCs/>' : ''}${italic ? '<w:i/><w:iCs/>' : ''}<w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`;
        return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
    }

    // Ein Absatz. Schreibrichtung nach dem ersten Buchstaben: arabisch → rechts-nach-links und rechtsbündig.
    function para(text, options = {}) {
        const { after = 120, before = 0, line = 300, align = '', border = '', keepNext = false, ...runOptions } = options;
        const isRtl = rtl(text);
        const justify = align || (isRtl ? 'right' : 'left');
        const props = `<w:pPr>${keepNext ? '<w:keepNext/>' : ''}${border}<w:spacing w:before="${before}" w:after="${after}" w:line="${line}" w:lineRule="auto"/><w:jc w:val="${justify}"/>${isRtl ? '<w:bidi/>' : ''}</w:pPr>`;
        return `<w:p>${props}${text ? run(text, runOptions) : ''}</w:p>`;
    }

    const RULE = `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="${LINE}"/></w:pBdr>`;

    function cell(content, width, { shade = '', borderBottom = true } = {}) {
        return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${borderBottom ? `<w:tcBorders><w:bottom w:val="single" w:sz="4" w:space="0" w:color="${LINE}"/></w:tcBorders>` : ''}${shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${shade}"/>` : ''}<w:tcMar><w:top w:w="70" w:type="dxa"/><w:bottom w:w="70" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr>${content}</w:tc>`;
    }

    // options = { organisation, title, meta: [[Beschriftung, Wert], …], sections: [{ heading, text }], footer, author }
    function report(options) {
        const { organisation, title, meta, sections, footer, author, subject } = options || {};
        const body = [];
        if (tidy(organisation)) body.push(para(tidy(organisation).replace(/\n/g, ' '), { size: 16, color: GREY, after: 160, border: RULE }));
        if (tidy(title)) body.push(para(tidy(title).replace(/\n/g, ' '), { bold: true, size: 40, after: 240 }));
        const rows = (Array.isArray(meta) ? meta : []).filter(row => Array.isArray(row) && tidy(row[1]));
        if (rows.length) {
            const widths = [2600, 6760];
            const tableRows = rows.map(([label, value]) => `<w:tr>${cell(para(tidy(label).replace(/\n/g, ' '), { size: 19, color: GREY, after: 0, line: 260 }), widths[0])}${cell(tidy(value).split('\n').map(part => para(part, { size: 21, after: 0, line: 260 })).join(''), widths[1])}</w:tr>`).join('');
            body.push(`<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders><w:top w:val="single" w:sz="6" w:space="0" w:color="${LINE}"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="${widths[0]}"/><w:gridCol w:w="${widths[1]}"/></w:tblGrid>${tableRows}</w:tbl>`);
            body.push(para('', { after: 120 }));
        }
        for (const section of Array.isArray(sections) ? sections : []) {
            if (!section || !tidy(section.text)) continue;
            if (tidy(section.heading)) body.push(para(tidy(section.heading).replace(/\n/g, ' '), { bold: true, size: 26, before: 240, after: 100, keepNext: true }));
            for (const paragraph of tidy(section.text).split('\n')) {
                if (!paragraph) { body.push(para('', { after: 60 })); continue; }
                body.push(para(paragraph, { size: 22, after: 100, line: 320 }));
            }
        }
        if (tidy(footer)) body.push(para(tidy(footer).replace(/\n/g, ' '), { size: 16, color: GREY, before: 360, after: 0, border: `<w:pBdr><w:top w:val="single" w:sz="6" w:space="6" w:color="${LINE}"/></w:pBdr>` }));

        const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
        const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}" w:eastAsia="${FONT}"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="de-DE" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`;
        const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
        const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(tidy(title))}</dc:title><dc:subject>${esc(tidy(subject))}</dc:subject><dc:creator>${esc(tidy(author))}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified></cp:coreProperties>`;
        const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
        const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
        const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
        return zip([['[Content_Types].xml', contentTypes], ['_rels/.rels', rels], ['word/_rels/document.xml.rels', documentRels], ['word/document.xml', document], ['word/styles.xml', styles], ['docProps/core.xml', core]]);
    }

    return { report };
})();
