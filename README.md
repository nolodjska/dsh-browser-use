# dsh-browser-use

Browser automation for DeepSeek Harness that drives **this window's own right-Sidebar
Browser tab** — not an external Chrome, and not a second product to install.

## What the model gets

| Surface | Value |
|---|---|
| Tool | `mcp__node_repl__js` — one JavaScript cell, fresh kernel per call |
| Kernel bindings | `agent.browsers`, `agent.documentation`, `nodeRepl.write/emitImage` |
| Skills | `control-browser`, `web-gui-tester` |
| Object model | `agent.browsers` (tabs, locators, ARIA snapshot with refs, viewport, dialogs) |

The object model in `lib/facade.js` is this project's own code, written against the
command layer in `lib/backend-cdp.js`. It follows the `agent.browsers` interface this
ecosystem's tooling expects (tab registry, Playwright-shaped locators, an ARIA
snapshot with `[ref=eN]` markers) because that interface is what guidance is written
against — not because any of it is copied.

## Install

```powershell
# from DSH, via the plugin manager tool:
#   action: install_bundle, target: <absolute path to this directory>
```

Then start DSH with the DevTools endpoint enabled (see below) and open a Browser
tab in the right Sidebar.

## The one requirement: `--remote-debugging-port`

The host half runs in an Electron *node-mode child* with no `webContents`, so it
cannot touch the renderer that owns `ctx.sidebarRight`. DSH exposes no
Host→Client invocation channel (documented in `DEBT.md`, D0b), so the DevTools
protocol is the carrier this package uses to reach the renderer and the guest.

`launch-dsh-debug.vbs` restart DSH with the endpoint; a shortcut to
`wscript.exe "<repo>\launch-dsh-debug.vbs"` gives a normal double-click icon with
no console window. If a dying instance still holds the port (TCP connects, nothing
answers), `launch-dsh-debug-9223.vbs` uses 9223 and the plugin discovers it on its
own — no configuration needed.

Set `DSH_BROWSER_USE_CDP` or the row's `config.endpoint` only if you want to pin
an endpoint; otherwise discovery reads the app's `DevToolsActivePort` and probes
9222–9225.

## Session isolation

`ctx.sidebarRight` acts on the Session **on screen**, so opening a tab blindly
would drop the agent's browser into whichever Session the user happens to be
looking at. The bridge is therefore fail-closed:

- caller Session == visible Session → the tab opens;
- different, or either side unknown → `session_mismatch` / `session_unknown` /
  `session_unknown_caller`, **with no tab created**.

A background Session gets a refusal that names both Sessions. Real per-Session
browsing needs an upstream per-Session navigation face (see `DEBT.md`, D2).

## Verify

```powershell
node test/verify.mjs      # or: npm run verify
```

Part A proves the session fuse with a fake Sidebar controller (no browser needed).
Part B drives the real Sidebar over CDP: endpoint discovery, `tabs.list`,
`domSnapshot` refs, screenshot. Missing endpoint or no open Browser tab prints
SKIP, not FAIL.

## Layout

```
lib/index.js       cordis plugin: skills provider + the js tool
lib/repl.js        fresh-kernel cell runner (last expression becomes the result)
lib/backend-cdp.js BrowserCommand dispatcher over raw CDP
lib/cdp.js         CDP transport, target discovery, endpoint probing
lib/selectors.js   Playwright selector dialect + ARIA snapshot with refs (in-page)
client.js          renderer half: the Sidebar bridge, session fuse, M2 spike
lib/facade.js      the agent.browsers object model (ours)
skills/ docs/      this plugin's guidance and API documentation
test/verify.mjs    the checks above
launchers/         windowless restart scripts that enable the DevTools endpoint
notes/             ARCHITECTURE.md, SELF-MODIFICATION.md — how this works and how
                   the harness itself can be extended
DEBT.md            every deviation, with evidence and the canonical shape
NOTICE.md          provenance: what this is built on, and what is not here
```

## Read next

- `notes/ARCHITECTURE.md` — one tool call, traced to a Sidebar tab, plus the
  failure table this runtime answers with.
- `notes/SELF-MODIFICATION.md` — what a plugin can change, what only a patch can,
  the one-IPC-verb pattern that removes the DevTools requirement, and the method
  for deciding that before writing code. Written for other agents.
- `DEBT.md` — the honest list, including the two findings that stop a no-patch
  release today.

## Scope of the notes in this repository

`notes/` documents how this harness and its plugins fit together, including how to
extend a packaged installation (`notes/ASAR-CHEATSHEET.md`) and how to add a
Host→Client verb to the host application (`notes/SELF-MODIFICATION.md`).

- They describe extending **your own installation, on your own machine**. Whether
  you may patch a particular binary is a licensing question about that software;
  these notes record a method, they do not grant permission.
- `launchers/*.vbs` restart DSH with `--remote-debugging-port`. That endpoint is
  **unauthenticated by design** — it is Chromium's debug protocol, so anything
  running as your user can drive the app while it is up. Use it on a machine you
  control, and prefer the ordinary launcher when you are not using this tool.

## Known limits

`DEBT.md` is the authoritative list. Summary: screenshots need the tab painted;
WebM recording, file upload/download relay and iframe-internal locators are not
implemented; the locator dialect is a subset of Playwright's.
