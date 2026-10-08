// PDF direkt auf dem Handy oder PC – dafür wird nichts an einen Server geschickt.
//   DocPdf.build()     Seitenfotos eines Dokuments → EIN durchsuchbares PDF (Foto + unsichtbarer Text der Texterkennung)
//   DocPdf.report()    schriftlicher Bericht eines Dolmetschers → sauber gesetztes A4-Blatt
//   DocPdf.fileName()  einheitlicher Dateiname, z. B. „4103_Mansour-Layla_Rezept-Physiotherapie_2026-10-05.pdf“
//   DocPdf.canShow()   lässt sich ein Text vollständig setzen? (sonst besser die Druckansicht des Browsers anbieten)
//   DocPdf.ready()     lädt pdf-lib vorab – nötig ist das nicht, build() und report() tun es selbst
// pdf-lib (pdf-lib.min.js im selben Ordner) wird erst geladen, wenn wirklich ein PDF entsteht.
// Die Schrift ist Helvetica: Sie zeigt lateinische Zeichen (Umlaute, ß, €), aber z. B. kein Arabisch.
window.DocPdf = (function () {
    const LIBRARY = 'pdf-lib.min.js';
    const APP = 'Medical Office Bonn – Transport und Dolmetscher';
    const A4 = [595.28, 841.89];
    const MARGIN = 56;
    let libraryPromise = null;

    // Lädt pdf-lib einmal nach, wenn es noch nicht auf der Seite ist.
    function ready() {
        if (window.PDFLib) return Promise.resolve();
        if (!libraryPromise) {
            libraryPromise = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                const fail = () => {
                    libraryPromise = null;      // beim nächsten Versuch noch einmal laden
                    script.remove();
                    reject(new Error('Das PDF kann gerade nicht erstellt werden (pdf-lib.min.js wurde nicht geladen). Bitte die Verbindung prüfen und noch einmal versuchen.'));
                };
                script.src = LIBRARY;
                script.onload = () => window.PDFLib ? resolve() : fail();
                script.onerror = fail;
                document.head.append(script);
            });
        }
        return libraryPromise;
    }

    // ---------- Zeichen ----------
    // Helvetica kennt nur die Zeichen von Windows-1252 (WinAnsi): Latin-1 und die folgenden Sonderzeichen.
    const EXTRA = 'ŒœŠšŸŽžƒˆ˜–—‘’‚“”„†‡•…‰‹›€™';
    const PLAIN = /^[\n\x20-\x7E\xA0-\xAC\xAE-\xFF]*$/;
    // Gleichwertiger Ersatz für Zeichen, die es in WinAnsi nicht gibt, die aber genauso aussehen.
    const SWAPS = [
        [/[\u{2010}-\u{2012}\u{2212}]/gu, '-'],                                             // Bindestriche und Minus
        [/\u{2015}/gu, '—'],
        [/[\u{2007}\u{202F}]/gu, '\xA0'],                                                   // geschützte schmale Leerzeichen
        [/[\u{1680}\u{2000}-\u{2006}\u{2008}-\u{200A}\u{205F}\u{3000}]/gu, ' '],            // übrige Sonder-Leerzeichen
        [/[\u{2BC}\u{201B}]/gu, '\u{2019}'],                                                // Apostrophe
        [/\u{201F}/gu, '\u{201C}'],
        [/\u{2032}/gu, '\''],
        [/\u{2033}/gu, '"'],
        [/[\u{2044}\u{2215}]/gu, '/'],
        [/\u{3BC}/gu, 'µ'],                                                                 // griechisches My → Mikro (µg)
        [/[\u{FB00}-\u{FB04}]/gu, char => ['ff', 'fi', 'fl', 'ffi', 'ffl'][char.charCodeAt(0) - 0xFB00]]      // Ligaturen aus der Texterkennung
    ];
    const HIDDEN = /[\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}]/gu;      // Steuer- und Formatzeichen: ohnehin unsichtbar
    const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('de', { granularity: 'grapheme' }) : null;

    function showable(char) {
        const code = char.codePointAt(0);
        return (code >= 0x20 && code <= 0x7E) || (code >= 0xA0 && code <= 0xFF) || EXTRA.includes(char);
    }

    // Macht aus beliebigem Text einen, den Helvetica setzen kann. Jedes Zeichen, das nicht geht
    // (ein Emoji aus mehreren Teilen zählt als eines), wird zu „mark“ und gezählt.
    function clean(value, mark = '?') {
        let source = String(value ?? '').normalize('NFC');
        if (PLAIN.test(source)) return { text: source, replaced: 0 };
        source = source.replace(/\r\n?|[\v\f\x85\u{2028}\u{2029}]/gu, '\n').replace(/\t/g, ' ');
        for (const [pattern, replacement] of SWAPS) source = source.replace(pattern, replacement);
        const parts = segmenter ? Array.from(segmenter.segment(source), part => part.segment) : Array.from(source);
        let text = '';
        let replaced = 0;
        for (const part of parts) {
            const visible = part === '\n' ? part : part.replace(HIDDEN, '');
            if (!visible) continue;
            if (visible === '\n' || Array.from(visible).every(showable)) text += visible;
            else {
                text += mark;
                replaced += 1;
            }
        }
        return { text, replaced };
    }

    // true: Der Text lässt sich vollständig setzen. false: besser die Druckansicht des Browsers anbieten.
    function canShow(text) {
        return clean(text).replaced === 0;
    }

    // ---------- Gemeinsames ----------
    const widthCache = new WeakMap();
    const fontKeys = new WeakMap();
    const round = value => Math.round(value * 100) / 100;

    // Breite in Punkt – Zeichen für Zeichen, also genau so, wie der Text gesetzt wird (ohne Unterschneidung).
    function textWidth(font, text, size) {
        let widths = widthCache.get(font);
        if (!widths) widthCache.set(font, widths = new Map());
        let sum = 0;
        for (const char of text) {
            let width = widths.get(char);
            if (width === undefined) widths.set(char, width = font.widthOfTextAtSize(char, 1));
            sum += width;
        }
        return sum * size;
    }

    // Jede Schrift bekommt je Seite nur einen Eintrag (pdf-lib legt sonst für jede Zeile einen neuen an).
    function fontKey(page, font) {
        let keys = fontKeys.get(page);
        if (!keys) fontKeys.set(page, keys = new Map());
        if (!keys.has(font)) keys.set(font, page.node.newFontDictionary(font.name, font.ref));
        return keys.get(font);
    }

    // Angaben zum Dokument (in jedem PDF-Programm unter „Eigenschaften“).
    function describe(pdf, options) {
        const text = value => String(value ?? '').replace(/\s+/g, ' ').trim();
        const keywords = [].concat(options.keywords ?? []).map(text).filter(Boolean);
        const now = new Date();
        if (text(options.title)) pdf.setTitle(text(options.title));
        if (text(options.subject)) pdf.setSubject(text(options.subject));
        if (text(options.author)) pdf.setAuthor(text(options.author));
        if (keywords.length) pdf.setKeywords([keywords.join(', ')]);
        pdf.setCreator(APP);
        pdf.setProducer(APP);
        pdf.setCreationDate(now);
        pdf.setModificationDate(now);
        pdf.setLanguage('de-DE');
    }

    async function save(pdf) {
        return new Blob([await pdf.save({ useObjectStreams: false })], { type: 'application/pdf' });
    }

    // ---------- Durchsuchbares PDF aus Seitenfotos ----------

    // Drehung laut EXIF (1 = aufrecht … 8). Handy-Kameras speichern Hochkant-Fotos oft quer und merken sich nur die Drehung.
    function orientation(bytes) {
        try {
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let pos = 2; view.getUint8(pos) === 0xFF; pos += 2 + view.getUint16(pos + 2)) {
                const marker = view.getUint8(pos + 1);
                if (marker === 0xDA) break;      // ab hier folgen die Bilddaten
                if (marker !== 0xE1 || view.getUint32(pos + 4) !== 0x45786966) continue;      // nur der Abschnitt „Exif“
                const tiff = pos + 10;
                const little = view.getUint16(tiff) === 0x4949;
                const directory = tiff + view.getUint32(tiff + 4, little);
                const count = view.getUint16(directory, little);
                for (let index = 0; index < count; index++) {
                    const entry = directory + 2 + index * 12;
                    if (view.getUint16(entry, little) !== 0x0112) continue;
                    const turn = view.getUint16(entry + 8, little);
                    return turn >= 1 && turn <= 8 ? turn : 1;
                }
                break;
            }
        } catch (error) {
            // unvollständige Angaben: Das Foto bleibt, wie es ist.
        }
        return 1;
    }

    // Andere Formate (z. B. WebP oder HEIC) wandelt der Browser in JPEG um – sofern er sie lesen kann.
    async function asJpeg(blob) {
        const bitmap = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0);
        bitmap.close();
        const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
        canvas.width = canvas.height = 0;      // Speicher gleich wieder freigeben
        if (!jpeg) throw new Error('Das Bild lässt sich nicht in JPEG umwandeln.');
        return new Uint8Array(await jpeg.arrayBuffer());
    }

    // PNG mit Farbtabelle (so speichert DocScan.compact() eine Textseite): Die gepackten Bilddaten kommen unverändert ins PDF –
    // nichts wird entpackt oder neu gerechnet, die Seite bleibt so klein wie die PNG-Datei. Ergebnis: { ref, width, height } oder
    // null, wenn es kein solches PNG ist (dann legt pdf-lib das Bild auf dem üblichen Weg ab).
    function embedIndexedPng(pdf, bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let width = 0, height = 0, depth = 0, palette = null;
        const data = [];
        for (let pos = 8; pos + 12 <= bytes.length;) {
            const length = view.getUint32(pos), type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]), start = pos + 8;
            if (start + length + 4 > bytes.length) return null;
            if (type === 'IHDR') {
                width = view.getUint32(start); height = view.getUint32(start + 4); depth = bytes[start + 8];
                // nur Farbtabelle (Typ 3), übliche Packung, nicht verschachtelt
                if (bytes[start + 9] !== 3 || bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || bytes[start + 12] !== 0) return null;
            } else if (type === 'PLTE') palette = bytes.subarray(start, start + length);
            else if (type === 'tRNS') return null;                                     // durchsichtige Stellen: der übliche Weg
            else if (type === 'IDAT') data.push(bytes.subarray(start, start + length));
            else if (type === 'IEND') break;
            pos = start + length + 4;
        }
        if (!(width > 0 && height > 0) || ![1, 2, 4, 8].includes(depth) || !palette || palette.length < 3 || palette.length % 3 || !data.length) return null;
        const packed = new Uint8Array(data.reduce((sum, part) => sum + part.length, 0));
        let at = 0;
        for (const part of data) { packed.set(part, at); at += part.length; }
        const P = window.PDFLib;
        const table = Array.from(palette, value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
        const stream = pdf.context.stream(packed, {
            Type: 'XObject', Subtype: 'Image', Width: width, Height: height, BitsPerComponent: depth,
            ColorSpace: ['Indexed', 'DeviceRGB', palette.length / 3 - 1, P.PDFHexString.of(table)],
            Filter: 'FlateDecode', DecodeParms: { Predictor: 15, Colors: 1, BitsPerComponent: depth, Columns: width }
        });
        return { ref: pdf.context.register(stream), width, height };
    }

    // Legt das Foto im PDF ab. JPEG bleibt dabei unverändert (wird weder entpackt noch neu gerechnet) – ebenso ein PNG mit Farbtabelle.
    async function embedPicture(pdf, blob) {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
        const jpeg = bytes[0] === 0xFF && bytes[1] === 0xD8;
        let image = png ? embedIndexedPng(pdf, bytes) : null;
        if (!image) {
            image = png ? await pdf.embedPng(bytes) : await pdf.embedJpg(jpeg ? bytes : await asJpeg(blob));
            await image.embed();      // sofort ins PDF schreiben – Zwischenstände (z. B. das entpackte PNG) werden gleich wieder frei
        }
        const turn = jpeg ? orientation(bytes) : 1;
        const [width, height] = turn > 4 ? [image.height, image.width] : [image.width, image.height];
        if (!(width > 0 && height > 0)) throw new Error('Das Bild hat keine Größe.');
        return { image, turn, width, height };
    }

    // Zeichnet das Foto in das Rechteck x/y/w/h – so gedreht, wie es der Browser anzeigt (EXIF 1 … 8).
    function drawPicture(page, picture, x, y, w, h) {
        const P = window.PDFLib;
        const matrix = [
            [w, 0, 0, h, x, y], [-w, 0, 0, h, x + w, y], [-w, 0, 0, -h, x + w, y + h], [w, 0, 0, -h, x, y + h],
            [0, -h, -w, 0, x + w, y + h], [0, -h, w, 0, x, y + h], [0, h, w, 0, x, y], [0, h, -w, 0, x + w, y]
        ][picture.turn - 1];
        page.pushOperators(P.pushGraphicsState(), P.concatTransformationMatrix(...matrix.map(round)),
            P.drawObject(page.node.newXObject('Image', picture.image.ref)), P.popGraphicsState());
    }

    // Unsichtbarer Text über dem Foto: jedes erkannte Wort an seiner Stelle – zum Suchen, Markieren und Kopieren.
    // area: Lage des Fotos auf der Seite (left, top) und Punkt je Bildpixel (scaleX, scaleY).
    function drawWords(page, font, words, area) {
        const P = window.PDFLib;
        const items = [];
        for (const word of Array.isArray(words) ? words : []) {
            const text = clean(word?.text, '').text.replace(/\s+/g, ' ').trim();
            const frame = word?.bbox || word;      // { text, x0, y0, x1, y1 } oder – wie bei Tesseract – { text, bbox: { x0, y0, x1, y1 } }
            const box = [frame?.x0, frame?.y0, frame?.x1, frame?.y1].map(Number);
            if (!text || !box.every(Number.isFinite)) continue;
            const bottom = area.top - Math.max(box[1], box[3]) * area.scaleY;
            const height = Math.abs(box[3] - box[1]) * area.scaleY;
            // Schriftgröße aus der Höhe des Wortes: Der Rahmen der Texterkennung liegt eng um die Buchstaben, also zählt,
            // ob das Wort Ober- und Unterlängen hat (Helvetica: Oberlänge 0,718 · x-Höhe 0,523 · Unterlänge 0,207 · Akzent auf Großbuchstaben 0,9).
            const up = /[À-ÅÈ-ÏÑ-ÖÙ-Ý]/.test(text) ? 0.9 : /^[acegmnopqrsuvwxyz.,:;_+=<>~-]+$/.test(text) ? 0.523 : 0.718;
            const down = /[gjpqy,;()[\]{}|_$§µç„‚]/.test(text) ? 0.207 : 0;
            const size = Math.min(Math.max(height / (up + down), 1), 400);
            items.push({
                text, size, bottom, height,
                left: area.left + Math.min(box[0], box[2]) * area.scaleX,
                width: Math.abs(box[2] - box[0]) * area.scaleX,
                base: bottom + down * size,
                letters: /[\p{L}\p{N}]/u.test(text)
            });
        }
        if (!items.length) return;
        const key = fontKey(page, font);
        page.pushOperators(P.pushGraphicsState(), P.beginText(), P.setTextRenderingMode(P.TextRenderingMode.Invisible));
        items.forEach((item, index) => {
            // Ein einzelnes Satzzeichen (Bindestrich, Aufzählungspunkt …) verrät die Schriftgröße nicht:
            // Es übernimmt Größe und Grundlinie vom Nachbarwort in derselben Zeile.
            const middle = item.bottom + item.height / 2;
            const beside = item.letters ? null : [items[index - 1], items[index + 1]].find(other => other?.letters && middle > other.bottom && middle < other.bottom + other.height);
            const size = round((beside || item).size);
            // In der Breite so stauchen oder dehnen, dass das Wort seinen Rahmen füllt.
            const natural = textWidth(font, item.text, size);
            const squeeze = item.width > 0 && natural > 0 ? Math.min(Math.max(item.width / natural * 100, 5), 2000) : 100;
            page.pushOperators(
                P.setFontAndSize(key, size), P.setCharacterSqueeze(round(squeeze)),
                P.setTextMatrix(1, 0, 0, 1, round(item.left), round((beside || item).base)),
                P.showText(font.encodeText(`${item.text} `))      // das Leerzeichen trennt die Wörter beim Kopieren
            );
        });
        page.pushOperators(P.endText(), P.popGraphicsState());
    }

    // options = { pages: [{ blob, width, height, words: [{ text, x0, y0, x1, y1 }] }], title, subject, author, keywords: [] }
    // Jedes Foto wird eine A4-Seite (hoch oder quer), vollständig sichtbar und mittig. Ergebnis: Blob (application/pdf).
    async function build(options) {
        const { pages, ...details } = options || {};
        const sources = Array.isArray(pages) ? pages : [];
        if (!sources.length) throw new Error('Es gibt keine Seite zum Speichern.');
        await ready();
        const P = window.PDFLib;
        const pdf = await P.PDFDocument.create();
        const font = pdf.embedStandardFont(P.StandardFonts.Helvetica);
        describe(pdf, details);
        // Eine Seite nach der anderen: Es ist immer nur ein Foto in Arbeit.
        for (let index = 0; index < sources.length; index++) {
            const source = sources[index] || {};
            let picture;
            try {
                picture = await embedPicture(pdf, source.blob);
            } catch (error) {
                throw new Error(`Seite ${index + 1} konnte nicht gelesen werden. Bitte diese Seite noch einmal fotografieren.`, { cause: error });
            }
            const size = picture.height > picture.width ? A4 : [A4[1], A4[0]];
            const scale = Math.min(size[0] / picture.width, size[1] / picture.height);
            const width = picture.width * scale;
            const height = picture.height * scale;
            const left = (size[0] - width) / 2;
            const bottom = (size[1] - height) / 2;
            const page = pdf.addPage(size);
            drawPicture(page, picture, left, bottom, width, height);
            // Die Wortrahmen gelten in den Bildpixeln, die der Aufrufer nennt (sonst in denen des Fotos).
            drawWords(page, font, source.words, {
                left,
                top: bottom + height,
                scaleX: width / (source.width > 0 ? Number(source.width) : picture.width),
                scaleY: height / (source.height > 0 ? Number(source.height) : picture.height)
            });
        }
        return save(pdf);
    }

    // ---------- Bericht ----------
    const INK = [0.08, 0.13, 0.22];       // Titel und Überschriften
    const BLACK = [0, 0, 0];
    const GREY = [0.39, 0.45, 0.55];      // Beschriftungen, Kopf- und Fußzeile
    const RULE = [0.8, 0.84, 0.88];       // feine Linien

    // Setzt eine Textzeile; y ist die Grundlinie.
    function put(page, font, text, x, y, size, color) {
        const P = window.PDFLib;
        page.pushOperators(P.beginText(), P.setFillingRgbColor(...color), P.setFontAndSize(fontKey(page, font), size),
            P.setTextMatrix(1, 0, 0, 1, round(x), round(y)), P.showText(font.encodeText(text)), P.endText());
    }

    // Feine Linie über die ganze Textbreite.
    function rule(page, y) {
        page.drawLine({ start: { x: MARGIN, y }, end: { x: A4[0] - MARGIN, y }, thickness: 0.6, color: window.PDFLib.rgb(...RULE) });
    }

    // Bricht einen Absatz in Zeilen um. Überlange Wörter (z. B. Internetadressen) werden geteilt, damit nichts über den Rand läuft.
    function wrap(text, font, size, maxWidth) {
        const lines = [];
        let line = '';
        for (let word of text.split(' ').filter(Boolean)) {
            if (line && textWidth(font, `${line} ${word}`, size) <= maxWidth) {
                line += ` ${word}`;
                continue;
            }
            if (line) lines.push(line);
            // Passt das Wort nicht einmal allein in eine Zeile, wird es Stück für Stück geteilt.
            for (;;) {
                let cut = 0;
                let used = 0;
                while (cut < word.length && (used += textWidth(font, word[cut], size)) <= maxWidth) cut += 1;
                if (cut === word.length) break;
                cut = Math.max(cut, 1);      // mindestens ein Zeichen je Zeile, damit es immer weitergeht
                const soft = word.slice(0, cut).search(/[\/\\_.,;:?&=+@-][^\/\\_.,;:?&=+@-]*$/) + 1;      // lieber nach / . - ? & = trennen
                if (soft > cut / 2) cut = soft;
                lines.push(word.slice(0, cut));
                word = word.slice(cut);
            }
            line = word;
        }
        if (line) lines.push(line);
        return lines;
    }

    // Wie wrap(), aber höchstens „max“ Zeilen – der Rest wird mit „…“ abgeschnitten (Kopf- und Fußzeile).
    function wrapShort(text, font, size, maxWidth, max) {
        const lines = wrap(text.replace(/\n/g, ' '), font, size, maxWidth);
        if (lines.length <= max) return lines;
        let last = lines[max - 1];
        while (last && textWidth(font, `${last}…`, size) > maxWidth) last = last.slice(0, -1);
        return [...lines.slice(0, max - 1), `${last.trimEnd()}…`];
    }

    // options = { organisation, title, meta: [[Beschriftung, Wert], …], sections: [{ heading, text }], footer }
    // (zusätzlich möglich: author, subject, keywords für die PDF-Angaben). Ergebnis: { blob, replaced }.
    // organisation steht klein über jeder Seite, footer unten links, rechts „Seite x von y“.
    // Zeilen ohne Wert und Abschnitte ohne Text entfallen. replaced = Zeichen, die Helvetica nicht kennt und die als „?“ erscheinen.
    async function report(options) {
        const { organisation, title, meta, sections, footer, ...details } = options || {};
        await ready();
        const P = window.PDFLib;
        const pdf = await P.PDFDocument.create();
        const regular = pdf.embedStandardFont(P.StandardFonts.Helvetica);
        const bold = pdf.embedStandardFont(P.StandardFonts.HelveticaBold);
        describe(pdf, { ...details, title });

        let replaced = 0;
        const show = value => {
            const result = clean(value);
            replaced += result.replaced;
            return result.text.split('\n').map(line => line.replace(/ +/g, ' ').trim()).join('\n').trim();
        };
        const empty = value => !clean(value).text.trim();
        const width = A4[0] - 2 * MARGIN;
        const head = wrapShort(show(organisation), regular, 8, width, 1)[0];

        // Schreibmarke: y ist die Oberkante der nächsten Zeile, fresh = auf dieser Seite steht noch nichts.
        let page = null;
        let y = 0;
        let fresh = true;
        const newPage = () => {
            page = pdf.addPage(A4);
            y = A4[1] - MARGIN;
            fresh = true;
            if (!head) return;
            put(page, regular, head, MARGIN, A4[1] - 38, 8, GREY);      // Kopfzeile im oberen Rand
            rule(page, A4[1] - 46);
        };
        // Reserviert eine Zeile der Höhe height. gap = Abstand davor (entfällt oben auf der Seite),
        // keep = Platz, der danach noch auf dieselbe Seite passen muss. Liefert die Oberkante der Zeile.
        const take = (height, gap = 0, keep = 0) => {
            if (!fresh && y - gap - height - keep < MARGIN) newPage();      // eine noch leere Seite wird nie übersprungen
            if (!fresh) y -= gap;
            fresh = false;
            y -= height;
            return y + height;
        };
        // Grundlinie einer Zeile, deren Buchstaben in der Zeilenhöhe mittig sitzen.
        const baseline = (top, lineHeight, size) => top - (lineHeight - 0.925 * size) / 2 - 0.718 * size;

        // Titel
        newPage();
        const headline = show(title).replace(/\n/g, ' ');
        if (headline) {
            y -= 14;
            for (const line of wrap(headline, bold, 20, width)) put(page, bold, line, MARGIN, baseline(take(25), 25, 20), 20, INK);
        }

        // Tabelle: Beschriftung grau, Wert schwarz – lange Werte laufen in der rechten Spalte weiter.
        const rows = (Array.isArray(meta) ? meta : [])
            .filter(row => Array.isArray(row) && !empty(row[1]))
            .map(row => ({ label: show(row[0]).replace(/\n/g, ' '), value: show(row[1]) }));
        if (rows.length) {
            const labelWidth = Math.min(Math.max(...rows.map(row => textWidth(regular, row.label, 9.5))), width * 0.3);
            const valueLeft = MARGIN + labelWidth + 18;
            const valueWidth = A4[0] - MARGIN - valueLeft;
            let first = true;
            for (const row of rows) {
                const labels = wrap(row.label, regular, 9.5, labelWidth);
                const values = row.value.split('\n').flatMap(part => wrap(part, regular, 10.5, valueWidth));
                const count = Math.max(labels.length, values.length);
                for (let index = 0; index < count; index++) {
                    const above = index === 0 ? 5 : 0;
                    const below = index === count - 1 ? 5 : 0;
                    // Eine Zeile der Tabelle bleibt zusammen, solange sie auf eine Seite passt.
                    const keep = index === 0 && count * 14 + 10 < A4[1] - 2 * MARGIN ? (count - 1) * 14 + 5 - below : 0;
                    const before = page;
                    const top = take(above + 14 + below, first ? 16 : 0, keep);
                    if (index === 0 && (first || page !== before)) rule(page, top);
                    first = false;
                    const line = baseline(top - above, 14, 10.5);
                    if (labels[index]) put(page, regular, labels[index], MARGIN, line, 9.5, GREY);
                    if (values[index]) put(page, regular, values[index], valueLeft, line, 10.5, BLACK);
                }
                rule(page, y);
            }
        }

        // Abschnitte: Überschrift fett, Text 11 pt. Neue Zeile = neuer Absatz, Leerzeile = größerer Abstand.
        for (const section of Array.isArray(sections) ? sections : []) {
            if (!section || empty(section.text)) continue;
            const heading = show(section.heading).replace(/\n/g, ' ');
            const paragraphs = show(section.text).split('\n');
            let gap = heading ? 24 : 14;
            if (heading) {
                const lines = wrap(heading, bold, 13, width);
                lines.forEach((line, index) => {
                    // Die Überschrift bleibt nie allein am Seitenende: Der Anfang des Textes muss noch darunter passen.
                    const top = index ? take(17) : take(17, gap, (lines.length - 1) * 17 + 6 + 3 * 15.5);
                    put(page, bold, line, MARGIN, baseline(top, 17, 13), 13, INK);
                });
                gap = 6;
            }
            for (const paragraph of paragraphs) {
                if (!paragraph) {
                    gap = 12;
                    continue;
                }
                // Aufzählung („- …“, „• …“): Folgezeilen stehen eingerückt unter dem Text.
                const bullet = (paragraph.match(/^[-–•*·] /) || [''])[0];
                const indent = textWidth(regular, bullet, 11);
                const lines = wrap(paragraph.slice(bullet.length), regular, 11, width - indent);
                lines.forEach((line, index) => {
                    // Keine einzelne Zeile eines Absatzes allein am Seitenende oder Seitenanfang:
                    // Zur ersten und zur vorletzten Zeile muss die nächste noch dazupassen (bis drei Zeilen bleibt der Absatz ganz zusammen).
                    const keep = index === 0 ? Math.min(lines.length - 1, lines.length > 3 ? 1 : 2) : index === lines.length - 2 ? 1 : 0;
                    const row = baseline(take(15.5, index ? 0 : gap, keep * 15.5), 15.5, 11);
                    put(page, regular, index ? line : bullet + line, MARGIN + (index ? indent : 0), row, 11, BLACK);
                });
                gap = 5;
            }
        }

        // Fußzeile erst jetzt – erst hier steht fest, wie viele Seiten es sind.
        const pages = pdf.getPages();
        const foot = wrapShort(show(footer), regular, 8, width - 90, 2);
        pages.forEach((sheet, index) => {
            const number = `Seite ${index + 1} von ${pages.length}`;
            rule(sheet, 44);
            foot.forEach((line, row) => put(sheet, regular, line, MARGIN, 31 - row * 10, 8, GREY));
            put(sheet, regular, number, A4[0] - MARGIN - textWidth(regular, number, 8), 31, 8, GREY);
        });
        return { blob: await save(pdf), replaced };
    }

    // ---------- Dateiname ----------
    const UMLAUTS = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', ẞ: 'SS' };

    // Nur A–Z, a–z, 0–9 und „-“: Umlaute werden ausgeschrieben (in GROSS geschriebenen Wörtern groß: Ü → UE),
    // Akzente weggelassen (é → e), alles andere wird zu „-“.
    function safe(value) {
        const spell = (char, index, text) => {
            const next = text[index + 1] || '';
            const beside = /\p{L}/u.test(next) ? next : text[index - 1] || '';
            return /[ÄÖÜßẞ]/.test(char) && /[A-ZÄÖÜẞ]/.test(beside) ? UMLAUTS[char].toUpperCase() : UMLAUTS[char];
        };
        return String(value ?? '').normalize('NFC').replace(/[äöüÄÖÜßẞ]/g, spell)
            .normalize('NFD').replace(/[\u{300}-\u{36F}]/gu, '')
            .replace(/[^A-Za-z0-9]+/g, '-').slice(0, 60).replace(/^-+|-+$/g, '');
    }

    // parts = { patientNr, patientName, kind, date: 'JJJJ-MM-TT', ext = 'pdf' } → z. B. „4103_Mansour-Layla_Rezept-Physiotherapie_2026-10-05.pdf“.
    // Der Nachname steht vorn: bei „Layla Mansour“ ist es das letzte Wort, bei „Mansour, Layla“ der Teil vor dem Komma.
    function fileName(parts) {
        const { patientNr, patientName, kind, date, ext } = parts || {};
        const name = String(patientName ?? '');
        const words = (name.includes(',') ? name.split(',') : name.trim().split(/\s+/)).map(safe).filter(Boolean);
        if (!name.includes(',') && words.length > 1) words.unshift(words.pop());
        const day = date instanceof Date ? date.toLocaleDateString('sv-SE') : date;
        const base = [safe(patientNr), words.join('-'), safe(kind), safe(day)].filter(Boolean).join('_') || 'Dokument';
        return `${base}.${safe(ext).replace(/-/g, '').toLowerCase() || 'pdf'}`;
    }

    return { ready, build, report, fileName, canShow };
})();
