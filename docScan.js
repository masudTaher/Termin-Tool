// Macht aus dem Handyfoto eines Papierdokuments (Arztbrief, Rezept, Überweisung) ein gerades, gut lesbares Blatt –
// direkt auf dem Gerät und nur mit Canvas 2D: Das Foto wird dafür nirgends hingeschickt.
//   DocScan.process()       alles in einem: laden → Blatt finden → gerade ziehen → aufhellen → prüfen → JPEG
//   DocScan.fromFile()      Foto laden (Drehung laut EXIF), längere Seite höchstens maxSide
//   DocScan.detect()        die vier Ecken des Blatts finden – oder null, wenn kein Blatt sicher zu erkennen ist
//   DocScan.warp()          das Blatt gerade ziehen (Perspektive)
//   DocScan.enhance()       Schatten entfernen und Kontrast anheben: 'auto' | 'color' | 'gray' | 'bw'
//   DocScan.assess()        Helligkeit, Kontrast, Schärfe und Hinweise auf Deutsch
//   DocScan.pageInfo()      Seitenzähler im erkannten Text („Seite 2 von 3“)
//   DocScan.missingPages()  fehlende oder doppelt fotografierte Seiten (beide Seitenzähler-Funktionen brauchen kein DOM)
//   DocScan.LIMITS          alle Schwellen an einer Stelle
// Das Ergebnis ist immer nur ein Vorschlag: „original“ bleibt erhalten, damit die Oberfläche „Original verwenden“ anbieten kann.
const DocScan = (() => {
    // Schwellen – hier lässt sich alles nachstellen (abgestimmt mit pwtest/t_docscan.js).
    const LIMITS = {
        confidence: 0.6,        // ab dieser Sicherheit schneidet process() das Blatt aus
        detectSide: 256,        // längere Seite der kleinen Kopie für die Blattsuche
        areaMin: 0.12,          // Anteil des Blatts am Foto: mindestens …
        areaMax: 0.97,          // … und höchstens (sonst füllt das Blatt das Foto ohnehin)
        fillMin: 0.75,          // gefundene Fläche / Fläche des Vierecks
        angleMin: 45,           // Winkel an den Ecken in Grad
        angleMax: 135,
        paperLead: 0.04,        // um diesen Anteil muss das Blatt an jeder Seite heller sein als seine Umgebung
        inset: 0.5,             // der Zuschnitt liegt knapp innerhalb der Blattkante (in Punkten der kleinen Kopie)
        edgeDrop: 0.06,         // Suche über Kanten: Kante ist, was um diesen Anteil dunkler ist als der hellste Nachbar
        dark: 90,               // mittlere Helligkeit darunter → „dunkel“
        inkLevel: 0.75,         // „Schrift“ ist, was dunkler als 75 % der Papierhelligkeit ist
        inkShare: 0.0005,       // Anteil solcher Stellen darunter: Die Schrift ist kaum zu sehen → „hell“ oder „kontrast“
        bright: 200,            // … „hell“ (überbelichtet), wenn die mittlere Helligkeit darüber liegt, sonst „kontrast“
        sharpness: 0.25,        // Schärfe geteilt durch den Kontrast im Kleinen darunter → „unscharf“
        minSide: 700,           // kürzere Seite in Bildpunkten darunter → „klein“
        maxGain: 2,             // so stark werden Schatten höchstens aufgehellt
        bwLevel: 0.78           // 'bw': schwarz ist, was dunkler als 78 % des Papiers an dieser Stelle ist
    };
    const ISSUES = {
        dunkel: 'Das Foto ist zu dunkel. Bitte mit mehr Licht noch einmal aufnehmen.',
        hell: 'Das Foto ist überbelichtet oder spiegelt. Bitte ohne Blitz noch einmal aufnehmen.',
        unscharf: 'Das Foto ist unscharf. Bitte ruhig halten und noch einmal aufnehmen.',
        klein: 'Das Foto ist sehr klein. Bitte näher herangehen.',
        kontrast: 'Die Schrift ist kaum zu erkennen. Bitte bei besserem Licht aufnehmen.'
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
    // Füllt zusammenhängende Flächen einer Maske: fill(Start, Nummer, Wert) liefert die Größe, centre danach den Anteil in der Bildmitte.
    function flooder(mask, width, height) {
        const labels = new Int32Array(mask.length), stack = new Int32Array(mask.length), last = mask.length - width;
        const left = width >> 2, right = width - left, top = (height >> 2) * width, bottom = (height - (height >> 2)) * width;
        const region = { labels, centre: 0 };
        region.fill = (start, label, want) => {
            let size = 0, count = 0, centre = 0;
            stack[size++] = start;
            labels[start] = label;
            while (size) {
                const i = stack[--size], x = i % width;
                count++;
                if (x >= left && x < right && i >= top && i < bottom) centre++;
                if (x > 0 && !labels[i - 1] && mask[i - 1] === want) { labels[i - 1] = label; stack[size++] = i - 1; }
                if (x < width - 1 && !labels[i + 1] && mask[i + 1] === want) { labels[i + 1] = label; stack[size++] = i + 1; }
                if (i >= width && !labels[i - width] && mask[i - width] === want) { labels[i - width] = label; stack[size++] = i - width; }
                if (i < last && !labels[i + width] && mask[i + width] === want) { labels[i + width] = label; stack[size++] = i + width; }
            }
            region.centre = centre;
            return count;
        };
        return region;
    }

    // 1 für alles, was vom Bildrand aus nicht erreichbar ist, ohne die Maske zu überqueren: die Maske samt ihrer Löcher.
    function enclosed(mask, width, height) {
        const { labels, fill } = flooder(mask, width, height);
        const seed = i => { if (!mask[i] && !labels[i]) fill(i, 1, 0); };
        for (let x = 0; x < width; x++) { seed(x); seed(mask.length - 1 - x); }
        for (let y = 0; y < height; y++) { seed(y * width); seed(y * width + width - 1); }
        return labels.map(label => label ? 0 : 1);
    }

    // Die größte zusammenhängende Fläche der Maske, die auch in der Bildmitte liegt (oder null).
    function mainRegion(mask, width, height) {
        const region = flooder(mask, width, height), centreMin = 0.05 * (width >> 1) * (height >> 1);
        let best = 0, bestCount = 0;
        for (let i = 0, label = 0; i < mask.length; i++) {
            if (!mask[i] || region.labels[i]) continue;
            const count = region.fill(i, ++label, 1);
            if (region.centre >= centreMin && count > bestCount) { best = label; bestCount = count; }
        }
        return best ? region.labels.map(label => label === best ? 1 : 0) : null;
    }

    // Konvexe Hülle (Andrew). Die Punkte müssen nach y und bei gleichem y nach x geordnet sein.
    function hull(points) {
        const half = list => {
            const out = [];
            for (const p of list) {
                while (out.length >= 2) {
                    const a = out[out.length - 2], b = out[out.length - 1];
                    if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) > 0) break;
                    out.pop();
                }
                out.push(p);
            }
            out.pop();
            return out;
        };
        return half(points).concat(half(points.slice().reverse()));
    }

    // Schnittpunkt der Geraden a→b und d→c – nur, wenn er hinter b und hinter c liegt (die Kante b–c fällt dann weg).
    function meet(a, b, c, d) {
        const rx = b.x - a.x, ry = b.y - a.y, sx = c.x - d.x, sy = c.y - d.y;
        const den = rx * sy - ry * sx;
        if (Math.abs(den) < 1e-9) return null;
        const t = ((d.x - a.x) * sy - (d.y - a.y) * sx) / den;
        const u = ((d.x - a.x) * ry - (d.y - a.y) * rx) / den;
        return t >= 1 && u >= 1 ? { x: a.x + t * rx, y: a.y + t * ry } : null;
    }

    // Macht aus der Hülle ein Viereck: Es fällt immer die Kante weg, deren Nachbarn verlängert am wenigsten Fläche hinzufügen.
    // So bleiben die vier langen Seiten übrig, und abgerundete oder umgeknickte Ecken werden ergänzt.
    function toQuad(points) {
        const pts = points.slice();
        while (pts.length > 4) {
            const n = pts.length;
            let best = null;
            for (let i = 0; i < n; i++) {
                const b = pts[i], c = pts[(i + 1) % n];
                const p = meet(pts[(i + n - 1) % n], b, c, pts[(i + 2) % n]);
                if (!p) continue;
                const added = Math.abs((p.x - b.x) * (c.y - b.y) - (p.y - b.y) * (c.x - b.x));
                if (!best || added < best.added) best = { i, p, added };
            }
            if (!best) return null;
            pts[best.i] = best.p;
            pts.splice((best.i + 1) % n, 1);
        }
        return pts.length === 4 ? pts : null;
    }

    // Viereck um die Fläche: je Zeile der erste und der letzte Punkt → Hülle → vier Seiten. area = Größe der Fläche.
    function quadOf(inside, width, height) {
        const points = [];
        let area = 0;
        for (let y = 0; y < height; y++) {
            let first = -1, last = -1;
            for (let x = 0; x < width; x++) {
                if (!inside[y * width + x]) continue;
                if (first < 0) first = x;
                last = x;
                area++;
            }
            if (first >= 0) points.push({ x: first + 0.5, y: y + 0.5 }, { x: last + 0.5, y: y + 0.5 });
        }
        const quad = points.length >= 6 ? toQuad(hull(points)) : null;
        return quad ? { quad, area } : null;
    }

    // Ausgleichsgerade durch Punkte: Schwerpunkt und Hauptrichtung – oder null, wenn es weniger als acht Punkte sind.
    function fitLine(points) {
        const n = points.length;
        let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
        for (const p of points) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y; }
        const angle = Math.atan2(2 * (sxy / n - sx * sy / (n * n)), sxx / n - (sx / n) ** 2 - syy / n + (sy / n) ** 2) / 2;
        return n < 8 ? null : { x: sx / n, y: sy / n, dx: Math.cos(angle), dy: Math.sin(angle) };
    }

    // Schiebt jede Seite auf die Blattkante in ihrer Nähe (innen heller als außen), legt eine Ausgleichsgerade durch
    // diese Punkte und schneidet benachbarte Geraden: Die Ecken werden genauer als ein Bildpunkt der kleinen Kopie.
    function refine(corners, gray, width, height) {
        const at = (x, y) => {      // Helligkeit zwischen den Bildpunkten (bilinear)
            const fx = Math.min(width - 1.001, Math.max(0, x - 0.5)), fy = Math.min(height - 1.001, Math.max(0, y - 0.5));
            const i = (fy | 0) * width + (fx | 0), ax = fx - (fx | 0), ay = fy - (fy | 0);
            const top = gray[i] + (gray[i + 1] - gray[i]) * ax, bottom = gray[i + width] + (gray[i + width + 1] - gray[i + width]) * ax;
            return top + (bottom - top) * ay;
        };
        const lines = corners.map((a, index) => {
            const b = corners[(index + 1) % 4], dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
            const nx = dy / length, ny = -dx / length;                              // zeigt nach außen
            const points = [];
            for (let t = 0.1; t < 0.91; t += 0.04) {
                const steps = [];
                for (let offset = -3; offset <= 1.5; offset += 0.25) {
                    const x = a.x + dx * t + nx * offset, y = a.y + dy * t + ny * offset;
                    const inner = at(x - nx, y - ny), step = inner - at(x + nx, y + ny);
                    steps.push(step >= LIMITS.paperLead * (inner + 16) ? step : 0);      // nur deutliche Sprünge zählen
                }
                // Von innen her die erste deutliche Kante: Was weiter außen liegt (Muster der Tischdecke, Rand eines Geräts), gehört
                // zum Untergrund – auch wenn es stärker ist. to = Ende ihres Gipfels, from = sein Anfang; die Kante liegt in der Mitte.
                const to = steps.findIndex((step, i) => step > 0 && !(steps[i + 1] >= step - 0.5));
                if (to < 0) continue;
                let from = to;
                while (from > 0 && steps[from - 1] > steps[to] - 0.5) from--;
                const offset = (from + to) / 8 - 3;
                points.push({ x: a.x + dx * t + nx * offset, y: a.y + dy * t + ny * offset });
            }
            // Zweimal anpassen: beim zweiten Mal ohne Ausreißer (ein Finger auf der Kante, Schrift dicht am Rand).
            let line = fitLine(points);
            if (line) line = fitLine(points.filter(p => Math.abs((p.x - line.x) * line.dy - (p.y - line.y) * line.dx) <= 1)) || line;
            return line ? { ...line, x: line.x - nx * LIMITS.inset, y: line.y - ny * LIMITS.inset } : { x: a.x, y: a.y, dx, dy };
        });
        return lines.map((line, i) => {
            const before = lines[(i + 3) % 4], den = before.dx * line.dy - before.dy * line.dx;
            if (Math.abs(den) < 1e-9) return corners[i];
            const t = ((line.x - before.x) * line.dy - (line.y - before.y) * line.dx) / den;
            return { x: before.x + t * before.dx, y: before.y + t * before.dy };
        });
    }

    // Ecken im Uhrzeigersinn, beginnend oben links.
    function order(quad) {
        const cx = quad.reduce((sum, p) => sum + p.x, 0) / 4, cy = quad.reduce((sum, p) => sum + p.y, 0) / 4;
        const turn = quad.slice().sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
        let first = 0;
        turn.forEach((p, index) => { if (p.x + p.y < turn[first].x + turn[first].y) first = index; });
        return turn.slice(first).concat(turn.slice(0, first));
    }

    // Kanten: 1, wo ein Punkt deutlich dunkler ist als der hellste in seiner Nähe – im Verhältnis gemessen, damit die Blattkante
    // im Schatten genauso zählt wie im Licht. Um ein Blatt auf hellem Tisch entsteht so ein geschlossener Ring.
    function edges(gray, width, height) {
        const top = spread(gray, width, height, 2, Math.max);
        return gray.map((value, i) => top[i] - value > LIMITS.edgeDrop * top[i] ? 1 : 0);
    }

    const areaOf = quad => Math.abs(quad.reduce((sum, p, i) => sum + p.x * quad[(i + 1) % 4].y - quad[(i + 1) % 4].x * p.y, 0)) / 2;

    // Wie sicher ist das Viereck ein Blatt? 0 = unplausibel. Zählt: Anteil am Foto, Winkel, Füllung, heller als die Umgebung.
    // fill = gefundene Fläche / Fläche des Vierecks um sie herum, gray = Helligkeit der kleinen Kopie.
    function rate(corners, fill, gray, width, height) {
        let worst = 0;
        for (let i = 0; i < 4; i++) {
            const a = corners[(i + 3) % 4], b = corners[i], c = corners[(i + 1) % 4];
            const ux = a.x - b.x, uy = a.y - b.y, vx = c.x - b.x, vy = c.y - b.y;
            if (vx * uy - vy * ux <= 0) return 0;                                    // nicht konvex
            const angle = Math.acos((ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy))) * 180 / Math.PI;
            if (angle < LIMITS.angleMin || angle > LIMITS.angleMax) return 0;
            worst = Math.max(worst, Math.abs(angle - 90));
        }
        const share = areaOf(corners) / (width * height);
        if (share < LIMITS.areaMin || share > LIMITS.areaMax || fill < LIMITS.fillMin) return 0;
        // Helligkeitssprung an jeder Seite (als Anteil): knapp innen gegen knapp außen. Ein Blatt hat eine scharfe Kante, ein Lichtfleck
        // auf dem Tisch nicht. Es gilt die schwächste Seite. Eine Seite am Bildrand ist keine Blattkante (das Blatt ist dort
        // abgeschnitten, die Ecken sind nicht die echten) und kostet deshalb Sicherheit.
        const at = (x, y) => x < 0 || y < 0 || x >= width || y >= height ? -1 : gray[(y | 0) * width + (x | 0)];
        let lead = Infinity, free = 0;
        for (let i = 0; i < 4; i++) {
            const a = corners[i], b = corners[(i + 1) % 4], length = Math.hypot(b.x - a.x, b.y - a.y);
            const nx = (b.y - a.y) / length * 2, ny = (a.x - b.x) / length * 2;      // zwei Punkte nach außen
            let step = 0, count = 0, clear = 0;
            for (let t = 0.15; t < 0.86; t += 0.05) {
                const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, outer = at(x + nx, y + ny), inner = at(x - nx, y - ny);
                if (outer < 0 || inner < 0) continue;
                step += (inner - outer) / (inner + 16);
                count++;
                if (inner - outer > LIMITS.paperLead / 2 * (inner + 16)) clear++;
            }
            if (count < 8) continue;
            if (clear < 0.8 * count) return 0;                                       // die Seite folgt nicht durchgehend einer Kante
            free++;
            lead = Math.min(lead, step / count);
        }
        if (free < 2 || lead < LIMITS.paperLead) return 0;
        return (0.7 + 0.3 * ramp(share, LIMITS.areaMin, 0.2)) * (0.4 + 0.6 * ramp(fill, LIMITS.fillMin, 0.995))
            * (1 - 0.5 * ramp(worst, 15, 45)) * (0.55 + 0.45 * ramp(lead, LIMITS.paperLead, 0.2)) * 0.55 ** (4 - free);
    }

    // Sucht das Blatt auf einer kleinen Kopie – zuerst im schwächsten Farbkanal (Papier ist hell und farblos, farbiger Untergrund
    // wird dort dunkel), dann in der Helligkeit (bei gelbem Lampenlicht ist auch Papier im Blau schwach).
    // Ergebnis: { corners: [oben links, oben rechts, unten rechts, unten links], confidence: 0…1 } oder null.
    function detect(canvas) {
        let found = null, first = null;
        const sure = () => found && found.confidence >= 0.95;      // darunter werden alle Versuche verglichen, der sicherste gilt
        for (const mix of [Math.min, luma]) {
            if (sure()) break;
            const { gray, width, height } = grayOf(canvas, LIMITS.detectSide, mix);
            // Ein Foto fast ohne Farbe sieht in der Helligkeit aus wie im schwächsten Kanal – dann genügt der erste Durchgang.
            if (first && gray.reduce((sum, value, i) => sum + value - first[i], 0) < 6 * gray.length) break;
            first = gray;
            const soft = blur(gray, width, height, 1);
            const attempt = mask => {
                // Löcher füllen (Schrift), dann dünne Anhängsel abtrennen (Schattenrand, Kabel, helle Fuge): die Fläche um zwei Punkte
                // schrumpfen und wieder wachsen lassen. Der Mittelwert über 5 × 5 Punkte ist 1, wenn alle dazugehören, und 0, wenn keiner.
                const core = blur(enclosed(mask, width, height), width, height, 2).map(value => value > 0.99 ? 1 : 0);
                const inside = mainRegion(blur(core, width, height, 2).map(value => value > 0.01 ? 1 : 0), width, height);
                const shape = inside && quadOf(inside, width, height);
                if (!shape) return;
                const corners = order(refine(order(shape.quad), soft, width, height));
                const confidence = rate(corners, shape.area / areaOf(shape.quad), soft, width, height);
                if (confidence > (found ? found.confidence + 0.03 : 0)) found = { confidence, corners: corners.map(p => ({ x: p.x / width, y: p.y / height })) };
            };
            // Drei Versuche, bis einer ganz sicher ist: die helle Fläche (Schwelle nach Otsu); dieselbe Suche nur im helleren Teil
            // (heller Tisch, auf dem auch Dunkles liegt); zuletzt die Fläche, die von Kanten umschlossen ist.
            const level = otsu(soft), upper = otsu(soft.filter(value => value > level));
            attempt(soft.map(value => value > level ? 1 : 0));
            if (!sure()) attempt(soft.map(value => value > upper ? 1 : 0));
            if (!sure()) attempt(edges(soft, width, height));
        }
        const fit = (value, size) => Math.min(size, Math.max(0, value * size));
        return found && {
            corners: found.corners.map(p => ({ x: fit(p.x, canvas.width), y: fit(p.y, canvas.height) })),
            confidence: Math.round(found.confidence * 100) / 100
        };
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

    // ---------- Aufhellen ----------
    // Helligkeit des Papiers an jeder Stelle, auf einer kleinen Kopie: Dunkles bis zur Größe 2 · radius schließen, dann weichzeichnen.
    // Übrig bleibt die Beleuchtung (Schatten, dunkle Ecken) – Schrift, Stempel und Unterschriften stecken nicht mehr darin.
    function paperMap(canvas, radius) {
        const { gray, width, height } = grayOf(canvas, 160);
        const closed = spread(spread(gray, width, height, radius, Math.max), width, height, radius, Math.min);
        return { map: blur(closed, width, height, 1), width, height };
    }

    // Macht das Blatt gut lesbar und gibt ein neues Canvas zurück (die Vorlage bleibt, wie sie ist).
    //   'auto'   Schatten heraus (durch die Papierhelligkeit teilen), dann Kontrast spreizen – Farben bleiben (Stempel, Unterschrift)
    //   'color'  nur Kontrast spreizen, die Beleuchtung bleibt (für Fotos und farbige Vorlagen)
    //   'gray'   wie 'auto', aber in Graustufen
    //   'bw'     reines Schwarz-Weiß: schwarz ist, was deutlich dunkler ist als das Papier an dieser Stelle
    function enhance(canvas, { mode = 'auto' } = {}) {
        const { width, height } = canvas;
        const out = makeCanvas(width, height);
        const ctx = context(out);
        ctx.drawImage(canvas, 0, 0);
        const image = ctx.getImageData(0, 0, width, height), data = image.data;
        if (mode !== 'color') {
            // Für Farbe und Grau bleibt Dunkles bis etwa 3 cm stehen (Logo, Stempel); für Schwarz-Weiß zählt, dass auch schmale Schatten verschwinden.
            const paper = paperMap(canvas, mode === 'bw' ? 3 : 7), map = paper.map, pw = paper.width, ph = paper.height;
            const top = map.reduce((most, value) => Math.max(most, value), 1);      // hellste Stelle des Papiers
            const floor = top / LIMITS.maxGain;
            const place = (index, size, count) => Math.min(count - 1, Math.max(0, (index + 0.5) * count / size - 0.5));
            const columns = Float32Array.from({ length: width }, (unused, x) => place(x, width, pw));      // Lage jeder Spalte in der kleinen Karte
            const line = new Float32Array(pw + 1);
            for (let y = 0, p = 0; y < height; y++) {
                const fy = place(y, height, ph), y0 = fy | 0, y1 = Math.min(ph - 1, y0 + 1);
                for (let x = 0; x < pw; x++) line[x] = map[y0 * pw + x] + (map[y1 * pw + x] - map[y0 * pw + x]) * (fy - y0);
                line[pw] = line[pw - 1];
                for (let x = 0; x < width; x++, p += 4) {
                    const x0 = columns[x] | 0, local = line[x0] + (line[x0 + 1] - line[x0]) * (columns[x] - x0);      // Papierhelligkeit an dieser Stelle
                    if (mode === 'bw') {
                        data[p] = data[p + 1] = data[p + 2] = luma(data[p], data[p + 1], data[p + 2]) < LIMITS.bwLevel * local ? 0 : 255;
                    } else {
                        const gain = top / Math.max(local, floor);
                        data[p] *= gain;
                        data[p + 1] *= gain;
                        data[p + 2] *= gain;
                    }
                }
            }
        }
        if (mode !== 'bw') {
            // Kontrast: Was zwischen dem 1. und dem 99. Hundertstel der Helligkeit liegt, wird auf 0 … 255 gespreizt.
            const hist = new Float64Array(256);
            for (let p = 0; p < data.length; p += 16) hist[Math.round(luma(data[p], data[p + 1], data[p + 2]))]++;
            const total = Math.ceil(data.length / 16);
            let seen = 0, low = 0, high = 255;
            for (let value = 0; value < 256; value++) {
                if (seen < total * 0.01) low = value;
                if (seen < total * 0.99) high = value;
                seen += hist[value];
            }
            low = Math.min(low, high - 96);                                          // fast leere Seiten nicht überziehen
            const lut = new Uint8ClampedArray(256);
            for (let value = 0; value < 256; value++) lut[value] = (value - low) * 255 / (high - low);
            for (let p = 0; p < data.length; p += 4) {
                data[p] = lut[data[p]];
                data[p + 1] = lut[data[p + 1]];
                data[p + 2] = lut[data[p + 2]];
                if (mode === 'gray') data[p] = data[p + 1] = data[p + 2] = luma(data[p], data[p + 1], data[p + 2]);
            }
        }
        ctx.putImageData(image, 0, 0);
        return out;
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

    // Alles in einem. options: maxSide, crop (false = nicht zuschneiden), mode (siehe enhance), quality (JPEG, 0…1).
    // Zugeschnitten wird nur, wenn das Blatt sicher erkannt ist – sonst bleibt das ganze Foto (cropped: false).
    async function process(file, options = {}) {
        const original = await fromFile(file, options);
        const found = options.crop === false ? null : detect(original);
        const cropped = Boolean(found && found.confidence >= LIMITS.confidence);
        const page = cropped ? warp(original, found.corners, options) : original;
        const canvas = enhance(page, { mode: options.mode });
        const issues = assess(canvas).issues;
        // Ob das Foto zu dunkel oder überbelichtet war, sieht man nach dem Aufhellen nicht mehr – deshalb auch vorher prüfen.
        for (const issue of assess(page).issues) {
            if (['dunkel', 'hell'].includes(issue.code) && !issues.some(other => other.code === issue.code)) issues.unshift(issue);
        }
        const blob = await toBlob(canvas, options.quality);
        return {
            canvas, blob, width: canvas.width, height: canvas.height, cropped,
            corners: found ? found.corners : null, confidence: found ? found.confidence : 0, issues, original
        };
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

    return { fromFile, detect, warp, enhance, assess, toBlob, process, pageInfo, missingPages, LIMITS };
})();
if (typeof window !== 'undefined') window.DocScan = DocScan;
if (typeof module !== 'undefined') module.exports = DocScan;
