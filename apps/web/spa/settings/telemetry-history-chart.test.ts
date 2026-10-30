import { describe, expect, test } from 'bun:test'

import { telemetryLinePath, telemetryTimeRange } from './telemetry-history-chart'

describe('telemetry chart geometry', () => {
  test('positions samples by elapsed time so outages remain visible', () => {
    expect(
      telemetryLinePath(
        [
          { at: 0, cpuPct: 10 },
          { at: 10, cpuPct: 20 },
          { at: 100, cpuPct: 30 },
        ],
        'cpuPct',
        100,
      ),
    ).toBe('M0 51.2 L30 46.4 L300 41.6')
  })

  test('labels the temporal midpoint rather than the middle sample', () => {
    expect(telemetryTimeRange([{ at: 0 }, { at: 10 }, { at: 100 }])).toEqual({
      firstAt: 0,
      middleAt: 50,
      lastAt: 100,
    })
  })
})
