import { describe, expect, test } from 'bun:test'

import { COLLECTION_PAGE_DEFAULT_LIMIT, COLLECTION_PAGE_MAX_LIMIT } from '../pagination/index'

import { z } from 'zod'

import { MAX_AGENTS_PER_WORKSPACE } from '../agents/index'
import { createBoundCursorCodec } from '../pagination/index'
import {
  IntegrationCatalogPageSchema,
  IntegrationAgentPolicyResponseSchema,
  IntegrationCatalogQuerySchema,
  IntegrationConnectionListSchema,
  IntegrationConnectRequestSchema,
  IntegrationConnectResponseSchema,
  MAX_INTEGRATION_AGENT_ID_UTF8_BYTES,
  MAX_INTEGRATION_AUTHORIZE_URL_UTF8_BYTES,
  MAX_INTEGRATION_CATALOG_DESCRIPTION_UTF8_BYTES,
  MAX_INTEGRATION_CATALOG_NAME_UTF8_BYTES,
  MAX_INTEGRATION_CONNECTION_ID_UTF8_BYTES,
  MAX_INTEGRATION_LOGO_URL_UTF8_BYTES,
  MAX_INTEGRATION_PROVIDER_CURSOR_UTF8_BYTES,
  MAX_INTEGRATION_PUBLIC_CURSOR_UTF8_BYTES,
  MAX_INTEGRATION_SLUG_UTF8_BYTES,
  IntegrationProviderConnectionPageSchema,
  SetIntegrationAgentPolicyRequestSchema,
} from './index'

describe('integration lifecycle contract', () => {
  test('preserves the absent and explicit-empty integration policy states', () => {
    expect(SetIntegrationAgentPolicyRequestSchema.parse({})).toEqual({})
    expect(SetIntegrationAgentPolicyRequestSchema.parse({ allowedAgentIds: [] })).toEqual({
      allowedAgentIds: [],
    })
    expect(IntegrationAgentPolicyResponseSchema.parse({ integration: 'gmail' })).toEqual({
      integration: 'gmail',
    })
    expect(
      IntegrationAgentPolicyResponseSchema.parse({ integration: 'gmail', allowedAgentIds: [] }),
    ).toEqual({ integration: 'gmail', allowedAgentIds: [] })
  })

  test('bounds an integration policy to root plus the workspace agent maximum', () => {
    const maximumPolicy = [
      'root',
      ...Array.from({ length: MAX_AGENTS_PER_WORKSPACE }, (_, index) => `agent-${index}`),
    ]
    expect(
      SetIntegrationAgentPolicyRequestSchema.safeParse({ allowedAgentIds: maximumPolicy }).success,
    ).toBe(true)
    expect(
      SetIntegrationAgentPolicyRequestSchema.safeParse({
        allowedAgentIds: [...maximumPolicy, 'one-too-many'],
      }).success,
    ).toBe(false)
  })

  test('bounds catalog pagination and normalizes the default page size', () => {
    expect(IntegrationCatalogQuerySchema.parse({})).toEqual({ limit: COLLECTION_PAGE_DEFAULT_LIMIT })
    expect(IntegrationCatalogQuerySchema.safeParse({ limit: COLLECTION_PAGE_MAX_LIMIT + 1 }).success).toBe(false)
  })

  test('bounds every provider-backed catalog and connection row in UTF-8 bytes', () => {
    const at = (bytes: number) => `${'a'.repeat(bytes - 4)}🚀`
    const over = (bytes: number) => `${'a'.repeat(bytes - 3)}🚀`
    const catalog = {
      integration: at(MAX_INTEGRATION_SLUG_UTF8_BYTES),
      name: at(MAX_INTEGRATION_CATALOG_NAME_UTF8_BYTES),
      description: at(MAX_INTEGRATION_CATALOG_DESCRIPTION_UTF8_BYTES),
      logoUrl: `https://example.test/${'a'.repeat(MAX_INTEGRATION_LOGO_URL_UTF8_BYTES - 25)}`,
      connected: false,
    }
    expect(
      IntegrationCatalogPageSchema.safeParse({ items: [catalog], nextCursor: null }).success,
    ).toBe(true)
    expect(
      IntegrationCatalogPageSchema.safeParse({
        items: [{ ...catalog, name: over(MAX_INTEGRATION_CATALOG_NAME_UTF8_BYTES) }],
        nextCursor: null,
      }).success,
    ).toBe(false)
    expect(
      IntegrationCatalogPageSchema.safeParse({
        items: [{ ...catalog, description: over(MAX_INTEGRATION_CATALOG_DESCRIPTION_UTF8_BYTES) }],
        nextCursor: null,
      }).success,
    ).toBe(false)
    expect(
      IntegrationCatalogPageSchema.safeParse({
        items: [{ ...catalog, integration: over(MAX_INTEGRATION_SLUG_UTF8_BYTES) }],
        nextCursor: null,
      }).success,
    ).toBe(false)
    expect(
      IntegrationCatalogPageSchema.safeParse({
        items: [
          {
            ...catalog,
            logoUrl: `https://example.test/${'x'.repeat(MAX_INTEGRATION_LOGO_URL_UTF8_BYTES)}`,
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(false)
    expect(
      IntegrationCatalogPageSchema.safeParse({
        items: Array.from({ length: COLLECTION_PAGE_MAX_LIMIT + 1 }, () => catalog),
        nextCursor: null,
      }).success,
    ).toBe(false)

    const connection = {
      id: at(MAX_INTEGRATION_CONNECTION_ID_UTF8_BYTES),
      integration: catalog.integration,
      name: catalog.name,
      logoUrl: catalog.logoUrl,
      status: 'active',
      connectedAt: 1,
      updatedAt: 1,
    }
    expect(
      IntegrationConnectionListSchema.safeParse({ items: [connection], nextCursor: null }).success,
    ).toBe(true)
    expect(
      IntegrationConnectionListSchema.safeParse({
        items: [{ ...connection, id: over(MAX_INTEGRATION_CONNECTION_ID_UTF8_BYTES) }],
        nextCursor: null,
      }).success,
    ).toBe(false)
    expect(
      IntegrationConnectionListSchema.safeParse({
        items: [
          {
            ...connection,
            allowedAgentIds: [over(MAX_INTEGRATION_AGENT_ID_UTF8_BYTES)],
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(false)
    expect(
      IntegrationConnectResponseSchema.safeParse({
        integration: 'gmail',
        authorizeUrl: `https://example.test/${'x'.repeat(
          MAX_INTEGRATION_AUTHORIZE_URL_UTF8_BYTES,
        )}`,
      }).success,
    ).toBe(false)
  })

  test('bounds provider and public continuation tokens independently', () => {
    expect(
      IntegrationProviderConnectionPageSchema.safeParse({
        items: [],
        nextCursor: 'c'.repeat(MAX_INTEGRATION_PROVIDER_CURSOR_UTF8_BYTES),
      }).success,
    ).toBe(true)
    expect(
      IntegrationProviderConnectionPageSchema.safeParse({
        items: [],
        nextCursor: 'c'.repeat(MAX_INTEGRATION_PROVIDER_CURSOR_UTF8_BYTES + 1),
      }).success,
    ).toBe(false)
    expect(
      IntegrationConnectionListSchema.safeParse({
        items: [],
        nextCursor: 'c'.repeat(MAX_INTEGRATION_PUBLIC_CURSOR_UTF8_BYTES + 1),
      }).success,
    ).toBe(false)
  })

  test('a maximum provider cursor fits after public binding', async () => {
    const codec = createBoundCursorCodec(
      'integrations.catalog',
      z.object({ cursor: z.string().min(1) }).strict(),
    )
    // Opaque means no alphabet assumption. Control characters are the
    // worst-case JSON-escaping expansion inside the public cursor wrapper.
    const providerCursor = '\u0001'.repeat(MAX_INTEGRATION_PROVIDER_CURSOR_UTF8_BYTES)
    expect(
      IntegrationProviderConnectionPageSchema.safeParse({
        items: [],
        nextCursor: providerCursor,
      }).success,
    ).toBe(true)
    const cursor = await codec.encode({
      subject: `workspace:${'w'.repeat(32)}`,
      filters: { q: 'q'.repeat(200) },
      order: 'provider-native order',
      position: { cursor: providerCursor },
    })

    expect(new TextEncoder().encode(cursor).byteLength).toBeLessThanOrEqual(
      MAX_INTEGRATION_PUBLIC_CURSOR_UTF8_BYTES,
    )
    expect(IntegrationCatalogQuerySchema.safeParse({ cursor, limit: COLLECTION_PAGE_MAX_LIMIT }).success).toBe(true)
  })

  test('does not accept caller-supplied entity or tenant identity', () => {
    expect(
      IntegrationConnectRequestSchema.parse({
        integration: 'gmail',
        redirectTo: '/integrations',
        entityId: 'spoofed',
        workspaceId: 'spoofed',
      }),
    ).toEqual({ integration: 'gmail', redirectTo: '/integrations' })
  })

  test('allows browser navigation only to an HTTPS provider authorization URL', () => {
    const response = {
      integration: 'gmail',
    }
    expect(
      IntegrationConnectResponseSchema.safeParse({
        ...response,
        authorizeUrl: 'javascript:alert(1)',
      }).success,
    ).toBe(false)
    expect(
      IntegrationConnectResponseSchema.safeParse({
        ...response,
        authorizeUrl: 'http://connect.example.test/gmail',
      }).success,
    ).toBe(false)
    expect(
      IntegrationConnectResponseSchema.parse({
        ...response,
        authorizeUrl: 'https://connect.example.test/gmail',
      }),
    ).toMatchObject({
      authorizeUrl: 'https://connect.example.test/gmail',
    })
  })
})
