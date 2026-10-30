import { describe, expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import appEn from '../../messages/en/app.json'
import { DriveBootstrapShell } from './bootstrap-shell'

describe('Drive bootstrap shell', () => {
  test('renders the supplied settings path with workspace destination tabs', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
        <DriveBootstrapShell initialPath="/w/acme/settings/shares" />
      </NextIntlClientProvider>,
    )

    expect(
      [...html.matchAll(/role="tab"[^>]*aria-label="([^"]+)"/g)].map(match => match[1]),
    ).toEqual(['Agents', 'Drive', 'Integrations'])
  })

  test('renders supplied Work Home in Work chrome without the Build tab bar', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={appEn} timeZone="UTC">
        <DriveBootstrapShell initialPath="/w/acme/home" />
      </NextIntlClientProvider>,
    )

    expect(html).toContain('data-loading-view="work-home"')
    expect(html).toContain('data-team-space-loading="work"')
    expect(html).not.toContain('grid-cols-6')
    expect(html).not.toContain('role="tab"')
  })
})
