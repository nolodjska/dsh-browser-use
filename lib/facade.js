/**
 * `agent.browsers` — this plugin's own implementation.
 *
 * The object model follows the ZCode browser-use contract (the same shape the
 * `control-browser` guidance and the browser tooling in this ecosystem use), but
 * every line here is ours: no vendored client, no ZCode dependency. Semantics and
 * method names are an interface; the code below is written against the command
 * layer in `backend-cdp.js`, which in turn speaks the DevTools Protocol.
 *
 * Fresh-kernel rule: a cell cannot reuse a binding from a previous cell, so a
 * `Browsers` object is cheap — it carries no state beyond the tab ids it has seen.
 * Continuity lives in the browser process, not in JavaScript.
 */

export class BrowserCommandError extends Error {
  constructor(command, result) {
    const code = result?.error?.code ?? 'browser_command_failed'
    super(result?.error?.message ?? `Browser command failed: ${code}`)
    this.name = 'BrowserCommandError'
    this.code = code
    this.command = command
    this.result = result
  }
}

const REF = (ref) => `aria-ref=${ref}`

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function roleSelector(role, options = {}) {
  if (!role) throw new Error('getByRole requires a role')
  if (options.name === undefined) return `internal:role=${role}`
  const matcher =
    typeof options.name === 'string'
      ? `${JSON.stringify(options.name)}${options.exact ? 's' : 'i'}`
      : String(options.name)
  return `internal:role=${role}[name=${matcher}]`
}

function textSelector(text, exact) {
  return `internal:text=${typeof text === 'string' ? `${JSON.stringify(text)}${exact ? 's' : 'i'}` : String(text)}`
}

function labelSelector(text, exact) {
  return `internal:label=${typeof text === 'string' ? `${JSON.stringify(text)}${exact ? 's' : 'i'}` : String(text)}`
}

function placeholderSelector(text, exact) {
  return `internal:attr=[placeholder=${typeof text === 'string' ? `${JSON.stringify(text)}${exact ? 's' : 'i'}` : String(text)}]`
}

function testIdSelector(testId) {
  if (!testId) throw new Error('getByTestId requires a testId')
  return `internal:testid=[data-testid=${JSON.stringify(testId)}s]`
}

/** One Playwright-flavoured locator, resolved by the in-page engine. */
export class Locator {
  constructor(tab, selector) {
    this.tab = tab
    this.selector = selector
  }

  chain(suffix) {
    return new Locator(this.tab, `${this.selector} >> ${suffix}`)
  }

  locator(selector) {
    if (!selector) throw new Error('locator requires a selector')
    return this.chain(selector)
  }

  getByRole(role, options) {
    return this.chain(roleSelector(role, options))
  }

  getByText(text, options = {}) {
    return this.chain(textSelector(text, Boolean(options.exact)))
  }

  getByLabel(text, options = {}) {
    return this.chain(labelSelector(text, Boolean(options.exact)))
  }

  getByPlaceholder(text, options = {}) {
    return this.chain(placeholderSelector(text, Boolean(options.exact)))
  }

  getByTestId(testId) {
    return this.chain(testIdSelector(testId))
  }

  first() {
    return this.chain('nth=0')
  }

  last() {
    return this.chain('nth=-1')
  }

  nth(index) {
    if (typeof index !== 'number') throw new Error('nth requires a number')
    return this.chain(`nth=${index}`)
  }

  filter(options = {}) {
    let next = this
    if (options.hasText !== undefined) next = next.chain(`internal:has-text=${JSON.stringify(String(options.hasText))}i`)
    if (options.hasNotText !== undefined) {
      next = next.chain(`internal:has-not-text=${JSON.stringify(String(options.hasNotText))}i`)
    }
    if (options.visible !== undefined) next = next.chain(`visible=${options.visible}`)
    return next
  }

  // terminal actions
  async click(options = {}) {
    await this.tab.playwrightAction('locator', { selector: this.selector, operation: 'click', ...options })
  }

  async dblclick(options = {}) {
    await this.tab.playwrightAction('locator', { selector: this.selector, operation: 'dblclick', ...options })
  }

  async fill(value, options = {}) {
    if (value == null) throw new Error('fill requires a value')
    await this.tab.playwrightAction('locator', {
      selector: this.selector,
      operation: 'fill',
      value: String(value),
      ...options,
    })
  }

  async type(value, options = {}) {
    if (value == null) throw new Error('type requires a value')
    await this.tab.playwrightAction('locator', {
      selector: this.selector,
      operation: 'press',
      value: String(value),
      ...options,
    })
  }

  async press(value, options = {}) {
    if (value == null) throw new Error('press requires a key')
    await this.tab.playwrightAction('locator', {
      selector: this.selector,
      operation: 'press',
      value: String(value),
      ...options,
    })
  }

  async selectOption(values, options = {}) {
    const list = Array.isArray(values) ? values : [values]
    await this.tab.playwrightAction('locator', {
      selector: this.selector,
      operation: 'selectOption',
      selections: list.map((value) => (typeof value === 'string' ? { value } : value)),
      ...options,
    })
  }

  async check(options = {}) {
    await this.tab.playwrightAction('locator', {
      selector: this.selector,
      operation: 'setChecked',
      checked: true,
      ...options,
    })
  }

  async uncheck(options = {}) {
    await this.tab.playwrightAction('locator', {
      selector: this.selector,
      operation: 'setChecked',
      checked: false,
      ...options,
    })
  }

  async waitFor(options = {}) {
    if (!options.state) throw new Error('waitFor requires a state')
    await this.tab.playwrightAction('locator', { selector: this.selector, operation: 'waitFor', ...options })
  }

  async count() {
    return this.tab.playwrightValue('locator', { selector: this.selector, operation: 'count' })
  }

  async textContent(options = {}) {
    return this.tab.playwrightValue('locator', { selector: this.selector, operation: 'textContent', ...options })
  }

  async innerText(options = {}) {
    return this.tab.playwrightValue('locator', { selector: this.selector, operation: 'innerText', ...options })
  }

  async getAttribute(name, options = {}) {
    if (!name) throw new Error('getAttribute requires a name')
    return this.tab.playwrightValue('locator', {
      selector: this.selector,
      operation: 'getAttribute',
      attribute: name,
      ...options,
    })
  }

  async isVisible() {
    return this.tab.playwrightValue('locator', { selector: this.selector, operation: 'isVisible' })
  }

  async isEnabled() {
    return this.tab.playwrightValue('locator', { selector: this.selector, operation: 'isEnabled' })
  }

  async allTextContents(options = {}) {
    return this.tab.playwrightValue('locator', { selector: this.selector, operation: 'allTextContents', ...options })
  }

  async evaluate(pageFunction, arg, options = {}) {
    const source = typeof pageFunction === 'function' ? pageFunction.toString() : String(pageFunction)
    return this.tab.playwrightValue('locator', {
      selector: this.selector,
      operation: 'evaluate',
      expression: source,
      expressionKind: typeof pageFunction === 'function' ? 'function' : 'string',
      arg,
      ...options,
    })
  }
}

/** The `tab.playwright` surface. */
export class PlaywrightAPI {
  constructor(tab) {
    this.tab = tab
  }

  locator(selector) {
    if (!selector) throw new Error('playwright.locator requires a selector')
    return new Locator(this.tab, selector)
  }

  getByRole(role, options) {
    return this.locator(roleSelector(role, options))
  }

  getByText(text, options = {}) {
    return this.locator(textSelector(text, Boolean(options.exact)))
  }

  getByLabel(text, options = {}) {
    return this.locator(labelSelector(text, Boolean(options.exact)))
  }

  getByPlaceholder(text, options = {}) {
    return this.locator(placeholderSelector(text, Boolean(options.exact)))
  }

  getByTestId(testId) {
    return this.locator(testIdSelector(testId))
  }

  /** The compact ARIA tree with `[ref=eN]` markers — the locator ground truth. */
  async domSnapshot() {
    return this.tab.playwrightValue('domSnapshot', {})
  }

  async evaluate(pageFunction, arg, options = {}) {
    const source = typeof pageFunction === 'function' ? pageFunction.toString() : String(pageFunction)
    return this.tab.playwrightValue('evaluate', {
      expression: source,
      expressionKind: typeof pageFunction === 'function' ? 'function' : 'string',
      arg,
      ...options,
    })
  }

  async waitForURL(url, options = {}) {
    await this.tab.playwrightAction('waitForURL', { url: String(url), ...options })
  }

  async waitForLoadState(options = {}) {
    await this.tab.playwrightAction('waitForLoadState', { ...options })
  }

  async waitForTimeout(timeoutMs) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error('waitForTimeout requires a non-negative integer')
    }
    await this.tab.request({ method: 'playwrightWaitForTimeout', timeoutMs })
  }
}

/** One tab. */
export class Tab {
  constructor(browser, tabId) {
    this.browser = browser
    this.id = tabId
    this.playwright = new PlaywrightAPI(this)
    this.viewportValue = undefined
  }

  async request(command) {
    const withTab = { ...command, tabId: this.id }
    const payload = await this.browser.request(withTab)
    // The command layer reports failures as `{ ok: false, error }` instead of
    // throwing, so this is the single place that turns them into exceptions. Do
    // not skip it: an unchecked failure surfaces later as a confusing
    // "missing value" and hides the real code.
    if (payload?.ok === false) throw new BrowserCommandError(withTab, payload)
    return payload ?? {}
  }

  /** Run a playwright action (`{ name, ...fields }`) and expect success only. */
  async playwrightAction(name, fields = {}) {
    await this.request({ method: 'playwright', action: { name, ...fields } })
  }

  /** Run a playwright action and return its `value`. */
  async playwrightValue(name, fields = {}) {
    const payload = await this.request({ method: 'playwright', action: { name, ...fields } })
    if (payload.value === undefined) {
      throw new BrowserCommandError({ method: 'playwright', action: name }, {
        ok: false,
        error: { code: 'execution_error', message: `Browser result missing value for playwright.${name}` },
      })
    }
    return payload.value
  }

  async url() {
    return (await this.getState()).url
  }

  async title() {
    return (await this.getState()).title
  }

  async getState() {
    const payload = await this.request({ method: 'getState' })
    return payload.state ?? {}
  }

  async goto(url) {
    await this.request({ method: 'navigate', url })
  }

  /** Alias kept because guidance in the wild uses both names. */
  async navigate(url) {
    await this.goto(url)
  }

  async back() {
    await this.request({ method: 'back' })
  }

  async forward() {
    await this.request({ method: 'forward' })
  }

  async reload() {
    await this.request({ method: 'reload' })
  }

  async close() {
    await this.request({ method: 'close' })
  }

  async screenshot(options = {}) {
    const payload = await this.request({ method: 'screenshot', ...options })
    const image = payload.image
    if (!image?.base64) {
      throw new BrowserCommandError({ method: 'screenshot' }, {
        ok: false,
        error: { code: 'execution_error', message: 'Browser result missing image' },
      })
    }
    return new Uint8Array(Buffer.from(image.base64, 'base64'))
  }

  async snapshot(options = {}) {
    const payload = await this.request({ method: 'snapshot', ...options })
    return payload.snapshot
  }

  async setViewportSize(viewportSize) {
    const { width, height } = viewportSize ?? {}
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      throw new TypeError('setViewportSize requires integer width and height')
    }
    if (width < 320 || width > 3840 || height < 320 || height > 2160) {
      throw new TypeError('setViewportSize requires width 320..3840 and height 320..2160')
    }
    await this.request({ method: 'browserViewportSet', width, height })
    this.viewportValue = { width, height }
  }

  viewportSize() {
    return this.viewportValue ? { ...this.viewportValue } : null
  }

  async click(target, options = {}) {
    if (typeof target === 'string') {
      await this.request({ method: 'click', ref: target, ...options })
      return
    }
    const { x, y, ...rest } = target ?? {}
    await this.request({ method: 'click', x, y, ...rest, ...options })
  }

  async type(text, options = {}) {
    await this.request({ method: 'type', text: String(text), ref: options.ref })
  }

  async press(key, options = {}) {
    await this.request({ method: 'press', key: String(key), ref: options.ref, modifiers: options.modifiers })
  }

  async hover(target) {
    if (typeof target === 'string') {
      await this.request({ method: 'hover', ref: target })
      return
    }
    await this.request({ method: 'hover', x: target?.x, y: target?.y })
  }

  async scroll(options = {}) {
    await this.request({ method: 'scroll', ...options })
  }

  async select(ref, values) {
    await this.request({ method: 'select', ref, values })
  }

  async check(ref, checked = true) {
    await this.request({ method: 'check', ref, checked })
  }

  async drag(from, to, options = {}) {
    const fromPart = typeof from === 'string' ? { fromRef: from } : { from }
    const toPart = typeof to === 'string' ? { toRef: to } : { to }
    await this.request({ method: 'drag', ...fromPart, ...toPart, ...options })
  }

  async evaluate(expressionOrFunction) {
    const expression =
      typeof expressionOrFunction === 'function'
        ? `(${expressionOrFunction.toString()})()`
        : String(expressionOrFunction)
    const payload = await this.request({ method: 'evaluate', expression })
    return payload.value
  }

  async elementInfo(x, y) {
    const payload = await this.request({ method: 'elementInfo', x, y })
    return payload.element
  }

  async getDialog() {
    const payload = await this.request({ method: 'getDialog' })
    return payload.dialog ?? null
  }

  async handleDialog(accept, promptText) {
    await this.request({ method: 'handleDialog', accept, promptText })
  }

  async markDeliverable() {
    await this.request({ method: 'markDeliverable' })
  }

  async markHandoff() {
    await this.request({ method: 'markHandoff' })
  }

  async finalize(options = {}) {
    await this.request({ method: 'finalize', deliverable: options.deliverable })
  }

  /** Convenience: type into the focused element without a locator. */
  async typeInto(text) {
    await this.request({ method: 'type', text: String(text) })
  }

  /** Convenience: press a snapshot ref's control by keyboard. */
  async pressIn(ref, key) {
    await this.request({ method: 'press', ref, key: String(key) })
  }

  /** Convenience: the ref of the Nth match, for callers that already snapshotted. */
  static refSelector(ref) {
    return REF(ref)
  }
}

/** One browser (this runtime advertises exactly one). */
export class Browser {
  constructor(host, descriptor) {
    this.host = host
    this.descriptor = descriptor
    this.id = descriptor.id
    this.type = descriptor.type
    this.tabs = {
      list: async () => (await this.exec({ method: 'list' })).tabs ?? [],
      get: async (tabId) => {
        const payload = await this.exec({ method: 'activateTab', tabId })
        return new Tab(this, payload.tab?.tabId ?? tabId)
      },
      new: async () => {
        const payload = await this.exec({ method: 'newTab' })
        return new Tab(this, payload.tab?.tabId)
      },
      reuse: async (url) => {
        const tabs = (await this.exec({ method: 'list' })).tabs ?? []
        const match = tabs.find((tab) => tab.url && url && tab.url.startsWith(new URL(url, 'http://x').origin))
        if (!match) return undefined
        const payload = await this.exec({ method: 'activateTab', tabId: match.tabId })
        return new Tab(this, payload.tab?.tabId ?? match.tabId)
      },
      finalize: async (options = {}) => {
        const keep = (options.keep ?? []).map(({ tab, status }) => ({
          tabId: typeof tab === 'string' ? tab : tab?.id,
          status,
        }))
        await this.exec({ method: 'finalizeTabs', keep })
      },
    }
    this.user = {
      /** No user-tab inventory is exposed by this transport. */
      openTabs: async () => [],
      claimTab: async () => {
        throw new BrowserCommandError({ method: 'claimTab' }, {
          ok: false,
          error: {
            code: 'capability_unsupported',
            message: 'Claiming a user tab needs the renderer bridge; this transport only controls tabs it opened.',
          },
        })
      },
    }
    this.capabilities = {
      list: async () => (await host.describe()).capabilities?.browser ?? [],
      get: async (capabilityId) =>
        (await host.describe()).capabilities?.browser?.find((capability) => capability.id === capabilityId),
    }
    this.recording = {
      start: async () => {
        throw new BrowserCommandError({ method: 'recordingStart' }, {
          ok: false,
          error: {
            code: 'capability_unsupported',
            message: 'WebM recording is not implemented by this runtime (no screencast transport).',
          },
        })
      },
    }
  }

  /** Execute one command, turning a reported failure into an exception. */
  async exec(command) {
    const payload = await this.host.execute(command)
    if (payload?.ok === false) throw new BrowserCommandError(command, payload)
    return payload ?? {}
  }

  async request(command) {
    return this.exec(command)
  }

  async documentation() {
    return this.host.documentation(undefined)
  }

  async nameSession(name) {
    if (typeof name !== 'string' || name.trim() === '') throw new Error('nameSession requires a name')
    await this.exec({ method: 'nameSession', name })
  }
}

/** The `agent.browsers` facade. */
export class Browsers {
  constructor(host) {
    this.host = host
    /** The tab a caller uses when it does not name one. */
    this.default = new Tab(new Browser(host, { id: 'default', type: 'cdp' }), undefined)
  }

  async list() {
    const descriptors = await this.host.describeAll()
    return descriptors.map(({ generation, ...rest }) => rest)
  }

  async get(idOrType) {
    const descriptors = await this.host.describeAll()
    const descriptor = descriptors.find((entry) => entry.id === idOrType || entry.type === idOrType)
    if (!descriptor) {
      throw new BrowserCommandError(
        { method: 'list' },
        {
          ok: false,
          error: {
            code: 'backend_unavailable',
            message: `No browser backend '${idOrType}'. Available: ${descriptors.map((entry) => entry.type).join(', ') || 'none'}`,
          },
        },
      )
    }
    return new Browser(this.host, descriptor)
  }

  async getDefault() {
    const descriptors = await this.host.describeAll()
    if (descriptors.length === 0) {
      throw new BrowserCommandError({ method: 'list' }, {
        ok: false,
        error: { code: 'backend_unavailable', message: 'No browser backend is available.' },
      })
    }
    return new Browser(this.host, descriptors[0])
  }

  /** Same backend as `getDefault`; the URL hint is unused with one backend. */
  async getForUrl(_url) {
    return this.getDefault()
  }

  /** Open (or reuse) a tab and navigate it. */
  async open(url, options = {}) {
    const browser = await this.getDefault()
    if (url && options.reuseTab !== false) {
      const reused = await browser.tabs.reuse(url).catch(() => undefined)
      if (reused) {
        await reused.goto(url)
        return reused
      }
    }
    const tab = await browser.tabs.new()
    if (url) await tab.goto(url)
    return tab
  }

  async current() {
    const browser = await this.getDefault()
    const tabs = await browser.tabs.list()
    const active = tabs.find((tab) => tab.active) ?? tabs[tabs.length - 1]
    if (!active) return browser.tabs.new()
    return browser.tabs.get(active.tabId)
  }

  async listTabs() {
    const browser = await this.getDefault()
    return (await browser.tabs.list()).map((summary) => new Tab(browser, summary.tabId))
  }
}

/**
 * Install the facade on a global `agent` object.
 *
 * The host is supplied by the plugin: `{ describeAll, describe, execute,
 * documentation }`. Nothing here touches a process or a socket directly.
 */
export function installBrowserRuntime({ globals, host, documentation }) {
  const agent = (globals.agent ??= {})
  agent.browsers = new Browsers(host)
  agent.documentation = Object.freeze({
    get: async (name) => {
      if (!name) throw new TypeError('agent.documentation.get requires a document name')
      return documentation(name)
    },
  })
  return agent.browsers
}
