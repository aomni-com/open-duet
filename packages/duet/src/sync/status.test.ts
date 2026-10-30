import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isConflictPath, listConflicts, readConvergence, waitForConvergence } from './status.js'
import type { SyncthingApi } from './syncthing-api.js'

describe('isConflictPath', () => {
  test('matches Syncthing conflict copies by basename', () => {
    expect(isConflictPath('a/b/x.sync-conflict-20260101-000000-ABCDEFG.txt')).toBe(true)
    expect(isConflictPath('x.sync-conflict-20260101-000000-ABCDEFG')).toBe(true)
    expect(isConflictPath('src/normal.ts')).toBe(false)
  })
})

describe('readConvergence', () => {
  function fakeApi(responders: Record<string, unknown>): SyncthingApi {
    return {
      base: 'http://127.0.0.1:8384',
      apiKey: 'k',
      fetch: async input => {
        const url = String(input)
        for (const [needle, body] of Object.entries(responders)) {
          if (url.includes(needle)) return new Response(JSON.stringify(body))
        }
        throw new Error(`unexpected ${url}`)
      },
    }
  }

  test('converged when peer connected, folder idle, and remote 100%', async () => {
    const api = fakeApi({
      '/rest/db/status': { state: 'idle', needBytes: 0, needItems: 0, globalTotalItems: 5 },
      '/rest/db/completion': { completion: 100, needBytes: 0 },
      '/rest/system/connections': { connections: { VM: { connected: true } } },
    })
    const state = await readConvergence(api, { folderId: 'workspace-drive', vmDeviceId: 'VM' })
    expect(state.converged).toBe(true)
  })

  test('not converged while disconnected even if local is idle', async () => {
    const api = fakeApi({
      '/rest/db/status': { state: 'idle', needBytes: 0, needItems: 0, globalTotalItems: 5 },
      '/rest/db/completion': { completion: 100, needBytes: 0 },
      '/rest/system/connections': { connections: { VM: { connected: false } } },
    })
    const state = await readConvergence(api, { folderId: 'workspace-drive', vmDeviceId: 'VM' })
    expect(state.converged).toBe(false)
    expect(state.connected).toBe(false)
  })

  test('waitForConvergence polls until quiet', async () => {
    let poll = 0
    const api: SyncthingApi = {
      base: 'http://127.0.0.1:8384',
      apiKey: 'k',
      fetch: async input => {
        const url = String(input)
        if (url.includes('/rest/system/connections')) {
          return new Response(JSON.stringify({ connections: { VM: { connected: true } } }))
        }
        if (url.includes('/rest/db/completion')) {
          return new Response(JSON.stringify({ completion: 100, needBytes: 0 }))
        }
        // status: syncing on the first poll, idle afterwards.
        poll += 1
        const state = poll < 2 ? 'syncing' : 'idle'
        const needBytes = poll < 2 ? 500 : 0
        return new Response(
          JSON.stringify({ state, needBytes, needItems: needBytes ? 1 : 0, globalTotalItems: 5 }),
        )
      },
    }
    const state = await waitForConvergence(api, {
      folderId: 'workspace-drive',
      vmDeviceId: 'VM',
      pollMs: 0,
      sleep: async () => {},
    })
    expect(state.converged).toBe(true)
  })
})

describe('listConflicts', () => {
  test('finds .sync-conflict-* files and skips node_modules/.git', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'duet-conflicts-'))
    try {
      await writeFile(join(dir, 'normal.ts'), 'x')
      await writeFile(join(dir, 'notes.sync-conflict-20260713-120000-NMWD7HN.md'), 'y')
      await mkdir(join(dir, 'src'), { recursive: true })
      await writeFile(join(dir, 'src', 'app.sync-conflict-20260713-120001-NMWD7HN.ts'), 'z')
      await mkdir(join(dir, 'node_modules', 'pkg'), { recursive: true })
      await writeFile(join(dir, 'node_modules', 'pkg', 'a.sync-conflict-x.js'), 'skip')
      const conflicts = await listConflicts(dir)
      expect(conflicts).toEqual([
        'notes.sync-conflict-20260713-120000-NMWD7HN.md',
        join('src', 'app.sync-conflict-20260713-120001-NMWD7HN.ts'),
      ])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
