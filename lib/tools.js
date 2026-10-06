/**
 * The two model-facing tools Lecture Copilot contributes.
 *
 * They exist so the lecture a student just recorded becomes conversation
 * material: the Agent can read the bilingual transcript, and it can pull (or
 * freshly regenerate) the structured review without asking the person to
 * paste anything.
 */

/** Bound on transcript characters returned in one tool call. */
const TRANSCRIPT_BUDGET = 60000

/**
 * Render one segment for the model as a tagged line block.
 * @param segment - stored segment.
 * @param index - zero-based position.
 * @returns the rendered block.
 */
function renderSegment(segment, index) {
  const translation = segment.translation === undefined
    ? '（翻译未完成）'
    : segment.translation
  return `【第 ${index + 1} 段｜${segment.at}】\nEN: ${segment.text}\nZH: ${translation}`
}

/**
 * Build the transcript view, newest-end truncation included.
 * @param lecture - the live lecture session.
 * @returns the text plus how many leading segments were dropped.
 */
function transcriptView(lecture) {
  const rendered = lecture.segments.map(renderSegment)
  let joined = rendered.join('\n\n')
  let dropped = 0
  while (joined.length > TRANSCRIPT_BUDGET && rendered.length - dropped > 1) {
    dropped += 1
    joined = rendered.slice(dropped).join('\n\n')
  }
  return { text: joined, dropped }
}

/**
 * Register the lecture tools on the tool registry.
 * @param ctx - Host plugin context.
 * @param lecture - the live lecture session.
 * @returns the disposer unregistering both tools.
 */
/**
 * Build the two tool definitions without registering them, so their schemas can
 * be validated offline against the registry's accepted subset.
 * @param lecture - the live lecture session.
 * @returns the definitions, in registration order.
 */
export function createToolDefinitions(lecture) {
  return [
    {
      name: 'lecture_transcript',
      description: [
        '读取 Lecture Copilot 最近一次课堂录音的双语转写。',
        '当用户提到“刚才那节课”“录音”“板书没抄完”“老师讲的推导”时使用它，',
        '拿到英文原文与中文翻译，再据此回答问题。转写按时间分段，可能含语音识别错误。',
      ].join(''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          offset: {
            type: 'integer',
            description: '从第几段开始返回（从 0 计数），省略则返回最近的全部内容。',
          },
          limit: {
            type: 'integer',
            description: '最多返回多少段，省略则按长度上限自动截断。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['active', 'total', 'text', 'note'],
          properties: {
            active: { type: 'boolean', description: '是否正在录音。' },
            total: { type: 'integer', description: '已转写的总段数。' },
            text: { type: 'string', description: '双语转写正文。' },
            note: { type: 'string', description: '截断或空内容的说明。' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.text.length === 0 ? value.note : `${value.text}\n\n（${value.note}）` }],
      },
      execute(args) {
        if (lecture.segments.length === 0) {
          return Promise.resolve({
            active: lecture.active,
            total: 0,
            text: '',
            note: '还没有任何录音内容。请用户点击 Harness 界面右下角的麦克风按钮开始听课录音。',
          })
        }
        const start = Number.isInteger(args?.offset) && args.offset > 0 ? Math.min(args.offset, lecture.segments.length) : 0
        const view = transcriptView({ ...lecture, segments: lecture.segments.slice(start) })
        const limited = Number.isInteger(args?.limit) && args.limit > 0
          ? view.text.split('\n\n').slice(0, args.limit).join('\n\n')
          : view.text
        return Promise.resolve({
          active: lecture.active,
          total: lecture.segments.length,
          text: limited,
          note: `共 ${lecture.segments.length} 段，本次返回第 ${start + 1} 段起${start === 0 ? '的最近内容' : ''}。`,
        })
      },
      presentCall: () => ({ card: 'generic', title: '读取课堂转写', kind: 'read' }),
    },

    {
      name: 'lecture_review',
      description: [
        '获取 Lecture Copilot 为最近一次课堂自动整理的复习笔记（含课堂主线、逻辑链、知识点、公式速查、术语表）。',
        '用户要求“复习”“总结这节课”“整理知识点”“再讲一遍推导”时优先调用它；',
        '若笔记不存在或用户希望换个角度重讲，把 regenerate 设为 true 重新生成。',
      ].join(''),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          regenerate: {
            type: 'boolean',
            description: '为 true 时忽略已有笔记，基于完整转写重新生成一份。',
          },
          subject: {
            type: 'string',
            description: '课程名（例如“高等数学”“数据结构”），用于让笔记贴合课程语境。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'review', 'message'],
          properties: {
            status: { type: 'string', description: 'ready | generating | empty | failed。' },
            review: { type: 'string', description: 'Markdown 复习笔记，未就绪时为空字符串。' },
            message: { type: 'string', description: '给模型的状态说明。' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.status === 'ready' ? value.review : value.message }],
      },
      async execute(args, exec) {
        const regenerate = args?.regenerate === true
        if (!regenerate && lecture.review !== undefined) {
          return {
            status: 'ready',
            review: lecture.review,
            message: `笔记已就绪（${lecture.review.length} 字）。`,
          }
        }
        if (lecture.segments.length === 0) {
          return {
            status: 'empty',
            review: '',
            message: '还没有录音内容：请用户先点击麦克风按钮听完一节课，停止录音后会自动生成笔记。',
          }
        }
        const result = await lecture.consolidate({ subject: args?.subject, signal: exec.signal })
        if (result.cancelled === true) {
          return {
            status: 'empty',
            review: '',
            message: '这次整理已被取消（用户清空了课堂），没有生成笔记。',
          }
        }
        if (result.review === undefined) {
          return {
            status: result.pending ? 'generating' : 'failed',
            review: '',
            message: result.pending
              ? '笔记正在生成中，请稍等片刻后再次调用本工具。'
              : `笔记生成失败：${result.error ?? '模型未返回内容'}。可以再试一次。`,
          }
        }
        return { status: 'ready', review: result.review, message: `已生成 ${result.review.length} 字复习笔记。` }
      },
      presentCall: () => ({ card: 'generic', title: '取复习笔记', kind: 'other' }),
    },
  ]
}

/**
 * Register the lecture tools on the tool registry.
 * @param ctx - Host plugin context.
 * @param lecture - the live lecture session.
 * @returns the disposer unregistering both tools.
 */
export function registerTools(ctx, lecture) {
  const tools = ctx.get('tools')
  const disposers = createToolDefinitions(lecture).map((definition) => tools.register(definition))
  return () => {
    for (const dispose of disposers) dispose()
  }
}
