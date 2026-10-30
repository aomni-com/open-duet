import { describe, expect, test } from 'bun:test'

import { sendResendMessage } from '../convex/services/resendTransport'

describe('Resend transactional transport', () => {
  test('sends the accepted sender and provider idempotency key without leaking the API key', async () => {
    let request: Request | undefined
    const result = await sendResendMessage(
      {
        from: 'Duet <team@mail.duet.so>',
        to: 'invitee@example.com',
        subject: 'You have been invited to Duet',
        html: '<a href="https://app.duet.so/invite/test-token">Open invitation</a>',
        idempotencyKey: 'workspace-invite:test',
      },
      {
        apiKey: 're_fixture_secret',
        fetch: async (input, init) => {
          request = new Request(input, init)
          return Response.json({ id: 'email_fixture' })
        },
      },
    )

    expect(result).toEqual({ id: 'email_fixture' })
    expect(request?.headers.get('authorization')).toBe('Bearer re_fixture_secret')
    expect(request?.headers.get('idempotency-key')).toBe('workspace-invite:test')
    const body = await request?.json()
    expect(body).toEqual({
      from: 'Duet <team@mail.duet.so>',
      to: ['invitee@example.com'],
      subject: 'You have been invited to Duet',
      html: '<a href="https://app.duet.so/invite/test-token">Open invitation</a>',
    })
    expect(body).not.toHaveProperty('text')
    expect(body).not.toHaveProperty('react')
    expect(JSON.stringify(body)).not.toContain('re_fixture_secret')
  })

  test('surfaces the provider failure without treating it as delivered', async () => {
    await expect(
      sendResendMessage(
        {
          from: 'Duet <team@mail.duet.so>',
          to: 'invitee@example.com',
          subject: 'Invite',
          html: '<p>private fixture body</p>',
          idempotencyKey: 'workspace-invite:failed',
        },
        {
          apiKey: 're_fixture_secret',
          fetch: async () =>
            Response.json(
              {
                message:
                  'Rejected https://app.duet.so/invite/private-token from <p>private fixture body</p>',
              },
              { status: 422 },
            ),
        },
      ),
    ).rejects.toMatchObject({ message: 'Resend returned 422' })
  })
})
