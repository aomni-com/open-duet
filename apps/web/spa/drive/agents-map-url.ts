/* ============================================================================
   What a map URL looks like, and nothing else.

   Pure, no React, no router. One module knows this grammar so the four things
   that need it — the router's destination table, the tab the bar lights,
   whether the shell hands over the whole window, and which skeleton a cold
   landing draws — read it instead of each carrying a regex of their own. Four
   hand-rolled copies is how one of them gets missed, and every miss is silent:
   the canvas renders as a document, the Agents tab goes dark, or the loading
   frame is somebody else's.

   ---- the rule the grammar follows ----
   **A path segment names a subject the drive has; a query names how you are
   looking at it.**

   An agent, one of its apps, its folder, one of its sessions — each is a thing
   this drive contains, so each is a segment. The camera coming closer to one
   agent's work is not: nothing new is on screen and nothing is unfolded, so the
   place is still the ring and `?branch=` says where you are standing on it.
   That split is what lets `/agents/ops` keep exactly one meaning — Ops
   unfolded — instead of having to also mean "Ops, but not unfolded".

   One thing on this surface is deliberately absent: the roster rail. It is
   furniture, and whether a column is out is a working preference rather than
   anything a link could be about. It keeps its own stored answer, per reader
   rather than per drive — see `agents-rail/open-state.ts`.

   ---- the card and the dialog are siblings, never nested ----
   `…/agents/ops/apps/invoices` and `…/agents/ops/sessions/s_42` are two children of
   one agent, and the URL cannot be on both. That is not a shortcut: the dialog
   is modal, so a reader with it open cannot be picking a card behind it. The
   states are exclusive on screen, and the grammar says the same thing.

   The one cost is worth stating. Open the dialog while the card is on an app
   you picked by hand, then close it, and the card returns to the *first thing
   in your own arranged row* rather than to that pick. The arrangement is
   persisted and reader-owned (`useHeaderRow`), so `…/agents/ops` means "your
   default view of Ops" — which is a truer thing for a bare agent URL to mean
   than "whatever the last reader happened to click".
   ========================================================================= */

import { ROOT_AGENT_SCOPE } from '@repo/contract'

import { anchorPathFromBrowserPath, encodeBrowserFilePath } from '../files/lib/paths'

/** Which face of the agent the card on the right is showing. */
export type MapCard =
  /** whatever the reader's own arranged row leads with */
  | { kind: 'default' }
  /** the agent's folder entry; the route resolves its registered path */
  | { kind: 'files-entry' }
  /** the agent's folder on the drive */
  | { kind: 'files'; path: string }
  /** the workspace desktop, reached from this agent's surface */
  | { kind: 'desktop' }
  | { kind: 'app'; appSlug: string }

/**
 * Where on the map a URL is. The zoom, the card, the dialog and the session.
 *
 * The dialog's kind is `sessions` because that is what the URL says and what
 * the thing *is* — a job is a session, one conversation with one agent. The
 * product goes on calling them Jobs on screen, which is the right word for work
 * in flight; the address bar spends the word the drive uses for the record.
 */
export type MapPlace =
  /** the drive's picture of itself, a place of its own rather than what `/agents` means */
  | { kind: 'graph' }
  | { kind: 'agent'; agentSlug: string; card: MapCard }
  /**
   * One conversation with an agent, and **Work's** address rather than Build's.
   *
   * Build has no surface for it: an agent's other sessions are Work's subject,
   * and Work claims this path directly
   * (`workRouteDestination`). The shape stays in this grammar because the path
   * is still built here — one owner for the URL vocabulary under `/agents` —
   * and because `chatLandingOf` still has to recognise the owner's own chat
   * arriving at it.
   */
  | { kind: 'sessions'; agentSlug: string; sessionId: string | null }

/**
 * Segments directly under `/agents` that are destinations, not agent slugs.
 *
 * A set rather than a regex so a fifth destination under `/agents` cannot ship
 * without either joining it or turning a test red. An agent that took one of
 * these words would be an agent no URL could ever address.
 *
 * `root` is deliberately *not* here: it is the drive's own agent, a real
 * subject with a real place on this map, and it answers to the same token the
 * contract already uses everywhere else (`ROOT_AGENT_SCOPE`).
 */
export const RESERVED_AGENT_SLUGS: ReadonlySet<string> = new Set([
  'desktop',
  'marketplace',
  'graph',
])

/* The ring's one lens, in two halves: which agent's work the camera has come
   closer to, and which single bead of it. `session` rather than `job` because
   that is the word every other URL on this surface spends for the record. */

const workspaceRoot = (workspaceSlug: string) => `/w/${encodeURIComponent(workspaceSlug)}`

const agentsRoot = (workspaceSlug: string) => `${workspaceRoot(workspaceSlug)}/agents`

/** The path for a place. The only builder; every other one delegates here. */
export function agentsMapUrl(workspaceSlug: string, place: MapPlace): string {
  const root = agentsRoot(workspaceSlug)
  if (place.kind === 'graph') return `${root}/graph`
  const agent = `${root}/${encodeURIComponent(place.agentSlug)}`
  if (place.kind === 'sessions') {
    return place.sessionId === null
      ? `${agent}/sessions`
      : `${agent}/sessions/${encodeURIComponent(place.sessionId)}`
  }
  switch (place.card.kind) {
    case 'files-entry':
      return `${agent}/files`
    case 'files':
      const anchorPath = anchorPathFromBrowserPath(place.card.path)
      return anchorPath.length === 0
        ? `${agent}/files`
        : `${agent}/files/${encodeBrowserFilePath(anchorPath)}`
    case 'desktop':
      return `${agent}/desktop`
    case 'app':
      return `${agent}/apps/${encodeURIComponent(place.card.appSlug)}`
    default:
      return agent
  }
}

/** The agent's own configuration document — beside the agent, not under it. */
export function agentSettingsUrl(workspaceSlug: string, agentSlug: string): string {
  return `${agentsRoot(workspaceSlug)}/${encodeURIComponent(agentSlug)}/settings`
}

/**
 * A path → the place it names, or `null` when it is not the map at all.
 *
 * Takes the whole path — query and hash included — because every caller has one
 * and stripping it at each of them is how a `?shareRequest=` on the ring stops
 * being the ring. Foreign workspaces, reserved words, malformed escapes and
 * shapes this grammar does not have all answer `null` rather than being
 * repaired into a place, so a bad URL costs the reader an error state and never
 * somebody else's agent.
 */
export function mapPlaceOf(path: string, workspaceSlug: string): MapPlace | null {
  const read = parseMapPath(path)
  return read !== null && read.workspaceSlug === workspaceSlug ? read.place : null
}

/**
 * Whether a path is the map at all, without asking whose.
 *
 * The shell decides whether to hand a destination the whole window before it
 * knows which workspace the route resolved to, and the cold-landing skeleton
 * runs before there is an identity to resolve one against. Both need the shape
 * and neither can supply a slug, so they get the same parse with the ownership
 * question left off rather than a second regex that agrees with this one until
 * it does not.
 */
export function isMapPath(path: string): boolean {
  return parseMapPath(path) !== null
}

/**
 * Which of the two destinations under `/agents` a path names, without asking
 * whose drive it is.
 *
 * The same parse as `isMapPath`, one question deeper, and for the same callers:
 * the cold-landing skeleton has to choose between the drive's picture and one
 * agent's page before there is an identity to resolve a workspace against. It
 * used to answer `isMapPath` alone and draw the map for both, which is a whole
 * screen of the wrong shape on every deep link into an agent.
 */
export function mapDestinationOf(path: string): 'graph' | 'agent' | null {
  const read = parseMapPath(path)
  return read === null ? null : read.place.kind === 'graph' ? 'graph' : 'agent'
}

function parseMapPath(path: string): { workspaceSlug: string; place: MapPlace } | null {
  /* The path decides the place and the query never does. A query names how you
     are looking at a place, not which place it is — so `?shareRequest=` landing
     on the ring is still the ring, and a stale `?branch=` is ignored rather than
     fighting the path for the answer. Both are still split off here, once, so no
     caller has to know whether the string it holds carries either. */
  const [beforeHash] = splitOnce(path, '#')
  const [pathname] = splitOnce(beforeHash, '?')
  const segments = pathname.split('/')

  if (segments[0] !== '' || segments[1] !== 'w' || segments[3] !== 'agents') return null
  const workspaceSlug = decodeSegment(segments[2])
  if (workspaceSlug === null) return null

  const place = placeOfTail(segments.slice(4))
  return place === null ? null : { workspaceSlug, place }
}

function placeOfTail(tail: string[]): MapPlace | null {
  // A trailing slash is the same place, so `/agents/` and `/agents` agree
  // without either one needing a redirect to reach the other.
  while (tail.at(-1) === '') tail.pop()

  /* `?branch=` used to live here — the ring with the camera flown onto one
     agent's work, the first half of a two-step. Work opens in one click now, so
     the query is gone and an old link carrying it lands on the plain ring: an
     unknown query is not a place, and decision 8's hard cutover means no
     redirect and no notice. */
  /* The bare path is the root agent's conversation, and this is the one place
     that says so. Every reader of this grammar gets the answer for free: the
     Agents tab stays lit because the path still parses, the shell still hands
     over the whole window, and the cold-landing skeleton draws an agent's page
     rather than a whole drive's worth of ring resolving into a page with no
     ring on it.

     `root` is a real subject with a real place — it is deliberately absent from
     the reserved set above — so this is the grammar keeping its one rule rather
     than making an exception to it: every agent surface is addressed by an
     agent segment, and the route rewrites the bare path to the explicit one. */
  if (tail.length === 0) {
    return { kind: 'agent', agentSlug: ROOT_AGENT_SCOPE, card: { kind: 'default' } }
  }

  /* Answered before the reserved check, and the order is the whole point:
     reserved makes `parseMapPath` return null so no agent can take the word,
     while this is what makes the shell, the tab and the skeleton recognise the
     place. A word that were only reserved would break all three silently. */
  if (tail.length === 1 && tail[0] === 'graph') return { kind: 'graph' }

  const agentSlug = decodeSegment(tail[0])
  if (agentSlug === null || RESERVED_AGENT_SLUGS.has(agentSlug)) return null

  if (tail.length === 1) return { kind: 'agent', agentSlug, card: { kind: 'default' } }

  const segment = tail[1]
  if (segment === 'files') {
    if (tail.length === 2) return { kind: 'agent', agentSlug, card: { kind: 'files-entry' } }
    const decoded = tail.slice(2).map(decodeSegment)
    if (decoded.some(part => part === null)) return null
    const path = decoded.length === 0 ? '/' : `/${decoded.join('/')}`
    try {
      anchorPathFromBrowserPath(path)
    } catch {
      return null
    }
    return { kind: 'agent', agentSlug, card: { kind: 'files', path } }
  }
  if (segment === 'desktop' && tail.length === 2) {
    return { kind: 'agent', agentSlug, card: { kind: 'desktop' } }
  }
  if (segment === 'apps' && tail.length === 3) {
    const appSlug = decodeSegment(tail[2])
    return appSlug === null ? null : { kind: 'agent', agentSlug, card: { kind: 'app', appSlug } }
  }
  if (segment === 'sessions') {
    if (tail.length === 2) return { kind: 'sessions', agentSlug, sessionId: null }
    if (tail.length === 3) {
      const sessionId = decodeSegment(tail[2])
      return sessionId === null ? null : { kind: 'sessions', agentSlug, sessionId }
    }
  }
  // `settings`, `train`, and anything this grammar has never heard of.
  return null
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator)
  return index === -1 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)]
}

/**
 * One decode, failing closed.
 *
 * An empty segment is not a name, and a malformed escape is not a repair job —
 * `%GG` means the URL is wrong, and guessing what it meant is how a reader ends
 * up on an agent nobody linked to. The single decode is the same rule the drive
 * grammar next door settled on: decoding twice lets a literal `%2F` in a name
 * alias a separator.
 */
function decodeSegment(segment: string | undefined): string | null {
  if (segment === undefined || segment.length === 0) return null
  try {
    const decoded = decodeURIComponent(segment)
    return decoded.length === 0 ? null : decoded
  } catch {
    return null
  }
}

/**
 * Where a `…/sessions/:sessionId` address belongs when the session it names is
 * the owner's own chat — and `null` when it belongs exactly where it is.
 *
 * That conversation is withheld from all four of the dialog's lists, because it
 * has a panel of its own; opening it *inside* the dialog would draw it as work
 * in the one surface built to list everything beside it, with no row lit,
 * because there is no row. And it is the commonest link in the product: a
 * session's lineage badge names the parent it was spawned from, and that parent
 * is usually the owner's chat. So the address is answered with the place that
 * does hold the conversation rather than with a refusal — the link is correct,
 * only the address is.
 *
 * `chatId` is `undefined` when this owner has no chat *or* when nobody has
 * answered yet, and both mean the same thing here: no id to compare against, so
 * nothing is rewritten. A rewrite on an unanswered pointer would send every
 * deep link to the panel for as long as the alias read takes.
 *
 * Pure, and read twice per render — once to decide whether the dialog opens at
 * all, once to navigate. Deciding it during render rather than in the effect
 * alone is the whole point: an effect runs after the frame is committed, so the
 * dialog would paint "that job is not in this list" over the reader's own
 * conversation and correct itself afterwards.
 */
export function chatLandingOf(place: MapPlace, chatId: string | undefined): MapPlace | null {
  if (place.kind !== 'sessions' || place.sessionId === null) return null
  if (chatId === undefined || place.sessionId !== chatId) return null
  return { kind: 'agent', agentSlug: place.agentSlug, card: { kind: 'default' } }
}
