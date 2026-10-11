/**
 * Headless verification harness for dsh-lecture-copilot.
 *
 * The plugin is dependency-free on purpose, so its Host half can be exercised
 * in a plain Node process with stub services: this proves the whole pipeline —
 * route registration, WAV validation, transcription, serialized translation,
 * review generation, and the two tools — without a running Harness.
 *
 * Run it with the launcher's Node:
 *   "…\dependencies\node\bin\node.exe" verify.mjs
 */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply, configDefaults, resolveConfig } from '../dsh-lecture-copilot/lib/index.js'
import { createToolDefinitions } from '../dsh-lecture-copilot/lib/tools.js'
import * as onenoteBridge from '../dsh-lecture-copilot/lib/onenote.js'
import { normalizeTitle } from '../dsh-lecture-copilot/lib/notes.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = join(here, '..', 'dsh-lecture-copilot')

/**
 * Load the panel's state module — the exact file the browser half requires.
 *
 * It is plain CommonJS, and this package declares `type: module`, so Node needs
 * a CJS-scoped copy to import it. The copy is byte-identical and removed again,
 * which keeps the tested code and the shipped code the same file.
 * @returns the module exports.
 */
function loadStateModule() {
  const scratch = join(here, '.state-cjs')
  mkdirSync(scratch, { recursive: true })
  writeFileSync(join(scratch, 'package.json'), '{"type":"commonjs"}')
  const copy = join(scratch, 'state.js')
  writeFileSync(copy, readFileSync(join(pluginDir, 'lib', 'state.js')))
  const loaded = createRequire(import.meta.url)(copy)
  rmSync(scratch, { recursive: true, force: true })
  return loaded
}

/**
 * Check one raw schema against the subset `@deepseek-ai/dsh-tools` accepts.
 * Mirrors `assertSupportedJsonSchema`: the key rules are that `properties`,
 * `required`, and `additionalProperties` belong to objects only, `items` to
 * arrays only, `enum`/`const` to scalars only, `required` is an array of
 * strings, and `type` is a single string.
 * @param node - schema node.
 * @param path - diagnostic path.
 * @param violations - collector.
 */
function checkSchema(node, path, violations) {
  const types = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
  if (node === null || typeof node !== 'object') {
    violations.push(`${path} must be a schema object`)
    return
  }
  const type = node.type
  if (typeof type !== 'string' || !types.includes(type)) {
    violations.push(`${path}.type must be one of ${types.join('/')}`)
    return
  }
  for (const [key, allowed] of Object.entries({
    properties: ['object'],
    required: ['object'],
    additionalProperties: ['object'],
    items: ['array'],
    enum: ['string', 'number', 'integer', 'boolean', 'null'],
    const: ['string', 'number', 'integer', 'boolean', 'null'],
  })) {
    if (Object.hasOwn(node, key) && !allowed.includes(type)) {
      violations.push(`${path}.${key} is not supported on type "${type}"`)
    }
  }
  if (type === 'object') {
    if (Object.hasOwn(node, 'required')) {
      const required = node.required
      if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
        violations.push(`${path}.required must be an array of strings`)
      }
    }
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      checkSchema(child, `${path}.properties.${name}`, violations)
    }
  }
  if (type === 'array' && Object.hasOwn(node, 'items')) {
    checkSchema(node.items, `${path}.items`, violations)
  }
}

let failures = 0
let checks = 0

/**
 * Assert one condition and record the outcome.
 * @param label - what is being asserted.
 * @param condition - the result.
 * @param detail - optional extra context on failure.
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

/** Build a canonical 16 kHz mono PCM16 WAV buffer of `seconds` of silence. */
function silentWave(seconds) {
  const samples = Math.max(1, Math.round(seconds * 16000))
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(bytes.length - 8, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24)
  bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(samples * 2, 40)
  return bytes
}

/** A minimal stand-in for a Node request carrying one body. */
function fakeRequest(method, url, body) {
  const listeners = new Map()
  const request = {
    method,
    url,
    on(event, handler) {
      listeners.set(event, handler)
      return request
    },
    destroy() {},
  }
  // Routes read bytes, as the real server hands them over. A plain object here
  // would reach Buffer.concat and fail the way it would in production.
  const payload = body === undefined || Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8')
  queueMicrotask(() => {
    if (payload !== undefined) listeners.get('data')?.(payload)
    listeners.get('end')?.()
  })
  return request
}

/** A minimal stand-in for a Node response that records what was sent. */
function fakeResponse() {
  const response = {
    status: 0,
    headers: undefined,
    body: '',
    writeHead(status, headers) {
      response.status = status
      response.headers = headers
    },
    end(chunk) {
      response.body += chunk ?? ''
    },
    get json() {
      return JSON.parse(response.body)
    },
  }
  return response
}

/** A scripted recognition provider that answers a fixed sentence per call. */
function transcriptionStub(sentences) {
  let index = 0
  const info = { id: 'sensevoice-local', name: 'SenseVoice (local)', location: 'host-local', languages: ['auto', 'en', 'zh'] }
  return {
    listProviders: () => [{ ...info }],
    snapshot: () => ({
      providers: [{ ...info, preparation: { phase: 'ready' } }],
      selection: { providerId: 'sensevoice-local', language: 'auto' },
    }),
    resolve: (request) => ({ ...request, provider: { info } }),
    transcribe: async () => {
      const text = sentences[Math.min(index, sentences.length - 1)]
      index += 1
      return { text, audioSeconds: 4, inferenceSeconds: 0.4 }
    },
  }
}

/**
 * A model stub that answers by prompt role rather than by call order: a call
 * carrying the review system prompt gets the review, anything else is treated
 * as a translation. `review` may be omitted, which models a composition whose
 * review call never answers.
 */
function llmStub({ translations, review }) {
  const seen = []
  let translations_used = 0
  const service = {
    /**
     * A small but realistic provider catalog: two models, one of which declares
     * reasoning levels. `/models` walks exactly these.
     */
    listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }],
    listModels: async (provider) => (provider === 'deepseek-official'
      ? [
        { provider, id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' },
        { provider, id: 'reasoner', name: 'DeepSeek-R1' },
      ]
      : []),
    resolveModelInfo: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      ...model === 'reasoner'
        ? {
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
            ],
            defaultEffort: 'low',
          },
        }
        : {},
    }),
    stream(options) {
      const bar = String.fromCharCode(10)
      const reviewBullet = String.fromCharCode(0x903b, 0x8f91, 0x94fe)
      const system = String(options.system ?? '')
      const user = options.messages[0].content[0].text
      const isReview = review !== undefined && system.split(bar).join('').includes(reviewBullet)
      const reply = isReview
        ? review
        : translations[Math.min(translations_used, translations.length - 1)]
      if (!isReview) translations_used += 1
      seen.push({
        role: isReview ? 'review' : 'translation',
        system,
        user,
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        reply,
      })
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        for (const piece of reply.match(/.{1,12}/gu) ?? []) {
          yield { type: 'text-delta', index: 0, text: piece }
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  return { seen, service }
}

/** Build the stub Cordis context the plugin's apply() expects. */
function buildContext({ sentences, translations, review, withTools = true, withWeb = true, onenote }) {
  const routes = new Map()
  const registered = new Map()
  const provided = new Map()
  const llm = llmStub({ translations, review })
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
    speechToText: transcriptionStub(sentences),
    disposers: [],
    effect: (callback) => {
      const disposer = callback()
      ctx.disposers.push(disposer)
      return disposer
    },
    provide: (name, value) => {
      provided.set(name, value)
      return () => provided.delete(name)
    },
    // A dependency the scenario omits is simply never injected — mirroring the
    // real runtime's "wait until the service appears" behaviour. `arm()` models
    // a service becoming available later, which is what the production bug was.
    inject: (deps, callback) => {
      const pending = deps.filter((name) => ctx.get(name) === undefined)
      if (pending.length === 0) callback(ctx)
      else ctx.pendingInjections.push({ deps, callback })
      return { dispose: async () => {} }
    },
    pendingInjections: [],
    /** Re-run every waiting injection, as Cordis does when a service appears. */
    arm: () => {
      const waiting = ctx.pendingInjections.splice(0)
      let ran = 0
      for (const item of waiting) {
        if (item.deps.every((name) => ctx.get(name) !== undefined)) {
          item.callback(ctx)
          ran += 1
        } else {
          ctx.pendingInjections.push(item)
        }
      }
      return ran
    },
    get: (name) => {
      if (name === 'llm') return llm.service
      if (name === 'speechToText') return ctx.speechToText
      if (name === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
      }
      if (name === 'tools') {
        if (!withTools) return undefined
        return {
          register: (definition) => {
            registered.set(definition.name, definition)
            return () => registered.delete(definition.name)
          },
        }
      }
      if (name === 'onenoteBridge') return onenote
      if (name === 'webServer') {
        if (!withWeb || !ctx.webArmed) return undefined
        return {
          register: (entry) => {
            routes.set(entry.path, entry)
            return () => routes.delete(entry.path)
          },
        }
      }
      return undefined
    },
    routes,
    registered,
    provided,
    llm,
    // Web/tools start absent in the "service arrives later" scenario.
    webArmed: withWeb
  }
  return ctx
}

/** Call one registered route. */
async function call(ctx, path, method, body, query) {
  const entry = ctx.routes.get(path)
  if (entry === undefined) throw new Error(`route ${path} is not registered`)
  const response = fakeResponse()
  const url = query === undefined ? path : `${path}?${query}`
  await entry.handler(fakeRequest(method, url, body), response)
  return response
}

/* ------------------------------------------------------------------- tests */

console.log('\n1. configuration')
{
  const defaults = resolveConfig(undefined)
  check('empty config resolves to defaults', defaults.language === 'en' && defaults.maxSegments === 2000, JSON.stringify({ language: defaults.language }))
  check('below-floor value is lifted to the floor', resolveConfig({ maxSegments: 1 }).maxSegments === 16)
  check('non-numeric value falls back to the default', resolveConfig({ translationTimeoutMs: 'soon' }).translationTimeoutMs === 60000)
  check('provider strings are preserved', resolveConfig({ provider: 'deepseek-official' }).provider === 'deepseek-official')
  check('defaults are exposed detached', configDefaults() !== configDefaults())
}

console.log('\n2. route table')
{
  const ctx = buildContext({ sentences: ['x'], translations: ['y'] })
  apply(ctx, undefined)
  const paths = [...ctx.routes.keys()].sort()
  check('every endpoint is registered', paths.length === 14, paths.join(','))
  check('audio endpoint exists', ctx.routes.has('/lecture-copilot/audio'))
  check('health endpoint exists', ctx.routes.has('/lecture-copilot/health'))
  check('the session is published on the context', ctx.provided.get('lectureCopilot') !== undefined)
  check(
    'both tools are registered',
    ctx.registered.has('lecture_transcript') && ctx.registered.has('lecture_review'),
    [...ctx.registered.keys()].join(','),
  )
}

console.log('\n3. health probe')
{
  const ctx = buildContext({ sentences: ['x'], translations: ['y'] })
  apply(ctx, { language: 'en' })
  const response = await call(ctx, '/lecture-copilot/health', 'GET')
  check('health answers 200', response.status === 200)
  check('health reports the recognizer', response.json.recognizer.selected === 'sensevoice-local')
  check('health reports the llm service', response.json.services.llm === true)
  check('health reflects the configured language', response.json.language === 'en')
}

console.log('\n4. the record -> transcribe -> translate pipeline')
{
  const ctx = buildContext({
    sentences: ['Consider the function f of x equals x squared.', 'Its derivative is two x by the power rule.'],
    translations: ['考虑函数 f(x) 等于 x 的平方。', '由幂法则，它的导数是 2x。'],
  })
  apply(ctx, { statusMinMs: 0 })
  const lecture = ctx.provided.get('lectureCopilot')

  const before = await call(ctx, '/lecture-copilot/audio', 'POST', silentWave(4))
  check('audio before start is refused', before.json.accepted === false && before.json.reason === 'idle')

  await call(ctx, '/lecture-copilot/start', 'POST')
  check('the session is active after start', lecture.view(0).active === true)

  const tiny = await call(ctx, '/lecture-copilot/audio', 'POST', silentWave(0.05))
  check('a too-short chunk is dropped', tiny.json.accepted === false && tiny.json.reason === 'too-short')

  const notWave = await call(ctx, '/lecture-copilot/audio', 'POST', Buffer.from('not audio at all, definitely not a wave file'))
  check('a non-WAV body is rejected with 400', notWave.status === 400)

  const first = await call(ctx, '/lecture-copilot/audio', 'POST', silentWave(4))
  check('the first chunk is transcribed', first.json.accepted === true, JSON.stringify(first.json))
  check('the English original comes back', String(first.json.text).includes('x squared'))

  const second = await call(ctx, '/lecture-copilot/audio', 'POST', silentWave(3))
  check('the second chunk is transcribed', second.json.accepted === true)

  await new Promise((resolve) => setTimeout(resolve, 80))
  const state = await call(ctx, '/lecture-copilot/state', 'GET')
  check('both segments are stored', state.json.state.total === 2, JSON.stringify(state.json.state.total))
  check('both segments are translated', state.json.state.translated === 2, JSON.stringify(state.json.state.segments))
  check('translations keep the lecture order', state.json.state.segments[0].translation.includes('平方'))
  const page = await call(ctx, '/lecture-copilot/state', 'GET', undefined, 'since=1')
  check('the incremental cursor filters', page.json.state.segments.length === 1)
  check('one model call per segment', ctx.llm.seen.length === 2, `saw ${ctx.llm.seen.length}`)
  check(
    'the translation prompt is the translation one',
    String(ctx.llm.seen[0]?.system ?? '').includes('同声传译员'),
    `system=${JSON.stringify(String(ctx.llm.seen[0]?.system ?? '').slice(0, 50))}`,
  )
  check(
    'the model route follows the composition default',
    ctx.llm.seen[0]?.provider === 'deepseek-official' && ctx.llm.seen[0]?.model === 'deepseek-flash',
    JSON.stringify(ctx.llm.seen[0]),
  )
}

console.log('\n5. stop returns at once and the review lands in the background')
{
  const ctx = buildContext({
    sentences: ['The limit of sine x over x as x tends to zero is one.', 'That is the first remarkable limit.'],
    translations: ['当 x 趋于 0 时，sin x 除以 x 的极限是 1。'],
    review: '## 一、课堂主线\n讲了第一个重要极限。\n\n## 二、逻辑链\n定义 → 夹逼 → 结论',
  })
  // The shipped 900 ms "translating" hold would otherwise dominate this timing.
  apply(ctx, { statusMinMs: 0 })
  await call(ctx, '/lecture-copilot/start', 'POST')
  await call(ctx, '/lecture-copilot/audio', 'POST', silentWave(4))

  // The route must not wait for the model: a blocking /stop is what froze the
  // panel, and in the worst case it times the request out entirely.
  const began = Date.now()
  const stopped = await call(ctx, '/lecture-copilot/stop', 'POST')
  const elapsed = Date.now() - began
  check('stop answers 200', stopped.status === 200)
  check('stop returns without waiting for the review', elapsed < 400, `${elapsed}ms`)
  check('stop says a review was started', stopped.json.reviewStarted === true, JSON.stringify(stopped.json))
  check('the recording is no longer active', stopped.json.state.active === false)
  check(
    'the state advertises the pending review immediately',
    stopped.json.state.reviewPending === true,
    JSON.stringify(stopped.json.state),
  )

  // Drain the background pass, exactly as the panel's polling loop does.
  let settled
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
    settled = (await call(ctx, '/lecture-copilot/state', 'GET')).json.state
    if (settled.hasReview || settled.reviewError !== null) break
  }
  check('the background review completes', settled.hasReview === true, JSON.stringify(settled.reviewError))
  check('once ready the state stops reporting pending', settled.reviewPending === false)

  const reviewCall = ctx.llm.seen.at(-1)
  check('the review is the last model call', ctx.llm.seen.length === 2, `saw ${ctx.llm.seen.length}`)
  check(
    'the review prompt asks for the logic chain',
    String(reviewCall?.system ?? '').includes('逻辑链'),
    JSON.stringify(String(reviewCall?.system ?? '').slice(0, 60)),
  )
  check('the review prompt carries the transcript', String(reviewCall?.user ?? '').includes('tends to zero'))
  check('the review prompt forbids inventing content', String(reviewCall?.system ?? '').includes('不要补充转写中没有出现的知识'))
  const review = await call(ctx, '/lecture-copilot/review', 'GET')
  check('the review route serves the stored note', String(review.json.review ?? '').includes('逻辑链'))
}

console.log('\n6. the model-facing tools')
{
  const ctx = buildContext({
    sentences: ['A binary search tree keeps the left subtree smaller.'],
    translations: ['二叉搜索树的左子树更小。'],
    review: '## 一、课堂主线\n讲二叉搜索树。',
  })
  apply(ctx, undefined)
  await call(ctx, '/lecture-copilot/start', 'POST')
  await call(ctx, '/lecture-copilot/audio', 'POST', silentWave(4))
  // The shipped status hold keeps a segment in "translating" for 900 ms.
  await new Promise((resolve) => setTimeout(resolve, 1000))

  const transcriptTool = ctx.registered.get('lecture_transcript')
  const transcript = await transcriptTool.execute({}, { signal: undefined })
  check(
    'the transcript tool returns both languages',
    transcript.text.includes('binary search tree') && transcript.text.includes('二叉搜索树'),
    JSON.stringify(transcript.text),
  )
  check('the transcript tool reports the segment count', transcript.total === 1)

  const reviewTool = ctx.registered.get('lecture_review')
  const review = await reviewTool.execute({}, { signal: undefined })
  check('the review tool generates on demand', review.status === 'ready' && review.review.includes('二叉搜索树'))
  check('tool output declares a text renderer', transcriptTool.output.render({}, transcript)[0].type === 'text')
}

console.log('\n7. degradation and teardown')
{
  const ctx = buildContext({ sentences: ['x'], translations: ['y'], withTools: false, withWeb: false })
  apply(ctx, undefined)
  check('a composition without a web server still publishes the session', ctx.provided.get('lectureCopilot') !== undefined)
  check('no routes are claimed without a web server', ctx.routes.size === 0)

  const ctx2 = buildContext({ sentences: ['x'], translations: ['y'] })
  apply(ctx2, undefined)
  const lecture = ctx2.provided.get('lectureCopilot')
  await call(ctx2, '/lecture-copilot/start', 'POST')
  const cleared = await call(ctx2, '/lecture-copilot/clear', 'POST')
  check('clear answers 200', cleared.status === 200)
  check('clear empties the session', lecture.view(0).total === 0 && lecture.view(0).active === false)
}

console.log('\n8. a service that arrives after activation still gets wired')
{
  // The production bug this guards: reading `ctx.get(name)` once at activation
  // leaves the row permanently inert when the service appears later. Only a
  // dependency-bound callback is re-run.
  const ctx = buildContext({ sentences: ['x'], translations: ['y'] })
  ctx.webArmed = false
  apply(ctx, undefined)
  check('nothing is claimed while the web server is absent', ctx.routes.size === 0)
  check('the plugin is waiting on the injection', ctx.pendingInjections.length > 0)

  ctx.webArmed = true
  const ran = ctx.arm()
  check('the waiting injection runs once the service appears', ran >= 1, `ran ${ran}`)
  check('every route is claimed after the service appears', ctx.routes.size === 14, String(ctx.routes.size))
  const health = await call(ctx, '/lecture-copilot/health', 'GET')
  check('the late-wired health route answers 200', health.status === 200)
}

console.log('\n9. the review prompt reports a plausible lecture duration')
{
  // Regression: the session used to hand `transcriptBody` the absolute stop
  // timestamp, so a 41-minute lecture was announced as ~29854533 minutes.
  const ctx = buildContext({ sentences: ['A short sentence.'], translations: ['一句话。'], review: '## 一、课堂主线\nx' })
  apply(ctx, undefined)
  await call(ctx, '/lecture-copilot/start', 'POST')
  await call(ctx, '/lecture-copilot/audio', 'POST', silentWave(3))
  // The panel reports the duration it measured; with none supplied the session
  // falls back to its own start/stop timestamps.
  await call(ctx, '/lecture-copilot/stop', 'POST', Buffer.from(JSON.stringify({ elapsedMs: 41 * 60 * 1000 })))
  const prompt = ctx.llm.seen.find((call) => call.role === 'review')?.user ?? ''
  const head = prompt.split('\n').find((line) => line.includes('课堂时长')) ?? ''
  check('the prompt states the reported duration', head.includes('课堂时长约 41 分钟'), JSON.stringify(head))
  check('the duration is never the raw stop timestamp', !head.includes('2985'), JSON.stringify(head))

  const fallback = buildContext({ sentences: ['A short sentence.'], translations: ['一句话。'], review: '## 一、课堂主线\nx' })
  apply(fallback, undefined)
  await call(fallback, '/lecture-copilot/start', 'POST')
  await call(fallback, '/lecture-copilot/audio', 'POST', silentWave(3))
  await call(fallback, '/lecture-copilot/stop', 'POST', Buffer.from('{}'))
  const fallbackPrompt = fallback.llm.seen.find((call) => call.role === 'review')?.user ?? ''
  const fallbackHead = fallbackPrompt.split('\n').find((line) => line.includes('课堂时长')) ?? ''
  check('without a reported duration it falls back to measured time', /课堂时长约 \d+ 分钟/u.test(fallbackHead), JSON.stringify(fallbackHead))
  check('the measured fallback is plausible', Number(fallbackHead.match(/[0-9]+/u)?.[0]) < 60, JSON.stringify(fallbackHead))
}

console.log('\n10. tool schemas belong to the registry-supported subset')
{
  // Guards the bug that made the live row fail activation: the registry rejects
  // `required: true` on a scalar and requires `required` to be an array.
  const definitions = createToolDefinitions({ segments: [], active: false, consolidate: async () => ({}) })
  check('both tools are described', definitions.length === 2, String(definitions.length))
  for (const definition of definitions) {
    const parameterViolations = []
    checkSchema(definition.parameters, `${definition.name}.parameters`, parameterViolations)
    check(`${definition.name} parameters are supported`, parameterViolations.length === 0, parameterViolations.join('; '))
    const outputViolations = []
    checkSchema(definition.output.schema, `${definition.name}.output.schema`, outputViolations)
    check(`${definition.name} output schema is supported`, outputViolations.length === 0, outputViolations.join('; '))
  }
  const transcript = definitions[0]
  check(
    'a scalar field carries no per-field required',
    transcript.output.schema.properties.active.required === undefined,
  )
  check(
    'the object declares required as an array',
    Array.isArray(transcript.output.schema.required),
    JSON.stringify(transcript.output.schema.required),
  )
  check('every tool has a text renderer', definitions.every((item) => typeof item.output.render === 'function'))
}

/**
 * Guard the one duplication in the plugin: the panel's state block is inlined in
 * the browser half (a bundle may only rely on the platform table and package
 * specifiers) and also lives in `lib/state.js`, which the tests above drive.
 *
 * The whole block is compared, not just each function, so the store literal, the
 * subscriber set, and every body have to agree. That keeps the tested code and
 * the shipped code the same behaviourally even though it is not the same file.
 * @returns the differences found, empty when the two agree.
 */
function compareStateImplementations() {
  const client = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8')
  const module = readFileSync(join(pluginDir, 'lib', 'state.js'), 'utf8')

  const clean = (text) => text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/\/\/[^\n]*/gu, '')
    .replace(/\s+/gu, '')

  // Between the two markers, client.js holds exactly the module's block.
  const start = client.indexOf('const store = {')
  const end = client.indexOf('/* ------------------------------------------------------- end of state block */')
  if (start === -1 || end === -1 || end < start) {
    return ['the state block markers are missing from client.js']
  }
  const inlined = clean(client.slice(start, end))

  const moduleStart = module.indexOf('const store = {')
  const moduleEnd = module.indexOf('/* ------------------------------------------------------- end of state block */')
  if (moduleStart === -1 || moduleEnd === -1) return ['the state block is missing from state.js']
  const declared = clean(module.slice(moduleStart, moduleEnd))

  const differences = []
  if (inlined !== declared) {
    // Point at the first divergence so the message is actionable.
    let at = 0
    while (at < inlined.length && at < declared.length && inlined[at] === declared[at]) at += 1
    differences.push(
      `inlined block diverges at character ${String(at)}: client "${inlined.slice(at, at + 40)}" vs state "${declared.slice(at, at + 40)}"`,
    )
  }
  for (const name of ['publish', 'subscribe', 'applyState', 'reviewOutcome', 'translationLine', 'routeOptions']) {
    if (!client.includes(`function ${name}(`)) differences.push(`${name} missing from client.js`)
  }
  return differences
}

console.log('\n11. panel state: a translated row replaces the pending one')
{
  // The row froze on "翻译中…" because `applyState` merged by id and kept the
  // first version of every known segment. Drive the exact sequence the page sees.
  const { store, applyState, translationLine, reviewOutcome, resetStore } = loadStateModule()

  resetStore()
  applyState({ state: { segments: [{ id: 1, at: '10:00', text: 'ENE', state: 'translating' }], total: 1, pending: 1 } })
  check('the row starts as pending', translationLine(store.segments[0]) === '翻译中…')

  applyState({ state: { segments: [{ id: 1, at: '10:00', text: 'ENE', state: 'translated', translation: '中文' }], total: 1, translated: 1, pending: 0 } })
  check('the same id now carries the translation', translationLine(store.segments[0]) === '中文', JSON.stringify(store.segments))
  check('the translated count follows', store.translated === 1)
  check('a failed segment reports why', translationLine({ id: 2, state: 'failed', error: '模型超时' }) === '翻译失败：模型超时')

  applyState({
    state: {
      segments: [
        { id: 1, at: '10:00', text: 'ENE', state: 'translated', translation: '中文' },
        { id: 2, at: '10:20', text: 'EN2', state: 'queued' },
      ],
      total: 2,
      translated: 1,
      pending: 1,
    },
  })
  check('a new segment joins without dropping the old one', store.segments.length === 2, String(store.segments.length))
  check('the first segment keeps its translation', store.segments[0].translation === '中文')

  check('a ready review asks for the body', reviewOutcome({ hasReview: true }) === 'fetch')
  check('a running review waits', reviewOutcome({ hasReview: false, reviewPending: true }) === 'wait')
  check('a failed review reports failure', reviewOutcome({ hasReview: false, reviewPending: false, reviewError: '模型超时' }) === 'failed')
  check('a settled empty review reports empty', reviewOutcome({ hasReview: false, reviewPending: false, reviewError: null }) === 'empty')
}

console.log('\n12. panel state: a ready review actually renders')
{
  // The button read "收起笔记" while the pane stayed hidden, because the flag was
  // set without the body. Assert the two agree.
  const { store, publish, reviewOutcome, resetStore } = loadStateModule()
  resetStore()

  check('the pass reports a body to fetch', reviewOutcome({ hasReview: true }) === 'fetch')

  // Exactly what `waitForReview` does once the body is in hand.
  const body = '## 一、课堂主线\n讲了什么'
  publish({ phase: 'idle', reviewOpen: body !== null, review: body, error: '' })

  check('the pane is open', store.reviewOpen === true)
  check('the pane has a body to render', store.review !== null, JSON.stringify(store.review))
  const panesRendered = store.reviewOpen && store.review !== null ? 1 : 0
  check('the pane actually renders', panesRendered === 1)
  const buttonLabel = store.reviewOpen ? '收起笔记' : '查看笔记'
  check('the button label matches a visible pane', buttonLabel === '收起笔记' && panesRendered === 1)

  // The pre-fix shape fails the same assertion, which is what made this a bug.
  resetStore()
  publish({ phase: 'idle', reviewOpen: true, error: '' })
  const brokenPanes = store.reviewOpen && store.review !== null ? 1 : 0
  check('setting only the flag would render nothing (the old bug)', brokenPanes === 0)
}

console.log('\n13. the inlined panel state matches the tested module')
{
  const differences = compareStateImplementations()
  check('every state function agrees between client.js and state.js', differences.length === 0, differences.join('; '))
  const source = readFileSync(join(pluginDir, 'lib', 'client.js'), 'utf8')
  check('the browser half requires nothing but the platform table', /require\('react'\)/u.test(source) && !/require\('\./u.test(source))
}

console.log('\n14. clearing during a review cancels it and produces no note')
{
  // The review is a long model call; "clear" during it must stop the pass rather
  // than let a note land for a lecture the person just discarded.
  let releaseReview
  const held = new Promise((resolve) => {
    releaseReview = resolve
  })
  const ctx = buildContext({
    sentences: ['A sentence worth a note.'],
    translations: ['一句值得记下来的话。'],
    review: '## 一、课堂主线\n这份笔记不该出现',
  })
  // Hold the review call open so the clear lands while it is genuinely in flight.
  const llm = ctx.llm.service
  const originalStream = llm.stream
  llm.stream = (options) => {
    if (String(options.system).includes('逻辑链')) {
      ctx.llm.seen.push({ role: 'review', system: options.system, user: options.messages[0].content[0].text })
      return (async function* () {
        await held
        yield { type: 'text-delta', index: 0, text: '## 一、课堂主线\n这份笔记不该出现' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    }
    return originalStream.call(llm, options)
  }

  apply(ctx, { statusMinMs: 0 })
  const lecture = ctx.provided.get('lectureCopilot')
  await call(ctx, '/lecture-copilot/start', 'POST')
  await call(ctx, '/lecture-copilot/audio', 'POST', silentWave(3))
  await call(ctx, '/lecture-copilot/stop', 'POST')

  await new Promise((resolve) => setTimeout(resolve, 40))
  check('the review is in flight', lecture.reviewing === true, `reviewing=${String(lecture.reviewing)}`)
  const pending = await call(ctx, '/lecture-copilot/state', 'GET')
  check('the state reports the pass as pending', pending.json.state.reviewPending === true)
  check('no note exists yet', pending.json.state.hasReview === false)

  const cleared = await call(ctx, '/lecture-copilot/clear', 'POST')
  check('clear answers 200', cleared.status === 200)
  check('clear reports that it interrupted the review', cleared.json.cancelledReview === true, JSON.stringify(cleared.json))
  check('the session is emptied', lecture.view(0).total === 0)

  // Let the held model call finish: its output must be discarded, not stored.
  releaseReview()
  await new Promise((resolve) => setTimeout(resolve, 60))
  check('the aborted pass stored no note', lecture.review === undefined, JSON.stringify(lecture.review))
  check('no review error is reported for a deliberate cancel', lecture.reviewError === undefined)
  const after = await call(ctx, '/lecture-copilot/state', 'GET')
  check('the panel sees no note after the cancel', after.json.state.hasReview === false)
  check('the panel is no longer pending', after.json.state.reviewPending === false)
}

console.log('\n15. each task picks its own model and reasoning level')
{
  const ctx = buildContext({
    sentences: ['Consider f of x.'],
    translations: ['考虑 f(x)。'],
    review: '## 一、课堂主线\n笔记',
  })
  apply(ctx, { statusMinMs: 0, provider: 'shared', model: 'shared-model' })

  const selected = await call(ctx, '/lecture-copilot/select', 'POST', Buffer.from(JSON.stringify({
    task: 'review',
    provider: 'deepseek-official',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  })))
  check('select answers 200', selected.status === 200, JSON.stringify(selected.json))
  check('the review route changed', selected.json.current.review.model === 'deepseek-reasoner', JSON.stringify(selected.json.current))
  check('the recognition route is untouched', selected.json.current.recognition.model === 'shared-model', JSON.stringify(selected.json.current))
  check('the reasoning level is kept', selected.json.current.review.reasoningEffort === 'high')

  const bad = await call(ctx, '/lecture-copilot/select', 'POST', Buffer.from(JSON.stringify({ task: 'nope' })))
  check('an unknown task is rejected', bad.status === 400)

  // Both routes must actually reach the model calls they belong to.
  await call(ctx, '/lecture-copilot/start', 'POST')
  await call(ctx, '/lecture-copilot/audio', 'POST', silentWave(3))
  await new Promise((resolve) => setTimeout(resolve, 40))
  await call(ctx, '/lecture-copilot/stop', 'POST')
  await new Promise((resolve) => setTimeout(resolve, 60))

  const translation = ctx.llm.seen.find((entry) => entry.role === 'translation')
  const review = ctx.llm.seen.find((entry) => entry.role === 'review')
  check('translation uses the recognition route', translation?.model === 'shared-model', JSON.stringify(translation?.model))
  check('review uses its own route', review?.model === 'deepseek-reasoner', JSON.stringify(review?.model))
  check('review carries its reasoning level', review?.reasoningEffort === 'high', JSON.stringify(review?.reasoningEffort))
  check('translation carries no reasoning level', translation?.reasoningEffort === undefined, JSON.stringify(translation?.reasoningEffort))

  // An empty pick falls back to the deployment default.
  await call(ctx, '/lecture-copilot/select', 'POST', Buffer.from(JSON.stringify({ task: 'review', provider: '', model: '' })))
  const health = await call(ctx, '/lecture-copilot/health', 'GET')
  check('clearing the pick restores the shared route', health.json.models.review.model === 'shared-model', JSON.stringify(health.json.models))
}

console.log('\n16. the model catalog and the route picker agree')
{
  const ctx = buildContext({ sentences: ['x'], translations: ['y'] })
  apply(ctx, undefined)
  const catalog = await call(ctx, '/lecture-copilot/models', 'GET')
  check('the catalog answers 200', catalog.status === 200, JSON.stringify(catalog.json).slice(0, 160))
  check('it lists the provider', catalog.json.providers?.[0]?.id === 'deepseek-official', JSON.stringify(catalog.json.providers?.map((p) => p.id)))
  const models = catalog.json.providers?.[0]?.models ?? []
  check('it lists the models', models.length === 2, JSON.stringify(models.map((m) => m.id)))
  check('reasoning levels ride along', (models.find((m) => m.id === 'reasoner')?.efforts ?? []).length === 2, JSON.stringify(models))

  const { routeOptions, resetStore } = loadStateModule()
  resetStore()
  const recognition = routeOptions(catalog.json, 'recognition', catalog.json.compositionDefault)
  check('the recognition picker offers every model', recognition.options.length === 2, String(recognition.options.length))
  check('it shows the default option label', recognition.fallbackLabel.includes('deepseek-official'), recognition.fallbackLabel)
  check('a model without reasoning levels shows none', recognition.efforts.length === 0, JSON.stringify(recognition.efforts))

  const review = routeOptions(
    { ...catalog.json, current: { review: { provider: 'deepseek-official', model: 'reasoner', reasoningEffort: 'high' } } },
    'review',
    null,
  )
  check('the review picker selects the chosen model', review.selectedKey.endsWith('reasoner'), review.selectedKey)
  check('it offers that model\'s reasoning levels', review.efforts.length === 2, JSON.stringify(review.efforts))
  check('it shows the chosen level', review.effort === 'high')
}

console.log('\n17. course context and glossary reach both prompts')
{
  // The recognizer is a fixed local model; the only place an accent-mangled term
  // can be resolved is downstream, and only if the prompts say what the course
  // is about. This asserts that plumbing end to end.
  const ctx = buildContext({
    sentences: ['The eigenvalue of the matrix is two.'],
    translations: ['矩阵的特征值是 2。'],
    review: '## 一、课堂主线\n讲了特征值',
  })
  apply(ctx, {
    statusMinMs: 0,
    context: '线性代数，全英文授课，教师为中文母语',
    glossary: ['eigenvalue', 'matrix', 'gradient descent'],
  })
  await call(ctx, '/lecture-copilot/start', 'POST')
  await call(ctx, '/lecture-copilot/audio', 'POST', silentWave(3))
  await new Promise((resolve) => setTimeout(resolve, 40))
  await call(ctx, '/lecture-copilot/stop', 'POST')
  await new Promise((resolve) => setTimeout(resolve, 60))

  const translation = ctx.llm.seen.find((entry) => entry.role === 'translation')
  const review = ctx.llm.seen.find((entry) => entry.role === 'review')
  check('the translation prompt carries the course context', String(translation?.user ?? '').includes('线性代数'), String(translation?.user ?? '').slice(0, 60))
  check('the translation prompt carries the glossary', String(translation?.user ?? '').includes('gradient descent'))
  check('the translation prompt still carries the segment', String(translation?.user ?? '').includes('eigenvalue of the matrix'))
  check('the review prompt carries the course context', String(review?.user ?? '').includes('线性代数'))
  check('the review prompt carries the glossary', String(review?.user ?? '').includes('eigenvalue'))
  check('the story still names the accent failure modes', String(translation?.system ?? '').includes('two eggs'))

  // With no context configured the prompts stay clean rather than gaining an
  // empty "本次课程背景：" header.
  const bare = buildContext({ sentences: ['x'], translations: ['y'] })
  apply(bare, { statusMinMs: 0 })
  await call(bare, '/lecture-copilot/start', 'POST')
  await call(bare, '/lecture-copilot/audio', 'POST', silentWave(3))
  await new Promise((resolve) => setTimeout(resolve, 40))
  const bareCall = bare.llm.seen.find((entry) => entry.role === 'translation')
  check('an empty context adds no header', !String(bareCall?.user ?? '').includes('本次课程背景'), String(bareCall?.user ?? '').slice(0, 40))
}

/**
 * A stand-in for the OneNote bridge.
 *
 * The route logic is what these tests exercise, so the fake records every call
 * and can be told to fail. It has no delete operation at all, mirroring the
 * shipped bridge: a test cannot accidentally prove a destructive behaviour works,
 * because the code under test cannot reach one.
 *
 * @param options - `notebooks` for the tree, `available` to simulate no OneNote.
 * @returns the fake bridge plus its call log.
 */
function onenoteStub(options = {}) {
  const calls = []
  const available = options.available !== false
  const notebooks = options.notebooks ?? [
    {
      id: 'nb-1',
      name: 'JNU',
      sections: [
        { id: 'sec-1', name: 'Adv. Maths 1', pages: [{ id: 'pg-1', name: '极限与导数' }, { id: 'pg-2', name: '10月6日' }] },
        { id: 'sec-2', name: 'Temp', pages: [] },
      ],
    },
    { id: 'nb-2', name: '光毅 的笔记本', sections: [{ id: 'sec-3', name: 'ENG', pages: [{ id: 'pg-3', name: 'Word List' }] }] },
  ]
  return {
    calls,
    // The real helpers, not reimplementations: matching and flattening are
    // production logic, and a copy here could pass while the shipped one broke.
    flatten: onenoteBridge.flatten,
    matchByName: onenoteBridge.matchByName,
    list: async () => {
      calls.push(['list'])
      return available ? { ok: true, notebooks } : { ok: false, error: 'OneNote 不可用' }
    },
    create: async (request) => {
      calls.push(['create', request])
      return { ok: true, pageId: 'pg-new', pageName: request.title, url: 'onenote:test' }
    },
    append: async (request) => {
      calls.push(['append', request])
      return { ok: true, pageId: request.pageId, pageName: '极限与导数', url: 'onenote:test#append', mode: 'append' }
    },
  }
}

/** A scratch directory so the destination store never touches the real home. */
async function scratchHome(label) {
  const dir = await mkdtemp(join(tmpdir(), `lcp-${label}-`))
  process.env.DSH_HOME = dir
  return dir
}

console.log('\n18. exporting the note to OneNote')
{
  const home = await scratchHome('onenote')
  const fake = onenoteStub()
  const ctx = buildContext({ sentences: ['x'], translations: ['y'], review: '## 一、课堂主线\n讲了极限与导数', onenote: fake })
  apply(ctx, { statusMinMs: 0, context: '高等数学，全英文授课' })
  await call(ctx, '/lecture-copilot/start', 'POST')
  await call(ctx, '/lecture-copilot/audio', 'POST', silentWave(3))
  await new Promise((resolve) => setTimeout(resolve, 40))
  await call(ctx, '/lecture-copilot/stop', 'POST')
  await new Promise((resolve) => setTimeout(resolve, 80))

  const tree = await call(ctx, '/lecture-copilot/onenote', 'GET')
  // The picker lists are sorted for display, so membership is asserted rather
  // than position — the order is the locale's business, not this test's.
  check(
    'the picker offers the live notebooks',
    tree.json.available === true && (tree.json.notebooks ?? []).includes('JNU'),
    JSON.stringify(tree.json.notebooks),
  )
  check(
    'the picker offers the live pages with their notebook',
    (tree.json.pages ?? []).some((row) => row.notebook === 'JNU' && row.name === '极限与导数'),
    JSON.stringify(tree.json.pages),
  )
  check('nothing is remembered before the first export', (tree.json.rememberedNotebooks ?? []).length === 0 && (tree.json.rememberedPages ?? []).length === 0)

  console.log('   a. an unknown notebook is refused without writing')
  // Reading the tree is expected; the thing that must never happen is a write.
  const writes = () => fake.calls.filter((entry) => entry[0] === 'append' || entry[0] === 'create')
  const before = writes().length
  const missingNotebook = await call(ctx, '/lecture-copilot/onenote/export', 'POST', { notebook: '根本没有这个本子', page: '极限与导数' })
  check('an unknown notebook reports a missing notebook', missingNotebook.json.ok === false && missingNotebook.json.error.includes('笔记本不存在'), JSON.stringify(missingNotebook.json))
  check('an unknown notebook writes nothing', writes().length === before, JSON.stringify(fake.calls))

  console.log('   b. an unknown page is refused without writing')
  const missingPage = await call(ctx, '/lecture-copilot/onenote/export', 'POST', { notebook: 'JNU', page: '这一页不存在' })
  check('an unknown page reports a missing page', missingPage.json.ok === false && missingPage.json.error.includes('没有这个页面'), JSON.stringify(missingPage.json))
  check('an unknown page writes nothing', writes().length === before, JSON.stringify(fake.calls))

  console.log('   c. a matching notebook and page appends')
  const exported = await call(ctx, '/lecture-copilot/onenote/export', 'POST', { notebook: 'jnu', page: '极限' })
  check('the export succeeds', exported.json.ok === true, JSON.stringify(exported.json))
  check('it appends rather than replaces', exported.json.mode === 'append', String(exported.json.mode))
  const appended = fake.calls.filter((entry) => entry[0] === 'append').pop()
  check('it targets the matched page', appended?.[1].pageId === 'pg-1', JSON.stringify(appended?.[1]?.pageId))
  check('the appended body is OneNote XML carrying the review', String(appended?.[1].body).includes('one:Outline') && String(appended?.[1].body).includes('极限'), String(appended?.[1].body).slice(0, 80))
  check('the addition is stamped for later reading', String(appended?.[1].stamp).includes('课堂同传'), String(appended?.[1].stamp))
  check('it never replaces or deletes anything', !fake.calls.some((entry) => entry[0] === 'update' || entry[0] === 'delete'))
  check('the successful destination is remembered', exported.json.remembered.notebooks.includes('JNU'), JSON.stringify(exported.json.remembered))

  console.log('   d. the remembered destination comes back as a dropdown option')
  const after = await call(ctx, '/lecture-copilot/onenote', 'GET')
  check('the notebook is remembered', after.json.rememberedNotebooks.includes('JNU'), JSON.stringify(after.json.rememberedNotebooks))
  check('the page is remembered with its notebook', after.json.rememberedPages.some((row) => row.notebook === 'JNU' && row.page === '极限与导数'), JSON.stringify(after.json.rememberedPages))
  const onDisk = JSON.parse(await readFile(join(home, 'storages', 'lecture-copilot', 'onenote-destinations.json'), 'utf8'))
  check('the memory survives on disk', onDisk.pages.some((row) => row.page === '极限与导数'), JSON.stringify(onDisk).slice(0, 120))

  console.log('   e. a remembered name that no longer exists is dropped')
  const narrowed = onenoteStub({ notebooks: [{ id: 'nb-9', name: '别的本子', sections: [{ id: 'sec-9', name: 'S', pages: [] }] }] })
  const second = buildContext({ sentences: ['x'], translations: ['y'], onenote: narrowed })
  apply(second, { statusMinMs: 0 })
  const narrowedTree = await call(second, '/lecture-copilot/onenote', 'GET')
  check('the vanished notebook is no longer offered', !narrowedTree.json.rememberedNotebooks.includes('JNU'), JSON.stringify(narrowedTree.json.rememberedNotebooks))

  console.log('   f. the plus button creates a page whose title comes from the note')
  const created = await call(ctx, '/lecture-copilot/onenote/new-page', 'POST', { notebook: 'JNU', section: 'Adv. Maths 1' })
  check('the new page is created', created.json.ok === true && created.json.mode === 'create', JSON.stringify(created.json))
  const createCall = fake.calls.filter((entry) => entry[0] === 'create').pop()
  check('it lands in the section that was chosen', createCall?.[1].sectionId === 'sec-1', String(createCall?.[1].sectionId))
  // The stub model answers every call with `y`, so this proves the title came from
  // the model rather than from the date-based fallback.
  check('the title comes from the model, not the date', createCall?.[1].title === 'y', String(createCall?.[1].title))
  check('the reply says the model named it', created.json.namedByModel === true, JSON.stringify(created.json.namedByModel))
  check('the reply reports the title it used', created.json.title === 'y', String(created.json.title))
  check('the body is the review', String(createCall?.[1].body).includes('极限'), String(createCall?.[1].body).slice(0, 60))

  console.log('   f2. an unknown section is refused without writing')
  const writesBefore = fake.calls.filter((entry) => entry[0] === 'create').length
  const badSection = await call(ctx, '/lecture-copilot/onenote/new-page', 'POST', { notebook: 'JNU', section: '根本没有这个分区' })
  check('the missing section is reported', badSection.json.ok === false && badSection.json.error.includes('分区不存在'), JSON.stringify(badSection.json))
  check('no page was created', fake.calls.filter((entry) => entry[0] === 'create').length === writesBefore, JSON.stringify(badSection.json))
  const noSection = await call(ctx, '/lecture-copilot/onenote/new-page', 'POST', { notebook: 'JNU' })
  check('an omitted section asks for one instead of guessing', noSection.json.ok === false && noSection.json.error.includes('请先选择分区'), JSON.stringify(noSection.json))
  const wrongNotebookSection = await call(ctx, '/lecture-copilot/onenote/new-page', 'POST', { notebook: '光毅 的笔记本', section: 'Adv. Maths 1' })
  check('a section from another notebook is refused', wrongNotebookSection.json.ok === false, JSON.stringify(wrongNotebookSection.json))

  console.log('   f3. the title route names a review')
  const titleReply = await call(ctx, '/lecture-copilot/onenote/title', 'POST', {})
  check('the title route answers', titleReply.json.ok === true, JSON.stringify(titleReply.json))
  check('it returns the model title', titleReply.json.generated === true && titleReply.json.title === 'y', JSON.stringify(titleReply.json))

  console.log('   g. the plus button refuses an unknown notebook')
  const newMissing = await call(ctx, '/lecture-copilot/onenote/new-page', 'POST', { notebook: '不存在本子', section: 'Adv. Maths 1' })
  check('an unknown notebook is reported', newMissing.json.ok === false && newMissing.json.error.includes('笔记本不存在'), JSON.stringify(newMissing.json))

  console.log('   h. with no note ready, nothing is written')
  const empty = buildContext({ sentences: ['x'], translations: ['y'], onenote: fake })
  apply(empty, { statusMinMs: 0 })
  const callCount = fake.calls.length
  const noNote = await call(empty, '/lecture-copilot/onenote/export', 'POST', { notebook: 'JNU', page: '极限与导数' })
  check('an export without a note is refused', noNote.json.ok === false, JSON.stringify(noNote.json))
  check('and it writes nothing', fake.calls.length === callCount)

  console.log('   i. without OneNote the panel is told, not broken')
  const unavailable = buildContext({ sentences: ['x'], translations: ['y'], onenote: onenoteStub({ available: false }) })
  apply(unavailable, { statusMinMs: 0 })
  const noOneNote = await call(unavailable, '/lecture-copilot/onenote', 'GET')
  check('the route still answers 200', noOneNote.status === 200, String(noOneNote.status))
  check('it reports unavailability instead of failing', noOneNote.json.available === false && typeof noOneNote.json.reason === 'string', JSON.stringify(noOneNote.json))

  console.log('   j. the section catalogue follows the notebook')
  const catalogue = await call(ctx, '/lecture-copilot/onenote', 'GET')
  check('sections are listed', Array.isArray(catalogue.json.sections) && catalogue.json.sections.length > 0, JSON.stringify(catalogue.json.sections))
  check('each section carries its notebook', catalogue.json.sections.every((row) => typeof row.notebook === 'string' && row.notebook.length > 0), JSON.stringify(catalogue.json.sections))
  check('a section belongs to JNU', catalogue.json.sections.some((row) => row.notebook === 'JNU' && row.name === 'Adv. Maths 1'), JSON.stringify(catalogue.json.sections))
}

console.log('\n19. a generated page title is cleaned before it becomes a page name')
{
  // These rules are what keep a model reply from becoming a page name with quotes,
  // a label, or a trailing full stop in it. They are pure, so they are worth
  // pinning exactly.
  const cases = [
    ['定积分', '定积分', 'a plain topic is kept as-is'],
    ['标题：定积分的计算', '定积分的计算', 'a leading label is removed'],
    ['「定积分」', '定积分', 'corner brackets are removed'],
    ['**定积分**', '定积分', 'markdown emphasis is removed'],
    ['定积分。', '定积分', 'a trailing full stop is removed'],
    ['定积分\n\n这门课还讲了别的', '定积分', 'only the first line is used'],
    ['  \n 定积分 \n ', '定积分', 'surrounding whitespace is removed'],
    ['定积分/极限', '定积分极限', 'characters OneNote forbids are dropped'],
    ['定积分: 基础', '定积分 基础', 'a colon is dropped'],
    ['', undefined, 'an empty reply yields nothing'],
    ['   ', undefined, 'a blank reply yields nothing'],
    ['标题：', undefined, 'a label with no topic yields nothing'],
    ['一'.repeat(40), '一'.repeat(24), 'a long title is capped'],
  ]
  for (const [reply, expected, label] of cases) {
    const actual = normalizeTitle(reply)
    check(label, actual === expected, `${JSON.stringify(reply)} -> ${JSON.stringify(actual)}`)
  }
  check('a non-string reply yields nothing', normalizeTitle(undefined) === undefined && normalizeTitle(42) === undefined)
  // A page name must survive OneNote's own constraints.
  const hostile = normalizeTitle('标题：「定积分/极限 * 应用题？」')
  check('a hostile reply becomes a legal page name', /^[^\\/?*[\]:]+$/u.test(hostile ?? ''), String(hostile))
}

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
