import { v } from 'convex/values'

import { TRANSACTIONAL_EMAIL_KINDS } from '@repo/email/contracts'

export const deliveryKindValidator = v.union(
  v.literal(TRANSACTIONAL_EMAIL_KINDS[0]),
  v.literal(TRANSACTIONAL_EMAIL_KINDS[1]),
  v.literal(TRANSACTIONAL_EMAIL_KINDS[2]),
  v.literal(TRANSACTIONAL_EMAIL_KINDS[3]),
)
