/**
 * Lecture Copilot — remembered OneNote destinations.
 *
 * The panel's notebook/page fields are text inputs backed by a datalist, so a
 * person can either type a name or pick one they used before. This module owns
 * that "used before" list.
 *
 * It is a hint, never an authority: every remembered entry is re-validated
 * against the live notebook tree before it is offered, and again before anything
 * is written. A notebook someone renamed or closed must not appear as a choice,
 * and must never become a write target.
 *
 * @module dsh-lecture-copilot/onenote-store
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** How many destinations to remember. Enough to cover a term's courses. */
const MAX_ENTRIES = 24

/**
 * The store file for one Harness home.
 * @param home - the `DSH_HOME` directory.
 * @returns the absolute path.
 */
export function storePath(home) {
  return join(home, 'storages', 'lecture-copilot', 'onenote-destinations.json')
}

/**
 * Read the remembered destinations.
 *
 * A missing or unreadable file is an ordinary first run, not an error.
 * @param home - the `DSH_HOME` directory.
 * @returns `{ notebooks: string[], pages: Array<{ notebook, section, page }> }`.
 */
export async function read(home) {
  try {
    const raw = await readFile(storePath(home), 'utf8')
    const parsed = JSON.parse(raw)
    return {
      notebooks: Array.isArray(parsed.notebooks) ? parsed.notebooks.filter((entry) => typeof entry === 'string') : [],
      pages: Array.isArray(parsed.pages)
        ? parsed.pages.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.page === 'string')
        : [],
    }
  } catch {
    return { notebooks: [], pages: [] }
  }
}

/**
 * Write the remembered destinations.
 * @param home - the `DSH_HOME` directory.
 * @param state - the full state to persist.
 * @returns completion; failures are reported, not thrown.
 */
async function write(home, state) {
  try {
    const path = storePath(home)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * Remember one destination, most recent first.
 * @param home - the `DSH_HOME` directory.
 * @param destination - `{ notebook, section, page }`; `page` may be empty.
 * @returns the updated state.
 */
export async function remember(home, destination) {
  const state = await read(home)
  const notebook = String(destination.notebook ?? '').trim()
  const page = String(destination.page ?? '').trim()
  if (notebook.length === 0) return state

  state.notebooks = [notebook, ...state.notebooks.filter((entry) => entry !== notebook)].slice(0, MAX_ENTRIES)
  if (page.length > 0) {
    const key = `${notebook}\u0000${page}`
    state.pages = [
      { notebook, section: String(destination.section ?? '').trim(), page },
      ...state.pages.filter((entry) => `${entry.notebook}\u0000${entry.page}` !== key),
    ].slice(0, MAX_ENTRIES)
  }
  await write(home, state)
  return state
}

/**
 * Drop one remembered destination.
 * @param home - the `DSH_HOME` directory.
 * @param destination - `{ notebook, page }`.
 * @returns the updated state.
 */
export async function forget(home, destination) {
  const state = await read(home)
  const notebook = String(destination.notebook ?? '').trim()
  const page = String(destination.page ?? '').trim()
  state.notebooks = state.notebooks.filter((entry) => entry !== notebook)
  state.pages = state.pages.filter((entry) => !(entry.notebook === notebook && entry.page === page))
  await write(home, state)
  return state
}

/**
 * Keep only the remembered names that still exist, and report what was dropped.
 *
 * Called on every read of the panel's pickers, so a closed notebook disappears
 * from the choices instead of failing at export time.
 * @param state - the remembered state.
 * @param live - `{ notebooks, sections, pages }` from the live tree.
 * @returns `{ notebooks, pages, dropped }`.
 */
export function reconcile(state, live) {
  const notebookNames = new Set(live.notebooks.map((row) => row.name))
  const pageKeys = new Set(live.pages.map((row) => `${row.notebookName}\u0000${row.name}`))

  const notebooks = state.notebooks.filter((name) => notebookNames.has(name))
  const pages = state.pages.filter((entry) => notebookNames.has(entry.notebook) && pageKeys.has(`${entry.notebook}\u0000${entry.page}`))
  return {
    notebooks,
    pages,
    dropped: {
      notebooks: state.notebooks.filter((name) => !notebooks.includes(name)),
      pages: state.pages.filter((entry) => !pages.includes(entry)),
    },
  }
}

export { MAX_ENTRIES }
