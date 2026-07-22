/*
 * Copyright (c) 2026 Azzar Budiyanto / LilyOpenCMS.
 * Licensed under the MIT License.
 * Contact: azzar.mr.zs@gmail.com for inquiries.
 *
 * Tool definitions and request handlers — registers all MCP tools, manages
 * named browser pages, handles routing/interception, and orchestrates
 * multi-step workflows like batch quizzes and parallel execution.
 */
const {
    getPage, closeBrowser, listPages, switchPage, newPage,
    getBrowserContext,
    addRoute, clearRoutes, listRoutes,
    createNamedPage, switchToNamedPage, removeNamedPage, listNamedPages,
    saveState,
    rotateSnapshot, saveSnapshot, getCurrSnapshot, getLastSnapshot,
    getConsoleMessages, getNetworkRequests, clearConsoleMessages, clearNetworkRequests,
    healthCheck,
} = require('../core/browser');
const { RecaptchaSolver } = require('../core/recaptcha');
const { captureState, observeInteractable, getElementByRef } = require('../core/state');
const cache = require('../core/cache');
const recorder = require('../core/recorder');
const fs = require('fs');
const path = require('path');
const { validateURL } = require('../utils/url-validator');

// Tesseract.js is optional — OCR tools gracefully degrade if not installed.
// This keeps the core bundle small while allowing OCR on demand.
let Tesseract;
try { Tesseract = require('tesseract.js'); } catch (_) { Tesseract = null; }

// SSRF protection flag — set via environment or tool
let allowPrivateIPs = process.env.ALLOW_PRIVATE_IPS === 'true';
let allowAllSchemes = process.env.ALLOW_ALL_SCHEMES === 'true';

// Behavioral profile controls timing and mouse movement patterns.
// 'stealth' adds human-like jitter and delays to avoid bot detection.
// 'speed' skips all delays for maximum throughput (CI/testing).
const AGENT_CONFIG = {
    profile: 'stealth',
};

// API capture state — persists across tool calls within a session.
// When active, page.on('response') listeners push matching responses here.
let capturedAPIs = [];
let apiCaptureActive = false;
let apiCapturePattern = null;
let isTracingRunning = false;

const TOOLS = [
    // ── Navigation & Tabs ─────────────────────────────────────────────────────
    {
        name: 'browser_navigate',
        description: 'Navigate to a URL. Retries automatically on network failure. Auto-switches to DuckDuckGo if Google shows CAPTCHA.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string' },
                retries: { type: 'number', default: 2, description: 'Number of retry attempts on failure.' },
                retryDelay: { type: 'number', default: 1000, description: 'Base delay in ms between retries (multiplied by attempt number).' },
            },
            required: ['url'],
        },
    },
    {
        name: 'browser_search',
        description: 'Search the web using DuckDuckGo (no CAPTCHA). Returns search results. Use this instead of navigating to Google directly.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query' },
            },
            required: ['query'],
        },
    },
    {
        name: 'browser_new_tab',
        description: 'Open a new browser tab.',
        inputSchema: {
            type: 'object',
            properties: { url: { type: 'string' } },
        },
    },
    {
        name: 'browser_list_tabs',
        description: 'List all open browser tabs.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'browser_switch_tab',
        description: 'Switch to a specific tab by index.',
        inputSchema: {
            type: 'object',
            properties: { index: { type: 'number' } },
            required: ['index'],
        },
    },
    {
        name: 'browser_wait_until_stable',
        description: 'Wait for the page to reach a stable state (networkidle).',
        inputSchema: {
            type: 'object',
            properties: { timeout: { type: 'number', default: 30000 } },
        },
    },
    {
        name: 'browser_wait_for_load',
        description: 'Wait for the page load event. Use instead of browser_wait_until_stable for pages with persistent WebSocket connections or polling that never reach networkidle.',
        inputSchema: {
            type: 'object',
            properties: {
                state: {
                    type: 'string',
                    enum: ['load', 'domcontentloaded'],
                    default: 'load',
                    description: '"load" waits for full page load including subresources. "domcontentloaded" fires earlier, once HTML is parsed.',
                },
                timeout: { type: 'number', default: 30000 },
            },
        },
    },
    {
        name: 'browser_back',
        description: 'Navigate back in history.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'browser_forward',
        description: 'Navigate forward in history.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'browser_reload',
        description: 'Reload the current page.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'browser_wait',
        description: 'Wait for a specified number of milliseconds.',
        inputSchema: {
            type: 'object',
            properties: { ms: { type: 'number' } },
            required: ['ms'],
        },
    },
    {
        name: 'browser_wait_for_selector',
        description: 'Wait for an element to appear.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string' },
                timeout: { type: 'number', default: 10000 },
            },
            required: ['selector'],
        },
    },
    {
        name: 'browser_wait_for_url',
        description: 'Wait for the URL to match a pattern.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Substring or regex (prefixed with regex:)' },
                timeout: { type: 'number', default: 15000 },
            },
            required: ['pattern'],
        },
    },

    // ── Interaction ───────────────────────────────────────────────────────────
    {
        name: 'browser_click',
        description: 'Click an element.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
                delay: { type: 'number', description: 'Delay between mousedown and mouseup (ms)' }
            },
        },
    },
    {
        name: 'browser_click_text',
        description: 'Click an element containing specific text.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string' },
                type: { type: 'string', enum: ['button', 'link', 'any'], default: 'any' },
            },
            required: ['text'],
        },
    },
    {
        name: 'browser_fill_form',
        description: 'Fill multiple form fields at once. Set typeAware=true to auto-detect input types (date, number, email, tel, url, select, checkbox, radio, file, contenteditable) and format values with the right Playwright method — much more reliable for structured forms than raw fill.',
        inputSchema: {
            type: 'object',
            properties: {
                data: { type: 'object', description: 'Key-value pairs of selector: value' },
                submit: { type: 'boolean', default: false, description: 'Whether to press Enter after filling' },
                typeAware: { type: 'boolean', default: false, description: 'Detect input type and format values automatically.' },
            },
            required: ['data'],
        },
    },
    {
        name: 'browser_double_click',
        description: 'Double-click an element.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
            },
        },
    },
    {
        name: 'browser_right_click',
        description: 'Right-click an element.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
            },
        },
    },
    {
        name: 'browser_hover',
        description: 'Hover over an element.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
            },
        },
    },
    {
        name: 'browser_drag',
        description: 'Drag from source to target.',
        inputSchema: {
            type: 'object',
            properties: {
                source: { type: 'string', description: 'Source selector' },
                target: { type: 'string', description: 'Target selector' },
            },
            required: ['source', 'target'],
        },
    },
    {
        name: 'browser_scroll',
        description: 'Scroll the page.',
        inputSchema: {
            type: 'object',
            properties: {
                direction: { type: 'string', enum: ['up', 'down'], default: 'down' },
                amount: { type: 'number' },
            },
        },
    },
    {
        name: 'browser_scroll_to',
        description: 'Scroll to an element or coordinates.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string' },
                x: { type: 'number' },
                y: { type: 'number' },
            },
        },
    },
    {
        name: 'browser_smart_scroll',
        description: 'Incremental scroll to trigger lazy loading.',
        inputSchema: {
            type: 'object',
            properties: {
                steps: { type: 'number', default: 5 },
                delayMs: { type: 'number', default: 800 },
            },
        },
    },

    // ── Forms & Input ─────────────────────────────────────────────────────────
    {
        name: 'browser_type',
        description: 'Type text into a field with optional human-like delay.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string' },
                text: { type: 'string' },
                delay: { type: 'number', description: 'Delay between keypresses in ms.', default: 50 },
            },
            required: ['selector', 'text'],
        },
    },
    {
        name: 'browser_clear',
        description: 'Clear an input field.',
        inputSchema: {
            type: 'object',
            properties: { selector: { type: 'string' } },
            required: ['selector'],
        },
    },
    {
        name: 'browser_press',
        description: 'Press a keyboard key.',
        inputSchema: {
            type: 'object',
            properties: { key: { type: 'string' } },
            required: ['key'],
        },
    },
    {
        name: 'browser_select',
        description: 'Select an option in a dropdown.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string' },
                value: { type: 'string', description: 'Value or label text' },
            },
            required: ['selector', 'value'],
        },
    },
    {
        name: 'browser_check',
        description: 'Check a checkbox or radio.',
        inputSchema: {
            type: 'object',
            properties: { selector: { type: 'string' } },
            required: ['selector'],
        },
    },
    {
        name: 'browser_uncheck',
        description: 'Uncheck a checkbox.',
        inputSchema: {
            type: 'object',
            properties: { selector: { type: 'string' } },
            required: ['selector'],
        },
    },

    // ── Observation ───────────────────────────────────────────────────────────
    {
        name: 'browser_get_state',
        description: 'Capture the current page state: URL, title, headings, text blocks, interactive elements (with ref numbers), AX tree, popups, and CAPTCHA status. Auto-saves snapshot for browser_state_diff. Pass screenshot=true to also include a visual screenshot — only do this when elements may be hidden from the AX tree (canvas, shadow DOM, iframes, visual-only widgets) or when layout context is needed.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                screenshot: {
                    type: 'boolean',
                    default: false,
                    description: 'Include a screenshot. Default false — only pass true when visual context is needed (canvas, iframes, hidden-from-AX elements).',
                },
                mark_elements: {
                    type: 'boolean',
                    default: false,
                    description: 'Set-of-Mark (SoM): If true, draws numeric badges over all interactable elements on the screenshot. The numbers match the `ref` IDs in the returned state, allowing LLMs to visually locate elements for clicking.',
                }
            },
        },
    },
    {
        name: 'browser_get_text',
        description: 'Read text from element(s). When all=true, returns up to maxLines results (default 100).',
        annotations: { readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string' },
                all: { type: 'boolean', default: false },
                maxLines: { type: 'number', description: 'Max number of elements to return when all=true. Default 100.' },
            },
            required: ['selector'],
        },
    },
    {
        name: 'browser_get_html',
        description: 'Get the full HTML content of the page or a specific element.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'Optional selector to get innerHTML of.' },
            },
        },
    },
    {
        name: 'browser_screenshot',
        description: 'Take a screenshot. Pass mark_elements=true to draw numeric badges over all interactable elements on the screenshot (Set-of-Mark).',
        annotations: { readOnlyHint: true },
        inputSchema: { 
            type: 'object', 
            properties: {
                mark_elements: {
                    type: 'boolean',
                    default: false,
                    description: 'Set-of-Mark (SoM): Draws numeric badges over interactable elements. The numbers will correspond to refs from observeInteractable.',
                }
            } 
        },
    },
    {
        name: 'browser_print_to_pdf',
        description: 'Print the current page to a PDF file. Returns the saved file path.',
        inputSchema: {
            type: 'object',
            properties: {
                outputPath: { type: 'string', description: 'Absolute path to save the PDF. Defaults to a timestamped file in the pdfs/ directory.' },
                landscape: { type: 'boolean', default: false },
                printBackground: { type: 'boolean', default: true },
                format: { type: 'string', default: 'A4' },
            },
        },
    },
    {
        name: 'browser_get_cookies',
        description: 'Get current browser cookies for the active page.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'browser_evaluate',
        description: 'Execute arbitrary JavaScript in the page context and return the result. Supports async/await, multi-statement scripts, and passing serializable data via args.',
        inputSchema: {
            type: 'object',
            properties: {
                script: {
                    type: 'string',
                    description: 'JS expression or statement block. Use `return` to return a value. May use `await`. Receives `args` as the first parameter.',
                },
                args: {
                    description: 'Serializable value passed into the script as `args`.',
                },
            },
            required: ['script'],
        },
    },
    {
        name: 'browser_state_diff',
        description: 'Compare the last two AX tree snapshots (saved automatically by browser_get_state). Returns structured diff: URL/title changes, new/removed headings, element changes, popup and captcha status transitions.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'browser_extract_table',
        description: 'Extract data from an HTML table into JSON.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector for the table' },
                header: { type: 'boolean', default: true, description: 'Whether the first row is a header' },
            },
            required: ['selector'],
        },
    },
    {
        name: 'browser_save_session',
        description: 'Save the current session with a name. Saves cookies by default; set includeStorage=true to also capture localStorage and sessionStorage (needed for sites that store auth tokens in Web Storage instead of cookies).',
        inputSchema: {
            type: 'object',
            properties: {
                name: { type: 'string' },
                includeStorage: {
                    type: 'boolean',
                    default: false,
                    description: 'Also capture localStorage and sessionStorage.',
                },
            },
            required: ['name'],
        },
    },
    {
        name: 'browser_load_session',
        description: 'Load a previously saved session. Restores cookies and, if the session was saved with includeStorage=true, also restores localStorage and sessionStorage.',
        inputSchema: {
            type: 'object',
            properties: { name: { type: 'string' } },
            required: ['name'],
        },
    },
    {
        name: 'browser_close',
        description: 'Close the browser session and clear state.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'browser_set_agent_profile',
        description: 'Set the agent behavior profile.',
        inputSchema: {
            type: 'object',
            properties: {
                profile: { type: 'string', enum: ['stealth', 'speed'], default: 'stealth' },
            },
            required: ['profile'],
        },
    },
    {
        name: 'browser_handle_captcha',
        description: 'Detect and handle CAPTCHA. Default: clicks checkbox, detects challenge type, returns immediately. Image: returns screenshot + prompt for agent to solve visually via browser_solve_captcha_grid. Audio: set audio=true to attempt whisper solve (with timeout param). Verify: set verify=true to check if solved. Agent is never blocked — can always use browser_screenshot or other tools between calls.',
        inputSchema: {
            type: 'object',
            properties: {
                verify: { type: 'boolean', default: false, description: 'Check if CAPTCHA was already solved.' },
                audio: { type: 'boolean', default: false, description: 'Attempt audio challenge solving via local whisper.' },
                timeout: { type: 'number', default: 30000, description: 'Max time for audio solve (ms).' }
            }
        },
    },
    {
        name: 'browser_solve_captcha_grid',
        description: 'Click image CAPTCHA grid tiles by index (1-based, 1-9 for 3x3 grid). Use after browser_handle_captcha returns an image challenge. Call browser_handle_captcha again to verify result.',
        inputSchema: {
            type: 'object',
            properties: {
                indices: { type: 'array', items: { type: 'number' }, description: '1-based tile indices to click (e.g., [1, 3, 5] for tiles 0, 2, 4 in the grid).' },
                action: { type: 'string', enum: ['verify'], default: 'verify', description: 'Action to take after clicking tiles (only verify supported).' }
            },
            required: ['indices'],
        },
    },

    // ── Named Pages / Agent Parallelism ──────────────────────────────────────
    {
        name: 'browser_agent_create',
        description: 'Create or switch to a named page/agent. Each named page is independent — use this to run parallel automation flows.',
        inputSchema: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Unique name for the agent page.' } },
            required: ['name'],
        },
    },
    {
        name: 'browser_agent_switch',
        description: 'Switch the active page to an existing named agent.',
        inputSchema: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Name of the agent to switch to.' } },
            required: ['name'],
        },
    },
    {
        name: 'browser_agent_remove',
        description: 'Remove and close a named agent page.',
        inputSchema: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Name of the agent to remove.' } },
            required: ['name'],
        },
    },
    {
        name: 'browser_agent_list',
        description: 'List all named agent pages and their URLs.',
        inputSchema: { type: 'object', properties: {} },
    },

    // ── Phase 2 Enhancements ─────────────────────────────────────────────────
    {
        name: 'browser_intercept_api',
        description: 'Capture API responses matching a URL pattern. Stores responses in memory for later retrieval. Use to extract quiz data, form options, or any XHR/fetch response without DOM scraping.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'URL pattern to match (glob or regex). E.g. "**/api/**", "**/exam*"' },
                action: { type: 'string', enum: ['start', 'stop', 'get'], default: 'start', description: '"start" begins capturing. "stop" stops and returns all captured. "get" returns captured without changing state.' },
                reloadPage: { type: 'boolean', default: false, description: 'If true, reload page after starting capture to trigger fresh API calls.' },
            },
            required: ['pattern'],
        },
    },
    {
        name: 'browser_batch_answer_quiz',
        description: 'Batch answer multiple quiz questions in a single tool call. Navigates through pages, selects answers, and optionally submits. Handles radio and checkbox questions. Returns results with errors.',
        inputSchema: {
            type: 'object',
            properties: {
                answers: {
                    type: 'array',
                    description: 'Array of answers. Each entry: {q: <questionIndex>, option: <optionIndex>} or {q: <questionIndex>, options: [<indices>]} for checkboxes.',
                    items: {
                        type: 'object',
                        properties: {
                            q: { type: 'number', description: '0-based question index on the current page' },
                            option: { type: 'number', description: '0-based option index for radio questions' },
                            options: { type: 'array', items: { type: 'number' }, description: 'Array of indices for checkbox questions' },
                        },
                        required: ['q'],
                    },
                },
                submitAfter: { type: 'boolean', default: false, description: 'Click submit button after answering all questions.' },
                nextSelector: { type: 'string', description: 'CSS selector for the "Next" button. Auto-detected if not provided.' },
                submitSelector: { type: 'string', description: 'CSS selector for the "Submit" button. Auto-detected if not provided.' },
            },
            required: ['answers'],
        },
    },
    {
        name: 'browser_switch_to_new_tab',
        description: 'Detect and switch to a newly opened tab/popup. Returns the new tab URL and switches focus to it.',
        inputSchema: {
            type: 'object',
            properties: {
                urlPattern: { type: 'string', description: 'Optional URL pattern to match the new tab. If not provided, switches to most recent new tab.' },
                timeout: { type: 'number', default: 10000, description: 'Max wait time in ms for new tab to appear.' },
            },
        },
    },
    {
        name: 'browser_get_captured_apis',
        description: 'Retrieve all API responses captured by browser_intercept_api. Returns structured JSON data.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Optional filter pattern to match against captured URLs.' },
                clearAfter: { type: 'boolean', default: false, description: 'Clear captured data after retrieval.' },
            },
        },
    },

    // ── Phase 3 Enhancements ─────────────────────────────────────────────────
    {
        name: 'browser_ocr',
        description: 'Extract text from a screenshot or code block using OCR (Tesseract.js). Use for reading code images, CAPTCHAs, or any visual text that is not accessible via DOM.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector to screenshot (e.g. ".code-block"). If omitted, screenshots full page.' },
                language: { type: 'string', default: 'eng', description: 'Tesseract language code (eng, ind, etc.)' },
                preprocess: { type: 'string', enum: ['none', 'threshold', 'grayscale', 'sharpen'], default: 'threshold', description: 'Image preprocessing for better OCR accuracy.' },
                returnImage: { type: 'boolean', default: false, description: 'Also return the preprocessed image as base64.' },
            },
        },
    },
    {
        name: 'browser_record_macro',
        description: 'Control macro recording. Start recording user actions, stop and get the recorded script, or clear the recording buffer.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['start', 'stop', 'clear', 'list', 'export'] },
                name: { type: 'string', description: 'Name for the macro (used in export/save).' },
                format: { type: 'string', enum: ['playwright', 'json', 'actions'], default: 'playwright', description: 'Export format.' },
                save: { type: 'boolean', default: false, description: 'Save to user_data/macros/ directory.' },
            },
            required: ['action'],
        },
    },
    {
        name: 'browser_replay_macro',
        description: 'Replay a recorded macro or a list of actions. Can replay from JSON actions or a saved macro file.',
        inputSchema: {
            type: 'object',
            properties: {
                actions: { type: 'array', description: 'Array of action objects to replay. Each: {type, args}' },
                macroName: { type: 'string', description: 'Name of a saved macro to replay from user_data/macros/.' },
                speed: { type: 'string', enum: ['fast', 'normal', 'slow'], default: 'normal', description: 'Replay speed.' },
                dryRun: { type: 'boolean', default: false, description: 'If true, log actions without executing.' },
            },
        },
    },
    {
        name: 'browser_parallel_execute',
        description: 'Execute actions on multiple named pages concurrently. Returns results from all pages.',
        inputSchema: {
            type: 'object',
            properties: {
                tasks: {
                    type: 'array',
                    description: 'Array of tasks: {page: <name>, actions: [{tool, args}]}',
                    items: {
                        type: 'object',
                        properties: {
                            page: { type: 'string', description: 'Named page to execute on' },
                            actions: { type: 'array', description: 'Actions to execute sequentially on this page' },
                        },
                        required: ['page', 'actions'],
                    },
                },
                timeout: { type: 'number', default: 30000, description: 'Max time per task in ms.' },
            },
            required: ['tasks'],
        },
    },

    // ── Request Interception ──────────────────────────────────────────────────
    {
        name: 'browser_intercept',
        description: 'Intercept network requests matching a URL pattern. Use to block ads/trackers, mock API responses, or inject headers. Rules persist for the session until browser_clear_intercepts is called.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'URL glob pattern (e.g. "**/api/users*") or exact URL.' },
                action: {
                    type: 'string',
                    enum: ['block', 'mock', 'modify'],
                    description: '"block" aborts the request. "mock" returns a synthetic response. "modify" passes through with extra headers.',
                },
                status: { type: 'number', default: 200, description: 'HTTP status code for mock responses.' },
                body: { description: 'Response body for mock (string or object — objects are JSON-serialized).' },
                contentType: { type: 'string', default: 'application/json', description: 'Content-Type header for mock responses.' },
                headers: { type: 'object', description: 'Headers to inject (mock: sets response headers; modify: merges into request headers).' },
            },
            required: ['pattern', 'action'],
        },
    },
    {
        name: 'browser_intercept_list',
        description: 'List all active request intercept rules.',
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'browser_clear_intercepts',
        description: 'Remove all active request intercept rules.',
        inputSchema: { type: 'object', properties: {} },
    },

    // ── Health & Diagnostics ───────────────────────────────────────────────────
    {
        name: 'browser_health',
        description: 'Check browser health: context alive, page responsive, page count, active URL, and evaluate latency. Read-only. Use to diagnose crashes, zombie contexts, or unresponsive pages.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {} },
    },

    // ── State Export & Session Discovery ──────────────────────────────────────
    {
        name: 'browser_export_state',
        description: 'Export the current page state (URL, title, headings, text, interactive elements, cookies, localStorage, sessionStorage, optional AX tree) as a JSON file. Use to create a reproducible snapshot for sharing with other agents, debugging, or replay. Defaults to exports/state-<timestamp>.json.',
        inputSchema: {
            type: 'object',
            properties: {
                outputPath: { type: 'string', description: 'Absolute path for the JSON file. Defaults to exports/state-<timestamp>.json.' },
                includeAxTree: { type: 'boolean', default: false, description: 'Include the full accessibility tree (significantly larger output).' },
                includeStorage: { type: 'boolean', default: true, description: 'Include localStorage and sessionStorage.' },
            },
        },
    },
    {
        name: 'browser_list_sessions',
        description: 'List all saved session files in the sessions/ directory with name, size, cookie count, origin, and modified time. Read-only.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {} },
    },

    // ── Phase 1 Enhancements ─────────────────────────────────────────────────
    {
        name: 'browser_wait_for_navigation',
        description: 'Smart wait after an action: waits for URL to change/contain a pattern, or for a specific selector to appear. Use after clicks that trigger navigation instead of fixed browser_wait.',
        inputSchema: {
            type: 'object',
            properties: {
                urlPattern: { type: 'string', description: 'Wait until URL contains this string. Supports regex: prefix.' },
                selector: { type: 'string', description: 'Wait for this CSS selector to appear on the page.' },
                timeout: { type: 'number', default: 15000, description: 'Max wait time in ms.' },
            },
        },
    },
    {
        name: 'browser_select_by_index',
        description: 'Select a radio button or checkbox by its 0-based index within a group. Use for quiz questions or radio groups where text matching is unreliable.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector matching the radio/checkbox group (e.g. "input[name=q5]")' },
                index: { type: 'number', description: '0-based index of the option to select.' },
                indices: { type: 'array', items: { type: 'number' }, description: 'For checkboxes: array of 0-based indices to check.' },
            },
            required: ['selector'],
        },
    },
    {
        name: 'browser_get_visible_text',
        description: 'Extract clean text from only visible elements on the page. Skips hidden, display:none, and zero-size elements. Returns structured text without DOM noise.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'Optional CSS selector to scope extraction (default: main content area).' },
            },
        },
    },

    // ── Helpers ───────────────────────────────────────────────────────────────
    {
        name: 'browser_dismiss_popups',
        description: 'Try to dismiss common popups and banners.',
        inputSchema: { type: 'object', properties: {} },
    },

    // ── Observe / Ref-click ───────────────────────────────────────────────────
    {
        name: 'browser_observe',
        description: 'Return only interactable elements (buttons, inputs, links, selects) without a screenshot. Each element gets a stable `ref` number. Use before planning an action to enumerate available targets with minimal token cost — then act with browser_click_ref or browser_type.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {} },
    },
    {
        name: 'browser_click_ref',
        description: 'Click an element by its `ref` number from the last browser_observe or browser_get_state call. More reliable than selectors for dynamic pages — no re-snapshotting needed.',
        inputSchema: {
            type: 'object',
            properties: {
                ref: { type: 'number', description: '1-based ref index from the last observe/state call.' },
            },
            required: ['ref'],
        },
    },

    // ── CDP Diagnostics ───────────────────────────────────────────────────────
    {
        name: 'browser_console_messages',
        description: 'Return captured browser console messages and page errors (last 100). Useful for debugging — check for JS errors after interactions. Read-only.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    enum: ['all', 'error', 'warning', 'log'],
                    default: 'all',
                    description: 'Filter by message type.',
                },
                clear: { type: 'boolean', default: false, description: 'Clear the log after reading.' },
                maxLines: { type: 'number', description: 'Maximum messages to return. Defaults to 100 (buffer size).' },
            },
        },
    },
    {
        name: 'browser_network_requests',
        description: 'Return captured network requests and their response status/timing (last 100). Useful for verifying API calls, detecting failed fetches, or inspecting what URLs are being hit. Read-only.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                filter: { type: 'string', description: 'Optional URL substring to filter results.' },
                statusMin: { type: 'number', description: 'Only return requests with status >= this value (e.g. 400 for errors).' },
                clear: { type: 'boolean', default: false, description: 'Clear the log after reading.' },
                maxLines: { type: 'number', description: 'Maximum requests to return. Defaults to 100.' },
            },
        },
    },

    // ── Schema Extraction ─────────────────────────────────────────────────────
    {
        name: 'browser_extract_schema',
        description: 'Extract structured data from the page matching a JSON schema. Provide a schema object with property names and descriptions — the tool scrapes the page and returns a typed JSON object. More reliable than text extraction for structured data (prices, tables, forms, product info).',
        inputSchema: {
            type: 'object',
            properties: {
                schema: {
                    type: 'object',
                    description: 'JSON Schema object describing the shape to extract. Each property should have a "description" hint for where to find it on the page.',
                },
                selector: {
                    type: 'string',
                    description: 'Optional CSS selector to scope the extraction to a specific element.',
                },
            },
            required: ['schema'],
        },
    },

    // ── Test Generation ───────────────────────────────────────────────────────
    {
        name: 'browser_generate_playwright_test',
        description: 'Generate a replayable Playwright test script from the recorded actions in this session. Returns a .spec.js file content. Call browser_clear_recording first to start a fresh recording.',
        inputSchema: {
            type: 'object',
            properties: {
                testName: { type: 'string', description: 'Name for the test case.', default: 'recorded_session' },
                outputPath: { type: 'string', description: 'Optional absolute path to save the .spec.js file.' },
            },
        },
    },
    {
        name: 'browser_clear_recording',
        description: 'Clear the current session action recording. Call before a workflow you want to capture as a test.',
        inputSchema: { type: 'object', properties: {} },
    },

    // ── Performance ───────────────────────────────────────────────────────────
    {
        name: 'browser_performance',
        description: 'Return Core Web Vitals and browser performance metrics for the current page using CDP. Includes LCP, CLS, FID estimates, navigation timing, and resource counts. Read-only.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {} },
    },

    // ── Planner-Validator ─────────────────────────────────────────────────────
    {
        name: 'browser_assert',
        description: 'Validate a condition on the current page. On failure, returns what is actually present to help re-plan. Use after actions to verify outcomes before continuing.',
        inputSchema: {
            type: 'object',
            properties: {
                condition: {
                    type: 'string',
                    description: 'What to check — either a CSS selector that must exist, a URL pattern to match, or a JS expression returning a boolean.',
                },
                conditionType: {
                    type: 'string',
                    enum: ['selector', 'url', 'js'],
                    default: 'selector',
                },
                expected: {
                    type: 'string',
                    description: 'For selector: optional text the element must contain. For url: pattern to match. For js: ignored (expression must return truthy).',
                },
            },
            required: ['condition'],
        },
    },

    // ── Cache Management ──────────────────────────────────────────────────────
    {
        name: 'browser_cache_stats',
        description: 'Return statistics about the action selector cache (hit count, entries, stale entries). Read-only.',
        annotations: { readOnlyHint: true },
        inputSchema: { type: 'object', properties: {} },
    },

    // ── Assertions (never throw — return PASS/FAIL) ──────────────────────────
    {
        name: 'browser_assert_visible',
        description: 'Check if an element is visible on the page. Returns [PASS]/[FAIL] — never throws. Use for verification without breaking flow.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector to check' },
            },
            required: ['selector'],
        },
    },
    {
        name: 'browser_assert_text',
        description: 'Check if an element contains expected text (substring match). Returns [PASS]/[FAIL] with context — never throws.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector' },
                expected: { type: 'string', description: 'Expected text substring' },
            },
            required: ['selector', 'expected'],
        },
    },
    {
        name: 'browser_assert_url',
        description: 'Check if current URL contains a pattern. Returns [PASS]/[FAIL] — never throws.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Substring to match in URL' },
            },
            required: ['pattern'],
        },
    },

    // ── Perception (read page content as structured data) ────────────────────
    {
        name: 'browser_get_page_markdown',
        description: 'Extract page content as structured markdown (headings, lists, tables, links). Better than raw text for reading comprehension.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'Optional CSS selector to scope extraction (default: main content area).' },
                maxLength: { type: 'number', description: 'Max output length in chars. Default 5000.' },
            },
        },
    },
    {
        name: 'browser_get_accessibility_tree',
        description: 'Get the accessibility tree as structured text — roles, names, states. Useful for understanding page structure without screenshots.',
        annotations: { readOnlyHint: true },
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'Optional CSS selector to scope extraction.' },
                maxLength: { type: 'number', description: 'Max output length in chars. Default 5000.' },
            },
        },
    },

    // ── Network Mocking ──────────────────────────────────────────────────────
    {
        name: 'browser_mock_network',
        description: 'Mock API responses for frontend testing. Intercepts matching URLs and returns synthetic data without touching the backend.',
        inputSchema: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'URL glob pattern to match (e.g. "**/api/users*")' },
                body: { description: 'Response body (string or JSON object)' },
                status: { type: 'number', default: 200, description: 'HTTP status code' },
                contentType: { type: 'string', default: 'application/json', description: 'Content-Type header' },
            },
            required: ['pattern', 'body'],
        },
    },
    {
        name: 'browser_clear_mocks',
        description: 'Remove all network mock routes and restore normal behavior.',
        inputSchema: { type: 'object', properties: {} },
    },

    // ── Dialog Handling ──────────────────────────────────────────────────────
    {
        name: 'browser_dialog',
        description: 'Set up handler for JavaScript dialogs (alert, confirm, prompt). Call BEFORE the action that triggers the dialog.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['accept', 'dismiss'], description: 'How to handle the dialog' },
                promptText: { type: 'string', description: 'Text to enter for window.prompt() dialogs' },
            },
            required: ['action'],
        },
    },

    // ── File Upload ──────────────────────────────────────────────────────────
    {
        name: 'browser_upload',
        description: 'Upload a file to an <input type="file"> element. Provide absolute file path(s).',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector for file input' },
                filePath: { type: 'string', description: 'Absolute path to file. Comma-separated for multiple files.' },
            },
            required: ['selector', 'filePath'],
        },
    },

    // ── Click Nth ────────────────────────────────────────────────────────────
    {
        name: 'browser_click_nth',
        description: 'Click the Nth element matching a selector (0-based). Avoids "strict mode violation" when multiple elements match.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector matching multiple elements' },
                index: { type: 'number', description: '0-based index of which match to click' },
            },
            required: ['selector', 'index'],
        },
    },

    // ── Visual Debug ─────────────────────────────────────────────────────────
    {
        name: 'browser_highlight',
        description: 'Draw a colored border around an element for visual debugging. Useful before taking screenshots to verify element location.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector to highlight' },
                color: { type: 'string', default: 'red', description: 'Border color' },
                durationMs: { type: 'number', default: 3000, description: 'How long to show the highlight (ms)' },
            },
            required: ['selector'],
        },
    },

    // ── Wait for Change ──────────────────────────────────────────────────────
    {
        name: 'browser_wait_for_change',
        description: 'Wait for an element text or attribute to change. Essential for SPAs where content updates after actions.',
        inputSchema: {
            type: 'object',
            properties: {
                selector: { type: 'string', description: 'CSS selector to watch' },
                attribute: { type: 'string', description: 'Attribute to watch (default: textContent)' },
                timeout: { type: 'number', default: 10000, description: 'Max wait in ms' },
            },
            required: ['selector'],
        },
    },

    // ── Emulation & Viewport ──────────────────────────────────────────────────
    {
        name: 'browser_emulate',
        description: 'Emulate network conditions, CPU throttling, geolocation, locale, timezone, and color scheme.',
        inputSchema: {
            type: 'object',
            properties: {
                networkProfile: {
                    type: 'string',
                    enum: ['no-throttling', 'offline', 'Slow 3G', 'Fast 3G'],
                    description: 'Standard network throttling profile to apply.'
                },
                cpuThrottlingRate: {
                    type: 'number',
                    description: 'CPU throttling rate multiplier (e.g. 2 for 2x slowdown, 4 for 4x slowdown). Use 1 or null to disable.'
                },
                geolocation: {
                    type: 'object',
                    properties: {
                        latitude: { type: 'number' },
                        longitude: { type: 'number' },
                        accuracy: { type: 'number', default: 100 }
                    },
                    required: ['latitude', 'longitude'],
                    description: 'Geolocation coordinates to emulate.'
                },
                colorScheme: {
                    type: 'string',
                    enum: ['light', 'dark', 'no-preference'],
                    description: 'Emulate prefer-color-scheme media query.'
                },
                timezoneId: {
                    type: 'string',
                    description: 'Emulate timezone (e.g., "America/New_York", "Europe/London").'
                },
                locale: {
                    type: 'string',
                    description: 'Emulate locale (e.g., "en-US", "fr-FR").'
                }
            }
        }
    },
    {
        name: 'browser_resize_page',
        description: 'Set viewport width and height dynamically on the active page.',
        inputSchema: {
            type: 'object',
            properties: {
                width: { type: 'number', description: 'Viewport width in pixels' },
                height: { type: 'number', description: 'Viewport height in pixels' }
            },
            required: ['width', 'height']
        }
    },

    // ── Playwright Trace Recording ───────────────────────────────────────────
    {
        name: 'browser_start_trace',
        description: 'Start recording a detailed Playwright trace including screenshots, snapshots, and network events.',
        inputSchema: {
            type: 'object',
            properties: {
                screenshots: { type: 'boolean', default: true, description: 'Whether to capture screenshots during tracing.' },
                snapshots: { type: 'boolean', default: true, description: 'Whether to capture DOM snapshots during tracing.' }
            }
        }
    },
    {
        name: 'browser_stop_trace',
        description: 'Stop recording trace and save zip file. Defaults to exports/trace-<timestamp>.zip.',
        inputSchema: {
            type: 'object',
            properties: {
                outputPath: { type: 'string', description: 'Absolute path for the zip file. Defaults to exports/trace-<timestamp>.zip.' }
            }
        }
    },
];

async function handleToolCall(name, args) {
    const page = await getPage();

    switch (name) {
        // Navigation
        case 'browser_navigate': {
            // SSRF protection — validate URL before navigation
            try {
                validateURL(args.url, { allowPrivate: allowPrivateIPs, allowAllSchemes });
            } catch (e) {
                return { content: [{ type: 'text', text: `URL blocked: ${e.message}` }], isError: true };
            }

            const retries = args.retries ?? 2;
            const retryDelay = args.retryDelay ?? 1000;
            let lastError;
            for (let attempt = 0; attempt <= retries; attempt++) {
                try {
                    await page.goto(args.url, { waitUntil: 'load', timeout: 30000 });
                    // Auto-fallback: if Google shows CAPTCHA, switch to DuckDuckGo
                    const url = page.url();
                    if (url.includes('google.com/sorry') || url.includes('google.com/search')) {
                        const hasCaptcha = await page.$('iframe[title="reCAPTCHA"]').catch(() => null);
                        if (hasCaptcha && url.includes('/sorry')) {
                            const query = new URL(args.url).searchParams.get('q') || '';
                            if (query) {
                                await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}`, { waitUntil: 'load', timeout: 15000 });
                                await saveState();
                                return { content: [{ type: 'text', text: `Google blocked with CAPTCHA. Switched to DuckDuckGo for: "${query}"` }] };
                            }
                        }
                    }
                    await saveState();
                    recorder.record('navigate', { url: args.url });
                    const suffix = attempt > 0 ? ` (succeeded on attempt ${attempt + 1})` : '';
                    return { content: [{ type: 'text', text: `Navigated to ${args.url}${suffix}` }] };
                } catch (e) {
                    lastError = e;
                    if (attempt < retries) await page.waitForTimeout(retryDelay * (attempt + 1));
                }
            }
            return { content: [{ type: 'text', text: `Failed to navigate to ${args.url} after ${retries + 1} attempt(s): ${lastError.message}` }], isError: true };
        }
        case 'browser_search': {
            const query = args.query;
            const ddgUrl = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
            try {
                await page.goto(ddgUrl, { waitUntil: 'load', timeout: 20000 });
                await saveState();
                recorder.record('navigate', { url: ddgUrl });
                return { content: [{ type: 'text', text: `Searched DuckDuckGo for: "${query}"` }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `Search failed: ${e.message}` }], isError: true };
            }
        }
        case 'browser_new_tab': {
            const newPg = await newPage();
            if (args.url) await newPg.goto(args.url, { waitUntil: 'load' });
            return { content: [{ type: 'text', text: `Opened new tab${args.url ? ' at ' + args.url : ''}.` }] };
        }
        case 'browser_list_tabs': {
            const pages = await listPages();
            const text = pages.map(p => `[${p.index}] ${p.active ? '*' : ' '} ${p.title} (${p.url})`).join('\n');
            return { content: [{ type: 'text', text }] };
        }
        case 'browser_switch_tab': {
            const success = await switchPage(args.index);
            return { content: [{ type: 'text', text: success ? `Switched to tab ${args.index}.` : `Failed to switch to tab ${args.index}.` }] };
        }
        case 'browser_wait_until_stable':
            await page.waitForLoadState('networkidle', { timeout: args.timeout || 30000 });
            return { content: [{ type: 'text', text: 'Page state is stable.' }] };
        case 'browser_wait_for_load':
            await page.waitForLoadState(args.state || 'load', { timeout: args.timeout || 30000 });
            return { content: [{ type: 'text', text: `Page reached "${args.state || 'load'}" state.` }] };
        case 'browser_back':
            await page.goBack({ waitUntil: 'load' });
            return { content: [{ type: 'text', text: 'Navigated back.' }] };
        case 'browser_forward':
            await page.goForward({ waitUntil: 'load' });
            return { content: [{ type: 'text', text: 'Navigated forward.' }] };
        case 'browser_reload':
            await page.reload({ waitUntil: 'load' });
            return { content: [{ type: 'text', text: 'Reloaded.' }] };
        case 'browser_wait':
            await page.waitForTimeout(args.ms);
            return { content: [{ type: 'text', text: `Waited ${args.ms}ms.` }] };
        case 'browser_wait_for_selector':
            await page.waitForSelector(args.selector, { timeout: args.timeout || 10000 });
            return { content: [{ type: 'text', text: `Selector ${args.selector} is visible.` }] };
        case 'browser_wait_for_url': {
            const isRegex = args.pattern.startsWith('regex:');
            const pattern = isRegex ? args.pattern.slice(6) : args.pattern;
            await page.waitForFunction(([pat, rx]) => {
                const u = location.href;
                return rx ? new RegExp(pat).test(u) : u.includes(pat);
            }, [pattern, isRegex], { timeout: args.timeout || 15000 });
            return { content: [{ type: 'text', text: `URL matches pattern.` }] };
        }

        // Interaction
        case 'browser_click': {
            const delay = args.delay || (AGENT_CONFIG.profile === 'stealth' ? Math.floor(Math.random() * 100) + 50 : 0);
            
            if (!args.selector && args.x !== undefined && args.y !== undefined) {
                // Coordinate click — no fallback needed
                if (AGENT_CONFIG.profile === 'stealth') {
                    await page.mouse.move(args.x + (Math.random() - 0.5) * 4, args.y + (Math.random() - 0.5) * 4, { steps: 5 });
                    await page.waitForTimeout(Math.random() * 200 + 100);
                }
                await page.mouse.click(args.x, args.y, { delay });
                return { content: [{ type: 'text', text: `Clicked at (${args.x}, ${args.y}) with ${delay}ms delay.` }] };
            }

            // Smart retry with fallback selectors
            // Why: text= selectors fail with "strict mode violation" when multiple elements match.
            // Strategy: try the original selector, then relax constraints progressively.
            // Order: exact → :not([disabled]) → role-based → text variants → element discovery.
            const selector = args.selector;
            const hostname = page.url() ? new URL(page.url()).hostname : 'unknown';
            const fallbacks = [
                selector,
                `${selector}:not([disabled])`,
                // If selector already contains :has-text(), don't extract text again
                ...(selector.includes(':has-text(') ? [] : [
                    `button:has-text("${selector.replace(/.*has-text\("([^"]+)"\).*/, '$1')}")`,
                    `[role="button"]:has-text("${selector.replace(/.*has-text\("([^"]+)"\).*/, '$1')}")`,
                    `a:has-text("${selector.replace(/.*has-text\("([^"]+)"\).*/, '$1')}")`,
                ]),
                // For plain text strings (no CSS syntax), try Playwright text selectors
                ...(!selector.includes('.') && !selector.includes('#') && !selector.includes('[') ? [
                    `text="${selector}"`,
                    `text=${selector}`,
                ] : []),
            ];

            // Try each fallback with a short timeout — first match wins
            let lastError;
            for (const fb of fallbacks) {
                try {
                    const loc = page.locator(fb).first();
                    // Trial click ensures the element is visible, enabled, and NOT occluded by a modal.
                    await loc.click({ trial: true, timeout: 2000 });
                    
                    const box = await loc.boundingBox({ timeout: 2000 });
                    if (!box) continue;

                    // Stealth mode: move mouse to center with jitter, then click
                    // This mimics human behavior and avoids bot detection heuristics
                    if (AGENT_CONFIG.profile === 'stealth') {
                        const jitterX = (Math.random() - 0.5) * 4;
                        const jitterY = (Math.random() - 0.5) * 4;
                        await page.mouse.move(box.x + box.width / 2 + jitterX, box.y + box.height / 2 + jitterY, { steps: 5 });
                        await page.waitForTimeout(Math.random() * 200 + 100);
                    }

                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay });
                    const usedFallback = fb !== selector ? ` (fallback: ${fb})` : '';
                    recorder.record('click', { selector, fallback: fb !== selector ? fb : undefined });
                    return { content: [{ type: 'text', text: `Clicked "${selector}"${usedFallback} with ${delay}ms delay.` }] };
                } catch (e) {
                    lastError = e;
                }
            }

            // Last resort: scan the accessibility tree for any element whose text matches.
            // This handles cases where the DOM structure is completely different from
            // what the selector expects (e.g., custom web components, shadow DOM).
            const observed = await observeInteractable(page);
            const match = observed.elements.find(el => {
                const t = (el.text || '').toLowerCase();
                const s = selector.toLowerCase();
                return t.includes(s) || s.includes(t);
            });

            if (match) {
                const cx = match.x + Math.floor(match.w / 2);
                const cy = match.y + Math.floor(match.h / 2);
                await page.mouse.click(cx, cy, { delay });
                return { content: [{ type: 'text', text: `Clicked "${selector}" via element discovery fallback at (${cx}, ${cy}).` }] };
            }

            return { content: [{ type: 'text', text: `All click strategies failed for "${selector}". Last error: ${lastError?.message}` }], isError: true };
        }
        case 'browser_click_text': {
            const hostname = new URL(page.url()).hostname;
            const cacheKey = `click_text::${args.type || 'any'}::${args.text}`;
            const cached = cache.get(hostname, cacheKey);

            if (cached) {
                const ok = await page.click(cached).then(() => true).catch(() => false);
                if (ok) {
                    recorder.record('click_text', { text: args.text, elType: args.type, selector: cached });
                    return { content: [{ type: 'text', text: `Clicked "${args.text}" (cache hit: ${cached}).` }] };
                }
                cache.invalidate(hostname, cacheKey);
            }

            // Cache miss or stale: discover selector
            const baseSelector = args.type === 'button' ? 'button, [role="button"]' : args.type === 'link' ? 'a, [role="link"]' : '*';
            const selector = `${baseSelector}:has-text("${args.text}")`;
            await page.click(selector);
            cache.set(hostname, cacheKey, selector);
            recorder.record('click_text', { text: args.text, elType: args.type, selector });
            return { content: [{ type: 'text', text: `Clicked element with text "${args.text}".` }] };
        }
        case 'browser_fill_form': {
            // Type-aware mode detects each input's HTML type and uses the right Playwright method.
            // Why: plain page.fill() doesn't work for checkboxes, selects, file inputs, or
            // contenteditable divs. This auto-detects and dispatches correctly.
            const actions = [];
            for (const [sel, rawVal] of Object.entries(args.data)) {
                const value = String(rawVal);
                if (!args.typeAware) {
                    await page.fill(sel, value);
                    actions.push('fill');
                    continue;
                }

                // Query the element's tag, type attribute, and contenteditable state
                // from the browser context — we need live DOM info, not just the selector.
                const meta = await page.evaluate((s) => {
                    const el = document.querySelector(s);
                    if (!el) return null;
                    return {
                        tag: el.tagName,
                        type: (el.getAttribute('type') || '').toLowerCase(),
                        isContentEditable: el.getAttribute('contenteditable') === 'true' || el.isContentEditable,
                    };
                }, sel);

                if (!meta) {
                    await page.fill(sel, value);
                    actions.push('fill (no element)');
                    continue;
                }

                // Contenteditable elements need keyboard.type(), not fill()
                if (meta.isContentEditable) {
                    await page.locator(sel).click();
                    await page.keyboard.type(value, { delay: 30 });
                    actions.push('type (contenteditable)');
                } else if (meta.tag === 'SELECT') {
                    // Match by value or label text — users often pass human-readable labels
                    const opts = await page.evaluate((s) => {
                        const el = document.querySelector(s);
                        return Array.from(el?.options || []).map(o => ({ value: o.value, label: o.text }));
                    }, sel);
                    const match = opts.find(o => o.value === value || o.label === value);
                    await page.selectOption(sel, match?.value ?? value);
                    actions.push(`select (${match ? 'matched' : 'fallback'})`);
                } else if (meta.type === 'checkbox' || meta.type === 'radio') {
                    // Accept truthy strings: "true", "1", "on", "yes", or boolean true
                    const truthy = value === true || value === 'true' || value === '1' || value === 'on' || value === 'yes';
                    if (truthy) await page.check(sel); else await page.uncheck(sel);
                    actions.push(truthy ? 'check' : 'uncheck');
                } else if (meta.type === 'file') {
                    // Comma-separated file paths for multi-file inputs
                    const files = value.split(',').map(s => s.trim()).filter(Boolean);
                    await page.setInputFiles(sel, files);
                    actions.push(`setInputFiles (${files.length})`);
                } else if (meta.type === 'number' || meta.type === 'range') {
                    // Strip non-numeric characters but keep scientific notation (e.g., "1e5")
                    const num = parseFloat(String(value).replace(/[^0-9.\-eE]/g, ''));
                    await page.fill(sel, isNaN(num) ? value : String(num));
                    actions.push('fill (number)');
                } else if (meta.type === 'date' || meta.type === 'datetime-local') {
                    // Convert any date string to ISO format — Playwright requires YYYY-MM-DD
                    const d = new Date(value);
                    const iso = isNaN(d) ? value : d.toISOString().slice(0, meta.type === 'date' ? 10 : 16);
                    await page.fill(sel, iso);
                    actions.push('fill (date)');
                } else if (meta.type === 'email') {
                    // Validate email before filling — Playwright throws cryptic errors on invalid values
                    const email = String(value).trim();
                    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                        throw new Error(`Invalid email value for ${sel}: ${email}`);
                    }
                    await page.fill(sel, email);
                    actions.push('fill (email)');
                } else if (meta.type === 'tel') {
                    // Strip non-phone characters — allows +, -, spaces, parens
                    await page.fill(sel, String(value).replace(/[^\d+\-\s()]/g, ''));
                    actions.push('fill (tel)');
                } else if (meta.type === 'url') {
                    // Auto-prepend https:// if no protocol provided
                    const url = /^https?:\/\//i.test(value) ? value : `https://${value}`;
                    await page.fill(sel, url);
                    actions.push('fill (url)');
                } else {
                    await page.fill(sel, value);
                    actions.push('fill');
                }
            }
            if (args.submit) await page.keyboard.press('Enter');
            const tag = args.typeAware ? ' (type-aware)' : '';
            return { content: [{ type: 'text', text: `Filled ${actions.length} field(s)${tag}: ${actions.join(', ')}${args.submit ? ' + submitted' : ''}.` }] };
        }
        case 'browser_double_click':
            if (args.selector) await page.dblclick(args.selector);
            else await page.mouse.dblclick(args.x, args.y);
            return { content: [{ type: 'text', text: 'Double-clicked.' }] };
        case 'browser_right_click':
            if (args.selector) await page.click(args.selector, { button: 'right' });
            else await page.mouse.click(args.x, args.y, { button: 'right' });
            return { content: [{ type: 'text', text: 'Right-clicked.' }] };
        case 'browser_hover':
            if (args.selector) await page.hover(args.selector);
            else await page.mouse.move(args.x, args.y);
            return { content: [{ type: 'text', text: 'Hovered.' }] };
        case 'browser_drag':
            await page.dragAndDrop(args.source, args.target);
            return { content: [{ type: 'text', text: 'Drag-and-drop executed.' }] };
        case 'browser_scroll': {
            const amount = args.amount || 500;
            const delta = args.direction === 'up' ? -amount : amount;
            await page.mouse.wheel(0, delta);
            return { content: [{ type: 'text', text: 'Scrolled.' }] };
        }
        case 'browser_scroll_to':
            if (args.selector) await page.locator(args.selector).scrollIntoViewIfNeeded();
            else await page.evaluate(({ x, y }) => window.scrollTo(x, y), { x: args.x || 0, y: args.y || 0 });
            return { content: [{ type: 'text', text: 'Scrolled to target.' }] };
        case 'browser_smart_scroll': {
            const steps = args.steps ?? 5;
            const delay = args.delayMs ?? 800;
            for (let i = 0; i < steps; i++) {
                await page.evaluate(() => window.scrollBy(0, 600));
                await page.waitForTimeout(delay);
            }
            return { content: [{ type: 'text', text: `Smart scroll completed (${steps} steps).` }] };
        }

        case 'browser_type': {
            const delay = args.delay || (AGENT_CONFIG.profile === 'stealth' ? 120 : 10);
            await page.type(args.selector, args.text, { delay });
            recorder.record('type', { selector: args.selector, text: args.text });
            return { content: [{ type: 'text', text: `Typed "${args.text}" with ${delay}ms delay.` }] };
        }
        case 'browser_clear':
            await page.fill(args.selector, '');
            return { content: [{ type: 'text', text: 'Cleared.' }] };
        case 'browser_press':
            await page.keyboard.press(args.key);
            recorder.record('press', { key: args.key });
            return { content: [{ type: 'text', text: `Pressed ${args.key}.` }] };
        case 'browser_select':
            await page.selectOption(args.selector, args.value);
            recorder.record('select', { selector: args.selector, value: args.value });
            return { content: [{ type: 'text', text: `Selected ${args.value}.` }] };
        case 'browser_check':
            await page.check(args.selector);
            recorder.record('check', { selector: args.selector });
            return { content: [{ type: 'text', text: 'Checked.' }] };
        case 'browser_uncheck':
            await page.uncheck(args.selector);
            recorder.record('uncheck', { selector: args.selector });
            return { content: [{ type: 'text', text: 'Unchecked.' }] };

        // Observation
        case 'browser_get_state': {
            await rotateSnapshot();
            const state = await captureState(page);
            await saveSnapshot(state);
            const content = [{ type: 'text', text: JSON.stringify(state, null, 2) }];
            if (args.screenshot) {
                if (args.mark_elements && state.elements) {
                    await page.evaluate((elements) => {
                        const style = document.createElement('style');
                        style.id = 'browser-agent-som-style';
                        style.textContent = `
                            .browser-agent-som-mark {
                                position: fixed;
                                background: #eb3449;
                                color: white;
                                font-size: 12px;
                                font-weight: bold;
                                font-family: monospace;
                                padding: 2px 4px;
                                border-radius: 3px;
                                z-index: 2147483647;
                                pointer-events: none;
                                text-shadow: 1px 1px 0 #000;
                                box-shadow: 0 0 0 1px #000, 0 2px 4px rgba(0,0,0,0.5);
                                transform: translate(-50%, -50%);
                            }
                            .browser-agent-som-box {
                                position: fixed;
                                border: 2px solid #eb3449;
                                z-index: 2147483646;
                                pointer-events: none;
                                background: rgba(235, 52, 73, 0.1);
                            }
                        `;
                        document.head.appendChild(style);
                        
                        const container = document.createElement('div');
                        container.id = 'browser-agent-som-container';
                        document.body.appendChild(container);
                        
                        elements.forEach(el => {
                            if (!el || !el.w || !el.h) return;
                            
                            const box = document.createElement('div');
                            box.className = 'browser-agent-som-box';
                            box.style.left = el.x + 'px';
                            box.style.top = el.y + 'px';
                            box.style.width = el.w + 'px';
                            box.style.height = el.h + 'px';
                            container.appendChild(box);
                            
                            const mark = document.createElement('div');
                            mark.className = 'browser-agent-som-mark';
                            mark.style.left = (el.x + el.w / 2) + 'px';
                            mark.style.top = (el.y + el.h / 2) + 'px';
                            mark.textContent = el.ref;
                            container.appendChild(mark);
                        });
                    }, state.elements);
                }
                
                const ss = await page.screenshot({ type: 'png' });
                
                if (args.mark_elements) {
                    await page.evaluate(() => {
                        document.getElementById('browser-agent-som-style')?.remove();
                        document.getElementById('browser-agent-som-container')?.remove();
                    });
                }
                
                content.push({ type: 'image', data: ss.toString('base64'), mimeType: 'image/png' });
            }
            return { content };
        }
        case 'browser_get_text': {
            if (args.all) {
                const texts = await page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map(el => el.innerText.trim()).filter(Boolean), args.selector);
                const maxLines = args.maxLines ?? 100;
                const truncated = texts.length > maxLines;
                const limited = texts.slice(0, maxLines);
                const suffix = truncated ? `\n... (${texts.length - maxLines} more, increase maxLines to see all)` : '';
                return { content: [{ type: 'text', text: limited.join('\n---\n') + suffix }] };
            }
            const text = await page.evaluate((sel) => document.querySelector(sel)?.innerText?.trim() ?? null, args.selector);
            return { content: [{ type: 'text', text: text || '(not found)' }] };
        }
        case 'browser_get_html': {
            const html = args.selector 
                ? await page.evaluate((sel) => document.querySelector(sel)?.innerHTML ?? null, args.selector)
                : await page.content();
            return { content: [{ type: 'text', text: html || '(not found)' }] };
        }
        case 'browser_screenshot': {
            if (args.mark_elements) {
                // Quickly grab elements without full state capture to get ref positions
                const { elements } = await observeInteractable(page);
                await page.evaluate((elements) => {
                    const style = document.createElement('style');
                    style.id = 'browser-agent-som-style';
                    style.textContent = `
                        .browser-agent-som-mark {
                            position: fixed;
                            background: #eb3449;
                            color: white;
                            font-size: 12px;
                            font-weight: bold;
                            font-family: monospace;
                            padding: 2px 4px;
                            border-radius: 3px;
                            z-index: 2147483647;
                            pointer-events: none;
                            text-shadow: 1px 1px 0 #000;
                            box-shadow: 0 0 0 1px #000, 0 2px 4px rgba(0,0,0,0.5);
                            transform: translate(-50%, -50%);
                        }
                        .browser-agent-som-box {
                            position: fixed;
                            border: 2px solid #eb3449;
                            z-index: 2147483646;
                            pointer-events: none;
                            background: rgba(235, 52, 73, 0.1);
                        }
                    `;
                    document.head.appendChild(style);
                    
                    const container = document.createElement('div');
                    container.id = 'browser-agent-som-container';
                    document.body.appendChild(container);
                    
                    elements.forEach(el => {
                        if (!el || !el.w || !el.h) return;
                        
                        const box = document.createElement('div');
                        box.className = 'browser-agent-som-box';
                        box.style.left = el.x + 'px';
                        box.style.top = el.y + 'px';
                        box.style.width = el.w + 'px';
                        box.style.height = el.h + 'px';
                        container.appendChild(box);
                        
                        const mark = document.createElement('div');
                        mark.className = 'browser-agent-som-mark';
                        mark.style.left = (el.x + el.w / 2) + 'px';
                        mark.style.top = (el.y + el.h / 2) + 'px';
                        mark.textContent = el.ref;
                        container.appendChild(mark);
                    });
                }, elements);
            }

            const ss = await page.screenshot({ type: 'png' });

            if (args.mark_elements) {
                await page.evaluate(() => {
                    document.getElementById('browser-agent-som-style')?.remove();
                    document.getElementById('browser-agent-som-container')?.remove();
                });
            }

            return { content: [{ type: 'image', data: ss.toString('base64'), mimeType: 'image/png' }] };
        }
        case 'browser_print_to_pdf': {
            const pdf = await page.pdf({
                landscape: args.landscape ?? false,
                printBackground: args.printBackground ?? true,
                format: args.format ?? 'A4',
            });
            const outputPath = args.outputPath || path.join(__dirname, '../../pdfs', `${Date.now()}.pdf`);
            const dir = path.dirname(outputPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(outputPath, pdf);
            return { content: [{ type: 'text', text: `PDF saved to ${outputPath} (${(pdf.length / 1024).toFixed(1)} KB)` }] };
        }
        case 'browser_get_cookies': {
            const cookies = await page.context().cookies();
            return { content: [{ type: 'text', text: JSON.stringify({ cookies }, null, 2) }] };
        }
        case 'browser_evaluate': {
            const result = await page.evaluate(async ([script, scriptArgs]) => {
                try {
                    // eslint-disable-next-line no-new-func
                    const fn = new Function('args', `"use strict"; return (async () => { ${script} })()`);
                    const value = await fn(scriptArgs);
                    return { ok: true, value };
                } catch (e) {
                    return { ok: false, error: e.message };
                }
            }, [args.script, args.args ?? null]);

            if (!result.ok) {
                return { content: [{ type: 'text', text: `Script error: ${result.error}` }], isError: true };
            }

            let output;
            try {
                output = result.value === undefined ? '(undefined)' : JSON.stringify(result.value, null, 2);
            } catch (_) {
                output = String(result.value);
            }
            return { content: [{ type: 'text', text: output }] };
        }
        case 'browser_extract_table': {
            const data = await page.evaluate(({ sel, hasHeader }) => {
                const table = document.querySelector(sel);
                if (!table) return null;
                const rows = Array.from(table.querySelectorAll('tr'));
                return rows.map(row => Array.from(row.querySelectorAll('td, th')).map(cell => cell.innerText.trim()));
            }, { sel: args.selector, hasHeader: args.header });
            
            if (!data) return { content: [{ type: 'text', text: 'Table not found.' }] };
            
            if (args.header && data.length > 0) {
                const headers = data[0];
                const body = data.slice(1);
                const structured = body.map(row => {
                    const obj = {};
                    headers.forEach((h, i) => { obj[h || `col${i}`] = row[i]; });
                    return obj;
                });
                return { content: [{ type: 'text', text: JSON.stringify({ table: structured }, null, 2) }] };
            }
            return { content: [{ type: 'text', text: JSON.stringify({ table: data }, null, 2) }] };
        }
        case 'browser_state_diff': {
            const last = getLastSnapshot();
            const curr = getCurrSnapshot();
            if (!curr) return { content: [{ type: 'text', text: 'No current snapshot. Call browser_get_state first.' }] };
            if (!last) return { content: [{ type: 'text', text: 'Only one snapshot exists. Call browser_get_state again to create a baseline for comparison.' }] };

            const changes = {};

            // URL / title
            if (last.url !== curr.url) changes.url = { from: last.url, to: curr.url };
            if (last.title !== curr.title) changes.title = { from: last.title, to: curr.title };

            // Headings
            const lastH = new Set((last.headings || []).map(h => `${h.level}:${h.text}`));
            const currH = new Set((curr.headings || []).map(h => `${h.level}:${h.text}`));
            const newH = (curr.headings || []).filter(h => !lastH.has(`${h.level}:${h.text}`));
            const goneH = (last.headings || []).filter(h => !currH.has(`${h.level}:${h.text}`));
            if (newH.length) changes.newHeadings = newH;
            if (goneH.length) changes.removedHeadings = goneH;

            // Interactive elements — summary by tag
            const lastTags = {};
            for (const el of last.elements || []) {
                const t = el.tag || '?';
                lastTags[t] = (lastTags[t] || 0) + 1;
            }
            const currTags = {};
            for (const el of curr.elements || []) {
                const t = el.tag || '?';
                currTags[t] = (currTags[t] || 0) + 1;
            }
            const tagDiffs = [];
            for (const tag of new Set([...Object.keys(lastTags), ...Object.keys(currTags)]).values()) {
                const before = lastTags[tag] || 0;
                const after = currTags[tag] || 0;
                if (before !== after) tagDiffs.push({ tag, before, after });
            }
            if (tagDiffs.length) changes.elements = tagDiffs;

            // Popups
            const hadPopups = (last.popups || []).length > 0;
            const hasPopups = (curr.popups || []).length > 0;
            if (!hadPopups && hasPopups) changes.popup = { status: 'appeared', text: curr.popups[0]?.text?.substring(0, 200) };
            if (hadPopups && !hasPopups) changes.popup = { status: 'dismissed' };

            // CAPTCHA
            if (!last.captchaDetected && curr.captchaDetected) changes.captcha = 'appeared';
            if (last.captchaDetected && !curr.captchaDetected) changes.captcha = 'resolved';

            const summary = Object.keys(changes).length
                ? JSON.stringify({ changes }, null, 2)
                : 'No meaningful changes detected between last two snapshots.';

            return { content: [{ type: 'text', text: summary }] };
        }
        case 'browser_save_session': {
            const sessionDir = path.join(__dirname, '../../sessions');
            if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

            const cookies = await page.context().cookies();
            const sessionData = { cookies };

            if (args.includeStorage) {
                sessionData.storage = await page.evaluate(() => ({
                    localStorage: { ...localStorage },
                    sessionStorage: { ...sessionStorage },
                    origin: location.origin,
                }));
            }

            fs.writeFileSync(path.join(sessionDir, `${args.name}.json`), JSON.stringify(sessionData, null, 2));
            const extras = args.includeStorage ? ' + localStorage/sessionStorage' : '';
            return { content: [{ type: 'text', text: `Session "${args.name}" saved (cookies${extras}).` }] };
        }
        case 'browser_load_session': {
            const sessionPath = path.join(__dirname, '../../sessions', `${args.name}.json`);
            if (!fs.existsSync(sessionPath)) {
                return { content: [{ type: 'text', text: `Session "${args.name}" not found.` }], isError: true };
            }

            const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

            // Support both old format (array of cookies) and new format ({ cookies, storage })
            const cookies = Array.isArray(sessionData) ? sessionData : sessionData.cookies;
            await page.context().addCookies(cookies);

            if (!Array.isArray(sessionData) && sessionData.storage) {
                const { localStorage: ls, sessionStorage: ss, origin } = sessionData.storage;
                if (page.url().startsWith(origin)) {
                    await page.evaluate(([lsData, ssData]) => {
                        Object.entries(lsData).forEach(([k, v]) => localStorage.setItem(k, v));
                        Object.entries(ssData).forEach(([k, v]) => sessionStorage.setItem(k, v));
                    }, [ls, ss]);
                    return { content: [{ type: 'text', text: `Session "${args.name}" loaded (cookies + localStorage/sessionStorage).` }] };
                }
                return { content: [{ type: 'text', text: `Session "${args.name}" loaded (cookies only — storage skipped: page origin mismatch with saved origin "${origin}").` }] };
            }

            return { content: [{ type: 'text', text: `Session "${args.name}" loaded.` }] };
        }
        case 'browser_list_sessions': {
            const sessionDir = path.join(__dirname, '../../sessions');
            if (!fs.existsSync(sessionDir)) return { content: [{ type: 'text', text: 'No sessions saved yet.' }] };

            const files = fs.readdirSync(sessionDir).filter(f => f.endsWith('.json'));
            if (!files.length) return { content: [{ type: 'text', text: 'No sessions saved yet.' }] };

            const lines = files.map(f => {
                const full = path.join(sessionDir, f);
                const stat = fs.statSync(full);
                const data = JSON.parse(fs.readFileSync(full, 'utf8'));
                const cookieCount = Array.isArray(data) ? data.length : (data.cookies?.length || 0);
                const hasStorage = !Array.isArray(data) && data.storage;
                const origin = hasStorage ? data.storage.origin : '—';
                return `${f.replace('.json', '')} | ${(stat.size / 1024).toFixed(1)} KB | ${cookieCount} cookies | origin: ${origin} | ${stat.mtime.toISOString()}`;
            });
            return { content: [{ type: 'text', text: lines.join('\n') }] };
        }
        case 'browser_export_state': {
            const exportDir = path.join(__dirname, '../../exports');
            if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

            const outputPath = args.outputPath || path.join(exportDir, `state-${Date.now()}.json`);
            const dir = path.dirname(outputPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            const baseState = await captureState(page);
            const state = { ...baseState, capturedAt: new Date().toISOString() };

            if (args.includeStorage !== false) {
                state.storage = await page.evaluate(() => {
                    try {
                        return {
                            localStorage: { ...localStorage },
                            sessionStorage: { ...sessionStorage },
                            origin: location.origin,
                        };
                    } catch (_) {
                        return { localStorage: {}, sessionStorage: {}, origin: location.origin, error: 'storage access denied' };
                    }
                });
            }

            state.cookies = await page.context().cookies();

            if (!args.includeAxTree) delete state.axTree;

            fs.writeFileSync(outputPath, JSON.stringify(state, null, 2));
            const sizeKb = (fs.statSync(outputPath).size / 1024).toFixed(1);
            return { content: [{ type: 'text', text: `State exported to ${outputPath} (${sizeKb} KB).` }] };
        }
        case 'browser_solve_captcha_grid': {
            const challengeFrame = await page.waitForSelector('iframe[src*="bframe"]', { timeout: 5000 }).catch(() => null);
            if (!challengeFrame) return { content: [{ type: 'text', text: 'Challenge frame not found.' }], isError: true };

            const bframe = await challengeFrame.contentFrame();
            if (!bframe) return { content: [{ type: 'text', text: 'Could not access challenge frame.' }], isError: true };

            const { indices, action } = args;

            // Click each tile inside the bframe using evaluate (avoids CSS selector issues with numeric IDs)
            for (const index of indices) {
                const tileIndex = index - 1; // convert 1-based to 0-based

                // Find the tile element and get its bounding box via evaluate
                const tileBox = await bframe.evaluate((idx) => {
                    // reCAPTCHA tiles are in a table — try multiple selectors
                    let tile = document.querySelector(`td[tabindex="${idx}"]`) ||
                               document.querySelector(`.rc-imageselect-tile:nth-child(${idx + 1})`) ||
                               document.querySelectorAll('table td')[idx];
                    if (!tile) return null;
                    const rect = tile.getBoundingClientRect();
                    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                }, tileIndex);

                if (tileBox) {
                    // Convert bframe coordinates to page coordinates
                    const frameRect = await challengeFrame.boundingBox();
                    if (frameRect) {
                        const cx = frameRect.x + tileBox.x + tileBox.width / 2 + (Math.random() - 0.5) * 4;
                        const cy = frameRect.y + tileBox.y + tileBox.height / 2 + (Math.random() - 0.5) * 4;
                        await page.mouse.move(cx, cy, { steps: 8 });
                        await page.waitForTimeout(150 + Math.random() * 200);
                        await page.mouse.click(cx, cy, { delay: 60 + Math.random() * 100 });
                    }
                } else {
                    // Fallback: click by grid coordinates
                    const row = Math.floor(tileIndex / 3);
                    const col = tileIndex % 3;
                    const frameRect = await challengeFrame.boundingBox();
                    if (!frameRect) continue;
                    const margin = 15;
                    const cellSize = (400 - margin * 2) / 3;
                    const cx = frameRect.x + margin + col * cellSize + cellSize / 2;
                    const cy = frameRect.y + margin + row * cellSize + cellSize / 2;
                    await page.mouse.move(cx, cy, { steps: 8 });
                    await page.waitForTimeout(150 + Math.random() * 200);
                    await page.mouse.click(cx, cy, { delay: 60 + Math.random() * 100 });
                }
                await page.waitForTimeout(200 + Math.random() * 400);
            }

            // Click verify button
            const verifyBtn = await bframe.$('#recaptcha-verify-button');
            if (verifyBtn) {
                const box = await verifyBtn.boundingBox();
                if (box) {
                    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
                    await page.waitForTimeout(200 + Math.random() * 400);
                    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 80 + Math.random() * 80 });
                }
            }

            return { content: [{ type: 'text', text: `Clicked tile indices ${indices.join(', ')} and clicked "${action || 'verify'}". Call browser_handle_captcha to check result.` }] };
        }
        // Named Pages / Agent Parallelism
        case 'browser_agent_create': {
            const created = await createNamedPage(args.name);
            return { content: [{ type: 'text', text: created ? `Created and switched to agent "${args.name}".` : `Switched to existing agent "${args.name}".` }] };
        }
        case 'browser_agent_switch': {
            const ok = await switchToNamedPage(args.name);
            return { content: [{ type: 'text', text: ok ? `Switched to agent "${args.name}".` : `Agent "${args.name}" not found.` }] };
        }
        case 'browser_agent_remove': {
            const removed = await removeNamedPage(args.name);
            return { content: [{ type: 'text', text: removed ? `Removed agent "${args.name}".` : `Agent "${args.name}" not found.` }] };
        }
        case 'browser_agent_list': {
            const agents = listNamedPages();
            if (!agents.length) return { content: [{ type: 'text', text: 'No named agents. Use browser_agent_create to add one.' }] };
            const text = agents.map(a => `${a.hasActivePage ? '*' : ' '} ${a.name} — ${a.url || '(blank)'}`).join('\n');
            return { content: [{ type: 'text', text }] };
        }

        // ── Phase 3: OCR ─────────────────────────────────────────────────────
        case 'browser_ocr': {
            if (!Tesseract) {
                return { content: [{ type: 'text', text: 'tesseract.js not installed. Run: npm install tesseract.js' }], isError: true };
            }

            // Capture the target region as a PNG buffer.
            // If selector is provided, screenshot just that element (cleaner OCR).
            // Otherwise, screenshot the full viewport.
            let imageBuffer;
            if (args.selector) {
                const el = page.locator(args.selector).first();
                imageBuffer = await el.screenshot({ type: 'png' });
            } else {
                imageBuffer = await page.screenshot({ type: 'png' });
            }

            // Image preprocessing significantly improves OCR accuracy.
            // We run this in the browser context using Canvas API to avoid
            // adding sharp/canvas npm dependencies.
            let processedBuffer = imageBuffer;
            const preprocess = args.preprocess || 'threshold';

            if (preprocess !== 'none') {
                const base64 = imageBuffer.toString('base64');
                const processed = await page.evaluate(async ({ img, mode }) => {
                    return new Promise((resolve) => {
                        const canvas = document.createElement('canvas');
                        const ctx = canvas.getContext('2d');
                        const imgEl = new Image();
                        imgEl.onload = () => {
                            canvas.width = imgEl.width;
                            canvas.height = imgEl.height;
                            ctx.drawImage(imgEl, 0, 0);

                            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                            const data = imageData.data;

                            // Convert to grayscale using luminance formula (ITU-R BT.601)
                            for (let i = 0; i < data.length; i += 4) {
                                let gray = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;

                                if (mode === 'threshold') {
                                    // Binary threshold: pure black/white — best for code screenshots
                                    gray = gray > 128 ? 255 : 0;
                                } else if (mode === 'sharpen') {
                                    // Push mid-tones toward extremes — improves text contrast
                                    gray = gray > 128 ? Math.min(255, gray + 30) : Math.max(0, gray - 30);
                                }

                                data[i] = data[i+1] = data[i+2] = gray;
                            }

                            ctx.putImageData(imageData, 0, 0);
                            resolve(canvas.toDataURL('image/png').split(',')[1]);
                        };
                        imgEl.src = 'data:image/png;base64,' + img;
                    });
                }, { img: base64, mode: preprocess });

                processedBuffer = Buffer.from(processed, 'base64');
            }

            // Run Tesseract OCR — suppress logger to avoid noisy output
            const lang = args.language || 'eng';
            const { data: { text, confidence } } = await Tesseract.recognize(processedBuffer, lang, {
                logger: () => {},
            });

            const result = {
                text: text.trim(),
                confidence: Math.round(confidence),
                language: lang,
                preprocessing: preprocess,
            };

            if (args.returnImage) {
                result.image = processedBuffer.toString('base64');
            }

            return { content: [{ type: 'text', text: result.text, data: result }] };
        }

        // ── Phase 3: Macro Recording ─────────────────────────────────────────
        // Macros record browser actions and replay them later.
        // Recording works by tagging the page — every browser_* call gets logged
        // to the recorder module. On stop, we export as either a Playwright test
        // script (for CI) or raw JSON (for replay).
        case 'browser_record_macro': {
            const { action, name, format, save } = args;

            if (action === 'start') {
                recorder.clear();
                // Tag the page so the handler knows to record actions
                if (!page._macroRecording) {
                    page._macroRecording = true;
                    page._macroHandler = async (toolName, toolArgs) => {
                        // Record all browser_ calls except record_macro itself
                        if (toolName.startsWith('browser_') && toolName !== 'browser_record_macro') {
                            recorder.record(toolName, toolArgs);
                        }
                    };
                }
                return { content: [{ type: 'text', text: 'Macro recording started. All browser actions will be captured.' }] };
            }

            if (action === 'stop') {
                page._macroRecording = false;
                const actions = recorder.getActions();
                const macroName = name || `macro-${Date.now()}`;

                let output;
                if (format === 'json' || format === 'actions') {
                    // JSON format preserves all action data for replay
                    output = JSON.stringify(actions, null, 2);
                } else {
                    // Playwright format generates a runnable test script
                    output = recorder.generate(macroName);
                }

                if (save) {
                    const dir = path.join(__dirname, '../../user_data/macros');
                    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                    const ext = format === 'json' ? 'json' : 'spec.js';
                    const filePath = path.join(dir, `${macroName}.${ext}`);
                    fs.writeFileSync(filePath, output);
                    return { content: [{ type: 'text', text: `Macro saved: ${filePath}\n${actions.length} actions recorded.`, data: { filePath, actionCount: actions.length } }] };
                }

                return { content: [{ type: 'text', text: `${actions.length} actions recorded.`, data: { actions, script: output } }] };
            }

            if (action === 'clear') {
                recorder.clear();
                return { content: [{ type: 'text', text: 'Macro buffer cleared.' }] };
            }

            if (action === 'list') {
                const actions = recorder.getActions();
                return { content: [{ type: 'text', text: `${actions.length} actions in buffer.`, data: actions }] };
            }

            if (action === 'export') {
                const macroName = name || 'macro';
                const output = recorder.generate(macroName);
                return { content: [{ type: 'text', text: output || 'No actions recorded.', data: { script: output } }] };
            }
        }

        case 'browser_replay_macro': {
            const { actions, macroName, speed, dryRun } = args;
            let actionList = actions;

            // Load from file if macroName provided
            if (macroName && !actionList) {
                const macroPath = path.join(__dirname, '../../user_data/macros', `${macroName}.json`);
                if (fs.existsSync(macroPath)) {
                    actionList = JSON.parse(fs.readFileSync(macroPath, 'utf8'));
                } else {
                    return { content: [{ type: 'text', text: `Macro not found: ${macroPath}` }], isError: true };
                }
            }

            if (!actionList || !actionList.length) {
                return { content: [{ type: 'text', text: 'No actions to replay.' }], isError: true };
            }

            const delay = speed === 'fast' ? 100 : speed === 'slow' ? 1000 : 300;
            const results = [];

            for (const action of actionList) {
                if (dryRun) {
                    results.push({ action: action.type || action.tool, args: action.args, dryRun: true });
                    continue;
                }

                try {
                    const toolName = action.type || action.tool;
                    const toolArgs = action.args || action.parameters || {};

                    // Skip record_macro calls
                    if (toolName === 'browser_record_macro') continue;

                    // Execute via the tool handler
                    const result = await handleToolCall(toolName, toolArgs);
                    results.push({ action: toolName, success: true });
                    await page.waitForTimeout(delay);
                } catch (e) {
                    results.push({ action: action.type || action.tool, error: e.message });
                }
            }

            return { content: [{ type: 'text', text: `Replayed ${results.length} actions (${results.filter(r => r.success).length} succeeded).`, data: results }] };
        }

        // ── Phase 3: Parallel Execution ──────────────────────────────────────
        case 'browser_parallel_execute': {
            const { tasks, timeout } = args;
            const maxTime = timeout || 30000;

            const executeTask = async (task) => {
                const { page: pageName, actions } = task;
                const startTime = Date.now();
                const taskResults = [];

                // Switch to the named page
                const switched = await switchToNamedPage(pageName);
                if (!switched) {
                    return { page: pageName, error: `Page "${pageName}" not found`, results: [] };
                }

                const taskPage = getPage();

                for (const action of actions) {
                    if (Date.now() - startTime > maxTime) {
                        taskResults.push({ action: action.tool, error: 'Timeout' });
                        break;
                    }

                    try {
                        // Execute action on this page
                        const result = await handleToolCall(action.tool, action.args || {});
                        taskResults.push({ action: action.tool, success: true });
                    } catch (e) {
                        taskResults.push({ action: action.tool, error: e.message });
                    }
                }

                return { page: pageName, results: taskResults };
            };

            // Execute all tasks concurrently
            const allResults = await Promise.all(tasks.map(executeTask));

            // Restore to first named page
            const firstPage = tasks[0]?.page;
            if (firstPage) await switchToNamedPage(firstPage);

            const summary = allResults.map(r => `${r.page}: ${r.error || r.results.filter(x => x.success).length + '/' + r.results.length + ' ok'}`).join('\n');
            return { content: [{ type: 'text', text: `Parallel execution complete:\n${summary}`, data: allResults }] };
        }

        // ── Phase 2: API Capture ─────────────────────────────────────────────
        // Captures API responses matching a URL pattern without mocking them.
        // Why: Most modern quiz/SPA platforms load data via XHR/fetch.
        // Intercepting at the network level is faster and more reliable than DOM scraping.
        case 'browser_intercept_api': {
            const pattern = args.pattern;
            const action = args.action || 'start';

            if (action === 'start') {
                apiCaptureActive = true;
                apiCapturePattern = pattern;
                capturedAPIs = [];

                // Listen for all responses and filter by pattern.
                // We use page.on('response') instead of page.route() because we want
                // to capture real responses, not mock them.
                const responseHandler = async (response) => {
                    const url = response.url();
                    // Convert glob pattern to regex: ** → .*, * → [^/]*
                    const regex = new RegExp('^' + pattern.replace(/\*\*/g, '<<<GLOB>>>').replace(/\*/g, '[^/]*').replace(/<<<GLOB>>>/g, '.*') + '$');
                    if (!regex.test(url)) return;

                    const contentType = response.headers()['content-type'] || '';
                    let body = null;

                    try {
                        if (contentType.includes('json')) {
                            body = await response.json();
                        } else if (contentType.includes('text')) {
                            body = await response.text();
                        } else {
                            body = `[binary: ${contentType}]`;
                        }
                    } catch (e) {
                        // Response body may already be consumed or timed out
                        body = `[error reading body: ${e.message}]`;
                    }

                    capturedAPIs.push({
                        url,
                        status: response.status(),
                        contentType,
                        body,
                        timestamp: Date.now(),
                    });
                };

                // Store handler reference for cleanup — prevents listener leaks
                if (!page._apiHandlers) page._apiHandlers = {};
                if (page._apiHandlers[pattern]) {
                    page.removeListener('response', page._apiHandlers[pattern]);
                }
                page._apiHandlers[pattern] = responseHandler;
                page.on('response', responseHandler);

                if (args.reloadPage) {
                    await page.reload({ waitUntil: 'networkidle' });
                }

                return { content: [{ type: 'text', text: `API capture started for pattern: ${pattern}. ${args.reloadPage ? 'Page reloaded.' : ''} Listening for responses...` }] };
            }

            if (action === 'stop') {
                if (page._apiHandlers && page._apiHandlers[pattern]) {
                    page.removeListener('response', page._apiHandlers[pattern]);
                    delete page._apiHandlers[pattern];
                }
                apiCaptureActive = false;
                const count = capturedAPIs.length;
                return { content: [{ type: 'text', text: `API capture stopped. ${count} responses captured.`, data: capturedAPIs }] };
            }

            if (action === 'get') {
                const filtered = args.pattern
                    ? capturedAPIs.filter(d => d.url.includes(args.pattern))
                    : capturedAPIs;
                return { content: [{ type: 'text', text: `${filtered.length} API responses.`, data: filtered }] };
            }
        }

        case 'browser_get_captured_apis': {
            let data = capturedAPIs;
            if (args.pattern) {
                data = data.filter(d => d.url.includes(args.pattern));
            }
            if (args.clearAfter) {
                capturedAPIs = [];
            }
            return { content: [{ type: 'text', text: `${data.length} API responses.`, data }] };
        }

        // ── Phase 2: Batch Quiz ──────────────────────────────────────────────
        // Answers multiple quiz questions in one tool call.
        // Strategy: discover radio/checkbox groups in DOM → click by index → navigate.
        // This is 10-20x faster than screenshot→analyze→click per question.
        case 'browser_batch_answer_quiz': {
            const { answers, submitAfter, nextSelector, submitSelector } = args;
            const results = { answered: 0, errors: [], pages: [] };

            // Auto-detect navigation buttons — supports Indonesian (Dicoding) and English
            const nextBtn = nextSelector || 'button:has-text("Selanjutnya"), button:has-text("Next"), a:has-text("Selanjutnya"), a:has-text("Next")';
            const submitBtn = submitSelector || 'button:has-text("Selesaikan"), button:has-text("Submit"), button:has-text("Kirim"), button[type="submit"]';

            for (const answer of answers) {
                try {
                    const { q, option, options } = answer;

                    // Discover all radio/checkbox groups on the current page.
                    // Groups are identified by their `name` attribute — each question
                    // typically has its own group name (e.g., "question_5").
                    const inputInfo = await page.evaluate(() => {
                        const groups = {};
                        const radios = document.querySelectorAll('input[type="radio"]');
                        const checkboxes = document.querySelectorAll('input[type="checkbox"]');

                        radios.forEach(el => {
                            const key = `radio:${el.name}`;
                            if (!groups[key]) groups[key] = { name: el.name, type: 'radio', count: 0, checked: -1 };
                            groups[key].count++;
                            if (el.checked) groups[key].checked = groups[key].count - 1;
                        });

                        checkboxes.forEach(el => {
                            const key = `checkbox:${el.name}`;
                            if (!groups[key]) groups[key] = { name: el.name, type: 'checkbox', count: 0, checked: [] };
                            groups[key].count++;
                            if (el.checked) groups[key].checked.push(groups[key].count - 1);
                        });

                        return Object.values(groups);
                    });

                    if (inputInfo.length === 0) {
                        results.errors.push({ q, error: 'No radio/checkbox inputs found' });
                        // Still try to advance — might be a non-input question page
                        try {
                            const next = page.locator(nextBtn).first();
                            if (await next.isVisible({ timeout: 1500 })) {
                                await next.click();
                                await page.waitForTimeout(1500);
                            }
                        } catch (_) {}
                        continue;
                    }

                    // Use first group — Dicoding shows one question per page
                    const group = inputInfo[0];

                    if (group.type === 'radio' && option !== undefined) {
                        // Click radio by index and dispatch change event
                        // (some frameworks only react to the event, not the click)
                        await page.evaluate(({ name, idx }) => {
                            const radios = document.querySelectorAll(`input[name="${name}"]`);
                            if (radios[idx]) {
                                radios[idx].click();
                                radios[idx].dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        }, { name: group.name, idx: option });
                        results.answered++;
                    } else if (group.type === 'checkbox' && options) {
                        // Check multiple checkboxes by index array
                        await page.evaluate(({ name, indices }) => {
                            const boxes = document.querySelectorAll(`input[name="${name}"]`);
                            indices.forEach(idx => {
                                if (boxes[idx] && !boxes[idx].checked) {
                                    boxes[idx].click();
                                    boxes[idx].dispatchEvent(new Event('change', { bubbles: true }));
                                }
                            });
                        }, { name: group.name, indices: options });
                        results.answered++;
                    } else {
                        results.errors.push({ q, error: `Type mismatch: ${group.type}` });
                        continue;
                    }

                    // Navigate to next question — wait for page transition
                    try {
                        const next = page.locator(nextBtn).first();
                        if (await next.isVisible({ timeout: 2000 })) {
                            await next.click();
                            await page.waitForTimeout(1500);
                            results.pages.push(page.url());
                        }
                    } catch (_) {}

                } catch (e) {
                    results.errors.push({ q: answer.q, error: e.message });
                }
            }

            if (submitAfter) {
                try {
                    const submit = page.locator(submitBtn).first();
                    if (await submit.isVisible({ timeout: 3000 })) {
                        await submit.click();
                        await page.waitForTimeout(2000);
                        results.submitted = true;
                    }
                } catch (e) {
                    results.errors.push({ q: 'submit', error: e.message });
                }
            }

            return { content: [{ type: 'text', text: `Batch answered: ${results.answered}/${answers.length}.`, data: results }] };
        }

        // ── Phase 2: Tab Awareness ───────────────────────────────────────────
        case 'browser_switch_to_new_tab': {
            const ctx = await getPage().context();
            const timeout = args.timeout || 10000;
            const urlPattern = args.urlPattern;

            const pagePromise = new Promise((resolve) => {
                ctx.once('page', resolve);
                setTimeout(() => {
                    ctx.removeAllListeners('page');
                    resolve(null);
                }, timeout);
            });

            const newPage = await pagePromise;

            if (!newPage) {
                return { content: [{ type: 'text', text: `No new tab appeared within ${timeout}ms.` }], isError: true };
            }

            try {
                await newPage.waitForLoadState('domcontentloaded', { timeout: 5000 });
            } catch (_) {}

            const newUrl = newPage.url();

            if (urlPattern && !newUrl.includes(urlPattern)) {
                return { content: [{ type: 'text', text: `New tab URL "${newUrl}" doesn't match "${urlPattern}".` }], isError: true };
            }

            const name = `popup-${Date.now()}`;
            await createNamedPage(name, newPage);

            return { content: [{ type: 'text', text: `New tab: ${newUrl} (registered as "${name}")` }] };
        }

        // Request Interception
        case 'browser_intercept': {
            await addRoute(args.pattern, args.action, {
                status: args.status,
                body: args.body,
                contentType: args.contentType,
                headers: args.headers,
            });
            return { content: [{ type: 'text', text: `Intercept rule added: ${args.action} "${args.pattern}"` }] };
        }
        case 'browser_intercept_list': {
            const routes = listRoutes();
            if (!routes.length) return { content: [{ type: 'text', text: 'No active intercept rules.' }] };
            const text = routes.map(r => `[${r.action}] ${r.pattern}`).join('\n');
            return { content: [{ type: 'text', text }] };
        }
        case 'browser_clear_intercepts': {
            await clearRoutes();
            return { content: [{ type: 'text', text: 'All intercept rules cleared.' }] };
        }

        case 'browser_close': {
            await closeBrowser();
            return { content: [{ type: 'text', text: 'Browser session closed.' }] };
        }
        case 'browser_set_agent_profile': {
            AGENT_CONFIG.profile = args.profile;
            return { content: [{ type: 'text', text: `Agent profile set to ${args.profile}.` }] };
        }
        case 'browser_handle_captcha': {
            const solver = new RecaptchaSolver(page);

            // Verify mode — check if already solved
            if (args.verify) {
                const solved = await solver.verifySolved();
                return { content: [{ type: 'text', text: solved ? 'CAPTCHA solved.' : 'CAPTCHA not yet solved.' }], isError: !solved };
            }

            // Audio mode — try to solve via local whisper (with timeout)
            if (args.audio) {
                const timeoutMs = args.timeout || 30000;
                try {
                    const result = await Promise.race([
                        solver.solveAudio(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error(`Audio solve timed out after ${timeoutMs}ms`)), timeoutMs))
                    ]);
                    return { content: [{ type: 'text', text: `CAPTCHA solved via ${result.method}. Transcription: "${result.transcription}"` }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `Audio CAPTCHA error: ${e.message}` }], isError: true };
                }
            }

            // Default: click checkbox, detect challenge, return immediately
            let result;
            try {
                result = await solver.solve();
            } catch (e) {
                return { content: [{ type: 'text', text: `CAPTCHA error: ${e.message}` }], isError: true };
            }

            if (result.solved) {
                return { content: [{ type: 'text', text: `CAPTCHA solved via ${result.method}.` }] };
            }

            // Image challenge — use challenge screenshot if available, else full page
            if (result.challenge?.type === 'image') {
                const content = [
                    { type: 'text', text: `Image challenge: "${result.challenge.prompt}"\nGrid: ${result.challenge.gridSize}x${result.challenge.gridSize} (${result.challenge.tileCount} tiles)\nDetermine which tiles contain the target object, then call browser_solve_captcha_grid(indices=[1-based tile numbers]) to click them. After clicking verify, call browser_handle_captcha(verify=true) to check result.` },
                ];
                // Prefer the challenge-only screenshot (smaller, more precise)
                const imgData = result.challenge.imageBase64
                    ? result.challenge.imageBase64
                    : (await page.screenshot({ type: 'png' })).toString('base64');
                content.push({ type: 'image', data: imgData, mimeType: 'image/png' });
                return { content };
            }

            // Token injection worked silently (invisible reCAPTCHA)
            if (result.method === 'token') {
                return { content: [{ type: 'text', text: 'reCAPTCHA solved via token injection (invisible mode).' }] };
            }

            return { content: [{ type: 'text', text: `Challenge detected but not solvable automatically. Try browser_screenshot to inspect, then browser_handle_captcha(audio=true) to attempt audio solve.` }], isError: true };
        }

        // ── Phase 1 Enhancements ─────────────────────────────────────────────
        case 'browser_wait_for_navigation': {
            const startTime = Date.now();
            const timeout = args.timeout || 15000;
            const initialUrl = page.url();

            // If no args, just wait for any URL change
            if (!args.urlPattern && !args.selector) {
                await page.waitForFunction((prevUrl) => location.href !== prevUrl, initialUrl, { timeout });
                return { content: [{ type: 'text', text: `URL changed from ${initialUrl} to ${page.url()}` }] };
            }

            // Wait for URL pattern
            if (args.urlPattern) {
                const isRegex = args.urlPattern.startsWith('regex:');
                const pattern = isRegex ? args.urlPattern.slice(6) : args.urlPattern;
                try {
                    await page.waitForFunction(([pat, rx]) => {
                        const u = location.href;
                        return rx ? new RegExp(pat).test(u) : u.includes(pat);
                    }, [pattern, isRegex], { timeout });
                    return { content: [{ type: 'text', text: `URL now matches "${args.urlPattern}" → ${page.url()}` }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `Timeout waiting for URL pattern "${args.urlPattern}". Current: ${page.url()}` }], isError: true };
                }
            }

            // Wait for selector
            if (args.selector) {
                try {
                    await page.waitForSelector(args.selector, { timeout, state: 'visible' });
                    return { content: [{ type: 'text', text: `Selector "${args.selector}" appeared.` }] };
                } catch (e) {
                    return { content: [{ type: 'text', text: `Timeout waiting for selector "${args.selector}".` }], isError: true };
                }
            }
        }

        case 'browser_select_by_index': {
            const { selector, index, indices } = args;

            // Detect if radio or checkbox
            const inputType = await page.evaluate((sel) => {
                const el = document.querySelector(sel);
                if (!el) return null;
                return el.type || el.tagName.toLowerCase();
            }, selector);

            if (!inputType) {
                return { content: [{ type: 'text', text: `Element not found: ${selector}` }], isError: true };
            }

            if (inputType === 'radio') {
                // Get all radios with same name
                const radioInfo = await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return null;
                    const name = el.name;
                    const radios = document.querySelectorAll(`input[name="${CSS.escape(name)}"]`);
                    return { name, count: radios.length };
                }, selector);

                if (radioInfo && index < radioInfo.count) {
                    // Click the label for the radio at the given index
                    await page.evaluate(({ sel, idx }) => {
                        const el = document.querySelector(sel);
                        const name = el.name;
                        const radios = document.querySelectorAll(`input[name="${CSS.escape(name)}"]`);
                        const target = radios[idx];
                        if (target) {
                            target.click();
                            // Also trigger change event
                            target.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    }, { sel: selector, idx: index });
                    return { content: [{ type: 'text', text: `Selected radio index ${index} (of ${radioInfo.count}) in group "${radioInfo.name}".` }] };
                }
                return { content: [{ type: 'text', text: `Radio index ${index} out of range (group has ${radioInfo?.count || 0} options).` }], isError: true };
            }

            if (inputType === 'checkbox') {
                const checkboxInfo = await page.evaluate((sel) => {
                    const el = document.querySelector(sel);
                    if (!el) return null;
                    const name = el.name || el.closest('fieldset')?.querySelector('input')?.name;
                    if (name) {
                        const boxes = document.querySelectorAll(`input[name="${CSS.escape(name)}"]`);
                        return { name, count: boxes.length };
                    }
                    // No name — treat as standalone
                    const all = document.querySelectorAll('input[type="checkbox"]');
                    const idx = Array.from(all).indexOf(el);
                    return { name: '__standalone__', count: all.length, standaloneIndex: idx };
                }, selector);

                const toCheck = indices || [index];
                const results = [];

                for (const idx of toCheck) {
                    try {
                        await page.evaluate(({ sel, idx }) => {
                            const el = document.querySelector(sel);
                            const name = el.name || el.closest('fieldset')?.querySelector('input')?.name;
                            let target;
                            if (name) {
                                const boxes = document.querySelectorAll(`input[name="${CSS.escape(name)}"]`);
                                target = boxes[idx];
                            } else {
                                const all = document.querySelectorAll('input[type="checkbox"]');
                                const standaloneIdx = Array.from(document.querySelectorAll('input[type="checkbox"]')).indexOf(el);
                                target = all[standaloneIdx + idx];
                            }
                            if (target && !target.checked) {
                                target.click();
                                target.dispatchEvent(new Event('change', { bubbles: true }));
                            }
                        }, { sel: selector, idx });
                        results.push(idx);
                    } catch (_) {}
                }

                return { content: [{ type: 'text', text: `Checked checkbox indices: [${results.join(', ')}].` }] };
            }

            return { content: [{ type: 'text', text: `Unsupported input type: ${inputType}. Use for radio or checkbox only.` }], isError: true };
        }

        case 'browser_get_visible_text': {
            const sel = args.selector || 'body';
            const text = await page.evaluate((selector) => {
                const root = document.querySelector(selector) || document.body;
                const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
                const lines = [];
                let currentBlock = '';

                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    const parent = node.parentElement;
                    if (!parent) continue;

                    const style = window.getComputedStyle(parent);
                    const rect = parent.getBoundingClientRect();

                    // Skip hidden elements
                    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
                    if (rect.width === 0 && rect.height === 0) continue;

                    // Skip script/style
                    const tag = parent.tagName.toLowerCase();
                    if (tag === 'script' || tag === 'style' || tag === 'noscript') continue;

                    const text = node.textContent.trim();
                    if (!text) continue;

                    // Block-level elements get their own line
                    const display = style.display;
                    const isBlock = ['block', 'flex', 'grid', 'list-item', 'table', 'table-row'].includes(display);

                    if (isBlock && currentBlock) {
                        lines.push(currentBlock);
                        currentBlock = '';
                    }

                    currentBlock += (currentBlock ? ' ' : '') + text;
                }

                if (currentBlock) lines.push(currentBlock);
                return lines.join('\n');
            }, sel);

            return { content: [{ type: 'text', text: text || '(no visible text found)' }] };
        }

        // Helpers
        case 'browser_dismiss_popups': {
            const dismissed = await page.evaluate(() => {
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

                const actions = [];
                const swal = document.querySelector('.swal2-popup');
                if (swal && swal.getBoundingClientRect().width > 0) {
                    const btn = swal.querySelector('.swal2-confirm, .swal2-close, .swal2-cancel');
                    if (btn) { btn.click(); actions.push('swal2'); }
                }
                querySelectorAllDeep('.modal.show, [role="dialog"], [aria-modal="true"]').forEach(m => {
                    if (m.getBoundingClientRect().width === 0) return;
                    // standard close buttons
                    let close = m.querySelector('[data-dismiss="modal"], [data-bs-dismiss="modal"], button.close, .btn-close, [aria-label="Close"]');
                    // generic agree/accept/close buttons
                    if (!close) {
                        const btns = Array.from(m.querySelectorAll('button, a'));
                        close = btns.find(b => {
                            const t = b.textContent.toLowerCase();
                            return t.includes('setuju') || t.includes('agree') || t.includes('accept') || t.includes('got it') || t.includes('close');
                        });
                    }
                    if (close) { close.click(); actions.push('modal'); }
                });
                return actions;
            });
            return { content: [{ type: 'text', text: dismissed.length ? `Dismissed: ${dismissed.join(', ')}` : 'No popups found.' }] };
        }

        // Schema-typed extraction
        case 'browser_observe': {
            const observed = await observeInteractable(page);
            return { content: [{ type: 'text', text: JSON.stringify(observed, null, 2) }] };
        }
        case 'browser_click_ref': {
            const el = getElementByRef(args.ref);
            if (!el) {
                return { content: [{ type: 'text', text: `Ref ${args.ref} not found. Call browser_observe or browser_get_state first.` }], isError: true };
            }
            const cx = el.x + Math.floor(el.w / 2);
            const cy = el.y + Math.floor(el.h / 2);
            const label = el.text ? ` "${el.text.substring(0, 50)}"` : '';
            if (AGENT_CONFIG.profile === 'stealth') {
                await page.mouse.move(cx + (Math.random() - 0.5) * 4, cy + (Math.random() - 0.5) * 4, { steps: 5 });
                await page.waitForTimeout(Math.random() * 150 + 80);
            }
            await page.mouse.click(cx, cy);
            recorder.record('click_ref', { ref: args.ref, label: el.text, x: cx, y: cy, selector: el.id ? `#${el.id}` : null });
            return { content: [{ type: 'text', text: `Clicked ref ${args.ref} (${el.tag}${label}) at (${cx}, ${cy}).` }] };
        }

        // CDP Diagnostics
        case 'browser_console_messages': {
            let messages = getConsoleMessages(page);
            const filterType = args.type || 'all';
            if (filterType !== 'all') messages = messages.filter(m => m.type === filterType);
            if (args.clear) clearConsoleMessages(page);
            if (!messages.length) return { content: [{ type: 'text', text: 'No console messages captured.' }] };
            const maxLines = args.maxLines ?? 100;
            const truncated = messages.length > maxLines;
            const limited = messages.slice(0, maxLines);
            const lines = limited.map(m => `[${m.type}] ${m.text}${m.url ? ` (${m.url})` : ''}`);
            const suffix = truncated ? `\n... (${messages.length - maxLines} more, increase maxLines to see all)` : '';
            return { content: [{ type: 'text', text: lines.join('\n') + suffix }] };
        }
        case 'browser_network_requests': {
            let requests = getNetworkRequests(page);
            if (args.filter) requests = requests.filter(r => r.url.includes(args.filter));
            if (args.statusMin) requests = requests.filter(r => r.status >= args.statusMin);
            if (args.clear) clearNetworkRequests(page);
            if (!requests.length) return { content: [{ type: 'text', text: 'No network requests captured.' }] };
            const maxLines = args.maxLines ?? 100;
            const truncated = requests.length > maxLines;
            const limited = requests.slice(0, maxLines);
            const lines = limited.map(r => `[${r.status}] ${r.method} ${r.url} — ${r.duration}ms ${r.contentType ? '(' + r.contentType + ')' : ''}`);
            const suffix = truncated ? `\n... (${requests.length - maxLines} more, increase maxLines to see all)` : '';
            return { content: [{ type: 'text', text: lines.join('\n') + suffix }] };
        }

        case 'browser_extract_schema': {
            const schema = args.schema;
            const scope = args.selector || 'body';
            const data = await page.evaluate(({ scopeSelector, schemaProps }) => {
                const root = document.querySelector(scopeSelector) || document.body;
                const result = {};
                for (const [key, def] of Object.entries(schemaProps)) {
                    const hint = (def.description || '').toLowerCase();
                    const type = def.type || 'string';

                    // Strategy: try aria/semantic selectors guided by description hints
                    const candidates = [];
                    if (hint.includes('price') || hint.includes('cost')) candidates.push('[class*="price"]', '[itemprop="price"]', '[data-price]');
                    if (hint.includes('title') || hint.includes('name')) candidates.push('h1', 'h2', '[itemprop="name"]', '[class*="title"]');
                    if (hint.includes('description')) candidates.push('[itemprop="description"]', '[class*="description"]', '[class*="summary"]', 'p');
                    if (hint.includes('image') || hint.includes('img')) candidates.push('img[src]', '[itemprop="image"]');
                    if (hint.includes('url') || hint.includes('link')) candidates.push('a[href]', 'link[rel="canonical"]');
                    if (hint.includes('rating') || hint.includes('score')) candidates.push('[itemprop="ratingValue"]', '[class*="rating"]', '[class*="score"]');
                    if (hint.includes('author')) candidates.push('[itemprop="author"]', '[class*="author"]', '[rel="author"]');
                    if (hint.includes('date')) candidates.push('time[datetime]', '[itemprop="datePublished"]', '[class*="date"]');
                    // Fallback: try to find element by key name as class/id/itemprop
                    candidates.push(`[itemprop="${key}"]`, `[class*="${key}"]`, `[id*="${key}"]`, `[data-${key}]`);

                    let found = null;
                    for (const sel of candidates) {
                        const el = root.querySelector(sel);
                        if (el) { found = el; break; }
                    }

                    if (!found) { result[key] = null; continue; }

                    if (type === 'string' || type === 'number') {
                        let val = found.getAttribute('content') || found.getAttribute('datetime')
                            || found.getAttribute('data-price') || found.innerText?.trim() || found.getAttribute('src') || found.getAttribute('href') || null;
                        if (type === 'number' && val) val = parseFloat(val.replace(/[^0-9.-]/g, '')) || null;
                        result[key] = val;
                    } else if (type === 'boolean') {
                        result[key] = found !== null;
                    } else if (type === 'array') {
                        result[key] = Array.from(root.querySelectorAll(candidates[candidates.length - 1] || sel))
                            .map(e => e.innerText?.trim()).filter(Boolean).slice(0, 20);
                    } else {
                        result[key] = found.innerText?.trim() || null;
                    }
                }
                return result;
            }, { scopeSelector: scope, schemaProps: schema.properties || schema });

            return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
        }

        // Test generation
        case 'browser_generate_playwright_test': {
            const script = recorder.generate(args.testName || 'recorded_session');
            if (!script) return { content: [{ type: 'text', text: 'No actions recorded. Interact with the browser first.' }] };
            if (args.outputPath) {
                const dir = path.dirname(args.outputPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(args.outputPath, script);
                return { content: [{ type: 'text', text: `Playwright test saved to ${args.outputPath}\n\n${script}` }] };
            }
            return { content: [{ type: 'text', text: script }] };
        }
        case 'browser_clear_recording': {
            recorder.clear();
            return { content: [{ type: 'text', text: 'Recording cleared. Subsequent actions will be recorded fresh.' }] };
        }

        // Performance / Core Web Vitals
        case 'browser_performance': {
            const [metrics, cwv] = await Promise.all([
                page.evaluate(() => {
                    const nav = performance.getEntriesByType('navigation')[0] || {};
                    const paint = Object.fromEntries(
                        performance.getEntriesByType('paint').map(e => [e.name.replace('first-', ''), Math.round(e.startTime)])
                    );
                    const resources = performance.getEntriesByType('resource');
                    const mem = performance.memory || {};
                    return {
                        domContentLoaded: Math.round(nav.domContentLoadedEventEnd - nav.fetchStart) || null,
                        load: Math.round(nav.loadEventEnd - nav.fetchStart) || null,
                        ttfb: Math.round(nav.responseStart - nav.fetchStart) || null,
                        paint,
                        resourceCount: resources.length,
                        transferSize: Math.round(resources.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024),
                        memory: mem.usedJSHeapSize ? {
                            usedJSHeapSize: Math.round(mem.usedJSHeapSize / 1024 / 1024 * 100) / 100, // MB
                            totalJSHeapSize: Math.round(mem.totalJSHeapSize / 1024 / 1024 * 100) / 100, // MB
                            jsHeapSizeLimit: Math.round(mem.jsHeapSizeLimit / 1024 / 1024 * 100) / 100 // MB
                        } : null
                    };
                }),
                page.evaluate(() => new Promise(resolve => {
                    const result = {};
                    try {
                        new PerformanceObserver(list => {
                            for (const entry of list.getEntries()) {
                                if (entry.entryType === 'largest-contentful-paint') result.lcp = Math.round(entry.startTime);
                                if (entry.entryType === 'layout-shift') result.cls = (result.cls || 0) + entry.value;
                            }
                        }).observe({ type: 'largest-contentful-paint', buffered: true });
                        new PerformanceObserver(list => {
                            for (const entry of list.getEntries()) {
                                if (entry.entryType === 'layout-shift') result.cls = ((result.cls || 0) + entry.value);
                            }
                        }).observe({ type: 'layout-shift', buffered: true });
                    } catch (_) {}
                    setTimeout(() => resolve(result), 500);
                })),
            ]);

            const out = { ...metrics, coreWebVitals: cwv };
            const lcpRating = cwv.lcp ? (cwv.lcp < 2500 ? 'good' : cwv.lcp < 4000 ? 'needs-improvement' : 'poor') : 'unknown';
            const clsRating = cwv.cls !== undefined ? (cwv.cls < 0.1 ? 'good' : cwv.cls < 0.25 ? 'needs-improvement' : 'poor') : 'unknown';
            out.ratings = { lcp: lcpRating, cls: clsRating };
            return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        }

        // Planner-validator
        case 'browser_assert': {
            const type = args.conditionType || 'selector';
            let passed = false;
            let actual = null;

            if (type === 'selector') {
                const el = await page.$(args.condition);
                if (el) {
                    const text = await el.innerText().catch(() => '');
                    if (args.expected) {
                        passed = text.includes(args.expected);
                        actual = text.trim().substring(0, 300);
                    } else {
                        passed = true;
                    }
                } else {
                    passed = false;
                    // Report what is near the selector's tag on the page to help re-plan
                    const tag = args.condition.split(/[\s.#\[]/)[0] || 'div';
                    const nearby = await page.evaluate(t => {
                        const els = Array.from(document.querySelectorAll(t)).slice(0, 5);
                        return els.map(e => e.outerHTML.substring(0, 200)).join('\n');
                    }, tag).catch(() => '');
                    actual = nearby || '(element not found, page may have changed)';
                }
            } else if (type === 'url') {
                const url = page.url();
                passed = url.includes(args.condition);
                actual = url;
            } else if (type === 'js') {
                const res = await page.evaluate(expr => {
                    // eslint-disable-next-line no-new-func
                    return new Function(`return (${expr})`)();
                }, args.condition).catch(e => ({ error: e.message }));
                passed = !!res && !res.error;
                actual = JSON.stringify(res);
            }

            if (passed) {
                return { content: [{ type: 'text', text: `✓ Assert passed.` }] };
            }
            return {
                content: [{ type: 'text', text: `✗ Assert failed.\nCondition: ${args.condition}\nActual: ${actual}` }],
                isError: true,
            };
        }

        // Cache management
        case 'browser_cache_stats': {
            const s = cache.stats();
            return { content: [{ type: 'text', text: JSON.stringify(s, null, 2) }] };
        }

        // Health
        case 'browser_health': {
            const health = await healthCheck();
            return { content: [{ type: 'text', text: JSON.stringify(health, null, 2) }] };
        }

        // ── New Tools: Assertions ────────────────────────────────────────────────
        case 'browser_assert_visible': {
            try {
                const visible = await page.locator(args.selector).first().isVisible({ timeout: 5000 });
                if (visible) {
                    return { content: [{ type: 'text', text: `[PASS] ${args.selector} is visible` }] };
                }
                return { content: [{ type: 'text', text: `[FAIL] ${args.selector} is not visible` }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `[FAIL] ${args.selector} — ${e.message}` }] };
            }
        }
        case 'browser_assert_text': {
            try {
                const element = page.locator(args.selector).first();
                const content = await element.textContent({ timeout: 5000 }) || '';
                if (content.includes(args.expected)) {
                    const idx = content.indexOf(args.expected);
                    const start = Math.max(0, idx - 50);
                    const end = Math.min(content.length, idx + args.expected.length + 50);
                    const ctx = (start > 0 ? '...' : '') + content.substring(start, end) + (end < content.length ? '...' : '');
                    return { content: [{ type: 'text', text: `[PASS] Found "${args.expected}" in ${args.selector}`, data: { found: true, context: ctx } }] };
                }
                return { content: [{ type: 'text', text: `[FAIL] "${args.expected}" not found in ${args.selector} (${content.length} chars)`, data: { found: false, text: content.substring(0, 300) } }] };
            } catch (e) {
                return { content: [{ type: 'text', text: `[FAIL] ${args.selector} — ${e.message}` }] };
            }
        }
        case 'browser_assert_url': {
            const currentUrl = page.url();
            if (currentUrl.includes(args.pattern)) {
                return { content: [{ type: 'text', text: `[PASS] URL contains "${args.pattern}"`, data: { match: true, url: currentUrl } }] };
            }
            return { content: [{ type: 'text', text: `[FAIL] URL does not contain "${args.pattern}"`, data: { match: false, url: currentUrl } }] };
        }

        // ── New Tools: Perception ───────────────────────────────────────────────
        case 'browser_get_page_markdown': {
            const sel = args.selector || 'main, article, [role="main"], .content, body';
            const maxLen = args.maxLength || 5000;
            const markdown = await page.evaluate(({ selector, max }) => {
                const root = document.querySelector(selector) || document.body;
                const lines = [];
                let charCount = 0;

                function processNode(node) {
                    if (charCount >= max) return;
                    if (node.nodeType === Node.TEXT_NODE) {
                        const text = node.textContent.trim();
                        if (text) { lines.push(text); charCount += text.length; }
                        return;
                    }
                    if (node.nodeType !== Node.ELEMENT_NODE) return;

                    const tag = node.tagName.toLowerCase();
                    const style = window.getComputedStyle(node);
                    if (style.display === 'none' || style.visibility === 'hidden') return;
                    if (['script', 'style', 'noscript'].includes(tag)) return;

                    if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
                        const level = parseInt(tag[1]);
                        lines.push('\n' + '#'.repeat(level) + ' ' + node.textContent.trim());
                        charCount += level + 1 + node.textContent.length;
                    } else if (tag === 'p') {
                        lines.push('\n' + node.textContent.trim());
                        charCount += node.textContent.length;
                    } else if (tag === 'li') {
                        lines.push('- ' + node.textContent.trim());
                        charCount += node.textContent.length + 2;
                    } else if (tag === 'a' && node.href) {
                        const text = node.textContent.trim();
                        if (text) { lines.push('[' + text + '](' + node.href + ')'); charCount += text.length + node.href.length; }
                    } else if (tag === 'img' && node.alt) {
                        lines.push('![' + node.alt + '](' + node.src + ')');
                        charCount += node.alt.length + node.src.length;
                    } else if (tag === 'table') {
                        const rows = Array.from(node.querySelectorAll('tr'));
                        rows.forEach((row, i) => {
                            const cells = Array.from(row.querySelectorAll('td, th')).map(c => c.textContent.trim());
                            lines.push('| ' + cells.join(' | ') + ' |');
                            if (i === 0) lines.push('| ' + cells.map(() => '---').join(' | ') + ' |');
                        });
                    } else {
                        for (const child of node.childNodes) processNode(child);
                        return;
                    }
                    if (!['table','h1','h2','h3','h4','h5','h6','p','li'].includes(tag)) {
                        for (const child of node.childNodes) processNode(child);
                    }
                }

                processNode(root);
                return lines.join('\n').substring(0, max);
            }, { selector: sel, max: maxLen });

            return { content: [{ type: 'text', text: markdown || '(no content found)' }] };
        }
        case 'browser_get_accessibility_tree': {
            const sel = args.selector;
            const maxLen = args.maxLength || 5000;
            const tree = await page.evaluate(({ selector, max }) => {
                const root = selector ? document.querySelector(selector) : document.body;
                if (!root) return '(element not found)';

                const lines = [];
                let charCount = 0;

                function walk(el, depth) {
                    if (charCount >= max) return;
                    const role = el.getAttribute('role') || '';
                    const name = el.getAttribute('aria-label') || '';
                    const state = [];
                    if (el.getAttribute('aria-hidden') === 'true') state.push('hidden');
                    if (el.getAttribute('aria-disabled') === 'true') state.push('disabled');
                    if (el.getAttribute('aria-expanded')) state.push('expanded=' + el.getAttribute('aria-expanded'));
                    if (el.getAttribute('aria-checked')) state.push('checked=' + el.getAttribute('aria-checked'));
                    if (el.getAttribute('aria-selected')) state.push('selected=' + el.getAttribute('aria-selected'));
                    if (el.getAttribute('aria-current')) state.push('current=' + el.getAttribute('aria-current'));
                    if (el.tagName === 'INPUT') state.push('type=' + el.type);
                    if (el.tagName === 'A' && el.href) state.push('href=' + el.href.substring(0, 80));

                    const tag = el.tagName.toLowerCase();
                    const indent = '  '.repeat(depth);
                    const stateStr = state.length ? ' [' + state.join(', ') + ']' : '';
                    const nameStr = name ? ' "' + name + '"' : '';
                    const text = el.childNodes.length === 1 && el.childNodes[0].nodeType === 3
                        ? ' "' + el.textContent.trim().substring(0, 50) + '"' : '';

                    lines.push(indent + tag + (role ? ' role=' + role : '') + (nameStr || text) + stateStr);
                    charCount += lines[lines.length - 1].length;

                    for (const child of el.children) walk(child, depth + 1);
                }

                walk(root, 0);
                return lines.join('\n').substring(0, max);
            }, { selector: sel, max: maxLen });

            return { content: [{ type: 'text', text: tree || '(no tree found)' }] };
        }

        // ── New Tools: Network Mocking ──────────────────────────────────────────
        case 'browser_mock_network': {
            const mockPattern = args.pattern;
            const body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
            const status = args.status || 200;
            const contentType = args.contentType || 'application/json';

            await page.route(mockPattern, route => {
                return route.fulfill({ status, contentType, body });
            });

            return { content: [{ type: 'text', text: 'Network mock active: ' + mockPattern + ' → ' + status }] };
        }
        case 'browser_clear_mocks': {
            await page.unrouteAll();
            return { content: [{ type: 'text', text: 'All network mocks cleared.' }] };
        }

        // ── New Tools: Dialog Handling ──────────────────────────────────────────
        case 'browser_dialog': {
            const dialogAction = args.action;
            const promptText = args.promptText || '';

            page.once('dialog', async (dialog) => {
                try {
                    if (dialogAction === 'accept') {
                        await dialog.accept(promptText);
                    } else {
                        await dialog.dismiss();
                    }
                } catch (_) {}
            });

            return { content: [{ type: 'text', text: 'Dialog handler set to "' + dialogAction + '"' + (promptText ? ' with prompt text' : '') + '.' }] };
        }

        // ── New Tools: File Upload ──────────────────────────────────────────────
        case 'browser_upload': {
            const files = args.filePath.split(',').map(f => f.trim()).filter(Boolean);
            await page.setInputFiles(args.selector, files);
            return { content: [{ type: 'text', text: 'Uploaded ' + files.length + ' file(s) to ' + args.selector + '.' }] };
        }

        // ── New Tools: Click Nth ────────────────────────────────────────────────
        case 'browser_click_nth': {
            const locator = page.locator(args.selector);
            const count = await locator.count();
            if (args.index < 0 || args.index >= count) {
                return { content: [{ type: 'text', text: 'Index ' + args.index + ' out of range (found ' + count + ' matches).' }], isError: true };
            }
            if (AGENT_CONFIG.profile === 'stealth') {
                const box = await locator.nth(args.index).boundingBox({ timeout: 5000 });
                if (box) {
                    const jitterX = (Math.random() - 0.5) * 4;
                    const jitterY = (Math.random() - 0.5) * 4;
                    await page.mouse.move(box.x + box.width / 2 + jitterX, box.y + box.height / 2 + jitterY, { steps: 5 });
                    await page.waitForTimeout(Math.random() * 150 + 80);
                }
            }
            await locator.nth(args.index).click({ timeout: 5000 });
            recorder.record('click_nth', { selector: args.selector, index: args.index });
            return { content: [{ type: 'text', text: 'Clicked ' + args.selector + ' at index ' + args.index + ' (of ' + count + ').' }] };
        }

        // ── New Tools: Visual Debug ─────────────────────────────────────────────
        case 'browser_highlight': {
            const color = args.color || 'red';
            const duration = args.durationMs || 3000;
            await page.evaluate(({ sel, clr, dur }) => {
                const el = document.querySelector(sel);
                if (!el) return;
                const prev = el.style.outline;
                el.style.transition = 'outline 0.2s ease';
                el.style.outline = '3px solid ' + clr;
                setTimeout(() => { el.style.outline = prev; }, dur);
            }, { sel: args.selector, clr: color, dur: duration });
            return { content: [{ type: 'text', text: 'Highlighted ' + args.selector + ' in ' + color + ' for ' + duration + 'ms.' }] };
        }

        // ── New Tools: Wait for Change ──────────────────────────────────────────
        case 'browser_wait_for_change': {
            const changeTimeout = args.timeout || 10000;
            const attr = args.attribute || 'textContent';
            try {
                if (attr === 'textContent' || attr === 'innerText') {
                    const initial = await page.locator(args.selector).first().textContent({ timeout: 3000 }) || '';
                    await page.waitForFunction(
                        ([sel, initialText, attribute]) => {
                            const el = document.querySelector(sel);
                            if (!el) return false;
                            const current = attribute === 'innerText' ? el.innerText : el.textContent;
                            return current !== initialText;
                        },
                        [args.selector, initial, attr],
                        { timeout: changeTimeout }
                    );
                } else {
                    const initial = await page.locator(args.selector).first().getAttribute(attr, { timeout: 3000 });
                    await page.waitForFunction(
                        ([sel, attributeName, initialValue]) => {
                            const el = document.querySelector(sel);
                            if (!el) return false;
                            return el.getAttribute(attributeName) !== initialValue;
                        },
                        [args.selector, attr, initial],
                        { timeout: changeTimeout }
                    );
                }
                return { content: [{ type: 'text', text: args.selector + ' ' + attr + ' changed.' }] };
            } catch (e) {
                return { content: [{ type: 'text', text: 'Timeout waiting for ' + args.selector + ' ' + attr + ' to change.' }], isError: true };
            }
        }

        // ── Emulation & Viewport ──────────────────────────────────────────────────
        case 'browser_emulate': {
            const ctx = await getBrowserContext();
            
            // 1. Geolocation
            if (args.geolocation) {
                await ctx.setGeolocation({
                    latitude: args.geolocation.latitude,
                    longitude: args.geolocation.longitude,
                    accuracy: args.geolocation.accuracy ?? 100
                });
                await ctx.grantPermissions(['geolocation']);
            }

            // 2. Color Scheme
            if (args.colorScheme) {
                await page.emulateMedia({ colorScheme: args.colorScheme });
            }

            // 3. CDP-specific emulation (CPU, Network, Timezone, Locale)
            const client = await ctx.newCDPSession(page);
            
            if (args.cpuThrottlingRate) {
                await client.send('Emulation.setCPUThrottlingRate', { rate: args.cpuThrottlingRate });
            }

            if (args.timezoneId) {
                await client.send('Emulation.setTimezoneOverride', { timezoneId: args.timezoneId });
            }

            if (args.locale) {
                await client.send('Emulation.setLocaleOverride', { locale: args.locale });
            }

            if (args.networkProfile) {
                let conditions = { offline: false, downloadThroughput: -1, uploadThroughput: -1, latency: 0 };
                if (args.networkProfile === 'offline') {
                    conditions = { offline: true, downloadThroughput: 0, uploadThroughput: 0, latency: 0 };
                } else if (args.networkProfile === 'Slow 3G') {
                    conditions = {
                        offline: false,
                        downloadThroughput: Math.round(400 * 1024 / 8),
                        uploadThroughput: Math.round(400 * 1024 / 8),
                        latency: 400
                    };
                } else if (args.networkProfile === 'Fast 3G') {
                    conditions = {
                        offline: false,
                        downloadThroughput: Math.round(1.6 * 1024 * 1024 / 8),
                        uploadThroughput: Math.round(750 * 1024 / 8),
                        latency: 150
                    };
                }
                await client.send('Network.enable');
                await client.send('Network.emulateNetworkConditions', conditions);
            }

            return { content: [{ type: 'text', text: 'Emulation settings successfully applied.' }] };
        }

        case 'browser_resize_page': {
            const width = args.width;
            const height = args.height;
            if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
                return { content: [{ type: 'text', text: 'Invalid width or height parameters.' }], isError: true };
            }
            await page.setViewportSize({ width, height });
            return { content: [{ type: 'text', text: 'Resized page viewport to ' + width + 'x' + height + '.' }] };
        }

        // ── Playwright Trace Recording ───────────────────────────────────────────
        case 'browser_start_trace': {
            const ctx = await getBrowserContext();
            const screenshots = args.screenshots !== false;
            const snapshots = args.snapshots !== false;
            await ctx.tracing.start({ name: 'mcp-trace', screenshots, snapshots, sources: true });
            isTracingRunning = true;
            return { content: [{ type: 'text', text: 'Started browser trace recording (screenshots: ' + screenshots + ', snapshots: ' + snapshots + ').' }] };
        }

        case 'browser_stop_trace': {
            if (!isTracingRunning) {
                return { content: [{ type: 'text', text: 'No active trace recording found. Call browser_start_trace first.' }], isError: true };
            }
            const ctx = await getBrowserContext();
            const exportDir = path.join(__dirname, '../../exports');
            if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

            const outputPath = args.outputPath || path.join(exportDir, `trace-${Date.now()}.zip`);
            const dir = path.dirname(outputPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

            await ctx.tracing.stop({ path: outputPath });
            isTracingRunning = false;
            return { content: [{ type: 'text', text: 'Stopped trace recording. Trace saved to: ' + outputPath }] };
        }

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

module.exports = {
    TOOLS,
    handleToolCall
};
