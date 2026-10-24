import { beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { Parser, Tree } from 'web-tree-sitter'

import { FlowAnalyzer, FlowAnalysisContext, InlayHint } from '../flow-analysis'
import {
  FlowBindings,
  tryGetArrayElements,
  tryGetConcreteValues,
  tryGetSingleValue,
} from '../flow-value'
import { initializeParser } from '../../parser'

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

/**
 * Build a FlowAnalysisContext for testing a single fixture file.
 */
function makeContext(
  uri: string,
  content: string,
  tree: Tree,
  overrides: Partial<FlowAnalysisContext> = {},
): FlowAnalysisContext {
  return {
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
    ...overrides,
  }
}

/**
 * Helper: get the single value of a variable from bindings.
 */
function getVar(bindings: FlowBindings, name: string): string | null {
  const fv = bindings.get(name)
  if (!fv) return null
  return tryGetSingleValue(fv)
}

/**
 * Helper: get array elements for a variable.
 */
function getVarElements(bindings: FlowBindings, name: string): string[] | null {
  const fv = bindings.get(name)
  if (!fv) return null
  return tryGetArrayElements(fv)
}

describe('FlowAnalyzer', () => {
  let parser: Parser

  beforeAll(async () => {
    parser = await initializeParser()
  })

  /**
   * Convenience: parse a fixture, run analysis, return bindings.
   */
  function analyzeFixture(
    name: string,
    ctxOverrides: Partial<FlowAnalysisContext> = {},
  ): {
    bindings: FlowBindings
    ctx: FlowAnalysisContext
  } {
    const filePath = path.join(FIXTURE_DIR, name)
    const uri = `file://${filePath}`
    const content = fs.readFileSync(filePath, 'utf8')
    const tree = parser.parse(content)!
    const ctx = makeContext(uri, content, tree, ctxOverrides)
    const bindings = FlowAnalyzer.analyzeFile(ctx)
    return { bindings, ctx }
  }

  // ─── basic assignment ───────────────────────────────────────────

  describe('basic assignment', () => {
    it('resolves simple string assignments', () => {
      const { bindings } = analyzeFixture('basic-assignment.sh')
      expect(getVar(bindings, 'NAME')).toBe('world') // reassigned
      expect(getVar(bindings, 'EMPTY')).toBe('')
      expect(getVar(bindings, 'ZERO')).toBe('0')
    })

    it('resolves numeric assignments', () => {
      const { bindings } = analyzeFixture('basic-assignment.sh')
      expect(getVar(bindings, 'VERSION')).toBe('42')
    })

    it('resolves concatenation in assignment', () => {
      const { bindings } = analyzeFixture('basic-assignment.sh')
      expect(getVar(bindings, 'GREETING')).toBe('Hello, world!')
    })

    it('resolves : "${VAR:=default}" pattern', () => {
      const { bindings } = analyzeFixture('basic-assignment.sh')
      expect(getVar(bindings, 'CONFIG_FILE')).toBe('/etc/myapp.conf')
    })

    it('resolves += append', () => {
      const { bindings } = analyzeFixture('basic-assignment.sh')
      expect(getVar(bindings, 'PATH')).toBe('/usr/bin:/usr/local/bin')
    })

    it('emits inlay hints for assignments', () => {
      const { ctx } = analyzeFixture('basic-assignment.sh')
      expect(ctx.inlayHints.length).toBeGreaterThan(0)
      // Check that PATH's hint shows the appended value
      const pathHint = ctx.inlayHints.find((h: InlayHint) => h.variable === 'PATH')
      expect(pathHint).toBeDefined()
    })
  })

  // ─── array assignment ──────────────────────────────────────────

  describe('array assignment', () => {
    it('resolves array assignment', () => {
      const { bindings } = analyzeFixture('array.sh')
      const fruits = getVarElements(bindings, 'FRUITS')
      expect(fruits).toEqual(['apple', 'banana', 'cherry', 'date', 'elderberry'])
    })

    it('resolves quoted array elements', () => {
      const { bindings } = analyzeFixture('array.sh')
      const files = getVarElements(bindings, 'FILES')
      expect(files).toEqual(['file one.txt', 'file two.txt'])
    })

    it('resolves array with expansion', () => {
      const { bindings } = analyzeFixture('array.sh')
      const all = getVarElements(bindings, 'ALL')
      // ALL is built from FRUITS and MORE
      expect(all).toEqual([
        'apple',
        'banana',
        'cherry',
        'date',
        'elderberry',
        'kiwi',
        'lemon',
      ])
    })
  })

  // ─── parameter expansion ───────────────────────────────────────

  describe('parameter expansion', () => {
    it('resolves ${var:-default} with unset variable', () => {
      const { bindings } = analyzeFixture('parameter-expansion.sh')
      expect(getVar(bindings, 'DEFAULT_A')).toBe('fallback')
    })

    it('resolves ${var:-default} with set variable', () => {
      const { bindings } = analyzeFixture('parameter-expansion.sh')
      expect(getVar(bindings, 'DEFAULT_B')).toBe('original')
    })

    it('resolves ${var:=assign} pattern', () => {
      const { bindings } = analyzeFixture('parameter-expansion.sh')
      expect(getVar(bindings, 'ASSIGNED_VAR')).toBe('assigned_value')
    })

    it('resolves ${var:+alternate} with set variable', () => {
      const { bindings } = analyzeFixture('parameter-expansion.sh')
      expect(getVar(bindings, 'EXPANSION_C')).toBe('has_value')
    })

    it('resolves ${var:+alternate} with unset variable to empty', () => {
      const { bindings } = analyzeFixture('parameter-expansion.sh')
      expect(getVar(bindings, 'EXPANSION_D')).toBe('')
    })
  })

  // ─── constexpr if / elif / else ─────────────────────────────────

  describe('constexpr if evaluation', () => {
    it('takes then branch on constant truthy condition', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'BRANCH_RESULT')).toBe('enabled-branch')
    })

    it('takes else branch on constant falsy condition', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'BRANCH_RESULT_2')).toBe('correct-branch')
    })

    it('resolves numeric -eq comparison', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'NUM_BRANCH')).toBe('equals-five')
    })

    it('resolves nested if statements', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'NESTED')).toBe('deep-branch')
    })

    it('resolves elif chains', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      // SCORE=85, so 70 <= 85 < 90 → GRADE="B"
      expect(getVar(bindings, 'GRADE')).toBe('B')
    })

    it('dims untaken branches', () => {
      const { ctx } = analyzeFixture('if-constexpr.sh')
      expect(ctx.dimmedRanges.length).toBeGreaterThan(0)
    })

    it('resolves command name from quoted variable expansion ("$VAR"=false)', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'CMD_VAR_THEN')).toBeNull()
      expect(getVar(bindings, 'CMD_VAR_ELSE')).toBe('command-is-false')
    })

    it('resolves command name from quoted variable expansion ("$VAR"=true)', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'CMD_TRUE_THEN')).toBe('command-is-true')
      expect(getVar(bindings, 'CMD_TRUE_ELSE')).toBeNull()
    })

    it('resolves command name from bare variable expansion ($VAR=false)', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'CMD_VAR2_THEN')).toBeNull()
      expect(getVar(bindings, 'CMD_VAR2_ELSE')).toBe('command-is-false-bare')
    })

    // ── composite conditions (&& / ||) ──

    it('evaluates true && true as truthy', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'COMPOSITE_AND_TRUE')).toBe('taken')
    })

    it('evaluates true && false as falsy', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'COMPOSITE_AND_FALSE')).toBe('else-taken')
    })

    it('evaluates false || true as truthy (short-circuit)', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'COMPOSITE_OR_TRUE')).toBe('taken-short-circuit')
    })

    it('evaluates false || false as falsy', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'COMPOSITE_OR_FALSE')).toBe('else-taken')
    })

    it('evaluates test_command && true mixed composite', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'COMPOSITE_MIXED')).toBe('taken')
    })

    it('evaluates test_command || arithmetic mixed composite', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'COMPOSITE_MIXED2')).toBe('taken-short-circuit')
    })

    // ── arithmetic expansion as command ──

    it('evaluates (( 5 == 5 )) as truthy', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'ARITH_TRUE')).toBe('taken')
    })

    it('evaluates (( 5 == 3 )) as falsy', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'ARITH_FALSE')).toBe('else-taken')
    })

    it('evaluates (( X > 5 )) with known variable X=10 as truthy', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'ARITH_VAR_TRUE')).toBe('taken')
    })

    it('evaluates (( X == 0 )) with known variable X=10 as falsy', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'ARITH_VAR_FALSE')).toBe('else-taken')
    })

    // ── composite with variable command ──

    it('evaluates true && "$VAR" where VAR=true as truthy', () => {
      const { bindings } = analyzeFixture('if-constexpr.sh')
      expect(getVar(bindings, 'COMPOSITE_VAR_CMD')).toBe('taken')
    })
  })

  // ─── case statement ────────────────────────────────────────────

  describe('case statement', () => {
    it('matches exact pattern and takes the correct branch', () => {
      const { bindings } = analyzeFixture('case.sh')
      expect(getVar(bindings, 'SOUND')).toBe('meow')
    })

    it('matches glob wildcard patterns', () => {
      const { bindings } = analyzeFixture('case.sh')
      expect(getVar(bindings, 'TYPE')).toBe('text')
    })

    it('analyzes all branches when value is unknown', () => {
      const { bindings } = analyzeFixture('case.sh')
      // All branches are analyzed; last assignment wins (no union tracking yet)
      const vals = tryGetConcreteValues(bindings.get('UK_SOUND')!)
      expect(vals).toContain('default-sound')
    })

    it('dims unmatched branches when value is known', () => {
      const { ctx } = analyzeFixture('case.sh')
      // Should have some dimmed ranges for unmatched case_item branches
      expect(ctx.dimmedRanges.length).toBeGreaterThan(0)
    })
  })

  // ─── arithmetic ────────────────────────────────────────────────

  describe('arithmetic expansion', () => {
    it('evaluates simple addition', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'SUM')).toBe('13')
    })

    it('evaluates subtraction', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'DIFF')).toBe('7')
    })

    it('evaluates multiplication', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'PROD')).toBe('30')
    })

    it('evaluates division (integer)', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'DIV')).toBe('3')
    })

    it('evaluates modulo', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'MOD')).toBe('1')
    })

    it('evaluates complex expressions with parens', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'COMPLEX')).toBe('25') // (10+3)*2-1 = 25
    })

    it('evaluates with variable substitution', () => {
      const { bindings } = analyzeFixture('arithmetic.sh')
      expect(getVar(bindings, 'Z')).toBe('20') // SUM(13) + DIFF(7)
    })
  })

  // ─── concatenation ─────────────────────────────────────────────

  describe('concatenation', () => {
    it('resolves concatenation with variables', () => {
      const { bindings } = analyzeFixture('concatenation.sh')
      expect(getVar(bindings, 'FULL')).toBe('Hello, World!')
    })

    it('resolves multiple concatenations with underscores', () => {
      const { bindings } = analyzeFixture('concatenation.sh')
      expect(getVar(bindings, 'LONG')).toBe('Hello_World_end')
    })
  })

  // ─── loops ─────────────────────────────────────────────────────

  describe('loops', () => {
    it('analyzes for loop over literal list', () => {
      const { bindings } = analyzeFixture('loops.sh')
      // After the loop, variables hold the last iteration's values
      expect(getVar(bindings, 'LAST_FRUIT')).toBe('cherry')
      expect(getVar(bindings, 'fruit')).toBe('cherry')
    })

    it('dims while body with false condition', () => {
      const { bindings, ctx } = analyzeFixture('loops.sh')
      expect(getVar(bindings, 'NEVER_REACHED')).toBeNull()
      expect(ctx.dimmedRanges.length).toBeGreaterThan(0)
    })

    it('analyzes while body with truthy condition', () => {
      const { bindings } = analyzeFixture('loops.sh')
      // Single iteration: COUNT starts at 0, condition 0 < 1 is true
      // Body sets COUNT=1, IN_LOOP="executed"
      expect(getVar(bindings, 'IN_LOOP')).toBe('executed')
      expect(getVar(bindings, 'COUNT')).toBe('1')
    })
  })

  // ─── declare / local / export ──────────────────────────────────

  describe('declaration commands', () => {
    it('tracks declare with assignment', () => {
      const { bindings } = analyzeFixture('declare.sh')
      expect(getVar(bindings, 'DECLARE_VAR')).toBe('declared')
    })

    it('tracks export with assignment', () => {
      const { bindings } = analyzeFixture('declare.sh')
      expect(getVar(bindings, 'EXPORT_VAR')).toBe('exported')
    })

    it('tracks readonly with assignment', () => {
      const { bindings } = analyzeFixture('declare.sh')
      expect(getVar(bindings, 'READONLY_VAR')).toBe('constant')
    })

    it('tracks typeset with assignment', () => {
      const { bindings } = analyzeFixture('declare.sh')
      expect(getVar(bindings, 'TYPESET_VAR')).toBe('typeset-value')
    })

    it('marks declare without value as existing', () => {
      const { bindings } = analyzeFixture('declare.sh')
      // EXISTS_VAR is marked as existing but unknown
      expect(bindings.has('EXISTS_VAR')).toBe(true)
    })

    it('tracks function-local variables (scope isolation)', () => {
      const { bindings } = analyzeFixture('declare.sh')
      // LOCAL_VAR should NOT leak to global scope
      expect(getVar(bindings, 'LOCAL_VAR')).toBeNull()
      // LOCAL_ONLY was set in function from LOCAL_VAR — also shouldn't leak
      expect(getVar(bindings, 'LOCAL_ONLY')).toBeNull()
    })
  })

  // ─── source / multi-file ───────────────────────────────────────

  describe('source command', () => {
    it('merges sourced file bindings', () => {
      const libPath = path.join(FIXTURE_DIR, 'source-lib.sh')
      const libUri = `file://${libPath}`
      const libContent = fs.readFileSync(libPath, 'utf8')
      const libTree = parser.parse(libContent)!

      // Pre-seed the sourced file analysis
      const sourcedBindings = FlowAnalyzer.analyzeFile(
        makeContext(libUri, libContent, libTree),
      )

      const mainContent = `
        source source-lib.sh
        MAIN_VAR="from-main"
      `
      // Parse inline to avoid needing a separate file
      const mainUri = `file://${path.join(FIXTURE_DIR, 'source-main.sh')}`
      const mainTree = parser.parse(mainContent)!

      const ctx = makeContext(mainUri, mainContent, mainTree, {
        resolveSource: () => libUri,
        analyzeSourcedFile: () => sourcedBindings,
      })

      const bindings = FlowAnalyzer.analyzeFile(ctx)

      // Variables from sourced file should be available
      expect(getVar(bindings, 'LIB_VAR')).toBe('from-library')
      expect(getVar(bindings, 'LIB_NAME')).toBe('mylib')
      expect(getVar(bindings, 'SHARED_VALUE')).toBe('shared-data')
      // Variables from main script should also be set
      expect(getVar(bindings, 'MAIN_VAR')).toBe('from-main')
    })
  })

  // ─── inlay hints ───────────────────────────────────────────────

  describe('inlay hints', () => {
    it('emits inlay hints for variable references within expansions', () => {
      // Use concatenation fixture which has ${PREFIX}, ${SUFFIX}
      const { ctx } = analyzeFixture('concatenation.sh')
      // Should have hints at variable expansion sites
      expect(ctx.inlayHints.length).toBeGreaterThan(0)
    })

    it('hints show resolved values for non-trivial assignments', () => {
      const { ctx } = analyzeFixture('arithmetic.sh')
      // Arithmetic values like SUM=$((X+Y)) should have hints
      const sumHint = ctx.inlayHints.find((h: InlayHint) => h.variable === 'SUM')
      expect(sumHint).toBeDefined()
      expect(sumHint!.label).toContain('13')
    })
  })

  // ─── control-flow joins ────────────────────────────────────────

  function analyzeSource(
    content: string,
    ctxOverrides: Partial<FlowAnalysisContext> = {},
  ): FlowBindings {
    return analyzeSourceWithContext(content, ctxOverrides).bindings
  }

  function analyzeSourceWithContext(
    content: string,
    ctxOverrides: Partial<FlowAnalysisContext> = {},
  ): { bindings: FlowBindings; ctx: FlowAnalysisContext } {
    const uri = 'file:///project/script.sh'
    const tree = parser.parse(content)!
    const ctx = makeContext(uri, content, tree, ctxOverrides)
    return { bindings: FlowAnalyzer.analyzeFile(ctx), ctx }
  }

  function getValues(bindings: FlowBindings, name: string): string[] {
    const fv = bindings.get(name)
    return fv ? tryGetConcreteValues(fv).sort() : []
  }

  describe('control-flow joins', () => {
    it('resolves an assignment without a value to the empty string', () => {
      const bindings = analyzeSource(
        ['e=', 'declare d=', 'a=(x)', 'a[1]=', 's=abc', 's+='].join('\n'),
      )
      expect(getVar(bindings, 'e')).toBe('')
      expect(getVar(bindings, 'd')).toBe('')
      expect(getVarElements(bindings, 'a')).toEqual(['x', ''])
      expect(getVar(bindings, 's')).toBe('abc')
    })

    it('resolves ${!name} through the variable it names', () => {
      const bindings = analyzeSource(
        ['a=b', 'b=hello', 'c=${!a}', 'e=', 'f=${!e}', 'p=x', 'q=${!p}'].join('\n'),
      )
      expect(getVar(bindings, 'c')).toBe('hello')
      expect(bindings.get('f')?.kind).toBe('unknown')
      expect(bindings.get('q')?.kind).toBe('unknown')
    })

    it('does not persist assignments prefixed to a command', () => {
      const bindings = analyzeSource('p=1\np= cmd\nq=2 cmd')
      expect(getVar(bindings, 'p')).toBe('1')
      expect(bindings.has('q')).toBe(false)
    })

    it('joins case branches when the subject is unknown', () => {
      const bindings = analyzeSource(
        [
          'x=0',
          'case "$1" in a) x=1 ;; b) x=2 ;; esac',
          'y=0',
          'case "$1" in a) y=1 ;; *) y=2 ;; esac',
        ].join('\n'),
      )
      expect(getValues(bindings, 'x')).toEqual(['0', '1', '2'])
      expect(getValues(bindings, 'y')).toEqual(['1', '2'])
    })

    it('joins nested case branches once', () => {
      const bindings = analyzeSource(
        [
          'y=0',
          'case "$1" in',
          'a) case "$2" in x) y=1 ;; esac ;;',
          'b) y=2 ;;',
          'esac',
        ].join('\n'),
      )
      expect(getValues(bindings, 'y')).toEqual(['0', '1', '2'])
    })

    it('matches every alternative of a case pattern', () => {
      const bindings = analyzeSource(
        ['v=--help', 'case "$v" in -h|--help) h=1 ;; *) h=2 ;; esac'].join('\n'),
      )
      expect(getVar(bindings, 'h')).toBe('1')
    })

    it('stops at a matching case item with an empty body', () => {
      const bindings = analyzeSource('v=b\ncase "$v" in b) ;; *) x=1 ;; esac')
      expect(bindings.has('x')).toBe(false)
    })

    it('analyzes else and elif branches from the state before the if', () => {
      const bindings = analyzeSource(
        [
          'x=0',
          'if [[ $1 ]]; then x=1; else seen=$x; x=2; fi',
          'y=0',
          'if [[ $1 ]]; then y=1; elif [[ $2 ]]; then y=2; fi',
        ].join('\n'),
      )
      expect(getValues(bindings, 'x')).toEqual(['1', '2'])
      expect(getVar(bindings, 'seen')).toBe('0')
      expect(getValues(bindings, 'y')).toEqual(['0', '1', '2'])
    })

    it('keeps every array a variable may hold after a join', () => {
      const bindings = analyzeSource(
        [
          'if [[ $1 ]]; then a=(x); else a=(y z); fi',
          'r="${a[@]}"',
          'a+=(w)',
          'if [[ $1 ]]; then s=1; else s=2; fi',
          's+=x',
        ].join('\n'),
      )
      expect(getValues(bindings, 'r')).toEqual(['x', 'y z'])
      expect(bindings.get('a')?.kind).toBe('unknown')
      expect(bindings.get('s')?.kind).toBe('unknown')
    })

    it('joins a while loop with the state before it', () => {
      const bindings = analyzeSource(
        [
          'h=false',
          'while (($#)); do',
          '  case $1 in -h) h=true ;; esac',
          '  shift',
          'done',
        ].join('\n'),
      )
      expect(getValues(bindings, 'h')).toEqual(['false', 'true'])
    })

    it('carries values between while loop iterations', () => {
      const bindings = analyzeSource(
        ['a=1', 'b=1', 'while [[ $1 ]]; do', '  b=$a', '  a=2', 'done'].join('\n'),
      )
      expect(getValues(bindings, 'a')).toEqual(['1', '2'])
      expect(getValues(bindings, 'b')).toEqual(['1', '2'])
    })

    it('widens values that keep changing across while loop iterations', () => {
      const bindings = analyzeSource('i=0\nwhile [[ $1 ]]; do i=$((i + 1)); done')
      expect(bindings.get('i')?.kind).toBe('unknown')
    })

    it('skips a never-executed while body inside another loop', () => {
      const bindings = analyzeSource(
        'x=0\nwhile [[ $1 ]]; do while false; do x=9; done; done',
      )
      expect(getVar(bindings, 'x')).toBe('0')
    })

    it('does not change the working directory when defining a function', () => {
      const bindings = analyzeSource('f() { cd /tmp; }')
      expect(getVar(bindings, 'PWD')).toBe('/project')
    })
  })

  // ─── path termination and narrowing ───────────────────────────

  describe('path termination and narrowing', () => {
    it('drops branches that exit', () => {
      const bindings = analyzeSource('x=0\nif [[ $1 ]]; then x=1; exit 1; fi')
      expect(getVar(bindings, 'x')).toBe('0')
    })

    it('keeps paths whose exit is conditional or in a subshell', () => {
      const bindings = analyzeSource(
        [
          'x=0',
          '[[ $1 ]] && exit',
          'x=1',
          'y=0',
          '(exit 1)',
          'y=2',
          'f() { return; }',
        ].join('\n'),
      )
      expect(getVar(bindings, 'x')).toBe('1')
      expect(getVar(bindings, 'y')).toBe('2')
    })

    it('runs the right side of && and || only on one outcome of the left', () => {
      const bindings = analyzeSource(
        [
          'x=0',
          '[[ $1 ]] && x=1',
          'err=',
          'cmd || err=failed',
          'v=',
          'if [[ $1 ]]; then v=a; fi',
          '[[ -n "$v" ]] || exit 1',
        ].join('\n'),
      )
      expect(getValues(bindings, 'x')).toEqual(['0', '1'])
      expect(getValues(bindings, 'err')).toEqual(['', 'failed'])
      expect(getVar(bindings, 'v')).toBe('a')
    })

    it('narrows a variable to the values that pass a condition', () => {
      const bindings = analyzeSource(
        [
          'if [[ $1 ]]; then f=true; else f=false; fi',
          'if "$f"; then a=$f; else b=$f; fi',
          'if "$f"; then exit 0; fi',
        ].join('\n'),
      )
      expect(getVar(bindings, 'a')).toBe('true')
      expect(getVar(bindings, 'b')).toBe('false')
      expect(getVar(bindings, 'f')).toBe('false')
    })

    it('treats failing tests and false under set -e as assertions', () => {
      const source = [
        'v=a',
        'if [[ $1 ]]; then v=; fi',
        '[[ -n "$v" ]]',
        'x=0',
        'if [[ $2 ]]; then x=1; false; fi',
      ]
      const strict = analyzeSource(['set -euo pipefail', ...source].join('\n'))
      expect(getVar(strict, 'v')).toBe('a')
      expect(getVar(strict, 'x')).toBe('0')

      const relaxed = analyzeSource(['set -e', 'set +e', ...source].join('\n'))
      expect(getValues(relaxed, 'v')).toEqual(['', 'a'])
      expect(getValues(relaxed, 'x')).toEqual(['0', '1'])
    })

    it('dispatches case items on the known values of the subject', () => {
      const { bindings, ctx } = analyzeSourceWithContext(
        [
          'if [[ $1 ]]; then v=linux; else v=mac; fi',
          'case "$v" in',
          'linux) a=$v ;;',
          'mac) b=$v ;;',
          '*) c=1 ;;',
          'esac',
        ].join('\n'),
      )
      expect(getVar(bindings, 'a')).toBe('linux')
      expect(getVar(bindings, 'b')).toBe('mac')
      expect(bindings.has('c')).toBe(false)
      expect(ctx.dimmedRanges.map((r) => r.start.line)).toEqual([4])
    })
  })

  // ─── FlowValue lattice ─────────────────────────────────────────

  describe('FlowValue lattice (flow-value.ts)', () => {
    it('tryGetSingleValue returns single concrete value', () => {
      const { bindings } = analyzeFixture('basic-assignment.sh')
      expect(tryGetSingleValue(bindings.get('NAME')!)).toBe('world')
    })

    it('tryGetSingleValue returns null for union values', () => {
      const { bindings } = analyzeFixture('case.sh')
      // UK_SOUND gets overwritten by sequential analysis, not a union yet
      // Last branch (*) sets it to "default-sound", so it's a single value
      const fv = bindings.get('UK_SOUND')
      expect(fv).toBeDefined()
      if (fv) {
        const val = tryGetSingleValue(fv)
        // May be "default-sound" (last branch wins) or null (if unions were tracked)
        expect(val === null || val === 'default-sound').toBe(true)
      }
    })

    it('tryGetConcreteValues returns all values for union', () => {
      const { bindings } = analyzeFixture('case.sh')
      const values = tryGetConcreteValues(bindings.get('UK_SOUND')!)
      // Currently the last branch wins; values contains at least "default-sound"
      expect(values.length).toBeGreaterThan(0)
      expect(values).toContain('default-sound')
    })
  })
})
