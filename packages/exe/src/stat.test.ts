import { describe, expect, test } from 'bun:test'

import { vmUsagePointsFromStat } from './stat.ts'

/**
 * Captured verbatim from a live `exe stat duet-ws-… --range=24h` on 2026-08-09
 * (see specs/done/vm-compute-fees/research/fleet-metering.md). A hand-written
 * approximation would pin what we imagine the provider sends, which is the
 * failure mode this fixture exists to prevent.
 */
const LIVE_POINT = {
  timestamp: '2026-08-07T20:25:57Z',
  disk_size_gb: 30.064771072,
  disk_used_gb: 0.132644864,
  disk_logical_used_gb: 0.42448896,
  fs_used_gb: 7.449460736,
  fs_total_gb: 30.064771072,
  fs_free_gb: 22.615310336,
  fs_available_gb: 21.11207424,
  cpu_cores: 0.02,
  cpu_nominal: 4,
  mem_used_bytes: 555114496,
  mem_total_bytes: 8589934592,
  network_tx_mbps: 0.0003655155397449551,
  network_rx_mbps: 0.0007740603433287837,
  io_read_mbps: 0,
  io_write_mbps: 0,
  vm_name: 'duet-ws-bde39bb132b57594e4dca70d',
}

describe('vmUsagePointsFromStat', () => {
  test('parses a live provider point into billing units', () => {
    const [point] = vmUsagePointsFromStat({ points: [LIVE_POINT] })

    expect(point).toEqual({
      at: Date.parse('2026-08-07T20:25:57Z'),
      cpuCores: 0.02,
      cpuNominalCores: 4,
      memUsedGb: 555114496 / 1024 ** 3,
      memTotalGb: 8,
      fsUsedGb: 7.449460736,
      fsTotalGb: 30.064771072,
    })
  })

  describe('a broken envelope throws, because zero points reads as "idle"', () => {
    test.each([
      ['null', null],
      ['a string', 'nope'],
      ['a number', 7],
    ])('%s', (_label, raw) => {
      expect(() => vmUsagePointsFromStat(raw)).toThrow()
    })

    test('points missing entirely', () => {
      expect(() => vmUsagePointsFromStat({ vm_name: 'x' })).toThrow(/no .points./)
    })

    test('points not an array', () => {
      expect(() => vmUsagePointsFromStat({ points: {} })).toThrow(/not an array/)
    })
  })

  describe('one unusable point is dropped, never fatal', () => {
    const good = { ...LIVE_POINT, timestamp: '2026-08-07T20:35:57Z' }

    test.each([
      ['a null cpu_cores', { ...LIVE_POINT, cpu_cores: null }],
      ['a NaN cpu_cores', { ...LIVE_POINT, cpu_cores: Number.NaN }],
      ['a negative mem_used_bytes', { ...LIVE_POINT, mem_used_bytes: -1 }],
      ['a missing cpu_nominal', { ...LIVE_POINT, cpu_nominal: undefined }],
      ['an unparseable timestamp', { ...LIVE_POINT, timestamp: 'sometime tuesday' }],
      ['no timestamp at all', { ...LIVE_POINT, timestamp: undefined }],
      ['a null point', null],
    ])('%s is skipped while its neighbour survives', (_label, bad) => {
      const points = vmUsagePointsFromStat({ points: [bad, good] })

      expect(points).toEqual([
        {
          at: Date.parse(good.timestamp),
          cpuCores: 0.02,
          cpuNominalCores: 4,
          memUsedGb: 555114496 / 1024 ** 3,
          memTotalGb: 8,
          fsUsedGb: 7.449460736,
          fsTotalGb: 30.064771072,
        },
      ])
    })
  })

  test('a point with no filesystem fields is still billable', () => {
    // fs_* feeds the chart and the storage bar. CPU and memory are the money.
    const { fs_used_gb, fs_total_gb, ...noFilesystem } = LIVE_POINT
    const [point] = vmUsagePointsFromStat({ points: [noFilesystem] })

    expect(point).toEqual({
      at: Date.parse('2026-08-07T20:25:57Z'),
      cpuCores: 0.02,
      cpuNominalCores: 4,
      memUsedGb: 555114496 / 1024 ** 3,
      memTotalGb: 8,
    })
  })

  test('an empty fleet response yields no points without throwing', () => {
    expect(vmUsagePointsFromStat({ points: [] })).toEqual([])
  })
})
