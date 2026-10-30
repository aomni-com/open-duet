import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  deriveListingMetadata,
  skillNamesFromAgentPaths,
  type ListingDerivedMetadata,
  type ListingOriginSnapshot,
} from '@repo/contract'
import { readDeterministicContentTree } from '@repo/seed-drive/deterministic-bundle'

import { officialSeedAgents } from '../manifest'
import { OFFICIAL_SEED_CONTENT } from './content.generated'

const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'content')

/** A manifest agent plus the catalog metadata derived from its own bytes. */
export type OfficialSyncAgent = (typeof officialSeedAgents)[number] & {
  derived: ListingDerivedMetadata
}

export interface OfficialSyncPlan {
  files: ReadonlyArray<{ path: string; bytes: Uint8Array; sha256: string }>
  agents: readonly OfficialSyncAgent[]
}

/**
 * What the repo claims the hub should contain: the authored files that sit
 * beneath a manifest-declared agent root, and the registrations for those
 * agents.
 *
 * The MANIFEST is the only owner of "which agents are code-owned." Nothing
 * downstream — not the API route, not the gateway — may filter again or keep
 * its own list; they receive this plan already scoped. An agent dropped from
 * the manifest simply stops appearing here, which is what makes demotion mean
 * "stops being managed" rather than "gets deleted."
 */
export function buildOfficialSyncPlan(): OfficialSyncPlan {
  const origins = officialListingOrigins()
  return {
    files: scopeToManifest(loadOfficialSeedFiles(), officialSeedAgents),
    agents: officialSeedAgents.map(agent => {
      const origin = origins.get(agent.slug)
      const derived = origin === undefined ? undefined : deriveListingMetadata(origin)
      // Both failures mean the repo shipped an agent it cannot describe — a
      // missing AGENTS.md, or one whose first block is all headings. The seed
      // test refuses both, so reaching here is a bug in this package, and
      // throwing beats silently syncing an agent the catalog cannot render.
      if (derived === undefined || 'error' in derived) {
        throw new Error(`Official agent ${agent.slug} has no derivable listing metadata`)
      }
      return { ...agent, derived }
    }),
  }
}

/**
 * The seed's origin snapshot per agent — the same shape the gateway builds by
 * inspecting a remote folder, built instead from the bytes this package already
 * carries.
 *
 * Official agents are published by us from content we hold in-process, so
 * round-tripping them through a gateway inspection to learn what we already
 * know would add a network hop and a second failure mode. What must NOT differ
 * is the derivation: both snapshots feed `deriveListingMetadata`, and the skill
 * rule is shared rather than reimplemented here.
 *
 * These are the REPO's bytes, not the hub's, and reading them here rather than
 * inspecting the converged tree is what keeps the catalog free of a round-trip.
 * The two now agree by construction: a sync reaps what the plan no longer
 * claims, so a skill dropped from the repo leaves both the listing and the
 * hub.
 */
export function officialListingOrigins(): Map<string, ListingOriginSnapshot> {
  const files = new Map<string, Uint8Array>()
  for (const file of loadOfficialSeedFiles()) files.set(file.path, file.bytes)

  const decoder = new TextDecoder()
  const read = (path: string): string | null => {
    const bytes = files.get(path)
    return bytes === undefined ? null : decoder.decode(bytes)
  }

  const origins = new Map<string, ListingOriginSnapshot>()
  for (const agent of officialSeedAgents) {
    const root = `${agent.path.replace(/\/+$/, '')}/`
    const agentsMd = read(`${root}AGENTS.md`)
    // An agent folder with no AGENTS.md has no prompt and no description, so it
    // is not listable. Here that is a repo bug rather than a runtime condition:
    // the seed test refuses a manifest entry whose root lacks one.
    if (agentsMd === null) continue
    origins.set(agent.slug, {
      agentDisplayName: agent.name,
      agentsMd,
      changelogMd: read(`${root}CHANGELOG.md`),
      agentJson: read(`${root}agent.json`),
      // Only files exist here — the generated module stores bytes, not the
      // directories that contained them — so a skill is recognised through the
      // SKILL.md (or anything else) sitting inside it.
      skills: skillNamesFromAgentPaths(
        [...files.keys()].flatMap(path =>
          path.startsWith(root)
            ? [{ relativePath: path.slice(root.length), kind: 'file' as const }]
            : [],
        ),
      ),
    })
  }
  return origins
}

/**
 * Segment-safe containment: `agents/foo` owns `agents/foo/x` but NOT
 * `agents/foobar/x`. A plain `startsWith` would hand a neighbouring agent's
 * files to whichever root happened to share a string prefix.
 */
export function scopeToManifest<T extends { path: string }>(
  files: readonly T[],
  agents: readonly { path: string }[],
): T[] {
  const roots = agents.map(agent => `${agent.path.replace(/\/+$/, '')}/`)
  return files.filter(file => roots.some(root => file.path.startsWith(root)))
}

// The runtime loader decodes the generated module instead of walking
// content/ on disk: serverless packaging silently prunes dot-directories
// from runtime asset trees (the staging seed shipped without .agents/**),
// while bundled source always arrives whole. content/ stays the authoring
// source; the drift test pins the module to it.
export function loadOfficialSeedFiles(): Array<{
  path: string
  bytes: Uint8Array
  sha256: string
}> {
  return OFFICIAL_SEED_CONTENT.map(entry => {
    // Buffer base64, not Uint8Array.fromBase64: the API function runs on
    // Node (no fromBase64 yet); Bun-only APIs pass local tests and then
    // throw in the deployed runtime.
    const bytes = new Uint8Array(Buffer.from(entry.base64, 'base64'))
    return { path: entry.path, bytes, sha256: contentSha256(bytes) }
  })
}

// Reads the authored tree from disk — the generator and the drift test use
// this; runtime code never does.
export async function readOfficialSeedFilesFromDisk(): Promise<
  Array<{ path: string; bytes: Uint8Array; sha256: string }>
> {
  return (await readDeterministicContentTree(CONTENT_DIR)).flatMap(entry =>
    entry.bytes === null
      ? []
      : [{ path: entry.path, bytes: entry.bytes, sha256: contentSha256(entry.bytes) }],
  )
}

export async function renderGeneratedContentModule(): Promise<string> {
  const files = await readOfficialSeedFilesFromDisk()
  const rows = files
    .map(
      file =>
        `  { path: ${JSON.stringify(file.path)}, base64: ${JSON.stringify(Buffer.from(file.bytes).toString('base64'))} },`,
    )
    .join('\n')
  return `// Generated by \`bun run codegen\` from content/ — do not edit by hand.
// The drift test (seed.test.ts) fails when this file is stale.
export const OFFICIAL_SEED_CONTENT: ReadonlyArray<{ path: string; base64: string }> = [
${rows}
]
`
}

export function contentSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export { CONTENT_DIR }
export * from '../manifest'
