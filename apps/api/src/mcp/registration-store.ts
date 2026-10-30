import { fn, fnQuery, type ApiRouteRuntime } from '../shared'
import type {
  McpClientRegistrationInput,
  McpRegistrationStore,
  StoredMcpClientRegistration,
} from './registration'

/**
 * `mcpClientRegistrations`, as the registration module sees it.
 *
 * The table is Convex's (`packages/backend/convex/domains/mcpServers/credentials.ts`)
 * and so is the authorization-server normalization that makes D18's sharing
 * rule work — origin plus pathname, no trailing slash, no query, no fragment.
 * Nothing here re-derives it: a second copy of that rule is a second answer to
 * "are these two servers behind the same authorization server", and the wrong
 * answer mints a registration per server.
 */

const CREDENTIALS = 'domains/mcpServers/credentials'

export interface ConvexMcpRegistrationStoreDeps {
  convex: ApiRouteRuntime['convex']
  internalKey: string
  workspaceId: string
  now: () => number
}

export function convexMcpRegistrationStore(
  deps: ConvexMcpRegistrationStoreDeps,
): McpRegistrationStore {
  const read = async (authorizationServer: string): Promise<StoredMcpClientRegistration | null> => {
    const registration = (await deps.convex.query(
      fnQuery(`${CREDENTIALS}:getMcpClientRegistration`),
      { internalKey: deps.internalKey, workspaceId: deps.workspaceId, authorizationServer },
    )) as ConvexRegistration | null
    return registration === null ? null : projectRegistration(registration)
  }

  return {
    read,
    async adopt(input: McpClientRegistrationInput) {
      // The decision is the mutation's, not ours. `storeMcpClientRegistration`
      // re-queries `by_workspace_and_as` inside its own transaction and
      // answers `exists` when a concurrent connect already adopted one, so two
      // connects racing the same authorization server cannot both write. The
      // loser deletes the client it just minted (RFC 7592) rather than
      // silently replacing the winner's — which is the whole of D18.
      //
      // Deliberately no check-then-act here: a read before the POST would just
      // narrow a window the mutation already closes, and would read as if this
      // layer owned the rule.
      const adopted = (await deps.convex.mutation(fn(`${CREDENTIALS}:storeMcpClientRegistration`), {
        internalKey: deps.internalKey,
        workspaceId: deps.workspaceId,
        authorizationServer: input.authorizationServer,
        clientId: input.clientId,
        ...defined('clientSecret', input.clientSecret),
        ...defined('tokenEndpointAuthMethod', input.tokenEndpointAuthMethod),
        ...defined('clientSecretExpiresAt', input.clientSecretExpiresAt),
        ...defined('registrationClientUri', input.registrationClientUri),
        ...defined('registrationAccessToken', input.registrationAccessToken),
        now: deps.now(),
      })) as { status: 'adopted' | 'exists'; registration: ConvexRegistration }
      return { status: adopted.status, registration: projectRegistration(adopted.registration) }
    },
    async invalidate(registrationId: string, reason: string) {
      await deps.convex.mutation(fn(`${CREDENTIALS}:invalidateMcpClientRegistration`), {
        internalKey: deps.internalKey,
        workspaceId: deps.workspaceId,
        registrationId,
        reason,
        now: deps.now(),
      })
    },
  }
}

/**
 * What `getMcpClientRegistration` and `storeMcpClientRegistration` answer with.
 * Neither ever returns the client secret or the RFC 7592 access token — both
 * are credentials, and Duet registers as a public client precisely so the token
 * exchange never needs one.
 */
interface ConvexRegistration {
  id: string
  authorizationServer: string
  clientId: string
  tokenEndpointAuthMethod?: string
}

function projectRegistration(registration: ConvexRegistration): StoredMcpClientRegistration {
  return {
    id: registration.id,
    authorizationServer: registration.authorizationServer,
    clientId: registration.clientId,
    ...defined('tokenEndpointAuthMethod', registration.tokenEndpointAuthMethod),
  }
}

/**
 * Convex argument validators are closed `v.object`s: an explicit `undefined`
 * is not the same as an absent field, and sending one 500s the call.
 */
function defined<K extends string, T>(key: K, value: T | undefined): Record<K, T> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>)
}
