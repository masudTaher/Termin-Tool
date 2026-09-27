# Termin-Tool

Browserbasiertes Werkzeug zur Planung von Übersetzer-Einsätzen bei Patiententerminen.

Das Termin-Tool führt in drei Schritten von einem rohen Termin-Export (Excel) zu einer Einsatzplanung, die sich am Einsatztag live verfolgen lässt:

1. **Filtern:** relevante Termine automatisch vorsortieren
2. **Bearbeiten:** Übersetzer zuweisen und den Bedarf berechnen
3. **Tracking:** den Status der Termine am Einsatztag verfolgen

Die Anwendung läuft vollständig im Browser. Sie benötigt kein Backend, keine Installation und keinen Build-Schritt. Alle Daten bleiben lokal auf dem Rechner: Sie werden per Excel-Upload eingelesen und als Excel- bzw. PDF-Datei wieder heruntergeladen.

---

## Inhalt

- [Funktionen](#funktionen)
- [Schnellstart](#schnellstart)
- [Arbeitsablauf](#arbeitsablauf)
  - [1. Termine Filtern](#1-termine-filtern)
  - [2. Termine Bearbeiten](#2-termine-bearbeiten)
  - [3. Termine Tracking](#3-termine-tracking)
- [Datenformat](#datenformat)
- [Projektstruktur](#projektstruktur)
- [Technik](#technik)
- [Entwicklung](#entwicklung)
- [Bekannte Einschränkungen](#bekannte-einschränkungen)

---

## Funktionen

- **Automatische Vorfilterung** der Termine anhand von Orts- und Schlüsselwortregeln, einschließlich spezieller Regeln für Flughafentermine
- **Manuelle Korrektur per Drag & Drop** zwischen den Listen „Bleiben“ und „Entfernt“
- **Editierbare Tabelle** mit Geschlechtsauswahl, Übersetzerzuweisung und Uhrzeitprüfung
- **Farbliche Gruppierung** von Patienten mit mehreren Terminen
- **Berechnung der Mindestanzahl** benötigter männlicher und weiblicher Übersetzer
- **Live-Tracking** mit Status je Termin und automatischer Hervorhebung bald beginnender Termine
- **Export** jedes Schritts als Excel-Datei. Zuweisungen und Tracking lassen sich zusätzlich als PDF zum Ausdrucken speichern.

## Schnellstart

**Voraussetzungen:** ein aktueller Browser (Chrome, Edge, Firefox) und eine Internetverbindung, weil die Bibliotheken über CDN geladen werden.

**Variante A: direkt öffnen**

Öffnen Sie `index.html` im Browser. Die Seite leitet automatisch zu „Termine Filtern“ weiter.

**Variante B: über einen lokalen Webserver**

```bash
python -m http.server 8000
```

Rufen Sie danach <http://localhost:8000> auf.

Über die Schaltfläche **☰** oben links öffnen Sie die Navigation zwischen den drei Seiten.

## Arbeitsablauf

Die drei Seiten bilden eine Pipeline. Jeder Schritt erzeugt eine Excel-Datei, die im nächsten Schritt hochgeladen wird:

```
Termin-Export (.xlsx)
        │
        ▼
┌──────────────────┐   <Datum>_gefilterte_Termine.xlsx
│ Termine Filtern  │ ─────────────────────────────────┐
└──────────────────┘                                  │
                                                      ▼
┌──────────────────┐   <Datum>_Zuweisungen.xlsx   ┌─────────────────────┐
│ Termine Tracking │ ◄─────────────────────────── │ Termine Bearbeiten  │
└──────────────────┘                              └─────────────────────┘
        │
        ▼
<Datum>_Tracking.xlsx / .pdf
```

Der Dateiname beginnt jeweils mit dem ersten vorhandenen Termindatum der Datei.

### 1. Termine Filtern

Laden Sie den rohen Termin-Export hoch. Die Datei muss alle [erwarteten Spalten](#datenformat) enthalten, sonst erscheint eine Fehlermeldung mit den fehlenden Spalten.

Die Termine werden automatisch auf zwei Tabellen verteilt: **Bleiben** und **Entfernt**. Die Regeln werden in dieser Reihenfolge geprüft, und die erste zutreffende Regel entscheidet:

| # | Bedingung | Ergebnis |
|---|-----------|----------|
| 1 | Bemerkung enthält „Büro“ | Bleibt |
| 2 | Bemerkung enthält „Auftrag“ | Entfernt |
| 3 | Arzt ist ein Flughafentermin („Flughafen“, „Abflug“, „Ankunft“) und die Bemerkung enthält „nach Bonn“ / „nach Köln“ | Bleibt |
| 4 | Flughafentermin und die Bemerkung enthält „nach Heidelberg“, „nach Mannheim“, „nach Frankfurt“ oder „FTT“ | Entfernt |
| 5 | Flughafentermin und Arzt oder Ort enthält Köln, Bonn, Düsseldorf oder Frankfurt | Bleibt |
| 6 | Bemerkung oder Ort enthält einen Ort aus der Ortsliste (z. B. Bonn, Köln, Hennef, Troisdorf) als Teil des Textes | Bleibt |
| 7 | Bemerkung oder Ort enthält ein Schlüsselwort aus der Wortliste (z. B. „LM“, „Flughafen Düsseldorf“) als ganzes Wort | Bleibt |
| – | Keine Regel trifft zu | Entfernt |

Groß- und Kleinschreibung spielt keine Rolle. Die vollständigen Listen stehen am Anfang von `termineFilternApp.js`.

Einzelne Termine lassen sich per **Drag & Drop** zwischen den Tabellen verschieben. **Änderungen speichern** erzeugt eine Excel-Datei mit zwei Tabellenblättern („Gefilterte Termine“ und „Entfernte Termine“), jeweils nach Uhrzeit sortiert. Excel-Datum und -Uhrzeit werden dabei in lesbare Texte umgewandelt (`d.m.yyyy` bzw. `HH:mm:ss`).

### 2. Termine Bearbeiten

Laden Sie die Datei `<Datum>_gefilterte_Termine.xlsx` hoch. Verwendet wird das erste Tabellenblatt, also die Termine, die bleiben. Fehlen die Spalten **Übersetzer** und **Anzahl Termine**, werden sie ergänzt.

- **Anzeige:** Zuerst stehen Patienten mit genau einem Termin, danach Patienten mit mehreren Terminen. Diese sind nach Patient gruppiert und jeweils in einer eigenen Farbe hinterlegt.
- **Bearbeitung:** Bemerkung und Übersetzer lassen sich direkt in der Zelle bearbeiten. Das Geschlecht wählen Sie über ein Dropdown. Eine fehlende Uhrzeit kann im Format `HH:mm:ss` nachgetragen werden.
- **Min. Übersetzer ermitteln** berechnet, wie viele männliche und weibliche Übersetzer mindestens benötigt werden. Dabei gelten diese Regeln:
  - Übersetzer und Patient haben dasselbe Geschlecht. Ohne Angabe wird männlich angenommen.
  - Ein Übersetzer ist ab Terminbeginn **3 Stunden** gebunden.
  - Ein Übersetzer übernimmt höchstens **2 Termine**. **Physio-Termine** zählen nur **halb**.
  - Die Termine werden nach Uhrzeit dem jeweils ersten passenden freien Übersetzer zugeordnet.
- **Export:** Speichern Sie als Excel-Datei für den nächsten Schritt oder als PDF im Querformat zum Ausdrucken. Das PDF enthält eine zusätzliche leere Spalte „Notiz“. Beide Exporte sind nach Uhrzeit sortiert.

### 3. Termine Tracking

Laden Sie die Datei `<Datum>_Zuweisungen.xlsx` hoch. Termine ohne Status erhalten den Status **Offen**.

| Status | Zeilenfarbe |
|--------|-------------|
| Offen, Beginn in weniger als 1 Stunde | Hellblau |
| Beendet / Alleine | Grün |
| Storniert | Rot |
| Losgefahren | Gelb |
| Offen | Keine Hervorhebung |

- Die Hervorhebung wird alle 10 Sekunden anhand der aktuellen Uhrzeit aktualisiert.
- Uhrzeit und Übersetzer lassen sich direkt in der Tabelle ändern. Nach einer Änderung der Uhrzeit wird die Tabelle neu sortiert.
- **Neue Zeile hinzufügen** öffnet ein Formular für kurzfristige Termine. Pflichtfelder sind Uhrzeit, Patienten-Nr., Name und Vorname. Das Datum wird aus der geladenen Datei übernommen.
- **Löschen** entfernt einen Termin nach einer Rückfrage.
- Nach jedem Hinzufügen oder Löschen wird **Anzahl Termine** neu berechnet.
- **Export** als Excel-Datei oder als PDF.

## Datenformat

Der Termin-Export muss mindestens die folgenden Spalten enthalten. Die Spaltennamen sind Teil des Datenformats und werden in allen Schritten unverändert verwendet.

| Spalte | Bedeutung | Anzeige |
|--------|-----------|---------|
| `Termin_Datum` | Datum (im Export als Excel-Seriennummer) | Datum |
| `Termin_Uhrzeit` | Uhrzeit (im Export als Excel-Zeitwert) | Uhrzeit / Start |
| `Patient_Nr` | Patientennummer | Pat. Nr |
| `Patienten Nr::Patienten_Name` | Nachname | Patient |
| `Patienten Nr::Patienten_Vorname` | Vorname | Patient |
| `Patienten Nr::Patienten_Geschlecht` | z. B. `M : Männlich`, `F : Weiblich` | Geschlecht |
| `Patienten Nr::Patienten_Status` | Patientenstatus | – |
| `Arzt_Nr` | Arztnummer | – |
| `Arzt Nr::Name` | Arzt bzw. Einrichtung | Arzt |
| `Arzt Nr::Vorname` | **Ort** des Termins | Ort |
| `Bemerkung` | Freitext | Bemerkung |
| `Kostengarantie Ja Nein` | Kostengarantie | – |

In den späteren Schritten kommen diese Spalten hinzu:

| Spalte | Hinzugefügt in | Inhalt |
|--------|----------------|--------|
| `Übersetzer` | Bearbeiten | zugewiesener Übersetzer |
| `Anzahl_Termine` | Bearbeiten | Anzahl der Termine des Patienten an diesem Tag |
| `Status` | Tracking | `offen`, `beendet`, `alleine`, `storniert` oder `losgefahren` |

> **Hinweis:** Die Spalte `Arzt Nr::Vorname` enthält im Quellsystem den **Ort** des Termins und wird deshalb überall als „Ort“ angezeigt.

## Projektstruktur

```
Termin-Tool/
├── index.html                 # Einstieg, leitet zu termineFiltern.html weiter
├── termineFiltern.html        # Schritt 1: Oberfläche
├── termineFilternApp.js       # Schritt 1: Import, Filterregeln, Drag & Drop, Export
├── termineBearbeiten.html     # Schritt 2: Oberfläche
├── termineBearbeitenApp.js    # Schritt 2: Tabelle, Übersetzerberechnung, Excel/PDF
├── termineTracking.html       # Schritt 3: Oberfläche inkl. Formular für neue Zeilen
├── termineTrackingApp.js      # Schritt 3: Status, Hervorhebung, Excel/PDF
├── common.js                  # Gemeinsame Helper aller Seiten (Sidebar, Datei-Import, …)
└── style.css                  # Gemeinsames Stylesheet
```

## Technik

- **HTML, CSS und Vanilla JavaScript**, ohne Framework, Build-System oder Package-Manager
- **Bibliotheken** (per CDN eingebunden):
  - [SheetJS `xlsx`](https://sheetjs.com/) zum Lesen und Schreiben von Excel-Dateien
  - [jsPDF](https://github.com/parallax/jsPDF) 2.5.1 für die PDF-Erzeugung
  - [jsPDF-AutoTable](https://github.com/simonbengtsson/jsPDF-AutoTable) 3.5.13 für Tabellen im PDF
- **Datenschutz:** Alle Daten werden ausschließlich lokal im Browser verarbeitet. Es werden keine Termindaten an einen Server übertragen.

## Entwicklung

- Jede Seite besteht aus einer HTML-Datei und der zugehörigen `*App.js`. Zwischen den Seiten gibt es keinen gemeinsamen Zustand; die Excel-Dateien sind die einzige Schnittstelle.
- `common.js` ist ein klassisches Skript (kein ES-Modul) und muss **vor** der jeweiligen `*App.js` eingebunden werden.
- Die Tabellen werden per `innerHTML` mit Inline-Event-Handlern (`oninput`, `ondrop` usw.) aufgebaut. Die aufgerufenen Funktionen müssen deshalb global bleiben.
- Bearbeiten und Tracking erwarten Datum und Uhrzeit als Text (`d.m.yyyy` bzw. `HH:mm:ss`), so wie sie der Filtern-Schritt erzeugt.
- UI-Texte, Kommentare und Commit-Nachrichten sind auf Deutsch.

Weitere Architekturhinweise stehen in [`CLAUDE.md`](CLAUDE.md).

## Bekannte Einschränkungen

- Ohne Internetverbindung funktioniert die Anwendung nicht, weil die Bibliotheken über CDN geladen werden.
- Die Version von SheetJS ist nicht festgelegt. Es wird immer die aktuelle Version vom CDN geladen.
- Eine Datei muss Termine **eines einzigen Tages** enthalten. Für den Dateinamen und für neue Tracking-Einträge wird das erste gefundene Datum verwendet.
- Die Übersetzerberechnung ist eine schnelle Näherung (erste passende Zuordnung) und nicht garantiert optimal. Sie berücksichtigt keine Fahrzeiten und keine Termine über Mitternacht.
