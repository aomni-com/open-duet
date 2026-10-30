import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import dotenv from 'dotenv'

import { DUET_API_ORIGIN } from '@repo/contract'

export const CONFIG_HOME_DIR_NAME = '.duet'
export const CONFIG_FILE_NAME = 'config.json'

export interface DuetConfig {
  apiKey?: string
  defaultWorkspace?: string
  apiUrl?: string
  machineId?: string
}

export function configPathForHome(home = homedir()): string {
  return join(home, CONFIG_HOME_DIR_NAME, CONFIG_FILE_NAME)
}

export async function loadConfig(path = configPathForHome()): Promise<DuetConfig> {
  let config: DuetConfig = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const value = parsed as Record<string, unknown>
      for (const field of ['apiKey', 'defaultWorkspace', 'apiUrl', 'machineId'] as const) {
        if (typeof value[field] === 'string') config[field] = value[field]
      }
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }

  // Transfer the old harness login before loading provider env files. Only the
  // saved user-global entry moves; project and explicit env files stay inputs.
  const legacyPath = join(dirname(path), '.env')
  try {
    const text = await readFile(legacyPath, 'utf8')
    const legacyKey = dotenv.parse(text).DUET_API_KEY
    if (legacyKey) {
      if (!config.apiKey) {
        config = { ...config, apiKey: legacyKey }
        await saveConfig(config, path)
      }
      await writeFile(
        legacyPath,
        text.replace(/^[ \t]*(?:export[ \t]+)?DUET_API_KEY[ \t]*=.*(?:\r?\n|$)/gm, ''),
        { mode: 0o600 },
      )
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') throw error
  }
  return config
}

export async function saveConfig(config: DuetConfig, path = configPathForHome()): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600)
}

export function effectiveApiUrl(
  config: DuetConfig,
  env: Record<string, string | undefined>,
  override?: string,
): string {
  const raw = override ?? env.DUET_API_URL ?? config.apiUrl ?? DUET_API_ORIGIN
  return raw.replace(/\/+$/, '')
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
