/**
 * dsh-browser-use — ZCode's browser-use runtime, hosted by DeepSeek Harness.
 *
 * Rows contributed by this plugin:
 *   - the `js` cell tool (registered as `mcp__node_repl__js`), which builds
 *     `agent.browsers` from the verbatim ZCode client in `scripts/browser-client.mjs`
 *   - the `control-browser` and `web-gui-tester` skills
 *
 * The browser it drives is DSH's own right-Sidebar Browser tab, reached over the
 * DevTools Protocol, so the endpoint only exists while DSH runs with
 * `--remote-debugging-port`.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { BrowserBackend } from './backend-cdp.js'
import { runCell, defaultImageDir } from './repl.js'

const PROVIDER_NAME = 'dsh-browser-use'
const PLUGIN_ROOT = fileURLToPath(new URL('../', import.meta.url))
const DOCS_DIR = fileURLToPath(new URL('../docs/', import.meta.url))

/** The `js` tool id the ZCode skills document. */
const PREFERRED_TOOL_NAME = 'mcp__node_repl__js'
const FALLBACK_TOOL_NAME = 'node_repl_js'

export const name = 'browser-use'

export const inject = ['tools', 'skills', 'systemPrompt', 'agents']

const SKILLS = [
  {
    name: 'control-browser',
    description:
      'Drive the DeepSeek Harness right-Sidebar browser from a JavaScript cell: navigate, read the ARIA snapshot, click and type through Playwright locators, capture screenshots, and verify visible page state. Use for any web page, local HTTP target, or rendered-page scraping inside DSH.',
    file: 'control-browser/SKILL.md',
  },
  {
    name: 'web-gui-tester',
    description:
      'Black-box GUI testing workflow layered on control-browser: turn a user-facing requirement into evidence-backed steps, assert visible state, capture screenshots, and report passed/failed/blocked without inventing results.',
    file: 'web-gui-tester/SKILL.md',
  },
]

const RESOURCE_BASE = { kind: 'directory', path: PLUGIN_ROOT }

/**
 * `defineTool` lives in the DSH installation, not in the profile's node_modules,
 * so a bare specifier only resolves when pnpm happened to provide it as a peer.
 * The running host process knows where the installation is (`argv[1]` is the
 * desktop-host entry inside app.asar), so resolve from there as well.
 */
async function resolveDshTools() {
  const candidates = ['@deepseek-ai/dsh-tools']
  const hostEntry = process.argv[1]
  if (typeof hostEntry === 'string' && hostEntry.includes('app.asar')) {
    const dshRoot = dirname(dirname(dirname(hostEntry)))
    candidates.push(join(dshRoot, '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  }
  if (typeof process.resourcesPath === 'string') {
    candidates.push(join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))
  }

  const failures = []
  for (const candidate of candidates) {
    const specifier = candidate.startsWith('/') || /^[A-Za-z]:[\\/]/.test(candidate)
      ? pathToFileURL(candidate).href
      : candidate
    try {
      const loaded = await import(specifier)
      if (typeof loaded.defineTool === 'function') return loaded
      failures.push(`${specifier}: no defineTool export`)
    } catch (error) {
      failures.push(`${specifier}: ${error?.message ?? error}`)
    }
  }
  throw new Error(`dsh-browser-use cannot load @deepseek-ai/dsh-tools (${failures.join(' | ')})`)
}

/**
 * The Session that initiated this tool call. The agent service carries the
 * initiating Agent through the driver chain, which is exactly this question.
 */
function callingSessionId(ctx) {
  try {
    const agent = ctx.agents?.currentInitiator?.()
    if (!agent) return undefined
    return (
      agent.sessionId ??
      agent.session?.sessionId ??
      agent.session?.id ??
      agent.id ??
      agent.header?.id ??
      undefined
    )
  } catch {
    return undefined
  }
}

function createSkillProvider() {  const candidates = SKILLS.map((skill) => ({ ...skill, locator: new URL(`../skills/${skill.file}`, import.meta.url) }))
  return {
    name: PROVIDER_NAME,
    list() {
      return Promise.resolve(
        candidates.map((candidate) => ({
          name: candidate.name,
          description: candidate.description,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: PROVIDER_NAME,
          source: 'bundled',
          resourceBase: RESOURCE_BASE,
          rank: 610,
          locator: candidate.locator,
        })),
      )
    },
    async get(candidate) {
      const match = candidates.find((entry) => entry.name === candidate.name)
      if (!match) throw new Error(`Unknown skill '${candidate.name}'`)
      return {
        name: match.name,
        description: match.description,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: PROVIDER_NAME,
        source: 'bundled',
        resourceBase: RESOURCE_BASE,
        content: await readFile(match.locator, 'utf8'),
      }
    },
  }
}

export async function apply(ctx, config) {
  const { defineTool } = await resolveDshTools()

  // An empty endpoint means "discover it": the backend reads the running app's
  // DevToolsActivePort and probes the usual ports. A stale listener can hold a
  // configured port (TCP connects, nothing answers), so no port is assumed here.
  const endpoint = process.env.DSH_BROWSER_USE_CDP ?? config?.endpoint ?? ''

  // The control-browser skill bootstraps from this variable and imports
  // <root>/scripts/browser-client.mjs, so it must point at this package.
  process.env.ZCODE_PLUGIN_ROOT ??= PLUGIN_ROOT

  const backend = new BrowserBackend({
    endpoint,
    docsRoot: DOCS_DIR,
    // Which Session asked. The Sidebar controller only draws the Session on
    // screen, so this is what keeps one Session's browsing out of another's.
    callerSessionId: () => callingSessionId(ctx),
  })
  const bridge = {
    /** Availability is reported per call as `backend_unavailable`, never faked. */
    assertAvailable() {},
    documentationRoot: DOCS_DIR,
    list: () => backend.list(),
    execute: (browserId, generation, command) => backend.execute(browserId, generation, command),
  }

  ctx.skills.registerProvider(() => createSkillProvider())

  const toolName = registerCellTool(ctx, defineTool, { endpoint, bridge })

  ctx.systemPrompt.section({
    name: 'tool:browser-use',
    order: 118,
    text:
      `The browser lives in this window's right Sidebar and is driven from a JavaScript cell: call \`${toolName}\` with \`code\`. ` +
      'Every call starts a fresh kernel — bindings do not persist, so re-run the skill bootstrap in each cell and recover tabs from ' +
      '`browser.tabs.list()`. Read the `control-browser` skill before browser work; it owns the snapshot → locator → act workflow, ' +
      'the evidence rules, and the unsupported-capability list. ' +
      'The runtime attaches to this window’s own Sidebar Browser tab over the DevTools Protocol; the live endpoint is ' +
      'discovered at call time, and when no endpoint answers the cell fails with the exact setup error instead of ' +
      'pretending a browser exists.',
  })
}

function registerCellTool(ctx, defineTool, { endpoint, bridge }) {
  const build = (toolName) =>
    defineTool({
      name: toolName,
      description:
        "Run JavaScript in a fresh kernel that exposes ZCode's browser-use object model: `agent.browsers`, `agent.documentation`, " +
        'and `nodeRepl.write/emitImage`. Returns the value of the final expression plus anything written. ' +
        'Read the control-browser skill first; it contains the bootstrap, the tab registry protocol and the locator workflow. ' +
        'Browsers are this window’s right-Sidebar tabs, reached over the DevTools Protocol on an endpoint discovered at call time.',
      parameters: {
        code: {
          type: 'string',
          required: true,
          description:
            'JavaScript source for this cell. Top-level await is allowed; the final expression becomes the result.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        if (typeof args.code !== 'string' || args.code.trim() === '') {
          throw new Error('code is required')
        }
        const { text, images } = await runCell(args.code, {
          bridge,
          pluginRoot: PLUGIN_ROOT,
          imageDir: defaultImageDir(),
        })
        const parts = []
        if (text) parts.push(text)
        for (const file of images) parts.push(`[image emitted: ${file}]`)
        if (parts.length === 0) parts.push('(cell completed with no output)')
        return parts.join('\n')
      },
    })

  try {
    ctx.tools.register(build(PREFERRED_TOOL_NAME))
    return PREFERRED_TOOL_NAME
  } catch {
    ctx.tools.register(build(FALLBACK_TOOL_NAME))
    return FALLBACK_TOOL_NAME
  }
}
