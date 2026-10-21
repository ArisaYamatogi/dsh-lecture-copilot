/**
 * Lecture Copilot — Host half.
 *
 * Owns everything that must not live in a browser tab:
 *   • transcription through the composition's `speechToText` provider
 *     (the bundled local SenseVoice recognizer, which is bilingual),
 *   • translation through the composition's `llm` service, serialized so the
 *     running translation keeps the lecture order,
 *   • the end-of-lecture review pass,
 *   • the two model-facing tools that expose the transcript and the review.
 *
 * The browser half records audio and renders the panel; the routes it talks to
 * are registered here too, because a static client plugin has no private
 * channel back to its Host half.
 *
 * @module dsh-lecture-copilot
 */

import { REVIEW_SYSTEM, TRANSLATION_SYSTEM, reviewRequest, transcriptBody, translationRequest } from './prompts.js'
import { generateReview, generateTitle, resolveModel, takeModelFailure, translateSegment } from './notes.js'
import { authSummary, transcribe as transcribeRemote } from './asr.js'
import { registerTools } from './tools.js'
import * as onenoteBridge from './onenote.js'
import { markdownToPageXml, noteTitle } from './note-xml.js'
import { forget as forgetDestination, read as readDestinations, reconcile as reconcileDestinations, remember as rememberDestination } from './onenote-store.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Loader identity for this composition row.
 *
 * The package deliberately imports nothing outside `node:` builtins and its
 * own modules: a profile-installed bundle resolves its bare specifiers from
 * the profile directory, which holds no `@deepseek-ai/*` scope — only the
 * launcher's immutable runtime does. Keeping the plugin dependency-free is
 * what lets `dsh plugin add <path>` be the whole installation story.
 */
export const name = 'lecture-copilot'

/** The one hard dependency: without a recognizer this plugin has no purpose. */
export const inject = ['speechToText']

/** Route base claimed by the Web carrier. */
export /** How long the model gets to name a new page before the fallback title is used. */
const TITLE_TIMEOUT_MS = 15000

const BASE = '/lecture-copilot'

/** Host program ceiling for one audio chunk, in bytes (16 kHz PCM16 ≈ 32 KiB/s). */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024

/**
 * The shipped configuration defaults, for documentation, profile patches, and
 * `Config` validation.
 *
 * Recognition and translation are two separate stages: recognition is the
 * speech-to-text engine (the Host's `speechToText` service, or one registered
 * `asrProviders` HTTP engine), while translation is an `llm` model call. They
 * therefore carry their own selection fields rather than sharing one route.
 *
 * | field | default | meaning |
 * |---|---|---|
 * | `provider` / `model` / `reasoningEffort` | composition default | shared fallback route for both LLM tasks |
 * | `translationProvider` / `translationModel` / `translationReasoningEffort` | follow the shared route | route for the live translation pass |
 * | `reviewProvider` / `reviewModel` / `reviewReasoningEffort` | follow the shared route | route for the review pass |
 * | `recognitionProvider` / `recognitionModel` / `recognitionReasoningEffort` | follow the shared route | **deprecated**: the pre-split name of the translation route, still honoured |
 * | `asrEngine` | `''` (the Host `speechToText` engine) | recognition engine id; `''`/`harness`/`speechToText` mean the Host service |
 * | `asrProviders` | `[]` | extra recognition engines: `{ id, label, baseURL, model, apiKey?, apiKeyEnv?, languages? }`, each an OpenAI-compatible `/audio/transcriptions` service; a key is optional and may be written literally (`apiKey`) or named as an environment variable (`apiKeyEnv`) |
 * | `language` | `en` | recognition language hint; `auto` lets the recognizer guess |
 * | `context` | empty | course context fed to both prompts, e.g. "高等数学，全英文授课" |
 * | `glossary` | `[]` | exact spellings of terms the recognizer tends to mangle |
 * | `minSegmentBytes` | 6400 | chunks below this are dropped (16 kHz PCM16 ≈ 0.2 s) |
 * | `maxSegments` | 2000 | segments kept per lecture; older ones are dropped |
 * | `statusMinMs` | 900 | shortest time one segment may show as "translating", so the panel does not flicker |
 * | `translationTemperature` | 0 | sampling temperature for the translation pass |
 * | `translationTimeoutMs` | 60000 | per-segment translation timeout |
 * | `translationMaxTokens` | 4096 | per-segment translation budget |
 * | `reviewTimeoutMs` | 300000 | end-of-lecture review timeout |
 * | `reviewMaxTokens` | 32000 | end-of-lecture review budget |
 */
const CONFIG_DEFAULTS = {
  provider: '',
  model: '',
  reasoningEffort: '',
  language: 'en',
  minSegmentBytes: 6400,
  maxSegments: 2000,
  statusMinMs: 900,
  translationTemperature: 0,
  translationTimeoutMs: 60000,
  translationMaxTokens: 4096,
  // Recognition: which engine transcribes, and the labels for engines that are
  // not the Host's own `speechToText` service.
  asrEngine: '',
  asrProviders: [],
  translationProvider: '',
  translationModel: '',
  translationReasoningEffort: '',
  // Deprecated pre-split names for the translation route; kept so an existing
  // profile keeps working.
  recognitionProvider: '',
  recognitionModel: '',
  recognitionReasoningEffort: '',
  reviewProvider: '',
  reviewModel: '',
  reviewReasoningEffort: '',
  context: '',
  glossary: [],
  // How long the model gets to name a new page before the date-based title is
  // used instead.
  titleTimeoutMs: 15000,
  reviewTimeoutMs: 300000,
  reviewMaxTokens: 32000,
}

/** Bounds that keep a hand-edited configuration from breaking the pipeline. */
const CONFIG_FLOORS = {
  minSegmentBytes: 1024,
  maxSegments: 16,
  statusMinMs: 0,
  translationTimeoutMs: 1000,
  translationMaxTokens: 64,
  reviewTimeoutMs: 5000,
  reviewMaxTokens: 256,
}

/**
 * Normalize the configured recognition engines.
 *
 * Each entry is one OpenAI-compatible `/audio/transcriptions` endpoint. An entry
 * without an id, a base URL, or a model is dropped rather than failing the row:
 * a half-written engine must cost that engine, not the lecture. Credentials are
 * optional and handled by `./asr.js`; they are kept on the normalized entry so
 * the transport can resolve them, and are never part of any route payload.
 * @param input - raw `asrProviders` value.
 * @returns the usable engines, each with a stable id and a label.
 */
function normalizeAsrProviders(input) {
  if (!Array.isArray(input)) return []
  const engines = []
  const seen = new Set()
  for (const entry of input) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    const baseURL = typeof entry.baseURL === 'string' ? entry.baseURL.trim().replace(/\/+$/u, '') : ''
    const model = typeof entry.model === 'string' ? entry.model.trim() : ''
    if (id.length === 0 || baseURL.length === 0 || model.length === 0 || seen.has(id)) continue
    // A reserved id would alias the Host service instead of naming an endpoint.
    if (id === 'harness' || id === 'speechToText') continue
    seen.add(id)
    const languages = Array.isArray(entry.languages)
      ? entry.languages.filter((language) => typeof language === 'string' && language.trim().length > 0).map((language) => language.trim())
      : []
    engines.push({
      id,
      label: typeof entry.label === 'string' && entry.label.trim().length > 0 ? entry.label.trim() : id,
      baseURL,
      model,
      ...typeof entry.apiKey === 'string' && entry.apiKey.trim().length > 0 ? { apiKey: entry.apiKey.trim() } : {},
      ...typeof entry.apiKeyEnv === 'string' && entry.apiKeyEnv.trim().length > 0 ? { apiKeyEnv: entry.apiKeyEnv.trim() } : {},
      ...languages.length === 0 ? {} : { languages },
    })
  }
  return engines
}

/**
 * Validate and complete the plugin configuration field by field. A hand-edited
 * value that is missing, malformed, or below its floor falls back to the
 * shipped default rather than failing the whole row: a plugin that only ever
 * loses tuning, never the lecture, is the right failure mode for a tool a
 * student starts five seconds before class.
 * @param input - raw configuration from the loader or a profile patch.
 * @returns the resolved configuration.
 */
export function resolveConfig(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const text = (key) => (typeof raw[key] === 'string' ? raw[key] : CONFIG_DEFAULTS[key])
  const count = (key) => {
    const value = raw[key]
    if (typeof value !== 'number' || !Number.isFinite(value)) return CONFIG_DEFAULTS[key]
    const rounded = Math.round(value)
    return rounded < CONFIG_FLOORS[key] ? CONFIG_FLOORS[key] : rounded
  }
  const ratio = (key) => {
    const value = raw[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : CONFIG_DEFAULTS[key]
  }
  const language = text('language').trim()
  const glossary = Array.isArray(raw.glossary)
    ? raw.glossary.filter((entry) => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : CONFIG_DEFAULTS.glossary
  const asrEngine = text('asrEngine').trim()
  return {
    provider: text('provider').trim(),
    model: text('model').trim(),
    reasoningEffort: text('reasoningEffort').trim(),
    language: language.length === 0 ? CONFIG_DEFAULTS.language : language,
    context: text('context').trim(),
    glossary,
    asrEngine: asrEngine === 'speechToText' ? 'harness' : asrEngine,
    asrProviders: normalizeAsrProviders(raw.asrProviders),
    minSegmentBytes: count('minSegmentBytes'),
    maxSegments: count('maxSegments'),
    statusMinMs: count('statusMinMs'),
    translationTemperature: ratio('translationTemperature'),
    translationTimeoutMs: count('translationTimeoutMs'),
    translationMaxTokens: count('translationMaxTokens'),
    translationProvider: text('translationProvider').trim(),
    translationModel: text('translationModel').trim(),
    translationReasoningEffort: text('translationReasoningEffort').trim(),
    recognitionProvider: text('recognitionProvider').trim(),
    recognitionModel: text('recognitionModel').trim(),
    recognitionReasoningEffort: text('recognitionReasoningEffort').trim(),
    reviewProvider: text('reviewProvider').trim(),
    reviewModel: text('reviewModel').trim(),
    reviewReasoningEffort: text('reviewReasoningEffort').trim(),
    reviewTimeoutMs: count('reviewTimeoutMs'),
    reviewMaxTokens: count('reviewMaxTokens'),
  }
}

/**
 * `Config`, in the standard-schema shape the Cordis loader validates before a
 * plugin starts. This package implements the interface directly instead of
 * importing a schema library, because a profile-installed bundle resolves its
 * bare specifiers from the profile directory, which holds no runtime packages.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-lecture-copilot',
    /**
     * Validate one configuration body.
     * @param value - raw configuration.
     * @returns the resolved configuration, or the issues that reject it.
     */
    validate(value) {
      const raw = value === null || value === undefined ? {} : value
      if (typeof raw !== 'object') {
        return { issues: [{ message: 'config must be a mapping', path: [] }] }
      }
      const issues = []
      for (const [key, candidate] of Object.entries(raw)) {
        if (!(key in CONFIG_DEFAULTS)) {
          issues.push({ message: `unknown field ${JSON.stringify(key)}`, path: [key] })
          continue
        }
        if (key === 'asrProviders') {
          if (!Array.isArray(candidate)) {
            issues.push({ message: 'expected an array of recognition engines', path: [key] })
            continue
          }
          candidate.forEach((entry, index) => {
            const at = [key, index]
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
              issues.push({ message: 'expected an engine object', path: at })
              return
            }
            for (const field of ['id', 'baseURL', 'model']) {
              if (typeof entry[field] !== 'string' || entry[field].trim().length === 0) {
                issues.push({ message: `expected a non-empty string for ${field}`, path: [...at, field] })
              }
            }
            for (const field of ['label', 'apiKey', 'apiKeyEnv']) {
              if (entry[field] !== undefined && typeof entry[field] !== 'string') {
                issues.push({ message: `expected a string for ${field}`, path: [...at, field] })
              }
            }
            if (entry.languages !== undefined
              && (!Array.isArray(entry.languages) || entry.languages.some((language) => typeof language !== 'string'))) {
              issues.push({ message: 'expected an array of strings for languages', path: [...at, 'languages'] })
            }
          })
          continue
        }
        const expected = typeof CONFIG_DEFAULTS[key]
        if (Array.isArray(CONFIG_DEFAULTS[key])) {
          if (!Array.isArray(candidate) || candidate.some((entry) => typeof entry !== 'string')) {
            issues.push({ message: 'expected an array of strings', path: [key] })
          }
          continue
        }
        if (expected === 'number' ? typeof candidate !== 'number' || !Number.isFinite(candidate) : typeof candidate !== expected) {
          issues.push({ message: `expected ${expected}`, path: [key] })
        }
      }
      return issues.length > 0 ? { issues } : { value: resolveConfig(raw) }
    },
  },
}

/** How long a "thinking" state is held so the panel does not flicker. */
const MODELS_CACHE_MS = 60000

/**
 * Languages the recognition row offers before any provider declares its own.
 *
 * These are the Host SenseVoice provider's set; a configured HTTP engine may add
 * more through its `languages` field. `auto` makes the recognizer guess.
 */
const ASR_LANGUAGES = ['auto', 'en', 'zh', 'yue', 'ja', 'ko']

/**
 * The shipped configuration defaults, for documentation and profile patches.
 * @returns a detached copy of the defaults.
 */
export function configDefaults() {
  return { ...CONFIG_DEFAULTS }
}

/**
 * Create the live lecture session. The plugin is dependency-free by design, so
 * this feature service is published through `ctx.provide` rather than through a
 * Cordis `Service` subclass; `ctx.provide` ties the registration to the
 * plugin's own fiber, which is the only ownership guarantee it needs.
 * @param ctx - Host plugin context.
 * @param config - resolved configuration.
 * @returns the session object.
 */
function createLecture(ctx, config) {
  const lecture = {
    config,
    segments: [],
    pending: [],
    tasks: new Set(),
    nextId: 1,
    active: false,
    startedAt: 0,
    stoppedAt: undefined,
    review: undefined,
    reviewError: undefined,
    reviewing: false,
    cancelled: false,
    reviewWaiters: [],
    draining: false,
    translationController: new AbortController(),
    reviewController: new AbortController(),
    /** Explicit per-task picks from the panel; empty means "use config". */
    selection: { asr: {}, translation: {}, review: {} },
  }

  /**
   * Resolve the route for one LLM task, panel pick first.
   * @param task - `'translation'` or `'review'`.
   * @returns provider, model, and optional reasoning effort.
   */
  lecture.model = (task = 'translation') => resolveModel(ctx, config, task, lecture.selection[task])

  /** Languages the recognition row may offer: the Host engines' own set first. */
  lecture.asrLanguages = () => {
    const languages = new Set(ASR_LANGUAGES)
    try {
      const snapshot = ctx.get('speechToText')?.snapshot?.()
      for (const provider of snapshot?.providers ?? []) {
        for (const language of provider.languages ?? []) languages.add(language)
      }
    } catch {
      // A missing or unreadable service simply contributes no languages.
    }
    for (const engine of config.asrProviders) {
      for (const language of engine.languages ?? []) languages.add(language)
    }
    return [...languages]
  }

  /**
   * Resolve the recognition engine, panel pick first.
   *
   * `harness` (or an empty pick) means the Host's own `speechToText` provider; a
   * configured engine means its OpenAI-compatible `/audio/transcriptions`
   * endpoint. A pick whose engine was removed from the configuration falls back
   * to the Host service rather than transcribing nowhere.
   *
   * This is the *public* view — it is what `/models` and `/health` return — so it
   * carries only whether a credential is configured (`auth`), never the key
   * itself and never the environment variable's name.
   * @returns engine id, label, language, credential source, and (for HTTP engines) base URL and model.
   */
  lecture.asr = () => {
    const clean = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : '')
    const requested = clean(lecture.selection.asr.engine) || config.asrEngine || 'harness'
    const language = clean(lecture.selection.asr.language) || config.language
    const engine = requested === 'harness' ? undefined : config.asrProviders.find((entry) => entry.id === requested)
    if (engine === undefined) {
      return { engine: 'harness', label: '本机 SenseVoice', language, auth: 'none' }
    }
    return {
      engine: engine.id,
      label: engine.label,
      language,
      baseURL: engine.baseURL,
      model: engine.model,
      auth: authSummary(engine),
    }
  }

  /**
   * Merge a panel pick for one task.
   *
   * Recognition picks carry an engine id and a language; the two LLM tasks carry
   * a provider, a model, and an optional reasoning level. Empty values clear a
   * pick so the configured default applies again.
   * @param task - `'asr'`, `'translation'`, or `'review'`.
   * @param pick - the fields to merge.
   * @returns `true`, or the reason the pick was refused.
   */
  lecture.select = (task, pick) => {
    // A page loaded before the split still asks for `recognition`; it names the
    // translation route, which is what that pick always controlled.
    const name = task === 'recognition' ? 'translation' : task
    if (name !== 'asr' && name !== 'translation' && name !== 'review') return 'task must be "asr", "translation", or "review"'
    const clean = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : '')
    if (name === 'asr') {
      for (const key of ['engine', 'language']) {
        if (pick?.[key] === undefined) continue
        const value = clean(pick[key])
        if (key === 'engine' && value.length > 0 && value !== 'harness'
          && !config.asrProviders.some((entry) => entry.id === value)) {
          return `unknown recognition engine ${JSON.stringify(pick[key])}`
        }
        if (key === 'language' && value.length > 0 && !lecture.asrLanguages().includes(value)) {
          return `unsupported recognition language ${JSON.stringify(pick[key])}`
        }
        lecture.selection.asr[key] = value
      }
      const asr = lecture.asr()
      ctx.logger?.info?.(`lecture-copilot: recognizer ${asr.engine} (${asr.language})`)
      return true
    }
    for (const key of ['provider', 'model', 'reasoningEffort']) {
      if (pick?.[key] !== undefined) lecture.selection[name][key] = clean(pick[key])
    }
    ctx.logger?.info?.(`lecture-copilot: ${name} route ${JSON.stringify(lecture.model(name))}`)
    return true
  }

  /** Track one background task so disposal and `finish()` can join it. */
  lecture.track = (promise) => {
    lecture.tasks.add(promise)
    promise.then(
      () => lecture.tasks.delete(promise),
      (error) => {
        lecture.tasks.delete(promise)
        ctx.logger?.warn?.(`lecture-copilot: background task failed: ${String(error?.message ?? error)}`)
      },
    )
    return promise
  }

  /** Local wall-clock stamp for one segment. */
  lecture.stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false })

  /**
   * Drain the translation queue one model call at a time.
   * @returns completion once the queue is empty.
   */
  lecture.drain = async () => {
    if (lecture.draining) return
    lecture.draining = true
    try {
      while (lecture.pending.length > 0) {
        const item = lecture.pending.shift()
        const segment = lecture.segments.find((candidate) => candidate.id === item.id)
        if (segment === undefined) continue
        segment.state = 'translating'
        segment.thinkingSince = Date.now()
        try {
          const translated = await translateSegment(ctx, {
            ...lecture.model('translation'),
            system: TRANSLATION_SYSTEM,
            temperature: config.translationTemperature,
            maxTokens: config.translationMaxTokens,
            timeoutMs: config.translationTimeoutMs,
            signal: lecture.translationController.signal,
          }, translationRequest(item.text, config.context, config.glossary))
          const held = config.statusMinMs - (Date.now() - segment.thinkingSince)
          if (held > 0) await new Promise((resolve) => setTimeout(resolve, held))
          segment.translation = translated
          segment.state = translated === undefined ? 'failed' : 'translated'
          if (translated === undefined) segment.error = '翻译未返回内容'
        } catch (error) {
          segment.state = 'failed'
          segment.error = String(error?.message ?? error)
        }
      }
    } finally {
      lecture.draining = false
    }
  }

  /** Enqueue one segment for translation. */
  lecture.enqueue = (id, text) => {
    lecture.pending.push({ id, text })
    lecture.track(lecture.drain())
  }

  /** Wake every waiter of an in-flight review pass. */
  lecture.settleReviewWaiters = () => {
    const waiters = lecture.reviewWaiters.splice(0)
    for (const waiter of waiters) waiter()
  }

  /**
   * Produce (or reuse) the review for the current transcript.
   * @param options - optional course name and whether to force a rebuild.
   * @returns the review plus how the call ended.
   */
  lecture.consolidate = async (options = {}) => {
    if (options.force !== true && lecture.review !== undefined) return { review: lecture.review }
    if (lecture.reviewing) {
      await new Promise((resolve) => lecture.reviewWaiters.push(resolve))
      return lecture.review === undefined
        ? { review: undefined, pending: true, error: lecture.reviewError }
        : { review: lecture.review }
    }
    if (lecture.segments.length === 0) return { review: undefined, error: '没有可整理的转写内容' }
    lecture.reviewing = true
    lecture.cancelled = false
    // A fresh controller per pass: cancelling a review must abort this pass and
    // nothing else, and a later pass must start uncancelled. A caller's own
    // signal (a tool call's cancellation) is combined with it rather than
    // replacing it, so both can end the pass.
    lecture.reviewController = new AbortController()
    const signal = options.signal === undefined
      ? lecture.reviewController.signal
      : AbortSignal.any([options.signal, lecture.reviewController.signal])
    try {
      // `transcriptBody` wants a duration, not the absolute stop timestamp. A
      // caller may supply one, which keeps the figure independent of wall-clock
      // timestamps and makes the prompt deterministic.
      const measured = lecture.startedAt === 0 || lecture.stoppedAt === undefined
        ? undefined
        : lecture.stoppedAt - lecture.startedAt
      const body = transcriptBody(lecture.segments, options.elapsedMs ?? measured)
      const produced = await generateReview(ctx, {
        ...lecture.model('review'),
        system: REVIEW_SYSTEM,
        user: reviewRequest(body, options.subject, config.context, config.glossary),
        maxTokens: config.reviewMaxTokens,
        timeoutMs: config.reviewTimeoutMs,
        signal,
      }, options.onDelta)
      if (lecture.cancelled) {
        // The pass was abandoned mid-flight: store nothing, report nothing.
        lecture.reviewError = undefined
        return { review: undefined, cancelled: true }
      }
      if (produced === undefined) {
        lecture.reviewError = takeModelFailure() ?? '模型调用失败或超时'
        return { review: undefined, error: lecture.reviewError }
      }
      lecture.review = produced
      lecture.reviewError = undefined
      return { review: produced }
    } finally {
      lecture.reviewing = false
      lecture.settleReviewWaiters()
    }
  }

  /**
   * Abandon an in-flight review pass.
   *
   * The model call is aborted and its output discarded, so no note is produced.
   * @returns whether a pass was actually interrupted.
   */
  lecture.cancelReview = () => {
    const wasReviewing = lecture.reviewing
    lecture.cancelled = true
    lecture.reviewController.abort(new Error('lecture-copilot: review cancelled'))
    lecture.settleReviewWaiters()
    if (wasReviewing) ctx.logger?.info?.('lecture-copilot: review cancelled')
    return wasReviewing
  }

  /** Begin a recording session, discarding the previous lecture. */
  lecture.start = () => {
    lecture.cancelReview()
    lecture.translationController.abort(new Error('lecture-copilot: lecture restarted'))
    lecture.translationController = new AbortController()
    lecture.segments.length = 0
    lecture.pending.length = 0
    lecture.nextId = 1
    lecture.review = undefined
    lecture.reviewError = undefined
    lecture.reviewing = false
    lecture.cancelled = false
    lecture.stoppedAt = undefined
    lecture.reviewStartedAt = undefined
    lecture.startedAt = Date.now()
    lecture.active = true
    ctx.logger?.info?.('lecture-copilot: recording started')
    return { startedAt: lecture.startedAt }
  }

  /**
   * Transcribe one recorded chunk and queue it for translation.
   * @param audio - canonical 16 kHz mono PCM16 WAV bytes.
   * @returns the accepted segment, or the reason it was dropped.
   */
  lecture.accept = async (audio) => {
    if (!lecture.active) return { accepted: false, reason: 'idle' }
    if (audio.length < config.minSegmentBytes) return { accepted: false, reason: 'too-short' }
    const began = Date.now()
    const engine = lecture.asr()
    const deadline = AbortSignal.timeout(config.translationTimeoutMs + 30000)
    let transcript
    if (engine.baseURL === undefined) {
      transcript = await ctx.speechToText.transcribe(ctx.speechToText.resolve({ audio, language: engine.language }), deadline)
    } else {
      // The transport needs the engine entry itself: `lecture.asr()` is the
      // public view and deliberately carries no credential.
      const configured = config.asrProviders.find((entry) => entry.id === engine.engine) ?? engine
      transcript = await transcribeRemote(configured, audio, { language: engine.language, signal: deadline })
    }
    const text = String(transcript?.text ?? '').trim()
    if (text.length === 0) return { accepted: false, reason: 'silent' }
    const segment = { id: lecture.nextId, at: lecture.stamp(), text, state: 'queued', thinkingSince: 0 }
    lecture.nextId += 1
    lecture.segments.push(segment)
    if (lecture.segments.length > config.maxSegments) {
      const dropped = lecture.segments.splice(0, lecture.segments.length - config.maxSegments)
      ctx.logger?.warn?.(`lecture-copilot: dropped ${dropped.length} oldest segments over the configured bound`)
    }
    lecture.enqueue(segment.id, text)
    ctx.logger?.debug?.(
      `lecture-copilot: segment ${segment.id} in ${Date.now() - began}ms via ${engine.engine} (${transcript?.audioSeconds ?? '?'}s audio)`,
    )
    return { accepted: true, id: segment.id, at: segment.at, text }
  }

  /**
   * Stop capture and join the outstanding translations, without waiting for the
   * review. The review is a long model call; keeping it off this path is what
   * lets the panel stay responsive while it runs. `consolidate` is idempotent
   * and queues behind an in-flight pass, so the caller may re-issue it freely.
   * @param options - optional caller-reported duration and course name.
   * @returns completion once the translations are settled.
   */
  lecture.finish = async (options = {}) => {
    lecture.active = false
    lecture.stoppedAt = Date.now()
    lecture.finishOptions = options
    ctx.logger?.info?.(`lecture-copilot: recording stopped after ${lecture.segments.length} segments`)
    await Promise.allSettled([...lecture.tasks])
  }

  /**
   * Build the review, in the background, without blocking the caller.
   *
   * `reviewStartedAt` is stamped synchronously so a caller that immediately
   * polls `/state` sees the pass as pending even before the model call has
   * flipped `reviewing`; without it the panel can observe "not reviewing, no
   * review" and give up on a review that is about to start.
   * @param options - optional caller-reported duration and course name.
   * @returns a promise settling with the review outcome.
   */
  lecture.buildReview = (options = {}) => {
    lecture.reviewStartedAt = Date.now()
    return lecture.track(
      lecture.consolidate({ force: true, ...lecture.finishOptions, ...options })
        .finally(() => {
          lecture.reviewStartedAt = undefined
        }),
    )
  }

  /** Forget the current lecture. */
  lecture.clear = () => {
    lecture.active = false
    lecture.segments.length = 0
    lecture.pending.length = 0
    lecture.review = undefined
    lecture.reviewError = undefined
    lecture.stoppedAt = undefined
    lecture.startedAt = 0
    lecture.settleReviewWaiters()
    ctx.logger?.info?.('lecture-copilot: cleared')
  }

  /**
   * Snapshot for the browser panel.
   * @param since - only return segments with an id greater than this.
   * @returns the wire state.
   */
  lecture.view = (since = 0) => {
    const started = lecture.startedAt === 0 ? undefined : lecture.startedAt
    return {
      active: lecture.active,
      reviewing: lecture.reviewing,
      elapsedMs: started === undefined ? 0 : (lecture.stoppedAt ?? Date.now()) - started,
      total: lecture.segments.length,
      translated: lecture.segments.filter((segment) => segment.translation !== undefined).length,
      pending: lecture.pending.length + lecture.segments.filter((segment) => segment.state === 'translating').length,
      segments: lecture.segments
        .filter((segment) => segment.id > since)
        .map((segment) => ({
          id: segment.id,
          at: segment.at,
          text: segment.text,
          state: segment.state,
          ...segment.translation === undefined ? {} : { translation: segment.translation },
          ...segment.error === undefined ? {} : { error: segment.error },
        })),
      hasReview: lecture.review !== undefined,
      // True from the moment a review pass is scheduled until it settles, so a
      // polling client never mistakes "not started yet" for "gave up".
      reviewPending: lecture.review !== undefined
        ? false
        : lecture.reviewing || lecture.reviewStartedAt !== undefined,
      reviewError: lecture.reviewError ?? null,
    }
  }

  /** Snapshot plus the review body. */
  lecture.viewWithReview = () => ({ ...lecture.view(0), review: lecture.review ?? null })

  return lecture
}

/* ------------------------------------------------------------------ routes */

/** Recognize the canonical PCM16 WAV header this plugin accepts. */
function isWave(bytes) {
  if (bytes.length < 46) return false
  const tag = (at, text) => {
    for (let index = 0; index < text.length; index += 1) {
      if (bytes[at + index] !== text.charCodeAt(index)) return false
    }
    return true
  }
  return tag(0, 'RIFF') && tag(8, 'WAVE')
}

/**
 * Read a request body with a hard ceiling.
 * @param req - the route request.
 * @param limit - maximum accepted bytes.
 * @returns the body bytes.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Send one JSON response.
 * @param res - the route response.
 * @param status - HTTP status code.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Read and parse a JSON request body.
 * @param req - the route request.
 * @returns the parsed body, or `undefined` when it is missing or malformed.
 */
async function readJsonBody(req) {
  try {
    const body = await readBody(req, 65536)
    if (body.length === 0) return {}
    const parsed = JSON.parse(body.toString('utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The Harness home, where the plugin keeps its own state.
 * @returns the directory path.
 */
function harnessHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Read the live notebook tree in the flat shape the routes match against.
 * @returns `{ notebooks, sections, pages }`, or `undefined` when OneNote is unavailable.
 */
async function loadLiveTree(bridge) {
  const reply = await bridge.list()
  if (reply.ok !== true) return undefined
  return bridge.flatten(reply.notebooks)
}

/**
 * Choose the section a new page belongs in.
 *
 * The section used to be inferred — today's dated section, else the notebook's
 * first — which silently put notes somewhere the person never chose. The picker
 * now names it explicitly, so this only resolves what was typed and reports a
 * miss rather than substituting a default.
 *
 * @param sections - that notebook's sections.
 * @param typed - the section name the caller supplied.
 * @param bridge - the OneNote bridge, for its matcher.
 * @returns the matched section, or `undefined`.
 */
function resolveSection(sections, typed, bridge) {
  return bridge.matchByName(typed, sections)
}

/**
 * Build the route table the Web carrier registers. Matching in the shipped
 * server is exact-or-longest-prefix over paths, not over methods, so each
 * entry dispatches on `req.method` itself.
 * @param lecture - the live lecture session.
 * @param ctx - Host plugin context, for logging.
 * @returns one exact route per endpoint.
 */
export function lectureRoutes(lecture, ctx, bridge = onenoteBridge, config = {}) {
  const route = (path, handler) => ({ kind: 'exact', path, handler })

  const state = route(`${BASE}/state`, (req, res) => {
    const url = new URL(req.url ?? BASE, 'http://localhost')
    const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10)
    sendJson(res, 200, { ok: true, state: lecture.view(Number.isFinite(since) && since > 0 ? since : 0) })
  })

  const review = route(`${BASE}/review`, (_req, res) => {
    sendJson(res, 200, { ok: true, ...lecture.viewWithReview() })
  })

  const start = route(`${BASE}/start`, (_req, res) => {
    sendJson(res, 200, { ok: true, ...lecture.start() })
  })

  const audio = route(`${BASE}/audio`, async (req, res) => {
    let body
    try {
      body = await readBody(req, MAX_AUDIO_BYTES)
    } catch (error) {
      sendJson(res, 413, { ok: false, error: String(error?.message ?? error) })
      return
    }
    if (!isWave(body)) {
      sendJson(res, 400, { ok: false, error: 'body is not a PCM16 WAV payload' })
      return
    }
    try {
      const outcome = await lecture.accept(body)
      sendJson(res, 200, { ok: true, ...outcome, state: lecture.view(0) })
    } catch (error) {
      ctx.logger?.warn?.(`lecture-copilot: transcription failed: ${String(error?.message ?? error)}`)
      sendJson(res, 502, { ok: false, error: String(error?.message ?? error) })
    }
  })

  const stop = route(`${BASE}/stop`, async (req, res) => {
    // The body is optional: the panel reports the duration it measured, and a
    // caller that sends nothing falls back to the recorded timestamps.
    const options = {}
    try {
      const body = await readBody(req, 8192)
      if (body.length > 0) {
        const parsed = JSON.parse(body.toString('utf8'))
        if (Number.isFinite(parsed?.elapsedMs) && parsed.elapsedMs >= 0) options.elapsedMs = Math.round(parsed.elapsedMs)
        if (typeof parsed?.subject === 'string' && parsed.subject.trim().length > 0) options.subject = parsed.subject.trim()
      }
    } catch {
      // An unreadable body just means "use the measured duration".
    }
    await lecture.finish(options)
    // Answer immediately; the review keeps building in the background and the
    // panel learns about it by polling `/state`. Blocking here would freeze the
    // whole control for as long as the model takes.
    lecture.buildReview()
    sendJson(res, 200, {
      ok: true,
      reviewStarted: lecture.segments.length > 0,
      state: lecture.view(0),
    })
  })

  const clear = route(`${BASE}/clear`, (_req, res) => {
    // Clearing during a review must stop the pass, not race it: the model call is
    // aborted and its output discarded, so no note is produced for a lecture the
    // person just threw away.
    const cancelled = lecture.cancelReview()
    lecture.clear()
    sendJson(res, 200, { ok: true, cancelledReview: cancelled })
  })

  /**
   * The routes this panel may send each task to.
   *
   * Reasoning levels are per model, so this walks every provider's model list and
   * resolves each one's reasoning metadata. The walk is cached briefly: it can
   * hit the provider, and a panel that polls must not hammer it.
   */
  const models = route(`${BASE}/models`, async (_req, res) => {
    const llm = ctx.get('llm')
    if (llm === undefined) {
      sendJson(res, 200, { ok: true, providers: [], reason: 'no llm service in this composition' })
      return
    }
    const now = Date.now()
    if (lecture.modelsCache !== undefined && now - lecture.modelsCache.at < MODELS_CACHE_MS) {
      sendJson(res, 200, { ok: true, ...lecture.modelsCache.payload, cached: true })
      return
    }
    try {
      const providers = []
      for (const provider of llm.listProviders()) {
        const entries = []
        let catalog = []
        try {
          catalog = await llm.listModels(provider.id)
        } catch (error) {
          ctx.logger?.warn?.(`lecture-copilot: listModels(${provider.id}) failed: ${String(error?.message ?? error)}`)
        }
        for (const model of catalog) {
          let efforts = []
          let defaultEffort
          try {
            const info = await llm.resolveModelInfo(provider.id, model.id)
            efforts = (info.reasoning?.efforts ?? []).map((effort) => ({
              id: effort.id,
              name: effort.name,
              ...effort.description === undefined ? {} : { description: effort.description },
            }))
            defaultEffort = info.reasoning?.defaultEffort
          } catch {
            // A model without reasoning metadata simply has no levels.
          }
          entries.push({
            id: model.id,
            name: model.name,
            ...model.description === undefined ? {} : { description: model.description },
            efforts,
            ...defaultEffort === undefined ? {} : { defaultEffort },
          })
        }
        providers.push({ id: provider.id, name: provider.name, models: entries })
      }
      const payload = {
        providers,
        // Recognition is its own stage: an engine pick, not an LLM route.
        asr: {
          engines: [
            { id: 'harness', label: '本机识别（Harness speechToText）', auth: 'none' },
            ...config.asrProviders.map((engine) => ({
              id: engine.id,
              label: engine.label,
              baseURL: engine.baseURL,
              model: engine.model,
              // Only the credential *source* is public; the key never leaves the Host.
              auth: authSummary(engine),
            })),
          ],
          languages: lecture.asrLanguages(),
          current: lecture.asr(),
        },
        current: {
          // `recognition` mirrors `translation` so a panel bundle cached before
          // the split keeps rendering the route it is actually using.
          recognition: lecture.model('translation'),
          translation: lecture.model('translation'),
          review: lecture.model('review'),
        },
        compositionDefault: ctx.get('agentDefaultModel')?.currentSelection() ?? null,
      }
      lecture.modelsCache = { at: now, payload }
      sendJson(res, 200, { ok: true, ...payload })
    } catch (error) {
      sendJson(res, 502, { ok: false, error: String(error?.message ?? error) })
    }
  })

  /** Record one task's pick for this session: an engine/language, or an LLM route. */
  const select = route(`${BASE}/select`, async (req, res) => {
    let parsed
    try {
      const body = await readBody(req, 8192)
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      sendJson(res, 400, { ok: false, error: 'body must be JSON' })
      return
    }
    const outcome = lecture.select(parsed?.task, parsed)
    if (outcome !== true) {
      sendJson(res, 400, { ok: false, error: outcome })
      return
    }
    sendJson(res, 200, {
      ok: true,
      selection: lecture.selection,
      current: {
        asr: lecture.asr(),
        translation: lecture.model('translation'),
        recognition: lecture.model('translation'),
        review: lecture.model('review'),
      },
    })
  })

  /**
   * Readiness probe: what this row found in the composition, and which
   * recognizer the transcription will use. Handy when the panel is silent and
   * the reason is a missing service rather than a missing microphone.
   */
  const health = route(`${BASE}/health`, (_req, res) => {
    const providers = ctx.speechToText.listProviders().map((provider) => ({
      id: provider.id,
      name: provider.name,
      location: provider.location,
      languages: [...provider.languages],
    }))
    const snapshot = ctx.speechToText.snapshot()
    const selection = ctx.get('agentDefaultModel')?.currentSelection()
    sendJson(res, 200, {
      ok: true,
      plugin: 'dsh-lecture-copilot',
      language: lecture.config.language,
      services: {
        speechToText: true,
        llm: ctx.get('llm') !== undefined,
        tools: ctx.get('tools') !== undefined,
        webServer: true,
      },
      recognizer: {
        selected: snapshot.selection.providerId,
        language: snapshot.selection.language,
        state: snapshot.providers.find((provider) => provider.id === snapshot.selection.providerId)?.preparation ?? null,
        providers,
      },
      models: {
        asr: lecture.asr(),
        recognition: lecture.model('translation'),
        translation: lecture.model('translation'),
        review: lecture.model('review'),
      },
      context: lecture.config.context,
      glossary: lecture.config.glossary,
      compositionDefault: selection ?? null,
    })
  })

  /**
   * The local notebook tree plus the remembered destination lists.
   *
   * `available: false` is an ordinary state — OneNote is simply not installed —
   * and the panel hides the export control instead of offering a button that
   * cannot work.
   */
  const onenote = route(`${BASE}/onenote`, async (_req, res) => {
    const reply = await bridge.list()
    if (reply.ok !== true) {
      sendJson(res, 200, { ok: true, available: false, reason: reply.error ?? 'OneNote 不可用' })
      return
    }
    const live = bridge.flatten(reply.notebooks)
    const remembered = reconcileDestinations(await readDestinations(harnessHome()), live)
    sendJson(res, 200, {
      ok: true,
      available: true,
      notebooks: live.notebooks.map((row) => row.name),
      rememberedNotebooks: remembered.notebooks,
      rememberedPages: remembered.pages,
      // Sections carry their notebook, so the picker can follow the notebook the
      // way the page picker does.
      sections: live.sections.map((row) => ({
        notebook: row.notebookName,
        name: row.name,
      })),
      pages: live.pages.map((row) => ({
        notebook: row.notebookName,
        section: row.sectionName,
        name: row.name,
      })),
    })
  })

  /**
   * Name one review, for use as a new page's title.
   *
   * Split from the create call so the panel can show the name before writing, and
   * so a model failure never blocks the write: the caller keeps its own fallback.
   */
  const onenoteTitle = route(`${BASE}/onenote/title`, async (req, res) => {
    const parsed = await readJsonBody(req)
    if (parsed === undefined) {
      sendJson(res, 400, { ok: false, error: 'body must be JSON' })
      return
    }
    if (lecture.review === undefined) {
      sendJson(res, 409, { ok: false, error: '还没有可导出的笔记' })
      return
    }
    const route = lecture.model('review')
    const title = await generateTitle(
      ctx,
      { ...route, timeoutMs: TITLE_TIMEOUT_MS, signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) },
      lecture.review,
    )
    sendJson(res, 200, {
      ok: true,
      title: title ?? noteTitle({ context: config.context, now: new Date() }),
      generated: title !== undefined,
    })
  })

  /**
   * Add the current review to an existing page, without disturbing it.
   *
   * Everything the person typed is matched against the live tree first: a
   * notebook or page that does not exist is reported and nothing is written.
   */
  const onenoteExport = route(`${BASE}/onenote/export`, async (req, res) => {
    const parsed = await readJsonBody(req)
    if (parsed === undefined) {
      sendJson(res, 400, { ok: false, error: 'body must be JSON' })
      return
    }
    if (lecture.review === undefined) {
      sendJson(res, 409, { ok: false, error: '还没有可导出的笔记' })
      return
    }
    const live = await loadLiveTree(bridge)
    if (live === undefined) {
      sendJson(res, 200, { ok: false, error: 'OneNote 不可用' })
      return
    }
    const notebook = bridge.matchByName(parsed.notebook, live.notebooks)
    if (notebook === undefined) {
      sendJson(res, 200, { ok: false, error: `笔记本不存在：${String(parsed.notebook ?? '').trim() || '（空）'}` })
      return
    }
    const page = bridge.matchByName(parsed.page, live.pages.filter((row) => row.notebookName === notebook.name))
    if (page === undefined) {
      sendJson(res, 200, { ok: false, error: `「${notebook.name}」里没有这个页面：${String(parsed.page ?? '').trim() || '（空）'}` })
      return
    }

    const stamp = noteTitle({ context: config.context, now: new Date() })
    const result = await bridge.append({
      pageId: page.id,
      stamp: `—— 课堂同传 · ${stamp} ——`,
      body: markdownToPageXml(lecture.review),
    })
    if (result.ok !== true) {
      sendJson(res, 200, { ok: false, error: result.error ?? '写入 OneNote 失败' })
      return
    }
    const remembered = await rememberDestination(harnessHome(), {
      notebook: notebook.name,
      section: page.sectionName,
      page: page.name,
    })
    sendJson(res, 200, {
      ok: true,
      mode: 'append',
      notebook: notebook.name,
      page: result.pageName ?? page.name,
      url: result.url ?? '',
      remembered: { notebooks: remembered.notebooks, pages: remembered.pages },
    })
  })

  /**
   * Create a fresh page in the chosen notebook and write the review into it.
   *
   * The page name is generated from the course context and the time; when the
   * notebook has a section whose name carries the date, that section is used so
   * the new page lands beside the day's notes.
   */
  const onenoteNewPage = route(`${BASE}/onenote/new-page`, async (req, res) => {
    const parsed = await readJsonBody(req)
    if (parsed === undefined) {
      sendJson(res, 400, { ok: false, error: 'body must be JSON' })
      return
    }
    if (lecture.review === undefined) {
      sendJson(res, 409, { ok: false, error: '还没有可导出的笔记' })
      return
    }
    const live = await loadLiveTree(bridge)
    if (live === undefined) {
      sendJson(res, 200, { ok: false, error: 'OneNote 不可用' })
      return
    }
    const notebook = bridge.matchByName(parsed.notebook, live.notebooks)
    if (notebook === undefined) {
      sendJson(res, 200, { ok: false, error: `笔记本不存在：${String(parsed.notebook ?? '').trim() || '（空）'}` })
      return
    }

    // A section is required to place the page, and it must be one that exists in
    // the notebook that was chosen. Falling back to "some section" would put the
    // note somewhere the person did not ask for.
    const sections = live.sections.filter((row) => row.notebookId === notebook.id)
    const section = resolveSection(sections, parsed.section, bridge)
    if (section === undefined) {
      const typed = String(parsed.section ?? '').trim()
      sendJson(res, 200, {
        ok: false,
        error: typed.length === 0
          ? `请先选择分区（「${notebook.name}」下有 ${String(sections.length)} 个）`
          : `分区不存在：${typed}`,
      })
      return
    }

    // The model names the page from the note's own content. A model failure is
    // not fatal: the date-based title keeps the button working.
    const titleTimeoutMs = Number.isFinite(config.titleTimeoutMs) ? config.titleTimeoutMs : TITLE_TIMEOUT_MS
    const generated = await generateTitle(
      ctx,
      {
        ...lecture.model('review'),
        timeoutMs: titleTimeoutMs,
        signal: AbortSignal.timeout(titleTimeoutMs),
      },
      lecture.review,
    )
    const title = generated ?? noteTitle({ context: config.context })
    const result = await bridge.create({ sectionId: section.id, title, body: markdownToPageXml(lecture.review) })
    if (result.ok !== true) {
      sendJson(res, 200, { ok: false, error: result.error ?? '新建页面失败' })
      return
    }
    const remembered = await rememberDestination(harnessHome(), { notebook: notebook.name, section: section.name, page: '' })
    sendJson(res, 200, {
      ok: true,
      mode: 'create',
      notebook: notebook.name,
      section: section.name,
      page: result.pageName ?? title,
      title,
      namedByModel: generated !== undefined,
      url: result.url ?? '',
      remembered: { notebooks: remembered.notebooks, pages: remembered.pages },
    })
  })

  /** Drop one remembered destination, so a stale name stops being offered. */
  const onenoteForget = route(`${BASE}/onenote/forget`, async (req, res) => {
    const parsed = await readJsonBody(req)
    if (parsed === undefined) {
      sendJson(res, 400, { ok: false, error: 'body must be JSON' })
      return
    }
    const remembered = await forgetDestination(harnessHome(), parsed)
    sendJson(res, 200, { ok: true, remembered: { notebooks: remembered.notebooks, pages: remembered.pages } })
  })

  return [
    ['state', state],
    ['review', review],
    ['start', start],
    ['audio', audio],
    ['stop', stop],
    ['clear', clear],
    ['models', models],
    ['select', select],
    ['onenote', onenote],
    ['onenote-export', onenoteExport],
    ['onenote-title', onenoteTitle],
    ['onenote-new-page', onenoteNewPage],
    ['onenote-forget', onenoteForget],
    ['health', health],
  ]
}

/**
 * Mount the Host half.
 *
 * The session is published unconditionally. Everything that attaches to
 * *another* service goes through `ctx.inject`, which is the only reactive form:
 * a plain `ctx.get(name)` at activation time reads once and never retries, so a
 * service that appears later would leave this row silently inert. Binding each
 * attachment to its own dependency also means one missing service costs exactly
 * one feature instead of the whole row.
 *
 * @param ctx - Host plugin context.
 * @param rawConfig - configuration as the loader read it.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const lecture = createLecture(ctx, config)
  ctx.provide('lectureCopilot', lecture)
  ctx.effect(() => () => {
    lecture.clear()
  }, 'lecture-copilot: session lifetime')

  const model = resolveModel(ctx, config)
  ctx.logger?.info?.(`lecture-copilot: ready (${model.provider}/${model.model}, language ${config.language})`)

  ctx.inject(['llm'], (scoped) => {
    scoped.logger?.info?.('lecture-copilot: llm available; live translation and the review are armed')
  })

  ctx.inject(['tools'], (scoped) => {
    scoped.effect(() => registerTools(scoped, lecture), 'lecture-copilot: lecture tools')
    scoped.logger?.info?.('lecture-copilot: lecture tools registered')
  })

  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.get('webServer')
    const routes = lectureRoutes(lecture, scoped, scoped.get('onenoteBridge') ?? onenoteBridge, config)
    for (const [label, entry] of routes) {
      scoped.effect(() => webServer.register(entry), `lecture-copilot: ${label} route`)
    }
    scoped.logger?.info?.(`lecture-copilot: web carrier mounted at ${BASE} (${routes.length} routes)`)
  })

  ctx.inject(['speechToText'], (scoped) => {
    const speech = scoped.get('speechToText')
    const snapshot = speech.snapshot()
    scoped.logger?.info?.(
      `lecture-copilot: recognizer ${snapshot.selection.providerId} (${snapshot.selection.language})`,
    )
  })
}

export { REVIEW_SYSTEM, TRANSLATION_SYSTEM, reviewRequest, transcriptBody as renderTranscript }

