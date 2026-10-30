import { z } from 'zod'

/**
 * The one grammar for a code a human reads off a screen or out of an email and
 * types back — device pairing today, email sign-in next to it.
 *
 * Thirty-two symbols, with `I`, `O`, `0`, and `1` removed so no character can be
 * mistaken for another when it is read aloud or retyped. That count is not
 * incidental: 32^8 is exactly 2^40, and forty bits is what lets an
 * eight-character code stand up to a verification path that has no rate limit of
 * its own (`@convex-dev/auth` skips its limiter when a sign-in call carries a
 * code but no email).
 */
export const HUMAN_ENTRY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/**
 * Deliberately wider than the alphabet — it admits `I` and `O`, which the
 * generator never emits.
 *
 * Narrowing it to match would reject a code a human retyped with an `O` where
 * they saw a `0`, and there is no `0` in the alphabet for it to collide with.
 * These are also the exact bytes device user codes have always accepted, so
 * unifying the two grammars changes nothing about what the device flow admits.
 */
export const HUMAN_ENTRY_CODE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/

export const HumanEntryCodeSchema = z.string().regex(HUMAN_ENTRY_CODE_PATTERN)

const GROUP_LENGTH = 4

export function generateHumanEntryCode(): string {
  return `${randomGroup(GROUP_LENGTH)}-${randomGroup(GROUP_LENGTH)}`
}

/**
 * Rejection sampling rather than a bare modulo. With 32 symbols the biased tail
 * is empty and no byte is ever rejected — the loop exists so that changing the
 * alphabet to a length that does not divide 256 cannot silently skew the code
 * toward its first few characters.
 */
function randomGroup(length: number): string {
  const limit =
    Math.floor(256 / HUMAN_ENTRY_CODE_ALPHABET.length) * HUMAN_ENTRY_CODE_ALPHABET.length
  let value = ''
  while (value.length < length) {
    const bytes = new Uint8Array(length - value.length)
    crypto.getRandomValues(bytes)
    for (const byte of bytes) {
      if (byte >= limit) continue
      value += HUMAN_ENTRY_CODE_ALPHABET[byte % HUMAN_ENTRY_CODE_ALPHABET.length]
    }
  }
  return value
}
