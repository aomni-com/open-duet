import { randomUUID } from 'node:crypto'

import { DESKTOP_BROWSER_EXTENSION_ID } from '@repo/contract'

export type BrowserExtensionCommand =
  | { command: 'snapshot' }
  | { command: 'createWindow'; url: string }
  | { command: 'createTab'; windowId: number; url: string; active: boolean }
  | { command: 'activateTab'; tabId: number }
  | { command: 'moveTab'; tabId: number; windowId: number }
  | { command: 'focusWindow'; windowId: number; tabId?: number }
  | { command: 'closeWindow'; windowId: number }
  | { command: 'closeTab'; tabId: number }
  | { command: 'discardTab'; tabId: number }

export type BrowserExtensionEvent =
  | { type: 'event'; event: 'focusTransient'; windowId: -1; at: number }
  | { type: 'event'; event: 'focusSettled'; windowId: number; at: number }
  | { type: 'event'; event: 'windowRemoved'; windowId: number; at: number }
  | { type: 'event'; event: 'tabCreated'; tabId: number; windowId: number; at: number }
  | { type: 'event'; event: 'tabActivated'; tabId: number; windowId: number; at: number }
  | { type: 'event'; event: 'tabRemoved'; tabId: number; windowId: number; at: number }
  | {
      type: 'event'
      event: 'tabReplaced'
      addedTabId: number
      removedTabId: number
      at: number
    }

type BrowserExtensionMessage =
  | { type: 'hello'; extensionId: string; workerStartedAt: number }
  | { type: 'keepalive'; at: number }
  | { type: 'response'; requestId: string; result: unknown; error?: never }
  | { type: 'response'; requestId: string; error: string; result?: never }
  | BrowserExtensionEvent

export interface BrowserExtensionSocket {
  send(message: string): void
  close(code: number, reason: string): void
}

export interface BrowserExtensionSocketData {
  kind: 'browser-extension'
  bridge: BrowserExtensionBridge
}

export interface BrowserExtensionConnection {
  workerStartedAt: number
}

interface PendingRequest {
  command: BrowserExtensionCommand
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: unknown
}

interface BrowserExtensionBridgeOptions {
  timeoutMs?: number
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
}

const numberField = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

const stringField = (value: unknown): value is string => typeof value === 'string'

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function objectField(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function validTabSnapshot(value: unknown): boolean {
  const tab = objectField(value)
  if (tab === null) return false
  const required = ['tabId', 'windowId', 'active', 'discarded']
  const optional = ['url', 'title', 'targetId']
  const keys = Object.keys(tab)
  return (
    required.every(key => keys.includes(key)) &&
    keys.every(key => required.includes(key) || optional.includes(key)) &&
    numberField(tab.tabId) &&
    numberField(tab.windowId) &&
    typeof tab.active === 'boolean' &&
    typeof tab.discarded === 'boolean' &&
    (tab.url === undefined || stringField(tab.url)) &&
    (tab.title === undefined || stringField(tab.title)) &&
    (tab.targetId === undefined || stringField(tab.targetId))
  )
}

function validWindowSnapshot(value: unknown): boolean {
  const window = objectField(value)
  return (
    window !== null &&
    hasExactKeys(window, ['windowId', 'focused', 'state', 'tabs']) &&
    numberField(window.windowId) &&
    typeof window.focused === 'boolean' &&
    stringField(window.state) &&
    Array.isArray(window.tabs) &&
    window.tabs.every(validTabSnapshot)
  )
}

function parseBrowserExtensionResult(command: BrowserExtensionCommand, value: unknown): unknown {
  const result = objectField(value)
  if (result === null) throw new Error('invalid browser extension response')

  if (
    command.command === 'snapshot' &&
    hasExactKeys(result, ['windows']) &&
    Array.isArray(result.windows) &&
    result.windows.every(validWindowSnapshot)
  ) {
    return value
  }
  if (
    (command.command === 'createWindow' ||
      command.command === 'createTab' ||
      command.command === 'activateTab' ||
      command.command === 'moveTab') &&
    hasExactKeys(result, ['windowId', 'tabId', 'targetId']) &&
    numberField(result.windowId) &&
    numberField(result.tabId) &&
    stringField(result.targetId)
  ) {
    return value
  }
  if (
    (command.command === 'focusWindow' || command.command === 'closeWindow') &&
    hasExactKeys(result, ['windowId']) &&
    numberField(result.windowId)
  ) {
    return value
  }
  if (
    command.command === 'closeTab' &&
    hasExactKeys(result, ['tabId']) &&
    numberField(result.tabId)
  ) {
    return value
  }
  if (
    command.command === 'discardTab' &&
    hasExactKeys(result, [
      'removedTabId',
      'replacementTabId',
      'windowId',
      'targetId',
      'discarded',
    ]) &&
    numberField(result.removedTabId) &&
    numberField(result.replacementTabId) &&
    numberField(result.windowId) &&
    stringField(result.targetId) &&
    result.discarded === true
  ) {
    return value
  }
  throw new Error('invalid browser extension response')
}

export function parseBrowserExtensionMessage(raw: string | Buffer): BrowserExtensionMessage {
  let value: unknown
  try {
    value = JSON.parse(String(raw))
  } catch {
    throw new Error('invalid browser extension message')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid browser extension message')
  }
  const message = value as Record<string, unknown>

  if (
    message.type === 'hello' &&
    hasExactKeys(message, ['type', 'extensionId', 'workerStartedAt']) &&
    typeof message.extensionId === 'string' &&
    numberField(message.workerStartedAt)
  ) {
    return message as BrowserExtensionMessage
  }
  if (
    message.type === 'keepalive' &&
    hasExactKeys(message, ['type', 'at']) &&
    numberField(message.at)
  ) {
    return message as BrowserExtensionMessage
  }
  if (
    message.type === 'response' &&
    typeof message.requestId === 'string' &&
    message.requestId.length > 0
  ) {
    if (hasExactKeys(message, ['type', 'requestId', 'result']))
      return message as BrowserExtensionMessage
    if (
      hasExactKeys(message, ['type', 'requestId', 'error']) &&
      typeof message.error === 'string'
    ) {
      return message as BrowserExtensionMessage
    }
  }
  if (message.type === 'event' && typeof message.event === 'string' && numberField(message.at)) {
    const windowEvent =
      message.event === 'focusTransient' ||
      message.event === 'focusSettled' ||
      message.event === 'windowRemoved'
    if (
      windowEvent &&
      hasExactKeys(message, ['type', 'event', 'windowId', 'at']) &&
      numberField(message.windowId) &&
      (message.event !== 'focusTransient' || message.windowId === -1)
    ) {
      return message as BrowserExtensionMessage
    }
    const tabEvent =
      message.event === 'tabCreated' ||
      message.event === 'tabActivated' ||
      message.event === 'tabRemoved'
    if (
      tabEvent &&
      hasExactKeys(message, ['type', 'event', 'tabId', 'windowId', 'at']) &&
      numberField(message.tabId) &&
      numberField(message.windowId)
    ) {
      return message as BrowserExtensionMessage
    }
    if (
      message.event === 'tabReplaced' &&
      hasExactKeys(message, ['type', 'event', 'addedTabId', 'removedTabId', 'at']) &&
      numberField(message.addedTabId) &&
      numberField(message.removedTabId)
    ) {
      return message as BrowserExtensionMessage
    }
  }

  throw new Error('invalid browser extension message')
}

export class BrowserExtensionBridge {
  private readonly timeoutMs: number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(event: BrowserExtensionEvent) => void>()
  private readonly connectionListeners = new Set<(connection: BrowserExtensionConnection) => void>()
  private activeSocket: BrowserExtensionSocket | undefined

  constructor(options: BrowserExtensionBridgeOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer =
      options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>))
  }

  open(_socket: BrowserExtensionSocket): void {}

  message(socket: BrowserExtensionSocket, raw: string | Buffer): void {
    let message: BrowserExtensionMessage
    try {
      message = parseBrowserExtensionMessage(raw)
    } catch {
      socket.close(1003, 'invalid browser extension message')
      return
    }

    if (message.type === 'hello') {
      if (message.extensionId !== DESKTOP_BROWSER_EXTENSION_ID) {
        socket.close(1008, 'unexpected extension identity')
        return
      }
      if (this.activeSocket !== undefined && this.activeSocket !== socket) {
        this.activeSocket.close(1012, 'new extension worker connected')
        this.rejectPending('browser extension reconnected')
      }
      this.activeSocket = socket
      for (const listener of this.connectionListeners) {
        listener({ workerStartedAt: message.workerStartedAt })
      }
      return
    }
    if (socket !== this.activeSocket) {
      socket.close(1008, 'browser extension hello required')
      return
    }
    if (message.type === 'keepalive') return
    if (message.type === 'event') {
      for (const listener of this.listeners) listener(message)
      return
    }

    const pending = this.pending.get(message.requestId)
    if (pending === undefined) return
    this.pending.delete(message.requestId)
    this.clearTimer(pending.timer)
    if (message.error !== undefined) {
      pending.reject(new Error(message.error))
      return
    }
    try {
      pending.resolve(parseBrowserExtensionResult(pending.command, message.result))
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }

  close(socket: BrowserExtensionSocket): void {
    if (socket !== this.activeSocket) return
    this.activeSocket = undefined
    this.rejectPending('browser extension disconnected')
  }

  connected(): boolean {
    return this.activeSocket !== undefined
  }

  request(command: BrowserExtensionCommand): Promise<unknown> {
    const socket = this.activeSocket
    if (socket === undefined) return Promise.reject(new Error('browser extension disconnected'))
    const requestId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pending.delete(requestId)
        reject(new Error('browser extension command timed out'))
      }, this.timeoutMs)
      this.pending.set(requestId, { command, resolve, reject, timer })
      socket.send(JSON.stringify({ ...command, requestId }))
    })
  }

  subscribe(listener: (event: BrowserExtensionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  subscribeConnection(listener: (connection: BrowserExtensionConnection) => void): () => void {
    this.connectionListeners.add(listener)
    return () => this.connectionListeners.delete(listener)
  }

  private rejectPending(message: string): void {
    for (const request of this.pending.values()) {
      this.clearTimer(request.timer)
      request.reject(new Error(message))
    }
    this.pending.clear()
  }
}

export function browserExtensionWebSocketHandlers(): Bun.WebSocketHandler<BrowserExtensionSocketData> {
  return {
    open(socket) {
      socket.data.bridge.open(socket)
    },
    message(socket, message) {
      socket.data.bridge.message(socket, message)
    },
    close(socket) {
      socket.data.bridge.close(socket)
    },
  }
}

export function handleBrowserExtensionUpgrade(
  request: Request,
  server: Bun.Server<BrowserExtensionSocketData>,
  bridge: BrowserExtensionBridge,
): Response | null | undefined {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return null
  const url = new URL(request.url)
  if (url.pathname !== '/v1/desktop/browser-extension/socket') return null
  const address = server.requestIP(request)?.address
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') {
    return new Response('browser extension requires loopback', { status: 403 })
  }
  if (request.headers.get('origin') !== `chrome-extension://${DESKTOP_BROWSER_EXTENSION_ID}`) {
    return new Response('unexpected browser extension origin', { status: 403 })
  }
  return server.upgrade(request, { data: { kind: 'browser-extension', bridge } })
    ? undefined
    : new Response('upgrade failed', { status: 400 })
}
