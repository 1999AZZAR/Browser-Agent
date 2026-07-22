# Perception Tools

Read page content as structured data instead of raw DOM text.

## browser_get_page_markdown

Extract page content as Markdown with headings, lists, tables, and links.

### Usage
```
browser_get_page_markdown()                    // full page (main/article/content/body)
browser_get_page_markdown(selector="article")  // scoped to element
browser_get_page_markdown(selector="#results", maxLength=2000)
```

### Output Format
```markdown
# Page Title
## Section 1
- List item 1
- List item 2
[Link text](https://example.com)
![Alt text](image-url)

| Header 1 | Header 2 |
| --- | --- |
| Cell 1 | Cell 2 |
```

### When to Use
- Reading article content for comprehension
- Extracting product information
- Understanding page structure
-替代 `browser_get_text()` when you need structure

### When NOT to Use
- Just need a single element's text → use `browser_get_text(selector)`
- Need exact HTML → use `browser_get_html(selector)`
- Need to interact with elements → use `browser_observe()`

## browser_get_accessibility_tree

Get the page's accessibility tree as structured text showing roles, names, and states.

### Usage
```
browser_get_accessibility_tree()                    // full page
browser_get_accessibility_tree(selector="#form")    // scoped
browser_get_accessibility_tree(maxLength=3000)
```

### Output Format
```
body
  nav role=navigation
    a "Home" href=/home
    a "About" href=/about
  main role=main
    h1 "Welcome"
    form role=form
      input type=text "Email" [required]
      input type=password [hidden]
      button "Submit" [disabled=false]
```

### When to Use
- Understanding what interactive elements exist
- Debugging ARIA issues
- Planning next actions (what can I click?)
- Verifying form structure

### ARIA States Reported
- `hidden` — aria-hidden="true"
- `disabled` — aria-disabled="true"
- `expanded` — aria-expanded value
- `checked` — aria-checked value
- `selected` — aria-selected value
- `current` — aria-current value
- `type` — input type attribute
- `href` — link destination (truncated)

## browser_observe & browser_get_state

Extract coordinate-based semantic references (`ref`) and Visual DOM state (Set-of-Mark).

### Usage
```javascript
// 1. Get raw Semantic Elements array (ideal for discovering click targets)
browser_observe()

// 2. Get full page state (headings, text, forms) + SoM Screenshot
browser_get_state(mark_elements=true, screenshot=true)
```

### When to Use
- You need a visual representation of the page with numbered bounding boxes (SoM).
- You are trying to click an element inside a cross-origin iframe (e.g. Stripe checkout, CAPTCHA).
- Standard CSS selectors are failing due to complex SPAs or shadow DOMs.

### Why use `ref` instead of selectors?
When you use `browser_click_ref(ref)`, the agent calculates absolute page coordinates and issues a raw mouse click. This natively bypasses iframe restrictions, pointer-events blocks, and obfuscated CSS classes.
