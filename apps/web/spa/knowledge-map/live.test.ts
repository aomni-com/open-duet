import { expect, test } from 'bun:test'

import { agentIsLive, beatOf, jobIsLive, liveWork } from './live'
import type { Agent, Job } from './types'

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j',
  title: 't',
  when: 'now',
  state: 'running',
  unread: false,
  ...over,
})

const agent = (jobs: readonly Job[]): Agent => ({
  id: 'a',
  name: 'A',
  avatarKey: 'a',
  jobs,
  apps: [],
})

/* The rule the pulse is built on. It used to have to subtract sleeping jobs
   back out of `running`, because the wire called both the same thing; now
   `scheduled` arrives as its own bucket and only one state is in flight. */
test('in flight means running, and nothing else is', () => {
  expect(jobIsLive(job({ state: 'running', unread: false }))).toBe(true)
  expect(jobIsLive(job({ state: 'scheduled', unread: false }))).toBe(false)
  expect(jobIsLive(job({ state: 'asking', unread: false }))).toBe(false)
  expect(jobIsLive(job({ state: 'done', unread: false }))).toBe(false)
})

/* An agent stuck on a question is not working, however much work it has open. */
test('an agent is live when any one session is in flight', () => {
  expect(
    agentIsLive(
      agent([job({ state: 'asking', unread: false }), job({ state: 'running', unread: false })]),
    ),
  ).toBe(true)
  expect(
    agentIsLive(
      agent([job({ state: 'asking', unread: false }), job({ state: 'done', unread: false })]),
    ),
  ).toBe(false)
  expect(agentIsLive(agent([job({ state: 'scheduled', unread: false })]))).toBe(false)
  expect(agentIsLive(agent([]))).toBe(false)
})

test('an agent working in its own conversation is live on the root map', () => {
  const runningChat = job({ id: 'chat', state: 'running', unread: false })
  const chatting = { ...agent([]), chat: [runningChat] }
  expect(agentIsLive(chatting)).toBe(true)
  expect(liveWork(chatting).jobs.map(item => item.id)).toEqual(['chat'])
})

/* The whole point of the beat is that two agents never have the same one. A ring
   where every trunk fires together is a metronome; the same ring with each agent
   on its own phase is a thing that is alive. So what is asserted is the spread,
   not a value: a hash that returned a constant would satisfy "in range" and
   "stable" and be exactly the bug this exists to prevent. */
test('every agent gets its own place in the beat, and keeps it', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `agent-${i}`)
  const beats = ids.map(beatOf)

  for (const beat of beats) {
    expect(beat.phase).toBeGreaterThanOrEqual(0)
    expect(beat.phase).toBeLessThan(1)
    expect(beat.stretch).toBeGreaterThanOrEqual(0)
    expect(beat.stretch).toBeLessThan(1)
  }

  /* Spread across the cycle rather than bunched: ten buckets, and a real fleet
     should land in nearly all of them. Two agents sharing a bucket is fine —
     forty agents sharing three would be a ring that still pulses in chorus. */
  const buckets = new Set(beats.map(beat => Math.floor(beat.phase * 10)))
  expect(buckets.size).toBeGreaterThanOrEqual(8)

  /* And the two numbers are not each other. Deriving the stretch from the same
     bits as the phase would tie "when it fires" to "how fast it runs", so the
     ring would drift back into unison instead of away from it. */
  expect(new Set(beats.map(beat => beat.stretch)).size).toBeGreaterThanOrEqual(8)
  expect(beats.filter(beat => beat.phase === beat.stretch)).toEqual([])

  // Stable, or the pulse would jump every time React re-rendered the ring.
  expect(beatOf('agent-7')).toEqual(beatOf('agent-7'))
})

/* What the card reads. The sessions themselves, in the order the wire gave
   them, and then the two things that are *not* in flight but change what the
   reader should do about it. */
test('live work is the sessions in flight, plus what is waiting either side', () => {
  const running = job({ id: 'r', state: 'running', unread: false })
  const work = liveWork(
    agent([
      job({ id: 'a1', state: 'asking', unread: false }),
      running,
      job({ id: 's1', state: 'scheduled', unread: false }),
      job({ id: 'a2', state: 'asking', unread: false }),
      job({ id: 'd1', state: 'done', unread: false }),
    ]),
  )
  expect(work.jobs.map(j => j.id)).toEqual(['r'])
  expect(work.asking).toBe(2)
  expect(work.onClock).toBe(1)
})
