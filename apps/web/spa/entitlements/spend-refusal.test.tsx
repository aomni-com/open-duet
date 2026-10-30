import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

import { SPEND_REFUSAL_CODES, type SpendRefusal } from '@repo/contract'

import en from '../../messages/en/app.json'
import es from '../../messages/es-419/app.json'
import { DuetApiError } from '../api/client'
import { SpendRefusalNotice, spendRefusalOf } from './spend-refusal'

const escaped = (copy: string) => copy.replaceAll("'", '&#x27;')

test('an out-of-credits send names the refusal and offers billing, not a generic failure', () => {
  const code = spendRefusalOf(
    new DuetApiError(402, 'insufficient_credits', 'insufficient_credits', {
      error: 'insufficient_credits',
      code: 'insufficient_credits',
      tier: 'account',
      balanceMicroUsd: 0,
      autoTopupScheduled: false,
      billingUrl: 'https://app.duet.so/settings/billing',
    }),
  )
  expect(code).toEqual({ code: 'insufficient_credits', tier: 'account' })

  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider timeZone="UTC" locale="en" messages={en}>
        <SpendRefusalNotice refusal={{ code: code!.code }} agentName="Duet" />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )

  expect(html).toContain(escaped(en.duetSpendRefusal.insufficient_credits.title))
  expect(html).toContain('href="/settings/billing"')
  expect(html).toContain('border-destructive/40')
  expect(html).toContain('text-destructive')
  expect(html).toContain('bg-primary')
  expect(html).not.toContain(escaped(en.duetApp.sessionProduct.actionError))
})

test('every spend refusal is recognized, and nothing else is', () => {
  for (const code of SPEND_REFUSAL_CODES) {
    expect(spendRefusalOf(new DuetApiError(402, code, code, { error: code, code }))).toEqual({
      code,
    })
  }
  // A 402 the payer cannot resolve by paying.
  expect(
    spendRefusalOf(
      new DuetApiError(402, 'workspace_limit_reached', 'workspace_limit_reached', {
        error: 'workspace_limit_reached',
        plan: 'max',
        limit: 10,
      }),
    ),
  ).toBeUndefined()
  // The same code at a status that is not a refusal to spend.
  expect(
    spendRefusalOf(
      new DuetApiError(403, 'payment_required', 'payment_required', { code: 'payment_required' }),
    ),
  ).toBeUndefined()
  expect(spendRefusalOf(new DuetApiError(500, 'request_failed'))).toBeUndefined()
  expect(spendRefusalOf(new Error('offline'))).toBeUndefined()
})

/* Not keyed by code: `monthly_cap` splits into two, because an account limit
   and a workspace limit are resolved by different people in different places. */
const COPY_KEYS = [
  'insufficient_credits',
  'monthly_cap_account',
  'monthly_cap_workspace',
  'subscription_required',
  'subscription_inactive',
  'payment_required',
] as const

const EVERY_REFUSAL = SPEND_REFUSAL_CODES.flatMap((code): SpendRefusal[] =>
  code === 'monthly_cap'
    ? [
        { code, tier: 'account' },
        { code, tier: 'workspace' },
      ]
    : [{ code }],
)

test('every spend refusal renders real copy in every supported locale', () => {
  for (const [locale, bundle] of [
    ['en', en],
    ['es-419', es],
  ] as const) {
    expect(Object.keys(bundle.duetSpendRefusal).sort()).toEqual([...COPY_KEYS].sort())
    for (const refusal of EVERY_REFUSAL) {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <NextIntlClientProvider timeZone="UTC" locale={locale} messages={bundle}>
            <SpendRefusalNotice refusal={refusal} agentName="Duet" />
          </NextIntlClientProvider>
        </MemoryRouter>,
      )
      // A refusal that renders the raw placeholder has lost the agent's name;
      // one that renders the key has no copy behind it at all.
      const key =
        refusal.code === 'monthly_cap'
          ? refusal.tier === 'workspace'
            ? 'monthly_cap_workspace'
            : 'monthly_cap_account'
          : refusal.code
      const copy = bundle.duetSpendRefusal[key]
      expect(html).toContain(escaped(copy.title))
      expect(html).toContain(escaped(copy.body.replaceAll('{name}', 'Duet')))
      expect(html).toContain(escaped(copy.action))
      expect(html).not.toContain('{name}')
      expect(html).not.toContain('duetSpendRefusal.')
      expect(html).toContain('href="/settings/billing"')
    }
  }
})

/* `authorizeSpend` returns `monthly_cap` only after the balance check passed
   (packages/backend/convex/domains/credits/creditsShared.ts), so this caller
   demonstrably HAS credits — the blocker is a spending limit. Copy that sends
   them to buy more takes their money and leaves them just as blocked. */
test('a reached spending limit never reads as an empty balance', () => {
  for (const tier of ['account', 'workspace'] as const) {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NextIntlClientProvider timeZone="UTC" locale="en" messages={en}>
          <SpendRefusalNotice refusal={{ code: 'monthly_cap', tier }} agentName="Duet" />
        </NextIntlClientProvider>
      </MemoryRouter>,
    )
    expect(html).not.toContain(en.duetSpendRefusal.insufficient_credits.action)
    expect(html).not.toContain('used up')
    expect(html).toContain('limit')
  }
})

test('the two spending limits are different problems and say so', () => {
  const render = (tier: 'account' | 'workspace') =>
    renderToStaticMarkup(
      <MemoryRouter>
        <NextIntlClientProvider timeZone="UTC" locale="en" messages={en}>
          <SpendRefusalNotice refusal={{ code: 'monthly_cap', tier }} agentName="Duet" />
        </NextIntlClientProvider>
      </MemoryRouter>,
    )
  expect(render('account')).not.toBe(render('workspace'))
  // Only the account cap has a control on the billing page to point at.
  expect(render('account')).toContain(escaped(en.duetSpendRefusal.monthly_cap_account.action))
  expect(render('workspace')).toContain(escaped(en.duetSpendRefusal.monthly_cap_workspace.action))
})

test('the billing recovery link targets a new tab', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider timeZone="UTC" locale="en" messages={en}>
        <SpendRefusalNotice refusal={{ code: 'insufficient_credits' }} agentName="Duet" />
      </NextIntlClientProvider>
    </MemoryRouter>,
  )
  // /settings/* is a sibling of /w/:slug (spa/root.tsx), so an in-page
  // navigation tears down the session and its useState draft with it.
  expect(html).toContain('target="_blank"')
  expect(html).toContain('rel="noreferrer"')
})
