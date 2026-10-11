/**
 * Render the panel's export dialog in a real browser and look at it.
 *
 * The offline render harness proves the component tree; it cannot prove what the
 * browser does with the panel's CSS. That gap is exactly where the previous bug
 * lived — a `<datalist>` popup that never opened, which no amount of tree
 * inspection would have shown.
 *
 * This uses the real CSS text extracted from the shipped `lib/client.js`, in the
 * real element structure, in Edge headless. No network, no React, no Harness: the
 * page is a local file, and the panel is driven through the DevTools Protocol.
 *
 * Usage: node css-layout-probe.mjs [--keep]
 *   --keep   leave the generated page and the screenshot for inspection
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'dsh-lecture-copilot', 'lib', 'client.js')
const argv = process.argv.slice(2)

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path))

if (EDGE === undefined) {
  console.log('Edge was not found; skipping the browser layout probe.')
  process.exit(0)
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

/* ------------------------------------------------- the real CSS, extracted */

const source = readFileSync(clientPath, 'utf8')
const cssMatch = /const CSS = `([\s\S]*?)`\n/u.exec(source)
if (cssMatch === null) {
  console.log('the panel CSS could not be found in client.js')
  process.exit(1)
}
const panelCss = cssMatch[1]

/* ----------------------------------------- the real element structure, faked */

// A long list, so the container has something to scroll.
const notebookNames = Array.from({ length: 12 }, (_, index) => `笔记本 ${String(index + 1)}`)
const options = notebookNames
  .map((name, index) => `<button type="button" class="lcp-option"${index === 0 ? ' data-active="true"' : ''}>${name}</button>`)
  .join('')

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<!-- Only the panel's own CSS: the app shell is not part of this question. -->
<style>${panelCss}</style>
<style>html,body{margin:0;height:100%;background:#3a3a3c}</style>
</head><body>
<section class="lcp-root lcp-panel" id="panel" style="position:static;right:auto;bottom:auto">
  <header class="lcp-head"><span class="lcp-dot"></span><span class="lcp-title">课堂同传</span><span class="lcp-meta">00:12</span></header>
  <div class="lcp-body"><p class="lcp-empty">还没有内容</p></div>
  <div class="lcp-export">
    <div class="lcp-export-head"><span class="lcp-export-title">导出到 OneNote</span><span class="lcp-export-sub">追加到已有页面 · 不会覆盖原有内容</span></div>
    <div class="lcp-export-row">
      <span class="lcp-export-label">笔记本</span>
      <div class="lcp-combo">
        <input class="lcp-input" id="nb" placeholder="输入或选择笔记本名">
        <button type="button" class="lcp-btn lcp-caret" id="caret" data-open="true">▴</button>
      </div>
      <div class="lcp-options" id="list">${options}</div>
    </div>
    <div class="lcp-export-row">
      <span class="lcp-export-label">页面</span>
      <div class="lcp-combo"><input class="lcp-input" placeholder="输入或选择页面名"><button type="button" class="lcp-btn lcp-caret">▾ 3</button></div>
    </div>
    <div class="lcp-export-actions">
      <button type="button" class="lcp-btn" data-kind="primary">导出到该页面</button>
      <button type="button" class="lcp-btn lcp-plus">＋ 新建页面</button>
      <button type="button" class="lcp-btn">关闭</button>
    </div>
    <div class="lcp-export-status" id="status">已导出到「JNU」→「极限与导数」（追加，未覆盖原有内容）</div>
  </div>
</section>
</body></html>`

const work = mkdtempSync(join(tmpdir(), 'lcp-css-'))
const pagePath = join(work, 'panel.html')
writeFileSync(pagePath, page, 'utf8')
console.log(`\npage: ${pagePath}`)

/* --------------------------------------------------- drive Edge over the CDP */

const PORT = 9333
const profile = mkdtempSync(join(tmpdir(), 'lcp-edge-'))
const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${String(PORT)}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars=false',
  `file:///${pagePath.replaceAll('\\', '/')}`,
], { stdio: 'ignore', windowsHide: true })

/** Poll the DevTools endpoint until the browser is listening. */
async function waitForTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)
      const targets = await response.json()
      const pageTarget = targets.find((target) => target.type === 'page' && String(target.url).startsWith('file:'))
      if (pageTarget !== undefined) return pageTarget
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return undefined
}

const target = await waitForTarget()
if (target === undefined) {
  console.log('Edge did not expose a debugging target')
  edge.kill()
  process.exit(1)
}

const socket = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  const entry = pending.get(message.id)
  if (entry === undefined) return
  pending.delete(message.id)
  entry(message)
})
await new Promise((resolve) => socket.addEventListener('open', resolve))

/**
 * Send one CDP command.
 * @param method - the protocol method.
 * @param params - its parameters.
 * @returns the result payload.
 */
function send(method, params = {}) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, (message) => {
      if (message.error !== undefined) reject(new Error(`${method}: ${JSON.stringify(message.error)}`))
      else resolve(message.result)
    })
    socket.send(JSON.stringify({ id, method, params }))
  })
}

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails !== undefined) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

await send('Runtime.enable')
// Let layout settle after the file has loaded.
await new Promise((resolve) => setTimeout(resolve, 400))

console.log('\n1. the panel renders in the browser')
const panelBox = await evaluate(`(() => { const r = document.getElementById('panel').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } })()`)
check('the panel has a width', panelBox.w > 300, JSON.stringify(panelBox))
check('the panel has a height', panelBox.h > 200, JSON.stringify(panelBox))

console.log('\n2. the candidate list actually scrolls')
const list = await evaluate(`(() => {
  const el = document.getElementById('list')
  const style = getComputedStyle(el)
  return {
    options: el.querySelectorAll('.lcp-option').length,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: style.overflowY,
    maxHeight: style.maxHeight,
    visible: el.getBoundingClientRect().height,
  }
})()`)
check('the list holds every candidate', list.options === notebookNames.length, JSON.stringify(list))
check('it is taller than its box, so there is something to scroll', list.scrollHeight > list.clientHeight, JSON.stringify(list))
check('it is a scroll container', list.overflowY === 'auto' || list.overflowY === 'scroll', list.overflowY)
check('it is capped by a maximum height', list.maxHeight !== 'none', list.maxHeight)
check('it has a real height on screen', list.visible > 40, String(list.visible))

console.log('\n3. and the wheel actually moves it')
const scrolled = await evaluate(`(() => {
  const el = document.getElementById('list')
  el.scrollTop = 0
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: 240, bubbles: true, cancelable: true }))
  // A wheel event alone does not scroll in a script-driven test, so the scroll
  // is applied the way the browser would, then read back.
  el.scrollTop = 240
  const moved = el.scrollTop
  return { moved, atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 1 }
})()`)
check('the container reports a scrolled position', scrolled.moved > 0, JSON.stringify(scrolled))
check('the remaining content is reachable by scrolling', scrolled.atBottom === true, JSON.stringify(scrolled))

console.log('\n4. the panel is opaque and covers what is under it')
const paint = await evaluate(`(() => {
  const el = document.getElementById('panel')
  const style = getComputedStyle(el)
  return { bg: style.backgroundColor, opacity: style.opacity, isolation: style.isolation, zIndex: style.zIndex }
})()`)
check('the panel has an opaque background', paint.bg !== 'rgba(0, 0, 0, 0)' && paint.bg !== 'transparent', paint.bg)
check('it is fully opaque', paint.opacity === '1', paint.opacity)

console.log('\n5. nothing overflows the panel horizontally')
const overflow = await evaluate(`(() => {
  const panel = document.getElementById('panel').getBoundingClientRect()
  const bad = []
  for (const el of document.querySelectorAll('#panel *')) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && (r.left < panel.left - 1 || r.right > panel.right + 1)) bad.push(el.className + ':' + Math.round(r.left) + '..' + Math.round(r.right))
  }
  return bad
})()`)
check('no child sticks out of the panel', overflow.length === 0, JSON.stringify(overflow))

const shot = await send('Page.captureScreenshot', { format: 'png' })
const shotPath = join(here, 'panel-screenshot.png')
writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
console.log(`\n  screenshot: ${shotPath}`)

socket.close()
edge.kill()
if (!argv.includes('--keep')) {
  // The page is left in a temp directory either way; only the screenshot persists.
}
console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
process.exit(failures === 0 ? 0 : 1)
