import { JsonValueSchema, type JsonValue } from '@repo/contract'

import type { ConversionCheckpointRuntime } from './conversionTypes'

interface ConversionCheckpointStorage {
  load(name: string): Promise<JsonValue | undefined>
  save(name: string, value: JsonValue): Promise<JsonValue>
  runtime: ConversionCheckpointRuntime
}

export function createConversionCheckpoint(
  storage: ConversionCheckpointStorage,
): <T extends JsonValue>(
  name: string,
  compute: (runtime: ConversionCheckpointRuntime) => Promise<T>,
) => Promise<T> {
  return async <T extends JsonValue>(
    name: string,
    compute: (runtime: ConversionCheckpointRuntime) => Promise<T>,
  ): Promise<T> => {
    assertConversionCheckpointName(name)
    const existing = await storage.load(name)
    if (existing !== undefined) return JsonValueSchema.parse(existing) as T
    const computed = JsonValueSchema.parse(await compute(storage.runtime)) as T
    return JsonValueSchema.parse(await storage.save(name, computed)) as T
  }
}

export function assertConversionCheckpointName(name: string): void {
  if (!name.trim() || name.length > 256) {
    throw new Error('Invalid conversion checkpoint name')
  }
}
