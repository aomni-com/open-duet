import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import type { OutgoingShareListItem } from '@repo/contract'

import messages from '../../messages/en/app.json'
import { SharesManagement } from './shares-management'

test('renders the outgoing source path and configuration status', () => {
  const share = {
    id: 'share_1',
    anchorId: 'anchor_1',
    originWorkspaceId: 'workspace_1',
    fromWorkspaceId: 'workspace_1',
    toEmail: 'teammate@example.com',
    toWorkspaceId: 'workspace_2',
    mode: 'write',
    ignorePatterns: [],
    state: 'active',
    createdByUserId: 'user_1',
    createdAt: 1,
    expiresAt: 2,
    acceptedAt: 2,
    tokenPrefix: 'duet_share_abcd',
    sourcePath: 'Projects/launch',
    syncStatus: {
      origin: {
        state: 'ready',
        matchesCurrentGeneration: true,
        updatedAt: 3,
      },
      recipient: {
        state: 'ready',
        matchesCurrentGeneration: true,
        updatedAt: 4,
      },
    },
  } satisfies OutgoingShareListItem

  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <SharesManagement
        incoming={[]}
        outgoing={[share]}
        busy={false}
        onUnlink={async () => {}}
        onRevoke={async () => {}}
        onSetPaused={async () => {}}
      />
    </NextIntlClientProvider>,
  )

  expect(html).toContain('Projects/launch')
  expect(html).toContain('Up to date')
  expect(html).toContain('does not compare every file byte')
  expect(html).toContain('role="switch"')
  expect(html).toContain('Freeze Projects/launch')
})

test('does not offer pause switches for supplied pending and revoked shares', () => {
  const pending = {
    id: 'share_pending',
    anchorId: 'anchor_1',
    originWorkspaceId: 'workspace_1',
    fromWorkspaceId: 'workspace_1',
    toEmail: 'teammate@example.com',
    mode: 'read' as const,
    ignorePatterns: [],
    state: 'pending' as const,
    createdByUserId: 'user_1',
    createdAt: 1,
    expiresAt: 2,
    tokenPrefix: 'duet_share_abcd',
    sourcePath: 'Projects/pending',
  } satisfies OutgoingShareListItem
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" timeZone="UTC" messages={messages}>
      <SharesManagement
        incoming={[]}
        outgoing={[pending, { ...pending, id: 'share_revoked', state: 'revoked' }]}
        busy={false}
        onUnlink={async () => {}}
        onRevoke={async () => {}}
        onSetPaused={async () => {}}
      />
    </NextIntlClientProvider>,
  )

  expect(html).not.toContain('role="switch"')
})
