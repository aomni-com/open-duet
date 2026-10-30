import { expect, test } from 'bun:test'

import { QueryClient } from '@tanstack/react-query'

import type { FileEntry } from '@repo/contract'

import { DuetApiError } from '../api/client'
import type { SpaApi } from '../context'
import {
  agentReadmeQueryOptions,
  agentRoleQueryOptions,
  agentSkillsQueryOptions,
  extractRole,
  extractSkills,
} from './agent-profile'

// --- Role extraction: the first prose line of AGENTS.md ---

test('the role is the first non-heading line', () => {
  expect(extractRole('# Research\n\nSynthesizes sources into decision-ready briefs.\n')).toBe(
    'Synthesizes sources into decision-ready briefs.',
  )
})

test('a heading-only file has no role', () => {
  expect(extractRole('# Research\n\n## Details\n')).toBeUndefined()
})

test('an empty file has no role', () => {
  expect(extractRole('')).toBeUndefined()
  expect(extractRole('\n\n   \n')).toBeUndefined()
})

test('a leading YAML frontmatter block is skipped', () => {
  const content = '---\nname: Research\nicon: robot\n---\n\n# Research\n\nBriefs from sources.\n'
  expect(extractRole(content)).toBe('Briefs from sources.')
})

test('an unterminated frontmatter fence yields no role', () => {
  expect(extractRole('---\nname: Research\n')).toBeUndefined()
})

test('an HTML comment block is skipped', () => {
  expect(extractRole('<!-- internal note\nspanning lines -->\nActual role line.')).toBe(
    'Actual role line.',
  )
})

test('a blockquote-authored description is stripped to its prose', () => {
  expect(extractRole('> Synthesizes sources into briefs.')).toBe('Synthesizes sources into briefs.')
})

test('a bullet-list first line is stripped to its prose', () => {
  expect(extractRole('- Triages inbound support threads.')).toBe('Triages inbound support threads.')
  expect(extractRole('1. Models revenue scenarios.')).toBe('Models revenue scenarios.')
})

test('CRLF line endings are handled', () => {
  expect(extractRole('# Title\r\n\r\nRole over CRLF.\r\n')).toBe('Role over CRLF.')
})

// --- Skills: the subfolders of .agents/skills/ ---

function entry(name: string, type: FileEntry['type']): FileEntry {
  return { name, path: `.agents/skills/${name}`, type, size: 0, mtime: '2026-07-15T08:00:00.000Z' }
}

test('skills are the directory entries, in listing order, ignoring files', () => {
  expect(
    extractSkills([
      entry('deep-research', 'directory'),
      entry('README.md', 'file'),
      entry('summarize', 'directory'),
      entry('link', 'symlink'),
    ]),
  ).toEqual(['deep-research', 'summarize'])
})

test('an empty skills listing yields no skills', () => {
  expect(extractSkills([])).toEqual([])
})

// --- Live file reads: split role, README, and paged skills ---

const AGENT = { id: 'agent_research', anchorPath: 'agents/research' }

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function runQueryFn(options: { queryFn?: unknown }, pageParam?: string) {
  return (
    options.queryFn as (ctx: { signal: AbortSignal; pageParam?: string }) => Promise<unknown>
  )({
    signal: new AbortController().signal,
    pageParam,
  })
}

// --- Skills alone: the half of a profile a caller that draws no role should pay for ---

test('a skills read fires exactly one request, and it is the skills listing', async () => {
  let reads = 0
  let listings = 0
  const api = {
    readOptionalWorkspaceFile: async () => {
      reads++
      throw new Error('the skills read must not touch AGENTS.md')
    },
    listOptionalWorkspaceFiles: async (_slug: string, path: string) => {
      listings++
      expect(path).toBe('agents/research/.agents/skills')
      return {
        items: [entry('deep-research', 'directory'), entry('README.md', 'file')],
        nextCursor: null,
      }
    },
  } as unknown as SpaApi

  const skills = await runQueryFn(agentSkillsQueryOptions(api, 'acme', AGENT))
  expect(reads).toBe(0)
  expect(listings).toBe(1)
  expect(skills).toEqual({ items: ['deep-research'], nextCursor: null })
})

/* Two different facts, and only one of them is "no skills". An agent with no
   `.agents/skills` folder is the ordinary case and reads as none; an agent whose
   folder could not be read is unknown, and a surface handed `[]` for that draws
   a confident zero for something it never checked. */
test('a missing skills folder is no skills; a failed read is not', async () => {
  const failing = (error: unknown) =>
    ({
      listOptionalWorkspaceFiles: async () => {
        throw error
      },
    }) as unknown as SpaApi
  const missing = { listOptionalWorkspaceFiles: async () => null } as unknown as SpaApi

  expect(await runQueryFn(agentSkillsQueryOptions(missing, 'acme', AGENT))).toEqual({
    items: [],
    nextCursor: null,
  })
  // A path that exists but cannot be listed — a symlink where the folder
  // should be — is likewise no skills, not an outage.
  expect(
    await runQueryFn(
      agentSkillsQueryOptions(failing(new DuetApiError(409, 'path_is_symlink')), 'acme', AGENT),
    ),
  ).toEqual({ items: [], nextCursor: null })
  expect(
    runQueryFn(agentSkillsQueryOptions(failing(new Error('the VM went away')), 'acme', AGENT)),
  ).rejects.toThrow('the VM went away')
})

test('skills expose the fifty-first directory through one explicit continuation', async () => {
  const cursors: Array<string | undefined> = []
  const api = {
    listOptionalWorkspaceFiles: async (
      _slug: string,
      _path: string,
      options: { cursor?: string },
    ) => {
      cursors.push(options.cursor)
      return options.cursor === undefined
        ? {
            items: Array.from({ length: 50 }, (_, index) =>
              entry(`skill-${String(index + 1).padStart(2, '0')}`, 'directory'),
            ),
            nextCursor: 'skills-page-2',
          }
        : { items: [entry('skill-51', 'directory')], nextCursor: null }
    },
  } as unknown as SpaApi
  const options = agentSkillsQueryOptions(api, 'acme', AGENT)

  const first = await runQueryFn(options)
  const second = await runQueryFn(options, 'skills-page-2')

  expect(first).toMatchObject({ nextCursor: 'skills-page-2' })
  expect(second).toEqual({ items: ['skill-51'], nextCursor: null })
  expect(cursors).toEqual([undefined, 'skills-page-2'])
})

// --- The role alone: the other half, for a list that draws a description ---

test('a role read fires exactly one request, and it is AGENTS.md', async () => {
  let listings = 0
  const api = {
    readOptionalWorkspaceFile: async (_slug: string, path: string) => {
      expect(path).toBe('agents/research/AGENTS.md')
      return { data: new TextEncoder().encode('# Research\n\nBriefs from sources.\n') }
    },
    listOptionalWorkspaceFiles: async () => {
      listings++
      throw new Error('the role read must not list the skills folder')
    },
  } as unknown as SpaApi

  expect(await runQueryFn(agentRoleQueryOptions(api, 'acme', AGENT))).toBe('Briefs from sources.')
  expect(listings).toBe(0)
})

/* A missing, unreadable or heading-only AGENTS.md all mean the same thing to a
   row that draws a description: there is not one. `null` rather than
   `undefined` because react-query reads an undefined result as "the query
   returned nothing" and warns — the absence has to be a value. */
test('an agent that describes itself nowhere reads as no description', async () => {
  const missing = { readOptionalWorkspaceFile: async () => null } as unknown as SpaApi
  expect(await runQueryFn(agentRoleQueryOptions(missing, 'acme', AGENT))).toBeNull()
  expect(await runQueryFn(agentReadmeQueryOptions(missing, 'acme', AGENT))).toBeNull()

  const headingOnly = {
    readOptionalWorkspaceFile: async () => ({ data: new TextEncoder().encode('# Research\n') }),
  } as unknown as SpaApi
  expect(await runQueryFn(agentRoleQueryOptions(headingOnly, 'acme', AGENT))).toBeNull()
})

/* Duet's anchor is the drive root, which is the empty string. Joined naively it
   yields `/AGENTS.md` — an *absolute* path the file client sends as `%2F…` — so
   the one carrier that is the drive itself would read nothing at all. */
test('the drive root reads its own AGENTS.md, not one at an absolute path', async () => {
  const api = {
    readOptionalWorkspaceFile: async (_slug: string, path: string) => {
      expect(path).toBe('AGENTS.md')
      return { data: new TextEncoder().encode('Runs this drive.') }
    },
  } as unknown as SpaApi
  expect(await runQueryFn(agentRoleQueryOptions(api, 'acme', { id: 'core', anchorPath: '' }))).toBe(
    'Runs this drive.',
  )
})

/* The drive root is the empty anchor, and the naive join makes `/AGENTS.md` —
   which the file client sends as an ABSOLUTE path, addressing a different file.
   The skills read learned this once already; the README read is covered here so
   both share the lesson rather than each rediscovering it. */
test('the drive root addresses its own files relatively, never with a leading slash', async () => {
  const paths: string[] = []
  const api = {
    readOptionalWorkspaceFile: async (_slug: string, path: string) => {
      paths.push(path)
      return { data: new TextEncoder().encode('# Duet\n\nThe drive itself.') }
    },
    listOptionalWorkspaceFiles: async (_slug: string, path: string) => {
      paths.push(path)
      return { items: [entry('remember', 'directory')], nextCursor: null }
    },
  } as unknown as SpaApi
  const root = { id: 'root', anchorPath: '' }

  const skills = (await runQueryFn(agentSkillsQueryOptions(api, 'acme', root))) as {
    items: readonly string[]
  }
  const readme = await runQueryFn(agentReadmeQueryOptions(api, 'acme', root))

  expect(paths).toEqual(['.agents/skills', 'AGENTS.md'])
  expect(paths.some(path => path.startsWith('/'))).toBe(false)
  expect(skills.items).toEqual(['remember'])
  expect(readme).toContain('The drive itself.')
})

test('a registered agent still reads its README below its own anchor', async () => {
  const paths: string[] = []
  const api = {
    readOptionalWorkspaceFile: async (_slug: string, path: string) => {
      paths.push(path)
      return { data: new TextEncoder().encode('# Research') }
    },
  } as unknown as SpaApi

  await runQueryFn(agentReadmeQueryOptions(api, 'acme', AGENT))
  expect(paths).toEqual(['agents/research/AGENTS.md'])
})

test('role, README, and paged skills retain independent cached answers for each agent', async () => {
  const queryClient = new QueryClient()
  const api = {
    readOptionalWorkspaceFile: async (_slug: string, path: string) => {
      const data = bytes(`# Title\n\nRole of ${path}`)
      return { data, etag: null, contentType: 'text/markdown', size: data.byteLength }
    },
    listOptionalWorkspaceFiles: async (_slug: string, path: string) => ({
      items: [entry(`${path}/skill`, 'directory')],
      nextCursor: null,
    }),
  }
  for (const id of ['first', 'second']) {
    const agent = { id, anchorPath: `agents/${id}` }
    await queryClient.fetchQuery(agentRoleQueryOptions(api, 'acme', agent))
    await queryClient.fetchQuery(agentReadmeQueryOptions(api, 'acme', agent))
    await queryClient.fetchInfiniteQuery(agentSkillsQueryOptions(api, 'acme', agent))
  }
  for (const id of ['first', 'second']) {
    const agent = { id, anchorPath: `agents/${id}` }
    expect(
      queryClient.getQueryData<string>(agentRoleQueryOptions(api, 'acme', agent).queryKey),
    ).toBe(`Role of agents/${id}/AGENTS.md`)
    expect(
      queryClient.getQueryData<string>(agentReadmeQueryOptions(api, 'acme', agent).queryKey),
    ).toBe(`# Title\n\nRole of agents/${id}/AGENTS.md`)
    expect(
      queryClient.getQueryData(agentSkillsQueryOptions(api, 'acme', agent).queryKey),
    ).toMatchObject({ pages: [{ items: [`agents/${id}/.agents/skills/skill`], nextCursor: null }] })
  }
  queryClient.clear()
})
