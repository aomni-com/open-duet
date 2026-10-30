/**
 * Measure the JSON-shaped values accepted by durable metadata bags. Optional
 * object properties may be `undefined` (and are omitted); arrays may not carry
 * holes or undefined values because those do not have a stable stored shape.
 */
export function assertJsonStorageBound(
  value: unknown,
  maximumBytes: number,
  label: string,
): number {
  assertJsonStorageValue(value, new Set(), false, label)
  let serialized: string
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error(`${label} must be finite JSON`)
  }
  const bytes = new TextEncoder().encode(serialized).byteLength
  if (bytes > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} serialized bytes`)
  return bytes
}

function assertJsonStorageValue(
  value: unknown,
  ancestors: Set<object>,
  optionalProperty: boolean,
  label: string,
): void {
  if (value === undefined && optionalProperty) return
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw new Error(`${label} must be finite JSON`)
  }
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertJsonStorageValue(item, ancestors, false, label)
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (
      (prototype !== Object.prototype && prototype !== null) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      throw new Error(`${label} must be finite JSON`)
    }
    for (const item of Object.values(value)) {
      assertJsonStorageValue(item, ancestors, true, label)
    }
  } finally {
    ancestors.delete(value)
  }
}
