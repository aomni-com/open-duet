/* ============================================================================
   What the card on the right is showing, and which selector says so.

   Three of the states are the reader's — an app, the agent's folder, or the
   shared desktop — and the other two are the query's. They are separated here,
   away from any JSX,
   because the rule that matters is not a rendering rule: an agent whose app
   list is still in flight and an agent that reaches no apps at all hand over the
   same empty array, and the card must not tell you the second thing while the
   first is true.

   The reader's choice is `null` until they make one, rather than being seeded
   with the first app when the zoom opens. The apps arrive a moment after the
   agent does, so seeding would mean an effect that writes state from data — and
   an effect like that is how a card ends up on an app the reader has already
   navigated away from.
   ========================================================================= */
import type { MapCard } from '../../../drive/agents-map-url'
import type { Read } from '../../../knowledge-map-data/use-agent-reads'
import type { Phase } from '../../../knowledge-map-data/use-workspace-map'
import type { AppItem } from '../../../knowledge-map/types'
import { appKey, DESKTOP_KEY, FILES_KEY, type HeaderItem } from './header-order'

/** What the reader picked. Null means they have not picked anything yet. */
export type AgentSurfaceShowing =
  | { kind: 'app'; app: AppItem }
  /** the agent's own folder on the drive, opened in the drive's own surface */
  | { kind: 'files' }
  /** the one workspace desktop; the agent is only another door into it */
  | { kind: 'desktop' }

/** What the card actually draws, once the reads have had their say. */
export type AgentStage =
  | AgentSurfaceShowing
  /** the agent reaches no apps — a fact about the agent */
  | { kind: 'none' }
  /** the app list has not answered — a fact about the query */
  | { kind: 'reading'; phase: Exclude<Phase, 'ready'> }

/**
 * The card a URL names, resolved against the app list behind it.
 *
 * `null` means "no choice" and hands the decision back to `stageOf` below,
 * which opens on the reader's own arranged row. Three ways to get there, and
 * only one of them is the reader saying nothing:
 *
 * - the URL names no card at all — the bare agent path;
 * - the URL names an app and the list has answered without it. The app is gone,
 *   uninstalled since the link was written, and falling through to the row's
 *   next item is the rule this file already keeps for a stored key that
 *   outlived its app. Note the asymmetry with a named *job*, which says so
 *   instead: a missing app has an obvious next thing to show and no risk of
 *   silently substituting somebody else's content, because the row it falls
 *   through to is the reader's own.
 *
 * While the list is still in flight the app is drawn as a stub rather than as
 * nothing, so a cold deep link opens on the app it names instead of flashing
 * the row's default and jumping.
 */
export function showingOf(card: MapCard, apps: Read<AppItem>): AgentSurfaceShowing | null {
  if (card.kind === 'files') return { kind: 'files' }
  if (card.kind === 'desktop') return { kind: 'desktop' }
  if (card.kind !== 'app') return null
  const app = apps.items.find(candidate => candidate.id === card.appSlug)
  if (app !== undefined) return { kind: 'app', app }
  if (apps.phase === 'ready') return null
  /* A stub with the slug as its identity: the picker marks the app being
     looked at either way, and the title fills in when the record lands. */
  return { kind: 'app', app: { id: card.appSlug, title: '', when: '', state: 'connected' } }
}

/**
 * What the card draws, from the reader's choice and the row they arranged.
 *
 * The default is the *first thing in the row*, not the first app. That is the
 * whole point of letting the row be arranged: a reader who drags files to the
 * front is saying they want to arrive at files. It used to seed from the app
 * list, which meant the arrangement could only ever change what the selectors
 * looked like and never where the card opened.
 *
 * The apps read is still what gates the two non-choices, because it is the only
 * one of these that can be mid-flight: an agent whose app list has not landed
 * and an agent that reaches no apps hand over the same empty array, and the card
 * must not say the second while the first is true.
 */
export function stageOf(
  showing: AgentSurfaceShowing | null,
  apps: Read<AppItem>,
  row: readonly HeaderItem[] = [],
): AgentStage {
  if (showing !== null) return showing
  if (apps.phase !== 'ready') return { kind: 'reading', phase: apps.phase }
  /* The first thing in the row that can actually be drawn. Walking rather than
     taking `row[0]` is the whole of the resilience here: the row is arranged
     from keys, and a key can outlive the thing it names — an app uninstalled
     since the reader last opened this agent is still first in their stored
     order. Landing on it would open the card on nothing and, worse, on nothing
     the reader can navigate out of, because the selector they are looking for is
     the one that is gone. Falling through to the next item costs them their
     first choice and keeps their second. */
  for (const item of row) {
    if (item.kind === 'files') return { kind: 'files' }
    if (item.kind === 'desktop') return { kind: 'desktop' }
    const app = apps.items.find(candidate => candidate.id === item.appId)
    if (app !== undefined) return { kind: 'app', app }
  }
  return { kind: 'none' }
}

/**
 * Whether a bare agent URL is still on its way to naming a card.
 *
 * The surface is withheld while this is true — a cold link must not paint one
 * destination and jump to another when the app list arrives — and the page
 * holds its own skeleton instead. So the question this answers is not "is the
 * card unresolved" but the narrower one: **can it still arrive?**
 *
 * An errored read is not going to answer, and an agent that reaches nothing has
 * already answered. Both used to keep the entry card "resolving" forever, which
 * meant a page that never drew: originally a blank one, and — once the blank was
 * replaced with the page's own skeleton — a skeleton nobody could get out of,
 * on a page whose card has an honest state for exactly these two cases (the
 * read's notice with its retry, or the empty stage).
 */
export function entryCardCanArrive(resolving: boolean, stage: AgentStage): boolean {
  return resolving && stage.kind === 'reading' && stage.phase !== 'error'
}

/**
 * Which selector the row draws as current, or null when none of them is.
 *
 * The keys are the header order's own — one vocabulary, so the row the reader
 * arranges and the view the card lights cannot disagree about what a thing is
 * called. There used to be a `*_PICK` alias per kind, each assigned from the
 * key it stood for; that layer was an indirection whose
 * only job was staying in step with the thing it copied.
 */
export function pickOf(stage: AgentStage): string | null {
  switch (stage.kind) {
    case 'app':
      return appKey(stage.app.id)
    case 'files':
      return FILES_KEY
    case 'desktop':
      return DESKTOP_KEY
    /* Both are states of the apps half of the row, and in both of them that
       half is empty — there is nothing to light. */
    default:
      return null
  }
}
