# Provenance and licensing

## This repository's own code

MIT. See `LICENSE`.

Covers: `lib/*.js`, `client.js`, `test/verify.mjs`, `notes/*`, `launchers/*`, and the
package metadata.

## Vendored from ZCode (Z.ai), MIT

The following files are copied **verbatim** from the official ZCode `browser-use`
plugin, version 0.5.1, as published in ZCode's plugin cache
(`…/.zcode/cli/plugins/cache/zcode-plugins-official/browser-use/0.5.1`):

| Path | Origin | Purpose |
|---|---|---|
| `scripts/browser-client.mjs` | `scripts/browser-client.mjs` | the client half: builds `agent.browsers` on top of a supplied bridge |
| `skills/control-browser/SKILL.md` | `skills/control-browser/SKILL.md` | model guidance |
| `skills/web-gui-tester/SKILL.md` | `skills/web-gui-tester/SKILL.md` | model guidance |
| `docs/*.md`, `docs/api.json`, `docs/documents.json` | `docs/` | the API manifest and worked examples the client reads at runtime |

They are unmodified on purpose: `browser-client.mjs` is the authoritative
implementation of the `agent.browsers` object model, and `docs/api.json` is the
manifest that decides which members exist per backend type. Re-implementing either
would trade exact fidelity for nothing.

ZCode's plugin declares `"license": "MIT"`. No ZCode runtime is redistributed here —
the `node_repl` host and the browser transport are this repository's own code, and
the bridge object they supply is the contract those files expect.

If you are the rights holder and want a different arrangement, open an issue and the
vendored files will be replaced by a download step at install time.
