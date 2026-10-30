import { describe, expect, test } from 'bun:test'

import { parseWorkspaceAddress } from './index'

describe('workspace address grammar', () => {
  test('parses explicit workspace paths', () => {
    expect(parseWorkspaceAddress('demo:/docs/readme.md')).toEqual({
      ok: true,
      address: { workspaceSlug: 'demo', path: '/docs/readme.md' },
    })
  })

  test('resolves slash-prefixed paths through the configured default workspace', () => {
    expect(parseWorkspaceAddress('/notes/today.md', { defaultWorkspace: 'demo' })).toEqual({
      ok: true,
      address: { workspaceSlug: 'demo', path: '/notes/today.md' },
    })
  })

  test('pins root handling and path safety through the drive path owner', () => {
    expect(parseWorkspaceAddress('demo:/', { allowRoot: true })).toEqual({
      ok: true,
      address: { workspaceSlug: 'demo', path: '/' },
    })
    expect(parseWorkspaceAddress('demo:/', { allowRoot: false })).toEqual({
      ok: false,
      reason: 'invalid_path',
    })
    expect(parseWorkspaceAddress('demo:/../secret')).toEqual({ ok: false, reason: 'invalid_path' })
    expect(parseWorkspaceAddress('demo:/.duet/config.json')).toEqual({
      ok: false,
      reason: 'invalid_path',
    })
  })

  test('rejects missing defaults, relative paths, and invalid workspace slugs', () => {
    expect(parseWorkspaceAddress('/docs/readme.md')).toEqual({
      ok: false,
      reason: 'missing_workspace',
    })
    expect(parseWorkspaceAddress('docs/readme.md', { defaultWorkspace: 'demo' })).toEqual({
      ok: false,
      reason: 'relative_path',
    })
    expect(parseWorkspaceAddress('Bad:/docs/readme.md')).toEqual({
      ok: false,
      reason: 'invalid_workspace',
    })
  })
})
