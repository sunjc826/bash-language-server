import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest'
import * as childProcess from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import * as LSP from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'

import { getMockConnection } from '../../../testing/mocks'
import Analyzer from '../analyser'
import LspServer from '../server'
import { CompletionItemDataType } from '../types'
import { FigCommand, FigSpecs } from '../util/fig-options'
import * as sh from '../util/sh'

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}))

const SPECS: Record<string, FigCommand> = {
  git: {
    name: ['git'],
    options: [
      { name: ['-C'], description: 'Run as if started in <path>', argCount: 1 },
      { name: ['--no-pager'], description: 'Do not pipe output into a pager' },
      { name: ['--verbose'], description: 'Be verbose', isPersistent: true },
    ],
    subcommands: [
      {
        name: ['commit', 'ci'],
        description: 'Record changes to the repository',
        options: [
          { name: ['-m', '--message'], description: 'Commit message', argCount: 1 },
          { name: ['-a', '--all'], description: 'Stage all changes' },
          { name: ['--amend'], description: 'Amend the previous commit' },
        ],
      },
      { name: ['remote'], loadSpec: 'git/remote' },
      { name: ['escape'], loadSpec: '../outside' },
    ],
  },
  'git/remote': {
    name: ['remote'],
    options: [{ name: ['--add'], description: 'Add a remote' }],
  },
  outside: { name: ['outside'], options: [{ name: ['--leak'] }] },
  pack: {
    name: ['pack'],
    options: [
      { name: ['-x'], description: 'Extract' },
      { name: ['-z'], description: 'Gzip' },
      { name: ['-f'], description: 'Archive file', argCount: 1 },
    ],
  },
  // Shaped like the real tar spec: modes are dash-prefixed subcommands that
  // hold the flags, and top-level flags apply in every mode.
  tar: {
    name: ['tar'],
    subcommands: [
      {
        name: ['x', '-x', '--extract'],
        description: 'Extract files from an archive',
        options: [
          { name: ['z', '-z', '--gzip'], description: 'Filter through gzip' },
          {
            name: ['f', '-f', '--file'],
            description: 'Archive file',
            argCount: 1,
            args: [{ name: 'ARCHIVE' }],
          },
          { name: ['--strip-components'], argCount: 1 },
        ],
      },
      {
        name: ['c', '-c', '--create'],
        description: 'Create a new archive',
        options: [
          { name: ['f', '-f', '--file'], description: 'Archive file', argCount: 1 },
        ],
      },
    ],
    options: [
      { name: ['v', '-v', '--verbose'], description: 'Verbose', isPersistent: true },
    ],
  },
  cp: {
    name: ['cp'],
    options: [{ name: ['-r'], description: 'Copy directories recursively' }],
    args: [
      { name: 'source', isVariadic: true },
      { name: 'target', description: 'Where to copy to' },
    ],
  },
  sudo: {
    name: ['sudo'],
    options: [{ name: ['-u'], argCount: 1, args: [{ name: 'user' }] }],
    args: [{ name: 'command', isCommand: true }],
  },
  go: {
    name: ['go'],
    posixNoncompliant: true,
    options: [
      { name: ['-C'], description: 'Change directory', argCount: 1 },
      { name: ['-Cx'], description: 'Not an argument-taking flag' },
      { name: ['-x'], description: 'Print commands' },
    ],
  },
}

let specDirectory: string

beforeAll(() => {
  const root = mkdtempSync(path.join(tmpdir(), 'bash-lsp-fig-'))
  specDirectory = path.join(root, 'specs')
  for (const [key, spec] of Object.entries(SPECS)) {
    const file = path.join(key === 'outside' ? root : specDirectory, `${key}.json`)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(spec))
  }
})

afterAll(() => rmSync(path.dirname(specDirectory), { recursive: true, force: true }))

const names = (words: string[], prefix: string) =>
  new FigSpecs(specDirectory).getOptions(words, prefix)?.map((o) => o.name) ?? null

describe('FigSpecs.getOptions', () => {
  it('returns null when there is no spec for the command', () => {
    expect(names(['missing'], '-')).toBeNull()
  })

  it.each(['', '../specs/git', 'specs/git', './git', '$GIT', 'git;id'])(
    'rejects command name %j',
    (name) => {
      expect(names([name], '-')).toBeNull()
    },
  )

  it('suggests top-level options with descriptions', () => {
    expect(new FigSpecs(specDirectory).getOptions(['git'], '--')).toEqual([
      { name: '--no-pager', description: 'Do not pipe output into a pager' },
      { name: '--verbose', description: 'Be verbose' },
    ])
  })

  it('descends into subcommands and keeps persistent options', () => {
    expect(names(['git', 'commit'], '-')).toEqual([
      '-m',
      '--message',
      '-a',
      '--all',
      '--amend',
      '--verbose',
    ])
    expect(names(['git', 'ci'], '--a')).toEqual(['--all', '--amend'])
  })

  it('skips option arguments so they are not taken as subcommands', () => {
    expect(names(['git', '-C', 'commit'], '--a')).toEqual([])
    expect(names(['git', '-C', 'repo', 'commit'], '--a')).toEqual(['--all', '--amend'])
    expect(names(['git', '-C=repo', 'commit'], '--a')).toEqual(['--all', '--amend'])
    expect(names(['git', 'commit', '-m', 'remote'], '--a')).toEqual(['--all', '--amend'])
    // -C takes the rest of the word as its value.
    expect(names(['git', '-Crepo', 'commit'], '--a')).toEqual(['--all', '--amend'])
  })

  it('suggests and descends into dash-prefixed subcommands', () => {
    expect(new FigSpecs(specDirectory).getOptions(['tar'], '--e')).toEqual([
      { name: '--extract', description: 'Extract files from an archive' },
    ])
    expect(names(['tar', '--extract'], '--')).toEqual([
      '--gzip',
      '--file',
      '--strip-components',
      '--verbose',
    ])
  })

  it('treats the last chained short flag as taking an argument', () => {
    expect(names(['pack', '-xzf', '-'], '-')).toEqual(['-x', '-z', '-f'])
    expect(names(['pack', '-xzf', 'archive.tgz', '--'], '-')).toEqual([])
  })

  it('enters the mode named in a group of short flags', () => {
    for (const group of ['-xzf', '-zxf', '-xvzf']) {
      expect(names(['tar', group, 'archive.tgz'], '--s')).toEqual(['--strip-components'])
    }
    // The archive name is -f's value, not a mode.
    expect(names(['tar', '-xf', '-c'], '--s')).toEqual(['--strip-components'])
    expect(names(['tar', '-cf', 'out.tar'], '--s')).toEqual([])
  })

  it('does not split single-dash options for POSIX-noncompliant specs', () => {
    const specs = new FigSpecs(specDirectory)
    // -Cx is its own flag, so the following word is not consumed as its value.
    expect(specs.getOptions(['go', '-Cx', '--'], '-')).toEqual([])
    expect(specs.getOptions(['go', '-C', '--'], '-')?.length).toBe(3)
  })

  it('loads subcommands from other spec files', () => {
    expect(names(['git', 'remote'], '--')).toEqual(['--add', '--verbose'])
  })

  it('ignores loadSpec references outside the spec directory', () => {
    expect(names(['git', 'escape'], '--')).toEqual(['--verbose'])
  })

  it('stops suggesting options after --', () => {
    expect(names(['git', 'commit', '--'], '-')).toEqual([])
  })
})

describe('FigSpecs.describeOption', () => {
  const describeNames = (words: string[], word: string) =>
    new FigSpecs(specDirectory)
      .describeOption(words, word)
      ?.map((o) => o.description ?? o.name.join()) ?? null

  it('describes options of the subcommand the words reach', () => {
    expect(describeNames(['git', '-C', 'repo', 'commit'], '--amend')).toEqual([
      'Amend the previous commit',
    ])
    expect(describeNames(['git', 'commit'], '-m')).toEqual(['Commit message'])
    expect(describeNames(['git', 'commit'], '--message=fix')).toEqual(['Commit message'])
    expect(describeNames(['git', 'commit'], '--verbose')).toEqual(['Be verbose'])
    expect(describeNames(['tar'], '--extract')).toEqual(['Extract files from an archive'])
  })

  it('describes each flag of a chained short option', () => {
    expect(describeNames(['pack'], '-xzf')).toEqual(['Extract', 'Gzip', 'Archive file'])
    // Everything after a flag that takes an argument is its value.
    expect(describeNames(['pack'], '-fxz')).toEqual(['Archive file'])
    expect(describeNames(['go'], '-Cx')).toEqual(['Not an argument-taking flag'])
  })

  it('describes a tar mode and the flags grouped with it', () => {
    expect(describeNames(['tar'], '-xvzf')).toEqual([
      'Extract files from an archive',
      'Verbose',
      'Filter through gzip',
      'Archive file',
    ])
    expect(describeNames(['tar'], '-cf')).toEqual([
      'Create a new archive',
      'Archive file',
    ])
  })

  it('finds nothing for unknown options, operands and commands without a spec', () => {
    expect(describeNames(['git', 'commit'], '--nope')).toEqual([])
    expect(describeNames(['git', 'commit', '--'], '--all')).toEqual([])
    expect(describeNames(['missing'], '--all')).toBeNull()
  })
})

describe('FigSpecs.describeArgument', () => {
  const describe_ = (words: string[], index: number) =>
    new FigSpecs(specDirectory).describeArgument(words, index)

  it('maps arguments to slots, counting slots after a variadic one from the end', () => {
    expect(describe_(['cp', 'a', 'b', 'c'], 1)).toMatchObject({ name: 'source' })
    expect(describe_(['cp', 'a', 'b', 'c'], 2)).toMatchObject({ name: 'source' })
    expect(describe_(['cp', '-r', 'a', 'b', 'c'], 4)).toEqual({
      kind: 'argument',
      name: 'target',
      description: 'Where to copy to',
    })
    // After --, a dash-prefixed word is an argument too.
    expect(describe_(['cp', '--', '-x', 'y'], 2)).toMatchObject({ name: 'source' })
    expect(describe_(['cp', '-r', 'a'], 1)).toBeNull()
  })

  it('describes option values and subcommands', () => {
    expect(describe_(['tar', '-xzf', 'a.tgz', 'member'], 2)).toEqual({
      kind: 'value',
      option: '-f',
      name: 'ARCHIVE',
    })
    expect(describe_(['git', '-C', 'repo', 'ci'], 3)).toEqual({
      kind: 'subcommand',
      name: 'ci',
      description: 'Record changes to the repository',
    })
    // A subcommand name in an argument position is just an argument.
    expect(describe_(['git', 'commit', '-m', 'commit'], 3)).toMatchObject({
      kind: 'value',
      option: '-m',
    })
  })

  it('follows a nested command such as sudo git', () => {
    const words = ['sudo', '-u', 'root', 'git', 'commit', '--a']
    expect(describe_(words, 2)).toMatchObject({ kind: 'value', name: 'user' })
    expect(describe_(words, 3)).toBeNull()
    expect(describe_(words, 4)).toMatchObject({ kind: 'subcommand', name: 'commit' })
    expect(names(words.slice(0, 5), '--a')).toEqual(['--all', '--amend'])
    expect(names(['sudo', 'missing'], '-')).toBeNull()
  })
})

describe('option completion', () => {
  afterEach(() => vi.restoreAllMocks())

  async function complete(text: string, line: number, character: number) {
    const connection = getMockConnection()
    const server = await LspServer.initialize(connection, {
      rootUri: null,
      processId: null,
      capabilities: {},
    })
    server.register(connection)
    const document = TextDocument.create('file:///options.sh', 'shellscript', 1, text)
    await server.analyzeAndLintDocument(document)
    return connection.onCompletion.mock.calls[0][0](
      { textDocument: { uri: document.uri }, position: { line, character } },
      {} as any,
      {} as any,
    )
  }

  it('uses Fig options with descriptions and the words before the cursor', async () => {
    const getOptions = vi
      .spyOn(FigSpecs.prototype, 'getOptions')
      .mockReturnValue([{ name: '--amend', description: 'Amend the previous commit' }])
    const spawn = vi.spyOn(childProcess, 'spawnSync')

    const result = await complete('git -C repo \\\n  commit --am other\n', 1, 13)

    expect(getOptions).toHaveBeenCalledWith(['git', '-C', 'repo', 'commit'], '--am')
    expect(spawn).not.toHaveBeenCalled()
    expect(result).toEqual(
      expect.arrayContaining([
        {
          label: '--amend',
          kind: expect.any(Number),
          data: { type: CompletionItemDataType.Symbol },
          documentation: 'Amend the previous commit',
          textEdit: {
            newText: 'end',
            range: {
              start: { line: 1, character: 13 },
              end: { line: 1, character: 13 },
            },
          },
        },
      ]),
    )
  })

  it('completes builtin options from bash help before Fig', async () => {
    vi.spyOn(sh, 'getBuiltinSpec').mockResolvedValue({
      name: ['unset'],
      options: [
        { name: ['-f'], description: 'treat each NAME as a shell function' },
        { name: ['-v'], description: 'treat each NAME as a shell variable' },
        { name: ['-n'], description: 'treat each NAME as a name reference' },
      ],
    })
    const getOptions = vi.spyOn(FigSpecs.prototype, 'getOptions')
    const spawn = vi.spyOn(childProcess, 'spawnSync')

    const result = (await complete('unset -\n', 0, 7)) as any[]

    expect(result.filter((item) => item.label.startsWith('-'))).toEqual([
      expect.objectContaining({
        label: '-f',
        documentation: 'treat each NAME as a shell function',
        textEdit: expect.objectContaining({ newText: 'f' }),
      }),
      expect.objectContaining({ label: '-v' }),
      expect.objectContaining({ label: '-n' }),
    ])
    // Fig is only consulted with the help spec as the root.
    expect(getOptions.mock.calls.every(([, , root]) => root !== undefined)).toBe(true)
    expect(spawn).not.toHaveBeenCalled()
  })

  it('completes builtin options from Fig when help lists none', async () => {
    vi.spyOn(sh, 'getBuiltinSpec').mockResolvedValue(null)
    const getOptions = vi
      .spyOn(FigSpecs.prototype, 'getOptions')
      .mockReturnValue([{ name: '-r', description: 'Read-only' }])

    const result = (await complete('local -\n', 0, 7)) as any[]

    expect(getOptions).toHaveBeenCalledWith(['local'], '-')
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: '-r', documentation: 'Read-only' }),
      ]),
    )
  })

  it('falls back to bash-completion when there is no Fig spec', async () => {
    vi.spyOn(FigSpecs.prototype, 'getOptions').mockReturnValue(null)
    const spawn = vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
      status: 0,
      stdout: Buffer.from('--line-buffered\t'),
    } as any)

    const result = await complete('grep --line-\n', 0, 12)

    expect(spawn).toHaveBeenCalledWith(expect.stringContaining('get-options.sh'), [
      'grep',
      '--line-',
    ])
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: '--line-buffered',
          textEdit: expect.objectContaining({ newText: 'buffered' }),
        }),
      ]),
    )
    expect(
      (result as any[]).find((item) => item.label === '--line-buffered'),
    ).not.toHaveProperty('documentation')
  })
})

describe('option hover', () => {
  afterEach(() => vi.restoreAllMocks())

  async function hover(
    text: string,
    line: number,
    character: number,
    explainshellEndpoint = '',
  ) {
    const connection = getMockConnection()
    ;(connection.workspace.getConfiguration as Mock).mockResolvedValue({
      shellcheckPath: '',
      explainshellEndpoint,
    })
    const server = await LspServer.initialize(connection, {
      rootUri: null,
      processId: null,
      capabilities: { workspace: { configuration: true } },
    })
    server.register(connection)
    await connection.onInitialized.mock.calls[0][0]({})
    const document = TextDocument.create('file:///options.sh', 'shellscript', 1, text)
    await server.analyzeAndLintDocument(document)
    return connection.onHover.mock.calls[0][0](
      { textDocument: { uri: document.uri }, position: { line, character } },
      {} as any,
      {} as any,
    )
  }

  it('shows the Fig description of the hovered option', async () => {
    const describeOption = vi
      .spyOn(FigSpecs.prototype, 'describeOption')
      .mockReturnValue([
        { name: ['-a', '--all'], description: 'Stage all changes' },
        { name: ['-m', '--message'], description: 'Commit message', argCount: 1 },
      ])

    expect(await hover('git -C repo commit -am fix\n', 0, 20)).toEqual({
      contents: {
        kind: 'markdown',
        value:
          '`-a`, `--all`\n\nStage all changes\n\n`-m`, `--message`\n\nCommit message',
      },
    })
    expect(describeOption).toHaveBeenCalledWith(['git', '-C', 'repo', 'commit'], '-am')
  })

  it('describes builtin options from bash help before Fig', async () => {
    vi.spyOn(sh, 'getBuiltinSpec').mockResolvedValue({
      name: ['builtin'],
      options: [
        { name: ['-f'], description: 'treat each NAME as a shell function' },
        { name: ['-v'], description: 'treat each NAME as a shell variable' },
        { name: ['-a'], description: 'to make NAMEs indexed arrays' },
        { name: ['-x'], description: 'to make NAMEs export' },
      ],
    })
    const describeOption = vi.spyOn(FigSpecs.prototype, 'describeOption')

    expect(await hover('unset -f my_function\n', 0, 7)).toEqual({
      contents: {
        kind: 'markdown',
        value: '`-f`\n\ntreat each NAME as a shell function',
      },
    })
    expect(await hover('declare -ax names\n', 0, 9)).toEqual({
      contents: {
        kind: 'markdown',
        value: '`-a`\n\nto make NAMEs indexed arrays\n\n`-x`\n\nto make NAMEs export',
      },
    })
    expect(describeOption.mock.calls.every(([, , root]) => root !== undefined)).toBe(true)
  })

  it('uses Fig for builtin options that help does not list', async () => {
    vi.spyOn(sh, 'getBuiltinSpec').mockResolvedValue(null)
    vi.spyOn(FigSpecs.prototype, 'describeOption').mockReturnValue([
      { name: ['-v'], description: 'Variable definition will be unset' },
    ])

    expect(await hover('unset -v name\n', 0, 7)).toEqual({
      contents: {
        kind: 'markdown',
        value: '`-v`\n\nVariable definition will be unset',
      },
    })
  })

  it('shows the argument slot of a word, with any symbol documentation', async () => {
    vi.spyOn(sh, 'getBuiltinSpec').mockResolvedValue({
      name: ['unset'],
      options: [{ name: ['-f'], description: 'treat each NAME as a shell function' }],
      args: [{ name: 'name', isOptional: true, isVariadic: true }],
    })
    const documentation = vi.spyOn(sh, 'getShellDocumentation')

    const result = (await hover('f() { :; }\nunset -f f\n', 1, 9)) as LSP.Hover

    expect(result.contents).toEqual({
      kind: 'markdown',
      value: expect.stringMatching(
        /^Argument `name\.\.\.` \(optional\)\n\n---\n\nFunction: \*\*f\*\*/,
      ),
    })
    expect(documentation).not.toHaveBeenCalled()
  })

  it('does not document an argument as the command it is named after', async () => {
    vi.spyOn(sh, 'getBuiltinSpec').mockResolvedValue({
      name: ['echo'],
      args: [{ name: 'arg', isOptional: true, isVariadic: true }],
    })
    const documentation = vi.spyOn(sh, 'getShellDocumentation')

    expect(await hover('echo cd\n', 0, 6)).toEqual({
      contents: { kind: 'markdown', value: 'Argument `arg...` (optional)' },
    })
    expect(documentation).not.toHaveBeenCalled()
  })

  it('shows the value an option word is given', async () => {
    const describeArgument = vi
      .spyOn(FigSpecs.prototype, 'describeArgument')
      .mockReturnValue({
        kind: 'value',
        option: '-f',
        name: 'ARCHIVE',
        description: 'Archive file',
      })

    expect(await hover('tar -xzf archive.tgz\n', 0, 12)).toEqual({
      contents: {
        kind: 'markdown',
        value: 'Value of `-f`: `ARCHIVE`\n\nArchive file',
      },
    })
    expect(describeArgument).toHaveBeenCalledWith(['tar', '-xzf', 'archive.tgz'], 2)
  })

  it('falls through when Fig has no description', async () => {
    vi.spyOn(FigSpecs.prototype, 'describeOption').mockReturnValue([
      { name: ['--quiet'] },
    ])
    expect(await hover('mytool --quiet\n', 0, 10)).toBeNull()
  })

  it('prefers explainshell when an endpoint is configured', async () => {
    vi.spyOn(Analyzer.prototype, 'getExplainshellDocumentation').mockResolvedValue({
      helpHTML: '<b>explainshell</b>',
    })
    const describeOption = vi.spyOn(FigSpecs.prototype, 'describeOption')

    expect(await hover('git commit --amend\n', 0, 13, 'http://localhost:5000')).toEqual({
      contents: { kind: 'markdown', value: '**explainshell**' },
    })
    expect(describeOption).not.toHaveBeenCalled()
  })
})
