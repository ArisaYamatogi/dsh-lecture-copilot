/**
 * Lecture Copilot — panel state, as a plain testable module.
 *
 * The offline harness loads this file with Node and drives the two sequences that
 * only ever misbehaved in a live page: a row frozen on "翻译中…" and a review that
 * stayed collapsed. The browser half cannot require it — a bundle may only rely
 * on the platform table and package specifiers — so the same block is inlined
 * there, and a drift guard in the harness fails if the two ever disagree.
 *
 * CommonJS on purpose: the harness reaches it through `createRequire`, which
 * ignores this package's `type: module`.
 */

/** The panel state. */
const store = {
  phase: 'idle',
  segments: [],
  elapsedMs: 0,
  total: 0,
  translated: 0,
  pending: 0,
  hasReview: false,
  reviewPending: false,
  review: null,
  reviewOpen: false,
  error: '',
  level: 0,
  // Per-task route picking: `{ providers, current, compositionDefault }`.
  catalog: null,
  catalogError: '',
  showRoutes: false,
  // OneNote export: the dialog's own inputs plus the server's remembered names.
  exportOpen: false,
  onenote: null,
  onenoteError: '',
  notebookQuery: '',
  // The section a new page is created in. Required for the + button.
  sectionQuery: '',
  pageQuery: '',
  exportBusy: false,
  exportStatus: '',
  // Which export field has its candidate list open, or `null` for none.
  listOpen: null,
}
const listeners = new Set()

/**
 * Apply a patch and notify every subscriber.
 *
 * Views must not read the store through a snapshot comparison: this mutates one
 * long-lived object, so a snapshot getter keeps returning the same reference and
 * React skips every re-render — the panel then only catches up when it happens
 * to remount. Subscribers are notified imperatively instead.
 */
function publish(patch) {
  Object.assign(store, patch)
  for (const listener of listeners) listener()
}

/** Subscribe a view to store changes; returns the unsubscribe function. */
function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Apply one `/state` reply.
 *
 * The segment list is *replaced*, never merged. `/state` is asked without a
 * `since` cursor, so it is the complete truth; merging by id kept the first
 * version of every known row, which froze each one at whatever it looked like
 * when it first arrived — a segment stayed "翻译中…" for the rest of the lecture
 * even though the Host had translated it seconds later.
 */
function applyState(reply) {
  const state = reply?.state ?? {}
  publish({
    segments: Array.isArray(state.segments) ? state.segments : [],
    elapsedMs: state.elapsedMs ?? 0,
    total: state.total ?? 0,
    translated: state.translated ?? 0,
    pending: state.pending ?? 0,
    hasReview: state.hasReview === true,
    reviewPending: state.reviewPending === true,
    error: state.reviewError === null || state.reviewError === undefined ? store.error : '',
  })
}

/**
 * What a settled review pass means for the panel.
 *
 * The pane renders from `review`, not from `reviewOpen`, so a caller that sets
 * only the flag shows a "收起笔记" button over an empty pane.
 */
function reviewOutcome(state) {
  if (state.hasReview === true) return 'fetch'
  if (state.reviewError) return 'failed'
  if (state.reviewPending === true) return 'wait'
  return 'empty'
}

/** One segment's Chinese line, including its pending and failed forms. */
function translationLine(segment) {
  if (typeof segment.translation === 'string' && segment.translation.length > 0) return segment.translation
  if (segment.state === 'failed') return `翻译失败：${segment.error ?? '模型未返回内容'}`
  return '翻译中…'
}

/**
 * Build the option lists one task's route picker renders.
 *
 * The picker has to express three things at once: which models exist, which
 * reasoning levels the chosen model accepts, and what "follow the default"
 * means. This reduces the catalog to exactly those, so the view stays dumb.
 * @param catalog - the `/models` payload, or `null` before it arrives.
 * @param task - `'recognition'` or `'review'`.
 * @param fallback - the composition default selection, for the label.
 * @returns the picker's view model.
 */
function routeOptions(catalog, task, fallback) {
  const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
  const current = catalog?.current?.[task] ?? {}
  const options = []
  for (const provider of providers) {
    for (const model of provider.models ?? []) {
      options.push({
        key: `${provider.id}\u0000${model.id}`,
        provider: provider.id,
        providerName: provider.name ?? provider.id,
        model: model.id,
        modelName: model.name ?? model.id,
        efforts: Array.isArray(model.efforts) ? model.efforts : [],
        defaultEffort: model.defaultEffort,
      })
    }
  }
  const selected = options.find((entry) => entry.provider === current.provider && entry.model === current.model)
  // A model id offered by two providers appears twice in the list; those are
  // genuinely different routes, so each entry says which provider it goes to.
  const duplicated = new Set(
    options
      .map((entry) => entry.model)
      .filter((model, index, all) => all.indexOf(model) !== index),
  )
  return {
    options: options.map((entry) => ({ ...entry, showProvider: duplicated.has(entry.model) })),
    selectedKey: selected?.key ?? '',
    // A model that declares reasoning levels gets a second picker; one that does
    // not gets none, rather than a control that silently does nothing.
    efforts: selected?.efforts ?? [],
    effort: current.reasoningEffort ?? '',
    fallbackLabel: fallback === null || fallback === undefined
      ? '组合默认'
      : `${fallback.provider}/${fallback.model}${fallback.reasoningEffort === undefined ? '' : ` · ${fallback.reasoningEffort}`}`,
  }
}
/* ------------------------------------------------------- end of state block */

/**
 * Reset the module store to its initial shape.
 *
 * The browser half never calls this — its store lives for the page. The harness
 * calls it between scenarios so each one starts from a clean panel.
 */
function resetStore() {
  Object.assign(store, {
    phase: 'idle',
    segments: [],
    elapsedMs: 0,
    total: 0,
    translated: 0,
    pending: 0,
    hasReview: false,
    reviewPending: false,
    review: null,
    reviewOpen: false,
    error: '',
    level: 0,
    catalog: null,
    catalogError: '',
    showRoutes: false,
    exportOpen: false,
    onenote: null,
    onenoteError: '',
    notebookQuery: '',
    sectionQuery: '',
    pageQuery: '',
    exportBusy: false,
    exportStatus: '',
    listOpen: null,
  })
  listeners.clear()
}

module.exports = { store, publish, subscribe, applyState, reviewOutcome, translationLine, routeOptions, resetStore }
