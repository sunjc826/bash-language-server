/**
 * File path completion utilities.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Get file and directory completions for a partial path.
 * Supports ~, relative, and absolute paths.
 */
export function getFileCompletions(partial: string, cwd: string): string[] {
  // Expand tilde
  let expanded = partial
  if (expanded.startsWith('~')) {
    const home = process.env.HOME || '/root'
    expanded = path.join(home, expanded.slice(1))
  }

  const dir = path.isAbsolute(expanded)
    ? path.dirname(expanded)
    : path.dirname(path.join(cwd, expanded))

  const base = path.basename(expanded)

  // If the partial ends with /, list inside that directory
  const searchDir = partial.endsWith('/')
    ? path.isAbsolute(expanded)
      ? expanded
      : path.join(cwd, expanded)
    : dir

  const prefix = partial.endsWith('/') ? '' : base

  try {
    const entries = fs.readdirSync(searchDir, { withFileTypes: true })
    const completions: string[] = []

    for (const entry of entries) {
      if (entry.name.startsWith('.') && !prefix.startsWith('.')) continue
      if (prefix && !entry.name.startsWith(prefix)) continue

      const suffix = entry.isDirectory() ? '/' : ''
      completions.push(entry.name + suffix)
    }

    // Reconstruct the full path for the label
    if (partial.endsWith('/')) {
      return completions
    }

    // For partial paths, we need to return the suffix to append
    // The LSP completion will replace based on the word prefix
    return completions
  } catch {
    return []
  }
}

/**
 * Determine if a word looks like it's a file path argument.
 */
export function isFilePathContext(word: string): boolean {
  if (!word) return false
  return (
    word.startsWith('./') ||
    word.startsWith('../') ||
    word.startsWith('/') ||
    word.startsWith('~/') ||
    word.includes('/')
  )
}

/**
 * Try to resolve a path string by expanding $VAR and ${VAR} references
 * using environment variables from process.env.
 *
 * Also handles concatenation patterns like "$HOME"/.local/ —
 * stripping quotes from string parts and joining with unquoted parts.
 */
export function resolvePathWithEnv(pathStr: string): string {
  let result = ''
  let i = 0

  while (i < pathStr.length) {
    if (pathStr[i] === '"' || pathStr[i] === "'") {
      // Quoted section: extract content, expand vars, skip the quotes
      const quote = pathStr[i]
      i++ // skip opening quote
      let content = ''
      while (i < pathStr.length && pathStr[i] !== quote) {
        content += pathStr[i]
        i++
      }
      if (i < pathStr.length) i++ // skip closing quote
      // Expand variables inside the quoted content
      result += expandEnvVars(content)
    } else {
      result += pathStr[i]
      i++
    }
  }

  // Also expand any remaining unquoted $VAR references in the full result
  return expandEnvVars(result)
}

/** Expand $VAR and ${VAR} patterns using process.env. */
function expandEnvVars(s: string): string {
  return s
    .replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '')
    .replace(/\$(\w+)/g, (_, name) => process.env[name] || '')
}

/**
 * Given a concatenation text like '"$HOME"/.local/', resolve the full
 * path by expanding environment variables and stripping quotes.
 * Returns the resolved absolute path, or null if it can't be resolved.
 */
export function resolveConcatenationPath(concatText: string): string | null {
  // Split concatenation into parts: quoted strings, unquoted words
  // e.g. '"$HOME"/.local/' -> expand $HOME, join with /.local/
  const resolved = resolvePathWithEnv(concatText)
  if (!resolved) return null

  // Expand tilde
  if (resolved.startsWith('~')) {
    const home = process.env.HOME || '/root'
    return home + resolved.slice(1)
  }

  return resolved
}
