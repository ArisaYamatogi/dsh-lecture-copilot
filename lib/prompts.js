/**
 * Prompts owned by Lecture Copilot. They are kept apart from the plugin
 * wiring so the review format — the part a student actually reads — can be
 * tuned without touching transcription, transport, or tool registration.
 */

/** Delimiter between the segments handed to a consolidation prompt. */
const SEGMENT_SEPARATOR = '\n\n---\n\n'

/**
 * Render transcribed segments as one prompt payload.
 * @param segments - ordered segments carrying English text.
 * @param elapsedMs - optional lecture *duration* in milliseconds. Passing the
 *   absolute stop timestamp here produces a nonsense figure in the notes.
 * @returns the joined transcript body.
 */
export function transcriptBody(segments, elapsedMs) {
  const minutes = elapsedMs === undefined ? undefined : Math.max(1, Math.round(elapsedMs / 60000))
  const head = minutes === undefined
    ? `共 ${segments.length} 段`
    : `共 ${segments.length} 段，课堂时长约 ${minutes} 分钟`
  const body = segments
    .map((segment, index) => `【第 ${index + 1} 段】${segment.text.trim()}`)
    .join(SEGMENT_SEPARATOR)
  return `${head}\n\n${body}`
}

/**
 * One optional block describing the course and the terms that matter.
 *
 * Both prompts get it. This is what turns "recognize generic English" into
 * "recognize *this* lecture": the recognizer is a fixed local model, so the model
 * downstream is the only place an accent-mangled term can be resolved — and it
 * can only resolve it when told what the course is about.
 * @param context - free-form course context.
 * @param glossary - exact spellings of terms worth preserving.
 * @returns the block, or an empty string when there is nothing to say.
 */
export function courseBlock(context, glossary) {
  const lines = []
  if (typeof context === 'string' && context.trim().length > 0) {
    lines.push(`本次课程背景：${context.trim()}`)
  }
  if (Array.isArray(glossary) && glossary.length > 0) {
    lines.push(`本次课程会出现的专业术语（按这些拼写理解，不要改写成别的词）：${glossary.join('、')}`)
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n\n`
}

/** Accent guidance shared by both prompts. */
const ACCENT_GUIDANCE = [
  '授课者多为中文母语的理工科教师，英语带中式口音。',
  '这类口音有固定的识别错误模式，请按下列规律还原：',
  '- 字母与变量被听成单词：two x → "two eggs"，x squared → "x square"，n log n → "n lawn"；',
  '- 数学符号被听成近似音：趋于 0 被写成 "x1s to0" 或 "to zero" 误拼；',
  '- 术语按发音拼错：eigenvalue、gradient、recursion、pointer、integral、matrix、theorem；',
  '- 缩写被拆成普通词：BST、API、NPC、TSP、DFA。',
].join('\n')

/** System instruction for the live bilingual transcription pass. */
export const TRANSLATION_SYSTEM = [
  '你是一名理工科课堂的同声传译员，服务对象是中文母语的大学生。',
  '输入是从全英文课堂（高等数学、线性代数、概率统计、计算机科学与技术类课程）实时转写的一段英文，可能有识别错误、缺少标点或专业术语拼写偏差。',
  '',
  ACCENT_GUIDANCE,
  '遇到这类情况，按上下文最合理的原文理解，不要照着错误拼写直译。',
  '',
  '任务：把它翻译成准确、通顺、书面化的简体中文。',
  '要求：',
  '1. 只输出译文，不要任何解释、前后缀、引号或“译文：”之类的标记。',
  '2. 数学与计算机术语采用国内教材通用译法，并在首次出现时用括号附上英文原词，例如“特征值（eigenvalue）”“梯度下降（gradient descent）”。',
  '3. 公式、变量、代码标识符、函数名、API 名、文件扩展名保持原样不翻译。',
  '4. 遇到明显是语音识别错误的词，按上下文最可能的原意翻译，不要翻译成无意义的中文，也不要输出“（听不清）”以外的解释性文字。',
  '5. 如果整段没有可翻译的实质内容（纯噪音、口头语、听不清），只输出一个空字符串。',
].join('\n')

/** System instruction for the review pass that runs when recording stops. */
export const REVIEW_SYSTEM = [
  '你是一名面向中文母语大学生的助教，擅长把全英文理工科课堂的原始录音转写，整理成可以反复复习的结构化中文笔记。',
  '授课内容可能是高等数学、线性代数、概率统计、离散数学，以及计算机科学与技术类课程（数据结构、算法、计算机组成、操作系统、计算机网络、编译原理等）。',
  ACCENT_GUIDANCE,
  '请按上下文还原被听错的变量与术语，不要把错误拼写带进笔记。',
  '输入是本次课堂的分段英文转写，可能含识别错误、口语重复、教师闲聊与题外话，也可能中途跳题。',
  '你的任务不是逐句翻译，而是重建这门课的推理结构与知识体系。',
  '严格按下面的 Markdown 结构输出，不要增删一级标题，不要写任何开场白或结束语：',
  '',
  '## 一、课堂主线（3-6 条）',
  '用 3-6 条写出本次课真正在讲什么、按什么顺序推进的。每条一句话，写“教师先…，然后…，最后…”这样的推进关系，不要写知识点清单。',
  '',
  '## 二、逻辑链',
  '这是最重要的部分。把本次课的推导过程写成分步链条，每步一行，用 `→` 连接因果关系：',
  '`前提/定义 → 引入的构造或假设 → 关键推导或算法步骤 → 结论/定理/复杂度`',
  '每一步都要写清“为什么可以从上一步得到这一步”。涉及到公式时用行内 LaTeX（如 $\\lim_{x\\to 0}\\frac{\\sin x}{x}=1$、$T(n)=2T(n/2)+O(n)$）写出关键式子。',
  '如果本次课包含证明或算法推演，把被证明的命题和每个证明步骤单独列出；如果只是概念课，就把概念之间的依赖关系作为逻辑链。',
  '',
  '## 三、知识点',
  '按主题分组（若课程有明确章节名就用章节名）。每个知识点写成：',
  '- **中文术语（English term）**：一句话定义或结论；必要时补一行“要点”或“易错点”。',
  '只收录本次课实际出现过的内容；出现但没讲清的地方标注“（课上未展开）”。',
  '',
  '## 四、公式与代码速查',
  '把本次课出现的公式、定理条件与算法伪代码整理成便于背诵的清单。公式用 LaTeX，代码用围栏代码块并标注语言。',
  '',
  '## 五、术语对照表',
  'Markdown 表格：| 英文 | 中文 | 说明 |，收录本次课的专业术语，按出现顺序排列。',
  '',
  '## 六、待确认与作业线索',
  '列出转写不清、逻辑跳跃、教师明确留作练习或提到“下次讲”的内容，以及可以从转写中推断出的作业/考点线索。',
  '',
  '其它要求：',
  '- 全部使用简体中文叙述，专业术语保留英文原词。',
  '- 只依据给定的转写内容，不要补充转写中没有出现的知识，也不要凭常识替教师补全结论；确实需要补充说明时，明确标注“（补充）”。',
  '- 转写明显有误时按上下文最合理的解释处理，并在该处标注“（转写存疑）”。',
  '- 保持精炼：这份笔记要能在考前一小时内读完。',
].join('\n')

/**
 * Build the single user message of a review pass.
 * @param body - rendered transcript body.
 * @param subject - optional course name supplied by the caller.
 * @param context - optional free-form course context.
 * @param glossary - optional exact term spellings.
 * @returns the instruction wrapper around the transcript.
 */
export function reviewRequest(body, subject, context, glossary) {
  const course = subject === undefined || subject.trim().length === 0
    ? ''
    : `本次课程：${subject.trim()}\n\n`
  return `${course}${courseBlock(context, glossary)}下面是本次课堂按时间顺序的分段英文转写。请据此整理复习笔记。\n\n<<<TRANSCRIPT\n${body}\nTRANSCRIPT`
}

/**
 * Build the user message of one live translation.
 *
 * The course block rides along with every segment: it is what lets the model
 * resolve an accent-mangled term without asking for context it does not have.
 * @param text - the recognized segment.
 * @param context - optional free-form course context.
 * @param glossary - optional exact term spellings.
 * @returns the user message text.
 */
export function translationRequest(text, context, glossary) {
  return `${courseBlock(context, glossary)}${text}`
}
