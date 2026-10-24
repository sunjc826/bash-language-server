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
        return []
      }

      // Some specs model modes as dash-prefixed subcommands (e.g. `tar -x`).
      const subcommand = command.subcommands?.find((s) => s.name.includes(token))
      if (subcommand) {
        persistent.push(...(command.options ?? []).filter((o) => o.isPersistent))
        command = this.resolveSubcommand(subcommand)
      } else if (token.startsWith('-')) {
        const option = findOption(token, [...(command.options ?? []), ...persistent], {
          posixNoncompliant: command.posixNoncompliant === true,
        })
        if (option?.argCount && !token.includes('=')) {
          i += option.argCount
        }
      }
    }

    const suggestions = new Map<string, FigOptionSuggestion>()
    const optionLikeSubcommands = (command.subcommands ?? []).filter((s) =>
      s.name.some((n) => n.startsWith('-')),
    )
    for (const option of [
      ...(command.options ?? []),
      ...persistent,
      ...optionLikeSubcommands,
    ]) {
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

function findOption(
  token: string,
  options: FigOption[],
  { posixNoncompliant }: { posixNoncompliant: boolean },
): FigOption | undefined {
  const name = token.split('=')[0]
  const exact = options.find((o) => o.name.includes(name))
  if (exact || posixNoncompliant || !/^-[^-]{2,}$/.test(name)) {
    return exact
  }

  // Chained short flags such as `-xzf archive`: only the last flag can take
  // an argument.
  return options.find((o) => o.name.includes(`-${name[name.length - 1]}`))
}
