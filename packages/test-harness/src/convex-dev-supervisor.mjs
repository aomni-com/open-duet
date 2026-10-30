import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { basename } from 'node:path'

// Two stop disciplines, chosen by the spawner:
//
// - `immediate` (the default): these deployments are disposable — their state
//   is discarded on stop — so the group is SIGKILLed outright and the whole
//   stop completes deterministically in well under a second. Any grace period
//   here is pure risk: afterAll hooks run under bun's 5s default budget, and a
//   stop still mid-escalation when the runner's reaper arrives gets SIGKILLed
//   itself, orphaning the backend it was about to kill — which then burns
//   cores under every later file in the run.
// - `graceful`: the template build's deployment is about to have its sqlite
//   snapshotted, and only a clean exit guarantees an untorn copy.
const GRACEFUL_STOP_TIMEOUT_MS = 5_000
const FORCE_STOP_TIMEOUT_MS = 2_000
const KILL_WAIT_MS = 1_000
const killMode = process.env.DUET_CONVEX_SUPERVISOR_KILL_MODE ?? 'immediate'
const runtimeDir = process.env.DUET_CONVEX_SUPERVISOR_RUNTIME_DIR
const [command, ...args] = process.argv.slice(2)

if (command === undefined || runtimeDir === undefined) {
  console.error('Convex supervisor requires a command and runtime directory.')
  process.exit(1)
}

const childEnv = { ...process.env }
delete childEnv.DUET_CONVEX_SUPERVISOR_RUNTIME_DIR
delete childEnv.DUET_CONVEX_SUPERVISOR_KILL_MODE

const child = spawn(command, args, {
  cwd: process.cwd(),
  env: childEnv,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'inherit', 'inherit'],
})

let stopping = false

process.stdin.resume()
process.stdin.once('end', () => void stop(0))
process.stdin.once('error', () => void stop(1))
process.once('SIGINT', () => void stop(0))
process.once('SIGTERM', () => void stop(0))
child.once('error', error => {
  console.error(error)
  void stop(1)
})
child.once('exit', code => void stop(code ?? 1))

async function stop(exitCode) {
  if (stopping) return
  stopping = true

  if (killMode === 'graceful') {
    signalProcessGroup('SIGINT')
    if (!(await waitForProcessGroupExit(GRACEFUL_STOP_TIMEOUT_MS))) {
      signalProcessGroup('SIGTERM')
    }
    if (!(await waitForProcessGroupExit(FORCE_STOP_TIMEOUT_MS))) {
      signalProcessGroup('SIGKILL')
      await waitForProcessGroupExit(FORCE_STOP_TIMEOUT_MS)
    }
  } else {
    signalProcessGroup('SIGKILL')
    await waitForProcessGroupExit(KILL_WAIT_MS)
  }

  cleanupRuntime()
  process.exit(exitCode)
}

function signalProcessGroup(signal) {
  try {
    if (process.platform === 'win32') {
      child.kill(signal)
    } else if (child.pid !== undefined) {
      process.kill(-child.pid, signal)
    }
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

async function waitForProcessGroupExit(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists()) {
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return true
}

function processGroupExists() {
  if (child.pid === undefined) return false
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, 0)
    return true
  } catch (error) {
    // ESRCH: gone. EPERM: macOS can report it for a group mid-reap after our
    // own SIGKILL — and either way we cannot signal it again, so waiting on it
    // is useless. Throwing here crashed the supervisor mid-stop, which made
    // the fixture see "exited before ready" instead of the real root cause.
    if (error?.code === 'ESRCH' || error?.code === 'EPERM') return false
    throw error
  }
}

function cleanupRuntime() {
  if (!basename(runtimeDir).startsWith('convex-dev-')) return
  rmSync(runtimeDir, { recursive: true, force: true })
}
