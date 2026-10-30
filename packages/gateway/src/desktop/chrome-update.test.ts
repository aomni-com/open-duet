import { describe, expect, test } from 'bun:test'

import { DESKTOP_CHROME_DEB_SHA256, DESKTOP_CHROME_VERSION } from '@repo/contract'

import { createChromeUpdater } from './chrome-update'

describe('shared Chrome updater', () => {
  const runMaintenance = async <T>(work: () => Promise<T>): Promise<T> => await work()

  test('stops an active shared browser, installs the exact pin, and restarts it', async () => {
    const commands: string[][] = []
    const agentStartBlocks: boolean[] = []
    const maintenance: string[] = []
    const updater = createChromeUpdater({
      hasLiveAgentRunners: () => false,
      setStartsBlocked: blocked => agentStartBlocks.push(blocked),
      runWithDesktopMaintenance: async work => {
        maintenance.push('entered')
        return await work()
      },
      runCommand: async argv => {
        commands.push(argv)
        return { exitCode: 0 }
      },
    })

    await expect(updater.update()).resolves.toEqual({
      ok: true,
      version: DESKTOP_CHROME_VERSION,
    })
    expect(commands).toEqual([
      ['sudo', '-n', 'systemctl', 'is-active', '--quiet', 'duet-desktop-browser.service'],
      ['sudo', '-n', 'systemctl', 'stop', 'duet-desktop-browser.service'],
      [
        'sudo',
        '-n',
        '/opt/duet/bin/update-shared-chrome',
        DESKTOP_CHROME_VERSION,
        DESKTOP_CHROME_DEB_SHA256,
      ],
      ['sudo', '-n', 'systemctl', 'start', 'duet-desktop-browser.service'],
    ])
    expect(agentStartBlocks).toEqual([true, false])
    expect(maintenance).toEqual(['entered'])
  })

  test('hard-refuses while an agent session is live without running a command', async () => {
    const commands: string[][] = []
    const updater = createChromeUpdater({
      hasLiveAgentRunners: () => true,
      setStartsBlocked: () => undefined,
      runWithDesktopMaintenance: runMaintenance,
      runCommand: async argv => {
        commands.push(argv)
        return { exitCode: 0 }
      },
    })

    await expect(updater.update()).resolves.toEqual({ ok: false, error: 'desktop_busy' })
    expect(commands).toEqual([])
  })

  test('does not install when systemd cannot determine browser activity', async () => {
    const commands: string[][] = []
    const agentStartBlocks: boolean[] = []
    const updater = createChromeUpdater({
      hasLiveAgentRunners: () => false,
      setStartsBlocked: blocked => agentStartBlocks.push(blocked),
      runWithDesktopMaintenance: runMaintenance,
      runCommand: async argv => {
        commands.push(argv)
        return { exitCode: 1 }
      },
    })

    await expect(updater.update()).rejects.toThrow('failed (1)')
    expect(commands).toEqual([
      ['sudo', '-n', 'systemctl', 'is-active', '--quiet', 'duet-desktop-browser.service'],
    ])
    expect(agentStartBlocks).toEqual([true, false])
  })

  test('coalesces concurrent operator retries into one install', async () => {
    let finishInstall: (() => void) | undefined
    const installCanFinish = new Promise<void>(resolve => {
      finishInstall = resolve
    })
    let installs = 0
    const updater = createChromeUpdater({
      hasLiveAgentRunners: () => false,
      setStartsBlocked: () => undefined,
      runWithDesktopMaintenance: runMaintenance,
      runCommand: async argv => {
        if (argv.includes('/opt/duet/bin/update-shared-chrome')) {
          installs += 1
          await installCanFinish
        }
        return { exitCode: argv.includes('is-active') ? 3 : 0 }
      },
    })

    const first = updater.update()
    const retry = updater.update()
    expect(retry).toBe(first)
    finishInstall?.()
    await expect(Promise.all([first, retry])).resolves.toEqual([
      { ok: true, version: DESKTOP_CHROME_VERSION },
      { ok: true, version: DESKTOP_CHROME_VERSION },
    ])
    expect(installs).toBe(1)
  })

  test.each([
    ['stop', ['systemctl', 'stop']],
    ['install', ['/opt/duet/bin/update-shared-chrome']],
  ] as const)('restores an active browser when %s fails', async (_stage, failingCommand) => {
    const commands: string[][] = []
    const updater = createChromeUpdater({
      hasLiveAgentRunners: () => false,
      setStartsBlocked: () => undefined,
      runWithDesktopMaintenance: runMaintenance,
      runCommand: async argv => {
        commands.push(argv)
        return { exitCode: failingCommand.every(part => argv.includes(part)) ? 1 : 0 }
      },
    })

    await expect(updater.update()).rejects.toThrow('failed (1)')
    expect(commands.at(-1)).toEqual([
      'sudo',
      '-n',
      'systemctl',
      'start',
      'duet-desktop-browser.service',
    ])
  })
})
