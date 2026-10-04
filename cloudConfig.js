// Verbindung zur Online-Datenbank (Supabase, Region Frankfurt).
// Der "publishable key" ist für den Browser gedacht und darf öffentlich sein –
// den Zugriff regeln die Row-Level-Security-Regeln in supabase/schema.sql.
// Den "secret key" oder das Datenbank-Passwort niemals hier eintragen.
window.TERMIN_CLOUD_CONFIG = {
    url: 'https://dvjfvbrvhurlagmgprsp.supabase.co',
    publishableKey: 'sb_publishable_bw7aJIwh_FxsCGxxyROIbg_4BG9kM0o',
    // Öffentliche Adresse des Portals (GitHub Pages). Wird als Link für die Dolmetscher angezeigt,
    // wenn die App lokal auf dem PC läuft.
    portalUrl: 'https://masudtaher.github.io/Termin-Tool/portal.html',
    // Auswahllisten im Portal – hier lassen sich Begriffe ändern oder ergänzen.
    parkingOptions: ['Links', 'Links/Rechts', 'Links/Rechts weit', 'Rechts', 'Büro'],
    // Schadensarten für die Schadenmeldung (kurz halten – „Sonstiges“ fängt den Rest auf).
    damageKinds: ['Kratzer', 'Schramme', 'Delle', 'Steinschlag', 'Unfall mit Bericht', 'Unfall ohne Bericht', 'Schiebetür defekt', 'Felge / Reifen', 'Sonstiges'],
    // Unterlagen, die Dolmetscher nach einem Termin fotografieren und als PDF schicken.
    documentKinds: ['Arztbericht', 'Rezept Medikamente', 'Rezept Physiotherapie', 'Rezept Hilfsmittel', 'Überweisung Facharzt', 'Überweisung Radiologie', 'Sonstiges'],
    alertKinds: ['Reifendruck', 'AdBlue nachfüllen', 'Serviceanzeige', 'Ölstand', 'Motorkontrollleuchte', 'Wischwasser', 'Sonstiges'],
    fuelLabels: ['Leer', '1/4', '1/2', '3/4', 'Voll'],
    // Arbeitszeit der Festangestellten – alles davor oder danach zählt als Überstunden.
    workStart: '09:00',
    workEnd: '16:00',
    // Speicherplatz des Supabase-Tarifs für die Anzeige unten links (in MB).
    // Kostenloser Tarif: 500 MB Datenbank, 1 GB Fotos.  Pro-Tarif: 8000 MB Datenbank, 100000 MB Fotos.
    storageLimits: { databaseMb: 500, photosMb: 1024 },
    // Name der Server-Funktion für Mitteilungen aufs Handy und „Passwort neu vergeben“.
    pushFunction: 'tt-push'
};
