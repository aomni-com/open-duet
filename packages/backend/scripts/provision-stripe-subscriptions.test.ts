import { expect, test } from 'bun:test'

import type Stripe from 'stripe'

import {
  parseWebhookUrl,
  provisionPortal,
  provisionWebhook,
  requireProvisioningKey,
  STRIPE_SUBSCRIPTION_WEBHOOK_EVENTS,
} from './provision-stripe-subscriptions'

function narrowPortal(id: string): Stripe.BillingPortal.Configuration {
  return {
    id,
    active: true,
    name: 'Duet billing portal',
    metadata: { owner: 'duet-monthly-subscriptions-portal-narrow-v2' },
    business_profile: {
      terms_of_service_url: 'https://duet.so/terms',
      privacy_policy_url: 'https://duet.so/privacy-policy',
    },
    features: {
      customer_update: { enabled: false },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: false },
      subscription_update: { enabled: false, products: [] },
    },
  } as unknown as Stripe.BillingPortal.Configuration
}

test('Stripe provisioner refuses live and malformed keys unless live mode is explicit', () => {
  expect(requireProvisioningKey('sk_test_fixture', false)).toBe('sk_test_fixture')
  expect(() => requireProvisioningKey('sk_live_fixture', false)).toThrow(
    'Refusing sk_live_ key without --confirm-live',
  )
  expect(requireProvisioningKey('sk_live_fixture', true)).toBe('sk_live_fixture')
  expect(() => requireProvisioningKey('rk_test_fixture', false)).toThrow(
    'STRIPE_SECRET_KEY must be an sk_test_ or sk_live_ secret key',
  )
})

test('webhook mode requires one absolute URL', () => {
  expect(parseWebhookUrl([])).toBeUndefined()
  expect(parseWebhookUrl(['--with-webhook', 'https://api-staging.duet.so/stripe/webhook'])).toBe(
    'https://api-staging.duet.so/stripe/webhook',
  )
  expect(() => parseWebhookUrl(['--with-webhook'])).toThrow('--with-webhook requires a URL')
  expect(() => parseWebhookUrl(['--with-webhook', '/stripe/webhook'])).toThrow(
    '--with-webhook must be an absolute HTTPS URL',
  )
  expect(() =>
    parseWebhookUrl([
      '--with-webhook',
      'https://one.example/hook',
      '--with-webhook',
      'https://two.example/hook',
    ]),
  ).toThrow('--with-webhook may be passed only once')
})

test('webhook provisioning rotates only the endpoint at the exact URL', async () => {
  const deleted: string[] = []
  let created: Stripe.WebhookEndpointCreateParams | undefined
  const stripe = {
    webhookEndpoints: {
      list: () => ({
        autoPagingToArray: async () => [
          { id: 'we_other', url: 'https://other-app.example/stripe' },
          { id: 'we_exact', url: 'https://api-staging.duet.so/stripe/webhook' },
          { id: 'we_similar', url: 'https://api-staging.duet.so/stripe/webhook/' },
        ],
      }),
      del: async (id: string) => {
        deleted.push(id)
        return { id, deleted: true }
      },
      create: async (params: Stripe.WebhookEndpointCreateParams) => {
        created = params
        return { id: 'we_new', secret: 'whsec_rotated', ...params }
      },
    },
  } as unknown as Stripe

  const endpoint = await provisionWebhook(stripe, 'https://api-staging.duet.so/stripe/webhook')

  expect(deleted).toEqual(['we_exact'])
  expect(created).toEqual({
    url: 'https://api-staging.duet.so/stripe/webhook',
    enabled_events: [...STRIPE_SUBSCRIPTION_WEBHOOK_EVENTS],
  })
  expect(endpoint.secret).toBe('whsec_rotated')
})

test('webhook rotation keeps the exact old endpoint when replacement creation fails', async () => {
  const deleted: string[] = []
  const stripe = {
    webhookEndpoints: {
      list: () => ({
        autoPagingToArray: async () => [{ id: 'we_exact', url: 'https://api.example/webhook' }],
      }),
      create: async () => {
        throw new Error('Stripe unavailable')
      },
      del: async (id: string) => deleted.push(id),
    },
  } as unknown as Stripe

  await expect(provisionWebhook(stripe, 'https://api.example/webhook')).rejects.toThrow(
    'Stripe unavailable',
  )
  expect(deleted).toEqual([])
})

test('Stripe provisioner creates a narrow portal without plan or cancellation controls', async () => {
  let createParams: Stripe.BillingPortal.ConfigurationCreateParams | undefined
  const stripe = {
    billingPortal: {
      configurations: {
        list: () => ({ autoPagingToArray: async () => [] }),
        create: (params: Stripe.BillingPortal.ConfigurationCreateParams) => {
          createParams = params
          return Promise.resolve({ id: 'bpc_narrow' })
        },
      },
    },
  } as unknown as Stripe

  await provisionPortal(stripe, undefined)

  expect(createParams).toEqual({
    name: 'Duet billing portal',
    metadata: { owner: 'duet-monthly-subscriptions-portal-narrow-v2' },
    business_profile: {
      terms_of_service_url: 'https://duet.so/terms',
      privacy_policy_url: 'https://duet.so/privacy-policy',
    },
    features: {
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
    },
  })
})

test('Stripe provisioner reuses its narrow portal while leaving the legacy broad portal alone', async () => {
  const narrow = narrowPortal('bpc_narrow')
  const legacyBroad = {
    id: 'bpc_legacy_broad',
    metadata: { owner: 'duet-monthly-subscriptions-v1' },
  } as unknown as Stripe.BillingPortal.Configuration
  let createCalls = 0
  const stripe = {
    billingPortal: {
      configurations: {
        list: () => ({ autoPagingToArray: async () => [legacyBroad, narrow] }),
        update: (id: string, params: Stripe.BillingPortal.ConfigurationUpdateParams) =>
          Promise.resolve({
            ...narrow,
            ...params,
            features: { ...narrow.features, ...params.features },
            id,
          }),
        create: () => {
          createCalls += 1
          return Promise.reject(new Error('must not create'))
        },
      },
    },
  } as unknown as Stripe

  expect((await provisionPortal(stripe, undefined)).id).toBe('bpc_narrow')
  expect(createCalls).toBe(0)
})

test('Stripe provisioner replaces a configured legacy broad id by minting the narrowed owner', async () => {
  const legacyBroad = {
    id: 'bpc_legacy_broad',
    metadata: { owner: 'duet-monthly-subscriptions-v1' },
  } as unknown as Stripe.BillingPortal.Configuration
  let created = false
  const stripe = {
    billingPortal: {
      configurations: {
        retrieve: async () => legacyBroad,
        list: () => ({ autoPagingToArray: async () => [] }),
        create: async () => {
          created = true
          return narrowPortal('bpc_narrow_new')
        },
      },
    },
  } as unknown as Stripe

  expect((await provisionPortal(stripe, legacyBroad.id)).id).toBe('bpc_narrow_new')
  expect(created).toBe(true)
})

test('Stripe provisioner rejects a configured portal owned by another app', async () => {
  const broad = narrowPortal('bpc_broad')
  broad.features.subscription_update.enabled = true
  broad.metadata = { owner: 'some-other-app' }
  const stripe = {
    billingPortal: {
      configurations: { retrieve: async () => broad },
    },
  } as unknown as Stripe

  await expect(provisionPortal(stripe, broad.id)).rejects.toThrow(
    'Portal configuration bpc_broad has drifted from the Duet contract',
  )
})

test('Stripe provisioner reconciles its own drifted configured portal in place', async () => {
  const drifted = narrowPortal('bpc_ours')
  drifted.business_profile.terms_of_service_url = 'https://old-host.example/terms'
  drifted.features.customer_update.enabled = true
  drifted.features.subscription_update.enabled = true
  drifted.features.subscription_cancel.enabled = true
  let updated: Stripe.BillingPortal.ConfigurationUpdateParams | undefined
  const stripe = {
    billingPortal: {
      configurations: {
        retrieve: async () => drifted,
        update: (id: string, params: Stripe.BillingPortal.ConfigurationUpdateParams) => {
          updated = params
          return Promise.resolve({
            ...drifted,
            ...params,
            features: { ...drifted.features, ...params.features },
            id,
          })
        },
      },
    },
  } as unknown as Stripe

  const result = await provisionPortal(stripe, drifted.id)
  expect(result.id).toBe('bpc_ours')
  expect(result.features.customer_update.enabled).toBe(false)
  expect(result.features.subscription_update.enabled).toBe(false)
  expect(result.features.subscription_cancel.enabled).toBe(false)
  expect(updated?.business_profile?.terms_of_service_url).toBe('https://duet.so/terms')
})
