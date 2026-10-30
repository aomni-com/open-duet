'use client'

import { CheckCircle, CircleNotch, CreditCard } from '@phosphor-icons/react'
import { CardElement, Elements, useElements, useStripe } from '@stripe/react-stripe-js'
import { loadStripe, type Stripe } from '@stripe/stripe-js'
import { useTranslations } from 'next-intl'
import { useEffect, useMemo, useRef, useState } from 'react'

import type {
  OnboardingBillingDetails,
  OnboardingPaymentIntentResponse,
  OnboardingPaymentStatus,
} from '@repo/contract'
import { cn } from '@repo/ui/lib/utils'

import type { DuetApiClient } from '../api/client'

type PaymentStepProps = {
  workspaceSlug: string
  api: Pick<
    DuetApiClient,
    'createOnboardingPaymentIntent' | 'completeOnboardingPayment' | 'onboardingPaymentStatus'
  >
  billingEmail?: string
  onReady: () => void
}

export function OnboardingPaymentStep({
  workspaceSlug,
  api,
  billingEmail,
  onReady,
}: PaymentStepProps) {
  const t = useTranslations('duetOnboarding')
  const [attemptId] = useState(() =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `attempt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  const [intent, setIntent] =
    useState<
      Extract<OnboardingPaymentIntentResponse, { status: 'requires_confirmation' | 'pending' }>
    >()
  const [stripe, setStripe] = useState<Stripe | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'card' | 'pending' | 'error'>(
    'loading',
  )
  const [error, setError] = useState<string>()
  const [billingName, setBillingName] = useState('')
  const [email, setEmail] = useState(billingEmail ?? '')
  const [address, setAddress] = useState({
    line1: '',
    city: '',
    state: '',
    postalCode: '',
    country: 'US',
  })
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    let active = true
    void api
      .onboardingPaymentStatus(workspaceSlug)
      .then(async current => {
        if (!active) return
        if (current.ready) {
          setStatus('ready')
          onReady()
          return
        }
        const response = await api.createOnboardingPaymentIntent(workspaceSlug, { attemptId })
        if (!active) return
        if (response.status === 'ready') {
          setStatus('ready')
          onReady()
          return
        }
        setIntent(response)
        setStripe(await loadStripe(response.publishableKey))
        setStatus('card')
      })
      .catch(() => {
        if (active) {
          setStatus('error')
          setError(t('paymentSetupError'))
        }
      })
    return () => {
      active = false
    }
  }, [api, attemptId, onReady, t, workspaceSlug])

  if (status === 'ready') {
    return <PaymentReadyState t={t} />
  }
  if (status === 'loading') {
    return <LoadingPayment t={t} />
  }
  if (status === 'error' || intent === undefined || stripe === null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {error ?? t('paymentSetupError')}
      </p>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {t('paymentKicker')}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t('paymentTitle')}</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">{t('paymentBody')}</p>
      </div>
      <div className="rounded-2xl border border-foreground/10 bg-background/45 p-5 dark:bg-white/[0.02]">
        <p className="flex items-center gap-2 text-sm font-medium">
          <CreditCard className="size-4" aria-hidden />
          {t('cardDetailsLabel')}
        </p>
        <label className="mt-4 block text-sm">
          <span className="text-muted-foreground">{t('billingNameLabel')}</span>
          <input
            value={billingName}
            onChange={event => setBillingName(event.target.value)}
            autoComplete="cc-name"
            className="mt-2 h-11 w-full rounded-xl border border-foreground/15 bg-background px-3 outline-none focus:border-foreground/40 focus:ring-4 focus:ring-foreground/[0.06]"
          />
        </label>
        <label className="mt-4 block text-sm">
          <span className="text-muted-foreground">{t('billingEmailLabel')}</span>
          <input
            value={email}
            onChange={event => setEmail(event.target.value)}
            type="email"
            autoComplete="email"
            className="mt-2 h-11 w-full rounded-xl border border-foreground/15 bg-background px-3 outline-none focus:border-foreground/40 focus:ring-4 focus:ring-foreground/[0.06]"
          />
        </label>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm sm:col-span-2">
            <span className="text-muted-foreground">{t('billingAddressLabel')}</span>
            <input
              value={address.line1}
              onChange={event => setAddress(current => ({ ...current, line1: event.target.value }))}
              autoComplete="address-line1"
              className="mt-2 h-11 w-full rounded-xl border border-foreground/15 bg-background px-3 outline-none focus:border-foreground/40 focus:ring-4 focus:ring-foreground/[0.06]"
            />
          </label>
          <label className="text-sm">
            <span className="text-muted-foreground">{t('billingCityLabel')}</span>
            <input
              value={address.city}
              onChange={event => setAddress(current => ({ ...current, city: event.target.value }))}
              autoComplete="address-level2"
              className="mt-2 h-11 w-full rounded-xl border border-foreground/15 bg-background px-3 outline-none focus:border-foreground/40 focus:ring-4 focus:ring-foreground/[0.06]"
            />
          </label>
          <label className="text-sm">
            <span className="text-muted-foreground">{t('billingStateLabel')}</span>
            <input
              value={address.state}
              onChange={event => setAddress(current => ({ ...current, state: event.target.value }))}
              autoComplete="address-level1"
              className="mt-2 h-11 w-full rounded-xl border border-foreground/15 bg-background px-3 outline-none focus:border-foreground/40 focus:ring-4 focus:ring-foreground/[0.06]"
            />
          </label>
          <label className="text-sm">
            <span className="text-muted-foreground">{t('billingPostalCodeLabel')}</span>
            <input
              value={address.postalCode}
              onChange={event =>
                setAddress(current => ({ ...current, postalCode: event.target.value }))
              }
              autoComplete="postal-code"
              className="mt-2 h-11 w-full rounded-xl border border-foreground/15 bg-background px-3 outline-none focus:border-foreground/40 focus:ring-4 focus:ring-foreground/[0.06]"
            />
          </label>
          <label className="text-sm">
            <span className="text-muted-foreground">{t('billingCountryLabel')}</span>
            <input
              value={address.country}
              onChange={event =>
                setAddress(current => ({ ...current, country: event.target.value.toUpperCase() }))
              }
              autoComplete="country"
              maxLength={2}
              className="mt-2 h-11 w-full rounded-xl border border-foreground/15 bg-background px-3 uppercase outline-none focus:border-foreground/40 focus:ring-4 focus:ring-foreground/[0.06]"
            />
          </label>
        </div>
        <div className="mt-4 rounded-xl border border-foreground/15 bg-background px-3 py-3">
          <Elements stripe={stripe} options={{ clientSecret: intent.clientSecret }}>
            <CardForm
              api={api}
              workspaceSlug={workspaceSlug}
              attemptId={intent.attemptId}
              paymentIntentId={intent.paymentIntentId}
              clientSecret={intent.clientSecret}
              billingDetails={{
                name: billingName,
                email,
                address,
              }}
              onReady={onReady}
              onPending={() => setStatus('pending')}
              onError={message => {
                setError(message)
                setStatus('card')
              }}
              t={t}
            />
          </Elements>
        </div>
        {status === 'pending' ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <CircleNotch className="size-4 animate-spin" aria-hidden />
            {t('paymentPending')}
          </p>
        ) : null}
        {error !== undefined && status !== 'pending' ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}

export function PaymentReadyState({
  t,
}: {
  t: ReturnType<typeof useTranslations<'duetOnboarding'>>
}) {
  return (
    <div className="space-y-6">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          {t('paymentKicker')}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">{t('paymentReadyTitle')}</h1>
        <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">{t('paymentBody')}</p>
      </div>
      <div className="flex items-start gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.06] p-5">
        <CheckCircle
          className="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
          weight="fill"
          aria-hidden
        />
        <div>
          <p className="font-medium">{t('paymentReady')}</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{t('paymentReadyBody')}</p>
        </div>
      </div>
    </div>
  )
}

function CardForm({
  api,
  workspaceSlug,
  attemptId,
  paymentIntentId,
  clientSecret,
  billingDetails,
  onReady,
  onPending,
  onError,
  t,
}: {
  api: PaymentStepProps['api']
  workspaceSlug: string
  attemptId: string
  paymentIntentId: string
  clientSecret: string
  billingDetails: OnboardingBillingDetails
  onReady: () => void
  onPending: () => void
  onError: (message: string) => void
  t: ReturnType<typeof useTranslations<'duetOnboarding'>>
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [submitting, setSubmitting] = useState(false)
  const canSubmit =
    stripe !== null &&
    elements !== null &&
    billingDetails.name.trim().length > 0 &&
    billingDetails.email.trim().length > 0 &&
    billingDetails.address.line1.trim().length > 0 &&
    billingDetails.address.city.trim().length > 0 &&
    billingDetails.address.postalCode.trim().length > 0 &&
    /^[A-Za-z]{2}$/.test(billingDetails.address.country.trim())
  const label = useMemo(() => (submitting ? t('paymentVerifying') : t('saveCard')), [submitting, t])

  async function submit() {
    if (!canSubmit || submitting) return
    const card = elements.getElement(CardElement)
    if (card === null) return
    setSubmitting(true)
    onPending()
    const billingState = billingDetails.address.state?.trim() ?? ''
    const result = await stripe.confirmCardPayment(
      // Stripe's PaymentIntent client secret comes from the server; the browser
      // only contributes the tokenized card element and billing details.
      clientSecret,
      {
        payment_method: {
          card,
          billing_details: {
            name: billingDetails.name.trim(),
            email: billingDetails.email.trim(),
            address: {
              line1: billingDetails.address.line1.trim(),
              city: billingDetails.address.city.trim(),
              ...(billingState.length === 0 ? {} : { state: billingState }),
              postal_code: billingDetails.address.postalCode.trim(),
              country: billingDetails.address.country.trim().toUpperCase(),
            },
          },
        },
      },
    )
    if (result.error !== undefined) {
      setSubmitting(false)
      onError(result.error.message ?? t('paymentFailed'))
      return
    }
    if (result.paymentIntent?.id !== paymentIntentId && result.paymentIntent?.id !== undefined) {
      setSubmitting(false)
      onError(t('paymentFailed'))
      return
    }
    try {
      const completed: OnboardingPaymentStatus = await api.completeOnboardingPayment(
        workspaceSlug,
        {
          attemptId,
          paymentIntentId: result.paymentIntent?.id ?? paymentIntentId,
          billingDetails: {
            name: billingDetails.name.trim(),
            email: billingDetails.email.trim(),
            address: {
              line1: billingDetails.address.line1.trim(),
              city: billingDetails.address.city.trim(),
              postalCode: billingDetails.address.postalCode.trim(),
              country: billingDetails.address.country.trim().toUpperCase(),
              ...(billingState.length === 0 ? {} : { state: billingState }),
            },
          },
        },
      )
      if (!completed.ready) throw new Error(t('paymentFailed'))
      onReady()
    } catch (error) {
      onError(error instanceof Error ? error.message : t('paymentFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div>
      <CardElement options={{ hidePostalCode: false }} />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSubmit || submitting}
        className={cn(
          'mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-xl bg-foreground px-4 text-sm font-semibold text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40',
        )}
      >
        {submitting ? <CircleNotch className="mr-2 size-4 animate-spin" aria-hidden /> : null}
        {label}
      </button>
    </div>
  )
}

function LoadingPayment({ t }: { t: ReturnType<typeof useTranslations<'duetOnboarding'>> }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <CircleNotch className="size-4 animate-spin" aria-hidden />
      {t('paymentLoading')}
    </p>
  )
}
