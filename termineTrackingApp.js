let trackingData = [];
let workbook;
let trackingRefreshInterval = null;
let activeWhatsAppAppointmentIndex = null;

// Excel-Datei hochladen und einlesen
document.getElementById('trackingFile').addEventListener('change', handleFileUpload);

function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file)
        return;

    event.target.value = '';

    if (typeof XLSX === 'undefined') {
        showWorkflowStatus('Die Excel-Funktion konnte nicht geladen werden. Bitte prüfe die Internetverbindung und lade die Seite erneut.', 'error');
        return;
    }

    showWorkflowStatus(`${file.name} wird geprüft …`);
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
        const data = new Uint8Array(e.target.result);
        workbook = XLSX.read(data, {
            type: 'array'
        });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];
        trackingData = normalizeTerminRecords(XLSX.utils.sheet_to_json(worksheet));
        if (trackingData.length === 0) {
            showWorkflowStatus('Die Excel-Datei enthält keine Termine.', 'error');
            return;
        }

        // Überprüfen, ob die Spalte "Status" vorhanden ist
        if (!trackingData[0] || !trackingData[0].hasOwnProperty('Status')) {
            trackingData = trackingData.map(row => ({
                        ...row,
                        Status: "offen"
                    }));
        }

        renderTrackingTable(trackingData);
        persistTerminRecords(trackingData, 'tracking', { filtered: trackingData, removed: [] });
        showWorkflowStatus(`${trackingData.length} Termine geladen. Änderungen werden in diesem Browser-Tab zwischengespeichert.`);
        startTrackingRefresh();
        } catch (error) {
            console.error('Fehler beim Einlesen der Excel-Datei:', error);
            showWorkflowStatus('Die Excel-Datei konnte nicht verarbeitet werden. Bitte prüfe das Tabellenblatt und die Spaltenüberschriften.', 'error');
        }
    };
    reader.onerror = () => showWorkflowStatus('Die Excel-Datei konnte nicht gelesen werden. Bitte wähle sie erneut aus.', 'error');
    reader.readAsArrayBuffer(file);
}

function startTrackingRefresh() {
    if (trackingRefreshInterval) return;
    trackingRefreshInterval = setInterval(() => updateAppointmentsStartingSoon(trackingData), 10000);
}

// Function to update rows with appointments that are starting soon
function updateAppointmentsStartingSoon(data) {
    const tableBody = document.getElementById('tableBody');
    const rows = tableBody.querySelectorAll('tr');

    rows.forEach((row, index) => {
        const termin = data[index];

        // Check if the appointment is starting soon
        if (isAppointmentStartingSoonOrOngoing(termin) && termin.Status === "offen") {
            row.style.backgroundColor = '#cce5ff'; // Highlight rows that are starting soon with a light blue color
        } else if (termin.Status === "beendet" || termin.Status === "alleine") {
            row.style.backgroundColor = '#ddffdd'; // Green for completed appointments
        } else if (termin.Status === "storniert") {
            row.style.backgroundColor = '#ffdddd'; // Red for canceled appointments
        } else if (termin.Status === "losgefahren") {
            row.style.backgroundColor = '#ffffcc'; // Yellow for departed appointments
        } else {
            row.style.backgroundColor = ''; // Reset to default
        }
    });

    console.log("Appointments updated for those starting soon."); // Optional logging for debugging
}

// Render the tracking table
function renderTrackingTable(data) {
    const tableBody = document.getElementById('tableBody');
    const tablesSection = document.querySelector('.tables-section');
    const actionSection = document.querySelector('.action-section');

    tableBody.innerHTML = ''; // Clear previous content

    if (data.length === 0) {
        tablesSection.style.display = 'none';
        actionSection.style.display = 'none';
        return; // No data, exit the function
    }

    tablesSection.style.display = 'block'; // The tracking table uses the full page width
    actionSection.style.display = 'flex'; // Show the action section

    const columnLabels = ['Lfd. Nr.', 'Start', 'Patienten-Nr.', 'Patient', 'Geschlecht', 'Bemerkung', 'Arzt', 'Ort', 'Übersetzer', 'Anzahl Termine', 'Status', 'Aktion'];

    data.forEach((termin, index) => {
        const row = document.createElement('tr');

        // Check if the appointment is starting soon
        if (isAppointmentStartingSoonOrOngoing(termin) && termin.Status === "offen") {
            row.style.backgroundColor = '#cce5ff'; // Highlight rows that are starting soon with a light blue color
        } else if (termin.Status === "beendet" || termin.Status === "alleine") {
            row.style.backgroundColor = '#ddffdd'; // Green for completed appointments
        } else if (termin.Status === "storniert") {
            row.style.backgroundColor = '#ffdddd'; // Red for canceled appointments
        } else if (termin.Status === "losgefahren") {
            row.style.backgroundColor = '#ffffcc'; // Yellow for departed appointments
        } else {
            row.style.backgroundColor = ''; // Reset to default
        }

        let endTime = '';
        if (termin.Termin_Uhrzeit) {
            const startTime = new Date(`1970-01-01T${termin.Termin_Uhrzeit}`);
            const durationMinutes = termin.Dauer * 60;
            endTime = new Date(startTime.getTime() + durationMinutes * 60000);
        }

        row.innerHTML = `
			            <td>${index + 1}</td> <!-- Add the Lfd. Nr. column -->

			<td contenteditable="true" onblur="updateTimeCell(event, ${index})">${escapeHtml(termin.Termin_Uhrzeit || '')}</td>
			<td>${escapeHtml(termin.Patient_Nr || '')}</td>

            <td>
				${(termin['Patienten Nr::Patienten_Vorname'] || termin['Patienten Nr::Patienten_Name'])
					? escapeHtml((termin['Patienten Nr::Patienten_Vorname'] || '') + (termin['Patienten Nr::Patienten_Name'] ? ' ' + termin['Patienten Nr::Patienten_Name'] : ''))
						: ''}				
			</td>

			<td>${escapeHtml(termin['Patienten Nr::Patienten_Geschlecht'] ? termin['Patienten Nr::Patienten_Geschlecht'].charAt(0) : '')}</td>
			            <td>${escapeHtml(termin.Bemerkung || '')}</td>

            <td>${escapeHtml(termin['Arzt Nr::Name'] || '')}</td>
			            <td>${escapeHtml(termin['Arzt Nr::Vorname'] || '')}</td>

			<td contenteditable="true" oninput="updateCell(event, ${index}, 'Übersetzer')">${escapeHtml(termin.Übersetzer || '')}</td>
			<td>${escapeHtml(termin.Anzahl_Termine || '')}</td>
			<td>
                <select data-index="${index}" class="status-select">
                    <option value="offen" ${termin.Status === "offen" ? "selected" : ""}>Offen</option>
                    <option value="beendet" ${termin.Status === "beendet" ? "selected" : ""}>Beendet</option>
					<option value="alleine" ${termin.Status === "alleine" ? "selected" : ""}>Alleine</option>
                    <option value="storniert" ${termin.Status === "storniert" ? "selected" : ""}>Storniert</option>
                    <option value="losgefahren" ${termin.Status === "losgefahren" ? "selected" : ""}>Losgefahren</option>
                </select>
            </td>
		          <td>
                <div class="tracking-row-actions">
                  <button type="button" class="whatsapp-button" data-index="${index}" aria-label="WhatsApp-Nachricht für diesen Termin vorbereiten" title="Nachricht an den Übersetzer vorbereiten">WhatsApp</button>
                  <button type="button" class="delete-button" data-index="${index}">Löschen</button>
                </div>
              </td>


        `;
        row.querySelectorAll('td').forEach((cell, columnIndex) => {
            cell.dataset.label = columnLabels[columnIndex] || '';
        });
        tableBody.appendChild(row);
    });
	
	    // Event-Listener für den Löschen-Button hinzufügen
    document.querySelectorAll('.delete-button').forEach(button =>
        button.addEventListener('click', deleteRow));

    document.querySelectorAll('.whatsapp-button').forEach(button =>
        button.addEventListener('click', event => openWhatsAppModal(Number(event.currentTarget.dataset.index))));

    document.querySelectorAll('.status-select').forEach(select =>
        select.addEventListener('change', updateStatusFromSelect));
}


function normalizeAppointmentColumnName(name) {
    return String(name || '')
        .toLocaleLowerCase('de-DE')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '');
}

function getAppointmentContactEntries(termin, person, kind) {
    const keys = Object.keys(termin || {});
    const personPattern = person === 'patient' ? /patient/ : /arzt|praxis/;
    const kindPattern = kind === 'phone'
        ? /telefon|rufnummer|phone|handy|mobil|mobile|cell/
        : /adresse|anschrift|strasse|street|hausnummer|plz|postleitzahl|postal|zip|ort|stadt|city|str$/;

    return keys
        .filter(key => {
            const normalized = normalizeAppointmentColumnName(key);
            return personPattern.test(normalized) && kindPattern.test(normalized);
        })
        .map(key => ({ key, value: String(termin[key] ?? '').trim() }))
        .filter(entry => entry.value)
        .filter((entry, index, entries) => entries.findIndex(other =>
            other.value.toLocaleLowerCase('de-DE') === entry.value.toLocaleLowerCase('de-DE')
        ) === index);
}

function getAppointmentContactValues(termin, person, kind) {
    return getAppointmentContactEntries(termin, person, kind).map(entry => entry.value);
}

function getPatientAddressFields(termin) {
    return getAppointmentContactEntries(termin, 'patient', 'address').map(({ key, value }) => {
        const normalized = normalizeAppointmentColumnName(key);
        let label = 'Patientenadresse';
        if (normalized.includes('deutschland')) label += ' (Deutschland)';
        else if (normalized.includes('qatar') || normalized.includes('katar')) label += ' (Katar)';
        return [label, value];
    });
}

function getDoctorAddress(termin) {
    const entries = getAppointmentContactEntries(termin, 'doctor', 'address');
    const findValue = pattern => entries.find(entry => pattern.test(normalizeAppointmentColumnName(entry.key)))?.value || '';
    const street = findValue(/strasse|street|hausnummer|adresse|anschrift/);
    const postalCode = findValue(/plz|postleitzahl|postal|zip/);
    const city = findValue(/ort$|stadt$|city$/);
    const locality = [postalCode, city].filter(Boolean).join(' ');
    const formattedAddress = [street, locality].filter(Boolean).join(', ');
    return formattedAddress || entries.map(entry => entry.value).join(', ');
}

function getWhatsAppDataHint(termin) {
    const missing = [];
    if (getPatientAddressFields(termin).length === 0) missing.push('Patientenadresse');
    if (getAppointmentContactValues(termin, 'patient', 'phone').length === 0) missing.push('Patiententelefonnummer');
    if (!getDoctorAddress(termin)) missing.push('Arztadresse');
    if (getAppointmentContactValues(termin, 'doctor', 'phone').length === 0) missing.push('Arzttelefonnummer');
    const remark = parseAppointmentRemark(termin.Bemerkung);
    const remarkHint = [
        remark.companionName ? `Mögliche Begleitperson erkannt: ${remark.companionName}.` : '',
        remark.enteredBy ? 'Die letzte Bemerkungszeile wird als „Eingetragen von“ übernommen.' : ''
    ].filter(Boolean).join(' ');

    if (missing.length) {
        return `In der Datei fehlen eigene Spalten für: ${missing.join(', ')}. Die Dolmetscherin/der Dolmetscher wird aus der Spalte „Übersetzer“ übernommen. „Patienten Nr“ wird nicht als Telefonnummer verwendet. ${remarkHint}`.trim();
    }
    return `Adressen und Telefonnummern aus den Excel-Spalten sowie der Name aus „Übersetzer“ werden übernommen. Bitte prüfe Empfänger und Text vor dem Senden. ${remarkHint}`.trim();
}

function formatWhatsAppDate(value) {
    if (value === null || value === undefined || value === '') return '';

    const numericValue = typeof value === 'number'
        ? value
        : (/^\d+(?:\.\d+)?$/.test(String(value).trim()) ? Number(value) : NaN);
    if (Number.isFinite(numericValue) && numericValue >= 1 && numericValue < 100000) {
        const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(numericValue) * 86400000);
        return `${String(date.getUTCDate()).padStart(2, '0')}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.${date.getUTCFullYear()}`;
    }

    const text = String(value).trim();
    const germanDate = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/);
    if (germanDate) {
        const year = germanDate[3].length === 2 ? `20${germanDate[3]}` : germanDate[3];
        return `${germanDate[1].padStart(2, '0')}.${germanDate[2].padStart(2, '0')}.${year}`;
    }

    const isoDate = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (isoDate) return `${isoDate[3].padStart(2, '0')}.${isoDate[2].padStart(2, '0')}.${isoDate[1]}`;
    return text;
}

function formatWhatsAppTime(value) {
    if (value === null || value === undefined || value === '') return '';

    const numericValue = typeof value === 'number'
        ? value
        : (/^\d*\.\d+$/.test(String(value).trim()) ? Number(value) : NaN);
    if (Number.isFinite(numericValue) && numericValue >= 0 && numericValue < 1) {
        const totalMinutes = Math.round(numericValue * 24 * 60) % (24 * 60);
        return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`;
    }

    const text = String(value).trim();
    const time = text.match(/^(\d{1,2})[:.](\d{2})/);
    return time ? `${time[1].padStart(2, '0')}:${time[2]}` : text;
}

function getPatientRecordNumber(termin) {
    const preferredKeys = [
        'Aktennummer', 'Patienten_Aktennummer', 'Patient_Aktennummer',
        'Patient_Nr', 'Patienten Nr', 'Pat. Nr'
    ];
    for (const key of preferredKeys) {
        const value = termin?.[key];
        if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
    }

    const matchingKey = Object.keys(termin || {}).find(key => {
        const normalized = normalizeAppointmentColumnName(key);
        return /patient|pat/.test(normalized)
            && /aktennummer|aktenzeichen|patientennr|patientnr|patnr/.test(normalized)
            && !/name|vorname|geschlecht|status/.test(normalized);
    });
    return matchingKey ? String(termin[matchingKey] ?? '').trim() : '';
}

function parseAppointmentRemark(value) {
    const lines = String(value || '').split(/\r\n|\n|\r/).map(line => line.trim()).filter(Boolean);
    const enteredBy = lines.length ? lines.pop() : '';
    const nonNameTerms = new Set([
        'abholung', 'apotheke', 'arzt', 'bericht', 'fahrt', 'fahrdienst', 'kontrolle',
        'krankenhaus', 'lieferung', 'medikament', 'medikamente', 'op', 'operation',
        'optag', 'patient', 'patientin', 'praxis', 'station', 'tag', 'termin', 'vorbereitung'
    ]);

    let companionName = '';
    let companionLineIndex = -1;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const explicitCompanion = line.match(/^(?:begleitperson|begleitung)\s*:\s*(.+)$/iu);
        const candidate = (explicitCompanion?.[1] || line).trim();
        const words = candidate.split(/\s+/);
        const normalizedWords = words.map(normalizeAppointmentColumnName).filter(Boolean);
        const hasOperationalTerm = normalizedWords.some(word => nonNameTerms.has(word));
        const nameWordPattern = /^(?:\p{Lu}[\p{L}\p{M}'’.-]*|\p{Lo}[\p{L}\p{M}'’.-]*)$/u;
        const looksLikeName = words.length > 0
            && words.length <= 4
            && words.every(word => nameWordPattern.test(word))
            && !hasOperationalTerm;

        if (explicitCompanion || looksLikeName) {
            companionName = candidate;
            companionLineIndex = index;
            break;
        }
    }

    return {
        companionName,
        enteredBy,
        noteLines: lines.filter((_, index) => index !== companionLineIndex)
    };
}

function createWhatsAppAppointmentMessage(termin, includeNote) {
    const interpreter = String(termin.Übersetzer || '').trim().replace(/[\r\n]+/g, ' ');
    const patientName = [termin['Patienten Nr::Patienten_Vorname'], termin['Patienten Nr::Patienten_Name']]
        .map(value => String(value || '').trim())
        .filter(Boolean)
        .join(' ');
    const patientRecordNumber = getPatientRecordNumber(termin);
    const remark = parseAppointmentRemark(termin.Bemerkung);
    const isCompanionAppointment = Boolean(remark.companionName);
    const doctorName = String(termin['Arzt Nr::Name'] || '').trim();
    const appointmentLocation = String(termin['Arzt Nr::Vorname'] || '').trim();
    const patientAddressFields = getPatientAddressFields(termin).map(([label, value]) => [
        isCompanionAppointment ? `${label} (Hauptpatient)` : label,
        value
    ]);
    const patientPhone = getAppointmentContactValues(termin, 'patient', 'phone').join(' / ');
    const doctorAddress = getDoctorAddress(termin);
    const doctorPhone = getAppointmentContactValues(termin, 'doctor', 'phone').join(' / ');
    const sections = [
        {
            title: 'PATIENTENAKTE',
            fields: [
                [isCompanionAppointment ? 'Hauptpatient/in' : 'Patient/in', patientName],
                ['Aktennummer', patientRecordNumber],
                ...(isCompanionAppointment ? [['Begleitperson', remark.companionName]] : [])
            ]
        },
        ...(isCompanionAppointment
            ? [{ title: 'BITTE BEACHTEN', fields: [['', `Der Termin ist für die Begleitperson ${remark.companionName} des oben genannten Hauptpatienten. Die Aktennummer gehört zum Hauptpatienten.`]] }]
            : []),
        {
            title: 'TERMIN',
            fields: [
                ['Datum', formatWhatsAppDate(termin.Termin_Datum)],
                ['Uhrzeit', formatWhatsAppTime(termin.Termin_Uhrzeit)]
            ]
        },
        {
            title: 'PATIENTENKONTAKT',
            fields: [
                ...patientAddressFields,
                [isCompanionAppointment ? 'Telefon Hauptpatient' : 'Telefon', patientPhone]
            ]
        },
        {
            title: 'ARZT / PRAXIS',
            fields: [
                ['Name', doctorName],
                ['Ort', appointmentLocation],
                ['Adresse', doctorAddress],
                ['Telefon', doctorPhone]
            ]
        },
        ...(includeNote && remark.noteLines.length
            ? [{ title: 'WEITERE HINWEISE', fields: remark.noteLines.map(line => ['', line]) }]
            : []),
        ...(includeNote && remark.enteredBy
            ? [{ title: 'TERMIN ERFASST VON', fields: [['Mitarbeiter/in', remark.enteredBy]] }]
            : [])
    ].map(section => ({
        ...section,
        fields: section.fields.filter(([, value]) => value)
    })).filter(section => section.fields.length > 0);

    const details = sections.flatMap(section => [
        `*${section.title}*`,
        ...section.fields.map(([label, value]) => label ? `${label}: ${value}` : String(value)),
        ''
    ]);

    return [
        '*TERMININFORMATIONEN*',
        '',
        interpreter ? `Guten Tag ${interpreter},` : 'Guten Tag,',
        '',
        'bitte übernimm folgenden Dolmetschauftrag:',
        '',
        ...details,
        'Bitte bestätige kurz den Erhalt des Auftrags. Vielen Dank.'
    ].join('\n').trim();
}

function updateWhatsAppMessagePreview() {
    const index = activeWhatsAppAppointmentIndex;
    const termin = Number.isInteger(index) ? trackingData[index] : null;
    if (!termin) return;

    document.getElementById('whatsappMessage').value = createWhatsAppAppointmentMessage(
        termin,
        document.getElementById('includeWhatsAppNote').checked
    );
    document.getElementById('whatsappDataHint').textContent = getWhatsAppDataHint(termin);
    document.getElementById('whatsappCopyStatus').textContent = '';
}

function openWhatsAppModal(index) {
    const termin = trackingData[index];
    if (!termin) return;

    const interpreter = String(termin.Übersetzer || '').trim();
    if (!interpreter) {
        alert('Bitte trage zuerst in der Spalte „Übersetzer“ den Namen ein.');
        return;
    }

    activeWhatsAppAppointmentIndex = index;
    document.getElementById('whatsappRecipient').textContent = `Empfänger laut Terminplan: ${interpreter}. Wähle in WhatsApp Web denselben Namen aus.`;
    document.getElementById('includeWhatsAppNote').checked = true;
    updateWhatsAppMessagePreview();

    const modal = document.getElementById('whatsappModal');
    modal.style.display = 'block';
    modal.setAttribute('aria-hidden', 'false');
    document.getElementById('whatsappMessage').focus();
}

function closeWhatsAppModal() {
    const modal = document.getElementById('whatsappModal');
    modal.style.display = 'none';
    modal.setAttribute('aria-hidden', 'true');
    activeWhatsAppAppointmentIndex = null;
}

document.getElementById('includeWhatsAppNote').addEventListener('change', updateWhatsAppMessagePreview);
document.getElementById('closeWhatsAppModal').addEventListener('click', closeWhatsAppModal);
document.getElementById('cancelWhatsAppButton').addEventListener('click', closeWhatsAppModal);
document.getElementById('copyWhatsAppMessageButton').addEventListener('click', async () => {
    const textarea = document.getElementById('whatsappMessage');
    const status = document.getElementById('whatsappCopyStatus');
    try {
        await navigator.clipboard.writeText(textarea.value);
        status.textContent = 'Nachricht kopiert. Füge sie in WhatsApp mit Strg+V ein.';
    } catch (error) {
        textarea.focus();
        textarea.select();
        const copied = document.execCommand('copy');
        status.textContent = copied
            ? 'Nachricht kopiert. Füge sie in WhatsApp mit Strg+V ein.'
            : 'Kopieren nicht möglich. Markiere den Text und drücke Strg+C.';
    }
});
document.getElementById('whatsappModal').addEventListener('click', event => {
    if (event.target.id === 'whatsappModal') closeWhatsAppModal();
});
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('whatsappModal').style.display === 'block') {
        closeWhatsAppModal();
    }
});
document.getElementById('openWhatsAppButton').addEventListener('click', () => {
    const message = document.getElementById('whatsappMessage').value.trim();
    if (!message) {
        alert('Bitte gib einen Nachrichtentext ein.');
        document.getElementById('whatsappMessage').focus();
        return;
    }

    // WhatsApps Click-to-Chat erwartet URL-kodierten UTF-8-Text. encodeURIComponent
    // kodiert auch Leerzeichen explizit als %20 und erhält Sonderzeichen/Umlaute.
    const whatsappUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
    // Reuse the WhatsApp tab opened from this app on later messages.
    const whatsappWindow = window.open(whatsappUrl, 'terminToolWhatsApp');
    if (whatsappWindow) whatsappWindow.focus();
    closeWhatsAppModal();
});


function updateTimeCell(event, index) {
    const newValue = event.target.innerText; // Get the new value from the cell

    // Validierung des neuen Wertes im Format HH:MM:SS
    if (!/^\d{2}:\d{2}:\d{2}$/.test(newValue)) {
        alert("Bitte eine gültige Uhrzeit im Format HH:MM:SS eingeben.");
        return;
    }

    // Update der Daten im Array
    if (trackingData && trackingData[index]) {
        trackingData[index].Termin_Uhrzeit = normalizeTerminUhrzeit(newValue); // Normalize edited time
    } else {
        console.error('trackingData array is not defined or index is out of bounds');
    }

    // Sortieren der Daten
    sortTrackingDataByTime(trackingData);

    // Tabelle neu rendern
    renderTrackingTable(trackingData);
    persistTerminRecords(trackingData, 'tracking');
}



// Funktion zum Löschen einer Zeile
function deleteRow(event) {
    const index = event.target.dataset.index;

    // Bestätigungsdialog
    if (confirm('Sind Sie sicher, dass Sie diese Zeile löschen möchten?')) {
        // Zeile aus der Datenstruktur entfernen
        trackingData.splice(index, 1);

    // Zähle die Anzahl der Termine und aktualisiere die Anzahl_Termine-Spalte
    updateAnzahlTermine(trackingData);
	
        // Tabelle neu rendern
        renderTrackingTable(trackingData);
        persistTerminRecords(trackingData, 'tracking');
    }
}

function formatTime(date) {
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${hours}:${minutes}:${seconds}`;
}

function updateCell(event, index, fieldName) {
    const newValue = event.target.innerText; // Get the new value from the cell

    // Check if the data array is valid
    if (trackingData && trackingData[index]) {
        trackingData[index][fieldName] = newValue; // Update the entry in the data array
        persistTerminRecords(trackingData, 'tracking');
    } else {
        console.error('trackingData array is not defined or index is out of bounds');
    }

    // Optionally save changes to backend
}

// Update status from select dropdown
function updateStatusFromSelect(event) {
    const index = event.target.dataset.index;
    trackingData[index].Status = event.target.value;

    const tableBody = document.getElementById('tableBody');
    const row = tableBody.querySelectorAll('tr')[index];

    // Update row background color based on the new status

    if (isAppointmentStartingSoonOrOngoing(trackingData[index]) && trackingData[index].Status === "offen") {
        row.style.backgroundColor = '#cce5ff'; // Highlight rows that are starting soon with a light blue color
    } else if (trackingData[index].Status === "beendet" || trackingData[index].Status === "alleine") {
        row.style.backgroundColor = '#ddffdd'; // Green for completed
    } else if (trackingData[index].Status === "storniert") {
        row.style.backgroundColor = '#ffdddd'; // Red for canceled
    } else if (trackingData[index].Status === "losgefahren") {
        row.style.backgroundColor = '#ffffcc'; // Yellow for departed
    } else {
        row.style.backgroundColor = ''; // Reset to default
    }
    persistTerminRecords(trackingData, 'tracking');
}

// Funktion zur Überprüfung, ob ein Termin in Kürze beginnt oder an diesem Tag noch stattfindet
function isAppointmentStartingSoonOrOngoing(termin) {
    const now = new Date();

    // Datumsformat anpassen (TT.MM.JJJJ -> JJJJ-MM-TT)
    const dateMatch = normalizeTerminDatum(termin?.Termin_Datum).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!dateMatch) return false;
    const [, day, month, year] = dateMatch;
    const time = normalizeTerminUhrzeit(termin?.Termin_Uhrzeit);
    if (!time) return false;

    // Füge führende Nullen hinzu, falls erforderlich
    const formattedDate = `${year}-${month}-${day}T${time}`;

    // Startzeit berechnen
    const startDateTime = new Date(formattedDate);

    // Ende des Tages berechnen (23:59:59 des gleichen Datums)
    const endOfDay = new Date(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T23:59:59`);

    // Eine Stunde vor Beginn des Termins berechnen
    const oneHourBeforeStart = new Date(startDateTime.getTime() - 60 * 60 * 1000); // Eine Stunde vorher

    // Überprüfen, ob 'now' zwischen einer Stunde vor 'startDateTime' und 'endOfDay' liegt
    return now >= oneHourBeforeStart;
}

// Workbook mit aktualisierten Daten aktualisieren
function updateWorkbook() {
    const newWorkbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(trackingData);
    XLSX.utils.book_append_sheet(newWorkbook, worksheet, 'Tracking');
    workbook = newWorkbook;
}

// Funktion zum Speichern und Herunterladen der aktualisierten Excel-Datei
function saveAndDownloadExcel() {
    updateWorkbook();
    persistTerminRecords(trackingData, 'tracking');

    const excelData = XLSX.write(workbook, {
        bookType: 'xlsx',
        type: 'array'
    });
    const blob = new Blob([excelData], {
        type: 'application/octet-stream'
    });

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);

    // Find the first non-empty 'Termin_Datum'
    let firstTerminDatum = 'unbekannt';
    for (let i = 0; i < trackingData.length; i++) {
        if (trackingData[i]['Termin_Datum']) {
            firstTerminDatum = trackingData[i]['Termin_Datum'];
            break;
        }
    }

    // Ensure firstTerminDatum is treated as a string
    firstTerminDatum = firstTerminDatum ? firstTerminDatum : 'unbekannt';

    link.download = `${firstTerminDatum}_Tracking.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

// Event-Listener für den "Änderungen speichern" Button
document.getElementById('saveChanges').addEventListener('click', saveAndDownloadExcel);

document.getElementById('savePdfButton').addEventListener('click', () => {
    // Access jsPDF from the global scope
    const {
        jsPDF
    } = window.jspdf;
    const doc = new jsPDF('landscape');

    // Set up the table headers
    const headers = [["Datum", "Start", "Pat. Nr", "Patient", "Geschlecht", "Bemerkung", "Arzt", "Ort", "Übersetzer", "Anzahl Termine", "Status"]];
    const rows = trackingData.map(termin => {
        let endTimeFormatted = ''; // Initialize as empty

        if (termin.Termin_Uhrzeit) {
            const startTime = new Date(`1970-01-01T${termin.Termin_Uhrzeit}`);
            const durationMinutes = termin.Dauer * 60; // Assuming Dauer is in hours
            const endTime = new Date(startTime.getTime() + durationMinutes * 60000); // Calculate end time
            endTimeFormatted = formatTimePdf(`${endTime.getHours()}:${endTime.getMinutes()}:${endTime.getSeconds()}`); // Format end time
        }

        // Clean up the Bemerkung field by removing extra line breaks
        const bemerkung = termin['Bemerkung']
             ? termin['Bemerkung'].replace(/(\r\n|\n|\r)+/g, ' ').trim()
             : ''; // Replace line breaks with a space

        return [
            termin.Termin_Datum,
            termin.Termin_Uhrzeit ? formatTimePdf(termin.Termin_Uhrzeit) : '', // Check if Termin_Uhrzeit is empty, if not, format it
			termin.Patient_Nr,
            termin['Patienten Nr::Patienten_Vorname'] + ' ' + termin['Patienten Nr::Patienten_Name'],
			termin['Patienten Nr::Patienten_Geschlecht'] ? termin['Patienten Nr::Patienten_Geschlecht'].charAt(0) : '',
            bemerkung,
            termin['Arzt Nr::Name']? termin['Arzt Nr::Name'] : '',
            termin['Arzt Nr::Vorname'],
            termin.Übersetzer,
            termin.Anzahl_Termine,
            termin.Status
        ];
    });

    // Generate the PDF table
    doc.autoTable({
        head: headers,
        body: rows
    });

    // Find the first non-empty 'Termin_Datum'
    let firstTerminDatum = 'unbekannt';
    for (let i = 0; i < trackingData.length; i++) {
        if (trackingData[i]['Termin_Datum']) {
            firstTerminDatum = trackingData[i]['Termin_Datum'];
            break;
        }
    }

    // Ensure firstTerminDatum is treated as a string
    firstTerminDatum = firstTerminDatum ? firstTerminDatum : 'unbekannt';

    // Save the PDF
    doc.save(`${firstTerminDatum}_Tracking.pdf`);

});

function formatTimePdf(timeString) {
    // Check if timeString is a valid string
    if (typeof timeString !== 'string') {
        console.error('Invalid input to formatTime:', timeString);
        return '00:00:00'; // Default to zero if format is invalid
    }

    // Trim whitespace
    timeString = timeString.trim();

    // Extract just the time part (hh:mm:ss)
    const timeOnly = timeString.split(' ')[0]; // Get the first part before the timezone info

    // Check if the timeOnly is in the correct format
    const timeParts = timeOnly.split(':');

    if (timeParts.length !== 3) { // Should have hours, minutes, and seconds
        console.error('Invalid time format:', timeOnly);
        return '00:00:00'; // Default to zero if format is invalid
    }

    // Ensure each part is two digits
    const [hours, minutes, seconds] = timeParts.map(part => String(part).padStart(2, '0'));

    return `${hours}:${minutes}:${seconds}`; // Return formatted time string
}


// Funktion zum Öffnen/Schließen des Modals
function toggleAddRowModal() {
    const modal = document.getElementById('addRowModal');
    modal.style.display = modal.style.display === 'block' ? 'none' : 'block';
}

  // Event-Listener für den Hinzufügen-Button
  document.getElementById('addRowButton').addEventListener('click', () => {
    toggleAddRowModal();
  });

// Event-Listener für den "Hinzufügen"-Button
document.getElementById('confirmAddRowButton').addEventListener('click', () => {
    if (trackingData.length === 0) {
        alert('Bitte lade zuerst eine Terminliste hoch oder gehe über die vorherigen Schritte hierher.');
        return;
    }

    const requiredFields = {
        'terminUhrzeit': 'Startzeit',
        'patientNr': 'Patienten-Nr.',
        'patientGeschlecht': 'Geschlecht',
        'patientName': 'Nachname',
        'patientVorname': 'Vorname'
    };

    for (const [field, label] of Object.entries(requiredFields)) {
        if (!document.getElementById(field).value) {
            alert(`Bitte fülle das Pflichtfeld „${label}“ aus.`);
            return;
        }
    }

    // Datum des aktuellen Tagesplans übernehmen.
    let firstTerminDatum = 'unbekannt';
    for (let i = 0; i < trackingData.length; i++) {
        if (trackingData[i]['Termin_Datum']) {
            firstTerminDatum = trackingData[i]['Termin_Datum'];
            break;
        }
    }

    // Ensure firstTerminDatum is treated as a string
    firstTerminDatum = firstTerminDatum ? firstTerminDatum : 'unbekannt';

    // Die bestehende Excel-Spaltenstruktur erhalten, ohne Daten eines anderen
    // Patienten in die neue Zeile zu kopieren.
    const newRow = Object.fromEntries(Object.keys(trackingData[0]).map(header => [header, '']));
    Object.assign(newRow, {
        "Termin_Datum": firstTerminDatum,
        "Termin_Uhrzeit": formatTimeToHHMMSS(document.getElementById('terminUhrzeit').value),
        "Patient_Nr": parseInt(document.getElementById('patientNr').value,10),
        "Patienten Nr::Patienten_Name": document.getElementById('patientName').value,
        "Arzt_Nr": '',
        "Arzt Nr::Name": document.getElementById('arztName').value,
        "Bemerkung": document.getElementById('bemerkung').value,
        "Kostengarantie Ja Nein": '',
        "Patienten Nr::Patienten_Geschlecht": document.getElementById('patientGeschlecht').value,
        "Patienten Nr::Patienten_Status": '',
        "Patienten Nr::Patienten_Vorname": document.getElementById('patientVorname').value,
        "Arzt Nr::Vorname": document.getElementById('arztVorname').value,
        "Übersetzer": document.getElementById('uebersetzer').value,
		"Status": 'offen'
    });
    if (Object.prototype.hasOwnProperty.call(trackingData[0], 'Dauer')) newRow.Dauer = '2';

    // Füge die neue Zeile zu trackingData hinzu
    trackingData.push(newRow);

    // Zähle die Anzahl der Termine und aktualisiere die Anzahl_Termine-Spalte
    updateAnzahlTermine(trackingData);


    // Sortiere die trackingData nach Uhrzeit
    trackingData = sortTrackingDataByTime(trackingData);

    // Tabelle neu rendern
    renderTrackingTable(trackingData);

    persistTerminRecords(trackingData, 'tracking');
	
	// Leere die Eingabefelder im Modal
    document.getElementById('addRowForm').reset();

    // Schließe das Modal nach dem Hinzufügen
    toggleAddRowModal();
});


// Funktion zum Umwandeln des Datums in d.m.yyyy-Format
function formatDateToDMYYYY(dateString) {
    // Datum im ISO-Format (yyyy-mm-dd) wird aus dem Eingabefeld erhalten
    const date = new Date(dateString);

    // Überprüfen, ob das Datum gültig ist
    if (isNaN(date.getTime())) {
        return ''; // Rückgabe eines leeren Strings, wenn das Datum ungültig ist
    }

    // Datumsteile extrahieren
    const day = date.getDate();  // Tag ohne führende Null
    const month = date.getMonth() + 1;  // Monat (0-indexiert) ohne führende Null
    const year = date.getFullYear();  // Jahr

    // Rückgabe des formatierten Datums
    return `${day}.${month}.${year}`;
}

// Funktion zum Umwandeln der Uhrzeit in hh:mm:ss-Format
function formatTimeToHHMMSS(timeString) {
    // Der Wert ist im Format hh:mm, wir fügen die Sekunden hinzu
    return `${timeString}:00`; // Anhängen von ":00" für die Sekunden
}

function restoreTrackingWorkflow() {
    const savedRecords = readTerminRecords();
    if (!savedRecords || savedRecords.length === 0) return;

    trackingData = normalizeTerminRecords(savedRecords.map(row => ({ Status: 'offen', ...row })));
    renderTrackingTable(trackingData);
    showWorkflowStatus(`${trackingData.length} Termine aus dem vorherigen Schritt geladen. Änderungen werden automatisch zwischengespeichert.`);
    startTrackingRefresh();
}

restoreTrackingWorkflow();


function sortTrackingDataByTime(data) {
    return data.sort((a, b) => {
        return compareTerminUhrzeit(a.Termin_Uhrzeit, b.Termin_Uhrzeit);
    });
}



function updateAnzahlTermine(data) {
    const countMap = data.reduce((acc, entry) => {
        acc[entry.Patient_Nr] = (acc[entry.Patient_Nr] || 0) + 1;
        return acc;
    }, {});

    // Aktualisieren der Anzahl der Termine für jeden Eintrag in trackingData
    data.forEach(entry => {
        entry.Anzahl_Termine = countMap[entry.Patient_Nr] || 0;
    });
}
