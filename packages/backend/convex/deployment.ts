import { BACKEND_SCHEMA_VERSION, ReleaseRevisionSchema } from '@repo/contract'

import { query } from './_generated/server'
import { DEPLOYED_RELEASE_REVISION } from './deploymentRevision'

export function deploymentIdentity(deployedRevision: string | null): {
  revision: string | null
  schema: number
} {
  const revision = ReleaseRevisionSchema.safeParse(deployedRevision)
  return {
    revision: revision.success ? revision.data : null,
    schema: BACKEND_SCHEMA_VERSION,
  }
}

export const identity = query({
  args: {},
  handler: () => deploymentIdentity(DEPLOYED_RELEASE_REVISION),
})
