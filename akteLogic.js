// Papierakte einlesen – die Regeln zum Sortieren, ohne Seitenbezug (damit sie einzeln prüfbar bleiben):
// Aus dem erkannten Text jeder Seite wird abgeleitet, was für ein Schriftstück es ist (Arztbericht, Befund, Rezept,
// Überweisung, Dolmetscherbericht, Rechnung …), wo ein neues Schriftstück beginnt, von wann es ist, von welchem Arzt
// und aus welcher Fachrichtung. Das Ergebnis ist immer nur ein Vorschlag – das Büro prüft und bestätigt jede Kategorie.
const AkteLogic = (() => {
    // Art eines Schriftstücks: kind = so steht es später in der Akte (tt_documents.kind), group = Abschnitt beim Prüfen.
    const KINDS = [
        { key: 'arzt', kind: 'Arztbericht', group: 'arzt', label: 'Arztbericht', single: false },
        { key: 'labor', kind: 'Befund Labor', group: 'befund', label: 'Laborbefund', single: false },
        { key: 'bild', kind: 'Befund Bildgebung', group: 'bild', label: 'Befund Bildgebung', single: false },
        // Blatt mit QR-Code oder Zugangscode, über den sich die Bilder (MRT, CT, Röntgen) im Internet ansehen lassen
        { key: 'bild_code', kind: 'Befund Bildgebung Zugang', group: 'bild', label: 'Bilder-Zugang (QR-Code)', single: true },
        { key: 'rezept_med', kind: 'Rezept Medikamente', group: 'rezept', label: 'Rezept Medikamente', single: true },
        { key: 'rezept_physio', kind: 'Rezept Physiotherapie', group: 'rezept', label: 'Rezept Physiotherapie', single: true },
        { key: 'rezept_hilf', kind: 'Rezept Hilfsmittel', group: 'rezept', label: 'Rezept Hilfsmittel', single: true },
        { key: 'ueb_fach', kind: 'Überweisung Facharzt', group: 'ueberweisung', label: 'Überweisung', single: true },
        { key: 'ueb_radio', kind: 'Überweisung Radiologie', group: 'ueberweisung', label: 'Überweisung Radiologie', single: true },
        { key: 'dolm', kind: 'Dolmetscherbericht', group: 'dolmetscher', label: 'Dolmetscherbericht', single: false },
        { key: 'rechnung', kind: 'Kosten Rechnung', group: 'kosten', label: 'Rechnung', single: false },
        { key: 'kv', kind: 'Kosten Kostenvoranschlag', group: 'kosten', label: 'Kostenvoranschlag', single: false },
        { key: 'kue', kind: 'Kosten Kostenübernahme', group: 'kosten', label: 'Kostenübernahme', single: false },
        { key: 'termin', kind: 'Terminzettel', group: 'sonstiges', label: 'Terminzettel', single: true },
        { key: 'sonst', kind: 'Sonstiges', group: 'sonstiges', label: 'Sonstiges', single: false }
    ];
    const GROUPS = [
        ['arzt', 'Krankenhaus- und Arztberichte'], ['bild', 'Bildgebung / Radiologie'], ['befund', 'Befunde (Labor)'], ['rezept', 'Rezepte'], ['ueberweisung', 'Überweisungen'],
        ['dolmetscher', 'Dolmetscherberichte'], ['kosten', 'Kosten (Rechnungen, Kostenvoranschläge)'], ['sonstiges', 'Sonstiges']
    ];
    const byKey = key => KINDS.find(item => item.key === key) || KINDS[KINDS.length - 1];
    const byKind = kind => KINDS.find(item => item.kind === kind) || null;

    // Vergleichsform: klein, ohne Akzente und Umlaute („Überweisung“ → „uberweisung“) – so stört es nicht, wenn die
    // Texterkennung einen Umlaut nicht trifft.
    const fold = text => String(text || '').toLocaleLowerCase('de').replace(/ß/g, 'ss').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[ \t ]+/g, ' ');
    const linesOf = text => String(text || '').split(/\r\n|\n|\r/).map(line => line.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean);
    const countOf = (text, pattern) => (text.match(pattern) || []).length;

    // ---------- Seitenzähler („Seite 2 von 3“, „2/3“, „- 2 -“) ----------
    const COUNTERS = [
        /(?<![\p{L}\d])(?:seite|blatt|page|s\.)\s*:?\s*([1-9]\d?)\s*(?:von|of|\/)\s*([1-9]\d?)(?!\d|[.\/]\d)/giu,
        /^[ \t]*([1-9]\d?)[ \t]*(?:\/|von|of)[ \t]*([1-9]\d?)[ \t]*$/gimu,
        /(?<![\p{L}\d])(?:seite|page)\s*:?\s*([1-9]\d?)(?![\d.\/])/giu,
        /^[ \t]*[-–—][ \t]*([1-9]\d?)[ \t]*[-–—][ \t]*$/gmu
    ];
    function counterOf(text) {
        for (const pattern of COUNTERS) {
            pattern.lastIndex = 0;
            for (const match of String(text || '').matchAll(pattern)) {
                const page = Number(match[1]), total = match[2] ? Number(match[2]) : null;
                if (page <= (total ?? 60) && (total ?? 1) <= 60) return { page, total };
            }
        }
        return null;
    }

    // ---------- Art erkennen ----------
    // [Muster in der Vergleichsform, Punkte, höchstens so oft gezählt]
    const RULES = {
        arzt: [
            [/\b(arztbrief|arztbericht|befundbericht|entlass(ungs)?(brief|bericht)|epikrise|ambulanzbrief|kurzbrief|kurzarztbrief|kurzbericht|verlegungsbrief|op-?bericht|operationsbericht|krankenhausbericht|behandlungsbericht|therapiebericht|abschlussbericht|zwischenbericht|verlaufsbericht|arztliches attest|gutachten)\b/g, 3, 1],
            [/sehr geehrte[rs]? (frau |herr )?(kolleg|dr\b|doktor|prof)|(liebe|lieber) (frau |herr )?kolleg|sehr geehrte damen und herren kolleg/g, 5, 1],
            [/wir berichten uber|berichten wir uber|nachfolgend berichten|stellte sich .{0,60}vor\b|vorstellung (am|in unserer)|in unserer (ambulanten |stationaren )?(sprechstunde|behandlung|klinik|praxis|ambulanz)|befand sich .{0,60}(behandlung|aufenthalt)/g, 4, 1],
            [/\bdiagnosen?\s*:/g, 3, 1], [/\banamnese\b/g, 3, 1], [/\b(klinischer|korperlicher|neurologischer)?\s?befunde?\s*:/g, 2, 1],
            [/\b(therapie|procedere|prozedere|empfehlung|therapieempfehlung|epikrise|verlauf|medikation)\b\s*:?/g, 1, 4],
            [/mit (freundlichen )?kollegialen gr/g, 4, 1], [/stationare[rn]? (aufenthalt|behandlung)|aufnahme am|entlassung am|wurde .{0,30}entlassen/g, 2, 1],
            // englische Arztbriefe
            [/\b(medical report|discharge (summary|letter|report)|clinical report|doctor'?s letter)\b/g, 3, 1], [/dear (colleagues?|dr\b|doctor)/g, 5, 1],
            [/we report on|presented to our|was admitted to|under our care/g, 4, 1], [/\b(diagnosis|diagnoses|history|findings|recommendations?|assessment|medication)\s*:/g, 1.5, 4]
        ],
        labor: [
            [/laborbefund|laborbericht|laborwerte|endbefund|laboratoriumsmedizin|labormedizin|laborgemeinschaft|\blabor\b/g, 4, 2],
            [/referenzbereich|normbereich|normalbereich|referenzwert|normwert/g, 6, 1],
            [/\b(mg\/dl|mmol\/l|g\/dl|u\/l|\/nl|\/pl|umol\/l|µmol\/l|ng\/ml|pg\/ml|mu\/l|miu\/l|g\/l|fl|pg)\b/g, 0.8, 10],
            [/\b(hamoglobin|leukozyten|thrombozyten|erythrozyten|hamatokrit|kreatinin|hba1c|cholesterin|triglyzeride|crp|tsh|got|gpt|ggt|natrium|kalium|glukose|harnstoff|harnsaure|bilirubin|quick|inr|ferritin)\b/g, 1.2, 6]
        ],
        bild: [
            [/\b(mrt|kernspintomograph\w*|magnetresonanztomograph\w*|ct|computertomograph\w*|rontgen\w*|sonograph\w*|ultraschall\w*|szintigraph\w*|mammograph\w*|pet-ct|angiograph\w*|echokardiograph\w*)\b/g, 1, 3],
            [/\b(technik|untersuchungstechnik|sequenzen|kontrastmittel)\b\s*:?/g, 3, 1], [/klinische angaben|fragestellung\s*:|indikation\s*:/g, 3, 1], [/\bbeurteilung\s*:/g, 2, 1],
            [/radiolog|nuklearmedizin|rontgeninstitut|institut fur diagnostische/g, 3, 1],
            [/\b(nativ|t1-|t2-|gewichtete|sagittal\w*|axial\w*|koronar\w*|schichten)\b/g, 1, 3]
        ],
        rezept: [
            [/(^|\n)\s*rp\b\.?/g, 5, 1, true], [/\b(privat|kassen|betaubungsmittel)rezept\b/g, 5, 1, true], [/\bpzn\b/g, 4, 1, true],
            [/krankenkasse bzw\.? ?kostentrager|name, vorname des versicherten/g, 3, 1, true], [/heilmittelverordnung|hilfsmittelverordnung|arzneiverordnung|verordnung von/g, 5, 1, true],
            [/aut idem|noctu|gebuhr ?(frei|pfl)|abgabedatum/g, 3, 1, true],
            [/\brezept\b/g, 2, 1], [/\bn[123]\b/g, 1.5, 2], [/\b(film)?tabletten|kapseln|tropfen|salbe|dragees|zapfchen|ampullen|\d+ ?mg\b/g, 0.7, 4], [/\bverordnung\b|verordnet|apotheke/g, 2, 1]
        ],
        ueberweisung: [
            [/uberweisungsschein/g, 8, 1, true], [/uberweisung an\b/g, 6, 1, true], [/(?<!fur die )(?<!freundliche )(?<!ihre )\buberweisung\b/g, 3, 1],
            [/\bauftrag\s*:|mit-?\/?weiterbehandlung|mitbehandlung|konsiliaruntersuchung|zielauftrag|mitbeurteilung/g, 3, 1, true], [/verdachtsdiagnose/g, 2, 1]
        ],
        dolm: [
            [/dolmetscherbericht|interpreter'?s report/g, 9, 1], [/(^|\n)[^a-z\n]{0,3}(bericht uber (den |einen )?(termin|tag|arzttermin|arztbesuch|einsatz)|tagesbericht|terminbericht|begleitbericht|besuchsbericht)\b/g, 8, 1], [/bericht (des|der) dolmetscher|bericht uber die begleitung|einsatzbericht/g, 7, 1], [/dolmetscher(\/in|in)?\s*:/g, 4, 1],
            [/dolmetscherdienst/g, 4, 1], [/medical office|gesundheitsburo/g, 2, 1], [/begleitet durch\s*:/g, 3, 1],
            [/(habe ich|ich habe) [^.]{0,140}\bbegleitet|der patient wurde .{0,30}begleitet|begleit(et|ung) zum termin|zum termin [^.]{0,80}\bbegleitet/g, 4, 1],
            [/(^|\n)(gez\. )?[^\n]{0,40}\bdolmetscher(in)?\s*(\n|$)/g, 3, 1], [/nachster termin\s*:|dauer des einsatzes/g, 1.5, 2], [/ubersetz(t|ung)/g, 1, 1]
        ],
        rechnung: [
            [/\brechnung(s?nr|snummer| nr\.?| nummer)?\b/g, 4, 1], [/rechnungsdatum|rechnungsbetrag|rechnungsnummer|rechnungs-nr/g, 5, 1], [/\bgoa\b|gebuhrenordnung fur arzte/g, 4, 1],
            [/\biban\b|bankverbindung|uberweisen sie|zahlbar|zahlungsziel|gesamtbetrag|zu zahlen|mwst|umsatzsteuer|betrag eur|\beur\b/g, 1.5, 4], [/liquidation|honorar|privatarztliche verrechnung/g, 3, 1], [/mahnung|zahlungserinnerung/g, 5, 1]
        ],
        kv: [[/kostenvoranschlag|kostenschatzung|kostenkalkulation|cost estimate/g, 9, 1], [/voraussichtliche (gesamt)?kosten/g, 4, 1]],
        kue: [[/kostenubernahme(erklarung)?|kostenzusage|kostengarantie|letter of guarantee|guarantee of payment|kostenubernahmebestatigung/g, 7, 1]],
        termin: [
            [/terminzettel|terminbestatigung|terminkarte|terminvereinbarung|einbestellung/g, 6, 1, true], [/ihr (nachster )?termin|wir haben fur sie (einen|folgenden) termin/g, 5, 1, true],
            [/termin am\b/g, 2, 1], [/bitte bringen sie|falls sie den termin nicht|sagen sie bitte rechtzeitig ab/g, 2, 2]
        ]
    };
    const FORMS = ['rezept', 'ueberweisung', 'termin'];
    const PHYSIO = /krankengymnastik|physiotherap|manuelle therapie|massage|lymphdrainage|heilmittel|ergotherap|logopad|\bkg\b/;
    const HILFSMITTEL = /hilfsmittel|bandage|orthese|einlagen|rollstuhl|rollator|gehhilfe|kompressionsstrumpf|prothese|korsett|schiene|gehstutze/;
    const RADIO = /radiolog|\bmrt\b|\bct\b|rontgen|kernspin|nuklear|szinti|mammo|computertomogra|magnetresonanz/;

    function scoresOf(folded, title) {
        const scores = {};
        Object.entries(RULES).forEach(([key, rules]) => {
            // Formulare (Rezept, Überweisung, Terminzettel) zählen nur, wenn ein sicheres Merkmal da ist (4. Angabe der Regel) –
            // ein Arztbrief, der nur ein „Rezept“ erwähnt, ist keines.
            let sure = !FORMS.includes(key) || title === key, sum = title === key ? 8 : 0;
            rules.forEach(([pattern, points, most, strong]) => { pattern.lastIndex = 0; const hits = Math.min(most, countOf(folded, pattern)); sum += hits * points; if (hits && strong) sure = true; });
            scores[key] = sure ? sum : Math.min(sum, 3);
        });
        return scores;
    }

    const LETTERHEAD = /\b(tel(efon)?|phone|fon)\.?\s?:?\s?[\d(+]|\b(tele)?fax\b|www\.|@|\b\d{5} [a-z]/;
    // Anfang eines Schriftstücks? (Briefkopf mit Datum, Anrede, Betreff …) – und Zeichen für eine Folgeseite.
    function startOf(lines, folded, counter) {
        let start = 0;
        const top = fold(lines.slice(0, Math.max(6, Math.ceil(lines.length * 0.4))).join('\n'));
        if (counter?.page === 1) start += 6;
        if (/sehr geehrte|liebe[r]? (frau|herr)|guten tag|dear (colleague|dr\b|doctor|sir|madam|mr|mrs|ms)/.test(top)) start += 3;
        if (/\bbetreff\b|\bbetr\.\s?:|\bbetrifft\s*:|unser zeichen|ihr zeichen|\bsubject\s*:|\bre\s*:|\bour ref/.test(top)) start += 2;
        if (/(^|\n)(herrn|frau|an|firma|to)\s*:?\s*(\n|$)/.test(top) || /(^|\n)(herrn|frau) (dr|prof)/.test(top)) start += 2;
        // Briefdatum: „Bonn, den 05.03.2024“, „Bonn, 3. März 2025“ – oder ein Datum am Anfang einer Zeile („15.01.2025 / Dr/ha“)
        if (/\b(den|,)\s?\d{1,2}\s?\.\s?(\d{1,2}\s?\.|[a-z]{3,9})\s?(19|20)\d{2}\b/.test(top) || /(^|\n)\d{1,2}\.\s?(\d{1,2}\.|[a-z]{3,9} )\s?(19|20)\d{2}( ?\/[^\n]{0,14})?(\n|$)/.test(top)) start += 2;
        // Briefkopf: Telefon, Internet-Adresse oder „PLZ Ort“ in den ersten Zeilen
        if (lines.slice(0, 6).map(fold).some(line => LETTERHEAD.test(line))) start += 2;
        const first = lines[0] || '';
        const follows = /^[a-zäöüß(]/.test(first) && first.length > 25 ? 2 : 0;      // beginnt mitten im Satz
        return { start, follows };
    }
    // Überschrift eines Schriftstücks als eigene, kurze Zeile oben auf dem Blatt („Laborbefund – Endbefund“, „Rechnung Nr. 4711“,
    // „LETTER OF GUARANTEE“). Sie entscheidet die Art am sichersten. Keine Zwischenüberschrift im Brief („Befund:“ endet mit Doppelpunkt).
    const TITLES = [
        ['dolm', /dolmetscherbericht|bericht (des|der) dolmetscher(s|in)?|interpreter'?s report|bericht uber die begleitung|einsatzbericht|bericht uber (den |einen )?(termin|tag|arzttermin|arztbesuch|einsatz)|tagesbericht|terminbericht|begleitbericht|besuchsbericht/],
        ['kue', /kostenubernahme(erklarung|bestatigung|zusage)?|kostenzusage|kostengarantie|letter of guarantee|guarantee of payment/],
        ['kv', /kostenvoranschlag|kostenschatzung|kostenkalkulation|cost estimate|voraussichtliche behandlungskosten/],
        ['rechnung', /rechnung|honorarrechnung|privatliquidation|liquidation|invoice|mahnung|zahlungserinnerung/],
        ['labor', /laborbefund|laborbericht|endbefund|vorbefund|teilbefund|laboratory report|laborblatt/],
        ['termin', /terminbestatigung|terminzettel|terminkarte|ihr (nachster )?termin|ihre (nachsten )?termine/],
        ['ueberweisung', /uberweisungsschein|uberweisung/],
        ['rezept', /heilmittelverordnung|hilfsmittelverordnung|privatrezept|rezept|arzneiverordnung/],
        ['arzt', /(vorlaufiger |endgultiger |arztlicher |facharztlicher )?(arztbrief|arztbericht|befundbericht|entlass(ungs)?(brief|bericht)|epikrise|kurzbrief|kurzarztbrief|kurzbericht|ambulanzbrief|ambulanzbericht|verlegungsbrief|verlegungsbericht|op-?bericht|operationsbericht|therapiebericht|abschlussbericht|zwischenbericht|verlaufsbericht|krankenhausbericht|behandlungsbericht|konsilbericht|gutachten|medical report|discharge (summary|letter|report)|clinical report)/]
    ];
    function headOf(lines) {
        const count = Math.max(12, Math.ceil(lines.length * 0.45));
        let title = '', titleLine = -1, headline = '';
        lines.slice(0, count).some((raw, index) => {
            // „Rechnung Nr. 4711   Rechnungsdatum: 11.03.2024“ – es zählt der Teil vor der ersten Angabe mit Doppelpunkt.
            const line = fold(raw).trim().replace(/ [^ :]{2,24}: .*$/, '');
            if (!line || line.length > 62 || line.split(' ').length > 8 || !/^[^a-z]*[A-ZÄÖÜ]/.test(raw.trim())) return false;
            // Die Überschrift steht am Anfang der Zeile – oder (zweispaltiger Kopf) an ihrem Ende.
            const hit = TITLES.find(([, pattern]) => new RegExp(`^[^a-z]{0,3}(${pattern.source})\\b[^:]{0,36}$`).test(line) || new RegExp(`[: ] ?(${pattern.source})$`).test(line));
            if (hit) { title = hit[0]; titleLine = index; return true; }
            // Unterlagen ohne eigene Art (Einverständniserklärung, Medikationsplan, Bescheinigung …)
            const other = index < 12 && HEADINGS.find(([pattern]) => new RegExp(`^[^a-z]{0,3}(arztliche[rs]? |arztl\\. )?(${pattern.source})`).test(line) || new RegExp(`\\b(${pattern.source})$`).test(line));
            if (other && !/[.:;,]$/.test(line)) { headline = other[1]; titleLine = index; return true; }
            return false;
        });
        // Briefkopf: Telefon, Internet-Adresse oder „PLZ Ort“ in den ersten Zeilen
        const letterhead = lines.slice(0, 6).map(fold).some(line => LETTERHEAD.test(line));
        return { title, titleLine, headline, letterhead };
    }
    // Endet die Seite mitten im Satz? Dann geht das Schriftstück auf der nächsten Seite weiter.
    const FOOTER = /^(seite|page|blatt)\b|\biban\b|\bbic\b|bankverbindung|\btel(efon)?\b|\bfax\b|www\.|@|geschaftsfuhr|amtsgericht|\bhrb\b|steuernummer|ust-?id|^[-–—\s\d\/|]+$/;
    const isProse = line => line.length >= 45 && countOf(line, /[\p{L} ]/gu) / line.length >= 0.82;
    function endsOpen(lines) {
        const body = lines.filter(line => !FOOTER.test(fold(line)));
        const last = body[body.length - 1] || '', before = body[body.length - 2] || '';
        if (!last || /[.!?:;)"”“]\s*$/.test(last)) return false;
        // Nach der Grußformel kommen nur noch Unterschrift und Stempel – das ist kein offener Satz.
        if (body.slice(-12).some(line => CLOSING.test(fold(line)))) return false;
        // Ein Satz läuft nur dann über die Seite hinaus, wenn die letzte Zeile bis zum rechten Rand geht (umbrochen wurde).
        const lengths = body.map(line => line.length).filter(length => length >= 30).sort((left, right) => left - right);
        const full = lengths.length ? lengths[Math.floor(lengths.length * 0.8)] : 0;
        const wrapped = line => isProse(line) && line.length >= full * 0.8;
        return wrapped(last) || (wrapped(before) && !/[.!?:]\s*$/.test(before) && /^[\p{L}\- ,]+$/u.test(last) && last.length < 40);
    }
    // Ist der Text lesbar – oder hat die Texterkennung nur Bruchstücke geliefert (Handschrift, Foto, fremde Schrift)?
    function readable(folded) {
        const words = folded.match(/[a-z]{4,}/g) || [];
        return words.filter(word => /[aeiouy]/.test(word) && !/[^aeiouy]{5,}/.test(word) && !/(.)\1\1/.test(word)).length;
    }
    // Überschrift für Unterlagen, die in keine der Arten passen (steht oben auf dem Blatt).
    const HEADINGS = [
        [/einverstandnis|einwilligungserklarung|einwilligung in/, 'Einverständniserklärung'], [/aufklarungsbogen|aufklarung uber|patientenaufklarung/, 'Aufklärungsbogen'], [/medikationsplan/, 'Medikationsplan'],
        [/arbeitsunfahigkeit/, 'Arbeitsunfähigkeitsbescheinigung'], [/\battest\b/, 'Attest'], [/bescheinigung/, 'Bescheinigung'], [/vollmacht/, 'Vollmacht'], [/schweigepflicht/, 'Schweigepflichtentbindung'],
        [/behandlungsvertrag/, 'Behandlungsvertrag'], [/wahlleistung/, 'Wahlleistungsvereinbarung'], [/datenschutz/, 'Datenschutzerklärung'], [/anamnesebogen|fragebogen|selbstauskunft/, 'Fragebogen'],
        [/impfausweis|impfpass|impfbuch/, 'Impfausweis'], [/allergiepass|notfallausweis|implantat(pass|ausweis)|schrittmacherausweis/, 'Patientenausweis'], [/patientenverfugung/, 'Patientenverfügung'],
        [/reisepass|passport|aufenthaltstitel|\bvisum\b/, 'Ausweisdokument'], [/telefax|fax-?deckblatt|faxnachricht/, 'Fax'], [/aufnahme(schein|vertrag|anzeige)|stationare aufnahme/, 'Aufnahmeunterlagen'],
        [/deckblatt|aktendeckel/, 'Deckblatt'], [/inhaltsverzeichnis|inhaltsubersicht/, 'Inhaltsverzeichnis'], [/trennblatt/, 'Trennblatt']
    ];
    function headingOf(text) {
        const top = fold(linesOf(text).slice(0, 10).join('\n'));
        return HEADINGS.find(([pattern]) => pattern.test(top))?.[1] || '';
    }

    // Grußformel am Ende eines Briefs (auch wenn die Texterkennung das „ü“ nicht trifft: „GriBen“).
    const CLOSING = /mit (freundlichen|besten|kollegialen|herzlichen)( kollegialen)? gr[a-z]{2,6}\b|mit freundlichem gr|hochachtungsvoll|yours (sincerely|faithfully)|(kind|best) regards/;
    // Zugang zu den Bildern einer Untersuchung: Blatt mit QR-Code oder Zugangscode („Ihre Bilder online ansehen“).
    const CODE_CUES = [/qr-?code/, /zugangs(code|daten|schlussel|kennung|nummer)|access ?code|freigabecode|abrufcode/, /bild(er)?(betrachtung|portal|zugang|abruf|ubermittlung|daten ?abruf)|bilder (und befunde? )?(online|im internet|digital|abrufen|ansehen|einsehen|herunterladen)|bilddaten|aufnahmen (online|abrufen|ansehen|einsehen)/,
        /(befund|patienten|zuweiser)portal|\bpacs\b|\bdicom\b|web-?viewer|bildviewer/, /scannen sie|code scannen|mit (der kamera|ihrem (smartphone|handy))|view your images|your images online/, /untersuchungs-?(id|nr|nummer)|passwort\s*:|kennwort\s*:|\bpin\s*:/];
    function codeCues(folded) { return CODE_CUES.filter(pattern => pattern.test(folded)).length; }

    // extra.qr: auf dem Blatt wurde ein QR-Code gefunden (akteImport.js).
    function analysePage(text, extra = {}) {
        const lines = linesOf(text), folded = fold(lines.join('\n'));
        const letters = countOf(folded, /[a-z]/g);
        const counter = counterOf(text);
        const { title, titleLine, headline, letterhead } = headOf(lines);
        const scores = scoresOf(folded, title);
        const entries = Object.entries(scores).sort((left, right) => right[1] - left[1]);
        let [key, score] = entries[0];
        // Ein Radiologie-Befund ist auch ein Arztbrief – er zählt als Bildgebung, wenn Technik oder Fragestellung genannt sind.
        if (key === 'arzt' && scores.bild >= 7 && scores.bild >= scores.arzt * 0.55) { key = 'bild'; score = scores.bild; }
        if (key === 'bild' && scores.bild < 6) { key = scores.arzt >= 5 ? 'arzt' : 'sonst'; score = scores.arzt; }
        if (key === 'labor' && scores.labor < 7) { key = scores.arzt >= 5 ? 'arzt' : 'sonst'; score = Math.max(scores.arzt, 0); }
        if (score < 4.5) key = 'sonst';
        // Rezept, Überweisung und Terminzettel sind kurze Formulare. Eine volle Textseite, die nur ein „Rezept“ erwähnt
        // (z. B. die Folgeseite eines Arztbriefs mit der Medikation), ist keines.
        const words = countOf(folded, /[a-z0-9]{2,}/g);
        if (['rezept', 'ueberweisung', 'termin'].includes(key) && words > 170 && score < 12) {
            const rest = entries.filter(([name]) => !['rezept', 'ueberweisung', 'termin'].includes(name))[0];
            key = rest && rest[1] >= 4.5 ? rest[0] : 'sonst';
            score = rest ? rest[1] : 0;
        }
        if (key === 'rezept') key = HILFSMITTEL.test(folded) ? 'rezept_hilf' : PHYSIO.test(folded) ? 'rezept_physio' : 'rezept_med';
        if (key === 'ueberweisung') {
            // Wohin die Überweisung geht, entscheidet – nicht, ob im Text eine frühere MRT erwähnt ist.
            const target = referralTarget(lines.join('\n')), order = (folded.match(/\bauftrag\s*:?\s*([^\n]{0,80}(\n[^\n]{0,80})?)/) || [])[1] || '';
            key = target ? (/radiolog|nuklear/i.test(target) ? 'ueb_radio' : 'ueb_fach') : RADIO.test(order || folded) ? 'ueb_radio' : 'ueb_fach';
        }
        // Blatt mit dem Zugang zu den Bildern: kurzes Blatt mit QR-Code und einem Bezug zur Bildgebung – oder mit zwei klaren Hinweisen
        // auf einen Zugang. (Ein QR-Code allein reicht nicht: Auch E-Rezepte und Rechnungen tragen einen.)
        const cues = codeCues(folded);
        if (words <= 260 && !['rezept_med', 'rezept_physio', 'rezept_hilf', 'rechnung', 'labor'].includes(key)
            && ((extra.qr && (cues >= 1 || RADIO.test(folded) || scores.bild >= 3)) || (cues >= 2 && (RADIO.test(folded) || /bild|aufnahme|images/.test(folded))))) { key = 'bild_code'; score = Math.max(score, 8); }
        const { start, follows } = startOf(lines, folded, counter);
        const closing = CLOSING.test(folded);
        const good = readable(folded);
        return { key, score, scores, counter, start, follows, closing, open: endsOpen(lines), letters, lines: lines.length, words, good, unreadable: good < 12 && key === 'sonst', title, titleLine, headline, letterhead, qr: Boolean(extra.qr) };
    }

    // ---------- Datum ----------
    const MONTHS = { januar: 1, january: 1, jan: 1, februar: 2, february: 2, feb: 2, marz: 3, march: 3, mrz: 3, april: 4, apr: 4, mai: 5, may: 5, juni: 6, june: 6, jun: 6, juli: 7, july: 7, jul: 7,
        august: 8, aug: 8, september: 9, sept: 9, sep: 9, oktober: 10, october: 10, okt: 10, oct: 10, november: 11, nov: 11, dezember: 12, december: 12, dez: 12, dec: 12 };
    const MONTH = 'januar|january|februar|february|marz|march|april|mai|may|juni|june|juli|july|august|september|oktober|october|november|dezember|december|jan|feb|mrz|apr|jun|jul|aug|sept|sep|okt|oct|nov|dez|dec';
    const WEEKDAY = /(montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend|sonntag|monday|tuesday|wednesday|thursday|friday|saturday|sunday),? (den |dem |the )?$/;
    const validDay = (year, month, day, maxYear) => {
        if (!(year >= 1985 && year <= maxYear && month >= 1 && month <= 12 && day >= 1 && day <= 31)) return false;
        const date = new Date(year, month - 1, day);
        return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
    };
    // Alle Datumsangaben einer Seite mit Bewertung: Briefdatum („Bonn, den 05.03.2024“, „Datum: …“) vor Daten im Fließtext;
    // ein Geburtsdatum zählt nie. appointment: Datum mit Wochentag oder Uhrzeit (für Terminzettel).
    function datesOf(text, today = new Date()) {
        const lines = linesOf(text), maxYear = today.getFullYear() + 1, found = [];
        lines.forEach((line, index) => {
            const low = fold(line), place = index / Math.max(1, lines.length - 1 || 1);
            const add = (year, month, day, at, length) => {
                if (!validDay(year, month, day, maxYear)) return;
                const before = low.slice(Math.max(0, at - 30), at), after = low.slice(at + length, at + length + 16);
                let score = 1;
                if (/(geb\.?|geboren|geburtsdatum|geb\.? ?am|\*|date of birth|born( on)?|\bdob|d\.o\.b\.?)\s*:?\s*(am )?$/.test(before)) return;      // Geburtsdatum
                const weekday = WEEKDAY.test(before);
                if (!weekday && (/\b[a-z.\- ]{2,25},? den $/.test(before) || /^[a-z.\- ]{2,25}, $/.test(before))) score += 6;      // „Bonn, den …“
                else if (/(datum|date|ausgang|ausgestellt am|erstellt am|gedruckt am|validiert( durch [^:]{0,40})? am|freigegeben am|(befund|bericht|brief|rechnung|schreiben) vom)\s*:?\s*$/.test(before)) score += 5;
                else if (/eingang\s*:?\s*$/.test(before)) score += 3;                    // Eingangsstempel, Probeneingang
                if (/(vom|am) $/.test(before)) score += 1;
                if (place <= 0.35) score += 2;
                if (low.trim().length === length) score += 2;                               // steht allein in der Zeile
                if (/(seit|bis|ab dem|gultig bis|versichert bis) $/.test(before)) score -= 1;
                const appointment = weekday || /^,? ?(um |at )?\d{1,2}[:.]\d{2}( ?uhr| ?h\b| ?[ap]m)?/.test(after) || /^ ?um \d{1,2} ?uhr/.test(after);
                found.push({ iso: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, score, line: index, appointment });
            };
            for (const match of low.matchAll(/(?<![\d.])([0-3]?\d)\s?[.,]\s?([01]?\d)\s?[.,]\s?((?:19|20)\d{2}|\d{2})(?![\d])/g)) {
                const year = match[3].length === 2 ? (Number(match[3]) > (maxYear % 100) ? 1900 + Number(match[3]) : 2000 + Number(match[3])) : Number(match[3]);
                add(year, Number(match[2]), Number(match[1]), match.index, match[0].length);
            }
            // „3. März 2025“, „08 January 2025“, „6th March 2025“
            for (const match of low.matchAll(new RegExp(`(?<![\\d.])([0-3]?\\d)(?:st|nd|rd|th)?\\.?\\s?(${MONTH})\\b\\.?,?\\s+((?:19|20)\\d{2})`, 'g'))) add(Number(match[3]), MONTHS[match[2]], Number(match[1]), match.index, match[0].length);
            // „March 6, 2025“
            for (const match of low.matchAll(new RegExp(`(?<![a-z])(${MONTH})\\b\\.?\\s+([0-3]?\\d)(?:st|nd|rd|th)?,?\\s+((?:19|20)\\d{2})`, 'g'))) add(Number(match[3]), MONTHS[match[1]], Number(match[2]), match.index, match[0].length);
            for (const match of low.matchAll(/(?<!\d)((?:19|20)\d{2})-(\d{2})-(\d{2})(?!\d)/g)) add(Number(match[1]), Number(match[2]), Number(match[3]), match.index, match[0].length);
        });
        return found.sort((left, right) => right.score - left.score || left.line - right.line);
    }
    const dateOf = (text, today) => datesOf(text, today)[0]?.iso || '';
    // Terminzettel: das Datum des Termins (mit Wochentag oder Uhrzeit), nicht das Datum des Schreibens.
    const appointmentOf = (text, today) => datesOf(text, today).filter(item => item.appointment).sort((left, right) => left.line - right.line)[0]?.iso || '';
    // Datum im Kopf der Seite – nur wenn es dort ausdrücklich als Datum des Schriftstücks steht („Bonn, den …“, „Datum: …“).
    function headDateOf(text, today) {
        const lines = linesOf(text);
        return datesOf(text, today).find(item => item.score >= 6 && item.line <= Math.max(14, lines.length * 0.5))?.iso || '';
    }

    // ---------- Arzt und Fachrichtung ----------
    const SPECIALTIES = [
        [/neurochirurg|neurosurg/, 'Neurochirurgie'], [/herzchirurg|kardiochirurg|cardiac surg|cardiothoracic/, 'Herzchirurgie'], [/gefasschirurg|angiolog|vascular surg/, 'Gefäßmedizin'], [/unfallchirurg|trauma surg/, 'Orthopädie und Unfallchirurgie'],
        [/kinderchirurg|pa?ediatric surg/, 'Kinderchirurgie'], [/plastische.{0,20}chirurg|plastic surg/, 'Plastische Chirurgie'], [/mund-?,? ?kiefer|oralchirurg|kieferchirurg|maxillofacial/, 'Mund-, Kiefer- und Gesichtschirurgie'],
        [/thoraxchirurg|thoracic surg/, 'Thoraxchirurgie'], [/viszeralchirurg|allgemeinchirurg|allgemein- und viszeral|visceral surg|general surg/, 'Allgemein- und Viszeralchirurgie'],
        [/[ck]ardiolog|herzzentrum|herzpraxis/, 'Kardiologie'], [/neurolog/, 'Neurologie'], [/orthopad|orthopa?edi/, 'Orthopädie'], [/urolog/, 'Urologie'], [/gynakolog|gyna?ecolog|frauenheilkunde|frauenarzt|frauenklinik|geburtshilfe|obstetric/, 'Gynäkologie'],
        [/hals-?,? ?nasen|\bhno\b|otorhinolaryng|ear, nose/, 'HNO'], [/augenheilkunde|augenklinik|augenarzt|augenzentrum|augenpraxis|ophthalmolog/, 'Augenheilkunde'], [/dermatolog|hautarzt|hautklinik|venerolog/, 'Dermatologie'],
        [/nuklearmedizin|nuclear medicine/, 'Nuklearmedizin'], [/strahlentherap|radioon[ck]olog|radiotherap/, 'Strahlentherapie'], [/radiolog|rontgeninstitut/, 'Radiologie'], [/hamatolog|ha?ematolog|on[ck]olog/, 'Onkologie'],
        [/gastroenterolog/, 'Gastroenterologie'], [/pneumolog|pulmonolog|lungenheilkunde|lungenfacharzt|lungenklinik|respiratory medicine/, 'Pneumologie'], [/nephrolog|dialyse|dialysis/, 'Nephrologie'],
        [/endo[ck]rinolog|diabetolog/, 'Endokrinologie und Diabetologie'], [/rheumatolog/, 'Rheumatologie'], [/psychiatr|psychotherap|psychosomat/, 'Psychiatrie und Psychotherapie'],
        [/padiatr|pa?ediatric|kinderarzt|kinderklinik|kinderheilkunde|kinder- und jugendmedizin/, 'Kinderheilkunde'], [/anasthes|ana?esthes|schmerztherap|schmerzambulanz|schmerzzentrum|pain (clinic|medicine)/, 'Anästhesie und Schmerztherapie'],
        [/zahnarzt|zahnklinik|zahnmedizin|zahnheilkunde|kieferorthopad|dentist|dental (clinic|medicine)/, 'Zahnmedizin'], [/physiotherap|krankengymnast|rehabilitation|\breha\b/, 'Physiotherapie und Reha'],
        [/laboratoriumsmedizin|labormedizin|mvz labor|laborgemeinschaft|laboratory medicine/, 'Labormedizin'], [/patholog/, 'Pathologie'], [/humangenetik|human genetics/, 'Humangenetik'], [/infektiolog|tropenmedizin|infectious diseases/, 'Infektiologie'],
        [/geriatr/, 'Geriatrie'], [/palliativ/, 'Palliativmedizin'], [/notaufnahme|notfallzentrum|notfallambulanz|emergency department/, 'Notaufnahme'], [/innere medizin|internist|internal medicine/, 'Innere Medizin'],
        [/allgemeinmedizin|hausarzt|praktischer arzt|general practi|family medicine/, 'Allgemeinmedizin'], [/\bchirurg|\bsurgery\b|\bsurgeon\b/, 'Chirurgie']
    ];
    const ROLE_LINE = /klinik fur|facharzt|facharztin|praxis fur|institut fur|abteilung fur|zentrum fur|poliklinik|direktor|chefarzt|chefarztin|arztliche leitung|gemeinschaftspraxis|sektion|fachbereich|department of|institute of|clinic (for|of)|head of|consultant|specialist in/;
    const NAME_STOP = /^(Facharzt|Fachärztin|Fach|Oberarzt|Oberärztin|Chefarzt|Chefärztin|Direktor|Direktorin|Leiter|Leiterin|Assistenzarzt|Assistenzärztin|Arzt|Ärztin|Klinik|Praxis|Institut|Tel|Telefon|Fax|Und|Sowie|Stationsarzt|Stationsärztin|Kollege|Kollegin|Herr|Frau|Privatdozent)$/i;

    // Zeilen des Empfängers im Brieffenster („Herrn / Dr. med. … / Facharzt für … / Straße / Ort“) – sie nennen nicht den Absender.
    function recipientLines(lines) {
        const skip = new Set();
        lines.forEach((line, index) => {
            const low = fold(line);
            const window = /^(herrn|frau|an|an den|an die|an das|firma|to)\b/.test(low) || (index >= 3 && /^(gemeinschafts)?praxis (dr|dres|prof)\b/.test(low));
            if (window && low.length <= 60 && index < lines.length * 0.5) {
                // Eine Anschrift endet mit „PLZ Ort“ – sonst ist es nur ein Satz, der mit „Herrn Dr. …“ beginnt.
                const end = lines.slice(index, index + 7).findIndex(item => /^(d-)?\d{5} \p{L}/iu.test(item));
                if (end !== -1) for (let k = index; k <= index + end; k++) skip.add(k);
            }
            if (/sehr geehrte|liebe[r]? (frau|herr)/.test(low)) skip.add(index);
        });
        return skip;
    }

    // Titel mit Punkt – oder mit Komma, wenn die Texterkennung den Punkt so liest („Dr. med, Thomas Sommer“).
    const DOCTOR = /((?:Prof[.,]?\s*)?(?:(?:Dr|PD|Priv\.?-?\s?Doz)[.,]?\s*)+(?:(?:med|dent|rer|nat|phil|univ|habil|h\.\s?c|mult)[.,]?\s*)*)((?:[A-ZÄÖÜ]\.\s?)?(?:(?:von|van|de|der|den|zu|al|el|bin|ben)\s+)?[A-ZÄÖÜ][\p{L}'’-]+(?:\s+(?:(?:von|van|de|der|den|zu|al|el|bin|ben)\s+)?[A-ZÄÖÜ][\p{L}'’-]+){0,2})/gu;
    // „Prof. Dr. med. Roland Goldbach“ → { title: 'Prof. Dr.', name: 'Goldbach', full: 'Prof. Dr. Goldbach' }
    function doctorsOf(text) {
        const lines = linesOf(text), skip = recipientLines(lines), found = [];
        const closingAt = lines.findIndex(line => CLOSING.test(fold(line)));
        lines.forEach((line, index) => {
            if (skip.has(index)) return;
            DOCTOR.lastIndex = 0;
            for (const match of line.matchAll(DOCTOR)) {
                const words = match[2].trim().split(/\s+/).filter(word => !/^[A-ZÄÖÜ]\.$/.test(word));
                const cut = words.findIndex(word => NAME_STOP.test(word) || SPECIALTIES.some(([pattern]) => pattern.test(fold(word))) || /^(am|an|im|in|bei|und|für|fur|vom|zum|zur|Klinikum|Krankenhaus|Zentrum|Markt|Platz|Straße|Strasse|Str)$/i.test(word));
                const nameWords = (cut === -1 ? words : words.slice(0, cut)).filter(Boolean);
                if (!nameWords.length) continue;
                const surname = nameWords.slice(nameWords.length > 1 && /^(von|van|de|der|den|zu|al|el|bin|ben)$/i.test(nameWords[nameWords.length - 2]) ? -2 : -1).join(' ');
                if (surname.length < 3 || /\d/.test(surname)) continue;
                const title = /prof/i.test(match[1]) ? 'Prof. Dr.' : 'Dr.';
                const low = fold(line), around = fold(`${lines[index - 1] || ''}\n${line}\n${lines[index + 1] || ''}`);
                let score = 1;
                if (ROLE_LINE.test(around)) score += 4;
                if (index <= Math.max(5, lines.length * 0.2)) score += 3;                    // Briefkopf
                if (closingAt !== -1 && index > closingAt) score += 2;                       // Unterschrift
                if (/direktor|chefarzt|chefarztin|arztliche leitung|leitender/.test(low)) score += 2;
                if (/\b(dr|prof)\b.{0,40}\b(dr|prof)\b/.test(low) && /oberarzt|assistenz|stationsarzt/.test(low)) score -= 1;
                found.push({ title, name: surname, full: `${title} ${surname}`, score, line: index });
            }
        });
        // Derselbe Name mehrfach: die beste Fundstelle zählt, jede weitere gibt einen Punkt dazu.
        const merged = new Map();
        found.forEach(item => {
            const id = fold(item.name), known = merged.get(id);
            if (!known) merged.set(id, { ...item });
            else { known.score = Math.max(known.score, item.score) + 1; if (item.title.startsWith('Prof')) { known.title = item.title; known.full = `${item.title} ${known.name}`; } }
        });
        return [...merged.values()].sort((left, right) => right.score - left.score || left.line - right.line);
    }

    // Allgemeine Angaben, hinter denen oft die genauere steht („Fachärztin für Innere Medizin und Gastroenterologie“).
    const GENERAL = { 'Innere Medizin': ['Kardiologie', 'Gastroenterologie', 'Pneumologie', 'Nephrologie', 'Endokrinologie und Diabetologie', 'Rheumatologie', 'Onkologie', 'Gefäßmedizin', 'Infektiologie', 'Geriatrie'],
        'Chirurgie': ['Neurochirurgie', 'Herzchirurgie', 'Gefäßmedizin', 'Orthopädie und Unfallchirurgie', 'Kinderchirurgie', 'Plastische Chirurgie', 'Thoraxchirurgie', 'Allgemein- und Viszeralchirurgie', 'Mund-, Kiefer- und Gesichtschirurgie'] };
    function specialtiesOf(text, { least = 3 } = {}) {
        const lines = linesOf(text), skip = recipientLines(lines), scores = new Map();
        const named = lines.map(line => { DOCTOR.lastIndex = 0; return DOCTOR.test(line); });
        lines.forEach((line, index) => {
            if (skip.has(index)) return;
            const low = fold(line);
            for (const [pattern, label] of SPECIALTIES) {
                if (!pattern.test(low)) continue;
                let points = 1;
                if (index <= Math.max(6, lines.length * 0.25)) points += 3;                  // Briefkopf
                if (ROLE_LINE.test(low)) points += 3;
                else if (named[index] || named[index - 1] || named[index + 1] || named[index - 2] || named[index + 2]) points += 2;      // Stempel: neben dem Namen des Arztes
                scores.set(label, (scores.get(label) || 0) + points);
                break;                                                                       // je Zeile zählt die genaueste Angabe (steht oben in der Liste)
            }
        });
        const list = [...scores.entries()].map(([label, score]) => ({ label, score })).filter(item => item.score >= least).sort((left, right) => right.score - left.score);
        const best = list[0], finer = best && GENERAL[best.label] ? list.find(item => GENERAL[best.label].includes(item.label) && item.score >= best.score * 0.4) : null;
        return finer ? [finer, ...list.filter(item => item !== finer)] : list;
    }
    // „Überweisung an: Neurochirurgie“ – bei einer Überweisung zählt, wohin sie geht.
    function referralTarget(text) {
        const match = fold(text).match(/uberweisung an\s*:?\s*([^\n]{3,60})/);
        if (!match) return '';
        return SPECIALTIES.find(([pattern]) => pattern.test(match[1]))?.[1] || '';
    }

    // ---------- Ein Schriftstück beschreiben ----------
    // texts: der Text jeder Seite des Schriftstücks, in Reihenfolge. Ergebnis: { key, kind, group, date, doctor, specialty, heading,
    // title, unsure, hints: [] } – auch für Schriftstücke, die das Büro beim Prüfen von Hand geteilt oder verbunden hat.
    function describe(texts, { today = new Date(), directory = [], features = null, unsure = false, weak = false } = {}) {
        const list = (Array.isArray(texts) ? texts : []).map(text => String(text || ''));
        const pageFeatures = features || list.map(text => analysePage(text));
        const known = (Array.isArray(directory) ? directory : []).map(item => ({ ...item, id: fold(item.name).replace(/\b(prof|dr|med|dent)\b\.?/g, ' ').replace(/[^a-z ]/g, ' ').trim().split(/\s+/).pop() })).filter(item => item.id && item.id.length >= 3);
        const first = list[0] || '', all = list.join('\n');
        const info = analysePage(all);
        // Für die Art zählt die erste Seite. Hat sie weder eine klare Art noch eine eigene Überschrift, zählt der Text des ganzen Schriftstücks.
        let key = pageFeatures[0]?.key || 'sonst';
        if (key === 'sonst' && info.key !== 'sonst' && !headingOf(first)) key = info.key;
        const kind = byKey(key);
        const date = (kind.key === 'termin' && (appointmentOf(first, today) || appointmentOf(all, today))) || dateOf(first, today) || dateOf(all, today);
        const doctors = doctorsOf(first).concat(doctorsOf(list.slice(1).join('\n')).map(item => ({ ...item, score: item.score - 2 })));
        const foldedAll = fold(all);
        const fromDirectory = known.find(item => new RegExp(`\\b${item.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(foldedAll) && doctors.some(doctor => fold(doctor.name) === item.id));
        const doctor = doctors.sort((left, right) => right.score - left.score)[0] || null;
        // Ein Dolmetscherbericht nennt die besuchte Praxis nur im Text; bei einer Heilmittelverordnung ist „Physiotherapie“ der Inhalt, nicht der Aussteller.
        // (Eine bloße Erwähnung im Fließtext – „Rezept für Physiotherapie“ – reicht nicht: Die Angabe muss beim Namen des Arztes stehen.)
        const least = kind.key === 'dolm' ? 2 : 3;
        const fields = specialtiesOf(first, { least }).concat(specialtiesOf(list.slice(1).join('\n'), { least }).map(item => ({ ...item, score: item.score * 0.5 })))
            .filter(item => !(kind.key === 'rezept_physio' && item.label === 'Physiotherapie und Reha'));
        let specialty = (kind.group === 'ueberweisung' ? referralTarget(all) : '') || (fromDirectory && fold(fromDirectory.name).includes(fold(doctor?.name || '#')) ? fromDirectory.specialty : '') || fields[0]?.label || '';
        if (kind.key === 'ueb_radio' && !specialty) specialty = 'Radiologie';
        if (kind.key === 'labor' && !specialty) specialty = 'Labormedizin';
        if ((kind.key === 'bild' || kind.key === 'bild_code') && !specialty) specialty = 'Radiologie';
        const hints = [];
        const counters = pageFeatures.map(feature => feature.counter).filter(Boolean);
        const total = counters.find(counter => counter.total)?.total;
        if (total) {
            const seen = new Set(counters.map(counter => counter.page));
            const missing = Array.from({ length: total }, (unused, index) => index + 1).filter(number => !seen.has(number));
            if (missing.length && counters.length === list.length) hints.push(`Laut Seitenzähler ${missing.length === 1 ? 'fehlt Seite' : 'fehlen die Seiten'} ${missing.join(', ')} von ${total}.`);
        }
        if (unsure) hints.push('Bitte prüfen: Gehören alle Seiten zu diesem Schriftstück?');
        if (weak) hints.push('Bitte prüfen: Beginnt hier ein neues Schriftstück – oder gehört die Seite noch zum vorherigen?');
        const unreadable = pageFeatures.length > 0 && pageFeatures.every(feature => feature.unreadable);
        const heading = key === 'sonst' && !unreadable ? headingOf(first) : '';
        if (unreadable) hints.push('Der Text ist nicht lesbar (Handschrift, Bild oder fremde Schrift) – bitte ansehen und einordnen.');
        else if (key === 'sonst' && !heading) hints.push('Die Art wurde nicht sicher erkannt.');
        const document = { key, kind: kind.kind, group: kind.group, date, doctor: unreadable ? '' : doctor?.full || '', specialty: unreadable ? '' : specialty, heading, unsure: unsure || weak || (key === 'sonst' && !heading), hints };
        document.title = titleOf(document);
        return document;
    }

    // ---------- Seiten zu Schriftstücken ordnen ----------
    // pages: [{ text, blank }] in der Reihenfolge des Scans. Ergebnis: { documents: [{ pages: [Nummern ab 0], key, kind, group,
    // date, doctor, specialty, title, unsure, hints: [] }], blanks: [Nummern], features: [je Seite] }
    function sortPages(pages, { today = new Date(), directory = [] } = {}) {
        const features = pages.map(page => page.blank ? { blank: true, key: 'sonst', score: 0, scores: {}, counter: null, start: 0, follows: 0, closing: false, letters: 0 }
            : { ...analysePage(page.text, { qr: page.qr }), headDate: headDateOf(page.text, today) });
        const groups = [], blanks = [];
        let current = null;
        const complete = group => group.closed || Boolean(group.lastCounter?.total && group.lastCounter.page >= group.lastCounter.total);
        features.forEach((feature, index) => {
            if (feature.blank) { blanks.push(index); return; }
            const kind = byKey(feature.key);
            const best = Math.max(0, ...Object.values(feature.scores));
            let fresh = !current, unsure = false, weak = false;
            // Rückseite eines Blattes (Vorder- und Rückseiten wurden getrennt gescannt): Sie gehört zu ihrer Vorderseite – außer sie
            // beginnt klar etwas Neues (Seitenzähler 1, eigener Briefkopf mit Anrede, ein Formular wie Rezept oder Überweisung).
            const backOfSheet = Boolean(pages[index].back) && current && current.pages[current.pages.length - 1] === index - 1
                && !(feature.counter && feature.counter.page === 1) && feature.start < 5 && !(kind.single && feature.score >= 5);
            if (backOfSheet) fresh = false;
            else if (current) {
                const last = current.lastCounter, before = features[current.pages[current.pages.length - 1]];
                const counted = feature.counter && feature.counter.page > 1 && (!last || feature.counter.page === last.page + 1 || feature.counter.page === last.page);
                if (counted) fresh = false;                                                  // „Seite 2 von 3“ nach „Seite 1 von 3“
                else if (feature.counter && feature.counter.page === 1) fresh = true;
                else if (feature.unreadable || before.unreadable) fresh = true;              // nicht lesbar: einzeln ansehen
                else if (kind.single && feature.score >= 5) fresh = true;                    // jedes Rezept, jede Überweisung ist ein eigenes Blatt
                else if (byKey(current.key).single) fresh = true;
                else if (feature.start >= 5) fresh = true;                                   // Briefkopf mit Datum, Anrede, Betreff
                else if ((feature.title || feature.headline) && (feature.letterhead || feature.titleLine < 12)) {      // eigene Überschrift oben auf dem Blatt
                    fresh = true;
                    // Kann auch die Kopfzeile einer Folgeseite sein („Entlassungsbericht Mustermann“): gleiche Art, sonst kein Zeichen für einen Anfang.
                    weak = !feature.letterhead && feature.start < 2 && feature.key === current.key && !complete(current) && !feature.headDate;
                }
                else if (feature.headDate && current.headDate && feature.headDate !== current.headDate && (feature.title || feature.headline || feature.letterhead)) fresh = true;      // eigenes, anderes Datum im Kopf
                else if (before.open || feature.follows) fresh = false;                      // der Satz geht über die Seitengrenze weiter
                else if (feature.key !== 'sonst' && feature.key !== current.key && feature.score >= 7 && (feature.start >= 2 || feature.score >= 9)) fresh = true;
                else if (complete(current)) fresh = true;                                    // Grußformel oder letzte gezählte Seite war schon da
                else if (best < 2 && current.key !== 'sonst') fresh = true;                  // passt zu nichts: eigenes Blatt unter „Sonstiges“
                else {
                    fresh = false;
                    // Folgeseite ohne klaren Hinweis: lieber noch einmal ansehen lassen.
                    unsure = !feature.counter && (feature.start >= 3 || (feature.key !== 'sonst' && feature.key !== current.key));
                }
            }
            if (fresh) { current = { pages: [], key: feature.key, lastCounter: null, closed: false, unsure: false, weak, headDate: feature.headDate || '' }; groups.push(current); }
            current.pages.push(index);
            if (feature.counter) current.lastCounter = feature.counter;
            if (feature.closing) current.closed = true;
            if (unsure) current.unsure = true;
        });

        const documents = groups.map(group => ({ pages: group.pages, ...describe(group.pages.map(index => pages[index].text || ''), { today, directory, features: group.pages.map(index => features[index]), unsure: group.unsure, weak: group.weak }) }));
        return { documents, blanks, features };
    }

    // ---------- Vorder- und Rückseiten getrennt gescannt ----------
    // Erst alle Vorderseiten, dann alle Rückseiten (gleich viele). Ergebnis: die Reihenfolge Blatt für Blatt – Vorderseite 1,
    // Rückseite 1, Vorderseite 2 … Die Rückseiten liegen entweder in derselben Reihenfolge (Rückseite 17 gehört zu Vorderseite 17)
    // oder umgekehrt (der Stapel wurde im Ganzen gewendet). reverse: true | false | null = selbst erkennen (Seitenzähler, Satz
    // geht weiter, Grußformel und Unterschrift auf der Rückseite).
    // pages: [{ text, blank }]. Ergebnis: { order: [Nummern], backs: Set der Rückseiten (Stelle in order), reversed, sure } oder null.
    function duplexOrder(pages, { reverse = null } = {}) {
        const total = pages.length, half = total / 2;
        if (!total || total % 2) return null;
        const features = pages.map(page => page.blank ? { blank: true } : analysePage(page.text, { qr: page.qr }));
        const fit = backAt => {
            let sum = 0;
            for (let sheet = 0; sheet < half; sheet += 1) {
                const front = features[sheet], back = features[half + backAt(sheet)];
                if (front.blank || back.blank) continue;
                if (front.counter && back.counter) sum += back.counter.page === front.counter.page + 1 && (!front.counter.total || !back.counter.total || front.counter.total === back.counter.total) ? 4 : -3;
                if (front.open && back.follows) sum += 2;
                if (!front.closing && back.closing && back.key === front.key) sum += 1;
                if (back.key !== 'sonst' && back.key === front.key) sum += 0.5;
            }
            return sum;
        };
        const same = fit(sheet => sheet), turned = fit(sheet => half - 1 - sheet);
        const reversed = reverse == null ? turned > same + 1.5 : Boolean(reverse);
        const order = [], backs = new Set();
        for (let sheet = 0; sheet < half; sheet += 1) { order.push(sheet); backs.add(order.length); order.push(half + (reversed ? half - 1 - sheet : sheet)); }
        return { order, backs, reversed, sure: Math.abs(same - turned) > 1.5, scores: { same, turned } };
    }

    // ---------- Gelerntes: was das Büro bestätigt oder verbessert hat, gilt für die nächsten Akten ----------
    // Merkmal eines Schriftstücks = die Wörter aus seinem Kopf (Name der Klinik oder Praxis, Überschrift des Formulars) – ohne Zahlen,
    // ohne den Namen des Patienten (exclude) und ohne Allerweltswörter. Daran wird dieselbe Art von Schriftstück wiedererkannt.
    const LEARN_STOP = new Set(['und', 'der', 'die', 'das', 'fur', 'von', 'mit', 'den', 'dem', 'des', 'im', 'in', 'am', 'an', 'zu', 'zur', 'zum', 'tel', 'telefon', 'fax', 'www', 'email', 'mail', 'herr', 'herrn', 'frau', 'geb', 'geboren', 'datum', 'seite', 'patient', 'patientin', 'name', 'vorname', 'strasse', 'str', 'de', 'com', 'http', 'https', 'the', 'and', 'of']);
    function signatureOf(text, exclude = []) {
        const skip = new Set((Array.isArray(exclude) ? exclude : [exclude]).flatMap(item => fold(item).split(/[^a-z]+/)).filter(word => word.length >= 3));
        const words = [];
        // Nur der Kopf des Blattes (Klinik, Praxis, Überschrift des Formulars) – keine Anschrift- oder Namenszeilen.
        // Der Kopf endet an der ersten Zeile mit Angaben zur Person (Anschrift, „Patient:“, Geburtsdatum) – höchstens vier Zeilen.
        const personal = line => /^\s*(herrn?|frau|patient(in)?|name|vorname|nachname|geb\.?|geboren|an|z\. ?hd\.?|familie|sehr geehrte|liebe[r]?)\b/i.test(line) || /geb\.|\d{4}/.test(line);
        const head = [];
        linesOf(text).slice(0, 8).some(line => { if (personal(line)) return head.length > 0; head.push(line); return head.length >= 4; });
        head.forEach(line => {
            fold(line).split(/[^a-z]+/).forEach(word => { if (word.length >= 4 && !LEARN_STOP.has(word) && !skip.has(word) && !words.includes(word)) words.push(word); });
        });
        return words.slice(0, 14);
    }
    // Bestes gelerntes Beispiel zum Kopf eines Schriftstücks: Anteil der gelernten Wörter, die wieder oben auf dem Blatt stehen.
    // memory: [{ words: [], key, doctor, specialty, fixed, count }]. Ergebnis: das Beispiel (mit share) oder null.
    function recall(text, memory, { least = 0.72 } = {}) {
        const top = new Set(fold(linesOf(text).slice(0, 12).join(' ')).split(/[^a-z]+/).filter(word => word.length >= 4));
        let best = null;
        (Array.isArray(memory) ? memory : []).forEach(item => {
            const words = Array.isArray(item?.words) ? item.words : [];
            if (words.length < 3) return;
            const share = words.filter(word => top.has(word)).length / words.length;
            if (share >= least && (!best || share > best.share || (share === best.share && (item.count || 0) > (best.count || 0)))) best = { ...item, share };
        });
        return best;
    }
    // Ein bestätigtes Schriftstück ins Gedächtnis aufnehmen (ohne Daten des Patienten). Gleiche Köpfe werden zusammengelegt;
    // es bleiben höchstens 300 Beispiele (die am längsten nicht mehr gesehenen fallen weg).
    function learn(memory, { text, key, doctor = '', specialty = '', fixed = false, exclude = [], day = '' }) {
        const list = (Array.isArray(memory) ? memory : []).filter(item => Array.isArray(item?.words));
        const words = signatureOf(text, exclude);
        if (words.length < 3 || !byKey(key) || byKey(key).key !== key) return list;
        const same = list.find(item => item.words.filter(word => words.includes(word)).length / Math.max(item.words.length, words.length) >= 0.8);
        if (same) {
            // Hat das Büro die Art von Hand gesetzt, gilt das – eine bloße Bestätigung überschreibt keine Verbesserung von Hand.
            if (fixed || !same.fixed || same.key === key) { same.key = key; same.fixed = Boolean(fixed || (same.fixed && same.key === key)); }
            if (doctor) same.doctor = doctor;
            if (specialty) same.specialty = specialty;
            same.count = (same.count || 1) + 1;
            same.day = day || same.day || '';
        } else list.push({ words, key, doctor, specialty, fixed: Boolean(fixed), count: 1, day });
        return list.sort((left, right) => String(right.day || '').localeCompare(String(left.day || ''))).slice(0, 300);
    }

    // Überschrift, an der man das Schriftstück in der Akte erkennt: „Arztbericht · Prof. Dr. Goldbach · Neurochirurgie“.
    function titleOf(document) {
        const kind = byKey(document.key) || byKind(document.kind);
        const label = (kind?.key === 'sonst' && document.heading) || kind?.label || document.kind || 'Unterlage';
        return [label, document.doctor, document.specialty && !label.includes(document.specialty) ? document.specialty : ''].filter(Boolean).join(' · ');
    }

    // Ordnen: 'datum' (neueste zuerst, ohne Datum am Ende) | 'fach' (Fachrichtung A–Z) | 'arzt' (Nachname A–Z).
    const surname = doctor => fold(doctor).replace(/\b(prof|dr|med|dent|pd)\b\.?/g, ' ').trim().split(/\s+/).pop() || '';
    function sortDocuments(documents, by = 'datum') {
        const dated = (left, right) => (right.date || '').localeCompare(left.date || '') || String(left.title || '').localeCompare(String(right.title || ''), 'de');
        const text = (left, right, pick) => { const a = pick(left), b = pick(right); return (a ? 0 : 1) - (b ? 0 : 1) || a.localeCompare(b, 'de'); };
        return [...documents].sort((left, right) => by === 'fach' ? text(left, right, item => fold(item.specialty)) || dated(left, right)
            : by === 'arzt' ? text(left, right, item => surname(item.doctor)) || dated(left, right) : ((left.date ? 0 : 1) - (right.date ? 0 : 1)) || dated(left, right));
    }

    return { duplexOrder, signatureOf, recall, learn, codeCues, KINDS, GROUPS, byKey, byKind, fold, counterOf, analysePage, datesOf, dateOf, appointmentOf, headDateOf, doctorsOf, specialtiesOf, headingOf, describe, sortPages, titleOf, sortDocuments, surname };
})();

if (typeof window !== 'undefined') window.AkteLogic = AkteLogic;
if (typeof module !== 'undefined') module.exports = AkteLogic;
