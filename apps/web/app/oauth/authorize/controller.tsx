'use client'

import { useEffect, useState } from 'react'

import type {
  OAuthConsentApproveResponse,
  OAuthConsentDenyResponse,
  OAuthConsentInspectResponse,
} from '@repo/contract'

import { OAuthConsentScreen } from '../../../components/auth/oauth-consent-card'
import { duetApi, DuetApiError, type DuetApiClient } from '../../../spa/api/client'

type OAuthApprovalApi = Pick<DuetApiClient, 'approveOAuthAuthorization'>
type OAuthDenialApi = Pick<DuetApiClient, 'denyOAuthAuthorization'>

export function oauthAuthorizationRequestId(
  searchParams: Pick<URLSearchParams, 'get'>,
): string | undefined {
  return searchParams.get('request') ?? undefined
}

export function oauthAuthorizationReturnTo(requestId: string): string {
  const search = new URLSearchParams({ request: requestId })
  return `/oauth/authorize?${search.toString()}`
}

export function autoSelectedOAuthWorkspaceSlug(
  inspection: Pick<OAuthConsentInspectResponse, 'workspaces'>,
): string | undefined {
  return inspection.workspaces.length === 1 ? inspection.workspaces[0]?.slug : undefined
}

export async function approveOAuthConsent(
  api: OAuthApprovalApi,
  requestId: string,
  workspaceSlug: string,
  navigate: (url: string) => void,
): Promise<void> {
  const completion: OAuthConsentApproveResponse = await api.approveOAuthAuthorization(
    requestId,
    workspaceSlug,
  )
  navigate(completion.redirectUrl)
}

export async function denyOAuthConsent(
  api: OAuthDenialApi,
  requestId: string,
  navigate: (url: string) => void,
): Promise<void> {
  const completion: OAuthConsentDenyResponse = await api.denyOAuthAuthorization(requestId)
  navigate(completion.redirectUrl)
}

export function OAuthConsentController({ requestId }: { requestId?: string }) {
  const [inspection, setInspection] = useState<OAuthConsentInspectResponse>()
  const [selectedSlug, setSelectedSlug] = useState<string>()
  const [busy, setBusy] = useState(requestId !== undefined)
  const [message, setMessage] = useState(
    requestId === undefined ? 'This authorization request is unavailable.' : undefined,
  )

  useEffect(() => {
    if (requestId === undefined) return
    const abortController = new AbortController()
    setInspection(undefined)
    setSelectedSlug(undefined)
    setBusy(true)
    setMessage(undefined)
    void duetApi
      .inspectOAuthAuthorization(requestId, abortController.signal)
      .then(result => {
        setInspection(result)
        setSelectedSlug(autoSelectedOAuthWorkspaceSlug(result))
        setBusy(false)
      })
      .catch(error => {
        if (abortController.signal.aborted) return
        if (error instanceof DuetApiError && error.status === 401) {
          const returnTo = oauthAuthorizationReturnTo(requestId)
          window.location.assign(`/sign-in?returnTo=${encodeURIComponent(returnTo)}`)
          return
        }
        setMessage(oauthConsentFailureMessage(error))
        setBusy(false)
      })
    return () => abortController.abort()
  }, [requestId])

  const complete = async (action: 'approve' | 'deny') => {
    if (requestId === undefined) return
    let operation: () => Promise<void>
    if (action === 'approve') {
      const workspaceSlug = selectedSlug
      if (workspaceSlug === undefined) return
      operation = () =>
        approveOAuthConsent(duetApi, requestId, workspaceSlug, url => window.location.assign(url))
    } else {
      operation = () => denyOAuthConsent(duetApi, requestId, url => window.location.assign(url))
    }
    setBusy(true)
    setMessage(undefined)
    try {
      await operation()
    } catch (error) {
      setMessage(oauthConsentFailureMessage(error))
      setBusy(false)
    }
  }

  return (
    <OAuthConsentScreen
      inspection={inspection}
      selectedSlug={selectedSlug}
      busy={busy}
      message={message}
      onSelect={setSelectedSlug}
      onApprove={() => void complete('approve')}
      onDeny={() => void complete('deny')}
    />
  )
}

function oauthConsentFailureMessage(error: unknown): string {
  if (error instanceof DuetApiError) {
    if (error.status === 410) return 'This authorization request has expired. Start again.'
    if (error.status === 409) return 'This authorization request has already been completed.'
  }
  return 'This authorization request is unavailable.'
}
