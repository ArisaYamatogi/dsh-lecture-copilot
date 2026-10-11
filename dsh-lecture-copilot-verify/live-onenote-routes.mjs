/**
 * Drive the running Harness's own HTTP routes for the OneNote export.
 *
 * The earlier suites prove two halves separately: `verify.mjs` runs the route
 * handlers in-process with a fake bridge, and `onenote-probe.mjs` drives the real
 * bridge directly. This one closes the gap — it talks to the **live server** on
 * its real port with the real bridge and the real OneNote behind it.
 *
 * Every check here is non-destructive: refusals are requested, and the one
 * accepted write targets a page the caller names. Nothing is deleted, and there
 * is no cleanup, because the feature has no delete path by design.
 *
 * Usage:
 *   set ELECTRON_RUN_AS_NODE=1
 *   "…\DeepSeek Harness.exe" live-onenote-routes.mjs [--base http://127.0.0.1:19387]
 *   "…\DeepSeek Harness.exe" live-onenote-routes.mjs --append --notebook JNU --page "页名"
 */

const argv = process.argv.slice(2)
/**
 * Read one `--flag value` pair.
 * @param flagName - the flag without dashes.
 * @returns its value, or `undefined`.
 */
const flag = (flagName) => {
  const index = argv.indexOf(`--${flagName}`)
  return index < 0 ? undefined : argv[index + 1]
}

const BASE = (flag('base') ?? 'http://127.0.0.1:19387').replace(/\/$/u, '')
const PREFIX = '/lecture-copilot'

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

/**
 * Call one live route.
 * @param path - route path below the plugin prefix.
 * @param options - `method` and optional JSON `body`.
 * @returns `{ status, json }`.
 */
async function call(path, options = {}) {
  const response = await fetch(`${BASE}${PREFIX}${path}`, {
    method: options.method ?? 'GET',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: response.status, json, text }
}

console.log(`\nlive server: ${BASE}`)

console.log('\n1. the plugin is up on the running server')
const health = await call('/health')
check('the health route answers 200', health.status === 200, String(health.status))
check('it names the plugin', health.json?.plugin === 'dsh-lecture-copilot', JSON.stringify(health.json)?.slice(0, 120))
check('the web carrier is mounted', health.json?.services?.webServer === true, JSON.stringify(health.json?.services))

console.log('\n2. the export route exists on the running server')
const tree = await call('/onenote')
check('the notebook route answers 200', tree.status === 200, String(tree.status))
if (tree.status !== 200) {
  console.log('\n  the running build predates the OneNote routes; restart the Harness and re-run.')
  console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
  process.exit(1)
}
check('it reports OneNote as available', tree.json?.available === true, JSON.stringify(tree.json)?.slice(0, 160))
check('real notebooks came back', (tree.json?.notebooks ?? []).length > 0, JSON.stringify(tree.json?.notebooks))
check('real pages came back', (tree.json?.pages ?? []).length > 0, String((tree.json?.pages ?? []).length))
console.log(`       ${String(tree.json.notebooks.length)} notebooks, ${String(tree.json.pages.length)} pages, ${String(tree.json.rememberedNotebooks.length)} remembered`)

console.log('\n3. an unknown notebook is refused by the live server, and nothing is written')
const bogusNotebook = await call('/onenote/export', { method: 'POST', body: { notebook: '肯定不存在的本子-zzz', page: '随便' } })
check('it answers 200 with a refusal', bogusNotebook.status === 200 && bogusNotebook.json?.ok === false, JSON.stringify(bogusNotebook.json))
check('the refusal names the notebook as missing', String(bogusNotebook.json?.error ?? '').includes('笔记本不存在'), String(bogusNotebook.json?.error))
check('no destination is reported, so nothing was written', bogusNotebook.json?.page === undefined && bogusNotebook.json?.url === undefined, JSON.stringify(bogusNotebook.json))

console.log('\n4. an unknown page is refused by the live server')
const realNotebook = tree.json.notebooks[0]
const bogusPage = await call('/onenote/export', { method: 'POST', body: { notebook: realNotebook, page: '这一页肯定不存在-zzz' } })
check('it answers 200 with a refusal', bogusPage.status === 200 && bogusPage.json?.ok === false, JSON.stringify(bogusPage.json))
check('the refusal names the page as missing', String(bogusPage.json?.error ?? '').includes('没有这个页面'), String(bogusPage.json?.error))
check('nothing was written', bogusPage.json?.mode === undefined, JSON.stringify(bogusPage.json))

console.log('\n5. the new-page route refuses an unknown notebook too')
const bogusNew = await call('/onenote/new-page', { method: 'POST', body: { notebook: '肯定不存在的本子-zzz' } })
check('it answers 200 with a refusal', bogusNew.status === 200 && bogusNew.json?.ok === false, JSON.stringify(bogusNew.json))
check('it names the notebook as missing', String(bogusNew.json?.error ?? '').includes('笔记本不存在'), String(bogusNew.json?.error))
check('no page was created', bogusNew.json?.page === undefined, JSON.stringify(bogusNew.json))

console.log('\n6. the remembered list is served to the picker')
check('the field exists', Array.isArray(tree.json.rememberedNotebooks), JSON.stringify(tree.json.rememberedNotebooks))
check('the page field exists', Array.isArray(tree.json.rememberedPages), JSON.stringify(tree.json.rememberedPages))
const onDisk = await call('/onenote')
check(
  'the picker gets the whole catalogue every time',
  (onDisk.json?.pages ?? []).length === (tree.json?.pages ?? []).length,
  `${String((onDisk.json?.pages ?? []).length)} vs ${String((tree.json?.pages ?? []).length)}`,
)

if (!argv.includes('--append')) {
  console.log(`\n${String(checks - failures)}/${String(checks)} checks passed (live, non-destructive)`)
  console.log('pass --append --notebook X --page Y to also assert the no-note refusals')
  process.exit(failures === 0 ? 0 : 1)
}

const notebookName = flag('notebook')
const pageName = flag('page')
if (notebookName === undefined || pageName === undefined) {
  console.log('--append needs --notebook and --page')
  process.exit(1)
}
const candidate = (tree.json.pages ?? []).find((row) => row.notebook === notebookName && row.name === pageName)
if (candidate === undefined) {
  console.log(`no page 「${pageName}」 in 「${notebookName}」`)
  process.exit(1)
}
console.log(`       target for the refusal check: ${candidate.notebook} / ${candidate.section} / ${candidate.name}`)

console.log('\n7. the live server refuses an export when there is no note')
// This section never writes. It used to assume the running session had no review,
// and wrote into a real notebook when that assumption was wrong. The session's
// state is therefore read first, and the run stops rather than guessing.
const state = await call('/state')
const hasNote = state.json?.state?.hasReview === true || state.json?.state?.reviewPending === true
if (hasNote) {
  console.log('       ! the running session already holds a finished review, so an export')
  console.log('         would write into a real notebook. Refusing to continue.')
  console.log('         Clear the session (the panel\'s 清空 button) and re-run, or use')
  console.log('         verify.mjs, which exercises the same refusals in-process.')
  console.log(`\n${String(checks - failures)}/${String(checks)} checks passed (stopped before writing)`)
  process.exit(failures === 0 ? 0 : 1)
}
const noNote = await call('/onenote/export', { method: 'POST', body: { notebook: notebookName, page: pageName } })
check('with no note, the live server refuses', noNote.status === 200 && noNote.json?.ok === false, JSON.stringify(noNote.json))
check('the refusal explains that there is nothing to export', String(noNote.json?.error ?? '').includes('没有可导出的笔记'), String(noNote.json?.error))
check('and it wrote nothing', noNote.json?.mode === undefined && noNote.json?.url === undefined, JSON.stringify(noNote.json))

const newPageNoNote = await call('/onenote/new-page', { method: 'POST', body: { notebook: notebookName } })
check('the new-page route refuses without a note too', newPageNoNote.json?.ok === false, JSON.stringify(newPageNoNote.json))
check('and it created nothing', newPageNoNote.json?.page === undefined, JSON.stringify(newPageNoNote.json))

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
process.exit(failures === 0 ? 0 : 1)
