# Mitteilungen aufs Handy und „Passwort neu vergeben“ einrichten

Dauer: etwa 5 Minuten, einmalig. Danach funktionieren:

- Mitteilungen aufs Handy der Dolmetscher (neuer Auftrag, Nachricht, Erinnerung „Fahrzeug zurückgeben“ nach 16 Uhr)
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
5. Danach in der Funktion auf **Details** (oder **Settings**) gehen und **„Verify JWT with legacy secret“ ausschalten** → speichern.
   Die Funktion prüft die Anmeldung selbst.

## Schritt 3 – Automatische Erinnerung nach 16 Uhr

1. Supabase → **SQL Editor**.
2. Den Inhalt der Datei `update-8b-erinnerung.sql` einfügen → **Run**.

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
