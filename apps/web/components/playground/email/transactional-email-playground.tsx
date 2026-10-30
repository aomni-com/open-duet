'use client'

import { prepareTransactionalEmail } from '@repo/email'
import type { TransactionalEmailKind } from '@repo/email/contracts'
import { TRANSACTIONAL_EMAIL_FIXTURES } from '@repo/email/fixtures'

import { EmailFrame } from './email-frame'

export function TransactionalEmailPlayground({ kind }: { kind: TransactionalEmailKind }) {
  const input = TRANSACTIONAL_EMAIL_FIXTURES.find(fixture => fixture.kind === kind)
  if (!input) throw new Error(`Missing transactional email fixture: ${kind}`)
  const prepared = prepareTransactionalEmail(input)
  return <EmailFrame subject={prepared.subject}>{prepared.document}</EmailFrame>
}
