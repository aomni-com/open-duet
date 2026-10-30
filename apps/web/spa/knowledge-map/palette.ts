/* ============================================================================
   Colour as a vocabulary, not a set of hexes.

   Two questions get asked of every node. They are different questions, so they
   are answered from different parts of the spectrum and they never mix:

     what kind of thing is this?    jobs · skills · files · apps   (kinds.ts)
     does it want something?        running · asking · scheduled · done   (here)

   STATE is the only thing on this map allowed to be saturated, and only two
   states are: *running* (electric blue) and *needs you* (coral) — a cool and a
   warm, because a machine getting on with it and an alarm should never have to
   be told apart by shade. "Connected" is the resting state of an app and wears
   nothing at all, not even a tick, because decorating the normal case is how a
   map turns into a dashboard.

   Running outranks asking. Both matter, but only one is spending money while
   you look at it: a question waits indefinitely at no cost, and a turn does
   not. The reader who sees blue and clicks in finds the question anyway.

   The four job states here are `SessionBucket`, the wire's own vocabulary —
   see types.ts. The tone is the only thing this file adds to it.

   This file ranks and tones a state; it does not *name* one. The name is copy,
   and copy has to be translated — every surface that prints a state word reads
   it out of the message catalogue keyed on the same string this returns.

   The hexes live in knowledge-map.css, keyed off the tone.
   ========================================================================= */
import type { Attention, BadgeGlyph, ItemState, LeafItem, Tone } from './types'

type StateMeaning = {
  /** what bubbles up to the parent; rank 0 never does */
  rank: number
  tone: Tone
  glyph: BadgeGlyph
}

const STATE: Record<ItemState, StateMeaning> = {
  running: { rank: 3, tone: 'live', glyph: 'spin' },
  asking: { rank: 2, tone: 'alert', glyph: 'ask' },
  /* Waiting on a clock, not on a machine. It borrows the resting tone rather
     than the live one because nothing is happening and nothing will until the
     alarm goes off — but it still bubbles, because it is unfinished work. */
  scheduled: { rank: 1, tone: 'muted', glyph: 'dot' },
  done: { rank: 0, tone: 'muted', glyph: 'none' },
  connected: { rank: 0, tone: 'ok', glyph: 'none' },
  available: { rank: 0, tone: 'offer', glyph: 'plus' },
  idle: { rank: 0, tone: 'muted', glyph: 'none' },
}

function carriesState(it: LeafItem): it is LeafItem & { state: ItemState } {
  /* hasOwn rather than `in`: `in` also answers true for inherited keys, so an
     item whose state came through untyped as "toString" would index STATE and
     read undefined off it. */
  return 'state' in it && typeof it.state === 'string' && Object.hasOwn(STATE, it.state)
}

/**
 * The state an item carries, or `idle` for one that carries none.
 *
 * Deliberately the identity on anything stateful. It used to fold "finished and
 * unread" into a `fresh` state, which put a reading-queue fact in the same slot
 * as a work fact and made them compete for one rank. Unread is its own axis now
 * — a badge, not a state — so this has nothing left to decide.
 */
export function stateOf(it: LeafItem | null | undefined): ItemState {
  return it && carriesState(it) ? it.state : 'idle'
}

export function meaningOf(state: ItemState): StateMeaning {
  return STATE[state]
}

export function toneOf(state: ItemState): Tone {
  return STATE[state].tone
}

/** True when a state is worth drawing a mark for at all. */
export function isSilent(state: ItemState): boolean {
  return STATE[state].glyph === 'none'
}

/* Unread lives in `./unread.ts`. It is a second axis and explicitly not a tone —
   this file's own note said so while still holding it — and the rule about which
   set a given node counts wants an owner of its own. */

/* The most urgent thing among a set of children, rolled up to the parent. Only
   states that want an action bubble — "not connected" is an offer, so it stays
   on its own card. If every agent wore a badge nobody would look at any. */
export function attention(items: readonly LeafItem[] | undefined): Attention {
  const counts = new Map<ItemState, number>()
  let top: ItemState | null = null
  for (const it of items ?? []) {
    const k = stateOf(it)
    counts.set(k, (counts.get(k) ?? 0) + 1)
    if (!top || STATE[k].rank > STATE[top].rank) top = k
  }
  if (top && STATE[top].rank === 0) top = null
  return { top, n: top ? (counts.get(top) ?? 0) : 0 }
}
