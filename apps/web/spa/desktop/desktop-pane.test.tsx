import { describe, expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import { DESKTOP_SCREEN } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import { DesktopFrameSourceProvider, DesktopPane } from './desktop-pane'

describe('DesktopPane', () => {
  test('renders initial connecting copy without a frame', () => {
    const markup = render('starting', null, [])

    expect(markup).toContain('Connecting to the desktop')
    expect(markup).not.toContain('<iframe')
  })

  test('lets hermetic fixtures replace the live credential-bearing frame source', () => {
    const markup = render('ready', 'https://vm.example/v1/desktop/grant.token/', [])

    expect(markup).toContain('src="/playground/desktop-frame"')
    expect(markup).not.toContain('grant.token')
    expect(markup).toContain('width="1440"')
    expect(markup).toContain('height="900"')
    expect(markup).toContain('referrerPolicy="no-referrer"')
  })

  test('names each owner once and distinguishes the focused browser window', () => {
    const markup = render('ready', 'https://vm.example/desktop', [
      {
        owner: { kind: 'agent', agentId: 'a' },
        agentSlug: 'researcher',
        agentName: 'Researcher',
        phase: 'active',
        focused: true,
        liveBatchCount: 1,
        batchTabCount: 1,
        discardedBatchTabCount: 0,
        lastActiveAt: 100,
      },
      {
        owner: { kind: 'agent', agentId: 'b' },
        agentSlug: 'Writer',
        phase: 'active',
        focused: false,
        liveBatchCount: 1,
        batchTabCount: 1,
        discardedBatchTabCount: 0,
        lastActiveAt: 110,
      },
    ])

    expect(
      [...markup.matchAll(/aria-label="([^"]*browser window(?: is focused)?)"/g)].map(
        match => match[1],
      ),
    ).toEqual(['Researcher browser window is focused', 'Writer browser window'])
    expect(markup.match(/<iframe/g)).toHaveLength(1)
  })

  test('renders one status rail with either empty or supplied owners', () => {
    const idle = render('ready', 'https://vm.example/desktop', [])
    const driving = render('ready', 'https://vm.example/desktop', [
      {
        owner: { kind: 'agent', agentId: 'a' },
        agentSlug: 'Researcher',
        phase: 'active',
        focused: true,
        liveBatchCount: 1,
        batchTabCount: 1,
        discardedBatchTabCount: 0,
        lastActiveAt: 100,
      },
    ])

    expect(idle.match(/data-desktop-owner-rail="true"/g)).toHaveLength(1)
    expect(driving.match(/data-desktop-owner-rail="true"/g)).toHaveLength(1)
  })

  test('renders an unhealthy refusal instead of the connecting state in both locales', () => {
    expect(render('starting', null, [], 'en', 'unhealthy')).toContain('Workspace needs attention')
    expect(render('starting', null, [], 'es-419', 'unhealthy')).toContain(
      'El espacio de trabajo requiere atención',
    )
    expect(render('starting', null, [], 'en', 'unhealthy')).not.toContain(
      'Connecting to the desktop',
    )
  })
})

function render(
  phase: 'stopped' | 'starting' | 'ready',
  entryUrl: string | null,
  owners: Array<import('@repo/contract').DesktopOwnerActivity>,
  locale: 'en' | 'es-419' = 'en',
  refusal?: 'unhealthy',
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === 'es-419' ? appEs : appEn}
      timeZone="UTC"
    >
      <DesktopFrameSourceProvider source={() => '/playground/desktop-frame'}>
        <DesktopPane
          phase={phase}
          entryUrl={entryUrl}
          owners={owners}
          screen={DESKTOP_SCREEN}
          refusal={refusal}
        />
      </DesktopFrameSourceProvider>
    </NextIntlClientProvider>,
  )
}
