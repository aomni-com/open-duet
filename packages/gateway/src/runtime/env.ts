import { resolve } from 'node:path'

import {
  DEFAULT_MEMORY_LOCK_WAIT_MS,
  DRIVE_ROOT_PATH,
  DUET_STATE_DIR_PATH,
  assertPathOutsideDriveRoot,
} from '@repo/contract'

import packageJson from '../../package.json'
import type { AgentRelayEvent } from '../agent-sessions/coordinator'
import type { SpawnHelper } from '../attribution/helper-supervisor'
import type { ConnectCommandRunner } from '../connected-providers/connect-session'
import type { DuetCliRunner } from '../duet-cli'
import type { KasmCredential } from '../routes/desktop'
import type { AgentRunnerFactory, FetchLike } from '../runner/process-runner'
import {
  DEFAULT_CURRENT_RELEASE_LINK,
  DEFAULT_RUNTIME_UPDATE_MAX_DEFER_MS,
  DEFAULT_RELEASES_DIR,
} from '../runtime-update'
import type { SystemCommandRunner } from '../system-command'
import type { TrainRunner } from '../train-runner'
import { RUNNING_RUNTIME } from './paths'

export const GATEWAY_VERSION = packageJson.version
export const DEFAULT_STATE_DIR = DUET_STATE_DIR_PATH
export const DEFAULT_DRIVE_DIR = DRIVE_ROOT_PATH
export const DEFAULT_UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000

export interface GatewayEnv {
  instanceId?: string
  provisioningToken?: string
  apiUrl?: string
  /** The port this gateway serves on; how a runner on this VM addresses it. */
  port?: number
  workspaceHint?: string
  stateDir?: string
  driveDir?: string
  runtimeVersion?: string
  imageVersion?: string
  webAppOrigin?: string
  uploadTokenTtlMs?: number
  memoryDbPath?: string
  memoryLockWaitMs?: number
  duetRunner?: DuetCliRunner
  trainRunner?: TrainRunner
  agentRunnerFactory?: AgentRunnerFactory
  agentRelayEvent?: AgentRelayEvent
  syncthingApiUrl?: string
  syncthingApiKey?: string
  /** Syncthing initialization retry timer; injectable for tests. */
  syncthingRetryDelay?: (ms: number) => Promise<void>
  extraHeaders?: Record<string, string>
  releasesDir?: string
  currentReleaseLink?: string
  runtimeUpdateMaxDeferMs?: number
  /** Privileged attribution-helper process boundary; injectable for tests. */
  helperSpawn?: SpawnHelper
  /** VM service control (systemctl via sudo); injectable for tests. */
  systemCommand?: SystemCommandRunner
  /** Connected-provider CLI process boundary; injectable for streamed route and sync tests. */
  connectedProviderRunCommand?: ConnectCommandRunner
  exit?: (code: number) => void
  fetch?: FetchLike
  desktopFetch?: (request: Request) => Promise<Response>
  readKasmCredential?: () => Promise<KasmCredential>
  now?: () => number
}

export type NormalizedGatewayEnv = Required<
  Pick<
    GatewayEnv,
    | 'stateDir'
    | 'driveDir'
    | 'runtimeVersion'
    | 'imageVersion'
    | 'extraHeaders'
    | 'releasesDir'
    | 'currentReleaseLink'
    | 'runtimeUpdateMaxDeferMs'
    | 'exit'
    | 'fetch'
    | 'now'
  >
> &
  Omit<
    GatewayEnv,
    | 'stateDir'
    | 'driveDir'
    | 'runtimeVersion'
    | 'imageVersion'
    | 'extraHeaders'
    | 'releasesDir'
    | 'currentReleaseLink'
    | 'runtimeUpdateMaxDeferMs'
    | 'exit'
    | 'fetch'
    | 'now'
  > & {
    memoryDbPath: string
    memoryLockWaitMs: number
    webAppOrigin?: string
    uploadTokenTtlMs: number
  }

export function normalizeEnv(env: GatewayEnv): NormalizedGatewayEnv {
  const driveDir = env.driveDir ?? DEFAULT_DRIVE_DIR
  const stateDir = env.stateDir ?? DEFAULT_STATE_DIR
  return {
    ...env,
    stateDir,
    driveDir,
    runtimeVersion: RUNNING_RUNTIME.version ?? env.runtimeVersion ?? GATEWAY_VERSION,
    imageVersion: env.imageVersion ?? '0.0.0',
    webAppOrigin: normalizeOrigin(env.webAppOrigin),
    uploadTokenTtlMs: env.uploadTokenTtlMs ?? DEFAULT_UPLOAD_TOKEN_TTL_MS,
    // This must equal the duet CLI's DEFAULT_MEMORY_DB_PATH (~/.duet/memory.db) when
    // stateDir is ~/.duet. The old memory.sqlite name stranded trained memories in a
    // file the agent never reads.
    memoryDbPath: assertPathOutsideDriveRoot(
      env.memoryDbPath ?? resolve(stateDir, 'memory.db'),
      driveDir,
    ),
    memoryLockWaitMs: env.memoryLockWaitMs ?? DEFAULT_MEMORY_LOCK_WAIT_MS,
    extraHeaders: env.extraHeaders ?? {},
    releasesDir: env.releasesDir ?? DEFAULT_RELEASES_DIR,
    currentReleaseLink: env.currentReleaseLink ?? DEFAULT_CURRENT_RELEASE_LINK,
    runtimeUpdateMaxDeferMs: env.runtimeUpdateMaxDeferMs ?? DEFAULT_RUNTIME_UPDATE_MAX_DEFER_MS,
    exit: env.exit ?? process.exit,
    fetch: env.fetch ?? fetch,
    now: env.now ?? Date.now,
  }
}

function normalizeOrigin(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined
  return value.replace(/\/+$/, '')
}

export function parseExtraHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (raw === undefined || raw.trim().length === 0) return undefined
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string') headers[name] = value
  }
  return headers
}
