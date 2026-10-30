import { describe, expect, test } from 'bun:test'

import {
  assertBareFileResponseHeaders,
  extractFileResource,
  extractGeneratedVideoResource,
} from './staging-live-mcp-file-resources.ts'
import {
  MCP_OAUTH_STAGING_LEGS,
  parseBearerChallenge,
  parseMcpJsonRpcResponse,
  pkceChallenge,
  readMcpOAuthJourneyEnv,
  runMcpOAuthSequence,
} from './staging-live-mcp-oauth.ts'

describe('MCP OAuth staging journey units', () => {
  test('parses the deployed bearer challenge without depending on parameter order', () => {
    expect(
      parseBearerChallenge(
        'Bearer scope="files:read memory", resource_metadata="https://mcp-staging.duet.so/.well-known/oauth-protected-resource"',
      ),
    ).toEqual({
      scope: 'files:read memory',
      resource_metadata: 'https://mcp-staging.duet.so/.well-known/oauth-protected-resource',
    })
    expect(
      parseBearerChallenge(
        'Bearer resource_metadata="https://fixture.test/resource", scope="memory"',
      ),
    ).toEqual({ resource_metadata: 'https://fixture.test/resource', scope: 'memory' })
    expect(() => parseBearerChallenge('Basic realm="duet"')).toThrow('Bearer challenge')
    expect(() => parseBearerChallenge('Bearer opaque')).toThrow('Bearer challenge')
  })

  test('parses JSON and SSE MCP responses through one JSON-RPC contract', () => {
    expect(parseMcpJsonRpcResponse('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { ok: true },
    })
    expect(
      parseMcpJsonRpcResponse(
        'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[]}}\n\n',
      ),
    ).toEqual({
      jsonrpc: '2.0',
      id: 2,
      result: { content: [] },
    })
    expect(() => parseMcpJsonRpcResponse('data: not-json\n\n')).toThrow('JSON-RPC')
  })

  test('accepts only the exact binary file ResourceLink result', () => {
    const resource = {
      type: 'resource_link' as const,
      uri: 'https://vm.example/v1/files/mcp/probe.bin?grant=opaque',
      name: 'mcp/probe.bin',
      mimeType: 'application/octet-stream',
      size: 4,
    }
    expect(
      extractFileResource(
        { content: [resource] },
        { name: 'mcp/probe.bin', mimeType: 'application/octet-stream', size: 4 },
      ),
    ).toEqual(resource)
    const structuredError = captureError(() =>
      extractFileResource(
        { content: [resource], structuredContent: { file: resource } },
        { name: 'mcp/probe.bin', mimeType: 'application/octet-stream', size: 4 },
      ),
    )
    expect(structuredError).toContain('structuredContent')
    expect(structuredError).not.toContain('grant=opaque')
    const metadataError = captureError(() =>
      extractFileResource(
        { content: [resource], _meta: { file: resource } },
        { name: 'mcp/probe.bin', mimeType: 'application/octet-stream', size: 4 },
      ),
    )
    expect(metadataError).toContain('_meta')
    expect(metadataError).not.toContain('grant=opaque')
    const invalidUrlError = captureError(() =>
      extractFileResource(
        { content: [{ ...resource, uri: 'invalid://[?grant=opaque' }] },
        { name: 'mcp/probe.bin', mimeType: 'application/octet-stream', size: 4 },
      ),
    )
    expect(invalidUrlError).toContain('valid URL')
    expect(invalidUrlError).not.toContain('grant=opaque')
    expect(() =>
      extractFileResource(
        { content: [{ ...resource, uri: 'https://vm.example/v1/files/mcp/probe.bin' }] },
        { name: 'mcp/probe.bin', mimeType: 'application/octet-stream', size: 4 },
      ),
    ).toThrow('grant')
    expect(() =>
      extractFileResource(
        {
          content: [
            {
              ...resource,
              uri: 'https://vm.example/v1/files/mcp/different.bin?grant=opaque',
            },
          ],
        },
        { name: 'mcp/probe.bin', mimeType: 'application/octet-stream', size: 4 },
      ),
    ).toThrow('path')
  })

  test('accepts inline text and generated video through the same file-resource shape', () => {
    const textLink = {
      type: 'resource_link' as const,
      uri: 'https://vm.example/v1/files/mcp/notes.txt?grant=text-token',
      name: 'mcp/notes.txt',
      mimeType: 'text/plain',
      size: 5,
    }
    expect(
      extractFileResource(
        { content: [{ type: 'text', text: 'hello' }, textLink] },
        { name: textLink.name, mimeType: textLink.mimeType, size: textLink.size, text: 'hello' },
      ),
    ).toEqual(textLink)

    const videoLink = {
      type: 'resource_link' as const,
      uri: 'https://vm.example/v1/files/mcp/generated-media/video.mp4?grant=video-token',
      name: 'mcp/generated-media/video.mp4',
      mimeType: 'video/mp4',
      size: 42,
    }
    expect(
      extractFileResource(
        { content: [videoLink] },
        { name: videoLink.name, mimeType: videoLink.mimeType, size: videoLink.size },
      ),
    ).toEqual(videoLink)
    expect(() =>
      extractFileResource(
        { content: [{ type: 'text', text: 'duplicate' }, videoLink] },
        { name: videoLink.name, mimeType: videoLink.mimeType, size: videoLink.size },
      ),
    ).toThrow('exactly one block')
  })

  test('requires generated video paths to use a UUID and the shared MIME extension', () => {
    const resource = {
      type: 'resource_link' as const,
      uri: 'https://vm.example/v1/files/mcp/generated-media/123e4567-e89b-42d3-a456-426614174000.mp4?grant=video-token',
      name: 'mcp/generated-media/123e4567-e89b-42d3-a456-426614174000.mp4',
      mimeType: 'video/mp4',
      size: 42,
    }
    expect(extractGeneratedVideoResource({ content: [resource] })).toEqual(resource)
    expect(() =>
      extractGeneratedVideoResource({
        content: [
          {
            ...resource,
            name: resource.name.replace(/\.mp4$/, '.png'),
            uri: resource.uri.replace(/\.mp4\?/, '.png?'),
          },
        ],
      }),
    ).toThrow('extension')
    expect(() =>
      extractGeneratedVideoResource({
        content: [
          {
            ...resource,
            name: 'mcp/generated-media/hand-picked.mp4',
            uri: 'https://vm.example/v1/files/mcp/generated-media/hand-picked.mp4?grant=video-token',
          },
        ],
      }),
    ).toThrow('durable UUID path')
  })

  test('validates supplied bare file headers and rejects missing content length', () => {
    const full = new Response(new Uint8Array(4), {
      headers: {
        'accept-ranges': 'bytes',
        'content-length': '4',
        'content-type': 'application/octet-stream',
        etag: '"full"',
        'last-modified': 'Tue, 25 Aug 2026 12:00:00 GMT',
      },
    })
    expect(() =>
      assertBareFileResponseHeaders(full, {
        mimeType: 'application/octet-stream',
        size: 4,
        requireLastModified: true,
      }),
    ).not.toThrow()

    const missingLength = new Response(new Uint8Array(4), {
      headers: {
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
        etag: '"full"',
      },
    })
    expect(() =>
      assertBareFileResponseHeaders(missingLength, {
        mimeType: 'application/octet-stream',
        size: 4,
      }),
    ).toThrow('Content-Length')
  })

  test('derives the RFC 7636 S256 challenge deterministically', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  test('requires a staging MCP public origin', () => {
    const env = readMcpOAuthJourneyEnv({
      DUET_API_URL: 'https://ctl-staging.duet.so',
      DUET_APP_URL: 'https://app-staging.duet.so',
      DUET_MCP_PUBLIC_URL: 'https://mcp-staging.duet.so/',
      CONVEX_DEPLOYMENT: 'dev:fixture-deployment',
      DUET_API_INTERNAL_KEY: 'internal-key',
      DUET_PROGRAMMATIC_LOGIN_SECRET: 'login-secret',
      VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-secret',
      AGENTMAIL_API_KEY: 'agentmail-key',
      DUET_E2E_AGENTMAIL_INBOX_ADDRESS: 'fixture@agentmail.to',
    })

    expect(env.mcpUrl).toBe('https://mcp-staging.duet.so/')

    expect(() =>
      readMcpOAuthJourneyEnv({
        DUET_API_URL: 'https://ctl-staging.duet.so',
        DUET_APP_URL: 'https://app-staging.duet.so',
        DUET_MCP_PUBLIC_URL: 'https://mcp.duet.so',
        CONVEX_DEPLOYMENT: 'dev:fixture-deployment',
        DUET_API_INTERNAL_KEY: 'internal-key',
        DUET_PROGRAMMATIC_LOGIN_SECRET: 'login-secret',
        VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-secret',
        AGENTMAIL_API_KEY: 'agentmail-key',
        DUET_E2E_AGENTMAIL_INBOX_ADDRESS: 'fixture@agentmail.to',
      }),
    ).toThrow('DUET_MCP_PUBLIC_URL must target a staging hostname')
  })

  test('awaits each declared leg before acknowledgement and always cleans up', async () => {
    const calls: string[] = []
    const passed: string[] = []
    const firstStarted = Promise.withResolvers<void>()
    const releaseFirst = Promise.withResolvers<void>()
    const actions = Object.fromEntries(
      MCP_OAUTH_STAGING_LEGS.map(leg => [
        leg,
        async () => {
          calls.push(leg)
          if (leg === MCP_OAUTH_STAGING_LEGS[0]) {
            firstStarted.resolve()
            await releaseFirst.promise
          }
        },
      ]),
    ) as Record<(typeof MCP_OAUTH_STAGING_LEGS)[number], () => Promise<void>>

    const completed = runMcpOAuthSequence({
      actions,
      pass: leg => passed.push(leg),
      cleanup: async () => {
        calls.push('cleanup')
      },
    })

    try {
      await firstStarted.promise
      expect(calls).toEqual([MCP_OAUTH_STAGING_LEGS[0]])
      expect(passed).toEqual([])
    } finally {
      releaseFirst.resolve()
      await completed
    }
    expect(calls).toEqual([...MCP_OAUTH_STAGING_LEGS, 'cleanup'])
    expect(passed).toEqual([...MCP_OAUTH_STAGING_LEGS])
  })

  test('stops reporting legs after failure but still performs journey cleanup', async () => {
    const calls: string[] = []
    const passed: string[] = []
    const actions = Object.fromEntries(
      MCP_OAUTH_STAGING_LEGS.map(leg => [
        leg,
        async () => {
          calls.push(leg)
          if (leg === 'refresh-family') throw new Error('fixture failure')
        },
      ]),
    ) as Record<(typeof MCP_OAUTH_STAGING_LEGS)[number], () => Promise<void>>

    await expect(
      runMcpOAuthSequence({
        actions,
        pass: leg => passed.push(leg),
        cleanup: async () => {
          calls.push('cleanup')
        },
      }),
    ).rejects.toThrow('fixture failure')
    expect(calls).toEqual([
      'discovery',
      'dcr-authorization',
      'mcp-tools',
      'file-resources',
      'refresh-family',
      'cleanup',
    ])
    expect(passed).toEqual(['discovery', 'dcr-authorization', 'mcp-tools', 'file-resources'])
  })
})

function captureError(action: () => void): string {
  try {
    action()
  } catch (error) {
    return String(error)
  }
  throw new Error('expected action to fail')
}
