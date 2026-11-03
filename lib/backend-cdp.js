/**
 * dsh-browser-use — the CDP execution layer.
 *
 * Replaces the Playwright transport for the Sidebar guest. Playwright cannot see
 * Electron `webview` targets (it only exposes `page` targets from
 * connectOverCDP), while the DevTools Protocol can drive them directly, so this
 * layer speaks CDP for both targets it needs:
 *
 *   app target   (`dsh-app://app/`) — calls `window.__dshBrowserBridge.openTab`
 *   guest target (`type: "webview"`) — navigation, DOM, input, screenshots
 *
 * The facade above this layer knows nothing about CDP: it still builds
 * `agent.browsers` and still sends the same BrowserCommand objects.
 */
import {
  CdpConnection,
  findAppTarget,
  listTargets,
  waitForGuestTarget,
} from './cdp.js'
import { INSTALL_SOURCE, SNAPSHOT_SOURCE, buildResolveSource, refToSelector } from './selectors.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROUTINE_TIMEOUT = 3000
const NAV_TIMEOUT = 15000
const MIME_PNG = 'image/png'
const DESCRIPTOR_ID = 'dsh-sidebar'

const ok = (payload = {}) => ({ ok: true, ...payload })
const fail = (code, message) => ({ ok: false, error: { code, message } })

class BackendError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BackendError'
    this.code = code
  }
}

/** Named keys the ZCode surface uses, mapped to CDP key/code/text tuples. */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
}

const MODIFIERS = { Alt: 1, Control: 2, Meta: 4, Shift: 8, ControlOrMeta: 2 }

function modifierMask(list) {
  let mask = 0
  for (const key of Array.isArray(list) ? list : []) mask |= MODIFIERS[key] ?? 0
  return mask
}

export class BrowserBackend {
  constructor({ endpoint, docsRoot, callerSessionId } = {}) {
    this.endpoint = endpoint
    this.activeEndpoint = undefined
    this.endpointCheckedAt = 0
    this.docsRoot = docsRoot
    this.callerSessionId = callerSessionId
    this.generation = 1
    this.app = undefined
    this.guests = new Map()
    this.tabs = new Map()
    this.byTarget = new Map()
    this.pending = new Map()
    this.dialogs = new Map()
    this.seq = 0
    this.activeTabId = undefined
    this.sessionName = undefined
  }

  // ── transport ────────────────────────────────────────────────────────────

  async list() {
    await this.ensureApp()
    return [
      {
        id: DESCRIPTOR_ID,
        generation: this.generation,
        type: 'cdp',
        name: 'DSH right-Sidebar browser',
        capabilities: {
          browser: [
            {
              id: 'visibility',
              description:
                'Sidebar pane visibility. The pane belongs to the DSH window, so get reports true and set is a no-op.',
            },
          ],
          tab: [
            {
              id: 'viewport',
              description: 'Emulation.setDeviceMetricsOverride; width 320..3840, height 320..2160.',
            },
          ],
        },
        apiSupportOverrides: {
          'BrowserUser.claimTab': true,
          'Tabs.finalize': true,
          'Tab.finalize': true,
          'Tab.markDeliverable': true,
          'Tab.markHandoff': true,
        },
        metadata: {
          endpoint: this.activeEndpoint ?? this.endpoint,
          engine: 'raw CDP over the Sidebar webview target',
          sessionName: this.sessionName,
          callerSessionId: this.callerSessionId?.() ?? null,
        },
      },
    ]
  }

  async execute(_browserId, generation, command) {
    const started = Date.now()
    try {
      if (!command || typeof command.method !== 'string') {
        return this.finish(started, fail('execution_error', 'command.method is required'))
      }
      if (typeof generation === 'number' && generation !== this.generation) {
        return this.finish(
          started,
          fail('stale_generation', `Browser generation ${generation} is stale (current ${this.generation})`),
        )
      }
      return this.finish(started, await this.dispatch(command))
    } catch (error) {
      return this.finish(started, this.toFailure(error))
    }
  }

  finish(started, result) {
    return { ...result, elapsedMs: Date.now() - started }
  }

  toFailure(error) {
    if (error instanceof BackendError) return fail(error.code, error.message)
    const message = error?.message ?? String(error)
    if (/timeout/i.test(message)) return fail('timeout', message)
    if (/not found|could not find|no element/i.test(message)) return fail('locator_not_found', message)
    return fail('browser_command_failed', message)
  }

  // ── connections ──────────────────────────────────────────────────────────

  /**
   * The live DevTools endpoint. A stale listener can hold the configured port
   * (TCP connects, nothing answers), so fall back to the port the running app
   * wrote into its own DevToolsActivePort file, then to the usual neighbours.
   */
  async ep() {
    const now = Date.now()
    if (this.activeEndpoint && now - this.endpointCheckedAt < 5000) return this.activeEndpoint
    const candidates = this.endpoint ? [this.endpoint] : []
    try {
      const file = join(process.env.APPDATA ?? '', '@deepseek-ai', 'dsh-desktop', 'DevToolsActivePort')
      const port = readFileSync(file, 'utf8').split(/\r?\n/)[0].trim()
      if (/^\d+$/.test(port)) candidates.push(`http://127.0.0.1:${port}`)
    } catch {}
    for (const port of [9222, 9223, 9224, 9225]) candidates.push(`http://127.0.0.1:${port}`)
    for (const candidate of candidates) {
      if (await endpointAlive(candidate)) {
        this.activeEndpoint = candidate
        this.endpointCheckedAt = now
        return candidate
      }
    }
    this.activeEndpoint = this.endpoint
    this.endpointCheckedAt = now
    return this.endpoint
  }
  async ensureApp() {
    if (this.app?.isOpen) return this.app
    const target = await findAppTarget(await this.ep())
    if (!target) {
      throw new BackendError(
        'backend_unavailable',
        `The DSH window renderer is not visible at ${this.endpoint}. Start DSH with --remote-debugging-port=9222.`,
      )
    }
    this.app = await CdpConnection.attach(target.webSocketDebuggerUrl)
    return this.app
  }

  /** A CDP connection to one guest, created on first use and reused. */
  async guest(targetId) {
    const existing = this.guests.get(targetId)
    if (existing?.isOpen) return existing
    const targets = await listTargets(await this.ep())
    const target = targets.find((entry) => entry.id === targetId)
    if (!target) throw new BackendError('backend_unavailable', `Browser tab '${targetId}' is gone`)
    const connection = await CdpConnection.attach(target.webSocketDebuggerUrl)
    await connection.send('Page.enable').catch(() => undefined)
    await connection.send('Runtime.enable').catch(() => undefined)
    this.guests.set(targetId, connection)
    return connection
  }

  /** Enumerate live webview targets into tab records keyed by a stable tabId. */
  async sync() {
    let targets
    try {
      targets = await listTargets(await this.ep())
    } catch (error) {
      throw new BackendError('backend_unavailable', `Cannot read CDP targets at ${this.endpoint}: ${error.message}`)
    }
    const guests = targets.filter((target) => target.type === 'webview')
    const seen = new Set()
    for (const target of guests) {
      seen.add(target.id)
      let record = this.byTarget.get(target.id)
      if (!record) {
        record = { tabId: `t${++this.seq}`, targetId: target.id, marks: {}, openedAt: Date.now() }
        this.byTarget.set(target.id, record)
      }
      record.url = target.url
      record.title = target.title
      this.tabs.set(record.tabId, record)
    }
    for (const [targetId, record] of [...this.byTarget]) {
      if (seen.has(targetId)) continue
      this.byTarget.delete(targetId)
      this.tabs.delete(record.tabId)
      this.dialogs.delete(record.tabId)
      const connection = this.guests.get(targetId)
      if (connection) {
        connection.close()
        this.guests.delete(targetId)
      }
      if (this.activeTabId === record.tabId) this.activeTabId = undefined
    }
    if (!this.activeTabId || !this.tabs.has(this.activeTabId)) {
      const first = [...this.tabs.keys()][0]
      if (first) this.activeTabId = first
    }
    return [...this.tabs.values()]
  }

  async openSidebarTab(url) {
    const app = await this.ensureApp()
    const before = new Set((await listTargets(await this.ep())).map((target) => target.id))
    // `ctx.sidebarRight` acts on the Session on screen, so the renderer must know
    // which Session asked. A mismatch is refused there rather than dropping this
    // tab into whatever Session the user happens to be looking at.
    let sessionId
    try {
      sessionId = this.callerSessionId?.()
    } catch {}
    try {
      await this.evaluateIn(
        app,
        ([target, caller]) => {
          const bridge = window.__dshBrowserBridge
          if (!bridge) {
            throw new Error('window.__dshBrowserBridge is missing: the dsh-browser-use client half is not loaded')
          }
          return bridge.openTab(target, { sessionId: caller })
        },
        [url, sessionId],
      )
    } catch (error) {
      const message = error?.message ?? String(error)
      if (message.includes('session_mismatch')) {
        throw new BackendError(
          'backend_unavailable',
          `${message}. The tab was NOT opened; ask the user to switch to this Session, or use web_fetch instead.`,
        )
      }
      throw error
    }
    const target = await waitForGuestTarget(await this.ep(), { excludeIds: before })
    if (!target) {
      throw new BackendError(
        'backend_unavailable',
        `The Sidebar accepted openTab(${url}) but no guest target appeared; the page may still be loading`,
      )
    }
    return { target }
  }

  // ── CDP helpers ──────────────────────────────────────────────────────────

  async evaluateIn(connection, pageFunction, arg) {
    const expression =
      typeof pageFunction === 'function' ? `(${pageFunction})(${JSON.stringify(arg ?? null)})` : pageFunction
    const result = await connection.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (result.exceptionDetails) {
      const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'evaluation failed'
      throw new BackendError('browser_command_failed', text.trim())
    }
    return result.result?.value
  }

  async installSelectors(connection) {
    await this.evaluateIn(connection, INSTALL_SOURCE)
  }

  /** In-page expression yielding the Nth element for a selector, or undefined. */
  elementExpression(selector, index = 0) {
    return `(function(){var api=window.__dshSel;if(!api)return undefined;var all=api.resolveAll(${JSON.stringify(
      selector,
    )})||[];var i=${Number(index)};if(i<0)i=all.length+i;return all[i];})()`
  }

  /** Resolve a selector to a box; returns undefined when nothing matched. */
  async resolveBox(connection, selector, index = 0) {
    const glue = `(() => {
      try {
        const el = ${this.elementExpression(selector, index)};
        if (!el) return 'null';
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height,
          tag: el.tagName, text: ((el.innerText || el.value || '') + '').trim().slice(0, 120) });
      } catch (error) { return JSON.stringify({ error: String(error && error.message || error) }); }
    })()`
    const raw = await this.evaluateIn(connection, glue)
    if (raw === 'null' || raw === null) return undefined
    const parsed = JSON.parse(raw)
    if (parsed.error) throw new BackendError('browser_command_failed', parsed.error)
    return parsed
  }

  /** Run a snippet against the resolved element. */
  async actOnElement(connection, selector, body, index = 0) {
    const glue = `(() => {
      try {
        const el = ${this.elementExpression(selector, index)};
        if (!el) return JSON.stringify({ missing: true });
        const fn = ${body};
        return JSON.stringify({ value: fn(el) });
      } catch (error) { return JSON.stringify({ error: String(error && error.message || error) }); }
    })()`
    const raw = await this.evaluateIn(connection, glue)
    const parsed = JSON.parse(raw)
    if (parsed.error) throw new BackendError('browser_command_failed', parsed.error)
    if (parsed.missing) {
      throw new BackendError('locator_not_found', `Nothing matches ${selector}`)
    }
    return parsed.value
  }

  /** The selector a command targets: an explicit selector, or a snapshot ref. */
  async selectorsFor(command) {
    if (typeof command.__selector === 'string' && command.__selector !== '') return command.__selector
    const { ref } = command
    if (typeof ref === 'string' && ref !== '') return refToSelector(ref)
    return undefined
  }

  async requireGuest(tabId) {
    await this.sync()
    const id = tabId ?? this.activeTabId
    if (!id) {
      const pending = [...this.pending.values()][0]
      if (pending) return { record: pending, connection: undefined }
      const record = this.createPendingTab()
      return { record, connection: undefined }
    }
    const record = this.tabs.get(id)
    if (!record) throw new BackendError('backend_unavailable', `Browser tab '${id}' is unavailable`)
    if (record.pending) return { record, connection: undefined }
    return { record, connection: await this.guest(record.targetId) }
  }

  createPendingTab() {
    const tabId = `t${++this.seq}`
    const record = { tabId, targetId: undefined, pending: true, marks: {}, openedAt: Date.now() }
    this.tabs.set(tabId, record)
    this.pending.set(tabId, record)
    if (!this.activeTabId) this.activeTabId = tabId
    return record
  }

  // ── dispatch ─────────────────────────────────────────────────────────────

  async dispatch(command) {
    switch (command.method) {
      case 'list':
        return this.listTabs()
      case 'newTab':
        return this.newTab()
      case 'listUserTabs':
        return ok({ userTabs: [] })
      case 'finalizeTabs':
      case 'markDeliverable':
      case 'markHandoff':
      case 'finalize':
        return ok()
      case 'nameSession':
        this.sessionName = command.name
        return ok()
      case 'browserVisibilityGet':
        return ok({ value: true })
      case 'browserVisibilitySet':
        return ok()
      case 'recordingStart':
      case 'recordingStatus':
      case 'recordingCancel':
        throw new BackendError(
          'capability_unsupported',
          'WebM recording is produced by the Electron renderer MediaRecorder in ZCode; this runtime does not implement it.',
        )
      case 'activateTab':
      case 'claimTab':
        return this.activateTab(command)
      default:
        break
    }

    const { record, connection } = await this.requireGuest(command.tabId)

    if (command.method === 'navigate') return this.navigate(record, command)
    if (command.method === 'close') {
      if (connection) {
        await this.evaluateIn(connection, () => window.close()).catch(() => undefined)
        connection.close()
        this.guests.delete(record.targetId)
      }
      this.tabs.delete(record.tabId)
      this.pending.delete(record.tabId)
      if (this.activeTabId === record.tabId) this.activeTabId = undefined
      return ok()
    }

    if (!connection) {
      throw new BackendError(
        'backend_unavailable',
        `Tab '${record.tabId}' has no guest yet: navigate it to a URL first (that is what opens the Sidebar tab).`,
      )
    }

    switch (command.method) {
      case 'getState':
        return ok({ state: await this.state(connection) })
      case 'screenshot':
        return this.screenshot(connection)
      case 'snapshot':
        return ok({ snapshot: await this.snapshot(connection) })
      case 'back':
        await this.evaluateIn(connection, () => history.back())
        await this.waitLoad(connection)
        return ok()
      case 'forward':
        await this.evaluateIn(connection, () => history.forward())
        await this.waitLoad(connection)
        return ok()
      case 'reload':
        await connection.send('Page.reload')
        await this.waitLoad(connection)
        return ok()
      case 'click':
        return this.click(connection, command)
      case 'type':
        return this.typeText(connection, command)
      case 'press':
        return this.pressKey(connection, command)
      case 'hover':
        return this.hover(connection, command)
      case 'scroll':
      case 'cuaScroll':
        return this.wheel(connection, command)
      case 'select':
        return this.selectOption(connection, command)
      case 'check':
        return this.check(connection, command)
      case 'drag':
      case 'cuaDrag':
        return this.drag(connection, command)
      case 'cuaKeypress':
        return this.pressKey(connection, { key: (command.keys ?? []).join('+') })
      case 'domCuaScroll':
        return this.domScroll(connection, command)
      case 'elementInfo':
        return ok({ element: await this.elementAt(connection, command.x, command.y) })
      case 'evaluate':
        return ok({ value: await this.evaluateIn(connection, command.expression) })
      case 'getDialog': {
        const dialog = this.dialogs.get(record.tabId)
        return ok({ dialog: dialog ?? null })
      }
      case 'handleDialog': {
        const dialog = this.dialogs.get(record.tabId)
        if (!dialog) throw new BackendError('execution_error', 'No JavaScript dialog is pending on this tab')
        this.dialogs.delete(record.tabId)
        await connection.send('Page.handleJavaScriptDialog', {
          accept: command.accept !== false,
          ...(command.promptText ? { promptText: command.promptText } : {}),
        })
        return ok()
      }
      case 'browserViewportSet':
        return this.setViewport(connection, command)
      case 'playwright':
        return this.playwrightAction(connection, command.action)
      case 'playwrightWaitForTimeout': {
        const ms = command.timeoutMs
        if (!Number.isInteger(ms) || ms < 0) {
          throw new BackendError('execution_error', 'playwrightWaitForTimeout requires a non-negative integer')
        }
        await new Promise((resolve) => setTimeout(resolve, ms))
        return ok()
      }
      default:
        throw new BackendError('execution_error', `Unsupported browser command '${command.method}'`)
    }
  }

  async listTabs() {
    const records = await this.sync()
    const tabs = []
    for (const record of records) {
      if (record.pending) {
        tabs.push({ tabId: record.tabId, viewport: { width: 0, height: 0 }, active: record.tabId === this.activeTabId })
        continue
      }
      const connection = await this.guest(record.targetId)
      const viewport = await this.evaluateIn(
        connection,
        () => ({ width: Math.round(innerWidth), height: Math.round(innerHeight) }),
      ).catch(() => ({ width: 0, height: 0 }))
      tabs.push({
        tabId: record.tabId,
        viewport,
        ...(record.tabId === this.activeTabId ? { active: true } : {}),
        ...(record.title ? { title: record.title } : {}),
        ...(record.url ? { url: record.url } : {}),
      })
    }
    return ok({ tabs })
  }

  async newTab() {
    await this.sync()
    for (const record of this.pending.values()) {
      return ok({ tab: { tabId: record.tabId, viewport: { width: 0, height: 0 } } })
    }
    const record = this.createPendingTab()
    return ok({ tab: { tabId: record.tabId, viewport: { width: 0, height: 0 } } })
  }

  async activateTab(command) {
    await this.sync()
    const record = this.tabs.get(command.tabId)
    if (!record) throw new BackendError('backend_unavailable', `Browser tab '${command.tabId}' is unavailable`)
    this.activeTabId = record.tabId
    return ok({ tab: { tabId: record.tabId, viewport: { width: 0, height: 0 }, url: record.url, title: record.title } })
  }

  // ── tab operations ───────────────────────────────────────────────────────

  async state(connection) {
    const state = await this.evaluateIn(connection, () => ({ url: location.href, title: document.title }))
    return state ?? {}
  }

  /**
   * Electron does not composite a `webview` guest that is not the visible one, so
   * captureScreenshot can stall forever. Ask the target to come forward first,
   * then retry once; a blown capture is reported as what it is instead of hanging.
   */
  async screenshot(connection) {
    await connection.send('Page.bringToFront').catch(() => undefined)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const shot = await connection.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs: 6000 })
        if (shot?.data) return ok({ image: { base64: shot.data, mimeType: MIME_PNG } })
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new BackendError(
      'capability_unsupported',
      'The Sidebar does not paint this tab because another Browser tab is the visible one, so no frame could be captured. ' +
        'Switch this session to the tab (sidebarRight.focus) or screenshot the visible tab instead.',
    )
  }

  async snapshot(connection) {
    await this.installSelectors(connection)
    const raw = await this.evaluateIn(connection, SNAPSHOT_SOURCE)
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!parsed?.ok) throw new BackendError('browser_command_failed', parsed?.error ?? 'snapshot failed')
    return parsed.snapshot
  }

  /**
   * A freshly opened Sidebar tab mounts its guest at `about:blank#<lease>` and
   * navigates asynchronously, so "the tab exists" is not "the document loaded".
   * Confirm the requested URL, and drive it ourselves when the pane did not.
   */
  async ensureDocument(connection, url, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs
    let href = ''
    while (Date.now() < deadline) {
      href = await this.evaluateIn(connection, () => location.href).catch(() => '')
      if (href === url) break
      if (href && href !== 'about:blank' && !href.startsWith('about:blank#')) break
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    if (!href || href === 'about:blank' || href.startsWith('about:blank#')) {
      await connection.send('Page.navigate', { url }, { timeoutMs: NAV_TIMEOUT })
    }
    await this.waitLoad(connection, NAV_TIMEOUT)
  }

  async waitLoad(connection, timeoutMs = ROUTINE_TIMEOUT) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const ready = await this.evaluateIn(connection, () => document.readyState).catch(() => 'complete')
      if (ready === 'complete') return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  assertNavigable(url) {
    if (typeof url !== 'string' || url === '') {
      throw new BackendError('execution_error', 'navigate requires a url')
    }
    if (url === 'about:blank') return
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      throw new BackendError('execution_error', `navigate requires an absolute http(s) URL, got '${url}'`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BackendError(
        'capability_unsupported',
        `navigate accepts http:, https: and exact about:blank; '${parsed.protocol}' is not navigable here`,
      )
    }
  }

  async navigate(record, command) {
    this.assertNavigable(command.url)
    if (record.pending || !record.targetId) {
      const { target } = await this.openSidebarTab(command.url)
      this.pending.delete(record.tabId)
      record.pending = false
      record.targetId = target.id
      record.url = target.url
      record.title = target.title
      this.byTarget.set(target.id, record)
      this.tabs.set(record.tabId, record)
      this.activeTabId = record.tabId
      const connection = await this.guest(target.id)
      await this.attachDialogs(connection, record.tabId)
      await this.ensureDocument(connection, command.url)
      return ok()
    }
    const connection = await this.guest(record.targetId)
    await connection.send('Page.navigate', { url: command.url }, { timeoutMs: NAV_TIMEOUT })
    await this.waitLoad(connection, NAV_TIMEOUT)
    return ok()
  }

  async attachDialogs(connection, tabId) {
    if (typeof connection.on !== 'function') return
    connection.on('Page.javascriptDialogOpening', (params) => {
      this.dialogs.set(tabId, {
        type: params.type,
        message: params.message,
        ...(params.defaultPrompt !== undefined ? { defaultValue: params.defaultPrompt } : {}),
      })
    })
  }

  async setViewport(connection, command) {
    const { width, height } = command
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      throw new BackendError('execution_error', 'browserViewportSet requires integer width and height')
    }
    if (width < 320 || width > 3840 || height < 320 || height > 2160) {
      throw new BackendError('execution_error', `browserViewportSet accepts width 320..3840, height 320..2160`)
    }
    await connection.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 0,
      mobile: false,
    })
    return ok()
  }

  async elementAt(connection, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new BackendError('execution_error', 'elementInfo requires numeric x and y')
    }
    return this.evaluateIn(connection, (point) => {
      const element = document.elementFromPoint(point.x, point.y)
      if (!element) return null
      const box = element.getBoundingClientRect()
      return {
        tagName: element.tagName,
        id: element.id || undefined,
        role: element.getAttribute('role') || undefined,
        name: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 160),
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
      }
    }, { x, y })
  }

  async click(connection, command) {
    const selector = await this.selectorsFor(command)
    const count = command.doubleClick ? 2 : 1
    const button = command.button === 'right' ? 'right' : command.button === 'middle' ? 'middle' : 'left'
    const mask = modifierMask(command.modifiers)
    let point
    if (selector) {
      point = await this.resolveBox(connection, selector)
      if (!point) throw new BackendError('locator_not_found', `Nothing matches ${selector}`)
    } else {
      if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) {
        throw new BackendError('execution_error', 'click requires a snapshot ref or numeric x and y')
      }
      point = { x: command.x, y: command.y }
    }
    for (let index = 0; index < count; index += 1) {
      await connection.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button,
        clickCount: index + 1,
        modifiers: mask,
      })
      await connection.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: point.x,
        y: point.y,
        button,
        clickCount: index + 1,
        modifiers: mask,
      })
    }
    return ok()
  }

  async typeText(connection, command) {
    const text = command.text
    if (typeof text !== 'string') throw new BackendError('execution_error', 'type requires text')
    const selector = await this.selectorsFor(command)
    if (selector) {
      await this.actOnElement(connection, selector, `(el) => { el.focus && el.focus(); return true }`)
    }
    await connection.send('Input.insertText', { text })
    return ok()
  }

  async pressKey(connection, command) {
    const spec = command.key
    if (typeof spec !== 'string' || spec === '') throw new BackendError('execution_error', 'press requires a key')
    const parts = spec.split('+').filter(Boolean)
    const last = parts.pop()
    const mask = modifierMask(parts)
    const named = KEYS[last] ?? { key: last, code: `Key${last.toUpperCase()}` }
    const selector = await this.selectorsFor(command)
    if (selector) {
      await this.actOnElement(connection, selector, `(el) => { el.focus && el.focus(); return true }`)
    }
    await connection.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.windowsVirtualKeyCode,
      modifiers: mask,
    })
    if (named.text && mask === 0) {
      await connection.send('Input.dispatchKeyEvent', { type: 'char', text: named.text, modifiers: mask })
    }
    await connection.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: named.key,
      code: named.code,
      windowsVirtualKeyCode: named.windowsVirtualKeyCode,
      modifiers: mask,
    })
    return ok()
  }

  async hover(connection, command) {
    const selector = await this.selectorsFor(command)
    let point
    if (selector) {
      point = await this.resolveBox(connection, selector)
      if (!point) throw new BackendError('locator_not_found', `Nothing matches ${selector}`)
    } else {
      if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) {
        throw new BackendError('execution_error', 'hover requires a snapshot ref or numeric x and y')
      }
      point = { x: command.x, y: command.y }
    }
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      modifiers: modifierMask(command.modifiers),
    })
    return ok()
  }

  async wheel(connection, command) {
    const dx = command.scrollX ?? command.deltaX ?? 0
    const dy = command.scrollY ?? command.deltaY ?? 0
    const point = Number.isFinite(command.x)
      ? { x: command.x, y: command.y }
      : await this.evaluateIn(connection, () => ({ x: innerWidth / 2, y: innerHeight / 2 }))
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: point.x,
      y: point.y,
      deltaX: dx,
      deltaY: dy,
      modifiers: modifierMask(command.modifiers),
    })
    return ok()
  }

  async selectOption(connection, command) {
    const selector = await this.selectorsFor(command)
    if (!selector) throw new BackendError('execution_error', 'select requires a snapshot ref')
    const values = Array.isArray(command.values) ? command.values : [command.values]
    await this.actOnElement(
      connection,
      selector,
      `(el) => {
        const wanted = ${JSON.stringify(values)}.map(String);
        const options = Array.from(el.options || []);
        for (const option of options) {
          if (!wanted.includes(option.value)) continue;
          el.value = option.value;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return option.value;
        }
        throw new Error('no option matches ' + wanted.join(', '));
      }`,
    )
    return ok()
  }

  async check(connection, command) {
    const selector = await this.selectorsFor(command)
    if (!selector) throw new BackendError('execution_error', 'check requires a snapshot ref')
    const wanted = command.checked !== false
    await this.actOnElement(
      connection,
      selector,
      `(el) => { if (el.checked !== ${wanted}) { el.click(); } return el.checked }`,
    )
    return ok()
  }

  async drag(connection, command) {
    const fromSelector = command.fromRef ? refToSelector(command.fromRef) : undefined
    const toSelector = command.toRef ? refToSelector(command.toRef) : undefined
    const start = fromSelector
      ? await this.resolveBox(connection, fromSelector)
      : command.from ?? command.path?.[0]
    const path = Array.isArray(command.path) ? command.path : undefined
    const end = toSelector ? await this.resolveBox(connection, toSelector) : command.to ?? path?.[path.length - 1]
    if (!start || !end) throw new BackendError('execution_error', 'drag requires from/to points or refs')
    await connection.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y })
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: start.x,
      y: start.y,
      button: 'left',
      clickCount: 1,
    })
    const steps = path ?? [end]
    for (const point of steps) {
      await connection.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 1,
      })
    }
    await connection.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: end.x,
      y: end.y,
      button: 'left',
      clickCount: 1,
    })
    return ok()
  }

  async domScroll(connection, command) {
    const selector = refToSelector(command.nodeId)
    await this.actOnElement(
      connection,
      selector,
      `(el) => { el.scrollBy(${command.scrollX ?? 0}, ${command.scrollY ?? 0}); return true }`,
    )
    return ok()
  }

  // ── playwright surface ───────────────────────────────────────────────────

  async playwrightAction(connection, action) {
    if (!action || typeof action.name !== 'string') {
      throw new BackendError('execution_error', 'playwright requires an action name')
    }
    switch (action.name) {
      case 'locator':
        return this.locatorOperation(connection, action)
      case 'evaluate': {
        const source =
          action.expressionKind === 'function'
            ? `(${action.expression})(${JSON.stringify(action.arg ?? null)})`
            : `(${action.arg === undefined ? action.expression : `(${action.expression})(${JSON.stringify(action.arg)})`})`
        return ok({ value: await this.evaluateIn(connection, source) })
      }
      case 'domSnapshot':
        return ok({ value: await this.snapshot(connection) })
      case 'waitForLoadState': {
        await this.waitLoad(connection, action.timeoutMs ?? ROUTINE_TIMEOUT)
        return ok()
      }
      case 'waitForURL': {
        const deadline = Date.now() + (action.timeoutMs ?? ROUTINE_TIMEOUT)
        while (Date.now() < deadline) {
          const current = await this.evaluateIn(connection, () => location.href).catch(() => '')
          if (!action.url || String(current).includes(action.url) || matchUrl(action.url, current)) return ok()
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        return ok()
      }
      case 'elementInfo':
        return ok({ element: await this.elementAt(connection, action.x, action.y) })
      case 'elementScreenshot': {
        const box = await this.resolveBox(connection, action.selector ?? 'body')
        const shot = await connection.send('Page.captureScreenshot', {
          format: 'png',
          ...(box ? { clip: { x: box.x - box.width / 2, y: box.y - box.height / 2, width: box.width, height: box.height, scale: 1 } } : {}),
        })
        return ok({ image: { base64: shot.data, mimeType: MIME_PNG } })
      }
      case 'waitForEvent':
      case 'downloadPath':
      case 'fileChooserSetFiles':
        throw new BackendError(
          'capability_unsupported',
          `${action.name} is an IAB-only path in ZCode; this CDP runtime does not relay downloads or file choosers.`,
        )
      default:
        throw new BackendError('capability_unsupported', `playwright.${action.name} is not implemented`)
    }
  }

  async locatorOperation(connection, action) {
    const selector = action.selector
    if (typeof selector !== 'string' || selector === '') {
      throw new BackendError('execution_error', 'playwright.locator requires a selector')
    }
    await this.installSelectors(connection)
    const timeout = action.timeoutMs ?? ROUTINE_TIMEOUT

    switch (action.operation) {
      case 'count': {
        const described = await this.evaluateIn(connection, buildResolveSource(selector, 0))
        const parsed = typeof described === 'string' ? JSON.parse(described) : described
        return ok({ value: parsed?.count ?? 0 })
      }
      case 'isVisible':
        return ok({ value: Boolean((await this.resolveBox(connection, selector, 0)) !== undefined) })
      case 'isEnabled': {
        const value = await this.actOnElement(connection, selector, `(el) => !el.disabled`)
        return ok({ value })
      }
      case 'textContent':
      case 'innerText': {
        const value = await this.actOnElement(connection, selector, `(el) => (el.innerText || el.textContent || '').trim()`)
        return ok({ value })
      }
      case 'allTextContents': {
        const value = await this.actOnElement(
          connection,
          selector,
          `(el) => Array.from(el.querySelectorAll('*')).slice(0, 50).map((node) => (node.innerText || '').trim()).filter(Boolean)`,
        )
        return ok({ value })
      }
      case 'getAttribute': {
        const value = await this.actOnElement(
          connection,
          selector,
          `(el) => el.getAttribute(${JSON.stringify(action.attribute)})`,
        )
        return ok({ value })
      }
      case 'click':
      case 'dblclick':
        return this.click(connection, {
          __selector: selector,
          ...(action.operation === 'dblclick' ? { doubleClick: true } : {}),
        })
      case 'fill':
      case 'press': {
        const text = String(action.value ?? '')
        await this.actOnElement(
          connection,
          selector,
          action.operation === 'fill'
            ? `(el) => { el.focus(); if ('value' in el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } return true }`
            : `(el) => { el.focus && el.focus(); return true }`,
        )
        if (action.operation === 'fill') {
          await connection.send('Input.insertText', { text })
        } else {
          await this.pressKey(connection, { key: text })
        }
        return ok()
      }
      case 'selectOption':
        return this.selectOption(connection, { __selector: selector, values: (action.selections ?? []).map((s) => s.value ?? s) })
      case 'setChecked':
        return this.check(connection, { __selector: selector, checked: action.checked })
      case 'waitFor': {
        const deadline = Date.now() + timeout
        const wantVisible = action.state !== 'detached' && action.state !== 'hidden'
        while (Date.now() < deadline) {
          const box = await this.resolveBox(connection, selector, 0)
          if (wantVisible ? Boolean(box) : !box) return ok()
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        throw new BackendError('timeout', `waitFor(${action.state}) timed out for ${selector}`)
      }
      case 'evaluate': {
        const source =
          action.expressionKind === 'function'
            ? `(${action.expression})(${JSON.stringify(action.arg ?? null)})`
            : action.expression
        const value = await this.evaluateIn(
          connection,
          `(() => { const el = ${this.elementExpression(selector, 0)}; if (!el) throw new Error('Nothing matches ' + ${JSON.stringify(selector)}); return (function(){ ${source} }).call(el); })()`,
        )
        return ok({ value })
      }
      case 'downloadMedia':
        throw new BackendError('capability_unsupported', 'downloadMedia is an IAB-only path in ZCode.')
      default:
        throw new BackendError('capability_unsupported', `playwright locator operation '${action.operation}' is not implemented`)
    }
  }
}

async function endpointAlive(endpoint) {
  try {
    const response = await fetch(`${endpoint.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(1500) })
    return response.ok
  } catch {
    return false
  }
}

function matchUrl(pattern, current) {
  if (typeof pattern !== 'string' || typeof current !== 'string') return false
  try {
    return new RegExp(pattern).test(current)
  } catch {
    return current.includes(pattern)
  }
}

export { BackendError }
