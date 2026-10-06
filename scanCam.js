// Kamera in der App zum Scannen von Unterlagen – ohne die Foto-App des Handys.
// Ein Rahmen zeigt, wohin das Blatt gehört; die erkannten Kanten werden live eingezeichnet. „Scannen“ nimmt das Bild auf.
// Zuschneiden, Geraderücken und Aufhellen erledigt danach docScan.js – alles auf dem Gerät, nichts geht an fremde Dienste.
//
//   ScanCam.supported()                       → gibt es eine Kamera, die die Seite direkt nutzen kann?
//   ScanCam.open({ title, count, onCapture }) → öffnet die Kamera; onCapture(file) je Aufnahme. Ergebnis (Promise):
//                                               { captured: Anzahl, reason: 'fertig' | 'galerie' | 'fehler', error? }
window.ScanCam = (function () {
    const supported = () => Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    let active = null;

    function errorText(error) {
        const name = error?.name || '';
        if (name === 'NotAllowedError' || name === 'SecurityError') return 'Die Kamera ist für diese App nicht erlaubt. Erlaube sie in den Einstellungen des Browsers – oder nimm die Foto-App.';
        if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Auf diesem Gerät wurde keine Kamera gefunden.';
        if (name === 'NotReadableError' || name === 'AbortError') return 'Die Kamera wird gerade von einer anderen App benutzt.';
        return 'Die Kamera konnte nicht gestartet werden.';
    }

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
            const root = el('div', 'scan-cam');
            root.setAttribute('role', 'dialog');
            root.setAttribute('aria-modal', 'true');
            root.setAttribute('aria-label', options.title || 'Unterlage scannen');
            const video = el('video', 'scan-cam-video');
            video.autoplay = true;
            video.muted = true;
            video.playsInline = true;
            video.setAttribute('playsinline', '');
            const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            overlay.setAttribute('class', 'scan-cam-overlay');
            const outline = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
            outline.setAttribute('class', 'scan-cam-outline');
            overlay.append(outline);
            const frame = el('div', 'scan-cam-frame');
            ['tl', 'tr', 'br', 'bl'].forEach(corner => frame.append(el('i', `scan-cam-corner is-${corner}`)));
            const top = el('div', 'scan-cam-top');
            const title = el('strong', '', options.title || 'Unterlage scannen');
            const done = el('button', 'scan-cam-done', 'Fertig');
            done.type = 'button';
            top.append(title, done);
            const status = el('p', 'scan-cam-status', 'Leg das Blatt in den Rahmen.');
            status.setAttribute('role', 'status');
            const bottom = el('div', 'scan-cam-bottom');
            const gallery = el('button', 'scan-cam-side', 'Galerie');
            gallery.type = 'button';
            const shutter = el('button', 'scan-cam-shutter');
            shutter.type = 'button';
            shutter.setAttribute('aria-label', 'Scannen');
            shutter.append(el('span', '', 'Scannen'));
            const torch = el('button', 'scan-cam-side scan-cam-torch', 'Licht');
            torch.type = 'button';
            torch.hidden = true;
            const counter = el('span', 'scan-cam-count');
            bottom.append(gallery, shutter, torch);
            const flash = el('div', 'scan-cam-flash');
            root.append(video, overlay, frame, top, status, counter, bottom, flash);
            document.body.append(root);
            document.documentElement.classList.add('scan-cam-open');

            let captured = 0;
            let already = Number(options.count) || 0;
            let lastCorners = null;       // erkannte Ecken im Videobild (Pixel des Videos) – nur wenn sicher erkannt
            let timer = 0;
            let busy = false;
            let closed = false;
            const track = stream.getVideoTracks()[0];
            const small = document.createElement('canvas');
            const showCount = () => { const total = already + captured; counter.textContent = total ? `${total} ${total === 1 ? 'Seite' : 'Seiten'}` : ''; counter.hidden = !total; };
            showCount();

            // Bild des Videos → Bildschirm (das Video füllt die Fläche, überstehende Ränder sind abgeschnitten)
            const mapping = () => {
                const box = video.getBoundingClientRect();
                const scale = Math.max(box.width / (video.videoWidth || 1), box.height / (video.videoHeight || 1));
                return { scale, left: (box.width - video.videoWidth * scale) / 2, top: (box.height - video.videoHeight * scale) / 2, box };
            };
            // Der Rahmen in Pixeln des Videos (mit etwas Rand) – dorthin wird zugeschnitten, wenn keine Kanten erkannt wurden.
            const frameInVideo = () => {
                const map = mapping();
                const rect = frame.getBoundingClientRect();
                const pad = rect.width * 0.05;
                const x0 = Math.max(0, (rect.left - map.box.left - pad - map.left) / map.scale);
                const y0 = Math.max(0, (rect.top - map.box.top - pad - map.top) / map.scale);
                const x1 = Math.min(video.videoWidth, (rect.right - map.box.left + pad - map.left) / map.scale);
                const y1 = Math.min(video.videoHeight, (rect.bottom - map.box.top + pad - map.top) / map.scale);
                return { x: Math.round(x0), y: Math.round(y0), width: Math.max(1, Math.round(x1 - x0)), height: Math.max(1, Math.round(y1 - y0)) };
            };

            function look() {
                if (closed || busy || !video.videoWidth || !window.DocScan?.detect) return;
                const ratio = Math.min(1, 420 / Math.max(video.videoWidth, video.videoHeight));
                small.width = Math.round(video.videoWidth * ratio);
                small.height = Math.round(video.videoHeight * ratio);
                small.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, small.width, small.height);
                let found = null;
                try { found = window.DocScan.detect(small); } catch (error) { found = null; }
                const sure = found && found.confidence >= 0.6 && Array.isArray(found.corners);
                lastCorners = sure ? found.corners.map(point => ({ x: point.x / ratio, y: point.y / ratio })) : null;
                root.dataset.found = sure ? 'ja' : 'nein';
                status.textContent = sure ? 'Blatt erkannt – jetzt „Scannen“ tippen.' : 'Leg das Blatt in den Rahmen. Dunkler Untergrund hilft.';
                if (sure) {
                    const map = mapping();
                    outline.setAttribute('points', lastCorners.map(point => `${(point.x * map.scale + map.left).toFixed(1)},${(point.y * map.scale + map.top).toFixed(1)}`).join(' '));
                } else outline.setAttribute('points', '');
            }

            async function capture() {
                if (busy || closed || !video.videoWidth) return;
                busy = true;
                shutter.disabled = true;
                try {
                    const full = document.createElement('canvas');
                    // Sind die Kanten erkannt, geht das ganze Bild weiter (docScan schneidet genau zu). Sonst gilt der Rahmen.
                    const area = lastCorners ? { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight } : frameInVideo();
                    full.width = area.width;
                    full.height = area.height;
                    full.getContext('2d').drawImage(video, area.x, area.y, area.width, area.height, 0, 0, area.width, area.height);
                    const blob = await new Promise(done => full.toBlob(done, 'image/jpeg', 0.93));
                    if (!blob) throw new Error('kein Bild');
                    flash.classList.remove('is-on'); void flash.offsetWidth; flash.classList.add('is-on');
                    captured += 1;
                    showCount();
                    status.textContent = 'Aufgenommen. Nächste Seite – oder „Fertig“.';
                    const file = new File([blob], `scan-${Date.now()}.jpg`, { type: 'image/jpeg' });
                    await options.onCapture?.(file, { framed: !lastCorners });
                    if (options.single) finish('fertig');
                } catch (error) {
                    status.textContent = 'Die Aufnahme hat nicht geklappt. Bitte noch einmal tippen.';
                } finally {
                    busy = false;
                    shutter.disabled = false;
                }
            }

            function finish(reason, error) {
                if (closed) return;
                closed = true;
                window.clearInterval(timer);
                stream.getTracks().forEach(item => item.stop());
                document.removeEventListener('keydown', onKey, true);
                root.remove();
                document.documentElement.classList.remove('scan-cam-open');
                active = null;
                resolve({ captured, reason, error });
            }
            const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); finish('fertig'); } };
            document.addEventListener('keydown', onKey, true);
            done.addEventListener('click', () => finish('fertig'));
            gallery.addEventListener('click', () => finish('galerie'));
            shutter.addEventListener('click', capture);
            track?.addEventListener?.('ended', () => finish('fehler', 'Die Kamera wurde beendet.'));

            // Taschenlampe, wo das Gerät sie anbietet
            try {
                const abilities = track?.getCapabilities?.() || {};
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
            timer = window.setInterval(look, 380);
            active = { finish };
            shutter.focus({ preventScroll: true });
        });
    }

    return { supported, open, close: () => active?.finish('fertig') };
})();
