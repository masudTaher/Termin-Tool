// Seite „Ärzte & Standorte“: das Ärzteverzeichnis pflegen und sehen, zu welchen Ärzten aus den Terminlisten noch etwas fehlt.
(function () {
    const $ = id => document.getElementById(id);
    const client = typeof TerminCloud !== 'undefined' ? TerminCloud.client : null;
    let records = [];
    let query = '';
    let editingKey = null;

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };
    const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const shift = days => { const date = new Date(); date.setDate(date.getDate() + days); return iso(date); };

    function setStatus(message, kind = 'info') {
        const status = $('doctorStatus');
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    function button(className, text, onClick) {
        const node = el('button', className, text);
        node.type = 'button';
        node.addEventListener('click', onClick);
        return node;
    }

    function openForm(entry, previousKey) {
        editingKey = previousKey || null;
        $('doctorDialogTitle').textContent = previousKey ? 'Eintrag ändern' : 'Arzt eintragen';
        $('doctorName').value = entry?.name || '';
        $('doctorCity').value = entry?.city || '';
        $('doctorSpecialty').value = entry?.specialty || '';
        $('doctorBuilding').value = entry?.building || '';
        $('doctorHint').value = entry?.hint || '';
        $('doctorMap').value = entry?.map || '';
        updateSearchLink(entry);
        $('doctorDialog').showModal();
        (entry?.name ? $('doctorSpecialty') : $('doctorName')).focus();
    }
    function updateSearchLink(extra) {
        const item = { name: $('doctorName').value, city: $('doctorCity').value, street: extra?.street || '', zip: extra?.zip || '' };
        $('doctorSearchLink').href = ArztVerzeichnis.searchUrl(item);
        $('doctorSearchLink').hidden = !item.name.trim();
    }
    ['doctorName', 'doctorCity'].forEach(id => $(id).addEventListener('input', () => updateSearchLink()));

    function render() {
        const list = ArztVerzeichnis.read();
        // 1 · Hier fehlt noch etwas
        const missing = ArztVerzeichnis.missing(records, list);
        $('doctorMissingCount').textContent = String(missing.length);
        $('doctorCopy').disabled = !missing.length;
        const missingList = $('doctorMissing');
        missingList.replaceChildren();
        if (!missing.length) missingList.append(el('li', 'directory-empty', records.length ? 'Alles vollständig – zu jedem Arzt der Terminlisten steht die Fachrichtung im Verzeichnis.' : 'Noch keine Terminliste online – oder du bist nicht angemeldet.'));
        missing.forEach(item => {
            const row = el('li', 'doctor-row is-missing');
            const main = el('div', 'doctor-main');
            main.append(el('strong', 'doctor-name', item.name), el('span', 'doctor-sub', [ArztVerzeichnis.addressOf(item) || 'ohne Adresse', `${item.count} ${item.count === 1 ? 'Termin' : 'Termine'}`].join(' · ')));
            if (item.entry) main.append(el('span', 'doctor-sub', 'Im Verzeichnis, aber ohne Fachrichtung'));
            const actions = el('div', 'doctor-actions');
            const search = el('a', 'button-secondary fleet-end-button', 'Im Internet nachsehen');
            search.href = ArztVerzeichnis.searchUrl(item);
            search.target = '_blank';
            search.rel = 'noopener';
            actions.append(search, button('button-primary fleet-end-button', 'Eintragen', () => openForm({ ...(item.entry || {}), name: item.entry?.name || item.name, city: item.entry?.city || item.city, street: item.street, zip: item.zip }, item.entry ? ArztVerzeichnis.keyOf(item.entry.name, item.entry.city) : null)));
            row.append(main, actions);
            missingList.append(row);
        });

        // 2 · Verzeichnis
        const fold = text => String(text || '').toLocaleLowerCase('de');
        const shown = list.filter(item => !query || fold([item.name, item.city, item.specialty, item.building, item.hint].join(' ')).includes(fold(query)));
        $('doctorListCount').textContent = String(list.length);
        const box = $('doctorList');
        box.replaceChildren();
        if (!shown.length) box.append(el('li', 'directory-empty', list.length ? 'Nichts passt zur Suche.' : 'Das Verzeichnis ist noch leer. Trage oben den ersten Arzt ein – oder lass die KI die Liste ergänzen.'));
        shown.forEach(item => {
            const key = ArztVerzeichnis.keyOf(item.name, item.city);
            const row = el('li', 'doctor-row');
            const main = el('div', 'doctor-main');
            main.append(el('strong', 'doctor-name', [item.name, item.city].filter(Boolean).join(' · ')));
            const facts = el('div', 'doctor-facts');
            if (item.specialty) facts.append(el('span', 'doctor-chip', item.specialty));
            if (item.building) facts.append(el('span', 'doctor-fact', item.building));
            if (item.hint) facts.append(el('span', 'doctor-sub', item.hint));
            if (!item.specialty) facts.append(el('span', 'doctor-sub', 'Fachrichtung fehlt'));
            main.append(facts);
            const actions = el('div', 'doctor-actions');
            if (item.map) { const map = el('a', 'button-secondary fleet-end-button', 'Karte'); map.href = item.map; map.target = '_blank'; map.rel = 'noopener'; actions.append(map); }
            actions.append(button('button-quiet', 'Ändern', () => openForm(item, key)), button('button-quiet-danger', 'Löschen', async () => {
                if (!await confirmDialog(`${item.name}${item.city ? ` (${item.city})` : ''} aus dem Verzeichnis löschen?`, 'Löschen')) return;
                ArztVerzeichnis.remove(key);
                render();
                window.syncSettingsNow?.();
                showToast('Eintrag gelöscht', 'success', { actionLabel: 'Rückgängig', onAction: () => { ArztVerzeichnis.save(item); render(); window.syncSettingsNow?.(); } });
            }));
            row.append(main, actions);
            box.append(row);
        });
    }
    window.renderDoctorDirectory = render;

    $('doctorAdd').addEventListener('click', () => openForm(null, null));
    $('doctorCancel').addEventListener('click', () => $('doctorDialog').close());
    $('doctorSearch').addEventListener('input', () => { query = $('doctorSearch').value.trim(); render(); });
    $('doctorForm').addEventListener('submit', event => {
        event.preventDefault();
        const entry = { name: $('doctorName').value, city: $('doctorCity').value, specialty: $('doctorSpecialty').value, building: $('doctorBuilding').value, hint: $('doctorHint').value, map: $('doctorMap').value, source: 'Büro' };
        if (!ArztVerzeichnis.normName(entry.name)) { showToast('Bitte den Namen des Arztes eintragen.', 'error'); $('doctorName').focus(); return; }
        if (entry.map.trim() && !/^https?:\/\//i.test(entry.map.trim())) { showToast('Der Karten-Link muss mit https:// beginnen.', 'error'); $('doctorMap').focus(); return; }
        if (!ArztVerzeichnis.save(entry, editingKey)) { showToast('Der Eintrag konnte nicht gespeichert werden.', 'error'); return; }
        $('doctorDialog').close();
        render();
        window.syncSettingsNow?.();
        showToast('Gespeichert – steht ab jetzt in jedem neuen Auftrag zu diesem Arzt', 'success');
    });

    // Liste für die KI: nur Ärzte und Adressen – keine Patienten, keine Termine.
    $('doctorCopy').addEventListener('click', async () => {
        const missing = ArztVerzeichnis.missing(records);
        const text = `Bitte recherchiere zu diesen Ärzten/Praxen die Fachrichtung und den genauen Standort (Gebäude, Eingang, Etage). Antwort: eine Zeile je Arzt im Format\nName | Ort | Fachrichtung | Gebäude / Standort | Hinweis zum Weg | Karten-Link\n\n${ArztVerzeichnis.exportText(missing)}`;
        try { await navigator.clipboard.writeText(text); showToast(`${missing.length} ${missing.length === 1 ? 'Arzt' : 'Ärzte'} kopiert – jetzt in den Chat mit der KI einfügen`, 'success'); }
        catch (error) { $('doctorImportTitle').textContent = 'Liste für die KI (bitte markieren und kopieren)'; $('doctorImportText').value = text; $('doctorImportSave').hidden = true; $('doctorImportInfo').textContent = ''; $('doctorImportDialog').showModal(); $('doctorImportText').select(); }
    });
    $('doctorPaste').addEventListener('click', () => {
        $('doctorImportTitle').textContent = 'Ergebnis der KI einfügen';
        $('doctorImportText').value = '';
        $('doctorImportInfo').textContent = '';
        $('doctorImportSave').hidden = false;
        $('doctorImportDialog').showModal();
        $('doctorImportText').focus();
    });
    $('doctorImportText').addEventListener('input', () => {
        if ($('doctorImportSave').hidden) return;
        const count = ArztVerzeichnis.parseImport($('doctorImportText').value).length;
        $('doctorImportInfo').textContent = $('doctorImportText').value.trim() ? `${count} ${count === 1 ? 'Eintrag' : 'Einträge'} erkannt` : '';
    });
    $('doctorImportCancel').addEventListener('click', () => $('doctorImportDialog').close());
    $('doctorImportSave').addEventListener('click', () => {
        const entries = ArztVerzeichnis.parseImport($('doctorImportText').value);
        if (!entries.length) { showToast('Keine Zeile im Format „Name | Ort | Fachrichtung | …“ erkannt.', 'error'); return; }
        const before = ArztVerzeichnis.read();
        ArztVerzeichnis.importEntries(entries);
        $('doctorImportDialog').close();
        render();
        window.syncSettingsNow?.();
        showToast(`${entries.length} ${entries.length === 1 ? 'Eintrag' : 'Einträge'} übernommen – bitte kurz prüfen`, 'success', { actionLabel: 'Rückgängig', onAction: () => { ArztVerzeichnis.write(before); render(); window.syncSettingsNow?.(); } });
    });

    async function load() {
        render();
        if (!client) return;
        let profile = null;
        try { profile = await TerminCloud.getProfile(); } catch (error) { /* wie nicht angemeldet */ }
        if (!TerminCloud.isStaff(profile)) { setStatus('Nicht angemeldet: Das Verzeichnis gilt dann nur auf diesem Gerät, und die Liste „Hier fehlt noch etwas“ bleibt leer. Anmelden auf der Seite „Team“.', 'info'); return; }
        const { data, error } = await client.from('tt_days').select('date,records').gte('date', shift(-14)).lte('date', shift(30));
        if (error) { setStatus(TerminCloud.germanError(error), 'error'); return; }
        records = data.flatMap(day => Array.isArray(day.records) ? day.records : []);
        render();
    }
    load();
})();
