import {
  IMPORT_SOURCES,
  importSessionSnippets,
  isImportSource,
  scrubImportedSnippets,
  type ImportSource,
  type SourceImportResult,
  type ScrubbedImportedSnippet,
} from '@repo/importers'

import { resolveWorkspace } from './cli-support.js'
import type { DuetConfig } from './config.js'
import { usageError } from './exit-codes.js'
import type { ApiClient } from './http.js'

interface ImportCommandContext {
  global: { json: boolean; workspace?: string }
  config: DuetConfig
  api: ApiClient
  io: {
    stdout: WritableSink
    stderr: WritableSink
  }
  home: string
}

type WritableSink = Pick<NodeJS.WriteStream, 'write'>

interface ImportReportSource {
  source: ImportSource
  assumedPath: string
  snippets: number
  scrubbed: number
  scrubbedSourceRefs: string[]
  warnings: string[]
}

interface ImportReport {
  dryRun: boolean
  requestedSources: ImportSource[]
  totalSnippets: number
  totalScrubbed: number
  totalWritten: number
  sources: ImportReportSource[]
}

export async function importSessions(args: string[], ctx: ImportCommandContext): Promise<void> {
  const options = parseImportArgs(args)
  if (options.sources.length === 0) {
    printImportReport(
      {
        dryRun: options.dryRun,
        requestedSources: [],
        totalSnippets: 0,
        totalScrubbed: 0,
        totalWritten: 0,
        sources: [],
      },
      ctx,
    )
    return
  }

  const results = await importSessionSnippets({
    home: ctx.home,
    sources: options.sources,
    warn: warning => writeText(ctx.io.stderr, `warning: ${warning}\n`),
  })
  const scrubbedBySource = results.map(result => ({
    result,
    snippets: scrubImportedSnippets(result.snippets),
  }))

  let totalWritten = 0
  if (!options.dryRun) {
    const workspaceSlug = resolveWorkspace(ctx)
    for (const sourceResult of scrubbedBySource) {
      for (const snippet of sourceResult.snippets) {
        await ctx.api.request(`/ws/${encodeURIComponent(workspaceSlug)}/memories`, {
          method: 'POST',
          json: {
            content: snippet.scrubbedText,
            source: 'import',
          },
        })
        totalWritten += 1
      }
    }
  }

  const report = importReport(options.dryRun, options.sources, scrubbedBySource, totalWritten)
  printImportReport(report, ctx)
}

function parseImportArgs(args: string[]): { dryRun: boolean; sources: ImportSource[] } {
  const sources: ImportSource[] = []
  let dryRun = false

  for (const arg of args) {
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg.startsWith('--')) throw usageError(`Unknown option: ${arg}`)
    if (!isImportSource(arg)) {
      throw usageError(
        `Unknown import source: ${arg}. Expected one of: ${IMPORT_SOURCES.join(', ')}`,
      )
    }
    if (!sources.includes(arg)) sources.push(arg)
  }

  return { dryRun, sources }
}

function importReport(
  dryRun: boolean,
  requestedSources: ImportSource[],
  scrubbedBySource: Array<{ result: SourceImportResult; snippets: ScrubbedImportedSnippet[] }>,
  totalWritten: number,
): ImportReport {
  const sources = scrubbedBySource.map(({ result, snippets }) => ({
    source: result.source,
    assumedPath: result.assumedPath,
    snippets: snippets.length,
    scrubbed: snippets.filter(snippet => snippet.scrubbed).length,
    scrubbedSourceRefs: snippets
      .filter(snippet => snippet.scrubbed)
      .map(snippet => snippet.sourceRef),
    warnings: result.warnings,
  }))
  return {
    dryRun,
    requestedSources,
    totalSnippets: sources.reduce((sum, source) => sum + source.snippets, 0),
    totalScrubbed: sources.reduce((sum, source) => sum + source.scrubbed, 0),
    totalWritten,
    sources,
  }
}

function printImportReport(report: ImportReport, ctx: ImportCommandContext): void {
  if (ctx.global.json) {
    writeJson(ctx.io.stdout, report)
    return
  }
  if (report.requestedSources.length === 0) {
    writeText(ctx.io.stdout, 'No import source selected. Nothing read.\n')
    return
  }

  const prefix = report.dryRun ? 'Would import' : 'Imported'
  writeText(
    ctx.io.stdout,
    `${prefix} ${report.totalSnippets} snippets (${report.totalScrubbed} scrubbed) from ${report.requestedSources.join(', ')}.\n`,
  )
  for (const source of report.sources) {
    writeText(
      ctx.io.stdout,
      `- ${source.source}: ${source.snippets} snippets, ${source.scrubbed} scrubbed, path ${source.assumedPath}\n`,
    )
    for (const sourceRef of source.scrubbedSourceRefs)
      writeText(ctx.io.stdout, `  scrubbed: ${sourceRef}\n`)
  }
}

function writeJson(sink: WritableSink, value: unknown): void {
  writeText(sink, `${JSON.stringify(value)}\n`)
}

function writeText(sink: WritableSink, text: string): void {
  sink.write(text)
}
