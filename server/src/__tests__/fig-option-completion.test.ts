import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { TextDocument } from 'vscode-languageserver-textdocument'

import { getMockConnection } from '../../../testing/mocks'
import LspServer from '../server'
import { CompletionItemDataType } from '../types'
import { FigCommand, FigSpecs } from '../util/fig-options'

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
  tar: {
    name: ['tar'],
    subcommands: [
      {
        name: ['x', '-x', '--extract'],
        description: 'Extract files from an archive',
        options: [{ name: ['--strip-components'], argCount: 1 }],
      },
    ],
    options: [
      { name: ['-x'], description: 'Extract' },
      { name: ['-z'], description: 'Gzip' },
      { name: ['-f'], description: 'Archive file', argCount: 1 },
    ],
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
  })

  it('suggests and descends into dash-prefixed subcommands', () => {
    expect(new FigSpecs(specDirectory).getOptions(['tar'], '--e')).toEqual([
      { name: '--extract', description: 'Extract files from an archive' },
    ])
    expect(names(['tar', '--extract'], '--')).toEqual(['--strip-components'])
  })

  it('treats the last chained short flag as taking an argument', () => {
    expect(names(['tar', '-xzf', '-'], '-')).toEqual(['-x', '-z', '-f', '--extract'])
    expect(names(['tar', '-xzf', 'archive.tgz', '--'], '-')).toEqual([])
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
