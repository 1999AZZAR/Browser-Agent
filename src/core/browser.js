/*
 * Copyright (c) 2026 Azzar Budiyanto / LilyOpenCMS.
 * Licensed under the MIT License.
 * Contact: azzar.mr.zs@gmail.com for inquiries.
 *
 * Browser lifecycle management — handles Playwright Chromium launch, page
 * creation/switching, navigation, and cleanup. Persists cookies and session
 * state to disk for cross-session reuse.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { SourceMapConsumer } = require('source-map');

// Lazy-loaded source map cache — maps URL → SourceMapConsumer for error stack trace mapping.
// Only loaded when needed to avoid memory overhead.
const _sourceMapCache = new Map();

// Configuration with sensible defaults — all overridable via environment variables.
// Using a persistent context (user data dir) instead of incognito for session persistence.
const CONFIG = {
    userDataDir: path.join(__dirname, '../../user_data'),
    viewport: { width: 1280, height: 720 },
    headless: process.env.BROWSER_HEADLESS === 'true' || process.env.BROWSER_HEADLESS === '1',
    launchRetries: Math.max(0, parseInt(process.env.BROWSER_LAUNCH_RETRIES || '3', 10)),
    launchBackoffMs: Math.max(100, parseInt(process.env.BROWSER_LAUNCH_BACKOFF || '1000', 10)),
    executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined,
    channel: process.env.CHROMIUM_CHANNEL || undefined,
    healthCheckTimeoutMs: 5000,
    tabCreateRetries: 3,
};

const STATE_FILE = path.join(CONFIG.userDataDir, 'session_state.json');

// Core state — single browser context, one active page, named pages for parallelism.
// WeakMaps for per-page logs avoid memory leaks when pages are closed.
let browserContext = null;
let activePage = null;
const activeRoutes = new Map(); // pattern → { action, options }
const namedPages = new Map();   // name → Page

const pageConsoleLog = new WeakMap(); // page → Message[]
const pageNetworkLog = new WeakMap(); // page → Request[]
const MAX_LOG_ENTRIES = 100;

// Build Chromium launch options with anti-detection flags.
// Key flags:
// - --disable-blink-features=AutomationControlled: removes navigator.webdriver flag
// - --no-sandbox: required for root/CI environments
// - Stability flags prevent Chrome from throttling background tabs during long sessions
function buildLaunchOptions() {
    const opts = {
        headless: CONFIG.headless,
        viewport: CONFIG.viewport,
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-blink-features=AutomationControlled',
            '--excludeSwitches=enable-automation',
            '--use-fake-ui-for-media-stream',
            // Stability flags for long-running sessions
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter',
            '--no-pings',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
    };
    if (CONFIG.executablePath) opts.executablePath = CONFIG.executablePath;
    if (CONFIG.channel) opts.channel = CONFIG.channel;
    return opts;
}

// Launch browser with exponential backoff retry.
// Why: Chromium launch can fail transiently (port conflicts, memory pressure).
// Exponential backoff avoids thundering herd on repeated failures.
async function launchWithRetry() {
    let lastErr;
    for (let attempt = 0; attempt <= CONFIG.launchRetries; attempt++) {
        try {
            await ensureUserDataDir();
            const ctx = await chromium.launchPersistentContext(CONFIG.userDataDir, buildLaunchOptions());
            if (attempt > 0) console.error(`[Browser] Launch succeeded on attempt ${attempt + 1}.`);
            return ctx;
        } catch (e) {
            lastErr = e;
            const total = CONFIG.launchRetries + 1;
            if (attempt < CONFIG.launchRetries) {
                const wait = CONFIG.launchBackoffMs * Math.pow(2, attempt);
                console.error(`[Browser] Launch attempt ${attempt + 1}/${total} failed: ${e.message}. Retrying in ${wait}ms...`);
                try { await browserContext?.close(); } catch (_) {}
                browserContext = null;
                await new Promise(r => setTimeout(r, wait));
            }
        }
    }
    throw new Error(`Browser failed to launch after ${CONFIG.launchRetries + 1} attempt(s): ${lastErr?.message}`);
}

// Detect transient CDP protocol errors that warrant a retry.
// These typically occur when Chrome's DevTools protocol connection drops briefly.
function isRetriableContextError(e) {
    const msg = e?.message || '';
    return msg.includes('Target.createTarget')
        || msg.includes('Protocol error')
        || msg.includes('Connection closed')
        || msg.includes('Browser has been closed')
        || msg.includes('Target closed');
}

// Create a new page with retry — handles transient CDP errors.
// On failure, resets the entire browser context and retries once.
async function newPageWithRetry() {
    let lastErr;
    for (let attempt = 0; attempt < CONFIG.tabCreateRetries; attempt++) {
        try {
            const ctx = await getBrowserContext();
            return await ctx.newPage();
        } catch (e) {
            lastErr = e;
            if (!isRetriableContextError(e) || attempt === CONFIG.tabCreateRetries - 1) throw e;
            console.error(`[Browser] newPage failed (attempt ${attempt + 1}/${CONFIG.tabCreateRetries}): ${e.message}. Resetting context and retrying...`);
            try { await browserContext?.close(); } catch (_) {}
            browserContext = null;
            activePage = null;
            await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
        }
    }
    throw lastErr;
}

async function getBrowserContext() {
    // If the browser was closed (e.g. crashed), the 'close' event handler sets browserContext to null.
    if (!browserContext) {
        browserContext = await launchWithRetry();

        injectCookiesIfExist();

        browserContext.on('close', () => {
            browserContext = null;
            activePage = null;
            namedPages.clear();
        });

        // Start clean: close any tabs restored by Chrome's crash recovery
        const pages = browserContext.pages();
        for (let i = 1; i < pages.length; i++) {
            pages[i].close().catch(() => {});
        }
        if (pages[0] && pages[0].url() !== 'about:blank') {
            pages[0].goto('about:blank').catch(() => {});
        }
        activePage = pages[0];
    }
    return browserContext;
}

async function ensureUserDataDir() {
    if (!fs.existsSync(CONFIG.userDataDir)) fs.mkdirSync(CONFIG.userDataDir, { recursive: true });
    // Clean stale lockfiles
    ['SingletonLock', 'SingletonSocket', 'SingletonCookie'].forEach(f => {
        try { fs.unlinkSync(path.join(CONFIG.userDataDir, f)); } catch (_) {}
    });
}

function injectCookiesIfExist() {
    const cookiesPath = path.join(__dirname, '../../cookies.json');
    if (fs.existsSync(cookiesPath)) {
        try {
            const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf8'));
            browserContext.addCookies(cookies).catch(() => {});
            console.error(`[Browser] Injected ${cookies.length} cookies from cookies.json`);
        } catch (e) {
            console.error(`[Browser] Failed to inject cookies: ${e.message}`);
        }
    }
}

// ── Session State Persistence ──────────────────────────────────────────────────

const SNAP_DIR = path.join(CONFIG.userDataDir, 'snapshots');
const CURR_SNAP = path.join(SNAP_DIR, 'currentstate.json');
const LAST_SNAP = path.join(SNAP_DIR, 'laststate.json');

async function saveState() {
    if (!browserContext) return;
    const pages = [];
    const seen = new Set();
    for (const [name, pg] of namedPages) {
        try {
            if (pg.isClosed()) continue;
            const url = pg.url();
            if (url && url !== 'about:blank') {
                pages.push({ name, url });
                seen.add(pg);
            }
        } catch (_) {}
    }
    // Include unnamed context pages
    try {
        const ctxPages = browserContext.pages();
        for (const pg of ctxPages) {
            if (seen.has(pg) || pg.isClosed()) continue;
            const url = pg.url();
            if (url && url !== 'about:blank') {
                pages.push({ name: `_tab${pg.index || pages.length}`, url });
            }
        }
    } catch (_) {}

    const routes = listRoutes();
    const activeName = getActiveName();
    const state = { pages, routes, activeName, timestamp: Date.now() };
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (_) {}
}

async function restoreState() {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
    if (!raw) return;
    const state = JSON.parse(raw);
    if (!state.pages || !state.pages.length) return;

    const ctx = browserContext;
    if (!ctx) return;

    // Close the blank auto-created page
    for (const p of ctx.pages()) {
        try { if (p.url() === 'about:blank' || !p.url()) await p.close(); } catch (_) {}
    }

    // Reopen saved pages
    for (const { name, url } of state.pages) {
        const pg = await newPageWithRetry();
        setupPage(pg);
        namedPages.set(name, pg);
        pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    }

    // Set active page
    if (state.activeName && namedPages.has(state.activeName)) {
        activePage = namedPages.get(state.activeName);
    } else {
        activePage = namedPages.values().next().value;
    }
    if (activePage) activePage.bringToFront().catch(() => {});

    // Reapply intercept routes
    for (const entry of state.routes || []) {
        const { pattern, action, options } = entry;
        await addRoute(pattern, action, (options && typeof options === 'object') ? options : {}).catch(() => {});
    }

    console.error(`[Browser] Restored ${state.pages.length} tab(s) and ${(state.routes || []).length} intercept rule(s) from session state`);
}

// ── AX Tree Snapshot Management ────────────────────────────────────────────────

async function rotateSnapshot() {
    try {
        if (fs.existsSync(CURR_SNAP)) {
            fs.mkdirSync(SNAP_DIR, { recursive: true });
            fs.copyFileSync(CURR_SNAP, LAST_SNAP);
        }
    } catch (_) {}
}

async function saveSnapshot(data) {
    try {
        fs.mkdirSync(SNAP_DIR, { recursive: true });
        fs.writeFileSync(CURR_SNAP, JSON.stringify(data, null, 2));
    } catch (_) {}
}

function loadSnapshot(snapPath) {
    try {
        if (!fs.existsSync(snapPath)) return null;
        return JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    } catch (_) { return null; }
}

function getCurrSnapshot() { return loadSnapshot(CURR_SNAP); }
function getLastSnapshot() { return loadSnapshot(LAST_SNAP); }

// ── Page Management ────────────────────────────────────────────────────────────

async function getPage() {
    const ctx = await getBrowserContext();
    if (!activePage || activePage.isClosed()) {
        // Recover from named pages first
        if (namedPages.size > 0) {
            for (const [, pg] of namedPages) {
                if (!pg.isClosed()) {
                    activePage = pg;
                    return activePage;
                }
            }
            namedPages.clear();
        }
        const pages = ctx.pages();
        activePage = pages.length > 0 ? pages[0] : await newPageWithRetry();
        setupPage(activePage);
    }
    return activePage;
}

async function resolveSourceLocation(url, line, col) {
    if (!url || !url.endsWith('.js')) return null;
    try {
        let consumer = _sourceMapCache.get(url);
        if (!consumer) {
            // Try fetching the source map
            const mapUrl = url + '.map';
            const resp = await fetch(mapUrl).catch(() => null);
            if (!resp || !resp.ok) return null;
            const rawMap = await resp.json().catch(() => null);
            if (!rawMap) return null;
            consumer = await new SourceMapConsumer(rawMap);
            _sourceMapCache.set(url, consumer);
        }
        const pos = consumer.originalPositionFor({ line: line || 1, column: col || 0 });
        if (pos.source) return `${pos.source}:${pos.line}:${pos.column}`;
    } catch (_) {}
    return null;
}

function setupPage(page) {
    page.on('dialog', async (dialog) => {
        console.error(`[Browser] Native dialog [${dialog.type()}]: "${dialog.message()}" — auto-accepting`);
        try { await dialog.accept(); } catch (_) {}
    });

    // Console capture with source-map resolution
    const consoleLog = [];
    pageConsoleLog.set(page, consoleLog);
    page.on('console', async msg => {
        const loc = msg.location();
        let resolvedLoc = loc?.url ? `${loc.url}:${loc.lineNumber || 0}` : undefined;
        if (loc?.url && loc?.lineNumber) {
            const mapped = await resolveSourceLocation(loc.url, loc.lineNumber, loc.columnNumber).catch(() => null);
            if (mapped) resolvedLoc = mapped;
        }
        consoleLog.push({ type: msg.type(), text: msg.text(), url: resolvedLoc });
        if (consoleLog.length > MAX_LOG_ENTRIES) consoleLog.shift();
    });
    page.on('pageerror', err => {
        consoleLog.push({ type: 'error', text: err.message });
        if (consoleLog.length > MAX_LOG_ENTRIES) consoleLog.shift();
    });

    // Network capture
    const netLog = [];
    pageNetworkLog.set(page, netLog);
    const reqStartTimes = new Map();
    page.on('request', req => { reqStartTimes.set(req, Date.now()); });
    page.on('response', resp => {
        const req = resp.request();
        const start = reqStartTimes.get(req) || Date.now();
        reqStartTimes.delete(req);
        netLog.push({
            method: req.method(),
            url: req.url(),
            status: resp.status(),
            contentType: (resp.headers()['content-type'] || '').split(';')[0].trim(),
            duration: Date.now() - start,
        });
        if (netLog.length > MAX_LOG_ENTRIES) netLog.shift();
    });
}

function getConsoleMessages(page) { return pageConsoleLog.get(page) || []; }
function getNetworkRequests(page) { return pageNetworkLog.get(page) || []; }
function clearConsoleMessages(page) { const log = pageConsoleLog.get(page); if (log) log.length = 0; }
function clearNetworkRequests(page) { const log = pageNetworkLog.get(page); if (log) log.length = 0; }

async function listPages() {
    const ctx = await getBrowserContext();
    const pages = ctx.pages();
    return pages.map((p, i) => ({
        index: i,
        title: p.title().catch(() => 'Error'),
        url: p.url(),
        active: p === activePage,
    }));
}

async function switchPage(index) {
    const ctx = await getBrowserContext();
    const pages = ctx.pages();
    if (index >= 0 && index < pages.length) {
        activePage = pages[index];
        await activePage.bringToFront();
        return true;
    }
    return false;
}

async function newPage() {
    activePage = await newPageWithRetry();
    setupPage(activePage);
    return activePage;
}

// ── Named Pages (Agent Parallelism) ────────────────────────────────────────────

async function createNamedPage(name) {
    const ctx = await getBrowserContext();
    // If name already exists, just switch to it
    if (namedPages.has(name)) {
        activePage = namedPages.get(name);
        await activePage.bringToFront();
        return false;
    }
    const pg = await newPageWithRetry();
    setupPage(pg);
    namedPages.set(name, pg);
    activePage = pg;
    return true;
}

async function switchToNamedPage(name) {
    if (!namedPages.has(name)) return false;
    activePage = namedPages.get(name);
    await activePage.bringToFront();
    return true;
}

async function removeNamedPage(name) {
    if (!namedPages.has(name)) return false;
    const pg = namedPages.get(name);
    namedPages.delete(name);
    try { await pg.close(); } catch (_) {}

    // Recover to another page
    if (activePage === pg || activePage?.isClosed()) {
        const remaining = Array.from(namedPages.values());
        const ctx = browserContext;
        if (remaining.length > 0) {
            activePage = remaining[0];
        } else if (ctx) {
            const ctxPages = ctx.pages().filter(p => !p.isClosed());
            activePage = ctxPages.length > 0 ? ctxPages[0] : await newPageWithRetry();
            setupPage(activePage);
        }
    }
    return true;
}

function listNamedPages() {
    return Array.from(namedPages.entries()).map(([name, pg]) => ({
        name,
        url: pg.url(),
        hasActivePage: pg === activePage,
    }));
}

function getActiveName() {
    for (const [name, pg] of namedPages) {
        if (pg === activePage) return name;
    }
    return 'default';
}

// ── Lifecycle ──────────────────────────────────────────────────────────────────

async function closeBrowser() {
    if (browserContext) {
        await browserContext.close();
        browserContext = null;
        activePage = null;
        activeRoutes.clear();
        namedPages.clear();
    }
    // Clear saved state so we start fresh next time
    try { fs.unlinkSync(STATE_FILE); } catch (_) {}
}

// ── Request Interception ───────────────────────────────────────────────────────

async function addRoute(pattern, action, options = {}) {
    const ctx = await getBrowserContext();
    if (activeRoutes.has(pattern)) {
        await ctx.unroute(pattern).catch(() => {});
    }
    await ctx.route(pattern, (route) => {
        if (action === 'block') return route.abort();
        if (action === 'mock') {
            return route.fulfill({
                status: options.status ?? 200,
                contentType: options.contentType ?? 'application/json',
                body: typeof options.body === 'object' ? JSON.stringify(options.body) : (options.body ?? ''),
                headers: options.headers ?? {},
            });
        }
        return route.continue({
            headers: { ...route.request().headers(), ...(options.headers ?? {}) },
        });
    });
    activeRoutes.set(pattern, { action, options });
    await saveState();
}

async function clearRoutes() {
    const ctx = await getBrowserContext();
    for (const pattern of activeRoutes.keys()) {
        await ctx.unroute(pattern).catch(() => {});
    }
    activeRoutes.clear();
    await saveState();
}

function listRoutes() {
    return Array.from(activeRoutes.entries()).map(([pattern, config]) => ({ pattern, ...config }));
}

// ── Health Check ───────────────────────────────────────────────────────────────

async function healthCheck() {
    const info = {
        contextAlive: false,
        pageResponsive: false,
        pageCount: 0,
        namedPageCount: namedPages.size,
        pageLatencyMs: null,
        activePageUrl: null,
        headless: CONFIG.headless,
        executablePath: CONFIG.executablePath || (CONFIG.channel ? `channel:${CONFIG.channel}` : 'playwright-bundled'),
        launchRetries: CONFIG.launchRetries,
    };
    try {
        const ctx = await getBrowserContext();
        const pages = ctx.pages();
        info.contextAlive = true;
        info.pageCount = pages.length;
        const page = await getPage();
        info.activePageUrl = page.url();
        const start = Date.now();
        await Promise.race([
            page.evaluate(() => 1),
            new Promise((_, rej) => setTimeout(() => rej(new Error('page evaluate timeout')), CONFIG.healthCheckTimeoutMs)),
        ]);
        info.pageLatencyMs = Date.now() - start;
        info.pageResponsive = true;
    } catch (e) {
        info.error = e.message;
    }
    return info;
}

module.exports = {
    getPage,
    getBrowserContext,
    closeBrowser,
    listPages,
    switchPage,
    newPage,
    createNamedPage,
    switchToNamedPage,
    removeNamedPage,
    listNamedPages,
    addRoute,
    clearRoutes,
    listRoutes,
    saveState,
    rotateSnapshot,
    saveSnapshot,
    getCurrSnapshot,
    getLastSnapshot,
    getConsoleMessages,
    getNetworkRequests,
    clearConsoleMessages,
    clearNetworkRequests,
    healthCheck,
};
