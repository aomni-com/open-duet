import { describe, expect, test } from 'bun:test'

import Stripe from 'stripe'

import {
  createOnboardingPaymentIntent,
  createSubscriptionCheckout,
  STRIPE_API_VERSION,
} from '../convex/services/stripe'
import {
  AuthorizationProofFake,
  buildAuthorizationIntentParams,
} from '../test-fixtures/stripe-authorization-proof'

describe('Stripe onboarding authorization proof seam', () => {
  test('uses a $10 manual card authorization and releases it without capture', async () => {
    const fake = new AuthorizationProofFake()
    const idempotencyKey = 'onboarding:user_onboarding:attempt-1'
    const params = buildAuthorizationIntentParams({
      customerId: 'cus_onboarding',
      workspaceId: 'workspace_onboarding',
      userId: 'user_onboarding',
      idempotencyKey,
    })

    const created = await fake.paymentIntents.create(params, {
      idempotencyKey,
    })
    const confirmed = await fake.paymentIntents.confirm(created.id, {
      payment_method: 'pm_card_visa',
    })

    expect(confirmed).toMatchObject({
      amount: 1_000,
      amount_capturable: 1_000,
      currency: 'usd',
      capture_method: 'manual',
      setup_future_usage: 'off_session',
      customer: 'cus_onboarding',
      status: 'requires_capture',
      payment_method: 'pm_card_visa',
    })
    expect(confirmed.metadata).toMatchObject({
      source: 'duet',
      type: 'onboarding_payment_method_authorization',
      workspaceId: 'workspace_onboarding',
      userId: 'user_onboarding',
    })
    expect(fake.customer('cus_onboarding').paymentMethods).toContain('pm_card_visa')

    await fake.customers.update('cus_onboarding', {
      invoice_settings: { default_payment_method: 'pm_card_visa' },
    })
    const canceled = await fake.paymentIntents.cancel(created.id)

    expect(canceled).toMatchObject({ status: 'canceled', amount_capturable: 0 })
    expect(fake.customer('cus_onboarding').defaultPaymentMethod).toBe('pm_card_visa')
    expect(fake.capturedPaymentIntentIds()).toEqual([])
    expect(fake.paidRevenueMicroUsd()).toBe(0)
  })

  test('retries lost responses idempotently and keeps declined/auth-required cards retryable', async () => {
    const fake = new AuthorizationProofFake()
    const idempotencyKey = 'onboarding:user_recovery:attempt-1'
    const params = buildAuthorizationIntentParams({
      customerId: 'cus_recovery',
      workspaceId: 'workspace_recovery',
      userId: 'user_recovery',
      idempotencyKey,
    })

    const firstCreate = await fake.paymentIntents
      .create(params, {
        idempotencyKey,
        simulateLostResponseAfterWrite: true,
      })
      .catch(error => {
        expect(error).toMatchObject({ code: 'response_lost' })
        return undefined
      })
    expect(firstCreate).toBeUndefined()
    const recoveredCreate = await fake.paymentIntents.create(params, {
      idempotencyKey,
    })
    expect(recoveredCreate.id).toBe('pi_proof_1')

    const confirmed = await fake.paymentIntents.confirm(recoveredCreate.id, {
      payment_method: 'pm_card_visa',
    })
    await fake.paymentIntents
      .cancel(recoveredCreate.id, { simulateLostResponseAfterWrite: true })
      .catch(error => expect(error).toMatchObject({ code: 'response_lost' }))
    const recoveredCancel = await fake.paymentIntents.retrieve(confirmed.id)
    expect(recoveredCancel.status).toBe('canceled')
    expect((await fake.paymentIntents.cancel(recoveredCreate.id)).status).toBe('canceled')

    const declined = await fake.paymentIntents.create(
      buildAuthorizationIntentParams({
        customerId: 'cus_declined',
        workspaceId: 'workspace_declined',
        userId: 'user_declined',
        idempotencyKey: 'onboarding:user_declined:attempt-1',
      }),
      { idempotencyKey: 'onboarding:user_declined:attempt-1' },
    )
    await expect(
      fake.paymentIntents.confirm(declined.id, { payment_method: 'pm_card_chargeDeclined' }),
    ).rejects.toMatchObject({ code: 'card_declined' })
    expect((await fake.paymentIntents.retrieve(declined.id)).status).toBe('requires_payment_method')

    const actionRequired = await fake.paymentIntents.create(
      buildAuthorizationIntentParams({
        customerId: 'cus_action',
        workspaceId: 'workspace_action',
        userId: 'user_action',
        idempotencyKey: 'onboarding:user_action:attempt-1',
      }),
      { idempotencyKey: 'onboarding:user_action:attempt-1' },
    )
    await expect(
      fake.paymentIntents.confirm(actionRequired.id, {
        payment_method: 'pm_card_authenticationRequired',
      }),
    ).rejects.toMatchObject({ code: 'authentication_required' })
    expect((await fake.paymentIntents.retrieve(actionRequired.id)).status).toBe('requires_action')
  })

  test('the existing subscription Checkout receives the same customer default card', async () => {
    const fake = new AuthorizationProofFake()
    await fake.customers.update('cus_subscription', {
      name: 'Subscription Proof',
      email: 'subscription-proof@example.test',
      address: {
        line1: '1 Proof Street',
        city: 'San Francisco',
        state: 'CA',
        postal_code: '94105',
        country: 'US',
      },
      invoice_settings: { default_payment_method: 'pm_card_visa' },
    })

    const session = await createSubscriptionCheckout(fake, {
      customerId: 'cus_subscription',
      userId: 'user_subscription',
      priceId: 'price_starter',
      successUrl: 'https://app.duet.test/billing/success',
      cancelUrl: 'https://app.duet.test/billing/cancel',
      idempotencyKey: 'subscription-checkout:user_subscription:starter',
    })

    expect(session).toMatchObject({
      mode: 'subscription',
      customer: 'cus_subscription',
      payment_method: 'pm_card_visa',
      cardEntryRequired: false,
      billingDetailsComplete: true,
    })
    expect(fake.lastCheckoutRequest()).toMatchObject({
      mode: 'subscription',
      customer: 'cus_subscription',
      payment_method_collection: 'if_required',
      line_items: [{ price: 'price_starter', quantity: 1 }],
    })
  })

  test('pins the repository Stripe SDK revision and request shape', () => {
    expect(STRIPE_API_VERSION).toBe('2026-02-25.clover')
    const params = buildAuthorizationIntentParams({
      customerId: 'cus_shape',
      workspaceId: 'workspace_shape',
      userId: 'user_shape',
      idempotencyKey: 'onboarding:user_shape:attempt-1',
    }) satisfies Stripe.PaymentIntentCreateParams

    expect(params).toEqual({
      amount: 1_000,
      currency: 'usd',
      customer: 'cus_shape',
      capture_method: 'manual',
      setup_future_usage: 'off_session',
      payment_method_types: ['card'],
      metadata: {
        source: 'duet',
        type: 'onboarding_payment_method_authorization',
        workspaceId: 'workspace_shape',
        userId: 'user_shape',
        attemptId: 'onboarding:user_shape:attempt-1',
      },
    })
  })

  test('the production service sends the proof metadata and idempotency seam', async () => {
    const fake = new AuthorizationProofFake()
    const intent = await createOnboardingPaymentIntent(fake, {
      customerId: 'cus_service',
      workspaceId: 'workspace_service',
      userId: 'user_service',
      idempotencyKey: 'onboarding:user_service:attempt-1',
    })

    expect(intent.metadata).toMatchObject({
      source: 'duet',
      type: 'onboarding_payment_method_authorization',
      workspaceId: 'workspace_service',
      userId: 'user_service',
    })
    expect(intent.amount).toBe(1000)
    expect(intent.capture_method).toBe('manual')
    expect(intent.setup_future_usage).toBe('off_session')
  })
})
