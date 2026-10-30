import { expect, test } from 'bun:test'

import { DuetApiClient } from './client'

test('incoming invitations belong to the signed-in user and acceptance returns the destination', async () => {
  const requests: Array<{ url: string; method: string }> = []
  const api = new DuetApiClient(async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? 'GET' })
    return Response.json(
      init?.method === 'POST'
        ? { workspaceId: 'workspace_newera', workspaceSlug: 'newera' }
        : { items: [], nextCursor: 'next-page' },
    )
  })
  expect(await api.listIncomingInvitations({ cursor: 'invitations page', limit: 10 })).toEqual({
    items: [],
    nextCursor: 'next-page',
  })
  expect(await api.acceptInvitation('invite/1')).toEqual({
    workspaceId: 'workspace_newera',
    workspaceSlug: 'newera',
  })
  expect(requests).toEqual([
    { url: '/api/duet/user/invitations?cursor=invitations+page&limit=10', method: 'GET' },
    { url: '/api/duet/user/invitations/invite%2F1/accept', method: 'POST' },
  ])
})
