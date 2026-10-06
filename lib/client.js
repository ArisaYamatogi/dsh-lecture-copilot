/**
 * Lecture Copilot — browser half.
 *
 * A floating microphone control in the frame-wide overlay plus the live
 * bilingual panel behind it:
 *
 *   press the button   → start a Host lecture, open the microphone
 *   while recording    → the page slices speech on natural pauses, encodes
 *                        each slice as 16 kHz mono PCM16 WAV, and posts it to
 *                        the Host, which transcribes it and translates it
 *   press it again     → stop capture, translate the backlog, and build the
 *                        structured review
 *
 * Everything model-facing happens on the Host; this half only captures audio
 * and renders what comes back. It is plain CommonJS in the client module
 * format — no JSX, React arrives through the module table.
 */

window.__ModuleLoader__.load({
  id: 'dsh-lecture-copilot-plugin',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /* ------------------------------------------------- panel state (inlined) */
    // Kept byte-equivalent to `lib/state.js`, which the offline harness loads and
    // tests directly — this half must stay self-contained, because only the
    // platform table and package specifiers are documented as resolvable from a
    // plugin bundle. A source guard in the harness fails if the two drift.
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

    /* ---------------------------------------------------------------- styles */

    // The panel deliberately sits above the whole shell. DSH's own stacks go up
    // to 1000 (the modal root, a fixed inset:0 layer that accepts pointer events)
    // and 1100 (portals and toasts); anything lower has its clicks swallowed by
    // an invisible full-screen layer, which is exactly "the button does not
    // press". The surface is opaque so the app's own text never shows through.
    const CSS = `
.lcp-root{--lcp-bg:#1c1c1e;--lcp-bg-soft:#242426;--lcp-line:rgba(255,255,255,.14);--lcp-fg:#f2f2f4;--lcp-dim:#9b9ba3;--lcp-accent:#3b82f6;--lcp-danger:#ff6b6b}
.lcp-launcher{position:fixed;right:22px;bottom:96px;z-index:1200;display:flex;align-items:center;gap:8px;height:40px;padding:0 14px;border-radius:20px;border:1px solid var(--lcp-line);background:var(--lcp-bg);color:var(--lcp-fg);font:inherit;font-size:13px;cursor:pointer;box-shadow:0 8px 26px rgba(0,0,0,.45)}
.lcp-launcher:hover{border-color:var(--lcp-accent)}
.lcp-panel{position:fixed;right:22px;bottom:96px;z-index:1200;width:min(440px,calc(100vw - 44px));max-height:min(70vh,680px);display:flex;flex-direction:column;border-radius:14px;border:1px solid var(--lcp-line);background:var(--lcp-bg);color:var(--lcp-fg);box-shadow:0 18px 52px rgba(0,0,0,.6);overflow:hidden;isolation:isolate}
.lcp-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:.5px solid var(--lcp-line);background:var(--lcp-bg-soft)}
.lcp-dot{width:9px;height:9px;border-radius:50%;background:var(--lcp-dim);flex:none}
.lcp-dot[data-state="rec"]{background:#ff5a5f;animation:lcp-pulse 1.6s infinite}
.lcp-dot[data-state="work"]{background:#f5a524;animation:lcp-pulse 1.2s infinite}
.lcp-dot[data-state="ok"]{background:#2fa36b}
.lcp-dot[data-state="err"]{background:#ff5a5f}
@keyframes lcp-pulse{0%{opacity:1}50%{opacity:.35}100%{opacity:1}}
.lcp-title{font-size:13px;font-weight:600;white-space:nowrap}
.lcp-meta{font-size:12px;color:var(--lcp-dim);margin-left:auto;white-space:nowrap}
.lcp-body{overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px;min-height:60px;background:var(--lcp-bg)}
.lcp-empty{color:var(--lcp-dim);font-size:12.5px;line-height:1.7}
.lcp-seg{display:flex;flex-direction:column;gap:4px;padding-bottom:9px;border-bottom:.5px dashed var(--lcp-line)}
.lcp-seg:last-child{border-bottom:0;padding-bottom:0}
.lcp-en{font-size:12.5px;line-height:1.6;color:var(--lcp-dim)}
.lcp-zh{font-size:14px;line-height:1.75;color:var(--lcp-fg)}
.lcp-seg[data-state="queued"] .lcp-zh,.lcp-seg[data-state="translating"] .lcp-zh{color:var(--lcp-dim)}
.lcp-seg[data-state="failed"] .lcp-zh{color:var(--lcp-danger)}
.lcp-time{font-size:11px;color:var(--lcp-dim);font-variant-numeric:tabular-nums}
.lcp-wave{display:flex;align-items:flex-end;gap:2px;height:18px}
.lcp-wave i{display:block;width:3px;border-radius:1.5px;background:var(--lcp-accent);height:3px;transition:height .08s linear}
.lcp-foot{display:flex;align-items:center;gap:8px;padding:9px 12px;border-top:.5px solid var(--lcp-line);background:var(--lcp-bg-soft)}
.lcp-btn{font:inherit;font-size:12.5px;cursor:pointer;padding:5px 11px;border-radius:7px;border:1px solid var(--lcp-line);background:transparent;color:var(--lcp-fg)}
.lcp-btn:hover:not(:disabled){border-color:var(--lcp-accent)}
.lcp-btn[data-kind="primary"]{background:var(--lcp-accent);border-color:transparent;color:#fff}
.lcp-btn[data-kind="danger"]{color:var(--lcp-danger);border-color:rgba(255,107,107,.5)}
.lcp-btn[data-active="true"]{background:var(--lcp-accent);border-color:transparent;color:#fff}
.lcp-btn:disabled{opacity:.4;cursor:default}
.lcp-review{margin:0;padding:10px 12px;border-top:.5px solid var(--lcp-line);max-height:44vh;overflow-y:auto;white-space:pre-wrap;word-break:break-word;font-size:12.5px;line-height:1.75;font-family:inherit;background:#161618;color:var(--lcp-fg)}
.lcp-routes{border-top:.5px solid var(--lcp-line);background:var(--lcp-bg-soft);padding:8px 12px 10px;display:flex;flex-direction:column;gap:8px}
.lcp-route{display:flex;flex-direction:column;gap:4px}
.lcp-route-label{font-size:11.5px;color:var(--lcp-dim)}
.lcp-route-row{display:flex;gap:6px;flex-wrap:wrap}
.lcp-select{flex:1 1 140px;min-width:0;font:inherit;font-size:12px;padding:4px 6px;border-radius:6px;border:1px solid var(--lcp-line);background:#141416;color:var(--lcp-fg)}
.lcp-select:disabled{opacity:.5}
.lcp-route-note{font-size:11px;color:var(--lcp-dim)}
.lcp-err{padding:7px 12px;font-size:12px;color:var(--lcp-danger);border-top:.5px solid var(--lcp-line);background:var(--lcp-bg-soft)}
.lcp-err[hidden]{display:none}
.lcp-export{border-top:.5px solid var(--lcp-line);background:var(--lcp-bg-soft);padding:9px 12px 11px;display:flex;flex-direction:column;gap:8px}
.lcp-export-head{display:flex;flex-direction:column;gap:2px}
.lcp-export-title{font-size:12.5px;font-weight:600;color:var(--lcp-fg)}
.lcp-export-sub{font-size:11px;color:var(--lcp-dim)}
.lcp-export-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.lcp-export-label{flex:0 0 42px;font-size:11.5px;color:var(--lcp-dim)}
.lcp-combo{flex:1 1 150px;min-width:0;display:flex;gap:4px}
.lcp-input{flex:1 1 auto;min-width:0;font:inherit;font-size:12px;padding:4px 7px;border-radius:6px;border:1px solid var(--lcp-line);background:#141416;color:var(--lcp-fg)}
.lcp-input:disabled{opacity:.5}
.lcp-caret{flex:0 0 auto;padding:4px 8px;font-size:11.5px;min-width:44px}
.lcp-caret[data-open]{border-color:var(--lcp-accent);color:var(--lcp-accent)}
/* A panel-drawn list, not a datalist: this one scrolls with the wheel and is
   not positioned by the OS outside the panel's stacking context. */
.lcp-options{flex:1 1 100%;max-height:168px;overflow-y:auto;overscroll-behavior:contain;margin:2px 0 0 48px;
  border:1px solid var(--lcp-line);border-radius:6px;background:#121214;display:flex;flex-direction:column}
.lcp-option{display:block;width:100%;text-align:left;font:inherit;font-size:11.5px;padding:5px 8px;
  background:transparent;color:var(--lcp-fg);border:0;border-bottom:.5px solid rgba(255,255,255,.06);cursor:pointer}
.lcp-option:last-child{border-bottom:0}
.lcp-option:hover{background:#232326}
.lcp-option[data-active=true]{color:var(--lcp-accent)}
.lcp-option-empty{padding:6px 8px;font-size:11.5px;color:var(--lcp-dim)}
.lcp-plus{flex:0 0 auto;padding:4px 10px;font-size:14px;line-height:1.1}
.lcp-export-actions{display:flex;gap:6px}
.lcp-export-note{font-size:11.5px;color:var(--lcp-dim)}
.lcp-export-note[data-kind=warn]{color:var(--lcp-danger)}
.lcp-export-status{font-size:11.5px;color:var(--lcp-danger);min-height:15px;word-break:break-all}
.lcp-export-status[data-kind=ok]{color:#4ade80}
`

    const tagId = 'dsh-lecture-copilot-plugin/panel.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${tagId}"]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-lecture-copilot-plugin'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* --------------------------------------------------------------- wiring */

    const BASE = '/lecture-copilot'
    const TICK_MS = 1200
    /** How long the panel waits for a background review before giving up. */
    const REVIEW_WAIT_MS = 10 * 60 * 1000

    /** Read the live store object, for a view that tracks its own revision. */
    const getStore = () => store

    /** Format an elapsed duration as mm:ss. */
    function clock(ms) {
      const total = Math.max(0, Math.round(ms / 1000))
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
    }

    /**
     * One same-origin JSON request against the Host carrier. The page's signed
     * browser-session cookie authorizes it; nothing else is needed.
     * @param path - route suffix.
     * @param options - optional method and JSON body.
     * @returns the decoded JSON reply.
     */
    async function api(path, options = {}) {
      const response = await fetch(`${BASE}${path}`, {
        method: options.method ?? 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        ...options.body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(options.body) },
      })
      const payload = await response.json().catch(() => undefined)
      if (!response.ok || payload === undefined) {
        // A refusal still carries the reason the person needs — "there is no note
        // to export yet" is an answer, not a transport failure — so it is
        // surfaced instead of being flattened into a status code.
        throw new Error(payload?.error ?? `HTTP ${String(response.status)}`)
      }
      return payload
    }

    /** One poll of the Host state. */
    async function poll() {
      try {
        applyState(await api('/state'))
      } catch (error) {
        publish({ error: `无法连接后台服务：${String(error.message ?? error)}` })
      }
    }

    /* -------------------------------------------------------------- recording */

    /** Linear resampler to the recognizer's 16 kHz mono rate. */
    function resample(input, from, to) {
      const output = new Float32Array(Math.max(1, Math.floor((input.length * to) / from)))
      const ratio = from / to
      for (let index = 0; index < output.length; index += 1) {
        const position = index * ratio
        const low = Math.floor(position)
        const high = Math.min(low + 1, input.length - 1)
        output[index] = input[low] + (input[high] - input[low]) * (position - low)
      }
      return output
    }

    /**
     * Encode mono samples as the canonical PCM16 WAV the Host accepts.
     * @param samples - 16 kHz mono samples in [-1, 1].
     * @returns complete little-endian WAV bytes.
     */
    function encodeWave(samples) {
      const bytes = new Uint8Array(44 + samples.length * 2)
      const view = new DataView(bytes.buffer)
      const text = (at, value) => {
        for (let index = 0; index < value.length; index += 1) bytes[at + index] = value.charCodeAt(index)
      }
      text(0, 'RIFF')
      view.setUint32(4, bytes.length - 8, true)
      text(8, 'WAVE')
      text(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true)
      view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      text(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let index = 0; index < samples.length; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
      }
      return bytes
    }

    /**
     * Open the microphone and slice speech on natural pauses.
     *
     * A lecture is continuous speech: a fixed-length cut lands mid-word and
     * costs recognition accuracy, while waiting for a long pause costs
     * latency. The capture therefore emits a chunk when a pause of
     * `silenceMs` follows speech of at least `minSpeechMs`, and force-emits
     * every `maxSegmentMs` so a fast talker still flows.
     */
    class Capture {
      constructor(onSegment, onLevel, onError) {
        this.onSegment = onSegment
        this.onLevel = onLevel
        this.onError = onError
        this.samples = []
        this.preRoll = []
        this.durationMs = 0
        this.silenceMs = 0
        this.speaking = false
        this.forceAt = 14000
        this.silenceLimit = 700
        this.minSpeechMs = 900
        this.minEmitMs = 1200
        this.prerollFrames = 8
        this.frameMs = 0
      }

      /** Begin capture; rejects when the microphone is unavailable or denied. */
      async start() {
        if (navigator.mediaDevices === undefined || typeof AudioContext === 'undefined') {
          throw new Error('当前浏览器不支持麦克风采集')
        }
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: true,
          },
          video: false,
        })
        this.context = new AudioContext()
        if (this.context.state === 'suspended') await this.context.resume()
        this.rate = this.context.sampleRate
        this.source = this.context.createMediaStreamSource(this.stream)
        this.node = this.context.createScriptProcessor(4096, 1, 1)
        this.frameMs = (4096 / this.rate) * 1000
        this.silent = this.context.createGain()
        this.silent.gain.value = 0
        this.node.onaudioprocess = (event) => this.push(event.inputBuffer.getChannelData(0))
        this.source.connect(this.node)
        this.node.connect(this.silent)
        this.silent.connect(this.context.destination)
      }

      /** Feed one analyser frame and emit a chunk when a boundary is reached. */
      push(frame) {
        let sum = 0
        for (let index = 0; index < frame.length; index += 1) sum += frame[index] * frame[index]
        const rms = Math.sqrt(sum / frame.length)
        this.onLevel(Math.min(1, rms * 9))

        const voiced = rms > 0.012
        const collecting = this.samples.length > 0

        if (voiced) {
          if (!collecting) {
            // Keep the onset: the pause before a word is that word's start.
            this.samples = this.preRoll.splice(0)
          }
          this.samples.push(new Float32Array(frame))
          this.durationMs += this.frameMs
          this.silenceMs = 0
          this.speaking = true
        } else if (collecting) {
          // Trailing silence is kept so a pause never clips the last syllable.
          this.samples.push(new Float32Array(frame))
          this.durationMs += this.frameMs
          this.silenceMs += this.frameMs
        } else {
          this.preRoll.push(new Float32Array(frame))
          if (this.preRoll.length > this.prerollFrames) this.preRoll.shift()
        }

        const pauseBoundary = this.speaking && this.silenceMs >= this.silenceLimit && this.durationMs >= this.minSpeechMs
        const forcedBoundary = this.durationMs >= this.forceAt
        if (pauseBoundary || forcedBoundary) {
          this.speaking = false
          this.flush()
        }
      }

      /** Emit the accumulated audio as one WAV chunk. */
      flush() {
        if (this.durationMs < this.minEmitMs) {
          this.samples = []
          this.preRoll = []
          this.durationMs = 0
          this.silenceMs = 0
          return
        }
        const total = this.samples.reduce((size, frame) => size + frame.length, 0)
        const joined = new Float32Array(total)
        let offset = 0
        for (const frame of this.samples) {
          joined.set(frame, offset)
          offset += frame.length
        }
        this.samples = []
        this.preRoll = []
        this.durationMs = 0
        this.silenceMs = 0
        try {
          this.onSegment(encodeWave(resample(joined, this.rate, 16000)))
        } catch (error) {
          this.onError?.(error)
        }
      }

      /** Stop capture and release every device and node. */
      async stop() {
        try {
          this.node.onaudioprocess = null
          this.node.disconnect()
          this.source.disconnect()
          this.silent.disconnect()
        } catch {
          /* nodes already torn down */
        }
        this.stream?.getTracks().forEach((track) => track.stop())
        try {
          await this.context?.close()
        } catch {
          /* context already closed */
        }
        this.onLevel(0)
      }
    }

    /* ------------------------------------------------------------------ views */

    /** One segment rendered as its time, English original, and Chinese line. */
    function SegmentView({ segment }) {
      return h('div', { className: 'lcp-seg', 'data-state': segment.state },
        h('span', { className: 'lcp-time' }, segment.at),
        h('div', { className: 'lcp-en' }, segment.text),
        h('div', { className: 'lcp-zh' }, translationLine(segment)),
      )
    }

    /** The running level meter: five bars driven by the analyser RMS. */
    function LevelMeter({ level }) {
      const bars = [0.35, 0.6, 0.85, 1, 0.7]
      return h('div', { className: 'lcp-wave', 'aria-hidden': 'true' },
        bars.map((weight, index) => h('i', {
          key: index,
          style: { height: `${Math.round(3 + Math.min(1, level * weight * 2.2) * 15)}px` },
        })),
      )
    }

    /**
     * One task's route picker: model, plus the reasoning levels that model
     * declares. An empty model means "follow the deployment default", which is
     * spelled out with the actual default so the person can see what they get.
     */
    function RoutePicker({ label, view, note, disabled, onSelect }) {
      const modelValue = view.selectedKey === '' ? '' : view.selectedKey
      return h('div', { className: 'lcp-route' },
        h('span', { className: 'lcp-route-label' }, label),
        h('div', { className: 'lcp-route-row' },
          h('select', {
            className: 'lcp-select',
            value: modelValue,
            disabled: disabled || view.options.length === 0,
            onChange: (event) => onSelect(event.target.value),
          },
            h('option', { value: '' }, `默认 · ${view.fallbackLabel}`),
            view.options.map((option) => h('option', { key: option.key, value: option.key },
              // The provider is shown when the same model id is offered by more
              // than one provider: those are different routes, not duplicates.
              `${option.providerName}${option.showProvider ? ` · ${option.provider}` : ''} — ${option.modelName}`)),
          ),
          view.efforts.length === 0
            ? null
            : h('select', {
              className: 'lcp-select',
              style: { flex: '0 1 96px' },
              value: view.effort,
              disabled,
              onChange: (event) => onSelect(view.selectedKey, event.target.value),
            },
              h('option', { value: '' }, '默认推理'),
              view.efforts.map((effort) => h('option', { key: effort.id, value: effort.id }, effort.name ?? effort.id)),
            ),
        ),
        note === '' ? null : h('span', { className: 'lcp-route-note' }, note),
      )
    }

    /**
     * One export bar: a text field, a list button, and optional extras.
     *
     * The list is drawn by this component rather than handed to a native
     * `datalist`. A `<datalist>` popup is an OS-level window that the browser
     * positions itself, and inside the panel's own fixed, isolated stacking
     * context it never appeared at all — and because it is not part of the DOM it
     * could not be scrolled either. A panel-rendered list scrolls with the wheel,
     * matches the dark palette, and can be asserted on in a test.
     *
     * @param props - `label`, `value`, `placeholder`, `options`, `open`, and the
     *   change/open callbacks, plus anything to render after the list button.
     */
    function ExportBar({ label, value, placeholder, options, open, disabled, onInput, onToggle, children }) {
      return h('div', { className: 'lcp-export-row' },
        h('span', { className: 'lcp-export-label' }, label),
        h('div', { className: 'lcp-combo' },
          h('input', {
            className: 'lcp-input',
            placeholder,
            value,
            disabled,
            onChange: (event) => onInput(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                if (!open) onToggle()
              }
            },
          }),
          h('button', {
            type: 'button',
            className: 'lcp-btn lcp-caret',
            'data-open': open ? 'true' : undefined,
            disabled,
            title: open ? '收起候选列表' : `展开候选列表（${String(options.length)} 项）`,
            onClick: onToggle,
          }, open ? '▴' : `▾ ${String(options.length)}`),
        ),
        open
          ? h('div', { className: 'lcp-options' },
            options.length === 0
              ? h('div', { className: 'lcp-option-empty' }, '没有匹配项，仍可直接输入')
              : options.map((option) => h('button', {
                key: option.key,
                type: 'button',
                className: 'lcp-option',
                'data-active': option.value === value ? 'true' : undefined,
                onClick: () => onInput(option.value, true),
              }, option.label)),
          )
          : null,
        children,
      )
    }

    /**
     * The OneNote export dialog.
     *
     * Both fields are text inputs: a person can type a notebook or page from
     * memory, or pick one from the list. Every choice is re-checked by the Host
     * against the live notebook tree, so a remembered name that no longer exists
     * is reported rather than silently written somewhere else — and a name that
     * does not exist writes nothing at all.
     *
     * The `+` button deliberately offers no page field: it creates a page in the
     * chosen notebook and names it from the course and the time.
     */
    function ExportDialog({ view, state, onExport, onNewPage, onClose }) {
      const known = state.onenote
      // Live notebooks as well as remembered ones: on a first run nothing has
      // been remembered yet, and an empty list would look like a broken control.
      const notebooks = [...new Set([...(known?.rememberedNotebooks ?? []), ...(known?.notebooks ?? [])])]
        .map((name) => ({ key: `n-${name}`, value: name, label: name, remembered: (known?.rememberedNotebooks ?? []).includes(name) }))

      const typed = state.notebookQuery.trim()
      const onlyThisNotebook = (entry) => typed.length === 0 || entry.notebook === typed

      // Sections belong to a notebook, so this list follows the notebook bar the
      // way the page list does. A section is required to create a page: without
      // one the note would land in a section nobody chose.
      const sections = (known?.sections ?? [])
        .filter(onlyThisNotebook)
        .map((entry) => ({
          key: `s-${entry.notebook}-${entry.name}`,
          value: entry.name,
          label: typed.length === 0 ? `${entry.name}　（${entry.notebook}）` : entry.name,
        }))

      const sectionTyped = state.sectionQuery.trim()
      const rememberedPages = (known?.rememberedPages ?? []).filter(onlyThisNotebook)
      const livePages = (known?.pages ?? []).filter(onlyThisNotebook)

      // Remembered destinations first, each named once even if it also appears in
      // the live tree, because that is the one this person actually reuses.
      const pageKeys = new Set(rememberedPages.map((entry) => `${entry.notebook}\u0000${entry.page}`))
      const pages = [
        ...rememberedPages.map((entry) => ({
          key: `rp-${entry.notebook}-${entry.page}`,
          value: entry.page,
          label: typed.length === 0 ? `${entry.page}　（${entry.notebook}）` : entry.page,
        })),
        ...livePages
          .filter((entry) => !pageKeys.has(`${entry.notebook}\u0000${entry.name}`))
          .map((entry) => ({
            key: `lp-${entry.notebook}-${entry.section}-${entry.name}`,
            value: entry.name,
            label: typed.length === 0 ? `${entry.name}　（${entry.notebook} / ${entry.section}）` : `${entry.name}　（${entry.section}）`,
          })),
      ]

      const busy = state.exportBusy
      const notebookOpen = state.listOpen === 'notebook'
      const sectionOpen = state.listOpen === 'section'
      const pageOpen = state.listOpen === 'page'

      return h('div', { className: 'lcp-export' },
        h('div', { className: 'lcp-export-head' },
          h('span', { className: 'lcp-export-title' }, '导出到 OneNote'),
          h('span', { className: 'lcp-export-sub' }, '追加到已有页面 · 不会覆盖原有内容'),
        ),

        h(ExportBar, {
          label: '笔记本',
          value: state.notebookQuery,
          placeholder: '输入或选择笔记本名',
          options: notebooks,
          open: notebookOpen,
          disabled: busy,
          onInput: (value) => publish({ notebookQuery: value, exportStatus: '', listOpen: null }),
          onToggle: () => publish({ listOpen: notebookOpen ? null : 'notebook' }),
        }),

        h(ExportBar, {
          label: '分区',
          value: state.sectionQuery,
          placeholder: typed.length === 0 ? '先选笔记本，或直接输入分区名' : `在「${typed}」中查找分区`,
          options: sections,
          open: sectionOpen,
          disabled: busy,
          onInput: (value) => publish({ sectionQuery: value, exportStatus: '', listOpen: null }),
          onToggle: () => publish({ listOpen: sectionOpen ? null : 'section' }),
        }),

        h(ExportBar, {
          label: '页面',
          value: state.pageQuery,
          placeholder: sectionTyped.length === 0 ? '要导出到哪个已有页面' : `在「${sectionTyped}」中查找页面`,
          options: pages,
          open: pageOpen,
          disabled: busy,
          onInput: (value) => publish({ pageQuery: value, exportStatus: '', listOpen: null }),
          onToggle: () => publish({ listOpen: pageOpen ? null : 'page' }),
        }),

        h('div', { className: 'lcp-export-actions' },
          h('button', {
            type: 'button',
            className: 'lcp-btn',
            'data-kind': 'primary',
            disabled: busy || typed.length === 0 || state.pageQuery.trim().length === 0,
            onClick: onExport,
          }, busy ? '写入中…' : '导出到该页面'),
          h('button', {
            type: 'button',
            className: 'lcp-btn lcp-plus',
            title: '在所选笔记本与分区内新建页面并导出（标题由笔记内容自动生成）',
            disabled: busy || typed.length === 0 || sectionTyped.length === 0,
            onClick: onNewPage,
          }, '＋ 新建页面'),
          h('button', {
            type: 'button',
            className: 'lcp-btn',
            disabled: busy,
            onClick: onClose,
          }, '关闭'),
        ),

        known === null && state.onenoteError === ''
          ? h('div', { className: 'lcp-export-note' }, '正在读取本机 OneNote 笔记本…')
          : null,
        state.onenoteError === ''
          ? null
          : h('div', { className: 'lcp-export-note', 'data-kind': 'warn' }, state.onenoteError),
        // `view` is null when OneNote could not be reached, so the count line must
        // not assume a tree came back — reading through it would crash the panel
        // exactly when the person needs to be told what went wrong.
        view === null || view === undefined
          ? null
          : h('div', { className: 'lcp-export-note' },
            `本机共 ${String(view.notebooks.length)} 个笔记本 / ${String(view.pages.length)} 个页面`),
        h('div', {
          className: 'lcp-export-status',
          'data-kind': state.exportStatus.startsWith('已导出') || state.exportStatus.startsWith('已在') ? 'ok' : undefined,
        }, state.exportStatus),
      )
    }

    /** The floating control: a launcher while idle, the live panel while busy. */
    function LectureCopilot() {
      // `useSyncExternalStore` cannot drive this store: `publish` mutates one
      // long-lived object, so its snapshot getter keeps returning the same
      // reference and React treats every update as a no-op. A revision counter
      // plus an explicit subscription re-renders on every publish.
      const [, bumpRevision] = React.useReducer((revision) => revision + 1, 0)
      const state = getStore()
      const captureRef = React.useRef(undefined)
      const queueRef = React.useRef(Promise.resolve())
      const bodyRef = React.useRef(null)
      // Cleared by `discard`, so a review the person just cancelled can never
      // publish its result onto the emptied panel.
      const reviewRef = React.useRef(false)
      const [expanded, setExpanded] = React.useState(false)

      React.useEffect(() => subscribe(bumpRevision), [])

      // The model catalog is deployment-wide, so it is fetched once when the
      // panel first opens rather than on every render.
      React.useEffect(() => {
        loadCatalog()
      }, [])

      const busy = state.phase === 'starting' || state.phase === 'recording' || state.phase === 'stopping' || state.phase === 'reviewing'

      React.useEffect(() => {
        if (state.phase !== 'recording' && state.phase !== 'reviewing' && state.phase !== 'stopping') return undefined
        const timer = setInterval(() => {
          poll()
        }, TICK_MS)
        return () => clearInterval(timer)
      }, [state.phase])

      React.useEffect(() => {
        const body = bodyRef.current
        if (body !== null) body.scrollTop = body.scrollHeight
      }, [state.segments.length, state.phase])

      React.useEffect(() => () => {
        captureRef.current?.stop()
      }, [])

      /** Read the deployment's model catalog once, for the route pickers. */
      async function loadCatalog() {
        try {
          const reply = await api('/models')
          publish({ catalog: reply, catalogError: '' })
        } catch (error) {
          publish({ catalogError: `无法读取模型列表：${String(error.message ?? error)}` })
        }
      }

      /**
       * Read the local OneNote notebook tree and the remembered destinations.
       *
       * Called when the export dialog opens rather than at mount: it starts a
       * PowerShell child, and a person who never exports should never pay for it.
       */
      async function loadOneNote() {
        publish({ onenoteError: '' })
        try {
          const reply = await api('/onenote')
          if (reply.available !== true) {
            publish({ onenote: null, onenoteError: `本机没有可用的 OneNote：${String(reply.reason ?? '未知原因')}` })
            return
          }
          publish({ onenote: reply, onenoteError: '' })
        } catch (error) {
          publish({ onenote: null, onenoteError: `无法读取 OneNote 笔记本：${String(error.message ?? error)}` })
        }
      }

      /** Open the export dialog, loading the notebook tree the first time. */
      async function openExport() {
        publish({ exportOpen: true, exportStatus: '' })
        await loadOneNote()
      }

      /**
       * Run one export and report exactly what happened.
       *
       * On success the server returns the names that were actually matched, not
       * the strings that were typed, so the report names the real destination.
       *
       * @param path - the route to call.
       * @param body - its request body.
       * @param describe - how to word a success.
       */
      async function runExport(path, body, describe) {
        publish({ exportBusy: true, exportStatus: '' })
        try {
          const reply = await api(path, { method: 'POST', body })
          if (reply.ok !== true) {
            // A name that does not exist writes nothing, so the message is the
            // whole outcome and no state needs unwinding.
            publish({ exportBusy: false, exportStatus: String(reply.error ?? '导出失败') })
            return
          }
          if (reply.remembered !== undefined) {
            publish({ onenote: { ...(state.onenote ?? {}), ...reply.remembered } })
            await loadOneNote()
          }
          publish({ exportBusy: false, exportStatus: describe(reply) })
        } catch (error) {
          publish({ exportBusy: false, exportStatus: `导出失败：${String(error.message ?? error)}` })
        }
      }

      /** Append the current note to the named page. */
      async function exportToPage() {
        await runExport(
          '/onenote/export',
          { notebook: state.notebookQuery, page: state.pageQuery },
          (reply) => `已导出到「${String(reply.notebook ?? '')}」→「${String(reply.page ?? '')}」（追加，未覆盖原有内容）`,
        )
      }

      /** Create a new page in the named notebook and export into it. */
      async function exportToNewPage() {
        // The title is chosen by the model from the note's own content, so the
        // status can say what the page was named rather than just where it went.
        await runExport(
          '/onenote/new-page',
          { notebook: state.notebookQuery, section: state.sectionQuery },
          (reply) => `已在「${String(reply.notebook ?? '')} / ${String(reply.section ?? '')}」新建页面「${String(reply.page ?? '')}」`
            + (reply.namedByModel === true ? '（标题由笔记内容生成）' : '（标题为默认时间格式）'),
        )
      }

      /**
       * Record one task's route pick for this session.
       * @param task - `'recognition'` or `'review'`.
       * @param key - `provider\u0000model`, or `''` for the deployment default.
       * @param effort - optional reasoning level; omitted keeps the current one.
       */
      async function chooseRoute(task, key, effort) {
        const [provider, model] = key === '' ? ['', ''] : key.split('\u0000')
        const body = { task, provider: provider ?? '', model: model ?? '' }
        if (effort !== undefined) body.reasoningEffort = effort
        try {
          const reply = await api('/select', { method: 'POST', body })
          publish({ catalog: { ...(store.catalog ?? {}), current: reply.current }, catalogError: '' })
        } catch (error) {
          publish({ catalogError: `切换模型失败：${String(error.message ?? error)}` })
        }
      }

      /** Serialize uploads so the Host sees the lecture in order. */
      function enqueueUpload(bytes) {        queueRef.current = queueRef.current
          .then(() => postAudio(bytes))
          .catch((error) => {
            publish({ error: `上传失败：${String(error.message ?? error)}` })
          })
      }

      /** Send one WAV chunk and fold the reply into the store. */
      async function postAudio(bytes) {
        const response = await fetch(`${BASE}/audio`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/octet-stream' },
          body: bytes,
        })
        const payload = await response.json().catch(() => undefined)
        if (!response.ok || payload === undefined) {
          throw new Error(payload?.error ?? `HTTP ${response.status}`)
        }
        applyState(payload)
      }

      /** First press: start the Host lecture and open the microphone. */
      async function startLecture() {
        publish({ phase: 'starting', error: '', segments: [], review: null, reviewOpen: false, total: 0, translated: 0, pending: 0, elapsedMs: 0, hasReview: false })
        setExpanded(true)
        try {
          await api('/start', { method: 'POST' })
        } catch (error) {
          publish({ phase: 'idle', error: `无法开始录音：${String(error.message ?? error)}` })
          return
        }
        const capture = new Capture(
          (bytes) => {
            publish({ pending: store.pending + 1 })
            enqueueUpload(bytes)
          },
          (level) => publish({ level }),
          (error) => publish({ error: `音频处理失败：${String(error.message ?? error)}` }),
        )
        try {
          await capture.start()
        } catch (error) {
          publish({ phase: 'error', error: `无法打开麦克风：${String(error.message ?? error)}` })
          return
        }
        captureRef.current = capture
        publish({ phase: 'recording' })
        poll()
      }

      /**
       * Second press: stop capture, wait for the tail upload, then let the Host
       * build the review in the background while this side polls for it. Nothing
       * here blocks on the model, so the controls stay usable throughout.
       */
      async function stopLecture() {
        publish({ phase: 'stopping', stoppedAt: Date.now() })
        const capture = captureRef.current
        captureRef.current = undefined
        if (capture !== undefined) {
          capture.flush()
          await capture.stop()
        }
        try {
          await queueRef.current
          publish({ phase: 'reviewing' })
          // Report the duration this page measured, so the review header does
          // not depend on the Host's own clock.
          const reply = await api('/stop', { method: 'POST', body: { elapsedMs: store.elapsedMs } })
          applyState(reply)
          if (reply.reviewStarted !== true) {
            publish({ phase: 'idle', error: '这次没有可整理的内容' })
            return
          }
        } catch (error) {
          publish({ phase: 'idle', error: `结束录音失败：${String(error.message ?? error)}` })
          return
        }
        await waitForReview()
      }

      /**
       * Poll until the Host settles the review. Always leaves the panel in an
       * actionable state, so a slow or failed pass can never strand the buttons.
       */
      async function waitForReview() {
        reviewRef.current = true
        const deadline = Date.now() + REVIEW_WAIT_MS
        for (;;) {
          if (!reviewRef.current) return
          try {
            const reply = await api('/state')
            if (!reviewRef.current) return
            applyState(reply)
            const state = reply.state ?? {}
            const outcome = reviewOutcome(state)
            if (outcome === 'fetch') {
              // Pull the body as well: `/state` only carries the flag, and the
              // review pane renders from `store.review`, not from `reviewOpen`.
              // Setting the flag alone left the note hidden behind an extra
              // click on a button that already read "收起笔记".
              const body = await fetchReview()
              if (!reviewRef.current) return
              publish({ phase: 'idle', reviewOpen: body !== null, review: body, error: '' })
              reviewRef.current = false
              return
            }
            if (outcome === 'failed') {
              publish({ phase: 'idle', error: `笔记生成失败：${state.reviewError}` })
              reviewRef.current = false
              return
            }
            if (outcome === 'empty') {
              publish({
                phase: 'idle',
                error: state.reviewPending === false && state.total === 0
                  ? '这次没有可整理的内容'
                  : '笔记已取消，没有生成内容',
              })
              reviewRef.current = false
              return
            }
          } catch (error) {
            publish({ phase: 'idle', error: `读取状态失败：${String(error.message ?? error)}` })
            reviewRef.current = false
            return
          }
          if (Date.now() > deadline) {
            publish({ phase: 'idle', error: '笔记还在生成，可以点「查看笔记」稍后重试' })
            reviewRef.current = false
            return
          }
          await new Promise((resolve) => setTimeout(resolve, TICK_MS))
        }
      }

      /**
       * Read the review body from the Host.
       * @returns the Markdown, or `null` when there is none yet.
       */
      async function fetchReview() {
        const reply = await api('/review')
        return typeof reply.review === 'string' && reply.review.length > 0 ? reply.review : null
      }

      /**
       * Forget the current lecture on both sides.
       *
       * Pressing this while a review is being written is an explicit "stop, I do
       * not want this note": the Host aborts the model call and discards its
       * output, and the panel stops waiting for it. The review flag is cleared here
       * too, so the wait loop in `waitForReview` cannot publish a late result
       * over the cleared panel.
       */
      async function discard() {
        reviewRef.current = false
        const capture = captureRef.current
        captureRef.current = undefined
        if (capture !== undefined) await capture.stop()
        try {
          await api('/clear', { method: 'POST' })
        } catch {
          /* the local reset below is authoritative for the panel */
        }
        publish({
          phase: 'idle',
          segments: [],
          review: null,
          reviewOpen: false,
          reviewPending: false,
          total: 0,
          translated: 0,
          pending: 0,
          elapsedMs: 0,
          hasReview: false,
          error: '',
          level: 0,
        })
      }

      /** Toggle the review pane, fetching the body the first time. */
      async function openReview() {
        if (state.review !== null) {
          publish({ reviewOpen: !state.reviewOpen })
          return
        }
        try {
          const body = await fetchReview()
          publish({ review: body, reviewOpen: body !== null, ...body === null ? { error: '笔记尚未生成，可稍后再试' } : {} })
        } catch (error) {
          publish({ error: `无法读取笔记：${String(error.message ?? error)}` })
        }
      }

      if (!busy && state.phase !== 'error' && !expanded) {
        return h('button', {
          type: 'button',
          className: 'lcp-root lcp-launcher',
          onClick: () => {
            setExpanded(true)
            startLecture()
          },
          title: '课堂同传：实时英文转写与中文翻译，停止后自动生成复习笔记',
        }, '🎧 课堂同传')
      }

      const status = state.phase === 'recording'
        ? '录音中'
        : state.phase === 'starting'
          ? '正在打开麦克风'
          : state.phase === 'stopping'
            ? '正在收尾'
            : state.phase === 'reviewing'
              ? '正在整理复习笔记'
              : state.hasReview ? '笔记已就绪' : '待机'
      const dotState = state.phase === 'recording'
        ? 'rec'
        : state.phase === 'idle' ? (state.hasReview ? 'ok' : '') : 'work'

      return h('section', { className: 'lcp-root lcp-panel', role: 'region', 'aria-label': '课堂同传' },
        h('header', { className: 'lcp-head' },
          h('span', { className: 'lcp-dot', 'data-state': dotState }),
          h('span', { className: 'lcp-title' }, `课堂同传 · ${status}`),
          state.phase === 'recording' ? h(LevelMeter, { level: state.level }) : null,
          h('span', { className: 'lcp-meta' },
            `${clock(state.elapsedMs)} · ${state.translated}/${state.total}${state.pending > 0 ? ` · 待译 ${state.pending}` : ''}`),
        ),

        h('div', { className: 'lcp-body', ref: bodyRef },
          state.segments.length === 0
            ? h('p', { className: 'lcp-empty' },
              state.phase === 'recording'
                ? '正在聆听英文讲解。每讲完一句，这里就会出现英文原文与中文翻译。再按一次按钮结束录音并自动整理复习笔记。'
                : '按下按钮开始听课；再按一次结束，助手会自动整理逻辑链与知识点。')
            : state.segments.map((segment) => h(SegmentView, { key: segment.id, segment })),
        ),

        state.reviewOpen && state.review !== null
          ? h('pre', { className: 'lcp-review' }, state.review)
          : null,

        // Routes are read at call time, so they are freely switchable while a
        // lecture is running: a change applies to the next segment, and always
        // to the review, which has not started yet.
        state.showRoutes
          ? h('div', { className: 'lcp-routes' },
            h(RoutePicker, {
              label: '识别 & 翻译（每段实时）',
              view: routeOptions(state.catalog, 'recognition', state.catalog?.compositionDefault),
              note: state.catalogError,
              disabled: false,
              onSelect: (key, effort) => chooseRoute('recognition', key, effort),
            }),
            h(RoutePicker, {
              label: '整理并生成笔记（结束录音后）',
              view: routeOptions(state.catalog, 'review', state.catalog?.compositionDefault),
              note: state.catalog !== null && routeOptions(state.catalog, 'review', null).options.length === 0
                ? '当前部署没有可切换的模型'
                : '',
              disabled: false,
              onSelect: (key, effort) => chooseRoute('review', key, effort),
            }),
          )
          : null,

        // The export dialog is armed only once a note exists: an export button
        // that cannot work is worse than no button.
        state.exportOpen
          ? h(ExportDialog, {
            view: state.onenote,
            state,
            onExport: exportToPage,
            onNewPage: exportToNewPage,
            onClose: () => publish({ exportOpen: false, exportStatus: '', listOpen: null }),
          })
          : null,

        h('div', { className: 'lcp-err', hidden: state.error.length === 0 }, state.error),

        h('footer', { className: 'lcp-foot' },
          busy
            ? h('button', {
              type: 'button',
              className: 'lcp-btn',
              'data-kind': 'danger',
              disabled: state.phase !== 'recording',
              onClick: stopLecture,
            }, state.phase === 'recording' ? '■ 结束并整理' : '处理中…')
            : h('button', {
              type: 'button',
              className: 'lcp-btn',
              'data-kind': 'primary',
              onClick: startLecture,
            }, '● 开始听课'),
          h('button', {
            type: 'button',
            className: 'lcp-btn',
            disabled: !state.hasReview && state.review === null,
            onClick: openReview,
          }, state.reviewOpen ? '收起笔记' : '查看笔记'),
          h('button', {
            type: 'button',
            className: 'lcp-btn',
            'data-active': state.showRoutes ? 'true' : undefined,
            onClick: () => {
              if (!state.showRoutes && state.catalog === null) loadCatalog()
              publish({ showRoutes: !state.showRoutes })
            },
          }, state.showRoutes ? '收起模型' : '模型'),
          h('button', {
            type: 'button',
            className: 'lcp-btn',
            'data-active': state.exportOpen ? 'true' : undefined,
            // Only offered once there is something to export.
            disabled: !state.hasReview && state.review === null,
            title: '把这份笔记追加到本机 OneNote',
            onClick: () => {
              if (state.exportOpen) publish({ exportOpen: false, exportStatus: '' })
              else openExport()
            },
          }, state.exportOpen ? '收起导出' : '导出 OneNote'),
          h('button', {
            type: 'button',
            className: 'lcp-btn',
            // Stays enabled while the review runs: pressing it is how a person
            // says "stop writing that note".
            'data-kind': state.phase === 'reviewing' ? 'danger' : undefined,
            title: state.phase === 'reviewing' ? '中断笔记整理并清空本次课堂' : '清空本次课堂内容',
            onClick: discard,
          }, state.phase === 'reviewing' ? '清空并中断' : '清空'),
          h('button', {
            type: 'button',
            className: 'lcp-btn',
            style: { marginLeft: 'auto' },
            disabled: state.phase === 'starting' || state.phase === 'stopping',
            onClick: () => setExpanded(false),
          }, '收起'),
        ),
      )
    }

    /* ----------------------------------------------------------------- mount */

    const NS = 'lecture-copilot'

    /** Required client services. */
    const inject = ['slots']

    /**
     * Mount the floating control into the frame-wide overlay.
     * @param ctx - the browser plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: NS,
        order: 40,
      }, LectureCopilot)), 'lecture-copilot: overlay control')
    }

    // `apply`/`inject`/`name` are what the client module system consumes. The
    // store and its publisher ride along so the offline render harness can drive
    // the panel through its real state rather than a copy of it; nothing in the
    // shell looks at them.
    return { apply, inject, name: NS, store, publish, routeOptions }
  },
})
