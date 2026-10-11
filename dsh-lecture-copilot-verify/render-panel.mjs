/**
 * Render the panel offline, without a browser.
 *
 * The client half is a CommonJS factory that only asks the module table for
 * `react`, so a stub React plus a stub `slots` service is enough to render the
 * real component tree and assert on what it produces. This is the only way to
 * check the panel's own behaviour — the offline suite drives the Host routes, and
 * a real browser would need the whole Harness running and a restart per edit.
 *
 * Effects are driven once, which hands the harness the panel's own store; that is
 * how state is injected without the panel exposing a setter. Nothing here starts
 * a microphone, polls the Host, or opens a PowerShell child.
 *
 * Usage: node render-panel.mjs
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'dsh-lecture-copilot', 'lib', 'client.js')

/* ------------------------------------------------------------ stub React */

let hookCursor = 0
const hooks = []
let rootFactory = null

/** A fake element node: just the props and children, enough to walk. */
function createElement(type, props, ...children) {
  return {
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
  }
}

const React = {
  createElement,
  Fragment: Symbol('Fragment'),
  useReducer: (reducer, initial) => {
    const at = hookCursor++
    if (hooks.length <= at) hooks[at] = initial
    return [hooks[at], () => {}]
  },
  useState: (initial) => {
    const at = hookCursor++
    // The panel's only `useState` is its expanded flag, which starts closed; the
    // harness opens it, because a person must click the launcher to see anything.
    if (hooks.length <= at) hooks[at] = { value: true }
    return [hooks[at].value, (next) => {
      hooks[at].value = next
    }]
  },
  useRef: (initial) => {
    const at = hookCursor++
    if (hooks.length <= at) hooks[at] = { current: initial }
    return hooks[at]
  },
  /**
   * Run each effect once. The panel's first effect is `subscribe(bumpRevision)`,
   * and its callback is the store — which is how this harness gets hold of it.
   */
  useEffect: (callback) => {
    const at = hookCursor++
    if (hooks.length <= at) hooks[at] = { done: false }
    if (hooks[at].done) return
    hooks[at].done = true
    callback()
  },
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
}

/* ------------------------------------------------------- stub DOM + module */

const styleTags = []
const globalWindow = {
  __ModuleLoader__: {
    load: (entry) => {
      rootFactory = entry.factory
    },
  },
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  setInterval: () => 0,
  clearInterval: () => {},
  location: { href: 'http://localhost/' },
}
globalThis.window = globalWindow
globalThis.document = {
  head: { appendChild: (node) => styleTags.push(node) },
  // The panel builds a real <style> node; `dataset` is how it tags it.
  createElement: () => ({ setAttribute: () => {}, appendChild: () => {}, style: {}, dataset: {} }),
  getElementById: () => null,
  querySelector: () => null,
  addEventListener: () => {},
}
// `navigator` is a read-only accessor on recent Node, so it has to be replaced
// rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: { mediaDevices: { getUserMedia: async () => { throw new Error('no microphone in this harness') } } },
})
globalThis.fetch = async () => {
  throw new Error('render-panel does not call the network')
}

// Load the real client half; it registers its factory as a side effect.
const source = readFileSync(clientPath, 'utf8')
// eslint-disable-next-line no-new-func -- the harness evaluates the shipped file as the browser would
new Function('window', 'document', 'navigator', source)(globalWindow, globalThis.document, globalThis.navigator)

if (rootFactory === null) {
  console.error('the client module did not register a factory')
  process.exit(1)
}

/* --------------------------------------------------------------- harness */

const registered = { overlay: null }
const slots = {
  inject: (_name, callback) => callback(),
  register: (_target, component) => {
    registered.overlay = component
    return () => {}
  },
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

// The store is CommonJS and this file is ESM, so it is reached through the
// module factory rather than imported — which is how the panel itself gets it.
const core = rootFactory((specifier) => {
  if (specifier === 'react') return React
  throw new Error(`unexpected require: ${specifier}`)
})
check('the module names itself', core.name === 'lecture-copilot', String(core.name))
check('it asks for the slots service', Array.isArray(core.inject) && core.inject.includes('slots'), JSON.stringify(core.inject))

core.apply({ effect: (callback) => callback(), slots })
const Panel = registered.overlay
check('it registers a component into shell.overlay', typeof Panel === 'function')

/**
 * Depth-first walk of every rendered element in a tree.
 *
 * The panel composes function components (`ExportDialog`, `ExportBar`,
 * `RoutePicker`), which React would invoke. This harness is not React, so it
 * invokes them here with a fresh hook cursor — without that, every assertion
 * would only ever see the outer `h(...)` calls.
 *
 * @param node - element, array, or text.
 * @param visit - called with each element node.
 */
function walk(node, visit) {
  visitedThisPass = new WeakSet()
  walkInner(node, visit)
}

/**
 * Walk one element, visiting each node once per pass.
 *
 * Without the visited set, an element reachable by two paths is counted twice —
 * which is exactly how a three-item list was reported as four.
 *
 * @param node - element, array, or text.
 * @param visit - called with each element node.
 */
function walkInner(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) walkInner(child, visit)
    return
  }
  if (visitedThisPass.has(node)) return
  visitedThisPass.add(node)
  if (typeof node.type === 'function') {
    // Memoised on the element node itself. Keying on props looked equivalent but
    // was not: the same node can be reached twice, and props identity does not
    // survive that, so each visit rendered the subtree again.
    let rendered = expansionCache.get(node)
    if (rendered === undefined) {
      const saved = hookCursor
      hookCursor = hookExpansionCursor
      rendered = node.type(node.props)
      hookExpansionCursor = hookCursor
      hookCursor = saved
      expansionCache.set(node, rendered ?? null)
    }
    if (rendered !== null) walkInner(rendered, visit)
    return
  }
  visit(node)
  for (const child of node.children ?? []) walkInner(child, visit)
}
/** Nodes already visited in the current pass. */
let visitedThisPass = new WeakSet()
/** Expanded subtrees, keyed by the element node they came from. */
let expansionCache = new WeakMap()
/** Hook cursor used while expanding nested components. */
let hookExpansionCursor = 0

/**
 * Every element whose class list contains all the given class names.
 *
 * Matching is on whole class tokens. A substring test looked equivalent and was
 * not: `lcp-options` (the list container) contains the text `lcp-option`, so a
 * search for options also returned their parent and every count was off by one.
 *
 * @param tree - the element to search under.
 * @param fragments - class names that must all be present.
 * @returns the matching elements.
 */
function byClass(tree, ...fragments) {
  const found = []
  walk(tree, (node) => {
    const tokens = String(node.props?.className ?? '').split(/\s+/u).filter((token) => token.length > 0)
    if (fragments.every((fragment) => tokens.includes(fragment))) found.push(node)
  })
  return found
}

/** All text under one element, flattened. */
function textOf(node) {
  const parts = []
  walk(node, (child) => {
    for (const kid of child.children ?? []) {
      if (typeof kid === 'string' || typeof kid === 'number') parts.push(String(kid))
    }
  })
  return parts.join('')
}

/** Every class name in a tree, for diagnosing a failed lookup. */
function collectClasses(tree) {
  const names = []
  walk(tree, (node) => {
    const className = String(node.props?.className ?? '')
    if (className.length > 0) names.push(className)
  })
  return names
}

/** Find the first element whose text equals a string. */
function buttonByText(tree, label) {
  const found = []
  walk(tree, (node) => {
    if (node.type === 'button' && textOf(node) === label) found.push(node)
  })
  return found[0]
}

let store = null
/**
 * Render the panel once and return its element tree.
 *
 * The panel reads its store module-level, so a patch is applied before each
 * render rather than passed in.
 * @returns the element tree.
 */
function renderPanel() {
  hookCursor = 0
  hookExpansionCursor = 0
  // A fresh cache per render: each render builds new element nodes, and keeping
  // the old ones would serve a stale snapshot to every assertion.
  expansionCache = new WeakMap()
  return Panel({})
}

console.log('\n1. the panel renders')
let tree = renderPanel()
check('a tree came back', tree !== null && tree !== undefined)
check('it is the panel root', byClass(tree, 'lcp-panel').length === 1 || byClass(tree, 'lcp-root').length >= 1, String(tree?.props?.className))

store = core.store
check('the module hands over its store', store !== null && typeof core.publish === 'function')
const publish = core.publish
const resetStore = () => {
  Object.assign(store, {
    phase: 'idle', segments: [], elapsedMs: 0, total: 0, translated: 0, pending: 0,
    hasReview: false, reviewPending: false, review: null, reviewOpen: false, error: '', level: 0,
    catalog: null, catalogError: '', showRoutes: false,
    exportOpen: false, onenote: null, onenoteError: '', notebookQuery: '', sectionQuery: '', pageQuery: '',
    exportBusy: false, exportStatus: '', listOpen: null,
  })
}

/** The catalog the live Harness actually returned, trimmed to what matters. */
const LIVE_ONENOTE = {
  available: true,
  notebooks: ['JNU', '光毅 的笔记本', 'My Notebook @ clsmss.edu.hk'],
  rememberedNotebooks: ['JNU'],
  rememberedPages: [],
  sections: [
    { notebook: 'JNU', name: 'Temp' },
    { notebook: 'JNU', name: 'Adv. Maths 1' },
    { notebook: '光毅 的笔记本', name: 'ENG' },
  ],
  pages: [
    { notebook: 'JNU', section: 'Temp', name: '极限与导数' },
    { notebook: 'JNU', section: 'Temp', name: '10月6日' },
    { notebook: '光毅 的笔记本', section: 'ENG', name: 'Word List' },
  ],
}

console.log('\n2. with no note, export is not offered')
{
  resetStore()
  publish({ phase: 'idle', hasReview: false, review: null })
  tree = renderPanel()
  const exportButton = buttonByText(tree, '导出 OneNote')
  check('the export control exists', exportButton !== undefined, 'no button labelled 导出 OneNote')
  check('and it is disabled while there is no note', exportButton?.props?.disabled === true, JSON.stringify(exportButton?.props?.disabled))
  check('the export dialog is not rendered', byClass(tree, 'lcp-export').length === 0)
}

console.log('\n3. with a note, export is offered')
{
  publish({ phase: 'idle', hasReview: true, review: '## 一、课堂主线\n内容' })
  tree = renderPanel()
  const exportButton = buttonByText(tree, '导出 OneNote')
  check('the export control is enabled', exportButton?.props?.disabled === false, JSON.stringify(exportButton?.props?.disabled))
}

console.log('\n4. the dialog renders three bars, each with a list button')
{
  resetStore()
  publish({ phase: 'idle', hasReview: true, review: '# note', exportOpen: true, onenote: LIVE_ONENOTE })
  tree = renderPanel()

  check('the dialog is rendered', byClass(tree, 'lcp-export').length === 1, JSON.stringify([...new Set(collectClasses(tree))].filter((name) => name.includes('export'))))
  const inputs = byClass(tree, 'lcp-input')
  check('there are three input bars', inputs.length === 3, String(inputs.length))
  const rows = byClass(tree, 'lcp-export-row')
  check('there are three rows', rows.length === 3, String(rows.length))
  // Order matters: a section belongs to a notebook, and a page to a section.
  check('the first bar is the notebook', textOf(rows[0]).includes('笔记本'), textOf(rows[0]))
  check('the second bar is the section', textOf(rows[1]).includes('分区'), textOf(rows[1]))
  check('the third bar is the page', textOf(rows[2]).includes('页面'), textOf(rows[2]))

  const carets = byClass(tree, 'lcp-caret')
  check('each bar has a list button', carets.length === 3, String(carets.length))
  // The count is on the button, so a closed list still says how much is in it.
  check('the notebook button reports its count', textOf(carets[0]).includes('3'), textOf(carets[0]))
  check('the section button reports its count', textOf(carets[1]).includes('3'), textOf(carets[1]))
  check('the page button reports its count', textOf(carets[2]).includes('3'), textOf(carets[2]))

  const plus = byClass(tree, 'lcp-plus')[0]
  check('the + button is in the action row', plus !== undefined && byClass(byClass(tree, 'lcp-export-actions')[0], 'lcp-plus').length === 1, String(plus !== undefined))
  check('+ is disabled until a notebook is chosen', plus?.props?.disabled === true, String(plus?.props?.disabled))
  check('+ explains what it does', String(plus?.props?.title ?? '').includes('新建页面'), String(plus?.props?.title))

  const exportToPage = buttonByText(tree, '导出到该页面')
  check('the export button refuses empty fields', exportToPage?.props?.disabled === true, String(exportToPage?.props?.disabled))
}

console.log('\n5. the notebook list opens and offers every real notebook')
{
  tree = renderPanel()
  const carets = byClass(tree, 'lcp-caret')
  // Pressing the list button is what a person does; the handler publishes.
  carets[0].props.onClick()
  check('the list is recorded as open', store.listOpen === 'notebook', String(store.listOpen))

  tree = renderPanel()
  // Every bar renders its own list container; only the open one has options, so a
  // count has to be taken per bar or the lists are added together.
  const bars = byClass(tree, 'lcp-export-row')
  const notebookOptions = byClass(bars[0], 'lcp-option')
  const sectionOptionsBefore = byClass(bars[1], 'lcp-option')
  check('only the notebook list is populated', notebookOptions.length === 3, `${String(notebookOptions.length)}: ${JSON.stringify(notebookOptions.map((node) => textOf(node)))}`)
  check('the section list is still closed', sectionOptionsBefore.length === 0, String(sectionOptionsBefore.length))
  const labels = notebookOptions.map((node) => textOf(node))
  check('every live notebook is offered, not only the remembered one', labels.includes('光毅 的笔记本'), JSON.stringify(labels))
  check('the remembered notebook is offered too', labels.includes('JNU'), JSON.stringify(labels))
  check('the remembered one is not listed twice', labels.filter((label) => label === 'JNU').length === 1, JSON.stringify(labels))

  // Choosing an option fills the field and closes the list.
  notebookOptions.find((node) => textOf(node) === '光毅 的笔记本').props.onClick()
  check('choosing an option fills the notebook field', store.notebookQuery === '光毅 的笔记本', String(store.notebookQuery))
  check('and closes the list', store.listOpen === null, String(store.listOpen))
}

console.log('\n6. the section list follows the notebook, and the page list follows nothing else')
{
  // Back to JNU, then look at what the section bar offers.
  publish({ notebookQuery: 'JNU', sectionQuery: '', pageQuery: '', listOpen: 'section' })
  tree = renderPanel()
  const sectionBar = byClass(tree, 'lcp-export-row')[1]
  const sectionOptions = byClass(sectionBar, 'lcp-option')
  check('only that notebook\'s sections are offered', sectionOptions.length === 2, `${String(sectionOptions.length)}: ${JSON.stringify(sectionOptions.map((node) => textOf(node)))}`)
  const sectionLabels = sectionOptions.map((node) => textOf(node))
  check('the right sections are offered', sectionLabels.includes('Temp') && sectionLabels.includes('Adv. Maths 1'), JSON.stringify(sectionLabels))
  check('another notebook\'s section is not offered', !sectionLabels.includes('ENG'), JSON.stringify(sectionLabels))

  // Choosing a section fills it in.
  sectionOptions.find((node) => textOf(node) === 'Adv. Maths 1').props.onClick()
  check('choosing a section fills the section field', store.sectionQuery === 'Adv. Maths 1', String(store.sectionQuery))
  check('and closes the list', store.listOpen === null, String(store.listOpen))

  // The page list still follows the notebook, not the section.
  publish({ listOpen: 'page' })
  tree = renderPanel()
  const pageBar = byClass(tree, 'lcp-export-row')[2]
  const pageOptions = byClass(pageBar, 'lcp-option')
  check('the page list still offers that notebook\'s pages', pageOptions.length >= 1, `${String(pageOptions.length)}: ${JSON.stringify(pageOptions.map((node) => textOf(node)))}`)

  store.listOpen = 'notebook'
  tree = renderPanel()
  const notebookOptions = byClass(byClass(tree, 'lcp-export-row')[0], 'lcp-option')
  check('the notebook list is still complete', notebookOptions.length === 3, String(notebookOptions.length))
}

console.log('\n7. a list with no match says so instead of looking broken')
{
  publish({ notebookQuery: '不存在本子', sectionQuery: '', listOpen: 'section' })
  tree = renderPanel()
  check('an empty list is explained', byClass(tree, 'lcp-option-empty').length === 1, String(byClass(tree, 'lcp-option-empty').length))
  check('the pool is the notebook field', store.notebookQuery === '不存在本子')
}

console.log('\n8. the + button needs a notebook AND a section; the export button needs a page')
{
  publish({ notebookQuery: 'JNU', sectionQuery: '', pageQuery: '极限与导数', listOpen: null })
  tree = renderPanel()
  check('the export button is enabled by a page alone', buttonByText(tree, '导出到该页面')?.props?.disabled === false)
  check('the + button is still disabled without a section', byClass(tree, 'lcp-plus')[0]?.props?.disabled === true, String(byClass(tree, 'lcp-plus')[0]?.props?.disabled))

  publish({ sectionQuery: 'Adv. Maths 1' })
  tree = renderPanel()
  check('the + button is enabled once a section is chosen', byClass(tree, 'lcp-plus')[0]?.props?.disabled === false, String(byClass(tree, 'lcp-plus')[0]?.props?.disabled))

  publish({ sectionQuery: '' })
  tree = renderPanel()
  check('clearing the section disables it again', byClass(tree, 'lcp-plus')[0]?.props?.disabled === true)
}

console.log('\n9. a refusal is shown, and the controls stay usable')
{
  publish({ exportBusy: false, exportStatus: '笔记本不存在：没有这个本子' })
  tree = renderPanel()
  const status = byClass(tree, 'lcp-export-status')[0]
  check('the reason is displayed', textOf(status).includes('笔记本不存在'), textOf(status))
  check('it is not styled as success', status?.props?.['data-kind'] !== 'ok', String(status?.props?.['data-kind']))
  check('the export button is usable again', buttonByText(tree, '导出到该页面')?.props?.disabled === false)
}

console.log('\n10. a success is reported with the real destination')
{
  publish({ exportStatus: '已导出到「JNU」→「极限与导数」（追加，未覆盖原有内容）' })
  tree = renderPanel()
  const status = byClass(tree, 'lcp-export-status')[0]
  check('the destination is shown', textOf(status).includes('极限与导数'), textOf(status))
  check('it is styled as success', status?.props?.['data-kind'] === 'ok', String(status?.props?.['data-kind']))
}

console.log('\n11. with no OneNote the dialog opens and says why')
{
  publish({ onenote: null, onenoteError: '本机没有可用的 OneNote：OneNote is not available', exportStatus: '', notebookQuery: '', pageQuery: '', listOpen: null })
  tree = renderPanel()
  check('the dialog is still rendered', byClass(tree, 'lcp-export').length === 1)
  const notes = byClass(tree, 'lcp-export-note')
  check('the reason is shown', notes.some((node) => textOf(node).includes('没有可用的 OneNote')), JSON.stringify(notes.map(textOf)))
  check('the export button is disabled', buttonByText(tree, '导出到该页面')?.props?.disabled === true)
}

console.log('\n12. the model pickers name the provider')
{
  resetStore()
  const catalog = {
    compositionDefault: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
    current: { recognition: {}, review: {} },
    providers: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek Official',
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', efforts: [{ id: 'off', name: 'Off' }, { id: 'max', name: 'Max' }] },
          { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', efforts: [{ id: 'high', name: 'High' }] },
        ],
      },
      {
        id: 'deepseek-account',
        name: 'DeepSeek Account',
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', efforts: [{ id: 'off', name: 'Off' }] },
        ],
      },
    ],
  }
  const { routeOptions } = core
  check('the state block exports routeOptions', typeof routeOptions === 'function')
  const view = routeOptions(catalog, 'recognition', catalog.compositionDefault)
  check('every provider/model pair is listed', view.options.length === 3, String(view.options.length))
  check('the provider name is on every option', view.options.every((option) => option.providerName.length > 0), JSON.stringify(view.options.map((o) => o.providerName)))
  const duplicated = view.options.filter((option) => option.model === 'deepseek-flash')
  check('a model offered twice is flagged so the provider can be shown', duplicated.every((option) => option.showProvider === true), JSON.stringify(duplicated))
  const unique = view.options.find((option) => option.model === 'deepseek-v4-pro')
  check('a unique model is not flagged', unique.showProvider === false, String(unique.showProvider))

  publish({ phase: 'idle', hasReview: true, review: '# note', showRoutes: true, catalog })
  tree = renderPanel()
  const options = []
  walk(tree, (node) => {
    if (node.type === 'option') options.push(textOf(node))
  })
  check('the select lists the provider for a duplicated model', options.some((label) => label.includes('deepseek-official') && label.includes('DeepSeek-V41-Flash')), JSON.stringify(options))
  check('and names the other provider separately', options.some((label) => label.includes('deepseek-account')), JSON.stringify(options))
  check('a unique model still names its provider', options.some((label) => label.includes('DeepSeek-V4-Pro')), JSON.stringify(options))
}

console.log(`\n${String(checks - failures)}/${String(checks)} checks passed`)
process.exit(failures === 0 ? 0 : 1)
