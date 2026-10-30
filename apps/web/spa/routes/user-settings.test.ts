import { expect, test } from 'bun:test'

import { createTranslator } from 'next-intl'

import { MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD, TransactionTypeSchema } from '@repo/contract'

import en from '../../messages/en/app.json'
import es from '../../messages/es-419/app.json'
import { billingHistoryLabel, validAutoTopupThreshold } from './user-settings'

const LOCALES = [
  { locale: 'en', messages: en, billing: en.duetSettings.user.billing },
  { locale: 'es-419', messages: es, billing: es.duetSettings.user.billing },
]

test('automatic top-up threshold accepts five dollars and rejects anything lower', () => {
  expect(validAutoTopupThreshold('5')).toBe(true)
  expect(validAutoTopupThreshold(String(MIN_AUTO_TOPUP_THRESHOLD_MICRO_USD / 1_000_000))).toBe(true)
  expect(validAutoTopupThreshold('4.999999')).toBe(false)
  expect(validAutoTopupThreshold('not-money')).toBe(false)
})

/* `createTranslator` infers its key type from the literal messages object, while
   `useTranslations` in the app has no such inference to draw on and accepts a
   plain string. The widening below is an artefact of the test knowing the
   messages, not a looser contract than production. */
function translatorFor({ locale, messages }: (typeof LOCALES)[number]): (key: string) => string {
  const t = createTranslator({ locale, messages, namespace: 'duetSettings' })
  return key => t(key as Parameters<typeof t>[0])
}

test('VM-COMPUTE-08 a VM compute fee is labelled apart from model spend in both locales', () => {
  for (const entry of LOCALES) {
    const t = translatorFor(entry)

    expect(billingHistoryLabel({ type: 'usage', usageKind: 'vm_compute' }, t)).toBe(
      entry.billing.transactionVmCompute,
    )
    expect(billingHistoryLabel({ type: 'usage' }, t)).toBe(entry.billing.transactionUsage)
    expect(billingHistoryLabel({ type: 'usage', usageKind: 'vm_compute' }, t)).not.toBe(
      billingHistoryLabel({ type: 'usage' }, t),
    )
  }
})

test('VM-COMPUTE-08 usageKind only renames usage rows, never the other transaction types', () => {
  const t = translatorFor(LOCALES[0]!)
  const billing = en.duetSettings.user.billing

  expect(billingHistoryLabel({ type: 'grant' }, t)).toBe(billing.transactionGrant)
  expect(billingHistoryLabel({ type: 'topup' }, t)).toBe(billing.transactionTopup)
  expect(billingHistoryLabel({ type: 'adjustment' }, t)).toBe(billing.transactionAdjustment)
  expect(billingHistoryLabel({ type: 'reservation' }, t)).toBe(billing.transactionReservation)
  expect(billingHistoryLabel({ type: 'subscription_grant' }, t)).toBe(
    billing.transactionSubscriptionGrant,
  )
  expect(billingHistoryLabel({ type: 'subscription_expiry' }, t)).toBe(
    billing.transactionSubscriptionExpiry,
  )

  /* A malformed row that carries a kind on a non-usage type must not steal the
     VM label -- the fee is a usage charge and nothing else. */
  for (const type of TransactionTypeSchema.options) {
    if (type === 'usage') continue
    expect(billingHistoryLabel({ type, usageKind: 'vm_compute' }, t)).toBe(
      billingHistoryLabel({ type }, t),
    )
  }
})

test('VM-COMPUTE-08 every transaction type resolves to distinct copy, not a message key', () => {
  for (const entry of LOCALES) {
    const t = translatorFor(entry)
    const labels = TransactionTypeSchema.options.map(type => billingHistoryLabel({ type }, t))
    const withVmCompute = [
      ...labels,
      billingHistoryLabel({ type: 'usage', usageKind: 'vm_compute' }, t),
    ]

    for (const label of withVmCompute) {
      // next-intl echoes the key path when a message is missing.
      expect(label).not.toContain('user.billing.')
      expect(label.length).toBeGreaterThan(0)
    }
    expect(new Set(withVmCompute).size).toBe(withVmCompute.length)
  }
})
