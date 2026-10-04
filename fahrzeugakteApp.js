// Fuhrpark: Zustand, Schäden mit Skizze, Meldungen und Verlauf je Fahrzeug – mit Archiv.
// Dazu: Tankkarten (nur der Admin gibt sie aus und nimmt sie zurück), Schäden selbst eintragen,
// fehlerhafte Meldungen löschen (nur Admin) und Kilometer einer Fahrt korrigieren.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const FUEL = window.TERMIN_CLOUD_CONFIG?.fuelLabels || ['Leer', '1/4', '1/2', '3/4', 'Voll'];
    const DAMAGE_STATUS = [['offen', 'Neu gemeldet'], ['bekannt', 'Altschaden'], ['in Arbeit', 'In Reparatur'], ['erledigt', 'Repariert (Archiv)']];
    let profile = null;
    let vehicles = [];
    let profiles = [];
    let damages = [];
    let alerts = [];
    let openHandovers = [];
    let takeoverNotes = [];
    let selectedId = null;
    let fileTab = 'current';
    let sketch = null;
    let fleetFilter = 'alle';
    let fuelCards = [];
    let fuelLog = [];
    let fuelReady = true;          // false: Tabellen fehlen noch (Update 10)
    let fileHandovers = [];
    const photoUrls = new Map();   // Fahrzeugfoto: Pfad → zeitlich begrenzte Adresse
    const DAMAGE_KINDS = window.TERMIN_CLOUD_CONFIG?.damageKinds || ['Kratzer', 'Schramme', 'Delle', 'Steinschlag', 'Unfall mit Bericht', 'Unfall ohne Bericht', 'Schiebetür defekt', 'Sonstiges'];
    const isAdmin = () => TerminCloud.isAdmin(profile);

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };
    const vehicleLabel = vehicle => [vehicle.plate, [vehicle.brand, vehicle.body].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    const formatKm = value => value == null ? '–' : `${Number(value).toLocaleString('de-DE')} km`;
    const formatDate = value => value ? new Date(value).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';
    const formatDateTime = value => value ? new Date(value).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–';
    const damageWhat = item => [item.category, item.description].filter((text, index, list) => text && list.indexOf(text) === index).join(' – ');
    const cleanText = value => value == null ? '–' : value ? 'sauber' : 'nicht sauber';
    const profileName = id => profiles.find(item => item.id === id)?.full_name || '';

    function setStatus(message, kind = 'info') {
        const status = $('fileStatus');
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    function pill(status, text) {
        const node = el('span', 'status-pill', text);
        node.dataset.status = status;
        return node;
    }

    async function refresh() {
        setStatus('');
        if (!client) { $('fileApp').hidden = true; setStatus('Die Verbindung zur Datenbank konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu.', 'error'); return; }
        try { profile = await TerminCloud.getProfile(true); } catch (error) { setStatus(error.message, 'error'); return; }
        if (!TerminCloud.isStaff(profile)) {
            $('fileApp').hidden = true;
            setStatus('Bitte melde dich zuerst auf der Seite „Team“ als Einsatzleitung an.', 'error');
            return;
        }
        await TerminCloud.syncFleet();
        const [vehicleResult, profileResult, damageResult, alertResult, handoverResult] = await Promise.all([
            client.from('tt_vehicles').select('*').order('plate'),
            client.from('tt_profiles').select('*').order('full_name'),
            client.from('tt_damages').select('*').order('created_at'),
            client.from('tt_alerts').select('*').order('created_at'),
            client.from('tt_handovers').select('*').is('end_time', null)
        ]);
        const [cardResult, cardLogResult] = await Promise.all([
            client.from('tt_fuel_cards').select('*').eq('active', true).order('number'),
            client.from('tt_fuel_card_log').select('*').order('created_at', { ascending: false }).limit(40)
        ]);
        fuelReady = !cardResult.error;
        fuelCards = cardResult.error ? [] : cardResult.data;
        fuelLog = cardLogResult.error ? [] : cardLogResult.data;
        const noteResult = await client.from('tt_handovers').select('*').eq('note_seen', false).order('created_at', { ascending: false }).limit(200);
        takeoverNotes = noteResult.error ? [] : noteResult.data.filter(item => item.start_note);
        const failed = [vehicleResult, profileResult, damageResult, alertResult, handoverResult].find(result => result.error);
        if (failed) {
            setStatus(`${TerminCloud.germanError(failed.error)} Falls Spalten oder Tabellen fehlen: supabase/update-2.sql im SQL Editor ausführen.`, 'error');
            return;
        }
        vehicles = vehicleResult.data.filter(vehicle => vehicle.active);
        profiles = profileResult.data;
        damages = damageResult.data;
        alerts = alertResult.data;
        openHandovers = handoverResult.data;
        $('fileApp').hidden = false;
        $('enableNotifications').hidden = !('Notification' in window) || Notification.permission !== 'default';
        renderInbox();
        renderFuel();
        renderGrid();
        loadPhotoUrls();
        if (selectedId && vehicles.some(vehicle => vehicle.id === selectedId)) await renderFile();
        else { selectedId = null; $('vehicleFile').hidden = true; }
        window.refreshCloudInbox?.();
    }

    // ---------- Fotos ----------
    async function showPhoto(path) {
        const url = await TerminCloud.photoUrl(path);
        if (!url) { showToast('Das Foto konnte nicht geladen werden.', 'error'); return; }
        $('photoDialogImage').src = url;
        $('photoDialog').showModal();
    }
    $('photoDialogClose').addEventListener('click', () => $('photoDialog').close());

    function photoButtons(paths) {
        const wrap = el('span', 'photo-buttons');
        paths.filter(Boolean).forEach((path, index) => {
            const button = el('button', 'button-secondary fleet-end-button', paths.length > 1 ? `Foto ${index + 1}` : 'Foto');
            button.type = 'button';
            button.addEventListener('click', () => showPhoto(path));
            wrap.append(button);
        });
        return wrap;
    }
    const damagePhotos = item => item.photo_paths?.length ? item.photo_paths : (item.photo_path ? [item.photo_path] : []);

    // ---------- Aktionen ----------
    async function setDamageStatus(item, status) {
        const { error } = await client.from('tt_damages').update({ status, resolved_at: status === 'erledigt' ? new Date().toISOString() : null }).eq('id', item.id);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        showToast(status === 'erledigt' ? 'Repariert – der Schaden liegt jetzt im Archiv' : status === 'in Arbeit' ? 'In Reparatur gegeben' : 'Status gespeichert', 'success');
        await refresh();
    }

    async function resolveAlert(item, resolved) {
        const { error } = await client.from('tt_alerts').update({
            status: resolved ? 'erledigt' : 'offen',
            resolved_at: resolved ? new Date().toISOString() : null,
            resolved_by: resolved ? (profile.full_name || '') : ''
        }).eq('id', item.id);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        showToast(resolved ? 'Meldung erledigt und archiviert' : 'Meldung wieder geöffnet', 'success');
        await refresh();
    }

    // Fehlerhafte Einträge ganz entfernen – das darf nur der Admin. Fotos werden mit gelöscht.
    function deleteButton(label, question, action) {
        const button = el('button', 'button-quiet-danger', 'Löschen');
        button.type = 'button';
        button.title = label;
        button.addEventListener('click', async () => {
            if (!await confirmDialog(question, 'Endgültig löschen')) return;
            button.disabled = true;
            const error = await action();
            if (error) { showToast(TerminCloud.germanError(error), 'error'); button.disabled = false; return; }
            showToast('Gelöscht', 'success');
            await refresh();
        });
        return button;
    }

    async function removeRow(table, item, paths) {
        const { data, error } = await client.from(table).delete().eq('id', item.id).select();
        if (error) return error;
        if (!data?.length) return new Error('Der Eintrag konnte nicht gelöscht werden. Löschen darf nur der Admin.');
        const files = (paths || []).filter(Boolean);
        if (files.length) await client.storage.from('schaeden').remove(files);
        return null;
    }
    const deleteDamage = item => deleteButton('Schaden löschen', `Diesen Schaden wirklich löschen?\n\n${item.zone || 'ohne Position'} · ${damageWhat(item)}\n\nDer Eintrag und seine Fotos sind danach weg – das lässt sich nicht rückgängig machen.`, () => removeRow('tt_damages', item, damagePhotos(item)));
    const deleteAlert = item => deleteButton('Meldung löschen', `Diese Meldung wirklich löschen?\n\n${item.kind}${item.note ? ` – ${item.note}` : ''}\n\nDas lässt sich nicht rückgängig machen.`, () => removeRow('tt_alerts', item, [item.photo_path]));

    // ---------- Übersicht: offene Punkte über alle Fahrzeuge ----------
    function renderInbox() {
        const list = $('inboxList');
        list.replaceChildren();
        const openAlerts = alerts.filter(item => item.status === 'offen');
        const newDamages = damages.filter(item => item.status === 'offen');
        const now = new Date();
        const overdue = openHandovers.filter(item => !item.emergency && item.driver_id && (item.date < TerminCloud.todayIso() || now.getHours() >= 16));
        $('inboxSummary').textContent = openAlerts.length || newDamages.length || takeoverNotes.length || overdue.length
            ? [
                `${openAlerts.length} ${openAlerts.length === 1 ? 'offene Meldung' : 'offene Meldungen'}`,
                `${newDamages.length} ${newDamages.length === 1 ? 'neuer Schaden' : 'neue Schäden'}`,
                takeoverNotes.length ? `${takeoverNotes.length} ${takeoverNotes.length === 1 ? 'Hinweis' : 'Hinweise'} zur Übernahme` : '',
                overdue.length ? `${overdue.length} nicht zurückgegeben` : ''
            ].filter(Boolean).join(', ')
            : 'Alles erledigt – es gibt nichts Offenes.';
        const vehicleOf = item => vehicles.find(vehicle => vehicle.id === item.vehicle_id);

        overdue.forEach(item => {
            const row = el('li', 'vehicle-entry inbox-entry');
            const meta = el('span');
            const phone = profiles.find(person => person.id === item.driver_id)?.phone;
            meta.append(el('strong', null, `${vehicleOf(item)?.plate || 'Fahrzeug'} · noch bei ${item.driver_name}`), el('small', null, [`übernommen am ${formatDate(item.date)} um ${String(item.start_time).slice(0, 5)} Uhr`, phone ? `Handy: ${phone}` : 'keine Handynummer hinterlegt'].join(' · ')));
            const actions = el('span', 'vehicle-entry-actions');
            const open = el('button', 'button-quiet', 'Akte');
            open.type = 'button';
            open.addEventListener('click', () => selectVehicle(item.vehicle_id));
            // Erinnerung direkt aufs Handy der Person (wenn sie Mitteilungen eingeschaltet hat).
            const remind = el('button', 'button-secondary fleet-end-button', 'Erinnern');
            remind.type = 'button';
            remind.addEventListener('click', async () => {
                remind.disabled = true;
                const result = await TerminCloud.callFunction({ action: 'notify', audience: 'einzeln', recipientIds: [item.driver_id], title: 'Fahrzeug zurückgeben', body: `Bitte gib ${vehicleOf(item)?.plate || 'dein Fahrzeug'} zurück und trag Kilometer, Tank und Parkort ein.` });
                remind.disabled = false;
                if (!result.ok) showToast(`Erinnerung nicht gesendet: ${result.reason}`, 'error');
                else showToast(result.data.sent ? `Erinnerung an ${item.driver_name} gesendet.` : `${item.driver_name} hat Mitteilungen noch nicht eingeschaltet – bitte anrufen.`, result.data.sent ? 'success' : 'info');
            });
            actions.append(remind, open);
            row.append(pill('offen', 'Nicht zurückgegeben'), meta, actions);
            list.append(row);
        });
        takeoverNotes.forEach(item => {
            const row = el('li', 'vehicle-entry inbox-entry');
            const meta = el('span');
            meta.append(el('strong', null, `${vehicleOf(item)?.plate || 'Fahrzeug'} · Hinweis von ${item.driver_name}`), el('small', null, `„${item.start_note}“ · vorher gefahren von ${item.previous_driver_name || 'unbekannt'} · ${formatDate(item.created_at)}`));
            const actions = el('span', 'vehicle-entry-actions');
            const seen = el('button', 'button-primary account-approve', 'Gelesen');
            seen.type = 'button';
            seen.addEventListener('click', async () => {
                const { error } = await client.from('tt_handovers').update({ note_seen: true }).eq('id', item.id);
                if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                await refresh();
            });
            actions.append(seen);
            row.append(pill('bekannt', 'Übernahme'), meta, actions);
            list.append(row);
        });

        openAlerts.forEach(item => {
            const row = el('li', 'vehicle-entry inbox-entry');
            const meta = el('span');
            meta.append(el('strong', null, `${vehicleOf(item)?.plate || 'Fahrzeug'} · ${item.kind}`), el('small', null, [item.note, `${item.reporter_name}, ${formatDate(item.created_at)}`].filter(Boolean).join(' · ')));
            const actions = el('span', 'vehicle-entry-actions');
            actions.append(photoButtons([item.photo_path]));
            const done = el('button', 'button-primary account-approve', 'Erledigt');
            done.type = 'button';
            done.addEventListener('click', () => resolveAlert(item, true));
            const open = el('button', 'button-quiet', 'Akte');
            open.type = 'button';
            open.addEventListener('click', () => selectVehicle(item.vehicle_id));
            actions.append(done, open);
            if (isAdmin()) actions.append(deleteAlert(item));
            row.append(pill('in Arbeit', 'Meldung'), meta, actions);
            list.append(row);
        });
        newDamages.forEach(item => {
            const row = el('li', 'vehicle-entry inbox-entry');
            const meta = el('span');
            meta.append(el('strong', null, `${vehicleOf(item)?.plate || 'Fahrzeug'} · ${item.category || 'Schaden'} · ${item.zone || 'ohne Position'}`), el('small', null, `${damageWhat(item)} · ${item.reporter_name}, ${formatDate(item.created_at)}`));
            const actions = el('span', 'vehicle-entry-actions');
            actions.append(photoButtons(damagePhotos(item)));
            const known = el('button', 'button-primary account-approve', 'Als Altschaden übernehmen');
            known.type = 'button';
            known.addEventListener('click', () => setDamageStatus(item, 'bekannt'));
            const open = el('button', 'button-quiet', 'Akte');
            open.type = 'button';
            open.addEventListener('click', () => selectVehicle(item.vehicle_id));
            actions.append(known, open);
            if (isAdmin()) actions.append(deleteDamage(item));
            row.append(pill('offen', 'Neuer Schaden'), meta, actions);
            list.append(row);
        });
    }

    // ---------- Fahrzeugbild: eigenes Foto, sonst die schwarze Zeichnung passend zur Bauart ----------
    function fillArt(node, vehicle) {
        const url = vehicle.photo_path ? photoUrls.get(vehicle.photo_path) : '';
        node.classList.toggle('has-photo', Boolean(url));
        if (url) {
            const image = el('img');
            image.src = url;
            image.alt = `Foto ${vehicle.plate}`;
            image.loading = 'lazy';
            node.replaceChildren(image);
        } else {
            node.innerHTML = CarArt.svg([vehicle.body, vehicle.brand].filter(Boolean).join(' '));
        }
    }

    async function loadPhotoUrls() {
        const missing = vehicles.filter(vehicle => vehicle.photo_path && !photoUrls.has(vehicle.photo_path));
        if (!missing.length) return;
        await Promise.all(missing.map(async vehicle => { photoUrls.set(vehicle.photo_path, await TerminCloud.photoUrl(vehicle.photo_path)); }));
        renderGrid();
        if (selectedId) { const vehicle = vehicles.find(item => item.id === selectedId); if (vehicle) fillArt($('fileArt'), vehicle); }
    }

    // Was ist mit diesem Fahrzeug los? Eine Stelle für Karten, Filter und Akte.
    function vehicleFacts(vehicle) {
        const own = damages.filter(item => item.vehicle_id === vehicle.id);
        return {
            holder: openHandovers.find(item => item.vehicle_id === vehicle.id) || null,
            newDamages: own.filter(item => item.status === 'offen').length,
            knownDamages: own.filter(item => item.status === 'bekannt').length,
            inRepair: own.filter(item => item.status === 'in Arbeit').length,
            repaired: own.filter(item => item.status === 'erledigt').length,
            openAlerts: alerts.filter(item => item.vehicle_id === vehicle.id && item.status === 'offen').length
        };
    }

    function vehicleBadges(vehicle, facts) {
        const badges = el('span', 'vehicle-card-badges');
        if (facts.holder?.emergency) badges.append(pill('in Arbeit', 'Notdienst'));
        if (facts.newDamages) badges.append(pill('offen', `${facts.newDamages} ${facts.newDamages === 1 ? 'neuer Schaden' : 'neue Schäden'}`));
        if (facts.inRepair) badges.append(pill('in Arbeit', `${facts.inRepair} in Reparatur`));
        if (facts.knownDamages) badges.append(pill('bekannt', `${facts.knownDamages} ${facts.knownDamages === 1 ? 'Altschaden' : 'Altschäden'}`));
        if (facts.openAlerts) badges.append(pill('in Arbeit', `${facts.openAlerts} ${facts.openAlerts === 1 ? 'Meldung' : 'Meldungen'}`));
        if (vehicle.clean_inside === false || vehicle.clean_outside === false) badges.append(pill('offen', 'nicht sauber'));
        if (vehicle.fuel != null && vehicle.fuel <= 1) badges.append(pill('in Arbeit', 'Tank niedrig'));
        if (!badges.children.length) badges.append(pill('erledigt', 'alles in Ordnung'));
        return badges;
    }

    const FLEET_FILTERS = {
        alle: () => true,
        frei: (vehicle, facts) => !facts.holder,
        unterwegs: (vehicle, facts) => Boolean(facts.holder),
        schaeden: (vehicle, facts) => facts.newDamages + facts.knownDamages + facts.inRepair > 0,
        reparatur: (vehicle, facts) => facts.inRepair > 0
    };

    // ---------- Fahrzeugkarten ----------
    function renderGrid() {
        const grid = $('vehicleGrid');
        grid.replaceChildren();
        if (!vehicles.length) {
            grid.append(el('p', 'directory-empty', 'Noch keine Fahrzeuge. Lege sie auf der Seite „Fahrzeuge“ an – sie erscheinen hier automatisch.'));
            return;
        }
        const all = vehicles.map(vehicle => ({ vehicle, facts: vehicleFacts(vehicle) }));
        const count = name => all.filter(({ vehicle, facts }) => FLEET_FILTERS[name](vehicle, facts)).length;
        $('fleetCountAll').textContent = String(all.length);
        $('fleetCountFree').textContent = String(count('frei'));
        $('fleetCountOut').textContent = String(count('unterwegs'));
        $('fleetCountDamage').textContent = String(count('schaeden'));
        $('fleetCountRepair').textContent = String(count('reparatur'));
        document.querySelectorAll('[data-fleet-filter]').forEach(button => {
            const active = button.dataset.fleetFilter === fleetFilter;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        const shown = all.filter(({ vehicle, facts }) => FLEET_FILTERS[fleetFilter](vehicle, facts));
        if (!shown.length) grid.append(el('p', 'directory-empty', 'Für diese Auswahl gibt es gerade kein Fahrzeug.'));
        shown.forEach(({ vehicle, facts }) => {
            const card = el('button', `vehicle-card${vehicle.id === selectedId ? ' is-active' : ''}`);
            card.type = 'button';
            const art = el('span', 'vehicle-art');
            fillArt(art, vehicle);
            const state = el('span', 'vehicle-state-chip', facts.holder ? `Unterwegs · ${facts.holder.driver_name}` : 'Frei');
            state.dataset.state = facts.holder ? 'unterwegs' : 'frei';
            const head = el('span', 'vehicle-card-head');
            head.append(el('strong', null, vehicle.plate), el('small', null, [vehicle.brand, vehicle.body, vehicle.type].filter(Boolean).join(' · ')));
            const people = el('span', 'vehicle-card-people');
            if (vehicle.assigned_to) people.append(el('small', 'vehicle-reserved', `Reserviert für ${profileName(vehicle.assigned_to) || '–'}`));
            const factsRow = el('span', 'vehicle-card-facts');
            factsRow.append(
                el('small', null, formatKm(vehicle.mileage)),
                el('small', null, `Tank ${vehicle.fuel == null ? '–' : FUEL[vehicle.fuel]}`),
                el('small', null, vehicle.parking ? `Steht: ${vehicle.parking}` : 'Parkort –')
            );
            card.append(art, state, head, people, factsRow, vehicleBadges(vehicle, facts));
            card.addEventListener('click', () => selectVehicle(vehicle.id));
            grid.append(card);
        });
    }

    async function selectVehicle(id) {
        selectedId = id;
        fileTab = 'current';
        renderGrid();
        await renderFile();
        $('vehicleFile').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // ---------- Akte eines Fahrzeugs ----------
    function damageEntry(item, number) {
        const row = el('li', 'vehicle-entry file-entry');
        row.id = `damage-${item.id}`;
        const meta = el('span');
        meta.append(
            el('strong', null, `${number != null ? `${number} · ` : ''}${[item.category, item.zone || 'ohne Position'].filter(Boolean).join(' · ')}`),
            ...(item.description && item.description !== item.category ? [el('small', null, item.description)] : []),
            el('small', null, `Gemeldet von ${item.reporter_name || '–'} am ${formatDate(item.created_at)}${item.resolved_at ? ` · behoben am ${formatDate(item.resolved_at)}` : ''}`)
        );
        const actions = el('span', 'vehicle-entry-actions');
        actions.append(photoButtons(damagePhotos(item)));
        // Schadenabwicklung in klaren Schritten: neu → (Altschaden) → in Reparatur → repariert (Archiv).
        const step = (text, status, className = 'button-secondary fleet-end-button') => {
            const button = el('button', className, text);
            button.type = 'button';
            button.addEventListener('click', () => setDamageStatus(item, status));
            return button;
        };
        if (item.status === 'offen') actions.append(step('Als Altschaden', 'bekannt'));
        if (item.status === 'offen' || item.status === 'bekannt') actions.append(step('In Reparatur', 'in Arbeit'));
        if (item.status === 'in Arbeit') actions.append(step('Doch nicht in Reparatur', 'bekannt', 'button-quiet'));
        if (item.status !== 'erledigt') actions.append(step('Repariert ✓', 'erledigt', 'button-primary account-approve'));
        else actions.append(step('Wieder öffnen', 'bekannt', 'button-quiet'));
        if (isAdmin()) actions.append(deleteDamage(item));
        row.append(pill(item.status, CarSketch.STATUS_LABELS[item.status] || item.status), meta, actions);
        return row;
    }

    function alertEntry(item) {
        const row = el('li', 'vehicle-entry file-entry');
        const meta = el('span');
        meta.append(
            el('strong', null, item.kind),
            el('small', null, [item.note, `Gemeldet von ${item.reporter_name || '–'} am ${formatDate(item.created_at)}`].filter(Boolean).join(' · ')),
            ...(item.status === 'erledigt' ? [el('small', null, `Erledigt am ${formatDate(item.resolved_at)}${item.resolved_by ? ` von ${item.resolved_by}` : ''}`)] : [])
        );
        const actions = el('span', 'vehicle-entry-actions');
        actions.append(photoButtons([item.photo_path]));
        const button = el('button', item.status === 'offen' ? 'button-primary account-approve' : 'button-quiet', item.status === 'offen' ? 'Erledigt' : 'Wieder öffnen');
        button.type = 'button';
        button.addEventListener('click', () => resolveAlert(item, item.status === 'offen'));
        actions.append(button);
        if (isAdmin()) actions.append(deleteAlert(item));
        row.append(meta, actions);
        return row;
    }

    const fillList = (id, nodes, emptyText) => $(id).replaceChildren(...(nodes.length ? nodes : [el('li', 'directory-empty', emptyText)]));

    async function renderFile() {
        const vehicle = vehicles.find(item => item.id === selectedId);
        if (!vehicle) return;
        $('vehicleFile').hidden = false;
        const holder = openHandovers.find(item => item.vehicle_id === vehicle.id);
        $('fileTitle').textContent = vehicleLabel(vehicle);
        $('fileSubtitle').textContent = [vehicle.type, vehicle.assigned_to ? `Reserviert für ${profileName(vehicle.assigned_to) || '–'}` : 'nicht reserviert', holder ? `gerade bei ${holder.driver_name}${holder.emergency ? ' (Notdienst)' : ''}` : 'frei'].filter(Boolean).join(' · ');
        fillArt($('fileArt'), vehicle);
        $('fileBadges').replaceChildren(...vehicleBadges(vehicle, vehicleFacts(vehicle)).children);
        $('filePhotoRemove').hidden = !vehicle.photo_path;
        $('filePhoto').value = '';

        const vehicleDamages = damages.filter(item => item.vehicle_id === vehicle.id);
        const current = vehicleDamages.filter(item => item.status !== 'erledigt');
        const archived = vehicleDamages.filter(item => item.status === 'erledigt');
        const vehicleAlerts = alerts.filter(item => item.vehicle_id === vehicle.id);

        if (!sketch) {
            sketch = CarSketch.create($('fileSketch'), {
                onMarker: marker => {
                    const target = document.getElementById(`damage-${marker.id}`);
                    if (!target) return;
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    target.classList.add('is-highlighted');
                    window.setTimeout(() => target.classList.remove('is-highlighted'), 1600);
                }
            });
        }
        const shown = fileTab === 'archive' ? archived : current;
        sketch.setMarkers(shown.map((item, index) => ({ id: item.id, x: item.pos_x, y: item.pos_y, status: item.status, label: damageWhat(item), number: index + 1 })));

        const stateRows = [
            ['Kilometer', formatKm(vehicle.mileage)],
            ['Tank', vehicle.fuel == null ? '–' : FUEL[vehicle.fuel]],
            ['Parkort', vehicle.parking || '–'],
            ['Innen', cleanText(vehicle.clean_inside)],
            ['Außen', cleanText(vehicle.clean_outside)],
            ['Stand', vehicle.state_updated_at ? `${formatDate(vehicle.state_updated_at)}${vehicle.state_updated_by ? `, ${vehicle.state_updated_by}` : ''}` : '–']
        ];
        $('fileState').replaceChildren(...stateRows.flatMap(([term, value]) => [el('dt', null, term), el('dd', null, value)]));

        const assigned = $('fileAssigned');
        assigned.replaceChildren(...[{ id: '', full_name: 'Kein fester Fahrer' }, ...profiles.filter(item => item.active)].map(item => {
            const option = el('option', null, item.id ? `${item.full_name}${item.employment === 'fest' ? ' (fest)' : ''}` : item.full_name);
            option.value = item.id;
            return option;
        }));
        assigned.value = vehicle.assigned_to || '';
        $('fileMileage').value = '';
        $('fileMileage').placeholder = vehicle.mileage == null ? 'km' : String(vehicle.mileage);

        document.querySelectorAll('[data-file-tab]').forEach(button => button.classList.toggle('is-active', button.dataset.fileTab === fileTab));
        document.querySelectorAll('[data-file-panel]').forEach(panel => { panel.hidden = panel.dataset.filePanel !== fileTab; });

        fillList('fileDamages', current.map((item, index) => damageEntry(item, index + 1)), 'Keine Schäden eingetragen.');
        fillList('fileAlerts', vehicleAlerts.filter(item => item.status === 'offen').map(alertEntry), 'Keine offenen Meldungen.');
        fillList('fileDamagesArchive', archived.map((item, index) => damageEntry(item, index + 1)), 'Noch keine behobenen Schäden.');
        fillList('fileAlertsArchive', vehicleAlerts.filter(item => item.status === 'erledigt').reverse().map(alertEntry), 'Noch keine erledigten Meldungen.');

        if (fileTab === 'archive') {
            const { data, error } = await client.from('tt_handovers').select('*').eq('vehicle_id', vehicle.id).order('created_at', { ascending: false }).limit(60);
            const body = $('fileHandovers');
            body.replaceChildren();
            fileHandovers = error ? [] : data;
            fileHandovers.forEach((item, position) => {
                const row = el('tr');
                [
                    formatDate(item.date),
                    item.driver_name,
                    `${String(item.start_time).slice(0, 5)} – ${item.end_time ? String(item.end_time).slice(0, 5) : 'offen'}`,
                    `${item.start_mileage ?? '–'} → ${item.end_mileage ?? '–'}`,
                    item.end_fuel == null ? '–' : FUEL[item.end_fuel],
                    item.end_parking || '–',
                    cleanText(item.end_clean_inside),
                    cleanText(item.end_clean_outside),
                    [item.emergency ? 'Notdienst' : '', item.start_note ? `Übernahme: „${item.start_note}“` : ''].filter(Boolean).join(' · ') || '–'
                ].forEach(text => row.append(el('td', null, text)));
                const edit = el('button', 'button-quiet', 'Kilometer ändern');
                edit.type = 'button';
                edit.addEventListener('click', () => openMileage(item, position === 0));
                const cell = el('td');
                cell.append(edit);
                row.append(cell);
                body.append(row);
            });
            if (!body.children.length) {
                const row = el('tr');
                const cell = el('td', null, 'Noch keine Fahrten.');
                cell.colSpan = 10;
                row.append(cell);
                body.append(row);
            }
        }
    }

    document.querySelectorAll('[data-file-tab]').forEach(button => {
        button.addEventListener('click', () => { fileTab = button.dataset.fileTab; renderFile(); });
    });

    $('fileAssigned').addEventListener('change', async () => {
        const { error } = await client.from('tt_vehicles').update({ assigned_to: $('fileAssigned').value || null }).eq('id', selectedId);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        showToast('Fester Fahrer gespeichert', 'success');
        await refresh();
    });

    $('fileSettings').addEventListener('submit', async event => {
        event.preventDefault();
        const text = $('fileMileage').value.trim();
        if (!text) return;
        const { error } = await client.from('tt_vehicles').update({ mileage: Number(text), state_updated_at: new Date().toISOString(), state_updated_by: `${profile.full_name || 'Admin'} (Korrektur)` }).eq('id', selectedId);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        showToast('Kilometerstand korrigiert', 'success');
        await refresh();
    });

    // Filter über den Karten: Alle / Frei / Unterwegs / Mit Schäden / In Reparatur
    document.querySelectorAll('[data-fleet-filter]').forEach(button => button.addEventListener('click', () => {
        fleetFilter = button.dataset.fleetFilter;
        renderGrid();
    }));

    // Eigenes Foto zum Fahrzeug (ersetzt die Zeichnung). Braucht supabase/update-9.sql.
    async function saveVehiclePhoto(path) {
        const { error } = await client.from('tt_vehicles').update({ photo_path: path }).eq('id', selectedId);
        if (error) {
            showToast(/photo_path/.test(error.message || '') ? 'Für Fahrzeugfotos fehlt noch das Datenbank-Update 9 (supabase/update-9.sql).' : TerminCloud.germanError(error), 'error');
            return false;
        }
        return true;
    }
    $('filePhoto').addEventListener('change', async event => {
        const file = event.target.files?.[0];
        if (!file || !selectedId) return;
        try {
            const path = await TerminCloud.uploadPhoto(file, profile.id);
            if (await saveVehiclePhoto(path)) { showToast('Foto gespeichert', 'success'); await refresh(); }
        } catch (error) {
            showToast(TerminCloud.germanError(error), 'error');
        }
        event.target.value = '';
    });
    $('filePhotoRemove').addEventListener('click', async () => {
        if (!selectedId) return;
        if (await saveVehiclePhoto(null)) { showToast('Foto entfernt – es wird wieder die Zeichnung gezeigt', 'success'); await refresh(); }
    });

    // ---------- Tankkarten ----------
    // Ausgeben und zurücknehmen darf nur der Admin (in der Datenbank abgesichert). Das Sekretariat sieht, wo die Karten sind.
    function renderFuel() {
        const list = $('fuelList');
        const admin = isAdmin();
        $('fuelAddForm').hidden = !admin || !fuelReady;
        $('fuelLogBox').hidden = !fuelLog.length;
        if (!fuelReady) {
            $('fuelSummary').textContent = 'Für Tankkarten fehlt noch das Datenbank-Update 10 (supabase/update-10.sql).';
            list.replaceChildren();
            return;
        }
        const out = fuelCards.filter(card => card.holder_id);
        $('fuelSummary').textContent = !fuelCards.length
            ? (admin ? 'Noch keine Tankkarte angelegt. Lege unten die erste Karte an.' : 'Noch keine Tankkarte angelegt.')
            : `${fuelCards.length} ${fuelCards.length === 1 ? 'Karte' : 'Karten'} · ${out.length ? `${out.length} ausgegeben` : 'alle im Büro'}${admin ? '' : ' · Ausgeben und Zurücknehmen macht nur der Admin.'}`;
        const people = profiles.filter(item => item.active).sort((left, right) => String(left.full_name).localeCompare(String(right.full_name), 'de'));
        list.replaceChildren(...fuelCards.map(card => {
            const row = el('li', 'vehicle-entry file-entry fuel-entry');
            const meta = el('span');
            meta.append(el('strong', null, `Tankkarte ${card.number}`),
                el('small', null, card.holder_id ? `bei ${card.holder_name || profileName(card.holder_id) || 'unbekannt'} seit ${formatDateTime(card.assigned_at)}` : 'liegt im Büro'));
            if (card.note) meta.append(el('small', null, card.note));
            const actions = el('span', 'vehicle-entry-actions');
            if (admin && card.holder_id) {
                const back = el('button', 'button-primary account-approve', 'Zurückgenommen');
                back.type = 'button';
                back.addEventListener('click', () => setFuelCard(card, null, back));
                actions.append(back);
            } else if (admin) {
                const select = el('select');
                select.setAttribute('aria-label', `Tankkarte ${card.number} ausgeben an`);
                select.append(...[{ id: '', full_name: 'Ausgeben an …' }, ...people].map(person => { const option = el('option', null, person.full_name); option.value = person.id; return option; }));
                const give = el('button', 'button-secondary fleet-end-button', 'Ausgeben');
                give.type = 'button';
                give.addEventListener('click', () => {
                    if (!select.value) { showToast('Bitte wähle zuerst, wer die Karte bekommt.', 'error', { target: select }); return; }
                    setFuelCard(card, select.value, give);
                });
                const remove = el('button', 'button-quiet-danger', 'Entfernen');
                remove.type = 'button';
                remove.addEventListener('click', async () => {
                    if (!await confirmDialog(`Tankkarte ${card.number} aus der Liste entfernen?\n\nDer Verlauf bleibt erhalten.`, 'Entfernen')) return;
                    const { error } = await client.from('tt_fuel_cards').update({ active: false }).eq('id', card.id);
                    if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
                    showToast(`Tankkarte ${card.number} entfernt`, 'success');
                    await refresh();
                });
                actions.append(select, give, remove);
            }
            row.append(pill(card.holder_id ? 'in Arbeit' : 'erledigt', card.holder_id ? 'ausgegeben' : 'im Büro'), meta, actions);
            return row;
        }));
        $('fuelLog').replaceChildren(...fuelLog.map(item => {
            const row = el('li', 'directory-entry');
            row.append(el('span', 'directory-entry-name', `${formatDateTime(item.created_at)} · Karte ${item.card_number} ${item.action === 'ausgegeben' ? 'ausgegeben an' : 'zurück von'} ${item.profile_name || 'unbekannt'}${item.by_name ? ` (${item.by_name})` : ''}`));
            return row;
        }));
    }

    async function setFuelCard(card, profileId, button) {
        button.disabled = true;
        const { error } = await client.rpc('tt_fuel_card_set', { p_card: card.id, p_profile: profileId });
        button.disabled = false;
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        showToast(profileId ? `Tankkarte ${card.number} ausgegeben an ${profileName(profileId)}` : `Tankkarte ${card.number} ist wieder im Büro`, 'success');
        await refresh();
    }

    $('fuelAddForm').addEventListener('submit', async event => {
        event.preventDefault();
        const number = $('fuelNumber').value.trim();
        if (!number) { showToast('Bitte trag die Kartennummer oder eine Bezeichnung ein.', 'error', { target: '#fuelNumber' }); return; }
        if (fuelCards.some(card => card.number.toLocaleLowerCase('de-DE') === number.toLocaleLowerCase('de-DE'))) { showToast('Diese Tankkarte gibt es schon.', 'error', { target: '#fuelNumber' }); return; }
        const { error } = await client.from('tt_fuel_cards').insert({ number, note: $('fuelNote').value.trim() });
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        event.target.reset();
        showToast(`Tankkarte ${number} angelegt`, 'success');
        await refresh();
    });

    // ---------- Schaden selbst eintragen (Stelle markieren, Art wählen, Foto) ----------
    let staffSketch = null;
    let staffPosition = null;
    const NO_POSITION = 'Noch keine Stelle gewählt.';
    $('staffDamageKinds').replaceChildren(...DAMAGE_KINDS.map(kind => {
        const label = el('label');
        const input = el('input');
        input.type = 'radio';
        input.name = 'staffDamageKind';
        input.value = kind;
        label.append(input, el('span', null, kind));
        return label;
    }));

    function photoRule() {
        const old = $('staffDamageStatus').value === 'bekannt';
        $('staffDamagePhotoHint').textContent = old ? 'bei Altschäden freiwillig · bis zu 3 Fotos' : 'Pflicht · bis zu 3 Fotos';
        return !old;
    }
    $('staffDamageStatus').addEventListener('change', photoRule);

    $('staffDamageOpen').addEventListener('click', () => {
        const vehicle = vehicles.find(item => item.id === selectedId);
        if (!vehicle) return;
        $('staffDamageForm').reset();
        staffPosition = null;
        $('staffDamageVehicle').textContent = vehicleLabel(vehicle);
        $('staffDamagePosition').textContent = NO_POSITION;
        delete $('staffDamagePosition').dataset.kind;
        photoRule();
        $('damageDialog').showModal();
        if (!staffSketch) {
            staffSketch = CarSketch.create($('staffDamageSketch'), {
                onPick: position => {
                    staffPosition = position;
                    $('staffDamagePosition').textContent = `Gewählt: ${CarSketch.zoneLabel(position.x, position.y)}`;
                    $('staffDamagePosition').dataset.kind = 'ok';
                }
            });
        }
        staffSketch.setPicked(null);
        const current = damages.filter(item => item.vehicle_id === vehicle.id && item.status !== 'erledigt');
        staffSketch.setMarkers(current.map((item, index) => ({ id: item.id, x: item.pos_x, y: item.pos_y, status: item.status, label: damageWhat(item), number: index + 1 })));
    });
    $('staffDamageCancel').addEventListener('click', () => $('damageDialog').close());

    $('staffDamageForm').addEventListener('submit', async event => {
        event.preventDefault();
        const category = document.querySelector('input[name="staffDamageKind"]:checked')?.value || '';
        const files = [...($('staffDamagePhoto').files || [])].slice(0, 3);
        const status = $('staffDamageStatus').value;
        // Die Anzeige liegt hinter dem Dialog – darum hier direkt zur Stelle springen.
        const stop = (message, target) => { showToast(message, 'error', { target }); window.jumpToProblem(target); };
        if (!staffPosition) { stop('Bitte tippe zuerst in der Skizze auf die Stelle des Schadens.', '#staffDamageSketch'); return; }
        if (!category) { stop('Bitte wähle die Art des Schadens.', '#staffDamageKinds'); return; }
        if (photoRule() && !files.length) { stop('Bitte füge ein Foto vom Schaden hinzu – bei einem neuen Schaden ist das Foto Pflicht.', '#staffDamagePhoto'); return; }
        const button = event.target.querySelector('button[type="submit"]');
        button.disabled = true;
        try {
            const paths = [];
            for (const file of files) paths.push(await TerminCloud.uploadPhoto(file, profile.id));
            const description = $('staffDamageDescription').value.trim();
            const { error } = await client.from('tt_damages').insert({
                vehicle_id: selectedId, reporter_id: profile.id, reporter_name: profile.full_name || 'Einsatzleitung',
                category, description: description || category, status, pos_x: staffPosition.x, pos_y: staffPosition.y,
                zone: CarSketch.zoneLabel(staffPosition.x, staffPosition.y), photo_path: paths[0] || '', photo_paths: paths
            });
            if (error) throw error;
            $('damageDialog').close();
            showToast('Schaden gespeichert', 'success');
            await refresh();
        } catch (error) {
            showToast(/category/.test(error?.message || '') ? 'Für die Schadensart fehlt noch das Datenbank-Update 11 (supabase/update-11.sql).' : TerminCloud.germanError(error), 'error');
        } finally {
            button.disabled = false;
        }
    });

    // ---------- Kilometer einer Fahrt korrigieren ----------
    let mileageItem = null;
    function openMileage(item, isLatest) {
        mileageItem = item;
        $('mileageDialogInfo').textContent = `${formatDate(item.date)} · ${item.driver_name} · ${String(item.start_time).slice(0, 5)} – ${item.end_time ? String(item.end_time).slice(0, 5) : 'offen'}`;
        $('mileageStart').value = item.start_mileage ?? '';
        $('mileageEnd').value = item.end_mileage ?? '';
        $('mileageEnd').disabled = !item.end_time;
        $('mileageCurrentRow').hidden = !isLatest;
        $('mileageCurrent').checked = isLatest;
        $('mileageDialog').showModal();
    }
    $('mileageCancel').addEventListener('click', () => $('mileageDialog').close());

    $('mileageForm').addEventListener('submit', async event => {
        event.preventDefault();
        if (!mileageItem) return;
        const read = id => { const text = $(id).value.trim(); return text === '' ? null : Number(text); };
        const start = read('mileageStart');
        const end = $('mileageEnd').disabled ? mileageItem.end_mileage ?? null : read('mileageEnd');
        const bad = value => value != null && (!Number.isInteger(value) || value < 0);
        if (bad(start)) { window.jumpToProblem('#mileageStart'); showToast('Bitte nur ganze Kilometer eintragen.', 'error', { target: '#mileageStart' }); return; }
        if (bad(end)) { window.jumpToProblem('#mileageEnd'); showToast('Bitte nur ganze Kilometer eintragen.', 'error', { target: '#mileageEnd' }); return; }
        if (start != null && end != null && end < start) { window.jumpToProblem('#mileageEnd'); showToast('Der Stand bei Rückgabe ist kleiner als bei der Übernahme.', 'error', { target: '#mileageEnd' }); return; }
        const { error } = await client.from('tt_handovers').update({ start_mileage: start, end_mileage: end }).eq('id', mileageItem.id);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        // Die letzte Fahrt bestimmt den aktuellen Stand des Fahrzeugs.
        if (!$('mileageCurrentRow').hidden && $('mileageCurrent').checked && (end ?? start) != null) {
            const update = await client.from('tt_vehicles').update({ mileage: end ?? start, state_updated_at: new Date().toISOString(), state_updated_by: `${profile.full_name || 'Admin'} (Korrektur)` }).eq('id', mileageItem.vehicle_id);
            if (update.error) { showToast(TerminCloud.germanError(update.error), 'error'); return; }
        }
        $('mileageDialog').close();
        showToast('Kilometer korrigiert', 'success');
        await refresh();
    });

    $('fileReload').addEventListener('click', refresh);
    $('enableNotifications').addEventListener('click', async () => {
        const permission = await Notification.requestPermission();
        $('enableNotifications').hidden = permission !== 'default';
        showToast(permission === 'granted' ? 'Benachrichtigungen sind eingeschaltet, solange die App geöffnet ist.' : 'Benachrichtigungen wurden im Browser nicht erlaubt.', permission === 'granted' ? 'success' : 'error');
    });

    refresh();
})();
