import { describe, expect, test } from 'bun:test'

import { toPlainText } from 'react-email'

import { TRANSACTIONAL_EMAIL_FIXTURES } from './fixtures'
import { prepareTransactionalEmail } from './index'
import { renderPreparedTransactionalEmail } from './render'

describe('transactional email family', () => {
  test('renders the magic-link message as a complete actionable email', async () => {
    const prepared = prepareTransactionalEmail({
      kind: 'auth_magic_link',
      actionUrl: 'https://app.duet.so/auth/verify?token=magic-token',
    })

    expect(prepared.subject).toBe('Sign in to Duet')
    expect(prepared.preview).toBe('Use your secure link to return to Duet.')

    const html = await renderPreparedTransactionalEmail(prepared)
    const text = toPlainText(html)
    expect(html).toContain('<!DOCTYPE html')
    expect(text).toContain('Sign in to Duet')
    // The link is time-boxed and the email says so. Deliberately not pinned to a
    // duration: the TTL is owned by @repo/contract, which this package does not
    // import, so an exact string here is a second copy of that number waiting to
    // go stale — which is precisely what it did.
    expect(text).toContain('expires')
    expect(html).toContain('https://app.duet.so/auth/verify?token=magic-token')
  })

  test('carries the code and names who asked, when an agent started the sign-in', async () => {
    const prepared = prepareTransactionalEmail({
      kind: 'auth_magic_link',
      actionUrl: 'https://app.duet.so/sign-in?code=RNP4-4Y37',
      code: 'RNP4-4Y37',
      clientName: 'Claude Code',
      expiresInMinutes: 10,
    })
    const text = toPlainText(await renderPreparedTransactionalEmail(prepared))

    expect(text).toContain('RNP4-4Y37')
    expect(text).toContain('Claude Code')
    // This email is the only place a human on the agent rail is told what the
    // code hands over — there is no approval screen on this path — so the scope
    // sentence is a contract, not decoration.
    expect(text).toContain('except administer your account')
    // No button, deliberately. The link and the code redeem the same single-use
    // token, so offering both would give the reader two paths that destroy each
    // other: clicking first leaves the agent's verify to fail against a consumed
    // code, and verifying first leaves the button dead.
    expect(text).not.toContain('https://app.duet.so/sign-in?code=RNP4-4Y37')
    // An unprimed review found these three missing, and each is the kind of
    // omission that only matters to the reader who is already worried.
    expect(text).toContain('expires in 10 minutes')
    expect(text).toContain('Do not share it with anyone else')
    expect(text).toContain('someone else may be trying to reach your account')
    const html = await renderPreparedTransactionalEmail(prepared)
    expect(html.match(/<a\b/g) ?? []).toHaveLength(0)
  })

  test('names no client when the request did not say who asked', async () => {
    const prepared = prepareTransactionalEmail({
      kind: 'auth_magic_link',
      actionUrl: 'https://app.duet.so/sign-in?code=RNP4-4Y37',
      code: 'RNP4-4Y37',
    })
    const text = toPlainText(await renderPreparedTransactionalEmail(prepared))

    expect(text).toContain('RNP4-4Y37')
    expect(text).toContain('A client asked to sign in as you')
  })

  test('shows a browser sign-in no code at all', async () => {
    // A human who never asked an agent for anything should not be shown a
    // typeable code — that teaches them to type codes at whatever asks.
    const prepared = prepareTransactionalEmail({
      kind: 'auth_magic_link',
      actionUrl: 'https://app.duet.so/auth/magic-link/callback?code=abc',
    })
    const text = toPlainText(await renderPreparedTransactionalEmail(prepared))

    expect(text).not.toContain('sign-in code')
    expect(text).not.toContain('except administer your account')
    expect(text).not.toContain('Do not share it with anyone else')
    expect(text).toContain('expires')
  })

  test('renders the workspace role and invitation action', async () => {
    const prepared = prepareTransactionalEmail({
      kind: 'workspace_invite',
      actionUrl: 'https://app.duet.so/invite/workspace-token',
      role: 'editor',
    })

    expect(prepared.subject).toBe("You're invited to a Duet workspace")
    expect(prepared.preview).toBe('Join your team and start collaborating in Duet.')

    const html = await renderPreparedTransactionalEmail(prepared)
    const text = toPlainText(html)
    expect(text).toContain('as an editor')
    expect(text).toContain('Accept invitation')
    expect(html).toContain('https://app.duet.so/invite/workspace-token')
  })

  test('leads a shared-folder invitation with the sharer and folder names', async () => {
    const prepared = prepareTransactionalEmail({
      kind: 'share_invite',
      actionUrl: 'https://app.duet.so/share/folder-token',
      sharerName: 'Mina Park',
      folderName: 'Launch plans',
    })

    expect(prepared.subject).toBe('Mina Park shared “Launch plans” with you')
    expect(prepared.preview).toBe('Open the folder and start working together.')

    const html = await renderPreparedTransactionalEmail(prepared)
    const text = toPlainText(html)
    expect(text).toContain('Mina Park shared the “Launch plans” folder with you')
    expect(text).toContain('Open shared folder')
    expect(html).toContain('https://app.duet.so/share/folder-token')
  })

  test('renders training context and uses the available recipient name', async () => {
    const prepared = prepareTransactionalEmail({
      kind: 'train_complete',
      actionUrl: 'https://app.duet.so/w/acme/train',
      jobId: 'job_2026_07_18',
      recipientName: 'Alex',
    })

    expect(prepared.subject).toBe('Your Duet training is ready')
    expect(prepared.preview).toBe('Your latest training job has finished.')

    const html = await renderPreparedTransactionalEmail(prepared)
    const text = toPlainText(html)
    expect(text).toContain('Hey Alex')
    expect(text).toContain('job_2026_07_18')
    expect(text).toContain('Review training')
    expect(html).toContain('https://app.duet.so/w/acme/train')
  })

  test('keeps every message transactional and limited to one action', async () => {
    for (const input of TRANSACTIONAL_EMAIL_FIXTURES) {
      const html = await renderPreparedTransactionalEmail(prepareTransactionalEmail(input))
      // At most one, not exactly one. The guard exists to stop a second
      // competing action appearing beside the first; zero is the strongest form
      // of that, and the sign-in email's code variant deliberately has none —
      // its button and its code redeem the same single-use token.
      expect((html.match(/<a\b/g) ?? []).length, input.kind).toBeLessThanOrEqual(1)
      expect(html.toLowerCase(), input.kind).not.toContain('unsubscribe')
      expect(html, input.kind).not.toMatch(/<(?:img|script|font)\b/i)
    }
  })

  test('renders personalized text without interpreting embedded markup', async () => {
    const html = await renderPreparedTransactionalEmail(
      prepareTransactionalEmail({
        kind: 'share_invite',
        actionUrl: 'https://app.duet.so/share/safe-token',
        sharerName: '<script>alert("name")</script>',
        folderName: '<img src=x onerror=alert("folder")>',
      }),
    )

    expect(html).not.toContain('<script>alert')
    expect(html).not.toContain('<img src=x')
    const text = toPlainText(html)
    expect(text).toContain('<script>alert("name")</script>')
    expect(text).toContain('<img src=x onerror=alert("folder")>')
  })
})
