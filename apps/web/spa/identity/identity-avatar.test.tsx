/* A person's face is drawn, not spelled.

   It used to be the first letter of the name on a slate gradient, which made
   every user in a workspace a different letter in the same badge — and made two
   people whose names start with the same letter indistinguishable. The face is
   generated from the name instead, so it is stable per person and different
   between people, and there is no text on it at all. */
import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { createUserAvatarDataUri, UserAvatar } from './identity-avatar'

test('creates a deterministic local face from the name it is given', () => {
  const walter = createUserAvatarDataUri('Walter Monecke')

  expect(walter).toStartWith('data:image/svg+xml')
  expect(createUserAvatarDataUri('  walter monecke ')).toBe(walter)
  expect(createUserAvatarDataUri('Grace Hopper')).not.toBe(walter)
  expect(walter).not.toContain('api.dicebear.com')
})

test('a user avatar renders a local SVG image rather than an initial', () => {
  const html = renderToStaticMarkup(<UserAvatar name="Walter Monecke" className="size-10" />)

  expect(html).toContain('data-identity-avatar="user"')
  expect(html).toContain('data:image/svg+xml')
  // The initial it replaced. Two people called Walter and Wendy shared it.
  expect(html).not.toContain('>W<')
})
