import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Parser } from 'web-tree-sitter'

import { initializeParser } from '../../parser'
import { getEmbeddedSemanticTokens, SEMANTIC_TOKEN_LEGEND } from '../embedded-tokens'

let parser: Parser
beforeAll(async () => {
  parser = await initializeParser()
})
afterAll(() => parser.delete())

/** Decode the semantic tokens of `source` as `line:text type` strings. */
function tokens(source: string): string[] {
  const tree = parser.parse(source)!
  const { data } = getEmbeddedSemanticTokens(tree.rootNode)
  tree.delete()
  const lines = source.split('\n')
  const result: string[] = []
  let line = 0
  let character = 0
  for (let i = 0; i < data.length; i += 5) {
    const [deltaLine, deltaChar, length, type] = data.slice(i, i + 4)
    line += deltaLine
    character = deltaLine ? deltaChar : character + deltaChar
    const text = lines[line].slice(character, character + length)
    result.push(`${line}:${text} ${SEMANTIC_TOKEN_LEGEND.tokenTypes[type]}`)
  }
  return result
}

describe('doc tag tokens', () => {
  it('highlights tags and what they document', () => {
    const source = [
      '# Convert a path.',
      '# @description More text',
      '# @arg $1 {path} dir Path to convert',
      '# @arg $2 {path} [cwd=$PWD] Base directory',
      '# @arg $@ string Extra arguments',
      '# @option -v|--verbose: Talk more',
      '# @set BU_RET {path} The result',
      '# @exitcode 1 On failure',
      '# @see other_function',
      'abspath() { :; }',
    ].join('\n')
    expect(tokens(source)).toEqual([
      '1:@description decorator',
      '2:@arg decorator',
      '2:$1 variable',
      '2:path type',
      '2:dir parameter',
      '3:@arg decorator',
      '3:$2 variable',
      '3:path type',
      '3:cwd parameter',
      '4:@arg decorator',
      '4:$@ variable',
      '4:string type',
      '5:@option decorator',
      '5:-v|--verbose parameter',
      '6:@set decorator',
      '6:BU_RET variable',
      '6:path type',
      '7:@exitcode decorator',
      '7:1 number',
      '8:@see decorator',
    ])
  })

  it('reads indented blocks and comments without a space after #', () => {
    const source = ['f() {', '  #@arg $1 {int} count', '  g() { :; }', '}'].join('\n')
    expect(tokens(source)).toEqual([
      '1:@arg decorator',
      '1:$1 variable',
      '1:int type',
      '1:count parameter',
    ])
  })

  it('keeps the tag of an @arg without a parameter', () => {
    expect(tokens('# @arg missing slot\nf() { :; }')).toEqual(['0:@arg decorator'])
  })

  it('ignores tags in code fences, trailing comments and indented text', () => {
    const source = [
      '# @example',
      '# ```',
      '# @arg $1 {int} n',
      '# ```',
      '#   @arg $1 {int} n',
      'echo hi # @arg $1 {int} n',
      'case $1 in',
      '-h)# @arg $1 {int} n',
      '  ;;',
      'esac',
    ].join('\n')
    expect(tokens(source)).toEqual(['0:@example decorator'])
  })
})
