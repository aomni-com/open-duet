import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import type { App } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { AppFrameBody, AppFrameSourceProvider } from './app-frame'

const baseApp: App = {
  id: 'app_1',
  workspaceId: 'workspace_1',
  anchorId: 'anchor_1',
  anchorPath: 'apps/reporting',
  anchorState: 'active',
  command: 'bun run start',
  apiScopes: [],
  port: 4173,
  slug: 'reporting',
  name: 'Launch intelligence',
  visibility: 'folder',
  canonicalUrl: 'https://reporting--acme.edge.duet.so/',
  runtimeStatus: 'reconciled',
  createdByUserId: 'user_1',
  createdAt: 1,
  updatedAt: 1,
  controls: {
    manageDomain: true,
    updateRuntime: true,
    makePublic: true,
    makePrivate: true,
    delete: true,
  },
}

function renderBody(app: App = baseApp) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <AppFrameSourceProvider
        source={(workspaceSlug, appSlug) => `/fixture/${workspaceSlug}/${appSlug}`}
      >
        <AppFrameBody app={app} workspaceSlug="acme" />
      </AppFrameSourceProvider>
    </NextIntlClientProvider>,
  )
}

test('a reconciled app renders the launch frame with its title and exact sandbox boundary', () => {
  const markup = renderBody()

  expect(markup).toContain('src="/fixture/acme/reporting"')
  expect(markup).toContain('title="Launch intelligence"')
  expect(markup).toContain(
    'sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"',
  )
})

/* The frame's first second belongs to Duet, not to the app: the grant redirect
   and the app's own boot happen behind an empty document, and an empty document
   is transparent, so what a reader looks at until the app paints is drawn under
   the frame here. */
test('a reconciled app initially renders a placeholder alongside its frame', () => {
  const markup = renderBody()

  expect(markup).toContain('data-app-frame-placeholder')
  expect(markup).toContain('<iframe')
})

/* The gap belongs to the theme. An iframe with nothing in it yet is
   transparent, so whatever the frame carries is what a reader looks at for as
   long as the app takes to arrive — and it was nailed to `bg-white`, which is
   the whole of what a dark drive saw while an app opened. The white canvas a
   background-less document needs comes back with the loaded app, so it is
   absent from this render and only from this one. */
test('a reconciled app initially uses theme background classes without a white override', () => {
  const markup = renderBody()

  expect(markup).not.toContain('bg-white')
  expect(markup).toContain('bg-background')
})

test('a reconciling app renders the starting presentation instead of a frame', () => {
  const markup = renderBody({ ...baseApp, runtimeStatus: 'reconciling' })

  expect(markup).toContain('Duet&#x27;s computer is starting this app.')
  expect(markup).not.toContain('<iframe')
})

test('a reconcile-failed app renders its failure and diagnostic instead of a frame', () => {
  const markup = renderBody({
    ...baseApp,
    runtimeStatus: 'reconcile_failed',
    reconciliationError: 'gateway_unavailable',
  })

  expect(markup).toContain('Runtime needs attention')
  expect(markup).toContain('gateway_unavailable')
  expect(markup).not.toContain('<iframe')
})

test('a disabled app renders its switched-off presentation instead of a frame', () => {
  const markup = renderBody({ ...baseApp, disabledAt: 2 })

  expect(markup).toContain('This app is switched off in your workspace.')
  expect(markup).not.toContain('<iframe')
})

/* Two ways an app is not running, and only one of them the reader can undo.
   "Switched off" invites you to turn it back on; a subscription-owned app is
   off because its files have not arrived yet, so saying that strands the reader
   looking for a control that does not exist. */
test('an app still waiting for its files says so, rather than offering a switch', () => {
  const markup = renderBody({
    ...baseApp,
    disabledAt: 2,
    listingSubscriptionId: 'sub_1',
    controls: {
      manageDomain: false,
      updateRuntime: false,
      makePublic: false,
      makePrivate: false,
      delete: false,
    },
  })

  expect(markup).toContain('still arriving from its publisher')
  expect(markup).not.toContain('Turn it back on')
  expect(markup).not.toContain('<iframe')
})

// A broken anchor is its own state, not a runtime failure, and it is explained
// rather than acted on: repairing one meant typing the folder's new Drive path,
// which is a sentence about anchors. Deleting it is what the app's menu offers.
test('a broken app explains itself, never a blank frame and never a runtime error', () => {
  const markup = renderBody({ ...baseApp, anchorState: 'broken' })

  expect(markup).toContain('Folder link needs repair')
  expect(markup).not.toContain('Runtime needs attention')
  expect(markup).not.toContain('<iframe')
})

test('public and private custom-domain apps keep the embedded launch source', () => {
  for (const visibility of ['public', 'folder'] as const) {
    const markup = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
        <AppFrameBody
          app={{
            ...baseApp,
            visibility,
            canonicalUrl: 'https://aomni.co/',
            customDomain: { hostname: 'aomni.co', status: 'active' },
          }}
          workspaceSlug="acme"
        />
      </NextIntlClientProvider>,
    )
    expect(markup).toContain('src="/api/duet/ws/acme/apps/reporting/launch"')
    expect(markup).not.toContain('aomni.co')
  }
})
