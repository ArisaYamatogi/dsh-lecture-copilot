/**
 * Lecture Copilot — recognition transport and its credential.
 *
 * Recognition has two possible homes: the Host's own `speechToText` service, or
 * one OpenAI-compatible `/audio/transcriptions` endpoint registered in the
 * profile's `asrProviders`. This module owns the HTTP half — endpoint, model,
 * language — and the API key, because a remote ASR service needs one while the
 * key must never reach the panel, the logs, or any address other than the one it
 * was configured for.
 *
 * Two ways to supply a key, in this order:
 *
 *   • `apiKey` — the literal value written in the engine entry (the YAML config);
 *   • `apiKeyEnv` — the name of an environment variable read at call time.
 *
 * The literal value wins because a person who types a key expects that exact key
 * to be used, even when the named variable also exists. A plaintext key in a
 * profile is convenient but sits on disk; an environment variable keeps it out of
 * the file. Both exist because a local service usually needs no key at all while
 * a cloud recognizer does.
 *
 * @module dsh-lecture-copilot/asr
 */

/** Header OpenAI-compatible services expect for a bearer credential. */
const AUTH_HEADER = 'authorization'

/** Statuses that mean "the credential was refused", not "the audio was bad". */
const AUTH_FAILURE_STATUSES = new Set([401, 403])

/**
 * Resolve the credential for one engine.
 *
 * Empty and whitespace-only values count as absent, so an unfilled template line
 * (`apiKey: ""`) behaves exactly like an omitted one instead of sending an empty
 * bearer token.
 *
 * @param engine - one normalized engine entry, or `undefined`.
 * @returns `{ key, source, missingEnv? }`; `source` is `config`, `env`, or `none`.
 */
export function resolveApiKey(engine) {
  const literal = typeof engine?.apiKey === 'string' ? engine.apiKey.trim() : ''
  if (literal.length > 0) return { key: literal, source: 'config' }
  const name = typeof engine?.apiKeyEnv === 'string' ? engine.apiKeyEnv.trim() : ''
  if (name.length === 0) return { key: undefined, source: 'none' }
  const value = process.env[name]
  if (typeof value === 'string' && value.trim().length > 0) return { key: value.trim(), source: 'env' }
  return { key: undefined, source: 'none', missingEnv: name }
}

/**
 * Public description of one engine's credential state.
 *
 * The panel must be able to tell "this engine has no key configured" from "this
 * engine is ready", and it must never receive the key itself; this returns only
 * the source label.
 *
 * @param engine - one engine entry.
 * @returns `'config'`, `'env'`, or `'none'`.
 */
export function authSummary(engine) {
  return resolveApiKey(engine).source
}

/**
 * Explain a refused credential without echoing it.
 *
 * A 401 from a remote ASR is almost always a configuration problem, and the
 * person is looking at the panel when it happens: name the missing piece instead
 * of forwarding a bare status. The key itself is never part of the message.
 *
 * @param resolution - the credential resolution for this engine.
 * @returns the parenthetical hint to append, or an empty string.
 */
function authHint(resolution) {
  if (resolution.source === 'none') {
    return resolution.missingEnv === undefined
      ? '（该引擎未配置 API 密钥：在 asrProviders 里填 apiKey，或设 apiKeyEnv 指向环境变量）'
      : `（环境变量 ${resolution.missingEnv} 未设置或为空）`
  }
  return '（API 密钥被拒绝：请确认 asrProviders 里的密钥有效且未过期）'
}

/**
 * Transcribe one WAV chunk through an OpenAI-compatible endpoint.
 *
 * One `fetch` to `<baseURL>/audio/transcriptions`: the WAV bytes as a multipart
 * file, the configured model id, and the language omitted when it is `auto` so
 * the service may guess. The plugin opens no persistent connection and keeps no
 * key after the call.
 *
 * Every failure is thrown with the engine named and, for a refused credential,
 * with the configuration hint — the panel shows the message, and "engine 8022
 * returned HTTP 500" is actionable while "transcription failed" is not.
 *
 * @param engine - one normalized engine entry (must carry `baseURL` and `model`).
 * @param audio - canonical 16 kHz mono PCM16 WAV bytes.
 * @param options - `language` (recognizer hint) and `signal` (cancellation).
 * @returns `{ text, language? }`.
 */
export async function transcribe(engine, audio, options = {}) {
  const form = new FormData()
  form.append('file', new Blob([audio], { type: 'audio/wav' }), 'segment.wav')
  form.append('model', engine.model)
  const language = typeof options.language === 'string' && options.language.length > 0 ? options.language : 'auto'
  if (language !== 'auto') form.append('language', language)
  const resolution = resolveApiKey(engine)
  const headers = resolution.key === undefined ? {} : { [AUTH_HEADER]: `Bearer ${resolution.key}` }
  let response
  try {
    response = await fetch(`${engine.baseURL}/audio/transcriptions`, {
      method: 'POST',
      body: form,
      headers,
      signal: options.signal,
    })
  } catch (error) {
    throw new Error(`识别引擎 ${engine.label} 连接失败：${String(error?.message ?? error)}`)
  }
  const body = await response.text()
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    const detail = String(payload?.detail ?? payload?.error?.message ?? payload?.error ?? body.slice(0, 200)).trim()
    const hint = AUTH_FAILURE_STATUSES.has(response.status) ? authHint(resolution) : ''
    throw new Error(`识别引擎 ${engine.label} 返回 HTTP ${String(response.status)}${detail.length === 0 ? '' : `：${detail}`}${hint}`)
  }
  if (payload === undefined) throw new Error(`识别引擎 ${engine.label} 返回的不是 JSON`)
  return {
    text: String(payload.text ?? '').trim(),
    ...typeof payload.language === 'string' ? { language: payload.language } : {},
  }
}
