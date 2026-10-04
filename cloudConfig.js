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
    parkingOptions: ['Rechts', 'Links', 'Rechts weit', 'Links weit', 'Botschaft'],
    alertKinds: ['Reifendruck', 'AdBlue nachfüllen', 'Serviceanzeige', 'Ölstand', 'Motorkontrollleuchte', 'Wischwasser', 'Sonstiges'],
    fuelLabels: ['Leer', '1/4', '1/2', '3/4', 'Voll']
};
