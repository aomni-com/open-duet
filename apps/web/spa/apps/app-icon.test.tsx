import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import type { App } from '@repo/contract'

import { DuetApiClient } from '../api/client'
import { AppIcon, appDisplayName } from './app-icon'

const app = {
  anchorPath: 'apps/reporting',
  icon: 'icon.png',
  updatedAt: 42,
} satisfies Pick<App, 'anchorPath' | 'icon' | 'updatedAt'>

test('uses the custom app name and otherwise falls back to the anchor folder basename', () => {
  expect(appDisplayName({ name: 'Quarterly reporting', anchorPath: 'apps/reporting' })).toBe(
    'Quarterly reporting',
  )
  expect(appDisplayName({ anchorPath: 'apps/reporting' })).toBe('reporting')
})

test('versions icon download URLs with the app update timestamp', () => {
  const api = new DuetApiClient()

  expect(api.workspaceFileDownloadUrl('acme', 'apps/reporting/icon.png', { version: 42 })).toBe(
    '/api/duet/ws/acme/files/apps/reporting/icon.png?v=42',
  )
})

test('renders a plain rounded image from the versioned workspace file URL', () => {
  const html = renderToStaticMarkup(
    <AppIcon app={app} status="reconciled" workspaceSlug="acme" className="size-10" />,
  )

  expect(html).toContain('src="/api/duet/ws/acme/files/apps/reporting/icon.png?v=42"')
  expect(html).toContain('class="size-10 rounded')
  expect(html).not.toContain('ring-')
})
