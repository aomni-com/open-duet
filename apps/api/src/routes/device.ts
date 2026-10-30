import {
  DeviceApprovalRequestSchema,
  DeviceApprovalResponseSchema,
  type DeviceApprovalAction,
  DeviceCodeRequestSchema,
  DeviceCodeResponseSchema,
  DeviceTokenRequestSchema,
  DeviceTokenResponseSchema,
  DevicePollResultSchema,
  FeedbackRequestSchema,
} from '@repo/contract'

import {
  fn,
  fnQuery,
  readJson,
  requireHumanActor,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
} from '../shared'
import { consumePreAuthRateLimit, networkIdentity } from './pre-auth-rate-limit'

const DEVICE_CODE_RATE_LIMIT = 20
const DEVICE_TOKEN_RATE_LIMIT = 60
const FEEDBACK_RATE_LIMIT = 20

export const DEVICE_AUTH_BYPASS_PATHS = [
  '/v1/device/code',
  '/v1/device/token',
  '/v1/feedback',
] as const

export function registerDeviceRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  options: { trustProxyHeaders: boolean },
): void {
  app.get('/device', c => c.redirect(deviceVerificationUrl(runtime)))

  app.post('/v1/device/code', async c => {
    const limited = await consumePreAuthRateLimit(runtime, {
      endpoint: 'device_code',
      identity: networkIdentity(c.req.raw, options.trustProxyHeaders),
      limit: DEVICE_CODE_RATE_LIMIT,
    })
    if (limited !== null) return limited
    const body = DeviceCodeRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const result = await runtime.convex.mutation(fn('domains/apiKeys/mutations:createDeviceCode'), {
      ...(body.data.client_name === undefined ? {} : { clientName: body.data.client_name }),
      verificationUri: deviceVerificationUrl(runtime),
    })
    return c.json(DeviceCodeResponseSchema.parse(result))
  })

  app.post('/v1/device/token', async c => {
    const limited = await consumePreAuthRateLimit(runtime, {
      endpoint: 'device_token',
      identity: networkIdentity(c.req.raw, options.trustProxyHeaders),
      limit: DEVICE_TOKEN_RATE_LIMIT,
    })
    if (limited !== null) return limited
    const body = DeviceTokenRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const result = DevicePollResultSchema.safeParse(
      await runtime.convex.mutation(fn('domains/apiKeys/api:pollDeviceCode'), {
        internalKey: runtime.internalKey,
        deviceCode: body.data.device_code,
        now: Date.now(),
      }),
    )
    if (!result.success) return c.json({ error: 'server_error' }, 500)
    if (result.data.status !== 'approved')
      return c.json(DeviceTokenResponseSchema.parse(result.data))
    return c.json(
      DeviceTokenResponseSchema.parse({
        status: 'approved',
        access_token: result.data.key,
        token_type: 'bearer',
        prefix: result.data.prefix,
      }),
    )
  })

  app.post('/v1/device/inspect', c => handleDeviceApproval(c, runtime, 'inspect'))
  app.post('/v1/device/approve', c => handleDeviceApproval(c, runtime, 'approve'))
  app.post('/v1/device/deny', c => handleDeviceApproval(c, runtime, 'deny'))

  app.post('/v1/feedback', async c => {
    const limited = await consumePreAuthRateLimit(runtime, {
      endpoint: 'feedback',
      identity: networkIdentity(c.req.raw, options.trustProxyHeaders),
      limit: FEEDBACK_RATE_LIMIT,
    })
    if (limited !== null) return limited
    const body = FeedbackRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    await runtime.convex.mutation(fn('domains/feedback/model:create'), {
      internalKey: runtime.internalKey,
      content: body.data.content,
      ...(body.data.source === undefined ? {} : { source: body.data.source }),
      now: runtime.now(),
    })
    return c.json({}, 202)
  })
}

async function handleDeviceApproval(
  c: ApiContext,
  runtime: ApiRouteRuntime,
  action: DeviceApprovalAction,
): Promise<Response> {
  const session = requireHumanActor(c)
  if ('response' in session) return session.response
  const body = DeviceApprovalRequestSchema.safeParse(await readJson(c.req.raw))
  if (!body.success) return c.json({ error: 'invalid_request' }, 400)
  try {
    const args = {
      internalKey: runtime.internalKey,
      actorId: session.userId,
      userCode: body.data.userCode,
      now: runtime.now(),
    }
    const result =
      action === 'inspect'
        ? await runtime.convex.query(fnQuery('domains/apiKeys/deviceApi:inspect'), args)
        : await runtime.convex.mutation(
            fn(
              action === 'approve'
                ? 'domains/apiKeys/deviceApi:approve'
                : 'domains/apiKeys/deviceApi:deny',
            ),
            args,
          )
    return c.json(DeviceApprovalResponseSchema.parse(result))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/Device code not found/.test(message)) return c.json({ error: 'not_found' }, 404)
    if (/Device code expired|Legacy device code expired/.test(message))
      return c.json({ error: 'device_code_expired' }, 410)
    const terminal = /Device code is (approved|denied|consumed|expired)/.exec(message)?.[1]
    if (terminal !== undefined) {
      return c.json({ error: 'device_code_not_pending', status: terminal }, 409)
    }
    throw error
  }
}

function deviceVerificationUrl(runtime: ApiRouteRuntime): string {
  return new URL('/device', runtime.appUrl).toString()
}
