import * as fs from 'fs'
import FuzzySearch from 'fuzzy-search'
import * as path from 'path'
import * as url from 'url'
import { isDeepStrictEqual } from 'util'
import * as LSP from 'vscode-languageserver/node'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { Node as SyntaxNode, Parser, Point, Tree } from 'web-tree-sitter'

import { getDefaultConfiguration } from './config'
import { flattenArray } from './util/array'
import { parseBashIdeDirectives } from './util/bash-ide-directives'
import { ConstexprEvaluator } from './util/constexpr-evaluator'
import {
  FindDeclarationParams,
  findDeclarationUsingGlobalSemantics,
  findDeclarationUsingLocalSemantics,
  getAllDeclarationsInTree,
  getGlobalDeclarations,
  getLocalDeclarations,
  GlobalDeclarations,
} from './util/declarations'
import {
  FlowAnalyzer,
  FlowAnalysisContext,
  FlowAnalysisOptions,
  InlayHint,
  referenceKey,
} from './util/flow-analysis'
import { concrete, FlowBindings, FlowValue } from './util/flow-value'
import { getFilePaths } from './util/fs'
import { getInputVariableDeclaration, variableNameRange } from './util/input-declarations'
import { logger } from './util/logger'
import { isPositionIncludedInRange } from './util/lsp'
import { expandPathEnvInitCaptures, matchPathEnvInitPattern } from './util/path-env-init'
import { analyzeFile } from './util/shebang'
import * as sourcing from './util/sourcing'
import * as TreeSitterUtil from './util/tree-sitter'
import { Config } from './config'

const BACKGROUND_ANALYSIS_TIMEOUT_MS = 10000
// Upper bound on sourced files analyzed for one document's flow analysis.
const MAX_FLOW_SOURCED_ANALYSES = 100

const SIMPLE_COMMAND_TYPES: ReadonlySet<string> = new Set(['command'])
// Commands whose options can be looked up, including builtins with their own
// node types: declare, export, local, readonly, typeset and unset.
const OPTION_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'command',
  'declaration_command',
  'unset_command',
])

const EXPANSION_TYPES: ReadonlySet<string> = new Set([
  'simple_expansion',
  'expansion',
  'command_substitution',
  'arithmetic_expansion',
  'process_substitution',
])

// Named children of a command that are not part of its argument words.
const NON_ARGUMENT_COMMAND_CHILDREN = new Set([
  'comment',
  'file_redirect',
  'herestring_redirect',
])

type AnalyzedDocument = {
  document: TextDocument
  globalDeclarations: GlobalDeclarations
  sourcedUris: Set<string>
  sourceCommands: sourcing.SourceCommand[]
  tree: Tree
  /** Flow analysis bindings after analysis. */
  flowBindings?: FlowBindings
  /** Values of variable references where analysis reached them. */
  flowReferenceValues?: Map<string, FlowValue>
  /** Inlay hints from flow analysis. */
  inlayHints?: InlayHint[]
  /** Dimmed ranges from constexpr branch evaluation. */
  dimmedRanges?: LSP.Range[]
  /** Source commands with resolved paths that don't exist on disk (for error diagnostics). */
  sourceErrors?: Array<{ range: LSP.Range; path: string }>
  /** Orphaned `# bash-ide constexpr` directive ranges (for error diagnostics). */
  constexprErrors?: LSP.Range[]
}

/**
 * The Analyzer uses the Abstract Syntax Trees (ASTs) that are provided by
 * tree-sitter to find definitions, reference, etc.
 */
export default class Analyzer {
  private backgroundAnalysisController?: AbortController
  private backgroundAnalyzedUris = new Set<string>()
  private config: Config | null = null
  private enableSourceErrorDiagnostics: boolean
  private includeAllWorkspaceSymbols: boolean
  private parser: Parser
  private uriToAnalyzedDocument: Record<string, AnalyzedDocument | undefined> = {}
  private workspaceFolder: string | null
  /** Tracks dynamically-resolved sourced URIs discovered during flow analysis (per source file). */
  private uriToFlowSourcedUris: Map<string, Set<string>> = new Map()
  /** Long-lived constexpr evaluator (and its cache) shared across analyses. */
  private constexprEvaluator: ConstexprEvaluator | null = null
  private constexprConfig: {
    enabled: boolean
    timeoutMs: number
    cacheTtlMs: number
  } | null = null

  public constructor({
    enableSourceErrorDiagnostics = false,
    includeAllWorkspaceSymbols = false,
    parser,
    workspaceFolder,
  }: {
    enableSourceErrorDiagnostics?: boolean
    includeAllWorkspaceSymbols?: boolean
    parser: Parser
    workspaceFolder: string | null
  }) {
    this.enableSourceErrorDiagnostics = enableSourceErrorDiagnostics
    this.includeAllWorkspaceSymbols = includeAllWorkspaceSymbols
    this.parser = parser
    this.workspaceFolder = workspaceFolder
  }

  /** Set the configuration for flow analysis. */
  public setConfig(config: Config): void {
    this.config = config
  }

  /**
   * Configure opt-in constexpr function evaluation. The evaluator (and its
   * cache) is long-lived; it is only recreated when the timeout or cache TTL
   * changes.
   */
  public setConstexprOptions(options: {
    enabled: boolean
    timeoutMs: number
    cacheTtlMs: number
  }): void {
    const previous = this.constexprConfig
    this.constexprConfig = options

    if (
      options.enabled &&
      (!this.constexprEvaluator ||
        !previous ||
        previous.timeoutMs !== options.timeoutMs ||
        previous.cacheTtlMs !== options.cacheTtlMs)
    ) {
      this.constexprEvaluator = new ConstexprEvaluator({
        timeoutMs: options.timeoutMs,
        cacheTtlMs: options.cacheTtlMs,
      })
    }
  }

  /**
   * Analyze the given document, cache the tree-sitter AST, and iterate over the
   * tree to find declarations.
   */
  public analyze({
    document,
    uri, // NOTE: we don't use document.uri to make testing easier
    background = false,
  }: {
    document: TextDocument
    uri: string
    background?: boolean
  }): LSP.Diagnostic[] {
    // An opened/on-demand document must survive subsequent background rescans,
    // including when parsing its new contents fails.
    if (!background) this.backgroundAnalyzedUris.delete(uri)
    const diagnostics: LSP.Diagnostic[] = []
    const fileContent = document.getText()

    const tree = this.parser.parse(fileContent)
    if (!tree) {
      throw new Error(`Failed to parse ${uri}: no syntax tree returned`)
    }

    let globalDeclarations: GlobalDeclarations
    let sourceCommands: sourcing.SourceCommand[]
    try {
      globalDeclarations = getGlobalDeclarations({ tree, uri })
      sourceCommands = sourcing.getSourceCommands({
        fileUri: uri,
        rootPath: this.workspaceFolder,
        tree,
      })
    } catch (error) {
      tree.delete()
      throw error
    }

    const sourcedUris = new Set(
      sourceCommands
        .map((sourceCommand) => sourceCommand.uri)
        .filter((uri): uri is string => uri !== null),
    )

    const analyzedDoc: AnalyzedDocument = {
      document,
      globalDeclarations,
      sourcedUris,
      sourceCommands: sourceCommands.filter((sourceCommand) => !sourceCommand.error),
      tree,
    }
    if (background) this.backgroundAnalyzedUris.add(uri)

    // Run flow analysis if enabled
    if (this.config?.enableFlowAnalysis && tree.rootNode) {
      try {
        this.runFlowAnalysis(analyzedDoc, uri, fileContent)
      } catch (err) {
        logger.warn(`Flow analysis failed for ${uri}: ${String(err)}`)
      }
    }

    // Record sourced URIs that flow analysis resolved dynamically
    // source commands (e.g. source "$LIB_DIR/mylib.sh") that were discovered
    // during flow analysis. Without this, symbols from those files won't appear
    // in completions, go-to-definition, or workspace symbols.
    const flowSourcedUris = this.uriToFlowSourcedUris?.get(uri)
    if (flowSourcedUris) {
      // Sourced files are analyzed on demand (see ensureUrisAreAnalyzed).
      for (const sourcedUri of flowSourcedUris) sourcedUris.add(sourcedUri)
      this.uriToFlowSourcedUris.delete(uri)
    }

    // The AST lives in WebAssembly memory. Waiting for JavaScript finalizers
    // lets that memory grow substantially during repeated edits.
    this.uriToAnalyzedDocument[uri]?.tree.delete()
    this.uriToAnalyzedDocument[uri] = analyzedDoc

    if (!this.includeAllWorkspaceSymbols) {
      sourceCommands
        .filter((sourceCommand) => sourceCommand.error)
        .forEach((sourceCommand) => {
          logger.warn(
            `${uri} line ${sourceCommand.range.start.line}: ${sourceCommand.error}`,
          )

          if (this.enableSourceErrorDiagnostics) {
            diagnostics.push(
              LSP.Diagnostic.create(
                sourceCommand.range,
                [
                  `Source command could not be analyzed: ${sourceCommand.error}.\n`,
                  'Consider adding a ShellCheck directive above this line to fix or ignore this:',
                  '# shellcheck source=/my-file.sh # specify the file to source',
                  '# shellcheck source-path=my_script_folder # specify the folder to search in',
                  '# shellcheck source=/dev/null # to ignore the error',
                  '',
                  'Disable this message by changing the configuration option "enableSourceErrorDiagnostics"',
                ].join('\n'),
                LSP.DiagnosticSeverity.Information,
                undefined,
                'bash-language-server',
              ),
            )
          }
        })
    }

    if (tree.rootNode.hasError) {
      logger.warn(`Error while parsing ${uri}: syntax error`)
    }

    return diagnostics
  }

  /**
   * Run flow-sensitive analysis on a document.
   */
  private runFlowAnalysis(
    analyzedDoc: AnalyzedDocument,
    uri: string,
    fileContent: string,
  ): void {
    if (!this.config) return

    const { pathEnvInit, seedVariables } = this.config
    const filePath = uriToPath(uri)

    // Track dynamically-resolved sourced URIs for this file
    const resolvedSourcedUris = new Set<string>()
    this.uriToFlowSourcedUris.set(uri, resolvedSourcedUris)

    const bashIde = parseBashIdeDirectives(fileContent)
    let cwd = path.dirname(filePath)
    const cwdDirective = bashIde.directives.find((d) => d.type === 'cwd')
    if (cwdDirective?.value) {
      cwd = path.resolve(path.dirname(filePath), cwdDirective.value)
    }

    const workspaceFolder = this.workspaceFolder?.startsWith('file://')
      ? uriToPath(this.workspaceFolder)
      : this.workspaceFolder
    const matchingRules = pathEnvInit.flatMap((rule) => {
      const captures = matchPathEnvInitPattern({
        filePath,
        pattern: rule.path,
        workspaceFolder,
      })
      return captures ? [{ rule, captures }] : []
    })

    const sourcePushd =
      bashIde.directives.some((d) => d.type === 'source-pushd') ||
      matchingRules.some(({ rule }) => rule.sourcePushd)

    let initialBindings: FlowBindings = new Map()
    for (const [varName, value] of Object.entries(seedVariables)) {
      initialBindings.set(varName, concrete(value, 'seed'))
    }
    for (const { rule, captures } of matchingRules) {
      for (const [varName, template] of Object.entries(rule.variables ?? {})) {
        initialBindings.set(
          varName,
          concrete(expandPathEnvInitCaptures(template, captures), 'seed'),
        )
      }
    }

    const constexprOptions = this.buildConstexprFlowOptions()
    // Each sourced file is analyzed in the context of its caller, so results
    // are not cached across source commands. Cycles and the overall amount of
    // sourced work are bounded per top-level analysis.
    const activeUris = new Set<string>([uri])
    let sourcedAnalysesRemaining = MAX_FLOW_SOURCED_ANALYSES

    const analyzeSourcedFile = (
      sourcedUri: string,
      currentPwd?: string,
      callerBindings: FlowBindings = new Map(),
    ): FlowBindings => {
      resolvedSourcedUris.add(sourcedUri)
      if (activeUris.has(sourcedUri) || sourcedAnalysesRemaining <= 0) return new Map()
      sourcedAnalysesRemaining--

      let sourcedTree: Tree | null = null
      activeUris.add(sourcedUri)
      try {
        const sourcedPath = uriToPath(sourcedUri)
        const content = this.getFlowSourceContent(sourcedUri)
        if (content === null) return new Map()
        sourcedTree = this.parser.parse(content)
        if (!sourcedTree) return new Map()

        // A sourced file runs in the caller's shell: it sees the caller's
        // variables and PWD, unless sourcePushd treats its own directory as PWD.
        const sourcedBindings = new Map(callerBindings)
        sourcedBindings.delete('BASH_SOURCE')
        if (sourcePushd) sourcedBindings.delete('PWD')

        const result = FlowAnalyzer.analyzeFile(
          {
            ...ctx,
            uri: sourcedUri,
            content,
            rootNode: sourcedTree.rootNode,
            cwd: sourcePushd ? path.dirname(sourcedPath) : currentPwd || ctx.cwd,
            initialBindings: sourcedBindings,
            trackInlayHints: false,
            referenceValues: undefined,
            inlayHints: [],
            dimmedRanges: [],
            sourceErrors: [],
            constexprErrors: [],
          },
          constexprOptions,
        )

        for (const name of ['BASH_SOURCE', ...(sourcePushd ? ['PWD'] : [])]) {
          const callerValue = callerBindings.get(name)
          if (callerValue) result.set(name, callerValue)
          else result.delete(name)
        }
        return result
      } catch (error) {
        logger.warn(
          `Flow analysis failed for sourced file ${sourcedUri}: ${String(error)}`,
        )
        return new Map()
      } finally {
        activeUris.delete(sourcedUri)
        // Bindings hold strings and LSP locations only, never syntax nodes.
        sourcedTree?.delete()
      }
    }

    const ctx: FlowAnalysisContext = {
      uri,
      content: fileContent,
      rootNode: analyzedDoc.tree.rootNode,
      cwd,
      initialBindings,
      sourcePushd,
      resolveSource: (sourcePath: string) => sourcePath,
      analyzeSourcedFile,
      trackInlayHints: true,
      inlayHints: [],
      dimmedRanges: [],
      sourceErrors: [],
      constexprErrors: [],
      topLevelUri: uri,
      referenceValues: new Map(),
      bashTab: this.config.enableBashTabAnalysis,
    }

    // Environment initialization commands run in order before the script.
    const envInitCommands = [
      ...matchingRules.flatMap(({ rule, captures }) =>
        rule.envInit ? [expandPathEnvInitCaptures(rule.envInit, captures)] : [],
      ),
      ...bashIde.directives.flatMap((d) =>
        d.type === 'env-init' && d.value ? [d.value] : [],
      ),
      ...bashIde.envInitBlocks.map((block) => block.commands.join('\n')),
    ]
    for (const command of envInitCommands) {
      initialBindings = this.runFlowEnvInit(command, { ...ctx, initialBindings })
    }
    ctx.initialBindings = initialBindings

    const flowBindings = FlowAnalyzer.analyzeFile(ctx, constexprOptions)

    analyzedDoc.flowBindings = flowBindings
    analyzedDoc.flowReferenceValues = ctx.referenceValues
    analyzedDoc.inlayHints = ctx.inlayHints
    analyzedDoc.dimmedRanges = ctx.dimmedRanges
    analyzedDoc.sourceErrors = ctx.sourceErrors
    analyzedDoc.constexprErrors = ctx.constexprErrors
  }

  /**
   * Analyze an environment initialization command (e.g. `source env.sh` or
   * `export A=1`) and return the bindings it leaves for the script.
   */
  private runFlowEnvInit(command: string, ctx: FlowAnalysisContext): FlowBindings {
    const tree = this.parser.parse(command)
    if (!tree) return ctx.initialBindings
    try {
      const bindings = FlowAnalyzer.analyzeFile({
        ...ctx,
        content: command,
        rootNode: tree.rootNode,
        trackInlayHints: false,
        referenceValues: undefined,
        inlayHints: [],
        dimmedRanges: [],
        sourceErrors: [],
        constexprErrors: [],
      })
      // Let the script's own analysis seed its shell state.
      for (const name of ['BASH_SOURCE', 'DIRSTACK', 'FUNCNAME', 'OLDPWD', 'PWD']) {
        bindings.delete(name)
      }
      return bindings
    } finally {
      tree.delete()
    }
  }

  /** Prefer the editor's contents for open documents over the file on disk. */
  private getFlowSourceContent(uri: string): string | null {
    const document = this.backgroundAnalyzedUris.has(uri)
      ? undefined
      : this.uriToAnalyzedDocument[uri]?.document
    if (document) return document.getText()
    try {
      return fs.readFileSync(uriToPath(uri), 'utf8')
    } catch {
      return null
    }
  }

  /**
   * Build the per-analysis constexpr options (registry and budget) when
   * constexpr evaluation is enabled. The registry and budget are fresh per
   * top-level analysis pass; the evaluator itself is long-lived.
   */
  private buildConstexprFlowOptions(): FlowAnalysisOptions | undefined {
    if (!this.constexprEvaluator || !this.constexprConfig?.enabled) {
      return undefined
    }

    return {
      constexpr: {
        evaluator: this.constexprEvaluator,
        registry: new Map(),
        budget: {
          spawnsRemaining: 100,
          deadline: Date.now() + 10_000,
        },
      },
    }
  }

  /**
   * Get inlay hints for a document.
   */
  public getInlayHints(uri: string): InlayHint[] {
    return this.uriToAnalyzedDocument[uri]?.inlayHints || []
  }

  /**
   * Get dimmed ranges for a document (untaken constexpr branches).
   */
  public getDimmedRanges(uri: string): LSP.Range[] {
    return this.uriToAnalyzedDocument[uri]?.dimmedRanges || []
  }

  /**
   * Get source command errors (resolved paths that don't exist on disk).
   */
  public getSourceErrors(uri: string): Array<{ range: LSP.Range; path: string }> {
    return this.uriToAnalyzedDocument[uri]?.sourceErrors || []
  }

  /**
   * Get orphaned `# bash-ide constexpr` directive ranges.
   */
  public getConstexprErrors(uri: string): LSP.Range[] {
    return this.uriToAnalyzedDocument[uri]?.constexprErrors || []
  }

  /**
   * Get the flow-resolved value of the variable referenced or assigned at the
   * given position, as analysis reached that point.
   */
  public getFlowValueAt({
    uri,
    position,
  }: {
    uri: string
    position: LSP.Position
  }): { name: string; value: FlowValue } | null {
    const analyzedDocument = this.uriToAnalyzedDocument[uri]
    const node = analyzedDocument?.tree.rootNode.descendantForPosition({
      row: position.line,
      column: position.character,
    })
    if (node?.type !== 'variable_name') return null
    const value = analyzedDocument?.flowReferenceValues?.get(
      referenceKey(node.startPosition),
    )
    return value ? { name: node.text, value } : null
  }

  /**
   * Get flow-resolved variable values for a document.
   */
  public getFlowBindings(uri: string): FlowBindings | undefined {
    return this.uriToAnalyzedDocument[uri]?.flowBindings
  }

  public cancelBackgroundAnalysis(): void {
    this.backgroundAnalysisController?.abort()
  }

  /** Discover and analyze workspace files within one elapsed-time budget. */
  public async initiateBackgroundAnalysis({
    backgroundAnalysisMaxFiles,
    backgroundAnalysisIgnore = getDefaultConfiguration().backgroundAnalysisIgnore,
    globPattern,
  }: {
    backgroundAnalysisMaxFiles: number
    backgroundAnalysisIgnore?: string[]
    globPattern: string
  }): Promise<{ filesParsed: number }> {
    this.cancelBackgroundAnalysis()
    const controller = new AbortController()
    this.backgroundAnalysisController = controller
    const { signal } = controller
    const rootPath = this.workspaceFolder
    if (!rootPath) return { filesParsed: 0 }

    if (backgroundAnalysisMaxFiles <= 0) {
      this.evictBackgroundDocuments(new Set())
      logger.info(`BackgroundAnalysis: skipping as backgroundAnalysisMaxFiles was 0...`)
      return { filesParsed: 0 }
    }

    logger.info(
      `BackgroundAnalysis: resolving glob "${globPattern}" inside "${rootPath}"...`,
    )

    const started = Date.now()
    const deadline = started + BACKGROUND_ANALYSIS_TIMEOUT_MS
    const expire = () => {
      if (signal.aborted) return
      logger.warn(
        `BackgroundAnalysis: stopped after ${BACKGROUND_ANALYSIS_TIMEOUT_MS}ms; workspace symbols may be incomplete. Exclude large folders with backgroundAnalysisIgnore or narrow globPattern.`,
      )
      controller.abort()
    }
    const stopped = () => {
      // Synchronous parsing can delay the timer; check between parses as well.
      if (Date.now() >= deadline) expire()
      return signal.aborted
    }
    const timer = setTimeout(expire, BACKGROUND_ANALYSIS_TIMEOUT_MS)
    const getTimePassed = () => `${(Date.now() - started) / 1000} seconds`
    let filesParsed = 0

    try {
      // fast-glob traverses hidden directories for globstars even though the
      // default pattern cannot match their files. Only prune for that pattern:
      // custom globs may deliberately target hidden directories.
      let filePaths: string[]
      try {
        filePaths = await getFilePaths({
          globPattern,
          rootPath,
          maxItems: backgroundAnalysisMaxFiles,
          timeoutMs: BACKGROUND_ANALYSIS_TIMEOUT_MS,
          ignore: backgroundAnalysisIgnore,
          skipHiddenEntries: globPattern === getDefaultConfiguration().globPattern,
          signal,
          onLimit: (reason) => {
            if (reason === 'time') expire()
            else
              logger.warn(
                `BackgroundAnalysis: stopped discovery at the directories limit; workspace symbols may be incomplete. Exclude large folders with backgroundAnalysisIgnore or narrow globPattern.`,
              )
          },
        })
      } catch (error) {
        if (!signal.aborted)
          logger.warn(
            `BackgroundAnalysis: failed resolving glob "${globPattern}". The experience across files will be degraded. Error: ${String(
              error,
            )}`,
          )
        return { filesParsed }
      }
      if (stopped()) return { filesParsed }

      this.evictBackgroundDocuments(
        new Set(filePaths.map((p) => url.pathToFileURL(p).href)),
      )
      logger.info(
        `BackgroundAnalysis: Glob resolved with ${
          filePaths.length
        } files after ${getTimePassed()}`,
      )

      for (const filePath of filePaths) {
        if (stopped()) break
        const uri = url.pathToFileURL(filePath).href
        const isOnDemand = () =>
          this.uriToAnalyzedDocument[uri] && !this.backgroundAnalyzedUris.has(uri)
        // Do not replace an open document's unsaved contents with its disk copy.
        if (isOnDemand()) continue

        try {
          let cancelRead: () => void = () => undefined
          const canceled = new Promise<undefined>((resolve) => {
            cancelRead = () => resolve(undefined)
            signal.addEventListener('abort', cancelRead, { once: true })
          })
          let fileContent: string | undefined
          try {
            // AbortSignal stops readFile's buffering, but an OS read may still
            // be pending. Settle the background pass immediately on cancellation.
            fileContent = await Promise.race([
              fs.promises.readFile(filePath, { encoding: 'utf8', signal }),
              canceled,
            ])
          } finally {
            signal.removeEventListener('abort', cancelRead)
          }
          if (stopped() || fileContent === undefined) break
          // The document may have been opened or edited while its read awaited I/O.
          if (isOnDemand()) continue
          const fileDialect = analyzeFile(uri, fileContent)
          if (!fileDialect.dialect) {
            logger.info(
              `BackgroundAnalysis: Skipping file ${uri} with dialect "${JSON.stringify(
                fileDialect,
              )}"`,
            )
            continue
          }

          this.analyze({
            document: TextDocument.create(uri, 'shell', 1, fileContent),
            uri,
            background: true,
          })
          filesParsed++
        } catch (error) {
          if (stopped()) break
          logger.warn(
            `BackgroundAnalysis: Failed analyzing ${uri}. Error: ${String(error)}`,
          )
        }
      }
      // Rereading background files can remove source relationships. Recompute
      // the retained dependency graph, without cleanup from a canceled old pass.
      if (!stopped()) {
        this.evictBackgroundDocuments(
          new Set(filePaths.map((p) => url.pathToFileURL(p).href)),
        )
      }
      logger.info(`BackgroundAnalysis: Completed after ${getTimePassed()}.`)
      return { filesParsed }
    } finally {
      clearTimeout(timer)
      if (this.backgroundAnalysisController === controller) {
        this.backgroundAnalysisController = undefined
      }
    }
  }

  private evictBackgroundDocuments(keep: Set<string>): void {
    // Preserve dependencies of opened/on-demand documents, even if a previous
    // background scan happened to analyze those dependencies first.
    for (const uri of Object.keys(this.uriToAnalyzedDocument)) {
      if (!this.backgroundAnalyzedUris.has(uri)) {
        for (const sourcedUri of this.findAllSourcedUris({ uri })) keep.add(sourcedUri)
      }
    }
    for (const uri of this.backgroundAnalyzedUris) {
      if (keep.has(uri)) continue
      this.uriToAnalyzedDocument[uri]?.tree.delete()
      delete this.uriToAnalyzedDocument[uri]
      this.backgroundAnalyzedUris.delete(uri)
    }
  }

  /**
   * Find all the locations where the word was declared.
   */
  public findDeclarationLocations({
    position,
    uri,
    word,
  }: {
    position: LSP.Position
    uri: string
    word: string
  }): LSP.Location[] {
    // If the word is sourced, return the location of the source file
    const sourcedUri = this.uriToAnalyzedDocument[uri]?.sourceCommands
      .filter((sourceCommand) => isPositionIncludedInRange(position, sourceCommand.range))
      .map((sourceCommand) => sourceCommand.uri)[0]

    if (sourcedUri) {
      return [LSP.Location.create(sourcedUri, LSP.Range.create(0, 0, 0, 0))]
    }

    return this.findDeclarationsMatchingWord({
      exactMatch: true,
      position,
      uri,
      word,
    }).map((symbol) => symbol.location)
  }

  /**
   * Find all the declaration symbols in the workspace matching the query using fuzzy search.
   */
  public findDeclarationsWithFuzzySearch(query: string): LSP.SymbolInformation[] {
    const searcher = new FuzzySearch(this.getAllDeclarations(), ['name'], {
      caseSensitive: true,
    })
    return searcher.search(query)
  }

  /**
   * Find declarations for the given word and position.
   */
  public findDeclarationsMatchingWord({
    exactMatch,
    position,
    uri,
    word,
  }: {
    exactMatch: boolean
    position: LSP.Position
    uri: string
    word: string
  }): LSP.SymbolInformation[] {
    return this.getAllDeclarations({ uri, position }).filter((symbol) => {
      if (exactMatch) {
        return symbol.name === word
      } else {
        return symbol.name.startsWith(word)
      }
    })
  }

  /**
   * Find a symbol's original declaration and parent scope based on its original
   * definition with respect to its scope.
   */
  public findOriginalDeclaration(params: FindDeclarationParams['symbolInfo']): {
    declaration: LSP.Location | null
    parent: LSP.Location | null
  } {
    const node = this.nodeAtPoint(
      params.uri,
      params.position.line,
      params.position.character,
    )

    if (!node) {
      return { declaration: null, parent: null }
    }

    const otherInfo: FindDeclarationParams['otherInfo'] = {
      currentUri: params.uri,
      boundary: params.position.line,
    }
    let parent = this.parentScope(node)
    let declaration: SyntaxNode | null | undefined
    let continueSearching = false

    // Search for local declaration within parents
    while (parent) {
      if (
        params.kind === LSP.SymbolKind.Variable &&
        parent.type === 'function_definition' &&
        parent.lastChild
      ) {
        ;({ declaration, continueSearching } = findDeclarationUsingLocalSemantics({
          baseNode: parent.lastChild,
          symbolInfo: params,
          otherInfo,
        }))
      } else if (parent.type === 'subshell') {
        ;({ declaration, continueSearching } = findDeclarationUsingGlobalSemantics({
          baseNode: parent,
          symbolInfo: params,
          otherInfo,
        }))
      }

      if (declaration && !continueSearching) {
        break
      }

      // Update boundary since any other instance within or below the current
      // parent can now be considered local to that parent or out of scope.
      otherInfo.boundary = parent.startPosition.row
      parent = this.parentScope(parent)
    }

    // Search for global declaration within files
    if (!parent && (!declaration || continueSearching)) {
      for (const uri of this.getOrderedReachableUris({ fromUri: params.uri })) {
        const root = this.uriToAnalyzedDocument[uri]?.tree.rootNode

        if (!root) {
          continue
        }

        otherInfo.currentUri = uri
        otherInfo.boundary =
          uri === params.uri
            ? // Reset boundary so globally defined variables within any
              // functions already searched can be found.
              params.position.line
            : // Set boundary to EOF since any position taken from the original
              // URI/file does not apply to other URIs/files.
              root.endPosition.row
        ;({ declaration, continueSearching } = findDeclarationUsingGlobalSemantics({
          baseNode: root,
          symbolInfo: params,
          otherInfo,
        }))

        if (declaration && !continueSearching) {
          break
        }
      }
    }

    return {
      declaration: declaration
        ? LSP.Location.create(otherInfo.currentUri, variableNameRange(declaration))
        : null,
      parent: parent
        ? LSP.Location.create(params.uri, TreeSitterUtil.range(parent))
        : null,
    }
  }

  /**
   * Find all the locations where the given word was defined or referenced.
   * This will include commands, functions, variables, etc.
   *
   * It's currently not scope-aware, see findOccurrences.
   */
  public findReferences(word: string): LSP.Location[] {
    const uris = Object.keys(this.uriToAnalyzedDocument)
    return flattenArray(uris.map((uri) => this.findOccurrences(uri, word)))
  }

  /**
   * Find all occurrences of a word in the given file.
   * It's currently not scope-aware.
   *
   * This will include commands, functions, variables, etc.
   *
   * It's currently not scope-aware, meaning references does include
   * references to functions and variables that has the same name but
   * are defined in different files.
   */
  public findOccurrences(uri: string, word: string): LSP.Location[] {
    const analyzedDocument = this.uriToAnalyzedDocument[uri]
    if (!analyzedDocument) {
      return []
    }

    const { tree } = analyzedDocument

    const locations: LSP.Location[] = []

    TreeSitterUtil.forEach(tree.rootNode, (n) => {
      let namedNode: SyntaxNode | null = null

      if (getInputVariableDeclaration(n)) {
        namedNode = n
      } else if (TreeSitterUtil.isReference(n)) {
        // NOTE: a reference can be a command, variable, function, etc.
        namedNode = n.firstNamedChild || n
      } else if (TreeSitterUtil.isDefinition(n)) {
        namedNode = n.firstNamedChild
      }

      if (
        namedNode &&
        (getInputVariableDeclaration(namedNode)?.name ?? namedNode.text) === word
      ) {
        const range = variableNameRange(namedNode)

        const alreadyInLocations = locations.some((loc) => {
          return isDeepStrictEqual(loc.range, range)
        })

        if (!alreadyInLocations) {
          locations.push(LSP.Location.create(uri, range))
        }
      }
    })

    return locations
  }

  /**
   * A more scope-aware version of findOccurrences that differentiates between
   * functions and variables.
   */
  public findOccurrencesWithin({
    uri,
    word,
    kind,
    start,
    scope,
  }: {
    uri: string
    word: string
    kind: LSP.SymbolKind
    start?: LSP.Position
    scope?: LSP.Range
  }): LSP.Range[] {
    const scopeNode = scope
      ? this.nodeAtPoints(
          uri,
          { row: scope.start.line, column: scope.start.character },
          { row: scope.end.line, column: scope.end.character },
        )
      : null
    const baseNode =
      scopeNode && (kind === LSP.SymbolKind.Variable || scopeNode.type === 'subshell')
        ? scopeNode
        : this.uriToAnalyzedDocument[uri]?.tree.rootNode

    if (!baseNode) {
      return []
    }

    const typeOfDescendants =
      kind === LSP.SymbolKind.Variable
        ? ['variable_name', 'word', 'string', 'raw_string']
        : ['function_definition', 'command_name']
    const startPosition = start
      ? { row: start.line, column: start.character }
      : baseNode.startPosition

    const ignoredRanges: LSP.Range[] = []
    const filterVariables = (n: SyntaxNode) => {
      const input = getInputVariableDeclaration(n)
      if ((input?.name ?? n.text) !== word || (n.type !== 'variable_name' && !input)) {
        return false
      }

      const definition = TreeSitterUtil.findParentOfType(n, 'variable_assignment')
      const definedVariable = definition?.descendantsOfType('variable_name').at(0)

      // For self-assignment `var=$var` cases; this decides whether `$var` is an
      // occurrence or not.
      if (definedVariable?.text === word && !n.equals(definedVariable)) {
        // `start.line` is assumed to be the same as the variable's original
        // declaration line; handles cases where `$var` shouldn't be considered
        // an occurrence.
        if (definition?.startPosition.row === start?.line) {
          return false
        }

        // Returning true here is a good enough heuristic for most cases. It
        // breaks down when redeclaration happens in multiple nested scopes,
        // handling those more complex situations can be done later on if use
        // cases arise.
        return true
      }

      const parent = this.parentScope(n)

      if (!parent || baseNode.equals(parent)) {
        return true
      }

      const includeDeclaration = !ignoredRanges.some(
        (r) => n.startPosition.row > r.start.line && n.endPosition.row < r.end.line,
      )

      const declarationCommand = TreeSitterUtil.findParentOfType(n, 'declaration_command')
      const isLocal =
        // Local `variable_name`s
        ((definedVariable?.text === word || !!(!definition && declarationCommand)) &&
          (parent.type === 'subshell' ||
            ['local', 'declare', 'typeset'].includes(
              declarationCommand?.firstChild?.text as any,
            ))) ||
        // Input destinations belong to their enclosing subshell.
        (parent.type === 'subshell' && !!input)
      if (isLocal) {
        if (includeDeclaration) {
          ignoredRanges.push(TreeSitterUtil.range(parent))
        }

        return false
      }

      return includeDeclaration
    }
    const filterFunctions = (n: SyntaxNode) => {
      const text = n.type === 'function_definition' ? n.firstNamedChild?.text : n.text
      if (text !== word) {
        return false
      }

      const parentScope = TreeSitterUtil.findParentOfType(n, 'subshell')

      if (!parentScope || baseNode.equals(parentScope)) {
        return true
      }

      const includeDeclaration = !ignoredRanges.some(
        (r) => n.startPosition.row > r.start.line && n.endPosition.row < r.end.line,
      )

      if (n.type === 'function_definition') {
        if (includeDeclaration) {
          ignoredRanges.push(TreeSitterUtil.range(parentScope))
        }

        return false
      }

      return includeDeclaration
    }

    return baseNode
      .descendantsOfType(typeOfDescendants, startPosition)
      .filter(kind === LSP.SymbolKind.Variable ? filterVariables : filterFunctions)
      .map((n) => {
        if (n.type === 'function_definition' && n.firstNamedChild) {
          return TreeSitterUtil.range(n.firstNamedChild)
        }

        return variableNameRange(n)
      })
  }

  public getAllVariables({
    position,
    uri,
  }: {
    position: LSP.Position
    uri: string
  }): LSP.SymbolInformation[] {
    return this.getAllDeclarations({ uri, position }).filter(
      (symbol) => symbol.kind === LSP.SymbolKind.Variable,
    )
  }

  /**
   * Get all symbol declarations in the given file. This is used for generating an outline.
   *
   * TODO: convert to DocumentSymbol[] which is a hierarchy of symbols found in a given text document.
   */
  public getDeclarationsForUri({ uri }: { uri: string }): LSP.SymbolInformation[] {
    const tree = this.uriToAnalyzedDocument[uri]?.tree

    if (!tree?.rootNode) {
      return []
    }

    return getAllDeclarationsInTree({ uri, tree })
  }

  /**
   * If the position is within a concatenation node, return the full
   * concatenation text (used for path resolution with $VAR expansion).
   */
  public getConcatenationTextAtPoint(
    uri: string,
    line: number,
    column: number,
  ): string | null {
    const node = this.nodeAtPoint(uri, line, column)
    if (!node) return null

    // Walk up to find a concatenation ancestor
    let current: SyntaxNode | null = node
    while (current) {
      if (current.type === 'concatenation') {
        return current.text
      }
      current = current.parent
    }
    return null
  }

  /**
   * Get the document for the given URI.
   */
  public getDocument(uri: string): TextDocument | undefined {
    return this.uriToAnalyzedDocument[uri]?.document
  }

  public getRootNode(uri: string): SyntaxNode | undefined {
    return this.uriToAnalyzedDocument[uri]?.tree.rootNode
  }

  // TODO: move somewhere else than the analyzer...
  public async getExplainshellDocumentation({
    params,
    endpoint,
  }: {
    params: LSP.TextDocumentPositionParams
    endpoint: string
  }): Promise<{ helpHTML?: string }> {
    const analyzedDocument = this.uriToAnalyzedDocument[params.textDocument.uri]

    const leafNode = analyzedDocument?.tree.rootNode.descendantForPosition({
      row: params.position.line,
      column: params.position.character,
    })

    if (!leafNode || !analyzedDocument) {
      return {}
    }

    // explainshell needs the whole command, not just the "word" (tree-sitter
    // parlance) that the user hovered over. A relatively successful heuristic
    // is to simply go up one level in the AST. If you go up too far, you'll
    // start to include newlines, and explainshell completely balks when it
    // encounters newlines.
    const interestingNode = leafNode.type === 'word' ? leafNode.parent : leafNode

    if (!interestingNode) {
      return {}
    }

    type ExplainshellResponse = {
      matches?: Array<{
        helpHTML?: string
        helpclass?: string
        start: number
        end: number
      }>
      helptext?: Array<[html: string, helpclass: string]>
    }

    const searchParams = new URLSearchParams({ cmd: interestingNode.text }).toString()
    const url = `${endpoint}/explain?${searchParams}`

    const explainshellRawResponse = await fetch(url)
    const explainshellResponse =
      (await explainshellRawResponse.json()) as ExplainshellResponse

    if (!explainshellRawResponse.ok) {
      throw new Error(`HTTP request failed: ${url}`)
    } else if (!explainshellResponse.matches) {
      return {}
    } else {
      const offsetOfMousePointerInCommand =
        analyzedDocument.document.offsetAt(params.position) - interestingNode.startIndex

      const match = explainshellResponse.matches.find(
        (helpItem) =>
          helpItem.start <= offsetOfMousePointerInCommand &&
          offsetOfMousePointerInCommand < helpItem.end,
      )

      const helpHTML =
        match?.helpHTML ??
        (match?.helpclass
          ? explainshellResponse.helptext?.find(([, id]) => id === match.helpclass)?.[0]
          : undefined)

      return { helpHTML }
    }
  }

  /**
   * Find the name of the command at the given point.
   */
  public commandNameAtPoint(uri: string, line: number, column: number): string | null {
    return this.commandAtPoint(uri, line, column)?.name.text.trim() ?? null
  }

  /**
   * Find the command name and the arguments that end before the given point,
   * excluding the word at the point. Unlike commandNameAtPoint, this also
   * finds builtins that tree-sitter parses on their own, such as `unset -f`
   * and `declare -a`, so their options can be completed and described.
   */
  public commandWordsAtPoint(uri: string, line: number, column: number): string[] | null {
    const command = this.commandAtPoint(uri, line, column, OPTION_COMMAND_TYPES)
    if (!command) {
      return null
    }

    const words = [command.name.text.trim()]
    for (const child of command.node.namedChildren) {
      if (!child || child.startIndex <= command.name.startIndex) {
        continue
      }
      const { row, column: endColumn } = child.endPosition
      if (row > line || (row === line && endColumn > column)) {
        break
      }
      if (!NON_ARGUMENT_COMMAND_CHILDREN.has(child.type)) {
        words.push(child.text)
      }
    }

    return words
  }

  /**
   * Find all words of the command at the given point, starting with its
   * name, and the index of the argument word that contains the point. Null
   * when the point is not on an argument, such as on the name or a redirect,
   * or the argument contains an expansion.
   */
  public commandArgumentAtPoint(
    uri: string,
    line: number,
    column: number,
  ): { words: string[]; index: number } | null {
    const command = this.commandAtPoint(uri, line, column, OPTION_COMMAND_TYPES)
    if (!command) {
      return null
    }

    const isAfter = (a: Point, b: Point) =>
      a.row > b.row || (a.row === b.row && a.column > b.column)
    const point = { row: line, column }
    const words = [command.name.text.trim()]
    let index = -1
    for (const child of command.node.namedChildren) {
      if (
        !child ||
        child.startIndex <= command.name.startIndex ||
        NON_ARGUMENT_COMMAND_CHILDREN.has(child.type)
      ) {
        continue
      }
      if (!isAfter(child.startPosition, point) && isAfter(child.endPosition, point)) {
        // A word with expansions is described by what it expands to instead.
        if (child.descendantsOfType([...EXPANSION_TYPES]).length > 0) return null
        index = words.length
      }
      words.push(child.text)
    }

    return index > 0 ? { words, index } : null
  }

  private commandAtPoint(
    uri: string,
    line: number,
    column: number,
    types: ReadonlySet<string> = SIMPLE_COMMAND_TYPES,
  ): { node: SyntaxNode; name: SyntaxNode } | null {
    let node = this.nodeAtPoint(uri, line, column)

    while (node && !types.has(node.type)) {
      node = node.parent
    }

    if (!node) {
      return null
    }

    // Declaration and unset commands start with their keyword instead.
    const name = node.type === 'command' ? node.firstNamedChild : node.firstChild

    if (!name || (node.type === 'command' && name.type !== 'command_name')) {
      return null
    }

    return { node, name }
  }

  /**
   * Find a block of comments above a line position, as Markdown without the
   * leading `#` of each line.
   */
  public commentsAbove(uri: string, line: number): string | null {
    const doc = this.uriToAnalyzedDocument[uri]?.document
    if (!doc) {
      return null
    }

    const commentBlock = []

    // start from the line above
    let commentBlockIndex = line - 1

    // will return the comment string without the comment '#'
    // and without leading whitespace, or null if the line 'l'
    // is not a comment line
    const getComment = (l: string): null | string => {
      // this regexp has to be defined within the function
      const commentRegExp = /^\s*#\s?(.*)/g
      const matches = commentRegExp.exec(l)
      return matches ? matches[1].trimRight() : null
    }

    let currentLine = doc.getText({
      start: { line: commentBlockIndex, character: 0 },
      end: { line: commentBlockIndex + 1, character: 0 },
    })

    // iterate on every line above and including
    // the current line until getComment returns null
    let currentComment: string | null = ''
    while ((currentComment = getComment(currentLine)) !== null) {
      commentBlock.push(currentComment)
      commentBlockIndex -= 1
      currentLine = doc.getText({
        start: { line: commentBlockIndex, character: 0 },
        end: { line: commentBlockIndex + 1, character: 0 },
      })
    }

    if (commentBlock.length) {
      // since we searched from bottom up, we then reverse
      // the lines so that it reads top down.
      commentBlock.reverse()
      // Comments are Markdown: hovers render lists, emphasis and code fences.
      return commentBlock.join('\n')
    }

    // no comments found above line:
    return null
  }

  /**
   * Find the full word at the given point.
   */
  public wordAtPoint(uri: string, line: number, column: number): string | null {
    const node = this.nodeAtPoint(uri, line, column)
    if (node) {
      const input =
        getInputVariableDeclaration(node) ||
        (node.parent && getInputVariableDeclaration(node.parent))
      if (input && isPositionIncludedInRange({ line, character: column }, input.range))
        return input.name
    }

    if (!node || node.childCount > 0 || node.text.trim() === '') {
      return null
    }

    return node.text.trim()
  }

  /**
   * Get the start column of the word at the given point.
   * Returns -1 if no word is found.
   */
  public wordStartColumnAtPoint(uri: string, line: number, column: number): number {
    const node = this.nodeAtPoint(uri, line, column)
    if (!node || node.childCount > 0 || node.text.trim() === '') {
      return -1
    }
    return node.startPosition.column
  }

  public wordAtPointFromTextPosition(
    params: LSP.TextDocumentPositionParams,
  ): string | null {
    return this.wordAtPoint(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    )
  }

  public symbolAtPointFromTextPosition(
    params: LSP.TextDocumentPositionParams,
  ): { word: string; range: LSP.Range; kind: LSP.SymbolKind } | null {
    const node = this.nodeAtPoint(
      params.textDocument.uri,
      params.position.line,
      params.position.character,
    )

    if (!node) {
      return null
    }

    if (
      node.type === 'variable_name' ||
      (node.type === 'word' &&
        ['function_definition', 'command_name'].includes(node.parent?.type as any))
    ) {
      return {
        word: node.text,
        range: TreeSitterUtil.range(node),
        kind:
          node.type === 'variable_name'
            ? LSP.SymbolKind.Variable
            : LSP.SymbolKind.Function,
      }
    }

    const input =
      getInputVariableDeclaration(node) ||
      (node.parent && getInputVariableDeclaration(node.parent))
    if (input && isPositionIncludedInRange(params.position, input.range)) {
      return {
        word: input.name,
        range: input.range,
        kind: LSP.SymbolKind.Variable,
      }
    }

    return null
  }

  public setEnableSourceErrorDiagnostics(enableSourceErrorDiagnostics: boolean): void {
    this.enableSourceErrorDiagnostics = enableSourceErrorDiagnostics
  }

  public setIncludeAllWorkspaceSymbols(includeAllWorkspaceSymbols: boolean): void {
    this.includeAllWorkspaceSymbols = includeAllWorkspaceSymbols
  }

  /**
   * If includeAllWorkspaceSymbols is true, this returns all URIs from the
   * background analysis, else, it returns the URIs of the files that are
   * linked to `uri` via sourcing.
   */
  public findAllLinkedUris(uri: string): string[] {
    if (this.includeAllWorkspaceSymbols) {
      return Object.keys(this.uriToAnalyzedDocument).filter((u) => u !== uri)
    }

    const uriToAnalyzedDocument = Object.entries(this.uriToAnalyzedDocument)
    const uris: string[] = []
    let continueSearching = true

    while (continueSearching) {
      continueSearching = false

      for (const [analyzedUri, analyzedDocument] of uriToAnalyzedDocument) {
        if (!analyzedDocument) {
          continue
        }

        for (const sourcedUri of analyzedDocument.sourcedUris.values()) {
          if (
            (sourcedUri === uri || uris.includes(sourcedUri)) &&
            !uris.includes(analyzedUri)
          ) {
            uris.push(analyzedUri)
            continueSearching = true
            break
          }
        }
      }
    }

    return uris
  }

  // Private methods

  /**
   * Returns all reachable URIs from the given URI based on sourced commands
   * If no URI is given, all URIs from the background analysis are returned.
   * If the includeAllWorkspaceSymbols flag is set, all URIs from the background analysis are also included.
   */
  private getReachableUris({ fromUri }: { fromUri?: string } = {}): string[] {
    if (!fromUri) {
      return Object.keys(this.uriToAnalyzedDocument)
    }

    const urisBasedOnSourcing = [
      fromUri,
      ...Array.from(this.findAllSourcedUris({ uri: fromUri })),
    ]

    if (this.includeAllWorkspaceSymbols) {
      return Array.from(
        new Set([...urisBasedOnSourcing, ...Object.keys(this.uriToAnalyzedDocument)]),
      )
    } else {
      return urisBasedOnSourcing
    }
  }

  /**
   * Returns all reachable URIs from `fromUri` based on source commands in
   * descending order starting from the top of the sourcing tree, this list
   * includes `fromUri`. If includeAllWorkspaceSymbols is true, other URIs from
   * the background analysis are also included after the ordered URIs in no
   * particular order.
   */
  private getOrderedReachableUris({ fromUri }: { fromUri: string }): string[] {
    let uris: Set<string> | string[] = this.findAllSourcedUris({ uri: fromUri })

    for (const u1 of uris) {
      for (const u2 of this.findAllSourcedUris({ uri: u1 })) {
        if (uris.has(u2)) {
          uris.delete(u2)
          uris.add(u2)
        }
      }
    }

    uris = Array.from(uris)
    uris.reverse()
    uris.push(fromUri)

    if (this.includeAllWorkspaceSymbols) {
      uris.push(
        ...Object.keys(this.uriToAnalyzedDocument).filter(
          (u) => !(uris as string[]).includes(u),
        ),
      )
    }

    return uris
  }

  private getAnalyzedReachableUris({ fromUri }: { fromUri?: string } = {}): string[] {
    return this.ensureUrisAreAnalyzed(this.getReachableUris({ fromUri }))
  }

  private ensureUrisAreAnalyzed(uris: string[]): string[] {
    return uris.filter((uri) => {
      if (!this.uriToAnalyzedDocument[uri]) {
        // Either the background analysis didn't run or the file is outside
        // the workspace. Let us try to analyze the file.
        try {
          logger.debug(`Analyzing file not covered by background analysis ${uri}`)
          const fileContent = fs.readFileSync(new URL(uri), 'utf8')
          this.analyze({
            document: TextDocument.create(uri, 'shell', 1, fileContent),
            uri,
          })
        } catch (err) {
          logger.warn(`Error while analyzing file ${uri}: ${String(err)}`)
          return false
        }
      }

      return true
    })
  }

  /**
   * Get all declaration symbols (function or variables) from the given file/position
   * or from all files in the workspace. It will take into account the given position
   * to filter out irrelevant symbols.
   *
   * Note that this can return duplicates across the workspace.
   */
  private getAllDeclarations({
    uri: fromUri,
    position,
  }: { uri?: string; position?: LSP.Position } = {}): LSP.SymbolInformation[] {
    return this.getAnalyzedReachableUris({ fromUri }).reduce((symbols, uri) => {
      const analyzedDocument = this.uriToAnalyzedDocument[uri]

      if (analyzedDocument) {
        if (uri !== fromUri || !position) {
          // We use the global declarations for external files or if we do not have a position
          const { globalDeclarations } = analyzedDocument
          Object.values(globalDeclarations).forEach((symbol) => symbols.push(symbol))
        }

        // For the current file we find declarations based on the current scope
        if (uri === fromUri && position) {
          const node = analyzedDocument.tree.rootNode?.descendantForPosition({
            row: position.line,
            column: position.character,
          })

          const localDeclarations = getLocalDeclarations({
            node,
            rootNode: analyzedDocument.tree.rootNode,
            uri,
          })

          Object.keys(localDeclarations).map((name) => {
            const symbolsMatchingWord = localDeclarations[name]

            // Prefer the latest preceding definition, with the first following
            // function as a fallback: a function body can call a function that
            // is declared later in the file.
            let closestSymbol: LSP.SymbolInformation | null = null
            let followingFunction: LSP.SymbolInformation | null = null
            symbolsMatchingWord.forEach((symbol) => {
              if (
                symbol.location.range.start.line > position.line ||
                (symbol.kind === LSP.SymbolKind.Variable &&
                  symbol.location.range.start.line === position.line &&
                  symbol.location.range.start.character > position.character)
              ) {
                if (
                  symbol.kind === LSP.SymbolKind.Function &&
                  !symbol.containerName &&
                  node?.type === 'word' &&
                  node.parent?.type === 'command_name' &&
                  TreeSitterUtil.findParentOfType(node, 'function_definition') &&
                  (!followingFunction ||
                    symbol.location.range.start.line <
                      followingFunction.location.range.start.line)
                ) {
                  followingFunction = symbol
                }
                return
              }

              if (
                closestSymbol === null ||
                symbol.location.range.start.line > closestSymbol.location.range.start.line
              ) {
                closestSymbol = symbol
              }
            })

            const symbol = closestSymbol || followingFunction
            if (symbol) {
              symbols.push(symbol)
            }
          })
        }
      }

      return symbols
    }, [] as LSP.SymbolInformation[])
  }

  public findAllSourcedUris({ uri }: { uri: string }): Set<string> {
    const allSourcedUris = new Set<string>([])

    const addSourcedFilesFromUri = (fromUri: string) => {
      const sourcedUris = this.uriToAnalyzedDocument[fromUri]?.sourcedUris

      if (!sourcedUris) {
        return
      }

      sourcedUris.forEach((sourcedUri) => {
        if (!allSourcedUris.has(sourcedUri)) {
          allSourcedUris.add(sourcedUri)
          addSourcedFilesFromUri(sourcedUri)
        }
      })
    }

    addSourcedFilesFromUri(uri)

    return allSourcedUris
  }

  /**
   * Returns the parent `subshell` or `function_definition` of the given `node`.
   * To disambiguate between regular `subshell`s and `subshell`s that serve as a
   * `function_definition`'s body, this only returns a `function_definition` if
   * its body is a `compound_statement`.
   */
  private parentScope(node: SyntaxNode): SyntaxNode | null {
    return TreeSitterUtil.findParent(
      node,
      (n) =>
        n.type === 'subshell' ||
        (n.type === 'function_definition' && n.lastChild?.type === 'compound_statement'),
    )
  }

  /**
   * Find the node at the given point.
   */
  private nodeAtPoint(uri: string, line: number, column: number): SyntaxNode | null {
    const tree = this.uriToAnalyzedDocument[uri]?.tree

    if (!tree?.rootNode) {
      // Check for lacking rootNode (due to failed parse?)
      return null
    }

    return tree.rootNode.descendantForPosition({ row: line, column })
  }

  private nodeAtPoints(uri: string, start: Point, end: Point): SyntaxNode | null {
    const rootNode = this.uriToAnalyzedDocument[uri]?.tree.rootNode

    if (!rootNode) {
      return null
    }

    return rootNode.descendantForPosition(start, end)
  }
}

const uriToPath = (uri: string): string =>
  uri.startsWith('file://') ? url.fileURLToPath(uri) : uri
