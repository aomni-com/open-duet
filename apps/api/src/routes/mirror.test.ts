import { describe, expect, test } from 'bun:test'

import { Hono } from 'hono'

import { API_VERSION, MAX_MIRROR_DEVICES_PER_WORKSPACE } from '@repo/contract'

import { type GatewayClient } from '../gateway/client'
import { type ApiRouteRuntime, type ApiVariables, type AuthPayload } from '../shared'
import { registerMirrorRoutes } from './mirror'

const FULL_DEVICE_ID = 'K5MNBGJ-QT4EVLE-KPBQKY7-CPT4L2N-QU4WHNA-2XBTUXO-Q7XCLHS-6MZ4DAY'

function humanAuth(overrides: Partial<AuthPayload> = {}): AuthPayload {
  return {
    credentialKind: 'user',
    credentialId: 'key_1',
    user: { id: 'usr_1', email: 'owner@example.com' },
    workspaces: [
      {
        id: 'ws_1',
        slug: 'acme',
        name: 'Acme',
        status: 'active',
        servicingStatus: 'active',
        onboardedAt: 1,
        role: 'editor',
        billingUserId: 'usr_1',
        funding: { plan: null, active: true },
        creditRecovery: null,
        defaultTier: { effective: 'balanced' },
      },
    ],
    scopes: ['ws:acme:files:read', 'ws:acme:files:write'],
    versions: API_VERSION,
    ...overrides,
  }
}

const TUNNEL_GRANT = {
  url: 'wss://acme-vm.exe.dev/v1/tunnel/accept/mirror-machine_9-abc',
  tunnelToken: '1767293700000.9f3c.4b8a',
  expiresAt: 1767293700000,
}

function buildApp(input: {
  auth: AuthPayload
  convex?: Partial<{ mutation: () => Promise<unknown>; query: () => Promise<unknown> }>
  gateway?: Partial<GatewayClient>
}) {
  const app = new Hono<{ Variables: ApiVariables }>()
  app.use('*', async (c, next) => {
    c.set('auth', input.auth)
    await next()
  })
  const runtime = {
    convex: {
      mutation:
        input.convex?.mutation ?? (async () => ({ machineId: 'machine_9', name: 'MacBook Pro' })),
      query: input.convex?.query ?? (async () => true),
    },
    internalKey: 'internal',
    now: () => 1767290000000,
  } as unknown as ApiRouteRuntime
  const gateway = {
    registerMirrorDevice: async () => ({
      folderId: 'workspace-drive',
      vmSyncthingDeviceId: 'VMDEVICE-ID',
    }),
    mintMirrorTunnel: async () => TUNNEL_GRANT,
    listMirrorDevices: async () => ({ devices: [] }),
    removeMirrorDevice: async () => ({ ok: true as const }),
    detachMirrorDevice: async () => undefined,
    ...input.gateway,
  } as unknown as GatewayClient
  registerMirrorRoutes(app as never, runtime, gateway)
  return app
}

describe('mirror-device routes', () => {
  test('registers the calling device: binds, provisions, and returns a tunnel grant', async () => {
    const app = buildApp({ auth: humanAuth() })
    const response = await app.request('/v1/ws/acme/mirror-devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId: 'machine_9', syncthingDeviceId: FULL_DEVICE_ID }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      machineId: 'machine_9',
      folderId: 'workspace-drive',
      vmSyncthingDeviceId: 'VMDEVICE-ID',
      tunnel: TUNNEL_GRANT,
    })
  })

  test('requires human identity to name a user-owned machine', async () => {
    const app = buildApp({
      auth: humanAuth({ credentialKind: 'system_vm', credentialId: 'key_1' }),
    })
    const response = await app.request('/v1/ws/acme/mirror-devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId: 'machine_9', syncthingDeviceId: FULL_DEVICE_ID }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'human_credential_required' })
  })

  test('rejects registration without workspace write scope', async () => {
    const app = buildApp({
      auth: humanAuth({ scopes: ['ws:acme:files:read'] }),
    })
    const response = await app.request('/v1/ws/acme/mirror-devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId: 'machine_9', syncthingDeviceId: FULL_DEVICE_ID }),
    })
    expect(response.status).toBe(403)
  })

  test('rejects a malformed Syncthing device id', async () => {
    const app = buildApp({ auth: humanAuth() })
    const response = await app.request('/v1/ws/acme/mirror-devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId: 'machine_9', syncthingDeviceId: 'not a device id!' }),
    })
    expect(response.status).toBe(400)
  })

  test('maps a missing gateway to 404', async () => {
    const app = buildApp({
      auth: humanAuth(),
      gateway: { registerMirrorDevice: async () => ({ error: 'not_found' as const }) },
    })
    const response = await app.request('/v1/ws/acme/mirror-devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId: 'machine_9', syncthingDeviceId: FULL_DEVICE_ID }),
    })
    expect(response.status).toBe(404)
  })

  test('lists mirror devices', async () => {
    const app = buildApp({
      auth: humanAuth(),
      gateway: {
        listMirrorDevices: async () => ({
          devices: [
            {
              machineId: 'machine_9',
              deviceName: 'MacBook Pro',
              syncthingDeviceId: FULL_DEVICE_ID,
              registeredAt: 1767290000000,
            },
          ],
        }),
      },
    })
    const response = await app.request('/v1/ws/acme/mirror-devices')
    expect(response.status).toBe(200)
    expect((await response.json()) as unknown).toEqual({
      items: [
        {
          machineId: 'machine_9',
          deviceName: 'MacBook Pro',
          syncthingDeviceId: FULL_DEVICE_ID,
          registeredAt: 1767290000000,
        },
      ],
      nextCursor: null,
    })
  })

  test('fails closed when a gateway violates the bounded mirror-device source invariant', async () => {
    const app = buildApp({
      auth: humanAuth(),
      gateway: {
        listMirrorDevices: async () => ({
          devices: Array.from({ length: MAX_MIRROR_DEVICES_PER_WORKSPACE + 1 }, (_, index) => ({
            machineId: `cred_${index}`,
            syncthingDeviceId: FULL_DEVICE_ID,
            registeredAt: index,
          })),
        }),
      },
    })
    const response = await app.request('/v1/ws/acme/mirror-devices')
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'mirror_gateway_failed' })
  })

  test('maps the mirror-device admission limit to a stable conflict', async () => {
    const app = buildApp({
      auth: humanAuth(),
      gateway: {
        registerMirrorDevice: async () => ({ error: 'mirror_device_limit' as const }),
      },
    })
    const response = await app.request('/v1/ws/acme/mirror-devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ machineId: 'machine_9', syncthingDeviceId: FULL_DEVICE_ID }),
    })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'mirror_device_limit' })
  })

  test('removes an owned machine from this workspace', async () => {
    const app = buildApp({
      auth: humanAuth(),
    })
    const response = await app.request('/v1/ws/acme/mirror-devices/machine_9', { method: 'DELETE' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, machineId: 'machine_9' })
  })

  test('refuses to remove a device the user does not own', async () => {
    const app = buildApp({
      auth: humanAuth(),
      convex: { query: async () => false },
    })
    const response = await app.request('/v1/ws/acme/mirror-devices/machine_other', {
      method: 'DELETE',
    })
    expect(response.status).toBe(404)
  })
})
