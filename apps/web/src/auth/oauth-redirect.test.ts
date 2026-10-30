import { describe, expect, test } from 'bun:test'

import { oauthRedirectTo } from './oauth-redirect'

describe('Google OAuth return destination', () => {
  test('returns Google to localhost when sign-in starts on localhost', () => {
    expect(oauthRedirectTo('http://localhost:3000', '/w/acme/sessions')).toBe(
      'http://localhost:3000/sign-in?returnTo=%2Fw%2Facme%2Fsessions',
    )
  })

  test('keeps deployed and preview sign-in destinations relative', () => {
    expect(oauthRedirectTo('https://app-staging.duet.so', '/w/acme/sessions')).toBe(
      '/sign-in?returnTo=%2Fw%2Facme%2Fsessions',
    )
    expect(oauthRedirectTo('https://preview.example', '/')).toBe('/sign-in?returnTo=%2F')
  })
})
