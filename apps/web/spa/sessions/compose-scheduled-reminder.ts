import { formatDistanceStrict } from 'date-fns'
import { useEffect, useMemo, useState } from 'react'

export type ScheduledReminderLabel = {
  primary: string
  hint: string
}

export type ScheduledReminderTokens =
  | { variant: 'noTime' }
  | { variant: 'duration'; duration: string }
  | { variant: 'time'; time: string }

export function buildScheduledReminderTokens(
  wakeAt: number | undefined,
  now: number,
): ScheduledReminderTokens {
  if (wakeAt == null) return { variant: 'noTime' }

  const msUntilWake = wakeAt - now
  if (msUntilWake <= 0) return { variant: 'noTime' }

  const ONE_HOUR_MS = 60 * 60 * 1000
  if (msUntilWake < ONE_HOUR_MS) {
    return {
      variant: 'duration',
      duration: formatDistanceStrict(wakeAt, now, { addSuffix: false }),
    }
  }

  return {
    variant: 'time',
    time: new Date(wakeAt).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    }),
  }
}

export function useScheduledReminderLabel(
  aiName: string,
  wakeAt: number | undefined,
  t: (key: string, values?: Record<string, string | number>) => string,
): ScheduledReminderLabel {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (wakeAt == null) return
    const intervalId = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(intervalId)
  }, [wakeAt])

  return useMemo(() => {
    const tokens = buildScheduledReminderTokens(wakeAt, now)
    const hint = t('reminderHint', { name: aiName })
    if (tokens.variant === 'noTime') {
      return { primary: t('reminderNoTime', { name: aiName }), hint }
    }
    if (tokens.variant === 'duration') {
      return {
        primary: t('reminderInDuration', { name: aiName, duration: tokens.duration }),
        hint,
      }
    }
    return { primary: t('reminderAtTime', { name: aiName, time: tokens.time }), hint }
  }, [aiName, now, t, wakeAt])
}
