import { describe, expect } from 'bun:test'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { DEVELOPER_SYSTEM_PROMPT } from '../../gateway/src/runner/developer-system-prompt.js'
import { TurnRunner } from '../src/turn-runner/turn-runner.js'
import type { TurnEvent } from '../src/types/protocol.js'
import { testIfDocker } from '../test/helpers/docker-only.js'
import { startMcpHttpServer } from '../test/helpers/mcp-http-server.js'

const model = process.env.EVAL_MODEL ?? 'sonnet-5'

describe('Duet channel context', () => {
  testIfDocker(
    'routes an unqualified channel request to Duet workspace resources instead of Slack',
    async () => {
      const calls: string[] = []
      const server = await startMcpHttpServer(() => {
        const mcp = new McpServer({ name: 'duet-channel-context-eval', version: '0.0.0' })
        mcp.registerTool(
          'workspace_sessions',
          {
            title: 'Duet workspace sessions',
            description: "Create or list sessions in the user's current workspace.",
            inputSchema: {
              action: z.enum(['list', 'create']),
              name: z.string().optional(),
            },
          },
          async ({ action, name }) => {
            calls.push('workspace_sessions')
            return {
              content: [
                {
                  type: 'text',
                  text: action === 'create' ? `Created session ${name ?? ''}` : 'Sessions listed',
                },
              ],
            }
          },
        )
        mcp.registerTool(
          'workspace_agents',
          {
            title: 'Duet workspace agents',
            description: "Create or list agents in the user's current workspace.",
            inputSchema: {
              action: z.enum(['list', 'create']),
              name: z.string().optional(),
            },
          },
          async ({ action, name }) => {
            calls.push('workspace_agents')
            return {
              content: [
                {
                  type: 'text',
                  text: action === 'create' ? `Created agent ${name ?? ''}` : 'Agents listed',
                },
              ],
            }
          },
        )
        mcp.registerTool(
          'external_channels',
          {
            title: 'External messaging channels',
            description: 'Create or list channels in an external messaging service such as Slack.',
            inputSchema: {
              action: z.enum(['list', 'create']),
              name: z.string().optional(),
            },
          },
          async ({ action, name }) => {
            calls.push('external_channels')
            return {
              content: [
                {
                  type: 'text',
                  text:
                    action === 'create'
                      ? `Created external channel ${name ?? ''}`
                      : 'Channels listed',
                },
              ],
            }
          },
        )
        return mcp
      })

      const runner = new TurnRunner({
        model,
        mode: 'agent',
        memoryStores: false,
        skillDiscovery: { includeDefaults: false },
        systemInstructions: DEVELOPER_SYSTEM_PROMPT,
      })
      const toolCalls: string[] = []
      runner.subscribe((event: TurnEvent) => {
        if (event.type !== 'step' || event.step.type !== 'tool_call') return
        if (!event.step.isError && event.step.toolName.startsWith('eval_mcp__')) {
          toolCalls.push(event.step.toolName)
        }
      })

      try {
        await runner.start({
          type: 'start',
          mode: 'agent',
          mcpServers: { eval_mcp: { type: 'http', url: server.url } },
        })
        const terminal = await runner.turn({
          type: 'prompt',
          message:
            'Create a channel called #general. You have enough context to proceed. You must use one of the available workspace tools to create it; do not ask or answer until the tool succeeds, then confirm what you did.',
          behavior: 'follow_up',
        })

        expect(terminal.type).toBe('complete')
        expect(
          calls.some(call => call === 'workspace_sessions' || call === 'workspace_agents'),
        ).toBe(true)
        expect(calls).not.toContain('external_channels')
        expect(
          toolCalls.some(
            call =>
              call === 'eval_mcp__workspace_sessions' || call === 'eval_mcp__workspace_agents',
          ),
        ).toBe(true)
      } finally {
        await runner.dispose()
        await server.close()
      }
    },
    60_000,
  )
})
