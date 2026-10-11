/**
 * Verify the client half loads the way the running Host loads it.
 *
 * The Host resolves a bundle's client entry from the *profile* directory and
 * hands the resolved URL to the browser, so two things must hold for a restart to
 * pick up a panel change:
 *
 *   1. the profile can resolve `dsh-lecture-copilot-plugin/client` at all
 *   2. the file that resolves to is byte-identical to the one in the workspace
 *
 * Point 2 is the one that actually bites: the profile links the workspace, so a
 * stale copy, a missing `files` entry, or an `exports` typo would keep serving
 * the previous panel and look like "my change did nothing".
 *
 * Usage:
 *   set ELECTRON_RUN_AS_NODE=1
 *   "…\DeepSeek Harness.exe" bundle-resolve-check.mjs
 */

import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspace = join(here, '..')
const pluginDir = join(workspace, 'dsh-lecture-copilot')
const profileDir = join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop')

let checks = 0
let failures = 0
/**
 * Assert one condition.
 * @param label - what is being asserted.
 * @param condition - the result.
 * @param detail - optional context.
 */
function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** SHA-256 of a file, for comparing what two paths really contain. */
function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

console.log('\n1. the profile declares the bundle')
const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
const bundles = profile.dsh?.profile?.bundles ?? []
check('the bundle is listed in the profile', bundles.includes('dsh-lecture-copilot-plugin'), JSON.stringify(bundles))
check(
  'the dependency is a link to the workspace',
  String(profile.dependencies?.['dsh-lecture-copilot-plugin'] ?? '').includes('dsh-lecture-copilot'),
  String(profile.dependencies?.['dsh-lecture-copilot-plugin']),
)

console.log('\n2. the profile resolves the client entry')
const require = createRequire(join(profileDir, 'index.js'))
let resolvedClient = null
try {
  resolvedClient = require.resolve('dsh-lecture-copilot-plugin/client')
} catch (error) {
  check('the client entry resolves from the profile', false, String(error.message))
}
if (resolvedClient !== null) {
  check('the client entry resolves from the profile', true)
  check('it resolves to the workspace file', realpathSync(resolvedClient) === realpathSync(join(pluginDir, 'lib', 'client.js')), resolvedClient)
  check('the resolved file is identical to the workspace copy', digest(resolvedClient) === digest(join(pluginDir, 'lib', 'client.js')))
}

console.log('\n3. the host entry resolves too')
let resolvedHost = null
try {
  resolvedHost = require.resolve('dsh-lecture-copilot-plugin')
  check('the host entry resolves from the profile', true)
  check('it resolves to the workspace file', realpathSync(resolvedHost) === realpathSync(join(pluginDir, 'lib', 'index.js')), resolvedHost)
} catch (error) {
  check('the host entry resolves from the profile', false, String(error.message))
}

console.log('\n4. the served client modules actually carry the current panel')
// These are the markers of the last round of panel fixes. If any is missing, the
// browser will keep rendering the previous panel after a restart.
const clientSource = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8')
const markers = [
  ['the panel-drawn candidate list', 'lcp-options'],
  ['the list container scrolls', 'overflow-y:auto'],
  ['the list button shows a count', 'lcp-caret'],
  ['the + button is in the action row', '＋ 新建页面'],
  ['the model picker names the provider', 'option.providerName'],
  ['the export dialog guards a null tree', 'view === null || view === undefined'],
]
for (const [label, marker] of markers) {
  check(label, clientSource.includes(marker), marker)
}
check('no datalist remains, since it could not be opened', !clientSource.includes("h('datalist'"))

console.log('\n5. the bundle would load as an ES module')
// The Host imports the resolved URL; a syntax error here is what a restart would
// report, so it is worth catching before asking for one.
try {
  await import(`${pathToFileURL(join(pluginDir, 'lib', 'index.js')).href}?probe=${String(Date.now())}`)
  check('the host entry imports', true)
} catch (error) {
  check('the host entry imports', false, String(error.message))
}

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
process.exit(failures === 0 ? 0 : 1)
