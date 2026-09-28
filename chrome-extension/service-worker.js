chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request?.type !== 'TERMIN_TOOL_OPEN_WHATSAPP') return false;

    const message = String(request.message || '').trim();
    if (!message) {
        sendResponse({ ok: false, error: 'Der Nachrichtentext ist leer.' });
        return false;
    }

    openWhatsAppInExistingTab(message)
        .then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
});

async function openWhatsAppInExistingTab(message) {
    const targetUrl = `https://web.whatsapp.com/send?text=${encodeURIComponent(message)}`;
    const activeWhatsAppTabs = await chrome.tabs.query({
        url: 'https://web.whatsapp.com/*',
        active: true
    });
    const anyWhatsAppTabs = activeWhatsAppTabs.length
        ? activeWhatsAppTabs
        : await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    const existingTab = anyWhatsAppTabs[0];

    if (!existingTab) {
        await chrome.tabs.create({ url: targetUrl, active: true });
        return { ok: true, reused: false };
    }

    await chrome.windows.update(existingTab.windowId, { focused: true });
    await chrome.tabs.update(existingTab.id, { url: targetUrl, active: true });
    return { ok: true, reused: true };
}
