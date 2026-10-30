import type { FunctionArgs, FunctionReference, FunctionReturnType } from 'convex/server'

import type {
  AnalyticsEvent,
  ConversionTriggerEventName,
  JsonObject,
  JsonValue,
} from '@repo/contract'

export interface AttributionView {
  attributionId: string
  campaignSlug: string
  action: string
  acquiredByUserId?: string
  signals: JsonObject
  createdAt: number
  expiresAt: number
}

export type ConversionTrigger =
  | { kind: 'event'; event: AnalyticsEvent<ConversionTriggerEventName> }
  | { kind: 'wake'; at: number }

export interface ConversionResult {
  state: JsonValue
  eligible: boolean
  done: boolean
  id?: string
  score?: number
  value?: number
  currency?: string
  properties?: JsonObject
  wakeAt?: number
}

export interface ConversionCheckpointRuntime {
  query<Query extends FunctionReference<'query', 'internal'>>(
    reference: Query,
    args: FunctionArgs<Query>,
  ): Promise<FunctionReturnType<Query>>
}

export interface ConversionFunctionContext<Config = JsonValue> {
  attribution: AttributionView
  trigger: ConversionTrigger
  state: JsonValue
  config: Config
  now: number
  checkpoint<T extends JsonValue>(
    name: string,
    compute: (runtime: ConversionCheckpointRuntime) => Promise<T>,
  ): Promise<T>
}

export type ConversionFunction<Config = JsonValue> = (
  context: ConversionFunctionContext<Config>,
) => Promise<ConversionResult>
