import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import en from '../../messages/en/app.json'
import { UsageSpendChart } from './usage-spend-chart'

const reports = {
  daily: {
    period: 'daily' as const,
    group: 'workspace' as const,
    rows: [
      { workspaceId: 'acme', period: '2026-10-08', spendMicroUsd: 1_250_000 },
      { workspaceId: 'acme', period: '2026-10-09', spendMicroUsd: 12_463_000 },
    ],
  },
}

test('shows the latest selected-period spend in the chart panel and exposes exact point values', () => {
  const html = renderToStaticMarkup(
    createElement(NextIntlClientProvider, {
      timeZone: 'UTC',
      locale: 'en',
      messages: en,
      children: createElement(UsageSpendChart, { reports }),
    }),
  )

  expect(html).toContain('$12.46')
  expect(html).toContain('Last day')
  expect(html).toContain('role="img"')
  expect(html).not.toContain('Reporting period')
})
