import { describe, expect, test } from 'bun:test'

import {
  DUET_APP_SLUG_HEADER,
  DUET_APP_ACCESS_COOKIE,
  DUET_APP_ACCESS_QUERY,
  DUET_PUBLISH_ANCHOR_PATH_HEADER,
  DUET_PUBLISH_FREEZE_HEADER,
  DUET_PUBLISH_KIND_HEADER,
  DUET_PUBLISH_SLUG_HEADER,
  DUET_VIEWER_DESCRIPTOR_HEADER,
  DUET_VIEWER_USER_ID_HEADER,
  DUET_WORKSPACE_SLUG_HEADER,
  EDGE_SECRET_HEADER,
  EdgeResolveResultSchema,
  EdgeResolveRequestSchema,
  allowedIntegrationRedirect,
  classifyPublishRequest,
  serializeViewerDescriptor,
  parseViewerDescriptor,
  ViewerDescriptorSchema,
  FORWARDED_HOST_HEADER,
  formatTunnelTokenParts,
  mintAppAccessGrant,
  parseEdgeRoute,
  parseTunnelTokenParts,
  TUNNEL_TOKEN_HEADER,
  verifyAppAccessGrant,
} from './index'

const classify = (path: string): ReturnType<typeof classifyPublishRequest> =>
  classifyPublishRequest(new URL(`https://edge.duet.so/acme-drive/q2${path}`))

describe('publish request selector grammar', () => {
  test('no reserved selector routes to the viewer, including unrelated params', () => {
    expect(classify('')).toBe('viewer')
    expect(classify('/deep/nested/file.txt')).toBe('viewer')
    expect(classify('?theme=dark')).toBe('viewer')
    expect(classify('?theme=dark&hl=en')).toBe('viewer')
  })

  test('exactly one reserved selector is authoritative regardless of its value', () => {
    expect(classify('?raw')).toBe('raw')
    expect(classify('?raw=')).toBe('raw')
    expect(classify('?raw=1&theme=dark')).toBe('raw')
    expect(classify('?list')).toBe('list')
    expect(classify('?list=')).toBe('list')
    expect(classify('/sub?list=true')).toBe('list')
  })

  test('both reserved selectors present is invalid — no last-wins tiebreak', () => {
    expect(classify('?raw&list')).toBe('invalid')
    expect(classify('?list&raw')).toBe('invalid')
    expect(classify('?raw=&list=')).toBe('invalid')
  })

  test('zip is a reserved selector, exclusive with raw and list', () => {
    expect(classify('?zip')).toBe('zip')
    expect(classify('?zip=')).toBe('zip')
    expect(classify('/sub/folder?zip=1&theme=dark')).toBe('zip')
    expect(classify('?zip&raw')).toBe('invalid')
    expect(classify('?zip&list')).toBe('invalid')
    expect(classify('?raw&list&zip')).toBe('invalid')
  })
})

describe('edge public URL grammar', () => {
  for (const edgeHost of ['edge.duet.so', 'edge-staging.duet.so']) {
    const context = {
      webAppUrl: 'https://app.duet.so',
      workspaceSlug: 'acme',
      edgeHost,
    }
    const lookalikeEdgeHost = edgeHost.replace(/^e/, '\u0435')
    const accepted = [
      {
        className: 'web-origin relative path',
        value: '/w/acme/settings?source=oauth#connected',
        normalized: 'https://app.duet.so/w/acme/settings',
      },
      {
        className: 'web-origin absolute path',
        value: 'https://app.duet.so/oauth/complete?code=secret#result',
        normalized: 'https://app.duet.so/oauth/complete',
      },
      {
        className: 'own-workspace app origin',
        value: `https://canvas--acme.${edgeHost}/oauth/complete?code=secret#result`,
        normalized: `https://canvas--acme.${edgeHost}/oauth/complete`,
      },
    ]
    const rejected = [
      {
        className: "another workspace's app origin",
        value: `https://canvas--other.${edgeHost}/oauth/complete`,
      },
      { className: 'bare edge host', value: `https://${edgeHost}/` },
      {
        className: 'publish host path',
        value: `https://${edgeHost}/acme/public-notes`,
      },
      { className: 'HTTP app origin', value: `http://canvas--acme.${edgeHost}/oauth/complete` },
      {
        className: 'credentialed app URL',
        value: `https://user:password@canvas--acme.${edgeHost}/oauth/complete`,
      },
      { className: 'protocol-relative URL', value: `//canvas--acme.${edgeHost}/oauth/complete` },
      {
        className: 'suffix-spoofed app host',
        value: `https://canvas--acme.${edgeHost}.evil.example/oauth/complete`,
      },
      {
        className: 'punycode lookalike edge host',
        value: `https://canvas--acme.${lookalikeEdgeHost}/oauth/complete`,
      },
      { className: 'malformed URL', value: 'https://[' },
    ]

    for (const acceptedCase of accepted) {
      test(`${edgeHost}: accepts ${acceptedCase.className} and strips query/hash`, () => {
        expect(allowedIntegrationRedirect(acceptedCase.value, context)).toBe(
          acceptedCase.normalized,
        )
      })
    }

    for (const rejectedCase of rejected) {
      test(`${edgeHost}: rejects ${rejectedCase.className}`, () => {
        expect(allowedIntegrationRedirect(rejectedCase.value, context)).toBeNull()
      })
    }
  }

  test('SUBS-IMPL-11 validates paused resolutions separately from origin resolutions', () => {
    expect(EdgeResolveResultSchema.parse({ paused: true, appName: 'Launch Status' })).toEqual({
      paused: true,
      appName: 'Launch Status',
    })
    expect(() =>
      EdgeResolveResultSchema.parse({ paused: true, appName: '', origin: { httpsUrl: 'nope' } }),
    ).toThrow()
  })

  test('parses app subdomains of the production edge host', () => {
    expect(
      parseEdgeRoute(
        'https://todo--acme-drive.edge.duet.so/dashboard?tab=1',
        'todo--acme-drive.edge.duet.so',
      ),
    ).toEqual({
      kind: 'app',
      host: 'todo--acme-drive.edge.duet.so',
      workspaceSlug: 'acme-drive',
      appSlug: 'todo',
      upstreamPath: '/dashboard?tab=1',
    })
  })

  test('parses app subdomains of the staging edge host', () => {
    expect(
      parseEdgeRoute(
        'https://todo--acme-drive.edge-staging.duet.so/',
        'todo--acme-drive.edge-staging.duet.so',
      ),
    ).toMatchObject({
      kind: 'app',
      appSlug: 'todo',
      workspaceSlug: 'acme-drive',
    })
  })

  test('keeps hyphenated slugs distinct from the app/workspace separator', () => {
    expect(
      parseEdgeRoute(
        'https://task-board--acme-drive.edge.duet.so/',
        'task-board--acme-drive.edge.duet.so',
      ),
    ).toMatchObject({
      kind: 'app',
      appSlug: 'task-board',
      workspaceSlug: 'acme-drive',
    })
    expect(
      parseEdgeRoute(
        'https://task-board-acme-drive.edge.duet.so/',
        'task-board-acme-drive.edge.duet.so',
      ),
    ).toBeNull()
  })

  test('parses publish paths on the production edge host', () => {
    expect(
      parseEdgeRoute('https://edge.duet.so/acme-drive/public-notes/roadmap?q=1', 'edge.duet.so'),
    ).toEqual({
      kind: 'publish',
      host: 'edge.duet.so',
      workspaceSlug: 'acme-drive',
      publishSlug: 'public-notes',
      upstreamPath: '/roadmap?q=1',
    })
  })

  test('bare duet.so and its non-edge subdomains never route', () => {
    expect(parseEdgeRoute('https://duet.so/acme-drive/public-notes', 'duet.so')).toBeNull()
    expect(
      parseEdgeRoute('https://todo--acme-drive.duet.so/', 'todo--acme-drive.duet.so'),
    ).toBeNull()
    expect(parseEdgeRoute('https://app.duet.so/w/acme/apps', 'app.duet.so')).toBeNull()
  })

  test('parses publish paths on the dedicated staging edge host without a forged Host header', () => {
    expect(
      parseEdgeRoute(
        'https://edge-staging.duet.so/acme-drive/public-notes/roadmap?q=1',
        'edge-staging.duet.so',
      ),
    ).toEqual({
      kind: 'publish',
      host: 'edge-staging.duet.so',
      workspaceSlug: 'acme-drive',
      publishSlug: 'public-notes',
      upstreamPath: '/roadmap?q=1',
    })
  })

  test('reserved words and unknown hosts reject without fallback proxying', () => {
    expect(parseEdgeRoute('https://api--acme.edge.duet.so/', 'api--acme.edge.duet.so')).toBeNull()
    expect(parseEdgeRoute('https://edge.duet.so/acme/api', 'edge.duet.so')).toBeNull()
    expect(parseEdgeRoute('https://example.com/acme/public', 'example.com')).toBeNull()
    expect(parseEdgeRoute('https://www.duet.so/acme/public', 'www.duet.so')).toBeNull()
  })
})

describe('edge tunnel token parts', () => {
  test('pins edge routing header names', () => {
    expect(EDGE_SECRET_HEADER).toBe('x-duet-edge-secret')
    expect(FORWARDED_HOST_HEADER).toBe('x-forwarded-host')
    expect(DUET_WORKSPACE_SLUG_HEADER).toBe('x-duet-workspace-slug')
    expect(DUET_APP_SLUG_HEADER).toBe('x-duet-app-slug')
    expect(DUET_PUBLISH_SLUG_HEADER).toBe('x-duet-publish-slug')
    expect(DUET_PUBLISH_KIND_HEADER).toBe('x-duet-publish-kind')
    expect(DUET_PUBLISH_ANCHOR_PATH_HEADER).toBe('x-duet-publish-anchor-path')
    expect(DUET_PUBLISH_FREEZE_HEADER).toBe('x-duet-publish-freeze')
    expect(DUET_VIEWER_USER_ID_HEADER).toBe('x-duet-viewer-user-id')
    expect(TUNNEL_TOKEN_HEADER).toBe('x-duet-tunnel-token')
  })

  test('rejects non-canonical base36 expiry aliases', () => {
    const token = formatTunnelTokenParts({
      expiresAt: 12_345,
      nonce: 'abc123abc123abcd',
      signature: 'a'.repeat(64),
    })

    expect(parseTunnelTokenParts(token)?.expiresAt).toBe(12_345)
    expect(parseTunnelTokenParts(token.replace('duet_tt_9ix_', 'duet_tt_9ix!_'))).toBeNull()
    expect(parseTunnelTokenParts(token.replace('duet_tt_9ix_', 'duet_tt_09ix_'))).toBeNull()
    expect(parseTunnelTokenParts(token.replace('duet_tt_9ix_', 'duet_tt_9IX_'))).toBeNull()
  })
})

describe('edge app access grants', () => {
  test('round-trips exact viewer, workspace, app, and expiry claims', async () => {
    const claims = {
      appId: 'app-id',
      userId: 'user_123',
      workspaceSlug: 'acme-drive',
      appSlug: 'todo',
      launchExpiresAt: 12_000,
      expiresAt: 20_000,
      nonce: '0123456789abcdef0123456789abcdef',
    }
    const token = await mintAppAccessGrant('edge-secret', claims)

    expect(DUET_APP_ACCESS_QUERY).toBe('duet_access')
    expect(DUET_APP_ACCESS_COOKIE).toBe('__Host-duet_app_access')
    expect(await verifyAppAccessGrant('edge-secret', token, 11_999)).toEqual(claims)
    expect(await verifyAppAccessGrant('edge-secret', token, 20_000)).toBeNull()
  })

  test('rejects tampering and a token signed by another environment', async () => {
    const token = await mintAppAccessGrant('staging-secret', {
      appId: 'app-id',
      userId: 'user_123',
      workspaceSlug: 'acme-drive',
      appSlug: 'todo',
      launchExpiresAt: 12_000,
      expiresAt: 12_000,
      nonce: '0123456789abcdef0123456789abcdef',
    })

    expect(await verifyAppAccessGrant('production-secret', token, 11_000)).toBeNull()
    expect(await verifyAppAccessGrant('staging-secret', `${token}x`, 11_000)).toBeNull()
  })
})

describe('public viewer descriptor wire', () => {
  const descriptor = {
    workspaceName: 'Acme Drive',
    ownerName: 'Ada Lovelace',
    rootName: 'q2.md',
    kind: 'file' as const,
  }

  test('the descriptor round-trips through its internal header', () => {
    expect(DUET_VIEWER_DESCRIPTOR_HEADER).toBe('x-duet-viewer-descriptor')
    const serialized = serializeViewerDescriptor(descriptor)
    expect(parseViewerDescriptor(serialized)).toEqual(descriptor)
  })

  test('the schema strips private fields — no email, VM address, or gateway token crosses', () => {
    const parsed = ViewerDescriptorSchema.parse({
      ...descriptor,
      ownerEmail: 'ada@example.com',
      vmName: 'vm-acme-01',
      gatewayAuthToken: 'secret-bearer',
      httpsUrl: 'https://vm.internal',
    })
    expect(parsed).toEqual(descriptor)
    expect(Object.keys(parsed).sort()).toEqual(['kind', 'ownerName', 'rootName', 'workspaceName'])
  })

  test('an email-shaped owner label is rejected, not published', () => {
    expect(() =>
      ViewerDescriptorSchema.parse({ ...descriptor, ownerName: 'ada@example.com' }),
    ).toThrow()
  })

  test('every descriptor field is required', () => {
    for (const field of ['workspaceName', 'ownerName', 'rootName', 'kind'] as const) {
      const { [field]: _omitted, ...rest } = descriptor
      expect(() => ViewerDescriptorSchema.parse(rest)).toThrow()
    }
  })

  test('parseViewerDescriptor returns null for a missing or malformed header', () => {
    expect(parseViewerDescriptor(null)).toBeNull()
    expect(parseViewerDescriptor(undefined)).toBeNull()
    expect(parseViewerDescriptor('not json')).toBeNull()
    expect(parseViewerDescriptor(JSON.stringify({ workspaceName: 'x' }))).toBeNull()
  })
})

describe('custom app host resolution', () => {
  test('requires a hostname lookup before a complete custom binding may enter app admission', () => {
    expect(
      EdgeResolveRequestSchema.safeParse({ kind: 'app-host', hostname: 'aomni.co' }).success,
    ).toBe(true)
    expect(
      EdgeResolveRequestSchema.safeParse({ kind: 'app-host', hostname: 'app.duet.so' }).success,
    ).toBe(false)
    expect(
      EdgeResolveRequestSchema.safeParse({
        kind: 'app',
        host: 'aomni.co',
        workspaceSlug: 'acme-drive',
        appSlug: 'todo',
        customBinding: { hostname: 'aomni.co' },
      }).success,
    ).toBe(false)
  })
})

test('app grants bind the durable app identity alongside reusable slugs', async () => {
  const token = await mintAppAccessGrant('secret', {
    appId: 'durable-app-id',
    userId: 'user',
    workspaceSlug: 'acme',
    appSlug: 'todo',
    launchExpiresAt: 20_000,
    expiresAt: 30_000,
    nonce: '0123456789abcdef0123456789abcdef',
  })
  expect((await verifyAppAccessGrant('secret', token, 10_000))?.appId).toBe('durable-app-id')
})
