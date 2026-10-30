import { describe, expect, test } from 'bun:test'

import {
  API_VERSION,
  APP_API_CAPABILITIES,
  AppApiScopesSchema,
  CAPABILITIES,
  CapabilityListSchema,
  parseScope,
  scopeSetSatisfies,
  serializeScope,
} from './index'

describe('workspace scope grammar', () => {
  test('app API scopes may explicitly declare no API access', () => {
    expect(AppApiScopesSchema.parse([])).toEqual([])
  })

  test('app API scopes are deduplicated into stable sorted order', () => {
    expect(AppApiScopesSchema.parse(['services', 'files:read', 'services'])).toEqual([
      'files:read',
      'services',
    ])
  })

  test('app API scopes reject admin and names outside the capability grammar', () => {
    expect(APP_API_CAPABILITIES).not.toContain('admin')
    expect(AppApiScopesSchema.safeParse(['admin']).success).toBe(false)
    expect(AppApiScopesSchema.safeParse(['unknown']).success).toBe(false)
  })

  test('a membership-backed capability request may name every capability', () => {
    // One list, not a subset: `roleCanGrant` is the ceiling, so the grammar
    // refuses nothing a workspace owner could legitimately delegate.
    expect(CapabilityListSchema.parse(CAPABILITIES)).toEqual([...CAPABILITIES].sort())
    expect(CapabilityListSchema.parse(['admin'])).toEqual(['admin'])
    expect(CapabilityListSchema.parse(['members'])).toEqual(['members'])
  })

  test('a capability request is canonical once parsed and refuses unknown names', () => {
    expect(CapabilityListSchema.parse(['memory', 'files:read', 'memory'])).toEqual([
      'files:read',
      'memory',
    ])
    expect(CapabilityListSchema.safeParse(['unknown']).success).toBe(false)
    expect(CapabilityListSchema.safeParse(['files']).success).toBe(false)
  })

  test('parses and serializes workspace capability scopes', () => {
    const parsed = parseScope('ws:acme-drive:files:read')
    expect(parsed).toEqual({ workspaceSlug: 'acme-drive', capability: 'files:read' })
    expect(serializeScope(parsed!)).toBe('ws:acme-drive:files:read')
    expect(parseScope('ws:acme-drive:publish')).toEqual({
      workspaceSlug: 'acme-drive',
      capability: 'publish',
    })
  })

  test('rejects malformed scopes, reserved slugs, and unknown capabilities', () => {
    for (const scope of [
      '',
      'acme-drive:files:read',
      'ws:api:files:read',
      'ws:Acme:files:read',
      'ws:acme-drive:unknown',
      'ws:acme-drive:files',
      'ws:acme-drive:files:delete',
    ]) {
      expect(parseScope(scope)).toBeNull()
    }
  })

  test('satisfies exact capabilities only inside the same workspace', () => {
    const scopes = ['ws:acme:files:read', 'ws:beta:files:write']
    expect(scopeSetSatisfies(scopes, 'ws:acme:files:read')).toBe(true)
    expect(scopeSetSatisfies(scopes, 'ws:acme:files:write')).toBe(false)
    expect(scopeSetSatisfies(scopes, 'ws:beta:files:read')).toBe(false)
  })

  test('parses the hard-cutover capabilities and rejects the retired names', () => {
    expect(parseScope('ws:acme:agents')).toEqual({
      workspaceSlug: 'acme',
      capability: 'agents',
    })
    expect(parseScope('ws:acme:sessions')).toEqual({
      workspaceSlug: 'acme',
      capability: 'sessions',
    })
    expect(parseScope('ws:acme:services')).toEqual({
      workspaceSlug: 'acme',
      capability: 'services',
    })
    expect(parseScope('ws:acme:members')).toEqual({
      workspaceSlug: 'acme',
      capability: 'members',
    })
    expect(parseScope('ws:acme:agent')).toBeNull()
    expect(parseScope('ws:acme:ai')).toBeNull()
    expect(scopeSetSatisfies(['ws:acme:sessions'], 'ws:acme:agents')).toBe(false)
    expect(scopeSetSatisfies(['ws:acme:agents'], 'ws:acme:sessions')).toBe(false)
  })

  test('admin implies every capability only within its workspace', () => {
    const scopes = ['ws:acme:admin']
    expect(scopeSetSatisfies(scopes, 'ws:acme:share')).toBe(true)
    expect(scopeSetSatisfies(scopes, 'ws:acme:files:write')).toBe(true)
    expect(scopeSetSatisfies(scopes, 'ws:acme:sessions')).toBe(true)
    expect(scopeSetSatisfies(scopes, 'ws:acme:services')).toBe(true)
    expect(scopeSetSatisfies(scopes, 'ws:acme:members')).toBe(true)
    expect(scopeSetSatisfies(scopes, 'ws:beta:admin')).toBe(false)
    expect(scopeSetSatisfies(scopes, 'not-a-scope')).toBe(false)
  })

  test('owns the public API version shape', () => {
    expect(API_VERSION).toEqual({ api: 1 })
  })
})
