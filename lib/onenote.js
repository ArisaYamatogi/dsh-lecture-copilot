/**
 * Lecture Copilot — local OneNote bridge (Host side).
 *
 * OneNote is a desktop application, so the only local, credential-free way to
 * write into it is COM automation. Node cannot host COM, so this module owns the
 * one PowerShell child that can, and speaks JSON to it over stdin/stdout:
 *
 *   list()                          → notebooks → sections → pages
 *   create(sectionId, title, body)  → a new page in that section
 *   update(pageId, title, body)     → in-place replacement of that page
 *
 * Every failure is returned, never thrown at the caller, because "OneNote is not
 * installed" is an ordinary state for a feature that lives behind one button.
 *
 * @module dsh-lecture-copilot/onenote
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
/** The PowerShell half lives beside `lib/`, not inside it. */
const SCRIPT = join(here, '..', 'host', 'onenote.ps1')

/** How long one bridge call may take. OneNote can be slow to wake up. */
const TIMEOUT_MS = 60000

/** One shared child at a time; OneNote serialises internally anyway. */
let queue = Promise.resolve()

/**
 * Locate the PowerShell executable.
 *
 * PowerShell 7 first, then Windows PowerShell. `-ExecutionPolicy Bypass` is
 * passed because the default policy blocks script files, and a feature behind a
 * button must not depend on the machine's policy.
 * @returns the executable name to spawn.
 */
function powershell() {
  return existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'pwsh.exe' : 'powershell.exe'
}

/**
 * Run one bridge request.
 * @param request - the JSON request body.
 * @returns the parsed reply, or `{ ok: false, error }` on any failure.
 */
function call(request) {
  const run = () => new Promise((resolve) => {
    let child
    try {
      child = spawn(
        powershell(),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
    } catch (error) {
      resolve({ ok: false, error: `cannot start PowerShell: ${String(error?.message ?? error)}` })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, error: `OneNote did not answer within ${String(TIMEOUT_MS / 1000)}s` })
    }, TIMEOUT_MS)

    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => finish({ ok: false, error: `PowerShell failed: ${String(error?.message ?? error)}` }))
    child.on('close', (code) => {
      if (process.env.LCP_ONENOTE_TRACE === '1') {
        console.error(`[onenote] exit=${String(code)} stdout=${String(stdout.length)}B stderr=${String(stderr.length)}B`)
      }
      const text = stdout.trim()
      if (text.length === 0 || !text.includes('{')) {
        const detail = stderr.trim().split('\n').map((entry) => entry.trim()).filter((entry) => entry.length > 0).slice(-3).join(' ')
        finish({
          ok: false,
          error: detail.length > 0
            ? `OneNote bridge failed (exit ${String(code)}): ${detail.slice(0, 300)}`
            : `OneNote bridge produced no output (exit ${String(code)})`,
        })
        return
      }
      // The script may print a warning before its JSON; take the last JSON line.
      const line = text.split('\n').map((entry) => entry.trim()).filter((entry) => entry.startsWith('{')).pop()
      if (line === undefined) {
        finish({ ok: false, error: `OneNote bridge returned no JSON: ${text.slice(0, 200)}` })
        return
      }
      try {
        finish({ ...JSON.parse(line), ok: JSON.parse(line).ok !== false })
      } catch (error) {
        finish({ ok: false, error: `OneNote bridge returned invalid JSON: ${String(error?.message ?? error)}` })
      }
    })

    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(request), 'utf8')
  })

  // Serialize: one OneNote COM session at a time keeps the replies unambiguous.
  queue = queue.then(run, run)
  return queue
}

/**
 * Read the local notebook tree.
 * @returns `{ ok, notebooks?, error? }`.
 */
export function list() {
  return call({ op: 'list' })
}

/**
 * Create a page and write its content.
 * @param options - `sectionId`, `title`, and `body` (OneNote XML).
 * @returns `{ ok, pageId?, pageName?, url?, error? }`.
 */
export function create(options) {
  return call({ op: 'create', sectionId: options.sectionId, title: options.title, body: options.body })
}

/**
 * Read one page's plain text back.
 *
 * Used to verify an addition landed and to show the person what a remembered
 * page currently holds. Read-only, like everything else here except `create` and
 * `append`.
 *
 * @param options - `pageId`.
 * @returns `{ ok, pageName?, text?, elements?, error? }`.
 */
export function readPage(options) {
  return call({ op: 'read', pageId: options.pageId })
}

/**
 * Append content to an existing page, keeping everything already on it.
 *
 * The bridge reads the page, adds one `one:Outline`, and writes the page back,
 * so nothing that was there can be lost. There is deliberately no call that
 * replaces a page and no call that removes one: this feature only ever adds.
 *
 * @param options - `pageId`, `stamp` (heading for this addition), and `body`.
 * @returns `{ ok, pageId?, pageName?, url?, mode?, error? }`.
 */
export function append(options) {
  return call({ op: 'append', pageId: options.pageId, stamp: options.stamp, body: options.body })
}

/**
 * Flatten the notebook tree into the rows the panel's pickers render.
 * @param notebooks - the `list()` reply's notebooks.
 * @returns `{ notebooks, sections, pages }`, each sorted for display.
 */
export function flatten(notebooks) {
  const byName = (left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN')
  const rows = { notebooks: [], sections: [], pages: [] }
  for (const notebook of notebooks ?? []) {
    rows.notebooks.push({ id: notebook.id, name: notebook.name })
    for (const section of notebook.sections ?? []) {
      rows.sections.push({ id: section.id, name: section.name, notebookId: notebook.id, notebookName: notebook.name })
      for (const page of section.pages ?? []) {
        rows.pages.push({
          id: page.id,
          name: page.name,
          sectionId: section.id,
          sectionName: section.name,
          notebookId: notebook.id,
          notebookName: notebook.name,
        })
      }
    }
  }
  rows.notebooks.sort(byName)
  rows.sections.sort(byName)
  rows.pages.sort(byName)
  return rows
}

/**
 * Match one typed string against a list of named rows.
 *
 * Matching is deliberately forgiving — case-insensitive, and a substring hit is
 * enough — because the person is typing a notebook name from memory while a
 * lecture is running. An exact (case-insensitive) hit always wins over a partial
 * one, so a name that happens to be a prefix of another still resolves to itself.
 *
 * A missing query never matches. Note that `String(undefined)` is the non-empty
 * `"undefined"`, which would otherwise sub-string-match a page someone really
 * named that way and turn an empty field into a write target.
 *
 * @param query - what the person typed.
 * @param rows - rows carrying `name`.
 * @returns the matched row, or `undefined`.
 */
export function matchByName(query, rows) {
  if (typeof query !== 'string') return undefined
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return undefined
  const exact = rows.find((row) => row.name.toLowerCase() === needle)
  if (exact !== undefined) return exact
  return rows.find((row) => row.name.toLowerCase().includes(needle))
}

export { SCRIPT, TIMEOUT_MS }
