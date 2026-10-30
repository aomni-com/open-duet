import { expect, test, spyOn } from 'bun:test'
import { createHash } from 'node:crypto'

import { ConvexHttpClient } from 'convex/browser'
import JSZip from 'jszip'

import { StagingResourceLedger } from './staging-live-resource-ledger'
import {
  inspectWorkspaceBackup,
  deleteBackup,
  recordBackupCleanup,
} from './staging-live-workspace-backup'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
test('independent ZIP inspection refuses missing or changed bytes even when the manifest says complete', async () => {
  const zip = new JSZip()
    .file('README.md', 'Recovery instructions')
    .file('manifest.json', JSON.stringify({ completeness: 'complete' }))
    .file(
      'inventory.ndjson',
      JSON.stringify({
        path: 'drive/.env',
        type: 'file',
        mode: 0o100600,
        mtime: 1,
        bytes: 8,
        sha256: digest('expected'),
      }) + '\n',
    )
    .file('warnings.ndjson', '')
    .file('drive/.env', 'changed!')
  await expect(
    inspectWorkspaceBackup(await zip.generateAsync({ type: 'uint8array' })),
  ).rejects.toThrow('drive/.env')
  zip.file('drive/.env', 'expected')
  const inspected = await inspectWorkspaceBackup(await zip.generateAsync({ type: 'uint8array' }))
  expect(await inspected.zip.file('drive/.env')!.async('text')).toBe('expected')
  zip.remove('drive/.env')
  await expect(
    inspectWorkspaceBackup(await zip.generateAsync({ type: 'uint8array' })),
  ).rejects.toThrow('drive/.env')
})

test('backup cleanup accepts a resource already deleted by the journey', async () => {
  const context = {
    env: { apiUrl: 'https://api.example.test' },
    workspace: { slug: 'fixture' },
    apiToken: 'fixture',
  }
  const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 404 }))
  try {
    await expect(deleteBackup(context, 'removed')).resolves.toBeUndefined()
  } finally {
    fetch.mockRestore()
  }
})

test('backup deletion remains verifiable after the fixture identity is retired', async () => {
  const ledger = new StagingResourceLedger(
    'recovery-run',
    () => 0,
    async () => {},
  )
  let retired = false
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        if (String(input).includes('convex.cloud'))
          return Response.json({ status: 'success', value: null })
        return new Response(null, { status: retired ? 401 : 404 })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  try {
    ledger.record({
      kind: 'user',
      id: 'owner',
      label: 'recovery-run:owner',
      cleanupPriority: -100,
      cleanup: async () => {
        retired = true
      },
      verify: async () => retired,
    })
    recordBackupCleanup(
      {
        ledger,
        runId: 'recovery-run',
        convex: new ConvexHttpClient('https://fixture.convex.cloud'),
        env: { apiUrl: 'https://api.example.test', internalKey: 'fixture-internal' },
        workspace: { _id: 'workspace', slug: 'fixture' },
        apiToken: 'fixture-bearer',
      },
      'backup',
    )
    expect(await ledger.cleanupAll()).toMatchObject({ status: 'pass', orphans: [] })
  } finally {
    fetch.mockRestore()
  }
})

test('failed journey cleanup retires the workspace before waiting out an active backup grant', async () => {
  const ledger = new StagingResourceLedger(
    'interrupted-run',
    () => 0,
    async () => {},
  )
  let workspaceDeleted = false
  let readsAfterDeletion = 0
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(
    Object.assign(
      async (input: Parameters<typeof globalThis.fetch>[0]) => {
        if (String(input).includes('convex.cloud')) {
          const removed = workspaceDeleted && ++readsAfterDeletion > 1
          return Response.json({
            status: 'success',
            value: removed ? null : { status: 'deleting' },
          })
        }
        return new Response(null, { status: 409 })
      },
      { preconnect: globalThis.fetch.preconnect },
    ),
  )
  const sleep = spyOn(Bun, 'sleep').mockResolvedValue(undefined)
  try {
    ledger.record({
      kind: 'workspace',
      id: 'workspace',
      label: 'interrupted-run:workspace',
      cleanup: async () => {
        workspaceDeleted = true
      },
      verify: async () => workspaceDeleted,
    })
    recordBackupCleanup(
      {
        ledger,
        runId: 'interrupted-run',
        convex: new ConvexHttpClient('https://fixture.convex.cloud'),
        env: { apiUrl: 'https://api.example.test', internalKey: 'fixture-internal' },
        workspace: { _id: 'workspace', slug: 'fixture' },
        apiToken: 'fixture',
      },
      'backup',
    )
    const report = await ledger.cleanupAll()
    expect(report).toMatchObject({ status: 'pass', orphans: [] })
    expect(report.resources.find(row => row.kind === 'backup')?.status).toBe('deleted')
  } finally {
    fetch.mockRestore()
    sleep.mockRestore()
  }
})
