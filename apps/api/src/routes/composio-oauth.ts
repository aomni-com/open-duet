import {
  decodeSignedDescriptor,
  encodeSignedDescriptor,
  hasExactlyKeys,
  isNonEmptyString,
} from '../signed-descriptor'

const USER_CONNECT_DESCRIPTOR_TTL_MS = 10 * 60 * 1_000
const CALLBACK_DESCRIPTOR_VERSION = 1 as const

export interface ComposioUserConnectCallbackDescriptor {
  version: typeof CALLBACK_DESCRIPTOR_VERSION
  kind: 'user-connect'
  workspaceSlug: string
  destination: string
  expiresAt: number
}

export interface ComposioToolRouterCallbackDescriptor {
  version: typeof CALLBACK_DESCRIPTOR_VERSION
  kind: 'tool-router'
  workspaceSlug: string
}

export type ComposioOAuthCallbackDescriptor =
  | ComposioUserConnectCallbackDescriptor
  | ComposioToolRouterCallbackDescriptor

export async function createComposioUserConnectCallbackUrl(args: {
  requestUrl: string
  workspaceSlug: string
  destination: string
  secret: string
  now: number
}): Promise<string> {
  const payload: ComposioUserConnectCallbackDescriptor = {
    version: CALLBACK_DESCRIPTOR_VERSION,
    kind: 'user-connect',
    workspaceSlug: args.workspaceSlug,
    destination: args.destination,
    expiresAt: args.now + USER_CONNECT_DESCRIPTOR_TTL_MS,
  }
  return await callbackUrl(args.requestUrl, payload, args.secret)
}

export async function createComposioToolRouterCallbackUrl(args: {
  requestUrl: string
  workspaceSlug: string
  secret: string
}): Promise<string> {
  const payload: ComposioToolRouterCallbackDescriptor = {
    version: CALLBACK_DESCRIPTOR_VERSION,
    kind: 'tool-router',
    workspaceSlug: args.workspaceSlug,
  }
  return await callbackUrl(args.requestUrl, payload, args.secret)
}

async function callbackUrl(
  requestUrl: string,
  payload: ComposioOAuthCallbackDescriptor,
  secret: string,
): Promise<string> {
  const callback = new URL('/v1/integrations/composio/oauth/callback', requestUrl)
  callback.searchParams.set('nonce', await encodeSignedDescriptor(payload, secret))
  return callback.toString()
}

export async function verifyComposioOAuthCallbackDescriptor(
  value: string | undefined,
  secret: string,
  now: number,
): Promise<ComposioOAuthCallbackDescriptor | null> {
  const payload = await decodeSignedDescriptor(value, secret)
  if (payload === null || payload.version !== CALLBACK_DESCRIPTOR_VERSION) return null
  if (payload.kind === 'user-connect') {
    if (
      !hasExactlyKeys(payload, ['version', 'kind', 'workspaceSlug', 'destination', 'expiresAt']) ||
      !isNonEmptyString(payload.workspaceSlug) ||
      typeof payload.destination !== 'string' ||
      typeof payload.expiresAt !== 'number' ||
      !Number.isFinite(payload.expiresAt) ||
      payload.expiresAt <= now
    ) {
      return null
    }
    return {
      version: CALLBACK_DESCRIPTOR_VERSION,
      kind: 'user-connect',
      workspaceSlug: payload.workspaceSlug,
      destination: payload.destination,
      expiresAt: payload.expiresAt,
    }
  }
  if (payload.kind === 'tool-router') {
    if (
      !hasExactlyKeys(payload, ['version', 'kind', 'workspaceSlug']) ||
      !isNonEmptyString(payload.workspaceSlug)
    ) {
      return null
    }
    return {
      version: CALLBACK_DESCRIPTOR_VERSION,
      kind: 'tool-router',
      workspaceSlug: payload.workspaceSlug,
    }
  }
  return null
}
