import { afterAll, describe, expect, test } from 'bun:test'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LAUNCH_AGENT_LABEL,
  installLaunchAgent,
  launchAgentPlistPath,
  renderLaunchAgentPlist,
  uninstallLaunchAgent,
  type LaunchctlResult,
} from './launchd.js'

const tmpDirs: string[] = []
afterAll(async () => {
  await Promise.all(tmpDirs.map(dir => rm(dir, { recursive: true, force: true })))
})

async function makeHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'duet-launchd-'))
  tmpDirs.push(dir)
  return dir
}

function fakeLaunchctl(): {
  run: (args: string[]) => Promise<LaunchctlResult>
  calls: string[][]
  loaded: Set<string>
} {
  const calls: string[][] = []
  const loaded = new Set<string>()
  const run = async (args: string[]): Promise<LaunchctlResult> => {
    calls.push(args)
    if (args[0] === 'bootstrap') {
      loaded.add(LAUNCH_AGENT_LABEL)
      return { code: 0, stderr: '' }
    }
    if (args[0] === 'bootout') {
      const wasLoaded = loaded.delete(LAUNCH_AGENT_LABEL)
      return { code: wasLoaded ? 0 : 3, stderr: wasLoaded ? '' : 'No such process' }
    }
    return { code: 0, stderr: '' }
  }
  return { run, calls, loaded }
}

describe('renderLaunchAgentPlist', () => {
  const plist = renderLaunchAgentPlist({
    label: LAUNCH_AGENT_LABEL,
    programArguments: ['/opt/node', '/opt/duet/dist/cli-entry.js', 'sync', 'daemon'],
    stdoutPath: '/home/me/.duet/sync/daemon.log',
    stderrPath: '/home/me/.duet/sync/daemon.log',
    path: '/usr/bin:/bin',
  })

  test('runs the daemon at login with keep-alive', () => {
    expect(plist).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`)
    expect(plist).toContain('<string>sync</string>')
    expect(plist).toContain('<string>daemon</string>')
    expect(plist).toContain('<key>RunAtLoad</key>\n    <true/>')
    expect(plist).toContain('<key>KeepAlive</key>\n    <true/>')
    expect(plist).toContain('<string>/home/me/.duet/sync/daemon.log</string>')
  })

  test('is deterministic (re-install writes byte-identical XML)', () => {
    const again = renderLaunchAgentPlist({
      label: LAUNCH_AGENT_LABEL,
      programArguments: ['/opt/node', '/opt/duet/dist/cli-entry.js', 'sync', 'daemon'],
      stdoutPath: '/home/me/.duet/sync/daemon.log',
      stderrPath: '/home/me/.duet/sync/daemon.log',
      path: '/usr/bin:/bin',
    })
    expect(again).toBe(plist)
  })

  test('escapes XML-significant characters in paths', () => {
    const escaped = renderLaunchAgentPlist({
      label: LAUNCH_AGENT_LABEL,
      programArguments: ['/opt/A & B/node'],
      stdoutPath: '/log',
      stderrPath: '/log',
    })
    expect(escaped).toContain('<string>/opt/A &amp; B/node</string>')
  })
})

describe('install / uninstall idempotence', () => {
  test('install writes the plist, loads it, and replaces cleanly on re-run', async () => {
    const home = await makeHome()
    const ctl = fakeLaunchctl()
    const env = {
      home,
      uid: 501,
      execPath: '/opt/node',
      scriptPath: '/opt/duet/dist/cli-entry.js',
      runLaunchctl: ctl.run,
    }
    const result = await installLaunchAgent(env)
    expect(result.plistPath).toBe(launchAgentPlistPath(home))
    await access(result.plistPath) // exists
    expect(ctl.loaded.has(LAUNCH_AGENT_LABEL)).toBe(true)
    const wrote = await readFile(result.plistPath, 'utf8')
    expect(wrote).toContain('<string>daemon</string>')

    // Re-install: boots out the old copy first, then bootstraps again (idempotent).
    ctl.calls.length = 0
    await installLaunchAgent(env)
    expect(ctl.calls[0]![0]).toBe('bootout')
    expect(ctl.calls[1]![0]).toBe('bootstrap')
    expect(ctl.loaded.has(LAUNCH_AGENT_LABEL)).toBe(true)
  })

  test('uninstall boots out, removes the plist, and is a quiet no-op the second time', async () => {
    const home = await makeHome()
    const ctl = fakeLaunchctl()
    const env = {
      home,
      uid: 501,
      execPath: '/opt/node',
      scriptPath: '/opt/duet/dist/cli-entry.js',
      runLaunchctl: ctl.run,
    }
    await installLaunchAgent(env)
    const first = await uninstallLaunchAgent(env)
    expect(first.wasLoaded).toBe(true)
    await expect(access(launchAgentPlistPath(home))).rejects.toThrow()

    const second = await uninstallLaunchAgent(env)
    expect(second.wasLoaded).toBe(false)
    expect(ctl.loaded.has(LAUNCH_AGENT_LABEL)).toBe(false)
  })

  test('a bootstrap failure is surfaced, not swallowed', async () => {
    const home = await makeHome()
    const env = {
      home,
      uid: 501,
      execPath: '/opt/node',
      scriptPath: '/opt/duet/dist/cli-entry.js',
      runLaunchctl: async (args: string[]): Promise<LaunchctlResult> =>
        args[0] === 'bootstrap'
          ? { code: 5, stderr: 'Bootstrap failed: 5' }
          : { code: 0, stderr: '' },
    }
    await expect(installLaunchAgent(env)).rejects.toThrow(/bootstrap failed/i)
  })
})
