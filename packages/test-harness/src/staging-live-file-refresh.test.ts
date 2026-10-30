import { describe, expect, test } from 'bun:test'

import {
  createLiveFileRefreshFixture,
  liveFileRefreshPathname,
  recordLiveFileRefreshCleanup,
} from './staging-live-file-refresh'
import { StagingResourceLedger } from './staging-live-resource-ledger'

describe('live file refresh staging journey', () => {
  test('derives one run-unique text identity and distinct mutation bodies', () => {
    const fixture = createLiveFileRefreshFixture('staging-e2e-live-file-refresh-mk123456-a1b2c3')

    expect(fixture.fileName).toBe('live-refresh-456-a1b2c3.txt')
    expect(fixture.path).toBe(fixture.fileName)
    expect(fixture.contents).toEqual({
      initial: 'initial:staging-e2e-live-file-refresh-mk123456-a1b2c3\n',
      remoteUpdate: 'remote-update:staging-e2e-live-file-refresh-mk123456-a1b2c3\n',
      localDraft: 'local-draft:staging-e2e-live-file-refresh-mk123456-a1b2c3\n',
      remoteConflict: 'remote-conflict:staging-e2e-live-file-refresh-mk123456-a1b2c3\n',
      replacement: 'browser-replacement:staging-e2e-live-file-refresh-mk123456-a1b2c3\n',
      recovery: 'same-path-recovery:staging-e2e-live-file-refresh-mk123456-a1b2c3\n',
    })
    for (const content of Object.values(fixture.contents)) {
      expect(content).toContain('staging-e2e-live-file-refresh-mk123456-a1b2c3')
      expect(content.endsWith('\n')).toBe(true)
    }
  })

  test('encodes workspace and file identities into the addressed Files route', () => {
    expect(liveFileRefreshPathname('team / 東京', 'live 100%.txt')).toBe(
      '/w/team%20%2F%20%E6%9D%B1%E4%BA%AC/files/live%20100%25.txt',
    )
  })

  test('records the file immediately and runs deletion before verification', async () => {
    const ledger = new StagingResourceLedger('staging-e2e-live-file-refresh-test', () => 123)
    const events: string[] = []
    recordLiveFileRefreshCleanup({
      ledger,
      path: 'live-refresh-test.txt',
      cleanup: async () => events.push('delete:200-or-404'),
      verify: async () => {
        events.push('verify')
        return true
      },
    })

    expect(ledger.snapshot()).toEqual([
      {
        kind: 'file',
        id: 'live-refresh-test.txt',
        label: 'staging-e2e-live-file-refresh-test:live-file-refresh-file:live-refresh-test.txt',
        recordedAt: 123,
        status: 'recorded',
      },
    ])
    expect(await ledger.cleanupAll()).toMatchObject({ status: 'pass', orphans: [] })
    expect(events).toEqual(['delete:200-or-404', 'verify'])
  })
})
