import { expect, test } from 'bun:test'

import { QueryClient, QueryObserver } from '@tanstack/react-query'

import { agentOnboardingSessionQueryOptions } from './agent-onboarding-session'

/* The endpoint behind this query CREATES on first call, so the only thing
   standing between "the surface opens the setup by being looked at" and "every
   glance mints a conversation" is that it is asked for exactly once per agent.
   These pin that, at the query layer where the deduplication actually lives. */

function harness() {
  let calls = 0
  const api = {
    openAgentOnboardingSession: async () => {
      calls += 1
      return { sessionId: 'session_setup' }
    },
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return { api, client, calls: () => calls }
}

test('two surfaces looking at one agent open one conversation between them', async () => {
  const { api, client, calls } = harness()
  const options = agentOnboardingSessionQueryOptions(api, 'acme', {
    id: 'agent_r1',
    slug: 'research',
  })

  const [first, second] = await Promise.all([
    client.fetchQuery(options),
    client.fetchQuery(options),
  ])

  expect(first.sessionId).toBe('session_setup')
  expect(second.sessionId).toBe('session_setup')
  expect(calls()).toBe(1)
})

test('looking again does not open a second one', async () => {
  const { api, client, calls } = harness()
  const options = agentOnboardingSessionQueryOptions(api, 'acme', {
    id: 'agent_r1',
    slug: 'research',
  })
  await client.fetchQuery(options)

  // A remount observes the same key. `staleTime: Infinity` is what makes this a
  // read of a durable row rather than a repeated write.
  const observer = new QueryObserver(client, options)
  const unsubscribe = observer.subscribe(() => {})
  await client.fetchQuery(options)
  unsubscribe()

  expect(calls()).toBe(1)
})

test('two agents get two conversations', async () => {
  const { api, client, calls } = harness()

  await client.fetchQuery(
    agentOnboardingSessionQueryOptions(api, 'acme', { id: 'agent_r1', slug: 'research' }),
  )
  await client.fetchQuery(
    agentOnboardingSessionQueryOptions(api, 'acme', { id: 'agent_v1', slug: 'reviewer' }),
  )

  expect(calls()).toBe(2)
})

test('a reinstalled agent under the same slug gets its own conversation', async () => {
  /* Delete an agent, reinstall it, and the newcomer answers to the same slug --
     but it is a new row with a fresh interview. Keyed by slug, the infinite
     staleTime served the DEAD agent's conversation to its successor: the exact
     broken chat, back from the grave, on an agent that was supposed to be new. */
  const { api, client, calls } = harness()

  await client.fetchQuery(
    agentOnboardingSessionQueryOptions(api, 'acme', { id: 'agent_old', slug: 'brand-designer' }),
  )
  await client.fetchQuery(
    agentOnboardingSessionQueryOptions(api, 'acme', { id: 'agent_new', slug: 'brand-designer' }),
  )

  expect(calls()).toBe(2)
})
