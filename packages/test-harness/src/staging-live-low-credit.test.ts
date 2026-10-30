import { expect, test } from 'bun:test'

import { lowCreditSecondaryEmail } from './staging-live-low-credit.ts'

test('the secondary live identity stays within the email local-part limit', () => {
  const email = lowCreditSecondaryEmail(
    'duet-so@agentmail.to',
    'staging-e2e-low-credit-recovery-mt6dtkfb-0ea4c5',
  )

  expect(email.split('@')[0]?.length).toBeLessThanOrEqual(64)
  expect(email).toBe('duet-so+staging-e2e-lc-mt6dtkfb-0ea4c5@agentmail.to')
})
