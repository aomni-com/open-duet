import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import type { WorkspaceSummary } from '@repo/contract'

import en from '../../messages/en/app.json'
import es from '../../messages/es-419/app.json'
import { LowCreditGate } from './low-credit-gate'

const workspace = {
  id: 'workspace_1',
  slug: 'northstar',
  name: 'Northstar Studio',
  status: 'active',
  servicingStatus: 'active',
  role: 'owner',
  billingUserId: 'user_owner',
  funding: { plan: null, active: true },
  creditRecovery: 'subscribe',
  defaultTier: { effective: 'balanced' },
} satisfies WorkspaceSummary

test('all recovery states render localized headings', () => {
  const headings = {
    en: [
      ['Your trial is almost done', 'Keep your workspace running'],
      ['Credits are running low', 'Top up to keep going'],
      ['Workspace credits are running low', 'The workspace owner needs to add credits'],
    ],
    'es-419': [
      ['Tu prueba está por terminar', 'Mantén tu espacio de trabajo activo'],
      ['Quedan pocos créditos', 'Recarga para seguir trabajando'],
      ['Quedan pocos créditos en el espacio de trabajo', 'El propietario debe agregar créditos'],
    ],
  } as const

  for (const [locale, messages] of [
    ['en', en],
    ['es-419', es],
  ] as const) {
    for (const [index, kind] of (['subscribe', 'topup', 'member'] as const).entries()) {
      const html = renderGate(kind, locale, messages)
      expect(html).toContain(headings[locale][index]![0])
      expect(html).toContain(headings[locale][index]![1])
      expect(html).not.toContain('duetLowCreditGate.')
    }
  }
})

test('payer recovery exposes only the approved choices and member recovery exposes no action', () => {
  const subscribe = renderGate('subscribe', 'en', en)
  expect(subscribe).toContain('role="radio" aria-checked="true"')
  expect(subscribe).toContain('Starter')
  expect(subscribe).toContain('Pro')
  expect(subscribe).toContain('Max')
  expect(subscribe).toContain('Recommended')

  const topup = renderGate('topup', 'en', en)
  expect(
    topup.match(/<strong[^>]*>\$\d+<\/strong>/g)?.map(value => value.match(/\$\d+/)![0]),
  ).toEqual(['$20', '$50', '$100'])

  const member = renderGate('member', 'en', en)
  expect(member).not.toContain('<button')
  expect(member).not.toContain('$2 or less')
  expect(member).not.toContain('aria-label="Close')
})

test('pending disables checkout and a recoverable error retains its retry action', () => {
  const pending = renderToStaticMarkup(
    <NextIntlClientProvider timeZone="UTC" locale="en" messages={en}>
      <LowCreditGate
        state={{ kind: 'topup', workspace: { ...workspace, creditRecovery: 'topup' } }}
        pending
        onTopup={() => undefined}
      />
    </NextIntlClientProvider>,
  )
  expect(pending).toContain('Opening secure checkout…')
  expect(pending.match(/<button[^>]*data-recovery-action[^>]*>/)?.[0]).toContain('disabled=""')
  expect(pending).toContain('data-low-credit-gate="topup"')

  const error = renderToStaticMarkup(
    <NextIntlClientProvider timeZone="UTC" locale="en" messages={en}>
      <LowCreditGate
        state={{ kind: 'subscribe', workspace }}
        error="Checkout could not open. Try again."
        onSubscribe={() => undefined}
      />
    </NextIntlClientProvider>,
  )
  expect(error).toContain('role="alert"')
  expect(error).toContain('Checkout could not open. Try again.')
  expect(error).toContain('Subscribe and continue')
  expect(error.match(/<button[^>]*data-recovery-action[^>]*>/)?.[0]).not.toContain('disabled=""')
})

function renderGate(
  kind: 'subscribe' | 'topup' | 'member',
  locale: 'en' | 'es-419',
  messages: typeof en | typeof es,
): string {
  const gate =
    kind === 'subscribe' ? (
      <LowCreditGate state={{ kind, workspace }} onSubscribe={() => undefined} />
    ) : kind === 'topup' ? (
      <LowCreditGate
        state={{ kind, workspace: { ...workspace, creditRecovery: 'topup' } }}
        onTopup={() => undefined}
      />
    ) : (
      <LowCreditGate state={{ kind, workspace }} />
    )
  return renderToStaticMarkup(
    <NextIntlClientProvider timeZone="UTC" locale={locale} messages={messages}>
      {gate}
    </NextIntlClientProvider>,
  )
}

/* A member waiting on somebody else's top-up can wait indefinitely, and the gate
   makes the shell behind it inert. Another workspace is their only way to keep
   working, so the gate itself has to lead there. */
test('member recovery renders a switch trigger only when another workspace is supplied', () => {
  const other = { ...workspace, id: 'workspace_2', slug: 'labs', name: 'Duet Labs' }
  const gateFor = (workspaces: WorkspaceSummary[]) =>
    renderToStaticMarkup(
      <NextIntlClientProvider timeZone="UTC" locale="en" messages={en}>
        <LowCreditGate
          state={{ kind: 'member', workspace }}
          workspaceSwitch={{ workspaces, onSelect: () => undefined }}
        />
      </NextIntlClientProvider>,
    )
  expect(gateFor([workspace, other])).toContain('Switch workspace')
  expect(gateFor([workspace])).not.toContain('Switch workspace')
})
