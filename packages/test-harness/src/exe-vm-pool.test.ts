import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import * as childProcess from 'node:child_process'

import { ExeClient } from '@repo/exe'

import {
  DUET_TEST_VM_PREFIX,
  DUET_TEST_VM_TAG,
  exeSelfTestReady,
  exeVmPool,
} from './exe-vm-pool.ts'

describe('exeVmPool', () => {
  test('rejects custom names outside the duet-test ownership prefix', async () => {
    const edge = controlledLobby()
    const pool = exeVmPool({ client: edge.client })
    await expect(pool.checkout({ name: 'manual-test-vm' })).rejects.toThrow(
      `Test VM names must start with ${DUET_TEST_VM_PREFIX}`,
    )
    expect(edge.commands).toEqual([])
  })

  test('applies ownership tags at creation for custom names with the duet-test prefix', async () => {
    const edge = controlledLobby()
    const pool = exeVmPool({ client: edge.client })
    const vm = await pool.checkout({ name: `${DUET_TEST_VM_PREFIX}custom` })
    expect(vm).toMatchObject({ vm_name: `${DUET_TEST_VM_PREFIX}custom`, tags: [DUET_TEST_VM_TAG] })
    expect(edge.commands.map(command => command[0])).toEqual(['new'])
  })

  test('preserves creation tags without re-adding existing provider tags', async () => {
    const edge = controlledLobby()
    const pool = exeVmPool({ client: edge.client })
    const vm = await pool.checkout({
      name: `${DUET_TEST_VM_PREFIX}creation`,
      tags: [DUET_TEST_VM_TAG, 'duet-run-fixture'],
    })
    expect(vm).toMatchObject({
      vm_name: `${DUET_TEST_VM_PREFIX}creation`,
      tags: [DUET_TEST_VM_TAG, 'duet-run-fixture'],
    })
    expect(edge.commands.map(command => command[0])).toEqual(['new'])
  })

  test('checking live SSH readiness cannot add an unknown host to user state', () => {
    const token = process.env.EXE_TOKEN
    const requests: unknown[][] = []
    const ssh = spyOn(childProcess, 'execFileSync').mockImplementation((...args: unknown[]) => {
      requests.push(args)
      throw new Error('Fixture host is not trusted')
    })
    process.env.EXE_TOKEN = 'fixture-token'
    try {
      expect(exeSelfTestReady()).toBe(false)
      const [command, args] = requests[0] as [string, string[]]
      expect(command).toBe('ssh')
      expect(args).toContain('BatchMode=yes')
      expect(args).toContain('StrictHostKeyChecking=yes')
      expect(args.slice(-2)).toEqual(['exe.dev', 'whoami'])
    } finally {
      ssh.mockRestore()
      if (token === undefined) delete process.env.EXE_TOKEN
      else process.env.EXE_TOKEN = token
    }
  })

  test.skipIf(!exeSelfTestReady())(
    'checks out an exe.dev VM, proves SSH user, and deletes it (requires EXE_TOKEN and ssh exe.dev whoami)',
    async () => {
      const pool = exeVmPool()
      let vmName: string | null = null

      try {
        const vm = await pool.checkout({ cpu: 1, memory: '2GB' })
        vmName = vm.vm_name

        expect(vm.vm_name.startsWith(DUET_TEST_VM_PREFIX)).toBe(true)

        await pool.client.waitUntilReady(vm.ssh_dest, { timeoutMs: 180_000, intervalMs: 2_000 })
        const whoami = await pool.client.exec(vm.ssh_dest, 'whoami', 30_000)

        expect(whoami.exitCode).toBe(0)
        expect(whoami.stdout.trim()).toBe('exedev')
      } finally {
        if (vmName !== null) {
          await pool.return(vmName)
        }
      }

      expect(vmName).not.toBeNull()
      const remaining = await pool.client.list()
      expect(remaining.some(vm => vm.vm_name === vmName)).toBe(false)
    },
    300_000,
  )
})

const restores: Array<() => void> = []
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore()
})

function controlledLobby() {
  const originalFetch = globalThis.fetch
  const commands: string[][] = []
  restores.push(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(String(input), init)
      expect(new URL(request.url).pathname).toBe('/exec')
      expect(request.headers.get('authorization')).toBe('Bearer fixture-token')
      // Fixtures use simple names/tags; accept both quoted and unquoted wire args.
      const command = ((await request.text()).match(/'[^']*'|"[^"]*"|[^\s]+/g) ?? []).map(arg =>
        arg.replace(/^(['"])(.*)\1$/, '$2'),
      )
      commands.push(command)
      if (command[0] !== 'new') throw new Error(`Unexpected provider command: ${command[0]}`)
      const tags = command.flatMap((arg, index) => (arg === '--tag' ? [command[index + 1]!] : []))
      return Response.json({
        vm_name: command[command.indexOf('--name') + 1],
        ssh_dest: 'fixture.example',
        tags,
      })
    },
    { preconnect() {} },
  )
  return { client: new ExeClient({ token: 'fixture-token' }), commands }
}
