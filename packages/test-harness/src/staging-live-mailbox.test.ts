import { describe, expect, test } from 'bun:test'

import {
  agentMailInboxAddress,
  boundedAgentMailRequest,
  deleteAgentMailMessage,
  extractMessageLink,
  findRunMessage,
  isAgentMailMessageDeleted,
  retryTimedOutAgentMailRequest,
  resolveAgentMailIdentityInboxes,
  selectAgentMailInbox,
  taggedInboxAddress,
  type StagingMailboxMessage,
} from './staging-live-mailbox.ts'

describe('staging mailbox matching', () => {
  test('bounds a provider request even when the provider ignores cancellation', async () => {
    let requestSignal: AbortSignal | undefined

    await expect(
      boundedAgentMailRequest(
        Date.now() + 1_000,
        'AgentMail message list',
        async options => {
          requestSignal = options.abortSignal
          return await new Promise<string>(() => {})
        },
        25,
      ),
    ).rejects.toThrow('Timed out waiting for AgentMail message list')
    expect(requestSignal?.aborted).toBe(true)
  })

  test('retries a timed-out provider request inside the overall mailbox deadline', async () => {
    let attempts = 0

    const result = await retryTimedOutAgentMailRequest(
      Date.now() + 5_000,
      'AgentMail message list',
      async () => {
        attempts += 1
        if (attempts === 1) {
          return await new Promise<string>(() => {})
        }
        return 'ready'
      },
      { requestTimeoutMs: 25, retryDelayMs: 0 },
    )

    expect(result).toBe('ready')
    expect(attempts).toBe(2)
  })

  test('uses the configured address as the inbox selector when the id is deduplicated', () => {
    expect(
      selectAgentMailInbox(
        [
          { inboxId: 'first@agentmail.to', displayName: 'First inbox' },
          { inboxId: 'inbox_qa', displayName: 'Duet QA <qa@agentmail.to>' },
        ],
        'qa@agentmail.to',
      ),
    ).toEqual({ id: 'inbox_qa', address: 'qa@agentmail.to' })
  })

  test('rejects a configured address that does not identify a listed inbox', () => {
    expect(() =>
      selectAgentMailInbox(
        [{ inboxId: 'first@agentmail.to', displayName: 'First inbox' }],
        'missing@agentmail.to',
      ),
    ).toThrow(/configured AgentMail staging inbox was not found/i)
  })

  test('uses the inbox id when AgentMail display names do not contain an address', () => {
    expect(
      agentMailInboxAddress({ inboxId: 'qa@agentmail.to', displayName: 'Duet staging tests' }),
    ).toBe('qa@agentmail.to')
    expect(
      agentMailInboxAddress({
        inboxId: 'ignored@agentmail.to',
        displayName: 'Duet QA <preferred@agentmail.to>',
      }),
    ).toBe('preferred@agentmail.to')
  })

  test('uses a run-tagged recipient without changing the persistent inbox', () => {
    expect(taggedInboxAddress('qa@agentmail.to', 'run_a1b2')).toBe('qa+run_a1b2@agentmail.to')
    expect(taggedInboxAddress('qa+old@agentmail.to', 'run_a1b2')).toBe(
      'qa+old.run_a1b2@agentmail.to',
    )
  })

  test('falls back to tagged identities when the configured second inbox was not provisioned', async () => {
    const resolved = await resolveAgentMailIdentityInboxes({
      apiKey: 'test-key',
      firstAddress: 'first@agentmail.to',
      secondAddress: 'missing@agentmail.to',
      resolve: async ({ address }) => {
        if (address === 'missing@agentmail.to') {
          throw new Error('Configured AgentMail staging inbox was not found')
        }
        return { id: 'first-inbox', address }
      },
    })

    expect(resolved).toEqual({
      first: { id: 'first-inbox', address: 'first@agentmail.to' },
      second: { id: 'first-inbox', address: 'first@agentmail.to' },
      usesTaggedFallback: true,
    })
  })

  test('matches only mail after the run began with recipient, subject, and run id', async () => {
    const matching: StagingMailboxMessage = {
      id: 'message_match',
      timestamp: 1_100,
      to: ['Duet QA <qa+run_a1b2@agentmail.to>'],
      subject: 'Sign in to Duet',
      text: 'Continue securely.',
    }
    const result = await findRunMessage(
      [
        { ...matching, id: 'too_old', timestamp: 999 },
        { ...matching, id: 'wrong_recipient', to: ['qa+other@agentmail.to'] },
        { ...matching, id: 'wrong_subject', subject: 'Unrelated alert' },
        matching,
      ],
      {
        after: 1_000,
        recipient: 'qa+run_a1b2@agentmail.to',
        subject: /sign in to duet/i,
        runId: 'run_a1b2',
      },
      async id => ({ ...matching, id }),
    )

    expect(result?.id).toBe('message_match')
  })

  test('loads message bodies before matching a run marker absent from the summary', async () => {
    const result = await findRunMessage(
      [
        {
          id: 'message_resend',
          timestamp: 1_100,
          to: ['qa+original-run@agentmail.to'],
          subject: 'Sign in to Duet',
        },
      ],
      {
        after: 1_000,
        recipient: 'qa+original-run@agentmail.to',
        subject: /sign in to duet/i,
        runId: 'resend-marker',
      },
      async id => ({
        id,
        timestamp: 1_100,
        to: ['qa+original-run@agentmail.to'],
        subject: 'Sign in to Duet',
        html: '<a href="https://app-staging.duet.so/auth/callback?e2e=resend-marker">Sign in</a>',
      }),
    )

    expect(result?.id).toBe('message_resend')
  })

  test('extracts an HTTPS action URL from encoded HTML and rejects unsafe links', () => {
    expect(
      extractMessageLink(
        '<a href="https://app-staging.duet.so/auth/callback?token=abc&amp;x=1">Continue</a>',
      ),
    ).toBe('https://app-staging.duet.so/auth/callback?token=abc&x=1')
    expect(() => extractMessageLink('<a href="javascript:alert(1)">Continue</a>')).toThrow(
      'HTTPS action link',
    )
  })

  test('extracts the share deep link from the plaintext invitation shape', () => {
    expect(
      extractMessageLink(
        `Alice shared 'field-notes' with you on Duet.\n\nhttps://app-staging.duet.so/share/duet_share_${'a'.repeat(64)}\n`,
      ),
    ).toBe(`https://app-staging.duet.so/share/duet_share_${'a'.repeat(64)}`)
  })

  test('permanently deletes tracked messages through the provider API', async () => {
    const requests: Request[] = []
    await deleteAgentMailMessage({
      apiKey: 'test-key',
      inboxId: 'inbox/id',
      messageId: 'message/id',
      fetch: async (input, init) => {
        requests.push(new Request(input, init))
        return new Response(null, { status: 204 })
      },
    })

    expect(requests[0]?.url).toBe(
      'https://api.agentmail.to/v0/inboxes/inbox%2Fid/messages/message%2Fid',
    )
    expect(requests[0]?.method).toBe('DELETE')
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer test-key')
    expect(
      await isAgentMailMessageDeleted({
        apiKey: 'test-key',
        inboxId: 'inbox/id',
        messageId: 'message/id',
        fetch: async () => new Response(null, { status: 404 }),
      }),
    ).toBe(true)
  })
})
