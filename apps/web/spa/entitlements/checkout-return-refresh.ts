/**
 * Browser focus and visibility commonly fire together when a checkout tab
 * hands control back. Share that server round trip instead of turning one
 * return into two identity refreshes.
 */
export function createCheckoutReturnRefresher(
  refresh: () => Promise<unknown>,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined
  return () => {
    if (inFlight !== undefined) return inFlight
    try {
      inFlight = refresh()
        .then(() => {})
        .finally(() => {
          inFlight = undefined
        })
    } catch (error) {
      return Promise.reject(error)
    }
    return inFlight
  }
}
