import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import englishAuth from '../../messages/en/auth.json'
import { AuthCard } from './auth-card'

const copy = englishAuth.signIn.card

test('the card keeps sign-in recovery self-serve', () => {
  const failed = renderToStaticMarkup(
    <AuthCard
      email="person@example.com"
      copy={copy}
      error={copy.errors.signInFailed}
    />,
  )
  expect(failed).toContain(copy.errors.signInFailed)
  expect(failed).not.toMatch(/cal\.com|book a call|booking/i)

  const welcome = renderToStaticMarkup(<AuthCard email="" copy={copy} />)
  expect(welcome).not.toMatch(/cal\.com|book a call|booking/i)
})
