/*
 * Copyright (c) 2026 Azzar Budiyanto / LilyOpenCMS.
 * Licensed under the MIT License.
 * Contact: azzar.mr.zs@gmail.com for inquiries.
 *
 * Accessibility tree snapshot and element state — captures page AX tree,
 * prunes to actionable elements only, and assigns stable ref numbers for
 * reliable re-selection across snapshots.
 */
const { INTERACTIVE_SELECTOR, MAIN_CONTENT_SELECTORS, CAPTCHA_SELECTORS } = require('../utils/selectors');

// AX roles that carry actionable or structural meaning.
// Filtering to these roles reduces the AX tree size by ~80% while preserving
// all interactive and navigational elements. This is the key to token efficiency.
const KEEP_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox',
    'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'tab', 'tabpanel', 'treeitem', 'switch', 'slider', 'spinbutton',
    'heading', 'banner', 'main', 'navigation', 'contentinfo', 'complementary',
    'alert', 'alertdialog', 'dialog', 'status', 'log', 'progressbar',
    'grid', 'row', 'columnheader', 'rowheader', 'cell', 'gridcell',
    'img', 'figure', 'form',
]);

// Recursively prune the accessibility tree to keep only meaningful nodes.
// Depth limit of 12 prevents runaway recursion on deeply nested DOMs.
// Truncates long text values to 200 chars to keep token count manageable.
function pruneAxTree(node, depth = 0) {
    if (!node || depth > 12) return null;
    const keep = KEEP_ROLES.has(node.role) || depth === 0;
    const children = (node.children || [])
        .map(c => pruneAxTree(c, depth + 1))
        .filter(Boolean);

    if (!keep && !children.length) return null;

    const out = {};
    if (node.role) out.role = node.role;
    if (node.name) out.name = node.name.substring(0, 200);
    if (node.value !== undefined && node.value !== '') out.value = String(node.value).substring(0, 200);
    if (node.description) out.description = node.description.substring(0, 200);
    if (node.checked !== undefined) out.checked = node.checked;
    if (node.disabled) out.disabled = true;
    if (node.expanded !== undefined) out.expanded = node.expanded;
    if (node.level) out.level = node.level;
    if (children.length) out.children = children;
    return out;
}

// Element ref cache — stores the last observe/get_state result.
// Refs are 1-based indices that allow clicking elements without re-querying the DOM.
// This is the core of the observe→act pattern that saves ~93% of tokens.
let _elementRefs = [];

function storeElementRefs(elements) { _elementRefs = elements; }
function getElementByRef(ref) { return _elementRefs.find(el => el.ref === ref) || null; }

// Capture full page state: URL, title, headings, text blocks, interactive elements,
// popups, CAPTCHA status, and pruned AX tree. This is the "sense" in sense-think-act.
// The AX tree provides semantic structure without screenshots — critical for token efficiency.
async function captureState(page) {
    const state = await page.evaluate(({ interactiveSelector, mainSelectors, captchaSelectors }) => {
        function querySelectorAllDeep(selector, rootNode = document) {
            const results = Array.from(rootNode.querySelectorAll(selector));
            const walk = (node) => {
                if (node.shadowRoot) {
                    results.push(...Array.from(node.shadowRoot.querySelectorAll(selector)));
                    walk(node.shadowRoot);
                }
                Array.from(node.children).forEach(walk);
            };
            walk(rootNode);
            return results;
        }

        // Find main content root — skip nav/header/footer for cleaner extraction
        const root = mainSelectors.reduce((found, sel) => found || document.querySelector(sel), null) || document.body;

        // Headings provide page structure — limited to 15 to control token count
        const headings = querySelectorAllDeep('h1,h2,h3,h4,h5', root)
            .map(el => {
                const r = el.getBoundingClientRect();
                return (r.width > 0) ? { level: parseInt(el.tagName[1]), text: el.innerText.trim().substring(0, 200) } : null;
            }).filter(Boolean).slice(0, 15);

        // Text blocks give context without full DOM dump
        const blocks = querySelectorAllDeep('p, li, td, blockquote, pre code', root)
            .map(el => {
                const r = el.getBoundingClientRect();
                const cs = window.getComputedStyle(el);
                // Skip hidden elements — they waste tokens
                if (r.width === 0 || cs.display === 'none' || cs.visibility === 'hidden') return null;
                return el.innerText.trim().substring(0, 500);
            }).filter(t => t && t.length > 10).slice(0, 40);

        // Interactive elements — the actionable targets for click/type/select
        const elements = querySelectorAllDeep(interactiveSelector, document).map(el => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            // Only include visible elements — hidden ones cause click failures
            const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            if (!visible) return null;

            const entry = {
                tag: el.tagName,
                x: Math.round(rect.left), y: Math.round(rect.top),
                w: Math.round(rect.width), h: Math.round(rect.height),
            };
            if (el.id) entry.id = el.id;
            if (el.className) entry.class = el.className.toString().trim().substring(0, 120);
            if (el.getAttribute('role')) entry.role = el.getAttribute('role');
            if (el.innerText) entry.text = el.innerText.trim().substring(0, 150);
            if (el.tagName === 'A' && el.href) entry.href = el.href;
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') entry.value = el.value.substring(0, 100);

            return entry;
        }).filter(Boolean);
        // Assign 1-based ref indices — used by browser_click_ref for stable targeting
        elements.forEach((el, i) => { el.ref = i + 1; });

        // Popups/modals block interaction — detect them for auto-dismissal
        const popups = querySelectorAllDeep('.modal, [role="dialog"], .swal2-popup', document)
            .map(el => {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0) return null;
                return {
                    text: el.innerText.trim().substring(0, 300),
                    visible: true
                };
            }).filter(Boolean);

        // CAPTCHA detection — triggers auto-handling or DuckDuckGo fallback
        const captchaDetected = !!document.querySelector(captchaSelectors);

        return {
            url: location.href,
            title: document.title,
            headings,
            text: blocks.join('\n').substring(0, 5000),
            elements,
            popups: popups.length ? popups : undefined,
            captchaDetected
        };
    }, { 
        interactiveSelector: INTERACTIVE_SELECTOR, 
        mainSelectors: MAIN_CONTENT_SELECTORS,
        captchaSelectors: CAPTCHA_SELECTORS 
    });

    // AX tree is optional — many pages don't expose it, and it's expensive in tokens
    let axTree = null;
    try {
        const raw = await page.accessibility.snapshot({ interestingOnly: true });
        axTree = raw ? pruneAxTree(raw) : null;
    } catch (_) {}
    state.axTree = axTree || undefined;

    storeElementRefs(state.elements);
    return state;
}

// Lightweight alternative to captureState — returns only interactable elements.
// No headings, no text blocks, no AX tree, no screenshots.
// Use this when you just need to find something to click (saves ~90% tokens).
async function observeInteractable(page) {
    const elements = await page.evaluate(({ interactiveSelector }) => {
        function querySelectorAllDeep(selector, rootNode = document) {
            const results = Array.from(rootNode.querySelectorAll(selector));
            const walk = (node) => {
                if (node.shadowRoot) {
                    results.push(...Array.from(node.shadowRoot.querySelectorAll(selector)));
                    walk(node.shadowRoot);
                }
                Array.from(node.children).forEach(walk);
            };
            walk(rootNode);
            return results;
        }
        return querySelectorAllDeep(interactiveSelector, document).map((el, i) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const visible = rect.width > 0 && rect.height > 0
                && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
            if (!visible) return null;

            const entry = {
                ref: i + 1,
                tag: el.tagName,
                x: Math.round(rect.left), y: Math.round(rect.top),
                w: Math.round(rect.width), h: Math.round(rect.height),
            };
            if (el.id) entry.id = el.id;
            if (el.getAttribute('role')) entry.role = el.getAttribute('role');
            if (el.innerText) entry.text = el.innerText.trim().substring(0, 150);
            if (el.tagName === 'A' && el.href) entry.href = el.href;
            if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
                entry.inputType = el.type || el.tagName.toLowerCase();
                if (el.value) entry.value = el.value.substring(0, 100);
                if (el.placeholder) entry.placeholder = el.placeholder;
                if (el.name) entry.name = el.name;
            }
            return entry;
        }).filter(Boolean);
    }, { interactiveSelector: INTERACTIVE_SELECTOR });

    storeElementRefs(elements);
    return { url: page.url(), title: await page.title(), elementCount: elements.length, elements };
}

module.exports = {
    captureState,
    observeInteractable,
    getElementByRef,
};
