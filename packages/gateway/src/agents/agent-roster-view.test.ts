import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GatewayAgentConfig } from '@repo/contract'

import { readReachableAgentRoster } from './agent-roster-view'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function driveWith(agentJson: Record<string, string> = {}): string {
  const driveDir = mkdtempSync(join(tmpdir(), 'duet-roster-view-'))
  roots.push(driveDir)
  for (const [anchorPath, contents] of Object.entries(agentJson)) {
    mkdirSync(join(driveDir, anchorPath), { recursive: true })
    writeFileSync(join(driveDir, anchorPath, 'agent.json'), contents)
  }
  return driveDir
}

const ROOT: GatewayAgentConfig = { kind: 'root', slug: 'root', name: 'HQ' }

function agent(
  slug: string,
  anchorPath: string,
  overrides: Partial<Extract<GatewayAgentConfig, { kind: 'agent' }>> = {},
): GatewayAgentConfig {
  return {
    kind: 'agent',
    agentId: `${slug}-agent`,
    anchorId: `${slug}-anchor`,
    anchorPath,
    slug,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    ...overrides,
  }
}

const WRITER = agent('writer', 'agents/writer')
const DRAFTER = agent('drafter', 'agents/writer/drafter')
const GRANDCHILD = agent('typist', 'agents/writer/drafter/typist')

/* The sibling branch a nested agent never exercises: a top-level agent's parent
   is the SYNTHETIC root member, which carries no agentId and no entry in the
   hierarchy's children map, so its siblings can only come from the agents no
   agent encloses — minus itself. Order is the structural one, self first. */
test("a top-level agent's siblings are the other agents no agent encloses", () => {
  const roster = readReachableAgentRoster({
    members: [ROOT, WRITER, agent('editor', 'agents/editor'), DRAFTER],
    scope: { kind: 'agent', agentId: 'writer-agent' },
    driveDir: driveWith(),
  })

  expect(roster?.rows).toEqual([
    {
      slug: 'writer',
      name: 'Writer',
      anchorPath: 'agents/writer',
      locked: false,
      relationship: 'self',
    },
    { slug: 'root', name: 'HQ', locked: false, relationship: 'parent' },
    {
      slug: 'editor',
      name: 'Editor',
      anchorPath: 'agents/editor',
      locked: false,
      relationship: 'sibling',
    },
    {
      slug: 'drafter',
      name: 'Drafter',
      anchorPath: 'agents/writer/drafter',
      locked: false,
      relationship: 'child',
    },
  ])
})

/* The other sibling branch: an enclosed agent's peers come from its parent's
   child list, and a grandchild of that parent is not one of them. */
test("a nested agent's siblings are its parent's other children, never a level further down", () => {
  const editor = agent('editor', 'agents/writer/editor')
  const roster = readReachableAgentRoster({
    members: [ROOT, WRITER, DRAFTER, editor, GRANDCHILD],
    scope: { kind: 'agent', agentId: 'drafter-agent' },
    driveDir: driveWith(),
  })

  expect(roster?.rows.map(row => [row.relationship, row.slug])).toEqual([
    ['self', 'drafter'],
    ['parent', 'writer'],
    ['sibling', 'editor'],
    ['child', 'typist'],
  ])
})

test('an agent reaches its parent and its direct children, never itself or a grandchild', () => {
  const roster = readReachableAgentRoster({
    members: [ROOT, WRITER, DRAFTER, GRANDCHILD],
    scope: { kind: 'agent', agentId: 'writer-agent' },
    driveDir: driveWith(),
  })

  expect(roster).toEqual({
    rows: [
      {
        slug: 'writer',
        name: 'Writer',
        anchorPath: 'agents/writer',
        locked: false,
        relationship: 'self',
      },
      { slug: 'root', name: 'HQ', locked: false, relationship: 'parent' },
      {
        slug: 'drafter',
        name: 'Drafter',
        anchorPath: 'agents/writer/drafter',
        locked: false,
        relationship: 'child',
      },
    ],
  })
})

test('the drive root is its own self row, wearing the workspace name and no folder', () => {
  const roster = readReachableAgentRoster({
    members: [ROOT, WRITER],
    scope: { kind: 'root' },
    driveDir: driveWith(),
  })

  expect(roster?.rows[0]).toEqual({ slug: 'root', name: 'HQ', locked: false, relationship: 'self' })
})

test('root answers to nobody and sees only the agents no agent encloses', () => {
  const roster = readReachableAgentRoster({
    members: [ROOT, WRITER, DRAFTER],
    scope: { kind: 'root' },
    driveDir: driveWith(),
  })

  expect(roster?.rows.map(row => [row.relationship, row.slug])).toEqual([
    ['self', 'root'],
    ['child', 'writer'],
  ])
})

/* The three-part verdict, exercised through the projection rather than
   restated: a declared onboarding with no completion stamp is the only
   combination that reads as locked. Everything else — no agent.json, or one
   nothing can parse — reads as unlocked. */
test('a child awaiting its declared onboarding is flagged; an unreadable config is not', () => {
  const driveDir = driveWith({
    'agents/writer/drafter': JSON.stringify({ onboarding: { kind: 'chat' } }),
    'agents/writer/typist': '{ not json at all',
  })
  const typist = agent('typist', 'agents/writer/typist')
  const roster = readReachableAgentRoster({
    members: [ROOT, WRITER, DRAFTER, typist],
    scope: { kind: 'agent', agentId: 'writer-agent' },
    driveDir,
  })

  expect(
    roster?.rows.filter(row => row.relationship === 'child').map(row => [row.slug, row.locked]),
  ).toEqual([
    ['drafter', true],
    // Malformed config fails open: an unreadable agent.json must never strand a
    // user behind a lock they cannot open.
    ['typist', false],
  ])
})

/* A locked peer is listed and flagged exactly like a locked child. The verdict
   is the agent's own, not a property of how you are related to it. */
test('a sibling awaiting onboarding is flagged, not hidden', () => {
  const driveDir = driveWith({ 'agents/editor': JSON.stringify({ onboarding: { kind: 'chat' } }) })
  const roster = readReachableAgentRoster({
    members: [ROOT, WRITER, agent('editor', 'agents/editor')],
    scope: { kind: 'agent', agentId: 'writer-agent' },
    driveDir,
  })

  expect(roster?.rows.filter(row => row.relationship === 'sibling')).toEqual([
    {
      slug: 'editor',
      name: 'Editor',
      anchorPath: 'agents/editor',
      locked: true,
      relationship: 'sibling',
    },
  ])
})

/* The lock verdict is drive content, so it is read under containment: a
   symlink inside the drive can point at gateway state outside it, and the same
   escape that would leak a secret here decides whether a user is locked out. */
test('an agent.json symlinked outside the drive is not read', () => {
  const onboarding = JSON.stringify({ onboarding: { kind: 'chat' } })
  const outside = mkdtempSync(join(tmpdir(), 'duet-roster-view-outside-'))
  roots.push(outside)
  writeFileSync(join(outside, 'agent.json'), onboarding)

  const contained = driveWith({ 'agents/writer/drafter': onboarding })
  const escaped = driveWith()
  mkdirSync(join(escaped, 'agents/writer/drafter'), { recursive: true })
  symlinkSync(join(outside, 'agent.json'), join(escaped, 'agents/writer/drafter/agent.json'))

  const lockedIn = (driveDir: string) =>
    readReachableAgentRoster({
      members: [ROOT, WRITER, DRAFTER],
      scope: { kind: 'agent', agentId: 'writer-agent' },
      driveDir,
    })?.rows.find(row => row.slug === 'drafter')?.locked

  expect(lockedIn(contained)).toBe(true)
  expect(lockedIn(escaped)).toBe(false)
})

/* Slug order, not folder order and not arrival order. The paths run opposite to
   the slugs on purpose: the hierarchy helper hands back its own rootPath order,
   so a projection that simply forwarded it would look sorted in any fixture
   where the two agree. Order is within a group, never across one — a sibling
   sorting ahead of the parent would put the policy's words out of order. */
test('each group comes back in slug order whatever order the roster arrived in', () => {
  const members = [
    ROOT,
    WRITER,
    agent('zebra', 'agents/aaa'),
    agent('alpha', 'agents/zzz'),
    agent('yak', 'agents/writer/aaa'),
    agent('beta', 'agents/writer/zzz'),
  ]
  const read = (order: readonly GatewayAgentConfig[]) =>
    readReachableAgentRoster({
      members: order,
      scope: { kind: 'agent', agentId: 'writer-agent' },
      driveDir: driveWith(),
    })?.rows.map(row => `${row.relationship}:${row.slug}`)

  const expected = [
    'self:writer',
    'parent:root',
    'sibling:alpha',
    'sibling:zebra',
    'child:beta',
    'child:yak',
  ]
  expect(read(members)).toEqual(expected)
  expect(read([...members].reverse())).toEqual(expected)
})

/* There is no cap. The workspace ceiling bounds the roster at its source, and a
   cap here could only drop colleagues from a list with no field left to say it
   had — which is exactly what the picker used to do, silently. */
test('lists every child beyond the former thirty-row truncation', () => {
  const children = Array.from({ length: 40 }, (_, index) => {
    const slug = `child-${String(index).padStart(2, '0')}`
    return agent(slug, `agents/writer/${slug}`)
  })
  const roster = readReachableAgentRoster({
    members: [ROOT, WRITER, ...children],
    scope: { kind: 'agent', agentId: 'writer-agent' },
    driveDir: driveWith(),
  })

  expect(roster?.rows.filter(row => row.relationship === 'child')).toEqual(
    Array.from({ length: 40 }, (_, index) => {
      const slug = `child-${String(index).padStart(2, '0')}`
      return {
        slug,
        name: `Child-${String(index).padStart(2, '0')}`,
        anchorPath: `agents/writer/${slug}`,
        locked: false,
        relationship: 'child',
      }
    }),
  )
})

/* Three answers that must stay distinguishable, because collapsing any pair
   turns "we have not asked yet" or "we do not know that agent" into the
   confident claim that a workspace is empty. */
test('no roster and an unknown agent yield no projection; a known-empty roster is empty', () => {
  expect(
    readReachableAgentRoster({
      members: undefined,
      scope: { kind: 'root' },
      driveDir: driveWith(),
    }),
  ).toBeUndefined()

  expect(
    readReachableAgentRoster({
      members: [ROOT, WRITER],
      scope: { kind: 'agent', agentId: 'ghost-agent' },
      driveDir: driveWith(),
    }),
  ).toBeUndefined()

  expect(
    readReachableAgentRoster({ members: [], scope: { kind: 'root' }, driveDir: driveWith() }),
  ).toEqual({
    // An empty roster still knows which agent is asking: the drive root, wearing
    // the workspace's own name.
    rows: [{ slug: 'root', name: 'Duet', locked: false, relationship: 'self' }],
  })
})

/* A roster with agents but no root member: the gateway has no workspace name to
   put above the agent, and inventing one is how a session learns to report to
   an agent that does not exist. */
test('an agent whose roster carries no root row gets no parent rather than a guess', () => {
  const roster = readReachableAgentRoster({
    members: [WRITER, DRAFTER, agent('editor', 'agents/editor')],
    scope: { kind: 'agent', agentId: 'writer-agent' },
    driveDir: driveWith(),
  })

  // No parent to name, but the peers it shares that missing parent with are
  // still peers.
  expect(roster?.rows.map(row => `${row.relationship}:${row.slug}`)).toEqual([
    'self:writer',
    'sibling:editor',
    'child:drafter',
  ])
})

test('an onboarded child is no longer flagged', () => {
  const driveDir = driveWith({
    'agents/writer/drafter': JSON.stringify({ onboarding: { kind: 'chat' } }),
  })
  const roster = readReachableAgentRoster({
    members: [ROOT, WRITER, agent('drafter', 'agents/writer/drafter', { onboardedAt: 1 })],
    scope: { kind: 'agent', agentId: 'writer-agent' },
    driveDir,
  })

  expect(roster?.rows.find(row => row.slug === 'drafter')?.locked).toBe(false)
})
