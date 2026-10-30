'use client'

import { useLocale, useTranslations } from 'next-intl'

import type { VmTelemetrySample } from '@repo/contract'
import { Skeleton } from '@repo/ui/components/shadcn/skeleton'

import { SettingsCard } from './settings-frame'

type TelemetryHistoryState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; samples: VmTelemetrySample[] }

type MetricKey = 'cpuPct' | 'memUsedMb' | 'memTotalMb' | 'diskUsedMb' | 'diskTotalMb'

export function TelemetryHistoryChart({ state }: { state: TelemetryHistoryState }) {
  const t = useTranslations('duetSettings.workspace.usage.telemetry')
  const locale = useLocale()

  return (
    <div data-telemetry-history-chart>
      <SettingsCard title={t('title')} description={t('description')}>
        {state.status === 'loading' ? (
          <div aria-label={t('loading')} className="space-y-3">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-20 rounded-xl" />
            ))}
          </div>
        ) : state.status === 'error' ? (
          <p role="alert" className="text-sm leading-6 text-muted-foreground">
            {t('error')}
          </p>
        ) : state.samples.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-muted/20 px-4 py-8 text-center">
            <p className="font-medium">{t('emptyTitle')}</p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('emptyBody')}</p>
          </div>
        ) : (
          <div className="space-y-5">
            <MetricChart
              title={t('cpu')}
              samples={state.samples}
              series={[{ key: 'cpuPct', label: t('cpu'), color: '#2563eb' }]}
              ceiling={100}
              formatValue={value => `${Math.round(value)}%`}
            />
            <MetricChart
              title={t('memory')}
              samples={state.samples}
              series={[
                { key: 'memUsedMb', label: t('memoryUsed'), color: '#7c3aed' },
                { key: 'memTotalMb', label: t('memoryTotal'), color: '#475569', dashed: true },
              ]}
              formatValue={formatStorage}
            />
            <MetricChart
              title={t('disk')}
              samples={state.samples}
              series={[
                { key: 'diskUsedMb', label: t('diskUsed'), color: '#059669' },
                { key: 'diskTotalMb', label: t('diskTotal'), color: '#475569', dashed: true },
              ]}
              formatValue={formatStorage}
            />
            <TimeRange samples={state.samples} locale={locale} />
          </div>
        )}
      </SettingsCard>
    </div>
  )
}

function MetricChart({
  title,
  samples,
  series,
  ceiling,
  formatValue,
}: {
  title: string
  samples: VmTelemetrySample[]
  series: Array<{ key: MetricKey; label: string; color: string; dashed?: boolean }>
  ceiling?: number
  formatValue(value: number): string
}) {
  const values = series.flatMap(item =>
    samples.flatMap(sample => {
      const value = sample[item.key]
      return value === undefined ? [] : [value]
    }),
  )
  const max = ceiling ?? Math.max(...values, 1)
  return (
    <section aria-label={title}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{title}</h4>
        {series.length > 1 ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {series.map(item => (
              <span
                key={item.key}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <span
                  className={`block h-0 w-5 border-t-2 ${item.dashed ? 'border-dashed' : ''}`}
                  style={{ borderColor: item.color }}
                />
                {item.label}
                {item.dashed ? ` · ${formatValue(maxMetricValue(samples, item.key))}` : null}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-[3rem_minmax(0,1fr)] items-stretch gap-2">
        <div className="flex flex-col justify-between py-1 text-right text-xs tabular-nums text-muted-foreground">
          <span>{formatValue(max)}</span>
          <span>{formatValue(0)}</span>
        </div>
        <svg
          viewBox="0 0 300 64"
          className="h-20 w-full overflow-visible rounded-lg bg-muted/20"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${title} history`}
        >
          {[8, 24, 40, 56].map(y => (
            <line
              key={y}
              x1="0"
              x2="300"
              y1={y}
              y2={y}
              stroke="currentColor"
              className="text-muted-foreground/30"
              strokeWidth="0.9"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {series.map(item => {
            const path = telemetryLinePath(samples, item.key, max)
            return path === null ? null : (
              <path
                key={item.key}
                d={path}
                fill="none"
                stroke={item.color}
                strokeWidth={item.dashed ? '1.8' : '2.2'}
                strokeDasharray={item.dashed ? '5 4' : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            )
          })}
        </svg>
      </div>
    </section>
  )
}

export function telemetryLinePath(
  samples: VmTelemetrySample[],
  key: MetricKey,
  max: number,
): string | null {
  const firstAt = samples[0]?.at
  const lastAt = samples.at(-1)?.at
  if (firstAt === undefined || lastAt === undefined) return null
  const duration = lastAt - firstAt
  const points = samples.flatMap(sample => {
    const value = sample[key]
    if (value === undefined) return []
    const x =
      duration <= 0 ? 150 : Math.max(0, Math.min(300, ((sample.at - firstAt) / duration) * 300))
    const y = 56 - Math.min(1, value / max) * 48
    return [{ x, y }]
  })
  if (points.length === 0) return null
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x} ${point.y}`).join(' ')
}

function maxMetricValue(samples: VmTelemetrySample[], key: MetricKey): number {
  return Math.max(
    ...samples.flatMap(sample => {
      const value = sample[key]
      return value === undefined ? [] : [value]
    }),
    0,
  )
}

function TimeRange({ samples, locale }: { samples: VmTelemetrySample[]; locale: string }) {
  const formatter = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' })
  const range = telemetryTimeRange(samples)
  if (range === null) return null
  return (
    <div className="ml-14 flex justify-between text-xs tabular-nums text-muted-foreground">
      <time dateTime={new Date(range.firstAt).toISOString()}>
        {formatter.format(range.firstAt)}
      </time>
      <time dateTime={new Date(range.middleAt).toISOString()}>
        {formatter.format(range.middleAt)}
      </time>
      <time dateTime={new Date(range.lastAt).toISOString()}>{formatter.format(range.lastAt)}</time>
    </div>
  )
}

export function telemetryTimeRange(
  samples: Array<Pick<VmTelemetrySample, 'at'>>,
): { firstAt: number; middleAt: number; lastAt: number } | null {
  const firstAt = samples[0]?.at
  const lastAt = samples.at(-1)?.at
  if (firstAt === undefined || lastAt === undefined) return null
  return { firstAt, middleAt: firstAt + (lastAt - firstAt) / 2, lastAt }
}

function formatStorage(value: number): string {
  if (value >= 1024) return `${(value / 1024).toFixed(value >= 10_240 ? 0 : 1)} GB`
  return `${Math.round(value)} MB`
}
