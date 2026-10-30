import { expect, test } from 'bun:test'

import type { ReactElement } from 'react'

import Page from './page'

// The proxy hands this page the proof it stamped on the return URL. Drive the
// page the way Next does -- an awaited searchParams object -- and read the prop
// the card actually receives, because a page that quietly downgrades an
// unrecognised proof to `undefined` renders a bare form behind a failed
// sign-in, with neither the handoff spinner nor the error.
async function returningFrom(authReturn: string): Promise<unknown> {
  const page = (await Page({
    searchParams: Promise.resolve({ authReturn, returnTo: '/' }),
  })) as ReactElement<{ children: ReactElement<{ returningFrom?: string }> }>
  return page.props.children.props.returningFrom
}

test('the sign-in page hands the card the OAuth return the proxy stamped', async () => {
  expect(await returningFrom('oauth')).toBe('google')
  expect(await returningFrom('magic-link')).toBe('magic-link')
  expect(await returningFrom('not-a-proof')).toBeUndefined()
})
