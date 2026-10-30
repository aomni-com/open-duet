import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  VmRegisterRequestSchema,
  VmRegisterResponseSchema,
  type VmRegisterRequest,
  type VmRegisterResponse,
} from '@repo/contract'

import type { NormalizedGatewayEnv } from '../runtime/env'
import { completePendingRestore, persistPendingRestore, type RestoreSuppression } from './archive'
import type { RestoreWindow } from './restore-window'

const TOKEN_FILE = 'vm-token'

export type RegisterResponse = VmRegisterResponse

export interface VmPhoneHomeOptions {
  config: NormalizedGatewayEnv
  setVmToken: (token: string) => void
  /** Restore-time attribution suppression (L6); omitted in local/dev gateways. */
  restoreSuppression?: RestoreSuppression
  restoreWindow: RestoreWindow
}

export interface VmPhoneHome {
  registerOnce(): Promise<RegisterResponse>
}

export function createVmPhoneHome(options: VmPhoneHomeOptions): VmPhoneHome {
  const { config } = options

  async function registerOnce(): Promise<RegisterResponse> {
    if (!config.provisioningToken || !config.apiUrl || !config.workspaceHint) {
      throw new Error('DUET_PROVISIONING_TOKEN, DUET_API_URL, and DUET_WORKSPACE_HINT are required')
    }
    const response = await config.fetch(`${config.apiUrl.replace(/\/+$/g, '')}/v1/vm/register`, {
      method: 'POST',
      headers: outboundHeaders(config.extraHeaders),
      body: JSON.stringify(
        VmRegisterRequestSchema.parse({
          provisioningToken: config.provisioningToken,
          workspaceHint: config.workspaceHint,
          runtimeVersion: config.runtimeVersion,
          imageVersion: config.imageVersion,
        } satisfies VmRegisterRequest),
      ),
    })
    if (!response.ok) throw new Error(`register failed with HTTP ${response.status}`)
    const body = VmRegisterResponseSchema.parse(await response.json())
    // A durable VM token lets restart proceed directly to sync. Record its
    // recovery prerequisite first so that restart cannot skip installation.
    if (body.restore) await persistPendingRestore(config.stateDir, body.restore)
    await persistVmToken(config.stateDir, body.vmToken)
    options.setVmToken(body.vmToken)
    if (body.restore) {
      const restore = () =>
        completePendingRestore({
          driveDir: config.driveDir,
          stateDir: config.stateDir,
          fetch: config.fetch,
          getVmToken: () => body.vmToken,
          extraHeaders: config.extraHeaders,
          runCommand: config.systemCommand,
          suppression: options.restoreSuppression,
        })
      await options.restoreWindow.run(restore)
    }
    return body
  }

  return { registerOnce }
}

export async function readVmToken(stateDir: string): Promise<string | null> {
  try {
    const token = (await readFile(tokenPath(stateDir), 'utf8')).trim()
    return token.length > 0 ? token : null
  } catch {
    return null
  }
}

export async function persistVmToken(stateDir: string, token: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const path = tokenPath(stateDir)
  await writeFile(path, `${token}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

function tokenPath(stateDir: string): string {
  return resolve(stateDir, TOKEN_FILE)
}

function outboundHeaders(extraHeaders: Record<string, string>): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...extraHeaders,
  }
}
