import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as LSP from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { Parser } from 'web-tree-sitter'

import { getMockConnection } from '../../../testing/mocks'
import Analyzer from '../analyser'
import { initializeParser } from '../parser'
import BashServer from '../server'
import { parseDocComment, renderDocComment } from '../util/doc-comments'

const uri = 'file:///function-signatures.sh'
let parser: Parser
beforeAll(async () => {
  parser = await initializeParser()
})
afterAll(() => parser.delete())

function analyze(source: string) {
  const analyzer = new Analyzer({ parser, workspaceFolder: null })
  const document = TextDocument.create(uri, 'shellscript', 1, source)
  const diagnostics = analyzer.analyze({ uri, document })
  return { analyzer, diagnostics }
}

/** Diagnostics as `line: message`, 1-based like an editor shows them. */
function problems(source: string): string[] {
  return analyze(source).diagnostics.map(
    (d) =>
      `${d.range.start.line + 1}: ${
        typeof d.message === 'string' ? d.message : d.message.value
      }`,
  )
}

/** Strip the `# ` of each line, as the comment block above a declaration. */
const comment = (...lines: string[]) => lines.map((line) => line.replace(/^# ?/, ''))

describe('parseDocComment', () => {
  it('returns null without tags, so plain comments stay as they are', () => {
    expect(parseDocComment(comment('# Just a comment', '# @ not a tag'))).toBeNull()
  })

  it('collects tag text until the next tag, including Markdown lists', () => {
    const doc = parseDocComment(
      comment(
        '# Convert a path.',
        '#',
        '# @arg $1 {path} dir Path to convert, which may',
        '#   be relative',
        '# @arg $2 {path} [cwd=$PWD] Base directory:',
        '#   - absolute',
        '#   - or relative',
        '# @set BU_RET {path} The absolute path',
      ),
    )
    expect(doc?.description).toBe('Convert a path.')
    expect(doc?.params).toMatchObject([
      {
        slot: 1,
        type: 'path',
        name: 'dir',
        optional: false,
        description: 'Path to convert, which may\n  be relative',
      },
      {
        slot: 2,
        name: 'cwd',
        optional: true,
        defaultValue: '$PWD',
        description: 'Base directory:\n  - absolute\n  - or relative',
      },
    ])
    expect(doc?.tags).toMatchObject([
      { tag: 'set', text: 'BU_RET {path} The absolute path' },
    ])
    expect(doc?.problems).toEqual([])
  })

  it('does not read tags inside code fences or directives as documentation', () => {
    const doc = parseDocComment(
      comment(
        '# @example',
        '# ```bash',
        '# @arg $1 is not a tag here',
        '# ```',
        '# bash-ide parse-func-sig',
      ),
    )
    expect(doc?.params).toEqual([])
    expect(doc?.tags).toEqual([
      { tag: 'example', text: '```bash\n@arg $1 is not a tag here\n```', line: 0 },
    ])
  })

  it('reads the plain shdoc form, which names no parameter', () => {
    expect(parseDocComment(comment('# @arg $1 string A name'))?.params).toMatchObject([
      { slot: 1, type: 'string', description: 'A name' },
    ])
  })

  it('reads rest parameters', () => {
    expect(
      parseDocComment(comment('# @arg $@ {string} words... Words'))?.params,
    ).toMatchObject([{ slot: 'rest', name: 'words', description: 'Words' }])
  })

  it.each([
    ['# @arg 1 string x', '@arg must start with a parameter such as $1 or $@'],
    ['# @arg $1 {path', '@arg type is missing its closing }'],
    ['# @arg $1 {path}', '@arg $1 {path} needs a parameter name after the type'],
  ])('reports a malformed tag: %s', (line, message) => {
    expect(parseDocComment(comment(line))?.problems).toEqual([{ line: 0, message }])
  })

  it('reports repeated and missing positions', () => {
    const doc = parseDocComment(
      comment('# @arg $1 {string} a', '# @arg $1 {string} b', '# @arg $3 {string} c'),
    )
    expect(doc?.problems.map((p) => p.message)).toEqual([
      '@arg $1 is documented more than once',
      '@arg $2 is missing before $3',
    ])
  })
})

describe('renderDocComment', () => {
  it('renders each tag on its own, with a synopsis and indented continuations', () => {
    const doc = parseDocComment(
      comment(
        '# Convert a path.',
        '# @arg $1 {path} dir Path to convert, which may',
        '#   be relative',
        '# @arg $2 {path} [cwd=$PWD] Base directory',
        '# @arg $@ {string} parts... Parts:',
        '#   - first',
        '#     - nested',
        '# @set BU_RET {path} The absolute path',
        '# @exitcode 0 Always',
        '# @notes',
        '# - Does not resolve symlinks',
        '# @example',
        '# bu_realpath ../dir',
        '# @custom tag text',
      ),
    )
    expect(doc).not.toBeNull()
    expect(
      renderDocComment({
        doc: doc!,
        name: 'bu_realpath',
        params: [
          {
            label: 'dir',
            type: 'path',
            optional: false,
            rest: false,
            description: 'Path',
          },
          {
            label: 'cwd',
            type: 'path',
            optional: true,
            defaultValue: '$PWD',
            rest: false,
            description: 'Base directory',
          },
          {
            label: 'parts',
            type: 'string',
            optional: true,
            rest: true,
            description: 'Parts:\n  - first\n    - nested',
          },
        ],
      }),
    ).toMatchInlineSnapshot(`
      "\`\`\`bash
      bu_realpath dir [cwd] [parts...]
      \`\`\`

      Convert a path.

      **Parameters**
      - \`dir\` *path* — Path
      - \`cwd\` *path*, optional, default \`$PWD\` — Base directory
      - \`parts...\` *string* — Parts:
        - first
          - nested

      **Sets**
      - \`BU_RET\` *path* — The absolute path

      **Exit codes**
      - \`0\` — Always

      **Notes**
      - Does not resolve symlinks

      **Examples**
      \`\`\`bash
      bu_realpath ../dir
      \`\`\`

      **@custom** tag text"
    `)
  })
})

const REALPATH = [
  '# Convert a path to an absolute path.',
  '# @arg $1 {path} dir Path to convert',
  '# @arg $2 {path} [cwd=$PWD] Base directory',
  '# bash-ide parse-func-sig',
  'bu_realpath()',
  '{',
  '    local -r dir=$1',
  '    local -r cwd=${2:-$PWD}',
  '    BU_RET=$cwd/$dir',
  '}',
]

describe('parse-func-sig', () => {
  it('reads the parameters bound at the top of the function', () => {
    const { analyzer, diagnostics } = analyze(REALPATH.join('\n'))
    expect(diagnostics).toEqual([])
    expect(analyzer.getFunctionSignature(uri, 4)).toEqual({
      name: 'bu_realpath',
      params: [
        {
          label: 'dir',
          type: 'path',
          optional: false,
          rest: false,
          description: 'Path to convert',
        },
        {
          label: 'cwd',
          type: 'path',
          optional: true,
          defaultValue: '$PWD',
          rest: false,
          description: 'Base directory',
        },
      ],
    })
  })

  it('reads several parameters per line, quoted values, flags and shift', () => {
    const { analyzer, diagnostics } = analyze(
      [
        '# bash-ide parse-func-sig',
        'f() {',
        '    local -r a=$1 b="$2"',
        '    local -n out=${3}',
        '    local -ri count=${4-}',
        '    shift 4',
        '    for word; do out+=("$word" "$1"); done',
        '    shift',
        '}',
      ].join('\n'),
    )
    expect(diagnostics).toEqual([])
    expect(analyzer.getFunctionSignature(uri, 1)?.params).toEqual([
      { label: 'a', optional: false, rest: false },
      { label: 'b', optional: false, rest: false },
      { label: 'out', type: 'var', optional: false, rest: false },
      { label: 'count', type: 'int', optional: true, rest: false },
      { label: 'args', optional: true, rest: true },
    ])
  })

  it('takes "$@" as the rest parameter of a function without parameters', () => {
    const { analyzer, diagnostics } = analyze(
      '# bash-ide parse-func-sig\nf() { printf "%s\\n" "$@" "$#"; }',
    )
    expect(diagnostics).toEqual([])
    expect(analyzer.getFunctionSignature(uri, 1)?.params).toEqual([
      { label: 'args', optional: true, rest: true },
    ])
  })

  it('does not count the parameters of a nested function', () => {
    expect(
      problems(
        [
          '# bash-ide parse-func-sig',
          'f() {',
          '    local -r a=$1',
          '    g() { echo "$1" "$@"; }',
          '}',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it.each([
    [
      'a later read of a bound parameter',
      ['local -r color=$1', 'local -r frame=$(( $2 + 1 ))'],
      [
        '4: $2 is read directly; bind parameters with local lines at the top of the function',
      ],
    ],
    [
      'a statement before the local lines',
      ['echo start', 'local -r a=$1'],
      [
        '4: $1 is read directly; bind parameters with local lines at the top of the function',
      ],
    ],
    [
      'parameters bound out of order',
      ['local -r a=$2'],
      ['3: a binds $2, but the next parameter is $1'],
    ],
    [
      '"$@" without shift',
      ['local -r a=$1', 'echo "$@"'],
      ['4: "$@" still holds $1; add shift 1 after the local lines'],
    ],
    [
      'for without in and without shift',
      ['local -r a=$1 b=$2', 'for x; do :; done'],
      [
        '4: for without in loops over "$@", which still holds $1-$2; add shift 2 after the local lines',
      ],
    ],
    [
      'shift by a different count',
      ['local -r a=$1 b=$2', 'shift'],
      ['4: shift changes the positional parameters bound at the top of the function'],
    ],
    [
      'set --',
      ['local -r a=$1', 'shift', 'set -- x'],
      ['5: set replaces the positional parameters bound at the top of the function'],
    ],
  ])('reports %s', (_name, body, expected) => {
    expect(
      problems(
        ['# bash-ide parse-func-sig', 'f() {', ...body.map((l) => `  ${l}`), '}'].join(
          '\n',
        ),
      ),
    ).toEqual(expected)
  })

  it('accepts the README example', () => {
    expect(
      problems(
        [
          '# @arg $1 {path} dir Path to convert',
          '# @arg $2 {path} [cwd=$PWD] Base directory',
          '# @arg $@ {string} parts... Further parts',
          '# bash-ide parse-func-sig',
          'bu_realpath() {',
          '    local -r dir=$1          # $1, "$1", ${1}',
          '    local -r cwd=${2:-$PWD}  # optional: ${N-x}, ${N:-x}; required: ${N?msg}, ${N:?msg}',
          '    shift 2                  # optional: the rest of "$@" is a further parameter',
          '    echo "$@"',
          '}',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('accepts set options, which keep the positional parameters', () => {
    expect(
      problems('# bash-ide parse-func-sig\nf() {\n  local -r a=$1\n  set -e\n}'),
    ).toEqual([])
  })

  it('reports a directive that is not directly above a function', () => {
    const { diagnostics } = analyze('# bash-ide parse-func-sig\n\nf() { :; }')
    expect(diagnostics).toMatchObject([
      {
        range: { start: { line: 0 } },
        severity: LSP.DiagnosticSeverity.Error,
        message:
          '# bash-ide parse-func-sig must be placed in the comment block directly above a function definition',
      },
    ])
  })

  it('reports nothing while the function does not parse', () => {
    expect(
      problems('# bash-ide parse-func-sig\nf() {\n  local -r a=$1\n  echo "$2" "$(\n}'),
    ).toEqual([])
  })

  it('does not read the prologue of an unmarked function', () => {
    const { analyzer, diagnostics } = analyze('# A comment\nf() {\n  local -r a=$1\n}')
    expect(diagnostics).toEqual([])
    expect(analyzer.getFunctionSignature(uri, 1)).toBeNull()
  })
})

describe('doc tags and the prologue', () => {
  it.each([
    [
      'a different name',
      ['# @arg $1 {path} file x'],
      ['local -r dir=$1'],
      ['2: @arg $1 is named file, but the function binds it to dir'],
    ],
    [
      'an optional tag for a required parameter',
      ['# @arg $1 {path} [dir] x'],
      ['local -r dir=$1'],
      ['2: @arg $1 is optional, but dir has no default'],
    ],
    [
      'a required tag for an optional parameter',
      ['# @arg $1 {path} dir x'],
      ['local -r dir=${1:-.}'],
      ['2: @arg $1 is required, but dir has a default'],
    ],
    [
      'a different default',
      ['# @arg $1 {path} [dir=/] x'],
      ['local -r dir=${1:-.}'],
      ['2: @arg $1 defaults to /, but dir defaults to .'],
    ],
    [
      'an undocumented parameter',
      ['# @arg $1 {path} dir x'],
      ['local -r dir=$1 cwd=$2'],
      ['2: $2 (cwd) has no @arg'],
    ],
    [
      'a tag for a parameter the function does not bind',
      ['# @arg $1 {path} dir x', '# @arg $2 {path} cwd y'],
      ['local -r dir=$1'],
      ['3: @arg $2 is not bound by the function, which takes $1'],
    ],
    [
      'a rest tag without shift',
      ['# @arg $1 {path} dir x', '# @arg $@ {string} more... y'],
      ['local -r dir=$1'],
      ['3: @arg $@, but the function does not pass further arguments on as "$@"'],
    ],
    [
      'an undocumented rest parameter',
      ['# @arg $1 {path} dir x'],
      ['local -r dir=$1', 'shift', 'echo "$@"'],
      ['2: The function takes further arguments as "$@", which have no @arg $@'],
    ],
    [
      'a type that is not int for local -i',
      ['# @arg $1 {string} n x'],
      ['local -i n=$1'],
      ['2: @arg $1 is {string}, but n is declared with local -i'],
    ],
    [
      'a type that is not var for a nameref',
      ['# @arg $1 {string} out x'],
      ['local -n out=$1'],
      ['2: @arg $1 is {string}, but out is a nameref (local -n)'],
    ],
    [
      '@noargs for a function with parameters',
      ['# @noargs'],
      ['local -r a=$1'],
      ['2: @noargs, but the function takes parameters'],
    ],
  ])('reports %s', (_name, docs, body, expected) => {
    expect(
      problems(
        [
          '# Description',
          ...docs,
          '# bash-ide parse-func-sig',
          'f() {',
          ...body.map((l) => `  ${l}`),
          '}',
        ].join('\n'),
      ),
    ).toEqual(expected)
  })

  it('accepts a variable type for a name passed without a nameref', () => {
    expect(
      problems(
        [
          '# @arg $1 {path} file x',
          '# @arg $2 {var:array} [ret=BU_RET] y',
          '# bash-ide parse-func-sig',
          'f() {',
          '  local file=$1',
          '  local ret=${2:-BU_RET}',
          '}',
        ].join('\n'),
      ),
    ).toEqual([])
  })

  it('takes the signature from the tags of an unmarked function', () => {
    const { analyzer, diagnostics } = analyze(
      [
        '# @arg $1 {string} color Color code',
        '# @arg $2 {int} frame Frame',
        '# @arg $@ {string} message... Message',
        'f() {',
        '  local -r frame=$(( $2 + 1 ))',
        '}',
      ].join('\n'),
    )
    expect(diagnostics).toEqual([])
    expect(analyzer.getFunctionSignature(uri, 3)?.params.map((p) => p.label)).toEqual([
      'color',
      'frame',
      'message',
    ])
  })

  it('names undocumented positions by their parameter in the plain shdoc form', () => {
    const { analyzer } = analyze('# @arg $1 string Name\nf() { :; }')
    expect(analyzer.getFunctionSignature(uri, 1)?.params.map((p) => p.label)).toEqual([
      '$1',
    ])
  })

  it('shows a synopsis above an untagged comment of a marked function', () => {
    const { analyzer } = analyze(
      '# Join words.\n# bash-ide parse-func-sig\nf() {\n  local -r sep=$1\n  shift\n  echo "$@"\n}',
    )
    expect(analyzer.commentsAbove(uri, 2)).toBe(
      '```bash\nf sep [args...]\n```\n\nJoin words.',
    )
  })
})

describe('hover', () => {
  async function hover(source: string, line: number, character: number) {
    const connection = getMockConnection()
    const server = await BashServer.initialize(connection, {
      rootPath: null,
      rootUri: null,
      processId: 42,
      capabilities: {},
      workspaceFolders: null,
      initializationOptions: { backgroundAnalysisMaxFiles: 0, shellcheckPath: '' },
    })
    server.register(connection)
    await connection.onInitialized.mock.calls[0][0]({})
    await server.analyzeAndLintDocument(
      TextDocument.create(uri, 'shellscript', 1, source),
    )
    const result = await connection.onHover.mock.calls[0][0](
      { textDocument: { uri }, position: { line, character } },
      {} as any,
      {} as any,
      undefined,
    )
    if (!result || !('contents' in result)) return null
    return (result.contents as LSP.MarkupContent).value
  }

  const source = [
    ...REALPATH,
    '# @arg $1 {string} sep Separator',
    '# @arg $@ {string} words... Words to join',
    '# bash-ide parse-func-sig',
    'join() {',
    '  local -r sep=$1',
    '  shift',
    '  echo "$@"',
    '}',
    'bu_realpath ../dir /home',
    'join , a b',
    'join "$@" a',
    'bu_realpath a b c',
  ]
  const callLine = source.indexOf('bu_realpath ../dir /home')

  it('describes the parameter an argument fills', async () => {
    expect(await hover(source.join('\n'), callLine, 20)).toMatchInlineSnapshot(`
      "Argument \`cwd\` of \`bu_realpath\` (*path*, optional, default \`$PWD\`)

      Base directory"
    `)
  })

  it('describes arguments of the rest parameter', async () => {
    expect(await hover(source.join('\n'), callLine + 1, 9)).toMatchInlineSnapshot(`
      "Argument \`words...\` of \`join\` (*string*)

      Words to join"
    `)
  })

  it('reports an argument the function does not take', async () => {
    expect(await hover(source.join('\n'), callLine + 3, 16)).toMatchInlineSnapshot(
      `"Extra argument: \`bu_realpath\` takes 2 arguments"`,
    )
  })

  it('does not guess the parameter after an argument of unknown length', async () => {
    expect((await hover(source.join('\n'), callLine + 2, 10)) ?? '').not.toContain(
      'Argument',
    )
  })

  it('shows the synopsis and tags on the function name', async () => {
    expect(await hover(source.join('\n'), callLine, 3)).toMatchInlineSnapshot(`
      "Function: **bu_realpath** - *defined on line 5*

      \`\`\`bash
      bu_realpath dir [cwd]
      \`\`\`

      Convert a path to an absolute path.

      **Parameters**
      - \`dir\` *path* — Path to convert
      - \`cwd\` *path*, optional, default \`$PWD\` — Base directory"
    `)
  })
})
