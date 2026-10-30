import { describe, expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import type { App } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { IncludedApps, shareRequestFromForm } from './share-dialog'

describe('share dialog request boundary', () => {
  test('maps product permission copy and newline patterns to the API contract', () => {
    expect(
      shareRequestFromForm({
        path: '/launch',
        email: ' teammate@example.com ',
        permission: 'edit',
        ignorePatterns: ' .env\n\nprivate/**\n.env ',
      }),
    ).toEqual({
      path: 'launch',
      toEmail: 'teammate@example.com',
      mode: 'write',
      ignorePatterns: ['.env', 'private/**'],
    })
  })

  test('keeps literal percent paths exact at the share API boundary', () => {
    for (const [browserPath, anchorPath] of [
      ['/100%.pdf', '100%.pdf'],
      ['/a%2Fb', 'a%2Fb'],
    ] as const) {
      expect(
        shareRequestFromForm({
          path: browserPath,
          email: 'teammate@example.com',
          permission: 'view',
          ignorePatterns: '',
        }),
        browserPath,
      ).toEqual({ path: anchorPath, toEmail: 'teammate@example.com', mode: 'read' })
    }
  })
})

test('an incomplete subtree preview keeps loaded apps and says they are not the whole share', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <IncludedApps
        apps={[shareApp('app-101')]}
        failed={false}
        incomplete
        canLoadMore
        loadingMore={false}
        moreFailed={false}
        onLoadMore={() => {}}
      />
    </NextIntlClientProvider>,
  )
  expect(html).toContain('app-101')
  expect(html).toContain('Loaded apps are only part of this folder.')
  expect(html).toContain('Load more apps')
})

test('a supplied cached subtree stays disclosed without a continuation', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
      <IncludedApps
        apps={[shareApp('cached-app')]}
        failed={false}
        incomplete
        canLoadMore={false}
        loadingMore={false}
        moreFailed={false}
        onLoadMore={() => {}}
      />
    </NextIntlClientProvider>,
  )
  expect(html).toContain('>cached-app<')
  expect(html).toContain('>launch/cached-app<')
  expect(html).toContain('Loaded apps are only part of this folder.')
  expect(html).not.toContain('Load more apps')
})

function shareApp(id: string): App {
  return {
    id,
    workspaceId: 'workspace_acme',
    anchorId: `anchor_${id}`,
    anchorPath: `launch/${id}`,
    anchorState: 'active',
    command: 'bun run start',
    apiScopes: [],
    port: 4173,
    slug: id,
    visibility: 'folder',
    canonicalUrl: `https://${id}.duet.so`,
    runtimeStatus: 'reconciled',
    createdByUserId: 'user_1',
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
}
