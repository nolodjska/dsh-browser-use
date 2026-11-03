# Selectors and locators

Locators are built from `domSnapshot()` facts. The selector dialect is a
Playwright-compatible subset, resolved by an in-page engine — not by Playwright
itself, because the guest is driven over the DevTools Protocol.

## What is supported

| Form | Example |
|---|---|
| ref from a snapshot | `tab.click('e12')` — becomes `aria-ref=e12` |
| role + accessible name | `internal:role=button[name="Save"i]` |
| text | `internal:text="Sign in"i` |
| label | `internal:label="Email"i` |
| placeholder | `internal:attr=[placeholder="Search"i]` |
| test id | `internal:testid=[data-testid="row"s]` |
| plain CSS | `#total`, `form > .row`, `[data-x="1"]` |
| chaining | `internal:role=listitem >> internal:text="Deck"i` |
| position | `>> nth=0`, `>> nth=-1`, `>> first`, `>> last` |
| visibility filter | `>> visible=true` |
| text filter | `>> internal:has-text="Open"i`, `>> internal:has-not-text="Closed"i` |

`name`/`text` accept `"…"i` (case-insensitive), `"…"s` (exact), or `/regex/flags`
(regex is matched as a substring pattern).

## Built from the snapshot, not from guesswork

```js
const snap = await tab.playwright.domSnapshot();
// - button "Save changes" [ref=e14] [cursor=pointer]
await tab.click('e14');
```

A snapshot-proven heading or text node can be clicked even without a `link` or
`button` role: the DOM event may bubble to a handler. Do not invent a role the
snapshot did not show.

## Counting before acting

```js
const row = tab.playwright.getByRole('row');
await row.count();          // 0 → re-snapshot; >1 → narrow with filter()/nth()
await row.filter({ hasText: 'Paid' }).first().click();
```

## Explicit values

All locator reads are time-boxed (3000ms by default) and throw
`BrowserCommandError`. `locator_not_found` and `timeout` mean the locator is stale,
not that the page is broken.

## What is not supported

- Locators **inside** an iframe: the snapshot renders iframe content, but a locator
  cannot cross the frame boundary. Read iframe content with `tab.evaluate()` and
  locate outside the frame, or use the site's own API.
- `internal:and` / `internal:or`, and Playwright's `frameLocator`.
- Downloads and file choosers.
