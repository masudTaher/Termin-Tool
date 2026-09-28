// Arbeitsstand zwischen den drei Seiten im selben Browser-Tab weitergeben.
// Die Daten bleiben in sessionStorage und werden beim Schließen der Sitzung verworfen.
const TERMIN_WORKFLOW_KEY = 'terminTool.workflow.v1';

function readTerminWorkflow() {
    try {
        const saved = sessionStorage.getItem(TERMIN_WORKFLOW_KEY);
        return saved ? JSON.parse(saved) : {};
    } catch (error) {
        console.warn('Der gespeicherte Arbeitsstand konnte nicht gelesen werden.');
        return {};
    }
}

function saveTerminWorkflow(changes) {
    try {
        const current = readTerminWorkflow();
        sessionStorage.setItem(TERMIN_WORKFLOW_KEY, JSON.stringify({
            ...current,
            ...changes,
            updatedAt: new Date().toISOString()
        }));
        return true;
    } catch (error) {
        console.warn('Der Arbeitsstand konnte nicht zwischengespeichert werden.');
        return false;
    }
}

function saveTerminRecords(records, step, extra = {}) {
    return saveTerminWorkflow({ ...extra, records, step });
}

function readTerminRecords() {
    const workflow = readTerminWorkflow();
    return Array.isArray(workflow.records) ? workflow.records : null;
}

function showWorkflowStatus(message, kind = 'info') {
    const status = document.getElementById('workflowStatus');
    if (!status) return;
    status.textContent = message;
    status.dataset.kind = kind;
}

function persistTerminRecords(records, step, extra = {}) {
    const saved = saveTerminRecords(records, step, extra);
    if (!saved) {
        showWorkflowStatus('Der Browser konnte den Arbeitsstand nicht speichern. Bitte vor dem Wechsel die Excel-Datei herunterladen.', 'error');
    }
    return saved;
}

function normalizeTerminDatum(value) {
    if (value === null || value === undefined || value === '') return '';

    const formatParts = (day, month, year) => `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${String(year).padStart(4, '0')}`;

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return formatParts(value.getDate(), value.getMonth() + 1, value.getFullYear());
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
        return formatParts(date.getUTCDate(), date.getUTCMonth() + 1, date.getUTCFullYear());
    }

    const text = String(value).trim();
    const germanDate = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
    if (germanDate) {
        const year = germanDate[3].length === 2 ? `20${germanDate[3]}` : germanDate[3];
        return formatParts(germanDate[1], germanDate[2], year);
    }

    const isoDate = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoDate) return formatParts(isoDate[3], isoDate[2], isoDate[1]);

    const parsedDate = new Date(text);
    if (!Number.isNaN(parsedDate.getTime())) {
        return formatParts(parsedDate.getDate(), parsedDate.getMonth() + 1, parsedDate.getFullYear());
    }
    return text;
}

// FileMaker-Exporte können Uhrzeiten als Excel-Zahl (Tagesbruch) liefern,
// während manuell erstellte Dateien sie oft als Text enthalten.
function normalizeTerminUhrzeit(value) {
    if (value === null || value === undefined || value === '') return '';

    const formatSeconds = totalSeconds => {
        const secondsInDay = 24 * 60 * 60;
        const wrappedSeconds = ((Math.round(totalSeconds) % secondsInDay) + secondsInDay) % secondsInDay;
        const hours = Math.floor(wrappedSeconds / 3600);
        const minutes = Math.floor((wrappedSeconds % 3600) / 60);
        const seconds = wrappedSeconds % 60;
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    };

    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return formatSeconds(value.getHours() * 3600 + value.getMinutes() * 60 + value.getSeconds());
    }

    if (typeof value === 'number' && Number.isFinite(value)) {
        return formatSeconds(value * 24 * 60 * 60);
    }

    const text = String(value).trim();
    if (!text) return '';

    if (/^\d+(?:\.\d+)?$/.test(text)) {
        const numericValue = Number(text);
        if (Number.isFinite(numericValue) && numericValue >= 0 && numericValue < 2) {
            return formatSeconds(numericValue * 24 * 60 * 60);
        }
    }

    const match = text.match(/(?:^|[T\s])(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!match) return text;

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = Number(match[3] || 0);
    if (hours > 23 || minutes > 59 || seconds > 59) return text;
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function normalizeTerminRecords(records) {
    if (!Array.isArray(records)) return records;
    return records.map(record => ({
        ...record,
        Termin_Datum: normalizeTerminDatum(record?.Termin_Datum),
        Termin_Uhrzeit: normalizeTerminUhrzeit(record?.Termin_Uhrzeit)
    }));
}

function compareTerminUhrzeit(left, right) {
    const toSeconds = value => {
        const normalized = normalizeTerminUhrzeit(value);
        const match = normalized.match(/^(\d{2}):(\d{2}):(\d{2})$/);
        return match
            ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
            : Number.POSITIVE_INFINITY;
    };

    return toSeconds(left) - toSeconds(right);
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}
