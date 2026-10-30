import type { BrowserRoomProbe } from './room-probe'

export type RemoteCommand = {
  id: number
  method: string
  argument: unknown
}

type RemoteProbe = Pick<
  BrowserRoomProbe,
  | 'connect'
  | 'waitForWorkerMetadata'
  | 'collectClockSamples'
  | 'startInputFixture'
  | 'waitForCandidateResponse'
  | 'interruptAtHeardBoundary'
  | 'disconnect'
  | 'armAudio'
>

export async function executeRemoteCommand(
  probe: Partial<RemoteProbe>,
  command: RemoteCommand,
): Promise<unknown> {
  switch (command.method) {
    case 'connect': {
      await requiredMethod(probe.connect, command.method).call(probe, command.argument as never)
      return null
    }
    case 'waitForWorkerMetadata':
      return requiredMethod(probe.waitForWorkerMetadata, command.method).call(
        probe,
        command.argument as string,
      )
    case 'collectClockSamples': {
      const [identity, sampleId] = pair(command.argument)
      return requiredMethod(probe.collectClockSamples, command.method).call(
        probe,
        identity,
        sampleId,
      )
    }
    case 'startInputFixture':
      return requiredMethod(probe.startInputFixture, command.method).call(probe)
    case 'waitForCandidateResponse': {
      const [identity, sampleId] = pair(command.argument)
      return requiredMethod(probe.waitForCandidateResponse, command.method).call(
        probe,
        identity,
        sampleId,
      )
    }
    case 'interruptAtHeardBoundary':
      return requiredMethod(probe.interruptAtHeardBoundary, command.method).call(
        probe,
        stringArgument(command.argument),
      )
    case 'disconnect': {
      await requiredMethod(probe.disconnect, command.method).call(probe)
      return null
    }
    default:
      throw new Error('unsupported mobile probe command')
  }
}

export function installRemoteController(probe: RemoteProbe, caption: HTMLOutputElement): void {
  const fragment = new URLSearchParams(location.hash.slice(1))
  const secret = fragment.get('secret')
  if (!secret) return
  history.replaceState(null, '', location.pathname + location.search)

  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Arm mobile probe'
  document.querySelector('main')?.append(button)
  caption.textContent = 'Tap once to arm audio'

  button.addEventListener(
    'click',
    () => {
      button.disabled = true
      void connectRemoteController(probe, caption, button, secret)
    },
    { once: true },
  )
}

async function connectRemoteController(
  probe: RemoteProbe,
  caption: HTMLOutputElement,
  button: HTMLButtonElement,
  secret: string,
): Promise<void> {
  try {
    await probe.armAudio()
    const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${scheme}//${location.host}/control`)
    socket.addEventListener('open', () =>
      socket.send(
        JSON.stringify({
          secret,
          browser: {
            user_agent: navigator.userAgent,
            platform: navigator.platform,
            max_touch_points: navigator.maxTouchPoints,
          },
        }),
      ),
    )
    socket.addEventListener('message', event => {
      void handleSocketMessage(probe, caption, button, socket, String(event.data))
    })
    socket.addEventListener('close', () => {
      caption.textContent = 'Mobile controller disconnected'
      caption.dataset.state = 'error'
    })
  } catch {
    caption.textContent = 'Could not arm audio'
    caption.dataset.state = 'error'
  }
}

async function handleSocketMessage(
  probe: RemoteProbe,
  caption: HTMLOutputElement,
  button: HTMLButtonElement,
  socket: WebSocket,
  text: string,
): Promise<void> {
  const message: unknown = JSON.parse(text)
  if (isAuthenticated(message)) {
    button.textContent = 'Audio armed'
    button.dataset.state = 'ready'
    caption.textContent = 'Mobile controller ready'
    caption.dataset.state = 'ready'
    return
  }
  if (!isRemoteCommand(message)) {
    socket.close(1008)
    return
  }
  try {
    const result = await executeRemoteCommand(probe, message)
    socket.send(JSON.stringify({ id: message.id, ok: true, result }))
  } catch {
    socket.send(JSON.stringify({ id: message.id, ok: false, error: 'command_failed' }))
  }
}

function requiredMethod<T extends (...args: never[]) => unknown>(
  method: T | undefined,
  name: string,
): T {
  if (!method) throw new Error(`mobile probe method is unavailable: ${name}`)
  return method
}

function pair(argument: unknown): [string, string] {
  if (
    !Array.isArray(argument) ||
    argument.length !== 2 ||
    typeof argument[0] !== 'string' ||
    typeof argument[1] !== 'string'
  ) {
    throw new Error('mobile probe command requires a string pair')
  }
  return [argument[0], argument[1]]
}

function stringArgument(argument: unknown): string {
  if (typeof argument !== 'string') throw new Error('mobile probe command requires a string')
  return argument
}

function isAuthenticated(value: unknown): value is { kind: 'authenticated' } {
  return (
    typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'authenticated'
  )
}

function isRemoteCommand(value: unknown): value is RemoteCommand {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    Number.isInteger(value.id) &&
    'method' in value &&
    typeof value.method === 'string' &&
    'argument' in value
  )
}
