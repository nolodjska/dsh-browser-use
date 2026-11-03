# How DSH can be changed — a method, not a workaround

> **Scope.** Documents extending an installation you own, or an agent doing that work under your supervision. It is not a claim that you may modify software you have no right to modify.

This file answers one question: **what can a plugin change, what can only a patch
change, and how do you tell the difference before writing code?** It is written to
be reused by other agents working on this harness, not just for this repository.

Everything below was measured on the shipped build:

```
app.asar      182,434,783 bytes, Electron 44.7.0 / Chromium 152 / Node 24.21
profile       %USERPROFILE%\.dsh\profiles\desktop   (bundles + node_modules)
processes     main (window, preload, IPC)
              └ host child: `runtime.exe --expose-internals …/dsh-desktop-host/lib/index.js`
              └ renderer(s): load `dsh-app://app/`
              └ webview guests: one per Sidebar browser tab
```

## 1. The three privileges, and what each one buys

| You are a… | You run in | You can reach |
|---|---|---|
| **Host plugin** (cordis row) | host child process | every Host Service: `tools`, `skills`, `systemPrompt`, `webServer`, `typert`, `agents`, `sessions`, `storage`… |
| **Client plugin** (`dsh.client`) | renderer | `ctx.sidebarRight`, `ctx.slots`, `ctx.layout`, `ctx.theme`, `ctx.sessions`, … and the real DOM, including `<webview>` |
| **Patched app** (edit `app.asar`) | either | whatever you add: new IPC verbs, new Remote namespaces, new forwarded events |

The boundary is **not** "plugin vs core" in the abstract; it is that a host plugin
has **no API that calls into a renderer**, and a client plugin has **no API that
registers a model-facing tool**. Each half is powerful and each half is deaf to the
other's job.

Proof, in order of how you find it:

- `ctx.sidebarRight` exists only in the renderer (its face is documented in
  `@deepseek-ai/dsh-client-ui-sidebar-right`; `mounted`, `openTab`, `focus`, `openTabs`).
- The host child has **no `webContents`**: it is Electron in node mode. `require('electron')`
  yields no window APIs. There is nothing to call.
- `@deepseek-ai/dsh-api-remotes` is a one-directional BFF: *"Host Remote capabilities
  selected by this application"*. The client imports **generated** `/remote`
  artifacts and `ctx.remote.$mount()`s them. A third party cannot add a namespace to
  that assembly.
- The only host→client direction is **events**, and the allowlist
  (`API_REMOTE_FORWARDED_EVENTS` in `dsh-api-remotes/src/remote-events.ts`) is a
  code constant. Its README: forwarding one more event "requires one entry in that
  array".

So: **a plugin can extend behaviour inside its own half, but cannot grant itself a
new verb across the boundary.** That is the whole rule. Everything else follows.

## 2. What a plugin *can* do without touching the app

- **Own the UI side.** `ctx.sidebarRightTabs.register({ id, kind, patterns, priority,
  canOpen, title, guide, keepMounted })` plus a `slots.register({ name:
  'sidebar.right.pane.tab', key: id }, Body)` body. That is how the shipped
  document-preview type is built; a third party goes through the same public path.
- **Drive a browser guest from the renderer.** A `<webview>` you own exposes
  `executeJavaScript`, `loadURL`, `goBack/goForward/reload`, `getURL`, `getTitle`,
  `getWebContentsId`, `insertCSS`, `setZoomFactor`, `sendInputEvent`, `focus`, and
  `capturePage`. Measured: on a guest whose rect is **0×0** (mounted but not
  painted) `executeJavaScript` still returns live page state — only
  `capturePage()` needs the tab painted.
- **Register host services and tools**, render skills, read/write profile storage,
  spawn subprocesses, and serve loopback HTTP routes.

What a plugin **cannot** do: make the host call the renderer, or make the renderer
register a tool. Those are the two directions that need a patch.

## 3. The minimal patch that settles it (the "one new verb" pattern)

The clean fix is one IPC verb in the **main** process, because main is the only
place that can talk to both sides: it owns `webContents`, and the host child is its
own child process.

```
host plugin ──(ipcRenderer-like channel)──▶ main ──webContents.executeJavaScript──▶ renderer
```

Concretely, three edits inside `app.asar`:

1. **preload**: expose a function on the existing desktop bridge, e.g.
   `dshDesktop.renderer.eval(webContentsId, code)` → `ipcRenderer.invoke('dsh-desktop:renderer-eval', …)`.
2. **main**: add the `ipcMain.handle('dsh-desktop:renderer-eval', …)` that resolves
   the `webContents` and calls `executeJavaScript(code, true)`. Reuse the existing
   guest-lease checks: the shipped browser code already validates that a guest
   belongs to an approved window, and this verb deserves the same check.
3. **host**: give the host child a way to send it. Today the host child is not the
   renderer, so this is also an IPC channel — the same message type, a second
   handler. Alternatively expose it as a **Host Service** the host plugin injects,
   which keeps plugin code identical to today's `@Remote` usage.

Cost and risk, stated plainly:

- every DSH update overwrites `app.asar`; the patch must be scripted and re-applied
  (`asar` header: 4-byte pickle size, 4-byte header size, 4-byte JSON length, JSON,
  then data at `8 + headerSize`; the offsets in the JSON are relative to that base);
- the updater may reject a modified bundle (signature/integrity), so a fork must be
  built and shipped rather than patched in place;
- an arbitrary-code verb across processes is a real security boundary: it must be
  loopback-only, token-checked, and scoped to the requesting session, exactly like
  the existing guest leases.

Two smaller patches exist and are **worse**: widening
`API_REMOTE_FORWARDED_EVENTS` (host emit → client receives) cannot return a value,
so a request/response protocol on top of it is a state machine in shared storage;
and adding a server route only helps a *browser* client, not the Desktop renderer
(see §4).

## 4. The route idea, and why it is still unproven

The renderer knows the host URL: `window.__DSH_TRANSPORT__.streamBaseUrl` (for
example `http://127.0.0.1:53395`). If a plugin-owned `ctx.webServer` route were
reachable from `dsh-app://app`, host↔client would need no patch at all.

Measured: `fetch('http://127.0.0.1:53395/…')` from the renderer rejects with
`Failed to fetch`. That is **ambiguous** — network unreachable, CORS, or Private
Network Access all produce it. The distinguishing experiment is cheap and has not
been run yet:

1. register a route that answers `OPTIONS` and sets `Access-Control-Allow-Origin`
   (the exact renderer origin), `Access-Control-Allow-Private-Network: true`, and
   the matching allowed-headers;
2. have the client POST a probe;
3. look for the body **on the host** (file or log), not for a resolved promise.

If the body arrives, the plugin can own its transport and the debug port is no
longer needed. If it does not, the patch in §3 is the only route — and then this
section is the evidence for that claim.

## 5. Method, for the next agent

1. **Locate the boundary before designing.** Enumerate processes (`Get-CimInstance
   Win32_Process`), then for each side list what it can reach (`cordis_inspect_query`
   `Service`, client `Service`/`Slots`). The answer to "can I call X from Y" is in
   that table, not in the docs.
2. **Prefer the half that already has the capability.** Driving the DOM belongs to
   the renderer; registering a tool belongs to the host. Cross the boundary once,
   at the narrowest point, rather than duplicating capability on both sides.
3. **Add one verb, not a framework.** One IPC handler (or one route) that takes
   `(target, code)` and returns a JSON result is enough for any UI work.
4. **Verify with an artefact, not a promise.** Write the received payload to disk on
   the *other* side. A resolved `fetch`/`await` proves only that your code ran.
5. **Record the debt next to the code** (see `DEBT.md`): what is non-canonical, why,
   the canonical shape, and the trigger for paying it down. A future agent should
   not have to rediscover this file's contents.
