import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import type { BillingWorkspace } from '@repo/contract'

import messages from '../../messages/en/app.json'
import { DuetApiError } from '../api/client'
import {
  advanceStorageWarningEpisodes,
  storageFullToastForSignal,
  storageWarningToast,
  evaluateStorageWarning,
  formatStorageUsage,
  StorageMeters,
  type StorageNumberFormatter,
  type StorageTranslator,
} from './storage-surfaces'

const workspace = {
  id: 'workspace_1',
  slug: 'studio',
  name: 'Studio',
  storage: {
    usableGb: 20,
    plan: 'starter',
    nextPlan: 'pro',
    nextUsableGb: 50,
  },
} satisfies BillingWorkspace

const t: StorageTranslator = (key, values = {}) =>
  Object.entries(values).reduce(
    (message, [name, value]) => message.replaceAll(`{${name}}`, String(value)),
    messages.duetStorage[key],
  )

const formatNumber: StorageNumberFormatter = value =>
  new Intl.NumberFormat('en', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value)

test('storage usage keeps an absent sample distinct from sampled zero', () => {
  expect(formatStorageUsage(workspace.storage, t, formatNumber)).toBe('Measuring…')
  expect(
    formatStorageUsage({ ...workspace.storage, usedBytes: 0, sampledAt: 1 }, t, formatNumber),
  ).toBe('0.0 GB of 20 GB')
})

test('the plan card renders one labeled storage meter per payer workspace', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider timeZone="UTC" locale="en" messages={messages}>
      <StorageMeters
        workspaces={[
          { ...workspace, storage: { ...workspace.storage, usedBytes: 12_400_000_000 } },
          {
            ...workspace,
            id: 'workspace_2',
            slug: 'archive',
            name: 'Archive',
            storage: { ...workspace.storage, usableGb: 50, usedBytes: 29_000_000_000 },
          },
        ]}
      />
    </NextIntlClientProvider>,
  )

  expect(html.match(/data-storage-meter=/g)).toHaveLength(2)
  expect(html).toContain('Storage')
  const meters = html.split('<div data-storage-meter=').slice(1)
  expect(meters[0]).toContain('"studio"')
  expect(meters[0]).toContain('Studio')
  expect(meters[0]).toContain('12.4 GB of 20 GB')
  expect(meters[0]).toContain('aria-valuemax="20"')
  expect(meters[0]).toContain('aria-valuenow="12.4"')
  expect(meters[1]).toContain('"archive"')
  expect(meters[1]).toContain('Archive')
  expect(meters[1]).toContain('29.0 GB of 50 GB')
  expect(meters[1]).toContain('aria-valuemax="50"')
  expect(meters[1]).toContain('aria-valuenow="29"')
})

test('storage warning stays silent at 89.99% and fires at 90%', () => {
  expect(
    evaluateStorageWarning(undefined, {
      ...workspace.storage,
      usedBytes: 17_998_000_000,
    }),
  ).toEqual({ latchedUsableGb: undefined, shouldShow: false })
  expect(
    evaluateStorageWarning(undefined, {
      ...workspace.storage,
      usedBytes: 18_000_000_000,
    }),
  ).toEqual({ latchedUsableGb: 20, shouldShow: true })
})

test('warning episodes stay latched until cleanup or usable storage growth', () => {
  let episodes = new Map<string, number>()
  let result = advanceStorageWarningEpisodes(episodes, 'workspace_1', {
    ...workspace.storage,
    usedBytes: 18_000_000_000,
  })
  expect(result.shouldShow).toBe(true)
  episodes = result.episodes

  result = advanceStorageWarningEpisodes(episodes, 'workspace_1', {
    ...workspace.storage,
    usedBytes: 19_000_000_000,
  })
  expect(result.shouldShow).toBe(false)

  result = advanceStorageWarningEpisodes(result.episodes, 'workspace_1', {
    ...workspace.storage,
    usedBytes: 10_000_000_000,
  })
  expect(result.episodes.has('workspace_1')).toBe(false)
  result = advanceStorageWarningEpisodes(result.episodes, 'workspace_1', {
    ...workspace.storage,
    usedBytes: 18_000_000_000,
  })
  expect(result.shouldShow).toBe(true)

  result = advanceStorageWarningEpisodes(result.episodes, 'workspace_1', {
    ...workspace.storage,
    usableGb: 50,
    usedBytes: 46_000_000_000,
  })
  expect(result.shouldShow).toBe(true)
  expect(result.episodes.get('workspace_1')).toBe(50)
})

test('507 file errors and storage_full session events converge on one destructive toast', () => {
  const fileToast = storageFullToastForSignal(
    { kind: 'file', error: new DuetApiError(507, 'storage_full') },
    workspace,
    t,
  )
  const sessionToast = storageFullToastForSignal(
    {
      kind: 'session',
      event: {
        type: 'system',
        level: 'error',
        message: 'The workspace drive is full',
        metadata: { code: 'storage_full' },
      },
    },
    workspace,
    t,
  )

  expect(fileToast).toEqual(sessionToast)
  expect(fileToast).toMatchObject({
    tone: 'error',
    message: 'Storage full',
    action: { label: 'Upgrade → 50 GB', href: '/settings/billing' },
  })
})

test('an upgrade toast invokes the supplied billing callback', () => {
  const opened: string[] = []
  const toast = storageWarningToast(workspace, t, formatNumber, () => {
    opened.push('billing')
  })

  expect(toast.action).toBeDefined()
  expect(toast.action && 'onClick' in toast.action).toBe(true)
  if (toast.action && 'onClick' in toast.action) toast.action.onClick()
  expect(opened).toEqual(['billing'])
})

test('Max storage surfaces give cleanup guidance without an upgrade action', () => {
  const maxWorkspace = {
    ...workspace,
    storage: {
      usableGb: 100,
      usedBytes: 98_600_000_000,
      sampledAt: 1,
      plan: 'max',
    },
  } satisfies BillingWorkspace

  const warning = storageWarningToast(maxWorkspace, t, formatNumber)
  const full = storageFullToastForSignal(
    { kind: 'file', error: new DuetApiError(507, 'storage_full') },
    maxWorkspace,
    t,
  )
  expect(warning.action).toBeUndefined()
  expect(warning.description).toContain('Delete files you no longer need')
  expect(full?.action).toBeUndefined()
  expect(full?.description).toContain('Delete files you no longer need')
})
