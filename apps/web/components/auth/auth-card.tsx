'use client'

import { CheckCircle, EnvelopeSimple, HardDrive } from '@phosphor-icons/react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'

import { Button } from '@repo/ui/components/shadcn/button'
import { Input } from '@repo/ui/components/shadcn/input'
import { cn } from '@repo/ui/lib/utils'

import { DuetMark } from '../brand/duet-mark'

export type AuthCardCopy = {
  invitationLabel: string
  invitedTitle: string
  defaultTitle: string
  invitedDescription: string
  defaultDescription: string
  sentTitle: string
  sentPrefix: string
  googleReturnTitle: string
  magicReturnTitle: string
  returnDescription: string
  preparingTitle: string
  preparingDescription: string
  continueWithGoogle: string
  or: string
  emailLabel: string
  emailPlaceholder: string
  emailLink: string
  legalPrefix: string
  legalTerms: string
  legalJoiner: string
  legalPrivacy: string
  legalSuffix: string
}

export type AuthCardPhase =
  | 'idle'
  | 'sending-link'
  | 'email-sent'
  | 'google-return'
  | 'magic-return'
  | 'preparing-workspace'

export function AuthCard({
  invited = false,
  email,
  phase = 'idle',
  error,
  copy,
  surface = 'card',
  publicSiteLocale = 'en',
  onEmailChange,
  onGoogle,
  onMagicLink,
}: {
  invited?: boolean
  email: string
  phase?: AuthCardPhase
  error?: string
  copy: AuthCardCopy
  surface?: 'card' | 'plain'
  publicSiteLocale?: string
  onEmailChange?: (email: string) => void
  onGoogle?: () => void
  onMagicLink?: () => void
}) {
  const reduceMotion = useReducedMotion()
  const transition = reduceMotion
    ? { duration: 0 }
    : { duration: 0.26, ease: [0.22, 1, 0.36, 1] as const }
  const progress =
    phase === 'google-return' || phase === 'magic-return' || phase === 'preparing-workspace'

  return (
    <motion.section
      className={cn(
        'w-full',
        surface === 'card'
          ? 'max-w-md rounded-3xl border bg-background p-7 shadow-xl sm:p-9'
          : 'max-w-sm',
      )}
      initial={reduceMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={transition}
    >
      {surface === 'card' ? <DuetMark active={progress} priority size="md" /> : null}
      {invited || surface === 'card' ? (
        <p className={cn('text-sm font-medium text-brand', surface === 'card' && 'mt-7')}>
          {invited ? copy.invitationLabel : 'Duet'}
        </p>
      ) : null}
      <h1
        className={cn(
          'text-3xl font-semibold tracking-[-0.025em]',
          (invited || surface === 'card') && 'mt-2',
        )}
      >
        {invited ? copy.invitedTitle : copy.defaultTitle}
      </h1>
      <p className="mt-3 text-pretty text-[15px] leading-6 text-foreground/70">
        {invited ? copy.invitedDescription : copy.defaultDescription}
      </p>

      <AnimatePresence initial={false} mode="wait">
        {progress ? (
          <AuthProgress key="auth-progress" phase={phase} copy={copy} reduceMotion={reduceMotion} />
        ) : phase === 'email-sent' ? (
          <motion.div
            key="email-sent"
            role="status"
            aria-live="polite"
            className="mt-8 rounded-2xl border bg-muted/80 p-5"
            initial={reduceMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -3 }}
            transition={transition}
          >
            <p className="flex items-center gap-2 font-medium">
              <CheckCircle aria-hidden className="size-5 text-brand" weight="fill" />
              {copy.sentTitle}
            </p>
            <p className="mt-1 text-sm leading-6 text-foreground/70">
              {copy.sentPrefix}{' '}
              <span className="whitespace-nowrap font-medium text-foreground">{email}</span>.
            </p>
          </motion.div>
        ) : (
          <motion.form
            key="form"
            className="mt-8 space-y-3.5"
            initial={reduceMotion ? false : { opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -3 }}
            transition={transition}
            onSubmit={event => {
              event.preventDefault()
              onMagicLink?.()
            }}
          >
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full shadow-xs transition-[background-color,border-color,transform] active:scale-[0.99] motion-reduce:transform-none"
              onClick={onGoogle}
            >
              <GoogleMark /> {copy.continueWithGoogle}
            </Button>
            <div className="flex items-center gap-3 py-1 text-xs uppercase tracking-[0.14em] text-muted-foreground">
              <span className="h-px flex-1 bg-border" /> {copy.or}{' '}
              <span className="h-px flex-1 bg-border" />
            </div>
            <label className="block text-sm font-medium" htmlFor="auth-email">
              {copy.emailLabel}
            </label>
            <Input
              id="auth-email"
              type="email"
              autoComplete="email"
              value={email}
              disabled={phase === 'sending-link'}
              onChange={event => onEmailChange?.(event.target.value)}
              placeholder={copy.emailPlaceholder}
              className="h-11 bg-background px-3 shadow-xs focus-visible:ring-2 focus-visible:ring-brand/20"
            />
            <Button
              type="submit"
              variant="brand"
              className="h-11 w-full bg-[oklch(0.54_0.16_254)] shadow-xs transition-[background-color,transform] hover:bg-[oklch(0.5_0.16_254)] focus-visible:ring-brand/45 active:scale-[0.99] motion-reduce:transform-none"
              isLoading={phase === 'sending-link'}
              disabled={phase === 'sending-link'}
            >
              <EnvelopeSimple size={18} /> {copy.emailLink}
            </Button>
          </motion.form>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {error ? (
          <motion.p
            role="alert"
            className="mt-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive"
            initial={reduceMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={transition}
          >
            {error}
          </motion.p>
        ) : null}
      </AnimatePresence>
      <p className="mt-7 text-xs leading-5 text-foreground/65">
        {copy.legalPrefix}
        <LegalLink href={publicSiteHref(publicSiteLocale, '/terms')}>{copy.legalTerms}</LegalLink>
        {copy.legalJoiner}
        <LegalLink href={publicSiteHref(publicSiteLocale, '/privacy-policy')}>
          {copy.legalPrivacy}
        </LegalLink>
        {copy.legalSuffix}
      </p>
    </motion.section>
  )
}

function LegalLink({ href, children }: { href: string; children: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="font-medium text-foreground/80 underline decoration-border underline-offset-2 transition-colors hover:text-foreground"
    >
      {children}
    </a>
  )
}

function publicSiteHref(locale: string, path: string) {
  const localePrefix = locale === 'es-419' ? '/es' : ''
  return `https://duet.so${localePrefix}${path}`
}

function AuthProgress({
  phase,
  copy,
  reduceMotion,
}: {
  phase: Extract<AuthCardPhase, 'google-return' | 'magic-return' | 'preparing-workspace'>
  copy: AuthCardCopy
  reduceMotion: boolean | null
}) {
  const preparing = phase === 'preparing-workspace'
  return (
    <motion.div
      role="status"
      aria-live="polite"
      className="mt-8 flex min-h-40 flex-col justify-center overflow-hidden border-y border-border/65 py-6"
      initial={reduceMotion ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -3 }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="flex items-start gap-3">
        <motion.span
          key={`${phase}-mark`}
          className="relative mt-0.5 grid size-9 shrink-0 place-items-center"
          initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
        >
          {preparing ? (
            <span className="grid size-9 place-items-center rounded-full border border-border bg-background text-brand shadow-xs">
              <HardDrive aria-hidden size={18} weight="duotone" />
            </span>
          ) : phase === 'google-return' ? (
            <span className="relative grid size-9 place-items-center rounded-full border border-border bg-background p-2 shadow-xs">
              <GoogleMark className="size-5" />
            </span>
          ) : (
            <span className="relative grid size-9 place-items-center rounded-full border border-border bg-background text-brand shadow-xs">
              <EnvelopeSimple aria-hidden size={18} weight="bold" />
            </span>
          )}
        </motion.span>
        <motion.div
          key={`${phase}-copy`}
          className="min-w-0 flex-1"
          initial={reduceMotion ? false : { opacity: 0, y: 3 }}
          animate={{ opacity: 1, y: 0 }}
          transition={reduceMotion ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="font-medium">
            {preparing
              ? copy.preparingTitle
              : phase === 'google-return'
                ? copy.googleReturnTitle
                : copy.magicReturnTitle}
          </p>
          <p className="mt-1 text-sm leading-6 text-foreground/70">
            {preparing ? copy.preparingDescription : copy.returnDescription}
          </p>
        </motion.div>
      </div>
      <div aria-hidden className="mt-5 grid grid-cols-2 gap-1.5">
        <ProgressSegment active={!preparing} complete={preparing} reduceMotion={reduceMotion} />
        <ProgressSegment active={preparing} complete={false} reduceMotion={reduceMotion} />
      </div>
    </motion.div>
  )
}

function ProgressSegment({
  active,
  complete,
  reduceMotion,
}: {
  active: boolean
  complete: boolean
  reduceMotion: boolean | null
}) {
  return (
    <span className="h-1 overflow-hidden rounded-full bg-border">
      <motion.span
        className="block h-full origin-left rounded-full bg-brand"
        initial={false}
        animate={
          complete
            ? { opacity: 1, scaleX: 1 }
            : active
              ? reduceMotion
                ? { opacity: 0.72, scaleX: 0.65 }
                : { opacity: [0.5, 1, 0.5], scaleX: [0.18, 0.88, 0.18] }
              : { opacity: 0, scaleX: 0 }
        }
        transition={
          active && !reduceMotion
            ? { duration: 1.55, ease: 'easeInOut', repeat: Number.POSITIVE_INFINITY }
            : { duration: reduceMotion ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }
        }
      />
    </span>
  )
}

function GoogleMark({ className }: { className?: string } = {}) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      className={cn('size-4', className)}
    >
      <path
        fill="#4285f4"
        d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z"
      />
      <path
        fill="#34a853"
        d="M12 22c2.7 0 4.97-.9 6.62-2.42l-3.24-2.54c-.9.6-2.05.96-3.38.96-2.6 0-4.81-1.76-5.6-4.13H3.06v2.62A10 10 0 0 0 12 22Z"
      />
      <path
        fill="#fbbc05"
        d="M6.4 13.87A6 6 0 0 1 6.08 12c0-.65.11-1.28.32-1.87V7.51H3.06A10 10 0 0 0 2 12c0 1.61.39 3.14 1.06 4.49l3.34-2.62Z"
      />
      <path
        fill="#ea4335"
        d="M12 6c1.47 0 2.78.5 3.82 1.5l2.86-2.86C16.97 3.05 14.7 2 12 2a10 10 0 0 0-8.94 5.51l3.34 2.62C7.19 7.76 9.4 6 12 6Z"
      />
    </svg>
  )
}
