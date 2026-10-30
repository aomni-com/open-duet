import { authReturnFromProof } from '../../src/auth/auth-code-proof'
import { safeReturnTo } from '../../src/auth/return-to'
import { DeviceIdentificationProvider } from './device-identification-provider'
import { SignInClient } from './sign-in-client'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{
    authError?: string
    authReturn?: string
    invited?: string
    returnTo?: string
  }>
}) {
  const { authError, authReturn, invited, returnTo } = await searchParams
  const destination = safeReturnTo(returnTo)
  return (
    <DeviceIdentificationProvider>
      <SignInClient
        failed={authError === 'invalid-link'}
        invited={invited === '1'}
        returningFrom={authReturnFromProof(authReturn)}
        returnTo={destination}
      />
    </DeviceIdentificationProvider>
  )
}
