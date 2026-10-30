import { expect, test } from 'bun:test'

import { NextIntlClientProvider } from 'next-intl'
import { renderToStaticMarkup } from 'react-dom/server'

import type { SessionAudience, SessionAudienceMemberPreview } from '@repo/contract'

import appEn from '../../messages/en/app.json'
import { SessionAudiencePreview } from './session-audience-manager'

const preview = [
  { memberId: 'm1', userId: 'u1', name: 'Ada', email: 'ada@example.com', role: 'viewer' as const },
  {
    memberId: 'm2',
    userId: 'u2',
    name: 'Grace',
    email: 'grace@example.com',
    role: 'owner' as const,
  },
]

function render(
  audience: SessionAudience,
  workspaceMembers?: readonly SessionAudienceMemberPreview[] | null,
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={appEn} onError={() => {}}>
      <SessionAudiencePreview audience={audience} workspaceMembers={workspaceMembers} />
    </NextIntlClientProvider>,
  )
}

test('the closed header renders only the server specific-audience preview and count', () => {
  const html = render({ kind: 'specific', count: 6, preview })

  expect(html).toContain('Ada')
  expect(html).toContain('Grace')
  expect(html).toContain('6 people')
  expect(html).not.toContain('owner')
  expect(html).not.toContain('Private')
  expect(html).not.toContain('data-identity-avatar="agent"')
})

test('workspace conversations show the human roster in the closed header', () => {
  const html = render({ kind: 'workspace' }, preview)

  expect(html).toContain('data-session-audience-preview')
  expect(html).toContain('title="Ada"')
  expect(html).toContain('title="Grace"')
  expect(html).toContain('2 people')
  expect(html.match(/data-identity-avatar="user"/g)).toHaveLength(2)
  expect(html).not.toContain('data-identity-avatar="agent"')
})

test('a ten-person workspace keeps the closed header bounded at every breakpoint', () => {
  const workspaceMembers = Array.from({ length: 10 }, (_, index) => ({
    memberId: `m${index}`,
    userId: `u${index}`,
    name: `Person ${index}`,
    email: `person-${index}@example.com`,
    role: 'viewer' as const,
  }))
  const html = render({ kind: 'workspace' }, workspaceMembers)

  expect(html).toContain('10 people')
  expect(html).toContain('+8')
  expect(html.match(/data-identity-avatar="user"/g)).toHaveLength(5)
  expect(html).not.toContain('Person 5')
})

test('a failed workspace roster stays actionable without claiming the conversation is empty', () => {
  const html = render({ kind: 'workspace' }, null)

  expect(html).toContain('data-audience-preview-state="unavailable"')
  expect(html).not.toContain('0 people')
  expect(html).not.toContain('animate-pulse')
})
