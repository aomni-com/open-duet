import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { SessionInitialHistorySnapshotSchema } from '@repo/contract'

import {
  hasWorkbenchTurnEvidence,
  INTEGRATION_AGENT_ACCESS_ALL_LABEL,
  runIntegrationAgentAccessJourney,
} from './staging-live-integration-agent-access.ts'

const originalComposioApiKey = process.env.COMPOSIO_API_KEY

describe('integration agent access staging journey', () => {
  beforeEach(() => {
    delete process.env.COMPOSIO_API_KEY
  })

  afterEach(() => {
    if (originalComposioApiKey === undefined) delete process.env.COMPOSIO_API_KEY
    else process.env.COMPOSIO_API_KEY = originalComposioApiKey
  })

  test('fails a focused run loudly when its provider credential is unavailable', async () => {
    await expect(runIntegrationAgentAccessJourney()).rejects.toThrow(
      'integration-agent-access journey requires COMPOSIO_API_KEY',
    )
  })

  test('targets the shipped accessible label for the All-agents policy control', async () => {
    const messages = (await Bun.file(
      new URL('../../../apps/web/messages/en/app.json', import.meta.url),
    ).json()) as { duetIntegrations: { agentAccess: { all: string } } }

    expect(INTEGRATION_AGENT_ACCESS_ALL_LABEL).toBe(messages.duetIntegrations.agentAccess.all)
  })

  test('requires a fresh successful workbench call whose output carries the sentinel', () => {
    const sentinel = 'duet-access-run-123'
    const history = SessionInitialHistorySnapshotSchema.parse({
      events: [
        workbenchStep(3, 'integrations__COMPOSIO_REMOTE_WORKBENCH', false, sentinel),
        workbenchStep(6, 'integrations__COMPOSIO_REMOTE_WORKBENCH', true, sentinel),
        workbenchStep(7, 'another_tool', false, sentinel),
        workbenchStep(8, 'integrations__COMPOSIO_REMOTE_WORKBENCH', false, sentinel),
      ],
    })

    expect(hasWorkbenchTurnEvidence(history, 5, sentinel)).toBe(true)
    expect(hasWorkbenchTurnEvidence(history, 8, sentinel)).toBe(false)
    expect(hasWorkbenchTurnEvidence(history, 5, 'different-sentinel')).toBe(false)
    const unsuccessful = SessionInitialHistorySnapshotSchema.parse({
      events: [
        workbenchStep(3, 'integrations__COMPOSIO_REMOTE_WORKBENCH', false, sentinel),
        workbenchStep(6, 'integrations__COMPOSIO_REMOTE_WORKBENCH', true, sentinel),
        workbenchStep(7, 'another_tool', false, sentinel),
      ],
    })
    expect(hasWorkbenchTurnEvidence(unsuccessful, 5, sentinel)).toBe(false)
  })
})

function workbenchStep(seq: number, toolName: string, isError: boolean, output: string) {
  return {
    seq,
    createdAt: seq,
    event: {
      type: 'step',
      step: {
        type: 'tool_call',
        toolName,
        toolCallId: `call-${seq}`,
        isError,
        output: [{ type: 'text', text: output }],
      },
    },
  }
}
