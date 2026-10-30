import type { GenericMutationCtx } from 'convex/server'

import { ApiKeyNameStorageSchema, canonicalizeApiKeyScopes } from '@repo/contract'

import type { DataModel, Doc, Id } from '../../_generated/dataModel'

type WithoutSystemFields<T> = T extends unknown ? Omit<T, '_id' | '_creationTime'> : never
type StoredApiKey = WithoutSystemFields<Doc<'apiKeys'>>

/** Canonical key storage: human identity or a byte-bounded managed grant. */
export async function insertApiKey(
  ctx: GenericMutationCtx<DataModel>,
  row: StoredApiKey,
): Promise<Id<'apiKeys'>> {
  const name = row.name === undefined ? undefined : ApiKeyNameStorageSchema.parse(row.name.trim())
  if (row.kind === 'user') {
    return await ctx.db.insert('apiKeys', { ...row, ...(name === undefined ? {} : { name }) })
  }
  return await ctx.db.insert('apiKeys', {
    ...row,
    ...(name === undefined ? {} : { name }),
    scopes: canonicalizeApiKeyScopes(row.scopes),
  })
}
