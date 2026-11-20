// R99: Sprache der Oberfläche – Deutsch, English, العربية.
// Die App ist auf Deutsch geschrieben. Für Englisch und Arabisch liegt je ein Wörterbuch (lang/en.js, lang/ar.js) mit
// den deutschen Texten als Schlüssel. Dieses Modul übersetzt die Seite beim Aufbau und alles, was später dazukommt
// (MutationObserver): Textknoten, Platzhalter, Titel, aria-Labels. Eingaben der Nutzer bleiben unangetastet.
//   • I18n.lang            aktuelle Sprache ('de' | 'en' | 'ar')
//   • I18n.t(text)         übersetzt einen Text (Deutsch → aktuelle Sprache), auch Muster mit {1} {2}
//   • I18n.set(lang)       Sprache wechseln (speichert und lädt die Seite neu)
//   • I18n.mount(element)  Sprachumschalter (DE · EN · AR) in ein Element setzen
// Ausgenommen: [data-no-i18n], <code>, <pre>, <script>, <style>, Eingabefelder, Bereiche mit anderem lang-Attribut.
(function () {
    'use strict';
    const KEY = 'terminTool.lang';
    const LANGS = { de: 'Deutsch', en: 'English', ar: 'العربية' };
    const ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-empty'];
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT', 'SVG', 'svg', 'KBD', 'TEMPLATE']);

    function readLang() {
        const fromUrl = (location.search.match(/[?&]lang=(de|en|ar)\b/) || [])[1];
        if (fromUrl) { try { localStorage.setItem(KEY, fromUrl); } catch (error) { /* ohne Speicher */ } return fromUrl; }
        try { const saved = localStorage.getItem(KEY); if (saved && LANGS[saved]) return saved; } catch (error) { /* ohne Speicher */ }
        return 'de';
    }
    const lang = readLang();
    const rtl = lang === 'ar';
    document.documentElement.lang = lang;
    document.documentElement.dir = rtl ? 'rtl' : 'ltr';
    document.documentElement.dataset.lang = lang;

    let dict = {};
    let patterns = [];              // { prefix, re, out }
    const applied = new WeakMap();  // Knoten → zuletzt von uns gesetzter Text
    const originals = new WeakMap(); // Knoten → deutscher Urtext
    const appliedAttr = new WeakMap(); // Element → { attr: gesetzter Wert }

    function normalize(text) { return text.replace(/\s+/g, ' ').trim(); }
    function escapeRe(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function compile(table) {
        dict = table || {};
        patterns = [];
        Object.keys(dict).forEach(key => {
            if (!/\{\d+\}/.test(key)) return;
            const parts = key.split(/\{\d+\}/);
            const prefix = parts[0];
            const literals = parts.filter(Boolean);
            const source = '^' + escapeRe(key).replace(/\\\{(\d+)\\\}/g, '([\\s\\S]+?)') + '$';
            try { patterns.push({ prefix, literals, re: new RegExp(source), out: dict[key], key }); } catch (error) { /* Muster unbrauchbar */ }
        });
        // Längere Präfixe zuerst – sie sind spezifischer.
        patterns.sort((a, b) => b.prefix.length - a.prefix.length || b.key.length - a.key.length);
    }

    function lookup(text) {
        const norm = normalize(text);
        if (!norm || !/[A-Za-zÄÖÜäöüß]/.test(norm)) return null;
        const direct = dict[norm];
        if (direct) return direct;
        for (const pattern of patterns) {
            if (pattern.prefix && !norm.startsWith(pattern.prefix)) continue;
            if (!pattern.literals.every(part => norm.includes(part))) continue;
            const match = norm.match(pattern.re);
            if (!match) continue;
            // Platzhalter füllen – Inhalte der Platzhalter selbst noch einmal nachschlagen (z. B. „{1} Termine“ mit „3“ bleibt 3).
            return pattern.out.replace(/\{(\d+)\}/g, (all, index) => {
                const part = match[Number(index)] ?? '';
                return dict[normalize(part)] || part;
            });
        }
        return null;
    }

    function t(text) {
        if (lang === 'de' || typeof text !== 'string') return text;
        return lookup(text) ?? text;
    }

    function skip(element) {
        for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
            if (SKIP_TAGS.has(node.tagName)) return true;
            if (node.hasAttribute('data-no-i18n') || node.isContentEditable) return true;
            const nodeLang = node.getAttribute('lang');
            if (nodeLang && node !== document.documentElement && !/^de\b/i.test(nodeLang)) return true;
        }
        return false;
    }

    function translateTextNode(node) {
        if (node.parentNode && node.parentNode.nodeName === 'TEXTAREA') return;   // Vorgabetext eines Eingabefelds nie anfassen
        const current = node.data;
        if (!current || !/[A-Za-zÄÖÜäöüß]/.test(current)) return;
        if (applied.get(node) === current) return;   // unser eigener Text, unverändert
        originals.set(node, current);
        const out = lookup(current);
        if (out === null) return;
        const lead = (current.match(/^\s*/) || [''])[0];
        const trail = (current.match(/\s*$/) || [''])[0];
        const next = lead + out + trail;
        if (next === current) return;
        applied.set(node, next);
        node.data = next;
    }

    function translateAttrs(element) {
        if (element.nodeType !== 1) return;
        const store = appliedAttr.get(element) || {};
        ATTRS.forEach(attr => {
            if (!element.hasAttribute(attr)) return;
            const value = element.getAttribute(attr);
            if (!value || store[attr] === value) return;
            const out = lookup(value);
            if (out === null || out === value) return;
            store[attr] = out;
            element.setAttribute(attr, out);
        });
        if (element.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(element.type) && element.value) {
            const out = lookup(element.value);
            if (out !== null && store.value !== out) { store.value = out; element.value = out; }
        }
        appliedAttr.set(element, store);
    }

    function walk(root) {
        if (!root) return;
        if (root.nodeType === 3) { if (!skip(root.parentElement)) translateTextNode(root); return; }
        if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
        if (root.nodeType === 1) {
            if (skip(root)) return;
            translateAttrs(root);
        }
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
            acceptNode(node) {
                if (node.nodeType === 1) return SKIP_TAGS.has(node.tagName) || node.hasAttribute('data-no-i18n') || node.isContentEditable || (node.getAttribute('lang') && !/^de\b/i.test(node.getAttribute('lang'))) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        let node;
        while ((node = walker.nextNode())) {
            if (node.nodeType === 3) translateTextNode(node);
            else translateAttrs(node);
        }
    }

    let observer = null;
    function observe() {
        if (observer || typeof MutationObserver !== 'function') return;
        observer = new MutationObserver(records => {
            for (const record of records) {
                if (record.type === 'childList') record.addedNodes.forEach(node => walk(node));
                else if (record.type === 'characterData') { if (!skip(record.target.parentElement)) translateTextNode(record.target); }
                else if (record.type === 'attributes') { if (!skip(record.target)) translateAttrs(record.target); }
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS.concat(['value']) });
    }

    // Eingebaute Dialoge (confirm/alert/prompt) sprechen sonst Deutsch.
    function wrapDialogs() {
        ['alert', 'confirm', 'prompt'].forEach(name => {
            const original = window[name];
            if (typeof original !== 'function') return;
            window[name] = function (message, ...rest) { return original.call(window, t(String(message ?? '')), ...rest); };
        });
    }

    // Datumsangaben mit Wochentag oder Monatsnamen in der Sprache der Oberfläche (Zahlenformate bleiben deutsch – sie dienen
    // teils als Schlüssel). Arabisch mit lateinischen Ziffern, wie in Deutschland üblich.
    function wrapDates() {
        const target = { en: 'en-GB', ar: 'ar-u-nu-latn' }[lang];
        if (!target) return;
        const textual = options => Boolean(options && (options.weekday || options.month === 'long' || options.month === 'short'));
        const swap = (locale, options) => textual(options) && /^de/i.test(String(locale || '')) ? target : locale;
        const dateString = Date.prototype.toLocaleDateString;
        Date.prototype.toLocaleDateString = function (locale, options) { return dateString.call(this, swap(locale, options), options); };
        const fullString = Date.prototype.toLocaleString;
        Date.prototype.toLocaleString = function (locale, options) { return fullString.call(this, swap(locale, options), options); };
    }

    // Sprachumschalter: drei Knöpfe, die aktive Sprache hervorgehoben.
    function mount(target, options = {}) {
        if (!target) return null;
        let box = target.querySelector(':scope > .lang-switch');
        if (box) return box;
        box = document.createElement('div');
        box.className = 'lang-switch' + (options.compact ? ' lang-switch-compact' : '');
        box.setAttribute('data-no-i18n', '');
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', 'Sprache / Language / اللغة');
        box.innerHTML = Object.keys(LANGS).map(code => `<button type="button" class="lang-switch-button" data-lang="${code}" lang="${code}" title="${LANGS[code]}"${code === lang ? ' aria-pressed="true"' : ' aria-pressed="false"'}>${code.toUpperCase()}</button>`).join('');
        box.addEventListener('click', event => {
            const button = event.target.closest('[data-lang]');
            if (button && button.dataset.lang !== lang) set(button.dataset.lang);
        });
        if (options.before && options.before.parentNode === target) target.insertBefore(box, options.before);
        else if (options.first && target.firstChild) target.insertBefore(box, target.firstChild);
        else target.append(box);
        return box;
    }

    function set(next) {
        if (!LANGS[next]) return;
        try { localStorage.setItem(KEY, next); } catch (error) { /* ohne Speicher */ }
        const url = new URL(location.href);
        url.searchParams.delete('lang');
        location.replace(url.toString());
    }

    function start() {
        if (lang !== 'de') {
            const table = lang === 'en' ? window.TT_I18N_EN : window.TT_I18N_AR;
            compile(table || {});
            wrapDialogs();
            wrapDates();
            walk(document.documentElement);
            if (document.title) { const out = lookup(document.title); if (out) document.title = out; }
            observe();
        }
    }

    window.I18n = { get lang() { return lang; }, rtl, LANGS, t, set, mount, translate: walk, ready: Promise.resolve() };
    const mountSlots = () => document.querySelectorAll('[data-lang-switch]').forEach(slot => mount(slot));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountSlots); else mountSlots();
    window.t = window.t || t;

    if (lang !== 'de') {
        // Wörterbuch synchron nachladen, solange der Kopf der Seite noch gelesen wird – so ist es da, bevor der Inhalt kommt.
        const table = lang === 'en' ? window.TT_I18N_EN : window.TT_I18N_AR;
        if (!table && document.readyState === 'loading') {
            document.write('<script src="lang/' + lang + '.js"><\/script>');
        }
        // Sobald das Wörterbuch da ist (gleich nach diesem Script), loslegen – und beim Aufbau des Inhalts mitlaufen.
        const begin = () => { start(); };
        if (document.readyState === 'loading') {
            // Das nachgeladene Script steht direkt hinter uns; ein eigenes Script danach startet die Übersetzung.
            document.write('<script>window.I18n && window.I18n.__start && window.I18n.__start();<\/script>');
            window.I18n.__start = begin;
            document.addEventListener('DOMContentLoaded', () => { if (!observer) begin(); walk(document.body); });
        } else {
            begin();
        }
    }
})();
