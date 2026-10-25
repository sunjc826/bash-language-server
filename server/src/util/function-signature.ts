/**
 * Function signatures: the positional parameters a function takes, from its
 * `@arg` doc tags and, for functions marked `# bash-ide parse-func-sig`, from
 * the `local name=$N` lines that open its body.
 *
 * A marked function promises that its parameters are trivially declared: the
 * body starts with `local`/`declare` lines binding $1, $2, ... in order,
 * optionally followed by `shift N` to pass the remaining arguments on as
 * "$@", and nothing else reads or replaces the bound parameters.
 */
import * as LSP from 'vscode-languageserver/node'
import { Node as SyntaxNode } from 'web-tree-sitter'

import { parseBashIdeDirectives } from './bash-ide-directives'
import {
  commentLinesAbove,
  DocComment,
  DocParam,
  parseDocComment,
  RenderedParam,
  slotLabel,
} from './doc-comments'
import * as TreeSitterUtil from './tree-sitter'

const DIAGNOSTIC_SOURCE = 'bash-language-server'

export type FunctionSignature = {
  name: string
  /** Positional parameters in order, then the rest parameter, if any. */
  params: RenderedParam[]
}

/**
 * The signatures of the functions defined in a file, keyed by the line each
 * definition starts on, and diagnostics for `parse-func-sig` functions that
 * break their promise, doc tags that disagree with them, and directives that
 * are not directly above a function.
 */
export function getFunctionSignatures(
  rootNode: SyntaxNode,
  lines: readonly string[],
): { signatures: Map<number, FunctionSignature>; diagnostics: LSP.Diagnostic[] } {
  const signatures = new Map<number, FunctionSignature>()
  const diagnostics: LSP.Diagnostic[] = []
  const directiveRows = new Set<number>()
  const warn = ({ range, message }: SignatureProblem) =>
    diagnostics.push(
      LSP.Diagnostic.create(
        range,
        message,
        LSP.DiagnosticSeverity.Warning,
        undefined,
        DIAGNOSTIC_SOURCE,
      ),
    )

  for (const fn of rootNode.descendantsOfType('function_definition')) {
    if (!fn) continue
    const name = fn.namedChildren.find((c) => c?.type === 'word')?.text
    if (!name) continue
    const { row } = fn.startPosition
    const block = commentLinesAbove(lines, row)
    const marks = block
      ? parseBashIdeDirectives(
          lines.slice(block.startRow, row).join('\n'),
        ).directives.filter((d) => d.type === 'parse-func-sig')
      : []
    for (const mark of marks) directiveRows.add((block?.startRow ?? 0) + mark.line)
    const isMarked = marks.length > 0
    const doc = block ? parseDocComment(block.lines) : null
    if (!isMarked && !doc) continue

    const prologue = isMarked ? readPrologue(fn) : null
    const docLineRange = (line: number) => {
      const docRow = (block?.startRow ?? row) + line
      return LSP.Range.create(docRow, 0, docRow, lines[docRow]?.length ?? 0)
    }
    const { params, problems } = buildSignature({ prologue, doc, docLineRange })
    // A comment block documents the first function defined on its next line.
    if (params && !signatures.has(row)) signatures.set(row, { name, params })

    // Half-typed code is reported once it parses.
    if (fn.hasError) continue
    for (const problem of doc?.problems ?? []) {
      warn({ range: docLineRange(problem.line), message: problem.message })
    }
    for (const problem of [...(prologue?.problems ?? []), ...problems]) warn(problem)
  }

  // While a file does not parse, the function below a directive may be missing.
  const directives = rootNode.hasError
    ? []
    : parseBashIdeDirectives(lines.join('\n')).directives
  for (const directive of directives) {
    if (directive.type !== 'parse-func-sig' || directiveRows.has(directive.line)) continue
    diagnostics.push(
      LSP.Diagnostic.create(
        LSP.Range.create(directive.line, 0, directive.line, lines[directive.line].length),
        '# bash-ide parse-func-sig must be placed in the comment block directly above a function definition',
        LSP.DiagnosticSeverity.Error,
        undefined,
        DIAGNOSTIC_SOURCE,
      ),
    )
  }
  return { signatures, diagnostics }
}

const POSITION = /^[1-9][0-9]*$/
// Flags of a declaration that only bind a plain local variable.
const PARAMETER_FLAGS = /^[-+][rinxlut]+$/
const DEFAULT_OPERATORS = new Set(['-', ':-'])
const REQUIRED_OPERATORS = new Set(['?', ':?'])

export type SignatureProblem = {
  range: LSP.Range
  message: string
}

/** A parameter bound by a `local name=$N` line at the top of a function. */
export type PrologueParam = {
  position: number
  name: string
  isInteger: boolean
  isNameref: boolean
  optional: boolean
  /** Default for a missing argument; empty for `${N-}`. */
  defaultValue?: string
}

export type Prologue = {
  params: PrologueParam[]
  /** Whether the function passes arguments after its parameters on as "$@". */
  rest: boolean
  problems: SignatureProblem[]
}

/** The `function_definition` body's statements, without the braces. */
function bodyStatements(fn: SyntaxNode): SyntaxNode[] {
  const body = fn.namedChildren.find(
    (c) => c?.type === 'compound_statement' || c?.type === 'subshell',
  )
  return (body?.namedChildren ?? []).filter(
    (c): c is SyntaxNode => !!c && c.type !== 'comment',
  )
}

/** The positional parameter an expansion reads, such as 1 for `$1` or `${1:-x}`. */
function expandedPosition(node: SyntaxNode): number | null {
  if (node.type !== 'simple_expansion' && node.type !== 'expansion') return null
  const name = node.namedChildren.find((c) => c?.type === 'variable_name')
  return name && POSITION.test(name.text) ? Number(name.text) : null
}

/**
 * Read `$N`, `"$N"`, `${N}`, `${N-default}`, `${N:-default}`, `${N?msg}` or
 * `${N:?msg}`, or null for any other value.
 */
function positionalValue(
  value: SyntaxNode,
): { position: number; optional: boolean; defaultValue?: string } | null {
  if (value.type === 'string') {
    const parts = value.namedChildren
    if (parts.length !== 1 || !parts[0] || value.text !== `"${parts[0].text}"`)
      return null
    return positionalValue(parts[0])
  }
  const position = expandedPosition(value)
  if (position === null) return null
  if (value.type === 'simple_expansion') return { position, optional: false }
  // Not ${#N} or ${!N}
  if (value.children[1]?.type !== 'variable_name') return null

  // ${N} or ${N<operator>word}
  const operator = value.children.find(
    (c, i) => i > 1 && c && !c.isNamed && c.type !== '}',
  )
  if (!operator) {
    return value.namedChildren.length === 1 ? { position, optional: false } : null
  }
  if (REQUIRED_OPERATORS.has(operator.type)) return { position, optional: false }
  if (!DEFAULT_OPERATORS.has(operator.type)) return null
  const defaultValue = value.text.slice(
    operator.endIndex - value.startIndex,
    value.text.length - 1,
  )
  return { position, optional: true, defaultValue }
}

type BoundParam = {
  name: string
  node: SyntaxNode
  value: NonNullable<ReturnType<typeof positionalValue>>
}

/**
 * The parameters bound by a declaration whose every assignment is a
 * positional parameter, or null when it declares anything else.
 */
function declarationParams(statement: SyntaxNode): BoundParam[] | null {
  if (statement.type !== 'declaration_command') return null
  const keyword = statement.firstChild?.text
  if (keyword !== 'local' && keyword !== 'declare' && keyword !== 'typeset') return null

  const params: BoundParam[] = []
  for (const child of statement.namedChildren) {
    if (!child) continue
    if (child.type === 'word' && PARAMETER_FLAGS.test(child.text)) continue
    if (child.type !== 'variable_assignment' || child.namedChildCount !== 2) return null
    const name = child.namedChildren[0]
    const value = child.namedChildren[1]
    if (!name || !value || name.type !== 'variable_name') return null
    const positional = positionalValue(value)
    if (!positional) return null
    params.push({ name: name.text, node: child, value: positional })
  }
  return params.length ? params : null
}

function declarationFlags(statement: SyntaxNode): string {
  return statement.namedChildren
    .filter((c) => c?.type === 'word' && c.text.startsWith('-'))
    .map((c) => c?.text.slice(1) ?? '')
    .join('')
}

/** `shift` or `shift N` as a whole statement; the count, or null otherwise. */
function shiftCount(statement: SyntaxNode): number | null {
  if (statement.type !== 'command') return null
  const [name, ...args] = statement.namedChildren
  if (name?.type !== 'command_name' || name.text !== 'shift') return null
  if (args.length === 0) return 1
  if (args.length === 1 && args[0] && /^[0-9]+$/.test(args[0].text)) {
    return Number(args[0].text)
  }
  return null
}

/**
 * Read the parameters a function binds at the top of its body, and report
 * where the rest of the body breaks the promise that they are trivially
 * declared.
 */
export function readPrologue(fn: SyntaxNode): Prologue {
  const statements = bodyStatements(fn)
  const params: PrologueParam[] = []
  const problems: SignatureProblem[] = []

  let index = 0
  for (; index < statements.length; index++) {
    const statement = statements[index]
    const bound = declarationParams(statement)
    if (!bound) break
    const flags = declarationFlags(statement)
    for (const { name, node, value } of bound) {
      const expected = params.length + 1
      if (value.position !== expected) {
        problems.push({
          range: TreeSitterUtil.range(node),
          message: `${name} binds $${value.position}, but the next parameter is $${expected}`,
        })
        continue
      }
      params.push({
        position: value.position,
        name,
        isInteger: flags.includes('i'),
        isNameref: flags.includes('n'),
        optional: value.optional,
        defaultValue: value.defaultValue,
      })
    }
  }

  // After `shift N` for the N bound parameters, the positional parameters
  // are the remaining arguments, which the body may read and shift freely.
  const shift = statements[index] ? shiftCount(statements[index]) : null
  const isShifted = params.length > 0 && shift === params.length
  if (isShifted) index++
  // Without parameters, "$@" holds every argument.
  let passesAll = false

  const report = (node: SyntaxNode, message: string) =>
    problems.push({ range: TreeSitterUtil.range(node), message })
  const readsAll = (node: SyntaxNode, what: string) => {
    if (isShifted) return
    if (params.length === 0) passesAll = true
    else {
      report(
        node,
        `${what} still holds ${boundRange(params)}; add shift ${
          params.length
        } after the local lines`,
      )
    }
  }

  const visit = (node: SyntaxNode) => {
    // A nested function has positional parameters of its own.
    if (node.type === 'function_definition') return
    if (node.type === 'command') {
      const name = node.firstNamedChild
      const args = node.namedChildren.slice(1).filter((c): c is SyntaxNode => !!c)
      if (name?.type === 'command_name' && name.text === 'shift' && !isShifted) {
        report(
          node,
          'shift changes the positional parameters bound at the top of the function',
        )
      }
      if (name?.type === 'command_name' && name.text === 'set') {
        const first = args.find((a) => a.type !== 'comment')
        if (first && (first.text === '--' || !/^[-+]/.test(first.text))) {
          report(
            node,
            'set replaces the positional parameters bound at the top of the function',
          )
        }
      }
    }
    if (node.type === 'for_statement' && !node.children.some((c) => c?.type === 'in')) {
      readsAll(node, 'for without in loops over "$@", which')
    }
    if (node.type === 'simple_expansion' || node.type === 'expansion') {
      const position = expandedPosition(node)
      const special = node.namedChildren.find((c) => c?.type === 'special_variable_name')
      if (position !== null && !isShifted) {
        report(
          node,
          `$${position} is read directly; bind parameters with local lines at the top of the function`,
        )
      } else if (special && (special.text === '@' || special.text === '*')) {
        readsAll(node, `"$${special.text}"`)
      }
    }
    for (const child of node.children) if (child) visit(child)
  }
  for (const statement of statements.slice(index)) visit(statement)

  return { params, rest: isShifted || passesAll, problems }
}

function boundRange(params: PrologueParam[]): string {
  return params.length === 1 ? '$1' : `$1-$${params.length}`
}

/**
 * The signature to show for a function: from its prologue when it is marked
 * `parse-func-sig`, described by its `@arg` tags, or from the tags alone.
 * Reports where the tags disagree with the prologue.
 */
export function buildSignature({
  prologue,
  doc,
  docLineRange,
}: {
  prologue: Prologue | null
  doc: DocComment | null
  docLineRange: (line: number) => LSP.Range
}): { params: RenderedParam[] | null; problems: SignatureProblem[] } {
  const problems: SignatureProblem[] = []
  const docParams = doc?.params ?? []
  const docRest = docParams.find((p) => p.slot === 'rest')
  const noArgs = doc?.tags.find((t) => t.tag === 'noargs')
  const bySlot = new Map<number | 'rest', DocParam>(docParams.map((p) => [p.slot, p]))
  const report = (param: DocParam | { line: number }, message: string) =>
    problems.push({ range: docLineRange(param.line), message })

  if (prologue) {
    const isDocumented = docParams.length > 0 || !!noArgs
    if (noArgs && (prologue.params.length > 0 || prologue.rest)) {
      report(noArgs, '@noargs, but the function takes parameters')
    }
    const params: RenderedParam[] = prologue.params.map((param) => {
      const docParam = bySlot.get(param.position)
      if (isDocumented && !docParam && !noArgs) {
        problems.push({
          range: docLineRange(docParams[docParams.length - 1]?.line ?? 0),
          message: `$${param.position} (${param.name}) has no @arg`,
        })
      }
      if (docParam) checkDocParam(docParam, param, (message) => report(docParam, message))
      return {
        label: param.name,
        type:
          docParam?.type ??
          (param.isInteger ? 'int' : param.isNameref ? 'var' : undefined),
        optional: param.optional,
        defaultValue: param.defaultValue || undefined,
        rest: false,
        description: docParam?.description || undefined,
      }
    })
    for (const docParam of docParams) {
      if (docParam.slot !== 'rest' && docParam.slot > prologue.params.length) {
        report(
          docParam,
          `@arg $${docParam.slot} is not bound by the function, which takes ${
            prologue.params.length ? boundRange(prologue.params) : 'no parameters'
          }`,
        )
      }
    }
    if (docRest && !prologue.rest) {
      report(
        docRest,
        '@arg $@, but the function does not pass further arguments on as "$@"',
      )
    }
    if (prologue.rest) {
      if (isDocumented && !docRest && !noArgs) {
        problems.push({
          range: docLineRange(docParams[docParams.length - 1]?.line ?? 0),
          message: 'The function takes further arguments as "$@", which have no @arg $@',
        })
      }
      params.push(restParam(docRest))
    }
    return { params, problems }
  }

  if (docParams.length === 0) return { params: noArgs ? [] : null, problems }
  const params: RenderedParam[] = docParams
    .filter((p): p is DocParam & { slot: number } => p.slot !== 'rest')
    .sort((a, b) => a.slot - b.slot)
    .map((p) => ({
      label: p.name ?? slotLabel(p.slot),
      type: p.type,
      optional: p.optional,
      defaultValue: p.defaultValue,
      rest: false,
      description: p.description || undefined,
    }))
  if (docRest) params.push(restParam(docRest))
  return { params, problems }
}

function restParam(doc: DocParam | undefined): RenderedParam {
  return {
    label: doc?.name ?? 'args',
    type: doc?.type,
    optional: true,
    rest: true,
    description: doc?.description || undefined,
  }
}

/** Report where an `@arg` tag disagrees with the parameter the body binds. */
function checkDocParam(
  doc: DocParam,
  param: PrologueParam,
  report: (message: string) => void,
): void {
  const slot = `@arg $${param.position}`
  if (doc.name !== undefined && doc.name !== param.name) {
    report(`${slot} is named ${doc.name}, but the function binds it to ${param.name}`)
  }
  if (doc.optional && !param.optional) {
    report(`${slot} is optional, but ${param.name} has no default`)
  } else if (doc.name !== undefined && !doc.optional && param.optional) {
    report(`${slot} is required, but ${param.name} has a default`)
  }
  if (
    doc.defaultValue !== undefined &&
    param.defaultValue !== undefined &&
    doc.defaultValue !== param.defaultValue
  ) {
    report(
      `${slot} defaults to ${doc.defaultValue}, but ${param.name} defaults to ${param.defaultValue}`,
    )
  }
  if (param.isInteger && doc.type !== undefined && doc.type !== 'int') {
    report(`${slot} is {${doc.type}}, but ${param.name} is declared with local -i`)
  }
  if (param.isNameref && doc.type !== undefined && !doc.type.startsWith('var')) {
    report(`${slot} is {${doc.type}}, but ${param.name} is a nameref (local -n)`)
  }
}
