import { createHash, timingSafeEqual } from 'node:crypto'

export function constantTimeSecretMatches(
  provided: string | null,
  expected: string | undefined,
): boolean {
  if (provided === null || expected === undefined || expected.length === 0) return false
  const providedDigest = createHash('sha256').update(provided).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(providedDigest, expectedDigest)
}
