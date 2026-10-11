/**
 * Load the shipped client bundle in a real browser and run it.
 *
 * Every other check treats `lib/client.js` as either text or as a module in Node,
 * and neither is how it runs. A real browser loading it can fail in ways Node
 * cannot show: a syntax form the engine rejects, a top-level reference to a
 * browser global that is not there, a CSS block the parser dislikes, or a
 * component that throws on its first render. After a restart, any of those means
 * the panel simply never appears.
 *
 * This page is local and offline: React is a stub, so nothing is fetched and the
 * question stays narrow — does this file load and run in an engine?
 *
 * Usage: node client-bundle-probe.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'dsh-lecture-copilot', 'lib', 'client.js')

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((path) => existsSync(path))
if (EDGE === undefined) {
  console.log('Edge was not found; skipping the client bundle probe.')
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

// The bundle is served as its own file, exactly as the browser receives it.
const source = readFileSync(clientPath, 'utf8')
const work = mkdtempSync(join(tmpdir(), 'lcp-bundle-'))
writeFileSync(join(work, 'client.js'), source, 'utf8')

const harness = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>client bundle probe</title></head>
<body>
<script>
// The two things the real shell provides before a plugin bundle runs.
window.__probe = { factory: null, error: null, renderError: null, cssRules: 0, styleTagId: null, registered: null };
window.__ModuleLoader__ = { load(entry) { window.__probe.factory = entry.factory; window.__probe.id = entry.id; } };
window.addEventListener('error', (event) => { window.__probe.error = String(event.message); });
</script>
<script type="module">
import { readFileSync } from 'node:fs';
</script>
<script>
// A stub React: enough for the factory to build its element tree once. Nothing is
// fetched, and no DOM components are exercised here — that is the offline
// harness's job. What matters is that the file loads and its component runs.
window.__reactStub = {
  createElement(type, props, ...children) { return { type, props, children }; },
  Fragment: Symbol('Fragment'),
  useReducer: (r, i) => [i, () => {}],
  useState: (i) => [i, () => {}],
  useRef: (i) => ({ current: i }),
  useEffect: () => {},
  useMemo: (f) => f(),
  useCallback: (f) => f,
};
// Capture the panel's <style> node as it is created. The module injects its CSS
// while it loads, so this has to be installed *before* the bundle script runs —
// afterwards is too late and silently captures nothing.
window.__styleTags = [];
(function () {
  const realCreate = document.createElement.bind(document);
  document.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'style') window.__styleTags.push(el);
    return el;
  };
})();
</script>
<script src="./client.js"></script>
<script>
const probe = window.__probe;
try {
  if (typeof probe.factory !== 'function') {
    probe.error = 'the client module did not register a factory';
  } else {
    const mod = probe.factory((specifier) => {
      if (specifier === 'react') return window.__reactStub;
      throw new Error('unexpected require: ' + specifier);
    });
    probe.registered = { name: mod.name, inject: mod.inject, hasApply: typeof mod.apply };
    let component = null;
    mod.apply({
      effect: (callback) => callback(),
      slots: { inject: (_name, callback) => callback(), register: (_target, fn) => { component = fn; return () => {}; } },
    });
    probe.registered.component = typeof component;
    if (typeof component === 'function') {
      // Two passes: the first mounts, the second re-renders with the store warm.
      component({});
      component({});
      probe.rendered = true;
    }
    const tag = window.__styleTags.find((el) => el.dataset && el.dataset.pluginCss !== undefined);
    if (tag === undefined) {
      probe.error = 'the panel never injected its stylesheet';
    } else {
      probe.styleTagId = tag.dataset.pluginCss;
      try {
        // Appending parses it, and parsing is what proves the engine accepts it.
        if (tag.parentNode === null) document.head.appendChild(tag);
        probe.cssRules = tag.sheet === null ? 0 : tag.sheet.cssRules.length;
      } catch (error) {
        probe.error = 'the panel CSS was rejected: ' + String(error.message);
      }
    }
  }
} catch (error) {
  probe.renderError = String(error && error.stack ? error.stack.split('\\n')[0] : error);
}
window.__done = true;
</script>
</body></html>`

writeFileSync(join(work, 'probe.html'), harness, 'utf8')

const PORT = 9334
const profile = mkdtempSync(join(tmpdir(), 'lcp-edge2-'))
const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${String(PORT)}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--allow-file-access-from-files',
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
for (let attempt = 0; attempt < 40; attempt += 1) {
  if (await evaluate('window.__done === true')) break
  await new Promise((resolve) => setTimeout(resolve, 100))
}

const probe = await evaluate('JSON.stringify(window.__probe)').then((text) => JSON.parse(text))

console.log('\n1. the browser loads and parses the bundle')
check('the file produced no top-level error', probe.error === null, String(probe.error))
check('the module registered a factory', probe.factory !== null, String(probe.error))

console.log('\n2. the module is the one the profile expects')
check('its id is the package name', probe.id === 'dsh-lecture-copilot-plugin', String(probe.id))
check('it names itself', probe.registered?.name === 'lecture-copilot', String(probe.registered?.name))
check('it declares its injected services', Array.isArray(probe.registered?.inject) && probe.registered.inject.includes('slots'), JSON.stringify(probe.registered?.inject))

console.log('\n3. mounting the panel does not throw')
check('the mount registers a component', probe.registered?.component === 'function', String(probe.registered?.component))
check('the component renders without throwing', probe.renderError === null, String(probe.renderError))
check('the render completed', probe.rendered === true, String(probe.rendered))

console.log('\n4. the panel CSS is accepted by the engine')
check('a style tag was tagged for this plugin', probe.styleTagId === 'dsh-lecture-copilot-plugin/panel.css', String(probe.styleTagId))
check('the stylesheet parsed into rules', probe.cssRules > 50, String(probe.cssRules))
console.log(`       ${String(probe.cssRules)} CSS rules parsed`)

socket.close()
edge.kill()
console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
process.exit(failures === 0 ? 0 : 1)
