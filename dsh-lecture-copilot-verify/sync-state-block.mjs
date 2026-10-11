/**
 * Copy the state block from `lib/state.js` into `lib/client.js`, byte-for-byte
 * apart from indentation.
 *
 * The client bundle cannot import the module — a profile-installed bundle only
 * resolves the platform table — so the block is inlined there, and the test
 * suite fails if the two ever differ. Regenerating it from the module is the
 * only reliable way to keep that promise after an edit.
 *
 * Usage: node sync-state-block.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'dsh-lecture-copilot', 'lib')
const START = 'const store = {'
const END = '/* ------------------------------------------------------- end of state block */'

const moduleText = readFileSync(join(lib, 'state.js'), 'utf8')
const clientText = readFileSync(join(lib, 'client.js'), 'utf8')

const moduleStart = moduleText.indexOf(START)
const moduleEnd = moduleText.indexOf(END)
if (moduleStart < 0 || moduleEnd < 0) {
  console.error('state.js is missing the state block or its end marker')
  process.exit(1)
}

const clientStart = clientText.indexOf(START)
const clientEnd = clientText.indexOf(END)
if (clientStart < 0 || clientEnd < 0) {
  console.error('client.js is missing the state block or its end marker')
  process.exit(1)
}

// The module sits at 2-space indent inside its file; the inlined copy sits one
// level deeper inside the module factory, so every line gains four spaces.
const block = moduleText.slice(moduleStart, moduleEnd)
const reindented = block
  .split('\n')
  .map((line) => (line.trim().length === 0 ? line : `    ${line}`))
  .join('\n')

const next = clientText.slice(0, clientStart) + reindented + clientText.slice(clientEnd)
writeFileSync(join(lib, 'client.js'), next, 'utf8')
console.log(`state block copied into client.js (${String(reindented.length)} characters)`)
