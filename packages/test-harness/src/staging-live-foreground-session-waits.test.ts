import { describe, expect, test } from 'bun:test'

import {
  deterministicSessionWaitRequestId,
  parseForegroundSessionWaitResponse,
} from './staging-live-foreground-session-waits'

describe('foreground session waits staging journey', () => {
  test('derives stable distinct UUIDs for idempotent live submissions', () => {
    expect(deterministicSessionWaitRequestId('run-1', 'root')).toBe(
      deterministicSessionWaitRequestId('run-1', 'root'),
    )
    expect(deterministicSessionWaitRequestId('run-1', 'root')).not.toBe(
      deterministicSessionWaitRequestId('run-1', 'child'),
    )
    expect(deterministicSessionWaitRequestId('run-1', 'root')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test('parses a successful wait body once and reserves text reads for errors', async () => {
    const completed = {
      sessionId: 'session_1',
      inputSeq: 1,
      terminal: {
        seq: 2,
        createdAt: 123,
        event: { type: 'complete' as const, result: 'done' },
      },
    }
    await expect(
      parseForegroundSessionWaitResponse(Response.json(completed, { status: 200 })),
    ).resolves.toEqual(completed)
    await expect(
      parseForegroundSessionWaitResponse(new Response('gateway mismatch', { status: 503 })),
    ).rejects.toThrow('foreground wait returned HTTP 503: gateway mismatch')
  })
})
