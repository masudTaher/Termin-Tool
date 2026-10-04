// Admin-Seite: Konten freischalten, Schäden bearbeiten, Arbeitstage ansehen.
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
        const sync = await TerminCloud.syncFleet();
        if (!sync.ok && sync.reason && !['offline', 'not-admin'].includes(sync.reason)) setStatus(`Fuhrpark-Abgleich: ${sync.reason}`, 'error');
        await loadAccounts();
        window.refreshCloudInbox?.();
    }

    // ---------- Konten + Arbeitstage ----------
    async function loadAccounts() {
        const { data: accounts, error } = await client.from('tt_profiles').select('*').order('full_name');
        if (error) { setStatus(TerminCloud.germanError(error), 'error'); return; }
        const waiting = accounts.filter(account => !account.active).length;
        $('accountsSummary').textContent = `${accounts.length} ${accounts.length === 1 ? 'Konto' : 'Konten'}${waiting ? `, ${waiting} warten auf Freischaltung` : ''}`;
        const list = $('accountList');
        list.replaceChildren();
        // Wartende Konten zuerst.
        [...accounts].sort((left, right) => Number(left.active) - Number(right.active)).forEach(account => {
            const item = document.createElement('li');
            item.className = 'vehicle-entry';
            const meta = document.createElement('span');
            const name = document.createElement('strong');
            name.textContent = account.full_name || '(ohne Namen)';
            const details = document.createElement('small');
            details.textContent = [{ admin: 'Admin', sekretariat: 'Sekretariat' }[account.role] || 'Dolmetscher/in', account.employment === 'fest' ? 'fest angestellt' : 'temporär', account.phone].filter(Boolean).join(' · ');
            const state = document.createElement('small');
            state.className = account.active ? 'vehicle-driver' : 'account-waiting';
            state.textContent = account.active ? 'Freigeschaltet' : 'Wartet auf Freischaltung';
            meta.append(name, details, state);
            const actions = document.createElement('span');
            actions.className = 'vehicle-entry-actions';
            const canManage = TerminCloud.isAdmin(profile);
            if (canManage && account.active && account.role === 'dolmetscher') {
                const employment = document.createElement('button');
                employment.type = 'button';
                employment.className = 'button-quiet';
                employment.textContent = account.employment === 'fest' ? 'Auf temporär setzen' : 'Als fest markieren';
                employment.addEventListener('click', () => updateAccount(account, { employment: account.employment === 'fest' ? 'temporär' : 'fest' }));
                actions.append(employment);
            }
            if (canManage && account.active && account.id !== profile.id) {
                const role = document.createElement('button');
                role.type = 'button';
                role.className = 'button-quiet';
                role.textContent = account.role === 'sekretariat' ? 'Sekretariat entfernen' : 'Zum Sekretariat machen';
                role.addEventListener('click', async () => {
                    const makeStaff = account.role !== 'sekretariat';
                    const confirmed = !makeStaff || await confirmDialog(`${account.full_name || 'Dieses Konto'} sieht und bearbeitet dann alles wie du – Termine, Fahrzeuge, Schäden und Aufträge. Konten verwalten kann nur der Admin. Fortfahren?`, 'Zum Sekretariat machen');
                    if (confirmed) updateAccount(account, { role: makeStaff ? 'sekretariat' : 'dolmetscher' });
                });
                actions.append(role);
            }
            if (canManage && account.id !== profile.id) {
                const toggle = document.createElement('button');
                toggle.type = 'button';
                toggle.className = account.active ? 'button-quiet-danger' : 'button-primary account-approve';
                toggle.textContent = account.active ? 'Sperren' : 'Freischalten';
                toggle.addEventListener('click', () => updateAccount(account, { active: !account.active }));
                actions.append(toggle);
            }
            item.append(meta, actions);
            list.append(item);
        });
        // Freigeschaltete Namen landen auch in der lokalen Vorschlagsliste für die Zuweisung.
        if (typeof addInterpreterName === 'function') {
            accounts.filter(account => account.active && account.full_name).forEach(account => addInterpreterName(account.full_name));
        }
        await loadWorkdays(accounts);
    }

    async function updateAccount(account, changes) {
        const { error } = await client.from('tt_profiles').update(changes).eq('id', account.id);
        if (error) { showToast(TerminCloud.germanError(error), 'error'); return; }
        const name = account.full_name || 'Konto';
        showToast('role' in changes ? `${name}: ${changes.role === 'sekretariat' ? 'Sekretariat' : 'Dolmetscher/in'}` : 'employment' in changes ? `${name}: ${changes.employment === 'fest' ? 'fest angestellt' : 'temporär'}` : changes.active ? `${name} ist freigeschaltet` : `${name} ist gesperrt`, 'success');
        await loadAccounts();
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
    $('copyPortalLink').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText($('portalLink').value);
            showToast('Link kopiert', 'success');
        } catch (error) {
            $('portalLink').select();
            showToast('Bitte den markierten Link mit Strg+C kopieren.', 'info');
        }
    });

    refresh();
})();
