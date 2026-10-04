// Fahrzeugakten: Zustand, Schäden mit Skizze, Meldungen und Verlauf je Fahrzeug – mit Archiv.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const FUEL = window.TERMIN_CLOUD_CONFIG?.fuelLabels || ['Leer', '1/4', '1/2', '3/4', 'Voll'];
    const DAMAGE_STATUS = [['offen', 'Neu gemeldet'], ['bekannt', 'Altschaden'], ['in Arbeit', 'In Reparatur'], ['erledigt', 'Behoben (Archiv)']];
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

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };
    const vehicleLabel = vehicle => [vehicle.plate, [vehicle.brand, vehicle.body].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    const formatKm = value => value == null ? '–' : `${Number(value).toLocaleString('de-DE')} km`;
    const formatDate = value => value ? new Date(value).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '–';
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
        renderGrid();
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
        showToast(status === 'erledigt' ? 'Schaden ins Archiv verschoben' : 'Status gespeichert', 'success');
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
            actions.append(open);
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
            row.append(pill('in Arbeit', 'Meldung'), meta, actions);
            list.append(row);
        });
        newDamages.forEach(item => {
            const row = el('li', 'vehicle-entry inbox-entry');
            const meta = el('span');
            meta.append(el('strong', null, `${vehicleOf(item)?.plate || 'Fahrzeug'} · ${item.zone || 'Schaden'}`), el('small', null, `${item.description} · ${item.reporter_name}, ${formatDate(item.created_at)}`));
            const actions = el('span', 'vehicle-entry-actions');
            actions.append(photoButtons(damagePhotos(item)));
            const known = el('button', 'button-primary account-approve', 'Als Altschaden übernehmen');
            known.type = 'button';
            known.addEventListener('click', () => setDamageStatus(item, 'bekannt'));
            const open = el('button', 'button-quiet', 'Akte');
            open.type = 'button';
            open.addEventListener('click', () => selectVehicle(item.vehicle_id));
            actions.append(known, open);
            row.append(pill('offen', 'Neuer Schaden'), meta, actions);
            list.append(row);
        });
    }

    // ---------- Fahrzeugkarten ----------
    function renderGrid() {
        const grid = $('vehicleGrid');
        grid.replaceChildren();
        if (!vehicles.length) {
            grid.append(el('p', 'directory-empty', 'Noch keine Fahrzeuge. Lege sie auf der Seite „Fahrzeuge“ an – sie erscheinen hier automatisch.'));
            return;
        }
        vehicles.forEach(vehicle => {
            const holder = openHandovers.find(item => item.vehicle_id === vehicle.id);
            const newDamages = damages.filter(item => item.vehicle_id === vehicle.id && item.status === 'offen').length;
            const knownDamages = damages.filter(item => item.vehicle_id === vehicle.id && ['bekannt', 'in Arbeit'].includes(item.status)).length;
            const openAlerts = alerts.filter(item => item.vehicle_id === vehicle.id && item.status === 'offen').length;
            const card = el('button', `vehicle-card${vehicle.id === selectedId ? ' is-active' : ''}`);
            card.type = 'button';
            const head = el('span', 'vehicle-card-head');
            head.append(el('strong', null, vehicle.plate), el('small', null, [vehicle.brand, vehicle.body, vehicle.type].filter(Boolean).join(' · ')));
            const people = el('span', 'vehicle-card-people');
            people.append(
                el('small', null, `Fest: ${profileName(vehicle.assigned_to) || '–'}`),
                el('small', holder ? 'vehicle-driver' : null, holder ? `Gerade bei ${holder.driver_name}` : 'Frei')
            );
            const facts = el('span', 'vehicle-card-facts');
            facts.append(
                el('small', null, formatKm(vehicle.mileage)),
                el('small', null, `Tank ${vehicle.fuel == null ? '–' : FUEL[vehicle.fuel]}`),
                el('small', null, vehicle.parking || 'Parkort –')
            );
            const badges = el('span', 'vehicle-card-badges');
            if (holder?.emergency) badges.append(pill('in Arbeit', 'Notdienst'));
            if (openAlerts) badges.append(pill('in Arbeit', `${openAlerts} ${openAlerts === 1 ? 'Meldung' : 'Meldungen'}`));
            if (newDamages) badges.append(pill('offen', `${newDamages} neu`));
            if (knownDamages) badges.append(pill('bekannt', `${knownDamages} Altschäden`));
            if (vehicle.clean_inside === false || vehicle.clean_outside === false) badges.append(pill('offen', 'nicht sauber'));
            if (vehicle.fuel != null && vehicle.fuel <= 1) badges.append(pill('in Arbeit', 'Tank niedrig'));
            if (!badges.children.length) badges.append(pill('erledigt', 'alles in Ordnung'));
            card.append(head, people, facts, badges);
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
            el('strong', null, `${number != null ? `${number} · ` : ''}${item.zone || 'ohne Position'}`),
            el('small', null, item.description),
            el('small', null, `Gemeldet von ${item.reporter_name || '–'} am ${formatDate(item.created_at)}${item.resolved_at ? ` · behoben am ${formatDate(item.resolved_at)}` : ''}`)
        );
        const actions = el('span', 'vehicle-entry-actions');
        actions.append(photoButtons(damagePhotos(item)));
        const select = el('select');
        select.setAttribute('aria-label', 'Status des Schadens');
        DAMAGE_STATUS.forEach(([value, text]) => {
            const option = el('option', null, text);
            option.value = value;
            option.selected = item.status === value;
            select.append(option);
        });
        select.addEventListener('change', () => setDamageStatus(item, select.value));
        actions.append(select);
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
        $('fileSubtitle').textContent = [vehicle.type, `Fest: ${profileName(vehicle.assigned_to) || '–'}`, holder ? `gerade bei ${holder.driver_name}${holder.emergency ? ' (Notdienst)' : ''}` : 'frei'].filter(Boolean).join(' · ');

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
        sketch.setMarkers(shown.map((item, index) => ({ id: item.id, x: item.pos_x, y: item.pos_y, status: item.status, label: item.description, number: index + 1 })));

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
            (error ? [] : data).forEach(item => {
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
                body.append(row);
            });
            if (!body.children.length) {
                const row = el('tr');
                const cell = el('td', null, 'Noch keine Fahrten.');
                cell.colSpan = 9;
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

    $('fileReload').addEventListener('click', refresh);
    $('enableNotifications').addEventListener('click', async () => {
        const permission = await Notification.requestPermission();
        $('enableNotifications').hidden = permission !== 'default';
        showToast(permission === 'granted' ? 'Benachrichtigungen sind eingeschaltet, solange die App geöffnet ist.' : 'Benachrichtigungen wurden im Browser nicht erlaubt.', permission === 'granted' ? 'success' : 'error');
    });

    refresh();
})();
