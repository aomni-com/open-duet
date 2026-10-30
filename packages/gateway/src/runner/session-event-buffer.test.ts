import { expect, test } from 'bun:test'

import type { AgentTurnEvent } from '@repo/contract'

import {
  RingSessionEventBuffer,
  SESSION_EVENT_MAX_FRAME_BYTES,
  type LiveFrame,
} from './session-event-buffer'

test('disconnects a stalled subscriber at its event ceiling so durable replay can resume', async () => {
  const limitEvents: unknown[] = []
  const buffer = new RingSessionEventBuffer({
    capacity: 100,
    subscriberLimits: {
      maxEvents: 2,
      maxBytes: 1024 * 1024,
    },
    onSubscriberLimit: event => limitEvents.push(event),
  })
  const stalled = buffer.subscribe(0)
  buffer.push(frame(1, 'one'))
  expect(await stalled[Symbol.asyncIterator]().next()).toEqual({
    done: false,
    value: frame(1, 'one'),
  })

  buffer.push(frame(2, 'two'))
  buffer.push(frame(3, 'three'))
  buffer.push(frame(4, 'four'))

  expect(await stalled[Symbol.asyncIterator]().next()).toEqual({
    done: false,
    value: frame(2, 'two'),
  })
  expect(await stalled[Symbol.asyncIterator]().next()).toEqual({
    done: false,
    value: frame(3, 'three'),
  })
  expect(await stalled[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
  expect(limitEvents).toEqual([
    {
      limit: 'events',
      action: 'subscriber_disconnected',
      maxEvents: 2,
      maxBytes: 1024 * 1024,
    },
  ])

  const resumed = buffer.subscribe(3)
  expect(await resumed[Symbol.asyncIterator]().next()).toEqual({
    done: false,
    value: frame(4, 'four'),
  })
  buffer.push(frame(5, 'five'))
  expect(await resumed[Symbol.asyncIterator]().next()).toEqual({
    done: false,
    value: frame(5, 'five'),
  })
})

test('disconnects a stalled subscriber before queued event payloads exceed its byte ceiling', async () => {
  const limitEvents: unknown[] = []
  const buffer = new RingSessionEventBuffer({
    capacity: 100,
    subscriberLimits: { maxEvents: 100, maxBytes: 200 },
    onSubscriberLimit: event => limitEvents.push(event),
  })
  const stalled = buffer.subscribe(0)

  buffer.push(frame(1, 'a'.repeat(80)))
  buffer.push(frame(2, 'b'.repeat(80)))

  expect(await stalled[Symbol.asyncIterator]().next()).toEqual({
    done: false,
    value: frame(1, 'a'.repeat(80)),
  })
  expect(await stalled[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
  expect(limitEvents).toEqual([
    { limit: 'bytes', action: 'subscriber_disconnected', maxEvents: 100, maxBytes: 200 },
  ])
})

test('detaches an overflowed subscriber from the producer before it resumes draining', async () => {
  const buffer = new RingSessionEventBuffer({
    capacity: 100,
    subscriberLimits: { maxEvents: 1, maxBytes: 1024 * 1024 },
  })
  const stalled = buffer.subscribe(0)
  buffer.push(frame(1, 'accepted'))
  buffer.push(frame(2, 'overflow'))

  // Dropping the producer must not clear the queue already accepted by a subscriber that
  // overflow detached. It owns that finite local tail and can drain it before reconnecting.
  buffer.dropSession()

  expect(await stalled[Symbol.asyncIterator]().next()).toEqual({
    done: false,
    value: frame(1, 'accepted'),
  })
  expect(await stalled[Symbol.asyncIterator]().next()).toEqual({ done: true, value: undefined })
})

test('bounds retained replay by the subscriber ceiling because durable truth lives in Convex', async () => {
  const buffer = new RingSessionEventBuffer({
    capacity: 100,
    subscriberLimits: { maxEvents: 2, maxBytes: 1024 * 1024 },
  })
  for (let seq = 1; seq <= 4; seq += 1) buffer.push(frame(seq, `event-${seq}`))

  const replay = buffer.subscribe(0)
  const iterator = replay[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: frame(3, 'event-3') })
  expect(await iterator.next()).toEqual({ done: false, value: frame(4, 'event-4') })
  replay.close()
})

test('replay and live arrivals share one subscriber budget', async () => {
  const limits: unknown[] = []
  const buffer = new RingSessionEventBuffer({
    capacity: 100,
    subscriberLimits: { maxEvents: 2, maxBytes: 1024 * 1024 },
    onSubscriberLimit: event => limits.push(event),
  })
  buffer.push(frame(1, 'replay-1'))
  buffer.push(frame(2, 'replay-2'))
  const subscriber = buffer.subscribe(0)

  buffer.push(frame(3, 'live-overflow'))

  const iterator = subscriber[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: frame(1, 'replay-1') })
  expect(await iterator.next()).toEqual({ done: false, value: frame(2, 'replay-2') })
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
  expect(limits).toEqual([expect.objectContaining({ limit: 'events' })])
})

test('retained replay is bounded by bytes even below its frame-count ceiling', async () => {
  const buffer = new RingSessionEventBuffer({
    capacity: 100,
    retainedMaxBytes: 230,
    subscriberLimits: { maxEvents: 100, maxBytes: 1024 * 1024 },
  })
  buffer.push(frame(1, 'a'.repeat(80)))
  buffer.push(frame(2, 'b'.repeat(80)))

  expect(await buffer.subscribe(0)[Symbol.asyncIterator]().next()).toEqual({
    done: false,
    value: frame(2, 'b'.repeat(80)),
  })
})

test('refuses one oversize frame and detaches a subscriber already waiting', async () => {
  const limits: unknown[] = []
  const buffer = new RingSessionEventBuffer({ onSubscriberLimit: event => limits.push(event) })
  const subscription = buffer.subscribe(0)
  const waiting = subscription[Symbol.asyncIterator]().next()

  buffer.push(frame(1, 'x'.repeat(SESSION_EVENT_MAX_FRAME_BYTES)))

  expect(await waiting).toEqual({ done: true, value: undefined })
  expect(limits).toEqual([
    expect.objectContaining({
      limit: 'frame_bytes',
      maxFrameBytes: SESSION_EVENT_MAX_FRAME_BYTES,
    }),
  ])
})

test('an oversize frame detaches without discarding the subscriber accepted tail', async () => {
  const buffer = new RingSessionEventBuffer()
  buffer.push(frame(1, 'accepted-replay'))
  const subscriber = buffer.subscribe(0)

  buffer.push(frame(2, 'x'.repeat(SESSION_EVENT_MAX_FRAME_BYTES)))

  const iterator = subscriber[Symbol.asyncIterator]()
  expect(await iterator.next()).toEqual({ done: false, value: frame(1, 'accepted-replay') })
  expect(await iterator.next()).toEqual({ done: true, value: undefined })
})

function frame(seq: number, message: string): LiveFrame {
  const event: AgentTurnEvent = { type: 'system', level: 'info', message }
  return { seq, event }
}
