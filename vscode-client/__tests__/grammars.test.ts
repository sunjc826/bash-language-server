import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
const packageJson = require('../package.json')

describe('grammars', () => {
  const grammars: { scopeName: string; path: string; injectTo?: string[] }[] =
    packageJson.contributes.grammars

  it('contributes grammar files that parse and declare their scope', () => {
    for (const grammar of grammars) {
      const file = JSON.parse(readFileSync(join(__dirname, '..', grammar.path), 'utf8'))
      expect(file.scopeName).toBe(grammar.scopeName)
      if (grammar.injectTo) expect(file.injectionSelector).toBeTruthy()
    }
  })
})
