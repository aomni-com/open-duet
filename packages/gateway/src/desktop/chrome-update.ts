import { DESKTOP_CHROME_DEB_SHA256, DESKTOP_CHROME_VERSION } from '@repo/contract'

import type { SystemCommandRunner } from '../system-command'

const BROWSER_UNIT = 'duet-desktop-browser.service'
const UPDATE_HELPER = '/opt/duet/bin/update-shared-chrome'

export interface ChromeUpdater {
  update(): Promise<
    { ok: true; version: typeof DESKTOP_CHROME_VERSION } | { ok: false; error: 'desktop_busy' }
  >
}

export function createChromeUpdater(args: {
  runCommand: SystemCommandRunner
  hasLiveAgentRunners: () => boolean
  setStartsBlocked: (blocked: boolean) => void
  runWithDesktopMaintenance: <T>(work: () => Promise<T>) => Promise<T>
}): ChromeUpdater {
  let inFlight: ReturnType<ChromeUpdater['update']> | undefined
  return {
    update() {
      if (inFlight !== undefined) return inFlight
      const running = runUpdate(args)
      inFlight = running
      const clear = () => {
        if (inFlight === running) inFlight = undefined
      }
      void running.then(clear, clear)
      return running
    },
  }
}

async function runUpdate(args: {
  runCommand: SystemCommandRunner
  hasLiveAgentRunners: () => boolean
  setStartsBlocked: (blocked: boolean) => void
  runWithDesktopMaintenance: <T>(work: () => Promise<T>) => Promise<T>
}): ReturnType<ChromeUpdater['update']> {
  // Installing under a browser being driven can lose in-flight work even
  // when systemd subsequently restarts it. The operator rail deliberately
  // has no force arm: finish the live session, then retry the same audit.
  if (args.hasLiveAgentRunners()) return { ok: false, error: 'desktop_busy' }
  // This is synchronous with the live-runner check, before the first await,
  // so neither a new runner nor a fresh human desktop can enter through the
  // gap and have its browser replaced. Existing lifecycle gates own both.
  args.setStartsBlocked(true)

  try {
    return await args.runWithDesktopMaintenance(() => performUpdate(args))
  } finally {
    args.setStartsBlocked(false)
  }
}

async function performUpdate(args: {
  runCommand: SystemCommandRunner
}): ReturnType<ChromeUpdater['update']> {
  const activityProbe = ['sudo', '-n', 'systemctl', 'is-active', '--quiet', BROWSER_UNIT]
  const activity = await args.runCommand(activityProbe)
  // systemctl reserves 3 for inactive. Any other failure could mean sudo
  // or systemd itself broke; proceeding would risk replacing Chrome under
  // a browser we failed to observe.
  if (activity.exitCode !== 0 && activity.exitCode !== 3) {
    throw commandError(activity.exitCode, activityProbe)
  }
  const wasActive = activity.exitCode === 0
  try {
    if (wasActive) {
      await requireSuccess(args.runCommand, ['sudo', '-n', 'systemctl', 'stop', BROWSER_UNIT])
    }
    await requireSuccess(args.runCommand, [
      'sudo',
      '-n',
      UPDATE_HELPER,
      DESKTOP_CHROME_VERSION,
      DESKTOP_CHROME_DEB_SHA256,
    ])
  } finally {
    // ExecStop flushes the shared profile before the install. Bring back the
    // service that was active before the attempt even if stopping or installing
    // failed; systemctl start is idempotent if stop never took effect.
    if (wasActive) {
      await requireSuccess(args.runCommand, ['sudo', '-n', 'systemctl', 'start', BROWSER_UNIT])
    }
  }

  return { ok: true, version: DESKTOP_CHROME_VERSION }
}

async function requireSuccess(runCommand: SystemCommandRunner, argv: string[]): Promise<void> {
  const result = await runCommand(argv)
  if (result.exitCode !== 0) {
    throw commandError(result.exitCode, argv)
  }
}

function commandError(exitCode: number, argv: string[]): Error {
  return new Error(`Chrome update command failed (${exitCode}): ${argv.join(' ')}`)
}
