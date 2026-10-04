# WhatsApp-Tab im Termin-Tool wiederverwenden

Die normale Webseite darf aus Sicherheitsgründen keinen anderen geöffneten Browser-Tab suchen oder steuern. Diese kleine Chrome-Erweiterung übernimmt genau diese Aufgabe: Beim Klick auf **„Im WhatsApp-Web-Tab öffnen“** verwendet sie einen bereits geöffneten Tab von WhatsApp Web. Gibt es keinen, öffnet sie WhatsApp Web in einem neuen Tab.

Die Erweiterung kann nur auf die Termin-Tool-Seite und WhatsApp Web zugreifen. Sie liest keine Nachrichten und sendet nichts selbst. Sie darf außerdem das Chrome-Fenster mit WhatsApp Web nach vorne holen. Empfänger auswählen, Nachricht prüfen und auf **„Senden“** klicken bleibt bei dir.

## Einmalige Einrichtung in Chrome

1. Den Ordner `chrome-extension` auf deinem PC speichern. Er muss entpackt bleiben.
2. In Chrome `chrome://extensions` in die Adresszeile eingeben und öffnen.
3. Oben rechts **Entwicklermodus** einschalten.
4. Auf **Entpackte Erweiterung laden** klicken.
5. Den gespeicherten Ordner `chrome-extension` auswählen (den Ordner mit `manifest.json`).
6. Die Seite des Termin-Tools neu laden (GitHub-Seite oder lokal gestartet über `start-local-app.bat`). Nach einem Update der Erweiterung in `chrome://extensions` einmal auf **Neu laden** klicken.
7. WhatsApp Web öffnen und angemeldet lassen. Danach im Live-Tracking auf **WhatsApp** und anschließend **Im WhatsApp-Web-Tab öffnen** klicken.

Falls Chrome auf dem Arbeits-PC das Laden von Erweiterungen durch eine Richtlinie blockiert, kann die IT die Erweiterung freigeben. Bis dahin funktionieren **Nachricht kopieren** und Einfügen im geöffneten WhatsApp-Tab weiterhin.
