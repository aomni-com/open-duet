import type { AgentTag } from '@repo/contract'

/**
 * The ONE owner of what the catalog's tag rail means.
 *
 * The gallery renders it and the card knows nothing about it. Filtering and
 * ordering live together because they answer the same question — what the user
 * sees and in what order — and splitting them would let a later change reorder
 * one path and not the other.
 */

/** `null` is "All": every listing, including the untagged. */
export type TagSelection = AgentTag | null

interface TaggedListing {
  tags: readonly string[]
  installs: number
  title: string
}

/**
 * Most-installed first, then alphabetical.
 *
 * The gallery had no ordering at all — listings arrived in whatever order the
 * catalog returned, which is invisible at three listings and arbitrary at
 * twenty. Installs are the only signal the catalog holds about whether an
 * agent is any good, and the alphabetical tiebreak keeps the order STABLE:
 * with installs mostly zero at launch, sorting on installs alone would leave
 * ties resolving differently between renders.
 */
export function orderListings<T extends TaggedListing>(listings: readonly T[]): T[] {
  return [...listings].sort(
    (left, right) => right.installs - left.installs || left.title.localeCompare(right.title),
  )
}

/** Filter then order — the gallery never does either itself. */
export function selectListings<T extends TaggedListing>(
  listings: readonly T[],
  selection: TagSelection,
): T[] {
  const matching =
    selection === null ? listings : listings.filter(listing => listing.tags.includes(selection))
  return orderListings(matching)
}
