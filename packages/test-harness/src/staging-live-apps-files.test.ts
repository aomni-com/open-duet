import { describe, expect, test } from 'bun:test'

import type { App, FileEntry } from '@repo/contract'

import {
  assertFreshWorkspaceSeed,
  assertVideoPreviewState,
  waitForFreshWorkspaceSeed,
  waitForHelloAppState,
} from './staging-live-apps-files'

const helloApp: App = {
  id: 'app_hello',
  workspaceId: 'workspace_fresh',
  anchorId: 'anchor_hello',
  anchorPath: 'welcome/hello-app',
  anchorState: 'active',
  command: 'bun run server.ts',
  apiScopes: [],
  port: 3000,
  slug: 'hello',
  visibility: 'folder',
  canonicalUrl: 'https://hello--fresh.duet.so/',
  runtimeStatus: 'reconciled',
  createdByUserId: 'user_owner',
  createdAt: 1,
  updatedAt: 2,
  controls: {
    manageDomain: true,
    updateRuntime: true,
    makePublic: true,
    makePrivate: true,
    delete: true,
  },
}
const rootApp: App = {
  ...helloApp,
  id: 'app_root',
  anchorId: 'anchor_root',
  anchorPath: 'dashboard',
  slug: 'dashboard',
  canonicalUrl: 'https://dashboard--fresh.duet.so/',
}

const file = (name: string, type: FileEntry['type'] = 'file'): FileEntry => ({
  name,
  path: `welcome/${name}`,
  type,
  size: type === 'directory' ? 0 : 128,
  mtime: '2026-07-17T00:00:00.000Z',
})

describe('fresh workspace apps-in-files acceptance oracle', () => {
  test('requires every seeded preview asset and the active hello app identity', () => {
    expect(
      assertFreshWorkspaceSeed({
        rootEntries: [
          {
            ...file('welcome', 'directory'),
            path: 'welcome',
          },
        ],
        welcomeEntries: [
          file('README.md'),
          file('sample.pdf'),
          file('deck.pptx'),
          file('clip.mp4'),
          file('hello-app', 'directory'),
        ],
        welcomeApps: [helloApp],
        rootApps: [rootApp],
        directApp: helloApp,
      }),
    ).toEqual(helloApp)

    expect(() =>
      assertFreshWorkspaceSeed({
        rootEntries: [{ ...file('welcome', 'directory'), path: 'welcome' }],
        welcomeEntries: [
          file('README.md'),
          file('sample.pdf'),
          file('clip.mp4'),
          file('hello-app', 'directory'),
        ],
        welcomeApps: [helloApp],
        rootApps: [],
        directApp: helloApp,
      }),
    ).toThrow('deck.pptx')
  })

  test('rejects apps outside the requested welcome subtree', () => {
    expect(() =>
      assertFreshWorkspaceSeed({
        rootEntries: [{ ...file('welcome', 'directory'), path: 'welcome' }],
        welcomeEntries: [
          file('README.md'),
          file('sample.pdf'),
          file('deck.pptx'),
          file('clip.mp4'),
          file('hello-app', 'directory'),
        ],
        welcomeApps: [
          helloApp,
          {
            ...helloApp,
            id: 'app_private',
            anchorId: 'anchor_private',
            anchorPath: 'private/admin',
            slug: 'admin',
          },
        ],
        rootApps: [],
        directApp: helloApp,
      }),
    ).toThrow('welcome subtree query leaked apps')
  })

  test('fails immediately with the gateway reason when seed reconciliation is terminal', async () => {
    const failed = {
      ...helloApp,
      runtimeStatus: 'reconcile_failed' as const,
      reconciliationError: 'App "hello" did not become ready',
    }

    await expect(
      waitForFreshWorkspaceSeed({
        load: async () => ({
          rootEntries: [{ ...file('welcome', 'directory'), path: 'welcome' }],
          welcomeEntries: [
            file('README.md'),
            file('sample.pdf'),
            file('deck.pptx'),
            file('clip.mp4'),
            file('hello-app', 'directory'),
          ],
          welcomeApps: [failed],
          rootApps: [],
          directApp: failed,
        }),
        sleep: async () => {
          throw new Error('terminal reconciliation should not retry')
        },
      }),
    ).rejects.toThrow('App "hello" did not become ready')
  })

  test('waits through anchor convergence without accepting an app identity replacement', async () => {
    const observations = [
      { ...helloApp, anchorState: 'active' as const, anchorPath: 'welcome/hello-app' },
      { ...helloApp, anchorState: 'broken' as const, anchorPath: 'welcome/hello2' },
      {
        ...helloApp,
        anchorPath: 'welcome/hello2',
        runtimeStatus: 'reconcile_failed' as const,
      },
      { ...helloApp, anchorState: 'active' as const, anchorPath: 'welcome/hello2' },
    ]
    let index = 0

    await expect(
      waitForHelloAppState({
        expectedId: helloApp.id,
        expectedPath: 'welcome/hello2',
        expectedState: 'active',
        load: async () => observations[Math.min(index++, observations.length - 1)]!,
        timeoutMs: 100,
        pollMs: 0,
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({
      id: helloApp.id,
      anchorPath: 'welcome/hello2',
      anchorState: 'active',
    })
    expect(index).toBe(4)

    await expect(
      waitForHelloAppState({
        expectedId: helloApp.id,
        expectedPath: 'welcome/hello2',
        expectedState: 'active',
        load: async () => ({ ...helloApp, id: 'app_replacement', anchorPath: 'welcome/hello2' }),
        timeoutMs: 100,
        pollMs: 0,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('identity changed')
  })

  test('retries the composed seed assertion until files and app registration agree', async () => {
    const complete = {
      rootEntries: [{ ...file('welcome', 'directory'), path: 'welcome' }],
      welcomeEntries: [
        file('README.md'),
        file('sample.pdf'),
        file('deck.pptx'),
        file('clip.mp4'),
        file('hello-app', 'directory'),
      ],
      welcomeApps: [helloApp],
      rootApps: [],
      directApp: helloApp,
    }
    const observations = [
      {
        ...complete,
        welcomeEntries: complete.welcomeEntries.filter(entry => entry.name !== 'clip.mp4'),
      },
      complete,
    ]
    let index = 0

    await expect(
      waitForFreshWorkspaceSeed({
        load: async () => observations[Math.min(index++, observations.length - 1)]!,
        timeoutMs: 100,
        pollMs: 0,
        sleep: async () => undefined,
      }),
    ).resolves.toEqual(helloApp)
  })
})

describe('video preview acceptance oracle', () => {
  test('accepts a valid media source before headless Chromium decodes metadata', () => {
    expect(() =>
      assertVideoPreviewState({
        currentSrc: 'https://app-staging.duet.so/api/duet/ws/fresh/files/welcome/clip.mp4',
        errorCode: null,
        networkState: 1,
        expectedPath: '/api/duet/ws/fresh/files/welcome/clip.mp4',
      }),
    ).not.toThrow()
  })

  test('rejects a missing or failed media source', () => {
    expect(() =>
      assertVideoPreviewState({
        currentSrc: 'https://app-staging.duet.so/api/duet/ws/fresh/files/welcome/clip.mp4',
        errorCode: 4,
        networkState: 3,
        expectedPath: '/api/duet/ws/fresh/files/welcome/clip.mp4',
      }),
    ).toThrow()
  })
})
