import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Hono } from 'hono'

import type { GatewayAgentConfig } from '@repo/contract'

import { createAgentRosterRoutes } from './agent-roster'

const roots: string[] = []
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function driveWith(agentJson: Record<string, string> = {}): string {
  const driveDir = mkdtempSync(join(tmpdir(), 'duet-roster-route-'))
  roots.push(driveDir)
  for (const [anchorPath, contents] of Object.entries(agentJson)) {
    mkdirSync(join(driveDir, anchorPath), { recursive: true })
    writeFileSync(join(driveDir, anchorPath, 'agent.json'), contents)
  }
  return driveDir
}

function agent(slug: string, anchorPath: string, onboardedAt?: number): GatewayAgentConfig {
  return {
    kind: 'agent',
    agentId: `${slug}-agent`,
    anchorId: `${slug}-anchor`,
    anchorPath,
    slug,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    ...(onboardedAt === undefined ? {} : { onboardedAt }),
  }
}

const ROOT: GatewayAgentConfig = { kind: 'root', slug: 'root', name: 'HQ' }
const WRITER = agent('writer', 'agents/writer')
const DRAFTER = agent('drafter', 'agents/writer/drafter')

function mountApp(input: {
  agents: readonly GatewayAgentConfig[] | undefined
  driveDir?: string
  refresh?: () => Promise<readonly GatewayAgentConfig[]>
}): Hono {
  const app = new Hono()
  app.route(
    '/v1/agents/roster',
    createAgentRosterRoutes({
      agents: () => input.agents,
      refresh: async () => {
        if (input.refresh) input.agents = await input.refresh()
      },
      driveDir: input.driveDir ?? driveWith(),
    }),
  )
  return app
}

test('completion and reset refresh the reachable roster without waiting for a scheduled poll', async () => {
  let current = [ROOT, WRITER]
  const app = mountApp({
    agents: current,
    refresh: async () => current,
    driveDir: driveWith({ 'agents/writer': '{"onboarding":{"kind":"chat"}}' }),
  })
  const locked = async () =>
    (await (await app.request('/v1/agents/roster')).json()).rows.find(
      (row: { slug: string }) => row.slug === 'writer',
    ).locked
  expect(await locked()).toBe(true)
  for (const onboardedAt of [123, undefined]) {
    current = [ROOT, agent('writer', 'agents/writer', onboardedAt)]
    const response = await app.request('/v1/agents/roster/refresh', { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await locked()).toBe(onboardedAt === undefined)
  }
})

test('the drive root sees the agents no agent encloses and answers to nobody', async () => {
  const app = mountApp({ agents: [ROOT, WRITER, DRAFTER] })

  const response = await app.request('/v1/agents/roster')

  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({
    rows: [
      { slug: 'root', name: 'HQ', locked: false, relationship: 'self' },
      {
        slug: 'writer',
        name: 'Writer',
        path: 'agents/writer',
        locked: false,
        relationship: 'child',
      },
    ],
  })
})

test('a nested agent sees its parent, its peers and its own children, itself first', async () => {
  const app = mountApp({ agents: [ROOT, WRITER, DRAFTER, agent('editor', 'agents/editor')] })

  const response = await app.request('/v1/agents/roster?agentId=writer-agent')

  expect(response.status).toBe(200)
  // Root is the parent of an agent no agent encloses, and it rides the wire
  // without a folder — the one row that may omit `path`.
  expect(await response.json()).toEqual({
    rows: [
      // The session's own agent leads, so a composer can name it.
      {
        slug: 'writer',
        name: 'Writer',
        path: 'agents/writer',
        locked: false,
        relationship: 'self',
      },
      { slug: 'root', name: 'HQ', locked: false, relationship: 'parent' },
      {
        slug: 'editor',
        name: 'Editor',
        path: 'agents/editor',
        locked: false,
        relationship: 'sibling',
      },
      {
        slug: 'drafter',
        name: 'Drafter',
        path: 'agents/writer/drafter',
        locked: false,
        relationship: 'child',
      },
    ],
  })
})

/* The route serializes the projection and nothing else: it neither sorts nor
   drops nor re-derives the lock verdict, so the wire must show the projection's
   own order and its flags — every row of it. */
test('rows arrive flagged and ordered exactly as projected, none dropped', async () => {
  const children = Array.from({ length: 40 }, (_, index) => {
    const slug = `child-${String(index).padStart(2, '0')}`
    return agent(slug, `agents/writer/${slug}`)
  })
  const app = mountApp({
    agents: [ROOT, WRITER, ...children],
    driveDir: driveWith({
      'agents/writer/child-00': JSON.stringify({ onboarding: { kind: 'chat' } }),
    }),
  })

  const response = await app.request('/v1/agents/roster?agentId=writer-agent')
  const body = (await response.json()) as {
    rows: { slug: string; locked: boolean; relationship: string }[]
  }

  expect(body.rows.filter(row => row.relationship === 'child').map(row => row.slug)).toEqual(
    children.map(child => child.slug),
  )
  expect(body.rows.filter(row => row.locked).map(row => row.slug)).toEqual(['child-00'])
})

/* The three answers the picker must keep apart. A workspace with no agents is
   a real answer; a gateway that has never synced is not, and an agent this
   roster does not carry is a miss rather than an emptiness. */
test('a known-empty roster is 200 empty, an unsynced gateway 503, an unknown agent 404', async () => {
  const empty = await mountApp({ agents: [ROOT] }).request('/v1/agents/roster')
  expect(empty.status).toBe(200)
  expect(await empty.json()).toEqual({
    rows: [{ slug: 'root', name: 'HQ', locked: false, relationship: 'self' }],
  })

  const unsynced = await mountApp({ agents: undefined }).request('/v1/agents/roster')
  expect(unsynced.status).toBe(503)
  expect(await unsynced.json()).toEqual({ error: 'roster_unavailable' })

  const unknown = await mountApp({ agents: [ROOT, WRITER] }).request(
    '/v1/agents/roster?agentId=ghost-agent',
  )
  expect(unknown.status).toBe(404)
})
