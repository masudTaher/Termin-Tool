// Online-Archiv: gespeicherte Tage wieder öffnen und der Verlauf pro Dolmetscher.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    const RESPONSE_LABEL = { offen: 'keine Antwort', zugesagt: 'Zusage', vorbehalt: 'Unter Vorbehalt', abgesagt: 'Absage' };
    const WORK_LABEL = { beendet: 'gearbeitet', alleine: 'Patient ging alleine', storniert: 'storniert', losgefahren: 'unterwegs', offen: 'offen' };
    let days = [];

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };
    const formatDate = iso => { const [year, month, day] = String(iso).split('-'); return `${day}.${month}.${year}`; };

    function setStatus(message, kind = 'info') {
        const status = $('archiveStatus');
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    async function refresh() {
        setStatus('');
        if (!client) { setStatus('Die Verbindung zur Datenbank konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu.', 'error'); return; }
        let profile;
        try { profile = await TerminCloud.getProfile(true); } catch (error) { setStatus(error.message, 'error'); return; }
        if (!TerminCloud.isStaff(profile)) {
            $('archiveApp').hidden = true;
            setStatus('Bitte melde dich zuerst auf der Seite „Team“ an.', 'error');
            return;
        }
        const [dayResult, profileResult] = await Promise.all([
            client.from('tt_days').select('*').order('date', { ascending: false }).limit(400),
            client.from('tt_profiles').select('id, full_name, role').order('full_name')
        ]);
        if (dayResult.error) {
            setStatus(`${TerminCloud.germanError(dayResult.error)} Falls die Tabelle fehlt: supabase/update-3.sql im SQL Editor ausführen.`, 'error');
            return;
        }
        days = dayResult.data;
        $('archiveApp').hidden = false;
        renderDays();

        const select = $('historyPerson');
        const previous = select.value;
        select.replaceChildren(el('option', null, 'Bitte wählen'), ...(profileResult.data || []).filter(item => item.full_name).map(item => {
            const option = el('option', null, item.full_name);
            option.value = item.id;
            return option;
        }));
        select.firstElementChild.value = '';
        select.value = previous;
        if (previous) loadHistory();
    }

    function renderDays() {
        const body = $('dayBody');
        body.replaceChildren();
        $('dayEmpty').hidden = days.length > 0;
        const archived = days.filter(day => day.archived).length;
        $('daysSummary').textContent = `${days.length} ${days.length === 1 ? 'Tag' : 'Tage'}, davon ${archived} abgeschlossen`;
        days.forEach(day => {
            const records = Array.isArray(day.records) ? day.records : [];
            const count = status => records.filter(record => String(record.Status || 'offen') === status).length;
            const row = el('tr');
            [formatDate(day.date), records.length, count('beendet') + count('alleine'), count('storniert')].forEach(value => row.append(el('td', null, String(value))));
            const state = el('td');
            const pill = el('span', 'status-pill', day.archived ? 'abgeschlossen' : 'in Arbeit');
            pill.dataset.status = day.archived ? 'erledigt' : 'in Arbeit';
            state.append(pill);
            row.append(state);
            const action = el('td');
            const open = el('button', 'button-secondary fleet-end-button', 'Im Live-Tracking öffnen');
            open.type = 'button';
            open.addEventListener('click', () => openDay(day));
            action.append(open);
            row.append(action);
            body.append(row);
        });
    }

    // Lädt den Tag in den Arbeitsstand dieses Tabs; von dort aus sind Excel- und PDF-Export möglich.
    async function openDay(day) {
        const current = readTerminRecords();
        if (current?.length) {
            const confirmed = await confirmDialog(`Der Tag ${formatDate(day.date)} ersetzt die Termine, die gerade in diesem Tab geladen sind. Sie bleiben online gespeichert, wenn du angemeldet warst.`, 'Tag öffnen');
            if (!confirmed) return;
        }
        sessionStorage.removeItem('terminTool.trackingUndo.v1');
        if (saveTerminRecords(day.records, 'tracking', { filtered: day.records, removed: [] })) window.location.href = 'termineTracking.html';
    }

    async function loadHistory() {
        const id = $('historyPerson').value;
        const list = $('historyList');
        list.replaceChildren();
        if (!id) { $('historySummary').textContent = 'Wähle eine Person.'; return; }
        const { data, error } = await client.from('tt_assignments').select('*').eq('interpreter_id', id).order('date', { ascending: false }).limit(500);
        if (error) { $('historySummary').textContent = TerminCloud.germanError(error); return; }
        const active = data.filter(item => !item.cancelled);
        const accepted = active.filter(item => item.response === 'zugesagt').length;
        const declined = active.filter(item => item.response === 'abgesagt').length;
        const worked = active.filter(item => item.work_status === 'beendet').length;
        const workedDays = new Set(active.filter(item => item.work_status === 'beendet').map(item => item.date)).size;
        $('historySummary').textContent = `${active.length} ${active.length === 1 ? 'Auftrag' : 'Aufträge'} · ${accepted} Zusagen · ${declined} Absagen · ${worked} gearbeitet an ${workedDays} ${workedDays === 1 ? 'Tag' : 'Tagen'}`;
        if (!data.length) { list.append(el('li', 'directory-empty', 'Für diese Person gibt es noch keine Aufträge.')); return; }
        data.forEach(item => {
            const row = el('li', 'vehicle-entry file-entry');
            const meta = el('span');
            meta.append(
                el('strong', null, `${formatDate(item.date)} · ${item.title}`),
                el('small', null, [item.cancelled ? 'Auftrag zurückgezogen' : `Antwort: ${RESPONSE_LABEL[item.response]}`, item.response_note, item.cancelled ? '' : `Ergebnis: ${WORK_LABEL[item.work_status] || '–'}`].filter(Boolean).join(' · '))
            );
            const pill = el('span', 'status-pill', item.cancelled ? 'zurückgezogen' : RESPONSE_LABEL[item.response]);
            pill.dataset.status = item.cancelled ? 'bekannt' : { offen: 'in Arbeit', zugesagt: 'erledigt', vorbehalt: 'bekannt', abgesagt: 'offen' }[item.response];
            row.append(pill, meta);
            list.append(row);
        });
    }

    $('historyPerson').addEventListener('change', loadHistory);
    $('archiveReload').addEventListener('click', refresh);
    refresh();
})();
