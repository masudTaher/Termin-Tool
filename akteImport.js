// Papierakte einlesen – das Einlesen selbst (ohne Oberfläche).
// Eine große Scan-Datei (PDF) oder mehrere Fotos werden Seite für Seite geöffnet, wie von einem Scanner aufbereitet
// (weißes Papier, kräftige Schrift, gerade gerückt, richtig herum gedreht), leere Seiten erkannt und der Text gelesen.
// Alles geschieht in diesem Browser auf diesem Rechner: Keine Seite verlässt ihn, bevor das Büro auf „Speichern“ tippt.
//
//   const run = AkteImport.start(files, { onProgress, onPage });   → { done: Promise<{ pages, problems }>, cancel() }
//   Seite: { index, label, file, pageNo, blob, compact, width, height, thumb, text, words, blank, ink, angle, turned, confidence, source, clean, cropped, error }
//          blob: die Seite als JPEG · compact: dieselbe Seite Platz sparend (PNG mit 16 Tönen, etwa ein Drittel so groß) – nur bei reinen
//          Textseiten, sonst null (Fotos, Farbflächen, graue Felder bleiben JPEG)
//          source: 'pdf' (Text stand schon in der Datei) | 'ocr' (Texterkennung) | '' (kein Text)
//          cropped: Foto mit Tisch drumherum – das Blatt wurde erkannt, zugeschnitten und gerade gezogen
//   AkteImport.createReader(count)  → die Texterkennung allein: { recognize(blob), terminate() } (für „Scan verbessern“)
//
// Braucht docScan.js. PDF: vendor/pdfjs (liegt beim Programm). Texterkennung: tesseract.js – wird erst geladen, wenn eine Seite
// keinen Text mitbringt. AkteImport.ocrFactory lässt sich ersetzen (Tests, andere Erkennung).
const AkteImport = (() => {
    const PDF_LIB = 'vendor/pdfjs/pdf.min.js';
    const PDF_WORKER = 'vendor/pdfjs/pdf.worker.min.js';
    const PDF_WASM = 'vendor/pdfjs/wasm/';
    const PDF_FONTS = 'vendor/pdfjs/standard_fonts/';
    const OCR_LIBRARY = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    // ---------- QR-Code auf dem Blatt? ----------
    // Gesucht werden die drei Eck-Quadrate eines QR-Codes (dunkel–hell–dunkel–hell–dunkel im Verhältnis 1:1:3:1:1, waagerecht und
    // senkrecht), die zusammen ein rechtwinkliges Dreieck bilden. Der Code wird nicht gelesen – es zählt nur, dass einer da ist
    // (Blatt mit dem Zugang zu den Bildern einer Untersuchung).
    function hasQr(canvas) {
        try {
            const scale = Math.min(1, 1500 / Math.max(canvas.width, canvas.height));
            const w = Math.max(1, Math.round(canvas.width * scale)), h = Math.max(1, Math.round(canvas.height * scale));
            const small = document.createElement('canvas');
            small.width = w; small.height = h;
            const context = small.getContext('2d', { willReadFrequently: true });
            context.drawImage(canvas, 0, 0, w, h);
            const data = context.getImageData(0, 0, w, h).data;
            const dark = new Uint8Array(w * h);
            for (let i = 0, p = 0; i < dark.length; i += 1, p += 4) dark[i] = (data[p] * 3 + data[p + 1] * 6 + data[p + 2]) < 1150 ? 1 : 0;      // dunkler als ≈ 115 von 255
            // Fünf Läufe ab einer Stelle prüfen: 1:1:3:1:1 (Abweichung bis zur Hälfte eines Moduls)
            const ratio = runs => {
                const total = runs[0] + runs[1] + runs[2] + runs[3] + runs[4];
                if (total < 14) return 0;
                const unit = total / 7, slack = unit * 0.6;
                return Math.abs(runs[0] - unit) < slack && Math.abs(runs[1] - unit) < slack && Math.abs(runs[2] - 3 * unit) < slack * 1.6 && Math.abs(runs[3] - unit) < slack && Math.abs(runs[4] - unit) < slack ? unit : 0;
            };
            // senkrecht durch die Mitte nachmessen
            const upright = (x, y, unit) => {
                if (!dark[y * w + x]) return 0;
                let top = y, bottom = y;
                while (top > 0 && dark[(top - 1) * w + x]) top -= 1;
                while (bottom < h - 1 && dark[(bottom + 1) * w + x]) bottom += 1;
                const core = bottom - top + 1;
                if (Math.abs(core - 3 * unit) > unit * 1.2) return 0;
                const walk = (from, step, want) => { let count = 0, at = from; while (at >= 0 && at < h && dark[at * w + x] === want && count < unit * 3) { count += 1; at += step; } return [count, at]; };
                const [lightUp, a] = walk(top - 1, -1, 0), [darkUp] = walk(a, -1, 1);
                const [lightDown, b] = walk(bottom + 1, 1, 0), [darkDown] = walk(b, 1, 1);
                const fits = value => Math.abs(value - unit) < unit * 0.7;
                return fits(lightUp) && fits(darkUp) && fits(lightDown) && fits(darkDown) ? (top + bottom) / 2 : 0;
            };
            const found = [];      // { x, y, unit, hits }
            for (let y = 2; y < h - 2; y += 2) {
                const row = y * w;
                const runs = [];      // [Farbe, Länge, Anfang]
                let start = 0;
                for (let x = 1; x <= w; x += 1) {
                    if (x === w || dark[row + x] !== dark[row + x - 1]) { runs.push([dark[row + x - 1], x - start, start]); start = x; }
                }
                for (let i = 0; i + 4 < runs.length; i += 1) {
                    if (!runs[i][0]) continue;
                    const unit = ratio([runs[i][1], runs[i + 1][1], runs[i + 2][1], runs[i + 3][1], runs[i + 4][1]]);
                    if (!unit) continue;
                    const cx = Math.round(runs[i + 2][2] + runs[i + 2][1] / 2);
                    const cy = upright(cx, y, unit);
                    if (!cy) continue;
                    const near = found.find(item => Math.abs(item.x - cx) < unit * 2.5 && Math.abs(item.y - cy) < unit * 2.5);
                    if (near) near.hits += 1; else found.push({ x: cx, y: cy, unit, hits: 1 });
                }
            }
            const marks = found.filter(item => item.hits >= 2);
            // Drei Ecken: zwei gleich lange Seiten im rechten Winkel, gleich große Module
            for (let a = 0; a < marks.length; a += 1) for (let b = 0; b < marks.length; b += 1) for (let c = b + 1; c < marks.length; c += 1) {
                if (a === b || a === c) continue;
                const A = marks[a], B = marks[b], C = marks[c];
                const units = [A.unit, B.unit, C.unit], unit = (units[0] + units[1] + units[2]) / 3;
                if (Math.max(...units) > Math.min(...units) * 1.6) continue;
                const ab = Math.hypot(B.x - A.x, B.y - A.y), ac = Math.hypot(C.x - A.x, C.y - A.y);
                if (ab < unit * 12 || ab > unit * 180 || Math.abs(ab - ac) > Math.max(ab, ac) * 0.14) continue;
                const cosine = ((B.x - A.x) * (C.x - A.x) + (B.y - A.y) * (C.y - A.y)) / (ab * ac);
                if (Math.abs(cosine) < 0.16) return true;
            }
            return false;
        } catch (error) { return false; }
    }

    const LIMITS = {
        side: 2200,             // längere Seite der gespeicherten Seite (A4 ≈ 190 dpi)
        photoSide: 3000,        // so groß wird ein Foto geladen (das Blatt füllt es selten ganz)
        thumb: 300,             // Vorschaubild: längere Seite
        quality: 0.8,           // JPEG-Güte der Seite
        thumbQuality: 0.6,
        textMin: 60,            // so viele Zeichen muss der Text aus der PDF-Datei haben, damit keine Texterkennung nötig ist
        goodWords: 10,          // … und so viele lesbare Wörter
        lowConfidence: 55,      // Texterkennung unsicherer als das: Seite steht vielleicht auf dem Kopf oder quer
        cleanWhite: 0.6,        // Seite direkt aus dem Computer (kein Scan): so viel reines Weiß …
        cleanTint: 0.02,        // … und fast keine getönten hellen Stellen
        cropShare: 0.85,        // Foto: Stößt das erkannte Blatt an einen Bildrand, wird nur zugeschnitten, wenn es höchstens so viel des Bildes füllt
        workers: 3,             // gleichzeitig laufende Texterkennungen (höchstens)
        ocrTimeout: 120000,
        maxFileBytes: 1500 * 1024 * 1024
    };

    const absolute = path => new URL(path, document.baseURI).href;
    const makeCanvas = (width, height) => Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });
    const context = canvas => canvas.getContext('2d', { willReadFrequently: true });
    const toBlob = (canvas, quality) => new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Die Seite konnte nicht gespeichert werden.')), 'image/jpeg', quality));
    const within = (promise, ms, message) => Promise.race([promise, new Promise((unused, reject) => window.setTimeout(() => reject(new Error(message || 'Zeit abgelaufen')), ms))]);
    const isPdf = file => /pdf$/i.test(file.type || '') || /\.pdf$/i.test(file.name || '');
    const isImage = file => /^image\/(jpeg|png|webp)$/i.test(file.type || '') || /\.(jpe?g|png|webp)$/i.test(file.name || '');

    // ---------- PDF-Bibliothek (liegt beim Programm, wird erst bei Bedarf geladen) ----------
    let pdfLib = null;
    function loadPdf() {
        if (!pdfLib) {
            pdfLib = import(absolute(PDF_LIB)).then(lib => { lib.GlobalWorkerOptions.workerSrc = absolute(PDF_WORKER); return lib; })
                .catch(error => { pdfLib = null; throw new Error(`Die PDF-Anzeige konnte nicht geladen werden (${error.message || error}). Bitte die Seite neu laden – am besten mit einem aktuellen Chrome oder Edge.`); });
        }
        return pdfLib;
    }
    // Öffnet eine PDF-Datei. Große Dateien werden stückweise gelesen (nicht ganz in den Arbeitsspeicher geladen).
    async function openPdf(file, password) {
        const lib = await loadPdf();
        const common = { wasmUrl: absolute(PDF_WASM), standardFontDataUrl: absolute(PDF_FONTS), isEvalSupported: false, password: password || undefined };
        const url = URL.createObjectURL(file);
        try {
            const doc = await lib.getDocument({ ...common, url, rangeChunkSize: 1024 * 1024, disableAutoFetch: true }).promise;
            return { lib, doc, close: async () => { try { await doc.destroy(); } catch (error) { /* schon zu */ } URL.revokeObjectURL(url); } };
        } catch (error) {
            URL.revokeObjectURL(url);
            if (error?.name === 'PasswordException') throw Object.assign(new Error('Diese PDF-Datei ist mit einem Kennwort geschützt.'), { code: 'password' });
            // Stückweises Lesen nicht möglich? Dann die Datei im Ganzen öffnen.
            const doc = await lib.getDocument({ ...common, data: await file.arrayBuffer() }).promise
                .catch(second => { throw new Error(second?.name === 'InvalidPDFException' ? 'Die Datei ist keine gültige PDF-Datei (oder beschädigt).' : `Die PDF-Datei konnte nicht geöffnet werden: ${second?.message || second}`); });
            return { lib, doc, close: async () => { try { await doc.destroy(); } catch (ignored) { /* schon zu */ } } };
        }
    }

    // Text, der schon in der PDF-Datei steht (vom Scanner erkannt oder am Computer geschrieben) – mit der Lage jedes Stücks.
    function textOf(content, viewport, lib) {
        const words = [];
        let text = '';
        (content?.items || []).forEach(item => {
            if (typeof item.str !== 'string') return;
            if (item.str.trim()) {
                const m = lib.Util.transform(viewport.transform, item.transform);
                const height = Math.hypot(m[2], m[3]) || Math.abs(m[3]) || 10;
                const width = Math.abs(item.width * viewport.scale) || item.str.length * height * 0.5;
                // Stücke mit mehreren Wörtern gleichmäßig aufteilen – genau genug zum Suchen und Markieren.
                const parts = item.str.split(/(\s+)/);
                const total = item.str.length || 1;
                let offset = 0;
                parts.forEach(part => {
                    if (part.trim()) words.push({ text: part, x0: m[4] + width * offset / total, y0: m[5] - height, x1: m[4] + width * (offset + part.length) / total, y1: m[5] });
                    offset += part.length;
                });
            }
            text += item.str + (item.hasEOL ? '\n' : (item.str && !/\s$/.test(item.str) ? ' ' : ''));
        });
        return { text: text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim(), words };
    }
    // Lesbare Wörter zählen (wie akteLogic.js) – erkennt Buchstabensalat.
    function goodWords(text) {
        const folded = String(text || '').toLocaleLowerCase('de').replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '');
        return (folded.match(/[a-z]{4,}/g) || []).filter(word => /[aeiouy]/.test(word) && !/[^aeiouy]{5,}/.test(word) && !/(.)\1\1/.test(word)).length;
    }

    // Kommt die Seite direkt aus dem Computer (reines Weiß, keine Körnung)? Dann bleibt sie, wie sie ist.
    function looksClean(canvas) {
        const side = 160, scale = side / Math.max(canvas.width, canvas.height);
        const small = makeCanvas(canvas.width * scale, canvas.height * scale), ctx = context(small);
        ctx.drawImage(canvas, 0, 0, small.width, small.height);
        const { data } = ctx.getImageData(0, 0, small.width, small.height);
        let white = 0, tinted = 0;
        for (let p = 0; p < data.length; p += 4) {
            const low = Math.min(data[p], data[p + 1], data[p + 2]), high = Math.max(data[p], data[p + 1], data[p + 2]);
            if (low >= 250) white++;
            else if (low >= 190 && (high - low > 6 || low < 244)) tinted++;
        }
        const count = data.length / 4;
        return white / count >= LIMITS.cleanWhite && tinted / count <= LIMITS.cleanTint;
    }

    function thumbOf(canvas) {
        const scale = Math.min(1, LIMITS.thumb / Math.max(canvas.width, canvas.height));
        const small = makeCanvas(canvas.width * scale, canvas.height * scale), ctx = context(small);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, 0, 0, small.width, small.height);
        return toBlob(small, LIMITS.thumbQuality);
    }
    function scaled(canvas, factor) {
        const small = makeCanvas(canvas.width * factor, canvas.height * factor), ctx = context(small);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, 0, 0, small.width, small.height);
        return small;
    }

    // ---------- Texterkennung ----------
    let ocrLibrary = null;
    function loadOcr() {
        if (window.Tesseract) return Promise.resolve(window.Tesseract);
        if (!ocrLibrary) {
            ocrLibrary = new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = OCR_LIBRARY;
                script.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Texterkennung nicht verfügbar'));
                script.onerror = () => { ocrLibrary = null; reject(new Error('Die Texterkennung konnte nicht geladen werden (kein Internet?).')); };
                document.head.append(script);
            });
        }
        return ocrLibrary;
    }
    // Mehrere Erkennungen arbeiten gleichzeitig. Ergebnis je Seite: { text, words: [{ text, x0, y0, x1, y1 }], confidence }
    async function defaultOcr(count) {
        const Tesseract = await within(loadOcr(), 60000, 'Die Texterkennung konnte nicht geladen werden.');
        const scheduler = Tesseract.createScheduler();
        for (let index = 0; index < count; index++) {
            const worker = await within(Tesseract.createWorker('deu', 1), 90000, 'Die Texterkennung startet nicht.');
            // Die Seite als Ganzes zerlegen (Briefköpfe in zwei Spalten, Tabellen, quer liegende Schrift) – nicht als einen einzigen Textblock lesen.
            try { await worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM?.AUTO || '3' }); } catch (error) { /* dann mit der Vorgabe */ }
            scheduler.addWorker(worker);
        }
        return {
            workers: count,
            recognize: async blob => {
                const { data } = await within(scheduler.addJob('recognize', blob), LIMITS.ocrTimeout, 'Die Texterkennung braucht zu lange.');
                return {
                    text: String(data?.text || ''), confidence: Number(data?.confidence || 0),
                    words: (data?.words || []).filter(word => word?.text && word.bbox).map(word => ({ text: word.text, x0: word.bbox.x0, y0: word.bbox.y0, x1: word.bbox.x1, y1: word.bbox.y1 }))
                };
            },
            terminate: () => scheduler.terminate().catch(() => null)
        };
    }

    // ---------- Der Lauf ----------
    function start(files, { onProgress = () => {}, onPage = () => {}, ocr: wantOcr = true, workers } = {}) {
        let cancelled = false;
        const state = { phase: 'öffnen', done: 0, total: 0, file: '', started: Date.now(), seconds: null, ocr: '' };
        const report = change => { Object.assign(state, change); try { onProgress({ ...state }); } catch (error) { /* Anzeige darf den Lauf nicht stören */ } };
        const pages = [], problems = [];
        let engine = null, engineOff = false, engineError = '';

        async function getOcr() {
            if (!wantOcr || engineOff) return null;
            if (!engine) {
                const count = Math.max(1, Math.min(workers || LIMITS.workers, (navigator.hardwareConcurrency || 4) - 1));
                report({ ocr: 'lädt' });
                engine = Promise.resolve().then(() => (api.ocrFactory || defaultOcr)(count)).then(ready => { report({ ocr: 'bereit' }); return ready; })
                    .catch(error => { engineOff = true; engineError = error.message || String(error); report({ ocr: 'aus' }); return null; });
            }
            return engine;
        }

        // Liegt die Schrift quer? Dann sind die Rahmen der Wörter höher als breit.
        const sideways = result => {
            const boxes = (result.words || []).filter(word => String(word.text).length >= 4);
            return boxes.length >= 6 && boxes.filter(word => (word.y1 - word.y0) > 1.4 * (word.x1 - word.x0)).length / boxes.length > 0.6;
        };
        // Eine fertig gezeichnete Seite: aufbereiten, lesen, speichern.
        async function finish(canvas, entry, embedded, photo = false) {
            const info = { ...entry, blank: false, ink: 0, angle: 0, turned: 0, confidence: 0, source: '', text: '', words: [], clean: false, cropped: false, error: '' };
            info.clean = looksClean(canvas);
            let base;
            if (photo && !info.clean) {
                // Foto (JPG/PNG): wie in der Scan-App – das Blatt suchen, zuschneiden, gerade ziehen und aufbereiten.
                // Wird kein Blatt sicher erkannt, bleibt das ganze Bild (ein Flachbett-Scan füllt es ohnehin).
                // Zugeschnitten wird nur, wenn das Blatt klar im Bild liegt: ringsum Tisch – oder an einer Seite angeschnitten und
                // deutlich kleiner als das Bild. Füllt das „Blatt“ fast das ganze Bild, ist es meist eine gescannte Seite mit farbigem
                // Balken oben und unten (Briefkopf, Fußzeile) – und der gehört zur Seite. Dann bleibt alles stehen.
                const found = DocScan.detect(canvas);
                const sure = Boolean(found && found.confidence >= DocScan.LIMITS.confidence);
                const inside = sure && (found.open === 0 || (found.open === 1 && found.share <= LIMITS.cropShare));
                const shot = await DocScan.process(null, { original: canvas, maxSide: LIMITS.side, ...(inside ? { corners: found.corners } : sure ? { crop: false } : {}) });
                base = shot.canvas;
                info.cropped = shot.cropped;
            } else {
                // Scan: wie von einem guten Scanner aufbereiten. Seiten direkt aus dem Computer bleiben, wie sie sind.
                base = info.clean ? canvas : DocScan.enhance(canvas);
            }
            // Gerade rücken – außer bei Seiten aus dem Computer und bei zugeschnittenen Fotos (die sind schon gerade gezogen).
            const level = sheet => { if (info.clean || info.cropped) return { canvas: sheet, angle: 0 }; return DocScan.straighten(sheet); };
            let { canvas: sheet, angle } = level(base);
            info.angle = angle;
            const empty = DocScan.blank(sheet);
            info.blank = empty.blank;
            info.ink = empty.ink;
            const hasText = embedded && embedded.text.length >= LIMITS.textMin && goodWords(embedded.text) >= LIMITS.goodWords;
            if (hasText) {
                // Der Text steht schon in der Datei. Nach dem Geraderücken stimmt die Lage der Wörter nicht mehr genau – dann nur der Text.
                info.source = 'pdf';
                info.text = embedded.text;
                info.words = info.angle ? [] : embedded.words;
                info.confidence = 100;
                info.blank = false;
            } else if (!info.blank) {
                const reader = await getOcr();
                if (reader) {
                    try {
                        let result = await reader.recognize(await toBlob(sheet, 0.9));
                        const across = sideways(result);
                        if (across || result.confidence < LIMITS.lowConfidence || goodWords(result.text) < 12) {
                            // Schlecht lesbar oder quer: steht die Seite auf dem Kopf oder liegt sie auf der Seite? Auf einer halb so großen
                            // Kopie ausprobieren – es gewinnt die Lage, in der die Texterkennung sich am sichersten ist.
                            const small = scaled(base, 0.5);
                            let best = { turns: 0, confidence: across ? 0 : result.confidence };
                            for (const turns of across ? [1, 3] : [2, 1, 3]) {
                                if (cancelled) break;
                                const trial = await reader.recognize(await toBlob(DocScan.turn(small, turns), 0.85));
                                if (trial.words.length >= 6 && !sideways(trial) && trial.confidence > best.confidence + (best.turns ? 0 : 12)) best = { turns, confidence: trial.confidence };
                            }
                            if (best.turns && !cancelled) {
                                base = DocScan.turn(base, best.turns);
                                ({ canvas: sheet, angle } = level(base));
                                info.angle = angle;
                                info.turned = best.turns;
                                result = await reader.recognize(await toBlob(sheet, 0.9));
                            }
                        }
                        info.source = result.text.trim() ? 'ocr' : '';
                        info.text = result.text;
                        info.words = result.words;
                        info.confidence = result.confidence;
                    } catch (error) {
                        info.error = `Der Text dieser Seite konnte nicht gelesen werden (${error.message || error}).`;
                    }
                }
            }
            info.width = sheet.width;
            info.height = sheet.height;
            info.qr = !info.blank && hasQr(sheet);
            [info.blob, info.thumb, info.compact] = await Promise.all([toBlob(sheet, LIMITS.quality), thumbOf(sheet), DocScan.compact ? DocScan.compact(sheet) : null]);
            return info;
        }

        const done = (async () => {
            const list = [...files].filter(file => isPdf(file) || isImage(file));
            const skipped = [...files].filter(file => !isPdf(file) && !isImage(file));
            skipped.forEach(file => problems.push(`„${file.name}“ ist weder PDF noch Foto und wurde übergangen.`));
            if (!list.length) throw new Error('Bitte eine PDF-Datei (oder Fotos als JPG/PNG) wählen.');
            // Zuerst alle Dateien öffnen: Dann steht die Zahl der Seiten fest.
            const sources = [];
            for (const file of list) {
                if (file.size > LIMITS.maxFileBytes) throw new Error(`„${file.name}“ ist zu groß (${Math.round(file.size / 1048576)} MB). Bitte in mehreren Teilen einscannen.`);
                if (isPdf(file)) { const opened = await openPdf(file); sources.push({ file, ...opened, count: opened.doc.numPages }); }
                else sources.push({ file, count: 1 });
                if (cancelled) break;
            }
            const total = sources.reduce((sum, source) => sum + source.count, 0);
            report({ phase: 'lesen', total, done: 0 });
            const running = new Set();
            const limit = () => Math.max(2, (workers || LIMITS.workers) + 1);
            let index = 0;
            const push = (promise, slot) => {
                const job = promise.then(info => { pages[slot] = info; }, error => {
                    pages[slot] = { index: slot, label: `Seite ${slot + 1}`, error: `Diese Seite konnte nicht gelesen werden (${error.message || error}).`, blank: false, text: '', words: [], blob: null, compact: null, thumb: null, width: 0, height: 0, source: '', confidence: 0, angle: 0, turned: 0, ink: 0, clean: false };
                }).then(() => {
                    running.delete(job);
                    const finished = pages.filter(Boolean).length;
                    const elapsed = (Date.now() - state.started) / 1000;
                    report({ done: finished, seconds: finished >= 2 ? Math.round(elapsed / finished * (total - finished)) : null });
                    try { onPage(pages[slot]); } catch (error) { /* Anzeige darf den Lauf nicht stören */ }
                });
                running.add(job);
            };
            try {
                for (const source of sources) {
                    for (let pageNo = 1; pageNo <= source.count; pageNo++) {
                        if (cancelled) break;
                        const slot = index++;
                        const entry = { index: slot, file: source.file.name, pageNo, label: sources.length > 1 || source.count > 1 ? `${source.file.name} · Seite ${pageNo}` : source.file.name };
                        report({ file: source.file.name });
                        try {
                            let canvas, embedded = null;
                            if (source.doc) {
                                const page = await source.doc.getPage(pageNo);
                                const base = page.getViewport({ scale: 1 });
                                const viewport = page.getViewport({ scale: Math.min(4, LIMITS.side / Math.max(base.width, base.height)) });
                                canvas = makeCanvas(viewport.width, viewport.height);
                                const ctx = context(canvas);
                                ctx.fillStyle = '#fff';
                                ctx.fillRect(0, 0, canvas.width, canvas.height);
                                await page.render({ canvasContext: ctx, canvas, viewport }).promise;
                                embedded = textOf(await page.getTextContent().catch(() => null), viewport, source.lib);
                                page.cleanup();
                            } else {
                                canvas = await DocScan.fromFile(source.file, { maxSide: LIMITS.photoSide });
                            }
                            push(finish(canvas, entry, embedded, !source.doc), slot);
                        } catch (error) {
                            push(Promise.reject(error), slot);
                        }
                        // Nicht zu viele Seiten gleichzeitig im Arbeitsspeicher halten.
                        while (running.size >= limit()) await Promise.race(running);
                        // Der Oberfläche Luft lassen (Fortschritt zeichnen, Abbrechen annehmen).
                        await new Promise(resolve => window.setTimeout(resolve, 0));
                    }
                    if (cancelled) break;
                }
                await Promise.all(running);
            } finally {
                for (const source of sources) await source.close?.();
                const reader = engine ? await engine : null;
                await reader?.terminate?.();
            }
            if (cancelled) throw Object.assign(new Error('Abgebrochen.'), { code: 'cancelled' });
            if (engineError) problems.push(`Die Texterkennung stand nicht zur Verfügung (${engineError}). Die Seiten sind eingelesen, müssen aber von Hand eingeordnet werden.`);
            pages.forEach(page => { if (page.error) problems.push(`${page.label}: ${page.error}`); });
            report({ phase: 'fertig', done: total, seconds: 0 });
            return { pages, problems };
        })();
        return { done, cancel: () => { cancelled = true; }, state: () => ({ ...state }) };
    }

    // Die Texterkennung allein (für „Scan verbessern“). Ergebnis: { recognize(blob) → { text, words, confidence }, terminate() } oder null, wenn sie nicht zu haben ist.
    async function createReader(count = 1) {
        try { return await (api.ocrFactory || defaultOcr)(Math.max(1, count)); } catch (error) { return null; }
    }

    const api = { hasQr, start, openPdf, loadPdf, goodWords, looksClean, textOf, createReader, LIMITS, ocrFactory: null };
    return api;
})();

if (typeof window !== 'undefined') window.AkteImport = AkteImport;
