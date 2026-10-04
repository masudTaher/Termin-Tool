// Gerätegebundene Dolmetscher-Namensliste. Hier werden keine Termindaten gespeichert.
const INTERPRETER_DIRECTORY_KEY = 'terminTool.interpreterDirectory.v1';

function normalizeInterpreterName(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
}

function readInterpreterDirectory() {
    try {
        const stored = JSON.parse(localStorage.getItem(INTERPRETER_DIRECTORY_KEY) || '[]');
        if (!Array.isArray(stored)) return [];
        return [...new Set(stored.map(normalizeInterpreterName).filter(Boolean))]
            .sort((left, right) => left.localeCompare(right, 'de', { sensitivity: 'base' }));
    } catch (error) {
        console.warn('Die Dolmetscherliste konnte nicht gelesen werden.');
        return [];
    }
}

function writeInterpreterDirectory(names) {
    const cleaned = [...new Set((names || []).map(normalizeInterpreterName).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right, 'de', { sensitivity: 'base' }));
    try {
        localStorage.setItem(INTERPRETER_DIRECTORY_KEY, JSON.stringify(cleaned));
        refreshInterpreterSuggestions();
        return true;
    } catch (error) {
        return false;
    }
}

function addInterpreterName(value) {
    const name = normalizeInterpreterName(value);
    if (!name) return false;
    const names = readInterpreterDirectory();
    if (names.some(existing => existing.toLocaleLowerCase('de') === name.toLocaleLowerCase('de'))) {
        refreshInterpreterSuggestions();
        return false;
    }
    return writeInterpreterDirectory([...names, name]);
}

function removeInterpreterName(value) {
    const normalized = normalizeInterpreterName(value).toLocaleLowerCase('de');
    return writeInterpreterDirectory(readInterpreterDirectory().filter(name => name.toLocaleLowerCase('de') !== normalized));
}

function refreshInterpreterSuggestions() {
    const datalist = document.getElementById('dolmetscherSuggestions');
    if (!datalist) return;
    datalist.replaceChildren(...readInterpreterDirectory().map(name => {
        const option = document.createElement('option');
        option.value = name;
        return option;
    }));
}

function renderInterpreterDirectory() {
    const list = document.getElementById('interpreterDirectoryList');
    const count = document.getElementById('interpreterDirectoryCount');
    if (!list || !count) return;

    const names = readInterpreterDirectory();
    count.textContent = `${names.length} ${names.length === 1 ? 'Dolmetscher/in' : 'Dolmetscher/innen'} gespeichert`;
    list.replaceChildren();

    if (!names.length) {
        const empty = document.createElement('li');
        empty.className = 'directory-empty';
        empty.textContent = 'Noch keine Namen eingetragen. Du kannst einen Namen oder mehrere Namen zeilenweise hinzufügen.';
        list.append(empty);
        return;
    }

    names.forEach(name => {
        const item = document.createElement('li');
        item.className = 'directory-entry';
        const label = document.createElement('span');
        label.className = 'directory-entry-name';
        label.textContent = name;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'button-quiet-danger';
        remove.textContent = 'Entfernen';
        remove.setAttribute('aria-label', `${name} aus der Dolmetscherliste entfernen`);
        remove.addEventListener('click', () => {
            removeInterpreterName(name);
            renderInterpreterDirectory();
        });
        item.append(label, remove);
        list.append(item);
    });
}

function initializeInterpreterDirectoryPage() {
    const singleForm = document.getElementById('addInterpreterForm');
    const bulkForm = document.getElementById('addInterpreterBulkForm');
    const fileInput = document.getElementById('importInterpreterFile');
    const status = document.getElementById('interpreterDirectoryStatus');

    singleForm?.addEventListener('submit', event => {
        event.preventDefault();
        const input = document.getElementById('interpreterNameInput');
        const name = normalizeInterpreterName(input.value);
        if (!name) return;
        const added = addInterpreterName(name);
        status.textContent = added ? `${name} wurde gespeichert.` : `${name} steht bereits in der Liste.`;
        input.value = '';
        renderInterpreterDirectory();
        input.focus();
    });

    bulkForm?.addEventListener('submit', event => {
        event.preventDefault();
        const input = document.getElementById('interpreterNamesBulk');
        const entries = input.value.split(/\r?\n|;/).map(normalizeInterpreterName).filter(Boolean);
        const before = readInterpreterDirectory().length;
        const success = writeInterpreterDirectory([...readInterpreterDirectory(), ...entries]);
        if (!success) {
            status.textContent = 'Speichern nicht möglich. Prüfe den verfügbaren Browserspeicher.';
            return;
        }
        const added = readInterpreterDirectory().length - before;
        status.textContent = `${added} neue ${added === 1 ? 'Person gespeichert' : 'Personen gespeichert'}.`;
        input.value = '';
        renderInterpreterDirectory();
    });

    document.getElementById('exportInterpreterNames')?.addEventListener('click', () => {
        const names = readInterpreterDirectory();
        if (!names.length) {
            status.textContent = 'Die Liste ist noch leer.';
            return;
        }
        const blob = new Blob([names.join('\r\n')], { type: 'text/plain;charset=utf-8' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'Dolmetscherliste.txt';
        link.click();
        URL.revokeObjectURL(link.href);
        status.textContent = 'Die Namensliste wurde als Textdatei exportiert.';
    });

    fileInput?.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file) return;
        const names = (await file.text()).split(/\r?\n|;|,/).map(normalizeInterpreterName).filter(Boolean);
        const before = readInterpreterDirectory().length;
        const success = writeInterpreterDirectory([...readInterpreterDirectory(), ...names]);
        const added = success ? readInterpreterDirectory().length - before : 0;
        status.textContent = success
            ? `${added} neue ${added === 1 ? 'Person importiert' : 'Personen importiert'}.`
            : 'Import nicht möglich. Prüfe den verfügbaren Browserspeicher.';
        renderInterpreterDirectory();
    });

    renderInterpreterDirectory();
    refreshInterpreterSuggestions();
}

initializeInterpreterDirectoryPage();
