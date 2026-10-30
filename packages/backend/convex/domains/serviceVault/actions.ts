'use node'

import { makeFunctionReference } from 'convex/server'
import { v } from 'convex/values'

import { internalAction } from '../../_generated/server'
import { requireApiInternalKey } from '../apiKeys/model'

const getResource = makeFunctionReference<'query'>('domains/serviceVault/model:getPoolResource')
const getCredential = makeFunctionReference<'query'>('domains/serviceVault/model:getServiceCredential')
const markExpired = makeFunctionReference<'mutation'>('domains/serviceVault/model:markPoolResourceExpired')

export const expirePoolResource = internalAction({
  args: { internalKey: v.string(), resourceId: v.id('servicePoolResources') },
  handler: async (ctx, args) => {
    requireApiInternalKey(args.internalKey)
    const row = await ctx.runQuery(getResource, { internalKey: args.internalKey, resourceId: args.resourceId }) as { serviceId: string; resourceId: string; state: string; expiry?: { baseUrl: string; method: string; path: string; body?: unknown; authKind: string; authName?: string } } | null
    if (row === null || row.state !== 'live') return { expired: false }
    const credential = await ctx.runQuery(getCredential, { internalKey: args.internalKey, serviceId: row.serviceId, name: 'apiKey' }) as { secret: string } | null
    if (!credential) return { expired: false }
    // Rows written before expiry metadata was persisted are the existing
    // ElevenLabs voice rows; keep their already-scheduled cleanup intact.
    const expiry = row.expiry ?? (row.serviceId === 'elevenlabs'
      ? { baseUrl: 'https://api.elevenlabs.io', method: 'DELETE', path: '/v1/voices/:voiceId', authKind: 'header', authName: 'xi-api-key' }
      : undefined)
    if (expiry === undefined) return { expired: false }
    const path = expiry.path.replace(/:([A-Za-z0-9_]+)/g, encodeURIComponent(row.resourceId))
    const target = new URL(`${expiry.baseUrl}${path}`)
    const headers = new Headers()
    if (expiry.authKind === 'header' && expiry.authName) headers.set(expiry.authName, credential.secret)
    else if (expiry.authKind === 'bearer') headers.set('authorization', `Bearer ${credential.secret}`)
    else if (expiry.authKind === 'basic') headers.set('authorization', `Basic ${credential.secret}`)
    else if (expiry.authKind === 'query' && expiry.authName) target.searchParams.set(expiry.authName, credential.secret)
    const init: RequestInit = { method: expiry.method, headers }
    if (expiry.body !== undefined) {
      headers.set('content-type', 'application/json')
      init.body = JSON.stringify(expiry.body)
    }
    const response = await fetch(target, init)
    if (!response.ok && response.status !== 404) throw new Error(`Pool expiry failed with HTTP ${response.status}`)
    await ctx.runMutation(markExpired, { internalKey: args.internalKey, resourceId: args.resourceId })
    return { expired: true }
  },
})
