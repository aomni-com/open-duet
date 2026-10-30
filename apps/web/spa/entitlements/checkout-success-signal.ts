/**
 * Stripe credits a payment through a webhook, so the balance behind the
 * low-credit gate moves some seconds *after* checkout hands the browser back.
 * The return lands on `/settings/billing?billing=success` — and because the
 * gate opens checkout in its own tab, that is never the tab holding the gate.
 * This module carries "the payment went through" from the tab that learns it
 * to every other tab, so the gate can step aside on the payer's word and let
 * the webhook catch up behind it.
 */
export const CHECKOUT_SUCCESS_STORAGE_KEY = 'duet.checkout.success'
export const CHECKOUT_SUCCESS_CHANNEL = 'duet.checkout'

/**
 * How long the gate stays out of the way on the strength of the redirect
 * alone. Long enough to cover a slow webhook, short enough that a payment
 * that never actually settles returns the user to a surface that can retry.
 */
export const CHECKOUT_CELEBRATION_GRACE_MS = 90_000

/**
 * How often to ask the server for the balance during that grace. The webhook
 * usually lands in a second or two; the baseline entitlement poll is far too
 * slow to notice while someone is watching.
 */
export const CHECKOUT_CELEBRATION_POLL_MS = 2_000

type RecordStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

type SignalChannel = { postMessage(message: unknown): void }

type SignalEventTarget = {
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
}

/**
 * A BroadcastChannel deliberately does not echo to the context that posted,
 * yet the tab Stripe redirects back to is itself a tab that should celebrate.
 * These stand in for the echo it will not send.
 */
const localListeners = new Set<(raw: string) => void>()

export function publishCheckoutSuccess(deps: {
  now: number
  userId: string
  storage: RecordStorage
  channel?: SignalChannel
}): void {
  const record = JSON.stringify({ at: deps.now, userId: deps.userId })
  // A tab that is opened, reloaded, or focused after the broadcast has already
  // fired still has to learn about it, so the record outlives the message.
  try {
    deps.storage.setItem(CHECKOUT_SUCCESS_STORAGE_KEY, record)
  } catch {
    // Private-mode storage refuses writes; the live broadcast still lands.
  }
  deps.channel?.postMessage(record)
  for (const deliver of localListeners) deliver(record)
}

/**
 * Spend the record once the server has confirmed the money landed. The grace
 * exists only to cover the gap before the webhook, so leaving it to run out on
 * a timer would let a redeemed payment go on answering for a balance that has
 * since been spent back down.
 */
export function clearCheckoutSuccess(deps: { storage: Pick<RecordStorage, 'removeItem'> }): void {
  try {
    deps.storage.removeItem(CHECKOUT_SUCCESS_STORAGE_KEY)
  } catch {
    // Private-mode storage refuses writes; the in-memory state still resets.
  }
}

/**
 * Reports every arrival of the fact, the standing record included, until the
 * returned callback is invoked. Three paths deliver it — the broadcast for
 * tabs already open, the storage event where no channel exists, and the local
 * list for the publishing tab — and the subscriber judges all three by the one
 * rule in `acceptedAt`, so no path can be believed on terms of its own.
 */
export function subscribeToCheckoutSuccess(
  listener: (at: number) => void,
  deps: {
    now(): number
    userId: string
    storage: RecordStorage
    channel?: SignalEventTarget
    window?: SignalEventTarget
  },
): () => void {
  const accept = (raw: string | null) => {
    const at = acceptedAt(raw, deps.now(), deps.userId)
    if (at !== undefined) listener(at)
  }
  const onMessage: EventListener = event => {
    const { data } = event as MessageEvent
    accept(typeof data === 'string' ? data : null)
  }
  const onStorage: EventListener = event => {
    const stored = event as StorageEvent
    if (stored.key !== CHECKOUT_SUCCESS_STORAGE_KEY) return
    accept(stored.newValue)
  }

  try {
    accept(deps.storage.getItem(CHECKOUT_SUCCESS_STORAGE_KEY))
  } catch {
    // Private-mode storage refuses reads; only live arrivals will be heard.
  }
  localListeners.add(accept)
  deps.channel?.addEventListener('message', onMessage)
  deps.window?.addEventListener('storage', onStorage)
  return () => {
    localListeners.delete(accept)
    deps.channel?.removeEventListener('message', onMessage)
    deps.window?.removeEventListener('storage', onStorage)
  }
}

/**
 * The one rule every arrival passes. A record answers for the person who made
 * it and for nobody else — browser storage outlives a sign-out, so without
 * that the next person on the machine inherits a payment they never made —
 * and it answers only while the grace it opened still stands.
 */
function acceptedAt(raw: string | null, now: number, userId: string): number | undefined {
  if (raw === null) return undefined
  let record: unknown
  try {
    record = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (
    typeof record !== 'object' ||
    record === null ||
    !('userId' in record) ||
    record.userId !== userId ||
    !('at' in record)
  )
    return undefined
  const at = record.at
  if (typeof at !== 'number' || !Number.isFinite(at)) return undefined
  // A clock that jumped backwards must not hand out an unbounded grace.
  if (now < at || now - at > CHECKOUT_CELEBRATION_GRACE_MS) return undefined
  return at
}
