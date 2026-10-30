import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { redactImportMemoryText } from '@repo/contract'

export const IMPORT_SOURCES = ['claude-code', 'codex', 'openclaw'] as const
export type ImportSource = (typeof IMPORT_SOURCES)[number]

export interface ImportedSnippet {
  text: string
  sourceRef: string
}

export interface ScrubbedImportedSnippet extends ImportedSnippet {
  scrubbedText: string
  scrubbed: boolean
  redactionCount: number
}

export interface SourceImportResult {
  source: ImportSource
  assumedPath: string
  snippets: ImportedSnippet[]
  warnings: string[]
}

export interface ImportSessionOptions {
  home: string
  sources: ImportSource[]
  warn?: (warning: string) => void
}

type Parser = (home: string) => Promise<SourceImportResult>
const SKIP_RECORD = Symbol('skip-record')
type ExtractedText = string | null | typeof SKIP_RECORD

const PARSERS: Record<ImportSource, Parser> = {
  'claude-code': parseClaudeCodeSessions,
  codex: parseCodexSessions,
  openclaw: parseOpenClawSessions,
}

export function isImportSource(value: string): value is ImportSource {
  return (IMPORT_SOURCES as readonly string[]).includes(value)
}

export async function importSessionSnippets(
  options: ImportSessionOptions,
): Promise<SourceImportResult[]> {
  const results: SourceImportResult[] = []
  for (const source of options.sources) {
    try {
      const result = await PARSERS[source](options.home)
      for (const warning of result.warnings) options.warn?.(warning)
      results.push(result)
    } catch (error) {
      const warning = `${source}: parser failed non-fatally: ${error instanceof Error ? error.message : 'unknown error'}`
      options.warn?.(warning)
      results.push({
        source,
        assumedPath: assumedPath(source, options.home),
        snippets: [],
        warnings: [warning],
      })
    }
  }
  return results
}

export function scrubImportedSnippets(snippets: ImportedSnippet[]): ScrubbedImportedSnippet[] {
  return snippets.map(snippet => {
    const redacted = redactImportMemoryText(snippet.text)
    return {
      ...snippet,
      scrubbedText: redacted.text,
      scrubbed: redacted.redacted,
      redactionCount: redacted.redactionCount,
    }
  })
}

export async function parseClaudeCodeSessions(home: string): Promise<SourceImportResult> {
  const root = assumedPath('claude-code', home)
  return await parseJsonlTree('claude-code', root, extractClaudeCodeText)
}

export async function parseCodexSessions(home: string): Promise<SourceImportResult> {
  const root = assumedPath('codex', home)
  return await parseJsonlTree('codex', root, extractCodexText)
}

export async function parseOpenClawSessions(home: string): Promise<SourceImportResult> {
  const root = assumedPath('openclaw', home)
  return await parseJsonlTree('openclaw', root, extractOpenClawText)
}

export function assumedPath(source: ImportSource, home: string): string {
  if (source === 'claude-code') return join(home, '.claude', 'projects')
  if (source === 'codex') return join(home, '.codex', 'sessions')
  return join(home, '.openclaw', 'sessions')
}

async function parseJsonlTree(
  source: ImportSource,
  root: string,
  extract: (value: unknown) => ExtractedText,
): Promise<SourceImportResult> {
  const snippets: ImportedSnippet[] = []
  const warnings: string[] = []
  const files = await listFiles(root, warnings, source)

  for (const file of files) {
    if (!looksLikeTranscriptFile(file)) continue
    const content = await readFile(file, 'utf8').catch((error: unknown) => {
      warnings.push(
        `${source}: skipped unreadable transcript ${file}: ${error instanceof Error ? error.message : 'read failed'}`,
      )
      return null
    })
    if (content === null) continue

    if (file.endsWith('.json')) {
      parseJsonFile(source, file, content, extract, snippets, warnings)
      continue
    }
    parseJsonlFile(source, file, content, extract, snippets, warnings)
  }

  return { source, assumedPath: root, snippets, warnings }
}

async function listFiles(
  root: string,
  warnings: string[],
  source: ImportSource,
): Promise<string[]> {
  const rootStat = await stat(root).catch(() => null)
  if (rootStat === null) return []
  if (!rootStat.isDirectory()) {
    warnings.push(`${source}: assumed session path is not a directory: ${root}`)
    return []
  }

  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
      warnings.push(
        `${source}: skipped unreadable directory ${dir}: ${error instanceof Error ? error.message : 'readdir failed'}`,
      )
      return []
    })
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
      } else if (entry.isFile()) {
        files.push(path)
      }
    }
  }
  await walk(root)
  return files.sort()
}

function parseJsonlFile(
  source: ImportSource,
  file: string,
  content: string,
  extract: (value: unknown) => ExtractedText,
  snippets: ImportedSnippet[],
  warnings: string[],
): void {
  const lines = content.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim()
    if (line.length === 0) continue
    const sourceRef = `${file}:${index + 1}`
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      warnings.push(`${source}: quarantined malformed JSONL record at ${sourceRef}`)
      continue
    }
    pushExtractedSnippet(source, sourceRef, parsed, extract, snippets, warnings)
  }
}

function parseJsonFile(
  source: ImportSource,
  file: string,
  content: string,
  extract: (value: unknown) => ExtractedText,
  snippets: ImportedSnippet[],
  warnings: string[],
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    warnings.push(`${source}: quarantined malformed JSON transcript at ${file}`)
    return
  }

  const messages = recordValue(objectValue(parsed), 'messages')
  const records = Array.isArray(parsed) ? parsed : Array.isArray(messages) ? messages : [parsed]
  for (let index = 0; index < records.length; index += 1) {
    pushExtractedSnippet(
      source,
      `${file}:${index + 1}`,
      records[index],
      extract,
      snippets,
      warnings,
    )
  }
}

function pushExtractedSnippet(
  source: ImportSource,
  sourceRef: string,
  parsed: unknown,
  extract: (value: unknown) => ExtractedText,
  snippets: ImportedSnippet[],
  warnings: string[],
): void {
  const text = extract(parsed)
  if (text === SKIP_RECORD) return
  if (text === null) {
    warnings.push(`${source}: quarantined unknown transcript shape at ${sourceRef}`)
    return
  }
  const trimmed = text.trim()
  if (trimmed.length === 0) return
  snippets.push({ text: trimmed, sourceRef })
}

function looksLikeTranscriptFile(file: string): boolean {
  return file.endsWith('.jsonl') || file.endsWith('.json')
}

function extractClaudeCodeText(value: unknown): ExtractedText {
  const record = objectValue(value)
  if (record === null) return null
  const type = stringValue(record.type)
  const role = stringValue(record.role) ?? stringValue(objectValue(record.message)?.role)
  if (record.isMeta === true || isClaudeLocalCommandRecord(record)) return SKIP_RECORD
  if (isKnownNonDialogueType(type) || isKnownNonDialogueRole(role)) return SKIP_RECORD
  if (!isDialogueMarker(type) && !isDialogueMarker(role)) return null
  return (
    contentText(recordValue(record, 'content')) ??
    contentText(recordValue(objectValue(record.message), 'content'))
  )
}

function extractCodexText(value: unknown): ExtractedText {
  const record = objectValue(value)
  if (record === null) return null

  const item =
    objectValue(record.item) ?? objectValue(record.payload) ?? objectValue(record.message) ?? record
  const type = stringValue(record.type) ?? stringValue(item.type)
  if (isKnownCodexNonDialogueType(type)) return SKIP_RECORD
  if (type === 'response_item') {
    if (item === record || stringValue(item.type) !== 'message') return SKIP_RECORD
    const role = stringValue(item.role)
    if (!isCodexDialogueRole(role)) return SKIP_RECORD
    return contentText(recordValue(item, 'content')) ?? contentText(recordValue(item, 'text'))
  }
  const role = stringValue(record.role) ?? stringValue(item.role)
  if (isKnownNonDialogueRole(role) || isKnownCodexNonDialogueType(stringValue(item.type)))
    return SKIP_RECORD
  if (type !== 'message' && !isCodexDialogueRole(role)) return null
  if (!isCodexDialogueRole(role)) return SKIP_RECORD
  return (
    contentText(recordValue(item, 'content')) ??
    contentText(recordValue(record, 'content')) ??
    contentText(recordValue(item, 'text'))
  )
}

function extractOpenClawText(value: unknown): ExtractedText {
  const record = objectValue(value)
  if (record === null) return null
  const role =
    stringValue(record.role) ??
    stringValue(record.speaker) ??
    stringValue(objectValue(record.message)?.role)
  if (isKnownNonDialogueRole(role)) return SKIP_RECORD
  if (!isDialogueMarker(role)) return null
  return (
    contentText(recordValue(record, 'content')) ??
    contentText(recordValue(objectValue(record.message), 'content'))
  )
}

function contentText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const parts = value.flatMap(item => {
      const text = contentText(item)
      return text === null ? [] : [text]
    })
    return parts.length === 0 ? null : parts.join('\n')
  }
  const record = objectValue(value)
  if (record === null) return null
  return (
    contentText(recordValue(record, 'text')) ??
    contentText(recordValue(record, 'input_text')) ??
    contentText(recordValue(record, 'output_text'))
  )
}

function isDialogueMarker(value: string | null): boolean {
  return value === 'user' || value === 'assistant' || value === 'human' || value === 'model'
}

function isCodexDialogueRole(value: string | null): boolean {
  return value === 'user' || value === 'assistant'
}

function isKnownNonDialogueRole(value: string | null): boolean {
  return value === 'system' || value === 'developer' || value === 'tool'
}

function isKnownNonDialogueType(value: string | null): boolean {
  return (
    value === 'metadata' ||
    value === 'summary' ||
    value === 'system' ||
    value === 'developer' ||
    value === 'tool' ||
    value === 'tool_use' ||
    value === 'tool_result' ||
    value === 'reasoning'
  )
}

function isKnownCodexNonDialogueType(value: string | null): boolean {
  return (
    value === 'reasoning' ||
    value === 'tool_call' ||
    value === 'function_call' ||
    value === 'function_call_output' ||
    value === 'custom_tool_call' ||
    value === 'custom_tool_call_output' ||
    isKnownNonDialogueType(value)
  )
}

function isClaudeLocalCommandRecord(record: Record<string, unknown>): boolean {
  if (stringValue(record.type) === 'local-command') return true
  if (stringValue(record.type) === 'local_command') return true
  const message = objectValue(record.message)
  const content = recordValue(record, 'content') ?? recordValue(message, 'content')
  if (typeof content === 'string' && content.includes('<local-command')) return true
  if (!Array.isArray(content)) return false
  if (content.some(item => contentText(item)?.trim())) return false
  return content.some(item => {
    const itemRecord = objectValue(item)
    const type = stringValue(itemRecord?.type)
    return type === 'tool_result' || type === 'tool_use' || type === 'local_command'
  })
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function recordValue(record: Record<string, unknown> | null, key: string): unknown {
  return record === null ? undefined : record[key]
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}
