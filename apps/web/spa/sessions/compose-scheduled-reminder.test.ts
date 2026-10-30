import { expect, test } from 'bun:test'

import { buildScheduledReminderTokens } from './compose-scheduled-reminder'

test('uses chat-app fallback semantics when no wake time is available', () => {
  expect(buildScheduledReminderTokens(undefined, Date.UTC(2026, 7, 3))).toEqual({
    variant: 'noTime',
  })
})

test('uses chat-app relative duration semantics for wakes under an hour away', () => {
  const now = Date.UTC(2026, 7, 3, 12, 0)

  expect(buildScheduledReminderTokens(now + 30 * 60_000, now)).toEqual({
    variant: 'duration',
    duration: '30 minutes',
  })
})

test('uses chat-app wall-clock semantics for a scheduled wake over an hour away', () => {
  const now = new Date(2026, 7, 3, 12, 0).getTime()
  const wakeAt = new Date(2026, 7, 3, 14, 30).getTime()
  const wakeTime = new Date(wakeAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })

  expect(buildScheduledReminderTokens(wakeAt, now)).toEqual({
    variant: 'time',
    time: wakeTime,
  })
})
