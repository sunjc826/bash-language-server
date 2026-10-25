import { readFileSync } from 'node:fs'
import * as path from 'node:path'

/**
 * Static option and subcommand data extracted from the Fig completion specs by
 * scripts/extract-fig-specs.mjs.
 */
export type FigArg = {
  name?: string
  description?: string
  isOptional?: boolean
  // Takes all remaining words, or those not taken by the slots after it.
  isVariadic?: boolean
  // The words from here on are another command, as in `sudo tar -xzf`.
  isCommand?: boolean
}

export type FigOption = {
  name: string[]
  description?: string
  // Number of required arguments that follow the option.
  argCount?: number
  args?: FigArg[]
  // Persistent options also apply to all subcommands.
  isPersistent?: boolean
}

export type FigCommand = {
  name: string[]
  description?: string
  options?: FigOption[]
  subcommands?: FigCommand[]
  args?: FigArg[]
  // Another spec file that defines this subcommand.
  loadSpec?: string
  // Single-dash options are whole words (e.g. `go test -run`), not chained flags.
  posixNoncompliant?: boolean
}

export type FigOptionSuggestion = {
  name: string
  description?: string
}

/** What a non-option word of a command line stands for. */
export type FigArgumentDescription =
  | { kind: 'subcommand'; name: string; description?: string }
  | { kind: 'value'; option: string; name?: string; description?: string }
  | {
      kind: 'argument'
      name?: string
      description?: string
      isOptional?: boolean
      isVariadic?: boolean
    }

/** What each word after the command name turned out to be. */
type WordRole =
  | { kind: 'subcommand'; command: FigCommand }
  | { kind: 'option' }
  | { kind: 'value'; option: FigOption; index: number }
  | { kind: 'argument'; command: FigCommand; position: number }
  | { kind: 'command' }
  | { kind: 'separator' }

type WalkState = {
  command: FigCommand
  persistent: FigOption[]
  // Arguments already given to the current command.
  positional: number
  // The next word is the value of this option.
  pendingValue?: { option: FigOption; index: number }
  // After `--`, every word is an argument.
  operandsOnly: boolean
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
   * source. `root` replaces the spec for the command name, such as one built
   * from a builtin's help text.
   */
  public getOptions(
    words: string[],
    prefix: string,
    root?: FigCommand,
  ): FigOptionSuggestion[] | null {
    const context = this.optionContext(words, root)
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
  public describeOption(
    words: string[],
    word: string,
    root?: FigCommand,
  ): FigOption[] | null {
    const context = this.optionContext(words, root)
    if (!context) return null
    if (context.options.length === 0) return []
    return this.parseOptionWordIn(word, context.command, context.persistent).options
  }

  /**
   * Describe the word at `index` of a whole command line (`words[0]` is the
   * command name) when it is a subcommand, an option's value or an argument.
   * Returns null for options, unknown commands and words the spec does not
   * describe.
   */
  public describeArgument(
    words: string[],
    index: number,
    root?: FigCommand,
  ): FigArgumentDescription | null {
    const roles = this.walk(words, root)?.roles
    const role = roles?.[index]
    if (!roles || !role) return null

    switch (role.kind) {
      case 'subcommand':
        return {
          kind: 'subcommand',
          name: role.command.name.find((n) => n === words[index]) ?? role.command.name[0],
          description: role.command.description,
        }
      case 'value': {
        const arg = role.option.args?.[role.index]
        return {
          kind: 'value',
          option: role.option.name.find((n) => n.startsWith('-')) ?? role.option.name[0],
          name: arg?.name,
          description: arg?.description,
        }
      }
      case 'argument': {
        // Count the command's arguments on the whole line, so slots after a
        // variadic one (`cp source... target`) take the last words.
        const count = roles.filter(
          (r) => r?.kind === 'argument' && r.command === role.command,
        ).length
        const slot = argumentSlot(role.command.args ?? [], role.position, count)
        return slot && (slot.name || slot.description)
          ? {
              kind: 'argument',
              name: slot.name,
              description: slot.description,
              isOptional: slot.isOptional,
              isVariadic: slot.isVariadic,
            }
          : null
      }
      default:
        return null
    }
  }

  /**
   * Follow the words after the command name into subcommands, and collect
   * the options that apply there: the subcommand's own, persistent ones from
   * its parents, and dash-prefixed subcommands. No options apply after `--`.
   */
  private optionContext(
    words: string[],
    root?: FigCommand,
  ): { command: FigCommand; persistent: FigOption[]; options: FigOption[] } | null {
    const end = this.walk(words, root)?.end
    if (!end) {
      return null
    }

    const { command, persistent } = end
    return {
      command,
      persistent,
      options: end.operandsOnly
        ? []
        : [...(command.options ?? []), ...persistent, ...optionLikeSubcommands(command)],
    }
  }

  /**
   * Walk a command line through the spec of its command, recording what each
   * word is. `end` is the state after the last word, or null when a word
   * starts another command that has no spec.
   */
  private walk(
    words: string[],
    root?: FigCommand,
  ): { roles: (WordRole | undefined)[]; end: WalkState | null } | null {
    const [name] = words
    if (!name || !COMMAND_NAME.test(name)) {
      return null
    }

    const spec = root ?? this.loadSpec(name)
    if (!spec) {
      return null
    }

    const roles: (WordRole | undefined)[] = [undefined]
    let state: WalkState = {
      command: spec,
      persistent: [],
      positional: 0,
      operandsOnly: false,
    }
    for (let i = 1; i < words.length; i++) {
      const token = words[i]

      if (state.pendingValue) {
        const { option, index } = state.pendingValue
        roles.push({ kind: 'value', option, index })
        state.pendingValue =
          index + 1 < (option.argCount ?? 0) ? { option, index: index + 1 } : undefined
        continue
      }

      if (!state.operandsOnly) {
        if (token === '--') {
          roles.push({ kind: 'separator' })
          state.operandsOnly = true
          continue
        }

        // Some specs model modes as dash-prefixed subcommands (e.g. `tar -x`).
        const subcommand =
          state.positional === 0
            ? state.command.subcommands?.find((s) => s.name.includes(token))
            : undefined
        if (subcommand) {
          const command = this.resolveSubcommand(subcommand)
          roles.push({ kind: 'subcommand', command })
          state = {
            command,
            persistent: [...state.persistent, ...persistentOptions(state.command)],
            positional: 0,
            operandsOnly: false,
          }
          continue
        }

        if (token.startsWith('-') && token !== '-') {
          const parsed = this.parseOptionWordIn(token, state.command, state.persistent)
          roles.push({ kind: 'option' })
          state.command = parsed.command
          state.persistent = parsed.persistent
          const last = parsed.options[parsed.options.length - 1]
          if (last?.argCount && !parsed.hasValue) {
            state.pendingValue = { option: last, index: 0 }
          }
          continue
        }
      }

      const slot = argumentSlot(
        state.command.args ?? [],
        state.positional,
        state.positional + 1,
      )
      if (slot?.isCommand) {
        // The rest of the line is another command, as in `sudo tar -xzf`.
        roles.push({ kind: 'command' })
        const nested = this.walk(words.slice(i))
        roles.push(...(nested?.roles.slice(1) ?? []))
        return { roles, end: nested?.end ?? null }
      }
      roles.push({ kind: 'argument', command: state.command, position: state.positional })
      state.positional++
    }

    return { roles, end: state }
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

/**
 * The slot of the argument at `position` among `count` arguments. Slots after
 * a variadic one take the last words: `cp a b c` is source, source, target.
 */
function argumentSlot(
  args: FigArg[],
  position: number,
  count: number,
): FigArg | undefined {
  const variadic = args.findIndex((a) => a.isVariadic)
  if (variadic === -1 || position < variadic) {
    return args[position]
  }
  const fromEnd = count - position
  const after = args.length - variadic - 1
  return fromEnd <= after ? args[args.length - fromEnd] : args[variadic]
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
