# Browser-Agent

A modular, production-ready browser automation agent implemented as a Model Context Protocol (MCP) server. Powered by Playwright, it provides **88 tools** for human-like web interaction, state analysis, automated navigation, and network-level control.

## Features

- **Semantic Interaction**: Click elements by text (`browser_click_text`) and fill entire forms (`browser_fill_form`) with single commands.
- **Multi-Tab Management**: Handle multiple sites simultaneously with tab list, switch, and creation tools.
- **Resilient Navigation**: Automatic retry with configurable attempts and backoff on network failures.
- **Request Interception**: Block, mock, or modify requests at the network level — stub APIs, strip ads, inject auth headers.
- **Session & Persistence**: Persistent browser contexts with named session save/load for both cookies and Web Storage (`localStorage`/`sessionStorage`).
- **Crash Recovery**: Browser state is automatically persisted to disk. If the browser process dies, tabs and intercept rules are restored on the next tool call — no data loss.
- **Parallel Agents**: Run independent named pages within a single browser context. Create, switch, and remove agents to handle multi-page workflows without interference.
- **PDF Export**: Save pages to disk as PDF with a custom output path and accurate file size reporting.
- **Smart Wait Strategy**: `browser_wait_for_load` for sites with WebSocket/SSE connections; `browser_wait_until_stable` for AJAX-heavy SPAs; `browser_wait_for_navigation` for post-action URL/selector waits.
- **Stealth and Evasion**: Anti-detection behavioral profiles (`stealth` vs `speed`), realistic user-agent spoofing, human-like mouse jitter and typing delay.
- **Robust State Capture**: Extracts semantic page data including Accessibility Trees (AX Tree), interactive elements, and structural headings. **Natively pierces cross-origin iframes (like Stripe/CAPTCHA)** to provide unified DOM extraction.
- **Vision & Set-of-Mark (SoM)**: Supports `mark_elements=true` to draw numbered bounding boxes over interactable elements in screenshots, bypassing semantic limitations of Canvas/ShadowDOM.
- **Data Extraction**: Table-to-JSON extraction, high-fidelity PDF/HTML capture, and visible-only text extraction.
- **CAPTCHA Management**: Automated detection and assisted resolution for reCAPTCHA, hCaptcha, and common challenge pages.
- **API Interception & Capture**: Capture XHR/fetch responses as structured JSON — extract quiz data without DOM scraping.
- **Batch Automation**: Answer entire quizzes in one tool call; batch form filling with index-based selection.
- **OCR**: Extract text from code screenshots and images via Tesseract.js with preprocessing.
- **Macro Recording & Replay**: Record workflows once, replay them with different parameters.
- **Parallel Execution**: Run actions on multiple named pages concurrently.
- **Assertions**: Verify outcomes without breaking flow — `browser_assert_visible`, `browser_assert_text`, `browser_assert_url` return PASS/FAIL.
- **Perception Tools**: Read page content as structured Markdown or accessibility tree — no screenshots needed.
- **Network Mocking**: Mock API responses for frontend testing without touching the backend.
- **SSRF Protection**: Blocks navigation to `file://`, `javascript://`, private IPs, DNS rebinding, and cloud metadata endpoints.

## Demo

See the General Browser Agent in action with Gemini CLI: [Watch on YouTube](https://youtu.be/O6nYKjmlaGk)

## Toolset

### Navigation & Tabs

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL with automatic retry on failure (`retries`, `retryDelay`) — state is saved for crash recovery |
| `browser_new_tab` | Open a new tab, optionally at a URL |
| `browser_list_tabs` | List all open tabs and their active status |
| `browser_switch_tab` | Switch active tab by index |
| `browser_back` / `browser_forward` / `browser_reload` | Standard history control |
| `browser_wait` | Wait for a fixed number of milliseconds |
| `browser_wait_for_selector` | Wait until an element appears in the DOM |
| `browser_wait_for_url` | Wait until the URL matches a pattern (substring or regex) |
| `browser_wait_for_navigation` | Smart wait for URL change/selector after an action (replaces fixed waits) |
| `browser_wait_until_stable` | Wait for networkidle — use for AJAX/SPA pages |
| `browser_wait_for_load` | Wait for the `load` or `domcontentloaded` event — use for WebSocket/SSE pages |

### Named Agents / Parallelism

![Blotcat acting as a puppeteer, controlling multiple isolated parallel browser contexts on strings](assets/blotcat-parallel.jpg)

| Tool | Description |
|------|-------------|
| `browser_agent_create` | Create a new named agent page, or switch to an existing one |
| `browser_agent_switch` | Switch active context to a named agent |
| `browser_agent_remove` | Close and remove a named agent |
| `browser_agent_list` | List all active named agents and their URLs |

Named agents are independent pages within the same browser. Use them to parallelize workflows — each agent keeps its own navigation state, forms, and cookies. Create one, work on it, switch to another, come back later.

**Wait strategy guide:**

| Situation | Tool |
|-----------|------|
| Standard page navigation | `browser_wait_for_load()` |
| SPA / AJAX-heavy content | `browser_wait_until_stable()` |
| Page with WebSocket or long-polling | `browser_wait_for_load()` — networkidle will hang |
| Specific element expected | `browser_wait_for_selector(selector)` |
| URL change after action | `browser_wait_for_url(pattern)` |

### Interaction

| Tool | Description |
|------|-------------|
| `browser_click_text` | Click element by visible text (smart button/link detection) |
| `browser_click_nth` | Click the nth element matching a CSS selector (0-based index) |
| `browser_fill_form` | Populate multiple fields at once from a `{selector: value}` object |
| `browser_click` | Click by selector or `x, y` coordinates — includes smart retry with fallback selectors |
| `browser_double_click` / `browser_right_click` | Pointer events |
| `browser_hover` | Hover over an element or coordinates |
| `browser_drag` | Drag source element to target |
| `browser_upload` | Upload a file to an `<input type="file">` element |
| `browser_download_click` | Click an element (by ref) that triggers an OS file download, bypass the dialog, and save locally |
| `browser_scroll` / `browser_scroll_to` | Scroll by direction or to a target |
| `browser_smart_scroll` | Incremental scroll to trigger lazy-loaded content |

### Assertions

Verify outcomes without breaking flow — each returns `[PASS]` or `[FAIL]`:

| Tool | Description |
|------|-------------|
| `browser_assert_visible` | Assert that a selector is visible within timeout |
| `browser_assert_text` | Assert that a selector contains specific text |
| `browser_assert_url` | Assert that the URL matches a pattern (substring or regex) |

**Example:**
```
browser_assert_visible("selector=button#submit", timeout=5000)
→ [PASS] Button '#submit' is visible

browser_assert_url("pattern=/dashboard")
→ [PASS] URL contains '/dashboard'
```

### Forms & Input

| Tool | Description |
|------|-------------|
| `browser_type` | Human-like character insertion with configurable delay |
| `browser_clear` | Clear an input field |
| `browser_press` | Press a keyboard key |
| `browser_select` | Select a dropdown option by value or label |
| `browser_select_by_index` | Select radio/checkbox by 0-based index (reliable for quiz questions) |
| `browser_check` / `browser_uncheck` | Checkbox and radio control |

### Observation & Extraction

![Blotcat using AX Tree goggles to turn a messy web scribble into a neat grid of Set-of-Mark boxes](assets/blotcat-perception.jpg)

| Tool | Description |
|------|-------------|
| `browser_get_state` | Unified page snapshot: URL, title, AX tree, interactive elements, screenshot. Use `mark_elements=true` for Set-of-Mark visual bounding boxes. |
| `browser_observe` | **Low-token alternative to `browser_get_state`** — returns only interactable elements with `ref` numbers, no screenshot. Use for pre-action planning. |
| `browser_click_ref` | Click an element by its `ref` number. Includes closed-loop Action Verification (auto-awaits `networkidle` and reports navigation status). |
| `browser_state_diff` | Compare last two AX snapshots: URL/title changes, new/removed headings, element shifts, popups, captcha |
| `browser_screenshot` | Take a screenshot (supports `mark_elements=true`) |
| `browser_get_text` | Read text from one or all matching elements |
| `browser_get_visible_text` | Extract only visible text (skips hidden, display:none, zero-size elements) |
| `browser_get_html` | Get full page or element HTML |
| `browser_extract_table` | Convert an HTML table to structured JSON |
| `browser_get_cookies` | Get all cookies for the active page |
| `browser_evaluate` | Execute JavaScript in the page context (supports `return`, `await`, and `args` injection) |
| `browser_print_to_pdf` | Save the page as a PDF file to a specified path |
| `browser_console_messages` | Return captured browser console messages and JS errors (last 100). Filter by `type`. Pass `clear: true` to flush. |
| `browser_network_requests` | Return captured network requests with status and timing (last 100). Filter by URL substring or `statusMin`. |
| `browser_health` | Check browser health: context alive, page responsive, latency, active URL. Use to diagnose crashes or unresponsive pages. |
| `browser_get_page_markdown` | Read page content as structured Markdown — headings, paragraphs, links, images. No screenshot needed. |
| `browser_get_accessibility_tree` | Get the full accessibility tree (AX Tree) without a screenshot. Lightweight perception tool for structured data. |

**`browser_evaluate` usage:**
```js
// Return a value
script: "return document.title"

// Use await
script: "const r = await fetch('/api/status'); return r.status"

// Pass data via args (no string interpolation needed)
script: "return args.x * args.y"
args: { "x": 6, "y": 7 }
```

### Request Interception & API Capture

![Blotcat acting as a network tollbooth, holding a block sign to an envelope while stamping another with mock](assets/blotcat-interception.jpg)

| Tool | Description |
|------|-------------|
| `browser_intercept` | Add an intercept rule: `block`, `mock`, or `modify` |
| `browser_intercept_list` | List all active intercept rules |
| `browser_clear_intercepts` | Remove all intercept rules |
| `browser_intercept_api` | Capture API responses matching a URL pattern as structured JSON |
| `browser_get_captured_apis` | Retrieve all captured API responses with optional filter |

**Actions:**
- `block` — abort matching requests (ads, trackers, heavy assets)
- `mock` — return a synthetic response with `status`, `body`, `contentType`, `headers`
- `modify` — pass the request through with injected headers (auth tokens, API keys)

**Examples:**
```
# Block all images
pattern: "**/*.{png,jpg,jpeg,gif,webp}", action: "block"

# Mock an API endpoint
pattern: "https://api.example.com/users*", action: "mock"
body: { "users": [] }, status: 200

# Inject Authorization header
pattern: "https://api.example.com/*", action: "modify"
headers: { "Authorization": "Bearer <token>" }
```

Rules persist across page navigations until `browser_clear_intercepts` is called.

### Network Mocking

Mock API responses without touching the backend — ideal for testing error states and edge cases:

| Tool | Description |
|------|-------------|
| `browser_mock_network` | Mock responses for requests matching a URL pattern |
| `browser_clear_mocks` | Remove all mock rules (keeps other intercept rules) |

**Example:**
```
# Mock a 500 error
browser_mock_network(pattern="**/api/users*", status=500, body={"error": "Internal Server Error"})

# Mock a slow response
browser_mock_network(pattern="**/api/data*", body={"data": [...]}, delay=3000)

# Clear all mocks
browser_clear_mocks()
```

### Session & Profile Management

| Tool | Description |
|------|-------------|
| `browser_save_session` | Save cookies (and optionally `localStorage`/`sessionStorage`) to a named file |
| `browser_load_session` | Restore a saved session |
| `browser_list_sessions` | List saved session files with size, cookie count, and origin |
| `browser_set_agent_profile` | Switch between `stealth` and `speed` behavioral profiles |
| `browser_handle_captcha` | Detect and manage CAPTCHA with optional manual hand-off |
| `browser_solve_captcha_grid` | Click specific grid cells in a visual CAPTCHA |
| `browser_switch_to_new_tab` | Detect and switch to a newly opened tab/popup |
| `browser_dialog` | Handle JavaScript `alert`, `confirm`, `prompt` dialogs (auto-dismissed by default) |
| `browser_highlight` | Highlight element(s) by selector — visual debug overlay |
| `browser_wait_for_change` | Wait for page title, URL, or element count to change (SPA detection) |
| `browser_close` | Terminate the browser session and clear all state |

### Batch Automation

| Tool | Description |
|------|-------------|
| `browser_batch_answer_quiz` | Answer all quiz questions in one call — auto-detects radio/checkbox, navigates, optional submit |
| `browser_fill_form` | Fill multiple form fields at once (see Forms & Input) |

### OCR & Macros

| Tool | Description |
|------|-------------|
| `browser_ocr` | Extract text from screenshots/code via Tesseract.js with preprocessing (threshold, grayscale, sharpen) |
| `browser_record_macro` | Start/stop/clear/export macro recordings as Playwright tests or JSON |
| `browser_replay_macro` | Replay recorded macros or action arrays with speed control and dry-run |
| `browser_parallel_execute` | Run actions on multiple named pages concurrently |

**Session storage note:** Pass `includeStorage: true` to `browser_save_session` to also capture `localStorage` and `sessionStorage`. Required for sites that store auth tokens in Web Storage instead of cookies (most modern SPAs). Storage is only restored if the current page origin matches the saved origin.

### Helpers

| Tool | Description |
|------|-------------|
| `browser_dismiss_popups` | Suppress modals, banners, and dialogs |
| `browser_export_state` | Export current page state (URL/title/AX/cookies/storage) as a JSON snapshot for sharing or replay |

## Installation

### Prerequisites
- Node.js 18.x or higher
- npm

### Setup
```bash
bash install.sh
```

## Cookie Injection (Firefox Sync)

Place a `cookies.json` file in the project root. The agent will automatically inject these cookies into every new session.

## Configuration

Register in your MCP client config:

```json
{
  "mcpServers": {
    "browser-agent": {
      "command": "node",
      "args": ["/absolute/path/to/browser-agent/src/server.js"],
      "env": {}
    }
  }
}
```

### Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `START_URL` | — | Page to open when the session starts. |
| `GOAL` | — | Task description exposed to MCP clients. |
| `CHROMIUM_EXECUTABLE_PATH` | Playwright bundled | Path to a dedicated Chromium binary. If set, Playwright uses this instead of its bundled Chromium. |
| `CHROMIUM_CHANNEL` | — | Playwright channel hint (e.g. `chromium`, `chrome`, `chrome-beta`). Ignored if `CHROMIUM_EXECUTABLE_PATH` is set. |
| `BROWSER_HEADLESS` | `false` | Set to `true` for headless operation (CI / production). |
| `BROWSER_LAUNCH_RETRIES` | `3` | Number of retries on browser launch failure. |
| `BROWSER_LAUNCH_BACKOFF` | `1000` | Base delay (ms) between launch retries; doubled each retry. |
| `ALLOW_PRIVATE_IPS` | `false` | Allow navigation to private/internal IPs (localhost, 192.168.x, etc.) — SSRF protection is enabled by default. |
| `ALLOW_ALL_SCHEMES` | `false` | Allow all URL schemes (`file://`, `data://`, `javascript://`, etc.) — only `http`/`https` allowed by default. |

### Browser Stability

The browser layer is hardened for long-running sessions:

- **Launch retry** with exponential backoff — if `chromium.launchPersistentContext` fails, the launcher retries up to `BROWSER_LAUNCH_RETRIES` times, doubling the wait between attempts.
- **Tab creation retry** — if `Target.createTarget` or related protocol errors occur when opening a new tab, the context is reset and the call is retried.
- **Context health probe** — the cached context is checked for liveness (with timeout) before reuse; dead contexts are torn down and relaunched transparently.
- **Stability flags** — Chromium is launched with flags that disable background timer throttling, renderer backgrounding, BackForwardCache, and other features that commonly cause crashes in automation.
- **`browser_health` tool** — returns `{ contextAlive, pageResponsive, pageCount, pageLatencyMs, activePageUrl, headless, executablePath, launchRetries }` for runtime diagnostics.

## Token-Efficient Interaction: Observe → Act

For repetitive or well-understood pages, skip the heavy `browser_get_state` screenshot and use the observe→click loop:

```
1. browser_observe()           # Returns elements with ref numbers, no screenshot
   → { elements: [{ ref: 1, tag: "BUTTON", text: "Sign In" }, ...] }

2. browser_click_ref(ref=1)    # Click by ref — no re-snapshot needed
   → "Clicked ref 1 (BUTTON "Sign In") at (320, 240)."
```

This matches the approach used by browser-use (93% context reduction) and Stagehand's `act` primitive.

For debugging after an interaction:
```
browser_console_messages(type='error')   # Any JS errors?
browser_network_requests(statusMin=400)  # Any failed API calls?
```

## Architecture: Sense-Think-Act

The agent is designed for closed-loop automation with a **hybrid screenshot strategy** — screenshots are used only when the AX tree is insufficient.

```
Unfamiliar page      → browser_get_state()               # AX tree + elements, no image
Planning an action   → browser_observe()                  # interactable elements + refs only
Visual verification  → browser_get_state(screenshot=true) # full state + screenshot
Act by ref           → browser_click_ref(ref)             # stable, no re-snapshot needed
After action         → browser_state_diff()               # diff only, no image
Debug failures       → browser_console_messages()         # JS errors
                       browser_network_requests()         # failed API calls
```

**When to request a screenshot:**
- Canvas-rendered UIs, game elements, charts
- `aria-hidden` elements that are visually significant
- Cross-origin iframes
- Visual layout verification (CAPTCHA, image-heavy pages)

All other cases → AX tree is sufficient and far cheaper in tokens.
