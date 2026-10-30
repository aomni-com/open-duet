import {
  FileListResponseSchema,
  FileOperationResponseSchema,
  FileWriteResponseSchema,
  RegisterAgentResponseSchema,
  type FileListResponse,
  type RegisterAgentResponse,
} from '@repo/contract'
import { scopeToManifest, type OfficialSeedAgent } from '@repo/official-agents-seed'

const WRITE_CONCURRENCY = 6

export interface OfficialAgentWorkspaceSeedFile {
  path: string
  bytes: Uint8Array
}

export interface OfficialAgentWorkspaceLoadResult {
  sourceAgent: OfficialSeedAgent
  reset: 'kept' | 'fresh' | 'reset'
  fileCount: number
  registered: RegisterAgentResponse
}

/**
 * Push generated official-agent content into an already-authenticated
 * workspace. The caller owns identity, VM readiness, output, and cleanup;
 * this boundary owns only reset, transfer, and registration.
 */
export async function loadOfficialAgentsIntoWorkspace(args: {
  apiUrl: string
  workspaceSlug: string
  token: string
  seedFiles: readonly OfficialAgentWorkspaceSeedFile[]
  agents: readonly OfficialSeedAgent[]
  reset: boolean
}): Promise<OfficialAgentWorkspaceLoadResult[]> {
  const apiUrl = args.apiUrl.replace(/\/+$/, '')
  const results: OfficialAgentWorkspaceLoadResult[] = []

  for (const sourceAgent of args.agents) {
    const files = scopeToManifest(args.seedFiles, [sourceAgent])
    if (files.length === 0) {
      throw new Error(
        `No authored files under ${sourceAgent.path} in the generated content module — run \`bun run codegen\` in packages/official-agents-seed`,
      )
    }

    const reset = args.reset
      ? await resetAgentFolder(apiUrl, args.workspaceSlug, args.token, sourceAgent.path)
      : 'kept'
    await writeAgentFiles(apiUrl, args.workspaceSlug, args.token, files)
    const registered = await registerAgent(apiUrl, args.workspaceSlug, args.token, sourceAgent)
    results.push({ sourceAgent, reset, fileCount: files.length, registered })
  }

  return results
}

async function resetAgentFolder(
  apiUrl: string,
  workspaceSlug: string,
  token: string,
  path: string,
): Promise<'fresh' | 'reset'> {
  const entries = await listDirectory(apiUrl, workspaceSlug, token, path)
  if (entries === null) return 'fresh'
  // Registration heals the anchor removed with this tree, so reset does not
  // need a separate marker-preservation or reanchor protocol.
  await deleteTree(apiUrl, workspaceSlug, token, path)
  return 'reset'
}

async function deleteTree(
  apiUrl: string,
  workspaceSlug: string,
  token: string,
  path: string,
): Promise<void> {
  const response = await fetch(`${workspaceFilesUrl(apiUrl, workspaceSlug)}/actions`, {
    method: 'POST',
    headers: bearerJson(token),
    body: JSON.stringify({ operation: 'delete', path, recursive: true }),
  })
  if (response.ok) {
    FileOperationResponseSchema.parse(await response.json())
    return
  }
  if (response.status === 404) return

  const body = await response.text()
  if (response.status === 409 && body.includes('recursive_limit_exceeded')) {
    // The API deliberately bounds recursive work. Divide an oversized tree at
    // its children, then retry the now-empty root through the same public API.
    for (const entry of (await listDirectory(apiUrl, workspaceSlug, token, path)) ?? []) {
      if (entry.type === 'directory') {
        await deleteTree(apiUrl, workspaceSlug, token, entry.path)
      } else {
        await deletePath(apiUrl, workspaceSlug, token, entry.path)
      }
    }
    await deleteTree(apiUrl, workspaceSlug, token, path)
    return
  }
  throw new Error(`POST /files/actions delete ${path} failed: ${response.status} ${body}`)
}

async function listDirectory(
  apiUrl: string,
  workspaceSlug: string,
  token: string,
  path: string,
): Promise<FileListResponse['items'] | null> {
  const items: FileListResponse['items'] = []
  let cursor: string | null = null
  do {
    const query = new URLSearchParams({ list: '1', limit: '100' })
    if (cursor !== null) query.set('cursor', cursor)
    const response = await fetch(
      `${workspaceFilesUrl(apiUrl, workspaceSlug)}/${encodeDrivePath(path)}?${query}`,
      { headers: bearer(token) },
    )
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(
        `GET /files/${path}?list=1 failed: ${response.status} ${await response.text()}`,
      )
    }
    const page = FileListResponseSchema.parse(await response.json())
    items.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== null)
  return items
}

async function deletePath(
  apiUrl: string,
  workspaceSlug: string,
  token: string,
  path: string,
): Promise<void> {
  const response = await fetch(`${workspaceFilesUrl(apiUrl, workspaceSlug)}/actions`, {
    method: 'POST',
    headers: bearerJson(token),
    body: JSON.stringify({ operation: 'delete', path, recursive: false }),
  })
  if (response.ok) {
    FileOperationResponseSchema.parse(await response.json())
    return
  }
  if (response.status === 404) return
  throw new Error(
    `POST /files/actions delete ${path} failed: ${response.status} ${await response.text()}`,
  )
}

async function writeAgentFiles(
  apiUrl: string,
  workspaceSlug: string,
  token: string,
  files: readonly OfficialAgentWorkspaceSeedFile[],
): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const file = files[next]
      next += 1
      if (file === undefined) return
      const response = await apiFetch(
        `${workspaceFilesUrl(apiUrl, workspaceSlug)}/${encodeDrivePath(file.path)}`,
        { method: 'PUT', headers: bearer(token), body: Uint8Array.from(file.bytes) },
      )
      FileWriteResponseSchema.parse(await response.json())
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(WRITE_CONCURRENCY, files.length) }, () => worker()),
  )
}

async function registerAgent(
  apiUrl: string,
  workspaceSlug: string,
  token: string,
  agent: OfficialSeedAgent,
): Promise<RegisterAgentResponse> {
  const response = await apiFetch(`${apiUrl}/v1/ws/${encodeURIComponent(workspaceSlug)}/agents`, {
    method: 'POST',
    headers: bearerJson(token),
    body: JSON.stringify({
      path: agent.path,
      slug: agent.slug,
      name: agent.name,
      ...(agent.icon === undefined ? {} : { icon: agent.icon }),
      ...(agent.apps === undefined ? {} : { apps: agent.apps }),
    }),
  })
  return RegisterAgentResponseSchema.parse(await response.json())
}

function workspaceFilesUrl(apiUrl: string, workspaceSlug: string): string {
  return `${apiUrl}/v1/ws/${encodeURIComponent(workspaceSlug)}/files`
}

function encodeDrivePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function bearer(token: string, headers?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...headers }
}

function bearerJson(token: string): Record<string, string> {
  return bearer(token, { 'content-type': 'application/json' })
}

async function apiFetch(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(
      `${init.method ?? 'GET'} ${url} failed: ${response.status} ${await response.text()}`,
    )
  }
  return response
}
