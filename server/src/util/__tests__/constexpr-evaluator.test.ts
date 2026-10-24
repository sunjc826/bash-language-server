import { beforeAll, describe, expect, it, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { Parser } from 'web-tree-sitter'

import { initializeParser } from '../../parser'
import { ConstexprEvaluator } from '../constexpr-evaluator'
import { FlowAnalysisContext, FlowAnalysisOptions, FlowAnalyzer } from '../flow-analysis'
import { FlowBindings, tryGetSingleValue } from '../flow-value'

// Allow spying on child_process functions imported by name.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}))

const FIXTURE_DIR = path.join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'testing',
  'fixtures',
  'flow-analysis',
)

function getVar(bindings: FlowBindings, name: string): string | null {
  const fv = bindings.get(name)
  if (!fv) return null
  return tryGetSingleValue(fv)
}

function makeEvaluator(): ConstexprEvaluator {
  return new ConstexprEvaluator({ timeoutMs: 5000, cacheTtlMs: 60_000 })
}

function makeConstexprOptions(evaluator: ConstexprEvaluator): FlowAnalysisOptions {
  return {
    constexpr: {
      evaluator,
      registry: new Map(),
      budget: { spawnsRemaining: 100, deadline: Date.now() + 10_000 },
    },
  }
}

describe('constexpr function evaluation', () => {
  let parser: Parser

  beforeAll(async () => {
    parser = await initializeParser()
  })

  function analyzeFixture(
    name: string,
    options?: FlowAnalysisOptions,
  ): { bindings: FlowBindings; ctx: FlowAnalysisContext } {
    const filePath = path.join(FIXTURE_DIR, name)
    const uri = `file://${filePath}`
    const content = fs.readFileSync(filePath, 'utf8')
    const tree = parser.parse(content)!
    const ctx: FlowAnalysisContext = {
      uri,
      content,
      rootNode: tree.rootNode,
      cwd: path.dirname(uri.replace('file://', '')),
      initialBindings: new Map(),
      sourcePushd: false,
      resolveSource: (sourcePath: string) => sourcePath,
      analyzeSourcedFile: () => new Map(),
      trackInlayHints: true,
      inlayHints: [],
      dimmedRanges: [],
      sourceErrors: [],
      constexprErrors: [],
      topLevelUri: uri,
    }
    const bindings = FlowAnalyzer.analyzeFile(ctx, options)
    return { bindings, ctx }
  }

  it('evaluates a marked function with literal args', () => {
    const { bindings } = analyzeFixture(
      'constexpr-double.sh',
      makeConstexprOptions(makeEvaluator()),
    )
    expect(getVar(bindings, 'VALUE')).toBe('42')
  })

  it('resolves variable args through flow state and injects referenced globals', () => {
    const { bindings } = analyzeFixture(
      'constexpr-globals.sh',
      makeConstexprOptions(makeEvaluator()),
    )
    expect(getVar(bindings, 'MSG')).toBe('hello world')
    expect(getVar(bindings, 'DOUBLED')).toBe('42')
  })

  it('does not evaluate unmarked functions or trailing-comment-only markers', () => {
    const { bindings } = analyzeFixture(
      'constexpr-unmarked.sh',
      makeConstexprOptions(makeEvaluator()),
    )
    expect(getVar(bindings, 'A')).toBeNull()
    expect(getVar(bindings, 'B')).toBeNull()
  })

  it('accepts the marker anywhere in the contiguous doc block', () => {
    const { bindings } = analyzeFixture(
      'constexpr-docblock.sh',
      makeConstexprOptions(makeEvaluator()),
    )
    expect(getVar(bindings, 'VALUE')).toBe('6')
  })

  it('yields no value when the function exits non-zero', () => {
    const { bindings } = analyzeFixture(
      'constexpr-fail.sh',
      makeConstexprOptions(makeEvaluator()),
    )
    expect(getVar(bindings, 'VALUE')).toBeNull()
  })

  it('evaluates two marked functions where one calls the other', () => {
    const { bindings } = analyzeFixture(
      'constexpr-chained.sh',
      makeConstexprOptions(makeEvaluator()),
    )
    expect(getVar(bindings, 'VALUE')).toBe('20')
  })

  it('reports a constexpr directive that is not above a function', () => {
    const { ctx } = analyzeFixture(
      'constexpr-orphan.sh',
      makeConstexprOptions(makeEvaluator()),
    )
    expect(ctx.constexprErrors).toHaveLength(1)
    expect(ctx.constexprErrors[0].start.line).toBe(1)
  })

  it('does not report properly-associated constexpr directives', () => {
    const { ctx } = analyzeFixture(
      'constexpr-double.sh',
      makeConstexprOptions(makeEvaluator()),
    )
    expect(ctx.constexprErrors).toHaveLength(0)
  })

  it('spawns nothing when the feature is disabled (default)', () => {
    const spy = vi.spyOn(childProcess, 'execFileSync')
    try {
      analyzeFixture('constexpr-double.sh')
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('serves re-analysis of an unchanged document from cache', () => {
    const evaluator = makeEvaluator()
    const spy = vi.spyOn(childProcess, 'execFileSync')
    try {
      const first = analyzeFixture('constexpr-double.sh', makeConstexprOptions(evaluator))
      expect(getVar(first.bindings, 'VALUE')).toBe('42')
      const spawnsAfterFirstAnalysis = spy.mock.calls.length

      const second = analyzeFixture(
        'constexpr-double.sh',
        makeConstexprOptions(evaluator),
      )
      expect(getVar(second.bindings, 'VALUE')).toBe('42')
      // The second analysis is served from cache — no additional spawns.
      expect(spy.mock.calls.length).toBe(spawnsAfterFirstAnalysis)
    } finally {
      spy.mockRestore()
    }
  })
})
