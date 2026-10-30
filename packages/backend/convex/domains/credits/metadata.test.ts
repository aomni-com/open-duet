import { describe, expect, test } from 'bun:test'

import { MAX_CREDIT_TRANSACTION_METADATA_JSON_BYTES, creditTransactionMetadata } from './metadata'

describe('credit transaction metadata storage boundary', () => {
  test('accepts finite metadata within the byte ceiling and rejects oversized metadata', () => {
    expect(creditTransactionMetadata({ source: 'gateway' })).toEqual({
      context: { source: 'gateway' },
    })
    expect(() =>
      creditTransactionMetadata({
        payload: 'x'.repeat(MAX_CREDIT_TRANSACTION_METADATA_JSON_BYTES),
      }),
    ).toThrow('Credit transaction metadata exceeds')
  })

  test('rejects cyclic and non-finite context before Convex storage', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => creditTransactionMetadata(cyclic)).toThrow('finite JSON')
    expect(() => creditTransactionMetadata({ amount: Number.POSITIVE_INFINITY })).toThrow(
      'finite JSON',
    )
  })
})
