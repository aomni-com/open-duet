'use client'

import { useTranslations } from 'next-intl'

import { SpendRefusalSchema, type SpendRefusal } from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { DuetApiError } from '../api/client'

/**
 * A spend refusal is the one rejection a person can act on, so it has to
 * survive the trip from the API to the surface that asked. Everything else a
 * request can fail with stays anonymous on purpose — there is nothing useful to
 * say about a dropped socket that "try again" does not already cover.
 *
 * The 402 status carries the weight: these codes also appear on responses that
 * are not refusals to spend.
 */
export function spendRefusalOf(error: unknown): SpendRefusal | undefined {
  if (!(error instanceof DuetApiError) || error.status !== 402) return undefined
  const parsed = SpendRefusalSchema.safeParse(error.data)
  return parsed.success ? parsed.data : undefined
}

/**
 * `monthly_cap` is two different problems wearing one code, and neither is an
 * empty wallet: `authorizeSpend` only reaches a cap check after the balance
 * check passed, so this caller has credits and is stopped by a limit. Which
 * limit decides what can be done about it — only the account's has a control on
 * the billing page — so the tier picks the copy rather than decorating it.
 */
function refusalCopyKey({ code, tier }: SpendRefusal): string {
  if (code !== 'monthly_cap') return code
  return tier === 'workspace' ? 'monthly_cap_workspace' : 'monthly_cap_account'
}

/**
 * `agentName` is not decoration: a refusal that names who stopped reads as this
 * session pausing rather than the product breaking, which is what happened.
 */
export function SpendRefusalNotice({
  refusal,
  agentName,
  onRecoveryStart,
}: {
  refusal: SpendRefusal
  agentName: string
  onRecoveryStart?: () => void
}) {
  const t = useTranslations('duetSpendRefusal')
  const key = refusalCopyKey(refusal)
  return (
    <div
      role="alert"
      data-spend-refusal={refusal.code}
      className="rounded-md border border-destructive/40 bg-destructive/5 p-3"
    >
      <p className="text-sm font-semibold text-destructive">{t(`${key}.title`)}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t(`${key}.body`, { name: agentName })}</p>
      {/* A new tab, not a route change: /settings/* is a sibling of /w/:slug,
          so navigating in place unmounts this composer and takes the rejected
          draft — the very thing the reader came back to send — with it. */}
      <a
        href="/settings/billing"
        target="_blank"
        rel="noreferrer"
        onClick={onRecoveryStart}
        className={cn(buttonVariants({ size: 'sm' }), 'mt-3')}
      >
        {t(`${key}.action`)}
      </a>
    </div>
  )
}
