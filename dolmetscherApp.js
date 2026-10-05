// Dolmetscher-Übersicht für viele Personen: wer ist unterwegs, wer ist frei, wer fehlt – heute, morgen oder an einem
// anderen Tag. Dazu die Tagesanfrage „Kannst du morgen arbeiten?“ und je Person ein Seitenfenster mit allen Angaben.
// Die Auswertung selbst steht in peopleLive.js; die Namensliste (zweiter Reiter) bleibt in teamDirectory.js.
(function () {
    const $ = id => document.getElementById(id);
    const client = typeof TerminCloud !== 'undefined' ? TerminCloud.client : null;
    const logic = window.AbsenceLogic;
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    const button = (className, text, onClick) => { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', onClick); return node; };
    const svgIcon = (paths, size = 15) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    const fold = text => String(text ?? '').toLocaleLowerCase('de-DE').normalize('NFD').replace(/[̀-ͯ]/g, '');
    const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

    // Fünf Zustände, die zusammen alle Personen ergeben – jeweils mit Farbe, Zeichen UND Wort.
    // „label“ gilt für heute, „plan“ für jeden anderen Tag (dort gibt es kein „unterwegs“).
    const STATES = [
        { key: 'unterwegs', label: 'Unterwegs', plan: 'Unterwegs', icon: '<path d="M5 12h12M12.500 7.500 17 12l-4.500 4.500"/><path d="M20 5v14"/>' },
        { key: 'frei', label: 'Frei', plan: 'Kommt', icon: '<path d="m5 12.500 4.500 4.500L19 7.500"/>' },
        { key: 'abwesend', label: 'Abwesend', plan: 'Abwesend', icon: '<rect x="4" y="5.500" width="16" height="14.500" rx="2"/><path d="M4 10h16M9.500 13.500l5 4M14.500 13.500l-5 4"/>' },
        { key: 'nichtda', label: 'Nicht da', plan: 'Kommt nicht', icon: '<circle cx="12" cy="12" r="8.500"/><path d="M8 12h8"/>' },
        { key: 'offen', label: 'Keine Angabe', plan: 'Keine Antwort', icon: '<circle cx="12" cy="12" r="8.500"/><path d="M9.700 9.500a2.400 2.400 0 1 1 3.500 2.100c-.800.500-1.200 1-1.200 1.900M12 16.500h.01"/>' }
    ];
    const STATE = Object.fromEntries(STATES.map(item => [item.key, item]));
    const CAR_ICON = '<path d="M5 16.500V12l1.800-5a2 2 0 0 1 1.900-1.300h6.600A2 2 0 0 1 17.200 7L19 12v4.500"/><path d="M4 12h16"/><circle cx="7.500" cy="16.500" r="1.800"/><circle cx="16.500" cy="16.500" r="1.800"/>';
    const VIEW_KEY = 'terminTool.crew.view.v1';
    const savedView = (() => { try { return JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') || {}; } catch (error) { return {}; } })();
    const collapsed = new Set(Array.isArray(savedView.collapsed) ? savedView.collapsed : []);
    let sort = ['standard', 'name', 'auftraege'].includes(savedView.sort) ? savedView.sort : 'standard';
    const saveView = () => { try { localStorage.setItem(VIEW_KEY, JSON.stringify({ sort, collapsed: [...collapsed] })); } catch (error) { /* gilt dann nur für diesen Besuch */ } };

    const params = new URLSearchParams(location.search);
    let tab = params.get('reiter') === 'liste' ? 'names' : 'board';
    let profile = null;
    let data = null;                 // Auswertung des gewählten Tages (PeopleLive.load)
    let date = '';                   // gewählter Tag (JJJJ-MM-TT)
    let filter = 'alle';
    let chipFilter = '';
    let query = '';
    let shownKeys = [];              // Reihenfolge der sichtbaren Personen (für „vorige / nächste“ im Seitenfenster)
    let selectedKey = null;
    let lastFocus = null;
    let loading = false;

    const today = () => TerminCloud.todayIso();
    const tomorrow = () => logic.addDays(today(), 1);
    const dayLong = text => logic.parse(text).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });
    const dayWord = text => text === today() ? 'heute' : text === tomorrow() ? 'morgen' : `am ${dayLong(text)}`;
    const isPlan = () => date !== today();
    const stateLabel = key => (isPlan() ? STATE[key].plan : STATE[key].label);
    const genderWord = person => person.gender === 'weiblich' ? 'Dolmetscherin' : person.gender === 'männlich' ? 'Dolmetscher' : '';
    function durationText(minutes) {
        if (minutes == null) return '';
        if (minutes < 1) return 'gerade eben';
        if (minutes < 60) return `${minutes} Min`;
        return `${Math.floor(minutes / 60)} Std ${String(minutes % 60).padStart(2, '0')} Min`;
    }
    const genderSplit = list => {
        const women = list.filter(person => person.gender === 'weiblich').length;
        const men = list.filter(person => person.gender === 'männlich').length;
        return women + men ? `${plural(women, 'Frau', 'Frauen')} · ${plural(men, 'Mann', 'Männer')}` : '';
    };

    function setStatus(message, kind = 'info') {
        const status = $('crewStatus');
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    // ---------- Reiter ----------
    function showTab() {
        document.querySelectorAll('[data-crew-tab]').forEach(node => { const active = node.dataset.crewTab === tab; node.classList.toggle('is-active', active); node.setAttribute('aria-selected', String(active)); });
        document.querySelectorAll('[data-crew-panel]').forEach(panel => { panel.hidden = panel.dataset.crewPanel !== tab; });
        $('crewReload').hidden = tab !== 'board';
        if (tab !== 'board') $('crewStatus').hidden = true;
        else if ($('crewStatus').textContent) $('crewStatus').hidden = false;
    }
    document.querySelectorAll('[data-crew-tab]').forEach(node => node.addEventListener('click', () => { tab = node.dataset.crewTab; showTab(); if (tab === 'board' && !data) load(); }));

    // ---------- Laden ----------
    async function load() {
        if (loading) return;
        if (!client) { $('crewBoard').hidden = true; setStatus('Die Verbindung zur Datenbank konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu. Die Namensliste funktioniert auch ohne Internet.', 'error'); return; }
        loading = true;
        try {
            profile = await TerminCloud.getProfile();
            if (!TerminCloud.isStaff(profile)) {
                $('crewBoard').hidden = true;
                setStatus('Die Übersicht zeigt, wer heute arbeitet – dafür bitte zuerst auf der Seite „Team“ anmelden. Die Namensliste (zweiter Reiter) geht auch ohne Anmeldung.', 'info');
                return;
            }
            if (!date) {
                const wanted = params.get('tag');
                date = wanted === 'morgen' ? tomorrow() : /^\d{4}-\d{2}-\d{2}$/.test(wanted || '') ? wanted : today();
            }
            data = await PeopleLive.load(date);
            setStatus(data.ready ? '' : 'Abwesenheiten und die Tagesanfrage sind in der Datenbank noch nicht eingerichtet (supabase/update-15.sql fehlt). Die Übersicht zeigt bis dahin nur Arbeitstage, Aufträge und Fahrzeuge.', 'error');
            $('crewBoard').hidden = false;
            render();
            if (selectedKey) fillFile();
        } catch (error) {
            setStatus(`Die Übersicht konnte nicht geladen werden: ${error.message || error}`, 'error');
        } finally {
            loading = false;
        }
    }

    // ---------- Was steht in einer Zeile? ----------
    function describe(person) {
        const plan = isPlan();
        const jobsText = person.jobs.total ? plural(person.jobs.total, 'Auftrag', 'Aufträge') : '';
        if (person.state === 'unterwegs') {
            return { main: [person.current.time ? `${person.current.time} Uhr` : '', person.current.title].filter(Boolean).join(' · '),
                sub: person.current.since ? `seit ${person.current.since} Uhr${person.sinceMinutes != null ? ` · ${durationText(person.sinceMinutes)}` : ''}` : 'unterwegs' };
        }
        if (person.state === 'abwesend') {
            return { main: logic.awayText(person.absence, date), sub: [person.absence.status === 'beantragt' ? 'gemeldet – noch nicht eingetragen' : '', person.absence.note].filter(Boolean).join(' · ') };
        }
        if (person.state === 'frei') {
            if (plan) {
                const main = person.noAccount ? 'Eingeteilt' : person.employment === 'fest' || person.role !== 'dolmetscher' ? 'Im Dienst' : person.answer === 'verfügbar' ? 'Hat zugesagt' : 'Eingeteilt';
                return { main, sub: jobsText ? `${jobsText} eingeteilt` : '' };
            }
            if (person.next) return { main: `Frei · nächster Auftrag ${person.next.time ? `${person.next.time} Uhr` : 'offen'}`, sub: person.next.title };
            if (person.jobs.total) return { main: 'Frei', sub: person.jobs.total === 1 ? 'der Auftrag ist erledigt' : `alle ${person.jobs.total} Aufträge erledigt` };
            return { main: 'Frei', sub: 'heute noch kein Auftrag' };
        }
        if (person.state === 'nichtda') {
            if (person.answer === 'nicht verfügbar') return { main: `Kann ${plan ? dayWord(date) : 'heute'} nicht`, sub: person.answerNote || '' };
            return { main: data.weekend ? 'Wochenende' : 'Nicht eingeplant', sub: data.weekend && person.employment === 'temporär' && person.gender !== 'männlich' ? 'wird am Wochenende nicht gefragt' : '' };
        }
        const asked = data.request ? `angefragt um ${new Date(data.request.asked_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr` : 'noch nicht gefragt';
        return { main: plan ? 'Noch keine Antwort' : 'Keine Angabe für heute', sub: asked };
    }

    function flagsOf(person) {
        const flags = [];
        if (person.responses.abgesagt) flags.push(['rot', 'absage', person.responses.abgesagt > 1 ? `${person.responses.abgesagt} Absagen` : 'Absage', 'Hat einen gesendeten Auftrag abgesagt']);
        if (person.responses.offen) flags.push(['gelb', 'antwort', 'Antwort offen', `${plural(person.responses.offen, 'gesendeter Auftrag', 'gesendete Aufträge')} ohne Antwort`]);
        if (person.late) flags.push(['gelb', 'spaet', `${logic.KINDS[person.late.kind].label} ${logic.formatMinutes(person.late.minutes)}`, person.late.note || '']);
        if (person.vacationWaiting) flags.push(['blau', 'urlaub', 'Urlaub beantragt', 'Der Urlaubsantrag für diesen Tag wartet auf die Entscheidung']);
        if (person.vehicle?.emergency) flags.push(['blau', 'notdienst', 'Notdienst', 'Hat das Fahrzeug als Notdienst übernommen']);
        if (person.vehicle?.overnight) flags.push(['rot', 'uebernacht', 'Auto seit gestern', 'Das Fahrzeug wurde nicht am selben Tag zurückgegeben']);
        if (person.noAccount) flags.push(['', 'ohnekonto', 'ohne Konto', 'Steht im Tagesplan, hat aber kein Portal-Konto']);
        else if (person.pushKnown && !person.pushOn) flags.push(['', 'ohnepush', 'ohne Mitteilungen', 'Hat Mitteilungen aufs Handy nicht eingeschaltet – sieht Anfragen erst beim Öffnen des Portals']);
        return flags;
    }

    const CHIPS = [
        ['fest', 'Fest angestellt', person => person.employment === 'fest'],
        ['temp', 'Temporär', person => person.employment === 'temporär'],
        ['frauen', 'Dolmetscherinnen', person => person.gender === 'weiblich'],
        ['maenner', 'Dolmetscher', person => person.gender === 'männlich'],
        ['auto', 'Mit Fahrzeug', person => Boolean(person.vehicle)],
        ['ohneauftrag', 'Ohne Auftrag', person => !person.jobs.total && (person.state === 'frei')],
        ['absage', 'Auftrag abgesagt', person => person.responses.abgesagt > 0],
        ['antwort', 'Antwort offen', person => person.responses.offen > 0],
        ['ohnepush', 'Ohne Mitteilungen', person => !person.noAccount && person.pushKnown && !person.pushOn],
        ['ohnekonto', 'Ohne Konto', person => person.noAccount]
    ];

    function matchesQuery(person) {
        if (!query) return true;
        const text = fold([person.name, person.phone, person.phone.replace(/\D/g, ''), person.vehicle?.plate, person.vehicle?.plate?.replace(/[\s-]/g, ''), person.current?.title, person.next?.title, person.employment, genderWord(person)].join(' '));
        return fold(query).split(/\s+/).filter(Boolean).every(part => text.includes(part));
    }

    function sorted(list, state) {
        const byName = (left, right) => left.name.localeCompare(right.name, 'de');
        if (sort === 'name') return [...list].sort(byName);
        if (sort === 'auftraege') return [...list].sort((left, right) => right.jobs.total - left.jobs.total || byName(left, right));
        if (state === 'unterwegs') return [...list].sort((left, right) => (right.sinceMinutes ?? -1) - (left.sinceMinutes ?? -1) || byName(left, right));   // am längsten unterwegs zuerst
        // Frei: wer am wenigsten hatte, zuerst – bei Gleichstand fest Angestellte vor temporären
        if (state === 'frei') return [...list].sort((left, right) => left.jobs.total - right.jobs.total || Number(left.employment !== 'fest') - Number(right.employment !== 'fest') || byName(left, right));
        return [...list].sort(byName);
    }

    function chip(label, count, active, onClick, kind) {
        const node = el('button', 'board-chip');
        node.type = 'button';
        node.setAttribute('aria-pressed', String(active));
        if (kind) node.dataset.kind = kind;
        node.append(el('span', null, label));
        if (count != null) node.append(el('b', null, String(count)));
        node.addEventListener('click', onClick);
        return node;
    }

    function statePill(person) {
        const node = el('span', 'state-pill');
        node.dataset.state = `crew-${person.state}`;
        node.innerHTML = svgIcon(STATE[person.state].icon);
        node.append(el('span', null, stateLabel(person.state)));
        return node;
    }

    function personRow(person) {
        const row = el('button', 'crew-row');
        row.type = 'button';
        row.dataset.key = person.key;
        row.dataset.state = person.state;
        if (person.key === selectedKey) row.classList.add('is-active');
        const info = describe(person);
        const who = el('span', 'row-main');
        who.append(el('strong', null, person.name), el('small', null, [person.noAccount ? 'ohne Portal-Konto' : person.role !== 'dolmetscher' ? (person.role === 'admin' ? 'Einsatzleitung' : 'Sekretariat') : person.employment === 'fest' ? 'fest angestellt' : 'temporär', genderWord(person)].filter(Boolean).join(' · ')));
        const what = el('span', 'row-who');
        what.append(el('strong', null, info.main));
        if (info.sub) what.append(el('small', null, info.sub));
        const numbers = el('span', 'row-numbers');
        if (person.vehicle) {
            const car = el('span', 'crew-car');
            car.innerHTML = svgIcon(CAR_ICON, 16);
            car.append(el('b', null, person.vehicle.plate || 'Fahrzeug'));
            car.title = `Fahrzeug ${person.vehicle.plate} seit ${person.vehicle.since} Uhr`;
            numbers.append(car);
        }
        if (person.jobs.total) {
            const jobs = el('span', 'job-count', String(person.jobs.total));
            jobs.dataset.load = person.jobs.total >= 4 ? 'hoch' : person.jobs.total === 3 ? 'mittel' : 'normal';
            jobs.title = `${plural(person.jobs.total, 'Auftrag', 'Aufträge')} ${dayWord(date)}: ${[person.jobs.done ? `${person.jobs.done} erledigt` : '', person.jobs.running ? `${person.jobs.running} unterwegs` : '', person.jobs.open ? `${person.jobs.open} offen` : ''].filter(Boolean).join(', ')}`;
            jobs.setAttribute('aria-label', jobs.title);
            numbers.append(jobs);
        }
        const flags = el('span', 'row-flags');
        flagsOf(person).forEach(([color, key, text, title]) => { const flag = el('span', 'row-flag', text); if (color) flag.dataset.kind = color; flag.dataset.flag = key; if (title) flag.title = title; flags.append(flag); });
        row.append(statePill(person), who, what, numbers, flags);
        row.setAttribute('aria-label', `${person.name}: ${stateLabel(person.state)}. ${info.main}${info.sub ? `, ${info.sub}` : ''}`);
        row.addEventListener('click', () => openFile(person.key, row));
        return row;
    }

    // ---------- Übersicht zeichnen ----------
    function render() {
        if (!data) return;
        const plan = isPlan();
        // Gezeigt werden die Personen mit Portal-Konto. Namen, die nur im Tagesplan stehen, erscheinen über „Ohne Konto“.
        const without = data.withoutAccount || [];
        if (chipFilter === 'ohnekonto' && !without.length && !data.people.some(item => item.noAccount)) chipFilter = '';
        const people = chipFilter === 'ohnekonto' && without.length ? without : data.people;
        // Kopf: Tag
        document.querySelectorAll('[data-crew-day]').forEach(node => node.setAttribute('aria-pressed', String((node.dataset.crewDay === 'heute' && date === today()) || (node.dataset.crewDay === 'morgen' && date === tomorrow()))));
        $('crewDate').value = date;
        $('crewDayLabel').textContent = `${date === today() ? 'Heute · ' : date === tomorrow() ? 'Morgen · ' : ''}${logic.parse(date).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long' })}${data.holiday ? ` · ${data.holiday}` : ''}`;
        $('crewSort').value = sort;

        // Kacheln: Zahlen je Zustand – zusammen ergeben sie „Alle“. An anderen Tagen gibt es kein „Unterwegs“.
        const inState = key => people.filter(person => person.state === key);
        $('crewCountAll').textContent = String(people.length);
        $('crewSubAll').textContent = people === without ? 'ohne Portal-Konto'
            : [data.employment.fest ? `${data.employment.fest} fest` : '', data.employment['temporär'] ? `${data.employment['temporär']} temporär` : ''].filter(Boolean).join(' · ');
        [['unterwegs', 'crewCountOut', 'crewSubOut'], ['frei', 'crewCountFree', 'crewSubFree'], ['abwesend', 'crewCountAway', 'crewSubAway'], ['nichtda', 'crewCountNo', 'crewSubNo'], ['offen', 'crewCountOpen', 'crewSubOpen']].forEach(([key, countId, subId]) => {
            const list = inState(key);
            $(countId).textContent = String(list.length);
            $(subId).textContent = list.length ? genderSplit(list) : '';
        });
        $('crewLabelFree').textContent = plan ? 'Kommen' : 'Frei';
        $('crewLabelNo').textContent = plan ? 'Kommen nicht' : 'Nicht da';
        $('crewLabelOpen').textContent = plan ? 'Keine Antwort' : 'Keine Angabe';
        document.querySelector('[data-crew-filter="unterwegs"]').hidden = plan;
        if (plan && filter === 'unterwegs') filter = 'alle';
        document.querySelectorAll('[data-crew-filter]').forEach(node => { const active = node.dataset.crewFilter === filter; node.classList.toggle('is-active', active); node.setAttribute('aria-pressed', String(active)); });

        // Weitere Filter: nur, was es an diesem Tag gibt
        const chips = CHIPS.map(([key, label, test]) => ({ key, label, test, count: key === 'ohnekonto' && without.length ? without.length : data.people.filter(test).length }))
            .filter(item => (item.key === 'ohnekonto' && without.length) || (item.count > 0 && item.count < data.people.length) || item.key === chipFilter);
        if (chipFilter && !chips.some(item => item.key === chipFilter)) chipFilter = '';
        $('crewChips').hidden = !chips.length;
        $('crewChips').replaceChildren(...chips.map(item => chip(item.label, item.count, chipFilter === item.key, () => { chipFilter = chipFilter === item.key ? '' : item.key; render(); }, item.key)));

        renderAsk();

        const grid = $('crewGrid');
        grid.replaceChildren();
        const result = $('crewResult');
        if (!people.length) {
            result.textContent = '';
            grid.append(el('p', 'directory-empty', 'Noch gibt es keine freigeschalteten Dolmetscher-Konten. Schick den Link zum Portal (Seite „Team“) – jede Person registriert sich selbst und du schaltest sie frei.'));
            shownKeys = [];
            return;
        }
        const chipTest = CHIPS.find(item => item[0] === chipFilter)?.[2];
        const shown = people.filter(person => (filter === 'alle' || person.state === filter) && (!chipTest || chipTest(person)) && matchesQuery(person));
        const active = [filter !== 'alle' ? stateLabel(filter) : '', CHIPS.find(item => item[0] === chipFilter)?.[1] || '', query ? `„${query}“` : ''].filter(Boolean);
        const total = [plural(people.length, 'Person', 'Personen'), genderSplit(people), data.gender.unbekannt ? `${data.gender.unbekannt} ohne Angabe` : ''].filter(Boolean).join(' · ');
        result.replaceChildren(el('span', null, active.length ? `${shown.length} von ${people.length} · Filter: ${active.join(', ')}` : total));
        if (active.length) result.append(button('button-quiet board-clear', 'Filter löschen', () => { filter = 'alle'; chipFilter = ''; query = ''; $('crewSearch').value = ''; render(); }));

        shownKeys = [];
        if (!shown.length) {
            const text = filter === 'frei' && !chipFilter && !query && !plan ? 'Im Moment ist niemand frei.'
                : filter === 'unterwegs' && !chipFilter && !query ? 'Gerade ist niemand unterwegs.'
                : 'Für diese Auswahl gibt es niemanden.';
            grid.append(el('p', 'directory-empty', text));
            updateNav();
            return;
        }
        STATES.forEach(state => {
            const entries = sorted(shown.filter(person => person.state === state.key), state.key);
            if (!entries.length) return;
            const group = el('section', 'board-group crew-group');
            group.dataset.group = state.key;
            const isCollapsed = collapsed.has(state.key) && filter === 'alle' && !query && !chipFilter;
            const head = el('button', 'board-group-head');
            head.type = 'button';
            head.setAttribute('aria-expanded', String(!isCollapsed));
            const title = el('span', 'board-group-title');
            title.innerHTML = svgIcon(state.icon);
            title.append(el('span', null, stateLabel(state.key)), el('b', null, String(entries.length)));
            const noJob = entries.filter(person => !person.jobs.total).length;
            const extra = [genderSplit(entries), state.key === 'frei' && !plan && noJob ? `${noJob} ohne Auftrag` : '',
                state.key === 'offen' ? (data.request ? 'angefragt' : 'noch nicht gefragt') : ''].filter(Boolean).join(' · ');
            head.append(title, el('small', null, extra), el('span', 'board-group-fold', isCollapsed ? 'anzeigen' : 'einklappen'));
            head.addEventListener('click', () => { if (collapsed.has(state.key)) collapsed.delete(state.key); else collapsed.add(state.key); saveView(); render(); });
            group.append(head);
            if (!isCollapsed) {
                const rows = el('div', 'board-rows');
                entries.forEach(person => { shownKeys.push(person.key); rows.append(personRow(person)); });
                group.append(rows);
            }
            grid.append(group);
        });
        updateNav();
    }

    // ---------- Tagesanfrage: „Kannst du morgen arbeiten?“ ----------
    const askTitle = () => date === today() ? 'Kannst du heute arbeiten?' : date === tomorrow() ? 'Kannst du morgen arbeiten?' : `Kannst du am ${logic.parse(date).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' })} arbeiten?`;

    function renderAsk() {
        const card = $('crewAsk');
        const ask = data.ask;
        const open = ask.open.length;
        // Für heute nur, solange noch Antworten fehlen – und dann in einer Zeile. Die Anfrage ist vor allem für morgen gedacht.
        card.hidden = !data.ready || date < today() || !ask.eligible || (date === today() && !open && !data.request);
        if (card.hidden) return;
        card.dataset.compact = String(date === today());
        $('crewAskTitle').textContent = `Tagesanfrage: „${askTitle()}“`;
        const answered = `${ask.yes} ${ask.yes === 1 ? 'kann' : 'können'}, ${ask.no} ${ask.no === 1 ? 'kann' : 'können'} nicht`;
        $('crewAskInfo').textContent = open
            ? `${open} von ${plural(ask.eligible, 'temporären Dolmetscher', 'temporären Dolmetschern')} ${open === 1 ? 'hat' : 'haben'} für ${dayLong(date)} noch nicht geantwortet (${answered}).${data.weekend ? ' Am Wochenende werden nur die Dolmetscher (Männer) gefragt.' : ''}`
            : `Alle ${ask.eligible} temporären Dolmetscher haben für ${dayLong(date)} geantwortet: ${answered}.`;
        const request = data.request;
        const state = $('crewAskState');
        state.hidden = !request;
        if (request) {
            const asked = new Date(request.asked_at);
            state.textContent = `Angefragt am ${asked.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} um ${asked.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr${request.asked_by_name ? ` von ${request.asked_by_name}` : ''}${request.note ? ` · Hinweis: ${request.note}` : ''}`;
        }
        const noPush = ask.open.filter(person => person.pushKnown && !person.pushOn).length;
        $('crewAskNote').hidden = !open || date === today();
        if (document.activeElement !== $('crewAskNote') && request && !$('crewAskNote').value) $('crewAskNote').value = request.note || '';
        const send = $('crewAskSend');
        send.hidden = !open;
        send.textContent = request ? `Noch einmal erinnern (${open})` : `Jetzt anfragen (${open})`;
        send.title = noPush ? `${noPush} davon haben Mitteilungen aufs Handy nicht eingeschaltet – sie sehen die Frage erst beim Öffnen des Portals.` : '';
        $('crewAskCancel').hidden = !request;
    }

    $('crewAskSend').addEventListener('click', async () => {
        const recipients = data.ask.open;
        if (!recipients.length) return;
        const send = $('crewAskSend');
        send.disabled = true;
        const note = $('crewAskNote').value.trim();
        const { error } = await client.from('tt_day_requests').upsert({ date, asked_at: new Date().toISOString(), asked_by_name: profile.full_name || '', note }, { onConflict: 'date' });
        if (error) { send.disabled = false; showToast(TerminCloud.germanError(error), 'error', { target: '#crewAskSend' }); return; }
        const result = await TerminCloud.callFunction({
            action: 'notify', audience: 'einzeln', recipientIds: recipients.map(person => person.id), page: 'start',
            title: askTitle(), body: `${dayLong(date)}${note ? ` · ${note}` : ''} – bitte antworte kurz im Portal mit Ja oder Nein.`
        });
        send.disabled = false;
        const noPush = recipients.filter(person => person.pushKnown && !person.pushOn).length;
        if (result.ok) showToast(`Anfrage gesendet an ${plural(recipients.length, 'Person', 'Personen')}.${noPush ? ` ${noPush} davon ${noPush === 1 ? 'hat' : 'haben'} Mitteilungen aufs Handy nicht eingeschaltet und ${noPush === 1 ? 'sieht' : 'sehen'} die Frage erst beim Öffnen des Portals.` : ''}`, 'success', { duration: 9000 });
        else showToast(`Die Anfrage steht jetzt im Portal. Die Mitteilung aufs Handy ging nicht hinaus: ${result.reason}`, 'info', { duration: 12000 });
        await load();
    });

    $('crewAskCancel').addEventListener('click', async () => {
        if (!await confirmDialog(`Die Anfrage für ${dayLong(date)} zurückziehen?\n\nDie Frage verschwindet im Portal. Antworten, die schon eingetragen sind, bleiben erhalten.`, 'Anfrage zurückziehen')) return;
        const { error } = await client.from('tt_day_requests').delete().eq('date', date);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        $('crewAskNote').value = '';
        showToast('Anfrage zurückgezogen.', 'success');
        await load();
    });

    // ---------- Seitenfenster für eine Person ----------
    const person = () => (data ? [...data.people, ...(data.withoutAccount || [])] : []).find(item => item.key === selectedKey) || null;
    function updateNav() {
        const position = shownKeys.indexOf(selectedKey);
        $('crewFilePosition').textContent = position >= 0 && shownKeys.length > 1 ? `${position + 1} von ${shownKeys.length}` : '';
        $('crewFilePrev').disabled = position <= 0;
        $('crewFileNext').disabled = position < 0 || position >= shownKeys.length - 1;
    }

    function openFile(key, origin) {
        if (origin) lastFocus = origin;
        selectedKey = key;
        $('crewFile').hidden = false;
        $('crewBackdrop').hidden = false;
        document.documentElement.classList.add('has-drawer');
        document.querySelectorAll('.crew-row').forEach(row => row.classList.toggle('is-active', row.dataset.key === key));
        fillFile();
        $('crewFile').scrollTop = 0;
        $('crewFile').focus({ preventScroll: true });
    }

    function closeFile() {
        if ($('crewFile').hidden) return;
        const key = selectedKey;
        selectedKey = null;
        $('crewFile').hidden = true;
        $('crewBackdrop').hidden = true;
        document.documentElement.classList.remove('has-drawer');
        document.querySelectorAll('.crew-row.is-active').forEach(row => row.classList.remove('is-active'));
        const row = [...document.querySelectorAll('.crew-row')].find(node => node.dataset.key === key);
        (row || lastFocus)?.focus?.({ preventScroll: true });
    }

    // Telefonnummer für WhatsApp: deutsche Nummern ohne Ländervorwahl bekommen die 49.
    function whatsappNumber(phone) {
        let digits = String(phone || '').replace(/[^\d+]/g, '');
        if (digits.startsWith('+')) digits = digits.slice(1);
        else if (digits.startsWith('00')) digits = digits.slice(2);
        else if (digits.startsWith('0')) digits = `49${digits.slice(1)}`;
        return /^\d{8,15}$/.test(digits) ? digits : '';
    }

    function fillFile() {
        const item = person();
        if (!item) { closeFile(); return; }
        const info = describe(item);
        $('crewFileAvatar').textContent = item.name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toLocaleUpperCase('de-DE');
        $('crewFileAvatar').dataset.state = item.state;
        $('crewFileTitle').textContent = item.name;
        $('crewFileSubtitle').textContent = [item.noAccount ? 'ohne Portal-Konto' : item.role !== 'dolmetscher' ? (item.role === 'admin' ? 'Einsatzleitung' : 'Sekretariat') : item.employment === 'fest' ? 'fest angestellt' : 'temporär', genderWord(item), item.phone].filter(Boolean).join(' · ');
        const badges = $('crewFileBadges');
        badges.replaceChildren(statePill(item));
        flagsOf(item).forEach(([color, key, text, title]) => { const flag = el('span', 'row-flag', text); if (color) flag.dataset.kind = color; if (title) flag.title = title; badges.append(flag); });

        // Erreichen: anrufen, WhatsApp
        const contact = $('crewFileContact');
        contact.replaceChildren();
        if (item.phone) {
            const call = el('a', 'button-secondary', `Anrufen: ${item.phone}`);
            call.href = `tel:${item.phone.replace(/[^\d+]/g, '')}`;
            contact.append(call);
            const number = whatsappNumber(item.phone);
            if (number) {
                const whatsapp = el('a', 'button-secondary', 'WhatsApp');
                const greeting = date >= today() && item.employment === 'temporär' && !item.answer ? `Hallo ${item.name.split(' ')[0]}, ${askTitle().replace('Kannst du', 'kannst du')} Bitte antworte kurz im Portal: ${new URL('portal.html', location.href).href}` : `Hallo ${item.name.split(' ')[0]}, `;
                whatsapp.href = `https://wa.me/${number}?text=${encodeURIComponent(greeting)}`;
                whatsapp.target = '_blank';
                whatsapp.rel = 'noopener';
                contact.append(whatsapp);
            }
        } else if (!item.noAccount) contact.append(el('p', 'field-hint', 'Im Konto ist keine Handynummer hinterlegt.'));

        // Der gewählte Tag
        $('crewFileDayTitle').textContent = date === today() ? 'Heute' : date === tomorrow() ? `Morgen · ${dayLong(date)}` : dayLong(date);
        const state = $('crewFileState');
        state.replaceChildren();
        const fact = (label, value) => { if (value) state.append(el('dt', null, label), el('dd', null, value)); };
        fact('Zustand', `${stateLabel(item.state)} – ${info.main}${info.sub ? ` (${info.sub})` : ''}`);
        fact('Fahrzeug', item.vehicle ? `${item.vehicle.plate} · seit ${item.vehicle.overnight ? `${logic.dayMonth(item.vehicle.date)} ` : ''}${item.vehicle.since} Uhr${item.vehicle.emergency ? ' · Notdienst' : ''}` : (date === today() && !item.noAccount ? 'kein Fahrzeug übernommen' : ''));
        fact('Aufträge', item.jobs.total ? `${item.jobs.total} – ${[item.jobs.done ? `${item.jobs.done} erledigt` : '', item.jobs.running ? `${item.jobs.running} unterwegs` : '', item.jobs.open ? `${item.jobs.open} offen` : ''].filter(Boolean).join(', ')}${item.jobs.cancelled ? ` · ${item.jobs.cancelled} storniert` : ''}` : 'keine');
        if (!item.noAccount && item.employment === 'temporär') fact('Antwort', item.answer === 'verfügbar' ? `kann arbeiten${item.answerNote ? ` (${item.answerNote})` : ''}` : item.answer === 'nicht verfügbar' ? `kann nicht${item.answerNote ? ` (${item.answerNote})` : ''}` : 'keine');
        if (!item.noAccount && item.pushKnown) fact('Mitteilungen aufs Handy', item.pushOn ? 'eingeschaltet' : 'nicht eingeschaltet – Anfragen sieht die Person erst beim Öffnen des Portals');

        // Antwort eintragen (für temporäre Dolmetscher, z. B. nach einem Anruf)
        const canAnswer = !item.noAccount && item.employment === 'temporär' && item.role === 'dolmetscher' && date >= today();
        $('crewFileAnswer').hidden = !canAnswer;
        if (canAnswer) {
            document.querySelectorAll('[data-crew-answer]').forEach(node => { if (node.dataset.crewAnswer) { node.setAttribute('aria-pressed', String(item.answer === node.dataset.crewAnswer)); node.dataset.status = node.dataset.crewAnswer; } });
            $('crewFileAnswerClear').hidden = !item.answer;
        }

        // Aufträge des Tages
        const jobs = $('crewFileJobs');
        jobs.replaceChildren();
        const byTime = (left, right) => String(left.Termin_Uhrzeit || '').localeCompare(String(right.Termin_Uhrzeit || ''));
        [...item.records].sort(byTime).forEach(record => {
            const group = PeopleLive.recordGroup(record);
            const sent = item.assignments.find(assignment => assignment.appointment_id === record._id);
            const row = el('li', 'vehicle-entry file-entry');
            const pillNode = el('span', 'status-pill', { offen: 'offen', unterwegs: 'unterwegs', erledigt: 'erledigt', storniert: 'storniert' }[group]);
            pillNode.dataset.status = { offen: 'bekannt', unterwegs: 'in Arbeit', erledigt: 'erledigt', storniert: 'offen' }[group];
            const meta = el('span');
            meta.append(el('strong', null, [String(record.Termin_Uhrzeit || '').slice(0, 5) ? `${String(record.Termin_Uhrzeit).slice(0, 5)} Uhr` : '', PeopleLive.recordTitle(record)].filter(Boolean).join(' · ')),
                el('small', null, [record.Losgefahren_um ? `los ${record.Losgefahren_um}` : '', record.Beendet_um ? `fertig ${record.Beendet_um}` : '',
                    sent ? `Auftrag gesendet – Antwort: ${{ offen: 'noch keine', zugesagt: 'zugesagt', vorbehalt: 'unter Vorbehalt', abgesagt: 'abgesagt' }[sent.response] || sent.response}${sent.response_note ? ` (${sent.response_note})` : ''}` : (item.noAccount ? '' : 'Auftrag nicht ins Portal gesendet')].filter(Boolean).join(' · ')));
            row.append(pillNode, meta);
            jobs.append(row);
        });
        if (!item.records.length) jobs.append(el('li', 'directory-empty', item.jobs.total ? `${plural(item.jobs.total, 'gesendeter Auftrag', 'gesendete Aufträge')} – der Tagesstand ist noch nicht gespeichert.` : `Für ${dayWord(date) === 'heute' ? 'heute' : dayWord(date)} ist kein Termin eingeteilt.`));

        // Verknüpfungen
        $('crewFileMessage').hidden = item.noAccount;
        $('crewFileAbsenceLink').hidden = item.noAccount || item.employment !== 'fest';
        $('crewFileTeam').hidden = item.noAccount || !TerminCloud.isAdmin(profile);
        if (!item.noAccount) { $('crewFileTeam').href = `team.html?konto=${encodeURIComponent(item.id)}`; $('crewFileMessage').href = `nachrichten.html?an=${encodeURIComponent(item.id)}`; }
        updateNav();
        loadFileDays(item);
    }

    // Die nächsten 14 Tage und die Abwesenheiten der Person (wird nachgeladen)
    async function loadFileDays(item) {
        const days = $('crewFileDays');
        const list = $('crewFileAbsences');
        days.replaceChildren();
        list.replaceChildren();
        $('crewFileDaysHint').textContent = '';
        $('crewFileAbsenceTitle').hidden = true;
        if (item.noAccount) { $('crewFileDaysHint').textContent = 'Ohne Portal-Konto gibt es keine Arbeitstage und keine Abwesenheiten.'; return; }
        const start = today();
        const end = logic.addDays(start, 13);
        const year = start.slice(0, 4);
        const [workdays, absences] = await Promise.all([
            client.from('tt_workdays').select('date, status').eq('user_id', item.id).gte('date', start).lte('date', end),
            client.from('tt_absences').select('*').eq('profile_id', item.id).gte('date_to', `${year}-01-01`).order('date_from', { ascending: false }).limit(60)
        ]);
        if (selectedKey !== item.key) return;                 // inzwischen wurde eine andere Person geöffnet
        const answers = new Map((workdays.error ? [] : workdays.data).map(entry => [entry.date, entry.status]));
        const away = absences.error ? [] : absences.data;
        const fest = item.employment === 'fest';
        for (let day = start; day <= end; day = logic.addDays(day, 1)) {
            const cell = el('span', 'crew-day-cell');
            const block = away.find(entry => logic.blocksDay(entry, day));
            const waiting = away.find(entry => entry.kind === 'urlaub' && entry.status === 'beantragt' && logic.covers(entry, day));
            const weekend = logic.isWeekend(day);
            const holiday = logic.holidayName(day);
            let kind = 'leer';
            let text = '–';
            if (block) { kind = 'weg'; text = logic.KINDS[block.kind].label; }
            else if (answers.get(day) === 'verfügbar') { kind = 'ja'; text = 'kann'; }
            else if (answers.get(day) === 'nicht verfügbar') { kind = 'nein'; text = 'kann nicht'; }
            else if (holiday) { kind = 'frei'; text = 'Feiertag'; }
            else if (weekend && (fest || item.gender !== 'männlich')) { kind = 'frei'; text = 'frei'; }      // am Wochenende werden nur die Dolmetscher (Männer) gefragt
            else if (fest) { kind = waiting ? 'wartet' : 'ja'; text = waiting ? 'Urlaub?' : 'da'; }
            cell.dataset.kind = kind;
            if (day === date) cell.classList.add('is-selected');
            cell.title = `${dayLong(day)}: ${text}${holiday ? ` (${holiday})` : ''}`;
            cell.append(el('small', null, logic.parse(day).toLocaleDateString('de-DE', { weekday: 'short' }).replace('.', '')), el('b', null, logic.dayMonth(day)), el('em', null, text));
            days.append(cell);
        }
        $('crewFileDaysHint').textContent = fest ? 'Fest angestellt: an Arbeitstagen da, außer bei Urlaub, Krankheit oder Notfall.' : 'Temporär: „kann“ und „kann nicht“ trägt die Person im Portal ein – oder du hier oben für den gewählten Tag.';
        // Abwesenheiten (nur fest angestellt): dieses Jahr und was noch kommt
        $('crewFileAbsenceTitle').hidden = !fest;
        if (!fest) return;
        if (absences.error) { list.append(el('li', 'directory-empty', 'Abwesenheiten sind in der Datenbank noch nicht eingerichtet (Update 15).')); return; }
        const sum = kind => away.filter(entry => entry.kind === kind && entry.status !== 'abgelehnt' && (kind !== 'urlaub' || entry.status === 'genehmigt')).reduce((total, entry) => total + logic.dayCount(entry, `${year}-01-01`, `${year}-12-31`), 0);
        $('crewFileAbsenceTitle').textContent = `Abwesenheiten ${year}: ${logic.formatDays(sum('urlaub'))} Urlaub · ${logic.formatDays(sum('krank'))} krank`;
        away.slice(0, 12).forEach(entry => {
            const row = el('li', 'vehicle-entry file-entry');
            const state = el('span', 'status-pill', entry.kind === 'urlaub' ? entry.status : { beantragt: 'gemeldet', genehmigt: 'eingetragen', abgelehnt: entry.kind === 'krank' || entry.kind === 'notfall' ? 'nicht anerkannt' : 'storniert' }[entry.status]);
            state.dataset.status = { beantragt: 'in Arbeit', genehmigt: 'erledigt', abgelehnt: 'offen' }[entry.status];
            const meta = el('span');
            meta.append(el('strong', null, `${logic.KINDS[entry.kind]?.label || entry.kind} · ${logic.rangeText(entry)}`),
                el('small', null, [entry.minutes ? logic.formatMinutes(entry.minutes) : ['urlaub', 'krank'].includes(entry.kind) || !entry.minutes ? logic.formatDays(logic.dayCount(entry)) : '', entry.note].filter(Boolean).join(' · ')));
            row.append(state, meta);
            list.append(row);
        });
        if (!away.length) list.append(el('li', 'directory-empty', 'Keine Einträge in diesem Jahr.'));
    }

    // Antwort für den gewählten Tag eintragen oder löschen (Einsatzleitung, z. B. nach einem Anruf)
    document.querySelectorAll('[data-crew-answer]').forEach(node => node.addEventListener('click', async () => {
        const item = person();
        if (!item || item.noAccount) return;
        const status = node.dataset.crewAnswer;
        document.querySelectorAll('[data-crew-answer]').forEach(other => { other.disabled = true; });
        const result = status && item.answer !== status
            ? await client.from('tt_workdays').upsert({ user_id: item.id, date, status, note: `eingetragen von ${profile.full_name || 'der Einsatzleitung'}` }, { onConflict: 'user_id,date' })
            : await client.from('tt_workdays').delete().eq('user_id', item.id).eq('date', date);
        document.querySelectorAll('[data-crew-answer]').forEach(other => { other.disabled = false; });
        if (result.error) { showToast(TerminCloud.germanError(result.error), 'error'); return; }
        showToast(status && item.answer !== status ? `${item.name}: ${status === 'verfügbar' ? 'kann' : 'kann nicht'} ${dayWord(date)} – eingetragen.` : `Antwort von ${item.name} für ${dayLong(date)} gelöscht.`, 'success');
        await load();
    }));

    $('crewFileClose').addEventListener('click', closeFile);
    $('crewBackdrop').addEventListener('click', closeFile);
    $('crewFilePrev').addEventListener('click', () => { const position = shownKeys.indexOf(selectedKey); if (position > 0) openFile(shownKeys[position - 1]); });
    $('crewFileNext').addEventListener('click', () => { const position = shownKeys.indexOf(selectedKey); if (position >= 0 && position < shownKeys.length - 1) openFile(shownKeys[position + 1]); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('crewFile').hidden && !document.querySelector('dialog[open]')) closeFile(); });

    // ---------- Bedienung ----------
    function chooseDay(next) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(next || '') || next === date) return;
        date = next;
        filter = 'alle';
        chipFilter = '';
        $('crewAskNote').value = '';
        closeFile();
        load();
    }
    document.querySelectorAll('[data-crew-day]').forEach(node => node.addEventListener('click', () => chooseDay(node.dataset.crewDay === 'morgen' ? tomorrow() : today())));
    $('crewDate').addEventListener('change', () => chooseDay($('crewDate').value));
    document.querySelectorAll('[data-crew-filter]').forEach(node => node.addEventListener('click', () => { filter = filter === node.dataset.crewFilter ? 'alle' : node.dataset.crewFilter; render(); }));
    $('crewSearch').addEventListener('input', () => { query = $('crewSearch').value.trim(); render(); });
    $('crewSort').addEventListener('change', () => { sort = $('crewSort').value; saveView(); render(); });
    $('crewReload').addEventListener('click', load);
    // Alle 60 Sekunden frisch – aber nicht, während jemand tippt oder ein Fenster offen ist.
    window.setInterval(() => { if (!document.hidden && tab === 'board' && data && !document.querySelector('dialog[open]') && document.activeElement !== $('crewAskNote') && document.activeElement !== $('crewSearch')) load(); }, 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && tab === 'board' && data) load(); });

    showTab();
    if (tab === 'board') load();
})();
