// Team-Seite: Konten freischalten, bearbeiten, sperren oder löschen (nur Admin) und die Arbeitstage ansehen.
(function () {
    const $ = id => document.getElementById(id);
    const client = TerminCloud.client;
    let profile = null;
    let registerMode = false;

    function setStatus(message, kind = 'info') {
        const status = $('teamStatus');
        status.hidden = !message;
        status.textContent = message || '';
        status.dataset.kind = kind;
    }

    function show(view) {
        $('teamAuth').hidden = view !== 'auth';
        $('teamApp').hidden = view !== 'app';
        $('teamSignOut').hidden = view === 'auth';
    }

    async function refresh() {
        setStatus('');
        $('teamUser').textContent = '';
        if (!client) {
            show('auth');
            setStatus('Die Verbindung zur Datenbank konnte nicht geladen werden. Prüfe das Internet und lade die Seite neu.', 'error');
            return;
        }
        try {
            profile = await TerminCloud.getProfile(true);
        } catch (error) {
            show('auth');
            setStatus(`${error.message} Falls die Tabellen noch fehlen: supabase/schema.sql im SQL Editor ausführen.`, 'error');
            return;
        }
        if (!profile) { show('auth'); return; }
        $('teamUser').textContent = profile.full_name || profile.email;
        if (!TerminCloud.isStaff(profile)) {
            show('none');
            $('teamSignOut').hidden = false;
            setStatus(profile.active
                ? 'Dieses Konto gehört nicht zur Einsatzleitung. Für Dolmetscher gibt es das Portal (portal.html).'
                : 'Dein Konto ist angelegt und wartet auf die Freischaltung durch den Admin.', profile.active ? 'error' : 'info');
            return;
        }
        show('app');
        const runsLocally = ['127.0.0.1', 'localhost', ''].includes(window.location.hostname);
        $('portalLink').value = runsLocally && window.TERMIN_CLOUD_CONFIG?.portalUrl
            ? window.TERMIN_CLOUD_CONFIG.portalUrl
            : new URL('portal.html', window.location.href).href;
        // Die Anleitung liegt neben dem Portal (Deutsch und Arabisch auf einer Seite).
        $('guideLink').value = new URL('anleitung.html', $('portalLink').value).href;
        const sync = await TerminCloud.syncFleet();
        if (!sync.ok && sync.reason && !['offline', 'not-admin'].includes(sync.reason)) setStatus(`Fuhrpark-Abgleich: ${sync.reason}`, 'error');
        await loadAccounts();
        checkServer();
        window.refreshCloudInbox?.();
    }

    // ---------- Konten + Arbeitstage ----------
    // Bei vielen Konten (30–60): Suche, Filter mit Zahlen und eine Zeile je Konto. Was Aufmerksamkeit braucht, steht oben:
    // neue Konten (Freischalten) und „Passwort vergessen“. Alles Weitere steckt hinter „Bearbeiten“.
    let accounts = [];
    let resetIds = new Set();
    let accountFilter = 'alle';
    let accountQuery = '';
    const fold = text => String(text ?? '').toLocaleLowerCase('de-DE').normalize('NFD').replace(/[̀-ͯ]/g, '');
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };
    // „Wartet“ sind nur Konten, die noch nie freigeschaltet waren; wer danach gesperrt wurde, ist „gesperrt“.
    const isWaiting = account => !account.active && !account.approved_at;
    const isLocked = account => !account.active && Boolean(account.approved_at);
    const isOffice = account => account.role === 'admin' || account.role === 'sekretariat';
    const roleText = account => ({ admin: 'Admin', sekretariat: 'Sekretariat' }[account.role] || (account.gender === 'weiblich' ? 'Dolmetscherin' : account.gender === 'männlich' ? 'Dolmetscher' : 'Dolmetscher/in'));
    const ACCOUNT_FILTERS = [
        ['alle', 'Alle', () => true],
        ['wartet', 'Warten auf Freischaltung', isWaiting],
        ['passwort', 'Passwort vergessen', account => resetIds.has(account.id)],
        ['fest', 'Fest angestellt', account => account.role === 'dolmetscher' && account.employment === 'fest' && account.active],
        ['temp', 'Temporär', account => account.role === 'dolmetscher' && account.employment !== 'fest' && account.active],
        ['frauen', 'Dolmetscherinnen', account => account.role === 'dolmetscher' && account.gender === 'weiblich' && account.active],
        ['maenner', 'Dolmetscher', account => account.role === 'dolmetscher' && account.gender === 'männlich' && account.active],
        ['ohneangabe', 'Ohne Angabe', account => account.role === 'dolmetscher' && !account.gender && account.active],
        ['buero', 'Einsatzleitung und Sekretariat', isOffice],
        ['gesperrt', 'Gesperrt', isLocked]
    ];

    async function loadAccounts() {
        const { data, error } = await client.from('tt_profiles').select('*').order('full_name');
        if (error) { setStatus(TerminCloud.germanError(error), 'error'); return; }
        accounts = data;
        // Wer hat im Portal „Passwort vergessen“ getippt? (nur für den Admin sichtbar)
        const resetResult = TerminCloud.isAdmin(profile) ? await client.from('tt_reset_requests').select('*').is('done_at', null) : { data: [] };
        resetIds = new Set((resetResult.data || []).map(item => item.profile_id));
        renderAccounts();
        // Freigeschaltete Namen landen auch in der lokalen Vorschlagsliste für die Zuweisung.
        if (typeof addInterpreterName === 'function') {
            accounts.filter(account => account.active && account.full_name).forEach(account => addInterpreterName(account.full_name));
        }
        await loadWorkdays(accounts);
        // Direkter Sprung aus der Dolmetscher-Übersicht: team.html?konto=<id>
        const wanted = new URLSearchParams(location.search).get('konto');
        if (wanted) {
            history.replaceState(null, '', location.pathname);
            const account = accounts.find(item => item.id === wanted);
            if (account && TerminCloud.isAdmin(profile)) openAccount(account);
        }
    }

    function renderAccounts() {
        const waiting = accounts.filter(isWaiting).length;
        const interpreters = accounts.filter(account => account.role === 'dolmetscher' && account.active);
        const women = interpreters.filter(account => account.gender === 'weiblich').length;
        const men = interpreters.filter(account => account.gender === 'männlich').length;
        $('accountsSummary').textContent = [`${accounts.length} ${accounts.length === 1 ? 'Konto' : 'Konten'}`,
            interpreters.length ? `${interpreters.length} ${interpreters.length === 1 ? 'Dolmetscher/in' : 'Dolmetscher/innen'} freigeschaltet (${women} ${women === 1 ? 'Frau' : 'Frauen'}, ${men} ${men === 1 ? 'Mann' : 'Männer'})` : '',
            waiting ? `${waiting} ${waiting === 1 ? 'wartet' : 'warten'} auf Freischaltung` : '',
            resetIds.size ? `${resetIds.size} ${resetIds.size === 1 ? 'Person hat' : 'Personen haben'} das Passwort vergessen` : ''].filter(Boolean).join(', ');

        // Filter mit Zahlen – nur, was es gerade gibt
        const chips = ACCOUNT_FILTERS.map(([key, label, test]) => ({ key, label, test, count: accounts.filter(test).length })).filter(item => item.key === 'alle' || item.count > 0 || item.key === accountFilter);
        if (!chips.some(item => item.key === accountFilter)) accountFilter = 'alle';
        $('accountChips').hidden = accounts.length < 6;
        $('accountChips').replaceChildren(...chips.map(item => {
            const chip = el('button', 'board-chip');
            chip.type = 'button';
            chip.dataset.kind = item.key;
            chip.setAttribute('aria-pressed', String(accountFilter === item.key));
            chip.append(el('span', null, item.label), el('b', null, String(item.count)));
            chip.addEventListener('click', () => { accountFilter = accountFilter === item.key ? 'alle' : item.key; renderAccounts(); });
            return chip;
        }));
        document.querySelector('.account-search').hidden = accounts.length < 6;

        const test = ACCOUNT_FILTERS.find(item => item[0] === accountFilter)[2];
        const words = fold(accountQuery).split(/\s+/).filter(Boolean);
        const matches = account => { const text = fold([account.full_name, account.phone, String(account.phone || '').replace(/\D/g, ''), roleText(account), account.employment].join(' ')); return words.every(word => text.includes(word)); };
        // Wartende Konten und Passwort-Anfragen zuerst, gesperrte zuletzt.
        const rank = account => isWaiting(account) ? 0 : resetIds.has(account.id) ? 1 : isLocked(account) ? 3 : 2;
        const shown = accounts.filter(account => test(account) && matches(account)).sort((left, right) => rank(left) - rank(right) || String(left.full_name).localeCompare(String(right.full_name), 'de'));
        const result = $('accountResult');
        result.replaceChildren();
        if (accountFilter !== 'alle' || accountQuery) {
            result.append(el('span', null, `${shown.length} von ${accounts.length} Konten`));
            const clear = el('button', 'button-quiet board-clear', 'Filter löschen');
            clear.type = 'button';
            clear.addEventListener('click', () => { accountFilter = 'alle'; accountQuery = ''; $('accountSearch').value = ''; renderAccounts(); });
            result.append(clear);
        }
        result.hidden = !result.childElementCount;

        const list = $('accountList');
        list.replaceChildren();
        const canManage = TerminCloud.isAdmin(profile);
        shown.forEach(account => {
            const item = el('li', 'vehicle-entry account-entry');
            item.dataset.account = account.id;
            const meta = el('span');
            meta.append(el('strong', null, account.full_name || '(ohne Namen)'),
                el('small', null, [roleText(account), account.role === 'dolmetscher' ? (account.employment === 'fest' ? 'fest angestellt' : 'temporär') : '', account.phone].filter(Boolean).join(' · ')));
            const state = el('small', account.active ? 'vehicle-driver' : 'account-waiting', account.active ? 'Freigeschaltet' : isWaiting(account) ? 'Wartet auf Freischaltung' : 'Gesperrt');
            meta.append(state);
            if (resetIds.has(account.id)) meta.append(el('small', 'account-waiting', 'Hat das Passwort vergessen'));
            const actions = el('span', 'vehicle-entry-actions');
            const add = (className, text, onClick) => { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', onClick); actions.append(node); return node; };
            if (canManage && account.id !== profile.id) {
                if (!account.active) add('button-primary account-approve', isWaiting(account) ? 'Freischalten' : 'Wieder freischalten', () => updateAccount(account, { active: true }));
                if (account.active && resetIds.has(account.id)) add('button-primary account-approve account-reset', 'Neues Passwort', () => resetPassword(account));
            }
            if (canManage) add('button-quiet account-edit', 'Bearbeiten', () => openAccount(account)).setAttribute('aria-label', `${account.full_name || 'Konto'} bearbeiten`);
            item.append(meta, actions);
            list.append(item);
        });
        if (!shown.length) list.append(el('li', 'directory-empty', accounts.length ? 'Für diese Auswahl gibt es kein Konto.' : 'Noch keine Konten.'));
    }
    $('accountSearch').addEventListener('input', () => { accountQuery = $('accountSearch').value.trim(); renderAccounts(); });

    // ---------- Ein Konto bearbeiten (nur Admin) ----------
    let editedAccount = null;
    const radio = (name, value) => { const node = document.querySelector(`input[name=${name}][value="${value}"]`); if (node) node.checked = true; };
    const radioValue = name => document.querySelector(`input[name=${name}]:checked`)?.value ?? '';
    function openAccount(account) {
        editedAccount = account;
        const own = account.id === profile.id;
        const admin = account.role === 'admin';
        $('accountDialogTitle').textContent = own ? 'Mein Konto bearbeiten' : `${account.full_name || 'Konto'} bearbeiten`;
        $('accountDialogInfo').textContent = [`angemeldet seit ${new Date(account.created_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}`,
            account.approved_at ? `freigeschaltet seit ${new Date(account.approved_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : 'noch nie freigeschaltet'].join(' · ');
        $('accountName').value = account.full_name || '';
        $('accountPhone').value = account.phone || '';
        radio('accountEmployment', account.employment === 'fest' ? 'fest' : 'temporär');
        radio('accountGender', account.gender || '');
        radio('accountRole', account.role === 'sekretariat' ? 'sekretariat' : 'dolmetscher');
        radio('accountActive', account.active ? 'ja' : 'nein');
        $('accountLockedText').textContent = isWaiting(account) ? 'Wartet noch' : 'Gesperrt';
        // Anstellung und Angabe gibt es nur für Dolmetscher; Rolle, Zugang und Löschen nicht beim eigenen und nicht bei einem Admin-Konto.
        $('accountEmploymentRow').hidden = account.role !== 'dolmetscher';
        $('accountGenderRow').hidden = account.role !== 'dolmetscher';
        $('accountRoleRow').hidden = own || admin;
        $('accountActiveRow').hidden = own || admin;
        $('accountDanger').hidden = own;
        $('accountReset').hidden = own || !account.active;
        $('accountDelete').hidden = own || admin;
        $('accountDialog').showModal();
    }
    $('accountCancel').addEventListener('click', () => $('accountDialog').close());
    document.querySelectorAll('input[name=accountRole]').forEach(input => input.addEventListener('change', () => {
        // Das Sekretariat hat weder Anstellung noch Angabe.
        const interpreter = radioValue('accountRole') === 'dolmetscher';
        $('accountEmploymentRow').hidden = !interpreter;
        $('accountGenderRow').hidden = !interpreter;
    }));

    $('accountForm').addEventListener('submit', async event => {
        event.preventDefault();
        const account = editedAccount;
        const own = account.id === profile.id;
        const admin = account.role === 'admin';
        const name = $('accountName').value.trim().replace(/\s+/g, ' ');
        const phone = $('accountPhone').value.trim();
        if (!name) { showToast('Bitte trag den Namen ein.', 'error', { target: '#accountName' }); return; }
        if (phone && !/^[0-9+ /()\-]{6,}$/.test(phone)) { showToast('Die Handynummer darf nur Ziffern, Leerzeichen und + / ( ) - enthalten.', 'error', { target: '#accountPhone' }); return; }
        const changes = {};
        if (name !== (account.full_name || '')) changes.full_name = name;
        if (phone !== (account.phone || '')) changes.phone = phone;
        const role = own || admin ? account.role : radioValue('accountRole');
        if (role !== account.role) changes.role = role;
        if (role === 'dolmetscher') {
            if (radioValue('accountEmployment') !== (account.employment === 'fest' ? 'fest' : 'temporär')) changes.employment = radioValue('accountEmployment');
            if (radioValue('accountGender') !== (account.gender || '')) changes.gender = radioValue('accountGender');
        }
        if (!own && !admin && (radioValue('accountActive') === 'ja') !== Boolean(account.active)) changes.active = radioValue('accountActive') === 'ja';
        if (!Object.keys(changes).length) { $('accountDialog').close(); return; }
        if (changes.role === 'sekretariat' && !await confirmDialog(`${name} sieht und bearbeitet dann alles wie du – Termine, Fahrzeuge, Schäden und Aufträge. Konten verwalten kann nur der Admin. Fortfahren?`, 'Zum Sekretariat machen')) return;
        if (changes.active === false && !await confirmDialog(`${name} sperren?\n\nDie Person kann sich dann nicht mehr anmelden. Alle Daten bleiben erhalten; du kannst das Konto jederzeit wieder freischalten.`, 'Sperren')) return;
        const { error } = await client.from('tt_profiles').update(changes).eq('id', account.id);
        if (error) { showToast(/gender|approved_at|schema cache/i.test(error.message || '') ? 'Dafür fehlt noch ein Datenbank-Update (supabase/update-15.sql).' : TerminCloud.germanError(error), 'error'); return; }
        $('accountDialog').close();
        // Der Name steht auch in der Vorschlagsliste für das Live-Tracking.
        if (changes.full_name && typeof addInterpreterName === 'function') { if (typeof removeInterpreterName === 'function' && account.full_name) removeInterpreterName(account.full_name); addInterpreterName(name); }
        showToast(`${name}: gespeichert.`, 'success');
        if (own) await TerminCloud.getProfile(true);
        await loadAccounts();
        window.refreshCloudInbox?.();
    });

    $('accountReset').addEventListener('click', () => { const account = editedAccount; $('accountDialog').close(); resetPassword(account); });

    // Konto endgültig löschen – läuft über die Server-Funktion, weil nur sie eine Anmeldung entfernen darf.
    $('accountDelete').addEventListener('click', async () => {
        const account = editedAccount;
        const name = account.full_name || 'dieses Konto';
        // Vorher zeigen, was mit dem Konto verschwindet.
        const count = async (table, column) => { const { data, error } = await client.from(table).select('id').eq(column, account.id); return error ? 0 : data.length; };
        const [workdays, jobs, overtime, statements, absences] = await Promise.all([count('tt_workdays', 'user_id'), count('tt_assignments', 'interpreter_id'), count('tt_overtime', 'profile_id'),
            client.from('tt_statements').select('month').eq('profile_id', account.id).then(result => (result.error ? 0 : result.data.length)), count('tt_absences', 'profile_id')]);
        const parts = [workdays ? `${workdays} ${workdays === 1 ? 'Arbeitstag' : 'Arbeitstage'}` : '', jobs ? `${jobs} ${jobs === 1 ? 'Auftrag' : 'Aufträge'}` : '', overtime ? `${overtime} ${overtime === 1 ? 'Überstunden-Meldung' : 'Überstunden-Meldungen'}` : '',
            statements ? `${statements} ${statements === 1 ? 'Abrechnung' : 'Abrechnungen'}` : '', absences ? `${absences} ${absences === 1 ? 'Abwesenheit' : 'Abwesenheiten'}` : ''].filter(Boolean);
        const message = `Das Konto von ${name} endgültig löschen?\n\n${parts.length ? `Mit dem Konto werden gelöscht: ${parts.join(', ')}.` : 'Zu diesem Konto gibt es noch keine Arbeitstage, Aufträge oder Abrechnungen.'}\nFahrten, Schäden, Belege und Unterlagen bleiben erhalten.\n\nDas lässt sich nicht rückgängig machen. Soll die Person nur nicht mehr arbeiten, genügt „Gesperrt“.`;
        if (!await confirmDialog(message, 'Endgültig löschen')) return;
        const result = await TerminCloud.callFunction({ action: 'deleteAccount', profileId: account.id });
        if (!result.ok) { showToast(`Das Konto konnte nicht gelöscht werden: ${result.reason || 'unbekannter Fehler'}`, 'error', { duration: 12000 }); return; }
        $('accountDialog').close();
        showToast(`Das Konto von ${name} ist gelöscht.`, 'success');
        await loadAccounts();
        window.refreshCloudInbox?.();
    });

    // Neues vorläufiges Passwort vergeben – läuft über die Server-Funktion, weil nur sie Passwörter setzen darf.
    async function resetPassword(account) {
        const name = account.full_name || 'dieses Konto';
        if (!await confirmDialog(`Für ${name} ein neues vorläufiges Passwort vergeben? Das alte Passwort gilt dann nicht mehr.`, 'Neues Passwort vergeben')) return;
        const result = await TerminCloud.callFunction({ action: 'resetPassword', profileId: account.id });
        if (!result.ok || !result.data?.password) {
            showToast(`Das Passwort konnte nicht vergeben werden: ${result.reason || 'unbekannter Fehler'}`, 'error', { duration: 12000 });
            return;
        }
        $('passwordDialogText').textContent = `Vorläufiges Passwort für ${name}:`;
        $('passwordDialogValue').textContent = result.data.password;
        $('passwordDialog').showModal();
        await loadAccounts();
        window.refreshCloudInbox?.();
    }
    $('passwordDialogClose').addEventListener('click', () => { $('passwordDialogValue').textContent = ''; $('passwordDialog').close(); });
    $('passwordDialogCopy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText($('passwordDialogValue').textContent); showToast('Passwort kopiert.', 'success'); }
        catch (error) { showToast('Bitte das Passwort von Hand abschreiben.', 'info'); }
    });

    // Ist die Server-Funktion eingerichtet? (für Mitteilungen aufs Handy und neue Passwörter)
    async function checkServer() {
        if (!TerminCloud.isAdmin(profile)) return;
        $('serverCard').hidden = false;
        const result = await TerminCloud.callFunction({ action: 'publicKey' });
        $('serverState').textContent = result.ok
            ? 'Eingerichtet. Dolmetscher schalten Mitteilungen im Portal unter „Mein Konto“ ein; die Erinnerung nach 16 Uhr läuft automatisch.'
            : 'Noch nicht eingerichtet. Anleitung: Datei „supabase/EINRICHTUNG-MITTEILUNGEN.md“ – dauert etwa 5 Minuten. Bis dahin funktionieren Nachrichten im Portal, aber ohne Mitteilung aufs Handy.';
        $('serverCard').dataset.state = result.ok ? 'ok' : 'todo';
    }

    async function updateAccount(account, changes) {
        const { error } = await client.from('tt_profiles').update(changes).eq('id', account.id);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        const name = account.full_name || 'Konto';
        showToast('role' in changes ? `${name}: ${changes.role === 'sekretariat' ? 'Sekretariat' : 'Dolmetscher/in'}` : 'employment' in changes ? `${name}: ${changes.employment === 'fest' ? 'fest angestellt' : 'temporär'}` : changes.active ? `${name} ist freigeschaltet` : `${name} ist gesperrt`, 'success');
        await loadAccounts();
        window.refreshCloudInbox?.();
    }

    async function loadWorkdays(accounts) {
        const days = Array.from({ length: 7 }, (_, offset) => { const date = new Date(); date.setDate(date.getDate() + offset); return date; });
        const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const { data, error } = await client.from('tt_workdays').select('*').gte('date', iso(days[0])).lte('date', iso(days[6]));
        if (error) return;
        const head = $('teamWorkdayHead');
        const body = $('teamWorkdayBody');
        head.replaceChildren();
        body.replaceChildren();
        const users = accounts.filter(account => data.some(entry => entry.user_id === account.id));
        $('teamWorkdayEmpty').hidden = users.length > 0;
        if (!users.length) return;
        const headRow = document.createElement('tr');
        ['Name', ...days.map(date => date.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' }))].forEach(text => {
            const cell = document.createElement('th');
            cell.textContent = text;
            headRow.append(cell);
        });
        head.append(headRow);
        users.forEach(account => {
            const row = document.createElement('tr');
            const name = document.createElement('td');
            name.textContent = account.full_name;
            row.append(name);
            days.forEach(date => {
                const cell = document.createElement('td');
                const entry = data.find(item => item.user_id === account.id && item.date === iso(date));
                if (entry) {
                    const pill = document.createElement('span');
                    pill.className = 'status-pill';
                    pill.dataset.status = entry.status === 'verfügbar' ? 'erledigt' : 'offen';
                    pill.textContent = entry.status === 'verfügbar' ? 'kann' : 'kann nicht';
                    cell.append(pill);
                } else {
                    cell.textContent = '–';
                }
                row.append(cell);
            });
            body.append(row);
        });
    }

    // ---------- Anmeldung ----------
    $('teamToggleRegister').addEventListener('click', () => {
        registerMode = !registerMode;
        $('teamName').hidden = !registerMode;
        $('teamNameLabel').hidden = !registerMode;
        $('teamName').required = registerMode;
        $('teamSubmit').textContent = registerMode ? 'Konto anlegen' : 'Anmelden';
        $('teamToggleRegister').textContent = registerMode ? 'Ich habe schon ein Konto' : 'Neues Konto anlegen';
        $('teamPassword').autocomplete = registerMode ? 'new-password' : 'current-password';
    });

    $('teamSignInForm').addEventListener('submit', async event => {
        event.preventDefault();
        const email = $('teamEmail').value.trim();
        const password = $('teamPassword').value;
        try {
            if (registerMode) {
                const result = await TerminCloud.signUp(email, password, $('teamName').value.trim().replace(/\s+/g, ' '), '');
                if (result.needsEmailConfirmation) {
                    setStatus('Konto angelegt. Bitte bestätige den Link in der E-Mail und melde dich danach hier an.');
                    $('teamToggleRegister').click();
                    return;
                }
            } else {
                await TerminCloud.signIn(email, password);
            }
            $('teamPassword').value = '';
            await refresh();
        } catch (error) {
            setStatus(error.message, 'error');
        }
    });

    $('teamSignOut').addEventListener('click', async () => { await TerminCloud.signOut(); await refresh(); });
    $('teamReload').addEventListener('click', refresh);
    const copyLink = async field => {
        try {
            await navigator.clipboard.writeText(field.value);
            showToast('Link kopiert', 'success');
        } catch (error) {
            field.select();
            showToast('Bitte den markierten Link mit Strg+C kopieren.', 'info');
        }
    };
    $('copyPortalLink').addEventListener('click', () => copyLink($('portalLink')));
    $('copyGuideLink').addEventListener('click', () => copyLink($('guideLink')));

    refresh();
})();
