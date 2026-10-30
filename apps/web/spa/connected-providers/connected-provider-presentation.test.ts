import { expect, test } from 'bun:test'

import { projectConnectedProviderRows } from './connected-provider-presentation'

test('projects pending and awaiting-code poll results into provider row values', () => {
  const connectSession = {
    provider: 'openai-codex' as const,
    sessionId: 'session-1',
    intervalMs: 1_000,
  }

  expect(
    projectConnectedProviderRows({ listed: [], connectSession, poll: { status: 'pending' } })[0],
  ).toEqual({ provider: 'openai-codex', state: 'connecting' })

  expect(
    projectConnectedProviderRows({
      listed: [],
      connectSession,
      poll: {
        status: 'awaiting_code',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://provider.example.test/device',
        expiresAt: 10_000,
      },
    })[0],
  ).toEqual({
    provider: 'openai-codex',
    state: 'awaiting_code',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://provider.example.test/device',
  })
})
