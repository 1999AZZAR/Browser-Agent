# Selector Strategy

## Priority Order
1. `#id` — fastest, most stable
2. `[data-testid="..."]` — standard in React/Vue apps
3. `[role="button"]`, `button:has-text("Login")` — semantic, survives refactors
4. `ref` (via `browser_click_ref`) — highly reliable coordinate click, natively pierces cross-origin iframes
5. `.class-name` — last resort; styling-coupled, fragile

## AX Tree Usage
`browser_get_state()` returns `axTree`. Use it to:
- Identify `role` + `name` for semantic targeting
- Find `focusable: true` elements as primary interaction targets
- Map parent-child relationships obscured by CSS structure

Prefer AX tree targeting over raw HTML selectors — it mirrors how assistive tech and CDP interact with the page.

## Dynamic Content Handling

**Element not yet in DOM:**
```
browser_wait_for_selector(selector, timeout=5000)
```

**Action triggers a page load:**
```
browser_click(selector)
browser_wait_for_selector(new_content_selector)
browser_get_state()   // re-sense after DOM change
```

**Cross-Origin Iframes (CAPTCHA, Stripe):**
```
// Do NOT try to use standard selectors on cross-origin iframes!
// browser_observe / browser_get_state automatically extract elements inside iframes
// and map their absolute screen coordinates. Just use click_ref:
browser_click_ref(ref=42)
```

## Pre-Interaction Checklist
- Element visible in viewport? → `browser_scroll_to(selector)` if not
- Element enabled? → check `axTree` state property
- Post-interaction change expected? → wait for it before continuing
