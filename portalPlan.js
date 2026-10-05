// Dolmetscher-Portal · Planung:
//   · einmalige Angabe „Dolmetscherin / Dolmetscher“ für Konten, die es schon gab
//   · Tagesanfrage der Einsatzleitung: „Kannst du morgen arbeiten?“ (temporär) – Antwort mit einem Tipp
//   · Wochenplan: ab Freitag 15 Uhr die Frage nach den Arbeitstagen der nächsten Woche (temporär)
//   · Urlaub beantragen, Krankheit oder Notfall melden (fest angestellt)
// Gehört zu portalApp.js (Schnittstelle window.PortalCore) und absenceLogic.js (Arbeitstage ohne Feiertage). Braucht supabase/update-15.sql.
window.PortalPlan = (function () {
    const core = window.PortalCore;
    const logic = window.AbsenceLogic;
    const $ = id => document.getElementById(id);
    const { client, toast, el } = core;
    const KIND = {
        urlaub: { label: 'Urlaub', submit: 'Urlaub beantragen', done: 'Urlaub beantragt. Die Einsatzleitung entscheidet und du siehst die Antwort hier.', placeholder: 'Zum Beispiel: Familienbesuch' },
        krank: { label: 'Krank', submit: 'Krank melden', done: 'Krankmeldung gesendet. Gute Besserung!', placeholder: 'Zum Beispiel: Arzttermin um 10 Uhr, Krankschreibung folgt' },
        notfall: { label: 'Notfall', submit: 'Notfall melden', done: 'Notfall gemeldet. Die Einsatzleitung weiß Bescheid.', placeholder: 'Kurz, was los ist – wenn du möchtest' },
        'verspätung': { label: 'Verspätung' },
        fehlstunden: { label: 'Fehlstunden' }
    };
    const STATUS = {
        beantragt: { urlaub: ['in Arbeit', 'wartet'], other: ['in Arbeit', 'gemeldet'] },
        genehmigt: { urlaub: ['erledigt', 'genehmigt'], other: ['erledigt', 'eingetragen'] },
        abgelehnt: { urlaub: ['offen', 'abgelehnt'], other: ['offen', 'nicht anerkannt'] }
    };
    let ready = true;          // false: Update 15 fehlt noch – dann bleibt alles wie bisher
    let dayRequests = [];      // Tage, für die die Einsatzleitung nachfragt
    let myDays = new Map();    // meine Arbeitstage der nächsten zwei Wochen: Datum → Status
    let absences = [];
    let genderAsked = false;

    const iso = date => core.isoDate(date);
    const today = () => iso(new Date());
    const addDays = (date, count) => { const next = new Date(date); next.setDate(next.getDate() + count); return next; };
    const parse = text => new Date(`${text}T00:00:00`);
    const dayText = text => parse(text).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' });
    const shortDay = text => parse(text).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const isWeekend = text => logic.isWeekend(text);
    // Arbeitstage: Montag bis Freitag ohne Feiertage (siehe absenceLogic.js)
    const workingDays = (from, to) => logic.workingDays(from, to);
    const daysText = count => logic.formatDays(count, 'Arbeitstag', 'Arbeitstage');
    // Feiertage im Zeitraum – als Hinweis, warum sie nicht mitzählen
    function holidaysBetween(from, to) {
        const found = [];
        for (let day = from; day <= to && found.length < 4; day = logic.addDays(day, 1)) {
            const name = logic.holidayName(day);
            if (name && !logic.isWeekend(day)) found.push(`${logic.dayMonth(day)} ${name}`);
        }
        return found;
    }
    function pill(status, text) {
        const node = el('span', 'status-pill', text);
        node.dataset.status = status;
        return node;
    }

    // ---------- Einmalige Angabe ----------
    function askGender() {
        const profile = core.profile();
        if (genderAsked || !ready || !profile?.active || profile.role !== 'dolmetscher' || profile.gender) return;
        genderAsked = true;
        const dialog = $('genderDialog');
        dialog.addEventListener('cancel', event => event.preventDefault());      // ohne Antwort geht es nicht weiter
        dialog.querySelectorAll('[data-gender]').forEach(button => {
            button.onclick = async () => {
                dialog.querySelectorAll('button').forEach(node => { node.disabled = true; });
                const { error } = await client.from('tt_profiles').update({ gender: button.dataset.gender }).eq('id', profile.id);
                dialog.querySelectorAll('button').forEach(node => { node.disabled = false; });
                // Fehlt die Spalte noch (Update 15), wird heute nicht weiter gefragt.
                if (!error) { core.setProfile({ gender: button.dataset.gender }); core.refreshAccount(); core.refreshWorkdays?.(); toast('Danke – gespeichert.', 'success'); }
                dialog.close();
                renderBanner();
            };
        });
        dialog.showModal();
    }

    // ---------- Laden ----------
    async function load() {
        const profile = core.profile();
        if (!profile?.active) return;
        if (core.isFest()) {
            const { data, error } = await client.from('tt_absences').select('*').eq('profile_id', profile.id).order('date_from', { ascending: false }).limit(200);
            ready = !error;
            absences = error ? [] : data;
            renderAbsences();
        } else {
            const until = iso(addDays(new Date(), 13));
            const [requestResult, dayResult] = await Promise.all([
                client.from('tt_day_requests').select('*').gte('date', today()).lte('date', iso(addDays(new Date(), 3))).order('date'),
                client.from('tt_workdays').select('date, status').eq('user_id', profile.id).gte('date', today()).lte('date', until)
            ]);
            ready = !requestResult.error;
            dayRequests = requestResult.error ? [] : requestResult.data;
            myDays = new Map((dayResult.error ? [] : dayResult.data).map(item => [item.date, item.status]));
        }
        renderBanner();
    }

    async function start() {
        await load();
        askGender();
    }

    // ---------- Karten auf der Startseite (temporär) ----------
    function nextWeek() {
        const now = new Date();
        const monday = addDays(now, ((8 - now.getDay()) % 7) || 7);
        return { from: iso(monday), to: iso(addDays(monday, 6)) };
    }

    function renderBanner() {
        const list = $('planBanner');
        const profile = core.profile();
        const cards = [];
        if (profile?.active && !core.isFest() && ready) {
            // 1) Tagesanfrage: nächster angefragter Tag ohne Antwort (Wochenende nur für Dolmetscher)
            const open = dayRequests.find(item => !myDays.has(item.date) && (profile.gender === 'männlich' || !isWeekend(item.date)) && item.date >= today());
            if (open) {
                const card = el('li', 'plan-card');
                card.dataset.date = open.date;
                const tomorrow = open.date === iso(addDays(new Date(), 1));
                card.append(el('strong', '', open.date === today() ? 'Kannst du heute arbeiten?' : tomorrow ? 'Kannst du morgen arbeiten?' : `Kannst du am ${dayText(open.date)} arbeiten?`),
                    el('span', '', `${dayText(open.date)}${open.note ? ` · ${open.note}` : ''}`),
                    el('small', '', 'Die Einsatzleitung plant gerade den Tag. Bitte antworte kurz.'));
                const buttons = el('div', 'plan-card-buttons');
                [['verfügbar', 'Ja, ich kann', 'button-primary'], ['nicht verfügbar', 'Nein, ich kann nicht', 'button-secondary']].forEach(([status, text, className]) => {
                    const button = el('button', `${className} big-button`, text);
                    button.type = 'button';
                    button.addEventListener('click', () => answerDay(open.date, status, buttons));
                    buttons.append(button);
                });
                card.append(buttons);
                cards.push(card);
            }
            // 2) Wochenplan: von Freitag 15 Uhr bis Sonntagabend, solange für nächste Woche noch nichts eingetragen ist
            const now = new Date();
            const planTime = (now.getDay() === 5 && now.getHours() >= 15) || now.getDay() === 6 || now.getDay() === 0;
            const week = nextWeek();
            const entered = [...myDays.keys()].some(date => date >= week.from && date <= week.to);
            if (planTime && !entered) {
                const card = el('li', 'plan-card is-week');
                card.append(el('strong', '', 'Wochenplan: Wann kannst du nächste Woche arbeiten?'),
                    el('span', '', `${shortDay(week.from)} bis ${shortDay(week.to)}`),
                    el('small', '', 'Tippe für jeden Tag an, ob du kannst. Das dauert eine halbe Minute.'));
                const button = el('button', 'button-primary big-button', 'Tage auswählen');
                button.type = 'button';
                button.addEventListener('click', () => { core.goTo('workdays'); window.setTimeout(() => $('nextWeekStart')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 250); });
                const buttons = el('div', 'plan-card-buttons');
                buttons.append(button);
                card.append(buttons);
                cards.push(card);
            }
        }
        list.hidden = !cards.length;
        list.replaceChildren(...cards);
    }

    async function answerDay(date, status, buttons) {
        const profile = core.profile();
        buttons.querySelectorAll('button').forEach(node => { node.disabled = true; });
        const { error } = await client.from('tt_workdays').upsert({ user_id: profile.id, date, status, note: '' }, { onConflict: 'user_id,date' });
        if (error) { buttons.querySelectorAll('button').forEach(node => { node.disabled = false; }); toast(TerminCloud.germanError(error), 'error'); return; }
        myDays.set(date, status);
        renderBanner();
        core.refreshWorkdays?.();
        toast(status === 'verfügbar' ? `Danke! Du bist für ${dayText(date)} als verfügbar eingetragen.` : `Danke für die Antwort. Für ${dayText(date)} wirst du nicht eingeplant.`, 'success');
    }

    // ---------- Urlaub, Krankheit, Notfall (fest angestellt) ----------
    const kindValue = () => document.querySelector('input[name=absenceKind]:checked')?.value || 'urlaub';

    function renderForm() {
        const kind = kindValue();
        const from = $('absenceFrom').value;
        const to = $('absenceTo').value;
        $('absenceSubmit').textContent = KIND[kind].submit;
        $('absenceNote').placeholder = KIND[kind].placeholder;
        const result = $('absenceDays');
        if (!from || !to) { result.dataset.kind = 'empty'; result.textContent = 'Wähle die Tage.'; return; }
        if (to < from) { result.dataset.kind = 'error'; result.textContent = 'Das Ende liegt vor dem Beginn.'; return; }
        const count = workingDays(from, to);
        const free = holidaysBetween(from, to);
        result.dataset.kind = count ? 'ok' : 'empty';
        result.textContent = from === to
            ? `${dayText(from)}${count ? '' : logic.holidayName(from) ? ` (Feiertag: ${logic.holidayName(from)})` : ' (Wochenende)'}`
            : `${shortDay(from)} bis ${shortDay(to)} · ${daysText(count)}${free.length ? ` · Feiertag zählt nicht: ${free.join(', ')}` : ' (ohne Wochenenden)'}`;
    }

    function resetForm() {
        $('absenceForm').reset();
        $('absenceFrom').value = today();
        $('absenceTo').value = today();
        renderForm();
    }

    // „Zeiten“ hat zwei Teile: Überstunden · Urlaub, Krankheit, Notfall. Gezeigt wird immer nur einer.
    let zeitenTab = window.portalZeitenWanted === 'absence' ? 'absence' : 'overtime';
    function showZeiten(tab) {
        const available = core.isFest() && ready;
        zeitenTab = available && tab === 'absence' ? 'absence' : 'overtime';
        $('zeitenTabs').hidden = !available;
        document.querySelectorAll('[data-zeiten-tab]').forEach(button => { const active = button.dataset.zeitenTab === zeitenTab; button.classList.toggle('is-active', active); button.setAttribute('aria-selected', String(active)); });
        document.querySelectorAll('[data-zeiten]').forEach(part => { part.hidden = part.dataset.zeiten !== zeitenTab; });
    }
    document.querySelectorAll('[data-zeiten-tab]').forEach(button => button.addEventListener('click', () => { showZeiten(button.dataset.zeitenTab); window.scrollTo(0, 0); }));

    function renderAbsences() {
        showZeiten(zeitenTab);
        if (!core.isFest() || !ready) return;
        // Zähler am Reiter: Entscheidungen der Einsatzleitung, die die Person noch nicht gesehen hat, gibt es nicht –
        // gezeigt wird, wie viele Anträge noch auf eine Entscheidung warten.
        const pending = absences.filter(item => item.status === 'beantragt' && item.kind === 'urlaub').length;
        $('zeitenBadge').hidden = !pending;
        $('zeitenBadge').textContent = String(pending);
        const year = String(new Date().getFullYear());
        // Tage, die in dieses Jahr fallen (ein Urlaub über den Jahreswechsel zählt anteilig)
        const days = kind => absences.filter(item => item.kind === kind && item.status !== 'abgelehnt' && (kind !== 'urlaub' || item.status === 'genehmigt'))
            .reduce((sum, item) => sum + logic.dayCount(item, `${year}-01-01`, `${year}-12-31`), 0);
        const waiting = absences.filter(item => item.kind === 'urlaub' && item.status === 'beantragt').length;
        $('absenceSummary').textContent = absences.length
            ? [`${year}: ${logic.formatDays(days('urlaub'), 'Urlaubstag', 'Urlaubstage')} genehmigt`, logic.formatDays(days('krank'), 'Krankheitstag', 'Krankheitstage'), waiting ? `${waiting} ${waiting === 1 ? 'Antrag wartet' : 'Anträge warten'}` : ''].filter(Boolean).join(' · ')
            : 'Noch keine Anträge oder Meldungen.';
        $('absenceList').replaceChildren(...absences.slice(0, 40).map(item => {
            const row = el('li', 'directory-entry damage-entry absence-entry');
            const meta = el('span', 'directory-entry-name');
            const range = logic.rangeText(item);
            const amount = item.minutes ? logic.formatMinutes(item.minutes)
                : ['urlaub', 'krank'].includes(item.kind) ? daysText(logic.dayCount(item)) : '';
            meta.append(el('strong', '', `${KIND[item.kind]?.label || item.kind} · ${range}`),
                el('small', '', [amount, item.note, item.kind === 'urlaub' ? `beantragt am ${logic.stampDate(item.created_at)}` : '', item.review_note ? `Einsatzleitung: ${item.review_note}` : ''].filter(Boolean).join(' · ')));
            const [color, text] = (STATUS[item.status] || STATUS.beantragt)[item.kind === 'urlaub' ? 'urlaub' : 'other'];
            const actions = el('span', 'vehicle-entry-actions');
            if (item.status === 'beantragt' && item.profile_id === core.profile().id && ['urlaub', 'krank', 'notfall'].includes(item.kind)) {
                const withdraw = el('button', 'button-quiet-danger', 'Zurückziehen');
                withdraw.type = 'button';
                withdraw.addEventListener('click', async () => {
                    withdraw.disabled = true;
                    const { data, error } = await client.from('tt_absences').delete().eq('id', item.id).select();
                    if (error || !data?.length) { withdraw.disabled = false; toast(error ? TerminCloud.germanError(error) : 'Das geht nicht mehr – die Einsatzleitung hat schon entschieden.', 'error'); return; }
                    toast('Zurückgezogen.', 'success');
                    await load();
                });
                actions.append(withdraw);
            }
            actions.prepend(pill(color, text));
            row.append(meta, actions);
            return row;
        }));
        if (!absences.length) $('absenceList').replaceChildren(core.emptyItem ? core.emptyItem('Hier stehen deine Urlaubsanträge und Meldungen.') : el('li', 'directory-empty', 'Hier stehen deine Urlaubsanträge und Meldungen.'));
    }

    // Aufruf beim Öffnen von „Zeiten“; tab = 'absence' springt direkt zu Urlaub/Krank (z. B. aus einer Mitteilung).
    function openAbsences(tab) {
        if (!core.isFest()) { showZeiten('overtime'); return; }
        if (!$('absenceFrom').value) resetForm();
        if (tab) showZeiten(tab);
        load();
    }

    document.querySelectorAll('input[name=absenceKind]').forEach(input => input.addEventListener('change', renderForm));
    $('absenceFrom').addEventListener('change', () => { if (!$('absenceTo').value || $('absenceTo').value < $('absenceFrom').value) $('absenceTo').value = $('absenceFrom').value; renderForm(); });
    $('absenceTo').addEventListener('change', renderForm);
    $('absenceForm').addEventListener('submit', async event => {
        event.preventDefault();
        const profile = core.profile();
        const kind = kindValue();
        const from = $('absenceFrom').value;
        const to = $('absenceTo').value;
        if (!from) { toast('Bitte wähle den ersten Tag.', 'error', '#absenceFrom'); return; }
        if (!to || to < from) { toast('Bitte wähle den letzten Tag – er darf nicht vor dem ersten liegen.', 'error', '#absenceTo'); return; }
        if (kind === 'urlaub' && from < today()) { toast('Urlaub lässt sich nur für heute oder später beantragen.', 'error', '#absenceFrom'); return; }
        if (kind === 'urlaub' && !workingDays(from, to)) { toast('In diesem Zeitraum liegt kein Arbeitstag (nur Wochenende).', 'error', '#absenceFrom'); return; }
        const clash = absences.find(item => item.kind === kind && item.status !== 'abgelehnt' && item.date_from <= to && item.date_to >= from);
        if (clash) { toast(`Für diesen Zeitraum gibt es schon einen Eintrag (${KIND[kind].label} ${shortDay(clash.date_from)}${clash.date_to !== clash.date_from ? ` bis ${shortDay(clash.date_to)}` : ''}).`, 'error', '#absenceList'); return; }
        const button = $('absenceSubmit');
        button.disabled = true;
        const { data, error } = await client.from('tt_absences').insert({
            profile_id: profile.id, person_name: profile.full_name || '', kind, date_from: from, date_to: to, note: $('absenceNote').value.trim(), status: 'beantragt', created_by_name: profile.full_name || ''
        }).select();
        button.disabled = false;
        if (error || !data?.length) {
            toast(error && /tt_absences|schema cache|does not exist/i.test(error.message || '') ? 'Das ist in der Datenbank noch nicht eingerichtet (Update 15 fehlt). Bitte sag der Einsatzleitung Bescheid.' : error ? TerminCloud.germanError(error) : 'Das konnte nicht gespeichert werden.', 'error', '#absenceSubmit');
            return;
        }
        // Die Einsatzleitung bekommt sofort eine Mitteilung – bei Krankheit und Notfall müssen Termine neu verteilt werden.
        TerminCloud.callFunction({ action: 'absence', absenceId: data[0].id });
        await core.showSuccess(kind === 'urlaub' ? 'Beantragt' : 'Gemeldet', KIND[kind].label);
        toast(KIND[kind].done, 'success');
        resetForm();
        await load();
    });

    // Das Portal kann schon gestartet sein, bevor diese Datei geladen ist – dann jetzt nachholen.
    if (core.profile()?.active) start();

    return { start, load, openAbsences, showZeiten, state: () => ({ ready, dayRequests, absences, days: [...myDays], zeitenTab }) };
})();
