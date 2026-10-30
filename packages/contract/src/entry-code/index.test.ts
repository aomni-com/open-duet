import { describe, expect, test } from 'bun:test'

import { generateHumanEntryCode, HUMAN_ENTRY_CODE_ALPHABET, HumanEntryCodeSchema } from './index'

describe('human entry code', () => {
  test('accepts what the generator emits, every time', () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      expect(HumanEntryCodeSchema.safeParse(generateHumanEntryCode()).success).toBe(true)
    }
  })

  test('rejects the shapes that used to be codes here', () => {
    // The retired fixture code, and the 32-hex token Convex Auth minted before
    // a human ever had to read one back.
    expect(HumanEntryCodeSchema.safeParse('0123456789abcdefghijklmnopqrstuvwxyz').success).toBe(
      false,
    )
    expect(HumanEntryCodeSchema.safeParse('c'.repeat(32)).success).toBe(false)
    expect(HumanEntryCodeSchema.safeParse('rnp4-4y37').success).toBe(false)
    expect(HumanEntryCodeSchema.safeParse('RNP44Y37').success).toBe(false)
    expect(HumanEntryCodeSchema.safeParse('RNP4-4Y3').success).toBe(false)
  })

  test('admits the two letters the generator never emits', () => {
    // Deliberate: a human who read an O and typed one should not be told their
    // code is malformed. There is no 0 in the alphabet for it to collide with.
    expect(HumanEntryCodeSchema.safeParse('IOIO-IOIO').success).toBe(true)
    expect(HUMAN_ENTRY_CODE_ALPHABET).not.toContain('I')
    expect(HUMAN_ENTRY_CODE_ALPHABET).not.toContain('O')
    expect(HUMAN_ENTRY_CODE_ALPHABET).not.toContain('0')
    expect(HUMAN_ENTRY_CODE_ALPHABET).not.toContain('1')
  })

  test('carries the forty bits the unrated verification path depends on', () => {
    expect(HUMAN_ENTRY_CODE_ALPHABET.length).toBe(32)
    expect(new Set(HUMAN_ENTRY_CODE_ALPHABET).size).toBe(HUMAN_ENTRY_CODE_ALPHABET.length)
    expect(HUMAN_ENTRY_CODE_ALPHABET.length ** 8).toBe(2 ** 40)
  })

  test('draws each symbol without leaning on the low end of the alphabet', () => {
    const counts = new Map<string, number>()
    const draws = 20_000
    for (let attempt = 0; attempt < draws; attempt += 1) {
      for (const character of generateHumanEntryCode().replace('-', '')) {
        counts.set(character, (counts.get(character) ?? 0) + 1)
      }
    }
    expect(counts.size).toBe(HUMAN_ENTRY_CODE_ALPHABET.length)
    const expected = (draws * 8) / HUMAN_ENTRY_CODE_ALPHABET.length
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected * 0.8)
      expect(count).toBeLessThan(expected * 1.2)
    }
  })
})
