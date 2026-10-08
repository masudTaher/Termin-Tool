// Dolmetscher-App: die ganze Akte des Patienten zum zugesagten Auftrag – groß, zum Suchen und Ordnen.
// Die Datenbank gibt die Unterlagen nur dem Dolmetscher, dem der Auftrag gerade gehört (ab der Zusage, rund um den Termin),
// und hält jeden Abruf fest. Hier werden sie gezeigt: nach Datum, Fachrichtung oder Arzt geordnet, nach Art gefiltert,
// und jede Unterlage lässt sich ansehen, speichern, weiterleiten und drucken – auch mehrere auf einmal.
//
//   PortalRecord.open({ docs, patientNr, patientName, jobDoctor, toast })
//   docs: Zeilen aus tt_patient_history (id, date, created_at, kind, title, specialty, doctor, note, body, pages, file_path, uploader_name, mine, status)
window.PortalRecord = (() => {
    const BUCKET = 'dokumente';
    const ORDER_KEY = 'terminTool.portal.recordOrder';
    const CACHE_LIMIT = 60 * 1024 * 1024;       // so viel an geholten Dateien bleibt höchstens im Arbeitsspeicher
    const SHARE_LIMIT = 10;                     // so viele Dateien auf einmal weiterleiten
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const clean = value => String(value ?? '').trim();
    const fold = text => clean(text).toLocaleLowerCase('de-DE').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ');
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    const dayOf = doc => clean(doc.date).slice(0, 10) || (doc.status === 'archiv' ? '' : clean(doc.created_at).slice(0, 10));
    const german = iso => { const match = clean(iso).match(/^(\d{4})-(\d{2})-(\d{2})/); return match ? `${match[3]}.${match[2]}.${match[1]}` : ''; };
    const titleOf = doc => clean(doc.title) || clean(doc.kind) || 'Unterlage';
    const surname = doctor => fold(doctor).replace(/\b(prof|dr|med|dent|pd)\b\.?/g, ' ').replace(/[,/].*$/, '').trim().split(/\s+/).pop() || '';
    const isKind = (doc, test) => (typeof test === 'string' ? clean(doc.kind) === test : test.test(clean(doc.kind)));
    // Arten (wie die Reiter der Akte im Büro). „Sonstiges“ ist alles, was sonst nirgends passt.
    const GROUPS = [
        ['arzt', 'Arztberichte', 'Arztbericht'], ['bild', 'Bildgebung', /Bildgebung/], ['befund', 'Befunde', /^Befund/], ['rezept', 'Rezepte', /^Rezept/], ['ueberweisung', 'Überweisungen', /^Überweisung/],
        ['dolm', 'Dolmetscherberichte', 'Dolmetscherbericht'], ['kosten', 'Kosten', /^Kosten/]
    ];
    const groupOf = doc => (GROUPS.find(([, , test]) => isKind(doc, test)) || ['sonst'])[0];
    const ORDERS = [['datum', 'Datum'], ['fach', 'Fachrichtung'], ['arzt', 'Arzt']];
    const ICONS = {
        view: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.600-7 10-7 10 7 10 7-3.600 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
        save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4"/><path d="M5 19h14"/></svg>',
        share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="M12 15V4m0 0-4 4m4-4 4 4"/></svg>',
        print: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V4h10v5"/><path d="M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2"/><path d="M7 14h10v6H7z"/></svg>',
        chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>'
    };

    let root = null;
    let state = null;
    const cache = new Map();      // id → File
    let cached = 0;
    let printFrame = null;

    const say = (message, kind = 'info', action = null) => { if (state?.toast) state.toast(message, kind, null, action); };
    const phone = () => { try { return window.matchMedia('(pointer: coarse)').matches; } catch (error) { return false; } };

    // ---------- Dateien ----------
    const fileName = doc => window.DocPdf ? DocPdf.fileName({ patientNr: state.patientNr, patientName: state.patientName, kind: doc.kind, date: clean(doc.date).slice(0, 10), ext: (clean(doc.file_path).match(/\.(pdf|jpe?g|png)$/i) || [])[1] || 'pdf' })
        : `${[state.patientNr, clean(doc.kind).replace(/\s+/g, '-'), clean(doc.date).slice(0, 10)].filter(Boolean).join('_') || 'Unterlage'}.pdf`;
    async function fileOf(doc) {
        if (cache.has(doc.id)) return cache.get(doc.id);
        if (!doc.file_path) throw new Error('Zu dieser Unterlage gibt es keine Datei.');
        const { data, error } = await TerminCloud.client.storage.from(BUCKET).download(doc.file_path);
        if (error || !data) throw new Error('Die Unterlage konnte nicht geladen werden. Bitte sag der Einsatzleitung Bescheid.');
        const file = new File([data], fileName(doc), { type: data.type || 'application/pdf' });
        if (file.size <= CACHE_LIMIT / 3) {
            while (cached + file.size > CACHE_LIMIT && cache.size) { const [first, old] = cache.entries().next().value; cache.delete(first); cached -= old.size; }
            cache.set(doc.id, file); cached += file.size;
        }
        return file;
    }
    const canShare = files => { try { return typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && navigator.canShare({ files }); } catch (error) { return false; } };
    function saveFile(file) {
        const link = document.createElement('a');
        link.href = URL.createObjectURL(file);
        link.download = file.name;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(link.href), 60000);
    }
    // Knopf während des Ladens sperren; Fehler als Anzeige.
    async function busy(button, work) {
        if (button.disabled) return;
        button.disabled = true;
        button.dataset.busy = 'ja';
        try { await work(); }
        catch (error) { if (error?.name !== 'AbortError') say(error?.message || 'Das hat nicht geklappt. Bitte noch einmal versuchen.', 'error'); }
        finally { button.disabled = false; delete button.dataset.busy; }
    }

    // Ansehen: in einem neuen Tab – der Tab entsteht sofort beim Tippen (nach dem Warten würde ihn das Handy blockieren).
    async function view(doc, button) {
        const tab = window.open('', '_blank');
        await busy(button, async () => {
            const { data, error } = await TerminCloud.client.storage.from(BUCKET).createSignedUrl(doc.file_path, 600);
            if (error || !data?.signedUrl) { tab?.close(); throw new Error('Die Unterlage konnte nicht geöffnet werden. Bitte sag der Einsatzleitung Bescheid.'); }
            if (tab && !tab.closed) { tab.opener = null; tab.location.replace(data.signedUrl); }
            else say('Der Browser hat das neue Fenster blockiert.', 'info', { label: 'Öffnen', run: () => { window.location.href = data.signedUrl; } });
        });
    }
    const save = (docs, button) => busy(button, async () => {
        for (const doc of docs) saveFile(await fileOf(doc));
        say(docs.length === 1 ? 'Gespeichert – die Datei liegt bei deinen Downloads.' : `${docs.length} Dateien gespeichert – sie liegen bei deinen Downloads.`, 'success');
    });
    // Weiterleiten über das Teilen-Menü des Handys (E-Mail, WhatsApp, AirDrop …) – mit der Datei selbst, nicht nur einem Link.
    async function shareFiles(files, hint) {
        const title = files.length === 1 ? files[0].name.replace(/\.[a-z0-9]+$/i, '') : `${files.length} Unterlagen${state.patientNr ? ` · Patient ${state.patientNr}` : ''}`;
        const go = () => navigator.share({ files, title });
        try { if (hint) say(hint, 'info'); await go(); }
        catch (error) {
            if (error?.name === 'AbortError') return;
            // Das Handy verlangt, dass „Teilen“ direkt auf einen Tipp folgt – nach dem Laden der Datei ist der manchmal schon „verbraucht“.
            if (error?.name === 'NotAllowedError') { say(files.length === 1 ? 'Die Datei ist bereit.' : 'Die Dateien sind bereit.', 'info', { label: 'Jetzt teilen', run: () => go().catch(() => null) }); return; }
            throw new Error('Teilen ist auf diesem Gerät gerade nicht möglich. Du kannst die Datei speichern und dann verschicken.');
        }
    }
    const share = (docs, button) => busy(button, async () => {
        if (docs.length > SHARE_LIMIT) throw new Error(`Bitte höchstens ${SHARE_LIMIT} Unterlagen auf einmal weiterleiten.`);
        const files = [];
        for (const doc of docs) files.push(await fileOf(doc));
        if (canShare(files)) { await shareFiles(files); return; }
        // Kein Teilen-Menü (z. B. am PC): speichern – von dort lässt sich die Datei an eine E-Mail hängen.
        files.forEach(saveFile);
        say(files.length === 1 ? 'Auf diesem Gerät gibt es kein Teilen-Menü. Die Datei wurde gespeichert – du kannst sie jetzt an eine E-Mail oder Nachricht anhängen.'
            : 'Auf diesem Gerät gibt es kein Teilen-Menü. Die Dateien wurden gespeichert – du kannst sie jetzt an eine E-Mail oder Nachricht anhängen.', 'info');
    });
    const print = (doc, button) => busy(button, async () => {
        const file = await fileOf(doc);
        // Handy: Drucken läuft über das Teilen-Menü („Drucken“).
        if (phone() && canShare([file])) { await shareFiles([file], 'Im Teilen-Menü „Drucken“ wählen.'); return; }
        const url = URL.createObjectURL(new Blob([file], { type: file.type || 'application/pdf' }));
        window.setTimeout(() => URL.revokeObjectURL(url), 300000);
        if (/pdf/i.test(file.type)) {
            // PC: das PDF unsichtbar laden und an den Drucker geben.
            printFrame?.remove();
            const frame = printFrame = document.createElement('iframe');
            frame.className = 'print-frame';
            frame.setAttribute('aria-hidden', 'true');
            let started = false;
            const start = () => {
                if (started) return;
                started = true;
                try { frame.contentWindow.focus(); frame.contentWindow.print(); }
                catch (error) { window.open(url, '_blank', 'noopener'); say('Die Unterlage ist in einem neuen Fenster geöffnet – dort drucken.', 'info'); }
            };
            frame.addEventListener('load', () => window.setTimeout(start, 300));
            window.setTimeout(start, 3000);
            frame.src = url;
            document.body.append(frame);
            return;
        }
        window.open(url, '_blank', 'noopener');
        say('Die Unterlage ist in einem neuen Fenster geöffnet – dort über das Menü drucken.', 'info');
    });

    // ---------- Liste ----------
    function visible() {
        const words = fold(state.query).split(' ').filter(Boolean);
        return state.docs.filter(doc => (state.group === 'alle' || groupOf(doc) === state.group)
            && words.every(word => fold([titleOf(doc), doc.kind, doc.doctor, doc.specialty, doc.note, doc.body, german(dayOf(doc)), dayOf(doc).slice(0, 4)].join(' ')).includes(word)));
    }
    const byDay = (left, right) => dayOf(right).localeCompare(dayOf(left)) || clean(right.created_at).localeCompare(clean(left.created_at));
    // Abschnitte: nach Datum je Jahr, sonst je Fachrichtung oder Arzt (ohne Angabe am Ende).
    function sections(docs) {
        const sorted = [...docs].sort(byDay);
        const grouped = (pick, missing, compare) => {
            const map = new Map();
            sorted.forEach(doc => { const key = pick(doc) || missing; if (!map.has(key)) map.set(key, []); map.get(key).push(doc); });
            return [...map.keys()].sort((left, right) => (left === missing) - (right === missing) || compare(left, right)).map(key => ({ title: key, docs: map.get(key) }));
        };
        if (state.order === 'fach') return grouped(doc => clean(doc.specialty), 'Ohne Fachrichtung', (left, right) => left.localeCompare(right, 'de'));
        if (state.order === 'arzt') return grouped(doc => clean(doc.doctor), 'Ohne Arzt', (left, right) => surname(left).localeCompare(surname(right), 'de') || left.localeCompare(right, 'de'));
        return grouped(doc => dayOf(doc).slice(0, 4), 'Ohne Datum', (left, right) => right.localeCompare(left));
    }
    function iconButton(className, icon, label, onClick) {
        const button = el('button', className);
        button.type = 'button';
        button.innerHTML = ICONS[icon];
        button.append(el('span', '', label));
        button.addEventListener('click', () => onClick(button));
        return button;
    }
    function entry(doc) {
        const open = state.openId === doc.id && !state.picking;
        const item = el('li', 'record-entry');
        item.dataset.id = doc.id;
        item.dataset.open = String(open);
        item.dataset.group = groupOf(doc);
        const head = el('button', 'record-head');
        head.type = 'button';
        head.setAttribute('aria-expanded', String(open));
        if (state.picking) {
            const box = el('span', 'record-check');
            box.dataset.on = String(state.picked.has(doc.id));
            box.setAttribute('aria-hidden', 'true');
            head.append(box);
            head.setAttribute('aria-pressed', String(state.picked.has(doc.id)));
            head.disabled = !doc.file_path;
        }
        const text = el('span', 'record-text');
        const day = dayOf(doc);
        const same = state.jobDoctor && doc.doctor && (fold(doc.doctor).includes(fold(state.jobDoctor)) || fold(state.jobDoctor).includes(fold(doc.doctor)));
        const title = titleOf(doc), said = value => !clean(value) || fold(title).includes(fold(value));
        text.append(el('strong', '', title), el('span', 'record-sub', [day ? german(day) : 'ohne Datum', said(doc.doctor) ? '' : clean(doc.doctor), said(doc.specialty) ? '' : clean(doc.specialty),
            doc.pages ? plural(doc.pages, 'Seite', 'Seiten') : '', doc.status === 'archiv' ? 'aus der Papierakte' : doc.mine ? 'von dir' : doc.uploader_name ? `von ${doc.uploader_name}` : ''].filter(Boolean).join(' · ')));
        if (same) text.append(el('em', 'chip chip-brand', 'gleiche Praxis'));
        head.append(text);
        if (!state.picking) { const arrow = el('span', 'record-arrow'); arrow.innerHTML = ICONS.chevron; head.append(arrow); }
        head.addEventListener('click', () => {
            if (state.picking) { if (state.picked.has(doc.id)) state.picked.delete(doc.id); else state.picked.add(doc.id); }
            else state.openId = open ? '' : doc.id;
            render();
        });
        item.append(head);
        if (open) {
            const body = el('div', 'record-body');
            if (clean(doc.note)) body.append(el('p', 'record-note', clean(doc.note)));
            if (clean(doc.body)) body.append(el('p', 'record-report', clean(doc.body)));
            if (doc.file_path) {
                const actions = el('div', 'record-actions');
                actions.append(iconButton('record-action is-main', 'view', 'Ansehen', button => view(doc, button)), iconButton('record-action', 'save', 'Speichern', button => save([doc], button)),
                    iconButton('record-action', 'share', 'Weiterleiten', button => share([doc], button)), iconButton('record-action', 'print', 'Drucken', button => print(doc, button)));
                body.append(actions);
            } else if (!clean(doc.body)) body.append(el('p', 'record-note', 'Zu diesem Eintrag gibt es keine Datei.'));
            item.append(body);
        }
        return item;
    }
    function render() {
        if (!root || !state) return;
        const shown = visible();
        // Arten mit Anzahl (zur Suche passend) – leere Arten erscheinen nicht.
        const matching = (() => { const group = state.group; state.group = 'alle'; const all = visible(); state.group = group; return all; })();
        const chips = root.querySelector('.record-groups');
        const chip = (key, label, count) => { const node = el('button', 'record-chip', `${label} `); node.type = 'button'; node.dataset.group = key; node.append(el('b', '', String(count))); node.setAttribute('aria-pressed', String(state.group === key)); node.addEventListener('click', () => { state.group = key; render(); }); return node; };
        chips.replaceChildren(chip('alle', 'Alle', matching.length), ...[...GROUPS, ['sonst', 'Sonstiges']].map(([key, label]) => [key, label, matching.filter(doc => groupOf(doc) === key).length]).filter(item => item[2] || item[0] === state.group).map(item => chip(...item)));
        root.querySelectorAll('[data-record-order]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.recordOrder === state.order)));
        const list = root.querySelector('.record-list');
        const parts = sections(shown);
        list.replaceChildren(...(shown.length ? parts.flatMap(part => [el('li', 'record-section', `${part.title}${parts.length > 1 || state.order !== 'datum' ? ` (${part.docs.length})` : ''}`), ...part.docs.map(entry)])
            : [el('li', 'record-empty', state.query ? 'Nichts gefunden. Prüfe die Schreibweise – oder wähle oben „Alle“.' : 'In diesem Bereich gibt es keine Unterlagen.')]));
        root.querySelector('.record-count').textContent = shown.length === state.docs.length ? plural(shown.length, 'Unterlage', 'Unterlagen') : `${shown.length} von ${plural(state.docs.length, 'Unterlage', 'Unterlagen')}`;
        // Mehrere auswählen
        const pickable = shown.filter(doc => doc.file_path);
        [...state.picked].forEach(id => { if (!pickable.some(doc => doc.id === id)) state.picked.delete(id); });
        root.dataset.picking = String(state.picking);
        root.querySelector('.record-pick').textContent = state.picking ? 'Auswahl beenden' : 'Mehrere auswählen';
        root.querySelector('.record-pick').hidden = pickable.length < 2 && !state.picking;
        const bar = root.querySelector('.record-bar');
        bar.hidden = !state.picking;
        bar.querySelector('.record-bar-count').textContent = state.picked.size ? `${state.picked.size} gewählt` : 'Tippe die Unterlagen an, die du brauchst.';
        bar.querySelectorAll('.record-action').forEach(node => { node.disabled = !state.picked.size; });
        bar.querySelector('.record-all').textContent = state.picked.size === pickable.length && pickable.length ? 'Keine' : 'Alle';
    }

    function close() {
        if (!root) return;
        document.removeEventListener('keydown', onKey, true);
        root.remove();
        root = null;
        state = null;
        cache.clear();
        cached = 0;
        document.documentElement.classList.remove('record-open');
    }
    function onKey(event) { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); close(); } }

    function open({ docs = [], patientNr = '', patientName = '', jobDoctor = '', toast = null } = {}) {
        if (root) close();
        let order = 'datum';
        try { const saved = localStorage.getItem(ORDER_KEY); if (ORDERS.some(([key]) => key === saved)) order = saved; } catch (error) { /* bleibt bei Datum */ }
        state = { docs: [...docs], patientNr: clean(patientNr), patientName: clean(patientName), jobDoctor: clean(jobDoctor), toast, group: 'alle', order, query: '', openId: '', picking: false, picked: new Set() };
        // Aufgeklappt beginnt die neueste Unterlage mit Datei – so sieht man gleich, was sich damit tun lässt.
        state.openId = ([...state.docs].sort(byDay).find(doc => doc.file_path) || {}).id || '';
        root = el('div', 'record-sheet');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', 'Akte des Patienten');
        const head = el('header', 'record-top');
        const back = el('button', 'record-close', '← Zurück');
        back.type = 'button';
        back.addEventListener('click', close);
        const titles = el('div', 'record-titles');
        titles.append(el('strong', '', state.patientName ? `Akte · ${state.patientName}` : 'Akte des Patienten'), el('span', '', [state.patientNr ? `Aktennummer ${state.patientNr}` : '', 'nur für diesen Auftrag – bitte vertraulich behandeln'].filter(Boolean).join(' · ')));
        head.append(back, titles);
        const tools = el('div', 'record-tools');
        const search = el('input', 'record-search');
        search.type = 'search';
        search.placeholder = 'Suchen: Arzt, Fachrichtung, Art, Jahr …';
        search.setAttribute('aria-label', 'In der Akte suchen');
        search.autocomplete = 'off';
        search.addEventListener('input', () => { state.query = search.value; render(); });
        const groups = el('div', 'record-groups');
        groups.setAttribute('role', 'group');
        groups.setAttribute('aria-label', 'Art der Unterlage');
        const line = el('div', 'record-line');
        const orders = el('div', 'record-orders');
        orders.setAttribute('role', 'group');
        orders.setAttribute('aria-label', 'Ordnen nach');
        ORDERS.forEach(([key, label]) => {
            const node = el('button', '', label);
            node.type = 'button';
            node.dataset.recordOrder = key;
            node.addEventListener('click', () => { state.order = key; try { localStorage.setItem(ORDER_KEY, key); } catch (error) { /* gilt dann bis zum Schließen */ } render(); });
            orders.append(node);
        });
        const pick = el('button', 'link-button record-pick', 'Mehrere auswählen');
        pick.type = 'button';
        pick.addEventListener('click', () => { state.picking = !state.picking; state.picked.clear(); render(); });
        line.append(el('span', 'record-line-label', 'Ordnen nach'), orders, el('span', 'record-count'), pick);
        tools.append(search, groups, line);
        const list = el('ul', 'record-list');
        const bar = el('div', 'record-bar');
        bar.hidden = true;
        const all = el('button', 'link-button record-all', 'Alle');
        all.type = 'button';
        all.addEventListener('click', () => { const pickable = visible().filter(doc => doc.file_path); if (state.picked.size === pickable.length) state.picked.clear(); else pickable.forEach(doc => state.picked.add(doc.id)); render(); });
        const chosen = () => state.docs.filter(doc => state.picked.has(doc.id));
        bar.append(el('span', 'record-bar-count'), all, iconButton('record-action', 'save', 'Speichern', button => save(chosen(), button)), iconButton('record-action is-main', 'share', 'Weiterleiten', button => share(chosen(), button)));
        root.append(head, tools, list, bar);
        document.body.append(root);
        document.documentElement.classList.add('record-open');
        document.addEventListener('keydown', onKey, true);
        render();
        back.focus({ preventScroll: true });
    }

    return { open, close, groupOf, state: () => state };
})();
