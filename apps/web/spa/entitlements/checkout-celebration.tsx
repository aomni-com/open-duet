'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { CelebrationBurst, CONFETTI_FALL_MS } from '@repo/ui/components/common/full-screen-confetti'

import { useSpa } from '../context'
import {
  CHECKOUT_CELEBRATION_GRACE_MS,
  CHECKOUT_SUCCESS_CHANNEL,
  clearCheckoutSuccess,
  publishCheckoutSuccess,
  subscribeToCheckoutSuccess,
} from './checkout-success-signal'

function openSuccessChannel(): BroadcastChannel | undefined {
  if (typeof BroadcastChannel === 'undefined') return undefined
  try {
    return new BroadcastChannel(CHECKOUT_SUCCESS_CHANNEL)
  } catch {
    return undefined
  }
}

/**
 * Hands the fact to every listener in this browser: the tabs already open hear
 * the broadcast, and one opened later reads the record.
 */
export function announceCheckoutSuccess(userId: string): void {
  const channel = openSuccessChannel()
  publishCheckoutSuccess({ now: Date.now(), userId, storage: window.localStorage, channel })
  channel?.close()
}

/**
 * Subscribes to the success fact for as long as the component lives, reporting
 * both the moment it arrives and whether one is still standing.
 */
function useCheckoutSuccess(resetKey?: string): { at: number | undefined; forget: () => void } {
  const { identity } = useSpa()
  const userId = identity.user.id
  const [at, setAt] = useState<number>()

  useEffect(() => {
    setAt(undefined)
    const channel = openSuccessChannel()
    const stop = subscribeToCheckoutSuccess(setAt, {
      now: () => Date.now(),
      userId,
      storage: window.localStorage,
      channel,
      window,
    })
    return () => {
      stop()
      channel?.close()
    }
  }, [userId, resetKey])

  useEffect(() => {
    if (at === undefined) return
    const remaining = at + CHECKOUT_CELEBRATION_GRACE_MS - Date.now()
    if (remaining <= 0) {
      setAt(undefined)
      return
    }
    const timer = setTimeout(() => setAt(undefined), remaining)
    return () => clearTimeout(timer)
  }, [at])

  const forget = useCallback(() => {
    clearCheckoutSuccess({ storage: window.localStorage })
    setAt(undefined)
  }, [])

  return { at, forget }
}

/**
 * Whether a checkout this browser completed is still owed the benefit of the
 * doubt, and the way to settle that debt once the server confirms the money.
 * False during SSR and on the first client render, so the markup hydrates
 * against the same surface the server drew.
 */
export function useCheckoutCelebration(resetKey?: string): {
  celebrating: boolean
  redeem: () => void
} {
  const { at, forget } = useCheckoutSuccess(resetKey)
  return { celebrating: at !== undefined, redeem: forget }
}

/**
 * Plays once per payment, driven by the arrival of the fact rather than by the
 * grace still standing — a webhook that lands quickly redeems that grace within
 * a second or two, and the burst it was thrown for has to outlive it. It waits
 * for the tab to be looked at: checkout runs in a tab of its own, so the
 * workspace behind it is usually hidden at the moment the payment lands, and
 * confetti thrown at an unwatched tab is confetti nobody sees.
 */
export function CheckoutCelebrationOverlay() {
  const { at } = useCheckoutSuccess()
  const [bursting, setBursting] = useState(false)
  const played = useRef<number>(undefined)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    if (at === undefined || played.current === at) return
    const play = () => {
      if (played.current === at || document.visibilityState !== 'visible') return
      played.current = at
      setBursting(true)
      timer.current = setTimeout(() => setBursting(false), CONFETTI_FALL_MS)
    }
    play()
    document.addEventListener('visibilitychange', play)
    return () => document.removeEventListener('visibilitychange', play)
  }, [at])

  useEffect(() => () => clearTimeout(timer.current), [])

  return <CelebrationBurst playing={bursting} />
}
