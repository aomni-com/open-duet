'use client'

import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  CategoryScale,
  Tooltip,
} from 'chart.js'
import { useLocale, useTranslations } from 'next-intl'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { UsageReportPeriod, UsageReportResponse } from '@repo/contract'
import { buttonVariants } from '@repo/ui/components/shadcn/button'
import { cn } from '@repo/ui/lib/utils'

import { SettingsCard } from './settings-frame'

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Tooltip)

export function UsageSpendChart({
  reports,
}: {
  reports: Partial<Record<UsageReportPeriod, UsageReportResponse>>
}) {
  const t = useTranslations('duetSettings.workspace.usage')
  const locale = useLocale()
  const [period, setPeriod] = useState<UsageReportPeriod>('daily')
  const report = reports[period]
  const rows = useMemo(() => (report?.rows ?? []).slice(-periodLimit(period)), [period, report])

  return (
    <SettingsCard title={t('chartTitle')} description={t('chartDescription')}>
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label={t('chartPeriod')}>
        {(['daily', 'weekly', 'monthly'] as const).map(item => (
          <button
            key={item}
            type="button"
            className={cn(
              buttonVariants({ variant: period === item ? 'default' : 'outline', size: 'sm' }),
            )}
            onClick={() => setPeriod(item)}
            aria-pressed={period === item}
          >
            {t(`periods.${item}`)}
          </button>
        ))}
      </div>
      {report === undefined ? (
        <p className="text-sm text-muted-foreground">{t('chartLoading')}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
          {t('chartEmpty')}
        </p>
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 rounded-lg bg-muted/30 px-4 py-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t('latestSpend')}
              </p>
              <p className="mt-1 text-2xl font-semibold tracking-tight">
                {formatSpend(rows.at(-1)!.spendMicroUsd, locale)}
              </p>
            </div>
            <p className="text-sm text-muted-foreground">{t(`periods.latest.${period}`)}</p>
          </div>
          <SpendPlot rows={rows} locale={locale} ariaLabel={t('chartTitle')} />
        </div>
      )}
    </SettingsCard>
  )
}

function SpendPlot({
  rows,
  locale,
  ariaLabel,
}: {
  rows: UsageReportResponse['rows']
  locale: string
  ariaLabel: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: rows.map(row => row.period),
        datasets: [
          {
            data: rows.map(row => row.spendMicroUsd / 1_000_000),
            borderColor: '#2563eb',
            backgroundColor: 'transparent',
            pointBackgroundColor: '#2563eb',
            pointBorderColor: '#2563eb',
            pointRadius: 4,
            pointHoverRadius: 5,
            tension: 0,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'nearest', intersect: true },
        plugins: {
          legend: { display: false },
          tooltip: {
            displayColors: false,
            callbacks: {
              title: items => formatReportPeriod(String(items[0]?.label ?? ''), locale),
              label: context => formatSpend((context.parsed.y ?? 0) * 1_000_000, locale),
            },
          },
        },
        scales: {
          x: { grid: { display: false }, ticks: { display: false } },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(100,116,139,.3)' },
            ticks: { display: false },
          },
        },
      },
    })
    return () => chart.destroy()
  }, [locale, rows])

  const max = Math.max(...rows.map(row => row.spendMicroUsd), 1)
  const last = rows.at(-1)!
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
        <div className="flex flex-col justify-between py-1 text-right text-xs tabular-nums text-muted-foreground">
          <span>{formatSpend(max, locale)}</span>
          <span>$0</span>
        </div>
        <div className="relative h-28 rounded-lg bg-muted/20">
          <canvas ref={canvasRef} role="img" aria-label={ariaLabel} />
        </div>
      </div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{rows[0]?.period}</span>
        <span>{last.period}</span>
      </div>
    </div>
  )
}

function periodLimit(period: UsageReportPeriod): number {
  return period === 'daily' ? 30 : period === 'weekly' ? 12 : 12
}

function formatSpend(microUsd: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(microUsd / 1_000_000)
}

function formatReportPeriod(period: string, locale: string): string {
  const date = new Date(`${period}-01T00:00:00Z`)
  if (period.length === 10) {
    return new Intl.DateTimeFormat(locale, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${period}T00:00:00Z`))
  }
  if (period.length === 7 && !Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat(locale, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date)
  }
  return period
}
