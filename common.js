// Gemeinsame Hilfsfunktionen für alle drei Seiten.
// Wird in jeder Seite VOR der jeweiligen *App.js eingebunden. Die Funktionen sind bewusst global,
// weil die Seiten klassische Skripte ohne Module verwenden.

// Sidebar ein-/ausblenden (Button "☰" oben links)
(function initSidebarToggle() {
    const sidebar = document.getElementById('sidebar');
    const container = document.getElementById('container');

    document.getElementById('toggleSidebar').addEventListener('click', () => {
        sidebar.classList.toggle('active');
        container.classList.toggle('expanded');
    });
})();

// Liest eine Excel-Datei ein und übergibt das erste Tabellenblatt an den Callback
function leseErstesTabellenblatt(file, onSheetGeladen) {
    const reader = new FileReader();
    reader.onload = (event) => {
        const data = new Uint8Array(event.target.result);
        const workbook = XLSX.read(data, {
            type: 'array'
        });
        onSheetGeladen(workbook.Sheets[workbook.SheetNames[0]]);
    };
    reader.readAsArrayBuffer(file);
}

// Tabellen- und Aktionsbereich sind per CSS standardmäßig ausgeblendet und werden erst mit Daten angezeigt
function setzeSektionenSichtbar(sichtbar) {
    document.querySelector('.tables-section').style.display = sichtbar ? 'flex' : 'none';
    document.querySelector('.action-section').style.display = sichtbar ? 'block' : 'none';
}

// Der erste nicht leere 'Termin_Datum'-Wert (in der aktuellen Reihenfolge der Daten) bestimmt den Dateinamen
function findeErstesTerminDatum(data) {
    const termin = data.find(row => row['Termin_Datum']);
    return termin ? termin['Termin_Datum'] : 'unbekannt';
}

// Zählt die Termine pro Patient_Nr (Grundlage für 'Anzahl_Termine')
function zaehleTermineProPatient(data) {
    return data.reduce((acc, entry) => {
        acc[entry.Patient_Nr] = (acc[entry.Patient_Nr] || 0) + 1;
        return acc;
    }, {});
}

// Normalisiert eine Uhrzeit "H:m:s" auf "HH:mm:ss" (für den PDF-Export)
function formatTime(timeString) {
    if (typeof timeString !== 'string') {
        console.error('Invalid input to formatTime:', timeString);
        return '00:00:00';
    }

    // Nur den Zeitanteil vor einer eventuellen Zeitzonenangabe verwenden
    const timeOnly = timeString.trim().split(' ')[0];
    const timeParts = timeOnly.split(':');

    if (timeParts.length !== 3) {
        console.error('Invalid time format:', timeOnly);
        return '00:00:00';
    }

    const [hours, minutes, seconds] = timeParts.map(part => String(part).padStart(2, '0'));
    return `${hours}:${minutes}:${seconds}`;
}

// Zeilenumbrüche in der Bemerkung stören das PDF-Layout und werden durch Leerzeichen ersetzt
function bereinigeBemerkung(bemerkung) {
    return bemerkung ? bemerkung.replace(/(\r\n|\n|\r)+/g, ' ').trim() : '';
}
