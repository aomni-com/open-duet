import { describe, expect, test } from 'bun:test'

import { namespacedToolName, SessionInitialHistorySnapshotSchema } from '@repo/contract'

import { hasSuccessfulToolCall, MCP_SERVERS_STAGING_LEGS } from './staging-live-mcp-servers.ts'

describe('custom MCP servers staging journey units', () => {
  test('requires degradation and orders consent before its dependent static-token leg', () => {
    // D17 is the decision the whole feature turns on, so its leg is the one
    // that may never be quietly dropped or renamed away.
    expect(MCP_SERVERS_STAGING_LEGS).toContain('broken-url-degrades')
    expect(new Set(MCP_SERVERS_STAGING_LEGS).size).toBe(MCP_SERVERS_STAGING_LEGS.length)
    // The pasted token is the one the consent leg mints, so consent has to run
    // before the static leg or the static leg has nothing to paste.
    expect(MCP_SERVERS_STAGING_LEGS.indexOf('oauth-consent-tools')).toBeLessThan(
      MCP_SERVERS_STAGING_LEGS.indexOf('static-token-tools'),
    )
  })

  test('accepts only a successful call of the exact namespaced tool', () => {
    const tool = namespacedToolName('fakeoauth', 'echo')
    const history = SessionInitialHistorySnapshotSchema.parse({
      events: [
        toolCallRow(1, namespacedToolName('staticfake', 'echo'), false),
        toolCallRow(2, tool, true),
        toolCallRow(3, tool, false),
      ],
    })

    expect(hasSuccessfulToolCall(history, tool)).toBe(true)
    expect(hasSuccessfulToolCall(history, namespacedToolName('fakeoauth', 'whoami'))).toBe(false)
    expect(
      hasSuccessfulToolCall(
        SessionInitialHistorySnapshotSchema.parse({ events: [toolCallRow(2, tool, true)] }),
        tool,
      ),
    ).toBe(false)
  })
})

function toolCallRow(seq: number, toolName: string, isError: boolean) {
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
        output: [{ type: 'text', text: 'echo: sentinel' }],
      },
    },
  }
}
