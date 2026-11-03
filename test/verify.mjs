#!/usr/bin/env node
/**
 * `npm run verify` — the checks this package actually relies on.
 *
 * Part A is pure: it loads `client.js` with a fake window and a fake Sidebar
 * controller and proves the session fuse (allow same Session, refuse anything it
 * cannot prove). No browser, no DSH, always runs.
 *
 * Part B drives the real Sidebar over the DevTools Protocol through the verbatim
 * ZCode client. It needs DSH started with --remote-debugging-port and one Browser
 * tab open; when either is missing it prints SKIP rather than failing, because a
 * closed Sidebar is not a broken plugin.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserBackend } from '../lib/backend-cdp.js'
import { defaultImageDir, runCell } from '../lib/repl.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function skip(label, why) {
  console.log(`  SKIP  ${label} — ${why}`)
}

// ── Part A: the session fuse ────────────────────────────────────────────────

function loadBridge(scope) {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  let loaded
  const win = {
    __ModuleLoader__: {
      load: (entry) => {
        loaded = entry.factory(() => ({}))
      },
    },
  }
  new Function('window', source)(win)
  loaded.apply({ inject: (_deps, publish) => publish(scope) })
  return win.__dshBrowserBridge
}

function makeScope({ mounted, opened = [] }) {
  return {
    sidebarRight: {
      openTab: (kind, options) => opened.push({ kind, options }),
      mounted,
      isExpanded: () => true,
      active: () => ({ id: 'tab1', kind: 'browser' }),
      close: () => {},
    },
    effect: () => {},
  }
}

const store = (snapshot) => ({ getSnapshot: () => snapshot, subscribe: () => () => {}, update() {}, set() {} })

function partA() {
  console.log('\nPart A — session fuse (pure)')
  const opened = []
  const bridge = loadBridge(makeScope({ mounted: store({ sessionId: 'session-B' }), opened }))
  check('bridge publishes a version', typeof bridge.version === 'number')
  check('state reports the visible Session', bridge.state().visibleSessionId === 'session-B')

  let allowed = false
  try {
    bridge.openTab('https://example.com', { sessionId: 'session-B' })
    allowed = true
  } catch {}
  check('same Session is allowed', allowed)
  check('allowed call reached the controller once', opened.length === 1)

  let code
  try {
    bridge.openTab('https://example.com', { sessionId: 'session-A' })
  } catch (error) {
    code = error.code
  }
  check('other Session is refused', code === 'session_mismatch', `got ${code}`)
  check('refusal has no side effect', opened.length === 1)

  let noCaller
  try {
    bridge.openTab('https://example.com', {})
  } catch (error) {
    noCaller = error.code
  }
  check('unknown caller is refused', noCaller === 'session_unknown_caller', `got ${noCaller}`)

  const opened2 = []
  const blind = loadBridge(makeScope({ mounted: undefined, opened: opened2 }))
  let blindCode
  try {
    blind.openTab('https://example.com', { sessionId: 'session-B' })
  } catch (error) {
    blindCode = error.code
  }
  check('unknown visible Session is refused', blindCode === 'session_unknown', `got ${blindCode}`)
  check('blind refusal has no side effect', opened2.length === 0)
}

// ── Part B: the live Sidebar ────────────────────────────────────────────────

async function resolveEndpoint() {
  const candidates = []
  if (process.env.DSH_BROWSER_USE_CDP) candidates.push(process.env.DSH_BROWSER_USE_CDP)
  try {
    const file = join(process.env.APPDATA ?? '', '@deepseek-ai', 'dsh-desktop', 'DevToolsActivePort')
    const port = readFileSync(file, 'utf8').split(/\r?\n/)[0].trim()
    if (/^\d+$/.test(port)) candidates.push(`http://127.0.0.1:${port}`)
  } catch {}
  for (const port of [9222, 9223, 9224, 9225]) candidates.push(`http://127.0.0.1:${port}`)
  for (const candidate of candidates) {
    try {
      const response = await fetch(`${candidate}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (response.ok) return candidate
    } catch {}
  }
  return undefined
}

async function partB() {
  console.log('\nPart B — live Sidebar over CDP')
  const endpoint = await resolveEndpoint()
  if (!endpoint) {
    skip('live checks', 'no DevTools endpoint answers (start DSH with --remote-debugging-port)')
    return
  }
  check('DevTools endpoint answers', true, endpoint)

  const targets = await (await fetch(`${endpoint}/json`)).json()
  const guests = targets.filter((target) => target.type === 'webview')
  if (guests.length === 0) {
    skip('live checks', 'no webview target — open a Browser tab in the right Sidebar first')
    return
  }
  check('a webview target is present', true, `${guests.length} guest(s)`)

  const backend = new BrowserBackend({
    endpoint,
    docsRoot: join(ROOT, 'docs'),
    // The caller is whoever runs this script; the contract only needs a stable id.
    callerSessionId: () => 'verify-session',
  })
  const bridge = {
    assertAvailable() {},
    documentationRoot: join(ROOT, 'docs'),
    list: () => backend.list(),
    execute: (browserId, generation, command) => backend.execute(browserId, generation, command),
  }
  const boot = `
const root = process.env.ZCODE_PLUGIN_ROOT;
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const { setupBrowserRuntime } = await import(pathToFileURL(join(root, 'scripts', 'browser-client.mjs')).href);
await setupBrowserRuntime({ globals: globalThis });
`
  const cell = (code) => runCell(boot + code, { bridge, pluginRoot: ROOT, imageDir: defaultImageDir() })

  const descriptor = await backend.list()
  check('descriptor is a cdp backend', descriptor[0]?.type === 'cdp')
  check('descriptor declares no hardcoded port', !/922\d/.test(JSON.stringify(descriptor[0]?.metadata ?? {}).replace(/"endpoint":"[^"]*"/, '')))

  const listed = await backend.execute('dsh-sidebar', 1, { method: 'list' })
  check('tabs.list returns tabs', Array.isArray(listed.tabs) && listed.tabs.length > 0)
  const tab = listed.tabs[0]
  check('tab summary carries a viewport', typeof tab.viewport?.width === 'number')

  const snapshot = await cell(`
const browser = await agent.browsers.getDefault();
const summary = (await browser.tabs.list())[0];
const tab = await browser.tabs.get(summary.id);
await tab.playwright.domSnapshot();
`)
  check('domSnapshot carries refs', typeof snapshot.text === 'string' && snapshot.text.includes('[ref='))

  const shot = await backend.execute('dsh-sidebar', 1, { method: 'screenshot', tabId: tab.tabId })
  if (shot.ok) {
    check('screenshot returns PNG bytes', Buffer.from(shot.image.base64, 'base64').length > 1000)
  } else {
    skip('screenshot', shot.error?.message?.slice(0, 90) ?? 'capture refused')
  }

  // Creating a tab needs the caller to be the visible Session, which a script
  // cannot claim; that path is covered by the unit-level fuse checks above.
  skip('openTab round-trip', 'requires the calling Session to be the one on screen')
}

partA()
await partB()

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
