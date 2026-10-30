import { expect, test } from 'bun:test'

import { resolveAgentConfig } from '@repo/contract'

import { duetQueryKeys } from '../api/query-keys'
import type { SpaApi } from '../context'
import { agentConfigQueryOptions } from './agent-config'

const AGENT = { id: 'agent_research', anchorPath: 'agents/research' }

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function runQueryFn(options: ReturnType<typeof agentConfigQueryOptions>) {
  return (options.queryFn as (ctx: { signal: AbortSignal }) => Promise<unknown>)({
    signal: new AbortController().signal,
  })
}

test.each([
  ['malformed JSON', '{"onboarding":'],
  ['unknown fields', JSON.stringify({ futureField: { enabled: true } })],
  [
    'declared settings',
    JSON.stringify({
      trainable: false,
      onboarding: { kind: 'app', app: '.onboarding/style-picker' },
    }),
  ],
] as const)('the config query resolves %s through the contract owner', async (_name, source) => {
  const api = {
    readOptionalWorkspaceFile: async (_slug: string, path: string) => {
      expect(path).toBe('agents/research/agent.json')
      return {
        data: bytes(source),
        etag: null,
        contentType: 'application/json',
        size: 0,
      }
    },
  } as unknown as SpaApi

  await expect(runQueryFn(agentConfigQueryOptions(api, 'acme', AGENT))).resolves.toEqual(
    resolveAgentConfig(source),
  )
})

/* `agent.json` is optional — most agents never write one — so the read says so
   on the wire and takes the empty answer as the ordinary fail-open config,
   rather than provoking a 404 the browser logs as an error on every agent. */
test('a missing agent.json is asked for as optional and resolves fail-open', async () => {
  let requiredReads = 0
  const api = {
    readOptionalWorkspaceFile: async () => null,
    readWorkspaceFile: async () => {
      requiredReads++
      throw new Error('the config read must never provoke a 404')
    },
  } as unknown as SpaApi

  await expect(runQueryFn(agentConfigQueryOptions(api, 'acme', AGENT))).resolves.toEqual(
    resolveAgentConfig(undefined),
  )
  expect(requiredReads).toBe(0)
})

test('an unreadable agent.json resolves to the fail-open config', async () => {
  const api = {
    readOptionalWorkspaceFile: async () => {
      throw new Error('workspace unavailable')
    },
  } as unknown as SpaApi

  await expect(runQueryFn(agentConfigQueryOptions(api, 'acme', AGENT))).resolves.toEqual({
    readable: false,
    trainable: true,
    // Fail-open means permissive on every axis, tags included: an agent whose
    // config could not be read is untagged, never mistakenly carrying the tags
    // of whatever was parsed last.
    tags: [],
  })
})

test('the config query is agent-keyed and remains stale for mount and focus refetches', () => {
  const options = agentConfigQueryOptions({} as SpaApi, 'acme', AGENT)

  expect(JSON.stringify(options.queryKey)).toBe(
    JSON.stringify(duetQueryKeys.workspaces.agents.config('acme', 'agent_research')),
  )
  expect(options.staleTime).toBeUndefined()
  expect(options.refetchOnMount).toBe(true)
  expect(options.refetchOnWindowFocus).toBe(true)
  expect(options.retry).toBe(false)
})
