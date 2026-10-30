import { expect, test } from 'bun:test'

import { deleteStoredInputImagesImpl, storeInputImagesImpl } from './images'

const INTERNAL_KEY = 'agent-session-image-test-key'

test('a later storage failure deletes every image whose id is already known', async () => {
  const previous = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = INTERNAL_KEY
  const deleted: string[] = []
  let stores = 0
  try {
    await expect(
      storeInputImagesImpl(
        {
          storage: {
            store: async () => {
              stores += 1
              if (stores === 2) throw new Error('store failed')
              return 'storage-1'
            },
            delete: async (id: string) => {
              deleted.push(id)
            },
          },
        } as never,
        {
          internalKey: INTERNAL_KEY,
          images: [
            { data: 'b25l', mimeType: 'image/png' },
            { data: 'dHdv', mimeType: 'image/png' },
          ],
        },
      ),
    ).rejects.toThrow('store failed')
    expect(deleted).toEqual(['storage-1'])
  } finally {
    if (previous === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previous
  }
})

test('known-image cleanup attempts every id before reporting failures', async () => {
  const previous = process.env.DUET_API_INTERNAL_KEY
  process.env.DUET_API_INTERNAL_KEY = INTERNAL_KEY
  const attempted: string[] = []
  const originalError = console.error
  console.error = () => undefined
  try {
    await expect(
      deleteStoredInputImagesImpl(
        {
          storage: {
            delete: async (id: string) => {
              attempted.push(id)
              if (id === 'storage-1') throw new Error('delete failed')
            },
          },
        } as never,
        {
          internalKey: INTERNAL_KEY,
          storageIds: ['storage-1', 'storage-2'] as never,
        },
      ),
    ).rejects.toThrow('Failed to delete 1 stored input image')
    expect(attempted).toEqual(['storage-1', 'storage-2'])
  } finally {
    console.error = originalError
    if (previous === undefined) delete process.env.DUET_API_INTERNAL_KEY
    else process.env.DUET_API_INTERNAL_KEY = previous
  }
})
