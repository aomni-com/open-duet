/* ============================================================================
   Is this agent working *right now*?

   A different question from the one `palette.ts` answers, and the map needs
   both. Attention asks "what is the most urgent thing here" and surfaces one
   state — so an agent that is both stuck on a question and running three
   sessions wears coral and says nothing at all about the three. Liveness asks
   only whether anything is in flight, and it is true alongside every other
   state rather than instead of them. That is what the trunk pulse and the mark
   on the plate are drawn from.

   ---- "in flight" is now just `running` ----
   It did not use to be. The wire called a job asleep on a clock `running` too,
   so this had to subtract those back out by hand, and the rule lived here so
   that a face on the ring and a heading inside it could not disagree. The wire
   distinguishes them itself now — `scheduled` is a bucket, indexed and stamped
   on the row — so the subtraction is gone and there is nothing left to keep in
   step. That is what moving a derivation onto the data buys.
   ========================================================================= */
import type { CSSProperties } from 'react'

import { stateOf } from './palette'
import type { Agent, Job } from './types'

/** Working right now. `scheduled` is its own bucket, so this is the whole definition. */
export function jobIsLive(job: Job): boolean {
  return stateOf(job) === 'running'
}

export function agentIsLive(agent: Agent): boolean {
  return agent.jobs.some(jobIsLive) || agent.chat?.some(jobIsLive) === true
}

/* ---- the beat ----------------------------------------------------------
   Where one agent's pulse sits, so that no two agents have the same one.

   A ring whose trunks all fire on the same clock is a metronome — twelve
   identical blinks, in chorus, forever — and the eye stops reading it as twelve
   machines working and starts reading it as one animation looping. So every
   agent is handed a place in the cycle and a cycle very slightly its own, and
   what the map does instead is drift: pulses cross it in an order that never
   quite repeats, which is what a room full of independent workers actually looks
   like.

   From the id rather than from a counter, and certainly not from a clock or a
   random: the map re-renders on every hover, agents come and go from the ring,
   and a beat that moved when the fleet changed would restart every pulse on
   screen. A pure function of the name is the same beat forever, and the same
   beat in a screenshot. */
export type Beat = {
  /** where in its own cycle it starts, in cycles */
  phase: number
  /** how much to stretch that cycle, in cycles — see `--km-cycle` */
  stretch: number
}

/* FNV-1a. Cheap, well spread over short strings, and — the reason it is spelled
   out rather than borrowed from a hash of convenience — it is a fixed rule that
   cannot change under us and quietly re-shuffle every pulse in the product. */
function fnv1a(text: string): number {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export function beatOf(id: string): Beat {
  /* Two hashes, not two slices of one: the phase and the stretch have to be
     independent or "when it fires" would be a function of "how fast it runs",
     and the ring would drift back into unison instead of away from it. */
  return { phase: (fnv1a(id) % 997) / 997, stretch: (fnv1a(`${id}~`) % 991) / 991 }
}

/**
 * The beat, as the two custom properties the stylesheet does its timing in.
 *
 * Handed to the DOM rather than turned into a duration here, because the *shape*
 * of the pulse is the stylesheet's business — how long a cycle is, how far the
 * echo trails, what eases — and this only knows which agent it belongs to. See
 * `--km-cycle` and `--km-lead` in knowledge-map.css.
 *
 * The type is spelled out rather than cast: an inline custom property is
 * ordinary CSS and this module holds no `as`.
 */
export type PulseStyle = CSSProperties & Record<'--km-phase' | '--km-stretch', number>

export function pulseStyle(id: string): PulseStyle {
  const beat = beatOf(id)
  return { '--km-phase': beat.phase, '--km-stretch': beat.stretch }
}

/**
 * What an agent has going, as the peek card reads it.
 *
 * The sessions in flight, in the order the wire gave them, and then the two
 * things that are *not* in flight but change what to do about it: work stopped
 * on a question, and work that will start itself later. Counted rather than
 * listed, because a card about what is happening should not be mostly a list of
 * what is not.
 */
export type LiveWork = {
  jobs: readonly Job[]
  /** stopped, and waiting on you */
  asking: number
  /** running, but asleep until its alarm */
  onClock: number
}

export function liveWork(agent: Agent): LiveWork {
  let asking = 0
  let onClock = 0
  const sessions = agent.chat === undefined ? agent.jobs : [...agent.jobs, ...agent.chat]
  for (const job of sessions) {
    if (stateOf(job) === 'asking') asking += 1
    else if (stateOf(job) === 'scheduled') onClock += 1
  }
  return { jobs: sessions.filter(jobIsLive), asking, onClock }
}
