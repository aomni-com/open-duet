import { AUTH_SIGN_IN_PATH, LOCAL_AUTH_ORIGIN } from '@repo/contract'

export function oauthRedirectTo(origin: string, returnTo: string): string {
  const destination = `${AUTH_SIGN_IN_PATH}?returnTo=${encodeURIComponent(returnTo)}`
  return origin === LOCAL_AUTH_ORIGIN ? `${origin}${destination}` : destination
}
