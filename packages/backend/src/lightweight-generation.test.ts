import { afterEach, expect, spyOn, test } from 'bun:test'

import { generateSessionTitle } from '../convex/domains/agentSessions/titleGeneration'
import { SESSION_TITLE_MODEL } from '../convex/domains/agentSessions/titles'
import { recommend } from '../convex/domains/onboarding/recommend'
import { RECOMMENDATIONS_MODEL } from '../convex/domains/onboarding/recommendationsCore'

const originalInternalKey = process.env.DUET_API_INTERNAL_KEY
const originalKey = process.env.AI_GATEWAY_API_KEY
let restoreFetch: (() => void) | undefined
afterEach(() => {
  restoreFetch?.()
  if (originalInternalKey === undefined) delete process.env.DUET_API_INTERNAL_KEY
  else process.env.DUET_API_INTERNAL_KEY = originalInternalKey
  if (originalKey === undefined) delete process.env.AI_GATEWAY_API_KEY
  else process.env.AI_GATEWAY_API_KEY = originalKey
})

test('session titles dispatch the configured model and consume the returned title without sampling overrides', async () => {
  process.env.AI_GATEWAY_API_KEY = 'fixture'
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = []
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
        return Response.json({
          content: [{ type: 'text', text: 'Release diagnosis' }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 2 } },
          warnings: [],
        })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  restoreFetch = () => fetchMock.mockRestore()
  const mutations: unknown[] = []
  const action = generateSessionTitle as unknown as {
    _handler(
      ctx: { runMutation: (...args: unknown[]) => Promise<void> },
      args: Record<string, string>,
    ): Promise<null>
  }
  await action._handler(
    {
      runMutation: async (_ref, args) => {
        mutations.push(args)
      },
    },
    {
      workspaceId: 'workspace',
      sessionId: 'session',
      prompt: 'Diagnose this release',
      attemptId: 'attempt',
    },
  )
  expect(mutations).toEqual([
    {
      workspaceId: 'workspace',
      sessionId: 'session',
      attemptId: 'attempt',
      title: 'Release diagnosis',
    },
  ])
  expect(requests).toHaveLength(1)
  expect(requests[0]!.headers.get('ai-language-model-id')).toBe(SESSION_TITLE_MODEL)
  expect(requests[0]!.body.temperature).toBeUndefined()
})

test('onboarding dispatches the configured model without sampling overrides and consumes four valid picks', async () => {
  process.env.AI_GATEWAY_API_KEY = 'fixture'
  process.env.DUET_API_INTERNAL_KEY = 'fixture-internal'
  const picks = ['writer', 'researcher', 'designer', 'bookkeeper'].map(agentName => ({
    agentName,
    reason: `You need ${agentName}.`,
  }))
  const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = []
  const fetchMock = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) })
        return Response.json({
          content: [{ type: 'text', text: JSON.stringify({ recommendations: picks }) }],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: { inputTokens: { total: 10 }, outputTokens: { total: 20 } },
          warnings: [],
        })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  restoreFetch = () => fetchMock.mockRestore()
  const action = recommend as unknown as {
    _handler(
      ctx: { runQuery: () => Promise<unknown> },
      args: { internalKey: string; purpose: string },
    ): Promise<unknown>
  }
  const result = await action._handler(
    {
      runQuery: async () => ({
        listings: picks.map(({ agentName }) => ({
          id: `listing-${agentName}`,
          publisherSlug: 'duet',
          verifiedPublisher: true,
          agentName,
          title: agentName,
          summary: `Helps with ${agentName}`,
          skills: [],
          installs: 1,
          availability: 'available',
        })),
      }),
    },
    { internalKey: 'fixture-internal', purpose: 'Help me run my business' },
  )
  expect(result).toEqual({ recommendations: picks })
  expect(requests).toHaveLength(1)
  expect(requests[0]!.headers.get('ai-language-model-id')).toBe(RECOMMENDATIONS_MODEL)
  expect(requests[0]!.body.temperature).toBeUndefined()
})
