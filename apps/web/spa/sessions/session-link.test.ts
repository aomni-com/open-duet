import { expect, test } from 'bun:test'

import { sessionLinkTarget } from './session-link'

const ORIGIN = 'https://app.duet.so'

test('same-origin root-relative path routes in-app with path, search, and hash preserved', () => {
  expect(sessionLinkTarget('/w/acme/agents/research', ORIGIN)).toEqual({
    kind: 'in-app',
    to: '/w/acme/agents/research',
  })
  expect(sessionLinkTarget('/w/acme/sessions?q=1#top', ORIGIN)).toEqual({
    kind: 'in-app',
    to: '/w/acme/sessions?q=1#top',
  })
})

test('same-origin absolute URL routes in-app, stripped to a router-relative path', () => {
  expect(sessionLinkTarget('https://app.duet.so/w/acme/agents/research', ORIGIN)).toEqual({
    kind: 'in-app',
    to: '/w/acme/agents/research',
  })
})

test('a different origin stays external and keeps the original href', () => {
  expect(sessionLinkTarget('https://example.com/docs', ORIGIN)).toEqual({
    kind: 'external',
    href: 'https://example.com/docs',
  })
})

test('a protocol-relative link to another host stays external', () => {
  expect(sessionLinkTarget('//example.com/docs', ORIGIN)).toEqual({
    kind: 'external',
    href: '//example.com/docs',
  })
})

test('a protocol-relative link to the same host routes in-app', () => {
  expect(sessionLinkTarget('//app.duet.so/w/acme/agents/research', ORIGIN)).toEqual({
    kind: 'in-app',
    to: '/w/acme/agents/research',
  })
})

test('mailto: stays external', () => {
  expect(sessionLinkTarget('mailto:team@duet.so', ORIGIN)).toEqual({
    kind: 'external',
    href: 'mailto:team@duet.so',
  })
})

test('an unparseable link stays external rather than throwing', () => {
  expect(sessionLinkTarget('http://[bad', ORIGIN)).toEqual({
    kind: 'external',
    href: 'http://[bad',
  })
})
