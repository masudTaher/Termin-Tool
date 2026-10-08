// Scannen wie in einer Scan-App – ohne die Foto-App des Handys.
//   · Kamera: Das Blatt wird im laufenden Bild erkannt und gelb markiert. Liegt es ruhig und ganz im Bild, wird von selbst
//     aufgenommen (abschaltbar mit „Automatisch“); „Scannen“ löst jederzeit von Hand aus.
//   · Vorschau: Nach jeder Aufnahme erscheint die fertige Seite groß – mit „Vergrößern“ zum genauen Ansehen, „Ecken anpassen“,
//     „Drehen“, „Neu aufnehmen“ und der Wahl Scan / Grau / Foto.
//   · Ecken anpassen: die vier Ecken auf dem Foto von Hand setzen (mit Lupe) – falls der Rand nicht stimmt.
// Zuschneiden, Geraderücken und Aufbereiten erledigt docScan.js – alles auf dem Gerät, nichts geht an fremde Dienste.
//
//   ScanCam.supported()   → gibt es eine Kamera, die die Seite direkt nutzen kann?
//   ScanCam.open({ title, count, single, shape, review, onCapture })
//                           öffnet die Kamera. onCapture(file, { automatic, result, settings }) je bestätigter Aufnahme:
//                           file = das Foto, result = die fertige Seite (DocScan.process), settings = Ecken/Art/Drehung dazu.
//                           shape: 'blatt' (Standard) oder 'beleg' (schmaler Kassenzettel – darf kleiner im Bild sein).
//                           review: false = ohne Vorschau nach der Aufnahme.
//                           Ergebnis (Promise): { captured: Anzahl, reason: 'fertig' | 'galerie' | 'fehler', error? }
//   ScanCam.review({ file, result, settings, title, canRetake, okLabel })
//                           zeigt die Vorschau für ein Foto (z. B. aus der Galerie oder für eine Seite aus der Liste).
//                           Ergebnis (Promise): { action: 'ok', result, settings } | { action: 'retake' } | { action: 'cancel' }
//   ScanCam.prepare(file, { title })
//                           ein Foto aus der Galerie: aufbereiten + Vorschau. Ergebnis (Promise): die fertige Seite oder null.
//   ScanCam.close()       → schließt die Kamera
window.ScanCam = (function () {
    const supported = () => Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const svg = (tag, className) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); if (className) node.setAttribute('class', className); return node; };
    const button = (className, text, label) => { const node = el('button', className, text); node.type = 'button'; if (label) node.setAttribute('aria-label', label); return node; };
    const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
    const AUTO_KEY = 'terminTool.scanCam.auto';
    const LIMITS = {
        confidence: 0.6,      // ab dieser Sicherheit gilt das Blatt als erkannt
        fillSheet: 0.55,      // so weit muss das Blatt das Bild in der Breite oder der Höhe füllen, bevor von selbst aufgenommen wird
        fillSlip: 0.4,        // (sonst: „Näher herangehen“) – ein Kassenzettel darf kleiner sein
        calm: 0.012,          // größte Bewegung einer Ecke zwischen zwei Blicken (Anteil der Bilddiagonale), die noch als „ruhig“ gilt
        calmTime: 650,        // so lange muss das Blatt ruhig liegen (Millisekunden)
        fresh: 0.06,          // erst wenn sich die Ecken so weit bewegt haben, gilt das Blatt als neues Blatt
        lookMin: 130,         // kürzester Abstand zwischen zwei Blicken
        zoomMax: 6, zoomStep: 1.6, zoomTap: 2.5
    };
    let active = null;

    function errorText(error) {
        const name = error?.name || '';
        if (name === 'NotAllowedError' || name === 'SecurityError') return 'Die Kamera ist für diese App nicht erlaubt. Erlaube sie in den Einstellungen des Browsers – oder nimm die Foto-App.';
        if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Auf diesem Gerät wurde keine Kamera gefunden.';
        if (name === 'NotReadableError' || name === 'AbortError') return 'Die Kamera wird gerade von einer anderen App benutzt.';
        return 'Die Kamera konnte nicht gestartet werden.';
    }

    // Ecken im Uhrzeigersinn, beginnend oben links (wie in docScan.js).
    function ordered(quad) {
        const cx = quad.reduce((sum, p) => sum + p.x, 0) / 4, cy = quad.reduce((sum, p) => sum + p.y, 0) / 4;
        const turn = quad.slice().sort((p, q) => Math.atan2(p.y - cy, p.x - cx) - Math.atan2(q.y - cy, q.x - cx));
        let first = 0;
        turn.forEach((p, index) => { if (p.x + p.y < turn[first].x + turn[first].y) first = index; });
        return turn.slice(first).concat(turn.slice(0, first));
    }
    const areaOf = quad => Math.abs(quad.reduce((sum, p, i) => sum + p.x * quad[(i + 1) % 4].y - quad[(i + 1) % 4].x * p.y, 0)) / 2;
    const convex = quad => { let sign = 0; for (let i = 0; i < 4; i++) { const a = quad[i], b = quad[(i + 1) % 4], c = quad[(i + 2) % 4], turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x); if (Math.abs(turn) < 1e-6) return false; if (sign && Math.sign(turn) !== sign) return false; sign = Math.sign(turn); } return true; };

    // ---------- Ecken anpassen ----------
    // Zeigt das Foto mit vier ziehbaren Ecken. Ergebnis: { corners } (Bildpunkte des Fotos) | { whole: true } | null (abgebrochen).
    function adjust({ original, corners, title = 'Ecken anpassen' }) {
        return new Promise(resolve => {
            const root = el('div', 'scan-adjust');
            root.setAttribute('role', 'dialog');
            root.setAttribute('aria-modal', 'true');
            root.setAttribute('aria-label', title);
            const top = el('div', 'scan-review-top');
            top.append(el('strong', '', title), el('small', '', 'Zieh die vier Punkte auf die Ecken des Blatts.'));
            const stage = el('div', 'scan-adjust-stage');
            const photo = el('canvas', 'scan-adjust-photo');
            const overlay = svg('svg', 'scan-adjust-overlay');
            const shade = svg('path', 'scan-adjust-shade');
            const outline = svg('polygon', 'scan-adjust-outline');
            overlay.append(shade, outline);
            const handles = [0, 1, 2, 3].map(index => { const handle = button('scan-adjust-handle', '', ['Ecke oben links', 'Ecke oben rechts', 'Ecke unten rechts', 'Ecke unten links'][index]); handle.dataset.corner = String(index); return handle; });
            const loupe = el('canvas', 'scan-adjust-loupe');
            loupe.width = loupe.height = 220;
            loupe.hidden = true;
            stage.append(photo, overlay, ...handles, loupe);
            const hint = el('p', 'scan-adjust-hint');
            hint.setAttribute('role', 'status');
            const bottom = el('div', 'scan-review-bottom');
            const whole = button('scan-review-button', 'Ganzes Foto');
            const again = button('scan-review-button', 'Automatisch erkennen');
            const cancel = button('scan-review-button', 'Abbrechen');
            const apply = button('scan-review-button is-main', 'Übernehmen');
            bottom.append(whole, again, cancel, apply);
            root.append(top, stage, hint, bottom);
            document.body.append(root);

            const W = original.width, H = original.height;
            const inset = point => ({ x: clamp(point.x, 0, W), y: clamp(point.y, 0, H) });
            const standard = () => [{ x: W * 0.08, y: H * 0.08 }, { x: W * 0.92, y: H * 0.08 }, { x: W * 0.92, y: H * 0.92 }, { x: W * 0.08, y: H * 0.92 }];
            let points = (corners && corners.length === 4 ? corners : standard()).map(inset);
            let map = { k: 1, left: 0, top: 0 };

            function layout() {
                const box = stage.getBoundingClientRect(), pad = 26;
                const k = Math.min((box.width - 2 * pad) / W, (box.height - 2 * pad) / H);
                map = { k, left: (box.width - W * k) / 2, top: (box.height - H * k) / 2, width: box.width, height: box.height };
                const ratio = Math.min(2, window.devicePixelRatio || 1);
                photo.width = Math.max(1, Math.round(W * k * ratio));
                photo.height = Math.max(1, Math.round(H * k * ratio));
                Object.assign(photo.style, { left: `${map.left}px`, top: `${map.top}px`, width: `${W * k}px`, height: `${H * k}px` });
                const ctx = photo.getContext('2d');
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(original, 0, 0, photo.width, photo.height);
                overlay.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
                draw();
            }
            const onScreen = point => ({ x: map.left + point.x * map.k, y: map.top + point.y * map.k });
            function draw() {
                const screen = points.map(onScreen);
                const list = screen.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
                outline.setAttribute('points', list);
                shade.setAttribute('d', `M0 0H${map.width}V${map.height}H0Z M${screen.map(point => `${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(' L')}Z`);
                handles.forEach((handle, index) => { handle.style.left = `${screen[index].x}px`; handle.style.top = `${screen[index].y}px`; });
                const good = convex(points) && areaOf(points) >= 0.03 * W * H;
                apply.disabled = !good;
                root.dataset.valid = good ? 'ja' : 'nein';
                hint.textContent = good ? '' : 'So ergibt sich kein Blatt – die Punkte dürfen sich nicht überkreuzen.';
            }
            function showLoupe(index) {
                const point = points[index], screen = onScreen(point), ctx = loupe.getContext('2d');
                const reach = 110 / (map.k * 2.4) / 2;      // die Lupe (110 Punkte breit) zeigt das Foto 2,4-fach größer als die Fläche darunter
                ctx.fillStyle = '#111';
                ctx.fillRect(0, 0, 220, 220);
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(original, point.x - reach, point.y - reach, reach * 2, reach * 2, 0, 0, 220, 220);
                ctx.strokeStyle = '#ffd400';
                ctx.lineWidth = 3;
                ctx.beginPath(); ctx.moveTo(110, 70); ctx.lineTo(110, 150); ctx.moveTo(70, 110); ctx.lineTo(150, 110); ctx.stroke();
                const above = screen.y > 150;
                loupe.style.left = `${clamp(screen.x, 62, map.width - 62)}px`;
                loupe.style.top = `${above ? screen.y - 92 : screen.y + 92}px`;
                loupe.hidden = false;
            }
            handles.forEach((handle, index) => {
                let grab = null;
                handle.addEventListener('pointerdown', event => {
                    event.preventDefault();
                    handle.setPointerCapture?.(event.pointerId);
                    const screen = onScreen(points[index]);
                    grab = { dx: screen.x - event.clientX, dy: screen.y - event.clientY };
                    handle.classList.add('is-held');
                    showLoupe(index);
                });
                handle.addEventListener('pointermove', event => {
                    if (!grab) return;
                    points[index] = inset({ x: (event.clientX + grab.dx - map.left) / map.k, y: (event.clientY + grab.dy - map.top) / map.k });
                    draw();
                    showLoupe(index);
                });
                const release = () => { grab = null; handle.classList.remove('is-held'); loupe.hidden = true; };
                handle.addEventListener('pointerup', release);
                handle.addEventListener('pointercancel', release);
                // mit den Pfeiltasten in kleinen Schritten (Umschalt = größer)
                handle.addEventListener('keydown', event => {
                    const step = (event.shiftKey ? 12 : 2) / map.k, move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
                    if (!move) return;
                    event.preventDefault();
                    points[index] = inset({ x: points[index].x + move[0], y: points[index].y + move[1] });
                    draw();
                });
            });

            const finish = value => {
                window.removeEventListener('resize', layout);
                document.removeEventListener('keydown', onKey, true);
                root.remove();
                resolve(value);
            };
            const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); } };
            document.addEventListener('keydown', onKey, true);
            window.addEventListener('resize', layout);
            cancel.addEventListener('click', () => finish(null));
            whole.addEventListener('click', () => finish({ whole: true }));
            apply.addEventListener('click', () => { if (!apply.disabled) finish({ corners: ordered(points) }); });
            again.addEventListener('click', () => {
                let found = null;
                try { found = window.DocScan?.detect(original); } catch (error) { found = null; }
                if (found && found.confidence >= 0.35) { points = found.corners.map(inset); draw(); hint.textContent = found.confidence >= LIMITS.confidence ? 'Rand erkannt.' : 'Rand vermutet – bitte prüfen.'; }
                else hint.textContent = 'Der Rand lässt sich nicht von selbst erkennen. Bitte die Punkte von Hand setzen.';
            });
            layout();
            apply.focus({ preventScroll: true });
        });
    }

    // ---------- Vorschau ----------
    const MODES = [['auto', 'Scan'], ['gray', 'Grau'], ['color', 'Foto']];
    const SHORT = { dunkel: 'Zu dunkel aufgenommen.', hell: 'Überbelichtet oder spiegelt.', unscharf: 'Unscharf.', klein: 'Sehr klein – näher herangehen.', kontrast: 'Schrift kaum zu erkennen.', rand: 'Rand nicht erkannt – bitte „Ecken anpassen“.' };

    function review({ file, result = null, settings = null, title = 'Vorschau', canRetake = true, okLabel = 'Passt ✓' } = {}) {
        return new Promise(resolve => {
            const state = Object.assign({ corners: null, crop: true, mode: null, turns: 0 }, settings || {});
            let current = result, url = '', working = 0, closed = false;
            const root = el('div', 'scan-review');
            root.setAttribute('role', 'dialog');
            root.setAttribute('aria-modal', 'true');
            root.setAttribute('aria-label', title);
            const top = el('div', 'scan-review-top');
            const note = el('small', 'scan-review-note');
            note.setAttribute('role', 'status');
            top.append(el('strong', '', title), note);
            const stage = el('div', 'scan-review-stage');
            const image = el('img', 'scan-review-image');
            image.alt = 'Gescannte Seite';
            image.draggable = false;
            const busy = el('div', 'scan-review-busy', 'Wird aufbereitet …');
            busy.hidden = true;
            stage.append(image, busy);
            const tools = el('div', 'scan-review-tools');
            const zoomToggle = button('scan-review-zoom', 'Vergrößern');
            const zoomOut = button('scan-review-step', '−', 'Verkleinern');
            const zoomIn = button('scan-review-step', '+', 'Weiter vergrößern');
            const modes = el('div', 'scan-review-modes');
            modes.setAttribute('role', 'group');
            modes.setAttribute('aria-label', 'Darstellung');
            const modeButtons = MODES.map(([key, label]) => { const node = button('scan-review-mode', label); node.dataset.mode = key; modes.append(node); return node; });
            tools.append(zoomToggle, zoomOut, zoomIn, modes);
            const bottom = el('div', 'scan-review-bottom');
            const retake = button('scan-review-button', 'Neu aufnehmen');
            const edit = button('scan-review-button is-edit', 'Ecken anpassen');
            const turn = button('scan-review-button', 'Drehen');
            const ok = button('scan-review-button is-main', okLabel);
            retake.hidden = !canRetake;
            bottom.append(retake, edit, turn, ok);
            const shut = button('scan-review-close', '×', 'Vorschau schließen');
            root.append(top, shut, stage, tools, bottom);
            document.body.append(root);
            document.documentElement.classList.add('scan-cam-open');

            // --- Vergrößern und Verschieben ---
            // Vergrößert wird über die Größe des Bildes (nicht über eine Skalierung der fertigen Fläche): So rechnet der Browser jedes Mal
            // aus der vollen Auflösung der Seite – die Schrift bleibt scharf.
            const zoom = { scale: 1, x: 0, y: 0 };
            const applyZoom = () => {
                const box = stage.getBoundingClientRect(), ratio = current ? current.width / current.height : 0.707;
                const fitWide = Math.max(40, Math.min(box.width - 24, (box.height - 24) * ratio)), wide = fitWide * zoom.scale, high = wide / ratio;
                const limitX = Math.max(0, (wide - box.width) / 2 + 24), limitY = Math.max(0, (high - box.height) / 2 + 24);
                zoom.x = zoom.scale <= 1 ? 0 : clamp(zoom.x, -limitX, limitX);
                zoom.y = zoom.scale <= 1 ? 0 : clamp(zoom.y, -limitY, limitY);
                image.style.width = `${wide}px`;
                image.style.height = `${high}px`;
                image.style.transform = `translate(calc(-50% + ${zoom.x}px), calc(-50% + ${zoom.y}px))`;
                root.dataset.zoomed = zoom.scale > 1.01 ? 'ja' : 'nein';
                root.dataset.zoom = zoom.scale.toFixed(2);
                zoomToggle.textContent = zoom.scale > 1.01 ? 'Ganze Seite' : 'Vergrößern';
                zoomOut.disabled = zoom.scale <= 1.01;
                zoomIn.disabled = zoom.scale >= LIMITS.zoomMax - 0.01;
            };
            // Auf scale vergrößern – der Punkt (px, py), gemessen ab der Mitte der Fläche, bleibt an seiner Stelle.
            const zoomTo = (scale, px = 0, py = 0) => {
                const next = clamp(scale, 1, LIMITS.zoomMax), factor = next / zoom.scale;
                zoom.x = px - (px - zoom.x) * factor;
                zoom.y = py - (py - zoom.y) * factor;
                zoom.scale = next;
                applyZoom();
            };
            const fromCentre = event => { const box = stage.getBoundingClientRect(); return { x: event.clientX - box.left - box.width / 2, y: event.clientY - box.top - box.height / 2 }; };
            const pointers = new Map();
            let drag = null, pinch = null, lastTap = 0;
            stage.addEventListener('pointerdown', event => {
                if (event.target.closest('button')) return;
                stage.setPointerCapture?.(event.pointerId);
                pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
                if (pointers.size === 1) drag = { x: zoom.x, y: zoom.y, px: event.clientX, py: event.clientY, moved: false };
                if (pointers.size === 2) {
                    const [a, b] = [...pointers.values()];
                    pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: zoom.scale };
                    drag = null;
                }
            });
            stage.addEventListener('pointermove', event => {
                if (!pointers.has(event.pointerId)) return;
                pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
                if (pinch && pointers.size >= 2) {
                    const [a, b] = [...pointers.values()], box = stage.getBoundingClientRect();
                    zoomTo(pinch.scale * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance, (a.x + b.x) / 2 - box.left - box.width / 2, (a.y + b.y) / 2 - box.top - box.height / 2);
                } else if (drag) {
                    const dx = event.clientX - drag.px, dy = event.clientY - drag.py;
                    if (Math.abs(dx) + Math.abs(dy) > 6) drag.moved = true;
                    if (zoom.scale > 1) { zoom.x = drag.x + dx; zoom.y = drag.y + dy; applyZoom(); }
                }
            });
            const lift = event => {
                if (!pointers.has(event.pointerId)) return;
                pointers.delete(event.pointerId);
                if (pointers.size < 2) pinch = null;
                if (drag && !drag.moved && event.type === 'pointerup') {      // Doppeltipp: hinein und wieder heraus
                    const now = Date.now();
                    if (now - lastTap < 320) { const at = fromCentre(event); if (zoom.scale > 1.01) zoomTo(1); else zoomTo(LIMITS.zoomTap, at.x, at.y); lastTap = 0; }
                    else lastTap = now;
                }
                if (!pointers.size) drag = null;
            };
            stage.addEventListener('pointerup', lift);
            stage.addEventListener('pointercancel', lift);
            stage.addEventListener('wheel', event => { event.preventDefault(); const at = fromCentre(event); zoomTo(zoom.scale * (event.deltaY < 0 ? 1.2 : 1 / 1.2), at.x, at.y); }, { passive: false });
            zoomToggle.addEventListener('click', () => { if (zoom.scale > 1.01) zoomTo(1); else zoomTo(LIMITS.zoomTap, 0, -stage.getBoundingClientRect().height * 0.18); });
            zoomIn.addEventListener('click', () => zoomTo(zoom.scale * LIMITS.zoomStep));
            zoomOut.addEventListener('click', () => zoomTo(zoom.scale / LIMITS.zoomStep));

            // --- Anzeige ---
            function show() {
                if (!current) return;
                if (url) URL.revokeObjectURL(url);
                url = URL.createObjectURL(current.blob);
                image.src = url;
                const facts = [current.cropped ? (current.manual ? 'Ecken von Hand gesetzt' : current.open ? 'Sichtbarer Teil zugeschnitten – das Blatt ragt aus dem Bild' : 'Rand erkannt und begradigt') : 'Ganzes Foto'];
                (current.issues || []).forEach(issue => facts.push(SHORT[issue.code] || issue.text));
                note.textContent = facts.join(' · ');
                root.dataset.cropped = current.cropped ? 'ja' : 'nein';
                root.dataset.issues = (current.issues || []).map(issue => issue.code).join(' ');
                root.dataset.size = `${current.width}x${current.height}`;
                modeButtons.forEach(node => node.setAttribute('aria-pressed', String(node.dataset.mode === current.mode)));
                zoom.scale = 1; zoom.x = 0; zoom.y = 0;
                applyZoom();
            }
            function setBusy(on) {
                working += on ? 1 : -1;
                busy.hidden = working <= 0;
                root.dataset.busy = working > 0 ? 'ja' : 'nein';
                [retake, edit, turn, ok, ...modeButtons].forEach(node => { node.disabled = working > 0; });
            }
            // Seite neu erzeugen: mit den Einstellungen in state (Ecken, ganzes Foto, Art, Drehung).
            async function produce() {
                setBusy(true);
                try {
                    const options = { original: current?.original, mode: state.mode || undefined };
                    if (state.crop === false) options.crop = false;
                    else if (state.corners) options.corners = state.corners;
                    let next = await window.DocScan.process(file, options);
                    if (state.turns) {
                        const canvas = window.DocScan.turn(next.canvas, state.turns), flat = next;
                        next = Object.assign({}, next, { canvas, blob: await window.DocScan.toBlob(canvas), width: canvas.width, height: canvas.height });
                        window.DocScan.release?.(flat, { keepOriginal: true });
                    }
                    if (closed) { window.DocScan.release?.(next); return; }
                    if (current && current !== next) window.DocScan.release?.(current, { keepOriginal: current.original === next.original });
                    current = next;
                    show();
                } catch (error) {
                    note.textContent = error?.message || 'Das Foto konnte nicht geöffnet werden.';
                } finally { setBusy(false); }
            }
            const finish = value => {
                if (closed) return;
                closed = true;
                document.removeEventListener('keydown', onKey, true);
                window.removeEventListener('resize', applyZoom);
                if (url) URL.revokeObjectURL(url);
                root.remove();
                if (!document.querySelector('.scan-cam, .scan-review')) document.documentElement.classList.remove('scan-cam-open');
                if (value.action !== 'ok') window.DocScan?.release?.(current);      // verworfen: Speicher gleich freigeben (bei „ok“ tut das, wer die Seite übernimmt)
                resolve(value);
            };
            const onKey = event => {
                if (document.querySelector('.scan-adjust')) return;
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish({ action: 'cancel' }); }
                if (event.key === '+') zoomTo(zoom.scale * LIMITS.zoomStep);
                if (event.key === '-') zoomTo(zoom.scale / LIMITS.zoomStep);
            };
            document.addEventListener('keydown', onKey, true);
            window.addEventListener('resize', applyZoom);
            shut.addEventListener('click', () => finish({ action: 'cancel' }));
            retake.addEventListener('click', () => finish({ action: 'retake' }));
            ok.addEventListener('click', () => { if (current) finish({ action: 'ok', result: current, settings: Object.assign({}, state) }); });
            turn.addEventListener('click', async () => {
                if (!current || working) return;
                setBusy(true);
                try {
                    state.turns = (state.turns + 1) % 4;
                    const canvas = window.DocScan.turn(current.canvas, 1), before = current;
                    current = Object.assign({}, current, { canvas, blob: await window.DocScan.toBlob(canvas), width: canvas.width, height: canvas.height });
                    window.DocScan.release?.(before, { keepOriginal: true });
                    show();
                } finally { setBusy(false); }
            });
            edit.addEventListener('click', async () => {
                if (!current?.original || working) return;
                const answer = await adjust({ original: current.original, corners: state.crop === false ? null : (state.corners || current.corners) });
                if (!answer || closed) return;
                if (answer.whole) { state.crop = false; state.corners = null; }
                else { state.crop = true; state.corners = answer.corners; }
                await produce();
            });
            modeButtons.forEach(node => node.addEventListener('click', async () => {
                if (working || !current || node.dataset.mode === current.mode) return;
                state.mode = node.dataset.mode;
                await produce();
            }));

            if (current && !state.turns && !state.mode && !state.corners && state.crop !== false) show();
            else produce();
            ok.focus({ preventScroll: true });
        });
    }

    // ---------- Kamera ----------
    async function open(options = {}) {
        if (active) return { captured: 0, reason: 'fehler', error: 'schon offen' };
        if (!supported()) return { captured: 0, reason: 'fehler', error: 'Auf diesem Gerät kann die App die Kamera nicht direkt öffnen.' };
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } });
        } catch (error) {
            return { captured: 0, reason: 'fehler', error: errorText(error) };
        }

        return new Promise(resolve => {
            const slip = options.shape === 'beleg', thing = slip ? 'den Beleg' : 'das Blatt', Thing = slip ? 'Der Beleg' : 'Das Blatt';
            const root = el('div', 'scan-cam');
            root.setAttribute('role', 'dialog');
            root.setAttribute('aria-modal', 'true');
            root.setAttribute('aria-label', options.title || 'Unterlage scannen');
            if (slip) root.dataset.shape = 'beleg';
            const video = el('video', 'scan-cam-video');
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            video.setAttribute('playsinline', '');
            const overlay = svg('svg', 'scan-cam-overlay');
            const outline = svg('polygon', 'scan-cam-outline');
            const dots = [0, 1, 2, 3].map(() => svg('circle', 'scan-cam-dot'));
            dots.forEach(dot => dot.setAttribute('r', '7'));
            overlay.append(outline, ...dots);
            const frame = el('div', 'scan-cam-frame');
            ['tl', 'tr', 'br', 'bl'].forEach(corner => frame.append(el('i', `scan-cam-corner is-${corner}`)));
            const top = el('div', 'scan-cam-top');
            const done = button('scan-cam-done', 'Fertig');
            top.append(el('strong', '', options.title || 'Unterlage scannen'), done);
            const status = el('p', 'scan-cam-status', `Halte das Handy über ${thing}.`);
            status.setAttribute('role', 'status');
            const bottom = el('div', 'scan-cam-bottom');
            const gallery = button('scan-cam-side', 'Galerie');
            const shutter = button('scan-cam-shutter', '', 'Scannen');
            shutter.append(el('span', '', 'Scannen'));
            const auto = button('scan-cam-auto');
            let autoOn = true;
            try { autoOn = localStorage.getItem(AUTO_KEY) !== 'aus'; } catch (error) { /* bleibt an */ }
            const showAuto = () => { auto.textContent = autoOn ? 'Automatisch: an' : 'Automatisch: aus'; auto.setAttribute('aria-pressed', String(autoOn)); };
            showAuto();
            const torch = button('scan-cam-side scan-cam-torch', 'Licht');
            torch.hidden = true;
            const counter = el('span', 'scan-cam-count');
            bottom.append(gallery, shutter, torch);
            const flash = el('div', 'scan-cam-flash');
            const working = el('div', 'scan-cam-working', 'Wird aufbereitet …');
            working.hidden = true;
            root.append(video, overlay, frame, top, status, counter, auto, bottom, flash, working);
            document.body.append(root);
            document.documentElement.classList.add('scan-cam-open');

            const track = stream.getVideoTracks()[0];
            let captured = 0, already = Number(options.count) || 0;
            let target = null;            // erkannte Ecken (Bildpunkte des Videos) – nur wenn sicher erkannt
            let shown = null;             // gezeichnete Ecken: folgen target weich
            let previous = null;          // Ecken beim vorigen Blick
            let calmSince = 0;            // seit wann liegt das Blatt ruhig (0 = bewegt sich)
            let shot = null;              // Ecken der letzten Aufnahme: erst ein anderes Blatt wird wieder von selbst gescannt
            let missed = 0;               // so viele Blicke nacheinander wurde nichts erkannt
            let lookTimer = 0, frameTimer = 0, busy = false, closed = false, startedAt = Date.now();
            const showCount = () => { const total = already + captured; counter.textContent = total ? `${total} ${total === 1 ? 'Seite' : 'Seiten'}` : ''; counter.hidden = !total; };
            showCount();
            const moved = (a, b) => { if (!a || !b) return Infinity; const size = Math.hypot(video.videoWidth, video.videoHeight) || 1; return Math.max(...a.map((point, index) => Math.hypot(point.x - b[index].x, point.y - b[index].y))) / size; };
            const say = (text, state) => { if (status.textContent !== text) status.textContent = text; root.dataset.state = state; };

            // Bild des Videos → Bildschirm (das Video füllt die Fläche, überstehende Ränder sind abgeschnitten)
            const mapping = () => {
                const box = video.getBoundingClientRect();
                const scale = Math.max(box.width / (video.videoWidth || 1), box.height / (video.videoHeight || 1));
                return { scale, left: (box.width - video.videoWidth * scale) / 2, top: (box.height - video.videoHeight * scale) / 2 };
            };
            // Die Markierung folgt dem Blatt weich – bei jedem Bild des Bildschirms ein Stück näher an die zuletzt erkannten Ecken.
            function paint() {
                if (closed) return;
                frameTimer = window.requestAnimationFrame(paint);
                if (!target) { if (shown) { shown = null; outline.setAttribute('points', ''); dots.forEach(dot => dot.setAttribute('visibility', 'hidden')); } return; }
                shown = shown ? shown.map((point, index) => ({ x: point.x + (target[index].x - point.x) * 0.35, y: point.y + (target[index].y - point.y) * 0.35 })) : target.map(point => ({ x: point.x, y: point.y }));
                const map = mapping(), screen = shown.map(point => ({ x: point.x * map.scale + map.left, y: point.y * map.scale + map.top }));
                outline.setAttribute('points', screen.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '));
                dots.forEach((dot, index) => { dot.setAttribute('cx', screen[index].x.toFixed(1)); dot.setAttribute('cy', screen[index].y.toFixed(1)); dot.setAttribute('visibility', 'visible'); });
            }

            // Ein Blick ins laufende Bild: Blatt suchen, Hinweis zeigen, bei ruhigem Blatt von selbst aufnehmen.
            function look() {
                if (closed) return;
                const began = performance.now();
                let wait = 220;
                if (!busy && video.videoWidth && window.DocScan?.detect) {
                    let found = null;
                    try { found = window.DocScan.detect(video, { fine: false }); } catch (error) { found = null; }
                    const sure = Boolean(found && found.confidence >= LIMITS.confidence && Array.isArray(found.corners));
                    const now = Date.now();
                    if (sure) {
                        missed = 0;
                        target = found.corners;
                        const calm = moved(target, previous) < LIMITS.calm;
                        calmSince = calm ? (calmSince || now) : 0;
                        previous = target;
                        const xs = target.map(point => point.x), ys = target.map(point => point.y);
                        const fill = Math.max((Math.max(...xs) - Math.min(...xs)) / video.videoWidth, (Math.max(...ys) - Math.min(...ys)) / video.videoHeight);
                        const small = fill < (slip ? LIMITS.fillSlip : LIMITS.fillSheet), cut = found.open > 0;
                        const fresh = !shot || moved(target, shot) > LIMITS.fresh;
                        root.dataset.found = 'ja';
                        if (cut) say(`${Thing} ist nicht ganz im Bild – etwas weiter weg.`, 'offen');
                        else if (small) say('Näher herangehen.', 'klein');
                        else if (!fresh) say('Gescannt. Nächste Seite hinlegen – oder „Fertig“.', 'fertig');
                        else if (!autoOn) say('Erkannt – jetzt „Scannen“ tippen.', 'bereit');
                        else if (!calm) say('Erkannt – ruhig halten …', 'bewegt');
                        else say('Ruhig halten – wird aufgenommen …', 'ruhig');
                        if (autoOn && fresh && !cut && !small && calmSince && now - calmSince >= LIMITS.calmTime) { calmSince = 0; capture(true); }
                    } else {
                        missed += 1;
                        if (missed >= 2) { target = null; previous = null; calmSince = 0; shot = null; root.dataset.found = 'nein'; }      // Blatt weggenommen → das nächste zählt wieder als neu
                        if (!target) say(now - startedAt > 6000 ? `Kein Blatt erkannt – du kannst auch selbst „Scannen“ tippen.` : `Halte das Handy über ${thing}.`, 'suche');
                    }
                    wait = Math.max(LIMITS.lookMin, (performance.now() - began) * 1.6);
                }
                lookTimer = window.setTimeout(look, wait);
            }

            // Das Bild holen: als Foto in voller Auflösung, wo das Gerät es anbietet – sonst das aktuelle Bild des Videos.
            async function grab() {
                if (typeof window.ImageCapture === 'function' && track && !options.frameOnly) {
                    try {
                        const photo = await Promise.race([new window.ImageCapture(track).takePhoto(), new Promise((unused, reject) => window.setTimeout(() => reject(new Error('zu langsam')), 2500))]);
                        if (photo && photo.size > 20000) return photo;
                    } catch (error) { /* weiter mit dem Bild des Videos */ }
                }
                const full = document.createElement('canvas');
                full.width = video.videoWidth;
                full.height = video.videoHeight;
                full.getContext('2d').drawImage(video, 0, 0);
                return new Promise(done => full.toBlob(done, 'image/jpeg', 0.93));
            }

            async function capture(automatic = false) {
                if (busy || closed || !video.videoWidth) return;
                busy = true;
                shutter.disabled = true;
                const position = target;
                try {
                    flash.classList.remove('is-on'); void flash.offsetWidth; flash.classList.add('is-on');
                    const blob = await grab();
                    if (!blob) throw new Error('kein Bild');
                    const file = new File([blob], `scan-${Date.now()}.jpg`, { type: 'image/jpeg' });
                    working.hidden = false;
                    let result = null, settings = null;
                    try { result = window.DocScan ? await window.DocScan.process(file) : null; } catch (error) { result = null; }
                    working.hidden = true;
                    if (closed) return;
                    if (result && options.review !== false) {
                        const number = already + captured + 1;
                        const answer = await review({ file, result, title: options.single ? 'Vorschau' : `Vorschau · Seite ${number}`, okLabel: options.single ? 'Passt ✓' : 'Passt – weiter' });
                        if (closed) return;
                        if (answer.action !== 'ok') { shot = null; calmSince = 0; say(`Halte das Handy über ${thing}.`, 'suche'); return; }
                        result = answer.result;
                        settings = answer.settings;
                    }
                    captured += 1;
                    shot = position;
                    showCount();
                    await options.onCapture?.(file, { automatic, result, settings });
                    if (options.single) { finish('fertig'); return; }
                    say('Gescannt. Nächste Seite hinlegen – oder „Fertig“.', 'fertig');
                } catch (error) {
                    working.hidden = true;
                    say('Die Aufnahme hat nicht geklappt. Bitte noch einmal tippen.', 'fehler');
                } finally {
                    busy = false;
                    shutter.disabled = false;
                }
            }

            function finish(reason, error) {
                if (closed) return;
                closed = true;
                window.clearTimeout(lookTimer);
                window.cancelAnimationFrame(frameTimer);
                stream.getTracks().forEach(item => item.stop());
                document.removeEventListener('keydown', onKey, true);
                root.remove();
                if (!document.querySelector('.scan-review')) document.documentElement.classList.remove('scan-cam-open');
                active = null;
                resolve({ captured, reason, error });
            }
            const onKey = event => { if (event.key === 'Escape' && !document.querySelector('.scan-review, .scan-adjust')) { event.preventDefault(); finish('fertig'); } };
            document.addEventListener('keydown', onKey, true);
            done.addEventListener('click', () => finish('fertig'));
            gallery.addEventListener('click', () => finish('galerie'));
            shutter.addEventListener('click', () => capture(false));
            auto.addEventListener('click', () => { autoOn = !autoOn; calmSince = 0; try { localStorage.setItem(AUTO_KEY, autoOn ? 'an' : 'aus'); } catch (error) { /* gilt bis zum Schließen */ } showAuto(); });
            track?.addEventListener?.('ended', () => finish('fehler', 'Die Kamera wurde beendet.'));

            // Taschenlampe und Dauer-Scharfstellen, wo das Gerät sie anbietet
            try {
                const abilities = track?.getCapabilities?.() || {};
                if (Array.isArray(abilities.focusMode) && abilities.focusMode.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => null);
                if (abilities.torch) {
                    torch.hidden = false;
                    let on = false;
                    torch.addEventListener('click', async () => {
                        on = !on;
                        try { await track.applyConstraints({ advanced: [{ torch: on }] }); torch.setAttribute('aria-pressed', String(on)); } catch (error) { torch.hidden = true; }
                    });
                }
            } catch (error) { /* ohne Licht-Knopf */ }

            video.srcObject = stream;
            video.play?.().catch(() => { /* startet nach dem ersten Tipp */ });
            root.dataset.found = 'nein';
            root.dataset.state = 'suche';
            lookTimer = window.setTimeout(look, 300);
            frameTimer = window.requestAnimationFrame(paint);
            active = { finish };
            shutter.focus({ preventScroll: true });
        });
    }

    // Ein Foto aus der Galerie: aufbereiten und die Vorschau zeigen. Ergebnis: die fertige Seite – oder null, wenn die Vorschau
    // geschlossen wurde.
    async function prepare(file, options = {}) { return (await prepareFull(file, options))?.result || null; }
    // Wie prepare, liefert aber auch die Einstellungen der Vorschau (Ecken, Art, Drehung) – damit lässt sich die Seite später
    // noch einmal „Ansehen“ und ändern: { result, settings } oder null.
    async function prepareFull(file, options = {}) {
        const result = await window.DocScan.process(file);
        const answer = await review(Object.assign({ file, result, canRetake: false }, options));
        return answer.action === 'ok' ? { result: answer.result, settings: answer.settings } : null;
    }

    // Ein Foto groß ansehen (ohne es zu verändern): Tipp auf das Bild oder „Vergrößern“ zeigt es in voller Schärfe zum Verschieben.
    // look({ blob | url, title, removeLabel }) → 'remove', wenn „Löschen“ getippt wurde, sonst 'close'.
    function look({ blob = null, url = '', title = 'Foto', removeLabel = '' } = {}) {
        return new Promise(resolve => {
            const own = blob ? URL.createObjectURL(blob) : '';
            const root = el('div', 'scan-review scan-look');
            root.setAttribute('role', 'dialog');
            root.setAttribute('aria-modal', 'true');
            root.setAttribute('aria-label', title);
            root.dataset.issues = '';
            const top = el('div', 'scan-review-top');
            top.append(el('strong', '', title), el('small', '', 'Tippe auf das Bild, um es zu vergrößern.'));
            const stage = el('div', 'scan-look-stage');
            const image = el('img', 'scan-look-image');
            image.alt = title;
            image.src = own || url;
            stage.append(image);
            const bottom = el('div', 'scan-review-bottom');
            const zoom = button('scan-review-button', 'Vergrößern');
            const remove = button('scan-review-button is-danger', removeLabel || 'Löschen');
            remove.hidden = !removeLabel;
            const ok = button('scan-review-button is-main', 'Schließen');
            bottom.append(zoom, remove, ok);
            const shut = button('scan-review-close', '×', 'Schließen');
            root.append(top, shut, stage, bottom);
            const toggle = event => {
                const big = root.dataset.zoomed !== 'ja';
                // Die getippte Stelle bleibt nach dem Vergrößern in der Mitte.
                const box = image.getBoundingClientRect();
                const fx = event?.clientX ? (event.clientX - box.left) / box.width : 0.5, fy = event?.clientY ? (event.clientY - box.top) / box.height : 0.3;
                root.dataset.zoomed = big ? 'ja' : 'nein';
                zoom.textContent = big ? 'Ganzes Bild' : 'Vergrößern';
                if (big) window.requestAnimationFrame(() => { stage.scrollLeft = image.offsetWidth * fx - stage.clientWidth / 2; stage.scrollTop = image.offsetHeight * fy - stage.clientHeight / 2; });
            };
            const finish = value => {
                document.removeEventListener('keydown', onKey, true);
                root.remove();
                if (own) URL.revokeObjectURL(own);
                if (!document.querySelector('.scan-cam, .scan-review')) document.documentElement.classList.remove('scan-cam-open');
                resolve(value);
            };
            const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish('close'); } };
            document.addEventListener('keydown', onKey, true);
            image.addEventListener('click', toggle);
            zoom.addEventListener('click', () => toggle());
            remove.addEventListener('click', () => finish('remove'));
            ok.addEventListener('click', () => finish('close'));
            shut.addEventListener('click', () => finish('close'));
            root.dataset.zoomed = 'nein';
            document.body.append(root);
            document.documentElement.classList.add('scan-cam-open');
            ok.focus({ preventScroll: true });
        });
    }

    return { supported, open, review, adjust, prepare, prepareFull, look, close: () => active?.finish('fertig'), LIMITS };
})();
