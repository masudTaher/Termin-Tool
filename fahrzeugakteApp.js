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
    let allVehicles = [];          // auch die aus dem Fuhrpark genommenen (für „Nicht mehr im Fuhrpark“)
    const lastReturns = new Map(); // Fahrzeug → letzte beendete Fahrt
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
        if (window.PhotoRequest) await PhotoRequest.load().catch(() => []);
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
        // Letzte Rückgabe je Fahrzeug – für „zuletzt Ahmad, 04.10. 17:40“ bei freien Fahrzeugen
        const returnResult = await client.from('tt_handovers').select('*').not('end_time', 'is', null).order('created_at', { ascending: false }).limit(400);
        lastReturns.clear();
        (returnResult.error ? [] : returnResult.data).forEach(item => { if (!lastReturns.has(item.vehicle_id)) lastReturns.set(item.vehicle_id, item); });
        const failed = [vehicleResult, profileResult, damageResult, alertResult, handoverResult].find(result => result.error);
        if (failed) {
            setStatus(`${TerminCloud.germanError(failed.error)} Falls Spalten oder Tabellen fehlen: supabase/update-2.sql im SQL Editor ausführen.`, 'error');
            return;
        }
        allVehicles = vehicleResult.data;
        vehicles = allVehicles.filter(vehicle => vehicle.active);
        profiles = profileResult.data;
        damages = damageResult.data;
        alerts = alertResult.data;
        openHandovers = handoverResult.data;
        $('fileApp').hidden = false;
        $('enableNotifications').hidden = !('Notification' in window) || Notification.permission !== 'default';
        renderInbox();
        renderFuel();
        renderGrid();
        renderRetired();
        loadPhotoUrls();
        if (selectedId && vehicles.some(vehicle => vehicle.id === selectedId)) await renderFile();
        else { selectedId = null; $('vehicleFile').hidden = true; $('fileBackdrop').hidden = true; document.documentElement.classList.remove('has-drawer'); }
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

    // „Foto neu anfordern“: nur bei Einträgen, die jemand im Portal gemeldet hat (nicht bei eigenen Einträgen der Einsatzleitung).
    const plateOf = item => vehicles.find(vehicle => vehicle.id === item.vehicle_id)?.plate || allVehicles.find(vehicle => vehicle.id === item.vehicle_id)?.plate || '';
    function requestButton(kind, item) {
        const reporter = profiles.find(person => person.id === item.reporter_id);
        if (!window.PhotoRequest || !reporter || !reporter.active || reporter.role !== 'dolmetscher') return null;
        return PhotoRequest.button({
            kind, refId: item.id, profileId: reporter.id, profileName: reporter.full_name || item.reporter_name,
            title: kind === 'schaden' ? ['Schaden', item.category, item.zone, plateOf(item)].filter(Boolean).join(' · ') : ['Meldung', item.kind, plateOf(item)].filter(Boolean).join(' · '),
            paths: kind === 'schaden' ? damagePhotos(item) : [item.photo_path]
        }, refresh);
    }
    const withRequest = (row, kind, item) => {
        const meta = row.querySelector('span:not(.status-pill):not(.vehicle-entry-actions)');
        const state = window.PhotoRequest?.pill(item.id);
        if (state) meta?.append(state);
        if (item.feedback_at) {
            const sent = el('span', 'status-pill request-pill feedback-pill', `Rückmeldung gesendet ${formatDate(item.feedback_at)}`);
            sent.dataset.status = 'erledigt';
            sent.title = `${item.feedback_by ? `${item.feedback_by}: ` : ''}${item.feedback_text || ''}`;
            meta?.append(sent);
        }
        return row;
    };

    // „Rückmeldung“: kurze Nachricht an die Person, die den Schaden oder die Meldung im Portal gemeldet hat.
    // Sie steht im Portal unter der Glocke und kommt als Mitteilung aufs Handy. Korrigieren oder löschen geht
    // danach auf der Seite „Nachrichten“.
    const FEEDBACK_TEXTS = {
        schaden: ['Danke für die Meldung.', 'Der Schaden ist aufgenommen.', 'Das Auto geht in die Werkstatt.', 'Der Schaden ist repariert.', 'Bitte ruf mich kurz an.', 'Bitte Schäden immer sofort melden.'],
        meldung: ['Danke für die Meldung.', 'Wir kümmern uns darum.', 'Bitte fahr das Auto vorerst nicht.', 'Du kannst normal weiterfahren.', 'Bitte ruf mich kurz an.', 'Ist erledigt.']
    };
    let feedbackDialog = null;
    function buildFeedbackDialog() {
        feedbackDialog = el('dialog', 'confirm-dialog request-dialog feedback-dialog');
        feedbackDialog.setAttribute('aria-labelledby', 'feedbackDialogTitle');
        feedbackDialog.innerHTML = `
            <form class="fleet-form" novalidate>
               <h2 id="feedbackDialogTitle">Rückmeldung</h2>
               <p class="field-hint" data-part="what"></p>
               <span class="field-label" id="feedbackTextsLabel">Schnell antworten</span>
               <div class="board-chips request-reasons" role="group" aria-labelledby="feedbackTextsLabel" data-part="texts"></div>
               <label for="feedbackDialogMessage">Deine Nachricht</label>
               <textarea id="feedbackDialogMessage" rows="3" maxlength="600"></textarea>
               <p class="workflow-status" data-part="problem" data-kind="error" role="alert" hidden></p>
               <p class="field-hint">Die Person sieht die Nachricht im Portal unter der Glocke und bekommt eine Mitteilung aufs Handy. Korrigieren oder löschen kannst du sie danach auf der Seite „Nachrichten“.</p>
               <div class="modal-buttons"><button type="button" class="button-secondary" data-part="cancel">Abbrechen</button><button type="submit" class="button-primary" data-part="submit">Senden</button></div>
            </form>`;
        document.body.append(feedbackDialog);
        feedbackDialog.querySelector('[data-part=cancel]').addEventListener('click', () => feedbackDialog.close('cancel'));
    }
    function askFeedback(kind, item, reporter) {
        if (!feedbackDialog) buildFeedbackDialog();
        const part = name => feedbackDialog.querySelector(`[data-part=${name}]`);
        const message = feedbackDialog.querySelector('#feedbackDialogMessage');
        const name = reporter.full_name || item.reporter_name || 'die Person';
        const what = kind === 'schaden' ? ['Schaden', item.category, item.zone, plateOf(item)].filter(Boolean).join(' · ') : ['Meldung', item.kind, plateOf(item)].filter(Boolean).join(' · ');
        feedbackDialog.querySelector('#feedbackDialogTitle').textContent = `Rückmeldung an ${name}`;
        part('what').textContent = `${what} · gemeldet am ${formatDate(item.created_at)}${item.feedback_at ? ` · letzte Rückmeldung am ${formatDate(item.feedback_at)}: „${item.feedback_text}“` : ''}`;
        part('problem').hidden = true;
        const chosen = new Set();
        let touched = false;      // selbst getippter Text bleibt stehen
        message.value = '';
        part('texts').replaceChildren(...FEEDBACK_TEXTS[kind].map(text => {
            const chip = el('button', 'board-chip', text.replace(/\.$/, ''));
            chip.type = 'button';
            chip.setAttribute('aria-pressed', 'false');
            chip.addEventListener('click', () => {
                if (touched) {
                    // Zum eigenen Text dazusetzen statt ihn zu ersetzen.
                    if (!message.value.includes(text)) message.value = `${message.value.trim()} ${text}`.trim();
                    chip.setAttribute('aria-pressed', 'true');
                    return;
                }
                if (chosen.has(text)) chosen.delete(text); else chosen.add(text);
                chip.setAttribute('aria-pressed', String(chosen.has(text)));
                message.value = [...chosen].join(' ');
            });
            return chip;
        }));
        message.oninput = () => { touched = true; part('problem').hidden = true; };
        const form = feedbackDialog.querySelector('form');
        const submit = part('submit');
        submit.disabled = false;
        form.onsubmit = async event => {
            event.preventDefault();
            const text = message.value.trim();
            if (!text) { part('problem').textContent = 'Bitte schreib eine kurze Rückmeldung oder tippe einen Vorschlag an.'; part('problem').hidden = false; message.focus(); return; }
            submit.disabled = true;
            const body = `Rückmeldung zu deiner ${kind === 'schaden' ? 'Schadenmeldung' : 'Meldung'} (${what.replace(/^(Schaden|Meldung) · /, '')}, ${formatDate(item.created_at)}): ${text}`;
            const { error } = await client.from('tt_messages').insert({ sender_id: profile.id, sender_name: profile.full_name || 'Einsatzleitung', audience: 'einzeln', recipient_ids: [reporter.id], body });
            if (error) { submit.disabled = false; part('problem').textContent = TerminCloud.germanError(error); part('problem').hidden = false; return; }
            feedbackDialog.close('sent');
            // Vermerk am Eintrag (Spalten aus Update 18; ohne das Update fehlt nur das Schildchen).
            const noted = { feedback_at: new Date().toISOString(), feedback_text: text.slice(0, 600), feedback_by: profile.full_name || '' };
            const mark = await client.from(kind === 'schaden' ? 'tt_damages' : 'tt_alerts').update(noted).eq('id', item.id);
            if (!mark.error) Object.assign(item, noted);
            const push = await TerminCloud.callFunction({ action: 'notify', audience: 'einzeln', recipientIds: [reporter.id], title: `Rückmeldung von ${profile.full_name || 'der Einsatzleitung'}`, body: body.slice(0, 300) });
            showToast(push.ok && push.data?.sent
                ? `Rückmeldung an ${name} gesendet – mit Mitteilung aufs Handy.`
                : `Rückmeldung an ${name} gesendet. Sie steht im Portal unter der Glocke (Mitteilungen aufs Handy sind dort nicht eingeschaltet).`, 'success', { duration: 8000 });
            await refresh();
        };
        feedbackDialog.showModal();
        message.focus();
    }
    // Knopf nur bei Einträgen, die jemand anderes gemeldet hat und dessen Konto noch aktiv ist.
    function feedbackButton(kind, item) {
        const reporter = profiles.find(person => person.id === item.reporter_id);
        if (!reporter || !reporter.active || reporter.id === profile?.id) return null;
        const node = el('button', 'button-quiet feedback-button', item.feedback_at ? 'Noch eine Rückmeldung' : 'Rückmeldung');
        node.type = 'button';
        node.title = `${reporter.full_name || item.reporter_name} eine kurze Rückmeldung schicken`;
        node.addEventListener('click', () => askFeedback(kind, item, reporter));
        return node;
    }

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

        // Auf Bitte neu geschickte Fotos (Schaden oder Meldung): ansehen und abhaken
        const answeredPhotos = window.PhotoRequest ? PhotoRequest.unseen().filter(item => item.kind === 'schaden' || item.kind === 'meldung') : [];
        answeredPhotos.forEach(request => {
            const target = request.kind === 'schaden' ? damages.find(item => item.id === request.ref_id) : alerts.find(item => item.id === request.ref_id);
            const row = el('li', 'vehicle-entry inbox-entry');
            const meta = el('span');
            meta.append(el('strong', null, `Neues Foto von ${request.profile_name || 'unbekannt'}`), el('small', null, [request.title, request.answer_note ? `„${request.answer_note}“` : '', formatDateTime(request.answered_at)].filter(Boolean).join(' · ')));
            const actions = el('span', 'vehicle-entry-actions');
            actions.append(photoButtons(request.answer_paths || []));
            if (target) {
                const open = el('button', 'button-quiet', 'Akte');
                open.type = 'button';
                open.addEventListener('click', () => selectVehicle(target.vehicle_id));
                actions.append(open);
            }
            const seen = el('button', 'button-primary account-approve', 'Gesehen');
            seen.type = 'button';
            seen.addEventListener('click', async () => {
                seen.disabled = true;
                const error = await PhotoRequest.markSeen(request);
                if (error) { seen.disabled = false; showToast(TerminCloud.germanError(error), 'error'); return; }
                renderInbox();
                window.refreshCloudInbox?.();
            });
            actions.append(seen);
            row.append(pill('erledigt', 'Neues Foto'), meta, actions);
            list.append(row);
        });

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
            const again = requestButton('meldung', item);
            if (again) actions.append(again);
            const reply = feedbackButton('meldung', item);
            if (reply) actions.append(reply);
            if (isAdmin()) actions.append(deleteAlert(item));
            row.append(pill('in Arbeit', 'Meldung'), meta, actions);
            list.append(withRequest(row, 'meldung', item));
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
            const again = requestButton('schaden', item);
            if (again) actions.append(again);
            const reply = feedbackButton('schaden', item);
            if (reply) actions.append(reply);
            if (isAdmin()) actions.append(deleteDamage(item));
            row.append(pill('offen', 'Neuer Schaden'), meta, actions);
            list.append(withRequest(row, 'schaden', item));
        });
        // Bei vielen Fahrzeugen bleibt die Übersicht oben: zuerst nur die ersten Punkte, der Rest auf einen Tipp.
        const rows = [...list.children];
        const LIMIT = 4;
        rows.forEach((row, index) => { row.hidden = !inboxOpen && index >= LIMIT; });
        $('inboxMore').hidden = rows.length <= LIMIT;
        $('inboxMore').textContent = inboxOpen ? 'Weniger anzeigen' : `Alle ${rows.length} Punkte anzeigen`;
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

    // ---------- Übersicht für viele Fahrzeuge ----------
    // Vier Zustände, die zusammen den ganzen Fuhrpark ergeben – jeweils mit Farbe, Zeichen UND Wort.
    // Schäden, Meldungen, Tank und Tankkarte sind Merkmale an der Zeile, keine eigenen Zustände.
    const STATES = [
        { key: 'ausgegeben', label: 'Ausgegeben', icon: '<path d="M5 12h12M12.500 7.500 17 12l-4.500 4.500"/><path d="M20 5v14"/>' },
        { key: 'frei', label: 'Frei', icon: '<path d="m5 12.500 4.500 4.500L19 7.500"/>' },
        { key: 'reserviert', label: 'Reserviert', icon: '<rect x="5.500" y="11" width="13" height="9" rx="2"/><path d="M8.500 11V8a3.500 3.500 0 0 1 7 0v3"/>' },
        { key: 'werkstatt', label: 'Werkstatt', icon: '<path d="M14.500 6.500a4 4 0 0 0-5.300 5.300L4 17l3 3 5.200-5.200a4 4 0 0 0 5.300-5.300L15 12l-3-3z"/>' }
    ];
    const STATE = Object.fromEntries(STATES.map(item => [item.key, item]));
    const FLAGS = [
        ['ueberfaellig', 'Rückgabe offen', facts => facts.overdue > 0],
        ['schaden', 'Neue Schäden', facts => facts.newDamages > 0],
        ['meldung', 'Offene Meldungen', facts => facts.openAlerts > 0],
        ['reparatur', 'In Reparatur', facts => facts.inRepair > 0],
        ['tank', 'Tank niedrig', (facts, vehicle) => vehicle.fuel != null && vehicle.fuel <= 1],
        ['sauber', 'Nicht sauber', (facts, vehicle) => vehicle.clean_inside === false || vehicle.clean_outside === false],
        ['karte', 'Tankkarte dabei', facts => Boolean(facts.card)]
    ];
    const VIEW_KEY = 'terminTool.fleet.view.v1';
    const readView = () => { try { return JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') || {}; } catch (error) { return {}; } };
    const savedView = readView();
    let fleetView = savedView.view === 'kacheln' ? 'kacheln' : 'liste';
    let fleetSort = ['standard', 'kennzeichen', 'dauer', 'kilometer'].includes(savedView.sort) ? savedView.sort : 'standard';
    const collapsedGroups = new Set(Array.isArray(savedView.collapsed) ? savedView.collapsed : []);
    let fleetQuery = '';
    let fleetModel = '';
    let fleetFlag = '';
    let shownIds = [];               // Reihenfolge der gerade sichtbaren Fahrzeuge (für „voriges / nächstes“ in der Akte)
    let inboxOpen = false;
    const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ view: fleetView, sort: fleetSort, collapsed: [...collapsedGroups] })); } catch (error) { /* Ansicht gilt dann nur für diesen Besuch */ } };
    const svgIcon = paths => `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const fold = text => String(text ?? '').toLocaleLowerCase('de-DE').normalize('NFD').replace(/[̀-ͯ]/g, '');

    // Drei Modelle im Fuhrpark – daraus werden die Modell-Filter. Alles andere läuft unter seiner Marke.
    function modelOf(vehicle) {
        const text = fold(`${vehicle.brand} ${vehicle.label}`);
        if (/v[\s-]?klasse|vito|viano/.test(text)) return 'V-Klasse';
        if (/e[\s-]?klasse/.test(text)) return 'E-Klasse';
        if (/5er|5 er|bmw/.test(text)) return 'BMW 5er';
        return String(vehicle.brand || '').trim() || 'Ohne Modell';
    }

    const startOf = handover => new Date(`${handover.date}T${String(handover.start_time || '00:00').slice(0, 5)}:00`);
    function durationText(minutes) {
        if (minutes < 1) return 'gerade eben';
        if (minutes < 60) return `${minutes} Min`;
        if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} Std ${String(minutes % 60).padStart(2, '0')} Min`;
        const days = Math.floor(minutes / (24 * 60));
        return `${days} ${days === 1 ? 'Tag' : 'Tage'}`;
    }
    function sinceText(handover) {
        const start = startOf(handover);
        const time = String(handover.start_time || '').slice(0, 5);
        return handover.date === TerminCloud.todayIso()
            ? `seit ${time} Uhr`
            : `seit ${start.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })} ${time} Uhr`;
    }

    // Was ist mit diesem Fahrzeug los? Eine Stelle für Übersicht, Filter und Akte.
    function vehicleFacts(vehicle) {
        const own = damages.filter(item => item.vehicle_id === vehicle.id);
        const holder = openHandovers.find(item => item.vehicle_id === vehicle.id) || null;
        const now = new Date();
        // Rückgabe offen: ab 16 Uhr (gelb), seit einem früheren Tag (rot). Notdienst ist ausgenommen.
        const overdue = holder && !holder.emergency && holder.driver_id
            ? (holder.date < TerminCloud.todayIso() ? 2 : now.getHours() >= 16 ? 1 : 0) : 0;
        return {
            holder,
            status: holder ? 'ausgegeben' : vehicle.service_status ? 'werkstatt' : vehicle.assigned_to ? 'reserviert' : 'frei',
            overdue,
            minutesOut: holder ? Math.max(0, Math.round((now - startOf(holder)) / 60000)) : 0,
            card: holder ? fuelCards.find(card => card.holder_id && card.holder_id === holder.driver_id) || null : null,
            last: lastReturns.get(vehicle.id) || null,
            model: modelOf(vehicle),
            newDamages: own.filter(item => item.status === 'offen').length,
            knownDamages: own.filter(item => item.status === 'bekannt').length,
            inRepair: own.filter(item => item.status === 'in Arbeit').length,
            repaired: own.filter(item => item.status === 'erledigt').length,
            openAlerts: alerts.filter(item => item.vehicle_id === vehicle.id && item.status === 'offen').length
        };
    }

    function statePill(vehicle, facts) {
        const state = STATE[facts.status];
        const label = facts.status === 'werkstatt' && vehicle.service_status === 'gesperrt' ? 'Gesperrt' : state.label;
        const node = el('span', 'state-pill');
        node.dataset.state = facts.status;
        node.innerHTML = svgIcon(state.icon);
        node.append(el('span', null, label));
        return node;
    }

    function vehicleBadges(vehicle, facts) {
        const badges = el('span', 'vehicle-card-badges');
        if (facts.holder?.emergency) badges.append(pill('in Arbeit', 'Notdienst'));
        if (facts.overdue) badges.append(pill(facts.overdue > 1 ? 'offen' : 'in Arbeit', 'Rückgabe offen'));
        if (vehicle.service_status) badges.append(pill('bekannt', vehicle.service_status === 'gesperrt' ? 'Gesperrt' : 'Werkstatt'));
        if (facts.newDamages) badges.append(pill('offen', `${facts.newDamages} ${facts.newDamages === 1 ? 'neuer Schaden' : 'neue Schäden'}`));
        if (facts.inRepair) badges.append(pill('in Arbeit', `${facts.inRepair} in Reparatur`));
        if (facts.knownDamages) badges.append(pill('bekannt', `${facts.knownDamages} ${facts.knownDamages === 1 ? 'Altschaden' : 'Altschäden'}`));
        if (facts.openAlerts) badges.append(pill('in Arbeit', `${facts.openAlerts} ${facts.openAlerts === 1 ? 'Meldung' : 'Meldungen'}`));
        if (vehicle.clean_inside === false || vehicle.clean_outside === false) badges.append(pill('offen', 'nicht sauber'));
        if (vehicle.fuel != null && vehicle.fuel <= 1) badges.append(pill('in Arbeit', 'Tank niedrig'));
        if (facts.card) badges.append(pill('bekannt', `Tankkarte ${facts.card.number}`));
        if (!badges.children.length) badges.append(pill('erledigt', 'alles in Ordnung'));
        return badges;
    }

    // Tank als kleine Anzeige mit vier Feldern – plus Wort, damit es auch ohne Farbe lesbar ist.
    function fuelGauge(vehicle) {
        const wrap = el('span', 'tank-gauge');
        if (vehicle.fuel == null) { wrap.append(el('small', null, 'Tank –')); return wrap; }
        const bar = el('span', 'tank-bar');
        bar.dataset.level = String(vehicle.fuel);
        for (let index = 1; index <= 4; index += 1) bar.append(el('i', index <= vehicle.fuel ? 'is-on' : ''));
        wrap.append(bar, el('small', null, FUEL[vehicle.fuel]));
        wrap.title = `Tank: ${FUEL[vehicle.fuel]}`;
        return wrap;
    }

    // Wer / wo / seit wann – der wichtigste Text einer Zeile.
    function whoLines(vehicle, facts) {
        const reserved = vehicle.assigned_to ? `Reserviert für ${profileName(vehicle.assigned_to) || '–'}` : '';
        if (facts.holder) {
            return [
                `${facts.holder.driver_name}${facts.holder.emergency ? ' · Notdienst' : ''}`,
                `${sinceText(facts.holder)} · ${durationText(facts.minutesOut)}`,
                reserved
            ];
        }
        if (facts.status === 'werkstatt') {
            return [
                vehicle.service_note || (vehicle.service_status === 'gesperrt' ? 'Gesperrt' : 'In der Werkstatt'),
                [vehicle.service_since ? `seit ${formatDate(vehicle.service_since)}` : '', vehicle.service_until ? `zurück etwa ${formatDate(vehicle.service_until)}` : ''].filter(Boolean).join(' · '),
                reserved
            ];
        }
        const last = facts.last ? `zuletzt ${facts.last.driver_name}, ${formatDate(facts.last.end_date || facts.last.date)} ${String(facts.last.end_time || '').slice(0, 5)}` : '';
        return [reserved || (vehicle.parking ? `Steht: ${vehicle.parking}` : 'Parkort –'), [reserved && vehicle.parking ? `Steht: ${vehicle.parking}` : '', last].filter(Boolean).join(' · '), ''];
    }

    function flagIcons(vehicle, facts) {
        const wrap = el('span', 'row-flags');
        const add = (kind, text, paths, count) => {
            const node = el('span', 'row-flag');
            node.dataset.kind = kind;
            node.title = text;
            node.setAttribute('aria-label', text);
            node.innerHTML = svgIcon(paths);
            if (count > 1) node.append(el('b', null, String(count)));
            wrap.append(node);
        };
        if (facts.newDamages) add('rot', `${facts.newDamages} ${facts.newDamages === 1 ? 'neuer Schaden' : 'neue Schäden'}`, '<path d="M12 4 3 19.500h18z"/><path d="M12 10v4.500M12 17.200v.300"/>', facts.newDamages);
        if (facts.openAlerts) add('gelb', `${facts.openAlerts} ${facts.openAlerts === 1 ? 'offene Meldung' : 'offene Meldungen'}`, '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.500 2h-15z"/><path d="M10 20.500a2 2 0 0 0 4 0"/>', facts.openAlerts);
        if (facts.inRepair) add('blau', `${facts.inRepair} in Reparatur`, STATE.werkstatt.icon, facts.inRepair);
        if (facts.knownDamages) add('grau', `${facts.knownDamages} ${facts.knownDamages === 1 ? 'Altschaden' : 'Altschäden'}`, '<circle cx="12" cy="12" r="8"/><path d="M12 8v4.500l3 1.500"/>', facts.knownDamages);
        if (vehicle.clean_inside === false || vehicle.clean_outside === false) add('gelb', 'Nicht sauber', '<path d="M12 4c3 4 5 6.500 5 9.500a5 5 0 0 1-10 0C7 10.500 9 8 12 4z"/>', 1);
        if (facts.card) add('grau', `Tankkarte ${facts.card.number} bei ${facts.holder.driver_name}`, '<rect x="3" y="6" width="18" height="12.500" rx="2"/><path d="M3 10h18M7 14.500h4"/>', 1);
        return wrap;
    }

    const FLEET_FILTERS = {
        alle: () => true,
        ausgegeben: (vehicle, facts) => facts.status === 'ausgegeben',
        frei: (vehicle, facts) => facts.status === 'frei',
        reserviert: (vehicle, facts) => facts.status === 'reserviert',
        werkstatt: (vehicle, facts) => facts.status === 'werkstatt'
    };

    function matchesQuery(vehicle, facts) {
        if (!fleetQuery) return true;
        const haystack = fold([vehicle.plate, String(vehicle.plate || '').replace(/[\s-]/g, ''), vehicle.brand, vehicle.body, vehicle.type, vehicle.label, vehicle.parking,
            facts.holder?.driver_name, profileName(vehicle.assigned_to), vehicle.service_note, facts.card?.number].filter(Boolean).join(' '));
        return fold(fleetQuery).split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
    }

    function sortEntries(entries, groupKey) {
        const byPlate = (left, right) => String(left.vehicle.plate).localeCompare(String(right.vehicle.plate), 'de', { numeric: true });
        if (fleetSort === 'kennzeichen') return entries.sort(byPlate);
        if (fleetSort === 'kilometer') return entries.sort((left, right) => (right.vehicle.mileage ?? -1) - (left.vehicle.mileage ?? -1) || byPlate(left, right));
        if (fleetSort === 'dauer') return entries.sort((left, right) => right.facts.minutesOut - left.facts.minutesOut || byPlate(left, right));
        // Wichtiges zuerst: überfällige Rückgaben, dann die längste Ausgabe; freie nach Modell und Kennzeichen.
        if (groupKey === 'ausgegeben') return entries.sort((left, right) => right.facts.overdue - left.facts.overdue || right.facts.minutesOut - left.facts.minutesOut || byPlate(left, right));
        return entries.sort((left, right) => left.facts.model.localeCompare(right.facts.model, 'de') || byPlate(left, right));
    }

    function chip(text, count, pressed, onClick, kind) {
        const button = el('button', 'board-chip');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(pressed));
        if (kind) button.dataset.kind = kind;
        button.append(el('span', null, text));
        if (count != null) button.append(el('b', null, String(count)));
        button.addEventListener('click', onClick);
        return button;
    }

    function vehicleRow(vehicle, facts) {
        const card = el('button', `vehicle-card vehicle-row${vehicle.id === selectedId ? ' is-active' : ''}`);
        card.type = 'button';
        card.dataset.state = facts.status;
        if (facts.overdue) card.dataset.overdue = String(facts.overdue);
        const main = el('span', 'row-main');
        main.append(el('strong', null, vehicle.plate), el('small', null, [vehicle.brand, vehicle.body, vehicle.type].filter(Boolean).join(' · ')));
        const [first, second, third] = whoLines(vehicle, facts);
        const who = el('span', 'row-who');
        who.append(el('strong', null, first));
        if (second) who.append(el('small', facts.overdue ? 'is-overdue' : '', second));
        if (third) who.append(el('small', 'vehicle-reserved', third));
        const numbers = el('span', 'row-numbers');
        numbers.append(el('small', 'row-km', formatKm(vehicle.mileage)), fuelGauge(vehicle));
        card.append(statePill(vehicle, facts), main, who, numbers, flagIcons(vehicle, facts));
        card.setAttribute('aria-label', `${vehicle.plate}, ${STATE[facts.status].label}${facts.holder ? `, ${facts.holder.driver_name}` : ''} – Akte öffnen`);
        card.addEventListener('click', () => selectVehicle(vehicle.id));
        return card;
    }

    function vehicleTile(vehicle, facts) {
        const card = el('button', `vehicle-card vehicle-tile${vehicle.id === selectedId ? ' is-active' : ''}`);
        card.type = 'button';
        card.dataset.state = facts.status;
        if (facts.overdue) card.dataset.overdue = String(facts.overdue);
        const art = el('span', 'vehicle-art');
        fillArt(art, vehicle);
        const head = el('span', 'vehicle-card-head');
        head.append(el('strong', null, vehicle.plate), el('small', null, [vehicle.brand, vehicle.body, vehicle.type].filter(Boolean).join(' · ')));
        const [first, second, third] = whoLines(vehicle, facts);
        const people = el('span', 'vehicle-card-people');
        people.append(el('small', 'tile-who', first));
        if (second) people.append(el('small', facts.overdue ? 'is-overdue' : '', second));
        if (third) people.append(el('small', 'vehicle-reserved', third));
        const factsRow = el('span', 'vehicle-card-facts');
        factsRow.append(el('small', null, formatKm(vehicle.mileage)), fuelGauge(vehicle));
        const chipWrap = el('span', 'tile-state');
        chipWrap.append(statePill(vehicle, facts));
        card.append(art, chipWrap, head, people, factsRow, vehicleBadges(vehicle, facts));
        card.addEventListener('click', () => selectVehicle(vehicle.id));
        return card;
    }

    // ---------- Fahrzeugübersicht ----------
    function renderGrid() {
        const grid = $('vehicleGrid');
        grid.replaceChildren();
        grid.dataset.view = fleetView;
        const all = vehicles.map(vehicle => ({ vehicle, facts: vehicleFacts(vehicle) }));
        const count = name => all.filter(({ vehicle, facts }) => FLEET_FILTERS[name](vehicle, facts)).length;
        $('fleetCountAll').textContent = String(all.length);
        $('fleetCountOut').textContent = String(count('ausgegeben'));
        $('fleetCountFree').textContent = String(count('frei'));
        $('fleetCountReserved').textContent = String(count('reserviert'));
        $('fleetCountService').textContent = String(count('werkstatt'));
        document.querySelectorAll('[data-fleet-filter]').forEach(button => {
            const active = button.dataset.fleetFilter === fleetFilter;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });
        document.querySelectorAll('[data-fleet-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.fleetView === fleetView)));
        $('fleetSort').value = fleetSort;

        // Modell-Filter (nur wenn es mehr als ein Modell gibt) und Auffälligkeiten (nur was es gerade gibt)
        const models = [...new Set(all.map(item => item.facts.model))].sort((left, right) => left.localeCompare(right, 'de'));
        if (fleetModel && !models.includes(fleetModel)) fleetModel = '';
        $('fleetModels').hidden = models.length < 2;
        $('fleetModels').replaceChildren(...(models.length < 2 ? [] : [
            chip('Alle Modelle', null, !fleetModel, () => { fleetModel = ''; renderGrid(); }),
            ...models.map(model => chip(model, all.filter(item => item.facts.model === model).length, fleetModel === model, () => { fleetModel = fleetModel === model ? '' : model; renderGrid(); }))
        ]));
        const flags = FLAGS.map(([key, label, test]) => ({ key, label, test, count: all.filter(({ vehicle, facts }) => test(facts, vehicle)).length })).filter(flag => flag.count > 0);
        if (fleetFlag && !flags.some(flag => flag.key === fleetFlag)) fleetFlag = '';
        $('fleetFlags').hidden = !flags.length;
        $('fleetFlags').replaceChildren(...flags.map(flag => chip(flag.label, flag.count, fleetFlag === flag.key, () => { fleetFlag = fleetFlag === flag.key ? '' : flag.key; renderGrid(); }, flag.key)));

        if (!vehicles.length) {
            $('fleetResult').textContent = '';
            grid.append(el('p', 'directory-empty', 'Noch keine Fahrzeuge. Lege das erste Fahrzeug mit „+ Fahrzeug“ an.'));
            shownIds = [];
            return;
        }
        const flagTest = FLAGS.find(flag => flag[0] === fleetFlag)?.[2];
        const shown = all.filter(({ vehicle, facts }) => FLEET_FILTERS[fleetFilter](vehicle, facts)
            && (!fleetModel || facts.model === fleetModel) && (!flagTest || flagTest(facts, vehicle)) && matchesQuery(vehicle, facts));

        // Ergebniszeile: wie viele sind zu sehen und welche Filter sind aktiv (mit einem Tipp wieder löschen)
        const result = $('fleetResult');
        const active = [fleetFilter !== 'alle' ? STATE[fleetFilter].label : '', fleetModel, FLAGS.find(flag => flag[0] === fleetFlag)?.[1] || '', fleetQuery ? `„${fleetQuery}“` : ''].filter(Boolean);
        result.replaceChildren(el('span', null, active.length ? `${shown.length} von ${all.length} Fahrzeugen · Filter: ${active.join(', ')}` : `${all.length} ${all.length === 1 ? 'Fahrzeug' : 'Fahrzeuge'}`));
        if (active.length) {
            const clear = el('button', 'button-quiet board-clear', 'Filter löschen');
            clear.type = 'button';
            clear.addEventListener('click', () => { fleetFilter = 'alle'; fleetModel = ''; fleetFlag = ''; fleetQuery = ''; $('fleetSearch').value = ''; renderGrid(); });
            result.append(clear);
        }

        shownIds = [];
        if (!shown.length) {
            // Leere Auswahl erklärt sich selbst – bei „Frei“ mit dem Hinweis, was als Nächstes zurückkommt.
            const out = all.filter(item => item.facts.status === 'ausgegeben').sort((left, right) => right.facts.minutesOut - left.facts.minutesOut)[0];
            const text = fleetFilter === 'frei' && !fleetQuery && !fleetModel && !fleetFlag
                ? `Gerade ist kein Fahrzeug frei.${out ? ` Am längsten unterwegs: ${out.vehicle.plate} bei ${out.facts.holder.driver_name} (${sinceText(out.facts.holder)}).` : ''}`
                : 'Für diese Auswahl gibt es gerade kein Fahrzeug.';
            grid.append(el('p', 'directory-empty', text));
            return;
        }

        STATES.forEach(state => {
            const entries = sortEntries(shown.filter(item => item.facts.status === state.key), state.key);
            if (!entries.length) return;
            const group = el('section', 'board-group');
            group.dataset.group = state.key;
            const isCollapsed = collapsedGroups.has(state.key) && fleetFilter === 'alle' && !fleetQuery;
            const head = el('button', 'board-group-head');
            head.type = 'button';
            head.setAttribute('aria-expanded', String(!isCollapsed));
            const title = el('span', 'board-group-title');
            title.innerHTML = svgIcon(state.icon);
            title.append(el('span', null, state.label), el('b', null, String(entries.length)));
            const late = entries.filter(item => item.facts.overdue).length;
            const extra = state.key === 'ausgegeben' && late ? `${late} ${late === 1 ? 'Rückgabe' : 'Rückgaben'} offen`
                : state.key === 'frei' ? [...new Set(entries.map(item => item.facts.model))].map(model => `${entries.filter(item => item.facts.model === model).length} × ${model}`).join(' · ') : '';
            head.append(title, el('small', late && state.key === 'ausgegeben' ? 'is-overdue' : '', extra), el('span', 'board-group-fold', isCollapsed ? 'anzeigen' : 'einklappen'));
            head.addEventListener('click', () => { if (collapsedGroups.has(state.key)) collapsedGroups.delete(state.key); else collapsedGroups.add(state.key); saveView(); renderGrid(); });
            group.append(head);
            if (!isCollapsed) {
                const rows = el('div', fleetView === 'kacheln' ? 'vehicle-grid' : 'board-rows');
                entries.forEach(({ vehicle, facts }) => { shownIds.push(vehicle.id); rows.append(fleetView === 'kacheln' ? vehicleTile(vehicle, facts) : vehicleRow(vehicle, facts)); });
                group.append(rows);
            }
            grid.append(group);
        });
        updateDrawerNav();
    }

    // ---------- Akte als Seitenfenster: Die Übersicht bleibt mit Filter und Stelle erhalten ----------
    function updateDrawerNav() {
        const position = shownIds.indexOf(selectedId);
        $('filePosition').textContent = position >= 0 && shownIds.length > 1 ? `${position + 1} von ${shownIds.length}` : '';
        $('filePrev').disabled = position <= 0;
        $('fileNext').disabled = position < 0 || position >= shownIds.length - 1;
    }

    function closeFile() {
        if ($('vehicleFile').hidden) return;
        const id = selectedId;
        selectedId = null;
        $('vehicleFile').hidden = true;
        $('fileBackdrop').hidden = true;
        document.documentElement.classList.remove('has-drawer');
        renderGrid();
        // Zurück zu der Zeile, von der man kam
        [...document.querySelectorAll('#vehicleGrid .vehicle-card')].find(card => card.getAttribute('aria-label')?.startsWith(`${vehicles.find(vehicle => vehicle.id === id)?.plate},`))?.focus({ preventScroll: true });
    }

    async function selectVehicle(id) {
        const wasOpen = !$('vehicleFile').hidden;
        selectedId = id;
        fileTab = 'current';
        renderGrid();
        await renderFile();
        $('fileBackdrop').hidden = false;
        document.documentElement.classList.add('has-drawer');
        $('vehicleFile').scrollTop = 0;
        if (!wasOpen) $('fileCloseButton').focus({ preventScroll: true });
        updateDrawerNav();
    }
    $('fileCloseButton').addEventListener('click', closeFile);
    $('fileRefresh').addEventListener('click', () => refresh());
    $('fileBackdrop').addEventListener('click', closeFile);
    $('filePrev').addEventListener('click', () => { const position = shownIds.indexOf(selectedId); if (position > 0) selectVehicle(shownIds[position - 1]); });
    $('fileNext').addEventListener('click', () => { const position = shownIds.indexOf(selectedId); if (position >= 0 && position < shownIds.length - 1) selectVehicle(shownIds[position + 1]); });
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !$('vehicleFile').hidden && !document.querySelector('dialog[open]')) closeFile();
    });

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
        const again = requestButton('schaden', item);
        if (again) actions.append(again);
        const reply = feedbackButton('schaden', item);
        if (reply) actions.append(reply);
        if (isAdmin()) actions.append(deleteDamage(item));
        row.append(pill(item.status, CarSketch.STATUS_LABELS[item.status] || item.status), meta, actions);
        return withRequest(row, 'schaden', item);
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
        const again = requestButton('meldung', item);
        if (again) actions.append(again);
        const reply = feedbackButton('meldung', item);
        if (reply) actions.append(reply);
        if (isAdmin()) actions.append(deleteAlert(item));
        row.append(meta, actions);
        return withRequest(row, 'meldung', item);
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
        const service = $('fileService');
        service.hidden = !vehicle.service_status;
        service.textContent = vehicle.service_status
            ? [`${vehicle.service_status === 'gesperrt' ? 'Gesperrt' : 'In der Werkstatt'}${vehicle.service_note ? ` – ${vehicle.service_note}` : ''}`, vehicle.service_since ? `seit ${formatDate(vehicle.service_since)}` : '', vehicle.service_until ? `zurück etwa ${formatDate(vehicle.service_until)}` : ''].filter(Boolean).join(' · ')
            : '';
        $('serviceOpen').textContent = vehicle.service_status ? 'Werkstatt / Sperre ändern' : 'Werkstatt / sperren';
        $('vehicleDelete').hidden = !isAdmin();
        updateDrawerNav();

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
                if (isAdmin()) {
                    const remove = el('button', 'button-quiet-danger', 'Löschen');
                    remove.type = 'button';
                    remove.title = 'Fahrt löschen';
                    remove.addEventListener('click', () => deleteTrip(item));
                    cell.append(remove);
                }
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

    // ---------- Übersicht bedienen: Zustand, Modell, Suche, Sortierung, Ansicht ----------
    document.querySelectorAll('[data-fleet-filter]').forEach(button => button.addEventListener('click', () => {
        // Ein zweiter Tipp auf denselben Zustand zeigt wieder alle.
        fleetFilter = fleetFilter === button.dataset.fleetFilter ? 'alle' : button.dataset.fleetFilter;
        renderGrid();
    }));
    document.querySelectorAll('[data-fleet-view]').forEach(button => button.addEventListener('click', () => { fleetView = button.dataset.fleetView; saveView(); renderGrid(); }));
    $('fleetSort').addEventListener('change', () => { fleetSort = $('fleetSort').value; saveView(); renderGrid(); });
    $('fleetSearch').addEventListener('input', () => { fleetQuery = $('fleetSearch').value.trim(); renderGrid(); });
    $('inboxMore').addEventListener('click', () => { inboxOpen = !inboxOpen; renderInbox(); });

    // ---------- Fahrzeug anlegen und bearbeiten ----------
    let editVehicleId = null;
    function openVehicleDialog(vehicle) {
        editVehicleId = vehicle?.id || null;
        const known = [...$('vehicleFormModel').options].map(option => option.value).filter(Boolean);
        const brand = vehicle?.brand || '';
        $('vehicleDialogTitle').textContent = vehicle ? `${vehicle.plate} bearbeiten` : 'Fahrzeug anlegen';
        $('vehicleFormSubmit').textContent = vehicle ? 'Änderung speichern' : 'Fahrzeug anlegen';
        $('vehicleFormPlate').value = vehicle?.plate || '';
        $('vehicleFormModel').value = !vehicle ? known[0] : known.includes(brand) ? brand : '';
        $('vehicleFormBrand').value = known.includes(brand) ? '' : brand;
        $('vehicleFormBrand').hidden = $('vehicleFormModel').value !== '';
        $('vehicleFormBody').value = ['Limousine', 'Kombi', 'Bus'].includes(vehicle?.body) ? vehicle.body : 'Limousine';
        $('vehicleFormType').value = vehicle?.type === 'Mietwagen' ? 'Mietwagen' : 'Diplomatisch';
        $('vehicleFormLabel').value = vehicle?.label || '';
        $('vehicleFormMileage').value = '';
        // Kilometer eines vorhandenen Fahrzeugs ändert man in der Akte („Kilometerstand korrigieren“).
        $('vehicleFormMileage').hidden = Boolean(vehicle);
        $('vehicleFormMileageLabel').hidden = Boolean(vehicle);
        $('vehicleDialog').showModal();
        $('vehicleFormPlate').focus();
    }
    $('vehicleFormModel').addEventListener('change', () => {
        const other = $('vehicleFormModel').value === '';
        $('vehicleFormBrand').hidden = !other;
        if ($('vehicleFormModel').value === 'Mercedes V-Klasse') $('vehicleFormBody').value = 'Bus';
        if (other) $('vehicleFormBrand').focus();
    });
    $('vehicleAddOpen').addEventListener('click', () => openVehicleDialog(null));
    $('vehicleEditOpen').addEventListener('click', () => openVehicleDialog(vehicles.find(vehicle => vehicle.id === selectedId) || null));
    $('vehicleFormCancel').addEventListener('click', () => $('vehicleDialog').close());
    $('vehicleForm').addEventListener('submit', async event => {
        event.preventDefault();
        const plate = $('vehicleFormPlate').value.trim().toLocaleUpperCase('de-DE').replace(/\s+/g, ' ');
        const key = TerminCloud.plateKey(plate);
        if (!key) { showToast('Bitte trage das Kennzeichen ein.', 'error', { target: '#vehicleFormPlate' }); return; }
        const brand = ($('vehicleFormModel').value || $('vehicleFormBrand').value).trim().replace(/\s+/g, ' ');
        if (!brand) { showToast('Bitte wähle das Modell oder trage Marke und Modell ein.', 'error', { target: '#vehicleFormBrand' }); return; }
        const mileageText = $('vehicleFormMileage').value.trim();
        if (mileageText && !(Number(mileageText) >= 0)) { showToast('Der Kilometerstand muss eine Zahl sein.', 'error', { target: '#vehicleFormMileage' }); return; }
        const twin = allVehicles.find(item => item.plate_key === key && item.id !== editVehicleId);
        if (twin && (twin.active || editVehicleId)) { showToast(`Das Kennzeichen ${twin.plate} gibt es schon${twin.active ? ' im Fuhrpark' : ' (unter „Nicht mehr im Fuhrpark“)'}.`, 'error', { target: '#vehicleFormPlate' }); return; }
        const row = { plate, plate_key: key, brand, body: $('vehicleFormBody').value, type: $('vehicleFormType').value, label: $('vehicleFormLabel').value.trim() };
        const state = mileageText ? { mileage: Number(mileageText), state_updated_at: new Date().toISOString(), state_updated_by: profile.full_name || '' } : {};
        const submit = $('vehicleFormSubmit');
        submit.disabled = true;
        // Ein früher aus dem Fuhrpark genommenes Kennzeichen wird wieder aufgenommen statt doppelt angelegt.
        const result = editVehicleId ? await client.from('tt_vehicles').update(row).eq('id', editVehicleId).select()
            : twin ? await client.from('tt_vehicles').update({ ...row, ...state, active: true }).eq('id', twin.id).select()
                : await client.from('tt_vehicles').insert({ ...row, ...state }).select();
        submit.disabled = false;
        if (result.error || !result.data?.length) {
            showToast(result.error ? (/duplicate|unique/i.test(result.error.message || '') ? 'Dieses Kennzeichen gibt es schon.' : TerminCloud.germanError(result.error)) : 'Das Fahrzeug konnte nicht gespeichert werden.', 'error', { target: '#vehicleFormPlate' });
            return;
        }
        $('vehicleDialog').close();
        showToast(editVehicleId ? `${plate} gespeichert` : twin ? `${plate} ist wieder im Fuhrpark` : `${plate} angelegt`, 'success');
        await refresh();
    });

    // ---------- Werkstatt / gesperrt ----------
    $('serviceOpen').addEventListener('click', () => {
        const vehicle = vehicles.find(item => item.id === selectedId);
        if (!vehicle) return;
        const holder = openHandovers.find(item => item.vehicle_id === vehicle.id);
        $('serviceDialogTitle').textContent = `${vehicle.plate}: Werkstatt / sperren`;
        $('serviceDialogInfo').textContent = holder ? `Das Fahrzeug ist gerade bei ${holder.driver_name}. Die Sperre gilt, sobald es zurück ist.` : '';
        $('serviceDialogInfo').hidden = !holder;
        document.querySelectorAll('input[name=serviceStatus]').forEach(input => { input.checked = input.value === (vehicle.service_status || ''); });
        $('serviceNote').value = vehicle.service_note || '';
        $('serviceUntil').value = vehicle.service_until || '';
        $('serviceDialog').showModal();
    });
    $('serviceCancel').addEventListener('click', () => $('serviceDialog').close());
    $('serviceForm').addEventListener('submit', async event => {
        event.preventDefault();
        const vehicle = vehicles.find(item => item.id === selectedId);
        if (!vehicle) return;
        const status = document.querySelector('input[name=serviceStatus]:checked')?.value || '';
        const { error } = await client.from('tt_vehicles').update({
            service_status: status,
            service_note: status ? $('serviceNote').value.trim() : '',
            service_since: status ? (vehicle.service_status === status && vehicle.service_since ? vehicle.service_since : new Date().toISOString()) : null,
            service_until: status && $('serviceUntil').value ? $('serviceUntil').value : null
        }).eq('id', vehicle.id);
        if (error) { showToast(/service_/.test(error.message || '') ? 'Dafür fehlt noch das Datenbank-Update 13 (supabase/update-13.sql).' : TerminCloud.germanError(error), 'error'); return; }
        $('serviceDialog').close();
        showToast(status === 'werkstatt' ? `${vehicle.plate} ist als „in der Werkstatt“ eingetragen` : status === 'gesperrt' ? `${vehicle.plate} ist gesperrt` : `${vehicle.plate} ist wieder einsatzbereit`, 'success');
        await refresh();
    });

    // ---------- Aus dem Fuhrpark nehmen, wieder aufnehmen, endgültig löschen ----------
    async function retireVehicle(vehicle) {
        const holder = openHandovers.find(item => item.vehicle_id === vehicle.id);
        if (holder) { showToast(`${vehicle.plate} ist gerade bei ${holder.driver_name}. Bitte zuerst die Rückgabe eintragen.`, 'error'); return; }
        if (!await confirmDialog(`${vehicle.plate} aus dem Fuhrpark nehmen?\n\nDas Fahrzeug verschwindet auf allen Geräten und im Portal aus der Liste. Fahrten, Schäden und Meldungen bleiben gespeichert, und du kannst es jederzeit wieder aufnehmen.`, 'Aus dem Fuhrpark nehmen')) return;
        const { error } = await client.from('tt_vehicles').update({ active: false, assigned_to: null }).eq('id', vehicle.id);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        closeFile();
        showToast(`${vehicle.plate} ist nicht mehr im Fuhrpark`, 'success');
        await refresh();
    }

    async function restoreVehicle(vehicle) {
        const { error } = await client.from('tt_vehicles').update({ active: true }).eq('id', vehicle.id);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        showToast(`${vehicle.plate} ist wieder im Fuhrpark`, 'success');
        await refresh();
    }

    // Endgültig löschen darf nur der Admin – mit allen Fahrten, Schäden, Meldungen und Fotos.
    async function deleteVehicle(vehicle) {
        const holder = openHandovers.find(item => item.vehicle_id === vehicle.id);
        if (holder) { showToast(`${vehicle.plate} ist gerade bei ${holder.driver_name}. Bitte zuerst die Rückgabe eintragen.`, 'error'); return; }
        if (!await confirmDialog(`${vehicle.plate} endgültig löschen?\n\nGelöscht werden auch alle Fahrten, Schäden, Meldungen und Fotos dieses Fahrzeugs. Das lässt sich nicht rückgängig machen.\n\nWird das Fahrzeug nur nicht mehr genutzt, wähle besser „Aus dem Fuhrpark nehmen“ – dann bleibt der Verlauf erhalten.`, 'Endgültig löschen')) return;
        const { data, error } = await client.rpc('tt_vehicle_delete', { p_id: vehicle.id });
        if (error) { showToast(/tt_vehicle_delete/.test(error.message || '') ? 'Dafür fehlt noch das Datenbank-Update 13 (supabase/update-13.sql).' : TerminCloud.germanError(error), 'error'); return; }
        const photos = Array.isArray(data?.photos) ? data.photos.filter(Boolean) : [];
        if (photos.length) await client.storage.from('schaeden').remove(photos);
        closeFile();
        showToast(`${vehicle.plate} gelöscht${data ? ` – mit ${data.trips} ${data.trips === 1 ? 'Fahrt' : 'Fahrten'} und ${data.damages} ${data.damages === 1 ? 'Schaden' : 'Schäden'}` : ''}`, 'success');
        await refresh();
    }
    $('vehicleRetire').addEventListener('click', () => { const vehicle = vehicles.find(item => item.id === selectedId); if (vehicle) retireVehicle(vehicle); });
    $('vehicleDelete').addEventListener('click', () => { const vehicle = vehicles.find(item => item.id === selectedId); if (vehicle) deleteVehicle(vehicle); });

    function renderRetired() {
        const retired = allVehicles.filter(vehicle => !vehicle.active).sort((left, right) => String(left.plate).localeCompare(String(right.plate), 'de', { numeric: true }));
        $('retiredSection').hidden = !retired.length;
        $('retiredCount').textContent = String(retired.length);
        $('retiredList').replaceChildren(...retired.map(vehicle => {
            const row = el('li', 'vehicle-entry');
            const meta = el('span');
            meta.append(el('strong', null, vehicle.plate), el('small', null, [vehicle.brand, vehicle.body, vehicle.type, vehicle.mileage != null ? formatKm(vehicle.mileage) : ''].filter(Boolean).join(' · ')));
            const actions = el('span', 'vehicle-entry-actions');
            const back = el('button', 'button-secondary fleet-end-button', 'Wieder aufnehmen');
            back.type = 'button';
            back.addEventListener('click', () => restoreVehicle(vehicle));
            actions.append(back);
            if (isAdmin()) {
                const remove = el('button', 'button-quiet-danger', 'Endgültig löschen');
                remove.type = 'button';
                remove.addEventListener('click', () => deleteVehicle(vehicle));
                actions.append(remove);
            }
            row.append(meta, actions);
            return row;
        }));
    }

    // Eine fehlerhafte Fahrt ganz entfernen (z. B. versehentlich übernommen) – nur der Admin.
    async function deleteTrip(item) {
        const open = !item.end_time;
        if (!await confirmDialog(`Diese Fahrt wirklich löschen?\n\n${formatDate(item.date)} · ${item.driver_name} · ${String(item.start_time).slice(0, 5)} – ${open ? 'offen' : String(item.end_time).slice(0, 5)}${open ? '\n\nDas Fahrzeug ist danach wieder frei.' : ''}\n\nDas lässt sich nicht rückgängig machen.`, 'Fahrt löschen')) return;
        const { data, error } = await client.from('tt_handovers').delete().eq('id', item.id).select();
        if (error || !data?.length) { showToast(error ? TerminCloud.germanError(error) : 'Die Fahrt konnte nicht gelöscht werden.', 'error'); return; }
        showToast('Fahrt gelöscht', 'success');
        await refresh();
    }

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
