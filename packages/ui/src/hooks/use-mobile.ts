'use client'

import { useSyncExternalStore } from 'react'

const MOBILE_QUERY = '(max-width: 767px)'

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const media = window.matchMedia(MOBILE_QUERY)
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}

function getSnapshot(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}
