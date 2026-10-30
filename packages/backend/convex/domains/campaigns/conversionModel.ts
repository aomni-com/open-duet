import type { GenericMutationCtx } from 'convex/server'
import { z } from 'zod'

import {
  AnalyticsEventSchema,
  JsonObjectSchema,
  JsonValueSchema,
  type AnalyticsEvent,
  type ConversionTriggerEventName,
  type JsonObject,
} from '@repo/contract'

import { internal } from '../../_generated/api'
import type { DataModel, Doc, Id } from '../../_generated/dataModel'
import { retrier } from '../../utils'
import { campaignBySlug, type CampaignDefinition } from './config'
import type { ConversionResult, ConversionTrigger } from './conversionTypes'
import type { DestinationName } from './destinationDelivery'

type ConversionMutationCtx = GenericMutationCtx<DataModel>

export interface RouteConversionOptions {
  now?: number
  campaignBySlug?: (slug: string) => CampaignDefinition | undefined
  startRun: (
    ctx: ConversionMutationCtx,
    instanceId: Id<'conversionInstances'>,
    inputId: Id<'conversionInputs'>,
  ) => Promise<string>
}

export interface PumpConversionOptions {
  now?: number
  startRun: RouteConversionOptions['startRun']
}

export interface CompleteConversionOptions {
  now?: number
  campaignBySlug?: (slug: string) => CampaignDefinition | undefined
  functionName?: string
  emit: (ctx: ConversionMutationCtx, event: AnalyticsEvent<'conversion.evaluated'>) => Promise<void>
  scheduleWake: (
    ctx: ConversionMutationCtx,
    instanceId: Id<'conversionInstances'>,
    at: number,
  ) => Promise<void>
  startDelivery?: (
    ctx: ConversionMutationCtx,
    deliveryId: Id<'conversionDeliveries'>,
  ) => Promise<string>
}

export async function startConversionRun(
  ctx: ConversionMutationCtx,
  instanceId: Id<'conversionInstances'>,
  inputId: Id<'conversionInputs'>,
): Promise<string> {
  return await retrier.run(
    ctx,
    internal.domains.campaigns.conversionExecutor.runConversion,
    { instanceId, inputId },
    { onComplete: internal.domains.campaigns.conversionExecutor.onComplete },
  )
}

export async function startConversionDeliveryRun(
  ctx: ConversionMutationCtx,
  deliveryId: Id<'conversionDeliveries'>,
): Promise<string> {
  return await retrier.run(
    ctx,
    internal.domains.campaigns.destinationAction.runDelivery,
    { deliveryId },
    { onComplete: internal.domains.campaigns.destinationExecutor.onComplete },
  )
}

export async function routeConversionEvent(
  ctx: ConversionMutationCtx,
  input: AnalyticsEvent,
  options: RouteConversionOptions,
): Promise<void> {
  const event = AnalyticsEventSchema.parse(input)
  if (event.name === 'conversion.evaluated') return

  const now = options.now ?? Date.now()
  const attribution = await resolveEventAttribution(ctx, event, now)
  if (attribution === null) return
  const campaign = (options.campaignBySlug ?? campaignBySlug)(attribution.campaignSlug)
  const conversion = campaign?.conversion
  if (
    conversion === undefined ||
    !conversion.on.includes(event.name as ConversionTriggerEventName) ||
    (conversion.origins !== undefined && !conversion.origins.includes(event.origin))
  ) {
    return
  }

  let instance = await ctx.db
    .query('conversionInstances')
    .withIndex('by_attribution_campaign', q =>
      q.eq('attributionId', attribution._id).eq('campaignSlug', attribution.campaignSlug),
    )
    .unique()
  if (instance?.doneAt !== undefined) return
  if (instance === null) {
    const instanceId = await ctx.db.insert('conversionInstances', {
      attributionId: attribution._id,
      campaignSlug: attribution.campaignSlug,
      state: {},
      createdAt: now,
      updatedAt: now,
    })
    instance = await ctx.db.get(instanceId)
    if (instance === null) throw new Error('Conversion instance disappeared after insertion')
  }

  const inputKey = `event:${event.id}`
  const duplicate = await ctx.db
    .query('conversionInputs')
    .withIndex('by_instance_key', q => q.eq('instanceId', instance._id).eq('inputKey', inputKey))
    .unique()
  if (duplicate !== null) return

  const trigger = JsonValueSchema.parse({
    kind: 'event',
    event,
  }) as ConversionTrigger
  await ctx.db.insert('conversionInputs', {
    instanceId: instance._id,
    inputKey,
    trigger,
    enqueuedAt: now,
  })
  await pumpConversionInstance(ctx, instance._id, {
    now,
    startRun: options.startRun,
  })
}

export async function pumpConversionInstance(
  ctx: ConversionMutationCtx,
  instanceId: Id<'conversionInstances'>,
  options: PumpConversionOptions,
): Promise<void> {
  const instance = await ctx.db.get(instanceId)
  if (instance === null || instance.doneAt !== undefined || instance.activeRunId !== undefined) {
    return
  }
  const input = await ctx.db
    .query('conversionInputs')
    .withIndex('by_instance_enqueued', q => q.eq('instanceId', instanceId))
    .first()
  if (input === null) return

  const now = options.now ?? Date.now()
  const runId = await options.startRun(ctx, instanceId, input._id)
  await ctx.db.patch(instanceId, {
    activeRunId: runId,
    activeInputId: input._id,
    updatedAt: now,
  })
}

const ConversionResultSchema: z.ZodType<ConversionResult> = z.object({
  state: JsonValueSchema,
  eligible: z.boolean(),
  done: z.boolean(),
  id: z.string().min(1).optional(),
  score: z.number().finite().optional(),
  value: z.number().finite().nonnegative().optional(),
  currency: z.string().min(1).optional(),
  properties: JsonObjectSchema.optional(),
  wakeAt: z.number().finite().optional(),
})

export function parseConversionResult(input: unknown): ConversionResult {
  return ConversionResultSchema.parse(input)
}

export async function completeConversionRun(
  ctx: ConversionMutationCtx,
  runId: string,
  inputResult: ConversionResult,
  options: CompleteConversionOptions,
): Promise<Id<'conversionInstances'> | null> {
  const result = parseConversionResult(inputResult)
  const instance = await ctx.db
    .query('conversionInstances')
    .withIndex('by_active_run', q => q.eq('activeRunId', runId))
    .unique()
  if (instance === null || instance.activeInputId === undefined) return null
  const input = await ctx.db.get(instance.activeInputId)
  if (input === null || input.instanceId !== instance._id) return null
  const attribution = await ctx.db.get(instance.attributionId)
  if (attribution === null) throw new Error('Conversion attribution not found')

  const now = options.now ?? Date.now()
  const trigger = input.trigger as ConversionTrigger
  const event = trigger.kind === 'event' ? trigger.event : undefined
  const userId =
    event?.userId === undefined
      ? (attribution.acquiredByUserId ?? null)
      : ctx.db.normalizeId('users', event.userId)
  const conversionId = result.id ?? `conversion:${instance._id}:${input._id}`
  const campaign = (options.campaignBySlug ?? campaignBySlug)(instance.campaignSlug)
  const normalizedResult = {
    id: conversionId,
    ...(result.score === undefined ? {} : { score: result.score }),
    ...(result.value === undefined ? {} : { value: result.value }),
    ...(result.currency === undefined ? {} : { currency: result.currency }),
    properties: result.properties ?? {},
  }
  JsonObjectSchema.parse(normalizedResult)

  if (result.eligible) {
    for (const destination of Object.keys(campaign?.destinations ?? {}) as DestinationName[]) {
      const duplicate = await ctx.db
        .query('conversionDeliveries')
        .withIndex('by_instance_destination_conversion', q =>
          q
            .eq('instanceId', instance._id)
            .eq('destination', destination)
            .eq('conversionId', conversionId),
        )
        .unique()
      if (duplicate !== null) continue
      const deliveryId = await ctx.db.insert('conversionDeliveries', {
        instanceId: instance._id,
        attributionId: instance.attributionId,
        campaignSlug: instance.campaignSlug,
        destination,
        conversionId,
        occurredAt: trigger.kind === 'event' ? trigger.event.at : trigger.at,
        ...(userId === null ? {} : { userId }),
        result: normalizedResult,
        createdAt: now,
        updatedAt: now,
      })
      if (options.startDelivery !== undefined) {
        const deliveryRunId = await options.startDelivery(ctx, deliveryId)
        await ctx.db.patch(deliveryId, { activeRunId: deliveryRunId, updatedAt: now })
      }
    }
  }

  await ctx.db.delete(input._id)

  const previousWakeAt = instance.wakeAt
  const nextWakeAt = result.done ? undefined : result.wakeAt
  await ctx.db.patch(instance._id, {
    state: result.state,
    activeRunId: undefined,
    activeInputId: undefined,
    wakeAt: nextWakeAt,
    ...(result.done ? { doneAt: now } : {}),
    lastError: undefined,
    updatedAt: now,
  })

  if (nextWakeAt !== undefined && nextWakeAt !== previousWakeAt) {
    await options.scheduleWake(ctx, instance._id, nextWakeAt)
  }
  if (result.done) {
    await purgeConversionInputs(ctx, instance._id)
  }

  // A journey with no acquired user has nobody to attribute the evaluation to.
  // Every conversion function that needs one already refuses earlier.
  if ((result.eligible || result.done) && userId !== null) {
    const properties: JsonObject = {
      campaignSlug: instance.campaignSlug,
      functionName: options.functionName ?? campaign?.conversion?.run.name ?? 'unknown',
      eligible: result.eligible,
      done: result.done,
      id: conversionId,
      ...(result.score === undefined ? {} : { score: result.score }),
      ...(result.value === undefined ? {} : { value: result.value }),
      ...(result.currency === undefined ? {} : { currency: result.currency }),
      resultProperties: result.properties ?? {},
    }
    await options.emit(ctx, {
      id: `conversion-evaluated:${instance._id}:${input._id}`,
      name: 'conversion.evaluated',
      version: 1,
      at: now,
      origin: 'conversion_executor',
      userId,
      ...(event?.workspaceId === undefined ? {} : { workspaceId: event.workspaceId }),
      attributionId: instance.attributionId,
      properties,
    })
  }
  return instance._id
}

export interface ConversionRunOutput {
  functionName: string
  result: ConversionResult
}

export function parseConversionRunOutput(value: unknown): ConversionRunOutput {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as { functionName?: unknown }).functionName !== 'string'
  ) {
    throw new Error('Conversion action returned an invalid envelope')
  }
  return {
    functionName: (value as { functionName: string }).functionName,
    result: parseConversionResult((value as { result?: unknown }).result),
  }
}

export async function settleConversionRun(
  ctx: ConversionMutationCtx,
  runId: string,
  returnValue: unknown,
  options: CompleteConversionOptions,
): Promise<Id<'conversionInstances'> | null> {
  try {
    const output = parseConversionRunOutput(returnValue)
    return await completeConversionRun(ctx, runId, output.result, {
      ...options,
      functionName: output.functionName,
    })
  } catch (error) {
    // The retrier swallows a completion-callback throw and still marks the
    // run completed, so an unhandled error here would strand activeRunId on a
    // run that can never call back again. Convert completion failures into
    // the designed terminal-input path: record the error, drop the input,
    // and let the journey advance.
    const message = error instanceof Error ? error.message : String(error)
    return await failConversionRun(
      ctx,
      runId,
      `Conversion completion failed: ${message}`,
      options.now,
    )
  }
}

export async function purgeConversionInputs(
  ctx: ConversionMutationCtx,
  instanceId: Id<'conversionInstances'>,
): Promise<void> {
  // A mailbox holds at most a handful of queued inputs; 1,000 is a safety
  // ceiling against pathological data, not a pagination scheme.
  const pending = await ctx.db
    .query('conversionInputs')
    .withIndex('by_instance_enqueued', q => q.eq('instanceId', instanceId))
    .take(1_000)
  for (const input of pending) await ctx.db.delete(input._id)
}

export async function failConversionRun(
  ctx: ConversionMutationCtx,
  runId: string,
  error: string,
  now = Date.now(),
): Promise<Id<'conversionInstances'> | null> {
  const instance = await ctx.db
    .query('conversionInstances')
    .withIndex('by_active_run', q => q.eq('activeRunId', runId))
    .unique()
  if (instance === null) return null
  if (instance.activeInputId !== undefined) {
    const input = await ctx.db.get(instance.activeInputId)
    if (input !== null && input.instanceId === instance._id) {
      await ctx.db.delete(input._id)
    }
  }
  await ctx.db.patch(instance._id, {
    activeRunId: undefined,
    activeInputId: undefined,
    lastError: boundedError(error),
    updatedAt: now,
  })
  return instance._id
}

export async function fireConversionWake(
  ctx: ConversionMutationCtx,
  instanceId: Id<'conversionInstances'>,
  expectedAt: number,
  options: PumpConversionOptions,
): Promise<void> {
  const instance = await ctx.db.get(instanceId)
  if (instance === null || instance.doneAt !== undefined || instance.wakeAt !== expectedAt) {
    return
  }
  const attribution = await ctx.db.get(instance.attributionId)
  const now = options.now ?? Date.now()
  if (attribution === null || attribution.expiresAt <= now) {
    // The journey can never be revived, so consume the fired wake instead of
    // leaving the instance advertising timer work that already happened.
    await ctx.db.patch(instanceId, { wakeAt: undefined, updatedAt: now })
    return
  }

  const inputKey = `wake:${expectedAt}`
  const duplicate = await ctx.db
    .query('conversionInputs')
    .withIndex('by_instance_key', q => q.eq('instanceId', instanceId).eq('inputKey', inputKey))
    .unique()
  await ctx.db.patch(instanceId, { wakeAt: undefined, updatedAt: now })
  if (duplicate === null) {
    const trigger = JsonValueSchema.parse({ kind: 'wake', at: expectedAt }) as ConversionTrigger
    await ctx.db.insert('conversionInputs', {
      instanceId,
      inputKey,
      trigger,
      enqueuedAt: now,
    })
  }
  await pumpConversionInstance(ctx, instanceId, options)
}

function boundedError(error: string): string {
  return error.length <= 4_096 ? error : `${error.slice(0, 4_093)}...`
}

async function resolveEventAttribution(
  ctx: ConversionMutationCtx,
  event: AnalyticsEvent,
  now: number,
): Promise<Doc<'campaignAttributions'> | null> {
  if (event.attributionId !== undefined) {
    const attributionId = ctx.db.normalizeId('campaignAttributions', event.attributionId)
    if (attributionId === null) return null
    const attribution = await ctx.db.get(attributionId)
    if (
      attribution === null ||
      attribution.expiresAt <= now ||
      (event.userId !== undefined &&
        attribution.acquiredByUserId !== undefined &&
        attribution.acquiredByUserId !== event.userId)
    ) {
      return null
    }
    JsonObjectSchema.parse(attribution.signals)
    return attribution
  }

  if (event.userId === undefined) return null
  const userId = ctx.db.normalizeId('users', event.userId)
  if (userId === null) return null
  const user = await ctx.db.get(userId)
  if (user?.acquisitionAttributionId === undefined) return null
  const attribution = await ctx.db.get(user.acquisitionAttributionId)
  if (
    attribution === null ||
    attribution.expiresAt <= now ||
    attribution.acquiredByUserId !== userId
  ) {
    return null
  }
  JsonObjectSchema.parse(attribution.signals)
  return attribution
}
