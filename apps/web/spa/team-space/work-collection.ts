import type { SessionListItem } from '@repo/contract'

/**
 * The visible slice of a Work list, and whether there is more behind it.
 *
 * Two lists share it, and they share it because they came to the same rule from
 * opposite mistakes: the rail (top-level, non-default, unarchived sessions) and
 * the delegated-work panel inside a conversation (everything that conversation
 * spawned). Both draw *all* of what comes back — there is no second,
 * client-side opinion about which of those rows is really a conversation.
 *
 * Each used to have one, pointing opposite ways. The rail filtered *out* any
 * row carrying a `machine` — a session running a state machine, which the
 * product calls a job — on the theory that Work holds conversations and Build
 * holds work; the per-agent groups further down the same column never applied
 * it, so one sidebar answered "what is this workspace doing" two different
 * ways, and the half a reader lands on first was the half that hid running
 * work. The panel filtered the other way, drawing *only* the children that
 * carried one, which left an ordinary delegated conversation with nowhere to
 * appear at all: the rail excludes it for being a child, and the panel excluded
 * it for being quiet. Which bucket a session is in is something its row says,
 * never something that decides whether the row exists.
 *
 * With no filter left, a page that comes back *short* is a list that is short —
 * there is no second opinion here to make it shorter. A page that comes back
 * **empty** is a different thing, and it is why `fetchNext` survived the filter
 * that used to justify it: the endpoint does not drop every row it drops before
 * the page is measured. A candidate the reader cannot see, one archived for
 * them alone, one the search text misses — each is dropped *inside* the page
 * while the cursor still advances past it, so `{items: [], nextCursor: '…'}` is
 * an ordinary answer meaning "keep reading". Drawing "nothing here" over a live
 * cursor tells a reader their conversation spawned no work while its children
 * sit one page behind.
 *
 * So the drain is narrow — only when nothing at all has been drawn — and
 * budgeted, because a conversation whose children are all hidden from this
 * reader would otherwise read the workspace's whole tail in the background to
 * draw nothing. After the automatic budget, the caller offers explicit continuation while a cursor remains.
 *
 * `truncated` is the other cap and a different one: a rail budget rather than a
 * request budget, and what puts "older conversations" under the last row.
 */
export function projectWorkConversationRows(
  pages: readonly { items: readonly SessionListItem[]; nextCursor: string | null }[],
  limit: number,
  pageLimit = WORK_COLLECTION_DRAIN_PAGES,
): { items: SessionListItem[]; fetchNext: boolean; truncated: boolean } {
  const rows = pages.flatMap(page => page.items)
  const lastCursor = pages.at(-1)?.nextCursor
  const hasNextPage = lastCursor !== null && lastCursor !== undefined
  return {
    items: rows.slice(0, limit),
    fetchNext: workCollectionDraining({
      itemCount: rows.length,
      hasNextPage,
      pagesRead: pages.length,
      pageLimit,
    }),
    truncated: rows.length > limit || hasNextPage,
  }
}

/** Automatic page budget while a collection is still looking for its first row. */
export const WORK_COLLECTION_DRAIN_PAGES = 4

/**
 * Whether a list holding nothing yet should read past the page it has.
 *
 * The rule shared by session discovery lists. They read different endpoints
 * and draw different rows, and they
 * share the one thing that makes this necessary — the server drops rows inside
 * the page it is measuring, so an empty page with a cursor behind it means
 * "keep reading", not "there is nothing here".
 *
 * The page budget is what makes it a projection rather than a loop: a reader
 * who cannot see any of a long tail would otherwise pull the whole tail through
 * in the background to draw nothing.
 */
export function workCollectionDraining(input: {
  itemCount: number
  hasNextPage: boolean
  pagesRead: number
  pageLimit?: number
}): boolean {
  return (
    input.itemCount === 0 &&
    input.hasNextPage &&
    input.pagesRead < (input.pageLimit ?? WORK_COLLECTION_DRAIN_PAGES)
  )
}

export type WorkCollectionPhase =
  | 'pending'
  | 'initial-error'
  | 'continuation-error'
  | 'empty'
  | 'ready'

/**
 * `draining` is the state between "nothing yet" and "nothing at all": the first
 * page came back holding none of this list's rows and a cursor is still open,
 * so the answer is not in yet. It reads as loading rather than as empty,
 * because those are the two things a reader can act on and only one of them is
 * true — and the read that resolves it is already in flight.
 */
export function workCollectionPhase(input: {
  pending: boolean
  initialError: boolean
  continuationError: boolean
  itemCount: number
  /* Required rather than optional: the honest default is not `false`, it is
     "the caller has not thought about it", and an omitted flag would quietly
     restore the empty-over-a-live-cursor answer this exists to prevent. */
  draining: boolean
}): WorkCollectionPhase {
  if (input.pending) return 'pending'
  if (input.initialError) return 'initial-error'
  if (input.continuationError && input.itemCount === 0) return 'continuation-error'
  if (input.draining && input.itemCount === 0) return 'pending'
  return input.itemCount === 0 ? 'empty' : 'ready'
}
