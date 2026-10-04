# Mitteilungen aufs Handy und „Passwort neu vergeben“ einrichten

Dauer: etwa 5 Minuten, einmalig. Danach funktionieren:

- Mitteilungen aufs Handy der Dolmetscher (neuer Auftrag, Nachricht, Erinnerung „Fahrzeug zurückgeben“ nach 16 Uhr,
  Erinnerung „Auftrag noch nicht beendet“ nach 4 Stunden und danach alle 2 Stunden)
- Mitteilungen an Einsatzleitung und Sekretariat („Dolmetscher losgefahren“, „Dolmetscher wieder frei“) –
  einschalten auf der Übersicht unter „Mitteilungen auf diesem Gerät“
- der Knopf „Neues Passwort“ auf der Seite „Team“

Ohne diese Einrichtung läuft die App ganz normal weiter – nur diese beiden Dinge fehlen dann.

## Schritt 1 – Datenbank aktualisieren

1. Supabase öffnen → links **SQL Editor**.
2. Den Inhalt der Datei `update-5-bis-8-zusammen.sql` einfügen → **Run**.
   (Falls Update 5 bis 7 schon gelaufen sind, reicht `update-8.sql`. Doppelt ausführen schadet nicht.)

## Schritt 2 – Server-Funktion anlegen

1. Supabase → links **Edge Functions** → **Deploy a new function** → **Via Editor**.
2. Name der Funktion: `tt-push` (genau so schreiben).
3. Den ganzen Text im Editor löschen und den Inhalt der Datei `functions/tt-push/index.ts` einfügen.
4. **Deploy function** klicken.
5. Fertig. Am Schalter „Verify JWT with legacy secret“ muss nichts geändert werden – die Funktion prüft die Anmeldung selbst und läuft in beiden Stellungen.

## Schritt 3 – Automatische Erinnerungen

1. Supabase → **SQL Editor**.
2. Den Inhalt der Datei `update-12.sql` einfügen → **Run**. Die Datenbank ruft die Funktion danach alle 10 Minuten auf;
   die Funktion entscheidet selbst, wer erinnert wird (Fahrzeug ab 16 Uhr einmal am Tag, offener Auftrag nach 4 Stunden
   und dann alle 2 Stunden, nachts zwischen 22 und 7 Uhr ist Ruhe).
   (`update-8b-erinnerung.sql` ist der alte Zeitplan und wird damit ersetzt.)
3. Nach jeder Änderung an `functions/tt-push/index.ts`: Supabase → **Edge Functions** → `tt-push` → **Code** →
   Text ersetzen → **Deploy updates**.

Falls dabei eine Meldung zu `pg_cron` oder `pg_net` kommt: Supabase → **Database** → **Extensions** → `pg_cron` und `pg_net` einschalten, dann Schritt 3 wiederholen.

## Schritt 4 – Prüfen

1. In der App die Seite **Team** öffnen.
2. Oben steht die Karte „Mitteilungen aufs Handy …“. Dort muss **„Eingerichtet“** stehen.

## Was die Dolmetscher tun

1. Portal als App auf das Handy legen (im Portal: Kreis oben rechts → „Als App auf das Handy legen“).
2. Im Portal: Kreis oben rechts → **Mitteilungen einschalten** → erlauben.

Hinweis iPhone: Mitteilungen gehen nur, wenn das Portal als App auf dem Home-Bildschirm liegt und von dort geöffnet wird (ab iOS 16.4).

## Sicherheit

- Es muss kein Passwort und kein geheimer Schlüssel kopiert werden.
- Den Schlüssel für die Mitteilungen erzeugt die Funktion beim ersten Aufruf selbst. Er liegt in einer gesperrten Tabelle, die niemand über die App lesen kann.
- Mitteilungen senden dürfen nur Einsatzleitung und Sekretariat; Passwörter neu vergeben darf nur der Admin.
