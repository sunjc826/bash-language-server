/**
 * Documentation comments: the comment block directly above a declaration,
 * written as Markdown and optionally structured with shdoc-style tags.
 *
 *   # Convert a path to an absolute path.
 *   # @arg $1 {path} dir Path to convert
 *   # @arg $2 {path} [cwd=$PWD] Base directory for relative paths
 *   # @arg $@ {string} rest... Extra arguments
 *   # @set BU_RET {path} The absolute path
 *   # @exitcode 0 Always
 *
 * A tag starts a line (after `# `) outside a code fence, and its text is
 * Markdown that runs until the next tag. Text before the first tag is the
 * description.
 */

const COMMENT_LINE = /^\s*#\s?(.*)/
const FENCE_LINE = /^\s*(```|~~~)/
const TAG_LINE = /^@([a-z][a-z-]*)(?:\s+(.*))?$/
const DIRECTIVE_LINE = /^\s*bash-ide\s/
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export type DocProblem = {
  /** Line of the tag, relative to the first line of the comment block. */
  line: number
  message: string
}

/** A documented positional parameter, from `@arg $N ...` or `@arg $@ ...`. */
export type DocParam = {
  /** 1-based position, or 'rest' for `$@`. */
  slot: number | 'rest'
  type?: string
  name?: string
  optional: boolean
  defaultValue?: string
  description: string
  line: number
}

export type DocTag = {
  tag: string
  /** Text after the tag name, including continuation lines. */
  text: string
  line: number
}

export type DocComment = {
  description: string
  params: DocParam[]
  /** Tags other than `@arg`, in source order. */
  tags: DocTag[]
  problems: DocProblem[]
}

/**
 * Read the comment block that ends on the line above `row`: the text of each
 * line without `#` and one following space, and the row the block starts on.
 */
export function commentLinesAbove(
  lines: readonly string[],
  row: number,
): { lines: string[]; startRow: number } | null {
  const block: string[] = []
  let current = row - 1
  for (; current >= 0; current--) {
    const match = COMMENT_LINE.exec(lines[current])
    if (!match) break
    block.push(match[1].trimEnd())
  }
  if (block.length === 0) return null
  return { lines: block.reverse(), startRow: current + 1 }
}

/** Whether the line starts a tag: `@word` at the start, outside code fences. */
function tagLines(lines: readonly string[]): Map<number, RegExpExecArray> {
  const tags = new Map<number, RegExpExecArray>()
  let inFence = false
  lines.forEach((line, index) => {
    if (FENCE_LINE.test(line)) {
      inFence = !inFence
      return
    }
    const match = inFence ? null : TAG_LINE.exec(line)
    if (match) tags.set(index, match)
  })
  return tags
}

/** Whether a comment block uses doc tags. */
export function hasDocTags(lines: readonly string[]): boolean {
  return tagLines(lines).size > 0
}

/**
 * Parse a comment block into its description and tags, or null when it has
 * no tags. `bash-ide` directive lines are not part of the documentation.
 */
export function parseDocComment(lines: readonly string[]): DocComment | null {
  const tags = tagLines(lines)
  if (tags.size === 0) return null

  const doc: DocComment = { description: '', params: [], tags: [], problems: [] }
  const description: string[] = []
  let current: { tag: string; line: number; text: string[] } | null = null
  const finish = () => {
    if (!current) return
    const text = trimBlankLines(current.text).join('\n')
    if (current.tag === 'arg') {
      const param = parseArg(text, current.line, doc.problems)
      if (param) doc.params.push(param)
    } else {
      doc.tags.push({ tag: current.tag, text, line: current.line })
    }
  }

  lines.forEach((line, index) => {
    const tag = tags.get(index)
    if (tag) {
      finish()
      current = { tag: tag[1], line: index, text: [tag[2] ?? ''] }
    } else if (!DIRECTIVE_LINE.test(line)) {
      ;(current ? current.text : description).push(line)
    }
  })
  finish()

  doc.description = trimBlankLines(description).join('\n')
  checkParams(doc)
  return doc
}

/**
 * Parse the text of an `@arg` tag. The braced form names the parameter:
 * `$N {type} name|[name]|[name=default]|name... description`. The plain shdoc
 * form `$N type description` does not.
 */
function parseArg(text: string, line: number, problems: DocProblem[]): DocParam | null {
  const slotMatch = /^\$(@|[1-9][0-9]*)(?=\s|$)\s*/.exec(text)
  if (!slotMatch) {
    problems.push({ line, message: '@arg must start with a parameter such as $1 or $@' })
    return null
  }
  const slot = slotMatch[1] === '@' ? 'rest' : Number(slotMatch[1])
  let rest = text.slice(slotMatch[0].length)

  if (!rest.startsWith('{')) {
    // shdoc: the first word is the type, the remainder the description
    const plain = /^(\S+)\s*([\s\S]*)$/.exec(rest)
    return {
      slot,
      type: plain?.[1],
      optional: false,
      description: plain?.[2] ?? '',
      line,
    }
  }

  const typeEnd = rest.indexOf('}')
  if (typeEnd < 0) {
    problems.push({ line, message: '@arg type is missing its closing }' })
    return null
  }
  const type = rest.slice(1, typeEnd).trim()
  rest = rest.slice(typeEnd + 1).trimStart()

  const nameMatch = /^(\[[^\]]*\]|\S+)\s*(?:-\s+)?/.exec(rest)
  const nameSpec = nameMatch?.[1] ?? ''
  const description = rest.slice(nameMatch?.[0].length ?? 0)
  let name = nameSpec
  let optional = false
  let defaultValue: string | undefined
  if (nameSpec.startsWith('[')) {
    optional = true
    const inner = nameSpec.slice(1, -1)
    const eq = inner.indexOf('=')
    name = eq < 0 ? inner : inner.slice(0, eq)
    if (eq >= 0) defaultValue = inner.slice(eq + 1)
  } else if (nameSpec.endsWith('...')) {
    name = nameSpec.slice(0, -3)
  }
  if (!NAME.test(name)) {
    problems.push({
      line,
      message: `@arg ${text
        .slice(0, slotMatch[0].length)
        .trim()} {${type}} needs a parameter name after the type`,
    })
    return null
  }
  return {
    slot,
    type: type || undefined,
    name,
    optional,
    defaultValue,
    description,
    line,
  }
}

/** Report repeated and missing `@arg` positions. */
function checkParams(doc: DocComment): void {
  const seen = new Set<number | 'rest'>()
  for (const param of doc.params) {
    if (seen.has(param.slot)) {
      doc.problems.push({
        line: param.line,
        message: `@arg ${slotLabel(param.slot)} is documented more than once`,
      })
    }
    seen.add(param.slot)
  }
  const positions = doc.params.flatMap((p) => (p.slot === 'rest' ? [] : [p.slot]))
  const max = Math.max(0, ...positions)
  for (let position = 1; position < max; position++) {
    if (!seen.has(position)) {
      const next = doc.params.find((p) => p.slot !== 'rest' && p.slot > position)
      doc.problems.push({
        line: next?.line ?? 0,
        message: `@arg $${position} is missing before $${max}`,
      })
    }
  }
}

export function slotLabel(slot: number | 'rest'): string {
  return slot === 'rest' ? '$@' : `$${slot}`
}

function trimBlankLines(lines: string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && lines[start].trim() === '') start++
  while (end > start && lines[end - 1].trim() === '') end--
  return lines.slice(start, end)
}

/** A parameter as shown in a synopsis and parameter list. */
export type RenderedParam = {
  label: string
  type?: string
  optional: boolean
  defaultValue?: string
  rest: boolean
  description?: string
}

/** Format a parameter for a synopsis: `name`, `[name]` or `[name...]`. */
function synopsisWord(param: RenderedParam): string {
  if (param.rest) return `[${param.label}...]`
  return param.optional ? `[${param.label}]` : param.label
}

/** A code block showing how to call a function, such as `f dir [cwd]`. */
export function renderSynopsis(name: string, params: RenderedParam[]): string {
  return ['```bash', [name, ...params.map(synopsisWord)].join(' '), '```'].join('\n')
}

/**
 * Indent continuation lines under a list item. They keep their indentation
 * relative to each other, so nested lists stay nested.
 */
function listItem(head: string, body: string | undefined): string {
  if (!body) return `- ${head}`
  const [first, ...more] = body.split('\n')
  const indent = Math.min(
    ...more.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length),
  )
  return [
    `- ${head} — ${first}`,
    ...more.map((l) => (l.trim() ? `  ${l.slice(indent)}` : '')),
  ].join('\n')
}

/** A parameter's name as written in its list item: `` `name` `` or `` `name...` ``. */
export function paramName(param: RenderedParam): string {
  return `\`${param.rest ? `${param.label}...` : param.label}\``
}

/** A parameter's type and default, such as `*path*, optional, default `$PWD``. */
export function paramNotes(param: RenderedParam): string {
  return [
    param.type ? `*${param.type}*` : null,
    param.optional && !param.rest
      ? param.defaultValue !== undefined
        ? `optional, default \`${param.defaultValue}\``
        : 'optional'
      : null,
  ]
    .filter((n): n is string => n !== null)
    .join(', ')
}

function describeParam(param: RenderedParam): string {
  const notes = paramNotes(param)
  return notes ? `${paramName(param)} ${notes}` : paramName(param)
}

const SECTION_TITLES: Record<string, string> = {
  set: 'Sets',
  stdin: 'Input',
  stdout: 'Output',
  stderr: 'Errors',
  exitcode: 'Exit codes',
  notes: 'Notes',
  example: 'Examples',
  see: 'See also',
}
const SECTION_ORDER = [
  'set',
  'stdin',
  'stdout',
  'stderr',
  'exitcode',
  'notes',
  'example',
  'see',
]

/**
 * Render documentation as Markdown: a synopsis when a signature is known,
 * then the description and the tags grouped into sections.
 */
export function renderDocComment({
  doc,
  name,
  params,
}: {
  doc: DocComment
  name: string | null
  params: RenderedParam[] | null
}): string {
  const parts: string[] = []
  if (name && params) parts.push(renderSynopsis(name, params))

  const byTag = new Map<string, DocTag[]>()
  for (const tag of doc.tags) {
    byTag.set(tag.tag, [...(byTag.get(tag.tag) ?? []), tag])
  }
  const take = (tag: string) => {
    const tags = byTag.get(tag) ?? []
    byTag.delete(tag)
    return tags
  }

  if (take('deprecated').length) parts.push('**Deprecated**')
  take('internal')
  const description = [doc.description, ...take('description').map((t) => t.text)]
    .filter((text) => text)
    .join('\n\n')
  if (description) parts.push(description)

  if (take('noargs').length) parts.push('**Parameters**: none')
  if (params?.length) {
    parts.push(
      [
        '**Parameters**',
        ...params.map((param) => listItem(describeParam(param), param.description)),
      ].join('\n'),
    )
  }

  for (const tag of SECTION_ORDER) {
    const tags = take(tag)
    if (!tags.length) continue
    const title = `**${SECTION_TITLES[tag]}**`
    if (tag === 'example') {
      const examples = tags.map((t) =>
        FENCE_LINE.test(t.text) ? t.text : ['```bash', t.text, '```'].join('\n'),
      )
      parts.push([title, ...examples].join('\n'))
    } else if (
      tag === 'notes' ||
      tag === 'stdin' ||
      tag === 'stdout' ||
      tag === 'stderr'
    ) {
      parts.push([title, ...tags.map((t) => t.text)].join('\n'))
    } else {
      parts.push([title, ...tags.map((t) => sectionItem(tag, t.text))].join('\n'))
    }
  }

  // Tags without a section of their own keep their name.
  for (const [tag, tags] of byTag) {
    for (const t of tags) parts.push(`**@${tag}**${t.text ? ` ${t.text}` : ''}`)
  }
  return parts.join('\n\n')
}

/** `@set NAME {type} text`, `@exitcode N text` and `@see target` list items. */
function sectionItem(tag: string, text: string): string {
  const match = /^(\S+)\s*(?:\{([^}]*)\}\s*)?([\s\S]*)$/.exec(text)
  if (!match) return `- ${text}`
  const [, key, type, body] = match
  if (tag === 'see') return `- \`${key}\`${body ? ` ${body}` : ''}`
  return listItem(`\`${key}\`${type ? ` *${type}*` : ''}`, body || undefined)
}
