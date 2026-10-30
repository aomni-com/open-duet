/**
 * exe.dev lifecycle timing benchmark.
 *
 * Measures the operations that matter when deciding whether exe.dev can replace
 * e2b for v2. exe.dev has NO memory-snapshot pause/resume — a VM is a persistent
 * disk you reboot — so the interesting number is the reboot cost.
 *
 * Transport is chosen automatically:
 *   - EXE_TOKEN set  -> HTTPS API (`POST /exec`). Control-plane only, so
 *     readiness is measured as "lobby reports running".
 *   - otherwise      -> SSH. Additionally measures true in-VM shell readiness.
 *
 * Metrics (HTTPS):  create, running, restart, restartRunning, delete
 * Metrics (SSH):    create, sshReady, exec, restart, restartReady, delete
 *
 * `restart(Running|Ready)` is the "stop/start" cost — a cold reboot from disk
 * with no live memory to restore, the direct analogue of an e2b resume.
 *
 * Usage:
 *   bun run bench -- --iterations 5
 *   bun run bench -- --iterations 10 --image exeuntu --cpu 2 --memory 4GB
 */

import { ExeClient } from '../src/exe.ts'

interface MetricResult {
  name: string
  durationMs: number
  status: 'passed' | 'failed'
  details?: string
}

interface CliOptions {
  iterations: number
  image?: string
  cpu?: number
  memory?: string
  disk?: string
  readyTimeoutMs: number
  keep: boolean
  verbose: boolean
}

function parseCliOptions(): CliOptions {
  const args = process.argv.slice(2)
  const options: CliOptions = {
    iterations: 5,
    readyTimeoutMs: 180_000,
    keep: false,
    verbose: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    const value = args[i + 1]
    switch (arg) {
      case '--iterations':
        options.iterations = requirePositiveInt(arg, value)
        i++
        break
      case '--image':
        options.image = requireValue(arg, value)
        i++
        break
      case '--cpu':
        options.cpu = requirePositiveInt(arg, value)
        i++
        break
      case '--memory':
        options.memory = requireValue(arg, value)
        i++
        break
      case '--disk':
        options.disk = requireValue(arg, value)
        i++
        break
      case '--ready-timeout-ms':
        options.readyTimeoutMs = requirePositiveInt(arg, value)
        i++
        break
      case '--keep':
        options.keep = true
        break
      case '--verbose':
        options.verbose = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`Missing value for ${flag}`)
  return value
}

function requirePositiveInt(flag: string, value: string | undefined): number {
  const parsed = Number(requireValue(flag, value))
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${flag} value "${value}". Expected a positive integer.`)
  }
  return parsed
}

async function timeStep(name: string, fn: () => Promise<void>): Promise<MetricResult> {
  const start = performance.now()
  try {
    await fn()
    return { name, durationMs: performance.now() - start, status: 'passed' }
  } catch (error) {
    return {
      name,
      durationMs: performance.now() - start,
      status: 'failed',
      details: error instanceof Error ? error.message : String(error),
    }
  }
}

async function runIteration(
  client: ExeClient,
  options: CliOptions,
  iteration: number,
): Promise<MetricResult[]> {
  const results: MetricResult[] = []
  const name = `bench-${Date.now().toString(36)}-${iteration}`
  const ssh = client.transport === 'ssh'
  let sshDest: string | null = null
  let created = false

  results.push(
    await timeStep('create', async () => {
      const vm = await client.create({
        name,
        image: options.image,
        cpu: options.cpu,
        memory: options.memory,
        disk: options.disk,
        comment: '@repo/exe lifecycle benchmark',
      })
      sshDest = vm.ssh_dest
      created = true
    }),
  )

  try {
    if (!created) return results

    results.push(
      await timeStep(ssh ? 'sshReady' : 'running', async () => {
        if (ssh) await client.waitUntilReady(sshDest!, { timeoutMs: options.readyTimeoutMs })
        else await client.waitUntilRunning(name, { timeoutMs: options.readyTimeoutMs })
      }),
    )

    if (ssh) {
      results.push(
        await timeStep('exec', async () => {
          const r = await client.exec(sshDest!, 'uname -a')
          if (r.exitCode !== 0) throw new Error(`exec failed: ${r.stderr}`)
        }),
      )
    }

    results.push(await timeStep('restart', async () => client.restart(name)))

    results.push(
      await timeStep(ssh ? 'restartReady' : 'restartRunning', async () => {
        if (ssh) await client.waitUntilReady(sshDest!, { timeoutMs: options.readyTimeoutMs })
        else await client.waitUntilRunning(name, { timeoutMs: options.readyTimeoutMs })
      }),
    )
  } finally {
    if (created && !options.keep) {
      results.push(await timeStep('delete', async () => client.remove(name)))
    }
  }

  return results
}

// ---- stats + reporting ---------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  if (sorted.length === 1) return sorted[0]!
  const index = (sorted.length - 1) * Math.max(0, Math.min(1, p))
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower)
}

function fmt(ms: number): string {
  return ms.toFixed(0).padStart(10)
}

function printIteration(iteration: number, results: MetricResult[]): void {
  console.log(`\nIteration ${iteration}:`)
  for (const r of results) {
    const tag = r.status === 'passed' ? '[ok]  ' : '[FAIL]'
    const line = `  ${tag} ${r.name.padEnd(15)} ${fmt(r.durationMs)} ms`
    console.log(r.details ? `${line}  - ${r.details}` : line)
  }
}

function printAggregate(all: MetricResult[], order: string[], iterations: number): void {
  console.log(`\nAggregate across ${iterations} iteration(s), milliseconds:`)
  console.log(
    'metric'.padEnd(16) +
      'samples'.padStart(9) +
      'avg'.padStart(11) +
      'p50'.padStart(11) +
      'p90'.padStart(11) +
      'p95'.padStart(11) +
      'min'.padStart(11) +
      'max'.padStart(11),
  )
  for (const metric of order) {
    const scoped = all.filter(r => r.name === metric)
    if (scoped.length === 0) continue
    const ok = scoped
      .filter(r => r.status === 'passed')
      .map(r => r.durationMs)
      .sort((a, b) => a - b)
    const avg = ok.length ? ok.reduce((s, v) => s + v, 0) / ok.length : 0
    console.log(
      metric.padEnd(16) +
        `${ok.length}/${scoped.length}`.padStart(9) +
        fmt(avg).padStart(11) +
        fmt(percentile(ok, 0.5)).padStart(11) +
        fmt(percentile(ok, 0.9)).padStart(11) +
        fmt(percentile(ok, 0.95)).padStart(11) +
        fmt(ok[0] ?? 0).padStart(11) +
        fmt(ok[ok.length - 1] ?? 0).padStart(11),
    )
  }
}

async function main(): Promise<void> {
  const options = parseCliOptions()
  const token = process.env.EXE_TOKEN
  const client = new ExeClient({ token, verbose: options.verbose })

  try {
    const me = (await client.whoami()) as { email?: string }
    console.log(`Authenticated as ${me.email ?? '(unknown)'} via ${client.transport.toUpperCase()}`)
  } catch (error) {
    throw new Error(
      client.transport === 'https'
        ? `EXE_TOKEN did not authenticate. Regenerate with \`ssh exe.dev ssh-key generate-api-key --exp=30d\`.\n${error instanceof Error ? error.message : String(error)}`
        : `Not authenticated with exe.dev over SSH. Register your key (\`ssh exe.dev\`) or set EXE_TOKEN.\n${error instanceof Error ? error.message : String(error)}`,
    )
  }

  const order =
    client.transport === 'ssh'
      ? ['create', 'sshReady', 'exec', 'restart', 'restartReady', 'delete']
      : ['create', 'running', 'restart', 'restartRunning', 'delete']

  console.log('exe.dev lifecycle benchmark')
  console.log(`  iterations: ${options.iterations}`)
  console.log(`  image:      ${options.image ?? '(default: exeuntu)'}`)
  console.log(`  cpu/mem:    ${options.cpu ?? 'default'} / ${options.memory ?? 'default'}`)
  if (options.keep) console.log('  keep:       VMs will NOT be deleted')

  const all: MetricResult[] = []
  for (let i = 1; i <= options.iterations; i++) {
    const results = await runIteration(client, options, i)
    printIteration(i, results)
    all.push(...results)
  }

  printAggregate(all, order, options.iterations)

  const failures = all.filter(r => r.status === 'failed')
  if (failures.length > 0) {
    console.error(`\n${failures.length} metric sample(s) failed.`)
    process.exit(1)
  }
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
