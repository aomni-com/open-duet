'use client'

import { Check, CircleNotch } from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { useTranslations } from 'next-intl'
import { useEffect, useId, useRef, useState } from 'react'

import { Input } from '@repo/ui/components/shadcn/input'
import { cn } from '@repo/ui/lib/utils'

import { PrimaryButton } from '@/components/landing/landing-cta'
import { buildEmailLeadRequest } from '@/src/campaigns/browser-action'

function faviconUrl(domain: string) {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128`
}

/** Consumer inboxes whose favicon says nothing about the lead's company — the
 * in-input favicon is a "we see your business" moment, so these stay blank. */
const FREE_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.net',
  'mail.com',
  'zoho.com',
  'fastmail.com',
  'hey.com',
  'qq.com',
  '163.com',
  'yandex.com',
])

/** The company domain worth previewing from a partial email — needs a
 * plausible `something.tld` after the `@`, and not a consumer inbox. */
function companyDomainFromEmail(email: string): string | null {
  const domain = email.trim().toLowerCase().split('@')[1]
  if (!domain || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) return null
  return FREE_MAIL_DOMAINS.has(domain) ? null : domain
}

type EmailCaptureFormProps = {
  className?: string
  buttonText?: string
  placeholder?: string
  /** Overrides the default success line (e.g. a lander-specific confirmation). */
  successText?: string
  onSuccess?: () => void
  variant?: 'compact' | 'large'
  source?: string
  pageSlug?: string
  /** Campaign registry slug. Editorial captures use the code-owned organic campaign. */
  campaignSlug?: string
  /**
   * The lead's company, when the lander already knows it (e.g. the `/grow`
   * scan flow). Stored inside the campaign lead's generic data object.
   */
  company?: { name?: string; url?: string }
  /**
   * Opt-in success choreography: the form softly gives way, the check scales
   * in, the confirmation rises after it. Default off so blog/footer usages
   * keep their instant swap.
   */
  celebrate?: boolean
  /**
   * Live company-favicon preview inside the input (the `/grow` trick): once
   * the typed email has a real company domain, its favicon springs in at the
   * field's left edge — the page starts looking at them before they submit.
   * Consumer domains (gmail, outlook, …) stay blank. Default off.
   */
  companyFavicon?: boolean
  /**
   * Wrap the success confirmation in a solid surface pill so it stays legible
   * over a busy background (e.g. the agent-drive hero video) — it reads as the
   * input field transformed into a chip. Default off keeps the plain inline
   * confirmation for blog/footer and other landers.
   */
  successPill?: boolean
}

export function EmailCaptureForm({
  className,
  buttonText,
  placeholder,
  successText,
  onSuccess,
  variant = 'compact',
  source,
  pageSlug,
  campaignSlug = 'organic',
  company,
  celebrate = false,
  companyFavicon = false,
  successPill = false,
}: EmailCaptureFormProps) {
  const t = useTranslations('blogUi')
  const reduceMotion = useReducedMotion()
  const resolvedButtonText = buttonText ?? t('subscribe')
  const resolvedPlaceholder = placeholder ?? t('enterEmail')
  const [email, setEmail] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isSuccess, setIsSuccess] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Debounced company-domain preview; `loaded` gates the reveal so a slow (or
  // failed) favicon fetch never flashes a broken image into the field.
  const [faviconDomain, setFaviconDomain] = useState<string | null>(null)
  const [faviconLoaded, setFaviconLoaded] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const successRef = useRef<HTMLDivElement>(null)
  // Unique per instance — the form renders twice per lander (hero + closing), so a
  // shared static id would collide and break label association.
  const fieldId = useId()

  useEffect(() => {
    if (!companyFavicon) return
    const timer = setTimeout(() => {
      const domain = companyDomainFromEmail(email)
      setFaviconDomain(prev => {
        if (domain !== prev) setFaviconLoaded(false)
        return domain
      })
    }, 450)
    return () => clearTimeout(timer)
  }, [email, companyFavicon])

  // On success the form (and the focused submit button) unmounts; move focus to the
  // confirmation so keyboard users aren't dropped to <body> and SRs land on the status.
  useEffect(() => {
    if (isSuccess) successRef.current?.focus()
  }, [isSuccess])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    // Re-entry guard instead of a disabled attribute, so the pill keeps its
    // brand blue (with the spinner) while the request is in flight.
    if (isSubmitting) return

    const trimmedEmail = email.trim()
    if (!trimmedEmail) return

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(trimmedEmail)) {
      setError(t('emailInvalid'))
      inputRef.current?.focus()
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const response = await fetch(
        `/api/campaigns/${encodeURIComponent(campaignSlug)}/actions/lead`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            buildEmailLeadRequest({
              email: trimmedEmail,
              source,
              pageSlug,
              company,
              sourceUrl: window.location.href,
              referrer: document.referrer || undefined,
            }),
          ),
        },
      )

      if (!response.ok) throw new Error('Submission failed')

      setIsSuccess(true)
      onSuccess?.()
    } catch {
      setError(t('emailError'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const isLarge = variant === 'large'

  // The confirmation check scales in after the surface lands when `celebrate`.
  const checkMark = celebrate ? (
    <motion.span
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ delay: 0.1, duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
      className="flex"
    >
      <Check className="h-5 w-5 text-[hsl(214_65%_56%)]" weight="bold" />
    </motion.span>
  ) : (
    <Check className="h-5 w-5 text-[hsl(214_65%_56%)]" weight="bold" />
  )

  const confirmation = (
    <div
      // Callback ref: with `celebrate`, this view mounts AFTER the form's exit
      // animation, so the isSuccess effect fires too early — focus on mount
      // instead (harmlessly redundant in the plain path).
      ref={node => {
        successRef.current = node
        node?.focus()
      }}
      tabIndex={-1}
      role="status"
      aria-live="polite"
      className={cn(
        'items-center gap-2 outline-none',
        variant === 'large' ? 'text-base' : 'text-sm',
        // A solid surface pill (matching the email input's own tokens) keeps the
        // confirmation legible over the hero video; otherwise a plain inline row.
        successPill
          ? 'inline-flex w-fit rounded-full border border-lv2-line bg-lv2-surface px-4 py-2 font-medium text-lv2-fg shadow-sm'
          : 'flex text-foreground',
        celebrate ? undefined : className,
      )}
    >
      {/* the lead is now "live" — the one place the rationed brand blue belongs */}
      {checkMark}
      <span>{successText ?? t('emailSuccess')}</span>
    </div>
  )

  const successView = confirmation

  // noValidate: use our own styled, role=alert validation instead of the browser's
  // native bubble, so a blocked submit is announced consistently and on-brand. Empty
  // submits are already blocked by the disabled button. (A plain JSX variable —
  // NOT a nested component, which would remount and drop focus every render.)
  const formView = (
    <form onSubmit={handleSubmit} noValidate className={cn('space-y-2', className)}>
      <label htmlFor={fieldId} className="sr-only">
        {t('enterEmail')}
      </label>
      <div className={cn('flex gap-2', isLarge ? 'flex-col sm:flex-row' : 'flex-col')}>
        <div className="relative min-w-0 flex-1">
          {/* The favicon springs in once the domain resolves — the positioning
              span owns the centering transform so motion's scale can't fight it. */}
          <AnimatePresence>
            {companyFavicon && faviconDomain ? (
              <span
                aria-hidden="true"
                className={cn(
                  'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2',
                  isLarge ? 'size-5' : 'size-4',
                )}
              >
                <motion.img
                  key={faviconDomain}
                  src={faviconUrl(faviconDomain)}
                  alt=""
                  onLoad={() => setFaviconLoaded(true)}
                  onError={() => setFaviconLoaded(false)}
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.4, y: 4 }}
                  animate={
                    faviconLoaded
                      ? { opacity: 1, scale: 1, y: 0 }
                      : reduceMotion
                        ? { opacity: 0 }
                        : { opacity: 0, scale: 0.4, y: 4 }
                  }
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.4, y: 4 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 26 }}
                  className="size-full rounded-sm"
                />
              </span>
            ) : null}
          </AnimatePresence>
          <Input
            ref={inputRef}
            id={fieldId}
            type="email"
            name="email"
            autoComplete="email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder={resolvedPlaceholder}
            // readOnly, not disabled: shadcn's `disabled:opacity-50` fades the
            // whole field to half-transparent during the in-flight submit —
            // over the hero video that reads as the input dissolving.
            readOnly={isSubmitting}
            className={cn(
              'bg-lv2-surface text-lv2-fg border border-lv2-line placeholder:text-[color:var(--lv2-muted)]',
              'focus-visible:ring-[hsl(214_65%_50%)]/50 dark:focus-visible:ring-[hsl(214_78%_66%)]/50',
              isLarge ? 'h-12 text-base' : 'h-10',
              // The text slides right to make room as the favicon lands.
              companyFavicon && 'transition-[padding] duration-300 motion-reduce:transition-none',
              companyFavicon && faviconDomain && faviconLoaded && (isLarge ? 'pl-10' : 'pl-9'),
            )}
          />
        </div>
        {/* The pill never fades: empty-field disabled is a fully opaque slate
            pill that wakes to brand blue (color, shadow, and a small spring of
            scale) on the first keystroke — h-12/py-0 pins the large pill to the
            input height, since size=md's py-4 sits taller. */}
        <motion.div
          className="shrink-0"
          animate={reduceMotion ? undefined : { scale: email.trim() ? 1 : 0.97 }}
          transition={{ type: 'spring', stiffness: 420, damping: 22 }}
        >
          <PrimaryButton
            type="submit"
            size={isLarge ? 'md' : 'sm'}
            disabled={!email.trim()}
            className={cn(
              'w-full',
              isLarge && 'h-12 py-0',
              'transition-[transform,box-shadow,background-color] duration-300',
              'disabled:opacity-100 disabled:bg-[hsl(214_16%_58%)] dark:disabled:bg-[hsl(215_12%_42%)]',
              'disabled:shadow-[0_0_0_1px_hsl(218_25%_42%/0.45)_inset,0_2px_6px_hsl(218_50%_28%/0.14)]',
              'dark:disabled:shadow-[0_0_0_1px_hsl(215_15%_52%/0.6)_inset,0_2px_8px_hsl(216_70%_2%/0.4)]',
            )}
          >
            {isSubmitting ? <CircleNotch className="h-4 w-4 animate-spin" /> : resolvedButtonText}
          </PrimaryButton>
        </motion.div>
      </div>
      {error && (
        <p
          role="alert"
          className="border-l-2 border-foreground/30 pl-2.5 text-sm text-foreground/70"
        >
          {error}
        </p>
      )}
    </form>
  )

  // Opt-in choreography: the form softly gives way; the confirmation rises in
  // its place. Default path keeps the historical instant swap.
  if (celebrate) {
    return (
      <AnimatePresence mode="wait" initial={false}>
        {isSuccess ? (
          <motion.div
            key="success"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className={className}
          >
            {successView}
          </motion.div>
        ) : (
          <motion.div
            key="form"
            exit={{
              opacity: 0,
              y: -4,
              transition: { duration: 0.18, ease: 'easeIn' },
            }}
          >
            {formView}
          </motion.div>
        )}
      </AnimatePresence>
    )
  }

  return isSuccess ? successView : formView
}
