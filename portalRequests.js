// Dolmetscher-Portal · Bitten der Einsatzleitung: „Bitte neues Foto“.
// Die Einsatzleitung fordert ein neues Foto an (Schaden, Meldung im Auto, Beleg) oder bittet, eine Unterlage
// neu zu fotografieren. Hier sieht die Person das bisherige Foto mit dem Hinweis und schickt das neue.
// Gehört zu portalApp.js (Schnittstelle window.PortalCore).
window.PortalRequests = (function () {
    const core = window.PortalCore;
    const $ = id => document.getElementById(id);
    const { client, toast, el } = core;
    const WHAT = { schaden: 'Foto vom Schaden', meldung: 'Foto der Meldung im Auto', beleg: 'Foto vom Beleg', unterlage: 'Unterlage' };
    const MAX_PHOTOS = 3;

    let requests = [];      // offene Bitten an mich, älteste zuerst
    let current = null;     // Bitte, die gerade geöffnet ist
    let photos = [];        // neu aufgenommene Fotos: { file, url }
    let sending = false;

    const when = value => new Date(value).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    async function load() {
        const profile = core.profile();
        if (!profile?.active) return;
        const { data, error } = await client.from('tt_requests').select('*').eq('profile_id', profile.id).eq('status', 'offen').order('created_at', { ascending: true });
        const before = requests.length;
        requests = error ? [] : data;      // fehlt die Tabelle noch (Update 14), gibt es einfach keine Bitten
        renderBanner();
        // Eine neue Bitte soll man nicht übersehen: auf der Startseite einmal nach oben rollen.
        if (requests.length > before && core.view() === 'vehicle') window.scrollTo({ top: 0 });
    }

    // Auf der Startseite ganz oben: eine Karte je offener Bitte.
    function renderBanner() {
        const list = $('requestBanner');
        list.hidden = !requests.length;
        list.replaceChildren(...requests.map(request => {
            const item = el('li');
            const card = el('button', 'request-card');
            card.type = 'button';
            const icon = el('span', 'request-card-icon');
            icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.500A1.500 1.500 0 0 1 5.500 7H8l1.500-2.500h5L16 7h2.500A1.500 1.500 0 0 1 20 8.500V18a1.500 1.500 0 0 1-1.500 1.500h-13A1.500 1.500 0 0 1 4 18z"/><circle cx="12" cy="13" r="3.500"/></svg>';
            const text = el('span', 'request-card-text');
            text.append(el('strong', '', request.kind === 'unterlage' ? 'Bitte neu fotografieren' : 'Bitte neues Foto'), el('span', '', request.title || WHAT[request.kind] || ''), el('small', '', request.message || ''));
            card.append(icon, text, el('span', 'car-card-arrow', '›'));
            card.addEventListener('click', () => open(request));
            item.append(card);
            return item;
        }));
    }

    function open(request) {
        current = request;
        core.goTo('requests');
    }

    function releasePhotos() {
        photos.forEach(photo => URL.revokeObjectURL(photo.url));
        photos = [];
    }

    // Vorschaubild oder Verweis auf das bisherige Foto bzw. PDF
    async function oldPreview(request) {
        const box = $('requestOld');
        box.replaceChildren();
        const paths = (request.photo_paths || []).filter(Boolean);
        $('requestOldLabel').hidden = !paths.length;
        for (const path of paths) {
            const { data } = await client.storage.from(request.photo_bucket || 'schaeden').createSignedUrl(path, 900);
            if (current !== request) return;
            if (!data?.signedUrl) continue;
            if (request.photo_bucket === 'dokumente' || /\.pdf$/i.test(path)) {
                const link = el('a', 'button-secondary request-old-file', 'Bisherige Unterlage ansehen');
                link.href = data.signedUrl;
                link.target = '_blank';
                link.rel = 'noopener';
                box.append(link);
            } else {
                const link = el('a', 'request-thumb');
                link.href = data.signedUrl;
                link.target = '_blank';
                link.rel = 'noopener';
                const image = el('img');
                image.src = data.signedUrl;
                image.alt = 'Bisheriges Foto';
                image.loading = 'lazy';
                link.append(image);
                box.append(link);
            }
        }
        if (!box.children.length) $('requestOldLabel').hidden = true;
    }

    function renderNew() {
        $('requestNew').replaceChildren(...photos.map((photo, index) => {
            const wrap = el('span', 'request-thumb is-new');
            const image = el('img');
            image.src = photo.url;
            image.alt = `Neues Foto ${index + 1}`;
            const drop = () => { const at = photos.indexOf(photo); if (at < 0) return; URL.revokeObjectURL(photo.url); photos.splice(at, 1); renderNew(); };
            // Tipp auf das Foto: groß ansehen (und dort bei Bedarf entfernen).
            const open = el('button', 'request-thumb-open');
            open.type = 'button';
            open.setAttribute('aria-label', `Neues Foto ${index + 1} groß ansehen`);
            open.addEventListener('click', async () => { if (await window.ScanCam?.look?.({ url: photo.url, title: `Neues Foto ${index + 1}`, removeLabel: 'Entfernen' }) === 'remove') drop(); });
            open.append(image);
            const remove = el('button', 'request-thumb-remove', '×');
            remove.type = 'button';
            remove.setAttribute('aria-label', `Neues Foto ${index + 1} entfernen`);
            remove.addEventListener('click', drop);
            wrap.append(open, remove);
            return wrap;
        }));
        $('requestSend').disabled = !photos.length || sending;
        $('requestCameraLabel').textContent = photos.length ? 'Noch ein Foto aufnehmen' : 'Foto aufnehmen';
        document.querySelector('.request-capture').hidden = photos.length >= MAX_PHOTOS;
    }

    // Wird von portalApp.js aufgerufen, sobald der Bereich „requests“ gezeigt wird.
    function show() {
        if (!current || !requests.some(item => item.id === current.id)) current = requests[0] || null;
        if (!current) { core.goTo('vehicle'); return; }
        const request = current;
        releasePhotos();
        sending = false;
        const isDocument = request.kind === 'unterlage';
        $('requestTitle').textContent = isDocument ? 'Bitte neu fotografieren' : 'Bitte neues Foto';
        // „Foto vom Beleg · Beleg · …“ liest sich doppelt: das führende Wort des Titels entfällt, wenn es schon davor steht.
        const lead = { schaden: 'Schaden', meldung: 'Meldung', beleg: 'Beleg' }[request.kind];
        const title = lead && String(request.title || '').startsWith(`${lead} · `) ? request.title.slice(lead.length + 3) : request.title;
        $('requestWhat').textContent = [WHAT[request.kind], title].filter(Boolean).join(' · ');
        $('requestMessage').textContent = request.message || 'Das Foto ist nicht gut zu erkennen. Bitte nimm ein neues auf.';
        $('requestFrom').textContent = `${request.created_by_name || 'Einsatzleitung'} · ${when(request.created_at)}`;
        $('requestPhotoPart').hidden = isDocument;
        $('requestDocPart').hidden = !isDocument;
        $('requestNote').value = '';
        renderNew();
        oldPreview(request);
    }

    function addFiles(fileList) {
        const files = [...(fileList || [])].filter(file => /^image\//.test(file.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(file.name));
        if (!files.length) return;
        const room = MAX_PHOTOS - photos.length;
        files.slice(0, room).forEach(file => photos.push({ file, url: URL.createObjectURL(file) }));
        if (files.length > room) toast(`Es gehen höchstens ${MAX_PHOTOS} Fotos.`, 'info');
        renderNew();
    }
    $('requestCamera').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
    $('requestGallery').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });

    async function send() {
        if (sending || !current) return;
        if (!photos.length) { toast('Bitte nimm zuerst ein neues Foto auf.', 'error', '#requestCameraLabel'); return; }
        const request = current;
        const profile = core.profile();
        sending = true;
        const button = $('requestSend');
        button.disabled = true;
        button.textContent = 'Wird gesendet …';
        const uploaded = [];
        try {
            for (const photo of photos) uploaded.push(await TerminCloud.uploadPhoto(photo.file, profile.id));
            const { error } = await client.rpc('tt_request_answer', { p_id: request.id, p_paths: uploaded, p_note: $('requestNote').value.trim(), p_new_ref: null });
            if (error) throw error;
            releasePhotos();
            current = null;
            await load();
            await core.showSuccess('Danke!', 'Das neue Foto ist angekommen.');
            toast('Neues Foto gesendet. Danke!', 'success');
            if (requests.length) open(requests[0]); else core.goTo('vehicle');
        } catch (error) {
            // Was schon hochgeladen wurde, wird wieder entfernt – beim nächsten Versuch entstehen keine doppelten Fotos.
            if (uploaded.length) await client.storage.from('schaeden').remove(uploaded).catch(() => null);
            const message = /tt_request_answer|schema cache/i.test(error?.message || '')
                ? 'Die Funktion ist in der Datenbank noch nicht eingerichtet (Update 14 fehlt). Bitte sag der Einsatzleitung Bescheid.'
                : TerminCloud.germanError(error);
            toast(`Nicht gesendet: ${message}`, 'error', '#requestSend');
        } finally {
            sending = false;
            button.textContent = 'Neues Foto senden';
            button.disabled = !photos.length;
        }
    }
    $('requestSend').addEventListener('click', send);
    $('requestRetake').addEventListener('click', () => { if (current) window.PortalDocs?.startRetake(current); });

    // Nach dem Senden einer neu fotografierten Unterlage (aus portalDocs.js): Bitte als erledigt melden.
    async function answerDocument(requestId, documentId, note) {
        const { error } = await client.rpc('tt_request_answer', { p_id: requestId, p_paths: [], p_note: note || '', p_new_ref: documentId });
        current = null;
        await load();
        return error || null;
    }

    // Das Portal kann schon gestartet sein, bevor diese Datei geladen ist – dann die Bitten jetzt nachladen.
    if (core.profile()?.active) load();

    return { load, show, open, answerDocument, state: () => ({ requests, current, photos: photos.length }) };
})();
