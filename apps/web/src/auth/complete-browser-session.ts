import { WorkspaceMemberAdmissionRefusalSchema } from '@repo/contract'

import { validateUnsafeRequest } from '../server/duet-proxy'
import { reportRequestFailure } from '../server/request-failure'
import { clearCampaignHandoffCookie } from './campaign-handoff'
import { clearPendingInviteCookie } from './pending-invite'

export interface BrowserBootstrapTokens {
  invite?: string
  acquisition?: string
}

/** What the browser observed about itself, for the signup abuse gate. */
export interface BrowserDeviceIdentification {
  visitorId: string
  requestId: string
}

export async function completeBrowserSession(args: {
  request: Request
  tokens?: BrowserBootstrapTokens
  bootstrap: (
    tokens?: BrowserBootstrapTokens,
    device?: BrowserDeviceIdentification,
  ) => Promise<{ workspaceSlug: string; invited: boolean }>
  exchange: (request: Request) => Promise<Response>
}): Promise<Response> {
  const unsafeResponse = validateUnsafeRequest(args.request)
  if (unsafeResponse !== null) return unsafeResponse

  // Unreadable or absent device evidence is not an error: the gate fails open
  // on a missing device, so a client that cannot identify still signs up.
  const body = (await args.request
    .clone()
    .json()
    .catch(() => null)) as {
    device?: unknown
  } | null
  const device = readDeviceIdentification(body?.device)

  let invitationDestination: string | undefined
  try {
    const result = await args.bootstrap(args.tokens, device)
    if (result.invited) invitationDestination = `/w/${encodeURIComponent(result.workspaceSlug)}`
  } catch (error) {
    // The browser boundary receives an error-shaped value from the identity
    // adapter; it must not import the backend transport class to understand
    // the public refusal payload carried in `data`.
    const capacity = WorkspaceMemberAdmissionRefusalSchema.safeParse(errorData(error))
    if (!capacity.success) reportRequestFailure(args.request, 'bootstrap_failed', error)
    return new Response(
      JSON.stringify(capacity?.success === true ? capacity.data : { error: 'bootstrap_failed' }),
      {
        status: capacity?.success === true ? 409 : 400,
        headers: {
          'content-type': 'application/json',
          ...(args.tokens?.invite === undefined
            ? {}
            : { 'set-cookie': clearPendingInviteCookie() }),
        },
      },
    )
  }
  const response = await args.exchange(args.request)
  if (!response.ok) return response
  if (invitationDestination !== undefined) {
    response.headers.set('location', invitationDestination)
  }
  if (args.tokens?.invite !== undefined) {
    response.headers.append('set-cookie', clearPendingInviteCookie())
  }
  if (args.tokens?.acquisition !== undefined) {
    response.headers.append('set-cookie', clearCampaignHandoffCookie())
  }
  return response
}

function errorData(error: unknown): unknown {
  return error !== null && typeof error === 'object' && 'data' in error
    ? (error as { data?: unknown }).data
    : undefined
}

function readDeviceIdentification(device: unknown): BrowserDeviceIdentification | undefined {
  if (device === null || typeof device !== 'object') return undefined
  const { visitorId, requestId } = device as Record<string, unknown>
  if (typeof visitorId !== 'string' || typeof requestId !== 'string') return undefined
  if (visitorId.length === 0 || requestId.length === 0) return undefined
  return { visitorId, requestId }
}
