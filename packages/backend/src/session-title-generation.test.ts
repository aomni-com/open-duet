import { describe, expect, test } from 'bun:test'

import { generateTitleWithTimeout } from '../convex/domains/agentSessions/titleGenerationCore'
import { resolveTitleAttempt } from '../convex/domains/agentSessions/titles'

describe('session title generation', () => {
  test('turns a timeout into the excerpt-preserving failure result', async () => {
    const title = await generateTitleWithTimeout(
      signal =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        }),
      5,
    )
    expect(title).toBeUndefined()
  })

  test('returns successful model text unchanged for the contract normalizer', async () => {
    expect(await generateTitleWithTimeout(async () => 'Release diagnosis', 50)).toBe(
      'Release diagnosis',
    )
  })

  test('allows one auto title while manual ownership wins every race', () => {
    const claimed = {
      archiveState: 'active' as const,
      prompt: 'Inspect staging',
      titleOrigin: 'excerpt' as const,
      titleAttemptId: 'attempt-1',
    }
    const completed = resolveTitleAttempt(claimed, 'attempt-1', 'Staging diagnosis')
    expect(completed).toMatchObject({
      title: 'Staging diagnosis',
      titleOrigin: 'auto',
      titleStatus: 'complete',
    })
    expect(
      resolveTitleAttempt({ ...claimed, ...completed }, 'attempt-1', 'Second generated title'),
    ).toBeNull()
    expect(resolveTitleAttempt(claimed, 'attempt-2', 'Wrong attempt')).toBeNull()
    expect(resolveTitleAttempt(claimed, 'attempt-1', undefined)).toMatchObject({
      titleStatus: 'failed',
      titleAttemptId: undefined,
    })
    expect(
      resolveTitleAttempt({ ...claimed, titleOrigin: 'manual' }, 'attempt-1', 'Late model title'),
    ).toBeNull()
  })
})
