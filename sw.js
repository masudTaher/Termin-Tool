// Service Worker für das Dolmetscher-Portal (installierbare App).
// Er hält nur die Programmdateien des Portals bereit, damit die App sofort startet.
// Daten (Fahrzeuge, Aufträge, Abrechnung) kommen immer frisch aus der Datenbank
// und werden hier nie gespeichert.
const CACHE = 'botschaft-portal-v2';
const SHELL = ['portal.html', 'style.css', 'cloudConfig.js', 'cloudClient.js', 'carSketch.js', 'receiptReader.js', 'portalApp.js', 'manifest.json', 'icon-192.png'];
const SHELL_PATHS = new Set(SHELL.map(file => new URL(file, self.location.href).pathname));

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).catch(() => null));
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    const isShell = url.origin === self.location.origin && SHELL_PATHS.has(url.pathname);
    const isLibrary = url.hostname === 'cdn.jsdelivr.net';
    // Alles andere (Datenbank, Fotos, die Seiten der Einsatzleitung) läuft unverändert übers Netz.
    if (!isShell && !isLibrary) return;
    // Erst das Netz (damit Updates sofort ankommen), ohne Netz die gespeicherte Fassung.
    event.respondWith(
        fetch(request)
            .then(response => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => null);
                }
                return response;
            })
            .catch(() => caches.match(request, { ignoreSearch: true }).then(hit => hit || Response.error()))
    );
});

// ---------- Mitteilungen aufs Handy ----------
// Die Server-Funktion schickt Titel und Text; hier wird daraus die Mitteilung auf dem Sperrbildschirm.
self.addEventListener('push', event => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch (error) { payload = { body: event.data ? event.data.text() : '' }; }
    const title = payload.title || 'Botschaft Dolmetscher und Transport-App';
    event.waitUntil(self.registration.showNotification(title, {
        body: payload.body || '',
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: payload.tag || undefined,
        data: { url: payload.url || 'portal.html' }
    }));
});

// Tippen auf die Mitteilung öffnet das Portal (oder holt die offene App nach vorne).
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const target = new URL(event.notification.data?.url || 'portal.html', self.location.href).href;
    event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
        const open = windows.find(client => new URL(client.url).pathname === new URL(target).pathname);
        if (open) { open.navigate(target).catch(() => null); return open.focus(); }
        return self.clients.openWindow(target);
    }));
});
