window.__ModuleLoader__.load({
  id: 'dsh-browser-use',
  factory: (require) => {
    const module = { exports: {} }

    /**
     * The Sidebar bridge.
     *
     * The Host half drives this module over the DevTools Protocol, but `ctx` and
     * the Sidebar controller exist only in this renderer, so the Host cannot open
     * a tab by itself:
     *
     *   window.__dshBrowserBridge.openTab('https://example.com', { sessionId })
     *
     * Session isolation is FAIL-CLOSED here. `ctx.sidebarRight` is a view
     * controller whose commands act on the Session on screen, so a tab opened on
     * behalf of Session A while the user watches Session B would land in B's
     * Sidebar. Rather than guess, this bridge refuses unless it can prove the
     * caller is the Session on screen. `probe()` exists so the Host can learn the
     * live shape of the controller without writing to the UI.
     */
    function valueOf(candidate) {
      if (typeof candidate === 'function') {
        try {
          return candidate()
        } catch {
          return undefined
        }
      }
      if (candidate && typeof candidate === 'object') {
        for (const accessor of ['getSnapshot', 'get', 'current', 'peek', 'value', 'snapshot']) {
          if (typeof candidate[accessor] === 'function') {
            try {
              const value = candidate[accessor]()
              if (value !== undefined) return value
            } catch {}
          } else if (candidate[accessor] !== undefined) {
            return candidate[accessor]
          }
        }
      }
      return candidate
    }

    function idOf(value) {
      if (!value) return undefined
      if (typeof value === 'string') return value
      return value.sessionId ?? value.session?.id ?? value.id ?? undefined
    }

    /** The Session on screen, per the Sidebar controller. */
    function visibleSessionId(scope) {
      try {
        return idOf(valueOf(scope.sidebarRight?.mounted))
      } catch {
        return undefined
      }
    }

    function describe(value, depth = 0) {
      const type = value === null ? 'null' : typeof value
      if (type !== 'object') return { type }
      const keys = Object.keys(value).slice(0, 24)
      const detail = { type, keys }
      if (depth < 1) {
        const resolved = valueOf(value)
        if (resolved !== value && resolved !== undefined) detail.resolved = describe(resolved, depth + 1)
      }
      return detail
    }

    function apply(ctx) {
      const publish = (scope) => {
        const openTab = (url, options = {}) => {
          if (typeof url !== 'string' || url === '') {
            throw new Error('openTab requires a URL string')
          }
          const visible = visibleSessionId(scope)
          const caller = typeof options.sessionId === 'string' && options.sessionId !== '' ? options.sessionId : undefined

          if (!visible) {
            const error = new Error(
              'session_unknown: the Sidebar controller did not report which Session is on screen, so this runtime cannot prove ' +
                'the tab would land in the calling Session. Refusing instead of opening it in an unrelated Session. ' +
                'Run probe() and report the shape.',
            )
            error.code = 'session_unknown'
            throw error
          }
          if (!caller) {
            const error = new Error(
              'session_unknown_caller: the Host did not say which Session called, so this runtime cannot prove the target ' +
                'Session. Refusing to open a tab in whichever Session is visible.',
            )
            error.code = 'session_unknown_caller'
            throw error
          }
          if (caller !== visible) {
            const error = new Error(
              `session_mismatch: this call came from Session ${caller}, but the Sidebar is showing ${visible}. ` +
                'Open that Session first, otherwise the tab would land in an unrelated Session.',
            )
            error.code = 'session_mismatch'
            throw error
          }
          scope.sidebarRight.openTab('browser', { params: { url } })
          return { ok: true, url, sessionId: caller }
        }

        const bridge = {
          version: 3,
          openTab,
          /**
           * M2 spike: can the `<webview>` element API replace raw CDP?
           *
           * This runs entirely in the renderer — no DevTools endpoint, no host
           * round trip. It reports which element methods exist and what they
           * return for the first Browser tab. Read-only: it never dispatches
           * input, so it cannot disturb the page a user is watching.
           */
          async spike() {
            const result = { at: new Date().toISOString(), webviews: 0 }
            const webviews = Array.from(document.querySelectorAll('webview'))
            result.webviews = webviews.length
            const view = webviews[0]
            if (!view) {
              result.skipped = 'no <webview> mounted; open a Browser tab in the right Sidebar'
              window.__dshSpike = result
              return result
            }
            const call = (fn) => {
              try {
                return fn()
              } catch (error) {
                return `ERR ${error && error.message}`
              }
            }
            result.methods = {
              executeJavaScript: typeof view.executeJavaScript,
              capturePage: typeof view.capturePage,
              sendInputEvent: typeof view.sendInputEvent,
              setZoomFactor: typeof view.setZoomFactor,
              loadURL: typeof view.loadURL,
              getURL: typeof view.getURL,
              getTitle: typeof view.getTitle,
              getWebContentsId: typeof view.getWebContentsId,
              insertCSS: typeof view.insertCSS,
            }
            result.getURL = call(() => view.getURL())
            result.getTitle = call(() => view.getTitle())
            result.webContentsId = call(() => view.getWebContentsId())
            try {
              result.executeJavaScript = await view.executeJavaScript(
                `JSON.stringify({ title: document.title, links: document.querySelectorAll('a').length,
                   h1: (document.querySelector('h1') || {}).textContent || null,
                   ready: document.readyState })`,
              )
            } catch (error) {
              result.executeJavaScriptError = String(error && error.message)
            }
            try {
              const image = await view.capturePage()
              result.capturePage = {
                size: image && image.getSize ? image.getSize() : null,
                pngBytes: image && image.toPNG ? image.toPNG().length : null,
              }
            } catch (error) {
              result.capturePageError = String(error && error.message)
            }
            window.__dshSpike = result
            return result
          },
          /** What the Sidebar currently shows, for diagnostics. */
          state() {
            const active = scope.sidebarRight.active()
            return {
              expanded: scope.sidebarRight.isExpanded(),
              visibleSessionId: visibleSessionId(scope) ?? null,
              active: active ? { id: active.id, kind: active.kind } : null,
            }
          },
          /** Read-only shape dump: what this scope actually exposes. */
          probe() {
            const mountedValue = (() => {
              try {
                const resolved = valueOf(scope.sidebarRight.mounted)
                if (!resolved || typeof resolved !== 'object') return { type: typeof resolved }
                const picked = {}
                for (const key of ['id', 'sessionId', 'title', 'cwd', 'session']) {
                  if (resolved[key] !== undefined) {
                    picked[key] =
                      typeof resolved[key] === 'object' ? describe(resolved[key]) : String(resolved[key]).slice(0, 60)
                  }
                }
                return { keys: Object.keys(resolved).slice(0, 24), picked }
              } catch (error) {
                return { error: String(error && error.message) }
              }
            })()
            return {
              scopeKeys: Object.keys(scope).slice(0, 40),
              sidebarRightKeys: Object.keys(scope.sidebarRight).slice(0, 40),
              mounted: describe(scope.sidebarRight.mounted),
              mountedValue,
              visibleSessionId: visibleSessionId(scope) ?? null,
              active: (() => {
                try {
                  const active = scope.sidebarRight.active()
                  return active ? { keys: Object.keys(active), id: active.id, kind: active.kind } : null
                } catch (error) {
                  return { error: String(error && error.message) }
                }
              })(),
            }
          },
          expand() {
            if (!scope.sidebarRight.isExpanded()) scope.sidebarRight.toggleExpanded()
            return { expanded: scope.sidebarRight.isExpanded() }
          },
          close(tabId) {
            scope.sidebarRight.close(tabId)
            return { ok: true }
          },
        }

        window.__dshBrowserBridge = bridge

        // The M2 capability spike is diagnostics, not a feature: it only runs when
        // asked for, so a normal load does no unrequested work.
        //   localStorage['dsh-browser-use:spike'] = '1'  → reload → window.__dshSpike
        // Guarded: this module is also loaded by the unit tests, which have no DOM.
        let timer
        if (typeof document !== 'undefined' && typeof setInterval === 'function') {
          let enabled = false
          try {
            enabled = window.localStorage?.getItem('dsh-browser-use:spike') === '1'
          } catch {}
          if (enabled) {
            let attempts = 0
            timer = setInterval(() => {
              attempts += 1
              if (window.__dshSpike || attempts > 300) {
                clearInterval(timer)
                return
              }
              if (document.querySelector('webview')) {
                clearInterval(timer)
                bridge.spike().catch(() => {})
              }
            }, 500)
          }
        }

        scope.effect(() => () => {
          if (timer !== undefined) clearInterval(timer)
          if (window.__dshBrowserBridge === bridge) delete window.__dshBrowserBridge
        })
      }

      if (typeof ctx.inject === 'function') ctx.inject(['sidebarRight'], publish)
      else publish(ctx)
    }

    module.exports.apply = apply
    module.exports.inject = []
    return module.exports
  },
})
