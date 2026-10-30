import { randomUUID } from 'node:crypto'

import type {
  ConnectedProviderId,
  ConnectedProviderStatus,
  ConnectPollResponse,
  ConnectStartResponse,
} from '@repo/contract'

import { DUET_CLI_BINARY, MANAGED_CLI_ENV } from '../duet-cli'

const MAX_EVENT_LINE_BYTES = 64 * 1024
const MAX_STATUS_BYTES = 256 * 1024
const DEFAULT_POLL_INTERVAL_MS = 1_000
const MAX_CONNECT_LIFETIME_MS = 15 * 60 * 1_000

// Asking the agent CLI for provider status costs a full runtime spawn — over a
// second of CPU. Nothing polls it any more; it is read when a person actually
// looks, so this window is not there to hide staleness but to absorb repeated
// looks — a refresh held down must not spawn a runtime per keypress. Keep it
// short enough that a reader treats the answer as live.
export const CONNECT_STATUS_FRESH_MS = 15 * 1_000

const PROVIDER_ALIASES: Record<ConnectedProviderId, string> = {
  'openai-codex': 'chatgpt',
  'github-copilot': 'copilot',
}

export interface ConnectCommandChild {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
  kill(): void
}

export type ConnectCommandRunner = (argv: readonly string[]) => ConnectCommandChild

export interface ConnectSessionManager {
  start(provider: ConnectedProviderId): Promise<ConnectStartResponse>
  poll(sessionId: string): Promise<ConnectPollResponse>
  disconnect(provider: ConnectedProviderId): Promise<void>
  status(): Promise<ConnectedProviderStatus[]>
}

export class ConnectOperationConflictError extends Error {}
export class ConnectSessionNotFoundError extends Error {}
export class ConnectCommandError extends Error {}

interface Session {
  result: ConnectPollResponse
}

interface ActiveOperation {
  child: ConnectCommandChild
  kind: 'connect' | 'disconnect'
}

type CliEvent =
  | {
      type: 'device_code'
      provider: ConnectedProviderId
      verificationUri: string
      userCode: string
      expiresAt: number
    }
  | { type: 'progress'; provider: ConnectedProviderId; code: string }
  | {
      type: 'complete'
      provider: ConnectedProviderId
      state: 'connected' | 'plan_ineligible' | 'disconnected'
    }
  | { type: 'error'; provider: ConnectedProviderId; code: string }

export function createConnectSessionManager(options: {
  runCommand?: ConnectCommandRunner
  now?: () => number
}): ConnectSessionManager {
  const runCommand = options.runCommand ?? spawnCommand
  const now = options.now ?? Date.now
  const sessions = new Map<string, Session>()
  const active = new Map<ConnectedProviderId, ActiveOperation>()
  let observed: { at: number; value: ConnectedProviderStatus[] } | null = null
  let probe: Promise<ConnectedProviderStatus[]> | null = null
  // Bumped by every local change. A probe reads the store as it was when it
  // started, so it may only publish its answer if nothing changed underneath
  // it — otherwise a connect or disconnect racing an in-flight probe would be
  // overwritten by the state it replaced, and stay that way for the whole
  // freshness window.
  let observedGeneration = 0

  function expireObservation(): void {
    observed = null
    observedGeneration += 1
  }

  return { start, poll, disconnect, status }

  async function start(provider: ConnectedProviderId): Promise<ConnectStartResponse> {
    if (active.has(provider))
      throw new ConnectOperationConflictError('provider operation in progress')

    const sessionId = `connect_${randomUUID()}`
    const session: Session = { result: { status: 'pending' } }
    const child = invokeCommand(runCommand, [
      DUET_CLI_BINARY,
      'connect',
      PROVIDER_ALIASES[provider],
      '--device-code',
      '--json',
    ])
    sessions.set(sessionId, session)
    const operation: ActiveOperation = { child, kind: 'connect' }
    active.set(provider, operation)

    let timeout = connectTimeout(child, MAX_CONNECT_LIFETIME_MS)
    void consumeConnect(child, provider, event => {
      if (event.type === 'device_code') {
        clearTimeout(timeout)
        timeout = connectTimeout(
          child,
          Math.min(MAX_CONNECT_LIFETIME_MS, Math.max(0, event.expiresAt - now())),
        )
        session.result = {
          status: 'awaiting_code',
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          expiresAt: event.expiresAt,
        }
        return
      }
      if (event.type === 'complete') {
        expireObservation()
        if (event.state === 'connected') {
          const connectedAt = now()
          session.result = {
            status: 'connected',
            connection: {
              provider,
              state: 'connected',
              connectedAt,
              eligibilityCheckedAt: connectedAt,
            },
          }
        } else if (event.state === 'plan_ineligible') {
          session.result = { status: 'failed', reason: 'plan_ineligible', provider }
        } else {
          session.result = { status: 'failed', reason: 'error' }
        }
        return
      }
      if (event.type === 'error') session.result = failureForCode(event.code)
    })
      .then(exitCode => {
        if (
          session.result.status === 'pending' ||
          session.result.status === 'awaiting_code' ||
          (exitCode !== 0 && session.result.status === 'connected')
        ) {
          session.result = { status: 'failed', reason: 'error' }
        }
      })
      .catch(() => {
        session.result = { status: 'failed', reason: 'error' }
      })
      .finally(() => {
        clearTimeout(timeout)
        if (active.get(provider) === operation) active.delete(provider)
      })

    return { sessionId, intervalMs: DEFAULT_POLL_INTERVAL_MS }
  }

  async function poll(sessionId: string): Promise<ConnectPollResponse> {
    const session = sessions.get(sessionId)
    if (session === undefined) throw new ConnectSessionNotFoundError('connect session not found')
    // A terminal result has been delivered once the caller polls it; drop the
    // session so the map stays bounded across the gateway's lifetime.
    if (session.result.status === 'connected' || session.result.status === 'failed') {
      sessions.delete(sessionId)
    }
    return session.result
  }

  async function disconnect(provider: ConnectedProviderId): Promise<void> {
    const current = active.get(provider)
    if (current?.kind === 'disconnect') {
      throw new ConnectOperationConflictError('provider operation in progress')
    }
    if (current !== undefined) {
      current.child.kill()
      await current.child.exited.catch(() => undefined)
    }

    const child = invokeCommand(runCommand, [
      DUET_CLI_BINARY,
      'connect',
      '--disconnect',
      PROVIDER_ALIASES[provider],
      '--json',
    ])
    const operation: ActiveOperation = { child, kind: 'disconnect' }
    active.set(provider, operation)
    let disconnected = false
    try {
      const exitCode = await consumeConnect(child, provider, event => {
        if (event.type === 'complete' && event.state === 'disconnected') disconnected = true
      })
      if (exitCode !== 0 || !disconnected)
        throw new ConnectCommandError('disconnect command failed')
    } catch (error) {
      if (error instanceof ConnectCommandError) throw error
      throw new ConnectCommandError('disconnect command failed')
    } finally {
      // A disconnect that failed part-way can still have changed credentials,
      // so the observation expires on the attempt, not on the happy path.
      expireObservation()
      if (active.get(provider) === operation) active.delete(provider)
    }
  }

  async function status(): Promise<ConnectedProviderStatus[]> {
    if (observed !== null && now() - observed.at < CONNECT_STATUS_FRESH_MS) return observed.value
    // One probe serves every concurrent caller: the sync rail and a product
    // request landing together must not each spawn a CLI.
    probe ??= probeStatus().finally(() => {
      probe = null
    })
    return probe
  }

  async function probeStatus(): Promise<ConnectedProviderStatus[]> {
    const generation = observedGeneration
    const child = invokeCommand(runCommand, [DUET_CLI_BINARY, 'connect', '--status', '--json'])
    try {
      const [output, exitCode] = await Promise.all([
        readBounded(child.stdout, MAX_STATUS_BYTES),
        child.exited,
        drain(child.stderr),
      ])
      if (exitCode !== 0) throw new Error('nonzero exit')
      const parsed = JSON.parse(output) as unknown
      if (!isRecord(parsed) || !Array.isArray(parsed.connections)) throw new Error('bad envelope')
      const connections = parsed.connections.map(connection => statusFromCli(connection))
      if (connections.some(connection => connection === null)) throw new Error('bad connection')
      const value = connections as ConnectedProviderStatus[]
      if (generation === observedGeneration) observed = { at: now(), value }
      return value
    } catch {
      child.kill()
      await child.exited.catch(() => undefined)
      throw new ConnectCommandError('connected-provider status output was invalid')
    }
  }
}

function connectTimeout(
  child: ConnectCommandChild,
  delayMs: number,
): ReturnType<typeof setTimeout> {
  const timeout = setTimeout(() => child.kill(), delayMs)
  timeout.unref?.()
  return timeout
}

function invokeCommand(
  runCommand: ConnectCommandRunner,
  argv: readonly string[],
): ConnectCommandChild {
  try {
    return runCommand(argv)
  } catch {
    throw new ConnectCommandError('connected-provider command failed')
  }
}

async function consumeConnect(
  child: ConnectCommandChild,
  provider: ConnectedProviderId,
  onEvent: (event: CliEvent) => void,
): Promise<number> {
  const stdout = consumeLines(child.stdout, line => {
    const event = parseCliEvent(line)
    if (event?.provider === provider) onEvent(event)
  })
  await Promise.all([stdout, drain(child.stderr)])
  return child.exited
}

async function consumeLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let discarding = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      while (true) {
        const newline = buffer.indexOf('\n')
        if (newline === -1) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!discarding && new TextEncoder().encode(line).byteLength <= MAX_EVENT_LINE_BYTES) {
          onLine(line)
        }
        discarding = false
      }
      if (new TextEncoder().encode(buffer).byteLength > MAX_EVENT_LINE_BYTES) {
        buffer = ''
        discarding = true
      }
    }
    buffer += decoder.decode()
    if (
      !discarding &&
      buffer.length > 0 &&
      new TextEncoder().encode(buffer).byteLength <= MAX_EVENT_LINE_BYTES
    ) {
      onLine(buffer)
    }
  } finally {
    reader.releaseLock()
  }
}

function parseCliEvent(line: string): CliEvent | null {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(value) || !isProvider(value.provider) || typeof value.type !== 'string') return null
  if (
    value.type === 'device_code' &&
    typeof value.verificationUri === 'string' &&
    typeof value.userCode === 'string' &&
    typeof value.expiresAt === 'number'
  ) {
    return value as CliEvent
  }
  if ((value.type === 'progress' || value.type === 'error') && typeof value.code === 'string') {
    return value as CliEvent
  }
  if (
    value.type === 'complete' &&
    (value.state === 'connected' ||
      value.state === 'plan_ineligible' ||
      value.state === 'disconnected')
  ) {
    return value as CliEvent
  }
  return null
}

function failureForCode(code: string): ConnectPollResponse {
  if (code === 'login_denied') return { status: 'failed', reason: 'denied' }
  if (code === 'login_expired') return { status: 'failed', reason: 'expired' }
  return { status: 'failed', reason: 'error' }
}

function statusFromCli(value: unknown): ConnectedProviderStatus | null {
  if (
    !isRecord(value) ||
    !isProvider(value.provider) ||
    typeof value.connectedAt !== 'number' ||
    (value.eligibility !== 'eligible' &&
      value.eligibility !== 'unknown' &&
      value.eligibility !== 'plan_ineligible') ||
    (value.eligibilityCheckedAt !== undefined && typeof value.eligibilityCheckedAt !== 'number')
  ) {
    return null
  }
  return {
    provider: value.provider,
    state: value.eligibility === 'plan_ineligible' ? 'plan_ineligible' : 'connected',
    connectedAt: value.connectedAt,
    ...(value.eligibilityCheckedAt === undefined
      ? {}
      : { eligibilityCheckedAt: value.eligibilityCheckedAt }),
  }
}

async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let output = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return output + decoder.decode()
      bytes += value.byteLength
      if (bytes > limit) throw new ConnectCommandError('connected-provider output was too large')
      output += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader()
  try {
    while (!(await reader.read()).done) {
      // Stderr is intentionally discarded: OAuth command output is untrusted
      // and must never cross into gateway logs or HTTP reports.
    }
  } finally {
    reader.releaseLock()
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isProvider(value: unknown): value is ConnectedProviderId {
  return value === 'openai-codex' || value === 'github-copilot'
}

function spawnCommand(argv: readonly string[]): ConnectCommandChild {
  const child = Bun.spawn([...argv], {
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...MANAGED_CLI_ENV },
  })
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: child.exited,
    kill: () => child.kill(),
  }
}
