'use client'

import { useTranslations } from 'next-intl'
import { useEffect, useRef } from 'react'

import {
  advanceVersionWatch,
  appUpdateToast,
  INITIAL_VERSION_WATCH,
  probeAppVersion,
} from './app-version'
import { useToast } from './toast'

/**
 * Tell a long-lived tab when the deployment underneath it has been replaced.
 *
 * The SPA can stay mounted for days, so a promotion leaves it running code the
 * origin no longer serves — old bundles, old assumptions about the API. Nothing
 * forces a reload; the tab only learns by asking, which it does on a slow timer
 * and whenever the user comes back to it.
 */
export function VersionChecker() {
  const t = useTranslations('duetAppUpdate')
  const showToast = useToast()
  const watch = useRef(INITIAL_VERSION_WATCH)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    const check = async () => {
      const observed = await probeAppVersion(controller.signal)
      if (cancelled) return
      const next = advanceVersionWatch(watch.current, observed)
      watch.current = next.watch
      if (next.shouldNotify) showToast(appUpdateToast(t, () => window.location.reload()))
    }

    void check()
    // 5 minutes: nothing here is urgent — a tab that learns late still reloads
    // on the user's terms — and every open tab in the fleet calls this route.
    const interval = window.setInterval(() => void check(), 5 * 60 * 1000)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelled = true
      controller.abort()
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [showToast, t])

  return null
}
