import Stripe from 'stripe'

type ProofCustomer = {
  defaultPaymentMethod?: string
  name?: string
  email?: string
  address?: Stripe.AddressParam
  paymentMethods: string[]
}

type ProofIntent = {
  id: string
  amount: number
  amount_capturable: number
  capture_method: 'manual'
  currency: 'usd'
  customer: string
  metadata: Record<string, string>
  payment_method?: string
  setup_future_usage: 'off_session'
  status: 'requires_payment_method' | 'requires_action' | 'requires_capture' | 'canceled'
}

type ProofRequestOptions = Stripe.RequestOptions & {
  simulateLostResponseAfterWrite?: boolean
}

export function buildAuthorizationIntentParams(args: {
  customerId: string
  workspaceId: string
  userId: string
  idempotencyKey: string
}): Stripe.PaymentIntentCreateParams {
  return {
    amount: 1_000,
    currency: 'usd',
    customer: args.customerId,
    capture_method: 'manual',
    setup_future_usage: 'off_session',
    payment_method_types: ['card'],
    metadata: {
      source: 'duet',
      type: 'onboarding_payment_method_authorization',
      workspaceId: args.workspaceId,
      userId: args.userId,
      attemptId: args.idempotencyKey,
    },
  }
}

export class AuthorizationProofFake {
  private readonly intents = new Map<string, ProofIntent>()
  private readonly idempotency = new Map<string, string>()
  private readonly customerRecords = new Map<string, ProofCustomer>()
  private sequence = 0
  private checkoutRequest?: Stripe.Checkout.SessionCreateParams

  readonly paymentIntents = {
    create: async (params: Stripe.PaymentIntentCreateParams, options?: ProofRequestOptions) => {
      const key = options?.idempotencyKey
      const existingId = key === undefined ? undefined : this.idempotency.get(key)
      if (existingId !== undefined) return this.intent(existingId)

      const id = `pi_proof_${++this.sequence}`
      const intent: ProofIntent = {
        id,
        amount: params.amount,
        amount_capturable: 0,
        capture_method: 'manual',
        currency: 'usd',
        customer: customerId(params.customer),
        metadata: Object.fromEntries(
          Object.entries(params.metadata ?? {}).map(([name, value]) => [name, String(value)]),
        ),
        setup_future_usage: 'off_session',
        status: 'requires_payment_method',
      }
      this.intents.set(id, intent)
      if (key !== undefined) this.idempotency.set(key, id)
      if (options?.simulateLostResponseAfterWrite) throw proofError('response_lost')
      return this.intent(id)
    },
    confirm: async (id: string, params: Stripe.PaymentIntentConfirmParams = {}) => {
      const intent = this.requireIntent(id)
      if (intent.status === 'canceled' || intent.status === 'requires_capture') {
        return this.intent(id)
      }
      const paymentMethod = paymentMethodId(params.payment_method)
      if (paymentMethod === 'pm_card_chargeDeclined') {
        intent.status = 'requires_payment_method'
        throw proofError('card_declined')
      }
      if (paymentMethod === 'pm_card_authenticationRequired') {
        intent.status = 'requires_action'
        throw proofError('authentication_required')
      }
      if (paymentMethod === undefined) throw proofError('payment_method_required')
      intent.payment_method = paymentMethod
      intent.status = 'requires_capture'
      intent.amount_capturable = intent.amount
      const customer = this.customer(intent.customer)
      if (!customer.paymentMethods.includes(paymentMethod))
        customer.paymentMethods.push(paymentMethod)
      return this.intent(id)
    },
    retrieve: async (id: string) => this.intent(id),
    cancel: async (id: string, options?: ProofRequestOptions) => {
      const intent = this.requireIntent(id)
      intent.status = 'canceled'
      intent.amount_capturable = 0
      if (options?.simulateLostResponseAfterWrite) throw proofError('response_lost')
      return this.intent(id)
    },
  }

  readonly customers = {
    update: async (id: string, params: Stripe.CustomerUpdateParams) => {
      const customer = this.customer(id)
      const defaultPaymentMethod = params.invoice_settings?.default_payment_method
      if (typeof defaultPaymentMethod === 'string')
        customer.defaultPaymentMethod = defaultPaymentMethod
      if (typeof params.name === 'string') customer.name = params.name
      if (typeof params.email === 'string') customer.email = params.email
      if (typeof params.address === 'object' && params.address !== null)
        customer.address = params.address
      return { id } as Stripe.Customer
    },
  }

  readonly checkout = {
    sessions: {
      create: async (
        params: Stripe.Checkout.SessionCreateParams,
        _options?: Stripe.RequestOptions,
      ) => {
        this.checkoutRequest = params
        const defaultPaymentMethod = this.customer(customerId(params.customer)).defaultPaymentMethod
        return {
          id: 'cs_proof_subscription',
          mode: params.mode,
          customer: params.customer,
          payment_method: defaultPaymentMethod,
          cardEntryRequired: defaultPaymentMethod === undefined,
          billingDetailsComplete: hasBillingDetails(this.customer(customerId(params.customer))),
          url: 'https://checkout.stripe.test/proof',
        } as unknown as Stripe.Checkout.Session
      },
    },
  }

  customer(id: string): ProofCustomer {
    const existing = this.customerRecords.get(id)
    if (existing !== undefined) return existing
    const created: ProofCustomer = { paymentMethods: [] }
    this.customerRecords.set(id, created)
    return created
  }

  capturedPaymentIntentIds(): string[] {
    return []
  }

  paidRevenueMicroUsd(): number {
    return 0
  }

  lastCheckoutRequest(): Stripe.Checkout.SessionCreateParams | undefined {
    return this.checkoutRequest
  }

  private requireIntent(id: string): ProofIntent {
    const intent = this.intents.get(id)
    if (intent === undefined) throw new Error(`Unknown proof PaymentIntent ${id}`)
    return intent
  }

  private intent(id: string): Stripe.PaymentIntent {
    return this.requireIntent(id) as unknown as Stripe.PaymentIntent
  }
}

function customerId(
  customer: string | Stripe.Customer | Stripe.DeletedCustomer | null | undefined,
): string {
  if (typeof customer === 'string') return customer
  if (customer !== null && customer !== undefined) return customer.id
  throw new Error('Proof PaymentIntent requires a customer')
}

function paymentMethodId(
  paymentMethod: string | Stripe.PaymentMethod | null | undefined,
): string | undefined {
  return typeof paymentMethod === 'string' ? paymentMethod : paymentMethod?.id
}

function hasBillingDetails(customer: ProofCustomer): boolean {
  return (
    customer.name !== undefined &&
    customer.email !== undefined &&
    customer.address?.line1 !== undefined &&
    customer.address.city !== undefined &&
    customer.address.country !== undefined &&
    customer.address.postal_code !== undefined
  )
}

function proofError(code: string): Error & { code: string } {
  const error = new Error(code) as Error & { code: string }
  error.code = code
  return error
}
