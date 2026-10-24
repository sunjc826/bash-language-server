#!/usr/bin/env node
// Extract the static parts of the Fig completion specs (names, descriptions,
// options and subcommands) into one JSON file per spec. The server reads these
// for option completion. Generators, scripts and other functions are dropped,
// so no spec code runs inside the language server.
//
// Usage: node scripts/extract-fig-specs.mjs [output directory]
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

const outDir = path.resolve(process.argv[2] ?? 'server/out/fig-specs')
// These cloud CLI specs are about 60 MB of the ~70 MB output, so leave them
// out (spec and subcommand files alike) and let bash-completion handle them.
const EXCLUDED_SPECS = new Set(['aws', 'az', 'gcloud'])
// Corrections to specs whose parser directives do not match the command.
const SPEC_OVERRIDES = {
  // The tar spec marks its flags POSIX-noncompliant for the old `tar xzf`
  // form, but `tar -xzf` groups short options like any other command.
  tar: (command) => ({ ...command, posixNoncompliant: undefined }),
}
const buildDir = path.dirname(
  createRequire(import.meta.url).resolve('@withfig/autocomplete'),
)

const toArray = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value]

const toNames = (name) => toArray(name).filter((n) => typeof n === 'string' && n)

const toDescription = (description) =>
  typeof description === 'string' && description.trim()
    ? description.trim()
    : undefined

// Drop undefined fields to keep the output small.
const compact = (object) =>
  Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined))

function convertOption(option) {
  const name = toNames(option?.name)
  if (option?.hidden || name.length === 0) {
    return undefined
  }

  const argCount = toArray(option.args).filter((arg) => !arg?.isOptional).length
  return compact({
    name,
    description: toDescription(option.description),
    argCount: argCount || undefined,
    isPersistent: option.isPersistent === true || undefined,
  })
}

function convertCommand(command) {
  const name = toNames(command?.name)
  if (name.length === 0) {
    return undefined
  }

  // An inline loadSpec replaces the subcommand's own definition, while a
  // string names another spec file. Functions would need to run, so skip them.
  const loaded =
    typeof command.loadSpec === 'object' && command.loadSpec !== null
      ? command.loadSpec
      : command
  const options = toArray(loaded.options).map(convertOption).filter(Boolean)
  const subcommands = toArray(loaded.subcommands).map(convertCommand).filter(Boolean)

  return compact({
    name,
    description: toDescription(command.description ?? loaded.description),
    options: options.length ? options : undefined,
    subcommands: subcommands.length ? subcommands : undefined,
    loadSpec: typeof command.loadSpec === 'string' ? command.loadSpec : undefined,
    posixNoncompliant:
      loaded.parserDirectives?.flagsArePosixNoncompliant === true || undefined,
  })
}

async function* specFiles(dir, relative = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const key = path.posix.join(relative, entry.name)
    if (EXCLUDED_SPECS.has(key.split('/')[0].replace(/\.js$/, ''))) {
      continue
    }
    if (entry.isDirectory()) {
      // dynamic/ holds runtime helpers rather than specs.
      if (key !== 'dynamic') yield* specFiles(path.join(dir, entry.name), key)
    } else if (entry.name.endsWith('.js') && key !== 'index.js') {
      yield { file: path.join(dir, entry.name), key: key.slice(0, -'.js'.length) }
    }
  }
}

await rm(outDir, { recursive: true, force: true })

let written = 0
let skipped = 0
for await (const { file, key } of specFiles(buildDir)) {
  const spec = (await import(pathToFileURL(file).href)).default
  // Versioned and dynamic specs are functions that compute the spec at runtime.
  const converted = typeof spec === 'object' ? convertCommand(spec) : undefined
  if (!converted) {
    skipped++
    continue
  }
  const command = SPEC_OVERRIDES[key]?.(converted) ?? converted

  const target = path.join(outDir, `${key}.json`)
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(command))
  written++
}

// oxlint-disable-next-line no-console
console.log(`Extracted ${written} Fig specs to ${outDir} (skipped ${skipped})`)
