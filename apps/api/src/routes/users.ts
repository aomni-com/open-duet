import type { PaginationResult } from 'convex/server'
import { ConvexError } from 'convex/values'

import {
  IncomingWorkspaceInviteListQuerySchema,
  IncomingWorkspaceInvitePageSchema,
  WorkspaceInviteAcceptedSchema,
  WorkspaceMemberAdmissionRefusalSchema,
  OAuthGrantListQuerySchema,
  OAuthGrantPageSchema,
  OAuthGrantRevokedSchema,
  SyncMachineSchema,
  SyncMachineRegisterRequestSchema,
  SyncMachineListQuerySchema,
  SyncMachinePageSchema,
  SyncMachineRemovedSchema,
  UserApiKeyIssueRequestSchema,
  UserApiKeyIssuedSchema,
  UserApiKeyListQuerySchema,
  UserApiKeyPageSchema,
  UserApiKeyRevokedSchema,
  UserProfileSchema,
  UserProfileUpdateRequestSchema,
  isCollectionCursorError,
} from '@repo/contract'

import { createConvexCollectionPage, createTemporalConvexCollectionPage } from '../collection-page'
import { type GatewayClient } from '../gateway/client'
import {
  fn,
  fnQuery,
  readJson,
  requireHumanActor,
  type ApiApp,
  type ApiRouteRuntime,
} from '../shared'

const invitationPages = createTemporalConvexCollectionPage('user-invitations-list')
const apiKeyPages = createConvexCollectionPage('user-keys-list')
const oauthGrantPages = createConvexCollectionPage('user-oauth-grants-list')
const syncMachinePages = createConvexCollectionPage('user-sync-machines-list')

export function registerUserRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
): void {
  app.get('/v1/user/profile', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const profile = await runtime.convex.query(fnQuery('domains/users/api:profile'), {
      internalKey: runtime.internalKey,
      actorId: session.userId,
    })
    return c.json(UserProfileSchema.parse(profile))
  })

  app.patch('/v1/user/profile', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const body = UserProfileUpdateRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const profile = await runtime.convex.mutation(fn('domains/users/api:updateProfile'), {
      internalKey: runtime.internalKey,
      actorId: session.userId,
      ...body.data,
      now: runtime.now(),
    })
    return c.json(UserProfileSchema.parse(profile))
  })

  app.get('/v1/user/invitations', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const query = IncomingWorkspaceInviteListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = {
      subject: session.userId,
      filters: {},
      order: 'expiresAt:asc,creationTime:asc',
    }
    try {
      const pagination = await invitationPages.pagination(query.data, binding, runtime.now())
      const result = (await runtime.convex.query(
        fnQuery('domains/invitations/queries:incomingFromApi'),
        {
          internalKey: runtime.internalKey,
          actorId: session.userId,
          ...pagination,
        },
      )) as PaginationResult<unknown>
      return c.json(
        IncomingWorkspaceInvitePageSchema.parse(
          await invitationPages.response(result, binding, pagination.asOf),
        ),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
  })

  app.post('/v1/user/invitations/:inviteId/accept', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    try {
      const result = await runtime.convex.mutation(
        fn('domains/invitations/mutations:acceptIncomingFromApi'),
        {
          internalKey: runtime.internalKey,
          actorId: session.userId,
          inviteId: c.req.param('inviteId'),
        },
      )
      return c.json(WorkspaceInviteAcceptedSchema.parse(result))
    } catch (error) {
      const refusal = WorkspaceMemberAdmissionRefusalSchema.safeParse(
        error !== null && typeof error === 'object' && 'data' in error ? error.data : undefined,
      )
      if (refusal.success) return c.json(refusal.data, 409)
      if (
        error !== null &&
        typeof error === 'object' &&
        'data' in error &&
        error.data === 'Invite could not be accepted'
      ) {
        return c.json({ error: 'invitation_unavailable' }, 404)
      }
      throw error
    }
  })

  app.get('/v1/user/api-keys', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const query = UserApiKeyListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = { subject: session.userId, filters: {}, order: 'createdAt:desc,id:desc' }
    try {
      const result = (await runtime.convex.query(fnQuery('domains/apiKeys/userApi:list'), {
        internalKey: runtime.internalKey,
        actorId: session.userId,
        paginationOpts: await apiKeyPages.paginationOpts(query.data, binding),
      })) as PaginationResult<unknown>
      return c.json(UserApiKeyPageSchema.parse(await apiKeyPages.response(result, binding)))
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
  })

  app.post('/v1/user/api-keys', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const body = UserApiKeyIssueRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    const issued = await runtime.convex.mutation(fn('domains/apiKeys/userApi:issue'), {
      internalKey: runtime.internalKey,
      actorId: session.userId,
      name: body.data.name,
      expiresAt: body.data.expiresAt,
      now: runtime.now(),
    })
    return c.json(UserApiKeyIssuedSchema.parse(issued), 201)
  })

  app.delete('/v1/user/api-keys/:keyId', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    try {
      const result = await runtime.convex.mutation(fn('domains/apiKeys/userApi:revoke'), {
        internalKey: runtime.internalKey,
        actorId: session.userId,
        keyId: c.req.param('keyId'),
        now: runtime.now(),
      })
      return c.json(UserApiKeyRevokedSchema.parse(result))
    } catch (error) {
      if (error instanceof Error && /API key not found/.test(error.message)) {
        return c.json({ error: 'not_found' }, 404)
      }
      throw error
    }
  })

  app.get('/v1/user/oauth-grants', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const query = OAuthGrantListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = { subject: session.userId, filters: {}, order: 'createdAt:desc,id:desc' }
    try {
      const result = (await runtime.convex.query(fnQuery('domains/oauth/api:listGrants'), {
        internalKey: runtime.internalKey,
        actorId: session.userId,
        paginationOpts: await oauthGrantPages.paginationOpts(query.data, binding),
      })) as PaginationResult<OAuthGrantDomainView>
      return c.json(
        OAuthGrantPageSchema.parse(
          await oauthGrantPages.response(result, binding, projectOAuthGrant),
        ),
      )
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
  })

  app.delete('/v1/user/oauth-grants/:grantId', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const grantId = c.req.param('grantId')
    try {
      const revoked = await runtime.convex.mutation(fn('domains/oauth/api:revokeGrant'), {
        internalKey: runtime.internalKey,
        actorId: session.userId,
        grantId,
        now: runtime.now(),
      })
      return c.json(OAuthGrantRevokedSchema.parse(revoked))
    } catch (error) {
      if (error instanceof Error && /OAuth grant not found/.test(error.message)) {
        return c.json({ error: 'not_found' }, 404)
      }
      throw error
    }
  })

  app.post('/v1/user/sync-machines', async c => {
    const actor = requireHumanActor(c)
    if ('response' in actor) return actor.response
    const body = SyncMachineRegisterRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)
    try {
      const machine = await runtime.convex.mutation(fn('domains/syncMachines/api:register'), {
        internalKey: runtime.internalKey,
        actorId: actor.userId,
        ...body.data,
        now: runtime.now(),
      })
      return c.json(SyncMachineSchema.parse(machine))
    } catch (error) {
      if (error instanceof ConvexError && error.data?.code === 'sync_machine_limit')
        return c.json({ error: 'sync_machine_limit' }, 409)
      throw error
    }
  })

  app.get('/v1/user/sync-machines', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    const query = SyncMachineListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const binding = {
      subject: session.userId,
      filters: {},
      order: 'createdAt:desc,creationTime:desc',
    }
    try {
      const result = (await runtime.convex.query(fnQuery('domains/syncMachines/api:list'), {
        internalKey: runtime.internalKey,
        actorId: session.userId,
        paginationOpts: await syncMachinePages.paginationOpts(query.data, binding),
      })) as PaginationResult<unknown>
      return c.json(SyncMachinePageSchema.parse(await syncMachinePages.response(result, binding)))
    } catch (error) {
      if (isCollectionCursorError(error)) {
        return c.json({ error: 'invalid_cursor' }, 400)
      }
      throw error
    }
  })

  app.delete('/v1/user/sync-machines/:machineId', async c => {
    const session = requireHumanActor(c)
    if ('response' in session) return session.response
    try {
      const result = (await runtime.convex.mutation(fn('domains/syncMachines/api:remove'), {
        internalKey: runtime.internalKey,
        actorId: session.userId,
        machineId: c.req.param('machineId'),
        now: runtime.now(),
      })) as { ok: true; removedAt: number; machineId: string; workspaceSlugs: string[] }
      // Detachment is repeatable: a lost response can retry every workspace.
      // Removed machines fail future registration even when a VM is unavailable.
      await Promise.all(
        result.workspaceSlugs.map(slug => gatewayClient.detachMirrorDevice(slug, result.machineId)),
      )
      return c.json(SyncMachineRemovedSchema.parse(result))
    } catch (error) {
      if (error instanceof ConvexError && error.data?.code === 'sync_machine_not_found') {
        return c.json({ error: 'not_found' }, 404)
      }
      throw error
    }
  })
}

type OAuthGrantDomainView = {
  id: string
  client: { id: string; name: string }
  redirectHost: string
  workspace: { slug: string; name: string } | null
  scopes: string[]
  createdAt: number
  revokedAt?: number
}

function projectOAuthGrant(grant: OAuthGrantDomainView) {
  return {
    id: grant.id,
    clientId: grant.client.id,
    clientName: grant.client.name,
    // The host the grant was authorized to redirect to — persisted on the
    // grant, truthful for opaque DCR client ids too (slice 12 fix).
    redirectHost: grant.redirectHost,
    workspace: grant.workspace,
    scopes: grant.scopes,
    createdAt: grant.createdAt,
    revokedAt: grant.revokedAt,
  }
}
