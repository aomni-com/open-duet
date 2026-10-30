export interface StagingMailboxMessage {
  id: string
  timestamp: number
  to: string[]
  subject: string
  text?: string
  html?: string
}

export interface RunMessageMatch {
  after: number
  recipient: string
  subject: RegExp
  runId: string
}

type AgentMailRequestOptions = NonNullable<Parameters<AgentMailClient['inboxes']['list']>[1]>

const AGENTMAIL_REQUEST_TIMEOUT_MS = 15_000
const AGENTMAIL_RETRY_DELAY_MS = 2_000

class AgentMailRequestTimeoutError extends Error {}

export async function boundedAgentMailRequest<T>(
  deadline: number,
  label: string,
  operation: (options: AgentMailRequestOptions) => PromiseLike<T>,
  requestTimeoutMs = AGENTMAIL_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const requestDeadline = Math.min(deadline, Date.now() + requestTimeoutMs)
  const remainingMs = requestDeadline - Date.now()
  if (remainingMs <= 0) throw new AgentMailRequestTimeoutError(`Timed out waiting for ${label}`)

  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort()
      reject(new AgentMailRequestTimeoutError(`Timed out waiting for ${label}`))
    }, remainingMs)
  })
  try {
    return await Promise.race([
      operation({
        timeoutInSeconds: Math.max(1, Math.ceil(remainingMs / 1_000)),
        maxRetries: 0,
        abortSignal: controller.signal,
      }),
      timedOut,
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

export async function retryTimedOutAgentMailRequest<T>(
  deadline: number,
  label: string,
  operation: (options: AgentMailRequestOptions) => PromiseLike<T>,
  options: { requestTimeoutMs?: number; retryDelayMs?: number } = {},
): Promise<T> {
  for (;;) {
    try {
      return await boundedAgentMailRequest(
        deadline,
        label,
        operation,
        options.requestTimeoutMs ?? AGENTMAIL_REQUEST_TIMEOUT_MS,
      )
    } catch (error) {
      if (!(error instanceof AgentMailRequestTimeoutError) || Date.now() >= deadline) throw error
      await Bun.sleep(
        Math.min(options.retryDelayMs ?? AGENTMAIL_RETRY_DELAY_MS, deadline - Date.now()),
      )
    }
  }
}

export function taggedInboxAddress(address: string, runId: string): string {
  const match = address
    .trim()
    .toLowerCase()
    .match(/^([^@]+)@([^@]+)$/)
  if (match === null) throw new Error('AgentMail inbox address is invalid')
  const [, local, domain] = match
  const separator = local!.includes('+') ? '.' : '+'
  return `${local}${separator}${runId}@${domain}`
}

export async function findRunMessage(
  messages: StagingMailboxMessage[],
  expected: RunMessageMatch,
  loadMessage: (id: string) => Promise<StagingMailboxMessage>,
): Promise<StagingMailboxMessage | undefined> {
  const recipient = expected.recipient.trim().toLowerCase()
  const candidates = [...messages]
    .sort((left, right) => left.timestamp - right.timestamp)
    .filter(message => {
      if (message.timestamp < expected.after) return false
      if (!message.to.some(value => mailboxAddress(value) === recipient)) return false
      expected.subject.lastIndex = 0
      return expected.subject.test(message.subject)
    })

  for (const candidate of candidates) {
    const message = await loadMessage(candidate.id)
    if (
      [message.subject, ...message.to, message.text ?? '', message.html ?? ''].some(value =>
        value.includes(expected.runId),
      )
    ) {
      return message
    }
  }
  return undefined
}

export function extractMessageLink(content: string): string {
  const decoded = decodeHtmlEntities(content)
  const candidates = [
    ...decoded.matchAll(/href\s*=\s*["']([^"']+)["']/gi),
    ...decoded.matchAll(/https:\/\/[^\s<>"']+/gi),
  ].map(match => match[1] ?? match[0])
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate)
      if (url.protocol === 'https:') return url.toString()
    } catch {
      // Keep looking. Provider copy often contains punctuation beside links.
    }
  }
  throw new Error('Message did not contain an HTTPS action link')
}

export async function resolveAgentMailInbox(args: {
  apiKey: string
  address: string
}): Promise<{ id: string; address: string }> {
  const client = new AgentMailClient({ apiKey: args.apiKey })
  const response = await boundedAgentMailRequest(
    Date.now() + AGENTMAIL_REQUEST_TIMEOUT_MS,
    'AgentMail inbox list',
    async options => await client.inboxes.list({ limit: 100 }, options),
  )
  return selectAgentMailInbox(response.inboxes, args.address)
}

export async function resolveAgentMailIdentityInboxes(args: {
  apiKey: string
  firstAddress: string
  secondAddress?: string
  resolve?: typeof resolveAgentMailInbox
}): Promise<{
  first: { id: string; address: string }
  second: { id: string; address: string }
  usesTaggedFallback: boolean
}> {
  const resolve = args.resolve ?? resolveAgentMailInbox
  const first = await resolve({ apiKey: args.apiKey, address: args.firstAddress })
  const secondAddress = args.secondAddress?.trim()
  if (!secondAddress) return { first, second: first, usesTaggedFallback: true }

  try {
    const second = await resolve({ apiKey: args.apiKey, address: secondAddress })
    if (second.id === first.id) {
      throw new Error('Staging identity inboxes must resolve to distinct inboxes')
    }
    return { first, second, usesTaggedFallback: false }
  } catch (error) {
    if (
      error instanceof Error &&
      /configured agentmail staging inbox was not found/i.test(error.message)
    ) {
      return { first, second: first, usesTaggedFallback: true }
    }
    throw error
  }
}

export function selectAgentMailInbox(
  available: ReadonlyArray<{ inboxId: string; displayName: string }>,
  address: string,
): { id: string; address: string } {
  const inboxes = [...available].sort((left, right) => left.inboxId.localeCompare(right.inboxId))
  const requestedAddress = mailboxAddress(address)
  const selected = inboxes.find(inbox => agentMailInboxAddress(inbox) === requestedAddress)
  if (selected === undefined) {
    throw new Error('Configured AgentMail staging inbox was not found')
  }
  if (!requestedAddress.endsWith('@agentmail.to')) {
    throw new Error('AgentMail staging inbox must use agentmail.to')
  }
  return { id: selected.inboxId, address: requestedAddress }
}

export function agentMailInboxAddress(inbox: { inboxId: string; displayName: string }): string {
  const displayAddress = mailboxAddress(inbox.displayName)
  return displayAddress.includes('@') ? displayAddress : mailboxAddress(inbox.inboxId)
}

export async function waitForMailboxLink(args: {
  apiKey: string
  inboxId: string
  expected: RunMessageMatch
  timeoutMs?: number
}): Promise<{ url: string; messageId: string }> {
  const client = new AgentMailClient({ apiKey: args.apiKey })
  const deadline = Date.now() + (args.timeoutMs ?? 120_000)
  for (;;) {
    const response = await retryTimedOutAgentMailRequest(
      deadline,
      'AgentMail message list',
      async options =>
        await client.inboxes.messages.list(
          args.inboxId,
          {
            after: new Date(args.expected.after),
            limit: 50,
          },
          options,
        ),
    )
    const summaries: StagingMailboxMessage[] = response.messages.map(message => ({
      id: message.messageId,
      timestamp: new Date(message.timestamp).getTime(),
      to: message.to,
      subject: message.subject ?? '',
    }))
    const match = await findRunMessage(summaries, args.expected, async id => {
      const message = await retryTimedOutAgentMailRequest(
        deadline,
        'AgentMail message body',
        async options => await client.inboxes.messages.get(args.inboxId, id, options),
      )
      const summary = summaries.find(candidate => candidate.id === id)!
      return {
        ...summary,
        text: message.text ?? undefined,
        html: message.html ?? undefined,
      }
    })
    if (match !== undefined) {
      return {
        url: extractMessageLink(match.text ?? match.html ?? ''),
        messageId: match.id,
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${args.expected.subject.source} email to ${args.expected.recipient}`,
      )
    }
    await Bun.sleep(2_000)
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

type AgentMailMessageRequest = {
  apiKey: string
  inboxId: string
  messageId: string
  fetch?: FetchLike
  timeoutMs?: number
}

export async function deleteAgentMailMessage(args: AgentMailMessageRequest): Promise<void> {
  const response = await (args.fetch ?? globalThis.fetch)(agentMailMessageUrl(args), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${args.apiKey}` },
    signal: AbortSignal.timeout(args.timeoutMs ?? AGENTMAIL_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok && response.status !== 404) {
    throw new Error(`AgentMail message cleanup returned HTTP ${response.status}`)
  }
}

export async function isAgentMailMessageDeleted(args: AgentMailMessageRequest): Promise<boolean> {
  const response = await (args.fetch ?? globalThis.fetch)(agentMailMessageUrl(args), {
    headers: { authorization: `Bearer ${args.apiKey}` },
    signal: AbortSignal.timeout(args.timeoutMs ?? AGENTMAIL_REQUEST_TIMEOUT_MS),
  })
  if (response.status === 404) return true
  if (response.ok) return false
  throw new Error(`AgentMail message cleanup verification returned HTTP ${response.status}`)
}

export async function cleanupAgentMailRunMessages(args: {
  apiKey: string
  inboxId: string
  runId: string
  after: number
}): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    const messageIds = await listAgentMailRunMessageIds(args)
    await Promise.all(
      messageIds.map(
        async messageId =>
          await deleteAgentMailMessage({
            apiKey: args.apiKey,
            inboxId: args.inboxId,
            messageId,
          }),
      ),
    )
    if (pass < 2) await Bun.sleep(1_000)
  }
}

export async function agentMailRunMessagesDeleted(args: {
  apiKey: string
  inboxId: string
  runId: string
  after: number
}): Promise<boolean> {
  return (await listAgentMailRunMessageIds(args)).length === 0
}

async function listAgentMailRunMessageIds(args: {
  apiKey: string
  inboxId: string
  runId: string
  after: number
}): Promise<string[]> {
  const client = new AgentMailClient({ apiKey: args.apiKey })
  const response = await boundedAgentMailRequest(
    Date.now() + AGENTMAIL_REQUEST_TIMEOUT_MS,
    'AgentMail cleanup message list',
    async options =>
      await client.inboxes.messages.list(
        args.inboxId,
        {
          after: new Date(args.after),
          limit: 100,
        },
        options,
      ),
  )
  return response.messages
    .filter(message =>
      [message.subject ?? '', ...message.to].some(value => value.includes(args.runId)),
    )
    .map(message => message.messageId)
}

function agentMailMessageUrl(args: Pick<AgentMailMessageRequest, 'inboxId' | 'messageId'>): string {
  return `https://api.agentmail.to/v0/inboxes/${encodeURIComponent(args.inboxId)}/messages/${encodeURIComponent(args.messageId)}`
}

function mailboxAddress(value: string): string {
  const angleAddress = value.match(/<([^>]+)>/)
  return (angleAddress?.[1] ?? value).trim().toLowerCase()
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}
import { AgentMailClient } from 'agentmail'
