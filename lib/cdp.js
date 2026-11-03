/**
 * dsh-browser-use — the raw CDP transport.
 *
 * Playwright cannot attach to Electron `webview` targets: `connectOverCDP` only
 * exposes `page` targets, while the Sidebar guest is reported as
 * `type: "webview"`. The DevTools Protocol drives it fine, so this module speaks
 * CDP directly over the target's own WebSocket.
 *
 * One `CdpConnection` is one target: the app renderer (to call the Sidebar
 * bridge) or one browser guest (to navigate, read the DOM, dispatch input).
 */

const DEFAULT_TIMEOUT = 15000

export class CdpError extends Error {
  constructor(message, method, code) {
    super(message)
    this.name = 'CdpError'
    this.method = method
    this.code = code
  }
}

export class CdpConnection {
  constructor(socket) {
    this.closed = false
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.socket = socket

    socket.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject, method } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) {
          reject(new CdpError(message.error.message ?? 'CDP error', method, message.error.code))
        } else {
          resolve(message.result ?? {})
        }
        return
      }
      if (typeof message.method === 'string') {
        for (const handler of this.listeners.get(message.method) ?? []) {
          try {
            handler(message.params ?? {})
          } catch {}
        }
      }
    }

    socket.onclose = () => {
      this.closed = true
      for (const [id, { reject, method }] of this.pending) {
        this.pending.delete(id)
        reject(new CdpError('CDP connection closed', method))
      }
    }
    socket.onerror = () => {
      // The close handler rejects pending work; keep this quiet.
    }
  }

  static async attach(wsUrl, { timeoutMs = 10000 } = {}) {
    const socket = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`CDP connect timed out for ${wsUrl}`)), timeoutMs)
      socket.onopen = () => {
        clearTimeout(timer)
        resolve()
      }
      socket.onerror = () => {
        clearTimeout(timer)
        reject(new Error(`CDP socket error for ${wsUrl}`))
      }
    })
    return new CdpConnection(socket)
  }

  get isOpen() {
    return !this.closed
  }

  /** `send(method, params, { timeoutMs })` — rejects CdpError on protocol errors. */
  send(method, params = {}, options = {}) {
    if (this.closed) return Promise.reject(new CdpError('CDP connection closed', method))
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CdpError(`CDP ${method} timed out after ${timeoutMs}ms`, method))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      try {
        this.socket.send(JSON.stringify({ id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new CdpError(`CDP ${method} could not be sent: ${error.message}`, method))
      }
    })
  }

  /** Subscribe to a CDP event (for example `Page.javascriptDialogOpening`). */
  on(method, handler) {
    const handlers = this.listeners.get(method) ?? []
    handlers.push(handler)
    this.listeners.set(method, handlers)
    return () => {
      const current = this.listeners.get(method) ?? []
      this.listeners.set(
        method,
        current.filter((entry) => entry !== handler),
      )
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.close()
    } catch {}
    for (const [id, { reject, method }] of this.pending) {
      this.pending.delete(id)
      reject(new CdpError('CDP connection closed', method))
    }
  }
}

export async function listTargets(endpoint) {
  let response
  try {
    response = await fetch(`${endpoint.replace(/\/$/, '')}/json`, { signal: AbortSignal.timeout(5000) })
  } catch (error) {
    throw new Error(`Cannot reach the CDP endpoint at ${endpoint} (${error.message})`)
  }
  if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status} from ${endpoint}/json`)
  const targets = await response.json()
  return Array.isArray(targets) ? targets : []
}

export async function findTarget(endpoint, predicate) {
  const targets = await listTargets(endpoint)
  return targets.find(predicate)
}

function isAppUrl(url) {
  if (typeof url !== 'string') return false
  if (url.startsWith('dsh-app://')) return true
  const web = process.env.DSH_WEB_URL
  if (!web) return false
  try {
    return new URL(url).origin === new URL(web).origin
  } catch {
    return false
  }
}

export function findGuestTarget(endpoint) {
  return findTarget(endpoint, (target) => target.type === 'webview')
}

export function findAppTarget(endpoint) {
  return findTarget(endpoint, (target) => target.type === 'page' && isAppUrl(target.url))
}

export async function waitForGuestTarget(endpoint, { timeoutMs = 10000, excludeIds = new Set() } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const targets = await listTargets(endpoint).catch(() => [])
    const guest = targets.find((target) => target.type === 'webview' && !excludeIds.has(target.id))
    if (guest) return guest
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return undefined
}
