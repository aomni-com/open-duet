import { expect, test } from 'bun:test'

import { createDiskGuard } from './disk-guard'

test('reports full when filesystem-available bytes are below the reserve', async () => {
  const guard = createDiskGuard({
    driveMount: '/drive',
    reserveBytes: 1_024,
    ttlMs: 3_000,
    now: () => 10,
    statvfs: async path => {
      expect(path).toBe('/drive')
      return { bavail: 15, frsize: 64 }
    },
  })

  await expect(guard.ensureWritable()).resolves.toBe('full')
})

test('allows writes when filesystem-available bytes equal the reserve', async () => {
  const guard = createDiskGuard({
    driveMount: '/drive',
    reserveBytes: 1_024,
    statvfs: async () => ({ bavail: 16, frsize: 64 }),
  })

  await expect(guard.ensureWritable()).resolves.toBe('ok')
})

test('fails open when the filesystem probe throws', async () => {
  const guard = createDiskGuard({
    driveMount: '/drive',
    statvfs: async () => {
      throw new Error('statvfs unavailable')
    },
  })

  await expect(guard.ensureWritable()).resolves.toBe('ok')
})

// One probe, many sizes: a 7 GiB upload and a 7.5 GiB one arriving inside the
// same TTL must each be weighed against the free bytes, not handed whichever
// verdict the first caller happened to ask for.
test('weighs each declared size against the same probe', async () => {
  const gib = 1024 ** 3
  let probes = 0
  const guard = createDiskGuard({
    driveMount: '/drive',
    reserveBytes: gib,
    ttlMs: 3_000,
    now: () => 0,
    statvfs: async () => {
      probes += 1
      return { bavail: 8 * 1024 * 1024, frsize: 1024 }
    },
  })

  await expect(guard.ensureWritable()).resolves.toBe('ok')
  await expect(guard.ensureWritable(7 * gib)).resolves.toBe('ok')
  await expect(guard.ensureWritable(7.5 * gib)).resolves.toBe('full')
  await expect(guard.ensureWritable()).resolves.toBe('ok')
  expect(probes).toBe(1)
})

test('reuses a probe only within the short TTL', async () => {
  let now = 0
  let probes = 0
  const guard = createDiskGuard({
    driveMount: '/drive',
    reserveBytes: 1_024,
    ttlMs: 3_000,
    now: () => now,
    statvfs: async () => {
      probes += 1
      return probes === 1 ? { bavail: 15, frsize: 64 } : { bavail: 16, frsize: 64 }
    },
  })

  await expect(guard.ensureWritable()).resolves.toBe('full')
  now = 2_999
  await expect(guard.ensureWritable()).resolves.toBe('full')
  expect(probes).toBe(1)
  now = 3_000
  await expect(guard.ensureWritable()).resolves.toBe('ok')
  expect(probes).toBe(2)
})
