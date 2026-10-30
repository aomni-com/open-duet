import { open } from 'node:fs/promises'
import { join } from 'node:path'

import {
  MAX_MARKETPLACE_AGENT_JSON_UTF8_BYTES,
  MAX_MARKETPLACE_AGENTS_MD_UTF8_BYTES,
  MAX_MARKETPLACE_CHANGELOG_UTF8_BYTES,
  MAX_MARKETPLACE_LISTING_SKILLS,
  MAX_MARKETPLACE_SKILL_NAME_UTF8_BYTES,
  skillNamesFromAgentPaths,
  utf8ByteLength,
  type ListingOriginSnapshot,
} from '@repo/contract'

import { collectPublishSubtree } from '../routes/publish-subtree'

export type ListingInspection =
  | {
      ok: true
      entries: number
      bytes: number
      origin: Omit<ListingOriginSnapshot, 'agentDisplayName'>
    }
  | { ok: false; error: 'listing_too_large' | 'listing_source_invalid' }

/**
 * Can this agent folder be listed, and what does its catalog entry say?
 *
 * One bounded pass answers both, **reusing `collectPublishSubtree`** — the walk
 * that already owns the serving floor, symlink exclusion and both recursive
 * bounds. A second walker here would be a second owner of "what does a publish
 * serve", and the bounds would drift the first time one side changed.
 *
 * This runs BEFORE any publish or listing row exists, so an oversized or
 * description-less agent is refused without ever having been public. It reads
 * only the two metadata files and the skills directory names out of the walk's
 * result — never the whole tree, and never the archive, so validating a 500 MiB
 * agent costs a stat sweep rather than half a gigabyte of transfer.
 */
export async function inspectListableAgent(options: {
  driveDir: string
  agentPath: string
}): Promise<ListingInspection> {
  const root = join(options.driveDir, options.agentPath)
  let subtree: Awaited<ReturnType<typeof collectPublishSubtree>>
  try {
    subtree = await collectPublishSubtree(root)
  } catch {
    // Missing folder, unreadable folder, or a path that is not a directory.
    return { ok: false, error: 'listing_source_invalid' }
  }
  if (!subtree.ok) return { ok: false, error: 'listing_too_large' }

  const files = subtree.entries.filter(entry => entry.kind === 'file')
  const bytes = files.reduce((total, entry) => total + entry.size, 0)
  const agentsMdEntry = files.find(entry => entry.relativePath === 'AGENTS.md')
  // An agent folder with no AGENTS.md has no prompt and no description: it is
  // not an agent, so it is not listable.
  if (agentsMdEntry === undefined) return { ok: false, error: 'listing_source_invalid' }

  const changelogEntry = files.find(entry => entry.relativePath === 'CHANGELOG.md')
  // The rule is shared with the seed's own snapshot producer: an agent must
  // not list different skills depending on whether we published it or a
  // stranger did.
  const skills = skillNamesFromAgentPaths(subtree.entries)

  // Carried raw for the same reason as the changelog: this snapshot transports
  // authored bytes, and `deriveListingMetadata` is the only thing that reads
  // them. A folder without one is ordinary, not an error.
  const agentJsonEntry = files.find(entry => entry.relativePath === 'agent.json')

  // The recursive walk bounds the whole tree, but these are the only files we
  // materialize during inspection. Refuse from stat metadata first so a single
  // catalog field cannot consume the archive allowance.
  if (
    agentsMdEntry.size > MAX_MARKETPLACE_AGENTS_MD_UTF8_BYTES ||
    (changelogEntry?.size ?? 0) > MAX_MARKETPLACE_CHANGELOG_UTF8_BYTES ||
    (agentJsonEntry?.size ?? 0) > MAX_MARKETPLACE_AGENT_JSON_UTF8_BYTES ||
    skills.length > MAX_MARKETPLACE_LISTING_SKILLS ||
    skills.some(name => utf8ByteLength(name) > MAX_MARKETPLACE_SKILL_NAME_UTF8_BYTES)
  ) {
    return { ok: false, error: 'listing_too_large' }
  }

  let agentsMd: string
  let changelogMd: string | null
  let agentJson: string | null
  try {
    ;[agentsMd, changelogMd, agentJson] = await Promise.all([
      readBoundedUtf8(agentsMdEntry.absolutePath, MAX_MARKETPLACE_AGENTS_MD_UTF8_BYTES),
      changelogEntry === undefined
        ? null
        : readBoundedUtf8(changelogEntry.absolutePath, MAX_MARKETPLACE_CHANGELOG_UTF8_BYTES),
      agentJsonEntry === undefined
        ? null
        : readBoundedUtf8(agentJsonEntry.absolutePath, MAX_MARKETPLACE_AGENT_JSON_UTF8_BYTES),
    ])
  } catch {
    // The descriptor-sized read is authoritative. A concurrent replacement,
    // growth, invalid UTF-8 sequence, or disappearance is a bounded refusal.
    return { ok: false, error: 'listing_source_invalid' }
  }

  return {
    ok: true,
    entries: subtree.entries.length,
    bytes,
    origin: {
      agentsMd,
      changelogMd,
      skills,
      agentJson,
    },
  }
}

async function readBoundedUtf8(path: string, maximumBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.allocUnsafe(maximumBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maximumBytes) throw new Error('metadata file exceeds byte bound')
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}
