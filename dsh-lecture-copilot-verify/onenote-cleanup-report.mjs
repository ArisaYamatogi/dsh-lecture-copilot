/**
 * Capture what the OneNote probes left behind, and back it up.
 *
 * Development of this feature created pages and appended sections in a real
 * notebook. Nothing here deletes anything — the feature has no delete path by
 * design — so this instead records exactly what is there and writes a backup of
 * the affected page's full text, which is what a manual restore would need.
 *
 * Usage:
 *   set ELECTRON_RUN_AS_NODE=1
 *   "…\DeepSeek Harness.exe" onenote-cleanup-report.mjs
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'dsh-lecture-copilot', 'lib').replaceAll('\\', '/')
const bridge = await import(`file:///${lib}/onenote.js`)

/**
 * Text that only a development probe would have written.
 *
 * `本次转写` was in this list and had to come out: it is the review's own opening
 * line, so the moment a real export existed the report began flagging the user's
 * own note as residue. A check that cries wolf on legitimate content is worse than
 * no check at all. What remains below is probe-only text.
 */
const MARKERS = ['PROBE-APPEND', '追加测试']
/**
 * The stamp an export writes before the content it appends:
 * `—— 课堂同传 · <title> ——`.
 *
 * A bare `课堂同传` cannot be used to conclude residue, because a legitimate export
 * carries it too. Only a stamp whose title is `课堂笔记` with no course is provably
 * probe-made: the probe ran with an empty course context, while a real session had
 * one configured.
 */
const BARE_STAMP = /课堂同传\s*·\s*课堂笔记/u
/** Page names the exporter generates, which no hand-written page would have. */
const GENERATED_NAME = /^课堂笔记 \d{4}-\d{2}-\d{2} /u

console.log('\nscanning OneNote for probe residue\n')
const reply = await bridge.list()
if (reply.ok !== true) {
  console.log(`OneNote unavailable: ${String(reply.error)}`)
  process.exit(1)
}
const rows = bridge.flatten(reply.notebooks)

const residue = []
const generated = []
for (const page of rows.pages) {
  const read = await bridge.readPage({ pageId: page.id })
  const text = String(read.text ?? '')
  // Only probe-only signals count as residue. A generated page *name* does not:
  // the feature creates pages with exactly this name, so flagging it by name alone
  // reported the user's own legitimate export as a leftover.
  const hit = MARKERS.find((marker) => text.includes(marker))
    ?? (BARE_STAMP.test(text) ? 'probe stamp' : undefined)
  if (hit !== undefined) residue.push({ page, text, elements: read.elements, hit })
  if (GENERATED_NAME.test(page.name)) generated.push({ page, text, elements: read.elements })
}

console.log(`pages carrying probe-only text: ${String(residue.length)}`)
for (const { page, text, elements, hit } of residue) {
  console.log(`  MODIFIED (${hit})`)
  console.log(`    ${page.notebookName} / ${page.sectionName} / ${page.name}`)
  console.log(`    ${String(elements)} elements, ${String(text.length)} characters`)
  console.log(`    oneNote id: ${page.id}`)
}
if (residue.length === 0) {
  console.log('  none — every page is clean of probe-only text.')
}

// Reported separately and explicitly *not* called residue: these are pages the
// exporter made, which is the feature working as designed.
console.log(`\npages created by the exporter: ${String(generated.length)}`)
for (const { page, elements, text } of generated) {
  console.log(`  ${page.notebookName} / ${page.sectionName} / ${page.name}`)
  console.log(`    ${String(elements)} elements, ${String(text.length)} characters — kept, not residue`)
}
console.log('  (delete these only if they are test pages you no longer want.)')

// A backup of anything flagged as residue, so a manual restore has the original
// bytes.
const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '-')
for (const [index, entry] of residue.entries()) {
  const target = join(here, `onenote-backup-${stamp}-${String(index)}.txt`)
  writeFileSync(
    target,
    [
      `# ${entry.page.notebookName} / ${entry.page.sectionName} / ${entry.page.name}`,
      `# page id: ${entry.page.id}`,
      `# captured: ${new Date().toISOString()}`,
      `# matched: ${entry.hit}`,
      '',
      entry.text,
      '',
    ].join('\n'),
    'utf8',
  )
  console.log(`\n  backup written: ${target}`)
}

console.log('\nwhat a manual cleanup looks like')
console.log('  · a page marked MODIFIED: delete just the section containing a PROBE-APPEND')
console.log('    marker or a 「—— 课堂同传 · 课堂笔记 … ——」 stamp written with no course')
console.log('  · the page itself and everything above that section are untouched: an append')
console.log('    only ever adds, so the original content is still intact')
console.log('')
process.exit(residue.length === 0 ? 0 : 1)
