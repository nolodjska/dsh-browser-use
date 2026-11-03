# Browser runtime — overview

`agent.browsers` is installed in every `js` cell. Nothing to import.

## Entry points

```js
const browsers = await agent.browsers.list();   // descriptors: id, type, name, capabilities, metadata
const browser  = await agent.browsers.getDefault();
const byType   = await agent.browsers.get('cdp');        // id or type
const byUrl    = await agent.browsers.getForUrl(url);    // one backend, so same as default
const tab      = await agent.browsers.open(url);         // reuse-or-create + navigate
const current  = await agent.browsers.current();         // active tab, else a new one
```

## Browser

| Member | Meaning |
|---|---|
| `browser.id`, `browser.type` | descriptor identity (`cdp`) |
| `browser.tabs.list()` | all controlled tabs: `id, url, title, viewport, active?` |
| `browser.tabs.get(id)` | validate + activate that tab, return a `Tab` |
| `browser.tabs.new()` | a pending tab; the next `goto()` creates the real Sidebar tab |
| `browser.tabs.reuse(url)` | activate a same-origin controlled tab, or `undefined` |
| `browser.tabs.finalize({ keep })` | mark tabs `deliverable` / `handoff` (metadata only) |
| `browser.documentation()` | this document |
| `browser.nameSession(name)` | label the browsing session |
| `browser.capabilities.list()` | capability descriptors (e.g. `viewport`, `visibility`) |
| `browser.user.openTabs()` | empty: this transport controls only tabs it opened |

## Tab

| Member | Meaning |
|---|---|
| `tab.id`, `await tab.url()`, `await tab.title()` | identity and state |
| `await tab.goto(url)` | navigate (creates the tab when it is pending) |
| `tab.back()`, `tab.forward()`, `tab.reload()`, `tab.close()` | history and lifetime |
| `await tab.getState()` | `{ url, title }` |
| `await tab.snapshot()` | ARIA tree, same shape as `playwright.domSnapshot()` |
| `await tab.screenshot()` | PNG bytes (`Uint8Array`) |
| `tab.setViewportSize({width,height})`, `tab.viewportSize()` | responsive viewport |
| `await tab.evaluate(fnOrString)` | run in the page; may change it |
| `tab.click(refOrPoint, opts)`, `tab.type(text,{ref})`, `tab.press(key,{ref})`, `tab.hover`, `tab.scroll`, `tab.select(ref,values)`, `tab.check(ref,bool)`, `tab.drag(from,to)` | actions |
| `await tab.getDialog()`, `await tab.handleDialog(accept, promptText)` | JS dialogs |
| `tab.markDeliverable()`, `tab.markHandoff()`, `tab.finalize()` | delivery metadata |

## `tab.playwright`

`domSnapshot()`, `locator(selector)`, `getByRole/getByText/getByLabel/getByPlaceholder/getByTestId`,
`evaluate(fn|string)`, `waitForURL`, `waitForLoadState`, `waitForTimeout`.

A locator offers `click`, `dblclick`, `fill`, `type`, `press`, `selectOption`,
`check`, `uncheck`, `waitFor`, `count`, `textContent`, `innerText`, `getAttribute`,
`isVisible`, `isEnabled`, `allTextContents`, `evaluate`, and the chaining helpers
`locator`, `getBy*`, `first`, `last`, `nth`, `filter`.

## Errors

Failures throw `BrowserCommandError` with a `code`:

| Code | Meaning |
|---|---|
| `backend_unavailable` | no DevTools endpoint, no Sidebar tab, or a session-mismatch refusal |
| `locator_not_found` | nothing matched the selector — re-snapshot |
| `timeout` | the wait budget (3000ms for routine work) expired |
| `stale_generation` | the browser reconnected; call `agent.browsers.list()` again |
| `capability_unsupported` | the operation is not implemented, or the tab is not painted |
| `execution_error` | the command itself was malformed |

## Documentation lookup

```js
await agent.documentation.get('playwright');   // selector dialect and locator behaviour
await agent.documentation.get('screenshots');  // when and how to capture
await agent.documentation.get('safety');       // untrusted content, isolation
await agent.documentation.get('viewport');
```
