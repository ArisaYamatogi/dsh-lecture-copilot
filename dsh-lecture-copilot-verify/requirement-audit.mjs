/**
 * Audit the objective, requirement by requirement, against the shipped code.
 *
 * The suites prove behaviour; this proves *coverage*. Each requirement is one
 * entry with the concrete implementation it maps to and the suites that exercise
 * it, so a requirement can never be quietly dropped: if the code it names
 * disappears, this fails.
 *
 * Usage: node requirement-audit.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const plugin = join(here, '..', 'dsh-lecture-copilot')

/** Read one file, relative to the plugin directory. */
function read(relative) {
  return readFileSync(join(plugin, relative), 'utf8')
}

const client = read('lib/client.js')
const host = read('lib/index.js')
const bridge = read('lib/onenote.js')
const hostScript = read('host/onenote.ps1')
const store = read('lib/onenote-store.js')
const xml = read('lib/note-xml.js')

let checks = 0
let failures = 0
/**
 * Assert one condition.
 * @param label - the requirement.
 * @param condition - whether the code satisfies it.
 * @param detail - where it lives.
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

console.log('\nA. 笔记就绪后出现导出按钮')
check(
  'the export control is gated on a review existing',
  /disabled: !state\.hasReview && state\.review === null/u.test(client),
  'the footer button',
)
check('the export button is labelled', client.includes("'导出 OneNote'"))
check('the dialog only renders when opened', client.includes('state.exportOpen\n          ? h(ExportDialog'), 'mount condition')

console.log('\nB. 弹出笔记本与页面的栏')
check('there is a notebook bar', client.includes("label: '笔记本'"))
check('there is a page bar', client.includes("label: '页面'"))
check('both bars are text inputs', client.includes("className: 'lcp-input'"))
check('both bars can be typed into', client.includes('onInput: (value) =>'), 'onChange wiring')

console.log('\nC. 支持字符串匹配查找')
check('matching ignores case and matches substrings', bridge.includes('toLowerCase()') && bridge.includes('.includes(needle)'), 'matchByName')
check('an exact match wins over a partial one', /const exact = rows\.find/u.test(bridge), 'exact-first ordering')
check('a missing query never matches', bridge.includes("if (typeof query !== 'string') return undefined"), 'undefined guard')
check('the page list follows the chosen notebook', /onlyThisNotebook|entry\.notebook === typed/u.test(client))
check('the page candidates carry their section when no notebook is chosen', client.includes('（${entry.section}）'), 'disambiguation')
check('every candidate is reachable through a panel-drawn list', client.includes("className: 'lcp-options'"), 'not a datalist')

console.log('\nD. 已用过的存在项保存为下拉选项')
check('a destination is remembered after a successful write', host.includes('await rememberDestination('))
check('it is persisted to disk', store.includes('onenote-destinations.json'))
check('it is read back for the picker', host.includes('await readDestinations(harnessHome())'))
check('remembered entries are offered', client.includes('rememberedNotebooks') && client.includes('rememberedPages'))
check('a remembered name that no longer exists is dropped', store.includes('export function reconcile'))
check('the live tree is merged in, so a first run is not empty', /\.\.\.\(known\?\.notebooks/u.test(client), 'union with the catalogue')

console.log('\nE. 输入不存在则提示，且不进行任何后续操作')
check('an unknown notebook is reported', host.includes('笔记本不存在：'))
check('an unknown page is reported', host.includes('没有这个页面：'))
check('the refusal returns before any write', /if \(notebook === undefined\) \{\n      sendJson[\s\S]{0,160}return\n    \}/u.test(host), 'early return')
check('the page is resolved before the append call', host.indexOf('if (page === undefined)') < host.indexOf('bridge.append('), 'ordering')
check('the panel shows the reason', client.includes("className: 'lcp-export-status'"))
check('a refusal is not styled as success', client.includes("state.exportStatus.startsWith('已导出') || state.exportStatus.startsWith('已在')"))

console.log('\nF. 栏位旁的「+」按钮：在已选笔记本内新建页面并导出')
check('the + control exists', client.includes("'＋ 新建页面'"))
check('it is disabled until a notebook is chosen', /className: 'lcp-btn lcp-plus'[\s\S]{0,220}disabled: busy \|\| typed\.length === 0/u.test(client))
check('its route exists', host.includes('/onenote/new-page'))
check('it creates rather than appends', bridge.includes("op: 'create'"))
check('the create path exists in the bridge', hostScript.includes("'create' {"))

console.log('\nG. 同时自动生成一个标题')
check('a title is generated from the course and the time', xml.includes('export function noteTitle'))
check('the title carries a real timestamp', xml.includes('pad(now.getMonth() + 1)') && xml.includes('pad(now.getHours())'))
check('the create call passes it', /bridge\.create\(\{ sectionId: section\.id, title,/u.test(host))
check('the page lands in a section the person chose, never an inferred one', host.includes('function resolveSection') && !host.includes('pickSection('))
check('an unknown section is reported instead of substituted', host.includes('分区不存在：'))
check('the section is required, so no default is guessed', host.includes('请先选择分区'))
check('the section catalogue is served to the picker', host.includes('sections: live.sections.map'))
check('the title is generated from the note, not the clock', host.includes('await generateTitle('))

console.log('\nH. 约束：只能增加，不能减少')
check('the bridge exports no update/delete', !/export function (update|remove|del)/u.test(bridge), Object.keys(await import(`file:///${join(plugin, 'lib', 'onenote.js').replaceAll('\\', '/')}`)).join(','))
check('appending reads the page first', hostScript.includes('$current = GetPageXml $request.pageId'), 'read-then-write')
check('it merges instead of replacing', hostScript.includes("Replace('</one:Page>', $addition + '</one:Page>')"))
check('no delete call exists anywhere in the plugin', !/DeleteHierarchy|DeletePageContent/u.test(bridge + host + client + hostScript))
check('the suite does not delete either', !/DeleteHierarchy/u.test(readFileSync(join(here, 'onenote-probe.mjs'), 'utf8')))

console.log(`\n${String(checks - failures)}/${String(checks)} requirements satisfied`)
process.exit(failures === 0 ? 0 : 1)
