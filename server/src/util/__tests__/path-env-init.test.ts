import { describe, expect, it } from 'vitest'

import { expandPathEnvInitCaptures, matchPathEnvInitPattern } from '../path-env-init'

const match = (pattern: string, filePath: string, workspaceFolder = '/work') =>
  matchPathEnvInitPattern({ filePath, pattern, workspaceFolder })

describe('matchPathEnvInitPattern', () => {
  it('captures segments in order', () => {
    expect(
      match('projects/(*)/scripts/(*).sh', '/work/projects/api/scripts/run.sh'),
    ).toEqual(['api', 'run'])
  })

  it('matches ** across segments, including none', () => {
    expect(match('libs/**/*.sh', '/work/libs/a/b/c.sh')).toEqual([])
    expect(match('libs/**/*.sh', '/work/libs/c.sh')).toEqual([])
    expect(match('libs/*.sh', '/work/libs/a/c.sh')).toBeNull()
  })

  it('treats regular expression characters literally', () => {
    expect(match('a+b/(x).sh', '/work/a+b/(x).sh')).toEqual([])
    expect(match('a.sh', '/work/aXsh')).toBeNull()
  })

  it('matches absolute patterns against the absolute path', () => {
    expect(match('/opt/(*)/*.sh', '/opt/tool/env.sh', '/elsewhere')).toEqual(['tool'])
  })

  it('does not match relative patterns outside the workspace', () => {
    expect(match('*.sh', '/other/run.sh')).toBeNull()
    expect(
      matchPathEnvInitPattern({
        filePath: '/run.sh',
        pattern: '*.sh',
        workspaceFolder: null,
      }),
    ).toBeNull()
  })
})

describe('expandPathEnvInitCaptures', () => {
  it('replaces numbered captures and drops missing ones', () => {
    expect(expandPathEnvInitCaptures('/opt/$1/$2/$3', ['a', 'b'])).toBe('/opt/a/b/')
  })
})
