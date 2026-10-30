import { httpRouter } from 'convex/server'
import { makeFunctionReference, type FunctionReference } from 'convex/server'

import {
  EDGE_SECRET_HEADER,
  EdgeResolveRequestSchema,
  type EdgeResolveRequest,
  type EdgeResolveResponse,
  type ViewerDescriptor,
} from '@repo/contract'

import { httpAction } from './_generated/server'
import { auth } from './auth'
import { isDuetV2SubscriptionMetadata } from './domains/credits/subscriptionEvents'
import { constructStripeWebhookEvent, createStripeClient } from './services/stripe'

const http = httpRouter()

auth.addHttpRoutes(http)

http.route({
  path: '/v1/stripe/webhook',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET
    if (webhookSecret === undefined || webhookSecret.length === 0) {
      return Response.json({ error: 'stripe_webhook_not_configured' }, { status: 500 })
    }
    const signature = request.headers.get('stripe-signature')
    if (signature === null) return Response.json({ error: 'missing_signature' }, { status: 400 })
    const rawBody = await request.text()
    const event = await constructStripeWebhookEvent({ rawBody, signature, webhookSecret }).catch(
      () => null,
    )
    if (event === null) {
      return Response.json({ error: 'invalid_signature' }, { status: 400 })
    }
    const related = await relatedStripeWebhookObjects(event.type, event.data.object)
    const result = await ctx.runMutation(
      fnMutation('domains/credits/internal:processStripeWebhookEvent'),
      {
        internalKey: apiInternalKey(),
        eventId: event.id,
        eventCreatedAt: event.created,
        type: event.type,
        object: event.data.object,
        previousAttributes: event.data.previous_attributes,
        ...related,
      },
    )
    return Response.json(result)
  }),
})

http.route({
  path: '/v1/edge/resolve',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    if (!isAuthorizedEdge(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const body = await readJson(request)
    const parsed = EdgeResolveRequestSchema.safeParse(body)
    if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 })
    if (parsed.data.kind === 'app-host') {
      const identity = await ctx.runQuery(fnQuery('domains/customDomains/model:resolveHostname'), {
        internalKey: apiInternalKey(),
        hostname: parsed.data.hostname,
      })
      return identity === null
        ? Response.json({ error: 'not_found' }, { status: 404 })
        : Response.json(identity)
    }
    if (parsed.data.kind === 'app') {
      const resolved = (await ctx.runQuery(fnQuery('domains/apps/model:resolveForEdge'), {
        internalKey: apiInternalKey(),
        workspaceSlug: parsed.data.workspaceSlug,
        appSlug: parsed.data.appSlug,
        viewerUserId: parsed.data.viewerUserId,
        viewerAppId: parsed.data.viewerAppId,
        viewerCredential: parsed.data.viewerCredential,
        customBinding: parsed.data.customBinding,
      })) as AppEdgeResolveResult | null
      if (resolved === null) return Response.json({ error: 'not_found' }, { status: 404 })
      if ('suspended' in resolved && resolved.suspended)
        return Response.json({ error: 'suspended' }, { status: 403 })
      if ('paused' in resolved) return Response.json(resolved)
      if ('denied' in resolved && resolved.denied)
        return Response.json(
          { error: resolved.guestPrivate ? 'guest_private' : 'forbidden' },
          { status: 403 },
        )
      return Response.json({
        visibility: resolved.visibility,
        workspace: resolved.workspace,
        origin: resolved.origin,
      })
    }
    if (parsed.data.kind === 'publish') {
      const resolved = (await ctx.runQuery(fnQuery('domains/publishes/model:resolveForEdge'), {
        internalKey: apiInternalKey(),
        workspaceSlug: parsed.data.workspaceSlug,
        publishSlug: parsed.data.publishSlug,
      })) as PublishEdgeResolveResult | null
      if (resolved === null) return Response.json({ error: 'not_found' }, { status: 404 })
      if ('suspended' in resolved && resolved.suspended)
        return Response.json({ error: 'suspended' }, { status: 403 })
      if ('paused' in resolved) return Response.json(resolved)
      return Response.json(resolved)
    }
    const workspace = (await ctx.runQuery(fnQuery('domains/edge/model:resolvePublicOrigin'), {
      workspaceSlug: parsed.data.workspaceSlug,
    })) as EdgeResolveWorkspace | null
    if (workspace === null) return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json(resolveResponse(parsed.data, workspace))
  }),
})

http.route({
  path: '/v1/edge/publishes/served',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    if (!isAuthorizedEdge(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const body = await readJson(request)
    if (!isPublishServedReport(body))
      return Response.json({ error: 'invalid_request' }, { status: 400 })
    const result = await ctx.runMutation(fnMutation('domains/publishes/model:recordServedPath'), {
      internalKey: apiInternalKey(),
      publishId: body.publishId,
      servedPath: body.servedPath,
      kind: body.kind,
    })
    return Response.json(result)
  }),
})

export default http

type QueryRef = FunctionReference<'query'>

interface EdgeResolveWorkspace {
  workspaceId: string
  workspaceSlug: string
  httpsUrl: string
  vmName: string
  gatewayAuthToken: string
}

type AppEdgeResolveResult =
  | { suspended: true }
  | { paused: true; appName: string }
  | { denied: true; visibility: 'folder' | 'public'; guestPrivate?: boolean }
  | {
      suspended?: false
      denied: false
      visibility: 'folder' | 'public'
      workspace: EdgeResolveResponse['workspace']
      origin: EdgeResolveResponse['origin']
    }

type PublishEdgeResolveResult =
  | { suspended: true }
  | { paused: true; appName: string }
  | (EdgeResolveResponse & {
      suspended?: false
      publish: {
        id: string
        kind: 'file' | 'folder'
        anchorPath: string
        viewer: ViewerDescriptor
      }
    })

function isAuthorizedEdge(request: Request): boolean {
  const expected = process.env.DUET_EDGE_INTERNAL_KEY
  if (expected === undefined || expected.length === 0)
    throw new Error('DUET_EDGE_INTERNAL_KEY is required')
  return request.headers.get(EDGE_SECRET_HEADER) === expected
}

function apiInternalKey(): string {
  const key = process.env.DUET_API_INTERNAL_KEY
  if (key === undefined || key.length === 0) throw new Error('DUET_API_INTERNAL_KEY is required')
  return key
}

async function relatedStripeWebhookObjects(
  eventType: string,
  input: unknown,
): Promise<{ subscriptionSchedule?: unknown; disputeCustomerId?: string }> {
  const object = objectRecord(input)
  if (
    eventType === 'customer.subscription.created' ||
    eventType === 'customer.subscription.updated'
  ) {
    if (!isDuetV2SubscriptionMetadata(object.metadata)) return {}
    const schedule = object.schedule
    if (objectRecordOrUndefined(schedule) !== undefined) {
      return { subscriptionSchedule: schedule }
    }
    if (typeof schedule === 'string') {
      return {
        subscriptionSchedule: await webhookStripeClient().subscriptionSchedules.retrieve(schedule),
      }
    }
  }
  if (eventType === 'charge.dispute.created') {
    const expandedCharge = objectRecordOrUndefined(object.charge)
    const charge =
      expandedCharge ??
      (typeof object.charge === 'string'
        ? await webhookStripeClient().charges.retrieve(object.charge)
        : undefined)
    const customerId = idOfStripeObject(objectRecordOrUndefined(charge)?.customer)
    return customerId === undefined ? {} : { disputeCustomerId: customerId }
  }
  return {}
}

function webhookStripeClient() {
  const apiKey = process.env.STRIPE_SECRET_KEY
  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error('STRIPE_SECRET_KEY is required for related webhook object lookup')
  }
  return createStripeClient(apiKey)
}

function objectRecord(value: unknown): Record<string, unknown> {
  return objectRecordOrUndefined(value) ?? {}
}

function objectRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function idOfStripeObject(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  const object = objectRecordOrUndefined(value)
  return typeof object?.id === 'string' && object.id.length > 0 ? object.id : undefined
}

function resolveResponse(
  request: EdgeResolveRequest,
  workspace: EdgeResolveWorkspace,
): EdgeResolveResponse {
  return {
    visibility: 'public',
    workspace: {
      id: workspace.workspaceId,
      slug: workspace.workspaceSlug,
      httpsUrl: workspace.httpsUrl,
      vmName: workspace.vmName,
    },
    origin: {
      httpsUrl: workspace.httpsUrl,
      gatewayAuthToken: workspace.gatewayAuthToken,
      gatewayPathPrefix:
        request.kind === 'app'
          ? '/public/app'
          : request.kind === 'publish'
            ? '/public/publish'
            : '',
    },
  }
}

function isPublishServedReport(
  body: unknown,
): body is { publishId: string; servedPath: string; kind: 'raw' | 'zip' } {
  if (typeof body !== 'object' || body === null) return false
  const value = body as Record<string, unknown>
  return (
    typeof value.publishId === 'string' &&
    value.publishId.length > 0 &&
    typeof value.servedPath === 'string' &&
    value.servedPath.length > 0 &&
    (value.kind === 'raw' || value.kind === 'zip')
  )
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function fnQuery(name: string): QueryRef {
  return makeFunctionReference(name) as QueryRef
}

function fnMutation(name: string): FunctionReference<'mutation'> {
  return makeFunctionReference(name) as FunctionReference<'mutation'>
}
