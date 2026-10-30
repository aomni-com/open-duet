import { expect, test } from 'bun:test'

import { renderToStaticMarkup } from 'react-dom/server'

import { ConsentPanel } from './consent-panel'

test('names the only grantable workspace without rendering a picker', () => {
  const html = renderToStaticMarkup(
    <ConsentPanel
      capabilities={['files:read', 'sessions']}
      workspaces={[{ slug: 'personal', name: 'Personal', role: 'owner' }]}
      selectedSlug="personal"
      onSelect={() => {}}
      emptyExplanation="No workspace can grant this access."
      approveLabel="Approve for Personal"
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  )

  expect(html).toContain('This device will act as you in your workspace:')
  expect(html).toMatch(/<strong[^>]*>Personal<\/strong>/)
  expect(html).toContain('your only workspace')
  expect(html).toContain('Approve for Personal')
  expect(html).not.toContain('radiogroup')
})

test('renders workspace selection as a controlled picker', () => {
  const render = (selectedSlug?: string) =>
    renderToStaticMarkup(
      <ConsentPanel
        capabilities={['files:read', 'files:write']}
        workspaces={[
          { slug: 'acme', name: 'Acme Inc', role: 'owner' },
          { slug: 'personal', name: 'Personal', role: 'editor' },
        ]}
        selectedSlug={selectedSlug}
        onSelect={() => {}}
        emptyExplanation="No workspace can grant this access."
        approveLabel={selectedSlug === 'personal' ? 'Approve for Personal' : 'Approve for Acme Inc'}
        onApprove={() => {}}
        onDeny={() => {}}
      />,
    )

  expect(render('acme')).toMatch(/checked="" value="acme"/)
  expect(render('personal')).toMatch(/checked="" value="personal"/)
  expect(render('personal')).toContain('Approve for Personal')
})

test('explains an empty grantable set and offers Deny only', () => {
  const html = renderToStaticMarkup(
    <ConsentPanel
      capabilities={['services']}
      workspaces={[]}
      onSelect={() => {}}
      emptyExplanation="Ask a workspace owner to upgrade your role, then try again."
      approveLabel="Approve"
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  )

  expect(html).toContain('You can&#x27;t approve this device')
  expect(html).toContain('Ask a workspace owner to upgrade your role, then try again.')
  expect(html).toContain('Deny')
  expect(html).not.toContain('Approve</button>')
  expect(html).not.toContain('services')
})

test('renders untrusted OAuth client identity as escaped text with localhost risk visible', () => {
  const html = renderToStaticMarkup(
    <ConsentPanel
      client={{
        name: '<img src=x onerror="alert(1)">',
        redirectHost: 'localhost',
        redirectIsLocalhost: true,
      }}
      capabilities={['files:read']}
      workspaces={[{ slug: 'personal', name: 'Personal', role: 'owner' }]}
      selectedSlug="personal"
      onSelect={() => {}}
      emptyExplanation="No workspace can grant this access."
      approveLabel="Approve for Personal"
      onApprove={() => {}}
      onDeny={() => {}}
    />,
  )

  expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
  expect(html).not.toContain('<img')
  expect(html).toContain('localhost')
  expect(html).toContain('impersonate')
  expect(html).toContain('This client will act as you')
  expect(html).not.toContain('This device will act as you')
})
