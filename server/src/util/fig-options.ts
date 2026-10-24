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
    if (!context) return null
    if (context.options.length === 0) return []
    return this.parseOptionWordIn(word, context.command, context.persistent).options
  }

  /**
   * Follow the words after the command name into subcommands, and collect
   * the options that apply there: the subcommand's own, persistent ones from
   * its parents, and dash-prefixed subcommands. No options apply after `--`.
   */
  private optionContext(
    words: string[],
  ): { command: FigCommand; persistent: FigOption[]; options: FigOption[] } | null {
    const [name, ...args] = words
    if (!name || !COMMAND_NAME.test(name)) {
      return null
    }

    let command = this.loadSpec(name)
    if (!command) {
      return null
    }

    let persistent: FigOption[] = []
    for (let i = 0; i < args.length; i++) {
      const token = args[i]
      if (token === '--') {
        // Everything after `--` is an operand.
        return { command, persistent, options: [] }
      }

      // Some specs model modes as dash-prefixed subcommands (e.g. `tar -x`).
      const subcommand = command.subcommands?.find((s) => s.name.includes(token))
      if (subcommand) {
        persistent = [...persistent, ...persistentOptions(command)]
        command = this.resolveSubcommand(subcommand)
      } else if (token.startsWith('-')) {
        const parsed = this.parseOptionWordIn(token, command, persistent)
        ;({ command, persistent } = parsed)
        const last = parsed.options[parsed.options.length - 1]
        if (last?.argCount && !parsed.hasValue) {
          i += last.argCount
        }
      }
    }

    return {
      command,
      persistent,
      options: [
        ...(command.options ?? []),
        ...persistent,
        ...optionLikeSubcommands(command),
      ],
    }
  }

  /**
   * Parse an option word in a command. A group of short flags that includes
   * a dash-prefixed subcommand, such as the mode in `tar -xzf` or `tar -zxf`,
   * enters that subcommand, and all of the group's flags are read there.
   */
  private parseOptionWordIn(
    word: string,
    command: FigCommand,
    persistent: FigOption[],
  ): {
    options: FigOption[]
    hasValue: boolean
    command: FigCommand
    persistent: FigOption[]
  } {
    const options = [...(command.options ?? []), ...persistent]
    const modes = optionLikeSubcommands(command)
    const posixNoncompliant = command.posixNoncompliant === true
    const name = word.split('=')[0]
    const mode =
      !posixNoncompliant &&
      /^-[^-]{2,}$/.test(name) &&
      !options.some((o) => o.name.includes(name))
        ? modes.find((m) =>
            name
              .slice(1)
              .split('')
              .some((flag) => m.name.includes(`-${flag}`)),
          )
        : undefined

    if (!mode) {
      const parsed = parseOptionWord(word, [...options, ...modes], posixNoncompliant)
      return { ...parsed, command, persistent }
    }

    const modeCommand = this.resolveSubcommand(mode)
    const modePersistent = [...persistent, ...persistentOptions(command)]
    const parsed = parseOptionWord(
      word,
      [mode, ...(modeCommand.options ?? []), ...modePersistent],
      false,
    )
    return { ...parsed, command: modeCommand, persistent: modePersistent }
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

function persistentOptions(command: FigCommand): FigOption[] {
  return (command.options ?? []).filter((o) => o.isPersistent)
}

// Some specs model modes as dash-prefixed subcommands (e.g. `tar -x`).
function optionLikeSubcommands(command: FigCommand): FigCommand[] {
  return (command.subcommands ?? []).filter((s) => s.name.some((n) => n.startsWith('-')))
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
