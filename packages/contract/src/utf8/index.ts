import { z } from 'zod'

const encoder = new TextEncoder()

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength
}

export function hasMaxUtf8Bytes(value: string, maximum: number): boolean {
  return utf8ByteLength(value) <= maximum
}

/** A string whose persisted UTF-8 representation has a structural byte ceiling. */
export function utf8BoundedString(maximum: number, label: string) {
  return z.string().refine(value => hasMaxUtf8Bytes(value, maximum), {
    message: `${label} exceeds ${maximum} UTF-8 bytes`,
  })
}

/** Runtime assertion for Convex seams whose validators cannot express byte length. */
export function assertMaxUtf8Bytes(value: string, maximum: number, label: string): string {
  if (!hasMaxUtf8Bytes(value, maximum)) {
    throw new Error(`${label} exceeds ${maximum} UTF-8 bytes`)
  }
  return value
}

/** Scalar-safe prefix truncation for bounded third-party display metadata. */
export function truncateUtf8(value: string, maximum: number): string {
  if (hasMaxUtf8Bytes(value, maximum)) return value
  let result = ''
  let bytes = 0
  for (const scalar of value) {
    const scalarBytes = utf8ByteLength(scalar)
    if (bytes + scalarBytes > maximum) break
    result += scalar
    bytes += scalarBytes
  }
  return result
}
