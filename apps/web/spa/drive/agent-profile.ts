import { queryOptions } from '@tanstack/react-query'

import type { Agent, FileEntry, FileListResponse } from '@repo/contract'

import { DuetApiError } from '../api/client'
import { duetQueryKeys } from '../api/query-keys'
import { collectionPagesQueryOptions } from '../api/query-options'
import type { SpaApi } from '../context'

export type AgentSkillsPage = { items: string[]; nextCursor: string | null }

// Both files are addressed relative to the agent anchor; the drive root is empty.
const AGENTS_FILE = 'AGENTS.md'
const SKILLS_DIR = '.agents/skills'

// Hold agent-authored files warm across ordinary navigation.
const AGENT_FILES_STALE_TIME_MS = 5 * 60_000

export type AgentSkillsApi = Pick<SpaApi, 'listOptionalWorkspaceFiles'>
export type AgentRoleApi = Pick<SpaApi, 'readOptionalWorkspaceFile'>

/**
 * The agent's whole `AGENTS.md`, for the surface that renders it rather than
 * just its first prose line.
 *
 * It lives here, beside the role read, because the two address the same file
 * and only {@link joinDrivePath} knows how to address it at the drive root —
 * where the naive `` `${anchorPath}/AGENTS.md` `` produces a leading slash the
 * file client sends as an ABSOLUTE path. The detail route wrote that join
 * itself and would have read the wrong file for Duet.
 *
 * `null` is the ordinary missing-file answer, not an error: an agent without an
 * `AGENTS.md` is normal, and the canvas draws an empty note for it.
 */
export function agentReadmeQueryOptions(
  api: AgentRoleApi,
  workspaceSlug: string,
  agent: Pick<Agent, 'id' | 'anchorPath'>,
) {
  return queryOptions({
    queryKey: duetQueryKeys.workspaces.agents.readme(workspaceSlug, agent.id),
    staleTime: AGENT_FILES_STALE_TIME_MS,
    retry: false,
    queryFn: async ({ signal }) => {
      const file = await api.readOptionalWorkspaceFile(
        workspaceSlug,
        joinDrivePath(agent.anchorPath, AGENTS_FILE),
        { signal },
      )
      return file === null ? null : decodeFileText(file.data)
    },
  })
}

/**
 * The paged skills read, for a surface that draws no role.
 *
 * The knowledge map reads `.skills` and nothing else, and it asks once per agent
 * — so paying the AGENTS.md read there is one wasted VM round-trip per agent on
 * the landing page's critical path. Its paged result needs a separate cache
 * key from the role and README, whose answers are strings.
 */
export function agentSkillsQueryOptions(
  api: AgentSkillsApi,
  workspaceSlug: string,
  agent: Pick<Agent, 'id' | 'anchorPath'>,
) {
  return collectionPagesQueryOptions<string>({
    queryKey: [
      ...duetQueryKeys.workspaces.agents.profile(workspaceSlug, agent.id),
      'skills',
    ] as const,
    queryFn: ({ cursor, signal }) =>
      readAgentSkills(api, workspaceSlug, agent.anchorPath, signal, cursor),
    staleTime: AGENT_FILES_STALE_TIME_MS,
    retry: false,
  })
}

/**
 * The role read, for a surface that draws no skills.
 *
 * The agents roster lists every agent at once with a line of description under
 * each name, and it draws no skills — so a combined reader would pay a
 * skills listing per agent for something nothing in it renders. One request per
 * row instead of two — and the roster is a permanent column, so that halving is
 * paid on the front door's first paint. `preload-agent-pages.ts` warms this key
 * for the whole fleet so the rows read a cache rather than the VM.
 *
 * Its own cache key keeps the extracted line separate from the whole README
 * and from the paged skills result.
 *
 * `null`, never `undefined`, for an agent that describes itself nowhere.
 * react-query reads `undefined` as a query that returned nothing and warns; the
 * absence of a description is an answer, so it has to be a value.
 */
export function agentRoleQueryOptions(
  api: AgentRoleApi,
  workspaceSlug: string,
  agent: Pick<Agent, 'id' | 'anchorPath'>,
) {
  return queryOptions({
    queryKey: [
      ...duetQueryKeys.workspaces.agents.profile(workspaceSlug, agent.id),
      'role',
    ] as const,
    queryFn: ({ signal }) => readAgentRole(api, workspaceSlug, agent.anchorPath, signal),
    staleTime: AGENT_FILES_STALE_TIME_MS,
    retry: false,
  })
}

async function readAgentRole(
  api: AgentRoleApi,
  workspaceSlug: string,
  anchorPath: string,
  signal: AbortSignal,
): Promise<string | null> {
  /* Every failure is the same answer here, unlike the skills read next door
     which tells a missing folder from an unreachable one. A description is the
     one thing on a row that is decoration: a drive whose VM is briefly away
     should draw its agents by name with no line under them, not a list of error
     states where the prose was. */
  return api
    .readOptionalWorkspaceFile(workspaceSlug, joinDrivePath(anchorPath, AGENTS_FILE), { signal })
    .then(file => (file === null ? null : (extractRole(decodeFileText(file.data)) ?? null)))
    .catch(() => null)
}

// Two different facts, told apart: an agent with no `.agents/skills` folder has
// no skills, and that is the ordinary case — the optional listing answers it
// with `null`, and a path that exists but cannot be listed (a symlink where the
// folder should be) with a 4xx. An agent whose folder could not be *reached* is
// unknown, and drawing that as "none" is how a surface ends up asserting an
// emptiness it never checked: a 5xx or a dropped connection is a failure and is
// allowed to reach the caller as one.
async function readAgentSkills(
  api: AgentSkillsApi,
  workspaceSlug: string,
  anchorPath: string,
  signal: AbortSignal,
  cursor?: string,
): Promise<AgentSkillsPage> {
  try {
    const listing = await api.listOptionalWorkspaceFiles(
      workspaceSlug,
      joinDrivePath(anchorPath, SKILLS_DIR),
      { cursor, signal },
    )
    return skillsPageFrom(listing)
  } catch (error) {
    if (error instanceof DuetApiError && error.status >= 400 && error.status < 500) return NO_SKILLS
    throw error
  }
}

const NO_SKILLS: AgentSkillsPage = { items: [], nextCursor: null }

function skillsPageFrom(listing: FileListResponse | null): AgentSkillsPage {
  return listing === null
    ? NO_SKILLS
    : { items: extractSkills(listing.items), nextCursor: listing.nextCursor }
}

// The drive root is the empty anchor — Duet's. Joining it the naive way yields
// a leading slash, which the file client reads as an *absolute* path and sends
// as `%2F…`, so the drive's own skills came back empty rather than missing.
function joinDrivePath(anchorPath: string, child: string): string {
  const base = anchorPath.replace(/\/+$/, '')
  return base.length === 0 ? child : `${base}/${child}`
}

function decodeFileText(data: Uint8Array): string {
  return new TextDecoder().decode(data)
}

/**
 * The role is the agent's first line of self-description: the first *prose* line of
 * its AGENTS.md. Deterministic skips, in order — a leading YAML frontmatter block,
 * blank lines, `#` headings, and HTML comment blocks; a blockquote (`>`) or list
 * marker (`-`/`*`/`+`/`1.`) is stripped so a bullet-authored description still reads
 * as prose. Heading-only or empty files have no prose line and yield no role.
 */
export function extractRole(content: string): string | undefined {
  const lines = stripFrontmatter(content.split(/\r?\n/))
  let inComment = false
  for (const raw of lines) {
    const line = raw.trim()
    if (inComment) {
      if (line.includes('-->')) inComment = false
      continue
    }
    if (line === '') continue
    if (line.startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true
      continue
    }
    if (line.startsWith('#')) continue
    const prose = stripLeadingMarkers(line)
    if (prose.length > 0) return prose
  }
  return undefined
}

// A YAML frontmatter block is `---` on the first non-blank line through its closing
// `---`; everything up to and including the fence is skipped. An unterminated fence
// leaves no prose (the whole file is treated as frontmatter).
function stripFrontmatter(lines: readonly string[]): readonly string[] {
  let start = 0
  while (start < lines.length && lines[start]!.trim() === '') start++
  if (start >= lines.length || lines[start]!.trim() !== '---') return lines
  for (let end = start + 1; end < lines.length; end++) {
    if (lines[end]!.trim() === '---') return lines.slice(end + 1)
  }
  return []
}

function stripLeadingMarkers(line: string): string {
  let text = line
  while (/^>\s?/.test(text)) text = text.replace(/^>\s?/, '')
  text = text.trimStart().replace(/^(?:[-*+]|\d+\.)\s+/, '')
  return text.trim()
}

/**
 * Skills are the subfolders of `.agents/skills/` — the cheapest correct reading is
 * one directory listing, taking each directory entry's name (a `SKILL.md`-per-entry
 * confirmation would cost N more requests for no better answer). Files and symlinks
 * in the directory are ignored; listing order is preserved.
 */
export function extractSkills(entries: readonly FileEntry[]): string[] {
  return entries.filter(entry => entry.type === 'directory').map(entry => entry.name)
}
