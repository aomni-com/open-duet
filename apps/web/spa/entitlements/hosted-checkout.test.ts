import { expect, test } from 'bun:test'

import { HostedCheckoutPopupBlockedError, openHostedCheckout } from './hosted-checkout'

test('reserves the checkout tab before asking the server for its URL', async () => {
  const events: string[] = []
  const tab = {
    close: () => events.push('close'),
    location: { replace: (url: string) => events.push(`navigate:${url}`) },
    opener: {} as Window,
  }
  let resolveUrl!: (url: string) => void
  const url = new Promise<string>(resolve => {
    resolveUrl = resolve
  })

  const launched = openHostedCheckout(
    () => {
      events.push('request')
      return url
    },
    {
      open: (url, target) => {
        events.push(`open:${url}:${target}`)
        return tab
      },
    },
  )

  expect(events).toEqual(['open:about:blank:_blank', 'request'])
  resolveUrl('https://checkout.stripe.test/session')
  await launched
  expect(events).toEqual([
    'open:about:blank:_blank',
    'request',
    'navigate:https://checkout.stripe.test/session',
  ])
  expect(tab.opener).toBeNull()
})

test('each retry reserves a fresh browsing context instead of reusing a Stripe tab', async () => {
  const targets: (string | undefined)[] = []
  const browser = {
    open: (_url?: string | URL, target?: string) => {
      targets.push(target)
      return {
        close: () => {},
        location: { replace: () => {} },
        opener: null,
      }
    },
  }

  await openHostedCheckout(async () => 'https://checkout.stripe.test/first', browser)
  await openHostedCheckout(async () => 'https://checkout.stripe.test/retry', browser)

  expect(targets).toEqual(['_blank', '_blank'])
})

test('a blocked popup never creates a checkout the user cannot reach', async () => {
  let requests = 0
  const launched = openHostedCheckout(
    async () => {
      requests += 1
      return 'https://checkout.stripe.test/unreachable'
    },
    { open: () => null },
  )

  await expect(launched).rejects.toBeInstanceOf(HostedCheckoutPopupBlockedError)
  expect(requests).toBe(0)
})

test('a failed checkout request closes its reserved blank tab', async () => {
  let closed = false
  const failure = new Error('checkout unavailable')
  const launched = openHostedCheckout(
    async () => {
      throw failure
    },
    {
      open: () => ({
        close: () => {
          closed = true
        },
        location: { replace: () => {} },
        opener: null,
      }),
    },
  )

  await expect(launched).rejects.toBe(failure)
  expect(closed).toBe(true)
})
