/**
 * Lecture Copilot — review note to OneNote page XML.
 *
 * OneNote's automation interface accepts its own XML dialect, and its schema is
 * narrow: `one:T` is a text-only element, and `one:Run` is rejected both under
 * `one:T` ("unexpected element Run according to the content model of parent
 * element T") and under `one:OE` (same error naming OE). So a run cannot appear
 * anywhere the Host can emit it, and there is no way to carry font styling.
 *
 * The conversion therefore keeps every piece of text in a plain `one:T` and
 * carries emphasis in the text itself — headings keep a marker, list items keep
 * their bullet or number. That survives copy-paste and renders identically in
 * every OneNote version, which is what a note the student re-reads needs.
 *
 * @module dsh-lecture-copilot/note-xml
 */

import { latexToDisplayMathML, latexToMathML } from './latex-mathml.js'

/** Maximum characters in one `one:T` CDATA payload. */
const MAX_RUN_CHARS = 4000

/** Maximum `one:T` elements in one page body, a bound for a 30k-token note. */
const MAX_ELEMENTS = 4000

/**
 * Wrap text in a CDATA section, escaping any terminator it contains.
 *
 * A `]]>` inside CDATA ends it early and makes the document invalid, which
 * OneNote reports as an opaque HRESULT, so this cannot be skipped.
 * @param text - the raw text.
 * @returns the CDATA section.
 */
export function cdata(text) {
  return `<![CDATA[${String(text).replaceAll(']]>', ']]]]><![CDATA[>')}]]>`
}

/**
 * One inline math span, `$…$`, capturing the LaTeX without its delimiters.
 *
 * The capture group matters: a `replace` callback is handed the whole match
 * before any group, so without it the parser received `$f(x)=x^2$` and produced a
 * leading `$`. `\\.` keeps an escaped `\$` from ending the span early.
 */
const INLINE_MATH = /\$((?:\\.|[^$\\])+)\$/gu
/**
 * One display math span, `$$…$$`, which may run across lines.
 */
const DISPLAY_MATH = /\$\$([\s\S]+?)\$\$/gu

/**
 * Replace every LaTeX span in one line with real MathML.
 *
 * Display math is handled first, because `$$…$$` contains `$…$`. A span that
 * cannot be converted is restored **with its delimiters**: returning only the
 * captured group deleted the `$` signs, so prose like `成本 5$ 与收益 10$` quietly
 * lost its currency marks. A note that renders most of its maths and leaves the
 * rest readable is useful; one that eats characters is not.
 *
 * @param line - one source line.
 * @returns the line with math spans replaced by `<math>` elements.
 */
export function latexToMathMarkup(line) {
  return String(line)
    .replace(DISPLAY_MATH, (whole, latex) => latexToDisplayMathML(latex) ?? whole)
    .replace(INLINE_MATH, (whole, latex) => latexToMathML(latex) ?? whole)
}

/**
 * Shield every LaTeX span while Markdown is stripped, then put it back.
 *
 * This matters: a review is now written in LaTeX throughout, and the Markdown
 * cleanup below is not LaTeX-aware. `$a^*$` lost its star, and `$a*b*c$` had the
 * middle of the expression treated as emphasis and deleted. Math is not Markdown,
 * so it is lifted out of the text before the markers are touched.
 *
 * @param text - the raw text.
 * @param transform - applied to the text with math removed.
 * @returns the transformed text with every math span restored verbatim.
 */
function protectingMath(text, transform) {
  const spans = []
  const stash = (match) => {
    spans.push(match)
    // A placeholder that cannot collide with Markdown syntax or with math.
    return `\u0000${String(spans.length - 1)}\u0000`
  }
  // Display first: `$$…$$` contains `$…$`.
  const shielded = String(text).replace(DISPLAY_MATH, stash).replace(INLINE_MATH, stash)
  const transformed = transform(shielded)
  return transformed.replace(/\u0000(\d+)\u0000/gu, (_all, index) => spans[Number(index)] ?? '')
}

/**
 * Strip inline Markdown, keeping the words.
 *
 * There is no styling to apply in this dialect, so the markers are simply removed
 * rather than left visible — except inside math, which is preserved exactly.
 * @param line - one source line.
 * @returns the plain text.
 */
function stripInline(line) {
  return protectingMath(line, (text) => text
    .replace(/\*\*([^*]+)\*\*/gu, '$1')
    .replace(/`([^`]+)`/gu, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/gu, '$1$2')
    .replace(/\s+$/u, ''))
}

/**
 * Split long text so no single CDATA payload is unbounded.
 * @param text - the text to split.
 * @returns chunks no longer than {@link MAX_RUN_CHARS}.
 */
function chunk(text) {
  if (text.length <= MAX_RUN_CHARS) return [text]
  const parts = []
  for (let index = 0; index < text.length; index += MAX_RUN_CHARS) {
    parts.push(text.slice(index, index + MAX_RUN_CHARS))
  }
  return parts
}

/**
 * One `one:OE` holding one text element, with any LaTeX turned into MathML.
 *
 * The math is substituted *before* the CDATA is built: OneNote reads a `<math>`
 * element inside the payload and turns it into a real, editable equation, whereas
 * the same characters inside CDATA would stay literal text.
 *
 * @param text - the line's text.
 * @returns the element XML.
 */
function element(text) {
  if (text.length === 0) return '<one:OE><one:T><![CDATA[]]></one:T></one:OE>'
  const withMath = latexToMathMarkup(text)
  if (withMath === text) {
    return `<one:OE>${chunk(text).map((part) => `<one:T>${cdata(part)}</one:T>`).join('')}</one:OE>`
  }
  // Math and text have to be split so each `<math>` stays its own node; a chunk
  // boundary must never fall inside one.
  const pieces = []
  let cursor = 0
  for (const match of withMath.matchAll(/<math[\s\S]*?<\/math>/gu)) {
    const before = withMath.slice(cursor, match.index)
    if (before.length > 0) pieces.push(`<one:T>${cdata(before)}</one:T>`)
    pieces.push(match[0])
    cursor = match.index + match[0].length
  }
  const after = withMath.slice(cursor)
  if (after.length > 0) pieces.push(`<one:T>${cdata(after)}</one:T>`)
  return `<one:OE>${pieces.join('')}</one:OE>`
}

/**
 * Render one block, applying the textual emphasis this dialect allows.
 * @param block - `{ kind, text, ... }` from the block scanner.
 * @returns the element XML.
 */
function renderBlock(block) {
  if (block.kind === 'heading') {
    // A visible marker replaces the lost font size, so the hierarchy still reads.
    const marker = block.level <= 2 ? '【' : ''
    const close = block.level <= 2 ? '】' : ''
    return element(`${marker}${stripInline(block.text)}${close}`)
  }
  if (block.kind === 'list') {
    return element(`${block.ordered ? `${String(block.index)}.` : '·'} ${stripInline(block.text)}`)
  }
  if (block.kind === 'code') {
    // Indentation stands in for the monospace block OneNote cannot receive.
    return block.text.split('\n').map((line) => element(`    ${line}`)).join('')
  }
  return element(stripInline(block.text))
}

/**
 * Split Markdown into the blocks this converter understands.
 *
 * Headings and fenced code are structural; everything else is grouped into
 * paragraphs so a wrapped sentence becomes one element rather than many.
 * @param markdown - the review text.
 * @returns blocks of `{ kind, text, ... }`.
 */
function scanBlocks(markdown) {
  const lines = String(markdown).replaceAll('\r\n', '\n').split('\n')
  const blocks = []
  let paragraph = []
  let code = null
  let fence = ''

  const flushParagraph = () => {
    if (paragraph.length === 0) return
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') })
    paragraph = []
  }

  for (const line of lines) {
    if (code !== null) {
      if (line.trimStart().startsWith(fence)) {
        blocks.push({ kind: 'code', text: code.join('\n') })
        code = null
        fence = ''
        continue
      }
      code.push(line)
      continue
    }

    const fenceMatch = /^\s*(```+|~~~+)/u.exec(line)
    if (fenceMatch !== null) {
      flushParagraph()
      code = []
      fence = fenceMatch[1]
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2].trim() })
      continue
    }

    // A table row becomes one text line; the separator row carries no meaning.
    if (/^\s*\|.*\|\s*$/u.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/u.test(line)) continue
      flushParagraph()
      const cells = line.trim().replace(/^\||\|$/gu, '').split('|').map((cell) => cell.trim())
      blocks.push({ kind: 'paragraph', text: cells.filter((cell) => cell.length > 0).join('  |  ') })
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/u.exec(line)
    if (bullet !== null) {
      flushParagraph()
      blocks.push({ kind: 'list', ordered: false, index: 0, text: bullet[1].trim() })
      continue
    }

    const numbered = /^\s*(\d+)[.)]\s+(.*)$/u.exec(line)
    if (numbered !== null) {
      flushParagraph()
      blocks.push({ kind: 'list', ordered: true, index: Number(numbered[1]), text: numbered[2].trim() })
      continue
    }

    if (line.trim().length === 0) {
      flushParagraph()
      continue
    }
    paragraph.push(line.trim())
  }

  if (code !== null) blocks.push({ kind: 'code', text: code.join('\n') })
  flushParagraph()
  return blocks
}

/**
 * Convert the review Markdown into the body XML OneNote accepts.
 *
 * Returns a complete `one:Outline`, which is what `UpdatePageContent` expects in
 * place of a body.
 * @param markdown - the review text.
 * @returns the `one:Outline` XML.
 */
export function markdownToPageXml(markdown) {
  const blocks = scanBlocks(markdown).slice(0, MAX_ELEMENTS)
  if (blocks.length === 0) {
    return '<one:Outline><one:OEChildren><one:OE><one:T><![CDATA[]]></one:T></one:OE></one:OEChildren></one:Outline>'
  }
  const elements = blocks.map((block) => renderBlock(block)).join('')
  return `<one:Outline><one:OEChildren>${elements}</one:OEChildren></one:Outline>`
}

/**
 * Generate a page title for one exported note.
 *
 * The title has to identify the lecture in a notebook list months later, so it
 * leads with the course when the plugin knows it and always carries the date.
 * @param options - `context` (course description) and `now` (defaults to today).
 * @returns the title.
 */
export function noteTitle(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
  // The first clause of the course context is the course itself; the rest is
  // teaching detail that would only make the title long.
  const course = String(options.context ?? '').split(/[，,；;\n]/u)[0].trim()
  return course.length > 0 ? `${course} · 课堂笔记 ${stamp}` : `课堂笔记 ${stamp}`
}

/**
 * Render an export report as the message a person reads.
 * @param result - `{ ok, notebookName, pageName, error }`.
 * @returns one Chinese sentence.
 */
export function describeExport(result) {
  if (result.ok !== true) return `导出失败：${result.error ?? '未知原因'}`
  return `已导出到 OneNote：「${result.notebookName ?? '?'}」→「${result.pageName ?? '?'}」`
}

export { scanBlocks, stripInline }
