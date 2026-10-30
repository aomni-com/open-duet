import { describe, expect, test } from 'bun:test'

import { restartFleet, selectFleet, parseCommandLine } from './restart-vm-fleet'

const vm = (name: string, tags: string[], status = 'running') => ({
  vm_name: name,
  ssh_dest: `${name}@exe`,
  status,
  tags,
})

const FLEET = [
  vm('prod-a', ['duet-workspace', 'duet-production']),
  vm('prod-b', ['duet-workspace', 'duet-production']),
  vm('stg-a', ['duet-workspace', 'duet-staging']),
  vm('stg-b', ['duet-workspace', 'duet-staging']),
  vm('stg-stopped', ['duet-workspace', 'duet-staging'], 'stopped'),
  vm('untagged', ['duet-workspace']),
  vm('not-a-workspace', ['something-else', 'duet-staging']),
]

const options = { environment: 'staging' as const, concurrency: 2, apply: false }

describe('fleet selection', () => {
  test('selects one environment and never the other', () => {
    const selection = selectFleet(FLEET, options)

    expect(selection.selected.map(entry => entry.vm_name)).toEqual(['stg-a', 'stg-b'])
    expect(selection.otherEnvironment).toBe(2)
  })

  test('excludes a workspace VM carrying no environment tag, and names it', () => {
    // The tag is absent when the VM was created against an unrecognized API
    // origin. Guessing its environment is how a staging sweep reaches prod.
    expect(selectFleet(FLEET, options).untagged.map(entry => entry.vm_name)).toEqual(['untagged'])
  })

  test('holds back the VMs named by --except', () => {
    const selection = selectFleet(FLEET, { ...options, except: ['stg-a'] })

    expect(selection.selected.map(entry => entry.vm_name)).toEqual(['stg-b'])
    expect(selection.spared).toEqual(['stg-a'])
  })
})

describe('restarting', () => {
  const client = (log: string[]) => ({
    list: async () => FLEET,
    restart: async (name: string) => {
      log.push(`restart:${name}`)
    },
    waitUntilRunning: async () => 1_000,
  })

  test('a dry run reboots nothing', async () => {
    const calls: string[] = []
    await restartFleet(client(calls), options, () => {})

    expect(calls).toEqual([])
  })

  test('refuses to run when --except names a VM that is not there', async () => {
    const calls: string[] = []
    // A typo would otherwise reboot the VM the operator meant to preserve —
    // silently, because a name that matches nothing simply spares nothing.
    await expect(
      restartFleet(client(calls), { ...options, apply: true, except: ['stg-typo'] }, () => {}),
    ).rejects.toThrow('stg-typo')
    expect(calls).toEqual([])
  })

  test('reboots the selection and keeps going when one VM fails', async () => {
    const calls: string[] = []
    const failing = {
      ...client(calls),
      restart: async (name: string) => {
        calls.push(`restart:${name}`)
        if (name === 'stg-a') throw new Error('unreachable')
      },
    }

    const { outcomes } = await restartFleet(failing, { ...options, apply: true }, () => {})

    expect(calls).toEqual(['restart:stg-a', 'restart:stg-b'])
    expect(outcomes.map(outcome => [outcome.vmName, outcome.status])).toEqual([
      ['stg-a', 'failed'],
      ['stg-b', 'rebooted'],
    ])
  })
})

describe('command line', () => {
  test('requires an environment', () => {
    expect(() => parseCommandLine([])).toThrow('--env')
    expect(() => parseCommandLine(['--env', 'both'])).toThrow('--env')
  })

  test('defaults to a dry run', () => {
    expect(parseCommandLine(['--env', 'staging']).apply).toBe(false)
    expect(parseCommandLine(['--env', 'staging', '--apply']).apply).toBe(true)
  })

  test('parses a comma-separated exception list', () => {
    expect(parseCommandLine(['--env', 'staging', '--except', 'a, b']).except).toEqual(['a', 'b'])
  })
})
