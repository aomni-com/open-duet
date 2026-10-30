'use client'

import { useAuthActions, useConvexAuth } from '@convex-dev/auth/react'
import { usePostHog } from '@posthog/next'
import { useCallback, useEffect, useRef, useState } from 'react'

import { SignOutStatus } from '@/components/auth/sign-out-status'
import { completeProductSignOut, revokeProductBrowserSession } from '@/src/auth/sign-out'

export default function Page() {
  const { signOut } = useAuthActions()
  const { isAuthenticated, isLoading } = useConvexAuth()
  const productAnalytics = usePostHog()
  const started = useRef(false)
  const [phase, setPhase] = useState<'signing-out' | 'failed'>('signing-out')
  const run = useCallback(() => {
    setPhase('signing-out')
    void completeProductSignOut({
      revokeBrowserSession: revokeProductBrowserSession,
      resetAnalytics: () => productAnalytics.reset(true),
      clearAuth: async () => {
        if (isAuthenticated) await signOut()
      },
      navigate: () => window.location.replace('/sign-in'),
    }).catch(() => setPhase('failed'))
  }, [isAuthenticated, productAnalytics, signOut])
  useEffect(() => {
    if (isLoading || started.current) return
    started.current = true
    run()
  }, [isLoading, run])
  return (
    <SignOutStatus
      phase={phase}
      onRetry={run}
      onReturn={() => window.location.replace('/sign-in')}
    />
  )
}
