'use client'

import { useAuthActions, useConvexAuth } from '@convex-dev/auth/react'
import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useRef, useState } from 'react'

import { AuthCard, type AuthCardCopy, type AuthCardPhase } from '../../components/auth/auth-card'
import { DuetMark } from '../../components/brand/duet-mark'
import type { AuthReturn } from '../../src/auth/auth-code-proof'
import { oauthRedirectTo } from '../../src/auth/oauth-redirect'
import { safeReturnTo } from '../../src/auth/return-to'
import { useIdentifyDevice } from './device-identification-provider'
import { SignInShowcase } from './sign-in-showcase'

export function SignInClient({
  failed,
  invited,
  returningFrom,
  returnTo,
}: {
  failed: boolean
  invited: boolean
  returningFrom?: AuthReturn
  returnTo: string
}) {
  const t = useTranslations('signIn.card')
  const locale = useLocale()
  const { signIn } = useAuthActions()
  const { isAuthenticated, isLoading } = useConvexAuth()
  const [email, setEmail] = useState('')
  const [phase, setPhase] = useState<AuthCardPhase>(
    returningFrom === 'google'
      ? 'google-return'
      : returningFrom === 'magic-link'
        ? 'magic-return'
        : 'idle',
  )
  const [error, setError] = useState<string | undefined>(
    failed ? t('errors.signInFailed') : undefined,
  )
  const sessionStarted = useRef(false)
  // Identification runs once, immediately before the session call below, on
  // whichever device actually completes the signup. Both providers land here,
  // so this is the only identification site in the product.
  const identifyDevice = useIdentifyDevice()

  useEffect(() => {
    if (isLoading) return
    if (!isAuthenticated) {
      if (returningFrom !== undefined) {
        setPhase('idle')
        setError(t('errors.signInFailed'))
      }
      return
    }
    if (sessionStarted.current) return
    sessionStarted.current = true
    setPhase('preparing-workspace')
    void identifyDevice()
      .then(device =>
        fetch('/api/duet/session', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(device === undefined ? {} : { device }),
        }),
      )
      .then(response => {
        if (!response.ok) {
          sessionStarted.current = false
          setPhase('idle')
          setError(t(invited ? 'errors.invitationFailed' : 'errors.signInFailed'))
          return
        }
        window.location.replace(safeReturnTo(response.headers.get('location') ?? returnTo))
      })
      .catch(() => {
        sessionStarted.current = false
        setPhase('idle')
        setError(t('errors.signInFailed'))
      })
  }, [identifyDevice, invited, isAuthenticated, isLoading, returnTo, returningFrom, t])

  const google = async () => {
    setError(undefined)
    setPhase('google-return')
    const redirectTo = oauthRedirectTo(window.location.origin, returnTo)
    const result = await signIn('google', { redirectTo }).catch(() => null)
    if (result?.redirect) window.location.assign(result.redirect)
    if (result === null) {
      setPhase('idle')
      setError(t('errors.googleFailed'))
    }
  }

  const magicLink = async () => {
    if (!email.trim()) {
      setError(t('errors.missingEmail'))
      return
    }
    setPhase('sending-link')
    setError(undefined)
    const response = await fetch('/api/auth/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), returnTo }),
    }).catch(() => null)
    if (response === null || !response.ok) {
      setPhase('idle')
      setError(t('errors.emailFailed'))
      return
    }
    setPhase('email-sent')
  }

  const copy: AuthCardCopy = {
    invitationLabel: t('invitationLabel'),
    invitedTitle: t('invitedTitle'),
    defaultTitle: t('defaultTitle'),
    invitedDescription: t('invitedDescription'),
    defaultDescription: t('defaultDescription'),
    sentTitle: t('sentTitle'),
    sentPrefix: t('sentPrefix'),
    googleReturnTitle: t('googleReturnTitle'),
    magicReturnTitle: t('magicReturnTitle'),
    returnDescription: t('returnDescription'),
    preparingTitle: t('preparingTitle'),
    preparingDescription: t('preparingDescription'),
    continueWithGoogle: t('continueWithGoogle'),
    or: t('or'),
    emailLabel: t('emailLabel'),
    emailPlaceholder: t('emailPlaceholder'),
    emailLink: t('emailLink'),
    legalPrefix: t('legalPrefix'),
    legalTerms: t('legalTerms'),
    legalJoiner: t('legalJoiner'),
    legalPrivacy: t('legalPrivacy'),
    legalSuffix: t('legalSuffix'),
  }
  const handoffInProgress =
    phase === 'google-return' || phase === 'magic-return' || phase === 'preparing-workspace'

  return (
    <main className="min-h-screen bg-background lg:grid lg:grid-cols-[minmax(0,1.15fr)_minmax(27rem,0.85fr)]">
      <SignInShowcase />

      <section className="flex min-h-screen flex-col bg-background">
        <header className="flex items-center gap-2.5 px-6 pt-[max(1.5rem,env(safe-area-inset-top))] sm:px-10 sm:pt-8">
          <DuetMark active={handoffInProgress} priority size="sm" />
          <span className="text-sm font-semibold tracking-tight">Duet</span>
        </header>

        <div className="flex flex-1 items-start justify-center px-6 pb-[max(2rem,env(safe-area-inset-bottom))] pt-16 sm:px-10 sm:pt-24 lg:items-center lg:py-10">
          <div className="w-full max-w-sm">
            <AuthCard
              surface="plain"
              invited={invited}
              email={email}
              phase={phase}
              error={error}
              copy={copy}
              publicSiteLocale={locale}
              onEmailChange={setEmail}
              onGoogle={() => void google()}
              onMagicLink={() => void magicLink()}
            />
          </div>
        </div>
      </section>
    </main>
  )
}
