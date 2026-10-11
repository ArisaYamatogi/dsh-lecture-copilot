/**
 * Render the shipped panel with the real React, in a real browser.
 *
 * The offline harness stubs React, so it proves the tree the file *builds*, not
 * what React *produces* from it. React 18 is strict about a few things a stub
 * happily accepts, and the browser is strict about things Node is not:
 *
 *   · a `<button>` nested inside a `<button>` is invalid and React warns
 *   · an uncontrolled `value` without `onChange` is a React error
 *   · `key` handling, fragment handling, `undefined` children
 *   · anything that only breaks while laid out or painted
 *
 * React 18.3.1 is vendored under `vendor/` as a UMD build, so this runs offline
 * and cannot drift with a CDN.
 *
 * Usage: node real-react-probe.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'dsh-lecture-copilot', 'lib', 'client.js')
const vendor = join(here, 'vendor')
const reactUmd = join(vendor, 'react.umd.js')
const reactDomUmd = join(vendor, 'react-dom.umd.js')

for (const required of [reactUmd, reactDomUmd]) {
  if (!existsSync(required)) {
    console.log(`missing ${required}; run the vendoring step first`)
    process.exit(1)
  }
}

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path))
if (EDGE === undefined) {
  console.log('Edge was not found; skipping the real-React probe.')
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

const work = mkdtempSync(join(tmpdir(), 'lcp-react-'))
writeFileSync(join(work, 'client.js'), readFileSync(clientPath, 'utf8'), 'utf8')
writeFileSync(join(work, 'react.umd.js'), readFileSync(reactUmd, 'utf8'), 'utf8')
writeFileSync(join(work, 'react-dom.umd.js'), readFileSync(reactDomUmd, 'utf8'), 'utf8')

// A note is present, so the export control is armed — that is the state the
// feature exists for.
const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>real react probe</title></head>
<body>
<div id="mount"></div>
<script>
window.__probe = { warnings: [], errors: [], mounted: false, id: null, registered: null };
window.__ModuleLoader__ = { load(entry) { window.__probe.id = entry.id; window.__factory = entry.factory; } };
// React reports invalid nesting and uncontrolled inputs through console.error.
const realError = console.error.bind(console);
console.error = (...args) => { window.__probe.errors.push(args.map(String).join(' ')); realError(...args); };
const realWarn = console.warn.bind(console);
console.warn = (...args) => { window.__probe.warnings.push(args.map(String).join(' ')); realWarn(...args); };
window.addEventListener('error', (event) => window.__probe.errors.push('window: ' + String(event.message)));
</script>
<script src="./react.umd.js"></script>
<script src="./react-dom.umd.js"></script>
<script src="./client.js"></script>
<script>
(function () {
  const probe = window.__probe;
  try {
    const mod = window.__factory((specifier) => {
      if (specifier === 'react') return window.React;
      throw new Error('unexpected require: ' + specifier);
    });
    probe.registered = { name: mod.name, inject: mod.inject };
    let component = null;
    mod.apply({
      effect: (cb) => cb(),
      slots: { inject: (_n, cb) => cb(), register: (_t, fn) => { component = fn; return () => {}; } },
    });
    if (typeof component !== 'function') { probe.errors.push('no component registered'); window.__done = true; return; }

    // A finished note, so the export bar is reachable, plus the destination
    // catalogue the live route returns.
    const store = mod.store;
    Object.assign(store, {
      phase: 'idle', hasReview: true, review: '## 一、课堂主线\\n内容',
      exportOpen: true, listOpen: 'notebook', notebookQuery: '', pageQuery: '',
      onenote: {
        available: true,
        notebooks: ['JNU', '光毅 的笔记本', 'My Notebook @ clsmss.edu.hk'],
        rememberedNotebooks: ['JNU'],
        rememberedPages: [],
        pages: [
          { notebook: 'JNU', section: 'Temp', name: '极限与导数' },
          { notebook: '光毅 的笔记本', section: 'ENG', name: 'Word List' },
        ],
      },
    });

    const root = ReactDOM.createRoot(document.getElementById('mount'));
    // flushSync forces the render to complete before this script returns, so the
    // assertions below read a settled DOM rather than an empty container.
    ReactDOM.flushSync(() => root.render(React.createElement(component, {})));
    probe.mounted = true;
    window.__store = store;
    window.__root = root;
    window.__component = component;
  } catch (error) {
    probe.errors.push(String(error && error.stack ? error.stack.split('\\n').slice(0, 2).join(' | ') : error));
  }
  window.__done = true;
})();
</script>
</body></html>`

writeFileSync(join(work, 'probe.html'), page, 'utf8')

const PORT = 9335
const profile = mkdtempSync(join(tmpdir(), 'lcp-edge3-'))
const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${String(PORT)}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  `file:///${join(work, 'probe.html').replaceAll('\\', '/')}`,
], { stdio: 'ignore', windowsHide: true })

/** Poll the DevTools endpoint until the page target appears. */
async function waitForTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(PORT)}/json/list`)
      const targets = await response.json()
      const found = targets.find((target) => target.type === 'page' && String(target.url).includes('probe.html'))
      if (found !== undefined) return found
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
for (let attempt = 0; attempt < 60; attempt += 1) {
  if (await evaluate('window.__done === true')) break
  await new Promise((resolve) => setTimeout(resolve, 100))
}
// Give React a beat to flush any warning it emits asynchronously.
await new Promise((resolve) => setTimeout(resolve, 300))

const probe = await evaluate('JSON.stringify(window.__probe)').then((text) => JSON.parse(text))

console.log('\n1. React 18 mounts the panel')
check('the bundle registered its module', probe.id === 'dsh-lecture-copilot-plugin', String(probe.id))
check('the component mounted', probe.mounted === true, JSON.stringify(probe.errors).slice(0, 300))
check('React reported no error while rendering', probe.errors.length === 0, JSON.stringify(probe.errors).slice(0, 400))

console.log('\n2. React produced the real DOM')
// The control starts collapsed, which is correct — a person clicks the launcher
// first. So the harness clicks it, exactly as the browser would.
const launcher = await evaluate(`(() => {
  const el = document.querySelector('.lcp-launcher')
  if (el === null) return { found: false }
  el.click()
  return { found: true, text: el.textContent }
})()`)
check('the launcher is what renders first', launcher.found === true, JSON.stringify(launcher))
await new Promise((resolve) => setTimeout(resolve, 400))

const mountedHtml = await evaluate(`document.getElementById('mount').innerHTML.slice(0, 700)`)
console.log(`       mount innerHTML: ${mountedHtml}`)
const dom = await evaluate(`(() => {
  const panel = document.querySelector('.lcp-panel')
  const rows = [...document.querySelectorAll('.lcp-export-row')]
  return {
    panel: panel !== null,
    inputs: document.querySelectorAll('.lcp-input').length,
    carets: document.querySelectorAll('.lcp-caret').length,
    options: document.querySelectorAll('.lcp-option').length,
    plus: document.querySelectorAll('.lcp-plus').length,
    plusText: (document.querySelector('.lcp-plus') || {}).textContent || '',
    exportButton: [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('导出到该页面')).length,
    notebookLabel: rows[0] ? rows[0].textContent.slice(0, 12) : '',
    sectionLabel: rows[1] ? rows[1].textContent.slice(0, 8) : '',
    pageLabel: rows[2] ? rows[2].textContent.slice(0, 8) : '',
    optionTexts: [...document.querySelectorAll('.lcp-option')].map((o) => o.textContent),
  }
})()`)
check('the panel element exists in the DOM', dom.panel === true, JSON.stringify(dom))
check('React rendered three input bars', dom.inputs === 3, String(dom.inputs))
check('React rendered three list buttons', dom.carets === 3, String(dom.carets))
check('React rendered the candidate list', dom.options === 3, JSON.stringify(dom.optionTexts))
check('React rendered the + button', dom.plus === 1 && dom.plusText.includes('新建页面'), JSON.stringify({ plus: dom.plus, text: dom.plusText }))
check('React rendered the export button', dom.exportButton === 1, String(dom.exportButton))
check('the notebook bar carries its label', dom.notebookLabel.includes('笔记本'), dom.notebookLabel)
check('the section bar carries its label', dom.sectionLabel.includes('分区'), dom.sectionLabel)
check('the page bar carries its label', dom.pageLabel.includes('页面'), dom.pageLabel)
check('every live notebook is a candidate', dom.optionTexts.includes('光毅 的笔记本'), JSON.stringify(dom.optionTexts))

console.log('\n3. React is happy with the markup')
const nesting = await evaluate(`(() => {
  // A button inside a button is invalid HTML; the browser reparents it, so this
  // checks the DOM React actually committed rather than the source.
  const nested = [...document.querySelectorAll('button button')].length
  const inputs = [...document.querySelectorAll('input')]
  const uncontrolled = inputs.filter((i) => i.value !== '' && i.getAttribute('value') === null).length
  return { nested, inputs: inputs.length, uncontrolled }
})()`)
check('no button is nested inside another button', nesting.nested === 0, String(nesting.nested))
const reactComplaints = probe.errors.filter((entry) => /validateDOMNesting|uncontrolled|Warning|Each child|key/u.test(entry))
check('React logged no nesting or key complaint', reactComplaints.length === 0, JSON.stringify(reactComplaints).slice(0, 400))

console.log('\n4. the candidate list is laid out and scrollable')
const layout = await evaluate(`(() => {
  const el = document.querySelector('.lcp-options')
  if (el === null) return null
  const style = getComputedStyle(el)
  const box = el.getBoundingClientRect()
  return { overflowY: style.overflowY, maxHeight: style.maxHeight, height: Math.round(box.height), width: Math.round(box.width), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
})()`)
check('the list is present and has size', layout !== null && layout.height > 0 && layout.width > 0, JSON.stringify(layout))
check('the list is a scroll container', layout?.overflowY === 'auto', String(layout?.overflowY))
check('no child overflows the panel horizontally', (await evaluate(`(() => {
  const panel = document.querySelector('.lcp-panel').getBoundingClientRect()
  return [...document.querySelectorAll('.lcp-panel *')].filter((el) => {
    const r = el.getBoundingClientRect()
    return r.width > 0 && (r.left < panel.left - 1 || r.right > panel.right + 1)
  }).length
})()`)) === 0)

console.log('\n5. clicking a candidate fills the field, through React')
const clicked = await evaluate(`(() => {
  const option = [...document.querySelectorAll('.lcp-option')].find((o) => o.textContent.includes('光毅'))
  if (option === undefined) return { error: 'candidate not found' }
  option.click()
  const input = document.querySelector('.lcp-input')
  return { clickDispatched: true }
})()`)
void clicked
// React processes the click and re-renders synchronously through its own queue.
await new Promise((resolve) => setTimeout(resolve, 500))
const afterClick = await evaluate(`(() => {
  const input = document.querySelector('.lcp-input')
  return { value: input.value, listOpen: document.querySelectorAll('.lcp-option').length }
})()`)
check('the click filled the notebook field', afterClick.value.includes('光毅'), JSON.stringify(afterClick))
check('and the list closed', afterClick.listOpen === 0, String(afterClick.listOpen))

socket.close()
edge.kill()
console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
process.exit(failures === 0 ? 0 : 1)
