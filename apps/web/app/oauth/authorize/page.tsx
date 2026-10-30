'use client'

import { useSearchParams } from 'next/navigation'

import { OAuthConsentController, oauthAuthorizationRequestId } from './controller'

export default function Page() {
  const searchParams = useSearchParams()
  return <OAuthConsentController requestId={oauthAuthorizationRequestId(searchParams)} />
}
