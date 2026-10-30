import { onCompleteValidator } from '@convex-dev/action-retrier'
import type { RegisteredAction, RegisteredMutation, RegisteredQuery } from 'convex/server'
import { v, type Infer } from 'convex/values'

import {
  AnalyticsEventSchema,
  JsonObjectSchema,
  JsonValueSchema,
  type AnalyticsEvent,
  type ConversionTriggerEventName,
  type JsonValue,
} from '@repo/contract'

import { internal } from '../../_generated/api'
import type { Doc, Id } from '../../_generated/dataModel'
import { internalAction, internalMutation, internalQuery } from '../../_generated/server'
import { emitAnalyticsEvent } from '../analytics/model'
import { assertConversionCheckpointName, createConversionCheckpoint } from './conversionCheckpoint'
import {
  failConversionRun,
  fireConversionWake,
  parseConversionResult,
  pumpConversionInstance,
  settleConversionRun,
  startConversionDeliveryRun,
  startConversionRun,
  type ConversionRunOutput,
} from './conversionModel'
import { runConfiguredConversion } from './conversionRuntime'
import type { AttributionView, ConversionTrigger } from './conversionTypes'

type RunConversionArgs = {
  instanceId: Id<'conversionInstances'>
  inputId: Id<'conversionInputs'>
}

const runArgs = {
  instanceId: v.id('conversionInstances'),
  inputId: v.id('conversionInputs'),
}

export const runConversion: RegisteredAction<'internal', RunConversionArgs, ConversionRunOutput> =
  internalAction({
    args: runArgs,
    handler: async (ctx, args) => {
      const loaded = await ctx.runQuery(
        internal.domains.campaigns.conversionExecutor.loadRunInput,
        args,
      )
      const checkpoint = createConversionCheckpoint({
        load: async name => {
          const value = await ctx.runQuery(
            internal.domains.campaigns.conversionExecutor.loadCheckpoint,
            { instanceId: args.instanceId, name },
          )
          return value ?? undefined
        },
        save: async (name, value) =>
          await ctx.runMutation(internal.domains.campaigns.conversionExecutor.saveCheckpoint, {
            instanceId: args.instanceId,
            name,
            value,
            now: Date.now(),
          }),
        runtime: {
          query: async (reference, queryArgs) => await ctx.runQuery(reference, queryArgs),
        },
      })
      const output = await runConfiguredConversion(loaded.instance.campaignSlug, {
        attribution: attributionView(loaded.attribution),
        trigger: parseTrigger(loaded.input.trigger),
        state: JsonValueSchema.parse(loaded.instance.state),
        now: Date.now(),
        checkpoint,
      })
      return {
        functionName: output.functionName,
        result: parseConversionResult(output.result),
      }
    },
  })

export const loadRunInput: RegisteredQuery<
  'internal',
  RunConversionArgs,
  {
    instance: Doc<'conversionInstances'>
    input: Doc<'conversionInputs'>
    attribution: Doc<'campaignAttributions'>
  }
> = internalQuery({
  args: runArgs,
  handler: async (ctx, args) => {
    const [instance, input] = await Promise.all([
      ctx.db.get(args.instanceId),
      ctx.db.get(args.inputId),
    ])
    if (
      instance === null ||
      input === null ||
      input.instanceId !== instance._id ||
      instance.activeInputId !== input._id ||
      instance.doneAt !== undefined
    ) {
      throw new Error('Conversion run no longer owns its input')
    }
    const attribution = await ctx.db.get(instance.attributionId)
    if (attribution === null) throw new Error('Conversion attribution not found')
    return { instance, input, attribution }
  },
})

export const loadCheckpoint: RegisteredQuery<
  'internal',
  { instanceId: Id<'conversionInstances'>; name: string },
  JsonValue | null
> = internalQuery({
  args: { instanceId: v.id('conversionInstances'), name: v.string() },
  handler: async (ctx, args) => {
    const checkpoint = await ctx.db
      .query('conversionCheckpoints')
      .withIndex('by_instance_name', q => q.eq('instanceId', args.instanceId).eq('name', args.name))
      .unique()
    return checkpoint === null ? null : JsonValueSchema.parse(checkpoint.value)
  },
})

export const saveCheckpoint: RegisteredMutation<
  'internal',
  {
    instanceId: Id<'conversionInstances'>
    name: string
    value: JsonValue
    now: number
  },
  JsonValue
> = internalMutation({
  args: {
    instanceId: v.id('conversionInstances'),
    name: v.string(),
    value: v.any(),
    now: v.number(),
  },
  handler: async (ctx, args) => {
    assertConversionCheckpointName(args.name)
    const value = JsonValueSchema.parse(args.value)
    const existing = await ctx.db
      .query('conversionCheckpoints')
      .withIndex('by_instance_name', q => q.eq('instanceId', args.instanceId).eq('name', args.name))
      .unique()
    if (existing !== null) return JsonValueSchema.parse(existing.value)
    await ctx.db.insert('conversionCheckpoints', {
      instanceId: args.instanceId,
      name: args.name,
      value,
      createdAt: args.now,
    })
    return value
  },
})

export const onComplete: RegisteredMutation<
  'internal',
  Infer<typeof onCompleteValidator>,
  null
> = internalMutation({
  args: onCompleteValidator,
  handler: async (ctx, args) => {
    let instanceId: Id<'conversionInstances'> | null
    if (args.result.type === 'success') {
      instanceId = await settleConversionRun(ctx, args.runId, args.result.returnValue, {
        emit: emitAnalyticsEvent,
        scheduleWake: async (mutationCtx, scheduledInstanceId, at) => {
          await mutationCtx.scheduler.runAt(
            at,
            internal.domains.campaigns.conversionExecutor.fireWake,
            { instanceId: scheduledInstanceId, expectedAt: at },
          )
        },
        startDelivery: startConversionDeliveryRun,
      })
    } else {
      instanceId = await failConversionRun(
        ctx,
        args.runId,
        args.result.type === 'failed' ? args.result.error : 'Conversion run canceled',
      )
    }

    if (instanceId !== null) {
      await ctx.scheduler.runAfter(0, internal.domains.campaigns.conversionExecutor.pump, {
        instanceId,
      })
    }
    // Completed retrier runs are vacuumed by the component's own daily cron.
    return null
  },
})

export const pump: RegisteredMutation<'internal', { instanceId: Id<'conversionInstances'> }, null> =
  internalMutation({
    args: { instanceId: v.id('conversionInstances') },
    handler: async (ctx, args) => {
      await pumpConversionInstance(ctx, args.instanceId, { startRun: startConversionRun })
      return null
    },
  })

export const fireWake: RegisteredMutation<
  'internal',
  { instanceId: Id<'conversionInstances'>; expectedAt: number },
  null
> = internalMutation({
  args: {
    instanceId: v.id('conversionInstances'),
    expectedAt: v.number(),
  },
  handler: async (ctx, args) => {
    await fireConversionWake(ctx, args.instanceId, args.expectedAt, {
      startRun: startConversionRun,
    })
    return null
  },
})

function parseTrigger(input: unknown): ConversionTrigger {
  const trigger = JsonValueSchema.parse(input)
  if (typeof trigger !== 'object' || trigger === null || Array.isArray(trigger)) {
    throw new Error('Invalid conversion trigger')
  }
  if (trigger.kind === 'wake' && typeof trigger.at === 'number' && Number.isFinite(trigger.at)) {
    return { kind: 'wake', at: trigger.at }
  }
  if (
    trigger.kind === 'event' &&
    typeof trigger.event === 'object' &&
    trigger.event !== null &&
    !Array.isArray(trigger.event)
  ) {
    const parsedEvent = AnalyticsEventSchema.parse(trigger.event)
    if (parsedEvent.name === 'conversion.evaluated') {
      throw new Error('Evaluation events cannot trigger')
    }
    const event = parsedEvent as AnalyticsEvent<ConversionTriggerEventName>
    return { kind: 'event', event }
  }
  throw new Error('Invalid conversion trigger')
}

function attributionView(attribution: Doc<'campaignAttributions'>): AttributionView {
  return {
    attributionId: attribution._id,
    campaignSlug: attribution.campaignSlug,
    action: attribution.action,
    ...(attribution.acquiredByUserId === undefined
      ? {}
      : { acquiredByUserId: attribution.acquiredByUserId }),
    signals: JsonObjectSchema.parse(attribution.signals),
    createdAt: attribution.createdAt,
    expiresAt: attribution.expiresAt,
  }
}
