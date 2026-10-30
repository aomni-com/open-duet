export function oauthVerifierCookieName(requestUrl: string): string {
  return new URL(requestUrl).protocol === 'https:'
    ? '__Host-__convexAuthOAuthVerifier'
    : '__convexAuthOAuthVerifier'
}

export function clearOAuthVerifierCookie(requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === 'https:'
  return [
    `${oauthVerifierCookieName(requestUrl)}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    secure ? 'Secure' : '',
  ]
    .filter(Boolean)
    .join('; ')
}
