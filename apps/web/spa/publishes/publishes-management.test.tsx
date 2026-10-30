import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import type { PublishRow } from '@repo/contract'

import messages from '../../messages/en/app.json'
import { PublishesManagement } from './publishes-management'

const publish = {
  id: 'publish_1',
  workspaceId: 'workspace_1',
  anchorId: 'anchor_1',
  anchorPath: 'Reports/Weekly',
  slug: 'weekly',
  kind: 'folder',
  createdByUserId: 'user_1',
  createdAt: 1,
  updatedAt: 2,
} satisfies PublishRow

test('renders supplied pending freeze with its checked disabled switch', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider timeZone="UTC" locale="en" messages={messages}>
      <PublishesManagement
        publishes={[publish]}
        transition={{ slug: 'weekly', paused: true }}
        onSetPaused={async () => {}}
      />
    </NextIntlClientProvider>,
  )

  expect(html).toContain('Reports/Weekly')
  expect(html).toContain('Freezing')
  expect(html).toContain('role="switch"')
  expect(html).toContain('aria-checked="true"')
  expect(html.match(/<button[^>]*role="switch"[^>]*>/)?.[0]).toContain('disabled=""')
  expect(html).not.toContain('dialog')
})

test('labels a committed paused publish as frozen and offers Resume', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider timeZone="UTC" locale="en" messages={messages}>
      <PublishesManagement
        publishes={[{ ...publish, pausedAt: 3, pauseGeneration: 'generation_1' }]}
        onSetPaused={async () => {}}
      />
    </NextIntlClientProvider>,
  )

  expect(html).toContain('Frozen')
  expect(html).toContain('Resume weekly')
})
