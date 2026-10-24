import * as path from 'node:path'

/**
 * Converts a pathEnvInit glob to a regular expression. `(*)` captures one
 * path segment, `*` and `?` match within a segment and `**` spans segments.
 */
export function pathEnvInitPatternToRegExp(pattern: string): RegExp {
  let source = ''
  for (let i = 0; i < pattern.length; i++) {
    if (pattern.startsWith('(*)', i)) {
      source += '([^/]*)'
      i += 2
    } else if (pattern.startsWith('**/', i)) {
      source += '(?:.*/)?'
      i += 2
    } else if (pattern.startsWith('**', i)) {
      source += '.*'
      i += 1
    } else if (pattern[i] === '*') {
      source += '[^/]*'
    } else if (pattern[i] === '?') {
      source += '[^/]'
    } else {
      source += pattern[i].replace(/[\\^$.|+()[\]{}]/g, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/**
 * Matches a file against a pathEnvInit pattern and returns the captured
 * segments, or null. Relative patterns are matched against the path relative
 * to the workspace folder.
 */
export function matchPathEnvInitPattern({
  filePath,
  pattern,
  workspaceFolder,
}: {
  filePath: string
  pattern: string
  workspaceFolder: string | null
}): string[] | null {
  let candidate = filePath
  if (!path.isAbsolute(pattern)) {
    if (!workspaceFolder) return null
    candidate = path.relative(workspaceFolder, filePath)
    if (candidate.startsWith('..') || path.isAbsolute(candidate)) return null
  }

  const match = pathEnvInitPatternToRegExp(pattern).exec(
    candidate.split(path.sep).join('/'),
  )
  return match ? match.slice(1) : null
}

/** Replaces $1, $2, … with the corresponding captured segments. */
export function expandPathEnvInitCaptures(template: string, captures: string[]): string {
  return template.replace(
    /\$(\d+)/g,
    (_, index: string) => captures[Number(index) - 1] ?? '',
  )
}
