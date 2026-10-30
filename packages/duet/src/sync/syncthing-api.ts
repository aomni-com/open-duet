// Minimal client for the LOCAL Mac Syncthing admin API (spec
// file-attribution slice 21). MAP-SYNC L14: this API is a single-tenant admin
// surface bound to loopback — the supervisor is its only consumer on the Mac,
// exactly as the gateway is on the VM. Nothing here is ever exposed, proxied,
// or handed a non-loopback base. The whole-config GET/PUT reconcile mirrors the
// VM's config coordinator; we do not reach for the VM's Syncthing API — the
// two sides each speak only to their own loopback instance.

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface SyncthingApi {
  base: string
  apiKey: string
  fetch: FetchLike
}

export interface SyncthingDevice {
  deviceID: string
  name?: string
  addresses?: string[]
  paused?: boolean
}

export interface SyncthingFolderDeviceRef {
  deviceID: string
}

export interface SyncthingFolder {
  id: string
  label?: string
  path: string
  type?: string
  devices?: SyncthingFolderDeviceRef[]
  fsWatcherEnabled?: boolean
  fsWatcherDelayS?: number
  ignorePerms?: boolean
  maxConflicts?: number
}

export interface SyncthingConfig {
  devices?: SyncthingDevice[]
  folders?: SyncthingFolder[]
  options?: Record<string, unknown>
  gui?: Record<string, unknown>
}

export interface SyncthingSystemStatus {
  myID?: string
}

export interface SyncthingFolderStatus {
  state?: string
  needBytes?: number
  needItems?: number
  globalBytes?: number
  // Syncthing counts the index as separate file/dir/symlink totals plus a
  // combined `globalTotalItems`; there is no `globalItems`.
  globalTotalItems?: number
  globalFiles?: number
  localBytes?: number
  errors?: number
}

export interface SyncthingCompletion {
  completion?: number
  needBytes?: number
  needItems?: number
}

export interface SyncthingConnections {
  connections?: Record<string, { connected?: boolean; address?: string }>
}

function headers(api: SyncthingApi): Record<string, string> {
  return { 'x-api-key': api.apiKey, 'content-type': 'application/json' }
}

async function getJson<T>(api: SyncthingApi, path: string): Promise<T> {
  const response = await api.fetch(`${api.base}${path}`, { headers: headers(api) })
  if (!response.ok) {
    throw new Error(`Syncthing GET ${path} failed with HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

export async function ping(api: SyncthingApi): Promise<boolean> {
  try {
    const response = await api.fetch(`${api.base}/rest/system/ping`, { headers: headers(api) })
    return response.ok
  } catch {
    return false
  }
}

export async function systemStatus(api: SyncthingApi): Promise<SyncthingSystemStatus> {
  return getJson<SyncthingSystemStatus>(api, '/rest/system/status')
}

export async function myDeviceId(api: SyncthingApi): Promise<string> {
  const status = await systemStatus(api)
  if (typeof status.myID !== 'string' || status.myID.length === 0) {
    throw new Error('Syncthing did not report a device ID')
  }
  return status.myID
}

export async function getConfig(api: SyncthingApi): Promise<SyncthingConfig> {
  return getJson<SyncthingConfig>(api, '/rest/config')
}

export async function putConfig(api: SyncthingApi, config: SyncthingConfig): Promise<void> {
  const response = await api.fetch(`${api.base}/rest/config`, {
    method: 'PUT',
    headers: headers(api),
    body: JSON.stringify(config),
  })
  if (!response.ok) {
    throw new Error(`Syncthing config write failed with HTTP ${response.status}`)
  }
}

/** Read-modify-write the whole config (the VM's reconcile shape). */
export async function updateConfig(
  api: SyncthingApi,
  update: (config: SyncthingConfig) => void,
): Promise<void> {
  const config = await getConfig(api)
  update(config)
  await putConfig(api, config)
}

export async function setFolderIgnores(
  api: SyncthingApi,
  folderId: string,
  patterns: readonly string[],
): Promise<void> {
  const response = await api.fetch(
    `${api.base}/rest/db/ignores?folder=${encodeURIComponent(folderId)}`,
    {
      method: 'POST',
      headers: headers(api),
      body: JSON.stringify({ ignore: [...patterns] }),
    },
  )
  if (!response.ok) {
    throw new Error(`Syncthing ignore write failed with HTTP ${response.status}`)
  }
}

export async function folderStatus(
  api: SyncthingApi,
  folderId: string,
): Promise<SyncthingFolderStatus> {
  return getJson<SyncthingFolderStatus>(
    api,
    `/rest/db/status?folder=${encodeURIComponent(folderId)}`,
  )
}

export async function completion(
  api: SyncthingApi,
  folderId: string,
  deviceId: string,
): Promise<SyncthingCompletion> {
  return getJson<SyncthingCompletion>(
    api,
    `/rest/db/completion?folder=${encodeURIComponent(folderId)}&device=${encodeURIComponent(deviceId)}`,
  )
}

export async function connections(api: SyncthingApi): Promise<SyncthingConnections> {
  return getJson<SyncthingConnections>(api, '/rest/system/connections')
}

export async function scanFolder(api: SyncthingApi, folderId: string): Promise<void> {
  const response = await api.fetch(
    `${api.base}/rest/db/scan?folder=${encodeURIComponent(folderId)}`,
    { method: 'POST', headers: headers(api) },
  )
  if (!response.ok && response.status !== 500) {
    throw new Error(`Syncthing scan failed with HTTP ${response.status}`)
  }
}
