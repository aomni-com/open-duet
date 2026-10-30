import { describe, expect, test } from 'bun:test'

import { requireConvexPublicUrlForBuild, resolveConvexAuthPublicUrl } from './convex-public-url'

describe('resolveConvexAuthPublicUrl', () => {
  test('derives the browser URL from the one deployment identifier', () => {
    expect(
      resolveConvexAuthPublicUrl({
        CONVEX_DEPLOYMENT: 'dev:chatty-llama-452',
        NEXT_PUBLIC_CONVEX_URL: undefined,
      }),
    ).toBe('https://chatty-llama-452.convex.cloud')
  })

  test('keeps an explicit local fixture URL', () => {
    expect(
      resolveConvexAuthPublicUrl({
        CONVEX_DEPLOYMENT: 'dev:chatty-llama-452',
        NEXT_PUBLIC_CONVEX_URL: ' https://fixture.convex.cloud ',
      }),
    ).toBe('https://fixture.convex.cloud')
  })

  test('leaves the value absent when neither source is configured', () => {
    expect(
      resolveConvexAuthPublicUrl({
        CONVEX_DEPLOYMENT: undefined,
        NEXT_PUBLIC_CONVEX_URL: undefined,
      }),
    ).toBeUndefined()
  })
})

describe('requireConvexPublicUrlForBuild', () => {
  test('a production build without a resolvable URL fails loudly', () => {
    expect(() =>
      requireConvexPublicUrlForBuild({
        CONVEX_DEPLOYMENT: undefined,
        NEXT_PUBLIC_CONVEX_URL: undefined,
      }),
    ).toThrow(/NEXT_PUBLIC_CONVEX_URL/)
  })

  test('either source satisfies the build', () => {
    expect(
      requireConvexPublicUrlForBuild({
        CONVEX_DEPLOYMENT: undefined,
        NEXT_PUBLIC_CONVEX_URL: 'https://fixture.convex.cloud',
      }),
    ).toBe('https://fixture.convex.cloud')
    expect(
      requireConvexPublicUrlForBuild({
        CONVEX_DEPLOYMENT: 'dev:chatty-llama-452',
        NEXT_PUBLIC_CONVEX_URL: undefined,
      }),
    ).toBe('https://chatty-llama-452.convex.cloud')
  })
})
