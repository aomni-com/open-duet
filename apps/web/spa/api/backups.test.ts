import { expect, test } from 'bun:test'

import { DuetApiClient } from './client'

test('backup client preserves request identity and addresses status and download operations', async () => {
  const requests: Array<{ path: string; method: string; body?: string }> = []
  const client = new DuetApiClient(async (input, init) => {
    const path = String(input)
    requests.push({
      path,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    })
    if (path.endsWith('/download'))
      return Response.json({
        url: 'https://backup.example.test/private.zip',
        expiresAt: 100,
        filename: 'workspace.zip',
        bytes: 200,
        sha256: 'a'.repeat(64),
      })
    if (init?.method === 'DELETE')
      return Response.json({ deleted: false, emptyDriveOnNextStart: true })
    if (!init?.method) return Response.json({ items: [], nextCursor: 'next-page' })
    return Response.json({
      backup: {
        id: 'backup-1',
        workspaceId: 'workspace-1',
        purpose: 'export',
        status: 'queued',
        createdAt: 1,
        updatedAt: 1,
        progress: {
          processedFiles: 0,
          processedRecords: 0,
          capturedBytes: 0,
          uploadedBytes: 0,
          warningCount: 0,
          warningSummary: [],
        },
      },
    })
  })
  await client.createWorkspaceBackup('acme space', { requestId: 'request-1' })
  expect(
    await client.listWorkspaceBackups('acme space', { cursor: 'older page', limit: 12 }),
  ).toEqual({ items: [], nextCursor: 'next-page' })
  expect(await client.downloadWorkspaceBackup('acme space', 'backup/1')).toMatchObject({
    filename: 'workspace.zip',
    bytes: 200,
  })
  expect(await client.deleteWorkspaceBackup('acme space', 'backup/1')).toEqual({
    deleted: false,
    emptyDriveOnNextStart: true,
  })
  expect(requests).toEqual([
    {
      path: '/api/duet/ws/acme%20space/backups',
      method: 'POST',
      body: '{"requestId":"request-1"}',
    },
    { path: '/api/duet/ws/acme%20space/backups?cursor=older+page&limit=12', method: 'GET' },
    { path: '/api/duet/ws/acme%20space/backups/backup%2F1/download', method: 'POST', body: '{}' },
    { path: '/api/duet/ws/acme%20space/backups/backup%2F1', method: 'DELETE' },
  ])
})

test('accepted create and delete update only their workspace list while downloads leave records unchanged', async () => {
  const { QueryClient } = await import('@tanstack/react-query')
  const { workspaceBackupMutationOptions, workspaceBackupsQueryOptions } = await import('./backups')
  const { duetQueryKeys } = await import('./query-keys')
  const queryClient = new QueryClient()
  const backup = {
    id: 'backup-1',
    workspaceId: 'workspace-1',
    purpose: 'export' as const,
    status: 'queued' as const,
    createdAt: 1,
    updatedAt: 1,
    progress: {
      processedFiles: 0,
      processedRecords: 0,
      capturedBytes: 0,
      uploadedBytes: 0,
      warningCount: 0,
      warningSummary: [],
    },
  }
  const client = new DuetApiClient(async (input, init) => {
    if (String(input).endsWith('/download'))
      return Response.json({
        url: 'https://backup.example.test/private.zip?secret=grant',
        expiresAt: 100,
        filename: 'workspace.zip',
        bytes: 200,
        sha256: 'a'.repeat(64),
      })
    if (init?.method === 'POST') return Response.json({ backup })
    if (init?.method === 'DELETE')
      return Response.json({ deleted: false, emptyDriveOnNextStart: false })
    return Response.json({ items: [], nextCursor: null })
  })
  const acmeKey = duetQueryKeys.workspaces.backups('acme')
  const peerKey = duetQueryKeys.workspaces.backups('peer')
  await queryClient.fetchInfiniteQuery(workspaceBackupsQueryOptions(client, 'acme'))
  await queryClient.fetchInfiniteQuery(workspaceBackupsQueryOptions(client, 'peer'))
  await queryClient
    .getMutationCache()
    .build(queryClient, workspaceBackupMutationOptions.create(client, queryClient, 'acme'))
    .execute('same-request')
  expect(queryClient.getQueryData(acmeKey)).toMatchObject({ pages: [{ items: [backup] }] })
  expect(queryClient.getQueryData(peerKey)).toMatchObject({ pages: [{ items: [] }] })
  const recordsBeforeDownload = queryClient.getQueryData(acmeKey)
  await queryClient
    .getMutationCache()
    .build(queryClient, workspaceBackupMutationOptions.download(client, 'acme'))
    .execute('backup-1')
  expect(JSON.stringify(queryClient.getQueryData(acmeKey))).toBe(
    JSON.stringify(recordsBeforeDownload),
  )
  expect(
    JSON.stringify(
      queryClient
        .getQueryCache()
        .getAll()
        .map(query => query.state.data),
    ),
  ).not.toContain('secret=grant')
  await queryClient
    .getMutationCache()
    .build(queryClient, workspaceBackupMutationOptions.delete(client, queryClient, 'acme'))
    .execute('backup-1')
  expect(queryClient.getQueryData(acmeKey)).toMatchObject({
    pages: [{ items: [{ id: 'backup-1', status: 'deleting' }] }],
  })
  queryClient.clear()
})

test('mounted backup polling resumes durable state after navigation and stops on ready', async () => {
  const child = Bun.spawn(
    [process.execPath, new URL('./backup-poll-lifecycle.fixture.ts', import.meta.url).pathname],
    { stdout: 'pipe', stderr: 'pipe' },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual({ calls: 3, status: 'ready' })
}, 15_000)
