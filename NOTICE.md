# Provenance

**This repository contains no third-party source code.** Everything except the
node built-ins is written for this plugin, under MIT (see `LICENSE`).

## What it is built on

- **DeepSeek Harness** — the host: `defineTool`, the skills registry, the system
  prompt, and the Web GUI. Consumed through its published plugin interfaces
  (`dsh.bundle.patch`, `dsh.client`, `@deepseek-ai/dsh-tools`); no DSH source is
  copied here.
- **Chrome DevTools Protocol** — the transport, spoken over a loopback WebSocket with
  the built-in `WebSocket` and `fetch`. No client library is vendored.
- **ZCode's `browser-use` plugin** — the *interface* this object model follows:
  `agent.browsers`, the tab registry, the `BrowserCommand` vocabulary, the ARIA
  snapshot with `[ref=eN]` markers. Interfaces and semantics are facts about how
  the ecosystem's tooling behaves, not copied expression; the implementation in
  `lib/facade.js`, `lib/backend-cdp.js`, `lib/cdp.js` and `lib/selectors.js` is
  this project's own, written against the protocol rather than derived from that
  package's source.

Earlier revisions of this repository did vendor ZCode's client, skills and docs.
They were removed once the runtime became self-contained: the plugin now needs
nothing but DSH, an Electron build with a DevTools endpoint, and the network.

## Attribution

If you believe anything here is too close to your work, open an issue and it will
be changed or credited — silently shipping a copy is not the intent.
