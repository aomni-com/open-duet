import {
  type FileFeedEvent,
  type FileHistoryResponse,
  type SeenByEntry,
  type SeenByResponse,
} from '@repo/contract'

import type {
  AttributionMember,
  FileActivityPageOptions,
  IAttributionSource,
} from './attribution-source'
import { normalizeBrowserFilePath } from './paths'

// Fixed page size so the playground can drive a "load older" pagination step
// with a handful of seeded events.
const MOCK_PAGE_SIZE = 4

// Hermetic attribution fixture for the playground and tests: seeded rows,
// deterministic failures, and call counting so cursor pagination without
// duplicates is observable from the outside.
export class MockAttributionSource implements IAttributionSource {
  private readonly seenByRows = new Map<string, SeenByEntry[]>()
  private readonly seenByCursors = new Map<string, string>()
  private readonly historyRows = new Map<string, FileFeedEvent[]>()
  private readonly scopedActivityRows = new Map<string, FileFeedEvent[]>()
  private activityRows: FileFeedEvent[] = []
  private members: AttributionMember[] = []
  fileHistoryCalls = 0
  workspaceActivityCalls = 0
  failAll = false

  seed(input: {
    members?: AttributionMember[]
    seenBy?: Record<string, SeenByEntry[]>
    seenByNextCursor?: Record<string, string>
    history?: Record<string, FileFeedEvent[]>
    activity?: FileFeedEvent[]
    scopedActivity?: Record<string, FileFeedEvent[]>
  }): void {
    if (input.members) this.members = input.members
    for (const [path, rows] of Object.entries(input.seenBy ?? {})) {
      this.seenByRows.set(normalizeBrowserFilePath(path), rows)
    }
    for (const [path, cursor] of Object.entries(input.seenByNextCursor ?? {})) {
      this.seenByCursors.set(normalizeBrowserFilePath(path), cursor)
    }
    for (const [path, rows] of Object.entries(input.history ?? {})) {
      this.historyRows.set(normalizeBrowserFilePath(path), sortBySeq(rows))
    }
    if (input.activity) this.activityRows = sortBySeq(input.activity)
    for (const [path, rows] of Object.entries(input.scopedActivity ?? {})) {
      this.scopedActivityRows.set(normalizeBrowserFilePath(path), sortBySeq(rows))
    }
  }

  async seenBy(_workspaceSlug: string, path: string): Promise<SeenByResponse> {
    this.maybeFail()
    const normalized = normalizeBrowserFilePath(path)
    return {
      items: this.seenByRows.get(normalized) ?? [],
      nextCursor: this.seenByCursors.get(normalized) ?? null,
    }
  }

  async fileHistory(
    _workspaceSlug: string,
    path: string,
    options: FileActivityPageOptions = {},
  ): Promise<FileHistoryResponse> {
    this.fileHistoryCalls += 1
    this.maybeFail()
    const rows = this.historyRows.get(normalizeBrowserFilePath(path)) ?? []
    // History keeps reads unless the caller opts out.
    return pageEvents(rows, options, options.includeReads ?? true)
  }

  async workspaceActivity(
    _workspaceSlug: string,
    options: FileActivityPageOptions = {},
  ): Promise<FileHistoryResponse> {
    this.workspaceActivityCalls += 1
    this.maybeFail()
    // A feed drops reads unless the caller opts in.
    const scoped =
      options.path === undefined
        ? undefined
        : this.scopedActivityRows.get(normalizeBrowserFilePath(options.path))
    return pageEvents(
      scoped ?? this.activityRows,
      scoped === undefined ? options : { ...options, path: undefined, scope: undefined },
      options.includeReads ?? false,
    )
  }

  async listMembers(): Promise<{ items: AttributionMember[]; nextCursor: null }> {
    this.maybeFail()
    return { items: this.members, nextCursor: null }
  }

  private maybeFail(): void {
    if (this.failAll) throw new Error('attribution_unavailable')
  }
}

function sortBySeq(rows: FileFeedEvent[]): FileFeedEvent[] {
  return [...rows].sort((a, b) => a.seq - b.seq)
}

// Emulates the seq cursor in either traversal direction, plus the public feed's
// read and path filters. Page + 1 lookahead decides nextCursor, the same
// contract the REST route parses, so pagination is exercised end to end.
function pageEvents(
  rows: readonly FileFeedEvent[],
  options: FileActivityPageOptions,
  includeReads: boolean,
): FileHistoryResponse {
  const descending = options.order === 'desc'
  const cursorSeq =
    options.cursor === undefined
      ? descending
        ? Number.POSITIVE_INFINITY
        : 0
      : parseMockCursor(options.cursor)
  const scopedPath = options.path === undefined ? undefined : normalizeBrowserFilePath(options.path)
  const pathMatches = (path: string | undefined) => {
    if (scopedPath === undefined) return true
    if (path === undefined) return false
    return options.scope === 'subtree'
      ? path === scopedPath || path.startsWith(`${scopedPath}/`)
      : path === scopedPath
  }
  const filtered = rows
    .filter(row => (descending ? row.seq < cursorSeq : row.seq > cursorSeq))
    .filter(row => includeReads || row.event.kind !== 'read')
    .filter(
      row =>
        scopedPath === undefined ||
        row.event.kind === 'restore' ||
        ('path' in row.event && pathMatches(row.event.path)) ||
        ('fromPath' in row.event && pathMatches(row.event.fromPath)),
    )
    .sort((a, b) => (descending ? b.seq - a.seq : a.seq - b.seq))
  const page = filtered.slice(0, MOCK_PAGE_SIZE)
  const last = page[page.length - 1]
  return {
    items: page,
    nextCursor:
      filtered.length > MOCK_PAGE_SIZE && last !== undefined ? `mock-activity:${last.seq}` : null,
  }
}

function parseMockCursor(cursor: string): number {
  const match = /^mock-activity:(\d+)$/.exec(cursor)
  if (match === null) throw new Error('invalid_mock_activity_cursor')
  return Number(match[1])
}
