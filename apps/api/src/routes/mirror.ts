import { ConvexError } from 'convex/values'

import {
  MirrorDeviceListSchema,
  MirrorDeviceListQuerySchema,
  MAX_MIRROR_DEVICES_PER_WORKSPACE,
  MirrorRegisterRequestSchema,
  MirrorRegisteredSchema,
  MirrorRemovedSchema,
  isCollectionCursorError,
  WORKSPACE_ARCHIVED_ERROR,
  WORKSPACE_PAUSED_ERROR,
  WORKSPACE_PROVISIONING_ERROR,
  WORKSPACE_UNHEALTHY_ERROR,
  type Capability,
  type MirrorDevice,
} from '@repo/contract'

import { createMaterializedCollectionPage } from '../collection-page'
import { type GatewayClient, type GatewayRequestError } from '../gateway/client'
import {
  fn,
  fnQuery,
  readJson,
  requireAuthedWorkspace,
  requireHumanActor,
  type ApiApp,
  type ApiContext,
  type ApiRouteRuntime,
  type WorkspaceRef,
} from '../shared'

const mirrorDevicePages = createMaterializedCollectionPage('mirror-devices.list')

// Whole-drive mirrors share ordinary human identity and live workspace access.
export function registerMirrorRoutes(
  app: ApiApp,
  runtime: ApiRouteRuntime,
  gatewayClient: GatewayClient,
): void {
  app.post('/v1/ws/:workspaceSlug/mirror-devices', async c => {
    const authed = requireMirrorWorkspace(c, 'files:write')
    if ('response' in authed) return authed.response
    const body = MirrorRegisterRequestSchema.safeParse(await readJson(c.req.raw))
    if (!body.success) return c.json({ error: 'invalid_request' }, 400)

    // Bind this workspace registration to the authenticated person’s machine.
    let machine: { machineId: string; name: string }
    try {
      const bound = (await runtime.convex.mutation(fn('domains/syncMachines/api:use'), {
        internalKey: runtime.internalKey,
        actorId: c.get('auth').user.id,
        machineId: body.data.machineId,
        workspaceId: authed.workspace.id,
        syncthingDeviceId: body.data.syncthingDeviceId,
        now: runtime.now(),
      })) as { machineId: string; name: string }
      machine = bound
    } catch (error) {
      if (error instanceof ConvexError && error.data?.code === 'workspace_write_access_required')
        return c.json({ error: 'insufficient_scope' }, 403)
      if (error instanceof ConvexError && error.data?.code === 'sync_machine_not_found') {
        return c.json({ error: 'not_found' }, 404)
      }
      throw error
    }

    const registered = await gatewayClient.registerMirrorDevice(authed.workspace.slug, {
      machineId: machine.machineId,
      syncthingDeviceId: body.data.syncthingDeviceId,
      deviceName: machine.name,
    })
    if ('error' in registered) return mirrorGatewayError(c, registered.error)

    const tunnel = await gatewayClient.mintMirrorTunnel(authed.workspace.slug, machine.machineId)
    if ('error' in tunnel) return mirrorGatewayError(c, tunnel.error)

    return c.json(
      MirrorRegisteredSchema.parse({
        machineId: machine.machineId,
        folderId: registered.folderId,
        vmSyncthingDeviceId: registered.vmSyncthingDeviceId,
        tunnel,
      }),
    )
  })

  app.get('/v1/ws/:workspaceSlug/mirror-devices', async c => {
    const authed = requireMirrorWorkspace(c, 'files:read')
    if ('response' in authed) return authed.response
    const query = MirrorDeviceListQuerySchema.safeParse(c.req.query())
    if (!query.success) return c.json({ error: 'invalid_request' }, 400)
    const listed = await gatewayClient.listMirrorDevices(authed.workspace.slug)
    if ('error' in listed) return mirrorGatewayError(c, listed.error)
    if (listed.devices.length > MAX_MIRROR_DEVICES_PER_WORKSPACE) {
      return mirrorGatewayError(c, 'gateway_failed')
    }
    const devices = [...listed.devices] as MirrorDevice[]
    devices.sort(
      (left, right) =>
        right.registeredAt - left.registeredAt || left.machineId.localeCompare(right.machineId),
    )
    try {
      const page = await mirrorDevicePages.response(
        query.data,
        {
          subject: `workspace:${authed.workspace.id}:user:${c.get('auth').user.id}`,
          filters: {},
          order: 'registration time desc, device id asc',
        },
        devices,
        device => [-device.registeredAt, device.machineId],
      )
      return c.json(MirrorDeviceListSchema.parse(page))
    } catch (error) {
      if (isCollectionCursorError(error)) return c.json({ error: 'invalid_cursor' }, 400)
      throw error
    }
  })

  app.delete('/v1/ws/:workspaceSlug/mirror-devices/:machineId', async c => {
    const authed = requireMirrorWorkspace(c, 'files:write')
    if ('response' in authed) return authed.response
    const machineId = c.req.param('machineId')
    const owned = await runtime.convex.query(fnQuery('domains/syncMachines/api:owned'), {
      internalKey: runtime.internalKey,
      actorId: c.get('auth').user.id,
      machineId,
    })
    if (!owned) return c.json({ error: 'not_found' }, 404)
    const removed = await gatewayClient.removeMirrorDevice(authed.workspace.slug, machineId)
    if ('error' in removed) return mirrorGatewayError(c, removed.error)
    return c.json(MirrorRemovedSchema.parse({ ok: true, machineId }))
  })
}

function requireMirrorWorkspace(
  c: ApiContext,
  capability: Extract<Capability, 'files:read' | 'files:write'>,
): { workspace: WorkspaceRef } | { response: Response } {
  const actor = requireHumanActor(c)
  if ('response' in actor) return actor
  const workspace = requireAuthedWorkspace(c, capability)
  if ('response' in workspace) return workspace
  return { workspace }
}

function mirrorGatewayError(c: ApiContext, error: GatewayRequestError): Response {
  if (error === 'not_found') return c.json({ error: 'not_found' }, 404)
  if (error === 'mirror_device_limit') return c.json({ error: 'mirror_device_limit' }, 409)
  if (error === WORKSPACE_PAUSED_ERROR) return c.json({ error: WORKSPACE_PAUSED_ERROR }, 402)
  if (error === WORKSPACE_PROVISIONING_ERROR) {
    return c.json({ error: WORKSPACE_PROVISIONING_ERROR }, 409)
  }
  if (error === WORKSPACE_UNHEALTHY_ERROR) return c.json({ error: WORKSPACE_UNHEALTHY_ERROR }, 503)
  if (error === WORKSPACE_ARCHIVED_ERROR) return c.json({ error: WORKSPACE_ARCHIVED_ERROR }, 410)
  return c.json({ error: 'mirror_gateway_failed' }, 502)
}
