import * as blob from '@vercel/blob'
import { generateClientTokenFromReadWriteToken } from '@vercel/blob/client'

import { BACKUP_UPLOAD_GRANT_MS } from '@repo/contract'

type StoredArtifact = Pick<blob.HeadBlobResult, 'pathname' | 'size' | 'contentType' | 'url'>

interface BlobSdk {
  head: (pathname: string, options: { token?: string }) => Promise<StoredArtifact>
  issueSignedToken: typeof blob.issueSignedToken
  del: typeof blob.del
}

const BLOB_MAX_BYTES = 5_000_000_000_000

export function createBackupBlobStore(options: { token?: string; sdk?: Partial<BlobSdk> } = {}) {
  const sdk: BlobSdk = {
    head: blob.head,
    issueSignedToken: blob.issueSignedToken,
    del: blob.del,
    ...options.sdk,
  }
  return {
    async uploadGrant(pathname: string, expiresAt = Date.now() + BACKUP_UPLOAD_GRANT_MS) {
      const token = await generateClientTokenFromReadWriteToken({
        token: options.token,
        pathname,
        validUntil: expiresAt,
        allowedContentTypes: ['application/zip'],
        maximumSizeInBytes: BLOB_MAX_BYTES,
        addRandomSuffix: false,
        allowOverwrite: false,
      })
      return { token, expiresAt }
    },
    async verify(pathname: string, bytes: number): Promise<StoredArtifact> {
      const artifact = await sdk.head(pathname, { token: options.token })
      if (
        artifact.pathname !== pathname ||
        artifact.size !== bytes ||
        artifact.contentType !== 'application/zip' ||
        !new URL(artifact.url).hostname.endsWith('.private.blob.vercel-storage.com')
      ) {
        throw new Error('backup_artifact_mismatch')
      }
      return artifact
    },
    async download(pathname: string) {
      const expiresAt = Date.now() + 15 * 60 * 1000
      const token = await sdk.issueSignedToken({
        token: options.token,
        pathname,
        operations: ['get'],
        validUntil: expiresAt,
      })
      const { presignedUrl } = await blob.presignUrl(token, {
        operation: 'get',
        pathname,
        access: 'private',
        validUntil: expiresAt,
        useCache: false,
      })
      return { url: blob.getDownloadUrl(presignedUrl), expiresAt }
    },
    delete: (pathname: string) => sdk.del(pathname, { token: options.token }),
  }
}

export type BackupBlobStore = ReturnType<typeof createBackupBlobStore>
