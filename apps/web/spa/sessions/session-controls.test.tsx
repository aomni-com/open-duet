import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import type { SessionArchive, SessionPermissions } from '@repo/contract'

import en from '../../messages/en/app.json'
import es from '../../messages/es-419/app.json'
import { SessionMenu, sessionLifecycleActions, shouldPutAwayAfterArchive } from './session-controls'

const allPermissions: SessionPermissions = {
  send: true,
  answer: true,
  interrupt: true,
  rename: true,
  manageAudience: true,
  personalArchive: true,
  globalArchive: true,
  delete: true,
}

const active: SessionArchive = {
  globalArchivedAt: null,
  personalArchivedAt: null,
  reason: null,
}

test('lifecycle labels follow stored causes rather than the effective reason', () => {
  expect(sessionLifecycleActions(active, allPermissions)).toEqual([
    { kind: 'personal', archived: true, label: 'archivePersonal' },
    { kind: 'global', archived: true, label: 'archiveGlobal' },
    { kind: 'delete', label: 'delete' },
  ])

  expect(
    sessionLifecycleActions(
      { globalArchivedAt: 20, personalArchivedAt: 10, reason: 'global' },
      allPermissions,
    ),
  ).toEqual([
    { kind: 'personal', archived: false, label: 'restorePersonal' },
    { kind: 'global', archived: false, label: 'restoreGlobal' },
    { kind: 'delete', label: 'delete' },
  ])
})

test('the lifecycle menu renders actions solely from public permissions', () => {
  const viewer = { ...allPermissions, globalArchive: false, delete: false }
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC" onError={() => {}}>
      <SessionMenu
        archive={active}
        permissions={viewer}
        busy={false}
        onArchive={async () => {}}
        onDelete={async () => {}}
      />
    </NextIntlClientProvider>,
  )

  expect(html).toContain('Session actions')
  expect(sessionLifecycleActions(active, viewer)).toEqual([
    { kind: 'personal', archived: true, label: 'archivePersonal' },
  ])
})

/* Every word this menu can put on screen, in both catalogues.
   
   The list is exhaustive on purpose, and it is the transient states that make
   it worth writing down: `deleting` is on the confirm button only while the
   request is in flight, so it appears in no static render and in no screenshot,
   and it was missing from both catalogues for as long as it existed — the
   button spent every delete showing a raw key path. This test existed then and
   passed, because the key was not on its list. A guard over a hand-written list
   is only as good as the list, so anything added to this menu belongs here. */
test('both catalogues own every word the lifecycle menu can render', () => {
  for (const key of [
    // the menu itself
    'actions',
    'archivePersonal',
    'restorePersonal',
    'archiveGlobal',
    'restoreGlobal',
    'actionError',
    // the confirmation, including the two states that only exist mid-flight
    'delete',
    'deleting',
    'retryDelete',
    'deleteTitle',
    'deleteConfirm',
    'deleteError',
    'cancel',
    // and what is said once it is done, on the surface the reader lands on
    'deleted',
  ] as const) {
    expect(en.duetApp.sessionProduct[key]).toBeTruthy()
    expect(es.duetApp.sessionProduct[key]).toBeTruthy()
  }
})

test('put-away follows the server effective transition, not the requested toggle', () => {
  expect(shouldPutAwayAfterArchive(null, 'personal')).toBe(true)
  expect(shouldPutAwayAfterArchive(null, 'global')).toBe(true)
  expect(shouldPutAwayAfterArchive('global', 'personal')).toBe(false)
  expect(shouldPutAwayAfterArchive('personal', 'global')).toBe(false)
  expect(shouldPutAwayAfterArchive('personal', null)).toBe(false)
  expect(shouldPutAwayAfterArchive('global', null)).toBe(false)
})
