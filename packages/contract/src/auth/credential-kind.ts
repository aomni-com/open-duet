import { z } from 'zod'

/**
 * What kind of credential authenticated a request.
 *
 * It lives in its own file, rather than beside the rest of the auth module,
 * purely so it can be imported without pulling the module in: `workspaces`
 * needs this enum, and the sign-in schemas in `./index` need `workspaces`'
 * role and slug grammars. Sharing one file would make that a runtime import
 * cycle — whichever module ESM enters second reads a half-initialized
 * namespace and throws. `./index` re-exports it, so every consumer outside this
 * package sees no difference.
 */
export const ApiCredentialKindSchema = z.enum([
  'user',
  'system_vm',
  'app',
  'impersonation',
  'browser_session',
  'oauth',
])
export type ApiCredentialKind = z.infer<typeof ApiCredentialKindSchema>
