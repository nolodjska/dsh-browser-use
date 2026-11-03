# Architecture — how one tool call reaches a Sidebar tab

Two halves, one protocol, one transport.

```
model
  │  tool call  mcp__node_repl__js { code }
  ▼
HOST plugin  (lib/index.js)            electron node-mode child
  ├─ resolveDshTools()  → defineTool from the app.asar installation
  ├─ skills provider    → control-browser, web-gui-tester
  └─ tool.execute(code)
       ▼
     lib/repl.js  — fresh kernel per call
       ├─ installs globalThis.agent / nodeRepl / the bridge symbol
       ├─ installs lib/facade.js (this plugin's agent.browsers)
       └─ returns the last expression's value
       ▼
     lib/backend-cdp.js — the BrowserCommand dispatcher
       ├─ lib/cdp.js        CDP transport, target discovery, endpoint probing
       └─ lib/selectors.js  Playwright selector dialect + ARIA snapshot w/ refs
       ▼
     raw CDP over 127.0.0.1:<devtools port>
       ├─ target `type:"webview"`  → the Sidebar browser guest (DOM, input, capture)
       └─ target `dsh-app://app/`  → the renderer, used only to call the bridge
```

```
RENDERER  (client.js)                 the DSH window
  ├─ ctx.sidebarRight.openTab('browser', { params: { url } })   ← opens/expands the pane
  ├─ window.__dshBrowserBridge = { version, openTab, state, probe, spike, expand, close }
  ├─ session fuse: caller Session must equal sidebarRight.mounted
  └─ optional M2 spike (opt-in via localStorage['dsh-browser-use:spike']='1')
```

## Why the transport is what it is

- The **client half must exist** because `ctx.sidebarRight` and the `<webview>` element
  live only in the renderer.
- The **host half must exist** because a model-facing tool can only be registered
  from the host.
- Therefore something has to cross the boundary. This build offers no host→client
  call (see `notes/SELF-MODIFICATION.md` §1), so the transport is the Chromium
  DevTools protocol, which needs `--remote-debugging-port`.

`lib/cdp.js` never trusts a fixed port: it tries the configured endpoint, then the
app's own `DevToolsActivePort`, then 9222–9225, and only reports failure after all
of them stay silent. That matters because a dying instance can hold a port in
`LISTENING` while answering nothing.

## Request lifecycle, concretely

1. `mcp__node_repl__js` runs the cell in a fresh kernel (`lib/repl.js`).
2. The cell imports the vendored client and calls `setupBrowserRuntime`.
3. Every browser operation becomes a `BrowserCommand` object; the client sends it to
   the bridge's `execute()`.
4. `lib/backend-cdp.js` maps that command onto CDP calls for one target.
5. Results come back in the exact shape the client expects (`{ ok, value | tabs |
   tab | state | snapshot | image | dialog }` or `{ ok: false, error: { code, message } }`),
   so `agent.browsers` behaves as it does inside ZCode.

## Failure behaviour

The plugin prefers an actionable refusal over a plausible lie:

| Situation | Answer |
|---|---|
| no DevTools endpoint answers | `backend_unavailable`, naming the endpoint and the launch flag |
| caller Session ≠ visible Session | `session_mismatch`, **no tab created** |
| either Session id unknown | `session_unknown` / `session_unknown_caller`, no tab created |
| tab not painted | `capability_unsupported` (capture), with the reason |
| recording, upload, download, iframe-internal locator | `capability_unsupported`, with the reason |
