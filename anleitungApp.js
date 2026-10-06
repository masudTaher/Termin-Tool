// Kurzanleitung für das Dolmetscher-Portal – Deutsch und Arabisch.
// Die Texte stehen hier; [[…]] kennzeichnet den Namen einer Schaltfläche, so wie sie im Portal heißt.
// Sprache: ?sprache=ar | ?sprache=de, sonst die zuletzt gewählte, sonst die Sprache des Geräts.
(function () {
    const IMAGE_PATH = 'anleitung/';
    const PORTAL_URL = 'https://masudtaher.github.io/Termin-Tool/portal.html';
    const STORE_KEY = 'terminTool.guide.lang';

    const GUIDE = {
        de: {
            dir: 'ltr',
            pageTitle: 'Kurzanleitung · Dolmetscher-Portal',
            name: 'Dolmetscher-Portal',
            kicker: 'Kurzanleitung',
            title: 'In 5 Minuten startklar',
            lead: 'Alles Wichtige auf dem Handy: Auto, Aufträge, Unterlagen, Arbeitstage und Belege.',
            org: ['Botschaft Katar · Medical Office Bonn', 'Abteilung Transport und Dolmetscher'],
            orgOther: 'المكتب الصحي القطري في مدينة بون',
            orgOtherLang: 'ar',
            openPortal: 'Zum Portal',
            backToPortal: 'Zurück zum Portal',
            print: 'Drucken / als PDF speichern',
            qr: 'Portal öffnen: Code mit der Handy-Kamera scannen',
            contents: 'Inhalt',
            zoomHint: 'Nach links wischen für den nächsten Schritt · Bild antippen = größer',
            zoom: 'Bild größer zeigen',
            close: 'Schließen',
            note: '',
            footer: 'Entwickelt von Abdulrahman Allam',
            sections: [
                { id: 'start', title: 'So startest du', lead: 'Vier Schritte – dann ist dein Konto bereit.', steps: [
                    ['01-anmelden', 'Portal öffnen', 'Tippe auf den Link aus WhatsApp – oder scanne den QR-Code mit der Handy-Kamera.'],
                    ['02-registrieren', 'Neu registrieren', 'Tippe [[Neu registrieren]]. Name, Handynummer, E-Mail und ein eigenes Passwort eintragen. Wähle [[Temporär]] oder [[Fest angestellt]] und [[Dolmetscherin]] oder [[Dolmetscher]].'],
                    ['03-warten', 'Kurz warten', 'Die Einsatzleitung schaltet dein Konto frei. Danach tippst du [[Erneut prüfen]].'],
                    ['19-konto', 'Als App speichern', 'Oben rechts auf deine Initialen tippen: [[Mitteilungen einschalten]] und [[Als App auf das Handy legen]].']
                ] },
                { id: 'startseite', title: 'Deine Startseite', lead: 'Oben steht immer, was gerade auf dich wartet.', steps: [
                    ['04-start', 'Was auf dich wartet', 'Fragen der Einsatzleitung, neue Nachrichten und Aufträge ohne Antwort stehen ganz oben. Antippen genügt.'],
                    ['12e-start-unterwegs', 'Dein Auto, dein Auftrag', 'Hast du ein Auto übernommen, steht es groß auf der Startseite – zusammen mit dem laufenden Auftrag.']
                ], tips: [
                    ['Die Leiste unten', '[[Start]] · [[Aufträge]] · [[Unterlagen]] · [[Arbeitstage]] · [[Abrechnung]]. Fest Angestellte sehen statt der letzten beiden [[Zeiten]] und [[Belege]].']
                ] },
                { id: 'uebernehmen', title: 'Fahrzeug übernehmen', lead: 'Auto wählen, Zustand prüfen, Kilometer eintragen – immer bevor du losfährst.', steps: [
                    ['04d-start-danach', 'Start', 'Auf der Startseite [[Fahrzeug übernehmen]] tippen.'],
                    ['05-auto-waehlen', 'Auto antippen', 'Du siehst nur freie Fahrzeuge – mit Tank und Parkort. Sind viele frei, wählst du zuerst [[Diplomatisch]] oder [[Mietwagen]].'],
                    ['06-zustand', 'Zustand prüfen', 'Alles gut? [[Ja, alles in Ordnung]]. Sonst [[Nein, etwas stimmt nicht]] und kurz beschreiben.'],
                    ['07-kilometer', 'Kilometer eintragen', 'Tacho ablesen, eintragen und [[Fahrzeug übernehmen]] tippen.']
                ] },
                { id: 'rueckgabe', title: 'Unterwegs und Rückgabe', lead: 'Einen Schaden sofort melden. Das Auto am Ende immer zurückgeben.', steps: [
                    ['08-mein-auto', 'Dein Auto', 'Von hier aus: [[Schaden melden]], [[Meldung im Auto]] (Warnlampe, AdBlue, Service) oder [[Fahrzeug zurückgeben]].'],
                    ['09-schaden', 'Schaden melden', 'Stelle in der Skizze antippen, Art wählen, Foto machen – das Foto ist Pflicht.'],
                    ['10b-parkort', 'Zurückgeben', 'Kilometer, Tank, Parkort, Sauberkeit – immer nur eine Frage.'],
                    ['11-rueckgabe-pruefen', 'Prüfen und fertig', 'Stimmt alles? [[Jetzt zurückgeben]] tippen.']
                ], tips: [
                    ['Erinnerung', 'Ist das Auto um 16 Uhr noch nicht zurück, erinnert dich dein Handy.']
                ] },
                { id: 'auftraege', title: 'Aufträge', lead: 'Eine rote Zahl bei [[Aufträge]] heißt: Ein Auftrag wartet auf deine Antwort. Mehrere Aufträge am selben Tag sagst du mit [[Zusage für den ganzen Tag]] auf einmal zu.', steps: [
                    ['12-auftrag-offen', 'Auftrag lesen', 'Patient, Praxis, Adresse und Telefon. [[In Karten öffnen]] zeigt den Weg. Unter jeder Nummer des Patienten: [[Anrufen]] und [[WhatsApp]].'],
                    ['12b-auftrag-antwort', 'Immer antworten', '[[Zusage]], [[Unter Vorbehalt]] oder [[Absage]]. Vertippt? [[Rückgängig]] oder [[Antwort zurücknehmen]]. Einen kurzen Hinweis schickst du mit [[Senden]].'],
                    ['12c-auftrag-zugesagt', 'Losfahren', 'Am Tag des Termins [[Losfahren]] tippen. Das geht erst, wenn du ein Fahrzeug übernommen hast.'],
                    ['12d-auftrag-unterwegs', 'Fertig', 'Nach dem Termin [[Fertig – Auftrag beenden]] tippen. Die Einsatzleitung sieht sofort, dass du wieder frei bist.']
                ] },
                { id: 'unterlagen', title: 'Unterlagen fotografieren', lead: 'Arztbericht, Rezept oder Überweisung – direkt nach dem Termin.', steps: [
                    ['13-unterlagen', 'Starten', '[[Unterlage fotografieren]] unter [[Unterlagen]] – oder [[Unterlagen fotografieren]] direkt am Auftrag.'],
                    ['13c-unterlage-art', 'Art wählen', 'Arztbericht, Rezept (Medikamente, Physiotherapie, Hilfsmittel), Überweisung (Facharzt, Radiologie) oder Sonstiges.'],
                    ['13e-unterlage-seiten', 'Seiten fotografieren', 'Blatt auf einen dunklen Untergrund legen, jede Seite einzeln. Das Portal schneidet den Rand zu und prüft, ob alles lesbar ist.'],
                    ['13f-unterlage-senden', 'Prüfen und senden', '[[Als PDF senden]] tippen. Fehlt eine Seite, sagt dir das Portal vorher Bescheid.']
                ] },
                { id: 'arbeitstage', title: 'Arbeitstage', badge: 'Temporär', lead: 'Sag der Einsatzleitung, wann du arbeiten kannst – ein Tipp pro Tag.', steps: [
                    ['04b-morgen-frage', '„Kannst du morgen arbeiten?“', 'Fragt die Einsatzleitung für morgen an, steht die Frage oben auf der Startseite: [[Ja, ich kann]] oder [[Nein, ich kann nicht]].'],
                    ['14-arbeitstage', 'Tage eintragen', 'Unter [[Arbeitstage]] für jeden Tag [[Kann]] oder [[Kann nicht]] tippen.'],
                    ['14c-wochenplan', 'Wochenplan', 'Jeden Freitag um 15 Uhr fragt das Portal nach der nächsten Woche. Samstag und Sonntag erinnert es noch einmal.'],
                    ['14e-wochenplan-ausgefuellt', 'Nächste Woche', '[[Tage auswählen]] tippen und die Tage antippen. Das dauert eine halbe Minute.']
                ], tips: [
                    ['Wochenende', 'Samstag und Sonntag stehen nur bei Dolmetschern (Männern) zur Auswahl.']
                ] },
                { id: 'zeiten', title: 'Zeiten', badge: 'Fest angestellt', lead: 'Überstunden, Urlaub, Krankheit und Notfall – alles unter [[Zeiten]].', steps: [
                    ['15-ueberstunden', 'Überstunden', 'Arbeitszeit ist 9 bis 16 Uhr. Was davor oder danach liegt, trägst du mit dem Termin ein – das Portal rechnet selbst.'],
                    ['15b-urlaub', 'Urlaub beantragen', 'Im Reiter [[Urlaub · Krank · Notfall]]: [[Urlaub]] wählen, von–bis eintragen, [[Urlaub beantragen]] tippen.'],
                    ['15c-krank', 'Krank oder Notfall', '[[Krank]] oder [[Notfall]] wählen und sofort melden – die Einsatzleitung bekommt eine Mitteilung und kann umplanen.'],
                    ['15d-abwesenheiten-liste', 'Deine Anträge', 'Du siehst den Stand: [[wartet]], [[genehmigt]] oder [[abgelehnt]]. Solange ein Antrag wartet, kannst du ihn zurückziehen.']
                ] },
                { id: 'belege', title: 'Abrechnung und Belege', lead: 'Geparkt oder getankt? Beleg fotografieren – fertig.', steps: [
                    ['16b-abrechnung-mit-beleg', 'Abrechnung', 'Arbeitstage, Sondertage und Belege des Monats. Gibt die Einsatzleitung die Abrechnung frei: prüfen und bestätigen.'],
                    ['17-beleg', 'Beleg einreichen', '[[Beleg einreichen]] tippen und den Beleg fotografieren. Betrag, Datum und Ort liest das Portal aus – bitte kurz prüfen.'],
                    ['20-neu-anfordern-start', '„Bitte neues Foto“', 'Ist ein Foto nicht lesbar, bittet das Büro um ein neues. Die Bitte steht rot oben auf der Startseite.'],
                    ['20b-neu-anfordern', 'Neu fotografieren', 'Die Bitte öffnen, [[Foto aufnehmen]] und dann [[Neues Foto senden]] tippen.']
                ] },
                { id: 'konto', title: 'Nachrichten und Konto', lead: 'Die Glocke oben zeigt Neues von der Einsatzleitung.', steps: [
                    ['18-nachrichten', 'Nachrichten', 'Auf die Glocke tippen. Die rote Zahl zeigt, wie viele Nachrichten neu sind.'],
                    ['19-konto', 'Mein Konto', 'Oben rechts auf deine Initialen: Mitteilungen, App, diese Anleitung, Passwort ändern, Abmelden.']
                ], tips: [
                    ['Passwort vergessen?', 'Auf der Anmeldeseite [[Passwort vergessen?]] tippen. Die Einsatzleitung gibt dir ein neues.', 'warn'],
                    ['iPhone', 'Mitteilungen gehen nur, wenn das Portal als App auf dem Home-Bildschirm liegt.']
                ] }
            ]
        },
        ar: {
            dir: 'rtl',
            pageTitle: 'دليل مختصر · بوابة المترجمين',
            name: 'بوابة المترجمين',
            kicker: 'دليل مختصر',
            title: 'جاهز للعمل في خمس دقائق',
            lead: 'كل ما تحتاجه على جوالك: السيارة، المهام، المستندات، أيام العمل والإيصالات.',
            org: ['المكتب الصحي القطري في مدينة بون', 'قسم النقل والترجمة'],
            orgOther: 'Botschaft Katar · Medical Office Bonn · Abteilung Transport und Dolmetscher',
            orgOtherLang: 'de',
            openPortal: 'فتح البوابة',
            backToPortal: 'العودة إلى البوابة',
            print: 'طباعة / حفظ بصيغة PDF',
            qr: 'لفتح البوابة: امسح الرمز بكاميرا الجوال',
            contents: 'المحتويات',
            zoomHint: 'اسحب جانبًا للخطوة التالية · اضغط على الصورة لتكبيرها',
            zoom: 'تكبير الصورة',
            close: 'إغلاق',
            note: 'واجهة البوابة باللغة الألمانية، لذلك تظهر أسماء الأزرار في هذا الدليل كما هي في التطبيق.',
            footer: 'تطوير: عبدالرحمن علام',
            sections: [
                { id: 'start', title: 'البداية', lead: 'أربع خطوات ويصبح حسابك جاهزًا.', steps: [
                    ['01-anmelden', 'افتح البوابة', 'اضغط على الرابط الذي وصلك عبر الواتساب، أو امسح الرمز المربّع بكاميرا الجوال.'],
                    ['02-registrieren', 'سجّل حسابًا جديدًا', 'اضغط [[Neu registrieren]] وأدخل الاسم ورقم الجوال والبريد الإلكتروني وكلمة مرور خاصة بك. اختر [[Temporär]] (مؤقت) أو [[Fest angestellt]] (دائم)، ثم [[Dolmetscherin]] (مترجمة) أو [[Dolmetscher]] (مترجم).'],
                    ['03-warten', 'انتظر التفعيل', 'تفعّل الإدارة حسابك. بعد ذلك اضغط [[Erneut prüfen]].'],
                    ['19-konto', 'ثبّت البوابة كتطبيق', 'اضغط على الحرفين في أعلى اليمين، ثم [[Mitteilungen einschalten]] لتصلك الإشعارات، و [[Als App auf das Handy legen]] لتثبيت التطبيق.']
                ] },
                { id: 'startseite', title: 'الصفحة الرئيسية', lead: 'في الأعلى يظهر دائمًا ما ينتظر ردّك.', steps: [
                    ['04-start', 'ما ينتظرك', 'أسئلة الإدارة والرسائل الجديدة والمهام التي لم تُجب عنها بعد تظهر في الأعلى. يكفي أن تضغط عليها.'],
                    ['12e-start-unterwegs', 'سيارتك ومهمتك', 'إذا استلمت سيارة ظهرت بوضوح في الصفحة الرئيسية، ومعها المهمة الجارية.']
                ], tips: [
                    ['الشريط السفلي', '[[Start]] البداية · [[Aufträge]] المهام · [[Unterlagen]] المستندات · [[Arbeitstage]] أيام العمل · [[Abrechnung]] الحساب. الموظفون الدائمون يرون بدلًا من الأخيرين [[Zeiten]] الدوام و [[Belege]] الإيصالات.']
                ] },
                { id: 'uebernehmen', title: 'استلام السيارة', lead: 'اختر السيارة، ثم افحص حالتها، ثم أدخل قراءة العدّاد، وذلك قبل كل انطلاق.', steps: [
                    ['04d-start-danach', 'ابدأ', 'في الصفحة الرئيسية اضغط [[Fahrzeug übernehmen]].'],
                    ['05-auto-waehlen', 'اختر السيارة', 'تظهر السيارات المتاحة فقط، مع مستوى الوقود ومكان الوقوف. وإذا كانت السيارات المتاحة كثيرة فاختر أولًا [[Diplomatisch]] (سيارة دبلوماسية) أو [[Mietwagen]] (سيارة مستأجرة).'],
                    ['06-zustand', 'افحص الحالة', 'كل شيء سليم؟ اضغط [[Ja, alles in Ordnung]]. وإن لاحظت شيئًا فاضغط [[Nein, etwas stimmt nicht]] واكتبه باختصار.'],
                    ['07-kilometer', 'قراءة العدّاد', 'اقرأ عدّاد الكيلومترات وأدخل الرقم، ثم اضغط [[Fahrzeug übernehmen]].']
                ] },
                { id: 'rueckgabe', title: 'أثناء العمل وإرجاع السيارة', lead: 'أبلغ عن أي ضرر فورًا، وأرجع السيارة دائمًا في نهاية العمل.', steps: [
                    ['08-mein-auto', 'سيارتك', 'من هنا: [[Schaden melden]] للإبلاغ عن ضرر، [[Meldung im Auto]] عند ظهور إشارة تحذير، [[Fahrzeug zurückgeben]] لإرجاع السيارة.'],
                    ['09-schaden', 'الإبلاغ عن ضرر', 'حدّد الموضع على المخطط، اختر نوع الضرر، والتقط صورة. الصورة إلزامية.'],
                    ['10b-parkort', 'الإرجاع', 'العدّاد، ثم الوقود، ثم مكان الوقوف، ثم النظافة. سؤال واحد في كل مرة.'],
                    ['11-rueckgabe-pruefen', 'راجع ثم أرسل', 'إذا كانت البيانات صحيحة فاضغط [[Jetzt zurückgeben]].']
                ], tips: [
                    ['تذكير', 'إذا لم تُرجَع السيارة حتى الساعة الرابعة عصرًا يصلك تذكير على جوالك.']
                ] },
                { id: 'auftraege', title: 'المهام', lead: 'الرقم الأحمر عند [[Aufträge]] يعني أن مهمة تنتظر ردّك. وإذا كانت لديك عدة مهام في اليوم نفسه فاضغط [[Zusage für den ganzen Tag]] للموافقة عليها دفعة واحدة.', steps: [
                    ['12-auftrag-offen', 'اقرأ المهمة', 'اسم المريض والعيادة والعنوان وأرقام الهاتف. اضغط [[In Karten öffnen]] لفتح الخريطة. وتحت كل رقم للمريض زرّان: [[Anrufen]] للاتصال و[[WhatsApp]] للمحادثة.'],
                    ['12b-auftrag-antwort', 'أجب دائمًا', '[[Zusage]] موافقة، [[Unter Vorbehalt]] موافقة بتحفّظ، [[Absage]] اعتذار. ضغطت بالخطأ؟ اضغط [[Rückgängig]] أو [[Antwort zurücknehmen]]. ولإرسال ملاحظة قصيرة اكتبها ثم اضغط [[Senden]].'],
                    ['12c-auftrag-zugesagt', 'عند الانطلاق', 'في يوم الموعد اضغط [[Losfahren]]. لا يعمل الزر إلا بعد استلام سيارة.'],
                    ['12d-auftrag-unterwegs', 'عند الانتهاء', 'بعد الموعد اضغط [[Fertig – Auftrag beenden]]، فتعرف الإدارة فورًا أنك أصبحت متاحًا.']
                ] },
                { id: 'unterlagen', title: 'تصوير المستندات', lead: 'التقرير الطبي أو الوصفة أو الإحالة، مباشرةً بعد الموعد.', steps: [
                    ['13-unterlagen', 'ابدأ', 'اضغط [[Unterlage fotografieren]] في قسم [[Unterlagen]]، أو [[Unterlagen fotografieren]] في بطاقة المهمة.'],
                    ['13c-unterlage-art', 'اختر النوع', 'تقرير طبي، وصفة (أدوية، علاج طبيعي، مستلزمات طبية)، إحالة (طبيب مختص، أشعة)، أو غير ذلك.'],
                    ['13e-unterlage-seiten', 'صوّر الصفحات', 'ضع الورقة على سطح داكن وصوّر كل صفحة على حدة. تقصّ البوابة الحواف وتتحقق من وضوح الصورة.'],
                    ['13f-unterlage-senden', 'راجع وأرسل', 'اضغط [[Als PDF senden]]. وإذا نقصت صفحة نبّهتك البوابة قبل الإرسال.']
                ] },
                { id: 'arbeitstage', title: 'أيام العمل', badge: 'للمؤقتين', lead: 'أخبر الإدارة متى تستطيع العمل. ضغطة واحدة لكل يوم.', steps: [
                    ['04b-morgen-frage', 'هل تستطيع العمل غدًا؟', 'عندما تسأل الإدارة عن يوم الغد يظهر السؤال أعلى الصفحة الرئيسية: [[Ja, ich kann]] نعم، أو [[Nein, ich kann nicht]] لا.'],
                    ['14-arbeitstage', 'حدّد أيامك', 'في [[Arbeitstage]] اضغط لكل يوم [[Kann]] أستطيع، أو [[Kann nicht]] لا أستطيع.'],
                    ['14c-wochenplan', 'خطة الأسبوع', 'كل يوم جمعة في الثالثة عصرًا تسألك البوابة عن الأسبوع القادم، وتذكّرك مرة أخرى يومي السبت والأحد.'],
                    ['14e-wochenplan-ausgefuellt', 'الأسبوع القادم', 'اضغط [[Tage auswählen]] ثم حدّد أيامك. لا يستغرق ذلك أكثر من نصف دقيقة.']
                ], tips: [
                    ['نهاية الأسبوع', 'يُعرض يوما السبت والأحد على المترجمين الرجال فقط.']
                ] },
                { id: 'zeiten', title: 'الدوام', badge: 'للدائمين', lead: 'العمل الإضافي والإجازة والمرض والطوارئ، كلها في [[Zeiten]].', steps: [
                    ['15-ueberstunden', 'العمل الإضافي', 'الدوام من التاسعة صباحًا إلى الرابعة عصرًا. ما كان قبل ذلك أو بعده تسجّله مع الموعد، والبوابة تحسب المدة.'],
                    ['15b-urlaub', 'طلب إجازة', 'في [[Urlaub · Krank · Notfall]] اختر [[Urlaub]] وحدّد تاريخ البداية والنهاية، ثم اضغط [[Urlaub beantragen]].'],
                    ['15c-krank', 'مرض أو طارئ', 'أبلغ فورًا عبر [[Krank]] أو [[Notfall]]. يصل الإدارة إشعار لتعيد توزيع المواعيد.'],
                    ['15d-abwesenheiten-liste', 'طلباتك', 'ترى حالة كل طلب: [[wartet]] قيد الانتظار، [[genehmigt]] مقبول، [[abgelehnt]] مرفوض. ويمكنك سحب الطلب ما دام قيد الانتظار.']
                ] },
                { id: 'belege', title: 'الحساب الشهري والإيصالات', lead: 'دفعت رسوم موقف أو ثمن وقود؟ يكفي أن تصوّر الإيصال.', steps: [
                    ['16b-abrechnung-mit-beleg', 'كشف الحساب', 'أيام العمل والأيام الخاصة والإيصالات لكل شهر. عندما تعتمد الإدارة الكشف راجعه ثم أكّده.'],
                    ['17-beleg', 'إرسال إيصال', 'اضغط [[Beleg einreichen]] وصوّر الإيصال. تقرأ البوابة المبلغ والتاريخ والمكان، فراجعها قبل الإرسال.'],
                    ['20-neu-anfordern-start', 'طلب صورة جديدة', 'إذا لم تكن الصورة واضحة طلب المكتب صورة جديدة. يظهر الطلب بالأحمر أعلى الصفحة الرئيسية.'],
                    ['20b-neu-anfordern', 'صوّر من جديد', 'افتح الطلب، ثم اضغط [[Foto aufnehmen]] وبعدها [[Neues Foto senden]].']
                ] },
                { id: 'konto', title: 'الرسائل والحساب', lead: 'الجرس في الأعلى يُظهر الجديد من الإدارة.', steps: [
                    ['18-nachrichten', 'الرسائل', 'اضغط على الجرس. الرقم الأحمر يبيّن عدد الرسائل الجديدة.'],
                    ['19-konto', 'حسابي', 'اضغط على الحرفين في أعلى اليمين: الإشعارات، تثبيت التطبيق، هذا الدليل، تغيير كلمة المرور، تسجيل الخروج.']
                ], tips: [
                    ['نسيت كلمة المرور؟', 'في صفحة الدخول اضغط [[Passwort vergessen?]]، وستعطيك الإدارة كلمة مرور جديدة.', 'warn'],
                    ['آيفون', 'لا تصل الإشعارات إلا إذا كانت البوابة مثبّتة كتطبيق على الشاشة الرئيسية.']
                ] }
            ]
        }
    };

    const $ = id => document.getElementById(id);
    const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node; };

    // Text mit [[Schaltflächen-Namen]]: der Name wird als eigenes, deutsches Stück gesetzt (auch mitten im arabischen Satz).
    function rich(node, text) {
        String(text).split(/(\[\[.+?\]\])/).forEach(part => {
            if (!part) return;
            if (part.startsWith('[[')) {
                const label = el('bdi', 'ui', part.slice(2, -2));
                label.lang = 'de';
                label.dir = 'ltr';
                node.append(label);
            } else node.append(document.createTextNode(part));
        });
        return node;
    }

    function pickLanguage() {
        const wanted = new URLSearchParams(location.search).get('sprache');
        if (GUIDE[wanted]) return wanted;
        try { const saved = localStorage.getItem(STORE_KEY); if (GUIDE[saved]) return saved; } catch (error) { /* ohne Speicher geht es auch */ }
        return String(navigator.language || '').toLowerCase().startsWith('ar') ? 'ar' : 'de';
    }

    let lang = pickLanguage();

    function render() {
        const text = GUIDE[lang];
        const root = document.documentElement;
        root.lang = lang;
        root.dir = text.dir;
        document.title = text.pageTitle;
        $('guideName').textContent = text.name;
        $('guideKickerTop').textContent = text.kicker;
        $('guideOpenText').textContent = text.openPortal;
        document.querySelector('.guide-brand').title = text.backToPortal;
        document.querySelector('.guide-brand').setAttribute('aria-label', `${text.backToPortal} · ${text.name}`);
        document.querySelectorAll('[data-lang]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.lang === lang)));

        const main = $('guide');
        main.replaceChildren();

        // Titel
        const hero = el('section', 'guide-hero');
        const copy = el('div');
        const org = el('p', 'guide-org');
        const other = el('span', 'guide-org-other', text.orgOther);
        other.lang = text.orgOtherLang;
        other.dir = text.orgOtherLang === 'ar' ? 'rtl' : 'ltr';
        text.org.forEach(line => org.append(el('span', '', line)));
        org.append(other);
        const buttons = el('div', 'guide-hero-buttons');
        const open = el('a', 'guide-button', text.openPortal);
        open.href = 'portal.html';
        const print = el('button', 'guide-button is-light', text.print);
        print.type = 'button';
        print.addEventListener('click', () => window.print());
        buttons.append(open, print);
        copy.append(el('p', 'guide-kicker', `${text.name} · ${text.kicker}`), el('h1', '', text.title), el('p', 'guide-lead', text.lead), org, buttons);
        const qr = el('div', 'guide-qr');
        const qrImage = el('img');
        qrImage.src = `${IMAGE_PATH}qr-portal.svg`;
        qrImage.alt = text.qr;
        qrImage.width = 160;
        qrImage.height = 160;
        qr.append(qrImage, el('strong', '', text.qr), el('small', '', PORTAL_URL.replace('https://', '')));
        hero.append(copy, qr);
        main.append(hero);
        if (text.note) main.append(el('p', 'guide-note', text.note));

        // Inhalt
        const nav = el('nav', 'guide-contents');
        nav.setAttribute('aria-label', text.contents);
        const navList = el('ol');
        text.sections.forEach((section, index) => {
            const item = el('li');
            const link = el('a');
            link.href = `#${section.id}`;
            link.append(el('b', '', String(index + 1)), document.createTextNode(section.title));
            item.append(link);
            navList.append(item);
        });
        nav.append(navList);
        main.append(nav);

        // Abschnitte
        text.sections.forEach((section, index) => {
            const box = el('section', 'guide-section');
            box.id = section.id;
            const head = el('div', 'guide-section-head');
            const title = el('h2', '', section.title);
            if (section.badge) title.append(el('span', 'guide-badge', section.badge));
            head.append(el('span', 'guide-nr', String(index + 1)), title);
            box.append(head, rich(el('p', 'guide-section-lead'), section.lead));
            if (index === 0) box.append(el('p', 'guide-zoom-hint', text.zoomHint));
            const steps = el('ol', 'guide-steps');
            section.steps.forEach(([image, stepTitle, stepText], stepIndex) => {
                const step = el('li', 'guide-step');
                const shot = el('button', 'guide-shot');
                shot.type = 'button';
                shot.setAttribute('aria-label', `${text.zoom}: ${stepTitle}`);
                const picture = el('img');
                picture.src = `${IMAGE_PATH}${image}.webp`;
                picture.alt = '';
                picture.width = 390;
                picture.height = 800;
                picture.loading = index < 2 ? 'eager' : 'lazy';
                picture.decoding = 'async';
                shot.append(picture);
                shot.addEventListener('click', () => zoom(picture.src, stepTitle));
                const copyBox = el('div', 'guide-step-text');
                copyBox.append(el('span', 'guide-step-nr', String(stepIndex + 1)), el('h3', '', stepTitle), rich(el('p'), stepText));
                step.append(shot, copyBox);
                steps.append(step);
            });
            box.append(steps);
            if (section.tips?.length) {
                const tips = el('div', 'guide-tips');
                section.tips.forEach(([tipTitle, tipText, kind]) => {
                    const tip = el('p', `guide-tip${kind === 'warn' ? ' is-warn' : ''}`);
                    tip.append(el('strong', '', tipTitle), rich(el('span'), tipText));
                    tips.append(tip);
                });
                box.append(tips);
            }
            main.append(box);
        });

        // Fuß
        const foot = el('footer', 'guide-foot');
        const footButtons = el('div', 'guide-foot-buttons');
        const openAgain = el('a', 'guide-button', text.openPortal);
        openAgain.href = 'portal.html';
        const printAgain = el('button', 'guide-button is-quiet', text.print);
        printAgain.type = 'button';
        printAgain.addEventListener('click', () => window.print());
        footButtons.append(openAgain, printAgain);
        const footOther = el('span', '', text.orgOther);
        footOther.lang = text.orgOtherLang;
        footOther.dir = text.orgOtherLang === 'ar' ? 'rtl' : 'ltr';
        foot.append(footButtons, el('span', '', text.org.join(' · ')), footOther, el('span', '', text.footer));
        main.append(foot);

        $('guideZoomClose').textContent = text.close;
    }

    function zoom(source, title) {
        const dialog = $('guideZoom');
        if (typeof dialog.showModal !== 'function') return;
        $('guideZoomImage').src = source;
        $('guideZoomImage').alt = title;
        $('guideZoomTitle').textContent = title;
        dialog.showModal();
    }

    document.querySelectorAll('[data-lang]').forEach(button => button.addEventListener('click', () => {
        if (button.dataset.lang === lang) return;
        lang = button.dataset.lang;
        try { localStorage.setItem(STORE_KEY, lang); } catch (error) { /* ohne Speicher geht es auch */ }
        const url = new URL(location.href);
        url.searchParams.set('sprache', lang);
        url.hash = '';
        history.replaceState(null, '', url);
        render();
        window.scrollTo(0, 0);
    }));
    // Ein Tipp neben das große Bild schließt es wieder.
    $('guideZoom').addEventListener('click', event => { if (event.target === $('guideZoom')) $('guideZoom').close(); });

    render();
    // Sprungmarke aus der Adresse (z. B. anleitung.html#auftraege) nach dem Aufbau ansteuern.
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
})();
