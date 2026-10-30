// Parkgebühren-Abrechnung der Festangestellten (R83): parkgebuehren.html?monat=JJJJ-MM
// Seite 1: Übersicht aller Mitarbeiter/innen mit Anzahl Belege und Betrag, Gesamtsumme, „Sachlich und rechnerisch richtig“,
// Datum und Unterschrift. Danach je Mitarbeiter/in eine Seite mit allen Parkbelegen des Monats (Datum, Ort, Nachweis, Betrag).
// Drucken oder als PDF speichern über den Browser. Nur für Einsatzleitung und Sekretariat (liest tt_receipts, tt_profiles).
(function () {
    const $ = id => document.getElementById(id);
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const client = typeof TerminCloud === 'undefined' ? null : TerminCloud.client;
    const MIN_ROWS = 20;      // so viele Zeilen hat die Tabelle je Mitarbeiter/in mindestens (leere zum Nachtragen)
    const euro = value => `${Number(value || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
    const german = iso => (iso ? new Date(`${String(iso).slice(0, 10)}T12:00:00`).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '');
    const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const defaultMonth = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };   // Vormonat
    function monthRange(value) {
        const [year, number] = value.split('-').map(Number);
        const last = new Date(year, number, 0).getDate();
        return { start: `${value}-01`, end: `${value}-${String(last).padStart(2, '0')}`, label: new Date(year, number - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }) };
    }
    const params = new URLSearchParams(location.search);
    let month = /^\d{4}-\d{2}$/.test(params.get('monat') || '') ? params.get('monat') : defaultMonth();
    let onlyChecked = params.get('alle') !== '1';
    let profile = null;
    let busy = false;

    function state(text, kind = 'info') { $('pkState').textContent = text || ''; $('pkState').dataset.kind = kind; }

    // Kurzname (wie in der Terminliste) und voller Name (aus dem Konto) – der volle steht nur dabei, wenn er mehr sagt.
    const fullNameOf = (group, people) => {
        const account = people.find(item => item.id === group.profile_id);
        const full = String(account?.full_name || '').trim();
        return full && full.toLocaleLowerCase('de-DE') !== group.name.toLocaleLowerCase('de-DE') ? full : '';
    };

    function render(receipts, people, range) {
        const groups = new Map();
        receipts.forEach(item => {
            const key = item.profile_id || `name:${item.person_name}`;
            if (!groups.has(key)) groups.set(key, { key, profile_id: item.profile_id, name: String(item.person_name || '').trim() || 'Ohne Namen', items: [], total: 0 });
            const group = groups.get(key);
            group.items.push(item);
            group.total += Number(item.amount || 0);
        });
        const list = [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, 'de'));
        const total = list.reduce((sum, group) => sum + group.total, 0);
        const count = receipts.length;
        $('pkMonthLabel').textContent = range.label;
        $('pkRange').textContent = `${german(range.start)} – ${german(range.end)}`;
        $('pkPeople').textContent = String(list.length);
        $('pkCount').textContent = String(count);
        $('pkTotal').textContent = euro(total);
        $('pkTotalFoot').textContent = euro(total);
        $('pkDate').textContent = german(todayIso());
        $('pkEmpty').hidden = list.length > 0;
        $('pkOverviewBody').replaceChildren(...list.map((group, index) => {
            const row = el('tr');
            row.append(el('td', 'pk-nr', String(index + 1)), el('td', 'pk-name', group.name), el('td', 'pk-full', fullNameOf(group, people)), el('td', 'pk-num', String(group.items.length)), el('td', 'pk-num', euro(group.total)));
            return row;
        }));
        const template = $('pkPersonTemplate');
        $('pkPersons').replaceChildren(...list.map(group => {
            const page = template.content.firstElementChild.cloneNode(true);
            page.dataset.person = group.name;
            page.querySelector('.pk-person-name').textContent = group.name;
            page.querySelector('.pk-person-full').textContent = fullNameOf(group, people) || group.name;
            page.querySelector('.pk-person-month').textContent = range.label;
            page.querySelector('.pk-person-range').textContent = `${german(range.start)} – ${german(range.end)}`;
            page.querySelector('.pk-person-count').textContent = String(group.items.length);
            page.querySelector('.pk-person-total').textContent = euro(group.total);
            page.querySelector('.pk-person-sum').textContent = euro(group.total);
            const body = page.querySelector('.pk-person-body');
            const items = [...group.items].sort((left, right) => String(left.date).localeCompare(String(right.date)) || String(left.created_at).localeCompare(String(right.created_at)));
            items.forEach((item, index) => {
                const row = el('tr');
                row.append(el('td', 'pk-nr', String(index + 1)), el('td', 'pk-date', german(item.date)), el('td', '', [item.place, item.note].filter(Boolean).join(' – ') || '–'), el('td', 'pk-proof', item.proof || 'Parkbeleg'), el('td', 'pk-num', euro(item.amount)));
                if (item.status === 'eingereicht') row.classList.add('is-unchecked');
                body.append(row);
            });
            for (let index = items.length; index < MIN_ROWS; index += 1) { const row = el('tr', 'pk-blank'); row.append(el('td', 'pk-nr', ''), el('td'), el('td'), el('td'), el('td')); body.append(row); }
            return page;
        }));
        document.title = `Parkgebühren ${range.label} · Medical Office Bonn`;
    }

    async function load() {
        if (!client) { state('Die Verbindung zur Datenbank konnte nicht geladen werden.', 'error'); return; }
        if (busy) return;
        busy = true;
        try {
            if (!profile) { try { profile = await TerminCloud.getProfile(true); } catch (error) { profile = null; } }
            if (!TerminCloud.isStaff(profile)) { $('pkDoc').hidden = true; state('Bitte zuerst auf der Seite „Team“ anmelden (Einsatzleitung oder Sekretariat).', 'error'); return; }
            const range = monthRange(month);
            state('Wird geladen …');
            const [receiptResult, profileResult] = await Promise.all([
                client.from('tt_receipts').select('*').gte('date', range.start).lte('date', range.end).order('date'),
                client.from('tt_profiles').select('*').order('full_name')
            ]);
            if (receiptResult.error) { state(TerminCloud.germanError(receiptResult.error), 'error'); return; }
            const people = profileResult.data || [];
            const festIds = new Set(people.filter(item => item.employment === 'fest').map(item => item.id));
            // Nur Parkbelege der Festangestellten; abgelehnte nie; „nur geprüfte“ lässt die noch nicht geprüften weg.
            const all = (receiptResult.data || []).filter(item => festIds.has(item.profile_id) && item.kind === 'Parken' && item.status !== 'abgelehnt');
            const unchecked = all.filter(item => item.status === 'eingereicht').length;
            const receipts = onlyChecked ? all.filter(item => item.status === 'geprüft') : all;
            render(receipts, people, range);
            $('pkDoc').hidden = false;
            state(unchecked ? (onlyChecked ? `${unchecked} ${unchecked === 1 ? 'Beleg ist' : 'Belege sind'} noch nicht geprüft und ${unchecked === 1 ? 'fehlt' : 'fehlen'} hier – erst prüfen oder „Nur geprüfte Belege“ ausschalten.` : `${unchecked} ${unchecked === 1 ? 'Beleg ist' : 'Belege sind'} noch nicht geprüft (grau markiert).`) : `${receipts.length} ${receipts.length === 1 ? 'Parkbeleg' : 'Parkbelege'} · alle geprüft.`, unchecked ? 'warn' : 'ok');
            const url = new URL(location.href);
            url.searchParams.set('monat', month);
            if (onlyChecked) url.searchParams.delete('alle'); else url.searchParams.set('alle', '1');
            history.replaceState(null, '', url);
        } finally { busy = false; }
    }

    $('pkMonth').value = month;
    $('pkOnlyChecked').checked = onlyChecked;
    $('pkMonth').addEventListener('change', () => { if (/^\d{4}-\d{2}$/.test($('pkMonth').value)) { month = $('pkMonth').value; load(); } });
    $('pkOnlyChecked').addEventListener('change', () => { onlyChecked = $('pkOnlyChecked').checked; load(); });
    $('pkPrint').addEventListener('click', () => window.print());
    window.ParkApp = { load, state: () => ({ month, onlyChecked }) };
    load();
})();
