/**
 * Sandboxed evaluation of `# bash-ide constexpr` functions.
 *
 * A function annotated with `# bash-ide constexpr` in the comment block above
 * its definition is declared pure enough to be *actually executed* at analysis
 * time. This module owns the process-spawning machinery: building a bash
 * script from the registered definitions, running it (optionally inside a
 * bubblewrap sandbox), and caching successful results.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { logger } from './logger'

/**
 * Input for a single constexpr evaluation.
 */
export interface ConstexprEvaluationInput {
  /** All registered constexpr function definitions, keyed by name. */
  registry: Map<string, string>
  /** The function to invoke. */
  functionName: string
  /** Already-resolved, shell-escaped-agnostic argument values. */
  args: string[]
  /** Variables to pre-seed into the script (shell variables). */
  injectedVariables: Map<string, string>
}

/**
 * Per-analysis budget, refreshed for each top-level analysis pass.
 */
export interface ConstexprBudget {
  /** Number of process spawns remaining in this analysis pass. */
  spawnsRemaining: number
  /** Epoch milliseconds after which no further spawns are allowed. */
  deadline: number
}

export interface ConstexprEvaluatorConfig {
  /** Per-call timeout in milliseconds. */
  timeoutMs: number
  /** How long successful results stay cached. */
  cacheTtlMs: number
}

const VALID_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

// bwrap detection is cached at module scope so it runs once per process.
let bwrapAvailable: boolean | null = null
let bwrapWarningLogged = false

const BWRAP_SANDBOX_ARGS = [
  '--ro-bind',
  '/',
  '/tmp',
  '--dev',
  '/dev',
  '--unshare-net',
  '--unshare-pid',
  '--die-with-parent',
]

/**
 * Shell-quote a value for single-quoted interpolation.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Find the bwrap executable on PATH, or null.
 */
function findBwrapPath(): string | null {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue
    try {
      const candidate = path.join(dir, 'bwrap')
      const stats = fs.statSync(candidate)
      if (stats.isFile() && (stats.mode & 0o111) !== 0) {
        return candidate
      }
    } catch {
      // keep scanning
    }
  }
  return null
}

/**
 * Verify that bwrap can actually create the sandbox (e.g. user namespaces are
 * permitted). A bwrap that is present but non-functional is treated as
 * unavailable so we fall back to plain bash.
 */
function bwrapUsable(bwrapPath: string): boolean {
  try {
    execFileSync(
      bwrapPath,
      [...BWRAP_SANDBOX_ARGS, 'bash', '--norc', '--noprofile', '-c', 'true'],
      {
        env: { PATH: process.env.PATH || '/usr/bin:/bin' },
        timeout: 2000,
        stdio: 'ignore',
      },
    )
    return true
  } catch {
    return false
  }
}

/**
 * Detect whether bubblewrap (`bwrap`) is available and usable. Cached once per
 * process.
 */
function detectBwrap(): boolean {
  if (bwrapAvailable !== null) {
    return bwrapAvailable
  }

  const bwrapPath = findBwrapPath()
  bwrapAvailable = bwrapPath !== null && bwrapUsable(bwrapPath)
  return bwrapAvailable
}

export class ConstexprEvaluator {
  private readonly cache = new Map<string, { value: string; expiresAt: number }>()

  public constructor(private readonly config: ConstexprEvaluatorConfig) {}

  /**
   * Evaluate a constexpr function invocation, returning its stdout (with
   * trailing newlines stripped) or null if it could not be resolved.
   *
   * Successful results are cached; failures are never cached so a later
   * analysis pass with a fresh budget can retry them.
   */
  public evaluate(
    input: ConstexprEvaluationInput,
    budget: ConstexprBudget,
  ): string | null {
    const script = this.buildScript(input)

    const now = Date.now()
    const cached = this.cache.get(script)
    if (cached && cached.expiresAt > now) {
      return cached.value
    }

    // Cache misses and failures must respect the per-analysis budget.
    if (budget.spawnsRemaining <= 0 || now > budget.deadline) {
      return null
    }

    budget.spawnsRemaining -= 1
    const value = this.run(script)
    if (value !== null) {
      this.cache.set(script, { value, expiresAt: now + this.config.cacheTtlMs })
    }
    return value
  }

  /**
   * Build the bash script: injected variables, then all registered function
   * definitions, then the invocation with shell-escaped arguments.
   */
  private buildScript(input: ConstexprEvaluationInput): string {
    const lines: string[] = []

    for (const [name, value] of input.injectedVariables) {
      if (!VALID_IDENTIFIER.test(name)) continue
      lines.push(`${name}=${shellQuote(value)}`)
    }

    for (const [, definition] of input.registry) {
      lines.push(definition)
    }

    if (!VALID_IDENTIFIER.test(input.functionName)) {
      // buildScript is only called after validation upstream; this guards the
      // unlikely case of a malformed function name reaching the evaluator.
      return ''
    }

    const invocation = [input.functionName, ...input.args.map(shellQuote)].join(' ')
    lines.push(invocation)

    return `${lines.join('\n')}\n`
  }

  /**
   * Run the script in a fresh bash process, returning stdout with trailing
   * newlines stripped, or null on any error/timeout/non-zero exit.
   */
  private run(script: string): string | null {
    if (!script) return null

    const bashArgs = ['--norc', '--noprofile', '-c', script]
    const isolated = detectBwrap()
    if (!isolated && !bwrapWarningLogged) {
      bwrapWarningLogged = true
      logger.warn(
        'constexpr functions run without isolation: bwrap (bubblewrap) is not available',
      )
    }

    const command = isolated
      ? ['bwrap', ...BWRAP_SANDBOX_ARGS, 'bash', ...bashArgs]
      : ['bash', ...bashArgs]

    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      HOME: process.env.HOME || '/',
      USER: process.env.USER || '',
    }

    try {
      const stdout = execFileSync(command[0], command.slice(1), {
        env,
        timeout: this.config.timeoutMs,
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      })
      return stdout.replace(/\n+$/, '')
    } catch {
      // Spawn error, timeout, or non-zero exit — treat as unresolvable.
      return null
    }
  }
}
