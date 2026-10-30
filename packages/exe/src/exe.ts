/**
 * Minimal exe.dev client.
 *
 * exe.dev has no SDK worth depending on: its API *is* SSH, with an HTTPS mirror.
 * Every control-plane operation is the same command either way:
 *
 *   - SSH:   `ssh exe.dev <command> --json`
 *   - HTTPS: `POST https://exe.dev/exec` with the command in the body and a
 *            `Authorization: Bearer <EXE_TOKEN>` header (JSON is always on).
 *
 * This client speaks HTTPS when given a `token` (from `EXE_TOKEN`) and SSH
 * otherwise. Two things only SSH can do, because `/exec` runs *lobby* commands
 * only (never commands inside a VM):
 *
 *   - `exec()`            run a command inside a VM (`ssh <vm>.exe.xyz -- ...`)
 *   - `waitUntilReady()`  poll until the VM answers SSH (true shell-ready)
 *
 * Over a token you instead use `waitUntilRunning()`, which polls `ls` until the
 * lobby reports the VM `running` (control-plane readiness).
 *
 * Auth:
 *   - HTTPS: `ssh exe.dev ssh-key generate-api-key --exp=30d` → put in EXE_TOKEN
 *   - SSH:   register your local key by running `ssh exe.dev` once
 *
 * Docs: https://exe.dev/docs/api  •  https://exe.dev/docs/https-api
 */

import { execFile } from 'node:child_process'

import { shellQuote, sshExitCode } from './internal.ts'
import type { ExeStatResponse } from './stat.ts'

const LOBBY_HOST = 'exe.dev'
const EXEC_ENDPOINT = 'https://exe.dev/exec'
const COMMAND_TIMEOUT_MS = 60_000
const CREATE_TIMEOUT_MS = 300_000

/** Shape of a VM as returned by `ls --json` / `new --json`. */
export interface ExeVm {
  vm_name: string
  ssh_dest: string
  https_url?: string
  region?: string
  region_display?: string
  status?: string
  tags?: string[]
  created_at?: string
  /** Provisioned disk size in bytes — capacity, not consumption. */
  disk_capacity_bytes?: number
  /** Allocated vCPU count. */
  allocated_cpus?: number
  /** Allocated memory in bytes — capacity, not consumption. */
  memory_capacity_bytes?: number
}

export interface ExeClientOptions {
  /** HTTPS API bearer token (EXE_TOKEN). When set, control-plane calls use HTTPS. */
  token?: string
  /** exe.dev lobby host (SSH transport). Override for testing. */
  host?: string
  /** SSH connect timeout (seconds) for a single attempt. */
  connectTimeoutSec?: number
  /** Log every underlying call to stderr. */
  verbose?: boolean
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface CreateVmOptions {
  name?: string
  image?: string
  /** Reserved capacity pool in which to create the VM. */
  pool?: string
  cpu?: number
  /** Memory allocation, e.g. "4GB". */
  memory?: string
  /** Disk size, e.g. "20GB". */
  disk?: string
  comment?: string
  /** Container command mode: "auto", "none", or a custom command. */
  command?: string
  /** Private registry credentials as USERNAME:PASSWORD for the registry hosting image. */
  registryAuth?: string
  /** VM tags. */
  tags?: string[]
  /** Environment variables in KEY=VALUE format. */
  env?: string[]
}

export interface ResizeVmOptions {
  cpu?: number
  /** Memory allocation, e.g. "4GB". */
  memory?: string
  /** New *total* disk size, e.g. "20GB". Must be larger than the current size. */
  disk?: string
}

export interface CopyVmOptions {
  cpu?: number
  /** Memory allocation, e.g. "4GB". */
  memory?: string
  /** Disk size, e.g. "20GB". */
  disk?: string
  copyTags?: boolean
}

/** Base SSH flags shared by every call: non-interactive, key-only, no prompts. */
function sshBaseArgs(connectTimeoutSec: number): string[] {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${connectTimeoutSec}`,
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'LogLevel=ERROR',
  ]
}

function runSsh(
  args: string[],
  opts: { verbose?: boolean; timeoutMs?: number } = {},
): Promise<ExecResult> {
  if (opts.verbose) {
    process.stderr.write(`$ ssh ${redactCommandForLog(args).join(' ')}\n`)
  }

  return new Promise(resolve => {
    execFile(
      'ssh',
      args,
      { timeout: opts.timeoutMs ?? 0, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        // execFile only sets error on non-zero exit / signal / timeout. We want
        // the exit code either way so callers can treat "connection refused"
        // during boot as a normal, pollable state rather than a throw.
        const exitCode = sshExitCode(error)
        resolve({ stdout, stderr, exitCode })
      },
    )
  })
}

export class ExeClient {
  private readonly token?: string
  private readonly host: string
  private readonly connectTimeoutSec: number
  private readonly verbose: boolean

  constructor(options: ExeClientOptions = {}) {
    this.token = options.token
    this.host = options.host ?? LOBBY_HOST
    this.connectTimeoutSec = options.connectTimeoutSec ?? 15
    this.verbose = options.verbose ?? false
  }

  /** Which control-plane transport is in use. */
  get transport(): 'https' | 'ssh' {
    return this.token ? 'https' : 'ssh'
  }

  /** Run a lobby command and parse its JSON. Uses HTTPS if a token is set, else SSH. */
  private async lobby<T>(command: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<T> {
    const raw = this.token
      ? await this.lobbyHttp(command, timeoutMs)
      : await this.lobbySsh(command, timeoutMs)
    try {
      return JSON.parse(raw) as T
    } catch {
      throw new Error(
        `exe.dev command '${redactCommandForLog(command).join(' ')}' did not return JSON:\n${redactShellSecrets(raw)}`,
      )
    }
  }

  private async lobbyHttp(command: string[], timeoutMs: number): Promise<string> {
    const body = [...command, '--json'].map(shellQuote).join(' ')
    if (this.verbose) process.stderr.write(`$ POST /exec  ${redactShellSecrets(body)}\n`)
    const res = await fetch(EXEC_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'text/plain' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(
        `exe.dev command failed: ${redactCommandForLog(command).join(' ')} (http ${res.status})\n${redactShellSecrets(text)}`,
      )
    }
    return text
  }

  private async lobbySsh(command: string[], timeoutMs: number): Promise<string> {
    const args = [
      ...sshBaseArgs(this.connectTimeoutSec),
      this.host,
      ...[...command, '--json'].map(shellQuote),
    ]
    const result = await runSsh(args, { verbose: this.verbose, timeoutMs })
    if (result.exitCode !== 0) {
      throw new Error(
        `exe.dev command failed: ${redactCommandForLog(command).join(' ')} (exit ${result.exitCode})\n${redactShellSecrets(result.stderr || result.stdout)}`,
      )
    }
    return result.stdout
  }

  /**
   * `share set-public` — expose the VM's portless HTTPS proxy without exe.dev
   * ingress auth. The proxy fronts the gateway (default-deny bearer auth),
   * which then owns the whole boundary — required for browser CORS preflights,
   * which can never carry the edge credential.
   */
  async setSharePublic(vmName: string): Promise<void> {
    await this.lobby(['share', 'set-public', vmName])
  }

  /** `whoami` — cheap check that auth is wired up. */
  async whoami(): Promise<unknown> {
    return this.lobby(['whoami'])
  }

  /** `new` — create (and boot) a VM. Returns once the lobby responds. */
  async create(options: CreateVmOptions = {}): Promise<ExeVm> {
    const command = ['new']
    if (options.name) command.push('--name', options.name)
    if (options.image) command.push('--image', options.image)
    if (options.pool) command.push('--pool', options.pool)
    if (options.cpu != null) command.push('--cpu', String(options.cpu))
    if (options.memory) command.push('--memory', options.memory)
    if (options.disk) command.push('--disk', options.disk)
    if (options.comment) command.push('--comment', options.comment)
    if (options.command) command.push('--command', options.command)
    if (options.registryAuth) command.push('--registry-auth', options.registryAuth)
    for (const tag of options.tags ?? []) command.push('--tag', tag)
    for (const env of options.env ?? []) command.push('--env', env)
    command.push('--no-email')
    return this.lobby<ExeVm>(command, CREATE_TIMEOUT_MS)
  }

  /** `cp` — copy a VM disk into a new VM. */
  async copy(sourceName: string, newName?: string, options: CopyVmOptions = {}): Promise<ExeVm> {
    const command = ['cp', sourceName]
    if (newName) command.push(newName)
    if (options.cpu != null) command.push('--cpu', String(options.cpu))
    if (options.memory) command.push('--memory', options.memory)
    if (options.disk) command.push('--disk', options.disk)
    /* `--copy-tags` is a BOOLEAN flag: exe.dev copies tags by default and only
       understands the disable form, `--copy-tags=false`. Passing it as two args
       (`--copy-tags true`) makes exe read `true` as the positional new-name and
       reject the whole command with `usage: cp <source-vm> [new-name]` -- which
       is what the weekly snapshot cron had been hitting. */
    if (options.copyTags === false) command.push('--copy-tags=false')
    return this.lobby<ExeVm>(command)
  }

  /**
   * Generate a token scoped to one VM's HTTPS proxy. The token value is returned
   * to the caller but never logged by this client.
   */
  async generateVmApiKey(vmName: string, label: string, exp = '1d'): Promise<string> {
    const out = await this.lobby<Record<string, unknown>>([
      'ssh-key',
      'generate-api-key',
      '--vm',
      vmName,
      '--label',
      label,
      '--exp',
      exp,
    ])
    for (const key of ['token', 'api_key', 'apiKey', 'key']) {
      const value = out[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    throw new Error(
      `VM API key response did not include a recognizable token field. Fields: ${Object.keys(out).join(', ')}`,
    )
  }

  /**
   * `shelley prompt` — send a prompt to the Shelley agent inside a VM. Returns
   * the conversation info when the lobby reports it. Shelley acts
   * asynchronously; observe its effects (e.g. a port coming up), don't wait on
   * a reply here.
   */
  async shelleyPrompt(vmName: string, prompt: string): Promise<unknown> {
    return this.lobby(['shelley', 'prompt', vmName, prompt])
  }

  /** `ssh-key remove` — remove an account SSH/API key by name or label. */
  async removeSshKey(name: string): Promise<void> {
    await this.lobby(['ssh-key', 'remove', name])
  }

  /**
   * `resize` — change a VM's cpu/memory/disk in place. Disk is **grow-only**:
   * the lobby rejects a `--disk` smaller than the current size.
   */
  async resize(name: string, options: ResizeVmOptions): Promise<unknown> {
    const command = ['resize', name]
    if (options.cpu != null) command.push(`--cpu=${options.cpu}`)
    if (options.memory) command.push(`--memory=${options.memory}`)
    if (options.disk) command.push(`--disk=${options.disk}`)
    return this.lobby(command)
  }

  /**
   * `stat` — CPU / memory / disk / IO metrics for a VM over a time range.
   *
   * Parse the result with `vmUsagePointsFromStat` rather than reading the wire
   * fields; this return type is the envelope, not a licence to spread
   * `cpu_cores` through the codebase.
   */
  async stat(name: string, range: '24h' | '7d' | '30d' = '24h'): Promise<ExeStatResponse> {
    return this.lobby<ExeStatResponse>(['stat', name, `--range=${range}`])
  }

  /** `restart` — reboot from the persistent disk (no memory restore). */
  async restart(name: string): Promise<void> {
    await this.lobby(['restart', name])
  }

  /** `rm` — delete a VM and its disk. */
  async remove(name: string): Promise<void> {
    await this.lobby(['rm', name])
  }

  /** `tag` — add one or more tags to a VM. */
  async tag(name: string, ...tags: string[]): Promise<void> {
    if (tags.length === 0) return
    await this.lobby(['tag', name, ...tags])
  }

  /** `ls` — list VMs. */
  async list(): Promise<ExeVm[]> {
    const out = await this.lobby<{ vms?: ExeVm[] } | ExeVm[]>(['ls'])
    return Array.isArray(out) ? out : (out.vms ?? [])
  }

  /** Current lobby-reported status for a VM, or null if it isn't listed. */
  async getStatus(name: string): Promise<string | null> {
    const vm = (await this.list()).find(v => v.vm_name === name)
    return vm?.status ?? null
  }

  /**
   * Poll `ls` until the lobby reports the VM `running`. Works over either
   * transport. Returns elapsed milliseconds. This is control-plane readiness,
   * not a proof that an in-VM shell is up (use waitUntilReady for that, SSH-only).
   */
  async waitUntilRunning(
    name: string,
    { timeoutMs = 180_000, intervalMs = 1_000 }: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<number> {
    const start = performance.now()
    const deadline = start + timeoutMs
    let last: string | null = null
    for (;;) {
      last = await this.getStatus(name)
      if (last === 'running') return performance.now() - start
      if (performance.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${name} to be 'running' (last status: ${last ?? 'not listed'}).`,
        )
      }
      await sleep(intervalMs)
    }
  }

  /**
   * Run a command *inside* a VM via `ssh <ssh_dest> -- <command>` (SSH-only;
   * `/exec` cannot reach inside a VM). Does not throw on failure — returns the
   * result so callers (e.g. the readiness poller) can inspect it.
   */
  async exec(
    sshDest: string,
    command: string,
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<ExecResult> {
    const args = [...sshBaseArgs(this.connectTimeoutSec), sshDest, '--', command]
    return runSsh(args, { verbose: this.verbose, timeoutMs })
  }

  /**
   * Poll `ssh <ssh_dest> true` until the VM answers, i.e. an in-VM shell is
   * usable (SSH-only). Returns elapsed milliseconds. Throws on timeout.
   */
  async waitUntilReady(
    sshDest: string,
    { timeoutMs = 120_000, intervalMs = 1_000 }: { timeoutMs?: number; intervalMs?: number } = {},
  ): Promise<number> {
    const start = performance.now()
    const deadline = start + timeoutMs
    for (;;) {
      const result = await this.exec(sshDest, 'true', this.connectTimeoutSec * 1000)
      if (result.exitCode === 0) {
        return performance.now() - start
      }
      if (performance.now() >= deadline) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for ${sshDest} to become SSH-ready. Last stderr:\n${result.stderr}`,
        )
      }
      await sleep(intervalMs)
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const SECRET_VALUE_FLAGS = new Set(['--registry-auth', '--env'])

function redactCommandForLog(args: string[]): string[] {
  const redacted: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (SECRET_VALUE_FLAGS.has(arg)) {
      redacted.push(arg)
      if (index + 1 < args.length) {
        redacted.push('[REDACTED]')
        index += 1
      }
      continue
    }
    const inlineFlag = [...SECRET_VALUE_FLAGS].find(flag => arg.startsWith(`${flag}=`))
    redacted.push(inlineFlag === undefined ? redactShellSecrets(arg) : `${inlineFlag}=[REDACTED]`)
  }
  return redacted
}

function redactShellSecrets(value: string): string {
  return value
    .replace(/(<<['"]?([A-Z0-9_]*TOKEN[A-Z0-9_]*)['"]?\n)[\s\S]*?(\n\2\b)/g, '$1[REDACTED]$3')
    .replace(/(--(?:registry-auth|env)(?:=|\s+))([^'"\s]+)/g, '$1[REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|API_KEY|AUTH)[A-Z0-9_]*=)([^'"\s]+)/gi, '$1[REDACTED]')
    .replace(/\bduet_sk_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\bsk-(?:proj|live|test)-[A-Za-z0-9_-]+/g, '[REDACTED]')
}
