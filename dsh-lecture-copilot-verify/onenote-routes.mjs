/**
 * Drive the plugin's real HTTP routes against the real OneNote bridge.
 *
 * The offline suite injects a fake bridge, and the probe drives the bridge
 * directly. This runs the two together — route handler, destination store, note
 * XML, PowerShell child, OneNote COM — which is as close to the shipped path as
 * can be reached without a Harness restart.
 *
 * Read-only unless `--append` is passed, which appends one marked section to the
 * page you name. Nothing here deletes anything.
 *
 *   set ELECTRON_RUN_AS_NODE=1
 *   "…\DeepSeek Harness.exe" onenote-routes.mjs
 *   "…\DeepSeek Harness.exe" onenote-routes.mjs --append --notebook JNU --page "页名"
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'dsh-lecture-copilot', 'lib').replaceAll('\\', '/')

const { apply, lectureRoutes } = await import(`file:///${lib}/index.js`)
const bridge = await import(`file:///${lib}/onenote.js`)
const noteXml = await import(`file:///${lib}/note-xml.js`)

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

// A throwaway home, so the real destination store is not touched by a test.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'lcp-routes-'))

const REVIEW = [
  '## 一、课堂主线',
  '',
  '1. 教师先给出 $f(x)=x^2$，随后套用 power rule 求得导数为 $2x$。',
  '2. 再把话题切到极限：求 $\\frac{\\sin x}{x}$ 当 $x\\to 0$ 时的极限。',
  '',
  '## 二、术语对照表',
  '',
  '| 英文 | 中文 |',
  '| --- | --- |',
  '| derivative | 导数 |',
  '| squeeze theorem | 夹逼定理 |',
  '',
  '特殊字符：<tag> & 以及 CDATA 终止符 ]]> 都要安全落地。',
].join('\n')

// A session that already holds a finished review, which is the state the export
// button exists for.
const lecture = {
  review: REVIEW,
  segments: [{ id: 1, text: 'x', translation: 'y' }],
  view: () => ({ phase: 'idle' }),
  viewWithReview: () => ({ review: REVIEW }),
}

const routes = new Map()
let webServer
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  provide: () => () => {},
  effect: (callback) => {
    callback()
    return () => {}
  },
  inject: (_deps, callback) => {
    callback(ctx)
    return { dispose: async () => {} }
  },
  get: (name) => {
    if (name === 'webServer') return webServer
    return undefined
  },
}
webServer = {
  register: (entry) => {
    routes.set(entry.path, entry.handler)
    return () => {}
  },
}

const table = lectureRoutes(lecture, ctx, bridge, { context: '高等数学，全英文授课' })
for (const [, entry] of table) webServer.register(entry)

/**
 * Call one route and parse its reply.
 * @param path - route path.
 * @param method - HTTP method.
 * @param body - optional JSON body.
 * @returns `{ status, json }`.
 */
async function call(path, method = 'GET', body) {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`route ${path} is not registered`)
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8')
  const listeners = new Map()
  const req = {
    method,
    url: path,
    on: (event, fn) => {
      listeners.set(event, fn)
      return req
    },
    destroy: () => {},
  }
  const response = { status: 0, body: '' }
  const res = {
    writeHead(status) {
      response.status = status
    },
    end(chunk) {
      response.body += chunk ?? ''
    },
  }
  const finished = new Promise((resolve) => {
    const originalEnd = res.end
    res.end = (chunk) => {
      originalEnd(chunk)
      resolve()
    }
  })
  queueMicrotask(() => {
    if (payload !== undefined) listeners.get('data')?.(payload)
    listeners.get('end')?.()
  })
  await handler(req, res)
  await finished
  return { status: response.status, json: JSON.parse(response.body) }
}

console.log('\n1. GET /onenote lists the real notebook tree')
const tree = await call('/lecture-copilot/onenote')
check('the route answers 200', tree.status === 200, String(tree.status))
check('OneNote is reported available', tree.json.available === true, JSON.stringify(tree.json).slice(0, 200))
check('real notebooks came back', (tree.json.notebooks ?? []).length > 0, JSON.stringify(tree.json.notebooks))
check('real pages came back', (tree.json.pages ?? []).length > 0, String((tree.json.pages ?? []).length))
check('nothing is remembered yet', (tree.json.rememberedNotebooks ?? []).length === 0)
console.log(`       ${String(tree.json.notebooks.length)} notebooks, ${String(tree.json.pages.length)} pages`)

console.log('\n2. an unknown notebook is refused, and nothing is written')
const bogusNotebook = await call('/lecture-copilot/onenote/export', 'POST', { notebook: '肯定不存在的本子-zzz', page: 'whatever' })
check('it reports the missing notebook', bogusNotebook.json.ok === false && String(bogusNotebook.json.error).includes('笔记本不存在'), JSON.stringify(bogusNotebook.json))
check('and it reports no page name, so nothing was written', bogusNotebook.json.page === undefined, JSON.stringify(bogusNotebook.json))

console.log('\n3. an unknown page in a real notebook is refused')
const someNotebook = tree.json.notebooks[0]
const bogusPage = await call('/lecture-copilot/onenote/export', 'POST', { notebook: someNotebook, page: '这一页肯定不存在-zzz' })
check('it reports the missing page', bogusPage.json.ok === false && String(bogusPage.json.error).includes('没有这个页面'), JSON.stringify(bogusPage.json))

if (!argv.includes('--append')) {
  console.log(`\n${String(checks - failures)}/${String(checks)} checks passed (read-only; pass --append --notebook X --page Y to test a real append through the route)`)
  process.exit(failures === 0 ? 0 : 1)
}

console.log('\n4. a real append through the route')
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
console.log(`       target: ${candidate.notebook} / ${candidate.section} / ${candidate.name}`)

const result = await call('/lecture-copilot/onenote/export', 'POST', { notebook: notebookName, page: pageName })
check('the route reports success', result.json.ok === true, JSON.stringify(result.json).slice(0, 240))
check('it names the destination it actually matched', String(result.json.notebook ?? '').length > 0 && String(result.json.page ?? '').length > 0, JSON.stringify(result.json))
check('the mode is append', result.json.mode === 'append', String(result.json.mode))
check('the destination is remembered', (result.json.remembered?.notebooks ?? []).includes(notebookName), JSON.stringify(result.json.remembered))

const after = await call('/lecture-copilot/onenote')
check('the remembered list is served back to the picker', (after.json.rememberedNotebooks ?? []).includes(notebookName), JSON.stringify(after.json.rememberedNotebooks))
check('the remembered page is served back', (after.json.rememberedPages ?? []).some((row) => row.page === pageName), JSON.stringify(after.json.rememberedPages))

console.log('\n5. the plus button creates a page through the route')
const created = await call('/lecture-copilot/onenote/new-page', 'POST', { notebook: notebookName })
check('the route reports success', created.json.ok === true, JSON.stringify(created.json).slice(0, 240))
check('it created rather than appended', created.json.mode === 'create', String(created.json.mode))
check('the generated title names the course', String(created.json.title ?? '').includes('高等数学'), String(created.json.title))
check('the generated title carries the time', /课堂笔记 \d{4}-\d{2}-\d{2}/u.test(String(created.json.title)), String(created.json.title))
console.log(`       created: ${String(created.json.section)} / ${String(created.json.page)}`)
console.log(`       url: ${String(created.json.url ?? '-')}`)
console.log('       the pages created here must be removed by hand; this feature has no delete path.')

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
process.exit(failures === 0 ? 0 : 1)
