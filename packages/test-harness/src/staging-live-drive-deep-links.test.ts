import { describe, expect, test } from 'bun:test'

import {
  encodeDrivePathForUrl,
  emittedLinkMatchesAnchor,
} from './staging-live-drive-deep-links'

const CANONICAL_PATH_CASES = [
  { anchorPath: '100%.pdf', encodedPath: '100%25.pdf' },
  { anchorPath: 'a%2Fb', encodedPath: 'a%252Fb' },
  { anchorPath: 'Q3 Reports', encodedPath: 'Q3%20Reports' },
  { anchorPath: '資料/研究.md', encodedPath: '%E8%B3%87%E6%96%99/%E7%A0%94%E7%A9%B6.md' },
  { anchorPath: '.env', encodedPath: '.env' },
  {
    anchorPath: 'reports/Q3 Drafts/final.txt',
    encodedPath: 'reports/Q3%20Drafts/final.txt',
  },
] as const

describe('emittedLinkMatchesAnchor', () => {
  test('mirrors every canonical web path case without importing the web grammar', () => {
    for (const { anchorPath, encodedPath } of CANONICAL_PATH_CASES) {
      expect(
        emittedLinkMatchesAnchor(
          {
            anchorPath,
            emittedHref: `/w/acme%20%2F%20%E6%9D%B1%E4%BA%AC/files/${encodedPath}`,
          },
          'acme / 東京',
        ),
        anchorPath,
      ).toBe(true)
    }
  })

  test('rejects links that are not the exact root-relative folder destination', () => {
    const evidence = {
      anchorPath: 'agents/research',
      emittedHref: '/w/acme/files/agents/research',
    }
    expect(emittedLinkMatchesAnchor(evidence, 'acme')).toBe(true)

    for (const emittedHref of [
      '/w/acme/agents/research',
      '/w/acme/files?path=agents%2Fresearch',
      'https://app-staging.duet.so/w/acme/files/agents/research',
      '//app-staging.duet.so/w/acme/files/agents/research',
      '/w/acme/files/agents%2Fresearch',
      '/w/acme/files/agents/research/',
    ]) {
      expect(emittedLinkMatchesAnchor({ ...evidence, emittedHref }, 'acme'), emittedHref).toBe(
        false,
      )
    }
  })

  test('rejects malformed anchor dialect input rather than normalizing identity', () => {
    for (const anchorPath of [
      '',
      '/agents/research',
      'agents//research',
      'agents/research/',
      'agents/../research',
      'agents/.duet/cache',
      'agents\\research',
    ]) {
      expect(
        emittedLinkMatchesAnchor(
          {
            anchorPath,
            emittedHref: '/w/acme/files/agents/research',
          },
          'acme',
        ),
        anchorPath,
      ).toBe(false)
    }
  })
})

describe('encodeDrivePathForUrl', () => {
  test('encodes each logical segment once so percent-bearing names stay distinct', () => {
    expect(encodeDrivePathForUrl('agents/research/100%.txt')).toBe('agents/research/100%25.txt')
    expect(encodeDrivePathForUrl('agents/research/a%2Fb.txt')).toBe('agents/research/a%252Fb.txt')
  })
})
