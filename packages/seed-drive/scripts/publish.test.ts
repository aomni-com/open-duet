import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'

import { publishSeedDrive, type SeedPublicationBackend } from './publish'

test('publish reports a verified no-op when the built hash is already current', async () => {
  const bytes = new TextEncoder().encode('canonical seed tar')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let uploadRequested = false
  const backend: SeedPublicationBackend = {
    current: async () => ({ storageId: 'storage-current', sha256 }),
    generateUploadUrl: async () => {
      uploadRequested = true
      return 'https://upload.example'
    },
    record: async () => {
      throw new Error('record should not run for an unchanged archive')
    },
    downloadUrl: async () => 'https://download.example',
  }

  const result = await publishSeedDrive({
    buildArchive: async () => ({ bytes, sha256 }),
    backend,
    fetch: async request => {
      expect(request).toBe('https://download.example')
      return new Response(bytes)
    },
  })

  expect(result).toEqual({ status: 'unchanged', storageId: 'storage-current', sha256 })
  expect(uploadRequested).toBe(false)
})

test('publish uploads, activates, and verifies changed archive bytes', async () => {
  const bytes = new TextEncoder().encode('new canonical seed tar')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  let current: { storageId: string; sha256: string } | null = null
  const backend: SeedPublicationBackend = {
    current: async () => current,
    generateUploadUrl: async () => 'https://upload.example',
    record: async bundle => {
      current = bundle
      return { ...bundle, created: true, activated: true }
    },
    downloadUrl: async () => 'https://download.example',
  }

  const result = await publishSeedDrive({
    buildArchive: async () => ({ bytes, sha256 }),
    backend,
    fetch: async (request, init) => {
      if (request === 'https://upload.example') {
        expect(init?.method).toBe('POST')
        expect(new Uint8Array(await new Response(init?.body).arrayBuffer())).toEqual(bytes)
        return Response.json({ storageId: 'storage-new' })
      }
      expect(request).toBe('https://download.example')
      return new Response(bytes)
    },
  })

  expect(result).toEqual({ status: 'published', storageId: 'storage-new', sha256 })
  expect(current).toEqual({ storageId: 'storage-new', sha256 })
})

test('publish fails when the active storage object does not match the built archive', async () => {
  const bytes = new TextEncoder().encode('expected bytes')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const backend: SeedPublicationBackend = {
    current: async () => ({ storageId: 'storage-current', sha256 }),
    generateUploadUrl: async () => 'https://upload.example',
    record: async bundle => ({ ...bundle, created: true, activated: true }),
    downloadUrl: async () => 'https://download.example',
  }

  await expect(
    publishSeedDrive({
      buildArchive: async () => ({ bytes, sha256 }),
      backend,
      fetch: async () => new Response('different bytes'),
    }),
  ).rejects.toThrow('Current seed drive bundle hash mismatch')
})
