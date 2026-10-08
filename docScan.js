// Macht aus dem Handyfoto eines Papierdokuments (Arztbrief, Rezept, Überweisung) ein gerades, gut lesbares Blatt –
// direkt auf dem Gerät und nur mit Canvas 2D: Das Foto wird dafür nirgends hingeschickt.
//   DocScan.process()       alles in einem: laden → Blatt finden (oder Ecken von Hand) → gerade ziehen → aufbereiten → prüfen → JPEG
//   DocScan.fromFile()      Foto laden (Drehung laut EXIF), längere Seite höchstens maxSide
//   DocScan.detect()        die vier Ecken des Blatts finden (Canvas, Bild oder laufendes Video) – oder null
//   DocScan.findSheet()     dieselbe Suche auf rohen Bildpunkten (ohne Canvas, zum Prüfen außerhalb des Browsers)
//   DocScan.warp()          das Blatt gerade ziehen (Perspektive)
//   DocScan.enhance()       wie ein Scanner: Papier rein weiß, Schrift dunkel und scharf – 'auto' | 'color' | 'gray' | 'bw'
//   DocScan.assess()        Helligkeit, Kontrast, Schärfe und Hinweise auf Deutsch
//   DocScan.release()       die großen Zwischenbilder eines Ergebnisses sofort freigeben (Speicher)
//   DocScan.straighten()    schief eingezogene Seite gerade rücken (skew = nur den Winkel messen, rotate / turn = drehen)
//   DocScan.blank()         leere Seite erkennen (Rückseite, Trennblatt)
//   DocScan.pageInfo()      Seitenzähler im erkannten Text („Seite 2 von 3“)
//   DocScan.missingPages()  fehlende oder doppelt fotografierte Seiten (beide Seitenzähler-Funktionen brauchen kein DOM)
//   DocScan.compact()       Platz sparende Speicherform einer Textseite: PNG mit 16 Tönen – oder null, wenn die Seite ein Foto enthält
//                           (tones() und tonesPng() sind die beiden Schritte einzeln – ohne Canvas, zum Prüfen außerhalb des Browsers)
//   DocScan.LIMITS          alle Schwellen an einer Stelle
// Das Ergebnis ist immer nur ein Vorschlag: „original“ bleibt erhalten, damit die Oberfläche „Original verwenden“ anbieten kann.
const DocScan = (() => {
    // Schwellen – hier lässt sich alles nachstellen (abgestimmt mit pwtest/t_docscan.js).
    const LIMITS = {
        confidence: 0.6,        // ab dieser Sicherheit schneidet process() das Blatt aus
        detectSide: 256,        // längere Seite der kleinen Kopie für die Blattsuche
        fineSide: 768,          // längere Seite der Kopie, auf der die Seiten genau an die Blattkante gelegt werden …
        fineReach: 8,           // … gesucht wird bis so viele Punkte beiderseits der vermuteten Kante
        fineInset: 0.7,         // … und der Zuschnitt liegt um so viel innerhalb der Kante
        edgeClean: 0.005,       // so breit wird der Rand eines zugeschnittenen Blatts weiß übermalt (Anteil der kürzeren Seite)
        loadSide: 3000,         // so groß wird das Foto höchstens geladen (das fertige Blatt: höchstens maxSide, sonst 2000)
        find: {                 // Blattsuche über Kanten und Linien (alle Längen in Punkten der kleinen Kopie)
            edgeFloor: 0.012,    // kleinster Helligkeitssprung (Anteil), der als Kante zählt …
            edgeNoise: 4.5,      // … mindestens dieses Vielfache des Rauschens (gemessen im ruhigsten Fünftel des Bildes)
            edgeFull: 3,         // ab dem Dreifachen der Schwelle zählt eine Kante voll
            spreadAngle: 6,      // eine Kante stimmt für Linien bis ± 6° um ihre Richtung
            peaksPerBucket: 22,  // je Richtung (15°-Fächer) werden so viele Linien geprüft …
            keepPerBucket: 4,    // … und je Merkmal (Länge, Stärke, Papierrand) so viele behalten
            maxLines: 64,        // Obergrenze insgesamt
            minVotes: 9,         // Mindestlänge einer Linie (gewichtete Punkte)
            peakAngle: 4, peakDist: 5,   // Abstand zweier Linien, damit sie als verschieden gelten
            gap: 7,              // Lücke entlang einer Linie, ab der sie in zwei Strecken zerfällt
            ring: 3,             // Abstand der Farbproben von der Kante (innen und außen)
            step: 0.03,          // Farbsprung innen/außen (Anteil), ab dem eine Stelle als Rand zählt
            tone: 0.07,          // Abweichung der Farbart vom Papier (je Farbe, als Anteil der Helligkeit), bis zu der eine Stelle als Papier gilt
            rough: 0.06,         // Kantenstärke, ab der eine Stelle im Inneren als „unruhig“ zählt (Tasten, Muster – nicht Schrift oder Schatten)
            dark: 60,            // mittlere Helligkeit des Blattrands darunter: kein Papier
            areaMin: 0.045, areaMax: 0.985,
            angleMin: 48, angleMax: 132,
            aspectMax: 6.5,
            outside: 0.06,       // Ecken dürfen um diesen Anteil außerhalb des Bildes liegen
            shortlist: 60,
            overrun: 0.75,       // Abzug je Linie, die über eine Ecke hinaus weiterläuft (dann ist es keine Ecke, sondern eine Kreuzung)
            inset: 0.6           // der Zuschnitt liegt knapp innerhalb der Blattkante (in Punkten der kleinen Kopie)
        },
        dark: 90,               // mittlere Helligkeit darunter → „dunkel“
        inkLevel: 0.75,         // „Schrift“ ist, was dunkler als 75 % der Papierhelligkeit ist
        inkShare: 0.0005,       // Anteil solcher Stellen darunter: Die Schrift ist kaum zu sehen → „hell“ oder „kontrast“
        bright: 200,            // … „hell“ (überbelichtet), wenn die mittlere Helligkeit darüber liegt, sonst „kontrast“
        sharpness: 0.25,        // Schärfe geteilt durch den Kontrast im Kleinen darunter → „unscharf“
        minSide: 560,           // kürzere Seite in Bildpunkten darunter → „klein“
        maxGain: 3,             // so stark werden Schatten höchstens aufgehellt
        paperSide: 320,         // längere Seite der kleinen Kopie für die Papierfarbe
        paperRadius: 10,        // Dunkles bis zu dieser Breite (· 2, in Punkten der kleinen Kopie) gilt als Schrift, nicht als Schatten
        darkArea: 0.3,          // Flächen dunkler als 30 % des Papiers sind kein Schatten (Foto, Logo, Tisch) – nicht aufhellen
        castLow: 0.33,          // Farbflächen sind auch kein Schatten: ab diesem Farbunterschied zum Papier (0 = farblos, 1 = kräftig bunt) …
        castHigh: 0.5,          // … wird weniger aufgehellt, ab diesem gar nicht mehr (farbiger Balken im Briefkopf, Klebezettel)
        whiteNoise: 0.5,        // Weißpunkt der Kurve: so viele Vielfache des Rauschens unter dem Papier (höchstens 6 % darunter)
        cleanGap: 0.018,        // Papier „putzen“: Was geglättet höchstens so viel dunkler ist als das Papier ringsum, wird rein weiß …
        cleanFade: 0.035,       // … mit weichem Übergang über diese Spanne (darüber bleibt alles stehen: blasse Schrift, Bleistift, Raster)
        cleanReach: 2,          // „ringsum“: so viele Schritte von je zwei Kästchen (ein Kästchen ≈ 1/500 der längeren Seite)
        cleanDeep: 0.05,        // was mehr als 5 % unter der Papierfarbe liegt, wird nie geputzt (graue Tabellenzeilen, Raster, Fotos, Markierungen)
        blackMax: 0.3,          // Schwarzpunkt höchstens bei 30 % der Papierfarbe (blasse Schrift nicht verschlucken)
        inkGamma: 1.7,          // Kurve > 1: Schrift wird dunkler – auch blasse (Durchschlag, Thermopapier, Bleistift)
        neutral: 22,            // Farbabstand (0…255), unter dem eine Stelle als farblos gilt
        sharpen: 0.8,           // Stärke des Schärfens (0 = aus)
        bwLevel: 0.78,          // 'bw': schwarz ist, was dunkler als 78 % des Papiers an dieser Stelle ist
        skewMax: 8,             // Schräglage: gesucht wird zwischen −8° und +8°
        skewMin: 0.3,           // … kleinere Winkel bleiben, wie sie sind
        skewGain: 1.15,         // … und nur, wenn die Zeilen danach deutlich schärfer getrennt sind
        blankEdge: 0.07,        // leere Seite: dieser Rand links/rechts zählt nicht (Lochung, Heftklammern)
        blankInk: 0.0006        // leere Seite: weniger als 0,06 % dunkle Stellen im Inneren
    };
    const ISSUES = {
        dunkel: 'Das Foto ist zu dunkel. Bitte mit mehr Licht noch einmal aufnehmen.',
        hell: 'Das Foto ist überbelichtet oder spiegelt. Bitte ohne Blitz noch einmal aufnehmen.',
        unscharf: 'Das Foto ist unscharf. Bitte ruhig halten und noch einmal aufnehmen.',
        klein: 'Das Foto ist sehr klein. Bitte näher herangehen.',
        kontrast: 'Die Schrift ist kaum zu erkennen. Bitte bei besserem Licht aufnehmen.',
        rand: 'Der Rand des Blatts wurde nicht sicher erkannt. Bitte die Ecken anpassen – oder noch einmal aufnehmen.'
    };
    const OPEN_ERROR = 'Das Foto konnte nicht geöffnet werden.';

    // ---------- Gemeinsames ----------
    function makeCanvas(width, height) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width));
        canvas.height = Math.max(1, Math.round(height));
        return canvas;
    }
    const context = canvas => canvas.getContext('2d', { willReadFrequently: true });
    const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
    const ramp = (value, from, to) => Math.min(1, Math.max(0, (value - from) / (to - from)));

    // Verkleinerte Kopie (längere Seite höchstens maxSide) – nie größer als die Vorlage.
    function shrink(source, maxSide) {
        const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
        const canvas = makeCanvas(source.width * scale, source.height * scale);
        const ctx = context(canvas);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
        return canvas;
    }

    // Helligkeit (0…255) je Bildpunkt einer verkleinerten Kopie. mix = Math.min nimmt stattdessen den schwächsten Farbkanal:
    // Papier ist hell und farblos, ein farbiger Untergrund (Holz, Tischdecke) wird damit dunkler als in der Helligkeit.
    function grayOf(source, maxSide, mix = luma) {
        const canvas = shrink(source, maxSide);
        const { width, height } = canvas;
        const rgba = context(canvas).getImageData(0, 0, width, height).data;
        const gray = new Float32Array(width * height);
        for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = mix(rgba[p], rgba[p + 1], rgba[p + 2]);
        return { gray, width, height };
    }

    // Läuft über jede Zeile und danach über jede Spalte: reduce(Werte, Anfang, Länge, Schritt, Ziel) schreibt eine Linie.
    function separable(src, width, height, reduce) {
        const rows = new Float32Array(src.length), out = new Float32Array(src.length);
        for (let y = 0; y < height; y++) reduce(src, y * width, width, 1, rows);
        for (let x = 0; x < width; x++) reduce(rows, x, height, width, out);
        return out;
    }

    // Weichzeichner: Mittelwert über ein Quadrat mit Radius radius (der Rand wird fortgesetzt).
    function blur(src, width, height, radius) {
        return separable(src, width, height, (from, start, count, step, to) => {
            let sum = 0;
            for (let k = -radius; k <= radius; k++) sum += from[start + Math.min(count - 1, Math.max(0, k)) * step];
            for (let i = 0; i < count; i++) {
                to[start + i * step] = sum / (2 * radius + 1);
                sum += from[start + Math.min(count - 1, i + radius + 1) * step] - from[start + Math.max(0, i - radius) * step];
            }
        });
    }

    // Größter (pick = Math.max) oder kleinster Wert im Umkreis. Erst max, dann min „schließt“ dunkle Schrift, lässt Schatten aber stehen.
    function spread(src, width, height, radius, pick) {
        return separable(src, width, height, (from, start, count, step, to) => {
            for (let i = 0; i < count; i++) {
                let value = from[start + i * step];
                for (let k = Math.max(0, i - radius); k <= Math.min(count - 1, i + radius); k++) value = pick(value, from[start + k * step]);
                to[start + i * step] = value;
            }
        });
    }

    // Schwelle nach Otsu: trennt Hell und Dunkel so, dass beide Gruppen in sich möglichst einheitlich sind.
    function otsu(values) {
        const hist = new Float64Array(256);
        let all = 0;
        for (let i = 0; i < values.length; i++) {
            const value = Math.min(255, Math.max(0, Math.round(values[i])));
            hist[value]++;
            all += value;
        }
        let best = 0, bestScore = -1, count = 0, sum = 0;
        for (let value = 0; value < 255; value++) {
            count += hist[value];
            sum += value * hist[value];
            if (!count || count === values.length) continue;
            const gap = sum / count - (all - sum) / (values.length - count);
            const score = count * (values.length - count) * gap * gap;
            if (score > bestScore) { bestScore = score; best = value; }
        }
        return best;
    }

    // ---------- Blatt finden ----------
    // Über Kanten und Linien – nicht über die Helligkeit: So wird auch weißes Papier auf hellem Tisch, ein rosa Rezept oder ein
    // Blatt auf einer gemusterten Decke gefunden. Alles hier rechnet auf einer kleinen Kopie (längere Seite: LIMITS.detectSide)
    // und braucht kein Canvas: findSheet(Bildpunkte, Breite, Höhe, Kanäle) lässt sich auch außerhalb des Browsers prüfen.
    //
    // Ablauf: 1. Schrift schließen (Dunkles bis vier Punkte Breite verschwindet), Kanten über alle drei Farben · 2. gerade Linien
    // (Hough), je Linie die zusammenhängenden Strecken · 3. je Linie: wo liegt eine Kante, welche Farben liegen links und rechts ·
    // 4. Vierecke aus zwei Paaren gegenüberliegender Linien · 5. Bewertung: Kante an allen vier Seiten, innen überall dieselbe
    // Papierfarbe, außen etwas anderes, Ecken sind echte Ecken · 6. Seiten genau an die Kantenpunkte legen.
    const FIND = LIMITS.find;
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

    // Größter (most = true) oder kleinster Wert aus fünf Nachbarn – erst entlang der Zeilen, dann quer dazu. Am Rand zählen nur die
    // vorhandenen Nachbarn. Ohne Rückruf je Bildpunkt und zeilenweise durch den Speicher: Das läuft für jedes Kamerabild.
    function five(src, tmp, dst, width, height, most) {
        const pick = most ? Math.max : Math.min;
        for (let y = 0, o = 0; y < height; y++, o += width) {
            for (let x = 2; x < width - 2; x++) {
                const i = o + x;
                let v = src[i - 2];
                if (most) { if (src[i - 1] > v) v = src[i - 1]; if (src[i] > v) v = src[i]; if (src[i + 1] > v) v = src[i + 1]; if (src[i + 2] > v) v = src[i + 2]; }
                else { if (src[i - 1] < v) v = src[i - 1]; if (src[i] < v) v = src[i]; if (src[i + 1] < v) v = src[i + 1]; if (src[i + 2] < v) v = src[i + 2]; }
                tmp[i] = v;
            }
            for (const x of [0, 1, width - 2, width - 1]) {
                let v = src[o + x];
                for (let k = Math.max(0, x - 2); k <= Math.min(width - 1, x + 2); k++) v = pick(v, src[o + k]);
                tmp[o + x] = v;
            }
        }
        for (let y = 0, o = 0; y < height; y++, o += width) {
            const a = y >= 2 ? o - 2 * width : y >= 1 ? o - width : o, b = y >= 1 ? o - width : o, d = y < height - 1 ? o + width : o, e = y < height - 2 ? o + 2 * width : d;
            for (let x = 0; x < width; x++) {
                let v = tmp[a + x];
                if (most) { if (tmp[b + x] > v) v = tmp[b + x]; if (tmp[o + x] > v) v = tmp[o + x]; if (tmp[d + x] > v) v = tmp[d + x]; if (tmp[e + x] > v) v = tmp[e + x]; }
                else { if (tmp[b + x] < v) v = tmp[b + x]; if (tmp[o + x] < v) v = tmp[o + x]; if (tmp[d + x] < v) v = tmp[d + x]; if (tmp[e + x] < v) v = tmp[e + x]; }
                dst[o + x] = v;
            }
        }
    }
    // Mittel aus 3 × 3 Nachbarn (der Rand wird fortgesetzt).
    function soften(src, tmp, dst, width, height) {
        for (let y = 0, o = 0; y < height; y++, o += width) {
            tmp[o] = (2 * src[o] + src[o + 1]) / 3;
            for (let x = 1; x < width - 1; x++) tmp[o + x] = (src[o + x - 1] + src[o + x] + src[o + x + 1]) / 3;
            tmp[o + width - 1] = (src[o + width - 2] + 2 * src[o + width - 1]) / 3;
        }
        for (let y = 0, o = 0; y < height; y++, o += width) {
            const up = y > 0 ? o - width : o, down = y < height - 1 ? o + width : o;
            for (let x = 0; x < width; x++) dst[o + x] = (tmp[up + x] + tmp[o + x] + tmp[down + x]) / 3;
        }
    }

    // ---------- 1. Farbebenen ohne Schrift, Kanten ----------
    function planesOf(pixels, width, height, channels) {
        const count = width * height, tmp = new Float32Array(count), work = new Float32Array(count);
        return [0, 1, 2].map(channel => {
            const plane = new Float32Array(count);
            for (let i = 0, p = channel; i < count; i++, p += channels) plane[i] = pixels[p];
            // Schrift, Linien und Stempel schließen (erst größter, dann kleinster Wert im Umkreis), danach leicht glätten.
            five(plane, tmp, work, width, height, true);
            five(work, tmp, plane, width, height, false);
            soften(plane, tmp, work, width, height);
            plane.set(work);
            return plane;
        });
    }

    // Stärke (als Anteil der Helligkeit) und Richtung der Kante je Bildpunkt – über alle drei Farben zugleich (Di Zenzo):
    // So zählt ein rosa Rezept auf weißem Tisch genauso wie weißes Papier auf dunklem Holz.
    function gradient(planes, width, height) {
        const count = width * height;
        const mag = new Float32Array(count), dir = new Float32Array(count);      // dir = Richtung der stärksten Änderung (−90° … 90°)
        const [R, G, B] = planes;
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
                const i = y * width + x;
                let jxx = 0, jyy = 0, jxy = 0;
                for (let c = 0; c < 3; c++) {
                    const p = planes[c];
                    const gx = (p[i - width + 1] + 2 * p[i + 1] + p[i + width + 1]) - (p[i - width - 1] + 2 * p[i - 1] + p[i + width - 1]);
                    const gy = (p[i + width - 1] + 2 * p[i + width] + p[i + width + 1]) - (p[i - width - 1] + 2 * p[i - width] + p[i - width + 1]);
                    jxx += gx * gx; jyy += gy * gy; jxy += gx * gy;
                }
                const lam = 0.5 * (jxx + jyy + Math.sqrt((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy));
                const light = (R[i] + G[i] + B[i]) / 3;
                mag[i] = Math.sqrt(lam / 3) / 4 / (light + 24);
                dir[i] = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
            }
        }
        return { mag, dir };
    }

    // Kanten ausdünnen: Nur der stärkste Punkt quer zur Kante bleibt – mit seiner Lage genauer als ein Bildpunkt.
    function thinEdges(mag, dir, width, height) {
        // Rauschen: der Wert, unter dem das ruhigste Fünftel des Bildes liegt. (Die Mitte aller Werte taugt nicht: Auf einer
        // karierten Decke liegt die halbe Fläche an einer Kante.)
        const hist = new Uint32Array(1024);
        for (let i = 0; i < mag.length; i++) hist[Math.min(1023, (mag[i] * 4096) | 0)]++;
        let seen = 0, bin = 0;
        while (bin < 1023 && (seen += hist[bin]) < mag.length * 0.2) bin++;
        const noise = (bin + 0.5) / 4096;
        const floor = Math.max(FIND.edgeFloor, FIND.edgeNoise * noise), full = floor * FIND.edgeFull;
        const points = [];
        const weight = new Float32Array(mag.length), at = new Int32Array(mag.length).fill(-1);
        for (let y = 2; y < height - 2; y++) {
            for (let x = 2; x < width - 2; x++) {
                const i = y * width + x, m = mag[i];
                if (m < floor) continue;
                const dx = Math.round(Math.cos(dir[i])), dy = Math.round(Math.sin(dir[i]));
                const before = mag[i - dy * width - dx], after = mag[i + dy * width + dx];
                if (m < before || m <= after) continue;
                const den = before - 2 * m + after, shift = den < 0 ? clamp(0.5 * (before - after) / den, -0.5, 0.5) : 0;
                const w = ramp(m, floor * 0.6, full);
                weight[i] = w;
                at[i] = points.length;
                // v = Stimmgewicht für die Liniensuche: Eine kräftige Kante (Blatt auf dunklem Tisch) zählt bis zu doppelt.
                points.push({ x: x + 0.5 + shift * dx, y: y + 0.5 + shift * dy, w, v: w * (1 + ramp(m, 0.05, 0.3)), m, dir: dir[i] });
            }
        }
        return { points, weight, at, floor, noise };
    }

    // ---------- 2. Linien (Hough) ----------
    // Gipfel im Raum (Richtung, Abstand zur Bildmitte) – je Richtungsfächer die stärksten, mit Abstand zueinander.
    function houghLines(points, width, height) {
        const cx = width / 2, cy = height / 2, R = Math.ceil(Math.hypot(width, height) / 2) + 2, nrho = 2 * R + 1;
        const acc = new Float32Array(180 * nrho);
        const COS = new Float32Array(180), SIN = new Float32Array(180);
        for (let t = 0; t < 180; t++) { COS[t] = Math.cos(t * Math.PI / 180); SIN[t] = Math.sin(t * Math.PI / 180); }
        const span = FIND.spreadAngle;
        for (const p of points) {
            const t0 = Math.round(p.dir * 180 / Math.PI), px = p.x - cx, py = p.y - cy;
            for (let dt = -span; dt <= span; dt++) {
                const t = ((t0 + dt) % 180 + 180) % 180;
                acc[t * nrho + Math.round(px * COS[t] + py * SIN[t] + R)] += p.v * (1 - Math.abs(dt) / (span + 1));
            }
        }
        const cells = [], least = FIND.minVotes * 1.2;
        for (let t = 0; t < 180; t++) {
            for (let b = 1; b < nrho - 1; b++) {
                const i = t * nrho + b, value = acc[i] + 0.5 * (acc[i - 1] + acc[i + 1]);
                if (value >= least) cells.push({ t, rho: b - R, value });
            }
        }
        cells.sort((a, b) => b.value - a.value);
        // Je Richtung (15°-Fächer) nur die stärksten: Ein Muster (Streifen, Karos, Dielen) darf nicht alle Plätze belegen.
        const lines = [], perBucket = new Array(12).fill(0);
        for (const cell of cells) {
            const bucket = Math.floor(cell.t / 15);
            if (perBucket[bucket] >= FIND.peaksPerBucket) continue;
            const near = lines.some(line => {
                let dt = Math.abs(cell.t - line.t), rho = line.rho;
                if (dt > 90) { dt = 180 - dt; rho = -rho; }                      // 179° grenzt an 0° – mit gespiegeltem Abstand
                return dt <= FIND.peakAngle && Math.abs(cell.rho - rho) <= FIND.peakDist;
            });
            if (!near) { lines.push({ t: cell.t, rho: cell.rho, votes: cell.value }); perBucket[bucket]++; }
        }
        return lines.map(line => ({ nx: COS[line.t], ny: SIN[line.t], c: line.rho, votes: line.votes, cx, cy }));
    }

    const turnOf = (a, b) => { const d = Math.abs(a - b) % Math.PI; return d > Math.PI / 2 ? Math.PI - d : d; };      // Winkel zwischen zwei Richtungen (0 … 90°)

    // Läuft die Linie im Bild ab: visit(k, x, y) für jeden ganzen Schritt (k = 0 … count − 1). Ergebnis: Lage der Linie
    // { dx, dy, px, py, first, count } – der Punkt zum Schritt k ist (px, py) + (first + k) · (dx, dy) – oder null, wenn sie das Bild kaum trifft.
    function walk(line, width, height, visit) {
        const { nx, ny, c, cx, cy } = line, dx = -ny, dy = nx, px = cx + nx * c, py = cy + ny * c;
        let s0 = -Infinity, s1 = Infinity;
        const cut = (p, d, low, high) => {
            if (Math.abs(d) < 1e-9) { if (p < low || p > high) { s0 = 1; s1 = 0; } return; }
            const a = (low - p) / d, b = (high - p) / d;
            s0 = Math.max(s0, Math.min(a, b)); s1 = Math.min(s1, Math.max(a, b));
        };
        cut(px, dx, 0.5, width - 0.5); cut(py, dy, 0.5, height - 0.5);
        if (!(s1 - s0 >= 8)) return null;
        const first = Math.ceil(s0), count = Math.floor(s1) - first + 1;
        if (visit) for (let k = 0; k < count; k++) visit(k, px + dx * (first + k), py + dy * (first + k));
        return { dx, dy, px, py, first, count };
    }

    // Kantenpunkte in einem Streifen von ± 2 Punkten um die Stelle (x, y) der Linie, deren Richtung zur Linie passt.
    function nearPoints(edges, x, y, nx, ny, angle, width, height, found) {
        for (let o = -2; o <= 2; o++) {
            const qx = x + nx * o, qy = y + ny * o;
            if (qx < 0 || qy < 0 || qx >= width || qy >= height) continue;
            const index = edges.at[(qy | 0) * width + (qx | 0)];
            if (index >= 0 && turnOf(edges.points[index].dir, angle) <= 0.3) found(edges.points[index]);
        }
    }

    // Zusammenhängende Kantenstücke entlang einer Linie, jedes mit eigener Ausgleichsgerade.
    // So zieht ein zufällig in der Flucht liegendes Stück (Schattenrand, Stift, Maserung) die Blattkante nicht schief.
    function segmentsOf(peak, edges, width, height) {
        const angle = Math.atan2(peak.ny, peak.nx), hits = [];
        walk(peak, width, height, (k, x, y) => nearPoints(edges, x, y, peak.nx, peak.ny, angle, width, height, p => hits.push({ k, p })));
        const out = [];
        for (let i = 1, start = 0; i <= hits.length; i++) {
            if (i < hits.length && hits[i].k - hits[i - 1].k <= FIND.gap) continue;
            const part = hits.slice(start, i);
            start = i;
            if (part.length < 6 || part[part.length - 1].k - part[0].k < 8) continue;
            const fitted = fitPoints(peak, [...new Set(part.map(hit => hit.p))]);
            if (fitted && fitted.used >= FIND.minVotes * 0.6) out.push(fitted);
        }
        return out;
    }

    // Ausgleichsgerade (Hauptachse) durch gewichtete Punkte – zweimal, beim zweiten Mal ohne Ausreißer.
    function fitPoints(line, points) {
        let { nx, ny, c } = line, used = 0;
        const { cx, cy } = line;
        for (const limit of [2.6, 1.2]) {
            let sw = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
            for (const p of points) {
                const px = p.x - cx, py = p.y - cy, d = px * nx + py * ny - c;
                if (d > limit || d < -limit) continue;
                sw += p.w; sx += p.w * px; sy += p.w * py; sxx += p.w * px * px; sxy += p.w * px * py; syy += p.w * py * py;
            }
            if (sw < 4) break;
            const mx = sx / sw, my = sy / sw, along = 0.5 * Math.atan2(2 * (sxy / sw - mx * my), (sxx / sw - mx * mx) - (syy / sw - my * my));
            let fx = -Math.sin(along), fy = Math.cos(along);
            if (fx * nx + fy * ny < 0) { fx = -fx; fy = -fy; }
            if (fx * nx + fy * ny < 0.94) break;                                 // dreht sich um mehr als 20° – nicht übernehmen
            nx = fx; ny = fy; c = mx * nx + my * ny; used = sw;
        }
        return used ? { ...line, nx, ny, c, used } : null;
    }

    // ---------- 3. Was liegt an der Linie? ----------
    // Für jeden Punkt entlang der Linie: Liegt dort eine Kante (state 1), quert eine andere (2)? Welche Farbe liegt auf der einen
    // (plus) und der anderen Seite (minus)? Dazu laufende Summen, damit sich jede Teilstrecke in einem Schritt auswerten lässt.
    function profile(line, planes, edges, width, height, centreLike) {
        const run = walk(line, width, height, null);
        if (!run) return null;
        const { nx, ny } = line, angle = Math.atan2(ny, nx), ring = FIND.ring, { weight, at, points } = edges, size = run.count;
        const pixel = (x, y) => (x < 0 || y < 0 || x >= width || y >= height) ? -1 : (y | 0) * width + (x | 0);
        const state = new Uint8Array(size), exact = new Uint8Array(size), valid = new Uint8Array(size), plus = new Float32Array(size * 3), minus = new Float32Array(size * 3), diff = new Float32Array(size * 3);
        walk(line, width, height, (k, x, y) => {
            let best = 0, other = 0;
            for (let o = -2; o <= 2; o++) {
                const i = pixel(x + nx * o, y + ny * o);
                if (i < 0 || !weight[i]) continue;
                const da = turnOf(points[at[i]].dir, angle);
                if (da <= 0.35) { if (weight[i] > best) best = weight[i]; if (da <= 0.12 && o >= -1 && o <= 1 && weight[i] >= 0.2) exact[k] = 1; }
                else if (da > 0.6 && weight[i] > other) other = weight[i];
            }
            state[k] = best >= 0.2 ? 1 : other >= 0.5 ? 2 : 0;
            const a = pixel(x + nx * ring, y + ny * ring), b = pixel(x - nx * ring, y - ny * ring);
            if (a < 0 || b < 0) return;
            valid[k] = 1;
            let la = 0, lb = 0;
            for (let ch = 0; ch < 3; ch++) { plus[k * 3 + ch] = planes[ch][a]; minus[k * 3 + ch] = planes[ch][b]; la += planes[ch][a]; lb += planes[ch][b]; }
            const scale = Math.max(la, lb) / 3 + 24;
            for (let ch = 0; ch < 3; ch++) diff[k * 3 + ch] = (planes[ch][a] - planes[ch][b]) / scale;
        });
        // Laufende Summen: Kanten, Kreuzungen, Farbsprung (mit Vorzeichen, je Farbe) und sein Betrag.
        // (exacts: Kante genau auf der Linie und genau in ihrer Richtung – daran zeigt sich, ob dieselbe Kante weiterläuft.)
        const sums = new Float32Array(size + 1), skips = new Float32Array(size + 1), exacts = new Float32Array(size + 1), signed = new Float32Array((size + 1) * 3), amount = new Float32Array(size + 1);
        let length = 0, contrast = 0, boundary = 0;
        for (let k = 0; k < size; k++) {
            sums[k + 1] = sums[k] + (state[k] === 1 ? 1 : 0);
            exacts[k + 1] = exacts[k] + exact[k];
            skips[k + 1] = skips[k] + (state[k] === 2 ? 1 : 0);
            const d0 = diff[k * 3], d1 = diff[k * 3 + 1], d2 = diff[k * 3 + 2], jump = Math.hypot(d0, d1, d2);
            signed[(k + 1) * 3] = signed[k * 3] + d0; signed[(k + 1) * 3 + 1] = signed[k * 3 + 1] + d1; signed[(k + 1) * 3 + 2] = signed[k * 3 + 2] + d2;
            amount[k + 1] = amount[k] + jump;
            if (state[k] !== 1) continue;
            length++;
            contrast += Math.min(0.5, jump);
            if (valid[k] && centreLike(plus[k * 3], plus[k * 3 + 1], plus[k * 3 + 2]) !== centreLike(minus[k * 3], minus[k * 3 + 1], minus[k * 3 + 2])) boundary++;
        }
        return { ...line, ...run, state, plus, minus, valid, diff, sums, skips, exacts, signed, amount, length, contrast, boundary };
    }

    // Die vier Bildränder als Linien (ohne Kante): für ein Blatt, das über den Bildrand hinausragt.
    function borderLines(width, height) {
        const cx = width / 2, cy = height / 2;
        return [[1, 0, cx - 0.5], [1, 0, -(cx - 0.5)], [0, 1, cy - 0.5], [0, 1, -(cy - 0.5)]].map(([nx, ny, c]) => {
            const dx = -ny, dy = nx, px = cx + nx * c, py = cy + ny * c;
            return { nx, ny, c, cx, cy, dx, dy, px, py, border: true, votes: 0 };
        });
    }

    const cross = (a, b) => {                                                    // Schnittpunkt zweier Linien oder null
        const den = a.nx * b.ny - a.ny * b.nx;
        if (Math.abs(den) < 1e-6) return null;
        return { x: a.cx + (a.c * b.ny - b.c * a.ny) / den, y: a.cy + (b.c * a.nx - a.c * b.nx) / den };
    };
    const param = (line, p) => (p.x - line.px) * line.dx + (p.y - line.py) * line.dy;      // Lage eines Punkts entlang der Linie
    const areaOf = quad => Math.abs(quad.reduce((sum, p, i) => sum + p.x * quad[(i + 1) % 4].y - quad[(i + 1) % 4].x * p.y, 0)) / 2;
    // Lage von p auf der Strecke a → b (0 = bei a, 1 = bei b).
    const fraction = (a, b, p) => { const dx = b.x - a.x, dy = b.y - a.y; return ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1); };

    function order(quad) {
        const cx = quad.reduce((sum, p) => sum + p.x, 0) / 4, cy = quad.reduce((sum, p) => sum + p.y, 0) / 4;
        const turn = quad.slice().sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
        let first = 0;
        turn.forEach((p, index) => { if (p.x + p.y < turn[first].x + turn[first].y) first = index; });
        return turn.slice(first).concat(turn.slice(0, first));
    }

    function pointIn(p, quad) {
        let sign = 0;
        for (let i = 0; i < 4; i++) {
            const a = quad[i], b = quad[(i + 1) % 4], side = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
            if (side !== 0) { if (sign && Math.sign(side) !== sign) return false; sign = Math.sign(side); }
        }
        return true;
    }

    // ---------- 4. Vierecke bilden ----------
    function shapeOk(corners, width, height) {
        let worst = 0;
        for (let i = 0; i < 4; i++) {
            const a = corners[(i + 3) % 4], b = corners[i], c = corners[(i + 1) % 4];
            const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
            if (vx * uy - vy * ux <= 0) return null;
            const angle = Math.acos(clamp((ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)), -1, 1)) * 180 / Math.PI;
            if (angle < FIND.angleMin || angle > FIND.angleMax) return null;
            worst = Math.max(worst, Math.abs(angle - 90));
        }
        const share = areaOf(corners) / (width * height);
        if (share < FIND.areaMin || share > FIND.areaMax) return null;
        const side = i => Math.hypot(corners[(i + 1) % 4].x - corners[i].x, corners[(i + 1) % 4].y - corners[i].y);
        const wide = (side(0) + side(2)) / 2, high = (side(1) + side(3)) / 2;
        if (Math.max(wide, high) > FIND.aspectMax * Math.min(wide, high)) return null;
        if (Math.max(side(0), side(2)) > 2.2 * Math.min(side(0), side(2)) || Math.max(side(1), side(3)) > 2.2 * Math.min(side(1), side(3))) return null;
        return { share, worst };
    }

    // Teilstrecke einer Linie in einem Schritt: Anteil mit Kante (Kreuzungen zählen nicht mit) und wie einheitlich der Farbsprung ist
    // (1 = überall in dieselbe Richtung, 0 = wechselt ständig – wie an der Linie zwischen den Feldern einer karierten Decke).
    function stretch(line, from, to) {
        const lo = Math.min(from, to), hi = Math.max(from, to), length = Math.max(4, hi - lo + 1);
        const a = clamp(Math.round(lo) - line.first, 0, line.count), b = clamp(Math.round(hi) - line.first + 1, 0, line.count);
        const hits = (line.sums[b] - line.sums[a]) / (length - Math.min(0.35 * length, line.skips[b] - line.skips[a]));
        const sx = line.signed[b * 3] - line.signed[a * 3], sy = line.signed[b * 3 + 1] - line.signed[a * 3 + 1], sz = line.signed[b * 3 + 2] - line.signed[a * 3 + 2];
        const total = line.amount[b] - line.amount[a];
        return { hits: Math.min(1, hits), even: total > 1e-6 ? Math.hypot(sx, sy, sz) / total : 0 };
    }

    // Läuft die Linie über die Ecke hinaus weiter (von corner weg, auf der anderen Seite als inner) – als Kante von ähnlicher Stärke
    // wie entlang der Seite? Dann ist es eine Kreuzung, keine Ecke. (Schwache Maserung hinter einer kräftigen Blattkante zählt nicht.)
    function runsOn(line, corner, inner, reach) {
        if (line.border) return false;
        const at = param(line, corner), far = param(line, inner), away = at >= far ? 1 : -1;
        const from = at + away * 3, to = at + away * (3 + reach);
        const lo = Math.round(Math.min(from, to)) - line.first, hi = Math.round(Math.max(from, to)) - line.first + 1;
        if (lo < 0 || hi > line.count) return false;                             // dort endet das Bild – unbekannt
        if ((line.exacts[hi] - line.exacts[lo]) < 0.7 * (hi - lo)) return false;
        const a = clamp(Math.round(Math.min(at, far)) - line.first, 0, line.count), b = clamp(Math.round(Math.max(at, far)) - line.first + 1, 0, line.count);
        const along = (line.amount[b] - line.amount[a]) / Math.max(1, b - a), beyond = (line.amount[hi] - line.amount[lo]) / (hi - lo);
        return beyond >= 0.5 * along;
    }

    function findSheet(pixels, width, height, channels = 4, debug = null) {
        const planes = planesOf(pixels, width, height, channels);
        const { mag, dir } = gradient(planes, width, height);
        const edges = thinEdges(mag, dir, width, height);

        // Farbe in der Bildmitte – meist liegt dort das Blatt. Linien, an denen diese Farbe endet, sind bevorzugt Blattkanten.
        const mids = [[], [], []];
        for (let y = Math.floor(height * 0.4); y < height * 0.6; y += 2) for (let x = Math.floor(width * 0.4); x < width * 0.6; x += 2) for (let ch = 0; ch < 3; ch++) mids[ch].push(planes[ch][y * width + x]);
        const mid = mids.map(list => list.sort((a, b) => a - b)[list.length >> 1]), midLight = (mid[0] + mid[1] + mid[2]) / 3;
        const centreLike = (r, g, b) => {
            const ratio = ((r + g + b) / 3 + 12) / (midLight + 12);
            if (ratio < 0.6 || ratio > 1.6) return false;
            return Math.abs(r / ratio - mid[0]) + Math.abs(g / ratio - mid[1]) + Math.abs(b / ratio - mid[2]) < FIND.tone * (midLight + 12) * 3;
        };

        // Linien: Gipfel → Strecken → eigene Gerade je Strecke → Profil. Gleiche Linien nur einmal.
        let lines = [];
        for (const peak of houghLines(edges.points, width, height)) for (const segment of segmentsOf(peak, edges, width, height)) lines.push(segment);
        lines.sort((a, b) => b.used - a.used);
        const unique = [];
        for (const line of lines) {
            const same = unique.some(other => { const dot = other.nx * line.nx + other.ny * line.ny; return Math.abs(dot) > 0.9997 && Math.abs(other.c - Math.sign(dot) * line.c) < 1.2; });
            if (!same) unique.push(line);
        }
        lines = unique.map(line => profile(line, planes, edges, width, height, centreLike)).filter(Boolean);
        // Auswahl je Richtung: die längsten, die kontrastreichsten und die, an denen die Farbe der Bildmitte endet.
        const chosen = new Set();
        for (let bucket = 0; bucket < 12; bucket++) {
            const group = lines.filter(line => { let t = Math.atan2(line.ny, line.nx) * 180 / Math.PI; if (t < 0) t += 180; return Math.min(11, Math.floor(t / 15)) === bucket; });
            for (const key of ['length', 'contrast', 'boundary']) group.slice().sort((a, b) => b[key] - a[key]).slice(0, FIND.keepPerBucket).forEach(line => { if (line[key] > 0) chosen.add(line); });
        }
        lines = [...chosen].sort((a, b) => b.length - a.length).slice(0, FIND.maxLines);
        if (debug) { debug.points = edges.points; debug.lines = lines; }

        const all = lines.concat(borderLines(width, height));
        const centre = { x: width / 2, y: height / 2 };
        const pad = FIND.outside, minGap = 0.1 * Math.min(width, height);
        const inFrame = (p, extra) => p.x >= -width * extra && p.x <= width * (1 + extra) && p.y >= -height * extra && p.y <= height * (1 + extra);

        // Paare gegenüberliegender Seiten: fast parallel, schneiden sich nicht im Bild, mit Abstand zueinander.
        const pairs = [];
        for (let i = 0; i < all.length; i++) {
            for (let j = i + 1; j < all.length; j++) {
                const a = all[i], b = all[j], dot = Math.abs(a.nx * b.nx + a.ny * b.ny);
                if (dot < 0.8) continue;                                         // mehr als ~37° zueinander
                const meet = cross(a, b);
                if (meet && inFrame(meet, 0.25)) continue;
                if (Math.abs((a.px - b.px) * b.nx + (a.py - b.py) * b.ny) < minGap) continue;
                pairs.push([a, b]);
            }
        }
        const candidates = [];
        for (let p = 0; p < pairs.length; p++) {
            for (let q = p + 1; q < pairs.length; q++) {
                const [a, b] = pairs[p], [c, d] = pairs[q];
                if (a === c || a === d || b === c || b === d) continue;
                if (Math.abs(a.nx * c.nx + a.ny * c.ny) > 0.75) continue;        // die beiden Paare müssen quer zueinander liegen
                const borders = (a.border ? 1 : 0) + (b.border ? 1 : 0) + (c.border ? 1 : 0) + (d.border ? 1 : 0);
                if (borders > 2) continue;
                const pts = [cross(a, c), cross(c, b), cross(b, d), cross(d, a)];
                if (pts.some(point => !point || !inFrame(point, pad))) continue;
                const shape = shapeOk(pts, width, height) || shapeOk(pts.slice().reverse(), width, height);
                if (!shape) continue;
                // Seiten in der Reihenfolge der Ecken: pts[0]–pts[1] liegt auf c, pts[1]–pts[2] auf b, pts[2]–pts[3] auf d, pts[3]–pts[0] auf a
                const sides = [[c, pts[0], pts[1]], [b, pts[1], pts[2]], [d, pts[2], pts[3]], [a, pts[3], pts[0]]];
                let low = 1, sum = 0;
                for (const [line, from, to] of sides) {
                    let value = 0.4;
                    if (!line.border) { const part = stretch(line, param(line, from), param(line, to)); value = part.hits * (0.3 + 0.7 * part.even); }
                    low = Math.min(low, value); sum += value;
                }
                if (low < 0.25) continue;
                // Ecken: Läuft eine der beiden Linien über die Ecke hinaus weiter, ist es eine Kreuzung.
                let overruns = 0;
                for (let k = 0; k < 4; k++) {
                    const before = sides[(k + 3) % 4], after = sides[k];
                    const reach = clamp(0.15 * Math.min(Math.hypot(before[2].x - before[1].x, before[2].y - before[1].y), Math.hypot(after[2].x - after[1].x, after[2].y - after[1].y)), 6, 20);
                    if (runsOn(before[0], pts[k], before[1], reach)) overruns++;
                    if (runsOn(after[0], pts[k], after[2], reach)) overruns++;
                }
                const quick = sum / 4 * Math.sqrt(low) * Math.pow(shape.share, 0.15) * Math.pow(FIND.overrun, overruns);
                candidates.push({ pts, sides, quick, shape, borders, overruns });
            }
        }
        candidates.sort((x, y) => y.quick - x.quick);
        if (debug) debug.candidates = candidates.length;

        // Helligkeit, an der „hell“ gemessen wird: das obere Zwanzigstel des Bildes
        const hist = new Uint32Array(256);
        for (let i = 0; i < width * height; i++) hist[Math.min(255, Math.max(0, Math.round((planes[0][i] + planes[1][i] + planes[2][i]) / 3)))]++;
        let top = 255;
        for (let seen = 0; top > 0 && (seen += hist[top]) < width * height * 0.05; top--);

        let best = null;
        for (const cand of candidates.slice(0, FIND.shortlist)) {
            const rated = rate(cand, planes, top, width, height, centre, mag, lines, debug || !best ? 0 : best.score);
            if (debug) (debug.rated = debug.rated || []).push({ pts: cand.pts, quick: cand.quick, borders: cand.borders, overruns: cand.overruns, score: rated.score, reject: rated.reject, parts: rated.parts });
            if (!rated.reject && (!best || rated.score > best.score)) best = rated;
        }
        if (debug) debug.best = best;
        if (!best) return null;
        const corners = order(refineQuad(best, edges, width, height));
        return { corners, confidence: Math.round(clamp(best.score, 0, 1) * 100) / 100, open: best.cand.borders, share: best.parts.share, parts: best.parts };
    }

    // ---------- 5. Genaue Bewertung eines Vierecks ----------
    function rate(cand, planes, top, width, height, centre, mag, lines, beat = 0) {
        const { pts, sides, shape } = cand;
        const mid = { x: (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4, y: (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4 };
        const ringColours = [], sideScores = [];
        let polarity = 0, counted = 0;
        for (const [line, from, to] of sides) {
            const a = param(line, from), b = param(line, to), lo = Math.min(a, b), hi = Math.max(a, b), trim = Math.min(4, (hi - lo) * 0.08);
            const inner = ((mid.x - line.px) * line.nx + (mid.y - line.py) * line.ny) > 0 ? 1 : -1;      // welche Seite der Linie liegt innen?
            if (line.border) {
                const samples = [];                                              // Bildrand: Farbe knapp innen entlang des Rands
                for (let s = lo + trim; s <= hi - trim; s += 2) {
                    const x = line.px + line.dx * s + line.nx * inner * FIND.ring, y = line.py + line.dy * s + line.ny * inner * FIND.ring;
                    if (x < 0 || y < 0 || x >= width || y >= height) continue;
                    const i = (y | 0) * width + (x | 0);
                    samples.push([planes[0][i], planes[1][i], planes[2][i]]);
                }
                ringColours.push(samples);
                sideScores.push({ border: true });
                continue;
            }
            const k0 = clamp(Math.ceil(lo + trim) - line.first, 0, line.count - 1), k1 = clamp(Math.floor(hi - trim) - line.first, 0, line.count - 1);
            const inside = inner > 0 ? line.plus : line.minus;
            let n = 0, edges = 0, crossings = 0;
            const sum = [0, 0, 0], samples = [], picked = [];
            for (let k = k0; k <= k1; k++) {
                if (!line.valid[k]) continue;
                n++;
                if (line.state[k] === 1) edges++; else if (line.state[k] === 2) crossings++;
                sum[0] += line.diff[k * 3] * inner; sum[1] += line.diff[k * 3 + 1] * inner; sum[2] += line.diff[k * 3 + 2] * inner;
                samples.push([inside[k * 3], inside[k * 3 + 1], inside[k * 3 + 2]]);
                picked.push(k);
            }
            if (n < 6) return { reject: 'seite zu kurz' };
            const length = Math.hypot(sum[0], sum[1], sum[2]);
            let pro = 0, contra = 0, bright = 0, strength = 0;
            if (length > 1e-6) {
                const u = [sum[0] / length, sum[1] / length, sum[2] / length];
                strength = length / n / 1.732;                                   // mittlerer Sprung innen/außen (als grauer Sprung gerechnet)
                for (const k of picked) {
                    const along = (line.diff[k * 3] * u[0] + line.diff[k * 3 + 1] * u[1] + line.diff[k * 3 + 2] * u[2]) * inner;
                    // Voller Sprung (3 % in allen drei Farben) – oder ein schwächerer genau dort, wo auch eine Kante liegt.
                    if (along >= FIND.step * 1.732 || (line.state[k] === 1 && along >= FIND.step * 1.1)) pro++;
                    else if (along <= -FIND.step * 1.732) contra++;
                }
                bright = (u[0] + u[1] + u[2]) / 1.732;                           // +1: innen heller, −1: innen dunkler, 0: nur andere Farbe
            }
            ringColours.push(samples);
            const edge = Math.min(1, edges / (n - Math.min(0.35 * n, crossings))), clear = (pro - contra) / n;
            sideScores.push({ edge, pro: pro / n, contra: contra / n, clear, bright, strength, value: edge < 0.3 ? 0 : Math.max(0, clear) * (0.5 + 0.5 * edge) });
            polarity += bright; counted++;
        }
        const real = sideScores.filter(side => !side.border);
        if (real.length < 2) return { reject: 'zu wenig echte seiten' };
        const values = real.map(side => side.value);
        const low = Math.min(...values), mean = values.reduce((s, v) => s + v, 0) / values.length;
        if (low < 0.3) return { reject: 'schwache seite', detail: sideScores };
        // Mehr als das kann es nicht mehr werden (alle weiteren Faktoren sind höchstens 1) – reicht es nicht an das bisher Beste heran, aufhören.
        const fixed = mean * Math.sqrt(low) * Math.pow(FIND.overrun, cand.overruns) * (1 - 0.4 * ramp(shape.worst, 15, 42)) * (0.8 + 0.2 * ramp(shape.share, FIND.areaMin, 0.25)) * Math.pow(0.72, cand.borders);
        if (fixed <= beat) return { reject: 'chancenlos' };

        // Der Rand innen: überall dieselbe Farbe (Papier)?
        const flat = ringColours.flat();
        if (flat.length < 12) return { reject: 'rand zu kurz' };
        const median = list => { const sorted = list.slice().sort((a, b) => a - b); return sorted[sorted.length >> 1]; };
        const paper = [0, 1, 2].map(ch => median(flat.map(colour => colour[ch])));
        const paperLight = (paper[0] + paper[1] + paper[2]) / 3;
        if (paperLight < FIND.dark) return { reject: 'zu dunkel' };              // Tastatur, Handy, dunkles Buch
        // „Wie Papier“: dieselbe Farbart (nach Angleichen der Helligkeit) und eine Helligkeit im Rahmen dessen, was Schatten erklären.
        const like = colour => {
            const ratio = ((colour[0] + colour[1] + colour[2]) / 3 + 12) / (paperLight + 12);
            if (ratio < 0.5 || ratio > 1.7) return false;
            return Math.abs(colour[0] / ratio - paper[0]) + Math.abs(colour[1] / ratio - paper[1]) + Math.abs(colour[2] / ratio - paper[2]) < FIND.tone * (paperLight + 12) * 3;
        };
        // Je Seite: Die Proben müssen zur Papierfarbe passen und untereinander ähnlich hell sein (ein Schatten ändert sich allmählich).
        let ringGood = 0;
        for (let i = 0; i < ringColours.length; i++) {
            const samples = ringColours[i];
            if (!samples.length) { if (sideScores[i].border) return { reject: 'bildrand ohne papier' }; continue; }
            const sideLight = median(samples.map(colour => (colour[0] + colour[1] + colour[2]) / 3));
            let good = 0;
            for (const colour of samples) {
                const ratio = ((colour[0] + colour[1] + colour[2]) / 3 + 12) / (sideLight + 12);
                if (like(colour) && ratio >= 0.72 && ratio <= 1.4) good++;
            }
            // Am Bildrand muss das Blatt wirklich bis an den Rand reichen.
            if (sideScores[i].border && (samples.length < 4 || good < 0.8 * samples.length)) return { reject: 'bildrand ohne papier' };
            ringGood += good;
        }
        const ringShare = ringGood / flat.length;

        // Das Innere: überwiegend Papierfarbe (Schrift ist geschlossen), ohne starkes Muster?
        let insideCount = 0, insideLike = 0, rough = 0;
        for (let v = 0.1; v < 0.95; v += 0.08) {
            for (let u = 0.1; u < 0.95; u += 0.08) {
                const x = (pts[0].x * (1 - u) + pts[1].x * u) * (1 - v) + (pts[3].x * (1 - u) + pts[2].x * u) * v;
                const y = (pts[0].y * (1 - u) + pts[1].y * u) * (1 - v) + (pts[3].y * (1 - u) + pts[2].y * u) * v;
                if (x < 0 || y < 0 || x >= width || y >= height) continue;
                const i = (y | 0) * width + (x | 0);
                insideCount++;
                if (like([planes[0][i], planes[1][i], planes[2][i]])) insideLike++;
                if (mag[i] >= FIND.rough) rough++;
            }
        }
        const insideShare = insideCount ? insideLike / insideCount : 0, roughShare = insideCount ? rough / insideCount : 0;

        // Liegt im Viereck, nahe an einer Seite und gleichlaufend, noch eine durchgehende Kante? Dann ist diese Seite zu weit außen
        // (Maserung, Streifen, Tischkante) – die wahre Blattkante ist die innere.
        let inner = 0;
        for (let k = 0; k < 4; k++) {
            const [line] = sides[k], before = sides[(k + 3) % 4], after = sides[(k + 1) % 4];
            for (const other of lines) {
                if (other === line || Math.abs(other.nx * line.nx + other.ny * line.ny) < 0.94) continue;
                const p = cross(other, before[0]), q = cross(other, after[0]);
                if (!p || !q) continue;
                const tb = fraction(before[2], before[1], p), ta = fraction(after[1], after[2], q);      // 0 = an der Seite k, 1 = gegenüber
                if (!(tb > 0.03 && tb < 0.45 && ta > 0.03 && ta < 0.45)) continue;
                const from = param(other, p), to = param(other, q);
                if (Math.abs(to - from) < 8) continue;
                inner = Math.max(inner, stretch(other, from, to).hits);
            }
        }
        const brightness = (paperLight + 12) / (top + 12);
        const parts = {
            sides: mean * Math.sqrt(low), low, mean,
            ring: ramp(ringShare, 0.55, 0.9), inside: ramp(insideShare, 0.6, 0.9), smooth: 1 - ramp(roughShare, 0.2, 0.45), light: ramp(brightness, 0.3, 0.55),
            tight: 1 - ramp(inner, 0.85, 0.97), corners: Math.pow(FIND.overrun, cand.overruns),
            strong: 0.75 + 0.25 * ramp(real.reduce((sum, side) => sum + side.strength, 0) / real.length, 0.03, 0.15),
            angle: 1 - 0.4 * ramp(shape.worst, 15, 42), size: 0.8 + 0.2 * ramp(shape.share, FIND.areaMin, 0.25), centre: pointIn(centre, pts) ? 1 : 0.85,
            borders: Math.pow(0.72, cand.borders), polarity: counted ? polarity / counted : 0,
            ringShare, insideShare, roughShare, inner, overruns: cand.overruns, brightness, share: shape.share, detail: sideScores
        };
        const score = parts.sides * parts.ring * parts.inside * parts.smooth * parts.tight * parts.corners * parts.strong * parts.light * parts.angle * parts.size * parts.centre * parts.borders;
        return { cand, score, parts };
    }

    // ---------- 6. Seiten genau an die Kantenpunkte zwischen den Ecken legen, dann neu schneiden ----------
    function refineQuad(best, edges, width, height) {
        const { sides, pts } = best.cand;
        const mid = { x: (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4, y: (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4 };
        const lines = sides.map(([line, from, to]) => {
            if (line.border) return line;
            const a = param(line, from), b = param(line, to), lo = Math.min(a, b), hi = Math.max(a, b), trim = (hi - lo) * 0.06;
            const angle = Math.atan2(line.ny, line.nx), near = new Set();
            walk(line, width, height, (k, x, y) => {
                const s = line.first + k;
                if (s >= lo + trim && s <= hi - trim) nearPoints(edges, x, y, line.nx, line.ny, angle, width, height, p => near.add(p));
            });
            const fitted = fitPoints(line, [...near]) || line;
            const inner = ((mid.x - line.cx - fitted.nx * fitted.c) * fitted.nx + (mid.y - line.cy - fitted.ny * fitted.c) * fitted.ny) > 0 ? 1 : -1;
            return { ...fitted, c: fitted.c + inner * FIND.inset };              // knapp nach innen: lieber ein Hauch Papier weniger als ein Streifen Tisch
        });
        const out = [cross(lines[3], lines[0]), cross(lines[0], lines[1]), cross(lines[1], lines[2]), cross(lines[2], lines[3])];
        return out.every(Boolean) ? out : pts;                                   // Ecken dürfen knapp außerhalb des Bildes liegen
    }

    // Kleine Kopie für die Blattsuche: Der Browser verkleinert höchstens auf das Vierfache der Zielgröße, den Rest mittelt diese
    // Schleife genau. (Manche Geräte lassen beim starken Verkleinern Bildpunkte aus – Schrift flimmert dann zu falschen Kanten.)
    let scratch = null;
    function smallCopy(source, maxSide) {
        const sw = source.videoWidth || source.naturalWidth || source.width, sh = source.videoHeight || source.naturalHeight || source.height;
        const scale = Math.min(1, maxSide / Math.max(sw, sh));
        const width = Math.max(8, Math.round(sw * scale)), height = Math.max(8, Math.round(sh * scale));
        const times = Math.max(1, Math.min(4, Math.floor(Math.max(sw, sh) / Math.max(width, height))));
        if (!scratch) scratch = makeCanvas(8, 8);
        if (scratch.width !== width * times || scratch.height !== height * times) { scratch.width = width * times; scratch.height = height * times; }
        const ctx = context(scratch);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(source, 0, 0, scratch.width, scratch.height);
        const big = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
        if (times === 1) return { pixels: big, width, height, sx: sw / width, sy: sh / height };
        const pixels = new Uint8ClampedArray(width * height * 4), row = width * times * 4, cells = times * times;
        for (let y = 0, p = 0; y < height; y++) {
            for (let x = 0; x < width; x++, p += 4) {
                let r = 0, g = 0, b = 0;
                for (let dy = 0, q = y * times * row + x * times * 4; dy < times; dy++, q += row) {
                    for (let dx = 0, i = q; dx < times; dx++, i += 4) { r += big[i]; g += big[i + 1]; b += big[i + 2]; }
                }
                pixels[p] = r / cells; pixels[p + 1] = g / cells; pixels[p + 2] = b / cells; pixels[p + 3] = 255;
            }
        }
        return { pixels, width, height, sx: sw / width, sy: sh / height };
    }

    // Legt die vier Seiten genau an die Blattkante – auf einer größeren Kopie und ohne die Schrift zu schließen (das verschiebt
    // Kanten neben einem Schlagschatten leicht nach außen). Je Seite wird an vielen Stellen quer zur Kante von innen nach außen
    // gesucht: Wo weicht die Farbe zum ersten Mal deutlich vom Papier ab? Dort endet das Blatt – auch wenn dahinter erst ein
    // Schatten und dann der Tisch kommt. Durch diese Punkte geht eine Ausgleichsgerade; die Geraden schneiden sich in den Ecken.
    function refineSides(source, corners) {
        const copy = smallCopy(source, LIMITS.fineSide), { pixels, width, height } = copy;
        const pts = corners.map(p => ({ x: p.x / copy.sx, y: p.y / copy.sy }));
        const mid = { x: (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4, y: (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4 };
        const at = (x, y, out) => {                                              // Farbe zwischen den Bildpunkten (bilinear) → out
            const fx = clamp(x - 0.5, 0, width - 1.001), fy = clamp(y - 0.5, 0, height - 1.001), x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0, i = (y0 * width + x0) * 4, down = width * 4;
            for (let k = 0; k < 3; k++) {
                const top = pixels[i + k] + (pixels[i + 4 + k] - pixels[i + k]) * ax, bottom = pixels[i + down + k] + (pixels[i + down + 4 + k] - pixels[i + down + k]) * ax;
                out[k] = top + (bottom - top) * ay;
            }
            return out;
        };
        const reach = LIMITS.fineReach, colour = [0, 0, 0];
        const lines = pts.map((a, index) => {
            const b = pts[(index + 1) % 4], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
            let nx = dy / length, ny = -dx / length;                              // zeigt nach außen
            if ((mid.x - a.x) * nx + (mid.y - a.y) * ny > 0) { nx = -nx; ny = -ny; }
            const found = [], steps = Math.max(12, Math.min(60, Math.round(length / 6)));
            for (let step = 0; step < steps; step++) {
                const t = 0.07 + 0.86 * (step + 0.5) / steps, px = a.x + dx * t, py = a.y + dy * t;
                if (px - nx * reach < 1 || py - ny * reach < 1 || px - nx * reach > width - 1 || py - ny * reach > height - 1) continue;
                // Papier: Mittel aus drei Proben innen; draußen: Mittel aus drei Proben außen
                const paper = [0, 0, 0], outer = [0, 0, 0];
                for (let k = 0; k < 3; k++) {
                    at(px - nx * (reach - k), py - ny * (reach - k), colour); paper[0] += colour[0] / 3; paper[1] += colour[1] / 3; paper[2] += colour[2] / 3;
                    at(px + nx * (reach - k), py + ny * (reach - k), colour); outer[0] += colour[0] / 3; outer[1] += colour[1] / 3; outer[2] += colour[2] / 3;
                }
                const scale = (paper[0] + paper[1] + paper[2]) / 3 + 24;
                const gap = c => (Math.abs(c[0] - paper[0]) + Math.abs(c[1] - paper[1]) + Math.abs(c[2] - paper[2])) / 3 / scale;
                const level = Math.max(0.035, 0.4 * gap(outer));
                if (gap(outer) < 0.03) continue;                                  // hier ist kein Unterschied zu sehen
                let before = 0;
                for (let offset = -reach + 3; offset <= reach; offset += 0.5) {
                    const now = gap(at(px + nx * offset, py + ny * offset, colour));
                    if (now >= level) { const exact = offset - 0.5 * (now - level) / Math.max(1e-6, now - before); found.push({ x: px + nx * exact, y: py + ny * exact }); break; }
                    before = now;
                }
            }
            // Ausgleichsgerade, beim zweiten Mal ohne Ausreißer (Finger auf der Kante, Schrift dicht am Rand)
            let line = { x: a.x, y: a.y, dx: dx / length, dy: dy / length };
            if (found.length < steps * 0.4) return { ...line, weak: true };
            for (const limit of [3, 1.2]) {
                const used = found.filter(p => Math.abs((p.x - line.x) * line.dy - (p.y - line.y) * line.dx) <= limit);
                if (used.length < steps * 0.3) break;
                let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
                for (const p of used) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y; }
                const n = used.length, angle = Math.atan2(2 * (sxy / n - sx * sy / (n * n)), sxx / n - (sx / n) ** 2 - syy / n + (sy / n) ** 2) / 2;
                let fx = Math.cos(angle), fy = Math.sin(angle);
                if (fx * line.dx + fy * line.dy < 0) { fx = -fx; fy = -fy; }
                if (fx * line.dx + fy * line.dy < 0.985) break;                   // mehr als 10° gedreht – nicht glaubhaft
                line = { x: sx / n, y: sy / n, dx: fx, dy: fy };
            }
            return { x: line.x - nx * LIMITS.fineInset, y: line.y - ny * LIMITS.fineInset, dx: line.dx, dy: line.dy };      // ein Hauch nach innen
        });
        return lines.map((line, i) => {
            const before = lines[(i + 3) % 4], den = before.dx * line.dy - before.dy * line.dx;
            if (Math.abs(den) < 1e-9 || line.weak || before.weak) return corners[i];
            const t = ((line.x - before.x) * line.dy - (line.y - before.y) * line.dx) / den;
            return { x: (before.x + t * before.dx) * copy.sx, y: (before.y + t * before.dy) * copy.sy };
        });
    }

    // Sucht das Blatt im Foto (Canvas, Bild oder laufendes Video). fine: false = ohne das genaue Nachlegen der Seiten (für das
    // laufende Kamerabild – dort zählt Tempo, zugeschnitten wird erst die Aufnahme).
    // Ergebnis: { corners: [oben links, oben rechts, unten rechts, unten links] in Bildpunkten der Vorlage, confidence: 0…1,
    //             open: so viele Seiten liegen am Bildrand (das Blatt ragt aus dem Bild), share: Anteil des Blatts am Bild } oder null.
    // Die Ecken dürfen knapp außerhalb des Bildes liegen (eine Ecke ragt hinaus).
    function detect(source, { fine = true } = {}) {
        const small = smallCopy(source, LIMITS.detectSide);
        const found = findSheet(small.pixels, small.width, small.height, 4);
        if (!found) return null;
        let corners = found.corners.map(p => ({ x: p.x * small.sx, y: p.y * small.sy }));
        if (fine && !found.open && found.confidence >= LIMITS.confidence * 0.6) {
            try { corners = refineSides(source, corners); } catch (error) { /* es bleiben die Ecken aus der kleinen Kopie */ }
        }
        return { corners, confidence: found.confidence, open: found.open, share: Math.round(found.share * 1000) / 1000 };
    }

    // ---------- Gerade ziehen ----------
    // Zieht das Viereck corners zu einem Rechteck. Größe: Mittel der gegenüberliegenden Seiten, längere Seite höchstens maxSide.
    function warp(canvas, corners, { maxSide = 2000 } = {}) {
        const [tl, tr, br, bl] = corners;
        const span = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
        const wide = (span(tl, tr) + span(bl, br)) / 2, high = (span(tl, bl) + span(tr, br)) / 2;
        const scale = Math.min(1, maxSide / Math.max(wide, high));
        const out = makeCanvas(wide * scale, high * scale);
        const { width, height } = out;
        // Abbildung des Einheitsquadrats auf das Viereck (Homographie): x = (a·u + b·v + c) / (g·u + h·v + 1), y entsprechend.
        const sx = tl.x - tr.x + br.x - bl.x, sy = tl.y - tr.y + br.y - bl.y;
        const dx1 = tr.x - br.x, dx2 = bl.x - br.x, dy1 = tr.y - br.y, dy2 = bl.y - br.y;
        const det = dx1 * dy2 - dx2 * dy1 || 1e-9;
        const g = (sx * dy2 - dx2 * sy) / det, h = (dx1 * sy - sx * dy1) / det;
        const a = tr.x - tl.x + g * tr.x, b = bl.x - tl.x + h * bl.x, c = tl.x;
        const d = tr.y - tl.y + g * tr.y, e = bl.y - tl.y + h * bl.y, f = tl.y;
        const sw = canvas.width, sh = canvas.height;
        const src = context(canvas).getImageData(0, 0, sw, sh).data;
        const image = context(out).createImageData(width, height), dst = image.data;
        for (let y = 0, p = 0; y < height; y++) {
            const v = (y + 0.5) / height;
            for (let x = 0; x < width; x++, p += 4) {
                const u = (x + 0.5) / width, w = g * u + h * v + 1;
                const fx = Math.min(sw - 1, Math.max(0, (a * u + b * v + c) / w - 0.5));
                const fy = Math.min(sh - 1, Math.max(0, (d * u + e * v + f) / w - 0.5));
                const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
                const i00 = (y0 * sw + x0) * 4, i10 = x0 < sw - 1 ? i00 + 4 : i00, down = y0 < sh - 1 ? sw * 4 : 0;
                for (let k = 0; k < 3; k++) {                                        // zwischen den vier Nachbarn mitteln (bilinear)
                    const top = src[i00 + k] + (src[i10 + k] - src[i00 + k]) * ax;
                    const bottom = src[i00 + down + k] + (src[i10 + down + k] - src[i00 + down + k]) * ax;
                    dst[p + k] = top + (bottom - top) * ay;
                }
                dst[p + 3] = 255;
            }
        }
        context(out).putImageData(image, 0, 0);
        return out;
    }

    // ---------- Laden und Speichern ----------
    function viaImage(blob) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(blob);
            const image = new Image();
            image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
            image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(OPEN_ERROR)); };
            image.src = url;
        });
    }

    // Lädt das Foto aufrecht (Drehung laut EXIF) und verkleinert es, bis die längere Seite höchstens maxSide misst.
    async function fromFile(file, { maxSide = 2000 } = {}) {
        let source = null;
        try {
            if (typeof createImageBitmap === 'function') source = await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (error) {
            source = null;      // z. B. HEIC in einem Browser, der es nur als <img> zeigen kann
        }
        try {
            if (!source) source = await viaImage(file);
            const width = source.naturalWidth || source.width, height = source.naturalHeight || source.height;
            if (!width || !height) throw new Error(OPEN_ERROR);
            const scale = Math.min(1, maxSide / Math.max(width, height));
            const canvas = makeCanvas(width * scale, height * scale);
            const ctx = context(canvas);
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
            if (source.close) source.close();
            return canvas;
        } catch (error) {
            throw new Error(OPEN_ERROR);
        }
    }

    function toBlob(canvas, quality = 0.82) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Das Foto konnte nicht gespeichert werden.')), 'image/jpeg', quality);
        });
    }

    // ---------- Aufhellen: aus dem Foto wird ein „Scan“ ----------
    // Papierfarbe an jeder Stelle – je Farbkanal, auf einer kleinen Kopie: Dunkles bis zur Größe 2 · radius schließen, dann
    // weichzeichnen. Übrig bleiben Beleuchtung und Farbstich (Schatten, dunkle Ecken, gelbes Lampenlicht) – Schrift, Stempel
    // und Unterschriften stecken nicht mehr darin.
    function paperMaps(canvas, radius, side = LIMITS.paperSide) {
        const small = shrink(canvas, side), { width, height } = small;
        const rgba = context(small).getImageData(0, 0, width, height).data;
        const steps = Math.max(1, Math.round(radius / 2));
        // Der Bildrand wird für das Schließen nach außen fortgesetzt (um die doppelte Reichweite). Sonst gälte ein schmaler Schatten
        // direkt am Blattrand – Heftseite, Deckel des Scanners, Schlagschatten der Blattkante – als „Schrift“ und bliebe als grauer
        // Streifen stehen. So zählt er wie jeder andere Schatten zur Beleuchtung und wird herausgerechnet. Was nur als schmaler
        // Strich an den Rand stößt (eine abgeschnittene Zeile, eine Tabellenlinie), bleibt weiterhin Schrift.
        const pad = steps * 4, wide = width + 2 * pad, tall = height + 2 * pad;
        const tmp = new Float32Array(wide * tall), work = new Float32Array(wide * tall);
        const maps = [0, 1, 2].map(channel => {
            let plane = new Float32Array(wide * tall), other = work;
            for (let y = 0; y < tall; y++) {
                const row = Math.min(height - 1, Math.max(0, y - pad)) * width;
                for (let x = 0; x < wide; x++) plane[y * wide + x] = rgba[(row + Math.min(width - 1, Math.max(0, x - pad))) * 4 + channel];
            }
            // Schließen in Schritten von zwei Punkten (größter Wert, dann kleinster) – zusammen wirkt es wie ein Umkreis von radius.
            for (const most of [true, false]) {
                for (let step = 0; step < steps; step++) { five(plane, tmp, other, wide, tall, most); [plane, other] = [other, plane]; }
            }
            // Weichzeichnen noch mit dem fortgesetzten Rand (ein schmaler Schatten an der Blattkante verläuft sonst ins Helle), dann zuschneiden.
            for (let step = 0; step < 2; step++) { soften(plane, tmp, other, wide, tall); [plane, other] = [other, plane]; }
            const map = new Float32Array(width * height);
            for (let y = 0; y < height; y++) map.set(plane.subarray((y + pad) * wide + pad, (y + pad) * wide + pad + width), y * width);
            return map;
        });
        return { maps, width, height };
    }
    // Wert, unter dem der Anteil share aller Zählungen liegt (hist: Zählungen je Stufe).
    function levelAt(hist, share) {
        let total = 0, seen = 0;
        for (let i = 0; i < hist.length; i++) total += hist[i];
        for (let i = 0; i < hist.length; i++) { seen += hist[i]; if (seen >= total * share) return i; }
        return hist.length - 1;
    }

    // Macht das Blatt gut lesbar und gibt ein neues Canvas zurück (die Vorlage bleibt, wie sie ist).
    //   'auto'   wie ein Scanner: Papier wird rein weiß (Schatten und Farbstich heraus, je Farbkanal durch die Papierfarbe geteilt),
    //            Schrift wird dunkler und schärfer – Farben bleiben (Stempel, Unterschrift, Markierungen)
    //   'color'  nur Kontrast spreizen, die Beleuchtung bleibt (für Fotos und farbige Vorlagen)
    //   'gray'   wie 'auto', aber in Graustufen
    //   'bw'     reines Schwarz-Weiß: schwarz ist, was deutlich dunkler ist als das Papier an dieser Stelle
    function enhance(canvas, { mode = 'auto' } = {}) {
        const { width, height } = canvas;
        const out = makeCanvas(width, height);
        const ctx = context(out);
        ctx.drawImage(canvas, 0, 0);
        const image = ctx.getImageData(0, 0, width, height), data = image.data;
        const place = (index, size, count) => Math.min(count - 1, Math.max(0, (index + 0.5) * count / size - 0.5));
        if (mode === 'bw') {
            // Für Schwarz-Weiß zählt, dass auch schmale Schatten verschwinden (kleiner Radius).
            const { gray, width: pw, height: ph } = grayOf(canvas, 160);
            const map = blur(spread(spread(gray, pw, ph, 3, Math.max), pw, ph, 3, Math.min), pw, ph, 1);
            const columns = Float32Array.from({ length: width }, (unused, x) => place(x, width, pw));
            const line = new Float32Array(pw + 1);
            for (let y = 0, p = 0; y < height; y++) {
                const fy = place(y, height, ph), y0 = fy | 0, y1 = Math.min(ph - 1, y0 + 1);
                for (let x = 0; x < pw; x++) line[x] = map[y0 * pw + x] + (map[y1 * pw + x] - map[y0 * pw + x]) * (fy - y0);
                line[pw] = line[pw - 1];
                for (let x = 0; x < width; x++, p += 4) {
                    const x0 = columns[x] | 0, local = line[x0] + (line[x0 + 1] - line[x0]) * (columns[x] - x0);
                    data[p] = data[p + 1] = data[p + 2] = luma(data[p], data[p + 1], data[p + 2]) < LIMITS.bwLevel * local ? 0 : 255;
                }
            }
            ctx.putImageData(image, 0, 0);
            return out;
        }
        if (mode === 'color') {
            // Kontrast: Was zwischen dem 1. und dem 99. Hundertstel der Helligkeit liegt, wird auf 0 … 255 gespreizt.
            const hist = new Float64Array(256);
            for (let p = 0; p < data.length; p += 16) hist[Math.round(luma(data[p], data[p + 1], data[p + 2]))]++;
            const high = levelAt(hist, 0.99), low = Math.min(levelAt(hist, 0.01), high - 96);      // fast leere Seiten nicht überziehen
            const lut = new Uint8ClampedArray(256);
            for (let value = 0; value < 256; value++) lut[value] = (value - low) * 255 / (high - low);
            for (let p = 0; p < data.length; p += 4) { data[p] = lut[data[p]]; data[p + 1] = lut[data[p + 1]]; data[p + 2] = lut[data[p + 2]]; }
            ctx.putImageData(image, 0, 0);
            return out;
        }

        // ----- 'auto' und 'gray' -----
        const paper = paperMaps(canvas, LIMITS.paperRadius), pw = paper.width, ph = paper.height;
        // Papierfarbe an gut beleuchteter Stelle (je Kanal) – der Maßstab dafür, was „dunkle Fläche“ ist.
        const tops = paper.maps.map(map => { const hist = new Float64Array(256); for (let i = 0; i < map.length; i++) hist[Math.min(255, Math.max(0, Math.round(map[i])))]++; return Math.max(1, levelAt(hist, 0.9)); });
        const topLuma = luma(tops[0], tops[1], tops[2]);
        const columns = Float32Array.from({ length: width }, (unused, x) => place(x, width, pw));
        const lines = [new Float32Array(pw + 1), new Float32Array(pw + 1), new Float32Array(pw + 1)];
        const fillLines = y => {
            const fy = place(y, height, ph), y0 = fy | 0, y1 = Math.min(ph - 1, y0 + 1), t = fy - y0;
            for (let k = 0; k < 3; k++) {
                const map = paper.maps[k], line = lines[k];
                for (let x = 0; x < pw; x++) line[x] = map[y0 * pw + x] + (map[y1 * pw + x] - map[y0 * pw + x]) * t;
                line[pw] = line[pw - 1];
            }
        };
        // Papierfarbe an der Stelle x der aktuellen Zeile. Dunkle Flächen (Foto, großes Logo, Tisch neben dem Blatt) und kräftig
        // gefärbte Flächen sind kein Schatten: Dort gilt die normale Papierfarbe, sie werden also nicht aufgehellt oder entfärbt.
        const local = [0, 0, 0];
        const fadeLow = LIMITS.darkArea, fadeHigh = LIMITS.darkArea + 0.12, floor = 1 / LIMITS.maxGain;
        const paperAt = x => {
            const x0 = columns[x] | 0, fx = columns[x] - x0;
            let r = lines[0][x0] + (lines[0][x0 + 1] - lines[0][x0]) * fx;
            let g = lines[1][x0] + (lines[1][x0 + 1] - lines[1][x0]) * fx;
            let b = lines[2][x0] + (lines[2][x0 + 1] - lines[2][x0]) * fx;
            const rel = luma(r, g, b) / topLuma;
            let keep = rel >= fadeHigh ? 1 : rel <= fadeLow ? 0 : (rel - fadeLow) / (fadeHigh - fadeLow);
            // Eine Farbfläche (farbiger Balken im Briefkopf, Klebezettel) ist ebenfalls kein Schatten: Ein Schatten macht das Papier
            // dunkler, aber nicht bunt. Ist die Stelle deutlich anders gefärbt als das Papier, bleibt sie, wie sie ist.
            const qr = r / tops[0], qg = g / tops[1], qb = b / tops[2];
            const high = qr > qg ? (qr > qb ? qr : qb) : (qg > qb ? qg : qb), low = qr < qg ? (qr < qb ? qr : qb) : (qg < qb ? qg : qb);
            const cast = high > 0 ? 1 - low / high : 0;
            if (cast > LIMITS.castLow) keep = Math.min(keep, cast >= LIMITS.castHigh ? 0 : 1 - (cast - LIMITS.castLow) / (LIMITS.castHigh - LIMITS.castLow));
            if (keep < 1) { r = tops[0] + (r - tops[0]) * keep; g = tops[1] + (g - tops[1]) * keep; b = tops[2] + (b - tops[2]) * keep; }
            local[0] = Math.max(r, tops[0] * floor); local[1] = Math.max(g, tops[1] * floor); local[2] = Math.max(b, tops[2] * floor);
        };

        // 1. Blick: Wie hell ist das Papier im Verhältnis zur Papierfarbe (Rauschen!) und wie dunkel die Schrift?
        const STEPS = 512, SPAN = 1.25;                                              // Verhältnis 0 … 1,25 in 512 Stufen
        const ratios = new Float64Array(STEPS);
        const stride = Math.max(1, Math.round(Math.sqrt(width * height / 160000)));
        for (let y = 0; y < height; y += stride) {
            fillLines(y);
            for (let x = 0, p = y * width * 4; x < width; x += stride, p += stride * 4) {
                paperAt(x);
                const ratio = luma(data[p] / local[0], data[p + 1] / local[1], data[p + 2] / local[2]);
                ratios[Math.min(STEPS - 1, (ratio * STEPS / SPAN) | 0)]++;
            }
        }
        // Papier: die häufigste Stufe im hellen Bereich; Streuung darum = Rauschen des Fotos.
        let mode1 = 0;
        for (let i = (0.7 * STEPS / SPAN) | 0; i < STEPS; i++) if (ratios[i] > ratios[mode1] || !mode1) mode1 = i;
        const paperLevel = (mode1 + 0.5) * SPAN / STEPS;
        let weight = 0, spreadSum = 0;
        for (let i = 0; i < STEPS; i++) {
            const value = (i + 0.5) * SPAN / STEPS;
            if (Math.abs(value - paperLevel) > 0.15) continue;
            weight += ratios[i]; spreadSum += ratios[i] * (value - paperLevel) ** 2;
        }
        const noise = weight ? Math.sqrt(spreadSum / weight) : 0.02;
        // Schwarzpunkt: die dunkelste Schrift.
        // Weißpunkt der Kurve: fast beim Papier. Das Rauschen auf dem Papier nimmt danach das „Putzen“ heraus (Schritt 3) – nicht mehr
        // ein tiefer Weißpunkt, der blasse Schrift mit wegbleichen würde.
        const white = Math.max(paperLevel - 0.06, paperLevel - LIMITS.whiteNoise * noise);
        const black = Math.min(LIMITS.blackMax, Math.max(0.04, (levelAt(ratios, 0.004) + 0.5) * SPAN / STEPS));
        const LUT = 1024, lutSpan = 1.25;
        const lut = new Uint8ClampedArray(LUT + 1);
        for (let i = 0; i <= LUT; i++) {
            const t = Math.min(1, Math.max(0, (i * lutSpan / LUT - black) / (white - black)));
            lut[i] = Math.round(255 * Math.pow(t, LIMITS.inkGamma));
        }
        const scale = LUT / lutSpan;

        // 2. Durchgang: jeden Farbkanal durch die Papierfarbe teilen, dann die Kurve.
        const gray = mode === 'gray';
        const lightness = new Uint8Array(width * height);                            // Helligkeit nach der Kurve – fürs Schärfen
        const level = new Uint16Array(width * height), UNIT = 40000;                  // Helligkeit im Verhältnis zum Papier (1 = UNIT) – fürs Putzen
        for (let y = 0, p = 0, i = 0; y < height; y++) {
            fillLines(y);
            for (let x = 0; x < width; x++, p += 4, i++) {
                paperAt(x);
                const qr = data[p] / local[0], qg = data[p + 1] / local[1], qb = data[p + 2] / local[2];
                // halb Helligkeit, halb schwächste Farbe: Blasses in Farbe (Textmarker, Stempel, Durchschlag) liegt damit klar unter dem Papier
                level[i] = Math.min(65535, (0.1495 * qr + 0.2935 * qg + 0.057 * qb + 0.5 * (qr < qg ? (qr < qb ? qr : qb) : (qg < qb ? qg : qb))) * UNIT);
                let r = lut[Math.min(LUT, qr * scale) | 0];
                let g = lut[Math.min(LUT, qg * scale) | 0];
                let b = lut[Math.min(LUT, qb * scale) | 0];
                const light = (r * 77 + g * 150 + b * 29) >> 8;
                // Fast farblose Stellen (schwarze Schrift mit Farbrauschen) werden rein grau; Farbiges bleibt farbig.
                const chroma = Math.max(r, g, b) - Math.min(r, g, b);
                if (gray || chroma <= LIMITS.neutral) r = g = b = light;
                else if (chroma < LIMITS.neutral * 2) { const keep = (chroma - LIMITS.neutral) / LIMITS.neutral; r = light + (r - light) * keep; g = light + (g - light) * keep; b = light + (b - light) * keep; }
                data[p] = r; data[p + 1] = g; data[p + 2] = b;
                lightness[i] = light;
            }
        }

        // 3. Papier putzen. Rein weiß wird, was nichts als Rauschen, Papierfaser oder ein Rest von Schatten ist – stehen bleibt jeder
        //    Strich, auch ein blasser. Dazu wird die Helligkeit geglättet (5 × 5 Punkte, 1-4-6-4-1: Rauschen mittelt sich heraus) und
        //    mit dem „Papier im Kleinen“ verglichen: dem hellsten Wert im nahen Umkreis. Ein Strich ist dunkler als das Papier neben
        //    ihm; ein Schattenrest ist so hell wie seine Umgebung – auch wenn die Papierfarbe (Schritt 2) dort etwas danebenliegt.
        {
            const soft = new Uint16Array(level.length), row = new Float32Array(Math.max(width, height));
            for (let y = 0; y < height; y++) {
                const o = y * width;
                for (let x = 0; x < width; x++) {
                    row[x] = (level[o + (x >= 2 ? x - 2 : 0)] + level[o + (x + 2 < width ? x + 2 : width - 1)] + 4 * (level[o + (x >= 1 ? x - 1 : 0)] + level[o + (x + 1 < width ? x + 1 : width - 1)]) + 6 * level[o + x]) / 16;
                }
                for (let x = 0; x < width; x++) soft[o + x] = row[x];
            }
            for (let x = 0; x < width; x++) {                                          // senkrecht – das Ergebnis ersetzt level
                for (let y = 0; y < height; y++) {
                    const o = y * width + x, up1 = y >= 1 ? o - width : o, up2 = y >= 2 ? o - 2 * width : up1, down1 = y + 1 < height ? o + width : o, down2 = y + 2 < height ? o + 2 * width : down1;
                    row[y] = (soft[up2] + soft[down2] + 4 * (soft[up1] + soft[down1]) + 6 * soft[o]) / 16;
                }
                for (let y = 0; y < height; y++) level[y * width + x] = row[y];
            }
            // Papier im Kleinen: hellster Wert je Kästchen (cell × cell Punkte), dann über die Nachbarkästchen ausgedehnt.
            const cell = Math.max(2, Math.round(Math.max(width, height) / 500)), cw = Math.ceil(width / cell), ch = Math.ceil(height / cell);
            let tops = new Float32Array(cw * ch), spare = new Float32Array(cw * ch);
            const tmp = new Float32Array(cw * ch);
            for (let y = 0; y < height; y++) {
                const o = y * width, c = ((y / cell) | 0) * cw;
                for (let x = 0; x < width; x++) { const i = c + ((x / cell) | 0); if (level[o + x] > tops[i]) tops[i] = level[o + x]; }
            }
            for (let step = 0; step < LIMITS.cleanReach; step++) { five(tops, tmp, spare, cw, ch, true); [tops, spare] = [spare, tops]; }
            soften(tops, tmp, spare, cw, ch);
            const gap = Math.max(LIMITS.cleanGap, noise) * UNIT, fade = LIMITS.cleanFade * UNIT, deep = (paperLevel - Math.max(LIMITS.cleanDeep, 1.5 * noise)) * UNIT;
            for (let y = 0, i = 0, p = 0; y < height; y++) {
                const fy = Math.min(ch - 1.001, Math.max(0, (y + 0.5) / cell - 0.5)), y0 = fy | 0, ty = fy - y0;
                for (let x = 0; x < width; x++, i++, p += 4) {
                    const value = level[i];
                    if (value < deep) continue;                                        // deutlich dunkler als Papier: Schrift, Fläche, Foto
                    const fx = Math.min(cw - 1.001, Math.max(0, (x + 0.5) / cell - 0.5)), x0 = fx | 0, tx = fx - x0, c = y0 * cw + x0;
                    const upper = spare[c] + (spare[c + 1] - spare[c]) * tx, lower = spare[c + cw] + (spare[c + cw + 1] - spare[c + cw]) * tx;
                    const dip = upper + (lower - upper) * ty - value;                  // so viel dunkler als das Papier ringsum
                    if (dip >= gap + fade) continue;
                    if (dip <= gap) { data[p] = data[p + 1] = data[p + 2] = 255; lightness[i] = 255; continue; }
                    const t = 1 - (dip - gap) / fade, w = t * t * (3 - 2 * t);
                    data[p] += (255 - data[p]) * w; data[p + 1] += (255 - data[p + 1]) * w; data[p + 2] += (255 - data[p + 2]) * w;
                    lightness[i] += (255 - lightness[i]) * w;
                }
            }
        }

        // 4. Schärfen (unscharf maskieren): Unterschied zur weichgezeichneten Helligkeit verstärken. Reines Weiß bleibt weiß.
        if (LIMITS.sharpen > 0) {
            const soft = new Uint8Array(lightness.length), row = new Float32Array(Math.max(width, height));
            for (let y = 0; y < height; y++) {                                         // waagerecht 1-4-6-4-1
                const o = y * width;
                for (let x = 0; x < width; x++) {
                    const a = lightness[o + Math.max(0, x - 2)], b2 = lightness[o + Math.max(0, x - 1)], c = lightness[o + x], d = lightness[o + Math.min(width - 1, x + 1)], e = lightness[o + Math.min(width - 1, x + 2)];
                    row[x] = (a + e + 4 * (b2 + d) + 6 * c) / 16;
                }
                for (let x = 0; x < width; x++) soft[o + x] = row[x];
            }
            const amount = LIMITS.sharpen;
            for (let x = 0; x < width; x++) {                                          // senkrecht, dann gleich anwenden
                for (let y = 0; y < height; y++) {
                    const a = soft[Math.max(0, y - 2) * width + x], b2 = soft[Math.max(0, y - 1) * width + x], c = soft[y * width + x], d = soft[Math.min(height - 1, y + 1) * width + x], e = soft[Math.min(height - 1, y + 2) * width + x];
                    row[y] = (a + e + 4 * (b2 + d) + 6 * c) / 16;
                }
                for (let y = 0; y < height; y++) {
                    const i = y * width + x, delta = (lightness[i] - row[y]) * amount;
                    if (delta > -1 && delta < 1) continue;
                    const p = i * 4;
                    data[p] += delta; data[p + 1] += delta; data[p + 2] += delta;      // Uint8ClampedArray begrenzt auf 0 … 255
                }
            }
        }
        ctx.putImageData(image, 0, 0);
        return out;
    }

    // ---------- Gerade rücken, drehen, leere Seiten ----------
    // Schräglage der Schrift in Grad (im Uhrzeigersinn positiv), z. B. bei schief eingezogenen Seiten eines Kopierers.
    // Verfahren: Die dunklen Stellen einer kleinen Kopie werden für jeden Winkel zeilenweise gezählt – stehen die Schriftzeilen
    // waagerecht, wechseln volle und leere Zeilen am schärfsten. sure = false: zu wenig Schrift oder kein klarer Winkel.
    function skew(canvas, { maxAngle = LIMITS.skewMax } = {}) {
        const { gray, width, height } = grayOf(canvas, 480);
        const level = Math.min(170, Math.max(60, otsu(gray)));
        const xs = [], ys = [];
        for (let y = 2; y < height - 2; y++) for (let x = 2; x < width - 2; x++) if (gray[y * width + x] < level) { xs.push(x - width / 2); ys.push(y - height / 2); }
        if (xs.length < 250 || xs.length > width * height * 0.5) return { angle: 0, sure: false };
        const rows = new Float64Array(height * 2 + 4);
        const score = degrees => {
            const sin = Math.sin(degrees * Math.PI / 180), cos = Math.cos(degrees * Math.PI / 180);
            rows.fill(0);
            for (let i = 0; i < xs.length; i++) rows[Math.round(ys[i] * cos - xs[i] * sin + height) | 0]++;
            let sum = 0;
            for (let r = 1; r < rows.length; r++) { const step = rows[r] - rows[r - 1]; sum += step * step; }
            return sum;
        };
        let best = 0, bestScore = score(0);
        const flat = bestScore;
        for (let degrees = -maxAngle; degrees <= maxAngle + 1e-9; degrees += 0.5) { const value = score(degrees); if (value > bestScore) { bestScore = value; best = degrees; } }
        for (let degrees = best - 0.4; degrees <= best + 0.4 + 1e-9; degrees += 0.1) { const value = score(degrees); if (value > bestScore) { bestScore = value; best = degrees; } }
        const angle = Math.round(best * 10) / 10;
        return { angle, sure: Math.abs(angle) >= LIMITS.skewMin && Math.abs(angle) < maxAngle - 0.05 && bestScore >= flat * LIMITS.skewGain };
    }

    // Dreht das Blatt um einen beliebigen Winkel (Grad, im Uhrzeigersinn). Nichts wird abgeschnitten: Das Ergebnis ist so groß,
    // dass das gedrehte Blatt ganz hineinpasst; die Ecken werden weiß.
    function rotate(canvas, degrees) {
        const rad = degrees * Math.PI / 180, sin = Math.abs(Math.sin(rad)), cos = Math.abs(Math.cos(rad));
        const out = makeCanvas(canvas.width * cos + canvas.height * sin, canvas.width * sin + canvas.height * cos);
        const ctx = context(out);
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, out.width, out.height);
        ctx.imageSmoothingQuality = 'high';
        ctx.translate(out.width / 2, out.height / 2);
        ctx.rotate(rad);
        ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
        return out;
    }
    // Rückt schief eingezogene Seiten gerade – nur wenn der Winkel sicher erkannt ist. { canvas, angle } (angle 0 = unverändert).
    function straighten(canvas, options) {
        const found = skew(canvas, options);
        return found.sure ? { canvas: rotate(canvas, -found.angle), angle: found.angle } : { canvas, angle: 0 };
    }
    // Vierteldrehungen im Uhrzeigersinn (1 = 90°, 2 = auf den Kopf, 3 = 270°).
    function turn(canvas, quarters) {
        const steps = ((Math.round(quarters) % 4) + 4) % 4;
        return steps ? rotate(canvas, steps * 90) : canvas;
    }

    // Ist die Seite leer (Rückseite, Trennblatt)? ink = Anteil dunkler Stellen im Inneren des Blatts – Lochung, Heftklammern und
    // dunkle Scanränder am Rand zählen nicht. Am besten auf dem bereits aufgehellten Blatt prüfen.
    function blank(canvas) {
        const { gray, width, height } = grayOf(canvas, 400);
        const left = Math.round(width * LIMITS.blankEdge), top = Math.round(height * LIMITS.blankEdge * 0.6);
        let dark = 0, count = 0;
        for (let y = top; y < height - top; y++) for (let x = left; x < width - left; x++, count++) if (gray[y * width + x] < 200) dark++;
        const ink = count ? dark / count : 0;
        return { blank: ink < LIMITS.blankInk, ink };
    }

    // ---------- Prüfen ----------
    // brightness = mittlere Helligkeit (0…255), contrast = ihre Streuung, sharpness = Varianz des Laplace-Filters
    // (auf einer Kopie mit höchstens 800 Bildpunkten). issues: [{ code, text }] – leer, wenn alles in Ordnung ist.
    function assess(canvas) {
        const { gray, width, height } = grayOf(canvas, 800);
        const count = gray.length, hist = new Float64Array(256);
        let sum = 0, squares = 0;
        for (let i = 0; i < count; i++) {
            sum += gray[i];
            squares += gray[i] * gray[i];
            hist[Math.round(gray[i])]++;
        }
        const brightness = sum / count, contrast = Math.sqrt(Math.max(0, squares / count - brightness * brightness));
        // Schärfe: Laplace-Filter. Zum Vergleich der Kontrast im Kleinen (Abstand zum Mittel der Umgebung) – Schatten und
        // der Tisch neben dem Blatt zählen dabei kaum, Schrift dagegen voll.
        const around = blur(gray, width, height, 5);
        let edgeSum = 0, edgeSquares = 0, inner = 0, detail = 0;
        for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++, inner++) {
                const i = y * width + x;
                const edge = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
                edgeSum += edge;
                edgeSquares += edge * edge;
                detail += (gray[i] - around[i]) ** 2;
            }
        }
        const sharpness = inner ? edgeSquares / inner - (edgeSum / inner) ** 2 : 0;
        // Papierhelligkeit = heller als 90 % aller Stellen; „Tinte“ = alles, was deutlich dunkler ist.
        let paper = 255, ink = 0;
        for (let seen = 0; paper > 0 && (seen += hist[paper]) < count * 0.1; paper--);
        for (let value = 0; value < paper * LIMITS.inkLevel; value++) ink += hist[value];

        const issues = [];
        const add = code => issues.push({ code, text: ISSUES[code] });
        if (brightness < LIMITS.dark) add('dunkel');
        else if (ink / count < LIMITS.inkShare) add(brightness > LIMITS.bright ? 'hell' : 'kontrast');
        if (inner && sharpness < LIMITS.sharpness * detail / inner) add('unscharf');
        if (Math.min(canvas.width, canvas.height) < LIMITS.minSide) add('klein');
        const round = value => Math.round(value * 10) / 10;
        return { brightness: round(brightness), contrast: round(contrast), sharpness: round(sharpness), issues };
    }

    // Füllt das Blatt das ganze Foto (nah fotografiert, kein Tisch zu sehen)? Dann ist am Bildrand ringsum dieselbe Papierfarbe
    // wie in der Mitte. Für ein Foto ohne erkanntes Blatt entscheidet das, ob es wie ein Scan aufbereitet wird.
    function fillsFrame(source) {
        const small = smallCopy(source, 160), { width, height } = small, planes = planesOf(small.pixels, width, height, 4);
        const mids = [[], [], []];
        for (let y = Math.floor(height * 0.35); y < height * 0.65; y += 2) for (let x = Math.floor(width * 0.35); x < width * 0.65; x += 2) for (let ch = 0; ch < 3; ch++) mids[ch].push(planes[ch][y * width + x]);
        const mid = mids.map(list => list.sort((a, b) => a - b)[list.length >> 1]), light = (mid[0] + mid[1] + mid[2]) / 3;
        if (light < 110) return false;
        let like = 0, count = 0;
        const edge = Math.max(2, Math.round(Math.min(width, height) * 0.04));
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                if (x >= edge && x < width - edge && y >= edge && y < height - edge) continue;
                const i = y * width + x, ratio = ((planes[0][i] + planes[1][i] + planes[2][i]) / 3 + 12) / (light + 12);
                count++;
                if (ratio >= 0.6 && ratio <= 1.5 && Math.abs(planes[0][i] / ratio - mid[0]) + Math.abs(planes[1][i] / ratio - mid[1]) + Math.abs(planes[2][i] / ratio - mid[2]) < 0.1 * (light + 12) * 3) like++;
            }
        }
        return like >= 0.9 * count;
    }

    // Alles in einem. options:
    //   maxSide   längere Seite des Ergebnisses (Standard 2000); loadSide = so groß wird das Foto dafür geladen (Standard 3000)
    //   crop      false = nicht zuschneiden
    //   corners   vier Ecken von Hand (Bildpunkte des geladenen Fotos, siehe original) – dann wird nicht gesucht
    //   mode      Aufbereitung (siehe enhance); ohne Angabe: 'auto' für ein Blatt, 'color' für ein Foto, auf dem kein Blatt erkannt ist
    //   quality   JPEG, 0…1
    // Zugeschnitten wird nur, wenn das Blatt sicher erkannt ist oder die Ecken von Hand kommen – sonst bleibt das ganze Foto.
    // Ergebnis: { canvas, blob, width, height, cropped, corners (die benutzten oder die vermuteten), confidence, open (Seiten am
    //             Bildrand), manual, mode, issues, original (das geladene Foto als Canvas – für „Ecken anpassen“) }
    async function process(file, options = {}) {
        // Das Foto wird größer geladen, als das Ergebnis wird: Das Blatt füllt selten das ganze Foto, und nach dem Geradeziehen
        // soll noch jede Zeile scharf sein.
        const original = options.original || await fromFile(file, { maxSide: options.loadSide || LIMITS.loadSide });
        const manual = Array.isArray(options.corners) && options.corners.length === 4;
        const found = manual || options.crop === false ? null : detect(original);
        const cropped = manual || Boolean(found && found.confidence >= LIMITS.confidence);
        const corners = manual ? options.corners.map(p => ({ x: p.x, y: p.y })) : found ? found.corners : null;
        const page = cropped ? warp(original, corners, options) : shrink(original, options.maxSide || 2000);
        // Ohne erkanntes Blatt: Nur wenn das Blatt das Foto füllt, wird es wie ein Scan aufbereitet. Sonst bliebe vom Tisch ein
        // heller, ausgewaschener Rest – dann lieber das Foto mit etwas mehr Kontrast, bis die Ecken gesetzt sind.
        const whole = !cropped && options.crop !== false && fillsFrame(original);
        const mode = options.mode || (cropped || whole || options.crop === false ? 'auto' : 'color');
        const canvas = enhance(page, { mode });
        // Ein schmaler Saum am Blattrand (Schlagschatten, ein Hauch Tisch) wird nach dem Aufbereiten zu einem farbigen Strich – weiß übermalen.
        if (cropped && mode !== 'color') {
            const ctx = context(canvas), edge = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * LIMITS.edgeClean));
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, edge); ctx.fillRect(0, canvas.height - edge, canvas.width, edge);
            ctx.fillRect(0, 0, edge, canvas.height); ctx.fillRect(canvas.width - edge, 0, edge, canvas.height);
        }
        const issues = assess(canvas).issues;
        // Ob das Foto zu dunkel oder überbelichtet war, sieht man nach dem Aufhellen nicht mehr – deshalb auch vorher prüfen.
        for (const issue of assess(page).issues) {
            if (['dunkel', 'hell'].includes(issue.code) && !issues.some(other => other.code === issue.code)) issues.unshift(issue);
        }
        if (!cropped && !whole && options.crop !== false) issues.push({ code: 'rand', text: ISSUES.rand });
        const blob = await toBlob(canvas, options.quality);
        return {
            canvas, blob, width: canvas.width, height: canvas.height, cropped, corners, manual, mode, whole,
            confidence: manual ? 1 : found ? found.confidence : 0, open: found && cropped ? found.open : 0, issues, original
        };
    }

    // Gibt den Speicher der großen Zwischenbilder sofort frei (canvas, original) – manche Handys räumen Canvas-Speicher erst spät
    // auf, und nach zwanzig Seiten wäre er sonst voll. keepOriginal: das geladene Foto wird noch gebraucht (neu zuschneiden).
    function release(result, { keepOriginal = false } = {}) {
        for (const key of keepOriginal ? ['canvas'] : ['canvas', 'original']) {
            const canvas = result && result[key];
            if (canvas && typeof canvas.getContext === 'function') { canvas.width = 0; canvas.height = 0; }
        }
    }

    // ---------- Platz sparen: die Seite als „Dokument“ mit 16 Tönen ----------
    // Eine aufbereitete Textseite besteht fast nur aus weißem Papier, schwarzer Schrift und ein wenig Farbe (Stempel, Unterschrift,
    // Textmarker). So eine Seite lässt sich mit 16 Tönen speichern – 6 Graustufen und bis zu 10 Tintenfarben dieser Seite – als PNG
    // mit Farbtabelle. Das braucht etwa ein Drittel des Platzes eines JPEG, und die Buchstaben sind schärfer (kein JPEG-Schleier).
    // Seiten mit Fotos, Farbflächen oder grauen Feldern eignen sich nicht: Dort meldet tones() fits = false und compact() null –
    // die Seite bleibt dann JPEG.
    const TONES = LIMITS.compact = {
        white: 230,             // ab dieser Helligkeit: rein weiß
        black: 25,              // bis zu dieser Helligkeit: rein schwarz
        chroma: 36,             // Farbabstand (0…255), ab dem ein Bildpunkt farbig ist …
        saturation: 0.25,       // … und so kräftig muss die Farbe mindestens sein (Anteil des hellsten Farbkanals)
        tintNear: 3,            // ein blasser Farbpunkt zählt nur mit so vielen Nachbarn derselben Farbfamilie (sonst: JPEG-Saum → Grau)
        colors: 10,             // höchstens so viele Tintenfarben je Seite (dazu kommen die 6 Graustufen)
        minShare: 0.00002,      // eine Farbe zählt erst ab diesem Anteil der Seite – sonst: verwandte Farbe oder Grau
        paleShare: 0.0003,      // eine blasse Farbe ohne kräftigen Strich derselben Familie erst ab diesem Anteil (Textmarker, blasser Stempel)
        mergeGap: 28,           // Farben, die sich um weniger unterscheiden (Abstand in RGB), teilen sich einen Platz der Farbtabelle
        joinGap: 70,            // eine seltene Farbe schließt sich einem Platz an, der höchstens so weit entfernt ist – sonst wird sie grau
        minSide: 1400,          // längere Seite darunter (A4 unter etwa 120 dpi): Die Schrift ist zu grob für nur 6 Graustufen
        midMax: 0.10,           // Seite als Ganzes: höchstens so viel Grau (weder weiß noch schwarz) – mehr heißt: unscharf oder getönt
        colorMax: 0.12,         // … so viel Farbe …
        blackMax: 0.35,         // … und so viel Schwarz
        block: 48,              // Kästchen: längere Seite / 48 (etwa 6 mm). Ein Kästchen ist keine Schrift, sondern …
        blockLight: 0.25,       // … ein Schatten oder eine getönte Fläche, wenn so viel davon hellgrau ist (Schrift: unter 10 %),
        blockFull: 0.85,        // … ein Foto oder ein graues Feld, wenn so viel davon nicht weiß ist …
        blockTone: 0.2,         //     … und mindestens so viel davon Grau oder Farbe (ein rein schwarzer Balken ist kein Foto)
        blocksMax: 2            // mehr solche Kästchen als das: Die Seite eignet sich nicht
    };
    const GRAY_TONES = [255, 204, 153, 102, 51, 0];
    // Tintenfarben: je Farbfamilie (Farbwinkel bis … Grad) drei Stufen – dunkel, mittel, hell. Die Mustertöne dienen nur zum Einordnen:
    // Gespeichert wird der Mittelwert der Bildpunkte der Seite, die einem Musterton am nächsten sind – das Blau des Stempels bleibt sein Blau.
    const INK_TONES = [
        { until: 15, tones: [[150, 25, 35], [215, 60, 65], [245, 165, 165]] },        // Rot
        { until: 42, tones: [[165, 80, 20], [240, 150, 50], [250, 200, 150]] },       // Orange, Braun
        { until: 70, tones: [[165, 135, 20], [250, 220, 70], [255, 242, 150]] },      // Gelb (Textmarker)
        { until: 165, tones: [[20, 100, 50], [60, 165, 90], [160, 222, 172]] },       // Grün
        { until: 200, tones: [[15, 100, 115], [40, 160, 180], [160, 220, 230]] },     // Blaugrün
        { until: 255, tones: [[25, 40, 125], [60, 90, 195], [160, 180, 240]] },       // Blau (Kugelschreiber, Stempel)
        { until: 295, tones: [[75, 35, 130], [130, 80, 190], [200, 170, 238]] },      // Violett (Stempel)
        { until: 345, tones: [[140, 25, 95], [215, 70, 150], [245, 170, 210]] }       // Pink – darüber wieder Rot
    ];
    const GRAYS = GRAY_TONES.length;
    const grayTone = light => light >= TONES.white ? 0 : light <= TONES.black ? GRAYS - 1 : Math.min(GRAYS - 2, Math.max(1, GRAYS - 1 - Math.round(light / 51)));
    // Ton eines Bildpunkts: 0 … 5 = Graustufe (weiß … schwarz), ab 6 = Tintenfarbe (6 + Familie · 3 + Stufe).
    function toneOf(r, g, b) {
        const high = Math.max(r, g, b), low = Math.min(r, g, b), chroma = high - low;
        if (chroma < TONES.chroma || chroma < TONES.saturation * high) return grayTone(luma(r, g, b));
        let hue = high === r ? (g - b) / chroma : high === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
        hue = (hue * 60 + 360) % 360;
        let family = INK_TONES.findIndex(ink => hue < ink.until);
        if (family < 0) family = 0;                                                    // über 345°: Rot
        let step = 0, nearest = Infinity;
        INK_TONES[family].tones.forEach((tone, at) => {
            const gap = (r - tone[0]) ** 2 + (g - tone[1]) ** 2 + (b - tone[2]) ** 2;
            if (gap < nearest) { nearest = gap; step = at; }
        });
        return GRAYS + family * 3 + step;
    }
    // Nachschlagetabelle: je Farbkanal 5 Bit (32 768 Einträge) – wird beim ersten Gebrauch gefüllt.
    let toneTable = null;
    function toneLookup() {
        if (!toneTable) {
            toneTable = new Uint8Array(32768);
            for (let r = 0; r < 32; r++) for (let g = 0; g < 32; g++) for (let b = 0; b < 32; b++) toneTable[(r << 10) | (g << 5) | b] = toneOf(r * 8 + 4, g * 8 + 4, b * 8 + 4);
        }
        return toneTable;
    }

    // Zerlegt die Seite in ihre Töne. pixels: RGBA (wie getImageData). Ergebnis:
    //   index     je Bildpunkt ein Eintrag der Farbtabelle        palette   die Farbtabelle der Seite: [[r, g, b], …] (6 … 16 Einträge)
    //   mid / color / black   Anteile der Seite (Grau, Farbe, Schwarz)       dense   Zahl der Kästchen, die keine Schrift sind (Schatten, Foto)
    //   fits      true: Die Seite ist ein Textdokument und kann so gespeichert werden.
    function tones(pixels, width, height) {
        const table = toneLookup(), count = width * height, kinds = GRAYS + INK_TONES.length * 3, families = INK_TONES.length;
        const index = new Uint8Array(count), seen = new Float64Array(kinds), sums = new Float64Array(kinds * 3);
        // 1. Jeder Bildpunkt bekommt seinen Ton.
        for (let i = 0, p = 0; i < count; i++, p += 4) {
            const tone = table[((pixels[p] >> 3) << 10) | ((pixels[p + 1] >> 3) << 5) | (pixels[p + 2] >> 3)];
            index[i] = tone;
            seen[tone]++;
            if (tone >= GRAYS) { const s = tone * 3; sums[s] += pixels[p]; sums[s + 1] += pixels[p + 1]; sums[s + 2] += pixels[p + 2]; }
        }
        const grayAt = i => grayTone(luma(pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]));
        // 2. Blasse Farbpunkte ohne Anschluss sind keine Tinte, sondern der Farbsaum, den JPEG um kräftige Striche legt (gelblich neben
        //    Blau, grünlich neben Rot). Ein blasser Punkt bleibt nur farbig, wenn genug Nachbarn zur selben oder zur benachbarten
        //    Farbfamilie gehören – der Rand eines Stempels, eine Textmarker-Fläche. Die anderen werden grau. Wiederholt, bis sich
        //    nichts mehr ändert.
        {
            const familyOf = tone => tone < GRAYS ? -9 : ((tone - GRAYS) / 3) | 0;
            let pale = [], paleCount = 0;
            for (let tone = GRAYS + 2; tone < kinds; tone += 3) paleCount += seen[tone];
            // Eine Seite voller blasser Farbe (farbiges Papier, große Farbfläche) eignet sich ohnehin nicht – dann nicht erst suchen.
            if (paleCount <= count * TONES.colorMax) for (let i = 0; i < count; i++) if (index[i] >= GRAYS && (index[i] - GRAYS) % 3 === 2) pale.push(i);
            for (let changed = true; changed && pale.length;) {
                const drop = [], keep = [];
                for (const i of pale) {
                    const family = familyOf(index[i]), x = i % width, y = (i - x) / width;
                    let near = 0;
                    for (let dy = -1; dy <= 1; dy++) {
                        const ny = y + dy;
                        if (ny < 0 || ny >= height) continue;
                        for (let dx = -1; dx <= 1; dx++) {
                            const nx = x + dx;
                            if (!(dx || dy) || nx < 0 || nx >= width) continue;
                            const gap = Math.abs(familyOf(index[ny * width + nx]) - family);
                            if (gap <= 1 || gap === families - 1) near++;
                        }
                    }
                    (near < TONES.tintNear ? drop : keep).push(i);
                }
                for (const i of drop) {
                    const tone = index[i], p = i * 4, gray = grayAt(i);
                    seen[tone]--; sums[tone * 3] -= pixels[p]; sums[tone * 3 + 1] -= pixels[p + 1]; sums[tone * 3 + 2] -= pixels[p + 2];
                    index[i] = gray; seen[gray]++;
                }
                changed = drop.length > 0;
                pale = keep;
            }
        }
        // 3. Die Farbtabelle der Seite: Die häufigsten Tintenfarben bekommen einen Platz – mit ihrem Mittelwert auf dieser Seite.
        //    Fast gleiche Farben teilen sich einen Platz (eine Tinte, deren Farbwinkel auf der Grenze zweier Familien liegt).
        //    Seltene Farben schließen sich einem ähnlichen Platz an; gibt es keinen, werden ihre Bildpunkte grau.
        const inkMin = Math.max(12, count * TONES.minShare), paleMin = Math.max(12, count * TONES.paleShare);
        const place = new Int16Array(kinds).fill(-1), slots = [];
        for (let tone = 0; tone < GRAYS; tone++) place[tone] = tone;
        const order = [];
        for (let tone = GRAYS; tone < kinds; tone++) if (seen[tone] > 0) order.push(tone);
        order.sort((a, b) => seen[b] - seen[a] || a - b);
        for (const tone of order) {
            const first = tone - (tone - GRAYS) % 3, pale = tone - first === 2, n = seen[tone];
            const r = sums[tone * 3] / n, g = sums[tone * 3 + 1] / n, b = sums[tone * 3 + 2] / n;
            // Blasses allein (ohne dunklen oder mittleren Strich derselben Familie) ist meist nur ein Rest von JPEG-Saum.
            const counts = n >= (pale && seen[first] < inkMin && seen[first + 1] < inkMin ? paleMin : inkMin);
            let best = null, gap = Infinity;
            for (const slot of slots) {
                const d = (r - slot.r / slot.n) ** 2 + (g - slot.g / slot.n) ** 2 + (b - slot.b / slot.n) ** 2;
                if (d < gap) { gap = d; best = slot; }
            }
            if (!(best && gap < TONES.mergeGap ** 2) && counts && slots.length < TONES.colors) { best = { first: tone, tones: [], n: 0, r: 0, g: 0, b: 0 }; slots.push(best); }
            else if (!(best && gap < TONES.joinGap ** 2)) continue;                    // kein Platz, nichts Ähnliches: wird grau
            best.tones.push(tone); best.n += n; best.r += sums[tone * 3]; best.g += sums[tone * 3 + 1]; best.b += sums[tone * 3 + 2];
        }
        const palette = GRAY_TONES.map(value => [value, value, value]);
        slots.sort((a, b) => a.first - b.first).forEach(slot => {
            slot.tones.forEach(tone => { place[tone] = palette.length; });
            palette.push([Math.round(slot.r / slot.n), Math.round(slot.g / slot.n), Math.round(slot.b / slot.n)]);
        });
        // 4. Endgültige Einträge – und dabei zählen: für die Seite und je Kästchen (hellgrau · Grau und Farbe zusammen · schwarz).
        const size = Math.max(8, Math.round(Math.max(width, height) / TONES.block)), across = Math.ceil(width / size), down = Math.ceil(height / size);
        const lights = new Uint32Array(across * down), mids = new Uint32Array(across * down), darks = new Uint32Array(across * down);
        const totals = new Float64Array(palette.length);
        for (let y = 0, i = 0; y < height; y++) {
            const rowAt = ((y / size) | 0) * across;
            for (let x = 0; x < width; x++, i++) {
                let tone = place[index[i]];
                if (tone < 0) tone = grayAt(i);
                index[i] = tone;
                totals[tone]++;
                if (tone === 0) continue;
                const block = rowAt + ((x / size) | 0);
                if (tone === GRAYS - 1) darks[block]++;
                else { mids[block]++; if (tone === 1) lights[block]++; }
            }
        }
        let mid = 0, color = 0, dense = 0;
        for (let tone = 1; tone < palette.length; tone++) if (tone >= GRAYS) color += totals[tone]; else if (tone < GRAYS - 1) mid += totals[tone];
        for (let by = 0; by < down; by++) {
            const tall = Math.min(size, height - by * size);
            for (let bx = 0; bx < across; bx++) {
                const block = by * across + bx, area = tall * Math.min(size, width - bx * size);
                if (lights[block] >= TONES.blockLight * area || (mids[block] + darks[block] >= TONES.blockFull * area && mids[block] >= TONES.blockTone * area)) dense++;
            }
        }
        mid /= count; color /= count;
        const black = totals[GRAYS - 1] / count;
        const fits = Math.max(width, height) >= TONES.minSide && mid <= TONES.midMax && color <= TONES.colorMax && black <= TONES.blackMax && dense <= TONES.blocksMax;
        return { index, palette, mid, color, black, dense, fits };
    }

    // PNG mit Farbtabelle (4 Bit je Bildpunkt, ohne Zeilenfilter – für Tabellenbilder die beste Wahl). Ergebnis: Uint8Array.
    const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } return table; })();
    function crc32(bytes, start, end) {
        let c = 0xFFFFFFFF;
        for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }
    async function tonesPng(index, width, height, palette) {
        const rowBytes = Math.ceil(width / 2), raw = new Uint8Array((rowBytes + 1) * height);
        for (let y = 0, at = 0; y < height; y++) {
            at++;                                                                      // Zeilenfilter 0
            const row = y * width;
            for (let x = 0; x < width; x += 2) raw[at++] = (index[row + x] << 4) | (x + 1 < width ? index[row + x + 1] : 0);
        }
        const packed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
        const chunk = (type, body) => {
            const out = new Uint8Array(12 + body.length), view = new DataView(out.buffer);
            view.setUint32(0, body.length);
            for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k);
            out.set(body, 8);
            view.setUint32(8 + body.length, crc32(out, 4, 8 + body.length));
            return out;
        };
        const head = new Uint8Array(13), view = new DataView(head.buffer);
        view.setUint32(0, width); view.setUint32(4, height);
        head[8] = 4; head[9] = 3;                                                      // 4 Bit, Farbtabelle
        const colors = new Uint8Array(palette.length * 3);
        palette.forEach((tone, at) => colors.set(tone, at * 3));
        const parts = [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', head), chunk('PLTE', colors), chunk('IDAT', packed), chunk('IEND', new Uint8Array(0))];
        const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
        let at = 0;
        for (const part of parts) { out.set(part, at); at += part.length; }
        return out;
    }

    // Die Seite Platz sparend speichern: PNG-Blob – oder null, wenn sie sich nicht eignet (Foto, Farbfläche, graue Felder) oder der
    // Browser das Packen nicht kann. Dann bleibt es beim JPEG. Löst nie einen Fehler aus.
    async function compact(canvas) {
        try {
            if (typeof CompressionStream !== 'function' || !canvas?.width || !canvas?.height) return null;
            const { width, height } = canvas;
            const found = tones(context(canvas).getImageData(0, 0, width, height).data, width, height);
            if (!found.fits) return null;
            return new Blob([await tonesPng(found.index, width, height, found.palette)], { type: 'image/png' });
        } catch (error) {
            return null;
        }
    }

    // ---------- Seitenzähler ----------
    const COUNTERS = [
        /(?<![\p{L}\d])(?:seite|blatt|page|s\.)\s*:?\s*([1-9]\d?)\s*(?:von|of|\/)\s*([1-9]\d?)(?!\d|[.\/]\d)/giu,     // „Seite 2 von 3“, „S. 2 / 3“
        /^[ \t]*([1-9]\d?)[ \t]*(?:\/|von|of)[ \t]*([1-9]\d?)[ \t]*$/gimu,                                               // „2/3“ allein in einer Zeile
        /^[ \t]*[-–—][ \t]*([1-9]\d?)[ \t]*[-–—][ \t]*$/gmu                                                             // „- 2 -“ (Gesamtzahl unbekannt)
    ];

    // Sucht den Seitenzähler im erkannten Text einer Seite: { page, total } – total ist null, wenn nur die Seitenzahl dasteht.
    // Ein Datum (02/03/2026) oder ein Bruch in einer längeren Zahl zählt nicht; es gilt 1 ≤ page ≤ total ≤ 50.
    function pageInfo(text) {
        const source = String(text ?? '').replace(/\r\n?/g, '\n');
        for (const pattern of COUNTERS) {
            for (const match of source.matchAll(pattern)) {
                const page = Number(match[1]), total = match[2] === undefined ? null : Number(match[2]);
                if (page <= (total ?? 50) && (total ?? 1) <= 50) return { page, total };
            }
        }
        return null;
    }

    // Was fehlt im Stapel? texts = erkannter Text je fotografierter Seite, in der Reihenfolge der Fotos.
    // Seiten mit derselben Gesamtzahl gehören zusammen, z. B. → ['Seite 2 von 3 fehlt.'] oder ['Seite 1 von 2 wurde doppelt fotografiert.'].
    function missingPages(texts) {
        const groups = new Map();      // Gesamtzahl → gefundene Seitenzahlen
        for (const text of texts || []) {
            const info = pageInfo(text);
            if (!info) continue;
            if (!groups.has(info.total)) groups.set(info.total, []);
            groups.get(info.total).push(info.page);
        }
        const list = pages => pages.length > 1 ? `Seiten ${pages.slice(0, -1).join(', ')} und ${pages[pages.length - 1]}` : `Seite ${pages[0]}`;
        const messages = [];
        for (const [total, pages] of groups) {
            const of = total ? ` von ${total}` : '';
            const missing = [], twice = [];
            // Ohne Gesamtzahl („- 2 -“) lassen sich nur Lücken zwischen der kleinsten und der größten Seitenzahl erkennen.
            for (let page = total ? 1 : Math.min(...pages); page <= (total || Math.max(...pages)); page++) {
                const count = pages.filter(other => other === page).length;
                if (!count) missing.push(page);
                if (count > 1) twice.push(page);
            }
            if (twice.length) messages.push(`${list(twice)}${of} ${twice.length > 1 ? 'wurden' : 'wurde'} doppelt fotografiert.`);
            if (missing.length) messages.push(`${list(missing)}${of} ${missing.length > 1 ? 'fehlen' : 'fehlt'}.`);
        }
        return messages;
    }

    return { fromFile, detect, findSheet, warp, enhance, assess, toBlob, process, release, pageInfo, missingPages, skew, rotate, straighten, turn, blank, tones, tonesPng, compact, LIMITS };
})();
if (typeof window !== 'undefined') window.DocScan = DocScan;
if (typeof module !== 'undefined') module.exports = DocScan;
