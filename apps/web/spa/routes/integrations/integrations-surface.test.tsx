import { expect, test } from 'bun:test'

import { QueryClient } from '@tanstack/react-query'
import { MAX_MCP_SERVERS_PER_WORKSPACE } from '@repo/contract'

import {
  applyOptimisticIntegrationAgentPolicy,
  integrationAgentPolicyMutation,
} from '../integrations'
import { nextIntegrationPolicy } from './integration-agent-access'
import { draftError, mcpServerNameSuggestion } from './mcp-servers-panel'

test('materializes all other visible principals when one child leaves All agents', () => {
  expect(
    nextIntegrationPolicy({
      current: undefined,
      visiblePrincipalIds: ['root', 'agent_research', 'agent_reviewer'],
      toggledId: 'agent_research',
      checked: false,
    }),
  ).toEqual(['root', 'agent_reviewer'])
})

test('All agents clears or creates the policy without collapsing explicit children', () => {
  const visiblePrincipalIds = ['root', 'agent_research']

  expect(
    nextIntegrationPolicy({
      current: ['root'],
      visiblePrincipalIds,
      toggledId: 'all',
      checked: true,
    }),
  ).toBeUndefined()
  expect(
    nextIntegrationPolicy({
      current: undefined,
      visiblePrincipalIds,
      toggledId: 'all',
      checked: false,
    }),
  ).toEqual([])
  expect(
    nextIntegrationPolicy({
      current: ['root'],
      visiblePrincipalIds,
      toggledId: 'agent_research',
      checked: true,
    }),
  ).toEqual(visiblePrincipalIds)
})

test('drops stale principals on the next visible child edit', () => {
  expect(
    nextIntegrationPolicy({
      current: ['agent_deleted', 'agent_research'],
      visiblePrincipalIds: ['root', 'agent_research', 'agent_reviewer'],
      toggledId: 'root',
      checked: true,
    }),
  ).toEqual(['root', 'agent_research'])
})

test('binds an optimistic policy save to the workspace where it began', () => {
  const first = integrationAgentPolicyMutation('workspace-a', 'github', ['agent-a'])
  const second = integrationAgentPolicyMutation('workspace-b', 'github', ['agent-b'])

  expect(first.workspaceSlug).toBe('workspace-a')
  expect(first.connectionsKey).not.toEqual(second.connectionsKey)
  expect(first.allowedAgentIds).toEqual(['agent-a'])
})

test('an optimistic save cannot mutate the active workspace after a workspace switch', () => {
  const queryClient = new QueryClient()
  const first = integrationAgentPolicyMutation('workspace-a', 'github', ['agent-a'])
  const second = integrationAgentPolicyMutation('workspace-b', 'github', ['agent-b'])
  const connection = (allowedAgentIds: string[]) => ({
    pages: [
      {
        items: [
          {
            id: 'github-connection',
            integration: 'github',
            status: 'active' as const,
            allowedAgentIds,
          },
        ],
        nextCursor: null,
      },
    ],
    pageParams: [undefined],
  })
  type ConnectionData = ReturnType<typeof connection>
  queryClient.setQueryData<ConnectionData>(first.connectionsKey, connection(['root']))
  queryClient.setQueryData<ConnectionData>(second.connectionsKey, connection(['agent-b']))

  applyOptimisticIntegrationAgentPolicy(queryClient, first)

  expect(queryClient.getQueryData<ConnectionData>(first.connectionsKey)).toEqual(
    connection(['agent-a']),
  )
  expect(queryClient.getQueryData<ConnectionData>(second.connectionsKey)).toEqual(
    connection(['agent-b']),
  )
})

test('suggests a server name only when the host yields a legal one', () => {
  expect(mcpServerNameSuggestion('https://mcp.acme-corp.test/v1/mcp')).toBe('acme-corp')
  expect(mcpServerNameSuggestion('https://api.www.example.test/mcp')).toBe('example')
  // The reserved name would displace the connected-apps server rather than
  // collide with it, so it is never offered.
  expect(mcpServerNameSuggestion('https://integrations.example.test/mcp')).toBe('')
  expect(mcpServerNameSuggestion('not-a-url')).toBe('')
})

test('refuses a draft the add route would refuse, and says which part', () => {
  const url = 'https://mcp.acme.test/mcp'
  expect(draftError({ url, name: 'acme' }, [], 0)).toBeUndefined()
  expect(draftError({ url: 'http://mcp.acme.test/mcp', name: 'acme' }, [], 0)).toBe('invalidUrl')
  // `__` is what makes `{server}__{tool}` decodable; a name carrying one has
  // two readings and the timeline chip could not pick.
  expect(draftError({ url, name: 'acme__corp' }, [], 0)).toBe('invalidName')
  expect(draftError({ url, name: 'integrations' }, [], 0)).toBe('invalidName')
  expect(draftError({ url, name: 'acme' }, ['acme'], 1)).toBe('duplicateName')
  expect(draftError({ url, name: 'acme' }, [], MAX_MCP_SERVERS_PER_WORKSPACE)).toBe('limit')
})
