'use client'

import { Check } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'

import type { SubscriptionPlanId } from '@repo/contract'
import { bonusPercentForPlan, SUBSCRIPTION_PLANS } from '@repo/contract'
import { cn } from '@repo/ui/lib/utils'

export function SubscriptionPlanChooser({
  selectedPlan,
  onSelect,
  disabled = false,
}: {
  selectedPlan: SubscriptionPlanId
  onSelect(plan: SubscriptionPlanId): void
  disabled?: boolean
}) {
  const t = useTranslations('duetPlanChooser')
  return (
    <div
      className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3"
      role="radiogroup"
      aria-label={t('plans')}
    >
      {(Object.keys(SUBSCRIPTION_PLANS) as SubscriptionPlanId[]).map(plan => {
        const selected = selectedPlan === plan
        const bonus = bonusPercentForPlan(plan)
        return (
          <button
            key={plan}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onSelect(plan)}
            className={cn(
              'relative min-h-[5.25rem] rounded-2xl border bg-white/75 p-3 text-left outline-none transition-[border-color,box-shadow,transform] active:scale-[.99] sm:min-h-28 sm:p-4 dark:bg-white/[.04]',
              selected
                ? 'border-violet-500 shadow-[0_10px_30px_rgba(124,58,237,.15)] ring-2 ring-violet-500/20'
                : 'border-slate-200 hover:border-slate-300 dark:border-white/10 dark:hover:border-white/20',
            )}
          >
            {plan === 'pro' ? (
              <span className="absolute bottom-3 right-3 rounded-full bg-violet-100 px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-violet-700 sm:-top-2.5 sm:bottom-auto sm:right-1/2 sm:translate-x-1/2 sm:px-2.5 sm:text-[10px] dark:bg-violet-400/15 dark:text-violet-200">
                {t('recommended')}
              </span>
            ) : null}
            <span className="flex items-center justify-between gap-2 pr-24 sm:pr-0">
              <span className="text-base font-semibold capitalize text-slate-950 dark:text-white">
                {t(`plan.${plan}`)}
              </span>
              {selected ? (
                <span className="grid size-5 place-items-center rounded-full bg-violet-600 text-white">
                  <Check aria-hidden size={12} weight="bold" />
                </span>
              ) : null}
            </span>
            <span className="mt-1 grid grid-cols-[auto_1fr] items-baseline gap-x-4 sm:mt-2 sm:block">
              <span className="text-xl font-semibold tracking-tight text-slate-950 sm:text-2xl dark:text-white">
                {formatPlanPrice(SUBSCRIPTION_PLANS[plan].monthlyPriceMicroUsd)}
                <span className="ml-1 text-[13px] font-medium text-slate-600 sm:text-xs sm:text-slate-500 dark:text-slate-300 sm:dark:text-slate-400">
                  {t('perMonth')}
                </span>
              </span>
              <span className="text-[13px] text-slate-600 sm:mt-2 sm:block sm:text-xs sm:text-slate-500 dark:text-slate-300 sm:dark:text-slate-400">
                {bonus > 0 ? t('bonus', { percent: bonus }) : t('monthlyCreditsIncluded')}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

function formatPlanPrice(microUsd: number): string {
  return `$${Math.round(microUsd / 1_000_000)}`
}
