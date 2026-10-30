import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { ExeClient, type ExeVm } from '../src/exe.ts'
import { PROBE_REPORTS_DIR, probeReportUrl } from './probe-artifacts.ts'

export const DUET_TAG = 'duet-test'
export const DEFAULT_CREATE = {
  cpu: 1,
  memory: '2GB',
  tags: [DUET_TAG],
}

export interface Timed<T> {
  value: T
  durationMs: number
}

export interface ProbeContext {
  control: ExeClient
  ssh: ExeClient
  created: string[]
}

export function makeContext(): ProbeContext {
  const verbose = process.argv.includes('--verbose')
  return {
    control: new ExeClient({ token: process.env.EXE_TOKEN, verbose }),
    ssh: new ExeClient({ verbose }),
    created: [],
  }
}

export function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').toLowerCase()
}

export function vmName(probe: string): string {
  return `duet-test-${probe}-${stamp()}-${Math.random().toString(36).slice(2, 6)}`
}

export async function time<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const start = performance.now()
  const value = await fn()
  return { value, durationMs: performance.now() - start }
}

export async function authenticate(ctx: ProbeContext): Promise<void> {
  await ctx.control.whoami()
}

export async function createVm(
  ctx: ProbeContext,
  options: NonNullable<Parameters<ExeClient['create']>[0]>,
): Promise<Timed<ExeVm>> {
  const result = await time(() =>
    ctx.control.create({
      ...DEFAULT_CREATE,
      ...options,
      tags: [...DEFAULT_CREATE.tags, ...(options.tags ?? [])],
    }),
  )
  ctx.created.push(result.value.vm_name)
  return result
}

export async function runOrThrow(
  client: ExeClient,
  sshDest: string,
  command: string,
  timeoutMs = 60_000,
): Promise<string> {
  const result = await client.exec(sshDest, command, timeoutMs)
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (exit ${result.exitCode}): ${command}\n${result.stderr || result.stdout}`,
    )
  }
  return result.stdout.trim()
}

export async function cleanup(
  ctx: ProbeContext,
): Promise<{ deleted: string[]; deleteErrors: string[] }> {
  const deleted: string[] = []
  const deleteErrors: string[] = []
  for (const name of [...ctx.created].reverse()) {
    try {
      await ctx.control.remove(name)
      deleted.push(name)
    } catch (error) {
      deleteErrors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { deleted, deleteErrors }
}

export async function assertNoDuetTestVms(client: ExeClient): Promise<string[]> {
  let leaked: string[] = []
  for (let attempt = 0; attempt < 10; attempt++) {
    leaked = (await client.list())
      .filter(vm => vm.vm_name.startsWith('duet-test-'))
      .map(vm => vm.vm_name)
    if (leaked.length === 0) return leaked
    await Bun.sleep(1_000)
  }
  throw new Error(`Leaked duet-test VMs remain: ${leaked.join(', ')}`)
}

export async function writeReport(filename: string, body: string): Promise<void> {
  await mkdir(fileURLToPath(PROBE_REPORTS_DIR), { recursive: true })
  await writeFile(fileURLToPath(probeReportUrl(filename)), body)
}

export function ms(ms: number): string {
  return `${ms.toFixed(0)} ms`
}

export function fenced(text: string): string {
  return `\`\`\`\n${text.trim()}\n\`\`\``
}
