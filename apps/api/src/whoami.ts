import {
  WhoamiResponseSchema,
  matchesInternalAdminEmail,
  type WhoamiResponse,
} from '@repo/contract'

import type { AuthPayload } from './shared'

export function whoamiResponseForAuth(auth: AuthPayload): WhoamiResponse {
  return WhoamiResponseSchema.parse({
    ...auth,
    internalAdmin: matchesInternalAdminEmail(auth.user.email),
    credential: {
      kind: auth.credentialKind,
      ...(auth.audience === undefined ? {} : { audience: auth.audience }),
    },
  })
}
