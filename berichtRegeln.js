// Berichtsregeln (R94): Zu welchen Terminen schreibt der Dolmetscher KEINEN Bericht?
// Gilt überall gleich – in der Kontrolle (Büro), in der Dolmetscher-App („Bericht über Termin“, „Berichte schreiben“ auf der Startseite).
// Erkannt am Titel des Auftrags, am Arzt/Praxis-Namen und an der Fachrichtung im Auftrag sowie an den Feldern des Tagesplans –
// nicht an der Bemerkung (dort steht „KG“ für Kostengarantie, und „Rezept Physiotherapie“ in einem Hinweis wäre ein Fehlalarm).
// Neue Begriffe einfach in die Liste aufnehmen (Groß-/Kleinschreibung egal).
(function () {
    const WORDS = [
        'physiotherap', 'physio\\b', 'krankengymnast', 'visite', 'ergotherap', 'lo[gk]op[äa]e?d',                       // Therapie und Visiten
        'novum\\s*(2|ii)\\b', 'novum\\b', 'uni[\\s-]?reha',                                                                 // Einrichtungen ohne Bericht
        'visum', 'visa\\b', 'visa-?verl', 'aufenthaltstitel', 'aufenthaltserlaubnis',                                        // Visum, Visa-Verlängerung
        '\\bbank\\b', 'commerzbank', 'sparkasse', 'volksbank',                                                              // Bank
        'flughafen', 'airport', 'bahnhof', 'abfl[uü]g', 'ank[uü]nft', '\\bfl[uü]g\\b', 'transport', 'transfer', 'abholung', 'abholen', 'hinfahrt', 'r[üu]e?ckfahrt', 'fahrdienst', 'nur fahr',   // Transport
        'beh[öo]e?rde', 'ausl[äa]e?nderamt', 'rathaus', 'b[üu]e?rgeramt', 'konsulat', 'botschaft', 'einwohnermelde',       // Behörden
        '\\bhotel\\b', 'wohnung', 'einkauf', 'umzug', 'umz[üu]e?ge',                                                        // Hotel, Wohnung, Einkauf, Umzug
        'apothek', 'theaterpassage', 'optiker', 'fielmann', 'apollo', 'brille',                                             // Apotheke, Theaterpassage, Optiker
        'mercedes', 'autohaus', 'automobil', 'werkstatt', '\\batu\\b', 't[üu]e?v\\b'                                        // Auto (Mercedes-Benz, Werkstatt)
    ];
    const NO_REPORT = new RegExp(WORDS.join('|'), 'i');
    // Die Stellen im Auftragstext, an denen die Terminart steht.
    const messageParts = message => {
        const text = String(message || '');
        return [(text.match(/^Name:\s*(.+)$/m) || [])[1], (text.match(/^Fachrichtung:\s*(.+)$/m) || [])[1], (text.match(/^\*?Ort:\s*(.+?)\*?$/m) || [])[1]];
    };
    // assignment: Auftrag (tt_assignments) – record: passender Termin aus dem Tagesplan (optional).
    const noReportExpected = (assignment, record) => {
        const row = record || {};
        return [assignment?.title, ...messageParts(assignment?.message), row['Arzt Nr::Name'], row['Arzt / Abteilung'], row['Wofür'], row['Arzt Nr::Fachrichtung'], row.Fachrichtung]
            .some(value => NO_REPORT.test(String(value || '')));
    };
    window.BerichtRegeln = { NO_REPORT, noReportExpected, words: WORDS };
})();
