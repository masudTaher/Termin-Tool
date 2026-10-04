const TRACKING_REMINDER_ALERTS_KEY = 'terminTool.trackingReminderAlerts.v1';
let trackingReminderAudio = null;
let trackingReminderSoundEnabled = false;

function readTrackingReminderAlerts() {
    try {
        const value = JSON.parse(sessionStorage.getItem(TRACKING_REMINDER_ALERTS_KEY) || '[]');
        return new Set(Array.isArray(value) ? value : []);
    } catch (error) {
        return new Set();
    }
}

function saveTrackingReminderAlerts(alerts) {
    try {
        sessionStorage.setItem(TRACKING_REMINDER_ALERTS_KEY, JSON.stringify([...alerts]));
    } catch (error) {
        // A missing browser storage slot must not stop the visible alert.
    }
}

function getAppointmentStart(appointment) {
    const date = normalizeTerminDatum(appointment?.Termin_Datum);
    const time = normalizeTerminUhrzeit(appointment?.Termin_Uhrzeit);
    const dateMatch = String(date).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    const timeMatch = String(time).match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!dateMatch || !timeMatch) return null;
    const [, day, month, year] = dateMatch;
    const [, hour, minute, second = '0'] = timeMatch;
    const start = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), 0);
    return Number.isNaN(start.getTime()) ? null : start;
}

function getAppointmentLocationValues(appointment) {
    const entries = [];
    const appointmentLocations = [
        appointment?.['Arzt Nr::Ort'],
        appointment?.Ort, appointment?.Termin_Ort, appointment?.Stadt
    ].map(value => String(value ?? '').trim()).filter(Boolean);
    appointmentLocations.forEach((value, index) => {
        if (!appointmentLocations.slice(0, index).some(previous => previous.toLocaleLowerCase('de') === value.toLocaleLowerCase('de'))) {
            entries.push({ kind: 'appointment', value });
        }
    });

    const addressParts = { patient: [], doctor: [] };
    Object.keys(appointment || {}).forEach(key => {
        const normalized = normalizeAppointmentColumnName(key);
        const locationField = /adresse|anschrift|strasse|street|hausnummer|plz|postleitzahl|postal|zip|ort|stadt|city|qatar|katar|country|land/.test(normalized);
        if (!locationField) return;
        const value = String(appointment[key] ?? '').trim();
        if (!value) return;
        if (/patient/.test(normalized)) addressParts.patient.push(value);
        else if (/arzt|praxis/.test(normalized)) addressParts.doctor.push(value);
    });

    Object.entries(addressParts).forEach(([kind, values]) => {
        const uniqueValues = [...new Set(values.map(value => value.toLocaleLowerCase('de')))]
            .map(normalized => values.find(value => value.toLocaleLowerCase('de') === normalized));
        if (uniqueValues.length) entries.push({ kind, value: uniqueValues.join(', ') });
    });

    return entries.filter((entry, index, values) => values.findIndex(other =>
        other.kind === entry.kind && other.value.toLocaleLowerCase('de') === entry.value.toLocaleLowerCase('de')
    ) === index);
}

function isBonnLocation(value) {
    return /\bbonn\b/i.test(String(value || '')) || /\b53(?:1|2)\d{2}\b/.test(String(value || ''));
}

function requiresExtendedReminder(appointment) {
    const locations = getAppointmentLocationValues(appointment);
    if (!locations.length) return true;
    return locations.some(location => !isBonnLocation(location.value));
}

function getOpenAppointmentReminder(appointment, index, now = new Date()) {
    const status = String(appointment?.Status || 'offen').trim().toLocaleLowerCase('de');
    if (['losgefahren', 'beendet', 'alleine', 'storniert'].includes(status)) return null;

    const start = getAppointmentStart(appointment);
    if (!start || start <= now) return null;
    const extended = requiresExtendedReminder(appointment);
    const leadMinutes = extended ? 90 : 60;
    const minutesRemaining = Math.ceil((start.getTime() - now.getTime()) / 60000);
    if (minutesRemaining > leadMinutes) return null;

    const patientName = [appointment?.['Patienten Nr::Patienten_Vorname'], appointment?.['Patienten Nr::Patienten_Name']]
        .map(value => String(value || '').trim()).filter(Boolean).join(' ') || `Termin ${index + 1}`;
    const place = getAppointmentLocationValues(appointment)[0]?.value || 'Ort nicht angegeben';
    const time = normalizeTerminUhrzeit(appointment.Termin_Uhrzeit).slice(0, 5);
    const identity = [
        normalizeTerminDatum(appointment.Termin_Datum),
        normalizeTerminUhrzeit(appointment.Termin_Uhrzeit),
        appointment.Patient_Nr || patientName,
        appointment['Arzt Nr::Name'] || '',
        place
    ].join('|');

    return { identity, patientName, place, time, minutesRemaining, leadMinutes, extended };
}

function playTrackingReminderTone() {
    if (!trackingReminderAudio || trackingReminderAudio.state !== 'running') return false;
    const now = trackingReminderAudio.currentTime;
    [0, 0.33, 0.66].forEach((offset, index) => {
        const oscillator = trackingReminderAudio.createOscillator();
        const gain = trackingReminderAudio.createGain();
        oscillator.type = 'sine';
        oscillator.frequency.value = index === 1 ? 920 : 740;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.17, now + offset + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.19);
        oscillator.connect(gain);
        gain.connect(trackingReminderAudio.destination);
        oscillator.start(now + offset);
        oscillator.stop(now + offset + 0.2);
    });
    return true;
}

async function enableTrackingReminderSound() {
    const AudioContextType = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextType) {
        document.getElementById('reminderSoundStatus').textContent = 'Dieser Browser unterstützt den Erinnerungston nicht.';
        return;
    }

    try {
        trackingReminderAudio = trackingReminderAudio || new AudioContextType();
        await trackingReminderAudio.resume();
        trackingReminderSoundEnabled = true;
        const button = document.getElementById('enableReminderSound');
        button.textContent = 'Ton ausschalten';
        button.classList.add('is-enabled');
        document.getElementById('reminderSoundStatus').textContent = 'Aktiv, solange diese Tracking-Seite geöffnet ist';
        const alerts = readTrackingReminderAlerts();
        const hasUnseenReminder = Array.isArray(trackingData) && trackingData.some((appointment, index) => {
            const reminder = getOpenAppointmentReminder(appointment, index);
            return reminder && !alerts.has(reminder.identity);
        });
        if (!hasUnseenReminder) playTrackingReminderTone();
        refreshTrackingReminders();
    } catch (error) {
        document.getElementById('reminderSoundStatus').textContent = 'Ton konnte nicht gestartet werden. Prüfe die Windows-Lautstärke.';
    }
}

function disableTrackingReminderSound() {
    trackingReminderSoundEnabled = false;
    const button = document.getElementById('enableReminderSound');
    button.textContent = 'Ton einschalten';
    button.classList.remove('is-enabled');
    document.getElementById('reminderSoundStatus').textContent = 'Ausgeschaltet';
}

function renderTrackingReminderBanner(reminders) {
    const banner = document.getElementById('reminderBanner');
    if (!banner) return;
    banner.replaceChildren();
    if (!reminders.length) {
        banner.hidden = true;
        return;
    }

    const heading = document.createElement('strong');
    heading.textContent = `${reminders.length === 1 ? 'Noch ein Termin' : `${reminders.length} Termine`} offen und bald fällig`;
    banner.append(heading);
    const list = document.createElement('ul');
    reminders.forEach(reminder => {
        const item = document.createElement('li');
        item.textContent = `${reminder.time} Uhr — ${reminder.patientName}, ${reminder.place} — in ca. ${reminder.minutesRemaining} Min.`;
        list.append(item);
    });
    banner.append(list);

    if (!trackingReminderSoundEnabled) {
        const help = document.createElement('p');
        help.className = 'reminder-banner-help';
        help.textContent = 'Der Browser benötigt einen Klick, bevor er Töne abspielen darf.';
        const activate = document.createElement('button');
        activate.type = 'button';
        activate.className = 'button-secondary reminder-enable-inline';
        activate.textContent = 'Erinnerungston einschalten';
        activate.addEventListener('click', enableTrackingReminderSound);
        banner.append(help, activate);
    }
    banner.hidden = false;
}

function refreshTrackingReminders() {
    if (!Array.isArray(trackingData)) return;
    const now = new Date();
    const activeReminders = trackingData
        .map((appointment, index) => getOpenAppointmentReminder(appointment, index, now))
        .filter(Boolean);
    const alerts = readTrackingReminderAlerts();
    const unseen = activeReminders.filter(reminder => !alerts.has(reminder.identity));

    if (trackingReminderSoundEnabled && unseen.length && playTrackingReminderTone()) {
        unseen.forEach(reminder => alerts.add(reminder.identity));
        saveTrackingReminderAlerts(alerts);
    }
    renderTrackingReminderBanner(activeReminders);
}

document.getElementById('enableReminderSound')?.addEventListener('click', () => {
    if (trackingReminderSoundEnabled) disableTrackingReminderSound();
    else enableTrackingReminderSound();
});

document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshTrackingReminders();
});

refreshTrackingReminders();
window.setInterval(refreshTrackingReminders, 20000);
