# Screenshots

Only for visual evidence: layout, styling, rendering, or when the user asked to
see the page. Do not snapshot and screenshot together by default — the snapshot is
cheaper and answers most questions.

```js
const bytes = await tab.screenshot();
nodeRepl.emitImage(bytes);       // emit in the same cell; the tool saves a PNG
```

The result is PNG bytes (`Uint8Array`). The tool writes them to disk and reports the
path, which the `read_image` tool can open.

## The tab must be painted

Electron does not composite a `webview` guest that is not currently painted. Two
things make a tab unpaintable:

- the right Sidebar is collapsed, or
- another tab in that pane is the visible one.

In both cases `screenshot()` answers `capability_unsupported` with that explanation
instead of hanging. Expand the Sidebar (`agent.browsers` opens it when it creates a
tab) and bring the tab forward, then retry.

Everything else — navigation, `executeJavaScript`, reading state, input — keeps
working on an unpainted tab. Only pixels require paint.
