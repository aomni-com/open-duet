'use node'

export interface ResendMessage {
  from: string
  to: string
  subject: string
  html: string
  idempotencyKey: string
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export async function syncResendContact(
  contact: { email: string; firstName?: string; lastName?: string },
  segmentId: string,
  options: { apiKey: string; fetch: FetchLike } = {
    apiKey: requiredResendApiKey(),
    fetch: (input, init) => fetch(input, init),
  },
): Promise<void> {
  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    'content-type': 'application/json',
  }
  const contactUrl = `https://api.resend.com/contacts/${encodeURIComponent(contact.email)}`
  const existing = await options.fetch(contactUrl, { headers })
  if (!existing.ok && existing.status !== 404) {
    throw new Error(`Resend returned ${existing.status}`)
  }
  // Existing contacts keep their names, other segments and unsubscribe choice.
  const response = existing.ok
    ? await options.fetch(`${contactUrl}/segments/${encodeURIComponent(segmentId)}`, {
        method: 'POST',
        headers,
      })
    : await options.fetch('https://api.resend.com/contacts', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          email: contact.email,
          first_name: contact.firstName,
          last_name: contact.lastName,
          segments: [{ id: segmentId }],
        }),
      })
  if (!response.ok) throw new Error(`Resend returned ${response.status}`)
}

export async function sendResendMessage(
  message: ResendMessage,
  options: { apiKey: string; fetch: FetchLike } = {
    apiKey: requiredResendApiKey(),
    fetch: (input, init) => fetch(input, init),
  },
): Promise<{ id?: string }> {
  const response = await options.fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': message.idempotencyKey,
    },
    body: JSON.stringify({
      from: message.from,
      to: [message.to],
      subject: message.subject,
      html: message.html,
    }),
  })
  const payload = (await response.json().catch(() => ({}))) as { id?: string }
  if (!response.ok) throw new Error(`Resend returned ${response.status}`)
  return payload
}

function requiredResendApiKey(): string {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('RESEND_API_KEY is required')
  return apiKey
}
