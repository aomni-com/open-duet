/* ============================================================================
   The order of the row across the top of the agent's card.

   ---- one row, and the reader owns it ----
   Everything the card can show is one selector in one strip, read left to right:
   the apps the agent reaches, its folder on the drive, and the shared desktop.
   There are no sections, because a section is a claim that two of these are a different
   *kind* of thing, and to a reader choosing what to look at they are not — they
   are answers to one question.

   The work in flight used to be in here, and what the drive is plugged into
   beside it. Jobs left because it is not a face of this agent you *look* at, it
   is the record of what it has done — it is a door beside the agent's name now,
   and it opens a dialog over the whole map. Connections left the surface
   entirely: they are the drive's, not this agent's, and every agent drew the
   same list.

   The card opens on whatever is first. That is the whole of why the order is
   worth storing: it is not decoration, it is the reader saying which of an
   agent's faces they want to arrive at.

   ---- the order belongs to the agent ----
   Stored per agent, not once for the reader. An agent *is* its apps, and what
   the reader wants to arrive at is a fact about this agent rather than about
   how they work generally: the one that writes reports opens on its folder, the
   one that watches a dashboard opens on the dashboard. A single order shared
   across every agent would make one of those arrangements wrong every time it
   made the other right.

   ---- and it survives the world moving underneath it ----
   Every function here is total. A saved order is a wish, not a schema: apps
   appear, apps are removed, the value in storage was written by an older version
   or by hand. The rule in all of those is the same — honour what still makes
   sense, drop what does not, and put anything new where it would have been if
   the reader had never touched the row. Never throw, and never show an empty
   row, because the row is the only way back to the rest of the agent.
   ========================================================================= */

/** What a selector in the row stands for. */
export type HeaderItemKind = 'app' | 'files' | 'desktop'

export type HeaderItem = {
  /** stable across renders and across sessions — this is what is stored */
  key: string
  kind: HeaderItemKind
  /** which app, when it is one */
  appId?: string
}

/** One key per selector. Apps carry their id because there is one per app. */
export const FILES_KEY = 'files'
export const DESKTOP_KEY = 'desktop'
export const appKey = (id: string): string => `app:${id}`

/** The id an app key names, or null for either fixed selector. */
export function appIdOf(key: string): string | null {
  return key.startsWith('app:') ? key.slice('app:'.length) : null
}

/**
 * What the agent has to offer the row.
 *
 * Kept as an object rather than a bare array, which would put two
 * `readonly string[]` parameters side by side in `orderedItems` — the agent's
 * apps and the reader's saved order — which is a pair anybody can transpose and
 * the compiler will never notice.
 */
export type HeaderInput = {
  /** the agent's apps, in the order the agent's own read hands them over */
  appIds: readonly string[]
}

/**
 * The row nobody has arranged: the agent's apps, then its files and the shared
 * desktop.
 *
 * Apps lead because an app is what an agent is *for*. Files and Desktop follow
 * because they are shared furniture rather than the agent's output — and
 * because the far end of a row does not move when an agent gains or loses an
 * app.
 */
export function defaultKeys({ appIds }: HeaderInput): string[] {
  return [...appIds.map(appKey), FILES_KEY, DESKTOP_KEY]
}

function itemOf(key: string): HeaderItem {
  const appId = appIdOf(key)
  if (appId !== null) return { key, kind: 'app', appId }
  return key === DESKTOP_KEY ? { key, kind: 'desktop' } : { key, kind: 'files' }
}

/**
 * The row this agent actually draws, given what the reader has arranged.
 *
 * The saved order is applied as a *filter and a sort over the default*, never as
 * the list itself. That is the difference between a preference and a snapshot:
 * a stored list taken literally would keep drawing an app the agent no longer
 * reaches, and would silently hide one it gained after the reader last touched
 * the row. Here, what the agent has is what appears; the saved order only says
 * in what sequence.
 *
 * Anything the reader has never seen keeps its default neighbours rather than
 * being appended to the end. A new app belongs with the other apps, not behind
 * the drive's folder — the reader arranged the row they were shown, and they
 * were never shown this.
 */
export function orderedItems({
  appIds,
  saved,
}: HeaderInput & { saved: readonly string[] | null }): HeaderItem[] {
  const wanted = defaultKeys({ appIds })
  if (saved === null || saved.length === 0) return wanted.map(itemOf)

  const present = new Set(wanted)
  /* Only the saved keys this agent actually has, in the reader's sequence. A key
     for another agent's app is carried in storage and ignored here — and a
     duplicate, which a hand-edited value can carry, is taken once. */
  const seen = new Set<string>()
  const placed = saved.filter(key => present.has(key) && !seen.has(key) && seen.add(key) !== null)

  /* Each unplaced key rides behind everything the reader deliberately put ahead
     of it: of all the placed keys that precede it in the *default* order, it
     follows whichever the reader dragged *latest*. Anchoring to the nearest
     default predecessor instead is subtly wrong, and the case that shows it is a
     reader who dragged their first app behind the files view — a *second* app
     defaults between the two, so anchoring to it would slot the new app ahead of
     the one the reader deliberately sent to the back and quietly undo the drag.
     A key with no placed predecessor at all belongs at the very front. */
  const rankOf = new Map(placed.map((key, index) => [key, index]))
  const trailing = new Map<string | null, string[]>()
  let behind: string | null = null
  let behindRank = -1
  for (const key of wanted) {
    const rank = rankOf.get(key)
    if (rank !== undefined) {
      if (rank > behindRank) {
        behind = key
        behindRank = rank
      }
      continue
    }
    const bucket = trailing.get(behind)
    if (bucket === undefined) trailing.set(behind, [key])
    else bucket.push(key)
  }

  const merged = [...(trailing.get(null) ?? [])]
  for (const key of placed) {
    merged.push(key)
    merged.push(...(trailing.get(key) ?? []))
  }
  return merged.map(itemOf)
}

/**
 * The row after the reader drags `moved` onto `onto`.
 *
 * Takes and returns the *drawn* keys rather than the stored ones, because what
 * the reader is arranging is the row in front of them.
 *
 * A drag onto itself, or onto something that is not in the row, is not an
 * error — it is a drag that was released where it started, which happens on
 * every mis-aimed pointer and must leave the row exactly as it was.
 */
export function reorder(keys: readonly string[], moved: string, onto: string): string[] {
  const from = keys.indexOf(moved)
  const to = keys.indexOf(onto)
  if (from === -1 || to === -1 || from === to) return [...keys]
  const out = [...keys]
  out.splice(from, 1)
  out.splice(to, 0, moved)
  return out
}

/* --------------------------------------------------------------- storage
   One key per agent — see the note at the top. The version suffix is what lets
   the shape change without anybody having to write a migration for a preference:
   an older value simply stops being found, and the row falls back to its
   default, which is a row the reader can use. */
const storageKey = (agentId: string): string => `duet.agent-surface.header-order.v1:${agentId}`

/**
 * What the reader arranged, or null if they never have.
 *
 * Total, because every one of its failure modes is somebody else's: storage
 * disabled by the browser, a quota error, a value written by an older build, a
 * value edited by hand. None of them is worth a broken card, and all of them
 * mean the same thing here — nobody has told us an order.
 */
export function readOrder(
  storage: Pick<Storage, 'getItem'> | undefined,
  agentId: string,
): string[] | null {
  if (storage === undefined) return null
  try {
    const raw = storage.getItem(storageKey(agentId))
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    const keys = parsed.filter((key): key is string => typeof key === 'string' && key.length > 0)
    return keys.length === 0 ? null : keys
  } catch {
    return null
  }
}

/** Store it, and never let failing to do so break the drag that caused it. */
export function writeOrder(
  storage: Pick<Storage, 'setItem'> | undefined,
  agentId: string,
  keys: readonly string[],
): void {
  if (storage === undefined) return
  try {
    storage.setItem(storageKey(agentId), JSON.stringify(keys))
  } catch {
    /* A preference the browser will not keep is still a preference for this
       session: the caller holds the order in state either way. */
  }
}
