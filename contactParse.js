// Kontaktangaben eines Patienten auswerten – gemeinsam für Einsatzleitung (Auftragstext) und Portal (Auftragskarte).
//
// In der Terminliste stehen Adresse und Telefonnummern oft in EINEM Feld („Anschrift Deutschland“), frei getippt und
// über mehrere Zeilen, zum Beispiel:
//     Bonn, Musterweg 3
//     0097430001234 wats0097455512345
// Hier wird daraus: die Adresse („Bonn, Musterweg 3“ – fürs Öffnen in der Karte) und jede Telefonnummer einzeln
// (zum Antippen), mit Vermerk „WhatsApp“ oder einem kurzen Zusatz wie „Vater“.
// Wichtig: Die Hausnummer gehört zur Adresse – auch wenn die Telefonnummer ohne Abstand dahinter steht.
(function (root) {
    'use strict';

    // Zeilenumbrüche aus Excel/FileMaker kommen als einzelnes CR (\r) an; manche Browser zeigen es gar nicht an,
    // dann kleben „3“ und „0097…“ zusammen. Alles wird zu einem normalen Zeilenumbruch.
    const BREAKS = /\r\n?|[\u000b\u000c\u0085\u2028\u2029]/g;
    const normalizeLineBreaks = value => String(value ?? '').replace(BREAKS, '\n');
    // Ein Feld in EINE Zeile bringen (z. B. der Name einer Praxis, der in der Liste über zwei Zeilen geht):
    // aus dem Umbruch wird „, “ – sonst kleben die Teile auf manchen Handys zusammen.
    const singleLine = value => normalizeLineBreaks(value).replace(/\s*\n+\s*/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '').replace(/,(?:\s*,)+/g, ',');

    const digitCount = text => (String(text).match(/\d/g) || []).length;
    const LETTERS = 'A-Za-zÄÖÜäöüßÀ-ÿ';
    const isWord = token => new RegExp(`^[${LETTERS}][${LETTERS}.'’-]*[.:,;]?$`).test(token);
    // wats, whats, WhatsApp, Watsapp, WA, W.A. …
    const isWhatsAppWord = token => /^w(?:h?ats?(?:app?|up)?|\.?a\.?)(?:[-\s]?(?:nr|nummer))?$/i.test(String(token).replace(/^[([{]+|[)\]}.:,;]+$/g, ''));
    // Wörter ohne eigene Aussage zwischen oder vor Nummern
    const isFiller = token => /^(?:[-–—\/|,;.:+&]+|oder|und|or|and|bzw\.?|tel\.?:?|telefon:?|telefonnr\.?:?|handy:?|handynr\.?:?|mobil:?|mobile:?|mob\.?:?|nr\.?:?|nummer:?|rufnummer:?|phone:?|nur)$/i.test(token);
    const cleanNote = text => String(text || '').replace(/^[\s([{:,;–—-]+|[\s)\]}:,;–—-]+$/g, '').replace(/\s{2,}/g, ' ').trim();

    // Eine Zeile in Stücke teilen. Zusammengeklebtes wird vorher getrennt:
    //   „wats0097455512345“ → „wats“ + Nummer,  „0097455512345wats“ → Nummer + „wats“,
    //   „Musterweg 30097430001234“ → Hausnummer „3“ + Nummer „0097430001234“,
    //   „0097430001234+0097455512345“ und „Hotel -01761234567“ → Plus und Strich sind nur Trenner.
    function tokens(line) {
        const spaced = String(line)
            .replace(new RegExp(`([${LETTERS}.:])((?:\\+|00)?\\d{7,})`, 'g'), '$1 $2')
            .replace(new RegExp(`(\\d{7,})([${LETTERS}])`, 'g'), '$1 $2')
            .replace(/(\d{7,})\+(?=0\d{6,})/g, '$1 + ')
            .replace(/(\d{7,})\+(?=[1-9]\d{7,})/g, '$1 +')
            .replace(/(^|[\s,;(])[-–—]+(?=\+?\d{7,})/g, '$1- ')
            .replace(/\s*([,;|])\s*/g, '$1 ')
            .replace(/(\d)\s*[–—]\s*(?=[\d+(])/g, '$1 - ');
        const list = spaced.split(/\s+/).filter(Boolean);
        const out = [];
        list.forEach(token => {
            const bare = token.replace(/[,;.]+$/, '');
            const glued = bare.match(/^([1-9]\d{0,3})(00[1-9]\d{9,12})$/);
            // Hausnummer + Auslandsnummer ohne Abstand – nur wenn davor ein Wort (die Straße) steht.
            if (glued && isWord(out[out.length - 1] || '')) { out.push(glued[1], glued[2]); return; }
            out.push(token);
        });
        return out;
    }

    const stripEnds = token => String(token).replace(/^[([{]+/, '').replace(/[)\]},;.:]+$/, '');
    // Beginn einer Telefonnummer: +49…, 0049…, 0228…, 0170…, (0228) … – oder eine lange Ziffernfolge ohne Null vorn.
    function isPhoneStart(token) {
        const bare = stripEnds(token);
        if (/^\+\d[\d\/-]*$/.test(bare)) return true;
        if (/^0\d[\d\/-]*$/.test(bare) && digitCount(bare) >= 3) return true;
        return /^\d{8,15}$/.test(bare);
    }
    const isDigitGroup = token => /^\d[\d\/-]*$/.test(stripEnds(token)) && digitCount(token) >= 2;
    const isStrongStart = token => /^(?:\+|00)\d/.test(stripEnds(token));
    function validPhone(text) {
        const bare = String(text).replace(/[^\d+]/g, '');
        const count = digitCount(bare);
        if (count > 16) return false;
        if (/^(?:\+|0)/.test(bare)) return count >= 7;
        return count >= 8;
    }

    // Eine Zeile lesen: Text vor der ersten Nummer, dann die Nummern – jeweils mit dem Text, der zu ihnen gehört.
    // In der Terminliste steht ein Vermerk HINTER seiner Nummer („0097… wats“, „0097… Tochter“). Text zwischen zwei
    // Nummern gehört deshalb zur Nummer davor. Zwei Ausnahmen:
    //   – die Zeile beginnt selbst mit einer Bezeichnung („Vater 0176… Mutter 0097…“): der Text steht jeweils davor;
    //   – ein Wort mit Doppelpunkt direkt vor einer Nummer („… - Sohn: 0097…“) bezeichnet die folgende Nummer.
    // leadMayBeLabel(wörter): darf der Text am Zeilenanfang eine Bezeichnung sein? (In der ersten Zeile ist er die Adresse.)
    const isSeparator = token => /^[-–—\/|,;+&]+$/.test(token);
    function readLine(line, leadMayBeLabel) {
        const list = tokens(line);
        const lead = [];
        const phones = [];
        let index = 0;
        let between = [];
        const leadIsLabel = () => lead.length > 0 && lead.length <= 3 && !/\d/.test(lead.join(' ')) && leadMayBeLabel(lead);
        const assign = last => {
            if (!between.length) return null;
            const previous = phones[phones.length - 1];
            const words = between;
            between = [];
            if (last) { previous.after.push(...words); return null; }
            const final = words[words.length - 1];
            if (/:$/.test(final) && !isFiller(final)) {
                // Die Bezeichnung reicht zurück bis zum letzten Trennzeichen; ohne Trennzeichen ist es nur das eine Wort.
                let start = words.length - 1;
                for (let position = words.length - 2; position >= 0; position -= 1) {
                    if (isSeparator(words[position]) || /[,;]$/.test(words[position])) { start = position + 1; break; }
                }
                previous.after.push(...words.slice(0, start));
                return words.slice(start);
            }
            if (previous.labelled) {
                // Ein WhatsApp-Vermerk direkt hinter der Nummer gehört trotzdem zu ihr („Vater 0176… wats Mutter 0097…“).
                let cut = 0;
                while (cut < words.length && (isWhatsAppWord(words[cut]) || isFiller(words[cut]))) cut += 1;
                previous.after.push(...words.slice(0, cut));
                return cut < words.length ? words.slice(cut) : null;
            }
            previous.after.push(...words);
            return null;
        };
        while (index < list.length) {
            const token = list[index];
            if (isPhoneStart(token)) {
                // Nummer aufsammeln: weitere Zifferngruppen gehören dazu („0170 1234567“, „+49 170 1234567“).
                const parts = [stripEnds(token)];
                let next = index + 1;
                while (next < list.length) {
                    const candidate = list[next];
                    const current = digitCount(parts.join(''));
                    if (/^[-\/]$/.test(candidate) && next + 1 < list.length && isDigitGroup(list[next + 1]) && current < 7 && !isPhoneStart(list[next + 1])) { next += 1; continue; }
                    if (!isDigitGroup(candidate)) break;
                    if (isStrongStart(candidate) && current >= 7) break;
                    if (/^0\d/.test(stripEnds(candidate)) && current >= 10) break;
                    if (/^01[5-7]\d/.test(stripEnds(candidate)) && current >= 7) break;
                    if (current >= 11 && !/^(?:\+|00)/.test(parts[0])) break;
                    if (current + digitCount(candidate) > 15) break;
                    parts.push(stripEnds(candidate));
                    next += 1;
                }
                const number = parts.join(' ');
                if (validPhone(number)) {
                    const before = phones.length ? assign(false) : null;
                    phones.push({ number, before: before || [], after: [], labelled: phones.length ? Boolean(before && before.length) : leadIsLabel() });
                    index = next;
                    continue;
                }
            }
            // Kein Nummernanfang: Text – vor der ersten Nummer gehört er nach vorn, sonst zu einer Nummer.
            if (!phones.length) lead.push(token); else between.push(token);
            index += 1;
        }
        if (phones.length) assign(true);
        return { lead, phones, leadIsLabel: phones.length > 0 && leadIsLabel() };
    }

    // Text hinter (oder vor) einer Nummer deuten: WhatsApp-Vermerk, kurzer Zusatz („Vater“) oder gar nichts.
    function describe(words) {
        let whatsapp = false;
        const rest = [];
        words.forEach(word => {
            if (isWhatsAppWord(word)) { whatsapp = true; return; }
            if (isFiller(word)) return;
            rest.push(word);
        });
        return { whatsapp, note: cleanNote(rest.join(' ')) };
    }

    const looksLikeStreet = text => new RegExp(`[${LETTERS}]{3,}[.]?\\s*\\d{1,4}\\s?[a-zA-Z]?(?:\\s*[-–]\\s*\\d{1,4})?(?![\\d.])`).test(text)
        || /(?:stra(?:ß|ss)e|str\.|weg|gasse|platz|allee|ring|ufer|damm|chaussee|pfad|hof)\b/i.test(text)
        || /\b\d{5}\s+[A-ZÄÖÜ]/.test(text);
    const trimAddress = text => String(text || '').replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '').replace(/\s{2,}/g, ' ').replace(/\s+,/g, ',').trim();

    // Wörter, die eine Person oder einen Anschluss bezeichnen – am Zeilenanfang vor einer Nummer sind sie keine Adresse.
    const isRoleWord = token => /^(?:vater|mutter|sohn|tochter|bruder|schwester|ehefrau|ehemann|frau|mann|onkel|tante|oma|opa|cousin|cousine|neffe|nichte|begleiter(?:in)?|begleitung|begleitperson|dolmetscher(?:in)?|patient(?:in)?|pat|privat|arbeit)$/i.test(String(token).replace(/[.:,;]+$/, ''));

    // Ort aus einer Zeile VOR der Straße („wohnt in Bonn“, „Köln, Hotel …“) – damit die Karte die richtige Stadt findet.
    const CITIES = ['Bonn', 'Köln', 'Düsseldorf', 'Bad Godesberg', 'Siegburg', 'Troisdorf', 'Sankt Augustin', 'Königswinter', 'Bad Honnef', 'Remagen', 'Bad Neuenahr', 'Ahrweiler', 'Andernach', 'Koblenz', 'Meckenheim', 'Rheinbach', 'Bornheim', 'Wesseling', 'Brühl', 'Hürth', 'Hennef', 'Euskirchen', 'Neuwied', 'Leverkusen', 'Aachen', 'Essen', 'Duisburg', 'Dortmund', 'Frankfurt', 'Mainz', 'Wiesbaden', 'Heidelberg', 'Münster', 'München', 'Berlin', 'Hamburg'];
    const lower = text => String(text || '').toLocaleLowerCase('de-DE');
    const hasCity = text => CITIES.some(city => new RegExp(`(?:^|[^${LETTERS}])${city.replace(/\s+/g, '\\s+')}(?:$|[^${LETTERS}])`, 'i').test(text));
    function cityBefore(context) {
        for (let position = context.length - 1; position >= 0; position -= 1) {
            const text = context[position];
            const named = text.match(new RegExp(`(?:^|[\\s(,])in\\s+((?:Bad\\s+|Sankt\\s+|St\\.\\s*)?[A-ZÄÖÜ][${LETTERS}]+(?:-[A-ZÄÖÜ][${LETTERS}]+)*)`));
            if (named) return named[1];
            const first = CITIES.find(city => new RegExp(`^\\(?${city.replace(/\s+/g, '\\s+')}\\)?(?:\\s*[,;:(–—-]|\\s*$)`, 'i').test(text));
            if (first) return first;
        }
        return '';
    }
    // Nur Straße und Hausnummer („Musterstraße 12“, „An der Allee 1-3“) – ohne Ort, ohne Komma.
    const isBareStreet = text => !/[,;()]/.test(text) && !/\b\d{5}\b/.test(text) && !hasCity(text)
        && new RegExp(`^[${LETTERS}][${LETTERS}.'’-]*(?:\\s+[${LETTERS}][${LETTERS}.'’-]*){0,3}\\.?\\s*\\d{1,4}\\s?[a-zA-Z]?(?:\\s*[-–\\/]\\s*\\d{1,4}\\s?[a-zA-Z]?)?$`).test(text);

    // Freitext aus dem Adressfeld → { address, extra: [weitere Textzeilen], phones: [{ number, whatsapp, note }] }
    function parsePatientContact(value) {
        const lines = normalizeLineBreaks(value).split('\n').map(line => line.trim()).filter(Boolean);
        const chunks = [];          // Textstücke ohne Nummer, in Lesereihenfolge
        const phones = [];
        lines.forEach(line => {
            // Kurzer Text direkt vor einer Nummer ist ein Zusatz zur Nummer („Vater 0176…“) – in der ersten Zeile nur,
            // wenn er eindeutig keine Adresse ist („WhatsApp: 0097…“, „Vater 0176…“); sonst ist er dort die Adresse.
            const mayBeLabel = words => chunks.length > 0 || words.every(word => isWhatsAppWord(word) || isFiller(word) || isRoleWord(word));
            const { lead, phones: found, leadIsLabel } = readLine(line, mayBeLabel);
            const leadText = lead.join(' ');
            const leadInfo = describe(lead);
            if (leadText && !leadIsLabel) chunks.push(trimAddress(leadText));
            found.forEach((phone, position) => {
                const info = describe([...phone.before, ...phone.after]);
                const lineLabel = position === 0 && leadIsLabel ? leadInfo : { whatsapp: false, note: '' };
                phones.push({
                    number: phone.number,
                    whatsapp: info.whatsapp || lineLabel.whatsapp,
                    note: [lineLabel.note, info.note].filter(Boolean).join(', ')
                });
            });
        });
        // Dieselbe Nummer zweimal: nur einmal zeigen, Vermerke zusammenführen.
        const seen = new Map();
        const unique = [];
        phones.forEach(phone => {
            const key = phone.number.replace(/\D/g, '').replace(/^00/, '');
            const known = seen.get(key);
            if (known) {
                known.whatsapp = known.whatsapp || phone.whatsapp;
                if (phone.note && !lower(known.note).includes(lower(phone.note))) known.note = [known.note, phone.note].filter(Boolean).join(', ').slice(0, 60);
                return;
            }
            const entry = { number: phone.number, whatsapp: phone.whatsapp, note: phone.note.slice(0, 60) };
            seen.set(key, entry);
            unique.push(entry);
        });
        const texts = chunks.filter(Boolean);
        // Die Adresse ist das Textstück, das nach Straße und Hausnummer aussieht – sonst das erste.
        const best = texts.findIndex(looksLikeStreet);
        const addressIndex = best >= 0 ? best : 0;
        let address = texts[addressIndex] || '';
        // Steht der Ort nur in der Zeile davor („wohnt in Bonn“ / „Musterstraße 12“), kommt er zur Adresse dazu.
        if (addressIndex > 0 && isBareStreet(address)) {
            const city = cityBefore(texts.slice(0, addressIndex));
            if (city) address = `${address}, ${city}`;
        }
        return { address, extra: texts.filter((text, position) => position !== addressIndex), phones: unique };
    }

    // Inhalt einer Telefon-Zeile des Auftragstextes: „0097455512345 (WhatsApp, Vater)“ oder mehrere Nummern.
    function parsePhones(value) {
        const text = normalizeLineBreaks(value).replace(/\n+/g, ' ; ');
        const tagged = text.match(/^(.*?\d)\s*\(([^()]*)\)\s*$/);
        if (tagged && !/[;|]/.test(tagged[1])) {
            const base = parsePatientContact(tagged[1]).phones;
            if (base.length === 1) {
                const tags = tagged[2].split(/\s*,\s*/).filter(Boolean);
                const whatsapp = tags.some(isWhatsAppWord);
                return [{ number: base[0].number, whatsapp: whatsapp || base[0].whatsapp, note: cleanNote(tags.filter(tag => !isWhatsAppWord(tag)).join(', ')) || base[0].note }];
            }
        }
        const parsed = parsePatientContact(text.replace(/[;|]/g, '\n'));
        return parsed.phones;
    }

    // Nummer für einen WhatsApp-Link (https://wa.me/…): Auslandsnummern, deutsche Handynummern und katarische Nummern.
    function whatsappNumber(number) {
        const bare = String(number || '').replace(/[^\d+]/g, '');
        let digits = '';
        if (bare.startsWith('+')) digits = bare.slice(1);
        else if (bare.startsWith('00')) digits = bare.slice(2);
        else if (/^01[5-7]\d{7,10}$/.test(bare)) digits = `49${bare.slice(1)}`;
        else if (/^974[3-7]\d{7}$/.test(bare)) digits = bare;
        else if (/^[3567]\d{7}$/.test(bare)) digits = `974${bare}`;
        digits = digits.replace(/\D/g, '');
        // Deutsche Nummern nur, wenn es Handynummern sind (015x, 016x, 017x) – ein Festnetzanschluss hat kein WhatsApp.
        if (digits.startsWith('49') && !/^491[5-7]/.test(digits)) return '';
        return digits.length >= 9 && digits.length <= 15 && !digits.startsWith('0') ? digits : '';
    }
    const isQatarNumber = number => /^974\d{8}$/.test(whatsappNumber(number));
    const dialNumber = number => String(number || '').replace(/[^\d+]/g, '');

    // Suchtext für die Karte: ohne Datumsangaben und Füllwörter („ab 01.10.25 neue Adresse: …“, „wohnt in …“).
    // Straßennamen wie „Neue Straße“ oder „Am Hof“ bleiben unberührt.
    function mapQuery(address) {
        return String(address || '')
            .replace(/(^|[\s,(])(?:ab|seit|bis|vom|am|zum)\s+(?=\d{1,2}\.\d{1,2}\.)/gi, '$1')
            .replace(/(^|[\s,(])\d{1,2}\.\d{1,2}\.(?:\d{2,4})?(?!\d)/g, '$1')
            .replace(/(^|[\s,(])(?:neue[rs]?\s+)?(?:adresse|anschrift)\s*:?(?=$|[\s,)])/gi, '$1')
            .replace(/(^|[\s,(])(?:wohnt|wohnen|wohnte|wohnhaft)(?:\s+(?:in|im|bei))?\s*:?(?=$|[\s,)])/gi, '$1')
            .replace(/(^|[\s,(])(?:jetzt|aktuell|zurzeit|derzeit)\s*:?(?=$|[\s,)])/gi, '$1')
            .replace(/(^|[\s,(])neu\s*:/gi, '$1')
            .replace(/[()]/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .replace(/\s+,/g, ',')
            .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
            .replace(/^(?:in|im|bei)\s+/i, '')
            .trim();
    }

    // Eine Telefon-Zeile für den Auftragstext: Nummer, dahinter in Klammern „WhatsApp“ und/oder der Zusatz.
    function formatPhone(phone) {
        const tags = [phone.whatsapp ? 'WhatsApp' : '', phone.note].filter(Boolean);
        return tags.length ? `${phone.number} (${tags.join(', ')})` : phone.number;
    }

    const api = { normalizeLineBreaks, singleLine, parsePatientContact, parsePhones, whatsappNumber, isQatarNumber, dialNumber, mapQuery, formatPhone };
    root.TerminContact = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
