import { homedir } from 'node:os'

import { parseWorkspaceAddress, type FetchLike } from '@repo/contract'

import { configPathForHome, effectiveApiUrl, loadConfig, type DuetConfig } from './config.js'
import { EXIT_CODES, CliError, usageError } from './exit-codes.js'
import { ApiClient } from './http.js'

export interface CliResult {
  exitCode: number
}

export interface CliIo {
  stdout: WritableSink
  stderr: WritableSink
}

export type WritableSink = Pick<NodeJS.WriteStream, 'write'>

export interface CliRuntime {
  env?: Record<string, string | undefined>
  home?: string
  cwd?: string
  fetch?: FetchLike
  io?: CliIo
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export interface GlobalOptions {
  json: boolean
  help: boolean
  apiUrl?: string
  workspace?: string
}

export interface CommandContext {
  global: GlobalOptions
  config: DuetConfig
  configPath: string
  api: ApiClient
  io: CliIo
  sleep: (ms: number) => Promise<void>
  now: () => number
  fetch: FetchLike
  env: Record<string, string | undefined>
  cwd: string
  home: string
}

export type CommandHandler = (args: string[], ctx: CommandContext) => Promise<void>

export class CommandRegistry {
  readonly commands = new Map<string, CommandHandler>()

  register(name: string, handler: CommandHandler): void {
    if (this.commands.has(name)) throw new Error(`CLI command already registered: ${name}`)
    this.commands.set(name, handler)
  }

  async dispatch(args: string[], ctx: CommandContext): Promise<void> {
    const [command, ...rest] = args
    const handler = command === undefined ? undefined : this.commands.get(command)
    if (handler !== undefined) {
      await handler(rest, ctx)
      return
    }
    throw usageError(`Unknown command: ${command ?? ''}`)
  }
}

export async function createCommandContext(
  argv: string[],
  runtime: CliRuntime,
): Promise<{
  parsed: { global: GlobalOptions; args: string[] }
  ctx: CommandContext
  io: CliIo
}> {
  const io = runtime.io ?? { stdout: process.stdout, stderr: process.stderr }
  const env = runtime.env ?? process.env
  const home = runtime.home ?? env.HOME ?? homedir()
  const cwd = runtime.cwd ?? process.cwd()
  const fetchImpl = runtime.fetch ?? fetch
  const sleep =
    runtime.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = runtime.now ?? Date.now
  const parsed = parseGlobalOptions(argv)
  const configPath = configPathForHome(home)
  const config = await loadConfig(configPath)
  const apiUrl = effectiveApiUrl(config, env, parsed.global.apiUrl)
  return {
    parsed,
    io,
    ctx: {
      global: parsed.global,
      config,
      configPath,
      api: new ApiClient({
        baseUrl: apiUrl,
        apiKey: env.DUET_API_KEY ?? config.apiKey,
        fetch: fetchImpl,
      }),
      io,
      sleep,
      now,
      fetch: fetchImpl,
      env,
      cwd,
      home,
    },
  }
}

export function parseGlobalOptions(argv: string[]): { global: GlobalOptions; args: string[] } {
  const global: GlobalOptions = { json: false, help: false }
  const args: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!
    if (arg === '--json') {
      global.json = true
    } else if (arg === '--help' || arg === '-h') {
      global.help = true
    } else if (arg === '--workspace' || arg.startsWith('--workspace=')) {
      const value = arg === '--workspace' ? argv[++index] : arg.slice('--workspace='.length)
      if (!value || value.startsWith('--')) throw usageError('--workspace requires a value')
      if (global.workspace && global.workspace !== value)
        throw usageError('Conflicting workspace selections.')
      const parsedWorkspace = parseWorkspaceAddress(`${value}:/`, { allowRoot: true })
      if (!parsedWorkspace.ok) throw usageError(`Invalid workspace: ${value}`)
      global.workspace = value
    } else if (arg === '--api-url') {
      const value = argv[index + 1]
      if (value === undefined) throw usageError('--api-url requires a value')
      global.apiUrl = value
      index += 1
    } else if (arg.startsWith('--api-url=')) {
      global.apiUrl = arg.slice('--api-url='.length)
    } else {
      args.push(arg)
    }
  }
  return { global, args }
}

export function parseNamedOptions(
  args: string[],
  names: string[],
): { positionals: string[]; values: Record<string, string[]> } {
  const values: Record<string, string[]> = {}
  const positionals: string[] = []
  const allowed = new Set(names)
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const raw = arg.slice(2)
    const equals = raw.indexOf('=')
    const rawName = equals === -1 ? raw : raw.slice(0, equals)
    const inlineValue = equals === -1 ? undefined : raw.slice(equals + 1)
    if (rawName === undefined || !allowed.has(rawName))
      throw usageError(`Unknown option: --${rawName ?? ''}`)
    const value = inlineValue ?? args[index + 1]
    if (value === undefined) throw usageError(`--${rawName} requires a value`)
    values[rawName] = [...(values[rawName] ?? []), value]
    if (inlineValue === undefined) index += 1
  }
  return { positionals, values }
}

export function resolveAddress(
  input: string,
  defaultWorkspace: string | undefined,
  allowRoot: boolean,
  explicitWorkspace?: string,
): { workspaceSlug: string; path: string } {
  const parsed = parseWorkspaceAddress(input, {
    defaultWorkspace: explicitWorkspace ?? defaultWorkspace,
    allowRoot,
  })
  if (!parsed.ok) throw usageError(`Invalid workspace address (${parsed.reason}): ${input}`)
  if (explicitWorkspace && parsed.address.workspaceSlug !== explicitWorkspace)
    throw usageError('Address and --workspace name different workspaces.')
  return parsed.address
}

export function filePath(address: { workspaceSlug: string; path: string }): string {
  const encodedPath =
    address.path === '/'
      ? ''
      : `/${address.path
          .slice(1)
          .split('/')
          .map(segment => encodeURIComponent(segment))
          .join('/')}`
  return `/ws/${encodeURIComponent(address.workspaceSlug)}/files${encodedPath}`
}

export function requireDefaultWorkspace(config: DuetConfig): string {
  if (config.defaultWorkspace === undefined || config.defaultWorkspace.length === 0) {
    throw usageError('No default workspace set. Use workspace use <slug> or pass workspace:/path.')
  }
  return config.defaultWorkspace
}

/** Normalize an operation target without modifying saved defaults. */
export function resolveWorkspace(
  ctx: {
    global: { workspace?: string }
    config: DuetConfig
    env?: Record<string, string | undefined>
  },
  positional?: string,
): string {
  if (positional && ctx.global.workspace && positional !== ctx.global.workspace) {
    throw usageError('Argument and --workspace name different workspaces.')
  }
  return resolveAddress(
    `${positional ?? ctx.global.workspace ?? ctx.env?.DUET_WORKSPACE ?? requireDefaultWorkspace(ctx.config)}:/`,
    undefined,
    true,
  ).workspaceSlug
}

export async function printJsonOrHuman(
  response: Response,
  ctx: CommandContext,
  human?: (body: unknown) => string,
): Promise<void> {
  const body = await responseJson(response)
  if (ctx.global.json) {
    writeJson(ctx.io.stdout, body)
    return
  }
  writeText(ctx.io.stdout, human?.(body) ?? `${JSON.stringify(body, null, 2)}\n`)
}

export function printResult(
  ctx: CommandContext,
  json: Record<string, unknown>,
  human: string,
): void {
  if (ctx.global.json) writeJson(ctx.io.stdout, json)
  else writeText(ctx.io.stdout, human)
}

export async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export function ensureArgCount(args: string[], expected: number, usage: string): void {
  if (args.length !== expected) throw usageError(`Usage: ${usage}`)
}

export function ensureNoArgs(args: string[], usage: string): void {
  if (args.length !== 0) throw usageError(`Usage: ${usage}`)
}

export function hasJsonFlag(argv: string[]): boolean {
  return argv.includes('--json')
}

export function writeJson(sink: WritableSink, value: unknown): void {
  writeText(sink, `${JSON.stringify(value)}\n`)
}

export function writeText(sink: WritableSink, text: string): void {
  sink.write(text)
}

export function writeChunk(sink: WritableSink, chunk: Uint8Array): void {
  sink.write(Buffer.from(chunk))
}

export function redactDetails(details: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(details)) {
    if (/token|key|authorization/i.test(key)) continue
    redacted[key] = value
  }
  return redacted
}

export function cliErrorFromUnknown(error: unknown): CliError {
  return error instanceof CliError
    ? error
    : new CliError(
        'internal_error',
        error instanceof Error ? error.message : 'Unexpected error.',
        EXIT_CODES.generic,
      )
}
