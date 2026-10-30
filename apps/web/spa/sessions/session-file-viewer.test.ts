import { expect, test } from 'bun:test'

import { DuetApiClient } from '../api/client'
import { resolveSessionFileTarget } from './session-file-viewer'

// Chat names files in the wire dialect — drive-relative, or the VM-absolute
// path an agent sees — while the files surface speaks browser paths, where a
// leading slash is the drive root. The viewer must not collapse the two: a
// VM-absolute target reaches the gateway with its slash, the gateway contains
// it, and the entry the viewer opens is the one the gateway named.
test('a VM-absolute target is stat-ed through the wire path the gateway contains', async () => {
  const requests: string[] = []
  const api = new DuetApiClient(async input => {
    requests.push(typeof input === 'string' ? input : new URL(String(input)).pathname)
    return Response.json({
      entry: {
        name: 'duet-import-plan.md',
        path: 'backups/duet-import-plan.md',
        type: 'file',
        size: 5,
        mtime: '2026-09-04T00:00:00.000Z',
      },
      etag: null,
    })
  })

  const entry = await resolveSessionFileTarget(api, 'acme', {
    path: '/home/exedev/drive/duet-import-plan.md',
  })

  expect(requests).toEqual([
    '/api/duet/ws/acme/files/%2Fhome/exedev/drive/duet-import-plan.md?stat=1',
  ])
  expect(entry).toMatchObject({
    name: 'duet-import-plan.md',
    path: '/backups/duet-import-plan.md',
    isDirectory: false,
    size: 5,
  })
})
