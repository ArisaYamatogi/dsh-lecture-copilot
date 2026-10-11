/**
 * Verify the OneNote bridge against the real desktop application.
 *
 * Read-only by default. `--append` writes a single clearly-marked probe section
 * onto the page you name, to prove that appending preserves what was already
 * there. Nothing here deletes anything, and the probe never cleans up after
 * itself — a feature that must never delete cannot have a delete-based test.
 *
 *   set ELECTRON_RUN_AS_NODE=1
 *   "…\DeepSeek Harness.exe" onenote-probe.mjs
 *   "…\DeepSeek Harness.exe" onenote-probe.mjs --append --page "页名" [--notebook "本子名"]
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginLib = join(here, '..', 'dsh-lecture-copilot', 'lib').replaceAll('\\', '/')

const oneNote = await import(`file:///${pluginLib}/onenote.js`)
const noteXml = await import(`file:///${pluginLib}/note-xml.js`)

const argv = process.argv.slice(2)
/**
 * Read one `--flag value` pair.
 * @param flagName - the flag name without dashes.
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

console.log('\n1. read the notebook tree')
const tree = await oneNote.list()
check('the bridge answers', tree.ok === true, JSON.stringify(tree).slice(0, 200))
if (tree.ok !== true) {
  console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
  process.exit(1)
}
const rows = oneNote.flatten(tree.notebooks)
check('notebooks were found', rows.notebooks.length > 0)
check('sections were found', rows.sections.length > 0)
check('pages were found', rows.pages.length > 0)
console.log(`       ${String(rows.notebooks.length)} notebooks, ${String(rows.sections.length)} sections, ${String(rows.pages.length)} pages`)
for (const notebook of rows.notebooks) console.log(`       · ${notebook.name}`)

console.log('\n2. name matching')
check('an exact name wins', oneNote.matchByName(rows.notebooks[0].name, rows.notebooks)?.id === rows.notebooks[0].id)
check('matching ignores case', oneNote.matchByName(rows.notebooks[0].name.toUpperCase(), rows.notebooks) !== undefined)
check('a substring matches', oneNote.matchByName(rows.notebooks[0].name.slice(0, 2), rows.notebooks) !== undefined)
check('an unknown name does not match', oneNote.matchByName('这个笔记本肯定不存在-zzz', rows.notebooks) === undefined)
check('an empty query does not match', oneNote.matchByName('   ', rows.notebooks) === undefined)
check('a missing query does not match', oneNote.matchByName(undefined, rows.notebooks) === undefined)
check('a non-string query does not match', oneNote.matchByName(7, rows.notebooks) === undefined)

console.log('\n3. markdown to page XML')
const markdown = '## 一、课堂主线\n\n极限的定义。\n\n- 挟逼定理\n- power rule\n\n特殊字符 <tag> & 与 CDATA 终止符 ]]> 也要安全。\n'
const body = noteXml.markdownToPageXml(markdown)
check('an outline was produced', body.includes('one:Outline'), body.slice(0, 60))
check('no one:Run is emitted, because OneNote rejects it', !body.includes('one:Run'), body.slice(0, 200))
check('the CDATA terminator is escaped', body.includes(']]]]><![CDATA[>'))
check('the heading keeps a visible marker', body.includes('【一、课堂主线】'))
check('a bullet keeps its marker', body.includes('· 挟逼定理'))
const title = noteXml.noteTitle({ context: '高等数学，全英文授课', now: new Date(2026, 9, 6, 15, 30) })
check('the generated title names the course', title.includes('高等数学'), title)
check('the generated title carries a timestamp', /2026-10-06 15:30/u.test(title), title)

if (!argv.includes('--append')) {
  console.log(`\n${String(checks - failures)}/${String(checks)} checks passed (read-only; pass --append --page "<页名>" to test appending)`)
  process.exit(failures === 0 ? 0 : 1)
}

const pageName = flag('page')
const notebookName = flag('notebook')
if (pageName === undefined) {
  console.log('\n--append needs --page "<页名>" naming an existing page.')
  process.exit(1)
}

console.log('\n4. append onto an existing page and prove nothing was lost')
const candidates = notebookName === undefined
  ? rows.pages.filter((row) => row.name === pageName)
  : rows.pages.filter((row) => row.name === pageName && row.notebookName === notebookName)
if (candidates.length === 0) {
  console.log(`no page named 「${pageName}」 was found`)
  process.exit(1)
}

// A name can be shared by many pages, and several of them are often empty — a
// OneNote notebook accumulates 无标题页. Measuring only the first candidate would
// prove nothing about preservation, so each is measured and the fullest one is
// chosen: appending to a page that already has text is the real test.
const scanned = candidates.slice(0, 12)
const measured = []
for (const row of scanned) {
  const reply = await oneNote.readPage({ pageId: row.id })
  measured.push({ row, text: String(reply.text ?? '') })
}
check('the candidate pages were readable', measured.length > 0)
const target = measured.reduce((best, entry) => (entry.text.length > best.text.length ? entry : best), measured[0])
const before = target.text
console.log(`       target: ${target.row.notebookName} / ${target.row.sectionName} / ${target.row.name}`)
console.log(`       scanned ${String(measured.length)} page(s) named 「${pageName}」; fullest holds ${String(before.length)} characters`)
check('the target page already had content, so preservation is actually tested', before.length > 0, `${String(before.length)} characters`)

const marker = `PROBE-APPEND-${String(Date.now())}`
const result = await oneNote.append({
  pageId: target.row.id,
  stamp: `—— 追加测试 ${marker} ——`,
  body: noteXml.markdownToPageXml(`本次追加的测试内容 ${marker}\n第二行，用于确认追加不会丢失原有内容。`),
})
check('the append succeeded', result.ok === true, JSON.stringify(result))
if (result.ok === true) {
  const reply = await oneNote.readPage({ pageId: target.row.id })
  const after = String(reply.text ?? '')
  console.log(`       after:  ${String(after.length)} characters`)
  check('the marker landed on the page that was targeted', after.includes(marker), after.slice(0, 200))
  check('the page grew rather than being replaced', after.length > before.length, `${String(before.length)} → ${String(after.length)}`)
  // The strongest evidence available that nothing was overwritten: the start of
  // the original text is still present after the write.
  check('the original content is still there', after.includes(before.slice(0, 40)), before.slice(0, 40))
  console.log(`       the page now carries a section marked ${marker}; remove that heading in OneNote when done.`)
  console.log(`       url: ${result.url ?? '-'}`)
}

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
process.exit(failures === 0 ? 0 : 1)
