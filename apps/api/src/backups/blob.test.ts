import { describe, expect, test } from 'bun:test'

import { getPayloadFromClientToken } from '@vercel/blob/client'

import { createBackupBlobStore } from './blob'

describe('private backup storage', () => {
  test('refuses completion when the stored object does not match the expected artifact', async () => {
    const store = createBackupBlobStore({
      token: 'test-store-token',
      sdk: {
        head: async () => ({
          pathname: 'workspace-backups/another-workspace/other.zip',
          size: 42,
          contentType: 'application/zip',
          url: 'https://fixture.private.blob.vercel-storage.com/other.zip',
        }),
      },
    })

    await expect(store.verify('workspace-backups/ws/job/attempt.zip', 42)).rejects.toThrow(
      'backup_artifact_mismatch',
    )
  })

  test('the VM receives only a signed write grant for its artifact', async () => {
    const pathname = 'workspace-backups/ws/job/attempt.zip'
    const store = createBackupBlobStore({
      token: 'vercel_blob_rw_fixture_testStoreSecret',
    })
    const grant = await store.uploadGrant(pathname)
    const wire = JSON.stringify(grant)
    expect(wire).not.toContain('testStoreSecret')
    const scope = getPayloadFromClientToken(grant.token)
    expect(scope.pathname).toBe(pathname)
    expect(scope.allowOverwrite).toBe(false)
    expect(scope.allowedContentTypes).toEqual(['application/zip'])
    expect(scope.validUntil).toBe(grant.expiresAt)
  })

  test('download grants give expiring private read access without exposing the store key', async () => {
    const store = createBackupBlobStore({
      token: 'vercel_blob_rw_fixture_testStoreSecret',
      sdk: {
        issueSignedToken: async options => ({
          delegationToken: `${Buffer.from(
            JSON.stringify({
              storeId: 'fixture',
              pathname: options.pathname,
              operations: options.operations,
              validUntil: options.validUntil,
            }),
          ).toString('base64url')}.signature`,
          clientSigningToken: 'fixture-signing-key',
          validUntil: options.validUntil!,
        }),
      },
    })
    const download = await store.download('workspace-backups/ws/job/attempt.zip')
    const url = new URL(download.url)
    expect(url.hostname).toBe('fixture.private.blob.vercel-storage.com')
    expect(url.pathname).toBe('/workspace-backups/ws/job/attempt.zip')
    expect(url.searchParams.get('cache')).toBe('0')
    expect(url.searchParams.get('download')).toBe('1')
    const delegation = url.searchParams.get('vercel-blob-delegation')!
    const scope = JSON.parse(Buffer.from(delegation.split('.')[0]!, 'base64url').toString())
    expect(scope.operations).toEqual(['get'])
    expect(scope.validUntil).toBe(download.expiresAt)
    expect(download.url).not.toContain('testStoreSecret')
    expect(download.url).not.toContain('fixture-signing-key')
  })
})
