import { describe, expect, test } from 'bun:test'

import { hasCompletedAfterCwdFallback } from './staging-live-trial-recommission'

describe('trial recommission staging acceptance', () => {
  test('accepts completion after the durable cwd fallback warning', () => {
    expect(
      hasCompletedAfterCwdFallback([
        { seq: 5, event: { type: 'prompt_submitted' } },
        {
          seq: 6,
          event: { type: 'system', metadata: { code: 'session_cwd_fallback' } },
        },
        { seq: 7, event: { type: 'turn_started' } },
        { seq: 8, event: { type: 'complete' } },
      ]),
    ).toBe(true)
  })

  test('rejects a warning without a later terminal response', () => {
    expect(
      hasCompletedAfterCwdFallback([
        { seq: 5, event: { type: 'complete' } },
        {
          seq: 6,
          event: { type: 'system', metadata: { code: 'session_cwd_fallback' } },
        },
        { seq: 7, event: { type: 'turn_started' } },
      ]),
    ).toBe(false)
  })
})
