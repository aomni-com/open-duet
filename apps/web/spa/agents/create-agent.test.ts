import { expect, test } from 'bun:test'

import { resolveAgentConfig } from '@repo/contract'

import { agentSlugFromName, createOwnAgent, starterAgentFiles } from './create-agent'

test('a name becomes its slug, and a taken slug steps aside instead of colliding', () => {
  expect(agentSlugFromName('Growth Analyst', new Set())).toBe('growth-analyst')
  expect(agentSlugFromName('Growth Analyst', new Set(['growth-analyst']))).toBe('growth-analyst-2')
  expect(agentSlugFromName('Growth Analyst', new Set(['growth-analyst', 'growth-analyst-2']))).toBe(
    'growth-analyst-3',
  )
})

test('names that normalize to nothing or to a reserved word still earn a usable slug', () => {
  // Punctuation-only, the catalog's address, and the drive root's token: none
  // may become an agent's slug, because each is an address that already means
  // something else.
  expect(agentSlugFromName('!!!', new Set())).toBe('agent')
  expect(agentSlugFromName('Marketplace', new Set())).toBe('marketplace-2')
  expect(agentSlugFromName('Root', new Set())).toBe('root-2')
})

test('a very long name suffixes within the slug length limit', () => {
  const name = 'The Extremely Thorough Compliance And Regulation Review Department'
  const base = agentSlugFromName(name, new Set())
  const suffixed = agentSlugFromName(name, new Set([base]))
  expect(suffixed.length).toBeLessThanOrEqual(40)
  expect(suffixed.endsWith('-2')).toBe(true)
})

test('the starter agent.json survives the real config parser with its message intact', () => {
  const { agentJson } = starterAgentFiles({
    name: 'Growth Analyst',
    workspaceSlug: 'acme',
    slug: 'growth-analyst',
  })

  // Through the one owner of agent.json semantics, not JSON.parse: a config
  // the resolver rejects fails open into an agent with no suggestion at all.
  const config = resolveAgentConfig(agentJson)
  expect(config.readable).toBe(true)
  expect(config.suggestedFirstMessage).toContain('Growth Analyst')
  expect(config.suggestedFirstMessage).toContain('/w/acme/train/growth-analyst')
})

test('creation completes its starter files before registration and registers their folder', async () => {
  const files = new Map<string, string>()
  const firstWrite = Promise.withResolvers<void>()
  let registered: { path: string; slug: string; name?: string } | undefined
  const api = {
    writeWorkspaceFile: async (_ws: string, path: string, bytes: Uint8Array) => {
      if (path.endsWith('/AGENTS.md')) await firstWrite.promise
      files.set(path, new TextDecoder().decode(bytes))
      return { ok: true as const, etag: 'e', size: bytes.length }
    },
    registerAgent: async (_ws: string, input: { path: string; slug: string; name?: string }) => {
      // The registration edge sees the real completed file sink, not queued calls.
      expect(files.get(`${input.path}/AGENTS.md`) ?? '').toContain('Growth Analyst')
      const config = resolveAgentConfig(files.get(`${input.path}/agent.json`) ?? '')
      expect(config.readable).toBe(true)
      expect(config.suggestedFirstMessage).toContain('/w/acme/train/growth-analyst')
      registered = input
      return { agent: { slug: input.slug } as never, apps: [] }
    },
  }

  const creation = createOwnAgent(api, 'acme', { name: 'Growth Analyst', slug: 'growth-analyst' })
  // Let an incorrectly unawaited first write reach registration before releasing it.
  await Promise.resolve()
  firstWrite.resolve()
  await creation

  expect(registered).toEqual({
    path: 'agents/growth-analyst',
    slug: 'growth-analyst',
    name: 'Growth Analyst',
  })
  expect([...files.keys()]).toEqual([
    'agents/growth-analyst/AGENTS.md',
    'agents/growth-analyst/agent.json',
  ])
})
