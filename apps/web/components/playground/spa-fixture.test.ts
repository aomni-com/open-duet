/* ============================================================================
   The fixture's default chat is a pointer, not a guess.

   It used to be derived — "the first session whose agent matches" — which reads
   correctly right up until something clears it. An owner with no default chat
   is not an exotic state: it is what every owner starts in, and it is what
   archiving puts one back into. A fixture that cannot represent it is a fixture
   the archive flow can never be photographed against, and the playground would
   answer with *more* than production does, which is the kind of fixture that
   cannot fail.

   Three readers share the one pointer, so all three are asserted here: the
   alias resolves it, the jobs list withholds it, and the setter moves it.
   ========================================================================= */
import { expect, test } from 'bun:test'

import type { RefObject } from 'react'

import { ROOT_AGENT_SCOPE, type WhoamiResponse } from '@repo/contract'

import type { SpaApi } from '../../spa/context'
import { createFixtureApi, createSessionStore, IDENTITY } from './spa-fixture'

function fixture(): {
  api: SpaApi
  store: RefObject<ReturnType<typeof createSessionStore>>
  memberRequests: unknown[]
} {
  const store = { current: createSessionStore() }
  const memberRequests: unknown[] = []
  const api = createFixtureApi(
    { current: IDENTITY as unknown as WhoamiResponse },
    store,
    { current: [] },
    {
      current: [
        { id: 'user_ada', email: 'ada@example.com', role: 'owner', isBillingUser: true },
        { id: 'user_grace', email: 'grace@example.com', role: 'editor', isBillingUser: false },
        { id: 'user_linus', email: 'linus@example.com', role: 'viewer', isBillingUser: false },
      ],
    },
    {
      current: {
        id: 'user_owner',
        email: 'owner@duet.so',
        firstName: 'Ada',
        lastName: 'Lovelace',
        name: 'Ada Lovelace',
      },
    },
    { current: [] },
    { current: [] },
    { current: [] },
    () => {},
    () => {},
    () => {},
    request => memberRequests.push(request),
  )
  return { api, store, memberRequests }
}

test('the playground member fake records normalized two-page searches', async () => {
  const { api, memberRequests } = fixture()
  const first = await api.listWorkspaceMembers('acme', { search: 'GRACE', limit: 20 })
  expect(first).toEqual({
    items: [{ id: 'user_grace', email: 'grace@example.com', role: 'editor', isBillingUser: false }],
    nextCursor: null,
  })
  expect(memberRequests).toEqual([{ search: 'GRACE', limit: 20 }])

  const pageOne = await api.listWorkspaceMembers('acme', { limit: 20 })
  const pageTwo = await api.listWorkspaceMembers('acme', {
    cursor: pageOne.nextCursor ?? undefined,
    limit: 20,
  })
  expect(pageOne.items.map(member => member.id)).toEqual(['user_ada', 'user_grace'])
  expect(pageTwo.items.map(member => member.id)).toEqual(['user_linus'])
})

/** The ids the jobs dialog would list for one owner. */
async function jobsFor(api: SpaApi, agentId: string): Promise<string[]> {
  const page = await api.listSessions('acme', { agentId, excludeDefault: true })
  return page.items.map(session => session.id)
}

test('the drive root opens on its own chat, and the jobs list withholds exactly that row', async () => {
  const { api } = fixture()
  const chat = await api.getDefaultSession('acme', ROOT_AGENT_SCOPE)
  expect(chat?.id).toBe('session_root_chat')
  const jobs = await jobsFor(api, ROOT_AGENT_SCOPE)
  expect(jobs).not.toContain('session_root_chat')
  /* And the row the scenes deep-link *is* work, so the playground can tell a
     job in the dialog from the conversation that has a panel of its own. */
  expect(jobs).toContain('session_live')
})

test('clearing the pointer empties the panel and hands the conversation to Jobs', async () => {
  const { api } = fixture()

  expect(await api.setDefaultSession('acme', ROOT_AGENT_SCOPE, null)).toBeNull()

  // The panel's read, which is what draws the day-one empty state.
  expect(await api.getDefaultSession('acme', ROOT_AGENT_SCOPE)).toBeNull()
  // And the same conversation, whole, in the list that used to withhold it.
  expect(await jobsFor(api, ROOT_AGENT_SCOPE)).toContain('session_root_chat')
})

/* The other direction, which is what makes archiving reversible in practice:
   the next message mints a chat and the same request stamps the pointer at it,
   exactly as delivery does. */
test('an owner with no chat gets one from its next message, pointer and all', async () => {
  const { api } = fixture()
  expect(await api.getDefaultSession('acme', 'research')).toBeNull()

  const sent = await api.sendDefaultSessionMessage('acme', 'research', {
    prompt: 'Summarise the competitor briefing',
    tier: 'balanced',
    behavior: 'steer',
  })
  const minted = 'session' in sent ? sent.session.sessionId : sent.sessionId

  expect((await api.getDefaultSession('acme', 'research'))?.id).toBe(minted)
  expect(await jobsFor(api, 'agent_research')).not.toContain(minted)

  // And archiving that one hands it over in turn.
  await api.setDefaultSession('acme', 'research', null)
  expect(await api.getDefaultSession('acme', 'research')).toBeNull()
  expect(await jobsFor(api, 'agent_research')).toContain(minted)
})
