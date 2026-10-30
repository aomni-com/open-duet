import { describe, expect, test } from 'bun:test'

import { appsUnderPath, browserPathToDrivePath, matchesAppsPathScope } from './path-scope'

describe('app path scopes', () => {
  test('matches exact, nested, root, and sibling-prefix paths for every scope', () => {
    const cases = [
      ['foo', 'foo', 'subtree', true],
      ['foo/bar', 'foo', 'subtree', true],
      ['foobar', 'foo', 'subtree', false],
      ['foo', 'foo', 'children', false],
      ['foo/bar', 'foo', 'children', true],
      ['foo/bar/baz', 'foo', 'children', false],
      ['foo', 'foo', 'self', true],
      ['foo/bar', 'foo', 'self', false],
      ['foo', '', 'subtree', true],
      ['foo/bar', '', 'subtree', true],
      ['foo', '', 'children', true],
      ['foo/bar', '', 'children', false],
      ['foo', '', 'self', false],
    ] as const

    for (const [anchorPath, path, scope, expected] of cases) {
      expect(matchesAppsPathScope(anchorPath, path, scope)).toBe(expected)
    }
  })

  test('filters apps with subtree as the default scope', () => {
    const apps = [
      { slug: 'exact', anchorPath: 'foo' },
      { slug: 'nested', anchorPath: 'foo/bar' },
      { slug: 'sibling-prefix', anchorPath: 'foobar' },
    ] as const

    expect(appsUnderPath(apps, 'foo').map(app => app.slug)).toEqual(['exact', 'nested'])
    expect(appsUnderPath(apps, 'foo', 'children').map(app => app.slug)).toEqual(['nested'])
    expect(appsUnderPath(apps, 'foo', 'self').map(app => app.slug)).toEqual(['exact'])
  })

  test('adapts browser paths to normalized drive paths and rejects unsafe input', () => {
    expect(browserPathToDrivePath('/')).toBe('')
    expect(browserPathToDrivePath('/foo//bar')).toBe('foo/bar')
    expect(() => browserPathToDrivePath('/../secret')).toThrow('Invalid browser path')
    expect(() => browserPathToDrivePath('//etc/passwd')).toThrow('Invalid browser path')
    expect(() => browserPathToDrivePath('foo/bar')).toThrow('Browser path must start with /')
  })
})
