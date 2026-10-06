// Seite „Neue Termine“ (Büro): Termine, die Dolmetscher aus der Praxis oder Klinik mitbringen.
// Übersichtliche Tabelle, nach dem Datum des Termins sortiert (der nächste Termin steht oben). Ein Klick auf
// „Eingetragen ✓“ hakt einen Termin ab, sobald er in FileMaker steht – er wandert dann ins Archiv („Eingetragen“).
// Korrigieren, Zurückholen und Löschen bleiben immer möglich. Export als Excel-Datei mit den Spaltennamen der Terminliste.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const BUCKET = 'dokumente';
    const PAYER = { selbstzahler: 'Selbstzahler', kostenuebernahme: 'Kostenübernahme', unbekannt: 'unklar' };
    const PAYER_SHORT = { selbstzahler: 'SZ', kostenuebernahme: 'KÜ', unbekannt: '?' };
    let profile = null;
    let rows = [];
    let filter = 'neu';
    let query = '';
    let editing = null;

    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const clean = value => String(value ?? '').trim();
    const fold = text => clean(text).toLocaleLowerCase('de-DE').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss');
    const clock = value => clean(value).slice(0, 5);
    const deDate = iso => iso ? iso.split('-').reverse().join('.') : '';
    const dayText = iso => iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
    const stampText = iso => iso ? new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const daysUntil = iso => Math.round((new Date(`${iso}T00:00:00`) - new Date(`${TerminCloud.todayIso()}T00:00:00`)) / 86400000);

    function setStatus(message, kind = 'info') {
        const status = $('apptStatus');
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    // Wie dringend ist der Termin? (Text und Farbe unter dem Datum)
    function urgency(item) {
        const days = daysUntil(item.date);
        if (days < 0) return ['vorbei', 'past'];
        if (days === 0) return ['heute', 'now'];
        if (days === 1) return ['morgen', 'now'];
        if (days <= 3) return [`in ${days} Tagen`, 'soon'];
        if (days <= 7) return [`in ${days} Tagen`, 'week'];
        return [`in ${days} Tagen`, ''];
    }

    // Neu und Alle: der nächste Termin zuerst. Eingetragen: zuletzt abgehakt zuerst.
    function sorted(list) {
        const byDate = (left, right) => `${left.date} ${clock(left.time) || '99:99'}`.localeCompare(`${right.date} ${clock(right.time) || '99:99'}`) || String(left.created_at).localeCompare(String(right.created_at));
        if (filter === 'eingetragen') return [...list].sort((left, right) => String(right.handled_at || '').localeCompare(String(left.handled_at || '')) || byDate(left, right));
        return [...list].sort(byDate);
    }

    function visible() {
        const needle = fold(query);
        return sorted(rows.filter(item => filter === 'alle' || item.status === filter).filter(item => !needle || fold([
            item.patient_nr, item.patient_name, deDate(item.date), clock(item.time), item.place, item.city, item.doctor, item.description,
            PAYER[item.payer], PAYER_SHORT[item.payer], item.reporter_name, item.office_note
        ].join(' ')).includes(needle)));
    }

    function button(className, text, onClick, title) {
        const node = el('button', className, text);
        node.type = 'button';
        if (title) node.title = title;
        node.addEventListener('click', () => onClick(node));
        return node;
    }

    function render() {
        const counts = { neu: rows.filter(item => item.status === 'neu').length, eingetragen: rows.filter(item => item.status === 'eingetragen').length };
        $('apptCountNew').textContent = counts.neu;
        $('apptCountDone').textContent = counts.eingetragen;
        document.querySelectorAll('[data-appt-filter]').forEach(node => node.setAttribute('aria-pressed', String(node.dataset.apptFilter === filter)));
        const list = visible();
        const body = $('apptBody');
        $('apptExport').disabled = !list.length;
        const sortText = filter === 'eingetragen' ? 'zuletzt abgehakt zuerst' : 'nach Datum sortiert, der nächste Termin steht oben';
        $('apptSummary').textContent = list.length
            ? `${list.length} ${list.length === 1 ? 'Termin' : 'Termine'} – ${sortText}.`
            : '';
        if (!list.length) {
            const cell = el('td', 'appt-empty', query ? 'Kein Termin passt zur Suche.'
                : filter === 'neu' ? 'Keine neuen Termine. Alles eingetragen.'
                : filter === 'eingetragen' ? 'Noch kein Termin als eingetragen abgehakt.' : 'Noch kein Termin gemeldet.');
            cell.colSpan = 8;
            const row = el('tr');
            row.append(cell);
            body.replaceChildren(row);
            return;
        }
        let lastDate = '';
        body.replaceChildren(...list.map(item => {
            const row = el('tr', item.status === 'eingetragen' ? 'is-done' : '');
            row.dataset.id = item.id;
            // Neuer Tag = kräftigere Linie: so sieht man auf einen Blick, was zusammengehört.
            if (filter !== 'eingetragen' && lastDate && item.date !== lastDate) row.classList.add('is-new-day');
            lastDate = item.date;

            const patient = el('td', 'appt-nr');
            patient.append(el('strong', '', item.patient_nr || '–'), el('span', '', item.patient_name || '–'));

            const when = el('td', 'appt-when-cell');
            when.append(el('strong', '', dayText(item.date)), el('span', '', clock(item.time) ? `${clock(item.time)} Uhr` : 'Uhrzeit offen'));
            if (item.status === 'neu') {
                const [text, kind] = urgency(item);
                const tag = el('span', 'appt-urgency', text);
                if (kind) tag.dataset.kind = kind;
                when.append(tag);
            }

            const place = el('td');
            place.append(el('strong', '', item.place || '–'));
            if (item.city) place.append(el('span', 'appt-sub', item.city));
            const doctor = el('td', '', item.doctor || '–');

            const what = el('td', 'appt-what');
            what.append(el('span', '', item.description || '–'));
            if (item.office_note) what.append(el('span', 'appt-note', `Büro: ${item.office_note}`));

            const cost = el('td');
            const pill = el('span', 'appt-payer', PAYER_SHORT[item.payer] || '?');
            pill.dataset.payer = item.payer || 'unbekannt';
            cost.append(pill, el('span', 'appt-sub', PAYER[item.payer] || 'unklar'));

            const who = el('td', 'appt-who');
            who.append(el('span', '', item.reporter_name || '–'), el('span', 'appt-sub', stampText(item.created_at)));
            if (item.file_path) who.append(button('button-secondary appt-slip', 'Zettel ansehen', node => openSlip(item, node), 'Terminzettel in einem neuen Fenster öffnen'));
            else who.append(el('span', 'appt-sub appt-noslip', 'kein Terminzettel'));

            const action = el('td', 'appt-actions');
            if (item.status === 'neu') {
                action.append(button('button-primary appt-done', 'Eingetragen ✓', node => setStatusOf(item, 'eingetragen', node), 'Der Termin steht in FileMaker – abhaken und ins Archiv legen'));
            } else {
                action.append(el('span', 'appt-sub appt-handled', `eingetragen ${stampText(item.handled_at)}${item.handled_by ? ` · ${item.handled_by}` : ''}`),
                    button('button-quiet', 'Zurück auf neu', node => setStatusOf(item, 'neu', node), 'Doch noch nicht eingetragen – wieder in die Liste „Neu“'));
            }
            const more = el('span', 'appt-more');
            more.append(button('button-quiet', 'Kopieren', () => copyRow(item), 'Alle Angaben als Text kopieren – zum Einfügen in FileMaker'),
                button('button-quiet', 'Korrigieren', () => openEdit(item)),
                button('button-quiet-danger', 'Löschen', node => removeRow(item, node)));
            action.append(more);

            row.append(patient, when, place, doctor, what, cost, who, action);
            return row;
        }));
    }

    // ---------- Aktionen ----------
    async function setStatusOf(item, status, node, silent = false) {
        if (node) node.disabled = true;
        const fields = status === 'eingetragen'
            ? { status, handled_at: new Date().toISOString(), handled_by: profile.full_name || '' }
            : { status, handled_at: null, handled_by: '' };
        const { error } = await client.from('tt_new_appointments').update(fields).eq('id', item.id);
        if (error) { if (node) node.disabled = false; showToast(TerminCloud.germanError(error), 'error'); return; }
        Object.assign(item, fields);
        render();
        window.refreshCloudInbox?.();
        if (silent) return;
        const label = [item.patient_nr, item.patient_name].filter(Boolean).join(' · ') || 'Termin';
        if (status === 'eingetragen') {
            showToast(`${label}: als eingetragen abgehakt.`, 'success', { actionLabel: 'Rückgängig', onAction: () => setStatusOf(item, 'neu', null, true), duration: 9000 });
        } else {
            showToast(`${label}: steht wieder unter „Neu“.`, 'success');
        }
    }

    async function signedUrl(item) {
        const { data, error } = await client.storage.from(BUCKET).createSignedUrl(item.file_path, 600);
        if (error || !data?.signedUrl) throw new Error(error?.message || 'Datei nicht gefunden');
        return data.signedUrl;
    }
    // Der Tab entsteht sofort beim Klick – nach dem Warten auf die Adresse würden ihn manche Browser blockieren.
    async function openSlip(item, node) {
        const tab = window.open('', '_blank');
        node.disabled = true;
        try {
            const url = await signedUrl(item);
            if (tab && !tab.closed) { tab.opener = null; tab.location.replace(url); }
            else showToast('Der Browser hat das neue Fenster blockiert.', 'info', { actionLabel: 'Terminzettel öffnen', onAction: () => window.open(url, '_blank', 'noopener'), duration: 15000 });
        } catch (error) {
            tab?.close();
            showToast(`Der Terminzettel konnte nicht geöffnet werden: ${error.message}`, 'error');
        } finally {
            node.disabled = false;
        }
    }

    function rowText(item) {
        return [
            `Patient: ${[item.patient_nr, item.patient_name].filter(Boolean).join(' · ')}`,
            `Termin: ${deDate(item.date)}${clock(item.time) ? ` um ${clock(item.time)} Uhr` : ''}`,
            `Wo: ${[item.place, item.city].filter(Boolean).join(', ')}`,
            item.doctor ? `Arzt / Abteilung: ${item.doctor}` : '',
            `Wofür: ${item.description}`,
            `Kosten: ${PAYER[item.payer] || 'unklar'}`,
            `Gemeldet von: ${item.reporter_name}`
        ].filter(Boolean).join('\n');
    }
    async function copyRow(item) {
        try {
            await navigator.clipboard.writeText(rowText(item));
            showToast('Angaben kopiert – in FileMaker mit Strg + V einfügen.', 'success');
        } catch (error) {
            showToast('Kopieren hat nicht geklappt. Bitte markiere den Text in der Zeile von Hand.', 'error');
        }
    }

    async function removeRow(item, node) {
        const label = [item.patient_nr, item.patient_name, deDate(item.date)].filter(Boolean).join(' · ');
        if (!await confirmDialog(`Diese Meldung endgültig löschen?\n${label}\n\nEintrag und Terminzettel lassen sich danach nicht wiederherstellen. Soll der Termin nur aus der Liste „Neu“ verschwinden, nimm „Eingetragen ✓“.`, 'Löschen')) return;
        node.disabled = true;
        const { error } = await client.from('tt_new_appointments').delete().eq('id', item.id);
        if (error) { node.disabled = false; showToast(TerminCloud.germanError(error), 'error'); return; }
        if (item.file_path) await client.storage.from(BUCKET).remove([item.file_path]).catch(() => null);
        rows = rows.filter(other => other.id !== item.id);
        render();
        window.refreshCloudInbox?.();
        showToast('Meldung gelöscht.', 'success');
    }

    // ---------- Korrigieren ----------
    const EDIT_FIELDS = { apptEditNr: 'patient_nr', apptEditName: 'patient_name', apptEditDate: 'date', apptEditTime: 'time', apptEditPlace: 'place', apptEditCity: 'city', apptEditDoctor: 'doctor', apptEditPayer: 'payer', apptEditDescription: 'description', apptEditNote: 'office_note' };
    // Vorschläge beim Tippen: alles, was schon einmal gemeldet wurde (Krankenhäuser, Orte, Ärzte).
    function fillLists() {
        const options = (id, values) => {
            let list = $(id);
            if (!list) { list = el('datalist'); list.id = id; document.body.append(list); }
            const counted = new Map();
            values.map(clean).filter(Boolean).forEach(value => counted.set(value, (counted.get(value) || 0) + 1));
            list.replaceChildren(...[...counted].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'de')).slice(0, 200).map(([value]) => { const option = el('option'); option.value = value; return option; }));
        };
        options('apptPlaceList', [...rows.map(item => item.place), ...learned.map(item => item.place)]);
        options('apptCityList', [...rows.map(item => item.city), ...learned.map(item => item.city)]);
        options('apptDoctorList', [...rows.map(item => item.doctor), ...learned.map(item => item.doctor)]);
        $('apptEditPlace').setAttribute('list', 'apptPlaceList');
        $('apptEditCity').setAttribute('list', 'apptCityList');
        $('apptEditDoctor').setAttribute('list', 'apptDoctorList');
    }
    function openEdit(item) {
        editing = item;
        Object.entries(EDIT_FIELDS).forEach(([id, key]) => { $(id).value = key === 'time' ? clock(item.time) : (item[key] ?? ''); });
        fillLists();
        $('apptEditDialog').showModal();
    }
    $('apptEditCancel').addEventListener('click', () => $('apptEditDialog').close());
    $('apptEditForm').addEventListener('submit', async event => {
        event.preventDefault();
        if (!editing) return;
        const fields = Object.fromEntries(Object.entries(EDIT_FIELDS).map(([id, key]) => [key, clean($(id).value)]));
        if (!fields.patient_nr) { $('apptEditNr').focus(); showToastOverDialog('Die Patientennummer darf nicht leer sein.'); return; }
        if (!fields.date) { $('apptEditDate').focus(); showToastOverDialog('Das Datum darf nicht leer sein.'); return; }
        if (!fields.place) { $('apptEditPlace').focus(); showToastOverDialog('Krankenhaus oder Praxis darf nicht leer sein.'); return; }
        fields.time = fields.time || null;
        const submit = $('apptEditForm').querySelector('[type="submit"]');
        submit.disabled = true;
        const { error } = await client.from('tt_new_appointments').update(fields).eq('id', editing.id);
        submit.disabled = false;
        if (error) { showToastOverDialog(TerminCloud.germanError(error)); return; }
        Object.assign(editing, fields);
        editing = null;
        $('apptEditDialog').close();
        render();
        showToast('Korrektur gespeichert.', 'success');
    });
    // Eine Einblendung läge hinter dem offenen Dialog – deshalb steht die Meldung im Dialog selbst.
    function showToastOverDialog(message) {
        let note = $('apptEditProblem');
        if (!note) { note = el('p', 'workflow-status'); note.id = 'apptEditProblem'; note.dataset.kind = 'error'; note.setAttribute('role', 'alert'); $('apptEditForm').prepend(note); }
        note.textContent = message;
        note.hidden = false;
    }
    $('apptEditDialog').addEventListener('close', () => { const note = $('apptEditProblem'); if (note) note.hidden = true; });

    // ---------- Export für FileMaker ----------
    // Spaltennamen wie in der Terminliste aus FileMaker: beim Importieren („Datei › Datensätze importieren“) ordnet
    // FileMaker gleiche Feldnamen von selbst zu. In der Bemerkung steht vorn der Kostenmarker (KG oder SZ).
    function exportRows() {
        const list = visible();
        if (!list.length) return;
        if (typeof XLSX === 'undefined') { showToast('Die Excel-Funktion konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu.', 'error'); return; }
        const marker = { selbstzahler: 'SZ', kostenuebernahme: 'KG' };
        const header = ['Termin_Datum', 'Termin_Uhrzeit', 'Patient_Nr', 'Patienten Nr::Patienten_Name', 'Arzt Nr::Name', 'Arzt Nr::Ort', 'Bemerkung', 'Kostengarantie Ja Nein', 'Arzt / Abteilung', 'Wofür', 'Kosten', 'Gemeldet von', 'Gemeldet am', 'Status'];
        const lines = list.map(item => [
            deDate(item.date), clock(item.time), item.patient_nr, item.patient_name, item.place, item.city,
            [marker[item.payer] || '', item.description, item.doctor ? `Arzt: ${item.doctor}` : '', item.reporter_name ? `gemeldet von ${item.reporter_name}` : ''].filter(Boolean).join(' · '),
            item.payer === 'kostenuebernahme' ? 'Ja' : item.payer === 'selbstzahler' ? 'Nein' : '',
            item.doctor, item.description, PAYER[item.payer] || 'unklar', item.reporter_name, stampText(item.created_at), item.status
        ]);
        const sheet = XLSX.utils.aoa_to_sheet([header, ...lines]);
        sheet['!cols'] = [12, 9, 11, 26, 30, 16, 60, 12, 24, 40, 16, 20, 14, 12].map(wch => ({ wch }));
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, 'Neue Termine');
        const names = { neu: 'neu', eingetragen: 'eingetragen', alle: 'alle' };
        XLSX.writeFile(book, `Neue Termine ${names[filter]} ${deDate(TerminCloud.todayIso())}.xlsx`);
        showToast(`${list.length} ${list.length === 1 ? 'Termin' : 'Termine'} exportiert. In FileMaker: Datei › Datensätze importieren › Datei.`, 'success', { duration: 9000 });
    }

    // ---------- Laden ----------
    let learned = [];
    let loading = false;
    async function refresh(quiet = false) {
        if (loading) return;
        loading = true;
        try {
            if (!quiet) setStatus('');
            if (!client) { setStatus('Die Verbindung zur Datenbank konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu.', 'error'); return; }
            try { profile = await TerminCloud.getProfile(!quiet); } catch (error) { if (!quiet) setStatus(error.message, 'error'); return; }
            if (!TerminCloud.isStaff(profile)) { $('apptApp').hidden = true; setStatus('Bitte melde dich zuerst auf der Seite „Team“ an.', 'error'); return; }
            const { data, error } = await client.from('tt_new_appointments').select('*').order('date', { ascending: true }).limit(1000);
            if (error) {
                if (quiet) return;
                $('apptApp').hidden = true;
                setStatus(/does not exist|schema cache|could not find/i.test(error.message || '')
                    ? 'Neue Termine sind in der Datenbank noch nicht eingerichtet. Bitte supabase/update-18.sql im SQL Editor ausführen.'
                    : TerminCloud.germanError(error), 'error');
                return;
            }
            rows = data || [];
            $('apptApp').hidden = false;
            setStatus('');
            render();
            if (!learned.length) client.rpc('tt_appointment_suggestions').then(result => { if (!result.error && Array.isArray(result.data)) learned = result.data; }).catch(() => null);
        } finally {
            loading = false;
        }
    }

    document.querySelectorAll('[data-appt-filter]').forEach(node => node.addEventListener('click', () => { filter = node.dataset.apptFilter; render(); }));
    $('apptSearch').addEventListener('input', () => { query = $('apptSearch').value; render(); });
    $('apptReload').addEventListener('click', () => refresh());
    $('apptExport').addEventListener('click', exportRows);
    // Neue Meldungen erscheinen von selbst: beim Zurückkehren auf die Seite und alle 45 Sekunden –
    // aber nicht, während gerade korrigiert wird.
    const idle = () => !document.hidden && !$('apptEditDialog').open && !document.querySelector('dialog.confirm-dialog[open]:not(#apptEditDialog)');
    document.addEventListener('visibilitychange', () => { if (idle()) refresh(true); });
    window.setInterval(() => { if (idle()) refresh(true); }, 45000);

    refresh();
})();
