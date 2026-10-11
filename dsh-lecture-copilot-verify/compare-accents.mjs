/**
 * Measure the local recognizer on the accented lecture corpus.
 *
 * Runs the real `speechToText` service and the real SenseVoice provider out of
 * the installed DSH runtime — no HTTP, no plugin — so a language-hint change can
 * be compared across every voice without restarting the Harness.
 *
 * Run with the launcher's Electron in Node mode:
 *   set ELECTRON_RUN_AS_NODE=1
 *   "…\DeepSeek Harness.exe" compare-accents.mjs <corpusDir>
 */

import { spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

const APP = 'D:/deepseekHarness/resources/app.asar/dsh/node_modules/@deepseek-ai'
const corpusDir = process.argv[2]
if (corpusDir === undefined) {
  console.log('usage: compare-accents.mjs <corpusDir>')
  process.exit(1)
}

const { Context } = await import(`file:///${APP}/cordis/lib/index.js`)
const { default: SpeechToText } = await import(`file:///${APP}/dsh-experimental-speech-to-text/lib/index.js`)
const sensevoice = await import(`file:///${APP}/dsh-experimental-speech-to-text-sensevoice/lib/index.js`)

// A real Cordis context, so the providers get the `ctx.reflect`/`ctx.fiber` they
// read during construction. Nothing else in the tree is mounted.
const ctx = Reflect.construct(Context, [{}])
// Keep the tree quiet except for failures: preparation errors explain a stall.
ctx.logger.exporter = undefined

/**
 * The smallest `subprocess` service the SenseVoice provider can drive.
 *
 * The shipped one is a whole plugin tree; the provider only needs `spawn` with
 * piped stdio, so this mounts that much and no more. Collect mode is not
 * implemented — the provider streams, and a request for readers fails loud
 * rather than silently returning nothing.
 */
const subprocess = {
  async resolveExecutable(command) {
    return command
  },
  async terminalEnvironment() {
    return { platform: 'windows' }
  },
  spawn(spec) {
    if (process.env.LCP_TRACE === '1') {
      console.log(`[spawn] ${spec.argv.map((part) => part.replaceAll('\\', '/').split('/').at(-1)).join(' ')}`)
    }
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd: spec.cwd,
      env: spec.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    if (process.env.LCP_TRACE === '1') {
      child.stderr.on('data', (chunk) => process.stderr.write(`[worker] ${String(chunk)}`))
      child.on('error', (error) => console.log(`[spawn error] ${error.message}`))
      child.on('exit', (code) => console.log(`[spawn exit] ${String(code)}`))
    }
    if (child.stdout === null || child.stderr === null) throw new Error('collect mode is not supported by this shim')
    // The provider pipes bytes through; PassThrough keeps the handle shape.
    for (const [source, target] of [[child.stdout, new PassThrough()], [child.stderr, new PassThrough()]]) {
      void source.pipe(target)
    }
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      control: undefined,
      collected: {},
      done: new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ exitCode: code, signal }))
      }),
      terminate: () => child.kill(),
      waitForExit: () => new Promise((resolve) => {
        if (child.exitCode !== null) {
          resolve(true)
          return
        }
        child.once('exit', () => resolve(true))
      }),
    }
  },
}
ctx.reflect.provide('subprocess', subprocess)

/**
 * Build the config shape these plugins read.
 *
 * The shipped loader hands every field through its schemastery field, so each
 * one has a `.get()`. Passing bare values makes `isAbsolute()` receive an object.
 */
function configOf(values) {
  const store = { ...values }
  return {
    ...Object.fromEntries(Object.entries(store).map(([key, value]) => [key, { get: () => value }])),
    get: (key) => store[key],
  }
}

const registry = new SpeechToText(ctx, configOf({ defaultProvider: 'sensevoice-local', language: 'auto' }))
// The installed model tree, so nothing is downloaded for this measurement.
// `apply` reads plain values: the shipped loader has already run them through
// the plugin's schemastery `Config`, which this harness deliberately bypasses.
const dataRoot = join(process.env.DSH_HOME, 'speech-to-text', 'sensevoice')
await sensevoice.apply(ctx, {
  dataRoot,
  providerId: 'sensevoice-local',
  precision: 'int8',
  language: 'auto',
  modelOrigins: ['https://huggingface.co', 'https://hf-mirror.com'],
  // The plugin's schemastery Config would supply these; this harness bypasses it,
  // and every deadline rejects an undefined timeout.
  modelProbeTimeoutMs: 3000,
  prepareTimeoutMs: 3600000,
  inferenceTimeoutMs: 120000,
  idleTimeoutMs: 300000,
})
const registered = registry.listProviders()
console.log(`providers: ${registered.map((entry) => entry.id).join(', ') || 'none'}`)
if (registered.length === 0) {
  console.log('the SenseVoice provider did not register')
  process.exit(1)
}

// The local provider refuses to transcribe until its model is loaded, exactly as
// it does in the Harness. Start preparation and wait for readiness.
registry.prepare('sensevoice-local')
const deadline = Date.now() + 180000
for (;;) {
  const preparation = registry.snapshot().providers[0]?.preparation
  // 'standby' loads the model lazily on the first transcription, exactly as the
  // panel sees it, so it is a valid starting point; only 'failed' is fatal.
  if (preparation?.phase === 'ready' || preparation?.phase === 'standby') break
  if (preparation?.phase === 'failed') {
    console.log(`preparation failed: ${JSON.stringify(preparation)}`)
    process.exit(1)
  }
  if (Date.now() > deadline) {
    console.log(`preparation did not finish: ${JSON.stringify(preparation)}`)
    process.exit(1)
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
}

// Wait for the model to come up before measuring anything.
const readiness = registry.snapshot()
const info = registered[0]
console.log(`provider: ${readiness.selection.providerId} (${info.name})`)
console.log(`languages: ${info.languages.join(', ')}`)
console.log(`preparation: ${readiness.providers[0]?.preparation?.phase ?? '?'}`)

const files = readdirSync(corpusDir).filter((name) => name.endsWith('.wav')).sort()
const languages = ['auto', 'en']

console.log(`\ncorpus: ${corpusDir}  (${String(files.length)} voices)\n`)
for (const file of files) {
  const audio = readFileSync(join(corpusDir, file))
  console.log(`== ${file.replace(/\.wav$/u, '')} ==`)
  for (const language of languages) {
    const started = Date.now()
    try {
      const spec = registry.resolve({ audio, language })
      const result = await registry.transcribe(spec, AbortSignal.timeout(180000))
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      console.log(`  [${language}] ${seconds}s  ${result.text.trim()}`)
    } catch (error) {
      console.log(`  [${language}] FAILED: ${error.message}`)
    }
  }
  console.log('')
}
