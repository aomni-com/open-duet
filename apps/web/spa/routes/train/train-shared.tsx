'use client'

import { useTranslations } from 'next-intl'

import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

export function TrainInlineRetry({ message, onRetry }: { message: string; onRetry(): void }) {
  const t = useTranslations('duetTrain')
  return (
    <div className="mt-5 rounded-xl border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
      <p>{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className={cn(
          buttonVariants({ variant: 'outline', size: 'sm' }),
          'mt-2 border-destructive/20 text-destructive hover:bg-destructive/10 hover:text-destructive',
        )}
      >
        {t('retry')}
      </button>
    </div>
  )
}

export function formatTrainDate(value: string | number, locale: string): string {
  const date = typeof value === 'number' ? new Date(value) : new Date(value)
  return Number.isNaN(date.valueOf())
    ? '—'
    : new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)
}
