'use client'

import { useCallback, useState } from 'react'

import type {
  MarketplaceAgentInstallRequest,
  MarketplaceAgentSubscriptionResponse,
  MarketplaceListingDetail,
} from '@repo/contract'

import { marketplaceMutationErrorPayload } from '../api/client'
import { requiresInstallConsent } from './consent-sheet'
import { marketplaceNamedInstallRequest, nextMarketplaceInstanceName } from './instance-name'

type InstallMutationLike = {
  mutate: (
    input: MarketplaceAgentInstallRequest,
    callbacks: {
      onSuccess: (response: MarketplaceAgentSubscriptionResponse) => void
      onError: (error: unknown) => void
    },
  ) => void
}

type InstallIntent = 'initial' | 'additional'

type NamingState = {
  listingId: string
  intent: InstallIntent
  initialName: string
  collision: boolean
  consentGranted: boolean
}

type InstallAttempt = {
  input: MarketplaceAgentInstallRequest
  collisionBaseName: string
}

/**
 * THE install ceremony, in order: naming for everyone, consent for unverified
 * publishers, a collision asked only when it happens — with the name the user
 * already chose riding every retry, because losing it would install under the
 * wrong name and say nothing.
 *
 * One owner for that ordering. The gallery's card installs and the detail
 * page's Install button both run through here, so the two surfaces cannot
 * drift into asking different questions in a different order. The playground
 * fixture deliberately scripts its own scenes instead.
 */
export function useMarketplaceInstallFlow(
  install: InstallMutationLike,
  options: { onInstalled?: (response: MarketplaceAgentSubscriptionResponse) => void } = {},
) {
  // The request being named. Holding the request rather than a boolean lets a
  // caller begin the ceremony from a catalog summary — the listing id is the
  // only thing naming needs before the detail arrives.
  const [naming, setNaming] = useState<NamingState | null>(null)
  const [pendingConsent, setPendingConsent] = useState<InstallAttempt | null>(null)

  const cancel = useCallback(() => {
    setNaming(null)
    setPendingConsent(null)
  }, [])

  const run = (attempt: InstallAttempt) => {
    install.mutate(attempt.input, {
      onSuccess: response => {
        cancel()
        options.onInstalled?.(response)
      },
      onError: error => {
        const payload = marketplaceMutationErrorPayload(error)
        if (payload?.error !== 'path_exists') {
          cancel()
          return
        }
        setNaming({
          listingId: attempt.input.listingId,
          intent: 'additional',
          initialName: nextMarketplaceInstanceName(attempt.collisionBaseName),
          collision: true,
          consentGranted: true,
        })
      },
    })
  }

  return {
    naming,
    pendingConsent,
    cancel,
    /** Open the ceremony: ask what to call the agent. */
    begin: (listingId: string, intent: InstallIntent = 'initial') =>
      setNaming({ listingId, intent, initialName: '', collision: false, consentGranted: false }),
    /**
     * The name is in. An empty name means the user declined to type one, so
     * the field is omitted rather than sent blank — the server then names the
     * agent after the listing's slug. Consent stands between the name and the
     * mutation for unverified publishers only.
     */
    named: (detail: MarketplaceListingDetail, name: string) => {
      if (naming === null) return
      const input = marketplaceNamedInstallRequest(naming.intent, naming.listingId, name)
      if (input === undefined) return
      setNaming(null)
      const attempt = { input, collisionBaseName: input.name ?? detail.agentName }
      if (!naming.consentGranted && requiresInstallConsent(detail)) setPendingConsent(attempt)
      else run(attempt)
    },
    confirmConsent: () => {
      if (pendingConsent === null) return
      setPendingConsent(null)
      run(pendingConsent)
    },
  }
}
