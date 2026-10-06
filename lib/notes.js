/**
 * Model calls owned by Lecture Copilot: one streaming text request, reused by
 * the live translation pass and the end-of-lecture review pass.
 *
 * The plugin never opens its own provider connection: it borrows the Host's
 * `llm` service and the deployment's default model selection, so credentials,
 * retry policy, and provider routing stay exactly where the composition put
 * them.
 */

/**
 * Resolve the model route for one task.
 *
 * Precedence, highest first: an explicit pick from the panel, the task's own
 * configuration fields, the shared configuration fields, the composition's
 * default selection, the shipped DeepSeek route. The two tasks resolve
 * independently, so a lecture can translate on a fast model and write its review
 * on a stronger one.
 *
 * @param ctx - Host plugin context.
 * @param config - resolved plugin configuration.
 * @param task - `'recognition'` (live translation) or `'review'`.
 * @param override - an explicit `{ provider, model, reasoningEffort }` pick.
 * @returns provider, model, and optional reasoning effort.
 */
export function resolveModel(ctx, config, task = 'recognition', override = undefined) {
  const selection = ctx.get('agentDefaultModel')?.currentSelection()
  const clean = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined)
  const taskKey = (name) => `${task}${name[0].toUpperCase()}${name.slice(1)}`
  const pick = (name) => clean(override?.[name]) ?? clean(config?.[taskKey(name)]) ?? clean(config?.[name])
  const provider = pick('provider') ?? selection?.provider ?? 'deepseek-official'
  const model = pick('model') ?? selection?.model ?? 'deepseek-flash'
  const reasoning = pick('reasoningEffort') ?? clean(selection?.reasoningEffort)
  return { provider, model, ...reasoning === undefined ? {} : { reasoningEffort: reasoning } }
}

/** Last model failure, so a caller can report why instead of waiting forever. */
let lastFailure

/**
 * Read and clear the most recent model failure.
 * @returns the last failure message, or `undefined`.
 */
export function takeModelFailure() {
  const failure = lastFailure
  lastFailure = undefined
  return failure
}

/**
 * Run one streaming text request to completion and return the concatenated
 * text. Progress is reported per delta so a caller can surface the review as
 * it is written.
 * @param ctx - Host plugin context.
 * @param options - model route, system instruction, user text, and controls.
 * @returns the full response text, or `undefined` when the call failed.
 */
export async function callText(ctx, options) {
  const llm = ctx.get('llm')
  if (llm === undefined) {
    lastFailure = 'no llm service in this composition'
    return undefined
  }
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = options.signal === undefined
    ? timeout
    : AbortSignal.any([options.signal, timeout])
  let text = ''
  try {
    const stream = llm.stream({
      provider: options.provider,
      model: options.model,
      ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
      system: options.system,
      messages: [{ role: 'user', content: [{ type: 'text', text: options.user }] }],
      ...options.temperature === undefined ? {} : { temperature: options.temperature },
      ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
      signal,
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        options.onDelta?.(text)
        continue
      }
      if (chunk.type !== 'finish') continue
      if (chunk.reason.kind === 'stop') return text
      if (chunk.reason.kind === 'aborted') {
        // A cancelled review is not a failure, and its partial text is not a
        // note: report the cancellation so the caller can discard it cleanly.
        lastFailure = options.signal?.aborted === true ? 'cancelled' : undefined
        return text.length === 0 ? undefined : text
      }
      throw new Error(chunk.reason.failure?.message ?? 'model call failed')
    }
    return text
  } catch (error) {
    if (options.signal?.aborted === true) {
      lastFailure = 'cancelled'
      return undefined
    }
    lastFailure = String(error?.message ?? error)
    ctx.logger?.warn?.(`lecture-copilot: model call failed: ${lastFailure}`)
    return undefined
  }
}

/**
 * Ask the model for a short topic title for one review.
 *
 * The title becomes the OneNote page name, so it has to read like a topic a
 * person would write in a notebook index — "定积分", not "课堂笔记 2026-10-06".
 * The model is asked for the topic alone and the reply is normalised hard,
 * because a page name is not a place for punctuation, quotes, or a preamble.
 *
 * @param ctx - Host plugin context.
 * @param options - prompt, model route, and sampling controls.
 * @param review - the finished review text.
 * @returns the title, or `undefined` when no model answered.
 */
/**
 * System prompt for naming a page.
 *
 * Deliberately separate from the review prompt: the review is a long structured
 * document, while this is a four-word answer, and mixing the two makes the model
 * narrate its reasoning into the title.
 */
const TITLE_SYSTEM = [
  '你为课堂复习笔记起一个极短的中文标题，用于 OneNote 页面名。',
  '',
  '规则：',
  '- 只输出标题本身，不要引号、不要标点、不要“标题：”之类的前缀、不要解释。',
  '- 标题必须概括笔记讲的主要内容，2 到 8 个汉字最佳，最多不超过 12 个字。',
  '- 用名词性短语，不要写成句子。例：「定积分的计算」而不是「这节课讲了定积分怎么算」。',
  '- 如果内容包含多个主题，取最主要的那一个。',
  '- 如果内容不足以判断主题，输出「课堂笔记」。',
].join('\n')

/**
 * Render the request that names one review.
 * @param review - the finished review.
 * @returns the request body.
 */
function titleRequest(review) {
  // Only the opening of a long review is needed to name it, and sending 30k
  // tokens to get four words back would be wasteful.
  const head = String(review).slice(0, 2000)
  return ['以下是课堂复习笔记的开头部分，请按规则给出标题：', '', head].join('\n')
}
export async function generateTitle(ctx, options, review) {
  const reply = await callText(ctx, {
    provider: options.provider,
    model: options.model,
    // Naming a page needs no reasoning, and the user is waiting on this click.
    reasoningEffort: 'off',
    system: TITLE_SYSTEM,
    user: titleRequest(review),
    temperature: 0,
    maxTokens: 64,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
  return normalizeTitle(reply)
}

/**
 * Reduce a model reply to a usable page name.
 *
 * Kept exported so the rules are testable without a model: a page name that
 * arrives wrapped in quotes, prefixed with "标题：", or carrying a trailing full
 * stop would otherwise become part of the note's identity in OneNote.
 *
 * @param reply - the raw model reply.
 * @returns the cleaned title, or `undefined` when nothing usable came back.
 */
export function normalizeTitle(reply) {
  if (typeof reply !== 'string') return undefined
  let text = reply.trim()
  if (text.length === 0) return undefined
  // Only the first line: models like to append an explanation.
  text = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0) ?? ''
  // A leading label is boilerplate, not part of the topic.
  text = text.replace(/^(标题|题目|主题|title)\s*[:：]\s*/iu, '')
  // Markdown emphasis and wrapping quotes would all end up in the page name.
  // Both CJK and Latin bracket styles are stripped: a model asked for a topic
  // often answers with 「」 or 《》 around it.
  text = text.replace(/^[#*\s"'“”‘’《》【】「」『』（）()]+/u, '').replace(/[#*\s"'“”‘’《》【】「」『』（）()]+$/u, '')
  // OneNote page names cannot contain these.
  text = text.replaceAll(/[\\/?*[\]:]/gu, '')
  text = text.replace(/[。．.,，；;、]+$/u, '').trim()
  if (text.length === 0) return undefined
  // Short enough to read in a notebook list; long enough to be a topic.
  return [...text].slice(0, 24).join('')
}

/**
 * Translate one transcribed segment into Simplified Chinese.
 * @param ctx - Host plugin context.
 * @param options - prompt, model route, and sampling controls.
 * @param text - the English segment.
 * @returns the translation, or `undefined` when no model answered.
 */
export async function translateSegment(ctx, options, text) {
  const translated = await callText(ctx, {
    provider: options.provider,
    model: options.model,
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
    system: options.system,
    user: text,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  })
  if (translated === undefined) return undefined
  const trimmed = translated.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Produce the end-of-lecture review from the whole transcript.
 * @param ctx - Host plugin context.
 * @param options - prompt, model route, budget, and cancellation signal.
 * @param onDelta - optional progress callback.
 * @returns the Markdown review, or `undefined` when no model answered.
 */
export async function generateReview(ctx, options, onDelta) {
  const review = await callText(ctx, {
    provider: options.provider,
    model: options.model,
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
    system: options.system,
    user: options.user,
    maxTokens: options.maxTokens,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    ...onDelta === undefined ? {} : { onDelta },
  })
  return review === undefined ? undefined : review.trim()
}
