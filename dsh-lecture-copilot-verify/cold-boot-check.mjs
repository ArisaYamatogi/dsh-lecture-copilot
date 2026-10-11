/**
 * Cold-boot readiness check for the installed bundle.
 *
 * Runs in a fresh process, resolves the plugin the way the Loader will (from the
 * profile directory), and asserts the three things a Cordis row needs: it
 * imports, it declares `inject`, and its `Config` validates raw config bodies in
 * the standard-schema shape `Fiber._resolveConfig` calls. Also asserts the
 * browser half resolves, because the client bundle is served from the same
 * package.
 *
 * Usage:
 *   node cold-boot-check.mjs [specifier]
 */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const specifier = process.argv[2] ?? 'dsh-lecture-copilot-plugin'
const profileDir = process.env.USERPROFILE === undefined
  ? undefined
  : join(process.env.USERPROFILE, '.dsh', 'profiles', 'desktop')

let failures = 0
/**
 * Assert one condition.
 * @param label - what is being asserted.
 * @param ok - the result.
 * @param detail - optional context.
 */
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

if (profileDir === undefined) {
  console.log('FAIL: USERPROFILE is not set')
  process.exit(1)
}

const requireFromProfile = createRequire(join(profileDir, 'package.json'))

console.log(`\n1. resolution (specifier ${JSON.stringify(specifier)} from the profile)`)
let entry
try {
  entry = requireFromProfile.resolve(specifier)
  check('the profile resolves the specifier', true)
  console.log(`       -> ${entry}`)
} catch (error) {
  check('the profile resolves the specifier', false, error.code ?? String(error))
  process.exit(1)
}

const packageJson = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8'))
check('the manifest name equals the row specifier', packageJson.name === specifier, `${packageJson.name} vs ${specifier}`)
check('the manifest declares dsh.bundle.patch', typeof packageJson.dsh?.bundle?.patch === 'string')
check('the manifest declares dsh.client.platform=web', packageJson.dsh?.client?.platform === 'web')

console.log('\n2. host half imports')
const mod = await import(pathToFileURL(entry).href)
check('apply is a function', typeof mod.apply === 'function')
check('inject declares speechToText', Array.isArray(mod.inject) && mod.inject.includes('speechToText'), JSON.stringify(mod.inject))
check('name is declared', typeof mod.name === 'string')

console.log('\n3. Config is a standard schema')
const schema = mod.Config?.['~standard']
check('Config exposes ~standard', schema !== undefined)
check('~standard declares version 1', schema?.version === 1)
check('~standard.validate is a function', typeof schema?.validate === 'function')
if (typeof schema?.validate === 'function') {
  const empty = schema.validate({})
  check('an empty config validates', empty.value !== undefined, JSON.stringify(empty))
  check('the empty config carries every default', empty.value?.language === 'en' && empty.value?.maxSegments === 2000, JSON.stringify(empty.value))
  check(
    'both task routes default to the shared route',
    empty.value?.recognitionModel === '' && empty.value?.reviewModel === '',
    JSON.stringify({ recognition: empty.value?.recognitionModel, review: empty.value?.reviewModel }),
  )
  check('the glossary defaults to empty', Array.isArray(empty.value?.glossary) && empty.value.glossary.length === 0)
  const tuned = schema.validate({ language: 'auto', maxSegments: 500, glossary: ['eigenvalue'] })
  check('a tuned config survives', tuned.value?.language === 'auto' && tuned.value?.maxSegments === 500, JSON.stringify(tuned))
  check('a glossary survives', tuned.value?.glossary?.[0] === 'eigenvalue', JSON.stringify(tuned.value?.glossary))
  const badGlossary = schema.validate({ glossary: 'eigenvalue' })
  check('a non-array glossary is rejected', Array.isArray(badGlossary.issues), JSON.stringify(badGlossary))
  const bad = schema.validate({ language: 7 })
  check('a wrong type is rejected', Array.isArray(bad.issues) && bad.issues.length === 1, JSON.stringify(bad))
  const unknown = schema.validate({ nope: 1 })
  check('an unknown field is rejected', Array.isArray(unknown.issues), JSON.stringify(unknown))
  const resolved = mod.resolveConfig?.(tuned.value)
  check('resolveConfig completes the shape', resolved?.provider === '' && resolved?.statusMinMs === 900, JSON.stringify(resolved))
}

console.log('\n4. browser half resolves')
try {
  const client = requireFromProfile.resolve(`${specifier}/client`)
  const source = readFileSync(client, 'utf8')
  check('the ./client export exists', true)
  check('it registers the module factory', source.includes('__ModuleLoader__.load'))
  const idPattern = new RegExp(`id:\\s*['"]${packageJson.name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}['"]`, 'u')
  check('its module id equals the package name', idPattern.test(source), packageJson.name)
  check('it mounts into shell.overlay', source.includes('shell.overlay'))
} catch (error) {
  check('the ./client export resolves', false, error.code ?? String(error))
}

console.log(`\n${failures === 0 ? 'READY' : 'NOT READY'}: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
