export class HostedCheckoutPopupBlockedError extends Error {
  constructor() {
    super('The browser blocked the checkout tab')
    this.name = 'HostedCheckoutPopupBlockedError'
  }
}

type ReservedCheckoutTab = {
  close(): void
  location: { replace(url: string): void }
  opener: unknown
}

type CheckoutBrowser = {
  open(url?: string | URL, target?: string, features?: string): ReservedCheckoutTab | null
}

/**
 * Reserve the tab while the click still owns the browser gesture. Hosted
 * checkout creation takes a round trip; waiting for it before `open` turns a
 * valid click into a popup in strict browsers and strands an undismissible
 * recovery gate.
 */
export async function openHostedCheckout(
  createUrl: () => Promise<string>,
  browser: CheckoutBrowser = window,
): Promise<void> {
  const checkout = browser.open('about:blank', '_blank')
  if (checkout === null) throw new HostedCheckoutPopupBlockedError()

  try {
    checkout.opener = null
    checkout.location.replace(await createUrl())
  } catch (error) {
    checkout.close()
    throw error
  }
}
