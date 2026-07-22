# Common Automation Patterns

## Search Flow
```
browser_navigate(url)
browser_get_state()                          // locate input: role="combobox" or INPUT
browser_click(input_selector)
browser_type(input_selector, query, delay=100)
browser_press("Enter")
browser_wait_for_selector(results_container) // or browser_wait_for_url(pattern)
browser_get_state()                          // verify result relevance
```

## Form Fill Flow
```
browser_get_state()                          // map all fields: name, id, placeholder
// Simple form (one type):
browser_fill_form(data={"#email": "me@example.com", "#password": "secret"})
// OR structured form (mixed input types) — auto-detects date/number/email/tel/url/select/checkbox/radio/file/contenteditable:
browser_fill_form(data={"#dob": "1990-01-15", "#qty": "3", "#email": "me@x.com"}, typeAware=true)
// For per-field control with stealth timing:
browser_scroll_to(field_selector)
browser_type(field_selector, value, delay=120)
// For dropdowns:
browser_select(selector, value)
// For checkboxes:
browser_check(selector) / browser_uncheck(selector)
// Submit:
browser_click(submit_selector)              // role="button" or text match
browser_dismiss_popups()                    // catch error/success toasts
```

## Session Export & Replay
```
// Snapshot current state (URL, AX, elements, cookies, storage) → exports/state-<ts>.json
browser_export_state()
// With full AX tree (larger):
browser_export_state(includeAxTree=true)
// To a specific path:
browser_export_state(outputPath="/tmp/run-42.json")
// List saved sessions:
browser_list_sessions()
```

## Diagnose Browser Issues
```
// If the page stops responding or you see repeated Target.createTarget errors:
browser_health()
// → { contextAlive, pageResponsive, pageCount, pageLatencyMs, activePageUrl, ... }
// If pageResponsive=false, the next tool call will reset the context automatically.
```

## Deep Content Extraction
```
browser_get_state()                          // identify semantic headings and blocks
browser_smart_scroll(steps=7)               // trigger lazy-loaded media/sections
browser_get_text(selector)                  // targeted text extraction
browser_get_html(selector)                  // preserve tables/lists structure
browser_print_to_pdf()                      // permanent high-fidelity record
```

## File Download Flow
```
// Headless browsers block OS save dialogs, so use browser_download_click
browser_observe()                            // Get the ref of the download/export button
browser_download_click(ref=42)               // Intercepts the download and saves locally
// The tool returns the absolute path to the saved file
```

## Blocked Element Recovery
```
// Step 1: dismiss any overlay
browser_dismiss_popups()
// Step 2: use coordinate-based ref click — pierces iframes and ignores CSS pointer-events blocks
browser_click_ref(ref=42)
// Step 3: JS override — when pointer events are suppressed
browser_evaluate("document.querySelector(selector).click()")
```
