import { expect, test } from 'bun:test'

import type { Agent } from '@repo/contract'
import { ROOT_AGENT_SCOPE } from '@repo/contract'

import { workRouteDestination } from '../team-space/work-destination'
import {
  resolveSessionOwner,
  sessionMapHref,
  sessionOwnerConfigAgent,
  sessionOwnerSlug,
} from './session-owner'

/** Follow a generated session link through Work's route parser. */
function opensInWork(session: {
  id: string
  agent?: { id: string }
  createdBySessionId?: string
}): boolean {
  const href = sessionMapHref('acme', session, AGENTS)
  if (href === undefined) return false
  const [pathname, search] = href.split('?')
  const destination = workRouteDestination(pathname!, 'acme', search ?? '')
  if (destination.kind !== 'session' || destination.sessionId !== session.id) return false
  return true
}

const AGENTS = [
  { id: 'agent_ops', slug: 'ops' },
  { id: 'agent_research', slug: 'research' },
]

test('a session owned by an agent resolves to that agent slug', () => {
  expect(sessionOwnerSlug({ id: 'agent_research' }, AGENTS)).toBe('research')
})

test('a session no agent owns resolves to the root scope without needing the list', () => {
  expect(sessionOwnerSlug(undefined, undefined)).toBe('root')
})

test('an owner the list has not loaded yet stays unresolved', () => {
  expect(sessionOwnerSlug({ id: 'agent_ops' }, undefined)).toBeUndefined()
})

test('an owner the list no longer holds stays unresolved rather than guessed', () => {
  expect(sessionOwnerSlug({ id: 'agent_gone' }, AGENTS)).toBeUndefined()
})

test('a session link resolves to the conversation in Work, on its own agent', () => {
  expect(
    sessionMapHref('acme', { id: 'session_child_1', agent: { id: 'agent_ops' } }, AGENTS),
  ).toBe('/w/acme/agents/ops/sessions/session_child_1')
})

test('a delegated session link opens the conversation rather than a refusal', () => {
  expect(
    opensInWork({
      id: 'session_job_1',
      agent: { id: 'agent_ops' },
      createdBySessionId: 'session_parent_1',
    }),
  ).toBe(true)
})

test('a top-level session link still opens', () => {
  expect(opensInWork({ id: 'session_top_1', agent: { id: 'agent_ops' } })).toBe(true)
})

test('a root session link resolves through the root scope', () => {
  expect(sessionMapHref('acme', { id: 'session_root_1' }, AGENTS)).toBe(
    '/w/acme/agents/root/sessions/session_root_1',
  )
})

/* An onboarding conversation is excluded from every list by design, so Work
   would truthfully report it missing. The agent's own surface is where a locked
   agent already mounts it. */
test('an onboarding session opens its agent instead', () => {
  expect(
    sessionMapHref(
      'acme',
      { id: 'session_setup_1', agent: { id: 'agent_research' }, onboarding: true },
      AGENTS,
    ),
  ).toBe('/w/acme/agents/research')
})

test('a session whose owner is unresolved yields no address yet', () => {
  expect(
    sessionMapHref('acme', { id: 'session_child_1', agent: { id: 'agent_ops' } }, undefined),
  ).toBeUndefined()
})

function mountAgent(overrides: Partial<Agent> & Pick<Agent, 'slug'>): Agent {
  return {
    id: `agent_${overrides.slug}`,
    workspaceId: 'workspace_acme',
    anchorId: `anchor_${overrides.slug}`,
    anchorPath: `agents/${overrides.slug}`,
    anchorState: 'active',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

const MOUNT_AGENTS = [
  mountAgent({ slug: 'research', name: 'Research' }),
  mountAgent({ slug: 'reviewer', name: 'Reviewer', anchorState: 'broken' }),
  mountAgent({ slug: 'nightly', name: 'Nightly', disabledAt: 1_000 }),
]

test('an absent or root scope mounts the drive root', () => {
  for (const requested of [undefined, null, '', ROOT_AGENT_SCOPE]) {
    expect(resolveSessionOwner(MOUNT_AGENTS, requested)).toEqual({
      status: 'ready',
      owner: { kind: 'root' },
    })
  }
})

test('a launchable agent slug mounts that agent', () => {
  expect(resolveSessionOwner(MOUNT_AGENTS, 'research')).toEqual({
    status: 'ready',
    owner: { kind: 'agent', agent: MOUNT_AGENTS[0]! },
  })
})

test('agent config loading is scoped to the one requested session owner', () => {
  expect(sessionOwnerConfigAgent(resolveSessionOwner(MOUNT_AGENTS, 'research'))).toEqual(
    MOUNT_AGENTS[0]!,
  )
  expect(
    sessionOwnerConfigAgent(resolveSessionOwner(MOUNT_AGENTS, ROOT_AGENT_SCOPE)),
  ).toBeUndefined()
  expect(sessionOwnerConfigAgent(resolveSessionOwner(MOUNT_AGENTS, 'ghost'))).toBeUndefined()
})

test('broken, disabled, locked, and unknown slugs are unavailable — never a silent root fallback', () => {
  expect(resolveSessionOwner(MOUNT_AGENTS, 'reviewer')).toEqual({ status: 'unavailable' })
  expect(resolveSessionOwner(MOUNT_AGENTS, 'nightly')).toEqual({ status: 'unavailable' })
  expect(resolveSessionOwner(MOUNT_AGENTS, 'ghost')).toEqual({ status: 'unavailable' })
  expect(resolveSessionOwner(MOUNT_AGENTS, 'research', new Set(['agent_research']))).toEqual({
    status: 'unavailable',
  })
})
