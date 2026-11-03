/**
 * dsh-browser-use — the cell runner behind the `js` tool.
 *
 * ZCode's browser-client assumes each call runs in a fresh JavaScript kernel:
 * bindings, imports and module cache do not persist, and continuity lives in the
 * persistent Browser tabs instead. This module reproduces that contract inside
 * the DSH host process:
 *
 *   - every cell gets a fresh `agent` binding and a fresh `nodeRepl` binding
 *   - the browser bridge is re-installed under the exact symbol ZCode reads
 *   - the value of the final expression becomes the cell's result
 *
 * It deliberately does not use `node:vm`: the bridge hands out live objects (the
 * browser facade, Playwright pages) and a separate realm would need
 * `--experimental-vm-modules` for the dynamic `import()` the skill bootstrap
 * performs. A fresh async-function scope gives the same observable semantics
 * without imposing a launch flag on the whole application.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { installBrowserRuntime } from './facade.js'

const AsyncFunction = async function () {}.constructor

/** Statements whose trailing expression must not be turned into a `return`. */
const NON_EXPRESSION_HEADS = [
  'const ',
  'let ',
  'var ',
  'function ',
  'class ',
  'if ',
  'if(',
  'for ',
  'for(',
  'while ',
  'while(',
  'do ',
  'switch ',
  'switch(',
  'try ',
  'try{',
  'return',
  'throw ',
  'import ',
  'export ',
  'debugger',
]

/**
 * Split off the trailing top-level statement so the cell can return its value.
 * Only semicolons at bracket depth 0 and the final non-empty line are treated as
 * boundaries; the caller verifies the split by compiling it.
 */
function splitTrailingStatement(source) {
  const boundaries = []
  let depth = 0
  let index = 0

  while (index < source.length) {
    const char = source[index]
    if (char === '/' && source[index + 1] === '/') {
      const end = source.indexOf('\n', index)
      index = end === -1 ? source.length : end
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      index = end === -1 ? source.length : end + 2
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(source, index)
      continue
    }
    if (char === '(' || char === '[' || char === '{') depth += 1
    else if (char === ')' || char === ']' || char === '}') depth -= 1
    else if (depth === 0 && (char === ';' || char === '\n')) boundaries.push(index)
    index += 1
  }

  const segments = []
  let previous = 0
  for (const boundary of boundaries) {
    segments.push({ start: previous, end: boundary })
    previous = boundary + 1
  }
  segments.push({ start: previous, end: source.length })

  // Walk backwards to the last segment that holds anything but whitespace and a
  // trailing semicolon; that statement is the cell's value.
  for (let cursor = segments.length - 1; cursor >= 0; cursor -= 1) {
    const segment = segments[cursor]
    const text = source
      .slice(segment.start, segment.end)
      .replace(/^\s+/, '')
      .replace(/;\s*$/, '')
      .trim()
    if (text !== '') {
      return { head: source.slice(0, segment.start), tail: text }
    }
  }
  return { head: source, tail: '' }
}

function skipString(source, start) {
  const quote = source[start]
  let index = start + 1
  while (index < source.length) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === quote) return index + 1
    if (quote === '`' && char === '$' && source[index + 1] === '{') {
      index += 2
      let depth = 1
      while (index < source.length && depth > 0) {
        const inner = source[index]
        if (inner === '{') depth += 1
        else if (inner === '}') depth -= 1
        else if (inner === '"' || inner === "'" || inner === '`') {
          index = skipString(source, index)
          continue
        }
        index += 1
      }
      continue
    }
    index += 1
  }
  return source.length
}

function startsWithNonExpression(tail) {
  const trimmed = tail.trimStart()
  return NON_EXPRESSION_HEADS.some((prefix) => trimmed.startsWith(prefix))
}

/** Pick the cell body: return the trailing expression when it compiles as one. */
export function buildCellBody(source) {
  const code = String(source ?? '')
  const { head, tail } = splitTrailingStatement(code)
  if (tail !== '' && !startsWithNonExpression(tail)) {
    const candidate = `${head}\nreturn (${tail});\n`
    try {
      new AsyncFunction(candidate)
      return candidate
    } catch {}
  }
  new AsyncFunction(code)
  return code
}

function formatValue(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  try {
    const json = JSON.stringify(value, null, 2)
    return json === undefined ? String(value) : json
  } catch {
    return String(value)
  }
}

class NodeRepl {
  constructor() {
    this.lines = []
    this.images = []
  }

  /** `nodeRepl.write(value)` — the cell's model-visible text output. */
  write(value) {
    this.lines.push(formatValue(value))
    return value
  }

  /** `nodeRepl.emitImage(bytes)` — inline evidence, saved next to the session temp dir. */
  emitImage(bytes) {
    if (bytes != null) this.images.push(bytes)
    return bytes
  }
}

/**
 * Run one cell.
 *
 * @returns {{ text: string, images: string[] }} text is the model-visible result,
 * images are absolute PNG paths written for the `read_image` tool.
 */
export async function runCell(source, options) {
  const { host, documentation, imageDir } = options
  const repl = new NodeRepl()

  // Fresh bindings every cell: a new `agent` and a new facade, no leftovers.
  // `agent.browsers` is installed here, so a cell never has to import anything.
  globalThis.agent = {}
  globalThis.nodeRepl = repl
  installBrowserRuntime({ globals: globalThis, host, documentation })

  const body = buildCellBody(source)
  const fn = new AsyncFunction(body)
  const value = await fn()

  const text = [...repl.lines]
  if (value !== undefined) text.push(formatValue(value))

  const images = []
  if (repl.images.length > 0) {
    await mkdir(imageDir, { recursive: true })
    let index = 0
    for (const image of repl.images) {
      index += 1
      const file = join(imageDir, `shot-${Date.now()}-${index}.png`)
      await writeFile(file, Buffer.isBuffer(image) ? image : Buffer.from(image))
      images.push(file)
    }
  }

  return { text: text.join('\n'), images }
}

export function defaultImageDir() {
  return join(tmpdir(), 'dsh-browser-use')
}
