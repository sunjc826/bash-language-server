import * as ChildProcess from 'child_process'
import { basename, isAbsolute } from 'path'

import { isBuiltin } from '../builtins'
import { FigOption } from './fig-options'
import { logger } from './logger'
import { isWindows } from './platform'

/**
 * Execute the following sh program.
 */
export function execShellScript(
  body: string,
  cmd = isWindows() ? 'cmd.exe' : 'bash',
): Promise<string> {
  const args = []

  if (cmd === 'cmd.exe') {
    args.push('/c', body)
  } else {
    args.push('--noprofile', '--norc', '-c', body)
  }

  return execProgram(cmd, args, body)
}

function execProgram(
  cmd: string,
  args: string[],
  description: string,
  input?: string,
): Promise<string> {
  const process = ChildProcess.spawn(cmd, args)

  return new Promise((resolve, reject) => {
    let output = ''

    const handleClose = (returnCode: number | Error) => {
      if (returnCode === 0) {
        resolve(output)
      } else {
        reject(`Failed to execute ${description}`)
      }
    }

    process.stdout.on('data', (buffer) => {
      output += buffer
    })

    process.on('close', handleClose)
    process.on('error', handleClose)
    if (input !== undefined) {
      process.stdin.on('error', handleClose)
      process.stdin.end(input)
    }
  })
}

// Currently only reserved words where documentation doesn't make sense.
// At least on OS X these just return the builtin man. On ubuntu there
// are no documentation for them.
const WORDS_WITHOUT_DOCUMENTATION = new Set([
  'else',
  'fi',
  'then',
  'esac',
  'elif',
  'done',
])

/**
 * Get documentation for the given word by using help and man.
 */
export async function getShellDocumentationWithoutCache({
  word,
}: {
  word: string
}): Promise<string | null> {
  const absolutePath = isAbsolute(word)
  const commandName = absolutePath ? basename(word) : word

  if (!absolutePath && word.split(' ').length > 1) {
    throw new Error(`lookupDocumentation should be given a word, received "${word}"`)
  }

  if (WORDS_WITHOUT_DOCUMENTATION.has(word)) {
    return null
  }

  const DOCUMENTATION_COMMANDS = [
    // An absolute path always invokes an external command, never a shell builtin.
    ...(!absolutePath
      ? [{ type: 'help', execute: () => execShellScript(`help ${word} | col -bx`) }]
      : []),
    // We have experimented with setting MANWIDTH to different values for reformatting.
    // The default line width of the terminal works fine for hover, but could be better
    // for completions.
    {
      type: 'man',
      execute: async () => {
        if (absolutePath) {
          // Pass filenames as arguments rather than shell syntax (also on Windows).
          const output = await execProgram(
            'man',
            ['-P', 'cat', '--', commandName],
            `man ${commandName}`,
          )
          return execProgram('col', ['-bx'], 'col -bx', output)
        }
        return execShellScript(`man -P cat ${word} | col -bx`)
      },
    },
  ]

  for (const { type, execute } of DOCUMENTATION_COMMANDS) {
    try {
      const documentation = await execute()
      if (documentation) {
        let formattedDocumentation = documentation.trim()

        if (type === 'man') {
          formattedDocumentation = formatManOutput(formattedDocumentation)
        }

        if (formattedDocumentation) {
          return formattedDocumentation
        }
      }
    } catch (error) {
      // Ignoring if command fails and store failure in cache
      logger.error(`getShellDocumentation failed for "${word}"`, error)
    }
  }

  return null
}

export function formatManOutput(manOutput: string): string {
  const indexNameBlock = manOutput.indexOf('NAME')
  const indexBeforeFooter = manOutput.lastIndexOf('\n')

  if (indexNameBlock < 0 || indexBeforeFooter < 0) {
    return manOutput
  }

  const formattedManOutput = manOutput.slice(indexNameBlock, indexBeforeFooter)

  if (!formattedManOutput) {
    logger.error(`formatManOutput failed`, { manOutput })
    return manOutput
  }

  return formattedManOutput
}

/**
 * Only works for one-parameter (serializable) functions.
 */
/* oxlint-disable typescript/no-unsafe-function-type */
export function memorize<T extends Function>(func: T): T {
  const cache = new Map()

  const returnFunc = async function (arg: any) {
    const cacheKey = JSON.stringify(arg)

    if (cache.has(cacheKey)) {
      return cache.get(cacheKey)
    }

    const result = await func(arg)

    cache.set(cacheKey, result)
    return result
  }

  return returnFunc as any
}

export const getShellDocumentation = memorize(getShellDocumentationWithoutCache)

/**
 * The options described in the "Options" sections of a builtin's `help`
 * text, such as `-f<TAB>treat each NAME as a shell function` for unset.
 * Bash separates a flag (and its value name) from its description with a
 * tab or, for `set`, two spaces; deeper-indented lines continue it.
 */
export function parseHelpOptions(help: string): FigOption[] {
  const options: FigOption[] = []
  let inSection = false
  let entryIndent: number | null = null

  for (const line of help.split('\n')) {
    if (/^\s*Options\b[^:]*:\s*$/.test(line)) {
      inSection = true
      entryIndent = null
      continue
    }
    if (!inSection) continue
    if (!line.trim()) {
      inSection = false
      continue
    }

    const leading = /^[ \t]*/.exec(line)?.[0] ?? ''
    const entry = /^(-\S*)(?: (\S[^\t]*?))?(?:\t+| {2,}|$)(.*)$/.exec(
      line.slice(leading.length),
    )
    if (
      entry &&
      !leading.includes('\t') &&
      (entryIndent === null || leading.length === entryIndent)
    ) {
      entryIndent = leading.length
      const [, flag, argument, description] = entry
      options.push({
        name: [flag],
        description: description.trim(),
        ...(argument && { argCount: 1 }),
      })
    } else if (options.length > 0) {
      const last = options[options.length - 1]
      last.description = [last.description, line.trim()].filter(Boolean).join(' ')
    }
  }

  return options
}

/**
 * The options a builtin's `help` text describes, or none when the builtin
 * is unknown or bash cannot describe it.
 */
export const getBuiltinOptions: (builtin: string) => Promise<FigOption[]> = memorize(
  async (builtin: string): Promise<FigOption[]> => {
    // The name is interpolated into the script, so only accept known builtins.
    if (!isBuiltin(builtin)) return []
    try {
      return parseHelpOptions(await execShellScript(`help ${builtin}`))
    } catch (error) {
      logger.error(`getBuiltinOptions failed for "${builtin}"`, error)
      return []
    }
  },
)
