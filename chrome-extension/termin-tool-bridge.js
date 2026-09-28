function markTerminToolExtensionReady() {
    if (!document.documentElement) return false;
    document.documentElement.dataset.terminToolExtensionReady = 'true';
    return true;
}

if (!markTerminToolExtensionReady()) {
    const rootObserver = new MutationObserver(() => {
        if (markTerminToolExtensionReady()) rootObserver.disconnect();
    });
    rootObserver.observe(document, { childList: true });
}

document.addEventListener('click', event => {
    if (!event.isTrusted || document.documentElement.dataset.terminToolExtensionReady !== 'true') return;
    if (!(event.target instanceof Element)) return;

    const button = event.target.closest('#openWhatsAppButton');
    if (!button) return;

    const message = String(document.getElementById('whatsappMessage')?.value || '').trim();
    if (!message) return;

    // Den Seiten-Fallback nur bei einem echten Klick abfangen, damit die
    // Erweiterung anschließend den WhatsApp-Tab gezielt wiederverwenden kann.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    chrome.runtime.sendMessage({ type: 'TERMIN_TOOL_OPEN_WHATSAPP', message }, response => {
        if (chrome.runtime.lastError || !response?.ok) {
            document.documentElement.dataset.terminToolExtensionReady = 'false';
            window.postMessage({
                source: 'termin-tool-whatsapp-extension',
                type: 'error',
                message: response?.error || chrome.runtime.lastError?.message || 'Unbekannter Fehler'
            }, window.location.origin);
            return;
        }

        window.postMessage({
            source: 'termin-tool-whatsapp-extension',
            type: 'opened',
            reused: response.reused
        }, window.location.origin);
    });
}, true);
