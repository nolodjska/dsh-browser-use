# Known deviations and debt — `dsh-browser-use`

Each entry names what is non-canonical today, why it was chosen, what the
canonical shape is, and when it should be paid down. Nothing here is hidden from
the model: every unsupported operation answers `capability_unsupported` with the
reason instead of faking success.

## M2 spike result (2026-11-03) — the element API is sufficient

Measured in the live renderer against a real Sidebar guest:

| Capability | Result |
|---|---|
| `executeJavaScript`, `loadURL`, `goBack`, `goForward`, `reload`, `stop` | present and working |
| `getURL`, `getTitle`, `getWebContentsId` | present and working |
| `insertCSS`, `setZoomFactor`, `focus`, `addEventListener` | present |
| `sendInputEvent` | present (rest-arg signature) |
| `capturePage()` on a **painted** tab | works |
| `capturePage()` on a **0×0 / unpainted** guest | never settles (page timeout at 6s) |

Critically, on a guest with `getBoundingClientRect()` of 0×0 (the tab is mounted
but not painted, e.g. another tab or Session is on screen) `executeJavaScript`
still returned real page state (`{"title":"Example Domain","ready":"complete","bodyLen":917}`)
and `getURL`/`setZoomFactor` still worked. **Only pixel capture needs paint.**

Consequences:

- A shipped plugin does **not** need `--remote-debugging-port` to drive the DOM,
  navigate, click, type or read state. That is the whole M2 answer.
- Screenshots need the tab painted. Own the tab type and this is ours to control:
  activate the tab, then capture.
- `Network.*` and `Accessibility.getFullAXTree` have no element-API equivalent,
  but this runtime never exposed network inspection and generates its own ARIA
  tree in `lib/selectors.js`, so nothing regresses.

## D0 — Desktop renderer talks to the host over IPC, not HTTP

**Observed.** The Desktop renderer loads from `dsh-app://app/`, and its API calls
go through the Electron IPC transport (`window.__DSH_TRANSPORT__`), not plain
`fetch` to the loopback web server. A host-registered `ctx.webServer` route is
therefore **not reachable** from the renderer in Desktop, so the "client polls a
host HTTP route" design is not available on the platform this plugin targets.

**Consequence.** Replacing D1's CDP eval needs a Host→Client channel. It does not
exist: see D0b.

## D0b — DSH has no Host→Client invocation channel (decisive)

**Evidence.**

- `dsh-api-remotes` describes itself as a "two-sided BFF for **Host** Remote
  capabilities **selected by this application**". Its client entry *imports
  generated `/remote` artifacts* and mounts them with `ctx.remote.$mount()`. Both
  the artifact and its inclusion in the assembly are properties of packaged code:
  a third-party namespace cannot add itself.
- The only reverse direction is host **events**: the gateway forwards a fixed
  allowlist (`API_REMOTE_FORWARDED_EVENTS` in `dsh-api-remotes/src/remote-events.ts`),
  and that package's own README says forwarding one more event "requires one entry
  in that array" — a code change inside the shipped app.
- `dsh-typert-registry` does let any owner call `ctx.typert.register(contribution)`,
  so a host endpoint can be *registered*. But without a client that mounts and
  invokes it, registration buys nothing.

**Consequence — this is the honest product answer.** A third-party plugin cannot
ask the renderer to do something from a host tool. The debug port is therefore the
only available Host→Client carrier today, and it is why the working implementation
needs `--remote-debugging-port`.

The M2 result still stands on its own terms — the `<webview>` element API can
drive a guest (even a 0×0 unpainted one) without CDP — but that only helps once
*the renderer decides by itself* to do the work. Until DSH exposes a Host→Client
call (or widens the forwarded-event allowlist), shipping without a debug port
requires the model-facing surface to stop being a host tool, which is an upstream
decision, not a plugin change.

## D1 — Host↔Client uses a window global driven over CDP

**Today.** The client half publishes `window.__dshBrowserBridge`; the host half
calls it with `Runtime.evaluate` on the app renderer target.

**Why.** `ctx.sidebarRight` and the cordis context exist only inside the renderer, and the host
runs in an Electron *node-mode child* with no `webContents`. The canonical
reverse channel (`@Remote` host service consumed through `ctx.remote`, or typert
Remote events) needs generated schema bindings this package cannot author yet.

**Cost.** The bridge only exists while `--remote-debugging-port` is live. A stale
listener holding the port (observed 2026-11-03: TCP accepted, nothing answered)
silently strands the whole bridge.

**Canonical.** A host service with `@Remote` methods plus a typert schema, so the
client calls the host through cordis RPC and no debug port is required.

**Pay down when.** Either DSH exposes a per-session navigation face, or this
package grows its own typert bindings.

## D2 — Per-session ownership is a fuse, not real routing

**Today.** `openTab` compares the caller's Session with `sidebarRight.mounted`
and refuses on a mismatch (`session_mismatch`), or when either side is unknown
(`session_unknown`, `session_unknown_caller`).

**Why.** The exported face is a *view* controller: every command acts on the
Session on screen, and `openTab` takes no session argument. Opening blind is how
a tab once landed in an unrelated Session.

**Consequence.** A background Session cannot browse through the Sidebar; it gets
a refusal that names both Sessions.

**Canonical.** Either the face grows a per-session target, or each Session gets
its own guest that is attached to the Sidebar only while that Session is on
screen.

## D3 — Screenshots require the visible tab

**Today.** `Page.captureScreenshot` on a `webview` guest that is not the one the
Sidebar paints never produces a frame; the runtime calls `Page.bringToFront`,
retries once, then answers `capability_unsupported` with that explanation.

**Why.** Electron does not composite hidden guests. `keepMounted` keeps the guest
alive across tab switches, so this is reachable in normal use.

**Canonical.** Ask the Sidebar to focus the corresponding tab (`sidebarRight.focus`)
before capturing — requires the guest↔sidebar-tab mapping (`openTabs` metadata).

## D4 — Locator dialect is a subset

**Today.** `lib/selectors.js` implements `aria-ref=`, `internal:role/text/label/attr/testid`,
`has-text`/`has-not-text`, `>>` chains, `nth=`, `visible=`, and plain CSS, with an
implicit-role table.

**Not implemented.** Playwright regex selectors beyond a substring fallback,
`internal:and` / `internal:or`, frame-piercing (`frameLocator`), and anything that
needs Playwright's own injected engine.

**Consequence.** A locator inside an iframe cannot be resolved, although
`domSnapshot` does render iframe bodies (Playwright's `mode: "ai"` is what we
borrowed the snapshot shape from; this port generates the tree itself).

## D5 — Not implemented at all

- WebM recording (`recordingStart/Status/Cancel`) — in ZCode this is the Electron
  renderer's `MediaRecorder`; a CDP screencast port is its own project.
- File upload and download relay (`waitForEvent`, `fileChooserSetFiles`,
  `downloadPath`, `downloadMedia`) — the Sidebar denies native pickers, and this
  runtime tracks no downloads.
- `browser.user.history` — no per-Session URL history is exposed.

## D6 — No `Config` schema

**Today.** The endpoint resolves from `DSH_BROWSER_USE_CDP`, else the row's
`config.endpoint`, else discovery (DevToolsActivePort + port probe).

**Why.** The canonical `export const Config = z.object({…})` needs
`@deepseek-ai/schemastery`, which does not resolve from this package: it installs
as a `link:` dependency, so Node resolves its real path outside the profile tree.
Verified 2026-11-03: `require.resolve('@deepseek-ai/schemastery')` fails from
`D:\deepseek\plugins\dsh-browser-use` and succeeds only from the profile's link
path. A static import would break plugin load entirely.

**Pay down when.** The package is published (then normal dependency resolution
applies) or the host injects its own schemastery instance.

## D7 — Open question: tool schemas in an already-running Session

**Observed 2026-11-03.** After installing the bundle, `cordis_inspect_query`
`Tool.listTools` reports `mcp__node_repl__js` as visible to this agent, and a
*fresh* Session (a subagent) could call it immediately — but the Session that was
already running never received the schema in its request.

**Not established.** Whether the harness snapshots tool schemas per Session or
this is a defect. `dsh-tools` documents a `tool-addition` record, which suggests
mid-session addition is meant to work.

**Do not** treat "reopen your Session" as the documented answer until this is
settled.
