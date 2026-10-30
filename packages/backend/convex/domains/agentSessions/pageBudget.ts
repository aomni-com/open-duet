import { convexToJson, type Value } from 'convex/values'

import {
  CONVEX_EVENT_BUDGET_BYTES,
  SESSION_LIST_MAX_LIMIT,
  WORKSPACE_MEMBER_LIMIT,
} from '@repo/contract'

export interface SessionListReadCost {
  ranges: number
  documents: number
  bytes: number
}

export const SESSION_LIST_PAGE_LIMITS = {
  ranges: 4_096,
  documents: 32_000,
  readBytes: 16 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
} as const

export const SESSION_HISTORY_PAGE_LIMITS = {
  ...SESSION_LIST_PAGE_LIMITS,
  // Keep one platform-sized document below Convex's 16 MiB transaction cap.
  // This absorbs accounting fields outside the application document payload
  // and makes the proof strict instead of relying on equality at the kill line.
  readBytes: 15 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  documentBytes: 1 * 1024 * 1024,
} as const

/**
 * The widest page-one alias admission is a human reading an agent default:
 * discovery membership, pointer owner, readiness owner, canonical session,
 * point membership, and agent-state owner. Seven platform-sized documents
 * leave one full document of headroom beyond that six-read path. Continuation
 * is narrower because its cursor pins the canonical session id.
 */
export const SESSION_HISTORY_SUPPORT_RESERVATION: SessionListReadCost = {
  ranges: 7,
  documents: 7,
  bytes: 7 * SESSION_HISTORY_PAGE_LIMITS.documentBytes,
}

/**
 * Every durable timeline writer passes this same byte gate. The gateway already
 * trims relayed output to this public contract; enforcing it again at the
 * canonical writer covers inputs, notes, control-plane events, and future
 * writers that never cross the gateway.
 */
export function sessionEventFitsStorageBudget(event: unknown): boolean {
  const measured = serializedSessionPageBytes(event)
  return measured.json <= CONVEX_EVENT_BUDGET_BYTES && measured.convex <= CONVEX_EVENT_BUDGET_BYTES
}

/**
 * A page's own JSON around its items: `{"items":[…],"nextCursor":"…"}`, one
 * separator per item, and the widest continuation cursor the codecs mint
 * (cursors hash their filters, so their width does not grow with a request).
 *
 * An allowance rather than a measurement, because measuring it means
 * serializing the page, which is the one cost the emit gate exists to avoid.
 * It is sound only while it OVER-estimates; `pageBudget.test.ts` holds it
 * there by serializing a page the gate accepted and checking it really fits.
 */
export const SESSION_PAGE_ENVELOPE_BYTES = 4 * 1024

export class SessionHistoryPageBudget {
  #reads: SessionListReadCost = { ...SESSION_HISTORY_SUPPORT_RESERVATION }
  #responseJson = SESSION_PAGE_ENVELOPE_BYTES
  #responseConvex = SESSION_PAGE_ENVELOPE_BYTES

  /**
   * How many rows the next scan may bring back.
   *
   * Each of them is reserved at the platform-maximum document size, because
   * the scan is issued before any of their real sizes are known. That makes
   * the byte ceiling, not the page's own limit, the thing that decides how
   * wide a scan may be.
   */
  readableRows(): number {
    const byRanges = SESSION_HISTORY_PAGE_LIMITS.ranges - this.#reads.ranges
    const byDocuments = SESSION_HISTORY_PAGE_LIMITS.documents - this.#reads.documents
    const byBytes = Math.floor(
      (SESSION_HISTORY_PAGE_LIMITS.readBytes - this.#reads.bytes) /
        SESSION_HISTORY_PAGE_LIMITS.documentBytes,
    )
    return Math.max(0, Math.min(byRanges, byDocuments, byBytes))
  }

  /**
   * Charge one scan and every row it returned.
   *
   * A scan is one range however many rows it carries, so the ranges are
   * charged once here and the documents per row. Charging a range per row
   * instead would have the sizer above bounding a scan against a cost the
   * scan does not incur.
   */
  commitScan(documentBytes: readonly number[]): void {
    let bytes = 0
    for (const rowBytes of documentBytes) {
      if (
        !Number.isFinite(rowBytes) ||
        rowBytes < 0 ||
        rowBytes > SESSION_HISTORY_PAGE_LIMITS.documentBytes
      ) {
        throw new Error('Session history row exceeded the platform document budget')
      }
      bytes += rowBytes
    }
    const reads = addSessionListReadCost(this.#reads, {
      ranges: 1,
      documents: documentBytes.length,
      bytes,
    })
    if (
      reads.ranges > SESSION_HISTORY_PAGE_LIMITS.ranges ||
      reads.documents > SESSION_HISTORY_PAGE_LIMITS.documents ||
      reads.bytes > SESSION_HISTORY_PAGE_LIMITS.readBytes
    ) {
      throw new Error('Session history read exceeded its reserved budget')
    }
    this.#reads = reads
  }

  /**
   * Whether one more measured item still fits the response cap.
   *
   * One item's own bytes, never the accumulated page: weighing a page by
   * re-serializing it costs the square of what it carries, and Convex kills a
   * query at one second. Callers measure each item once and hand the numbers
   * over; this only adds.
   */
  canEmit(item: SerializedPageBytes): boolean {
    return (
      Math.max(this.#responseJson + item.json, this.#responseConvex + item.convex) <=
      SESSION_HISTORY_PAGE_LIMITS.responseBytes
    )
  }

  commitEmit(item: SerializedPageBytes): void {
    this.#responseJson += item.json
    this.#responseConvex += item.convex
  }

  snapshot(): SessionListReadCost {
    return this.#reads
  }
}

/**
 * One extra candidate the list may ask a lane for, on top of the page it wants,
 * when it is holding a single known row out of that page — the owner's default
 * chat under `excludeDefault`. Letting the exclusion spend a slot out of the
 * page's own budget is how a page comes back empty with a match one row behind
 * it; see `excludeAllowance` in `queries.ts` and `discovery.ts`, which both
 * spend exactly this.
 */
export const SESSION_LIST_EXCLUDE_ALLOWANCE = 1

/**
 * And one row past whatever limit a lane is handed, which is how the lane
 * learns there is more behind the page rather than guessing from a full one.
 */
export const DISCOVERY_LANE_HAS_MORE_PROBE = 1

// Membership archive discovery has the widest source: workspace, direct, and
// personal lanes. Discovery copies only bounded
// title/step/preview/activity/identity fields; 8 KiB per row is over twice the
// maximum-width test fixture and keeps the pre-read proof explicit even though
// actual bytes are charged after the indexed fetch.
//
// `rowsPerLane` is spelled as the sum it has to cover rather than as a number,
// because it was a number and the number went stale: the exclusion allowance
// was added to both callers afterwards, and a reservation of `limit + 1` then
// bounded one row per lane less than the read it was proving.
export const SESSION_LIST_SOURCE_RESERVATION = {
  lanes: 3,
  rowsPerLane:
    SESSION_LIST_MAX_LIMIT + SESSION_LIST_EXCLUDE_ALLOWANCE + DISCOVERY_LANE_HAS_MORE_PROBE,
  bytesPerRow: 8 * 1024,
} as const

// Canonical session, referenced owner, and unread cursor are point reads.
const SESSION_LIST_FIXED_CANDIDATE_POINT_READS = 3

/**
 * The complete maximum supporting set for one list candidate: canonical row,
 * referenced owner, current directory, generation states, caller state/unread,
 * and the ranges that produce them. The
 * byte ceilings are intentionally larger than the maximum-width fixture; the
 * proof test records the measured value and keeps this reservation honest.
 */
export const SESSION_LIST_CANDIDATE_RESERVATION = {
  // A canonical session and referenced agent/user row can each approach
  // Convex's ~1 MiB document ceiling. Directory and member-state rows are
  // structurally small; the third MiB is their explicit headroom.
  read: {
    ranges: WORKSPACE_MEMBER_LIMIT + 1 + SESSION_LIST_FIXED_CANDIDATE_POINT_READS,
    documents: WORKSPACE_MEMBER_LIMIT * 2 + SESSION_LIST_FIXED_CANDIDATE_POINT_READS,
    bytes: 3 * 1024 * 1024,
  },
  // The list projects only SessionActivityMachine: step is <=480 UTF-8 bytes
  // and every other machine field is numeric or enum. Together with bounded
  // title/cwd/identity/audience preview, 64 KiB includes ample JSON/Convex
  // envelope and cursor headroom without capping canonical machine state.
  responseBytes: 64 * 1024,
} as const

export function addSessionListReadCost(
  left: SessionListReadCost,
  right: SessionListReadCost,
): SessionListReadCost {
  return {
    ranges: left.ranges + right.ranges,
    documents: left.documents + right.documents,
    bytes: left.bytes + right.bytes,
  }
}

export type SerializedPageBytes = { json: number; convex: number }

export function serializedSessionPageBytes(value: unknown): SerializedPageBytes {
  const encoder = new TextEncoder()
  return {
    json: encoder.encode(JSON.stringify(value)).byteLength,
    convex: encoder.encode(JSON.stringify(convexToJson(value as Value))).byteLength,
  }
}

export class SessionListPageBudget {
  #reads: SessionListReadCost
  #responseJson = SESSION_PAGE_ENVELOPE_BYTES
  #responseConvex = SESSION_PAGE_ENVELOPE_BYTES

  constructor(pageSupport: SessionListReadCost) {
    this.#reads = pageSupport
  }

  canReserveCandidate(): boolean {
    const reserved = addSessionListReadCost(this.#reads, SESSION_LIST_CANDIDATE_RESERVATION.read)
    return (
      reserved.ranges <= SESSION_LIST_PAGE_LIMITS.ranges &&
      reserved.documents <= SESSION_LIST_PAGE_LIMITS.documents &&
      reserved.bytes <= SESSION_LIST_PAGE_LIMITS.readBytes &&
      this.#responseBytes() + SESSION_LIST_CANDIDATE_RESERVATION.responseBytes <=
        SESSION_LIST_PAGE_LIMITS.responseBytes
    )
  }

  /**
   * Charge one candidate's reads, and its row if it reached the page.
   *
   * The row arrives already measured and only adds to a running total. Weighing
   * the page by re-serializing it per candidate costs the square of what the
   * page carries — and a candidate the scan drops adds no row at all, so it has
   * nothing to weigh.
   */
  commitCandidate(reads: SessionListReadCost, row?: SerializedPageBytes): void {
    assertWithinReservation(reads)
    const nextReads = addSessionListReadCost(this.#reads, reads)
    if (
      row !== undefined &&
      Math.max(row.json, row.convex) > SESSION_LIST_CANDIDATE_RESERVATION.responseBytes
    ) {
      throw new Error('Session list candidate exceeded its response reservation')
    }
    const nextJson = this.#responseJson + (row?.json ?? 0)
    const nextConvex = this.#responseConvex + (row?.convex ?? 0)
    if (
      nextReads.ranges > SESSION_LIST_PAGE_LIMITS.ranges ||
      nextReads.documents > SESSION_LIST_PAGE_LIMITS.documents ||
      nextReads.bytes > SESSION_LIST_PAGE_LIMITS.readBytes ||
      Math.max(nextJson, nextConvex) > SESSION_LIST_PAGE_LIMITS.responseBytes
    ) {
      throw new Error('Session list candidate exceeded its proven page reservation')
    }
    this.#reads = nextReads
    this.#responseJson = nextJson
    this.#responseConvex = nextConvex
  }

  snapshot(): { reads: SessionListReadCost; responseBytes: number } {
    return { reads: this.#reads, responseBytes: this.#responseBytes() }
  }

  #responseBytes(): number {
    return Math.max(this.#responseJson, this.#responseConvex)
  }
}

function assertWithinReservation(reads: SessionListReadCost): void {
  const maximum = SESSION_LIST_CANDIDATE_RESERVATION.read
  if (
    reads.ranges > maximum.ranges ||
    reads.documents > maximum.documents ||
    reads.bytes > maximum.bytes
  ) {
    throw new Error('Session list candidate exceeded its supporting-set reservation')
  }
}
