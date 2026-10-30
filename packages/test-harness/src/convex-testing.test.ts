import { expect, spyOn, test } from 'bun:test'

import { uniqueEmail } from './convex-testing'

test('two synthetic accounts never share a domain or a mailbox', () => {
  const clock = spyOn(Date, 'now').mockReturnValue(1_000)
  const weakRandom = spyOn(Math, 'random').mockReturnValue(0.5)
  try {
    const [a, b] = [uniqueEmail('owner'), uniqueEmail('owner')]
    const [aLocal, aDomain] = a.split('@')
    const [bLocal, bDomain] = b.split('@')
    expect(aDomain).not.toBe(bDomain)
    expect(aLocal).not.toBe(bLocal)
    // Re-domained for a company account, the mailbox alone must still be unique.
    expect(a.replace(/@[^@]+$/, '@aomni.com')).not.toBe(b.replace(/@[^@]+$/, '@aomni.com'))
  } finally {
    clock.mockRestore()
    weakRandom.mockRestore()
  }
})
