// Dolmetscher-Portal · Neuen Termin melden: Der Dolmetscher bringt aus der Praxis oder Klinik einen neuen Termin mit.
// Es wird eins nach dem anderen gefragt: 1 Patient (zuerst die Nummer) · 2 Datum und Uhrzeit · 3 Krankenhaus/Praxis, Ort,
// Arzt · 4 wofür · 5 Kostenübernahme oder Selbstzahler · 6 Terminzettel als Scan (Nachweis) und Kontrolle.
// Das Portal lernt mit: Krankenhäuser, Orte und Ärzte aus allen Meldungen und Terminlisten werden beim Tippen
// vorgeschlagen; Patienten nur aus den eigenen Aufträgen und eigenen Meldungen (Datenschutz).
// Das Büro sieht den Termin auf der Seite „Neue Termine“.
// Gehört zu portalApp.js (Schnittstelle window.PortalCore).
window.PortalAppointments = (function () {
    const core = window.PortalCore;
    if (!core) return null;
    const { client, toast, el } = core;
    const $ = id => document.getElementById(id);
    if (!$('apptForm')) return null;
    const today = () => TerminCloud.todayIso();
    const dayText = iso => iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
    const PAYER = { selbstzahler: 'Selbstzahler', kostenuebernahme: 'Kostenübernahme', unbekannt: 'Kosten unklar' };
    const MAX_PDF_BYTES = 19 * 1024 * 1024;
    let mine = [];
    let slip = null;          // gescannter Terminzettel: { blob, width, height }
    let editing = null;       // gemeldeter Termin, der gerade geändert wird (nur solange „neu“)
    let payer = '';           // 'kostenuebernahme' | 'selbstzahler' | 'unbekannt'
    let learned = [];         // gelernte Orte: [{ place, city, doctor, uses }]
    let patients = [];        // bekannte Patienten aus eigenen Aufträgen und Meldungen: [{ nr, name }]
    let cityAuto = '';        // Ort, den ein Vorschlag eingetragen hat (darf vom nächsten Vorschlag ersetzt werden)
    const STEPS = 6;
    const SUGGEST_KEY = 'terminTool.portal.apptSuggest';
    const fold = text => String(text ?? '').toLocaleLowerCase('de-DE').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/\s+/g, ' ').trim();

    // ---------- Liste der eigenen Meldungen ----------
    async function load() {
        const profile = core.profile();
        if (!profile) return;
        const { data, error } = await client.from('tt_new_appointments').select('*').eq('reporter_id', profile.id).order('created_at', { ascending: false }).limit(40);
        mine = error ? [] : data;
        $('apptMissing').hidden = !error || !/does not exist|schema cache|could not find/i.test(error.message || '');
        renderList();
    }

    function renderList() {
        const list = $('apptList');
        if (!mine.length) { list.replaceChildren(core.emptyItem('Du hast noch keinen neuen Termin gemeldet.')); return; }
        list.replaceChildren(...mine.map(item => {
            const entry = el('li', 'directory-entry damage-entry sent-doc');
            const text = el('span', 'directory-entry-name');
            text.append(el('strong', '', [item.patient_nr ? `Patient ${item.patient_nr}` : '', item.patient_name].filter(Boolean).join(' · ') || 'Patient'),
                el('small', '', [dayText(item.date), item.time ? `${String(item.time).slice(0, 5)} Uhr` : '', item.place, item.city].filter(Boolean).join(' · ')),
                el('small', '', [PAYER[item.payer] || '', item.file_path ? 'mit Terminzettel' : 'ohne Terminzettel'].filter(Boolean).join(' · ')));
            const side = el('span', 'vehicle-entry-actions');
            const state = el('span', 'status-pill', item.status === 'eingetragen' ? 'eingetragen' : 'gemeldet');
            state.dataset.status = item.status === 'eingetragen' ? 'erledigt' : 'in Arbeit';
            side.append(state);
            if (item.status === 'neu') {
                const edit = el('button', 'button-quiet', 'Ändern');
                edit.type = 'button';
                edit.addEventListener('click', () => open(item));
                const remove = el('button', 'button-quiet-danger', 'Löschen');
                remove.type = 'button';
                remove.addEventListener('click', async () => {
                    if (remove.dataset.armed !== 'yes') { remove.dataset.armed = 'yes'; remove.textContent = 'Wirklich löschen?'; window.setTimeout(() => { remove.dataset.armed = ''; remove.textContent = 'Löschen'; }, 4000); return; }
                    remove.disabled = true;
                    const { error } = await client.from('tt_new_appointments').delete().eq('id', item.id);
                    if (error) { toast(TerminCloud.germanError(error), 'error'); remove.disabled = false; return; }
                    if (item.file_path) await client.storage.from('dokumente').remove([item.file_path]).catch(() => null);
                    toast('Meldung gelöscht.', 'success');
                    await load();
                });
                side.append(edit, remove);
            }
            entry.append(text, side);
            return entry;
        }));
    }

    // ---------- Vorschläge: das Portal lernt mit ----------
    // Krankenhäuser, Praxen, Orte, Ärzte: aus der Datenbank (alle Meldungen + Terminlisten), auf dem Handy zwischengespeichert.
    function readLearned() {
        try { const saved = JSON.parse(localStorage.getItem(SUGGEST_KEY) || '[]'); return Array.isArray(saved) ? saved : []; } catch (error) { return []; }
    }
    async function loadSuggestions() {
        if (!learned.length) learned = readLearned();
        const { data, error } = await client.rpc('tt_appointment_suggestions');
        // Ohne die Datenbank-Funktion (Update 18 fehlt) lernt das Portal wenigstens aus den eigenen Meldungen.
        const rows = !error && Array.isArray(data) ? data : mine.filter(item => item.place).map(item => ({ place: item.place, city: item.city || '', doctor: item.doctor || '', uses: 1 }));
        if (!error || !learned.length) learned = rows.map(row => ({ place: String(row.place || '').trim(), city: String(row.city || '').trim(), doctor: String(row.doctor || '').trim(), uses: Number(row.uses) || 1 })).filter(row => row.place);
        if (!error) { try { localStorage.setItem(SUGGEST_KEY, JSON.stringify(learned.slice(0, 400))); } catch (storageError) { /* voller Speicher: dann eben ohne Zwischenspeicher */ } }
    }

    // Patienten nur aus den eigenen Aufträgen (neueste zuerst) und den eigenen Meldungen.
    function knownPatients() {
        const seen = new Set();
        const list = [];
        const add = (nr, name) => {
            nr = String(nr || '').trim(); name = String(name || '').trim();
            const key = `${fold(nr)}|${fold(name)}`;
            if ((!nr && !name) || seen.has(key)) return;
            seen.add(key);
            list.push({ nr, name });
        };
        core.jobs().filter(job => !job.cancelled).sort((left, right) => `${right.date} ${right.time}`.localeCompare(`${left.date} ${left.time}`)).forEach(job => {
            const facts = core.parseJobMessage(job.message)?.facts || {};
            add(facts['Aktennummer'], facts['Hauptpatient/in'] || facts['Patient/in']);
        });
        mine.forEach(item => add(item.patient_nr, item.patient_name));
        return list;
    }

    // Gewichtete Liste eindeutiger Werte: [{ value, uses, hint }]
    function tally(entries) {
        const map = new Map();
        entries.forEach(([value, uses, hint]) => {
            value = String(value || '').trim();
            if (!value) return;
            const key = fold(value);
            const item = map.get(key) || { value, uses: 0, hints: new Map() };
            item.uses += uses;
            if (hint) item.hints.set(hint, (item.hints.get(hint) || 0) + uses);
            map.set(key, item);
        });
        return [...map.values()].map(item => ({ value: item.value, uses: item.uses, hint: [...item.hints].sort((left, right) => right[1] - left[1])[0]?.[0] || '' })).sort((left, right) => right.uses - left.uses || left.value.localeCompare(right.value, 'de'));
    }
    // Treffer: Anfang des Textes zuerst, dann Wortanfang, dann irgendwo im Text. Ohne Eingabe: die häufigsten.
    function matches(items, query, keys = item => [item.value]) {
        const needle = fold(query);
        if (!needle) return items;
        return items.map((item, index) => {
            let best = 0;
            keys(item).forEach(key => {
                const text = fold(key);
                if (!text) return;
                if (text === needle) best = Math.max(best, 4);
                else if (text.startsWith(needle)) best = Math.max(best, 3);
                else if (text.split(/[\s,./()-]+/).some(word => word.startsWith(needle))) best = Math.max(best, 2);
                else if (text.includes(needle)) best = Math.max(best, 1);
            });
            return { item, best, index };
        }).filter(entry => entry.best).sort((left, right) => right.best - left.best || left.index - right.index).map(entry => entry.item);
    }

    const DESCRIPTION_STARTERS = ['Kontrolle', 'Nachsorge', 'Erstgespräch', 'Besprechung der Befunde', 'Blutabnahme', 'MRT', 'CT', 'Röntgen', 'Ultraschall', 'OP-Vorbereitung', 'Operation', 'Stationäre Aufnahme', 'Physiotherapie', 'Verbandswechsel'];
    const SUGGEST = {
        apptPatientNr: {
            box: 'apptPatientSuggest', max: 6, empty: 'Aus deinen Aufträgen:',
            list: query => matches(patients.filter(item => item.nr), query, item => [item.nr, item.name]).map(item => ({ value: item.nr, label: [item.nr, item.name].filter(Boolean).join(' · '), data: item })),
            pick: entry => { $('apptPatientNr').value = entry.data.nr; $('apptPatientName').value = entry.data.name; }
        },
        apptPatientName: {
            box: 'apptNameSuggest', max: 5, typedOnly: true,
            list: query => matches(patients.filter(item => item.name), query, item => [item.name]).map(item => ({ value: item.name, label: [item.name, item.nr].filter(Boolean).join(' · '), data: item })),
            pick: entry => { $('apptPatientName').value = entry.data.name; if (entry.data.nr && !$('apptPatientNr').value.trim()) $('apptPatientNr').value = entry.data.nr; }
        },
        apptPlace: {
            box: 'apptPlaceSuggest', max: 6, empty: 'Häufig:',
            list: query => matches(tally(learned.map(row => [row.place, row.uses, row.city])), query).map(item => ({ value: item.value, label: item.value, small: item.hint, data: item })),
            pick: entry => {
                $('apptPlace').value = entry.value;
                // Der Ort kommt mit, wenn das Feld leer ist oder der vorige Vorschlag ihn eingetragen hat.
                if (entry.data.hint && (!$('apptCity').value.trim() || $('apptCity').value.trim() === cityAuto)) { $('apptCity').value = entry.data.hint; cityAuto = entry.data.hint; }
            }
        },
        apptCity: {
            box: 'apptCitySuggest', max: 5, typedOnly: true,
            list: query => matches(tally(learned.map(row => [row.city, row.uses])), query).map(item => ({ value: item.value, label: item.value })),
            pick: entry => { $('apptCity').value = entry.value; cityAuto = ''; }
        },
        apptDoctor: {
            box: 'apptDoctorSuggest', max: 6, empty: 'Bekannt:',
            // Ärzte des gewählten Krankenhauses zuerst (zehnfach gewichtet), danach alle anderen.
            list: query => {
                const place = fold($('apptPlace').value);
                return matches(tally([...learned.filter(row => row.doctor).map(row => [row.doctor, row.uses * (place && fold(row.place) === place ? 10 : 1), row.place]), ...mine.filter(item => item.doctor).map(item => [item.doctor, 1, item.place])]), query)
                    .map(item => ({ value: item.value, label: item.value, small: place && fold(item.hint) === place ? '' : item.hint }));
            },
            pick: entry => { $('apptDoctor').value = entry.value; }
        },
        apptDescription: {
            box: 'apptDescriptionSuggest', max: 10, empty: 'Antippen zum Übernehmen:', keepOpen: true,
            // Eigene frühere (kurze) Beschreibungen zählen stärker als die festen Beispiele.
            list: () => {
                const text = fold($('apptDescription').value);
                return tally([...mine.filter(item => item.description && item.description.length <= 50).map(item => [item.description, 3]), ...DESCRIPTION_STARTERS.map((value, index) => [value, 1 - index / 100])])
                    .filter(item => !text.includes(fold(item.value))).map(item => ({ value: item.value, label: item.value }));
            },
            pick: entry => {
                const field = $('apptDescription');
                const now = field.value.trim();
                field.value = now ? `${now}${/[,;:–-]$/.test(now) ? ' ' : ', '}${entry.value}` : entry.value;
            }
        }
    };

    function renderSuggest(id) {
        const setup = SUGGEST[id];
        const field = $(id);
        const box = $(setup.box);
        const query = setup.keepOpen ? '' : field.value.trim();
        let entries = (setup.typedOnly && !query) ? [] : setup.list(query);
        // Steht der Vorschlag schon genau so im Feld, braucht ihn niemand mehr.
        if (!setup.keepOpen) entries = entries.filter(entry => fold(entry.value) !== fold(query) || (id === 'apptPatientNr' && entry.data.name && fold(entry.data.name) !== fold($('apptPatientName').value)));
        entries = entries.slice(0, setup.max);
        box.hidden = !entries.length;
        if (!entries.length) { box.replaceChildren(); return; }
        const chips = entries.map(entry => {
            const chip = el('button', 'suggest-chip');
            chip.type = 'button';
            chip.append(el('span', '', entry.label));
            if (entry.small) chip.append(el('small', '', entry.small));
            chip.addEventListener('click', () => {
                setup.pick(entry);
                Object.keys(SUGGEST).forEach(renderSuggest);
                if (id === 'apptDescription') field.focus({ preventScroll: true });
                showWhen();
            });
            return chip;
        });
        box.replaceChildren(el('span', 'suggest-title', query || !setup.empty ? 'Vorschläge:' : setup.empty), ...chips);
    }
    Object.keys(SUGGEST).forEach(id => {
        $(id).addEventListener('input', () => { if (id === 'apptCity') cityAuto = ''; renderSuggest(id); if (id === 'apptPlace') renderSuggest('apptDoctor'); });
        $(id).addEventListener('focus', () => renderSuggest(id));
    });
    // Bekannte Patientennummer: der Name kommt von selbst, solange das Namensfeld leer ist.
    $('apptPatientNr').addEventListener('change', () => {
        const nr = fold($('apptPatientNr').value);
        const hits = patients.filter(item => item.nr && fold(item.nr) === nr && item.name);
        if (nr && hits.length === 1 && !$('apptPatientName').value.trim()) { $('apptPatientName').value = hits[0].name; renderSuggest('apptPatientNr'); }
    });

    // ---------- Schritte ----------
    const wizard = core.makeWizard('appt', STEPS, () => core.goTo('appts'));
    const value = id => $(id).value.trim();
    const PAYER_CHOICES = [['kostenuebernahme', 'Kostenübernahme (KÜ)'], ['selbstzahler', 'Selbstzahler (SZ)'], ['unbekannt', 'Weiß ich nicht']];
    function renderPayer() {
        core.choiceButtons($('apptPayerChoices'), PAYER_CHOICES, picked => { payer = picked; window.setTimeout(() => showStep(6), 160); });
        $('apptPayerChoices').querySelectorAll('.choice-button').forEach(button => button.classList.toggle('is-picked', button.dataset.value === payer));
    }

    function showWhen() {
        const text = $('apptWhenText');
        const date = value('apptDate');
        text.hidden = !date;
        if (!date) return;
        const days = Math.round((new Date(`${date}T00:00:00`) - new Date(`${today()}T00:00:00`)) / 86400000);
        const distance = days === 0 ? 'heute' : days === 1 ? 'morgen' : days > 1 ? `in ${days} Tagen` : 'liegt in der Vergangenheit';
        text.textContent = `${new Date(`${date}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}${value('apptTime') ? ` um ${value('apptTime')} Uhr` : ''} – ${distance}`;
        text.dataset.kind = days < 0 ? 'warn' : '';
    }
    ['apptDate', 'apptTime'].forEach(id => $(id).addEventListener('input', showWhen));

    // Prüft einen Schritt; bei einem Fehler erklärt eine Einblendung, was fehlt.
    function checkStep(step) {
        if (step === 1) {
            if (!value('apptPatientNr')) return ['Bitte trag zuerst die Patientennummer ein.', '#apptPatientNr'];
            if (value('apptPatientName').length < 2) return ['Bitte trag den Namen des Patienten ein.', '#apptPatientName'];
        } else if (step === 2) {
            if (!value('apptDate')) return ['Bitte trag das Datum des Termins ein.', '#apptDate'];
            if (value('apptDate') < today()) return ['Der Termin liegt in der Vergangenheit. Bitte prüfe das Datum.', '#apptDate'];
            if (!value('apptTime')) return ['Bitte trag die Uhrzeit ein.', '#apptTime'];
        } else if (step === 3) {
            if (!value('apptPlace')) return ['Bitte trag das Krankenhaus oder die Praxis ein.', '#apptPlace'];
            if (value('apptDoctor').length < 2) return ['Bitte trag den Arzt oder die Abteilung ein.', '#apptDoctor'];
        } else if (step === 4) {
            if (value('apptDescription').length < 3) return ['Bitte schreib kurz, wofür der Termin ist.', '#apptDescription'];
        } else if (step === 5) {
            if (!payer) return ['Bitte wähle: Kostenübernahme oder Selbstzahler.', '#apptPayerChoices'];
        }
        return null;
    }

    const SUMMARY = [
        [1, 'Patient', () => [value('apptPatientNr'), value('apptPatientName')].filter(Boolean).join(' · ')],
        [2, 'Termin', () => value('apptDate') ? `${dayText(value('apptDate'))}${value('apptTime') ? ` · ${value('apptTime')} Uhr` : ''}` : ''],
        [3, 'Wo', () => [value('apptPlace'), value('apptCity')].filter(Boolean).join(', ')],
        [3, 'Arzt', () => value('apptDoctor')],
        [4, 'Wofür', () => value('apptDescription')],
        [5, 'Kosten', () => PAYER[payer] || '']
    ];
    function renderSummary() {
        $('apptSummary').replaceChildren(...SUMMARY.map(([step, label, read]) => {
            const row = el('div', 'appt-summary-row');
            const text = read();
            const change = el('button', 'link-button', 'ändern');
            change.type = 'button';
            change.setAttribute('aria-label', `${label} ändern`);
            change.addEventListener('click', () => showStep(step));
            const shown = el('dd', '', text || 'fehlt noch');
            if (!text) shown.dataset.missing = 'ja';
            row.append(el('dt', '', label), shown, change);
            return row;
        }));
    }

    function showStep(step) {
        wizard.show(step);
        decorate(step);
    }
    // Der „Zurück“-Knopf des Assistenten blättert selbst; danach wird der Schritt hier frisch gefüllt.
    $('apptBack').addEventListener('click', () => { if (core.view() === 'apptNew') decorate(wizard.step); });
    function decorate(step) {
        if (step === 5) renderPayer();
        if (step === 6) renderSummary();
        showWhen();
        Object.keys(SUGGEST).forEach(renderSuggest);
        // Auf dem Handy öffnet sich die Tastatur gleich im richtigen Feld (nicht beim Datum: dort stört der Kalender).
        const first = { 1: 'apptPatientNr', 3: 'apptPlace', 4: 'apptDescription' }[step];
        if (first && !$(first).value) window.setTimeout(() => { if (wizard.step === step && core.view() === 'apptNew') $(first).focus({ preventScroll: true }); }, 80);
    }
    function next() {
        const problem = checkStep(wizard.step);
        if (problem) { toast(problem[0], 'error', problem[1]); return; }
        // Beim Ändern geht es nach der Korrektur gleich zurück zur Kontrolle.
        showStep(editing ? STEPS : Math.min(STEPS, wizard.step + 1));
    }
    document.querySelectorAll('[data-appt-next]').forEach(button => button.addEventListener('click', next));
    // „Enter“ auf der Tastatur springt zum nächsten Feld bzw. zum nächsten Schritt – gesendet wird erst im letzten Schritt.
    $('apptForm').addEventListener('keydown', event => {
        if (event.key !== 'Enter' || event.target.tagName === 'TEXTAREA' || event.target.tagName === 'BUTTON' || event.target.type === 'checkbox') return;
        event.preventDefault();
        const fields = [...document.querySelectorAll(`[data-appt-step="${wizard.step}"] input:not([type="file"]):not([type="checkbox"])`)];
        const following = fields[fields.indexOf(event.target) + 1];
        if (following) following.focus(); else if (wizard.step < STEPS) next();
    });

    // ---------- Formular ----------
    function clearSlip() {
        slip = null;
        const image = $('apptSlipImage');
        if (image.src) URL.revokeObjectURL(image.src);
        image.removeAttribute('src');
        $('apptSlipPreview').hidden = true;
        $('apptSlipLabel').textContent = 'Terminzettel scannen';
    }

    function open(item = null) {
        editing = item && item.status === 'neu' ? item : null;
        $('apptForm').reset();
        clearSlip();
        payer = '';
        cityAuto = '';
        patients = knownPatients();
        $('apptDate').min = today();
        $('apptEditing').hidden = !editing;
        $('apptSubmit').textContent = editing ? 'Änderung senden' : 'Termin melden';
        if (editing) {
            $('apptPatientNr').value = editing.patient_nr || '';
            $('apptPatientName').value = editing.patient_name || '';
            $('apptDate').value = editing.date || '';
            $('apptTime').value = String(editing.time || '').slice(0, 5);
            $('apptPlace').value = editing.place || '';
            $('apptCity').value = editing.city || '';
            $('apptDoctor').value = editing.doctor || '';
            $('apptDescription').value = editing.description || '';
            payer = editing.payer || '';
            $('apptNoSlip').checked = Boolean(editing.no_slip);
        }
        $('apptSlipKept').hidden = !(editing && editing.file_path);
        showSlipState();
        if (core.view() !== 'apptNew') core.goTo('apptNew');
        showStep(editing ? STEPS : 1);
        loadSuggestions().then(() => { if (core.view() === 'apptNew') Object.keys(SUGGEST).forEach(renderSuggest); });
    }

    function showSlipState() {
        const none = $('apptNoSlip').checked;
        $('apptSlipScan').disabled = none;
        $('apptSlipBox').dataset.off = none ? 'ja' : '';
    }
    $('apptNoSlip').addEventListener('change', showSlipState);

    async function useSlipFile(original) {
        clearSlip();
        $('apptSlipState').hidden = false;
        $('apptSlipState').dataset.kind = 'busy';
        $('apptSlipState').textContent = 'Terminzettel wird zugeschnitten …';
        try {
            const scanned = window.DocScan ? await DocScan.process(original) : null;
            if (scanned?.blob) slip = { blob: scanned.blob, width: scanned.width, height: scanned.height, cropped: Boolean(scanned.cropped) };
        } catch (error) { /* weiter mit dem Foto */ }
        if (!slip) {
            const size = await new Promise(resolve => { const image = new Image(); image.onload = () => resolve([image.naturalWidth, image.naturalHeight]); image.onerror = () => resolve(null); image.src = URL.createObjectURL(original); });
            if (!size) { $('apptSlipState').dataset.kind = 'warn'; $('apptSlipState').textContent = 'Das Foto konnte nicht geöffnet werden. Bitte noch einmal scannen.'; return; }
            slip = { blob: original, width: size[0], height: size[1], cropped: false };
        }
        $('apptSlipImage').src = URL.createObjectURL(slip.blob);
        $('apptSlipInfo').textContent = slip.cropped ? 'Terminzettel erkannt und zugeschnitten – wird als PDF mitgeschickt.' : 'Ganzes Foto – wird als PDF mitgeschickt.';
        $('apptSlipPreview').hidden = false;
        $('apptSlipLabel').textContent = 'Terminzettel neu scannen';
        $('apptSlipState').hidden = true;
        $('apptSlipKept').hidden = true;
        $('apptNoSlip').checked = false;
        showSlipState();
    }
    $('apptSlipScan').addEventListener('click', async () => {
        if (!window.ScanCam?.supported()) { $('apptSlipFile').click(); return; }
        const result = await ScanCam.open({ title: 'Terminzettel scannen', single: true, onCapture: file => useSlipFile(file) });
        if (result.reason === 'galerie') $('apptSlipFile').click();
        else if (result.reason === 'fehler') { toast(`${result.error || 'Die Kamera konnte nicht gestartet werden.'} Wähle das Foto aus der Galerie oder nimm die Foto-App.`, 'info'); $('apptSlipFile').click(); }
    });
    $('apptSlipFile').addEventListener('change', () => { const file = $('apptSlipFile').files?.[0]; $('apptSlipFile').value = ''; if (file) useSlipFile(file); });

    $('apptForm').addEventListener('submit', async event => {
        event.preventDefault();
        const profile = core.profile();
        // Alle Schritte noch einmal prüfen; beim ersten Fehler dorthin springen.
        for (let step = 1; step < STEPS; step += 1) {
            const problem = checkStep(step);
            if (problem) { showStep(step); toast(problem[0], 'error', problem[1]); return; }
        }
        const keepOld = Boolean(editing?.file_path) && !slip && !$('apptNoSlip').checked;
        if (!slip && !keepOld && !$('apptNoSlip').checked) { toast('Bitte scanne den Terminzettel – oder kreuze an, dass es keinen gibt.', 'error', '#apptSlipScan'); return; }
        const button = $('apptSubmit');
        button.disabled = true;
        let uploaded = '';
        try {
            let filePath = keepOld ? editing.file_path : null;
            if (slip) {
                const pdf = await DocPdf.build({
                    pages: [{ blob: slip.blob, width: slip.width, height: slip.height, words: [] }],
                    title: `Terminzettel · ${[value('apptPatientNr'), value('apptPatientName')].filter(Boolean).join(' ')}`,
                    subject: `Neuer Termin am ${value('apptDate').split('-').reverse().join('.')} · ${value('apptPlace')}`, author: profile.full_name || '', keywords: ['Terminzettel', value('apptPatientNr')]
                });
                if (pdf.size > MAX_PDF_BYTES) throw new Error('Der Scan ist zu groß. Bitte noch einmal scannen.');
                uploaded = `${profile.id}/${Date.now()}-terminzettel-${value('apptPatientNr').replace(/[^0-9A-Za-z]/g, '') || 'patient'}.pdf`;
                const upload = await client.storage.from('dokumente').upload(uploaded, pdf, { contentType: 'application/pdf' });
                if (upload.error) throw upload.error;
                filePath = uploaded;
            }
            const fields = {
                patient_nr: value('apptPatientNr'), patient_name: value('apptPatientName'), date: value('apptDate'), time: value('apptTime'),
                place: value('apptPlace'), city: value('apptCity'), doctor: value('apptDoctor'), description: value('apptDescription'),
                payer, file_path: filePath, no_slip: !filePath
            };
            const result = editing
                ? await client.from('tt_new_appointments').update(fields).eq('id', editing.id)
                : await client.from('tt_new_appointments').insert({ ...fields, reporter_id: profile.id, reporter_name: profile.full_name || profile.email || '', status: 'neu' }).select('id').single();
            if (result.error) throw result.error;
            // Mitteilung aufs Handy der Einsatzleitung und des Sekretariats (ohne Patientennamen).
            const reportedId = editing ? editing.id : result.data?.id;
            if (reportedId) TerminCloud.callFunction?.({ action: 'appointment', appointmentId: reportedId, changed: Boolean(editing) })?.catch?.(() => null);
            // Ein ersetzter Terminzettel wird nicht mehr gebraucht.
            if (editing?.file_path && editing.file_path !== filePath) await client.storage.from('dokumente').remove([editing.file_path]).catch(() => null);
            uploaded = '';
            const changed = Boolean(editing);
            editing = null;
            clearSlip();
            await load();
            await core.showSuccess(changed ? 'Änderung gesendet' : 'Termin gemeldet', `${fields.patient_nr} · ${dayText(fields.date)} · ${fields.time} Uhr`);
            toast('Das Büro sieht den Termin jetzt unter „Neue Termine“. Danke!', 'success');
            core.goTo('appts');
        } catch (error) {
            if (uploaded) await client.storage.from('dokumente').remove([uploaded]).catch(() => null);
            toast(/does not exist|schema cache|could not find/i.test(error?.message || '')
                ? 'Neue Termine sind in der Datenbank noch nicht eingerichtet (Update 18 fehlt). Bitte sag der Einsatzleitung Bescheid.'
                : `Nicht gesendet: ${TerminCloud.germanError(error)}`, 'error', '#apptSubmit');
        } finally {
            button.disabled = false;
        }
    });

    $('apptStart').addEventListener('click', () => open(null));
    $('homeNewAppt')?.addEventListener('click', () => open(null));

    return { load, open: () => load(), start: () => open(null) };
})();
