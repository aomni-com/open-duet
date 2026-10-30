'use client'

import { useState } from 'react'

import { renderBuildingPage, type BuildingPageModel } from '@repo/gateway/building-page'

const NOW_MS = 1_700_000_000_000

const ACTIVE_MODEL = {
  name: 'Analytics',
  nowMs: NOW_MS,
  refreshSeconds: 3,
  files: [
    { path: 'server.ts', mtimeMs: NOW_MS - 4_000 },
    { path: 'index.html', mtimeMs: NOW_MS - 31_000 },
    {
      path: 'src/features/quarterly-revenue/visualizations/chart-utils.ts',
      mtimeMs: NOW_MS - 60_000,
    },
  ],
} as const satisfies BuildingPageModel

const VARIANTS = [
  { label: 'Named app with activity', model: ACTIVE_MODEL },
  {
    label: 'Slug fallback',
    model: {
      ...ACTIVE_MODEL,
      name: 'weekly-metrics-dashboard',
      files: ACTIVE_MODEL.files.slice(0, 2),
    },
  },
  {
    label: 'No activity yet',
    model: {
      name: 'new-report',
      nowMs: NOW_MS,
      refreshSeconds: 3,
      files: [],
    },
  },
] as const satisfies readonly { label: string; model: BuildingPageModel }[]

export function BuildingPagePlayground() {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selected = VARIANTS[selectedIndex] ?? VARIANTS[0]

  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-8 text-zinc-950 sm:px-8 sm:py-10 dark:bg-zinc-950 dark:text-zinc-50">
      <div className="mx-auto max-w-[1480px]">
        <header className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
            Gateway HTML renderer
          </p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">App building page</h1>
        </header>
        <div className="mb-4 flex flex-wrap gap-2" aria-label="Building page variants">
          {VARIANTS.map((variant, index) => (
            <button
              key={variant.label}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                index === selectedIndex
                  ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-950'
                  : 'border-zinc-300 bg-white text-zinc-600 hover:text-zinc-950 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:text-white'
              }`}
              onClick={() => setSelectedIndex(index)}
              type="button"
            >
              {variant.label}
            </button>
          ))}
        </div>
        <section className="min-w-0">
          <h2 className="mb-2 text-sm font-medium text-zinc-600 dark:text-zinc-300">
            {selected.label}
          </h2>
          <iframe
            key={selected.label}
            className="h-[620px] w-full rounded-2xl border border-zinc-300 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
            loading="eager"
            sandbox=""
            srcDoc={renderBuildingPage(selected.model)}
            title={selected.label}
          />
        </section>
      </div>
    </main>
  )
}
