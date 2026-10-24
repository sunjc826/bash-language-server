import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import { TextDocument } from 'vscode-languageserver-textdocument'
import { Parser, Tree } from 'web-tree-sitter'

import Analyzer from '../analyser'
import { Config, getDefaultConfiguration } from '../config'
import { initializeParser } from '../parser'
import { tryGetConcreteValues, tryGetSingleValue } from '../util/flow-value'

describe('flow analysis through the analyzer', () => {
  let directory: string
  let parser: Parser
  let analyzer: Analyzer
  let trees: Tree[]

  beforeEach(async () => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-')))
    parser = await initializeParser()
    trees = []
    const parse = parser.parse.bind(parser)
    vi.spyOn(parser, 'parse').mockImplementation((...args) => {
      const tree = parse(...args)
      if (tree) trees.push(tree)
      return tree
    })
    analyzer = createAnalyzer()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    parser.delete()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  function createAnalyzer(config: Partial<Config> = {}) {
    const result = new Analyzer({ parser, workspaceFolder: directory })
    result.setConfig({
      ...getDefaultConfiguration(),
      enableFlowAnalysis: true,
      ...config,
    })
    return result
  }

  function write(name: string, text: string) {
    const filePath = path.join(directory, name)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, text)
    return pathToFileURL(filePath).href
  }

  function analyze(uri: string, text = fs.readFileSync(new URL(uri), 'utf8')) {
    analyzer.analyze({
      uri,
      document: TextDocument.create(uri, 'shellscript', 1, text),
    })
  }

  function value(uri: string, name: string) {
    const binding = analyzer.getFlowBindings(uri)?.get(name)
    return binding ? tryGetSingleValue(binding) : null
  }

  it('stops at source cycles', () => {
    write('b.sh', 'source ./a.sh\nFROM_B=b\n')
    const uri = write('a.sh', 'source ./b.sh\nFROM_A=a\n')

    analyze(uri)

    expect(value(uri, 'FROM_A')).toBe('a')
    expect(value(uri, 'FROM_B')).toBe('b')
    // The document itself plus one parse of b.sh
    expect(trees).toHaveLength(2)
  })

  it('frees trees parsed for sourced files', () => {
    write('lib.sh', 'LIB=1\n')
    const uri = write('main.sh', 'source ./lib.sh\nsource ./lib.sh\n')
    const deleted = vi.spyOn(Tree.prototype, 'delete')

    analyze(uri)

    const freed = new Set(deleted.mock.contexts)
    // Only the analyzed document's own tree stays alive.
    expect(trees.filter((tree) => !freed.has(tree))).toHaveLength(1)
  })

  it('re-reads sourced files on each analysis', () => {
    const libUri = write('lib.sh', 'LIB=one\n')
    const uri = write('main.sh', 'source ./lib.sh\n')
    analyze(uri)
    expect(value(uri, 'LIB')).toBe('one')

    write('lib.sh', 'LIB=two\n')
    analyze(uri)
    expect(value(uri, 'LIB')).toBe('two')

    // An open sourced document is analyzed with its own contents.
    analyze(libUri, 'LIB=three\n')
    analyze(uri)
    expect(value(uri, 'LIB')).toBe('three')
  })

  it('analyzes sourced files in the context of the sourcing file', () => {
    write('lib.sh', 'COPY=$ORIGIN\n')
    const firstUri = write('first.sh', 'ORIGIN=first\nsource ./lib.sh\n')
    const secondUri = write('second.sh', 'ORIGIN=second\nsource ./lib.sh\n')

    analyze(firstUri)
    analyze(secondUri)

    expect(value(firstUri, 'COPY')).toBe('first')
    expect(value(secondUri, 'COPY')).toBe('second')
  })

  describe('values at a position', () => {
    const text = [
      'X=one', // 0
      'echo "$X"', // 1
      'X=two', // 2
      'echo "${X}"', // 3
      'for f in a b; do echo "$f"; done', // 4
      'if false; then echo "$X"; fi', // 5
      'echo "$f"', // 6
    ].join('\n')

    function valuesAt(line: number, character: number) {
      const uri = write('positions.sh', text)
      analyze(uri)
      const result = analyzer.getFlowValueAt({ uri, position: { line, character } })
      return result && { name: result.name, values: tryGetConcreteValues(result.value) }
    }

    it('reports the value a reference has where it runs', () => {
      expect(valuesAt(1, 7)).toEqual({ name: 'X', values: ['one'] })
      expect(valuesAt(3, 8)).toEqual({ name: 'X', values: ['two'] })
    })

    it('reports the value an assignment leaves', () => {
      expect(valuesAt(2, 0)).toEqual({ name: 'X', values: ['two'] })
    })

    it('reports every iteration value inside a loop and the last after it', () => {
      expect(valuesAt(4, 24)).toEqual({ name: 'f', values: ['a', 'b'] })
      expect(valuesAt(6, 7)).toEqual({ name: 'f', values: ['b'] })
    })

    it('reports nothing for unreachable code or non-variables', () => {
      expect(valuesAt(5, 22)).toBeNull()
      expect(valuesAt(1, 1)).toBeNull()
    })
  })

  describe('pathEnvInit', () => {
    it('expands each (*) capture group in order', () => {
      analyzer = createAnalyzer({
        pathEnvInit: [
          {
            path: 'projects/(*)/(*)/*.sh',
            variables: { PROJECT: '$1', COMPONENT: '$2' },
          },
        ],
      })
      const uri = write('projects/api/server/run.sh', 'echo "$PROJECT"\n')

      analyze(uri)

      expect(value(uri, 'PROJECT')).toBe('api')
      expect(value(uri, 'COMPONENT')).toBe('server')
    })

    it('does not let * match across directories', () => {
      analyzer = createAnalyzer({
        pathEnvInit: [{ path: 'scripts/*.sh', variables: { MATCHED: 'yes' } }],
      })
      const nestedUri = write('scripts/nested/run.sh', 'true\n')
      const uri = write('scripts/run.sh', 'true\n')

      analyze(nestedUri)
      analyze(uri)

      expect(value(nestedUri, 'MATCHED')).toBeNull()
      expect(value(uri, 'MATCHED')).toBe('yes')
    })

    it('applies assignments from envInit', () => {
      analyzer = createAnalyzer({
        pathEnvInit: [
          { path: '**/(*).sh', envInit: 'export TOOL_HOME=/opt/$1 MODE=dev' },
        ],
      })
      const uri = write('bin/deploy.sh', 'true\n')

      analyze(uri)

      expect(value(uri, 'TOOL_HOME')).toBe('/opt/deploy')
      expect(value(uri, 'MODE')).toBe('dev')
    })

    it('resolves sources relative to the sourced file with sourcePushd', () => {
      write('lib/helpers.sh', 'HELPER=loaded\n')
      write('lib/entry.sh', 'source ./helpers.sh\n')
      analyzer = createAnalyzer({
        pathEnvInit: [{ path: '*.sh', sourcePushd: true }],
      })
      const uri = write('main.sh', 'source ./lib/entry.sh\n')

      analyze(uri)

      expect(value(uri, 'HELPER')).toBe('loaded')
    })
  })
})
