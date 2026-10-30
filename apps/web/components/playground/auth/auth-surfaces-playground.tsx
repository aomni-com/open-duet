import { useState } from 'react'

import englishAuth from '../../../messages/en/auth.json'
import { AuthCard, type AuthCardPhase } from '../../auth/auth-card'
import { SignOutStatus } from '../../auth/sign-out-status'

const authCardCopy = englishAuth.signIn.card

export function AuthSurfacesPlayground() {
  const [phase, setPhase] = useState<AuthCardPhase | 'overview' | 'sign-out-failure'>('overview')
  return (
    <div className="min-h-screen bg-sidebar p-5 sm:p-8">
      <nav className="sr-only" aria-label="Authentication fixture scenarios">
        <button onClick={() => setPhase('google-return')}>Auth scenario: Google return</button>
        <button onClick={() => setPhase('preparing-workspace')}>
          Auth scenario: workspace preparation
        </button>
        <button onClick={() => setPhase('overview')}>Auth scenario: overview</button>
        <button onClick={() => setPhase('sign-out-failure')}>
          Auth scenario: sign-out failure
        </button>
      </nav>
      {phase === 'sign-out-failure' ? (
        <div className="-m-5 sm:-m-8">
          <SignOutStatus phase="failed" />
        </div>
      ) : (
        <div
          className={
            phase === 'overview'
              ? 'mx-auto grid max-w-6xl items-start justify-items-center gap-8 lg:grid-cols-2'
              : 'mx-auto grid max-w-md place-items-center'
          }
        >
          <AuthCard email="" phase={phase === 'overview' ? 'idle' : phase} copy={authCardCopy} />
          {phase === 'overview' ? (
            <>
              <AuthCard
                invited
                email="new-teammate@example.com"
                phase="email-sent"
                copy={authCardCopy}
              />
              <AuthCard
                email="person@example.com"
                error={authCardCopy.errors.signInFailed}
                copy={authCardCopy}
              />
            </>
          ) : null}
        </div>
      )}
    </div>
  )
}
