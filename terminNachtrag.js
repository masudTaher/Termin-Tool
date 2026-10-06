// Live-Tracking · „Termine nachtragen“: Die Kollegen tragen manche Termine erst spät ein. Mit diesem Knopf wird die
// aktualisierte Excel-Datei aus FileMaker noch einmal geladen – eigener Knopf, damit nichts durcheinander kommt.
// Es kommen nur NEUE Termine dazu, die zu Bonn gehören (dieselben Filterregeln wie im Schritt „Filtern“). Alles, was
// schon in der Liste steht (Dolmetscher, Autos, Status, gesendete Aufträge), bleibt unverändert. Vor dem Ergänzen
// zeigt eine Vorschau, was dazukommt; danach hilft „Rückgängig“.
// Gehört zu termineTrackingApp.js (gleiche Seite, nutzt deren Funktionen) und filterLogic.js.
(function () {
    const button = document.getElementById('nachtragButton');
    const input = document.getElementById('nachtragFile');
    if (!button || !input) return;

    const SKIP_KEY = 'terminTool.nachtrag.skip.v1';
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const fold = value => String(value ?? '').toLocaleLowerCase('de-DE').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
    const clock = record => normalizeTerminUhrzeit(record.Termin_Uhrzeit).slice(0, 5);
    const patientName = record => [record['Patienten Nr::Patienten_Vorname'], record['Patienten Nr::Patienten_Name']].map(value => String(value || '').trim()).filter(Boolean).join(' ');
    const patientKey = record => fold(record.Patient_Nr) || fold(patientName(record));
    const doctorKey = record => fold(record['Arzt Nr::Name']);
    // Derselbe Termin = derselbe Patient, dieselbe Uhrzeit, derselbe Arzt.
    const keyOf = record => `${patientKey(record)}|${clock(record)}|${doctorKey(record)}`;
    const placeOf = record => String(record['Arzt Nr::Ort'] || record['Arzt Nr::Stadt'] || record.Ort || record.Termin_Ort || record.Stadt || '').trim();
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
    const status = (message, kind = 'info') => { if (typeof showWorkflowStatus === 'function') showWorkflowStatus(message, kind); };
    const toast = (message, kind = 'info', options) => { if (typeof showToast === 'function') showToast(message, kind, options); };

    // Merkzettel je Tag: Termine, die bewusst nicht übernommen oder in der Liste gelöscht wurden – sie werden beim
    // nächsten Nachtragen nicht noch einmal vorgeschlagen (nur als Prüfsumme gespeichert, ohne Namen).
    const hash = text => { let value = 5381; for (let index = 0; index < text.length; index += 1) value = ((value << 5) + value + text.charCodeAt(index)) >>> 0; return value.toString(36); };
    function readSkip(day) {
        try { const saved = JSON.parse(localStorage.getItem(SKIP_KEY) || '{}'); return saved.day === day && Array.isArray(saved.keys) ? new Set(saved.keys) : new Set(); } catch (error) { return new Set(); }
    }
    function saveSkip(day, keys) {
        try { localStorage.setItem(SKIP_KEY, JSON.stringify({ day, keys: [...keys].slice(-400) })); } catch (error) { /* ohne Speicher: dann wird eben noch einmal gefragt */ }
    }
    const currentDay = () => {
        const days = [...new Set(trackingData.map(record => normalizeTerminDatum(record.Termin_Datum)).filter(Boolean))];
        return days.length === 1 ? days[0] : '';
    };
    // Wird beim Löschen eines Termins in der Liste aufgerufen (termineTrackingApp.js).
    window.noteDeletedTermin = termin => {
        const day = normalizeTerminDatum(termin?.Termin_Datum);
        if (!day || day !== currentDay()) return;
        const keys = readSkip(day);
        keys.add(hash(keyOf(termin)));
        saveSkip(day, keys);
    };

    button.addEventListener('click', () => {
        if (!trackingData.length) { toast('Es ist noch keine Terminliste geladen. Lade die Liste zuerst über „Filtern“.', 'error'); return; }
        if (!currentDay()) { toast('In deiner Liste stehen Termine von verschiedenen Tagen – Nachtragen geht nur für einen einzelnen Tag.', 'error'); return; }
        input.click();
    });

    input.addEventListener('change', () => {
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        if (typeof XLSX === 'undefined') { status('Die Excel-Funktion konnte nicht geladen werden. Bitte prüfe die Internetverbindung und lade die Seite erneut.', 'error'); return; }
        status(`${file.name} wird geprüft …`);
        const reader = new FileReader();
        reader.onerror = () => status('Die Excel-Datei konnte nicht gelesen werden. Bitte wähle sie erneut aus.', 'error');
        reader.onload = event => {
            try {
                const book = XLSX.read(new Uint8Array(event.target.result), { type: 'array' });
                const sheet = book.Sheets[book.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(sheet);
                compare(rows, file.name);
            } catch (error) {
                console.error('Fehler beim Einlesen der Excel-Datei:', error);
                status('Die Excel-Datei konnte nicht verarbeitet werden. Prüfe, ob es der aktuelle FileMaker-Export ist.', 'error');
            }
        };
        reader.readAsArrayBuffer(file);
    });

    // Vergleicht die neue Datei mit der Liste und zeigt die Vorschau.
    function compare(rows, fileName) {
        if (!Array.isArray(rows) || !rows.length) { status('Die Excel-Datei enthält keine Termine.', 'error'); toast('Die Excel-Datei enthält keine Termine.', 'error'); return; }
        const needed = ['Termin_Datum', 'Termin_Uhrzeit', 'Patient_Nr', 'Arzt Nr::Name'];
        const headers = new Set(rows.flatMap(row => Object.keys(row)));
        const missingHeaders = needed.filter(header => !headers.has(header));
        if (missingHeaders.length) {
            const message = `In der Datei fehlen benötigte Spalten: ${missingHeaders.join(', ')}. Bitte nimm den Export aus FileMaker.`;
            status(message, 'error'); toast(message, 'error');
            return;
        }
        const day = currentDay();
        const all = normalizeTerminRecords(rows);
        const sameDay = all.filter(record => normalizeTerminDatum(record.Termin_Datum) === day);
        const otherDays = [...new Set(all.map(record => normalizeTerminDatum(record.Termin_Datum)).filter(value => value && value !== day))];
        if (!sameDay.length) {
            const message = `Die Datei enthält keine Termine für den ${day}${otherDays.length ? ` (in der Datei: ${otherDays.slice(0, 3).join(', ')})` : ''}. Es wurde nichts geändert.`;
            status(message, 'error'); toast(message, 'error', { duration: 12000 });
            return;
        }
        // Die Filterregeln können sich seit dem Laden der Seite geändert haben (Abgleich zwischen den Geräten).
        if (typeof readFilterRules === 'function') filterRules = readFilterRules();

        // Was steht schon in der Liste? (Zählung je Termin – zwei gleiche Zeilen in der Datei sind zwei Termine.)
        const existing = new Map();
        trackingData.forEach(record => { const key = keyOf(record); existing.set(key, (existing.get(key) || 0) + 1); });
        const fileKeys = new Map();
        sameDay.forEach(record => { const key = keyOf(record); fileKeys.set(key, (fileKeys.get(key) || 0) + 1); });
        const skip = readSkip(day);

        const fresh = [];      // neu und gehört zu Bonn
        const skipped = [];    // neu, aber früher bewusst nicht übernommen oder gelöscht
        const foreign = [];    // neu, gehört laut Filterregeln nicht zu Bonn
        let known = 0;
        const left = new Map(existing);
        sameDay.forEach(record => {
            const key = keyOf(record);
            if (left.get(key) > 0) { left.set(key, left.get(key) - 1); known += 1; return; }
            const verdict = classifyTermin(record);
            const entry = { record, key, reason: verdict.reason };
            if (skip.has(hash(key))) skipped.push(entry);
            else if (verdict.keep) fresh.push(entry);
            else foreign.push(entry);
        });
        // In der Liste, aber nicht (mehr) in der Datei – nur zur Information, es wird nichts gelöscht.
        const seen = new Map();
        const gone = trackingData.filter(record => {
            const key = keyOf(record);
            seen.set(key, (seen.get(key) || 0) + 1);
            return seen.get(key) > (fileKeys.get(key) || 0);
        });
        // Wurde ein Termin vielleicht nur verschoben? (derselbe Patient beim selben Arzt, andere Uhrzeit)
        [...fresh, ...skipped].forEach(entry => {
            const moved = gone.find(record => patientKey(record) === patientKey(entry.record) && doctorKey(record) === doctorKey(entry.record) && clock(record) !== clock(entry.record));
            if (moved) entry.hint = `Vielleicht verschoben: In deiner Liste steht dieser Patient bei diesem Arzt um ${clock(moved)} Uhr. Der alte Termin bleibt stehen – bitte prüfen.`;
        });
        const byTime = (first, second) => compareTerminUhrzeit(first.record.Termin_Uhrzeit, second.record.Termin_Uhrzeit);
        [fresh, skipped, foreign].forEach(list => list.sort(byTime));

        const ours = known + fresh.length + skipped.length;
        status(`${fileName}: ${plural(sameDay.length, 'Termin', 'Termine')} für den ${day} geprüft – ${plural(fresh.length, 'neuer Termin', 'neue Termine')} für Bonn.`);
        if (!fresh.length && !skipped.length && !foreign.length && !gone.length) {
            toast(`Nichts nachzutragen: Alle ${plural(known, 'Termin steht', 'Termine stehen')} schon in deiner Liste.`, 'success', { duration: 9000 });
            return;
        }
        showPreview({ day, fileName, total: sameDay.length, ours, known, fresh, skipped, foreign, gone, otherDays });
    }

    // ---------- Vorschau ----------
    let dialog = null;
    function row(entry, checked) {
        const record = entry.record;
        const line = el('tr');
        const pick = el('td', 'nachtrag-pick');
        if (checked != null) {
            const box = el('input');
            box.type = 'checkbox';
            box.checked = checked;
            box.setAttribute('aria-label', `${clock(record)} Uhr · ${patientName(record) || record.Patient_Nr} übernehmen`);
            entry.box = box;
            pick.append(box);
        }
        const what = el('td');
        what.append(el('strong', '', String(record['Arzt Nr::Name'] || '–')));
        if (placeOf(record)) what.append(el('span', 'nachtrag-sub', placeOf(record)));
        const note = el('td', 'nachtrag-note');
        const remark = String(record.Bemerkung || '').replace(/\s+/g, ' ').trim();
        if (remark) note.append(el('span', '', remark.length > 110 ? `${remark.slice(0, 110)} …` : remark));
        if (entry.reason) note.append(el('span', 'nachtrag-sub', entry.reason));
        if (entry.hint) note.append(el('span', 'nachtrag-hint', entry.hint));
        line.append(pick, el('td', 'nachtrag-time', clock(record) || '–'), el('td', '', String(record.Patient_Nr ?? '')), el('td', '', patientName(record) || '–'), what, note);
        // Ein Klick irgendwo in die Zeile setzt den Haken.
        if (entry.box) line.addEventListener('click', event => { if (event.target !== entry.box) { entry.box.checked = !entry.box.checked; entry.box.dispatchEvent(new Event('change', { bubbles: true })); } });
        return line;
    }
    function table(entries, checked) {
        const wrap = el('div', 'nachtrag-table-wrap');
        const node = el('table', 'nachtrag-table');
        const head = el('thead');
        const headRow = el('tr');
        ['', 'Uhrzeit', 'Pat.-Nr.', 'Patient', 'Arzt · Ort', 'Bemerkung'].forEach(label => headRow.append(el('th', '', label)));
        head.append(headRow);
        const body = el('tbody');
        body.append(...entries.map(entry => row(entry, checked)));
        node.append(head, body);
        wrap.append(node);
        return wrap;
    }
    function fold_(title, hint, entries, checked) {
        const box = el('details', 'nachtrag-more');
        box.append(el('summary', '', title));
        if (hint) box.append(el('p', 'field-hint', hint));
        box.append(table(entries, checked));
        return box;
    }

    function showPreview(result) {
        dialog?.remove();
        dialog = el('dialog', 'confirm-dialog nachtrag-dialog');
        dialog.setAttribute('aria-labelledby', 'nachtragTitle');
        const title = el('h2', '', `Termine nachtragen · ${result.day}`);
        title.id = 'nachtragTitle';
        const summary = el('p', 'nachtrag-summary');
        summary.append(
            el('span', '', `${plural(result.total, 'Termin', 'Termine')} in der Datei`),
            el('span', '', `${plural(result.known, 'steht', 'stehen')} schon in deiner Liste`),
            el('strong', '', `${plural(result.fresh.length, 'neuer Termin', 'neue Termine')} für Bonn`)
        );
        dialog.append(title, summary);
        if (result.otherDays.length) dialog.append(el('p', 'field-hint', `Termine anderer Tage in der Datei (${result.otherDays.slice(0, 3).join(', ')}) wurden übersprungen.`));

        const selectable = [...result.fresh, ...result.skipped, ...result.foreign];
        if (result.fresh.length) {
            const head = el('div', 'nachtrag-head');
            head.append(el('h3', '', 'Neu – wird ergänzt'));
            if (result.fresh.length > 1) {
                const toggle = el('button', 'button-quiet', 'Alle abwählen');
                toggle.type = 'button';
                toggle.addEventListener('click', () => {
                    const on = result.fresh.some(entry => !entry.box.checked);
                    result.fresh.forEach(entry => { entry.box.checked = on; });
                    update();
                });
                head.append(toggle);
                result.toggle = toggle;
            }
            dialog.append(head, table(result.fresh, true));
        } else {
            dialog.append(el('p', 'nachtrag-none', 'Für Bonn ist kein neuer Termin dazugekommen.'));
        }
        if (result.skipped.length) dialog.append(fold_(`Früher nicht übernommen oder von dir gelöscht (${result.skipped.length})`, 'Diese Termine hast du beim letzten Nachtragen abgewählt oder in der Liste gelöscht. Mit Haken kommen sie doch dazu.', result.skipped, false));
        if (result.foreign.length) dialog.append(fold_(`Gehört laut Filterregeln nicht zu Bonn (${result.foreign.length})`, 'Diese Termine bleiben draußen. Mit Haken kannst du einzelne trotzdem übernehmen.', result.foreign, false));
        if (result.gone.length) dialog.append(fold_(`In deiner Liste, aber nicht mehr in der neuen Datei (${result.gone.length})`, 'Nur zur Information – es wird nichts gelöscht. Vielleicht wurde der Termin abgesagt, verschoben oder von dir selbst hinzugefügt.', result.gone.map(record => ({ record })), null));

        const problem = el('p', 'field-hint nachtrag-foot', 'Alles, was schon in deiner Liste steht, bleibt unverändert: Dolmetscher, Autos, Status und gesendete Aufträge.');
        const buttons = el('div', 'modal-buttons');
        const cancel = el('button', 'button-secondary', 'Abbrechen');
        cancel.type = 'button';
        const ok = el('button', 'button-primary', '');
        ok.type = 'button';
        buttons.append(cancel, ok);
        dialog.append(problem, buttons);
        document.body.append(dialog);

        const picked = () => selectable.filter(entry => entry.box?.checked);
        function update() {
            const count = picked().length;
            ok.disabled = !count;
            ok.textContent = count ? `${plural(count, 'Termin', 'Termine')} ergänzen` : 'Nichts ausgewählt';
            if (result.toggle) result.toggle.textContent = result.fresh.some(entry => !entry.box.checked) ? 'Alle auswählen' : 'Alle abwählen';
        }
        dialog.addEventListener('change', update);
        update();
        if (!selectable.length) { ok.hidden = true; cancel.textContent = 'Schließen'; }
        cancel.addEventListener('click', () => box.close());
        // Das Schließen wird erst kurz danach gemeldet – dann darf nur dieses Fenster entfernt werden, nicht ein inzwischen neu geöffnetes.
        const box = dialog;
        box.addEventListener('close', () => { box.remove(); if (dialog === box) dialog = null; });
        ok.addEventListener('click', () => { const chosen = picked(); box.close(); apply(result, chosen); });
        dialog.showModal();
        (result.fresh.length ? ok : cancel).focus();
    }

    // ---------- Ergänzen ----------
    function apply(result, chosen) {
        if (!chosen.length) return;
        // Der Tag darf sich inzwischen nicht geändert haben (z. B. „Tag abschließen“ auf einem anderen Gerät).
        if (currentDay() !== result.day) { toast('Die Terminliste hat sich inzwischen geändert. Bitte lade die Datei noch einmal über „Termine nachtragen“.', 'error'); return; }
        const stamp = Date.now().toString(36);
        const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        // Dieselbe Spaltenstruktur wie die Liste: fehlende Spalten leer, interne Felder frisch.
        const columns = Object.keys(trackingData[0] || {}).filter(header => !header.startsWith('_'));
        const added = ensureTrackingFields(chosen.map((entry, index) => ({
            ...Object.fromEntries(columns.filter(header => !['Status', 'Übersetzer', 'Rückmeldung', 'Fahrzeug', 'Losgefahren_um', 'Beendet_um', 'Sonderbetrag', 'Sondergrund', 'Anzahl_Termine'].includes(header)).map(header => [header, ''])),
            ...Object.fromEntries(Object.entries(entry.record).filter(([header]) => !header.startsWith('_'))),
            Status: 'offen', _src: `n${stamp}-${index}`, _nachtrag: time
        })));
        recordTrackingUndo(`${plural(added.length, 'Termin', 'Termine')} nachgetragen`);
        // Erste Zeile der Bemerkung = vorab eingetragener Dolmetscher (nur Namen aus der Dolmetscherliste).
        const remark = typeof assignInterpretersFromRemarks === 'function' ? assignInterpretersFromRemarks(added) : { assigned: 0, unknown: [] };
        trackingData.push(...added);
        updateAnzahlTermine(trackingData);
        sortTrackingDataByTime(trackingData);
        renderTrackingTable(trackingData);
        persistTerminRecords(trackingData, 'tracking', { filtered: trackingData });

        // Merkzettel: was neu war, aber abgewählt wurde, wird nicht noch einmal vorgeschlagen; was übernommen wurde, ist nicht mehr gemerkt.
        const skip = readSkip(result.day);
        result.fresh.filter(entry => !entry.box.checked).forEach(entry => skip.add(hash(entry.key)));
        chosen.forEach(entry => skip.delete(hash(entry.key)));
        saveSkip(result.day, skip);

        const names = remark.assigned ? ` ${plural(remark.assigned, 'Dolmetscher', 'Dolmetscher')} aus der Bemerkung eingetragen.` : '';
        status(`${plural(added.length, 'Termin', 'Termine')} nachgetragen (${time} Uhr). Die bisherigen ${trackingData.length - added.length} Termine sind unverändert.${names}`, 'success');
        toast(`${plural(added.length, 'Termin', 'Termine')} ergänzt – in der Tabelle mit „neu“ markiert.${names}`, 'success', { actionLabel: 'Rückgängig', onAction: undoLastTrackingChange, duration: 12000 });
        window.syncTrackingDayNow?.();
        const first = document.querySelector('#tableBody tr.is-nachtrag');
        first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    // Beim Abwählen in der Vorschau ohne Übernehmen (Abbrechen) wird nichts gemerkt – nur beim Ergänzen.
})();
