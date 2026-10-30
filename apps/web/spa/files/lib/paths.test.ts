import { describe, expect, test } from 'bun:test'

import { driveFolderUrl, filesBrowserPathFromPathname } from '../../drive/drive-routes'
import {
  anchorPathFromBrowserPath,
  browserPathFromAnchorPath,
  isBrowserFilePath,
  normalizeBrowserFilePath,
  parentBrowserFilePath,
} from './paths'

const canonicalDriveDeepLinkPathCases = [
  { label: 'percent literal', browserPath: '/100%.pdf', encodedPath: '100%25.pdf' },
  { label: 'encoded-looking literal', browserPath: '/a%2Fb', encodedPath: 'a%252Fb' },
  { label: 'space', browserPath: '/Q3 Reports', encodedPath: 'Q3%20Reports' },
  {
    label: 'Unicode',
    browserPath: '/資料/研究.md',
    encodedPath: '%E8%B3%87%E6%96%99/%E7%A0%94%E7%A9%B6.md',
  },
  { label: 'dotfile', browserPath: '/.env', encodedPath: '.env' },
  {
    label: 'nested',
    browserPath: '/reports/Q3 Drafts/final.txt',
    encodedPath: 'reports/Q3%20Drafts/final.txt',
  },
] as const

describe('browser file paths', () => {
  test('converts a relative anchor path to the absolute browser dialect', () => {
    expect(browserPathFromAnchorPath('agents/research')).toBe('/agents/research')
  })

  test('rejects absolute, separator-bearing, and traversal anchor paths', () => {
    for (const anchorPath of [
      '/agents/research',
      'agents\\research',
      'agents//research',
      'agents/research/',
      'agents/../secret',
      'agents/.duet/cache',
    ]) {
      expect(() => browserPathFromAnchorPath(anchorPath), anchorPath).toThrow()
    }
  })

  test('converts browser paths back to anchor paths without decoding literal percent bytes', () => {
    for (const { label, browserPath } of canonicalDriveDeepLinkPathCases) {
      const anchorPath = browserPath.slice(1)
      expect(anchorPathFromBrowserPath(browserPath), label).toBe(anchorPath)
      expect(browserPathFromAnchorPath(anchorPath), label).toBe(browserPath)
    }
    expect(anchorPathFromBrowserPath('/')).toBe('')
  })

  test('rejects non-canonical browser dialect inputs', () => {
    for (const browserPath of [
      '',
      'reports/draft.md',
      '//reports/draft.md',
      '/reports//draft.md',
      '/reports/draft.md/',
      '/reports\\draft.md',
      '/reports/has\0nul',
    ]) {
      expect(() => anchorPathFromBrowserPath(browserPath), browserPath).toThrow()
    }
  })

  test('clamps the parent of the browser root to the root', () => {
    expect(parentBrowserFilePath('/')).toBe('/')
  })

  test('returns the parent of nested and root-child browser paths', () => {
    expect(parentBrowserFilePath('/reports/drafts')).toBe('/reports')
    expect(parentBrowserFilePath('/reports')).toBe('/')
  })

  test('round-trips the canonical path table through a raw files pathname', () => {
    const workspaceSlug = 'acme / 東京'

    for (const { label, browserPath, encodedPath } of canonicalDriveDeepLinkPathCases) {
      const url = driveFolderUrl(workspaceSlug, browserPath)
      expect(url, label).toBe(`/w/acme%20%2F%20%E6%9D%B1%E4%BA%AC/files/${encodedPath}`)
      expect(filesBrowserPathFromPathname(url, workspaceSlug), label).toBe(browserPath)
    }
  })
})

/* The thrower is reached from agent-authored text and from VM-absolute paths
   that only look like drive paths, so the message is the only place a reader
   learns WHICH path and WHY. A bare "Invalid file path" in a console names
   neither, and the path it is hiding is the whole diagnosis. */
test('a rejected path says which path and which segment', () => {
  expect(() => normalizeBrowserFilePath('app/engine/../releases/notes.md')).toThrow(
    'Invalid file path "app/engine/../releases/notes.md": a ".." segment',
  )
  expect(() => normalizeBrowserFilePath('/home/exedev/.duet/skills/x/SKILL.md')).toThrow(
    'Invalid file path "/home/exedev/.duet/skills/x/SKILL.md": a ".duet" segment, ' +
      'which is not part of the drive',
  )
  expect(() => normalizeBrowserFilePath('reports//q2.md')).toThrow(
    'Invalid file path "reports//q2.md": an empty segment',
  )
})

test('isBrowserFilePath answers for the paths the normalizer refuses', () => {
  expect(isBrowserFilePath('reports/q2.md')).toBe(true)
  expect(isBrowserFilePath('app/engine/../releases/notes.md')).toBe(false)
  expect(isBrowserFilePath('/home/exedev/.duet/skills/x/SKILL.md')).toBe(false)
})
