import { describe, expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  SERVICING_ARCHIVE_AFTER_MS,
  type UserBillingOverview,
  type WorkspaceSummary,
} from '@repo/contract'

import messages from '../../messages/en/app.json'
import {
  decommissionNotice,
  deriveWorkspaceWall,
  ROOT_ENTITLEMENT_POLL_MS,
  SubscribeWall,
  summarizeWorkspaceMomentum,
} from './subscribe-wall'

const workspace = {
  id: 'workspace_1',
  slug: 'studio',
  name: 'Studio',
  status: 'active',
  servicingStatus: 'paused',
  servicingStatusChangedAt: Date.now(),
  role: 'editor',
  billingUserId: 'payer_1',
  funding: { plan: null, active: false },
  creditRecovery: null,
  defaultTier: { effective: 'balanced' },
} satisfies WorkspaceSummary

const billing = {
  autoTopupEnabled: false,
  autoTopupThresholdMicroUsd: 5_000_000,
  monthlySpendMicroUsd: 5_000_000,
  balanceMicroUsd: 2_000_000,
  paidCreditBalanceMicroUsd: 2_000_000,
  monthlyCreditBalanceMicroUsd: 0,
  consecutiveTopupFailures: 0,
  subscription: {
    plan: 'pro',
    status: 'canceled',
    isActive: false,
    currentPeriodStart: 1,
    currentPeriodEnd: 2,
    creditsExpireAt: 2,
    cancelAtPeriodEnd: false,
  },
  trial: { status: 'ended' },
  hasPaymentMethod: true,
  workspaces: [
    {
      id: 'workspace_1',
      slug: 'studio',
      name: 'Studio',
      storage: {
        usableGb: 50,
        plan: 'pro',
        nextPlan: 'max',
        nextUsableGb: 100,
      },
    },
  ],
} satisfies UserBillingOverview

/* The warning, with the real number in it. The fixture is paused as of now, so
   the wall must say the full window — and it must say it by COMPUTING, which is
   what the unit tests below pin across the rest of the window. The number is
   derived, never typed: the wall's whole job is to promise the same deadline
   the sweep enforces, and a literal here would let the two drift apart silently
   the next time the policy moves. */
const WINDOW_DAYS = SERVICING_ARCHIVE_AFTER_MS / (24 * 60 * 60 * 1000)
const FULL_WINDOW_SENTENCE = `Your workspace and all its files shut down in ${WINDOW_DAYS} days.`

describe('workspace entitlement wall', () => {
  test('the wall never softens the shutdown with a reassurance about saved data', () => {
    expect(JSON.stringify(messages.duetEntitlementWall)).not.toMatch(/everything.*saved/i)
  })

  test('paused payers can open the billing portal beside logout, including while billing loads', () => {
    const html = renderWall(
      <SubscribeWall
        state={{ kind: 'payer-loading', workspace }}
        momentum={{ generations: 0, publishedApps: 0, organizedFiles: 0 }}
        onLogout={() => {}}
        billingPortal={{ onOpen: () => {}, pending: false, failed: false }}
      />,
    )
    expect(html).toContain('Manage billing')
    expect(html).toContain('Log out')
  })

  test('members cannot open another payer’s portal', () => {
    const html = renderWall(
      <SubscribeWall
        state={{ kind: 'member', workspace }}
        momentum={{ generations: 0, publishedApps: 0, organizedFiles: 0 }}
        onLogout={() => {}}
        billingPortal={{ onOpen: () => {}, pending: false, failed: true }}
      />,
    )
    expect(html).not.toContain('Manage billing')
    expect(html).not.toContain('Billing portal could not open')
    expect(html).toContain('Log out')
  })

  /* The wall makes everything behind it inert, the shell's own switcher
     included, so a person whose only open door is another workspace needs one
     on the wall itself — and a door that leads back here is not one. */
  test('offers a way to another workspace, and only when there is one to go to', () => {
    const other = { ...workspace, id: 'workspace_2', slug: 'agency', name: 'Agency' }
    const wallFor = (workspaces: WorkspaceSummary[]) =>
      renderWall(
        <SubscribeWall
          state={{ kind: 'member', workspace }}
          momentum={{ generations: 0, publishedApps: 0, organizedFiles: 0 }}
          onLogout={() => {}}
          workspaceSwitch={{ workspaces, onSelect: () => {} }}
        />,
      )
    expect(wallFor([workspace, other])).toContain('Switch workspace')
    expect(wallFor([workspace])).not.toContain('Switch workspace')
  })

  test('SUBS-IMPL-11 walls an entitled viewer of a paused payer workspace without a purchase action', () => {
    const wall = deriveWorkspaceWall(workspace, 'member_1', undefined)
    expect(wall).toEqual({ kind: 'member', workspace })

    const html = renderWall(
      <SubscribeWall
        onLogout={() => {}}
        state={wall!}
        momentum={{ generations: 18, publishedApps: 2, organizedFiles: 47 }}
      />,
    )
    expect(html).toContain('data-entitlement-wall="member"')
    expect(html).toContain('Contact the workspace owner')
    expect(html).toContain(FULL_WINDOW_SENTENCE)
    expect(html).not.toContain('data-subscribe-action')
  })

  test('SUBS-IMPL-11 does not wall a lapsed member of an active payer workspace', () => {
    expect(
      deriveWorkspaceWall({ ...workspace, servicingStatus: 'active' }, 'member_1', billing),
    ).toBeNull()
  })

  test('projects the three payer variants and keeps Pro preselected', () => {
    expect(
      deriveWorkspaceWall({ ...workspace, role: 'owner' }, 'payer_1', {
        ...billing,
        subscription: null,
        trial: { status: 'exhausted' },
      })?.kind,
    ).toBe('trial-exhausted')
    expect(
      deriveWorkspaceWall({ ...workspace, role: 'owner' }, 'payer_1', {
        ...billing,
        subscription: null,
        trial: { status: 'ended' },
      })?.kind,
    ).toBe('trial-timed-out')

    const lapsed = deriveWorkspaceWall({ ...workspace, role: 'owner' }, 'payer_1', billing)
    expect(lapsed?.kind).toBe('lapsed')
    const html = renderWall(
      <SubscribeWall
        onLogout={() => {}}
        state={lapsed!}
        momentum={{ generations: 18, publishedApps: 2, organizedFiles: 47 }}
      />,
    )
    expect(html).toContain('data-selected-plan="pro"')
    expect(html).toContain('Recommended')
    expect(html).toContain('20% more credits')
    expect(html).toContain('25% more credits')
    expect(html).not.toContain('$60')
    expect(html).not.toContain('$250')
    expect(html).toContain('data-entitlement-wall="lapsed"')
    expect(html).toContain(FULL_WINDOW_SENTENCE)
  })

  test('covers a paused payer immediately while its billing projection loads', () => {
    const loading = deriveWorkspaceWall({ ...workspace, role: 'owner' }, 'payer_1', undefined)
    expect(loading?.kind).toBe('payer-loading')
    const html = renderWall(
      <SubscribeWall
        onLogout={() => {}}
        state={loading!}
        momentum={{ generations: 0, publishedApps: 0, organizedFiles: 0 }}
      />,
    )
    expect(html).toContain('data-entitlement-wall="payer-loading"')
    expect(html).not.toContain('data-subscribe-action')
    expect(html).not.toContain('aria-label="Close')
  })

  test('SUBS-IMPL-FIX2 gives an active subscriber a billing recovery wall without subscribe', () => {
    const wall = deriveWorkspaceWall({ ...workspace, role: 'owner' }, 'payer_1', {
      ...billing,
      subscription: { ...billing.subscription, status: 'active', isActive: true },
    })
    expect(wall?.kind).toBe('billing-issue')

    const html = renderWall(
      <SubscribeWall
        onLogout={() => {}}
        state={wall!}
        momentum={{ generations: 18, publishedApps: 2, organizedFiles: 47 }}
      />,
    )
    expect(html).toContain('data-entitlement-wall="billing-issue"')
    expect(html).not.toContain('href="/settings/billing"')
    expect(html).toContain('data-billing-recovery-action')
    expect(html).not.toContain('data-subscribe-action')
    expect(html).not.toContain('why it can&#x27;t stay free')
  })

  test('polls the root workspace identity inside the accepted propagation bound', () => {
    expect(ROOT_ENTITLEMENT_POLL_MS).toBeGreaterThan(0)
    expect(ROOT_ENTITLEMENT_POLL_MS).toBeLessThanOrEqual(30_000)
  })

  test('keeps the active-route momentum honest for a later paused wall', () => {
    expect(
      summarizeWorkspaceMomentum({
        ledgerEntries: [{ type: 'usage' }, { type: 'grant' }, { type: 'usage' }],
        apps: [{ visibility: 'public' }, { visibility: 'private' }, { visibility: 'public' }],
        rootEntries: [{ type: 'file' }, { type: 'directory' }, { type: 'file' }],
      }),
    ).toEqual({ generations: 2, publishedApps: 2, organizedFiles: 2 })
    expect(
      summarizeWorkspaceMomentum({
        ledgerEntries: [],
        apps: [],
        rootEntries: Array.from({ length: 50 }, () => ({ type: 'file' })),
        rootEntriesIncomplete: true,
      }),
    ).toEqual({
      generations: 0,
      publishedApps: 0,
      organizedFiles: 50,
      organizedFilesAtLeast: true,
    })
    expect(
      summarizeWorkspaceMomentum({
        ledgerEntries: [],
        apps: [{ visibility: 'public' }],
        appsIncomplete: true,
        rootEntries: [],
      }),
    ).toEqual({
      generations: 0,
      publishedApps: 1,
      publishedAppsAtLeast: true,
      organizedFiles: 0,
    })
    expect(
      summarizeWorkspaceMomentum({
        ledgerEntries: Array.from({ length: 50 }, () => ({ type: 'usage' })),
        ledgerEntriesIncomplete: true,
        apps: [],
        rootEntries: [],
      }),
    ).toEqual({
      generations: 50,
      generationsAtLeast: true,
      publishedApps: 0,
      organizedFiles: 0,
    })
  })
})

function renderWall(node: ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      timeZone="UTC"
      now={new Date(Date.UTC(2026, 6, 18))}
    >
      {node}
    </NextIntlClientProvider>,
  )
}

/* The line that decides whether a warning is a warning. It read "will shut down
   in 7 days" from the first day of the pause to the last — and kept reading it
   after the workspace had been destroyed, because decommission changes `status`
   and leaves `servicingStatus` at `paused`. Somebody subscribing to save their
   files was answering a promise about something already over. */
describe('the decommission notice', () => {
  const DAY = 24 * 60 * 60 * 1000
  const PAUSED_AT = Date.UTC(2026, 7, 5, 8, 0)
  const say = (key: string, values?: Record<string, number>) =>
    values === undefined ? key : `${key}:${JSON.stringify(values)}`

  test('counts the days actually left, from the instant the sweep measures', () => {
    expect(
      decommissionNotice(say, { status: 'active', servicingStatusChangedAt: PAUSED_AT }, PAUSED_AT),
    ).toBe(`decommission:{"days":${WINDOW_DAYS}}`)
    expect(
      decommissionNotice(
        say,
        { status: 'active', servicingStatusChangedAt: PAUSED_AT },
        PAUSED_AT + SERVICING_ARCHIVE_AFTER_MS - DAY,
      ),
    ).toBe('decommission:{"days":1}')
  })

  test('the last day says today rather than "in 0 days"', () => {
    expect(
      decommissionNotice(
        say,
        { status: 'active', servicingStatusChangedAt: PAUSED_AT },
        PAUSED_AT + SERVICING_ARCHIVE_AFTER_MS,
      ),
    ).toBe('decommissionToday')
  })

  test('a workspace already torn down says so, in the past tense', () => {
    // The state David hit: subscribing here brings the workspace back empty,
    // and the wall has to say that BEFORE the money, not after.
    expect(
      decommissionNotice(
        say,
        { status: 'archived', servicingStatusChangedAt: PAUSED_AT },
        PAUSED_AT + SERVICING_ARCHIVE_AFTER_MS + DAY,
      ),
    ).toBe('decommissioned')
    expect(
      decommissionNotice(
        say,
        { status: 'retired', servicingStatusChangedAt: PAUSED_AT },
        PAUSED_AT,
      ),
    ).toBe('decommissioned')
  })

  test('a row with no timestamp says soon rather than inventing a date', () => {
    expect(decommissionNotice(say, { status: 'active' }, PAUSED_AT)).toBe('decommissionUnknown')
  })
})
