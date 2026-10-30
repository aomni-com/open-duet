/**
 * The browser half of the signup abuse gate.
 *
 * Duet needs exactly ONE identification, taken on the device that actually
 * completes a signup, because the server counts devices off the verified
 * visitor id rather than off anything the client asserts. That is why this is
 * called just before `/api/duet/session` rather than before the magic link is
 * sent: a link requested on a desktop and opened on a phone should count the
 * phone.
 *
 * chat-app has to identify earlier and thread state through OAuth, but only
 * because its design hashes the email into the identification event. Duet's
 * does not, so both providers converge on this single call site. Do not
 * "restore" the earlier, two-route shape.
 */
export type DeviceIdentification = { visitorId: string; requestId: string }

type GetData = (options?: { ignoreCache?: boolean }) => Promise<{
  visitorId?: string
  requestId?: string
}>

/**
 * Returns `undefined` whenever identification is unavailable — no provider, no
 * key, blocked by an extension, offline. The server treats a missing device as
 * an allow, so this failing costs a signup nothing. That is deliberate: see the
 * fail-open note in the backend's `evidence.ts`.
 */
export async function identifyDevice(
  getData: GetData | undefined,
): Promise<DeviceIdentification | undefined> {
  if (getData === undefined) return undefined
  try {
    const { visitorId, requestId } = await getData()
    if (typeof visitorId !== 'string' || typeof requestId !== 'string') return undefined
    if (visitorId.length === 0 || requestId.length === 0) return undefined
    return { visitorId, requestId }
  } catch {
    return undefined
  }
}
