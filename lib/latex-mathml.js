/**
 * Lecture Copilot — LaTeX to MathML, for OneNote.
 *
 * OneNote 2013+ accepts MathML in page content and turns it into real, editable
 * equations. It does **not** accept OMML: handed `<m:oMath>` it writes back the
 * plain text of the runs (`x^2` became `xx2`), which is why this module exists.
 * The form it echoes back for a good write is
 * `<!--[if mathML]><math …>…</math><![endif]-->`, and an inline equation keeps no
 * `display` attribute while a standalone one is given `display="block"`.
 *
 * This is not a general LaTeX implementation. It covers the notation a lecture
 * note actually uses — fractions, roots, scripts, limits, sums and integrals,
 * matrices, and the symbol set of calculus, linear algebra, and algorithms — and
 * anything it cannot parse is left as the original text rather than being dropped
 * or mangled. That choice matters more than coverage: a note that renders most of
 * its maths and keeps the rest readable is useful, while one that silently eats an
 * equation is not.
 *
 * @module dsh-lecture-copilot/latex-mathml
 */

/** The MathML namespace, spelled once. */
const MML = 'http://www.w3.org/1998/Math/MathML'

/** Function names set upright, as LaTeX does. */
const UPRIGHT_FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan',
  'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg', 'exp', 'lim', 'limsup',
  'liminf', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'deg', 'gcd',
  'hom', 'arg', 'Pr', 'mod',
])

/** Multi-letter names that must stay upright rather than becoming a product. */
const UPRIGHT_NAMES = new Set([
  'lim', 'limsup', 'liminf', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker',
  'deg', 'gcd', 'hom', 'arg', 'Pr', 'mod', 'sin', 'cos', 'tan', 'cot', 'sec',
  'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log',
  'ln', 'lg', 'exp',
])

/** Big operators that take limits above and below. */
const BIG_OPERATORS = new Map([
  ['sum', '\u2211'],
  ['prod', '\u220F'],
  ['coprod', '\u2210'],
  ['int', '\u222B'],
  ['iint', '\u222C'],
  ['iiint', '\u222D'],
  ['oint', '\u222E'],
  ['bigcup', '\u22C3'],
  ['bigcap', '\u22C2'],
])

/** LaTeX commands that map to one character. */
const SYMBOLS = new Map(Object.entries({
  // Arithmetic and relations.
  'pm': '\u00B1', 'mp': '\u2213', 'times': '\u00D7', 'div': '\u00F7', 'cdot': '\u22C5',
  'ast': '\u2217', 'star': '\u22C6', 'circ': '\u2218', 'bullet': '\u2219',
  'le': '\u2264', 'leq': '\u2264', 'ge': '\u2265', 'geq': '\u2265',
  'ne': '\u2260', 'neq': '\u2260', 'approx': '\u2248', 'equiv': '\u2261',
  'sim': '\u223C', 'simeq': '\u2243', 'propto': '\u221D', 'll': '\u226A', 'gg': '\u226B',
  // Sets and logic.
  'in': '\u2208', 'notin': '\u2209', 'ni': '\u220B', 'subset': '\u2282',
  'subseteq': '\u2286', 'supset': '\u2283', 'supseteq': '\u2287',
  'cup': '\u222A', 'cap': '\u2229', 'setminus': '\u2216', 'emptyset': '\u2205',
  'varnothing': '\u2205', 'forall': '\u2200', 'exists': '\u2203', 'nexists': '\u2204',
  'neg': '\u00AC', 'lnot': '\u00AC', 'land': '\u2227', 'wedge': '\u2227',
  'lor': '\u2228', 'vee': '\u2228', 'implies': '\u21D2', 'iff': '\u21D4',
  'therefore': '\u2234', 'because': '\u2235',
  // Arrows.
  'to': '\u2192', 'rightarrow': '\u2192', 'leftarrow': '\u2190', 'gets': '\u2190',
  'leftrightarrow': '\u2194', 'Rightarrow': '\u21D2', 'Leftarrow': '\u21D0',
  'Leftrightarrow': '\u21D4', 'mapsto': '\u21A6', 'uparrow': '\u2191', 'downarrow': '\u2193',
  'nearrow': '\u2197', 'searrow': '\u2198', 'longrightarrow': '\u27F6',
  // Analysis.
  'infty': '\u221E', 'partial': '\u2202', 'nabla': '\u2207', 'prime': '\u2032',
  'sum': '\u2211', 'prod': '\u220F', 'int': '\u222B', 'oint': '\u222E',
  'lim': 'lim', 'sqrt': '\u221A',
  // Greek, lower case.
  'alpha': '\u03B1', 'beta': '\u03B2', 'gamma': '\u03B3', 'delta': '\u03B4',
  'epsilon': '\u03B5', 'varepsilon': '\u03B5', 'zeta': '\u03B6', 'eta': '\u03B7',
  'theta': '\u03B8', 'vartheta': '\u03D1', 'iota': '\u03B9', 'kappa': '\u03BA',
  'lambda': '\u03BB', 'mu': '\u03BC', 'nu': '\u03BD', 'xi': '\u03BE',
  'pi': '\u03C0', 'varpi': '\u03D6', 'rho': '\u03C1', 'sigma': '\u03C3',
  'varsigma': '\u03C2', 'tau': '\u03C4', 'upsilon': '\u03C5', 'phi': '\u03C6',
  'varphi': '\u03C6', 'chi': '\u03C7', 'psi': '\u03C8', 'omega': '\u03C9',
  // Greek, upper case.
  'Gamma': '\u0393', 'Delta': '\u0394', 'Theta': '\u0398', 'Lambda': '\u039B',
  'Xi': '\u039E', 'Pi': '\u03A0', 'Sigma': '\u03A3', 'Upsilon': '\u03A5',
  'Phi': '\u03A6', 'Psi': '\u03A8', 'Omega': '\u03A9',
  // Misc.
  'ldots': '\u2026', 'cdots': '\u22EF', 'vdots': '\u22EE', 'ddots': '\u22F1',
  'angle': '\u2220', 'triangle': '\u25B3', 'square': '\u25A1', 'checkmark': '\u2713',
  'degree': '\u00B0', 'S': '\u00A7', 'P': '\u00B6', 'ldots': '\u2026',
}))

/** Commands that take one braced argument and wrap it. */
const WRAPPERS = new Map(Object.entries({
  mathbb: 'mi', mathcal: 'mi', mathfrak: 'mi', mathrm: 'mi', mathbf: 'mi',
  mathit: 'mi', mathsf: 'mi', mathtt: 'mi', text: 'mtext',
  textrm: 'mtext', textbf: 'mtext', textit: 'mtext', boldsymbol: 'mi',
}))

/**
 * Commands whose argument is a name set upright as a whole.
 *
 * `\operatorname{rank}(A)` has to render as one upright `rank`, not as four
 * italic letters, which is what a per-letter parse would produce.
 */
const NAME_WRAPPERS = new Set(['operatorname', 'DeclareMathOperator', 'mathrm', 'textrm', 'text'])

/** Accents, as `mover` with an accent character. */
const ACCENTS = new Map(Object.entries({
  hat: '\u02C6', widehat: '\u02C6', bar: '\u00AF', overline: '\u00AF',
  vec: '\u2192', dot: '\u02D9', ddot: '\u00A8', tilde: '\u02DC', widetilde: '\u02DC',
}))

/** Spacing commands, mapped to their width in em. */
const SPACES = new Map(Object.entries({
  ',': '0.167', ':': '0.222', ';': '0.278', '!': '-0.167', quad: '1', qquad: '2',
}))

/**
 * A tiny reader over the LaTeX source.
 *
 * The parser needs one character of lookahead and a position it can restore, so
 * it is written as an object rather than as recursive index passing.
 */
class Reader {
  /**
   * @param source - the LaTeX text.
   */
  constructor(source) {
    this.text = source
    this.at = 0
  }

  /** @returns whether the end has been reached. */
  get done() {
    return this.at >= this.text.length
  }

  /** @returns the next character without consuming it. */
  peek() {
    return this.text[this.at]
  }

  /** @returns the next character and consumes it. */
  next() {
    return this.text[this.at++]
  }

  /**
   * Consume the next character if it is the given one.
   * @param character - the expected character.
   * @returns whether it was consumed.
   */
  eat(character) {
    if (this.peek() !== character) return false
    this.at += 1
    return true
  }

  /**
   * Consume an exact string if it is next.
   * @param word - the expected string.
   * @returns whether it was consumed.
   */
  eatWord(word) {
    if (!this.text.startsWith(word, this.at)) return false
    this.at += word.length
    return true
  }
}

/**
 * Escape text for XML character data.
 * @param text - the raw text.
 * @returns the escaped text.
 */
function xml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Split a run of letters into single-letter identifiers, keeping known function
 * names upright.
 * @param letters - the letter run.
 * @returns the MathML for the run.
 */
function lettersToMath(letters) {
  const parts = []
  let rest = letters
  while (rest.length > 0) {
    // Longest upright name first, so `limsup` beats `lim`, and `sin` beats `s`.
    const name = [...UPRIGHT_NAMES]
      .filter((candidate) => rest.startsWith(candidate))
      .sort((left, right) => right.length - left.length)[0]
    if (name !== undefined) {
      parts.push(`<mi>${xml(name)}</mi>`)
      rest = rest.slice(name.length)
      continue
    }
    parts.push(`<mi>${xml(rest[0])}</mi>`)
    rest = rest.slice(1)
  }
  return parts.join('')
}

/**
 * Parse one required group, `{…}` or a single token.
 * @param reader - the reader.
 * @returns the MathML for the group.
 */
function parseGroup(reader) {
  if (!reader.eat('{')) return parseAtom(reader)
  let depth = 1
  const inner = new Reader(reader.text.slice(reader.at).replace(/^/u, ''))
  let end = 0
  const start = reader.at
  while (reader.at < reader.text.length) {
    const character = reader.next()
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        end = reader.at - 1
        break
      }
    }
  }
  void inner
  const body = reader.text.slice(start, end)
  return parseSequence(new Reader(body))
}

/**
 * Parse an optional group in square brackets.
 * @param reader - the reader.
 * @returns the group's text, or `undefined`.
 */
function parseOptional(reader) {
  if (!reader.eat('[')) return undefined
  const start = reader.at
  let depth = 0
  while (reader.at < reader.text.length) {
    const character = reader.next()
    if (character === '{') depth += 1
    else if (character === '}') depth -= 1
    else if (character === ']' && depth === 0) return reader.text.slice(start, reader.at - 1)
  }
  return reader.text.slice(start)
}

/**
 * Parse one script argument, which may be a group or a single token.
 * @param reader - the reader.
 * @returns the MathML for the argument.
 */
function parseScript(reader) {
  if (reader.peek() === '{') return parseGroup(reader)
  return parseAtom(reader)
}

/**
 * Wrap a script argument, avoiding a redundant `mrow` around a single child.
 *
 * Cleaner MathML is easier to read in OneNote's stored form and has one less
 * level for the editor to walk when someone edits the equation.
 * @param markup - the argument's MathML.
 * @returns the argument, wrapped only when it has several children.
 */
function scriptWrap(markup) {
  if (markup.length === 0) return ''
  // Already a single element? Leave it alone.
  if (/^<[a-z]+ [^>]*\/>$/u.test(markup) || /^<([a-z]+)[^>]*>.*<\/\1>$/u.test(markup)) return markup
  return `<mrow>${markup}</mrow>`
}

/**
 * Parse an environment body, `\begin{name} … \end{name}`.
 * @param reader - the reader, positioned after `\begin{name}`.
 * @param name - the environment name.
 * @returns the MathML for the environment.
 */
function parseEnvironment(reader, name) {
  const close = `\\end{${name}}`
  const start = reader.at
  const end = reader.text.indexOf(close, start)
  const body = end < 0 ? reader.text.slice(start) : reader.text.slice(start, end)
  reader.at = end < 0 ? reader.text.length : end + close.length

  // A matrix family renders as a table; `aligned` and `cases` are the same shape.
  const rows = body.split('\\\\').map((row) => row.trim()).filter((row) => row.length > 0)
  const cells = rows.map((row) => row.split('&').map((cell) => parseSequence(new Reader(cell.trim()))))
  const width = Math.max(...cells.map((row) => row.length), 1)
  const trs = cells.map((row) => {
    const padded = [...row, ...Array.from({ length: width - row.length }, () => '')]
    return `<mtr>${padded.map((cell) => `<mtd>${cell}</mtd>`).join('')}</mtr>`
  }).join('')
  return `<mtable>${trs}</mtable>`
}

/**
 * Parse one atom: a command, a group, a number, a letter, or an operator.
 * @param reader - the reader.
 * @returns the MathML for the atom.
 */
function parseAtom(reader) {
  const character = reader.peek()
  if (character === undefined) return ''
  reader.next()

  if (character === '{') {
    // The brace was consumed; re-read the group body.
    reader.at -= 1
    return parseGroup(reader)
  }
  if (character === '\\') {
    return parseCommand(reader)
  }
  if (/[0-9.]/u.test(character)) {
    let number = character
    while (!reader.done && /[0-9.]/u.test(reader.peek())) number += reader.next()
    return `<mn>${xml(number)}</mn>`
  }
  if (/[A-Za-z]/u.test(character)) {
    let letters = character
    while (!reader.done && /[A-Za-z]/u.test(reader.peek())) {
      // Only keep absorbing while the run could be an upright function name.
      const candidate = letters + reader.peek()
      if ([...UPRIGHT_NAMES].some((name) => name.startsWith(candidate))) letters += reader.next()
      else break
    }
    return lettersToMath(letters)
  }
  // Operators and punctuation. A run of `=`/`<`/`>` is one relational operator.
  if (/[=<>]/u.test(character)) {
    let operator = character
    while (!reader.done && /[=<>]/u.test(reader.peek())) operator += reader.next()
    return `<mo>${xml(operator)}</mo>`
  }
  if (character === '-') return '<mo>\u2212</mo>'
  if (character === '*') {
    // `*` is multiplication between operands but an asterisk when it stands alone,
    // which is how a note writes a dual space or an unspecified operation. Only the
    // standalone case can be told apart by looking at what follows.
    let lookahead = reader.at
    while (lookahead < reader.text.length && reader.text[lookahead] === ' ') lookahead += 1
    const next = reader.text[lookahead]
    const standalone = next === undefined || /[\^_=<>+\-),\]}]/u.test(next)
    return standalone ? '<mo>\u2217</mo>' : '<mo>\u22C5</mo>'
  }
  if (character === "'") return '<mo>\u2032</mo>'
  if (character === ' ') return ''
  if (/[+\u2212/|,;:!()[\]]/u.test(character)) return `<mo>${xml(character)}</mo>`
  return `<mo>${xml(character)}</mo>`
}

/**
 * Parse a command, with the backslash already consumed.
 * @param reader - the reader.
 * @returns the MathML for the command.
 */
function parseCommand(reader) {
  const start = reader.at
  while (!reader.done && /[A-Za-z]/u.test(reader.peek())) reader.next()
  const name = reader.text.slice(start, reader.at)
  // A single non-letter after the backslash is a symbol: `\,` `\{` `\%`.
  const single = name.length === 0 ? reader.next() : undefined
  const command = name.length > 0 ? name : single

  if (command === undefined) return ''

  if (WRAPPERS.has(command)) {
    const tag = WRAPPERS.get(command)
    const body = parseGroup(reader)
    // `\text{…}` and `\operatorname{…}` are upright words, so their text is taken
    // as-is rather than parsed letter by letter.
    return tag === 'mtext' ? `<mtext>${xml(plainText(body))}</mtext>` : `<mrow>${body}</mrow>`
  }
  if (NAME_WRAPPERS.has(command)) {
    const name = plainText(parseGroup(reader)).trim()
    if (name.length === 0) return ''
    return `<mi>${xml(name)}</mi>`
  }
  if (UPRIGHT_NAMES.has(command)) {
    // `\sin`, `\lim`, `\log`: a function name, set upright.
    return `<mi>${xml(command)}</mi>`
  }
  if (command === 'frac' || command === 'dfrac' || command === 'tfrac') {
    const numerator = parseGroup(reader)
    const denominator = parseGroup(reader)
    // Children are grouped only when they have more than one part, which is what
    // OneNote's own writer does.
    return `<mfrac>${scriptWrap(numerator)}${scriptWrap(denominator)}</mfrac>`
  }
  if (command === 'sqrt') {
    const index = parseOptional(reader)
    const body = parseGroup(reader)
    if (index === undefined) return `<msqrt>${body}</msqrt>`
    return `<mroot>${scriptWrap(body)}${scriptWrap(parseSequence(new Reader(index)))}</mroot>`
  }
  if (BIG_OPERATORS.has(command)) {
    const operator = `<mo>${xml(BIG_OPERATORS.get(command))}</mo>`
    const lower = reader.eat('_') ? parseScript(reader) : undefined
    const upper = reader.eat('^') ? parseScript(reader) : undefined
    if (lower === undefined && upper === undefined) return operator
    if (lower !== undefined && upper !== undefined) return `<munderover>${operator}${scriptWrap(lower)}${scriptWrap(upper)}</munderover>`
    if (upper !== undefined) return `<mover>${operator}${scriptWrap(upper)}</mover>`
    return `<munder>${operator}${scriptWrap(lower)}</munder>`
  }
  // `\left…\right` only affects sizing, which MathML leaves to the renderer.
  if (command === 'left' || command === 'right') {
    const delimiter = reader.peek()
    if (delimiter === undefined) return ''
    if (delimiter === '\\') {
      reader.next()
      const braceStart = reader.at
      while (!reader.done && /[A-Za-z]/u.test(reader.peek())) reader.next()
      const delimiterName = reader.text.slice(braceStart, reader.at)
      if (delimiterName === 'lvert' || delimiterName === 'rvert') return '<mo>|</mo>'
      if (delimiterName === 'lVert' || delimiterName === 'rVert') return '<mo>\u2016</mo>'
      if (delimiterName === 'langle') return '<mo>\u27E8</mo>'
      if (delimiterName === 'rangle') return '<mo>\u27E9</mo>'
      if (delimiterName === 'lbrace') return '<mo>{</mo>'
      if (delimiterName === 'rbrace') return '<mo>}</mo>'
      if (delimiterName === 'vert') return '<mo>|</mo>'
      if (delimiterName === 'Vert') return '<mo>\u2016</mo>'
      if (delimiterName === '.') return ''
      return `<mo>${xml(delimiterName)}</mo>`
    }
    reader.next()
    if (delimiter === '.') return ''
    const mapped = delimiter === '{' ? '{' : delimiter === '}' ? '}' : delimiter
    return `<mo>${xml(mapped)}</mo>`
  }
  if (command === 'begin') {
    const environment = parseGroup(reader)
    const name = plainText(environment).trim()
    return parseEnvironment(reader, name)
  }
  if (command === 'end') {
    // Consumed by `parseEnvironment`; reaching here means an unmatched `\end`.
    parseGroup(reader)
    return ''
  }
  if (ACCENTS.has(command)) {
    const body = parseGroup(reader)
    return `<mover accent="true"><mrow>${body}</mrow><mo>${xml(ACCENTS.get(command))}</mo></mover>`
  }
  if (SPACES.has(command)) {
    return `<mspace width="${SPACES.get(command)}em" />`
  }
  if (SYMBOLS.has(command)) {
    const value = SYMBOLS.get(command)
    // A symbol that is letters (`lim`) is a name; the rest are operators.
    if (/^[A-Za-z]+$/u.test(value)) return UPRIGHT_FUNCTIONS.has(value) ? `<mi>${xml(value)}</mi>` : `<mi>${xml(value)}</mi>`
    return `<mo>${xml(value)}</mo>`
  }
  if (command === '\\') return '<mspace linebreak="newline" />'
  if (single !== undefined && /[{}%$&#_]/u.test(single)) return `<mo>${xml(single)}</mo>`
  // An unknown command: keep it visible rather than dropping it silently.
  return `<mtext>${xml(`\\${command}`)}</mtext>`
}

/**
 * Strip MathML tags to recover the plain text of a fragment.
 * @param markup - the MathML fragment.
 * @returns the text content.
 */
function plainText(markup) {
  return String(markup)
    .replaceAll(/<[^>]*>/gu, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

/**
 * Parse a whole sequence, applying scripts to whatever came before them.
 * @param reader - the reader.
 * @returns the MathML for the sequence.
 */
function parseSequence(reader) {
  const parts = []
  while (!reader.done) {
    const character = reader.peek()
    if (character === '}' || character === '&') break
    if (character === '_' || character === '^') {
      reader.next()
      const script = parseScript(reader)
      const base = parts.pop() ?? ''
      // A second script on the same base combines into msubsup.
      if (character === '_' && reader.peek() === '^') {
        reader.next()
        const upper = parseScript(reader)
        parts.push(`<msubsup>${base}${scriptWrap(script)}${scriptWrap(upper)}</msubsup>`)
        continue
      }
      if (character === '^' && reader.peek() === '_') {
        reader.next()
        const lower = parseScript(reader)
        parts.push(`<msubsup>${base}${scriptWrap(lower)}${scriptWrap(script)}</msubsup>`)
        continue
      }
      parts.push(character === '_'
        ? `<msub>${base}${scriptWrap(script)}</msub>`
        : `<msup>${base}${scriptWrap(script)}</msup>`)
      continue
    }
    if (character === ' ') {
      reader.next()
      continue
    }
    parts.push(parseAtom(reader))
  }
  const kept = parts.filter((part) => part.length > 0)
  if (kept.length === 0) return ''
  if (kept.length === 1) return kept[0]
  return `<mrow>${kept.join('')}</mrow>`
}

/**
 * Whether a fragment's braces and environments are balanced.
 *
 * An unbalanced `{` used to be parsed to the end of the string and then quietly
 * dropped, producing a fraction with a missing denominator. Refusing the input
 * instead leaves the original text in place, which is the honest outcome.
 *
 * @param source - the LaTeX fragment.
 * @returns whether every brace is closed.
 */
function isBalanced(source) {
  let depth = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth < 0) return false
    }
  }
  return depth === 0
}

/**
 * CJK text, which never appears in real LaTeX outside `\text{…}`.
 *
 * This is the check that keeps two currency signs in a sentence from being read as
 * a math span: `成本 5$ 与收益 10$ 的差` otherwise became an equation whose
 * operators were the words `与收益`. Refusing is the right answer there — the
 * money amounts should stay prose.
 */
const CJK = /[\u3000-\u303F\u3040-\u30FF\u4E00-\u9FFF\uFF00-\uFFEF]/u

/**
 * Convert one LaTeX fragment into MathML.
 *
 * @param latex - the LaTeX source, without delimiters.
 * @returns the `<math>` element, or `undefined` when there is nothing to convert.
 */
export function latexToMathML(latex) {
  const source = String(latex).trim()
  if (source.length === 0) return undefined
  if (!isBalanced(source)) return undefined
  // `\text{…}` legitimately holds CJK; strip those spans before the CJK test so a
  // labelled equation still converts.
  const withoutText = source.replace(/\\text\s*\{[^{}]*\}/gu, '')
  if (CJK.test(withoutText)) return undefined
  let body
  try {
    body = parseSequence(new Reader(source))
  } catch {
    // A parser bug must never lose an equation: the caller keeps the source text.
    return undefined
  }
  if (body.length === 0) return undefined
  return `<math xmlns="${MML}">${body}</math>`
}

/**
 * Convert one LaTeX fragment into a standalone MathML equation.
 *
 * `display="block"` is what makes OneNote centre the equation on its own line;
 * that is also the only difference it makes, so inline math omits it.
 *
 * @param latex - the LaTeX source, without delimiters.
 * @returns the `<math>` element with `display="block"`.
 */
export function latexToDisplayMathML(latex) {
  const inline = latexToMathML(latex)
  if (inline === undefined) return undefined
  return inline.replace(`<math xmlns="${MML}">`, `<math xmlns="${MML}" display="block">`)
}

export { UPRIGHT_FUNCTIONS, SYMBOLS, BIG_OPERATORS, parseSequence, Reader }
