import { readFileSync } from 'node:fs'
import * as path from 'node:path'

/**
 * Static option and subcommand data extracted from the Fig completion specs by
 * scripts/extract-fig-specs.mjs.
 */
export type FigOption = {
  name: string[]
  description?: string
  // Number of required arguments that follow the option.
  argCount?: number
  // Persistent options also apply to all subcommands.
  isPersistent?: boolean
}

export type FigCommand = {
  name: string[]
  description?: string
  options?: FigOption[]
  subcommands?: FigCommand[]
  // Another spec file that defines this subcommand.
  loadSpec?: string
  // Single-dash options are whole words (e.g. `go test -run`), not chained flags.
  posixNoncompliant?: boolean
}

export type FigOptionSuggestion = {
  name: string
  description?: string
}

// Same restriction as get-options.sh: plain command names only.
const COMMAND_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/
// Spec keys referenced by loadSpec may contain directories (e.g. aws/s3).
const SPEC_KEY = /^[A-Za-z0-9_@][A-Za-z0-9_.+@-]*(\/[A-Za-z0-9_@][A-Za-z0-9_.+@-]*)*$/

export class FigSpecs {
  private readonly cache = new Map<string, FigCommand | null>()

  constructor(private readonly specDirectory = path.join(__dirname, '..', 'fig-specs')) {}

  /**
   * Find the options that apply after the given command words, starting with
   * the command name and excluding the word being completed. Returns null when
   * there is no spec for the command, so callers can fall back to another
   * source.
   */
  public getOptions(words: string[], prefix: string): FigOptionSuggestion[] | null {
    const context = this.optionContext(words)
    if (!context) {
      return null
    }

    const suggestions = new Map<string, FigOptionSuggestion>()
    for (const option of context.options) {
      for (const optionName of option.name) {
        if (optionName.startsWith(prefix) && !suggestions.has(optionName)) {
          suggestions.set(optionName, {
            name: optionName,
            description: option.description,
          })
        }
      }
    }

    return [...suggestions.values()]
  }

  /**
   * Find the options an option word such as `--all`, `--file=x` or `-xzf`
   * stands for after the given command words. Returns null when there is no
   * spec for the command.
   */
  public describeOption(words: string[], word: string): FigOption[] | null {
    const context = this.optionContext(words)
    return context
      ? parseOptionWord(word, context.options, context.command.posixNoncompliant === true)
          .options
      : null
  }

  /**
   * Follow the words after the command name into subcommands, and collect
   * the options that apply there: the subcommand's own, persistent ones from
   * its parents, and dash-prefixed subcommands. No options apply after `--`.
   */
  private optionContext(
    words: string[],
  ): { command: FigCommand; options: FigOption[] } | null {
    const [name, ...args] = words
    if (!name || !COMMAND_NAME.test(name)) {
      return null
    }

    let command = this.loadSpec(name)
    if (!command) {
      return null
    }

    const persistent: FigOption[] = []
    for (let i = 0; i < args.length; i++) {
      const token = args[i]
      if (token === '--') {
        // Everything after `--` is an operand.
        return { command, options: [] }
      }

      // Some specs model modes as dash-prefixed subcommands (e.g. `tar -x`).
      const subcommand = command.subcommands?.find((s) => s.name.includes(token))
      if (subcommand) {
        persistent.push(...(command.options ?? []).filter((o) => o.isPersistent))
        command = this.resolveSubcommand(subcommand)
      } else if (token.startsWith('-')) {
        const { options, hasValue } = parseOptionWord(
          token,
          [...(command.options ?? []), ...persistent],
          command.posixNoncompliant === true,
        )
        const last = options[options.length - 1]
        if (last?.argCount && !hasValue) {
          i += last.argCount
        }
      }
    }

    const optionLikeSubcommands = (command.subcommands ?? []).filter((s) =>
      s.name.some((n) => n.startsWith('-')),
    )
    return {
      command,
      options: [...(command.options ?? []), ...persistent, ...optionLikeSubcommands],
    }
  }

  private resolveSubcommand(subcommand: FigCommand): FigCommand {
    const loaded = subcommand.loadSpec ? this.loadSpec(subcommand.loadSpec) : null
    return loaded ? { ...loaded, name: subcommand.name } : subcommand
  }

  private loadSpec(key: string): FigCommand | null {
    const cached = this.cache.get(key)
    if (cached !== undefined) {
      return cached
    }

    let spec: FigCommand | null = null
    if (SPEC_KEY.test(key) && !key.split('/').includes('..')) {
      try {
        spec = JSON.parse(
          readFileSync(path.join(this.specDirectory, `${key}.json`), 'utf8'),
        ) as FigCommand
      } catch {
        // No spec for this command (or the data was not generated).
      }
    }

    this.cache.set(key, spec)
    return spec
  }
}

/**
 * The options an option word stands for, and whether it already holds the
 * value of the last one: `--file=x`, or `-ffile` when -f takes an argument.
 * Chained short flags such as `-xzf` stand for each flag in turn.
 */
function parseOptionWord(
  word: string,
  options: FigOption[],
  posixNoncompliant: boolean,
): { options: FigOption[]; hasValue: boolean } {
  const separator = word.indexOf('=')
  const name = separator === -1 ? word : word.slice(0, separator)
  const hasValue = separator !== -1

  const exact = options.find((o) => o.name.includes(name))
  if (exact || posixNoncompliant || !/^-[^-]{2,}$/.test(name)) {
    return { options: exact ? [exact] : [], hasValue }
  }

  const flags: FigOption[] = []
  for (let i = 1; i < name.length; i++) {
    const flag = options.find((o) => o.name.includes(`-${name[i]}`))
    if (!flag) continue
    flags.push(flag)
    // The rest of the word is the value of a flag that takes an argument.
    if (flag.argCount) {
      return { options: flags, hasValue: hasValue || i < name.length - 1 }
    }
  }
  return { options: flags, hasValue }
}
