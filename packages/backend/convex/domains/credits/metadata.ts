import type { Infer } from 'convex/values'

import { MAX_CREDIT_TRANSACTION_METADATA_JSON_BYTES } from '@repo/contract'

import { creditTransactionMetadataValidator } from '../../validators'
import { assertJsonStorageBound } from '../shared/jsonStorageBounds'

export { MAX_CREDIT_TRANSACTION_METADATA_JSON_BYTES } from '@repo/contract'

export type CreditTransactionMetadata = Infer<typeof creditTransactionMetadataValidator>

export type CreditTransactionMetadataFields = Pick<
  CreditTransactionMetadata,
  | 'status'
  | 'event'
  | 'walletAllocation'
  | 'estimateMicroUsd'
  | 'actualCostMicroUsd'
  | 'tier'
  | 'reservationId'
  | 'releaseReason'
  | 'balanceDeltaMicroUsd'
  | 'forfeitedMonthlyMicroUsd'
  | 'usageKind'
>

export function creditTransactionMetadata(
  context: unknown,
  fields: CreditTransactionMetadataFields = {},
): CreditTransactionMetadata | undefined {
  const contextRecord = metadataContext(context)
  if (contextRecord === undefined && Object.keys(fields).length === 0) return undefined
  const metadata = {
    ...fields,
    ...(contextRecord === undefined ? {} : { context: contextRecord }),
  }
  assertCreditTransactionMetadataBound(metadata)
  return metadata
}

export function assertCreditTransactionMetadataBound(metadata: CreditTransactionMetadata): void {
  assertJsonStorageBound(
    metadata,
    MAX_CREDIT_TRANSACTION_METADATA_JSON_BYTES,
    'Credit transaction metadata',
  )
}

export function metadataContext(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return { value }
}
