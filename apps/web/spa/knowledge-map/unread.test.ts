import { expect, test } from 'bun:test'

import { AVATAR_RADIUS, AVATAR_SIZE, CORE_AVATAR_SIZE, unreadDotOffset } from './metrics'
import type { Agent, AppItem, Job, MapNode } from './types'
import { hasUnread } from './unread'

const job = (state: Job['state']): Job => ({
  id: state,
  unread: false,
  title: 't',
  when: 'now',
  state,
})

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: 'a_1',
  name: 'Ops',
  avatarKey: 'ops',
  jobs: [],
  apps: [],
  ...over,
})

const at = { x: 0, y: 0 }
const app: AppItem = { id: 'app_1', title: 'Sheets', state: 'connected', when: 'now' }

const face = (a: Agent): MapNode => ({ id: 'a_1', kind: 'agent', pos: at, data: a })
const seat = (a: Agent): MapNode => ({
  id: 'a_1-jobs',
  kind: 'jobs',
  pos: at,
  agent: a,
  room: 100,
  deg: 0,
  along: 0,
})

/* ---------------------------------------------------------------- the rule

   One mark, on a face, for that owner's own conversation. Asserted for every
   node kind at once, because the failure this guards against is one surface
   quietly deciding the mark means something else. */

test('a face wears the mark when its own chat is unread', () => {
  expect(hasUnread(face(agent({ chat: [{ ...job('done'), unread: true }] })))).toBe(true)
})

test('a chat that has been read wears nothing', () => {
  expect(hasUnread(face(agent({ chat: [job('done')] })))).toBe(false)
})

test('an owner with no chat yet wears nothing', () => {
  // Absent is the ordinary state of an owner nobody has written to — its pointer
  // names nothing — and it must read as nothing to say, not as zero of something.
  expect(hasUnread(face(agent()))).toBe(false)
})

/* The load-bearing one. The face answers for the conversation and the seat
   beside it answers for the work, and the work must never reach the face —
   that separation is the whole reason the chat is a field of its own. */
test('unread work never reaches the face', () => {
  const busy = agent({
    chat: [job('done')],
    jobs: [
      { ...job('running'), unread: true },
      { ...job('done'), unread: true },
    ],
  })
  expect(hasUnread(face(busy))).toBe(false)
})

test('the centre is an owner like any face', () => {
  const core: MapNode = {
    id: 'core',
    kind: 'core',
    pos: at,
    data: { label: 'Duet', meta: '' },
    agent: agent({ chat: [{ ...job('done'), unread: true }] }),
  }
  expect(hasUnread(core)).toBe(true)
})

/* The seat is a door and nothing else. It used to carry both a state roll-up
   and an unread count; a reader who sees a mark on it again should find this
   test in their way. */
test('the Jobs seat wears nothing, however loud its work is', () => {
  const loud = agent({
    chat: [{ ...job('done'), unread: true }],
    jobs: [
      { ...job('asking'), unread: true },
      { ...job('running'), unread: true },
    ],
  })
  expect(hasUnread(seat(loud))).toBe(false)
})

test('nothing that is not a face wears the mark', () => {
  const a = agent({ chat: [{ ...job('running'), unread: true }] })
  const nodes: MapNode[] = [
    { id: 'app', kind: 'app', pos: at, agent: a, data: app, room: 100 },
    {
      id: 'bead',
      kind: 'job',
      pos: at,
      agent: a,
      room: 100,
      data: { ...job('running'), unread: true },
    },
    { id: 'more', kind: 'more', pos: at, agent: a, parent: 'a_1', count: 2, room: 100 },
    { id: 'add', kind: 'add', pos: at, count: 0 },
  ]
  for (const node of nodes) expect(hasUnread(node)).toBe(false)
})

/* ============================================================ where it sits

   The mark's *position* belongs to this axis as much as its meaning does, and
   it is the half that drifted. Both draw sites hand-tuned an inset against
   their own plate — 26 on an agent's 68, 28 on Duet's 76 — which put the two
   dots at 0.765 and 0.737 of their half-size. Neither is the plate's own
   corner, and because they are wrong by *different* amounts the agent's dot
   straddled the edge while Duet's was very nearly swallowed by it.

   So the rule is geometric now, and these pin it against the corner computed
   independently here: a plate is a rounded square, so its 45° edge is a point
   on the corner arc, not on a circle. Deriving it twice — once in the product,
   once here from the shape's own definition — is what makes this a test rather
   than a restatement of the constant. */

/** The 45° point on a rounded square's corner, from the shape's definition. */
function cornerEdge(size: number): number {
  const half = size / 2
  const corner = size * AVATAR_RADIUS
  /* The arc's centre sits `corner` in from each side; the 45° point on it is
     `corner / √2` back out along the diagonal. */
  return half - corner + corner * Math.SQRT1_2
}

test.each([
  ['an agent face', AVATAR_SIZE],
  ['Duet at the centre', CORE_AVATAR_SIZE],
])('the dot sits on the corner of %s', (_name, size) => {
  expect(unreadDotOffset(size)).toBeCloseTo(cornerEdge(size), 6)
})

/* The guarantee the caller cannot get wrong: the same fraction at every size,
   so half the disc is on the plate and half on the ground whatever the plate
   is. A face drawn at some size nobody has used yet lands correctly for free. */
test('the rule is scale-invariant, so a new plate size needs no new constant', () => {
  const sizes = [24, 40, 68, 76, 120, 512]
  const ratios = sizes.map(size => unreadDotOffset(size) / size)
  for (const ratio of ratios) expect(ratio).toBeCloseTo(ratios[0]!, 12)
  for (const size of sizes) expect(unreadDotOffset(size)).toBeCloseTo(cornerEdge(size), 6)
})

/* The old constants were *inside* the corner, which is why the dot read as
   buried rather than as sitting on the edge. Pinned so a well-meaning revert
   to a round number is visible as a regression rather than as a tidy-up. */
test('the corner is further out than the hand-tuned insets ever were', () => {
  expect(unreadDotOffset(AVATAR_SIZE)).toBeGreaterThan(26)
  expect(unreadDotOffset(CORE_AVATAR_SIZE)).toBeGreaterThan(28)
})
