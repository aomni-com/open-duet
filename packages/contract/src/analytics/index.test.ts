import { describe, expect, test } from 'bun:test'

import {
  ANALYTICS_EVENT_NAMES,
  AUDIT_EVENT_NAMES,
  AnalyticsEventSchema,
  CONVERSION_TRIGGER_EVENT_NAMES,
  type AnalyticsEvent,
} from './index'

describe('analytics event contract', () => {
  test('accepts a canonical event with finite JSON properties', () => {
    const event: AnalyticsEvent = {
      id: 'event-1',
      name: 'onboarding.started',
      version: 1,
      at: 1_723_000_000_000,
      origin: 'product_browser',
      userId: 'user-1',
      workspaceId: 'workspace-1',
      properties: {
        step: 1,
        nested: { ready: true },
        labels: ['new', null],
      },
    }

    expect(AnalyticsEventSchema.parse(event)).toEqual(event)
  })

  test('rejects undefined, non-finite numbers, and cycles anywhere in properties', () => {
    const event = {
      id: 'event-1',
      name: 'onboarding.started',
      version: 1,
      at: 1,
      origin: 'product_browser',
      properties: {},
    } as const
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    for (const properties of [
      { value: undefined },
      { value: Array(1) },
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      cyclic,
    ]) {
      expect(AnalyticsEventSchema.safeParse({ ...event, properties }).success).toBe(false)
    }
  })

  test('accepts exactly 64 KiB of serialized properties and rejects one byte more', () => {
    const event = {
      id: 'event-1',
      name: 'onboarding.started',
      version: 1,
      at: 1,
      origin: 'product_browser',
      userId: 'user-1',
    } as const
    const objectFramingBytes = new TextEncoder().encode(JSON.stringify({ value: '' })).byteLength

    expect(
      AnalyticsEventSchema.safeParse({
        ...event,
        properties: { value: 'x'.repeat(64 * 1024 - objectFramingBytes) },
      }).success,
    ).toBe(true)
    expect(
      AnalyticsEventSchema.safeParse({
        ...event,
        properties: { value: 'x'.repeat(64 * 1024 - objectFramingBytes + 1) },
      }).success,
    ).toBe(false)
  })

  test('derives audit and conversion-trigger inventories from the canonical names', () => {
    expect(AUDIT_EVENT_NAMES.every(name => ANALYTICS_EVENT_NAMES.includes(name))).toBe(true)
    expect(CONVERSION_TRIGGER_EVENT_NAMES).toEqual(
      ANALYTICS_EVENT_NAMES.filter(name => name !== 'conversion.evaluated'),
    )
    expect(CONVERSION_TRIGGER_EVENT_NAMES).not.toContain('conversion.evaluated')
  })
})
