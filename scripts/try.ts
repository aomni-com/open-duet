/**
 * `bun run try <slug> [...] [--all] [--keep]` — take an authored official agent
 * from packages/official-agents-seed/content/ straight into a real staging
 * workspace, through the documented public API, and print the URL to open.
 *
 * Identity is a stable dedicated user (agent-lab@duet.so) minted via
 * `POST /v1/admin/login-as` with `create: true` and NOT ephemeral — an
 * ephemeral identity is swept along with its workspaces, which would destroy
 * the durable workspace this command reuses across runs.
 *
 * By default each target agent's folder is wiped before pushing so a run
 * starts clean; `--keep` overwrites files in place instead, so an onboarded
 * agent's prior artifacts survive.
 *
 * Run through the package.json entry so dotenvx loads .env.staging:
 *   bun run try seo-specialist
 *   bun run try account-researcher editor
 *   bun run try --all --keep
 */

import { AdminLoginAsResponseSchema, type AdminLoginAsResponse } from '@repo/contract'
import {
  loadOfficialSeedFiles,
  officialSeedAgents,
  readOfficialSeedFilesFromDisk,
  scopeToManifest,
  type OfficialSeedAgent,
} from '@repo/official-agents-seed'
import { loadOfficialAgentsIntoWorkspace } from '@repo/test-harness/official-agent-workspace'

const AGENT_LAB_EMAIL = 'agent-lab@duet.so'
const AGENT_LAB_NAME = 'Agent Lab'
const LOGIN_TTL_SECONDS = 60 * 60
const WORKSPACE_READY_TIMEOUT_MS = 10 * 60_000
const WORKSPACE_READY_POLL_MS = 3_000

interface TryOptions {
  agents: OfficialSeedAgent[]
  keep: boolean
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

async function main(argv: string[]): Promise<void> {
  const options = parseArguments(argv)
  const apiUrl = requiredEnvironment('DUET_API_URL').replace(/\/+$/, '')
  const appUrl = requiredEnvironment('DUET_APP_URL').replace(/\/+$/, '')
  const loginSecret = requiredEnvironment('DUET_PROGRAMMATIC_LOGIN_SECRET')

  const login = await loginAsAgentLab(apiUrl, loginSecret)
  const workspaceSlug = login.workspaceSlug
  console.log(`${AGENT_LAB_EMAIL} → workspace ${workspaceSlug}${login.created ? ' (created)' : ''}`)
  await waitForWorkspaceUsable(apiUrl, workspaceSlug, login.token)

  // The generated content module is the same byte source the hub sync reads —
  // never a re-walk of content/ from disk (serverless packaging taught us the
  // two can differ). Which is exactly why a fresh edit to content/ must be
  // refused rather than silently ignored: until codegen runs, the module still
  // carries yesterday's bytes.
  const seedFiles = loadOfficialSeedFiles()
  await assertGeneratedContentFresh(seedFiles, options.agents)
  for (const agent of options.agents) {
    const [loaded] = await loadOfficialAgentsIntoWorkspace({
      apiUrl,
      workspaceSlug,
      token: login.token,
      seedFiles,
      agents: [agent],
      reset: !options.keep,
    })
    if (loaded === undefined) throw new Error(`Official agent ${agent.slug} was not loaded`)
    const registered = loaded.registered
    // Report the apps the API SAYS it registered — never a count derived from
    // the manifest we sent, which once printed success while a staging API was
    // silently discarding the whole array.
    const appsNote =
      registered.apps.length === 0
        ? ''
        : ` — apps: ${registered.apps.map(app => `${app.slug} (${app.status})`).join(', ')}`
    // Mirrors the SPA's per-agent URL grammar (apps/web/spa/drive/agents-map-url.ts,
    // `agentsMapUrl` with an `agent` place) — that module lives inside the web
    // app and is not importable from a repo script.
    const url = `${appUrl}/w/${encodeURIComponent(workspaceSlug)}/agents/${encodeURIComponent(registered.agent.slug)}`
    console.log(
      `${agent.slug}: ${loaded.reset}, ${loaded.fileCount} files, registered${appsNote} → ${url}`,
    )
  }
}

function parseArguments(argv: string[]): TryOptions {
  let all = false
  let keep = false
  const slugs: string[] = []
  for (const argument of argv) {
    if (argument === '--all') all = true
    else if (argument === '--keep') keep = true
    else if (argument.startsWith('-')) throw new Error(`Unknown flag ${argument}\n\n${usage()}`)
    else slugs.push(argument)
  }
  if (all && slugs.length > 0) throw new Error(`--all takes no slugs\n\n${usage()}`)
  if (!all && slugs.length === 0) throw new Error(usage())

  if (all) return { agents: [...officialSeedAgents], keep }
  const bySlug = new Map(officialSeedAgents.map(agent => [agent.slug, agent]))
  const agents = [...new Set(slugs)].map(slug => {
    const agent = bySlug.get(slug)
    if (agent === undefined) {
      throw new Error(
        `Unknown official agent "${slug}". Available: ${officialSeedAgents.map(entry => entry.slug).join(', ')}`,
      )
    }
    return agent
  })
  return { agents, keep }
}

/**
 * The push serves the generated module's bytes, so an authored edit that has
 * not been through codegen would go out stale — and look like the edit did
 * nothing. Compare the module against content/ for the targeted agents and
 * refuse to push drift.
 */
async function assertGeneratedContentFresh(
  seedFiles: ReadonlyArray<{ path: string; sha256: string }>,
  agents: readonly OfficialSeedAgent[],
): Promise<void> {
  const authored = await readOfficialSeedFilesFromDisk()
  const digest = (files: ReadonlyArray<{ path: string; sha256: string }>) =>
    new Map(files.map(file => [file.path, file.sha256]))
  const generated = digest(scopeToManifest(seedFiles, agents))
  const disk = digest(scopeToManifest(authored, agents))
  const stale =
    generated.size !== disk.size ||
    [...disk].some(([path, sha256]) => generated.get(path) !== sha256)
  if (stale) {
    throw new Error(
      'content/ has edits the generated module does not carry — run `bun run codegen` in packages/official-agents-seed, then re-run',
    )
  }
}

function usage(): string {
  return 'Usage: bun run try <slug> [<slug> ...] [--keep] | bun run try --all [--keep]'
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (value === undefined || value === '') {
    throw new Error(`Missing ${name} — run through \`bun run try\` so dotenvx loads .env.staging`)
  }
  return value
}

async function loginAsAgentLab(apiUrl: string, loginSecret: string): Promise<AdminLoginAsResponse> {
  const response = await apiFetch(`${apiUrl}/v1/admin/login-as`, {
    method: 'POST',
    headers: { authorization: `Bearer ${loginSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: AGENT_LAB_EMAIL,
      name: AGENT_LAB_NAME,
      create: true,
      ttlSeconds: LOGIN_TTL_SECONDS,
    }),
  })
  return AdminLoginAsResponseSchema.parse(await response.json())
}

/**
 * Usable means the workspace VM answers through the public files surface,
 * because every write this command makes goes through that proxy. The proxy's
 * answers are typed: `409 workspace_provisioning` means the gateway is not
 * registered yet and is safe to retry; `503 workspace_unhealthy` needs
 * recovery and fails immediately. Untyped 502/503/504 responses are wake
 * blips, and a 200 proves the drive is writable.
 */
async function waitForWorkspaceUsable(
  apiUrl: string,
  workspaceSlug: string,
  token: string,
): Promise<void> {
  const deadline = Date.now() + WORKSPACE_READY_TIMEOUT_MS
  let announced = false
  const waitOrTimeOut = async (last: string): Promise<void> => {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${Math.round(WORKSPACE_READY_TIMEOUT_MS / 60_000)}m waiting for workspace ${workspaceSlug} (last: ${last})`,
      )
    }
    if (!announced) {
      console.log(`waiting for workspace ${workspaceSlug} (first provision can take a few minutes)`)
      announced = true
    }
    await Bun.sleep(WORKSPACE_READY_POLL_MS)
  }

  for (;;) {
    const response = await fetch(
      `${apiUrl}/v1/ws/${encodeURIComponent(workspaceSlug)}/files?list=1`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    if (response.status === 200) return
    const body = await response.text()
    if (response.status === 503 && body.includes('workspace_unhealthy')) {
      throw new Error(`Workspace ${workspaceSlug} is unhealthy and needs recovery`)
    }
    const provisioning = response.status === 409 && body.includes('workspace_provisioning')
    if (!provisioning && ![502, 503, 504].includes(response.status)) {
      throw new Error(`Workspace probe failed: GET /files?list=1 → ${response.status} ${body}`)
    }
    await waitOrTimeOut(provisioning ? 'workspace_provisioning' : `files probe ${response.status}`)
  }
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
