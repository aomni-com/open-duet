import { describe, expect, test } from 'bun:test'

import type { AppListResponse } from '@repo/contract'

import { DuetApiClient } from '../../api/client'
import { RestWorkspaceAppsSource } from './apps-source'
import { MockWorkspaceAppsSource } from './mock-apps-source'

const response: AppListResponse = {
  items: [],
  nextCursor: null,
  meta: { capabilities: { register: true } },
}

describe('RestWorkspaceAppsSource', () => {
  test('delegates workspace app reads to the API client listApps owner', async () => {
    const calls: Array<{ path: string; signal?: AbortSignal | null }> = []
    const api = new DuetApiClient(async (input, init) => {
      calls.push({ path: String(input), signal: init?.signal })
      return Response.json(response)
    })
    const source = new RestWorkspaceAppsSource(api)
    const controller = new AbortController()

    await expect(
      source.listApps('acme', { cursor: 'app-100', limit: 100, signal: controller.signal }),
    ).resolves.toEqual(response)
    expect(calls).toEqual([
      { path: '/api/duet/ws/acme/apps?cursor=app-100&limit=100', signal: controller.signal },
    ])
  })
})

describe('MockWorkspaceAppsSource', () => {
  test('returns the response seeded for each workspace and rejects missing fixtures', async () => {
    const source = new MockWorkspaceAppsSource()
    source.seed('acme', response)

    await expect(source.listApps('acme')).resolves.toBe(response)
    await expect(source.listApps('other')).rejects.toThrow('workspace_apps_fixture_missing:other')
  })
})
