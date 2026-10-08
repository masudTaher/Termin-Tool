// „Scan verbessern“ – eine schon archivierte, vom Handy fotografierte Unterlage nachträglich aufbereiten:
// Blatt erkennen und zuschneiden, gerade ziehen, weißes Papier, kräftige Schrift. Vorher und Nachher stehen nebeneinander;
// jede Seite lässt sich ansehen und anpassen (Ecken, Darstellung, Drehen). Übernommen wird erst auf Knopfdruck –
// die frühere Datei bleibt aufbewahrt (tt_documents.original_path) und lässt sich in der Akte wiederherstellen.
// Alles geschieht in diesem Browser; hochgeladen wird nur das fertige PDF.
//
//   ScanFix.open(doc, { profile, fileName, onDone })      eine Unterlage, Seite für Seite zum Ansehen und Anpassen
//   ScanFix.batch(docs, { label, onDone })                viele auf einmal: Vorher / Nachher je Unterlage, mit Häkchen
//
// Braucht TerminCloud. docScan.js, scanCam.js, akteImport.js und docPdf.js werden erst beim Öffnen nachgeladen.
window.ScanFix = (() => {
    const BUCKET = 'dokumente';
    const LIMITS = { render: 2600, side: 2200, quality: 0.8, thumb: 560, maxPages: 60 };
    const NEEDS = [['DocScan', 'docScan.js'], ['ScanCam', 'scanCam.js'], ['AkteImport', 'akteImport.js'], ['DocPdf', 'docPdf.js']];
    // Platz sparen (dieselbe Wahl wie bei „Papierakte einlesen“): Reine Textseiten werden als „Dokument“ mit 16 Tönen gespeichert –
    // etwa ein Drittel so groß. Fotos und Seiten mit Farbflächen bleiben JPEG (DocScan.compact liefert dafür null).
    const compactWanted = () => { try { return localStorage.getItem('terminTool.akte.compact') !== '0'; } catch (error) { return true; } };
    const compactOf = async canvas => compactWanted() && window.DocScan?.compact ? DocScan.compact(canvas) : null;
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const clean = value => String(value ?? '').trim();
    const pause = () => new Promise(resolve => window.setTimeout(resolve, 0));
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    const loading = new Map();
    function load(source) {
        if (!loading.has(source)) {
            loading.set(source, new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = source;
                script.onload = resolve;
                script.onerror = () => { loading.delete(source); reject(new Error(`Ein Teil des Programms (${source}) konnte nicht geladen werden. Bitte die Verbindung prüfen.`)); };
                document.head.append(script);
            }));
        }
        return loading.get(source);
    }
    async function ready() { for (const [name, source] of NEEDS) if (!window[name]) await load(source); }

    const makeCanvas = (width, height) => Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });
    const copyOf = canvas => { const copy = makeCanvas(canvas.width, canvas.height); copy.getContext('2d').drawImage(canvas, 0, 0); return copy; };
    function thumbUrl(canvas) {
        const scale = Math.min(1, LIMITS.thumb / Math.max(canvas.width, canvas.height));
        const small = makeCanvas(canvas.width * scale, canvas.height * scale), ctx = small.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, 0, 0, small.width, small.height);
        return small.toDataURL('image/jpeg', 0.72);
    }

    // Die Seiten der gespeicherten Datei als Bilder. Ein PDF aus der App enthält je Seite genau ein Foto, mittig auf A4 –
    // herausgeschnitten wird genau dieses Foto (ohne den weißen Rand des Blatts A4 drumherum).
    async function pagesOf(file, onPage) {
        if (!/pdf$/i.test(file.type || '') && !/\.pdf$/i.test(file.name || '')) return [await DocScan.fromFile(file, { maxSide: 3000 })];
        const opened = await AkteImport.openPdf(file);
        const list = [];
        try {
            const count = opened.doc.numPages;
            if (count > LIMITS.maxPages) throw new Error(`Diese Unterlage hat ${count} Seiten – „Scan verbessern“ ist für fotografierte Unterlagen bis ${LIMITS.maxPages} Seiten gedacht.`);
            const OPS = opened.lib.OPS;
            for (let number = 1; number <= count; number++) {
                onPage?.(number, count);
                const page = await opened.doc.getPage(number);
                const base = page.getViewport({ scale: 1 });
                // Lage des einen Fotos auf der Seite (in Punkten): aus den Zeichenbefehlen gelesen.
                let box = null;
                try {
                    const ops = await page.getOperatorList();
                    const stack = [];
                    let matrix = [1, 0, 0, 1, 0, 0];
                    const images = [];
                    const multiply = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
                    ops.fnArray.forEach((fn, index) => {
                        if (fn === OPS.save) stack.push(matrix);
                        else if (fn === OPS.restore) matrix = stack.pop() || matrix;
                        else if (fn === OPS.transform) matrix = multiply(matrix, ops.argsArray[index]);
                        else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageXObjectRepeat) images.push(matrix);
                    });
                    if (images.length === 1 && Math.abs(images[0][1]) < 0.01 && Math.abs(images[0][2]) < 0.01 && images[0][0] > 0 && images[0][3] > 0) {
                        const [a, , , d, e, f] = images[0];
                        const one = base.convertToViewportPoint(e, f), two = base.convertToViewportPoint(e + a, f + d);
                        box = [Math.min(one[0], two[0]), Math.min(one[1], two[1]), Math.max(one[0], two[0]), Math.max(one[1], two[1])];
                        const share = (box[2] - box[0]) * (box[3] - box[1]) / (base.width * base.height);
                        if (share < 0.3 || share > 1.02) box = null;
                    }
                } catch (error) { box = null; }
                const longest = box ? Math.max(box[2] - box[0], box[3] - box[1]) : Math.max(base.width, base.height);
                const viewport = page.getViewport({ scale: Math.min(5, LIMITS.render / longest) });
                const canvas = makeCanvas(viewport.width, viewport.height), ctx = canvas.getContext('2d', { willReadFrequently: true });
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                await page.render({ canvasContext: ctx, canvas, viewport }).promise;
                page.cleanup();
                if (box) {
                    const k = viewport.scale, left = Math.max(0, Math.round(box[0] * k)), top = Math.max(0, Math.round(box[1] * k));
                    const width = Math.min(canvas.width - left, Math.round((box[2] - box[0]) * k)), height = Math.min(canvas.height - top, Math.round((box[3] - box[1]) * k));
                    if (width < canvas.width - 2 || height < canvas.height - 2) {
                        const cut = makeCanvas(width, height);
                        cut.getContext('2d').drawImage(canvas, left, top, width, height, 0, 0, width, height);
                        canvas.width = 0; canvas.height = 0;
                        list.push(cut);
                        continue;
                    }
                }
                list.push(canvas);
            }
        } finally { await opened.close(); }
        return list;
    }

    // ---------- Oberfläche ----------
    let root = null;
    let state = null;
    function note(page) {
        const result = page.result;
        const parts = [result.cropped ? (result.manual ? 'Ecken von Hand gesetzt, zugeschnitten und begradigt' : 'Blatt erkannt, zugeschnitten und begradigt')
            : result.whole || result.mode !== 'color' ? 'Papier aufgehellt, Schrift kräftiger' : 'Kein Blattrand erkannt – über „Ansehen und anpassen“ lassen sich die Ecken setzen'];
        if (page.settings.turns) parts.push('gedreht');
        return parts.join(' · ');
    }
    function setStatus(message, kind = 'info') {
        if (!root) return;
        const line = root.querySelector('.scan-fix-status');
        line.hidden = !message;
        line.textContent = message || '';
        line.dataset.kind = kind;
    }
    function render() {
        if (!root || !state) return;
        const grid = root.querySelector('.scan-fix-pages');
        grid.replaceChildren(...state.pages.map((page, index) => {
            const card = el('li', 'scan-fix-page');
            card.dataset.cropped = page.result.cropped ? 'ja' : 'nein';
            const pair = el('div', 'scan-fix-pair');
            const side = (label, url) => { const figure = el('figure'); const image = el('img'); image.src = url; image.alt = `${label}: Seite ${index + 1}`; figure.append(image, el('figcaption', '', label)); return figure; };
            pair.append(side('Vorher', page.beforeUrl), el('span', 'scan-fix-arrow', '→'), side('Nachher', page.afterUrl));
            const foot = el('div', 'scan-fix-foot');
            const edit = el('button', 'button-secondary scan-fix-edit', 'Ansehen und anpassen');
            edit.type = 'button';
            edit.disabled = state.busy;
            edit.addEventListener('click', () => adjust(index));
            foot.append(el('span', 'scan-fix-note', `Seite ${index + 1}: ${note(page)}`), edit);
            card.append(pair, foot);
            return card;
        }));
        const save = root.querySelector('.scan-fix-save');
        save.disabled = state.busy || !state.pages.length;
        save.textContent = state.pages.length > 1 ? `Übernehmen (${plural(state.pages.length, 'Seite', 'Seiten')})` : 'Übernehmen';
        root.querySelector('.scan-fix-cancel').disabled = state.saving;
        root.dataset.busy = state.busy ? 'ja' : 'nein';
    }
    function release() {
        (state?.pages || []).forEach(page => { window.DocScan?.release?.(page.result); if (page.afterUrl?.startsWith('blob:')) URL.revokeObjectURL(page.afterUrl); });
        (state?.items || []).forEach(item => { item.pages = []; });
    }
    function close() {
        if (!root) return;
        release();
        document.removeEventListener('keydown', onKey, true);
        root.remove();
        root = null;
        state = null;
        document.documentElement.classList.remove('scan-fix-open');
    }
    function onKey(event) {
        if (event.key !== 'Escape' || document.querySelector('.scan-review, .scan-adjust, dialog[open]')) return;
        event.preventDefault();
        if (!state?.saving) close();
    }

    // Eine Seite groß ansehen und anpassen (dieselbe Vorschau wie in der Dolmetscher-App).
    async function adjust(index) {
        const page = state?.pages[index];
        if (!page || state.busy) return;
        // Die Vorschau gibt beim Abbrechen den Speicher ihrer Bilder frei – deshalb bekommt sie Kopien.
        const lent = Object.assign({}, page.result, { canvas: copyOf(page.result.canvas), original: copyOf(page.result.original) });
        const answer = await ScanCam.review({ file: null, result: lent, settings: page.settings, title: `Seite ${index + 1} von ${state.pages.length}`, canRetake: false, okLabel: 'So übernehmen' });
        if (!state || answer?.action !== 'ok') return;
        DocScan.release(page.result);
        if (page.afterUrl?.startsWith('blob:')) URL.revokeObjectURL(page.afterUrl);
        page.result = answer.result;
        page.settings = answer.settings;
        page.compact = await compactOf(answer.result.canvas);
        if (!state) return;
        page.afterUrl = URL.createObjectURL(page.compact || answer.result.blob);
        render();
    }

    // Speichert die verbesserten Seiten einer Unterlage: Text neu lesen (für die Suche im PDF), PDF bauen, hochladen, Eintrag
    // umstellen. Die frühere Datei bleibt liegen und ist im Eintrag vermerkt (original_path).
    // pages: [{ blob, compact, width, height }] – blob: JPEG (daraus wird auch der Text gelesen), compact: Platz sparende Form oder null
    async function store(doc, pages, reader, onStatus = () => {}) {
        const client = TerminCloud.client;
        const texts = [], words = [];
        if (reader) {
            for (let index = 0; index < pages.length; index++) {
                onStatus(`Text wird gelesen: Seite ${index + 1} von ${pages.length} …`);
                try { const read = await reader.recognize(pages[index].blob); words.push(read.words || []); texts.push(clean(read.text)); }
                catch (error) { words.push([]); texts.push(''); }
            }
        }
        onStatus('Das PDF wird erstellt …');
        const title = clean(doc.title) || doc.kind || 'Unterlage';
        const pdf = await DocPdf.build({
            pages: pages.map((page, index) => ({ blob: page.compact || page.blob, width: page.width, height: page.height, words: words[index] || [] })),
            title: `${title} · ${[clean(doc.patient_nr), clean(doc.patient_name)].filter(Boolean).join(' ')}`,
            subject: [doc.date ? `vom ${String(doc.date).slice(8, 10)}.${String(doc.date).slice(5, 7)}.${String(doc.date).slice(0, 4)}` : '', clean(doc.doctor)].filter(Boolean).join(' · '),
            author: clean(doc.uploader_name), keywords: [clean(doc.patient_nr), clean(doc.patient_name), doc.kind, 'Scan verbessert'].filter(Boolean)
        });
        if (pdf.size > 20 * 1024 * 1024) throw new Error('Die verbesserte Datei wäre zu groß (über 20 MB).');
        onStatus('Wird gespeichert …');
        const old = clean(doc.file_path);
        const folder = old.includes('/') ? old.slice(0, old.lastIndexOf('/') + 1) : '';
        const name = (old.slice(folder.length).replace(/\.[a-z0-9]+$/i, '').replace(/-verbessert-[a-z0-9]+$/i, '') || 'unterlage').slice(0, 120);
        const path = `${folder}${name}-verbessert-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}.pdf`;
        const upload = await client.storage.from(BUCKET).upload(path, pdf, { contentType: 'application/pdf', upsert: false });
        if (upload.error) throw upload.error;
        const text = texts.some(Boolean) ? texts.map((part, index) => part ? (pages.length > 1 ? `--- Seite ${index + 1} ---\n${part}` : part) : '').filter(Boolean).join('\n\n').slice(0, 60000) : '';
        const changes = { file_path: path, file_bytes: pdf.size, pages: pages.length, original_path: clean(doc.original_path) || old, enhanced_at: new Date().toISOString() };
        if (text) changes.text_content = text;
        // Nur, wenn die Unterlage noch auf die Datei zeigt, die hier verbessert wurde.
        const { data, error } = await client.from('tt_documents').update(changes).eq('id', doc.id).eq('file_path', old).select('id');
        if (error || !data?.length) {
            await client.storage.from(BUCKET).remove([path]);
            throw error || new Error('Die Unterlage wurde inzwischen geändert. Bitte die Seite aktualisieren und noch einmal versuchen.');
        }
        // War die Unterlage schon einmal verbessert, wird die vorige verbesserte Fassung nicht mehr gebraucht – das Original bleibt.
        if (clean(doc.original_path) && clean(doc.original_path) !== old) await client.storage.from(BUCKET).remove([old]);
        return path;
    }
    const failText = error => window.TerminCloud?.germanError ? TerminCloud.germanError(error) : (error?.message || String(error));

    async function save() {
        if (!state || state.busy) return;
        const { doc, pages } = state;
        state.busy = true; state.saving = true;
        render();
        let reader = null;
        try {
            // Text neu lesen – wenn die Texterkennung zu haben ist. Sonst bleibt der bisherige Text der Unterlage.
            reader = await AkteImport.createReader(1);
            await store(doc, pages.map(page => ({ blob: page.result.blob, compact: page.compact, width: page.result.width, height: page.result.height })), reader, setStatus);
            const done = state.onDone;
            close();
            window.showToast?.('Scan verbessert – das Original ist aufbewahrt und lässt sich in der Akte wiederherstellen.', 'success');
            await done?.();
        } catch (error) {
            if (!state) return;
            state.busy = false; state.saving = false;
            setStatus(`Nicht gespeichert: ${failText(error)}`, 'error');
            render();
        } finally { await reader?.terminate?.(); }
    }

    async function open(doc, { profile = null, fileName = '', onDone = null } = {}) {
        if (root || !doc?.file_path) return;
        state = { doc, pages: [], busy: true, saving: false, profile, onDone };
        root = el('div', 'scan-fix');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', 'Scan verbessern');
        const head = el('header', 'scan-fix-head');
        const titles = el('div');
        titles.append(el('h2', '', 'Scan verbessern'), el('p', '', [clean(doc.title) || doc.kind || 'Unterlage', [clean(doc.patient_nr) ? `Patient ${clean(doc.patient_nr)}` : '', clean(doc.patient_name)].filter(Boolean).join(' · ')].filter(Boolean).join(' – ')));
        const shut = el('button', 'scan-fix-close', '×');
        shut.type = 'button';
        shut.setAttribute('aria-label', 'Schließen');
        shut.addEventListener('click', () => { if (!state?.saving) close(); });
        head.append(titles, shut);
        const body = el('div', 'scan-fix-body');
        const lead = el('p', 'scan-fix-lead', 'Links die gespeicherte Seite, rechts der Vorschlag: Blatt zugeschnitten und gerade gezogen, Papier weiß, Schrift kräftig. Erst mit „Übernehmen“ wird gespeichert – das Original bleibt aufbewahrt.');
        const status = el('p', 'workflow-status scan-fix-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const list = el('ul', 'scan-fix-pages');
        body.append(lead, status, list);
        const foot = el('footer', 'scan-fix-actions');
        const cancel = el('button', 'button-secondary scan-fix-cancel', 'Abbrechen');
        cancel.type = 'button';
        cancel.addEventListener('click', () => { if (!state?.saving) close(); });
        const keep = el('button', 'button-primary scan-fix-save', 'Übernehmen');
        keep.type = 'button';
        keep.disabled = true;
        keep.addEventListener('click', save);
        foot.append(cancel, keep);
        root.append(head, body, foot);
        document.body.append(root);
        document.documentElement.classList.add('scan-fix-open');
        document.addEventListener('keydown', onKey, true);
        const mine = state;
        try {
            setStatus('Die Unterlage wird geladen …');
            await ready();
            const { data, error } = await TerminCloud.client.storage.from(BUCKET).download(doc.file_path);
            if (error || !data) throw new Error(/not found/i.test(String(error?.message || '')) || !data ? 'Die Datei wurde im Speicher nicht gefunden.' : TerminCloud.germanError(error));
            if (state !== mine) return;
            const file = new File([data], fileName || (clean(doc.file_path).split('/').pop() || 'unterlage.pdf'), { type: data.type || (/\.pdf$/i.test(doc.file_path) ? 'application/pdf' : 'image/jpeg') });
            const originals = await pagesOf(file, (number, count) => setStatus(`Seite ${number} von ${count} wird geöffnet …`));
            if (state !== mine) { originals.forEach(canvas => { canvas.width = 0; canvas.height = 0; }); return; }
            for (let index = 0; index < originals.length; index++) {
                setStatus(`Seite ${index + 1} von ${originals.length} wird aufbereitet …`);
                await pause();
                const beforeUrl = thumbUrl(originals[index]);
                const result = await DocScan.process(null, { original: originals[index], maxSide: LIMITS.side, quality: LIMITS.quality });
                if (state !== mine) { DocScan.release(result); return; }
                const compact = await compactOf(result.canvas);
                if (state !== mine) { DocScan.release(result); return; }
                state.pages.push({ result, compact, settings: { corners: null, crop: true, mode: null, turns: 0 }, beforeUrl, afterUrl: URL.createObjectURL(compact || result.blob), words: [] });
                render();
            }
            state.busy = false;
            const cropped = state.pages.filter(page => page.result.cropped).length;
            setStatus(cropped ? `${cropped === state.pages.length ? (cropped === 1 ? 'Das Blatt wurde' : 'Alle Blätter wurden') : `${cropped} von ${state.pages.length} Blättern wurden`} erkannt und zugeschnitten. Bitte ansehen – passt es?`
                : 'Kein Tisch zu sehen (oder kein Blattrand erkannt): Die Seiten wurden aufgehellt. Bitte ansehen – ist es besser als vorher?');
            render();
        } catch (error) {
            if (state !== mine) return;
            state.busy = false;
            setStatus(error?.message || String(error), 'error');
            render();
        }
    }

    // ---------- Viele auf einmal ----------
    // Alle Unterlagen werden nacheinander geöffnet und aufbereitet. Danach steht je Unterlage Vorher / Nachher da, mit Häkchen:
    // vorgewählt ist, was sichtbar besser wird (Blatt zugeschnitten oder Papier deutlich weißer). Gespeichert wird erst auf
    // Knopfdruck – und auch dann bleibt jedes Original aufbewahrt.
    function whiteShare(canvas) {
        const scale = 120 / Math.max(canvas.width, canvas.height);
        const small = makeCanvas(canvas.width * scale, canvas.height * scale), ctx = small.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(canvas, 0, 0, small.width, small.height);
        const { data } = ctx.getImageData(0, 0, small.width, small.height);
        let white = 0;
        for (let p = 0; p < data.length; p += 4) if (data[p] >= 236 && data[p + 1] >= 236 && data[p + 2] >= 236) white++;
        return white / (data.length / 4);
    }
    const german = iso => { const match = clean(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return match ? `${match[3]}.${match[2]}.${match[1]}` : ''; };
    function renderBatch() {
        if (!root || !state?.batch) return;
        const list = root.querySelector('.scan-fix-batch');
        list.replaceChildren(...state.items.map(item => {
            const row = el('li', 'scan-fix-row');
            row.dataset.status = item.status;
            row.dataset.docId = item.doc.id;
            const tick = el('label', 'scan-fix-tick');
            const box = el('input');
            box.type = 'checkbox';
            box.checked = item.keep;
            box.disabled = state.busy || item.status !== 'fertig' || item.unsure;
            box.setAttribute('aria-label', 'Diese Unterlage verbessern');
            box.addEventListener('change', () => { item.keep = box.checked; renderBatch(); });
            tick.append(box);
            const mini = el('button', 'scan-fix-mini');
            mini.type = 'button';
            mini.title = 'Größer ansehen';
            if (item.pages[0]) {
                const before = el('img'); before.src = item.pages[0].beforeUrl; before.alt = 'Vorher';
                const after = el('img'); after.src = item.pages[0].afterUrl; after.alt = 'Nachher';
                mini.append(before, el('span', 'scan-fix-arrow', '→'), after);
                mini.addEventListener('click', () => { item.big = !item.big; renderBatch(); });
            } else mini.disabled = true;
            if (item.big) row.dataset.big = 'ja';
            const text = el('div', 'scan-fix-rowtext');
            const doc = item.doc;
            text.append(el('strong', '', clean(doc.title) || doc.kind || 'Unterlage'),
                el('span', '', [clean(doc.patient_nr) ? `Patient ${clean(doc.patient_nr)}` : '', clean(doc.patient_name), german(doc.date), item.pages.length ? plural(item.pages.length, 'Seite', 'Seiten') : ''].filter(Boolean).join(' · ')),
                el('em', '', item.note));
            row.append(tick, mini, text);
            return row;
        }));
        const chosen = state.items.filter(item => item.keep && item.status === 'fertig').length;
        const save = root.querySelector('.scan-fix-save');
        const finished = state.phase === 'ende';
        save.textContent = finished ? 'Fertig' : `Ausgewählte übernehmen (${chosen})`;
        save.disabled = finished ? false : state.busy || !chosen;
        root.querySelector('.scan-fix-cancel').hidden = finished;
        root.querySelector('.scan-fix-cancel').disabled = state.saving;
        root.dataset.busy = state.busy ? 'ja' : 'nein';
        root.dataset.phase = state.phase;
    }
    async function saveBatch() {
        if (!state?.batch || state.busy) return;
        if (state.phase === 'ende') { const done = state.onDone; close(); await done?.(); return; }
        const mine = state;
        const todo = state.items.filter(item => item.keep && item.status === 'fertig');
        state.busy = true; state.saving = true; state.phase = 'speichern';
        renderBatch();
        const reader = await AkteImport.createReader(1);
        let saved = 0, failed = 0;
        try {
            for (const [index, item] of todo.entries()) {
                if (state !== mine) return;
                item.status = 'speichert'; item.note = 'Wird gespeichert …';
                setStatus(`Unterlage ${index + 1} von ${todo.length} wird gespeichert …`);
                renderBatch();
                try {
                    await store(item.doc, item.pages.map(page => ({ blob: page.blob, compact: page.compact, width: page.width, height: page.height })), reader);
                    item.status = 'gespeichert'; item.keep = false; item.note = 'Verbessert ✓ – das Original ist aufbewahrt'; saved += 1;
                } catch (error) { item.status = 'fehler'; item.keep = false; item.note = `Nicht gespeichert: ${failText(error)}`; failed += 1; }
                renderBatch();
            }
        } finally { await reader?.terminate?.(); }
        if (state !== mine) return;
        state.busy = false; state.saving = false; state.phase = 'ende';
        setStatus(`${plural(saved, 'Unterlage', 'Unterlagen')} verbessert – die Originale sind aufbewahrt und lassen sich in der Akte wiederherstellen.${failed ? ` ${failed === 1 ? 'Eine konnte' : `${failed} konnten`} nicht gespeichert werden (siehe Liste).` : ''}`, failed ? 'error' : 'success');
        renderBatch();
    }
    async function batch(docs, { label = '', onDone = null } = {}) {
        const list = (docs || []).filter(doc => doc?.file_path);
        if (root || !list.length) return;
        state = { batch: true, items: list.map(doc => ({ doc, pages: [], status: 'wartet', keep: false, unsure: false, big: false, note: 'wartet …' })), busy: true, saving: false, phase: 'prüfen', onDone };
        root = el('div', 'scan-fix');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', 'Scans verbessern');
        const head = el('header', 'scan-fix-head');
        const titles = el('div');
        titles.append(el('h2', '', 'Scans verbessern'), el('p', '', `${plural(list.length, 'fotografierte Unterlage', 'fotografierte Unterlagen')}${label ? ` – ${label}` : ''}`));
        const shut = el('button', 'scan-fix-close', '×');
        shut.type = 'button';
        shut.setAttribute('aria-label', 'Schließen');
        const leave = async () => { if (state?.saving) return; const done = state?.phase === 'ende' ? state.onDone : null; close(); await done?.(); };
        shut.addEventListener('click', leave);
        head.append(titles, shut);
        const body = el('div', 'scan-fix-body');
        const lead = el('p', 'scan-fix-lead', 'Jede Unterlage wird geöffnet und wie in einer Scan-App aufbereitet: Blatt zugeschnitten und gerade gezogen, Papier weiß, Schrift kräftig. Links steht vorher, rechts nachher. Angehakt ist, was sichtbar besser wird – gespeichert wird erst mit „Ausgewählte übernehmen“, und jedes Original bleibt aufbewahrt.');
        const status = el('p', 'workflow-status scan-fix-status');
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        const rows = el('ul', 'scan-fix-batch');
        body.append(lead, status, rows);
        const foot = el('footer', 'scan-fix-actions');
        const cancel = el('button', 'button-secondary scan-fix-cancel', 'Abbrechen');
        cancel.type = 'button';
        cancel.addEventListener('click', leave);
        const keep = el('button', 'button-primary scan-fix-save', 'Ausgewählte übernehmen (0)');
        keep.type = 'button';
        keep.disabled = true;
        keep.addEventListener('click', saveBatch);
        foot.append(cancel, keep);
        root.append(head, body, foot);
        document.body.append(root);
        document.documentElement.classList.add('scan-fix-open');
        document.addEventListener('keydown', onKey, true);
        const mine = state;
        renderBatch();
        try {
            setStatus('Wird vorbereitet …');
            await ready();
        } catch (error) {
            if (state !== mine) return;
            state.busy = false;
            setStatus(error?.message || String(error), 'error');
            renderBatch();
            return;
        }
        for (const [index, item] of mine.items.entries()) {
            if (state !== mine) return;
            item.status = 'läuft'; item.note = 'wird aufbereitet …';
            setStatus(`Unterlage ${index + 1} von ${mine.items.length} wird aufbereitet …`);
            renderBatch();
            await pause();
            try {
                const doc = item.doc;
                const { data, error } = await TerminCloud.client.storage.from(BUCKET).download(doc.file_path);
                if (error || !data) throw new Error('Die Datei wurde im Speicher nicht gefunden.');
                const file = new File([data], clean(doc.file_path).split('/').pop() || 'unterlage.pdf', { type: data.type || (/\.pdf$/i.test(doc.file_path) ? 'application/pdf' : 'image/jpeg') });
                const originals = await pagesOf(file);
                for (const original of originals) {
                    if (state !== mine) { original.width = 0; original.height = 0; continue; }
                    const beforeUrl = thumbUrl(original), before = whiteShare(original);
                    const result = await DocScan.process(null, { original, maxSide: LIMITS.side, quality: LIMITS.quality });
                    item.pages.push({ blob: result.blob, compact: await compactOf(result.canvas), width: result.width, height: result.height, cropped: result.cropped, whole: Boolean(result.whole), plain: !result.cropped && !result.whole && result.mode === 'color',
                        beforeUrl, afterUrl: thumbUrl(result.canvas), gain: whiteShare(result.canvas) - before });
                    DocScan.release(result);
                    await pause();
                }
                if (state !== mine) return;
                const cropped = item.pages.filter(page => page.cropped).length;
                const gain = item.pages.reduce((sum, page) => sum + page.gain, 0) / Math.max(1, item.pages.length);
                item.unsure = item.pages.some(page => page.plain);
                const better = cropped > 0 || gain >= 0.08;
                item.keep = better && !item.unsure;
                item.note = item.unsure ? 'Kein Blattrand erkannt – bitte in der Akte einzeln über „Scan verbessern“ ansehen und die Ecken setzen'
                    : cropped === item.pages.length ? (cropped === 1 ? 'Blatt erkannt und zugeschnitten' : `Alle ${cropped} Blätter erkannt und zugeschnitten`)
                    : cropped ? `${cropped} von ${item.pages.length} Blättern zugeschnitten, die übrigen aufgehellt`
                    : better ? 'Papier aufgehellt, Schrift kräftiger' : 'Kaum ein Unterschied – bleibt, wie sie ist (Häkchen setzen, wenn sie trotzdem ersetzt werden soll)';
                item.status = 'fertig';
            } catch (error) {
                if (state !== mine) return;
                item.status = 'fehler';
                item.note = `Nicht geöffnet: ${error?.message || error}`;
            }
            renderBatch();
        }
        if (state !== mine) return;
        state.busy = false; state.phase = 'bereit';
        const good = state.items.filter(item => item.keep).length, unclear = state.items.filter(item => item.unsure).length, same = state.items.filter(item => item.status === 'fertig' && !item.keep && !item.unsure).length;
        setStatus([good ? `${good === 1 ? 'Eine Unterlage wird' : `${good} Unterlagen werden`} sichtbar besser (angehakt).` : 'Keine Unterlage wird sichtbar besser.', same ? `${same === 1 ? 'Eine ist' : `${same} sind`} schon gut.` : '',
            unclear ? `Bei ${unclear === 1 ? 'einer' : unclear} wurde kein Blattrand erkannt – bitte einzeln ansehen.` : '', good ? 'Bitte ansehen und dann übernehmen.' : ''].filter(Boolean).join(' '));
        renderBatch();
    }

    return { open, batch, close, pagesOf, LIMITS, state: () => state };
})();
