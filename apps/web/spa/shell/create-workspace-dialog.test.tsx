import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import type { ComponentProps, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'

import en from '../../messages/en/app.json'
import es from '../../messages/es-419/app.json'
import { DuetApiClient } from '../api/client'
import { CreateDriveRefusal, refusalOf, type DriveRefusal } from './create-workspace-dialog'

/** The refusal as the API actually serves it, read back through the real client. */
async function refusalFromApi(status: number, body: unknown): Promise<DriveRefusal> {
  const client = new DuetApiClient(
    async () => new Response(JSON.stringify(body), { status, headers: jsonHeaders }),
  )
  try {
    await client.createWorkspace({ name: 'Second Drive', slug: 'second-drive' })
  } catch (error) {
    return refusalOf(error)
  }
  throw new Error('createWorkspace resolved on a refusal')
}

test('a plan limit refusal preserves the server-supplied plan and limit', async () => {
  expect(
    await refusalFromApi(402, {
      error: 'workspace_limit_reached',
      plan: 'pro',
      limit: 3,
    }),
  ).toEqual({ error: 'workspace_limit_reached', plan: 'pro', limit: 3 })
})

test('every other failure stays the unexplained one, so an outage never reads as a bill', async () => {
  expect(await refusalFromApi(500, { error: 'internal_error' })).toBe('unknown')
  expect(await refusalFromApi(409, { error: 'slug_taken' })).toBe('unknown')
  expect(refusalOf(new Error('offline'))).toBe('unknown')
  expect(await refusalFromApi(402, { error: 'subscription_required' })).toBe('unknown')
})

test('the plan limit refusal names its plan, server-supplied limit, and upgrade path', () => {
  for (const [locale, messages] of [
    ['en', en],
    ['es-419', es],
  ] as const) {
    const html = render(
      <CreateDriveRefusal refusal={{ error: 'workspace_limit_reached', plan: 'pro', limit: 3 }} />,
      locale,
      messages,
    )

    const visibleText = html.replace(/<[^>]*>/g, '')
    expect(visibleText).toContain(
      locale === 'en'
        ? 'Pro workspace limit reached'
        : 'Alcanzaste el límite de espacios de trabajo de Pro',
    )
    expect(visibleText).toContain(messages.duetApp.workspaceLimitBody.replace('{limit}', '3'))
    expect(visibleText).toContain(messages.duetApp.workspaceLimitAction)
    expect(html).toContain('href="/settings/billing"')
    expect(html).not.toContain(escapeCopy(messages.duetApp.createWorkspaceError))
  }
})

test('an unexplained failure keeps the plain sentence and offers no billing errand', () => {
  const html = render(<CreateDriveRefusal refusal="unknown" />, 'en', en)

  expect(html).toContain(escapeCopy(en.duetApp.createWorkspaceError))
  expect(html).not.toContain('href="/settings/billing"')
})

const jsonHeaders = { 'content-type': 'application/json' }

function render(
  node: ReactNode,
  locale: string,
  messages: ComponentProps<typeof NextIntlClientProvider>['messages'],
): string {
  // Both ways out of a refusal are react-router links: the SPA owns these paths,
  // and a next/link would push a URL react-router never hears.
  return renderToStaticMarkup(
    <MemoryRouter>
      <NextIntlClientProvider
        locale={locale}
        messages={messages}
        timeZone="UTC"
        now={new Date(Date.UTC(2026, 7, 5))}
      >
        {node}
      </NextIntlClientProvider>
    </MemoryRouter>,
  )
}

function escapeCopy(copy: string): string {
  return copy.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
