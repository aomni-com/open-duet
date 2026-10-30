import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_MARKETPLACE_CHANGELOG_UTF8_BYTES,
  MAX_RECURSIVE_FILE_ENTRIES,
  deriveListingMetadata,
} from '@repo/contract'

import { inspectListableAgent } from './inspector'

let driveDir: string

beforeEach(async () => {
  driveDir = await mkdtemp(join(tmpdir(), 'duet-listing-inspect-'))
})

afterEach(async () => {
  await rm(driveDir, { recursive: true, force: true })
})

async function seedAgent(name = 'sec-triage'): Promise<string> {
  const agentPath = `agents/${name}`
  const root = join(driveDir, agentPath)
  await mkdir(join(root, '.agents', 'skills', 'triage'), { recursive: true })
  await mkdir(join(root, '.agents', 'skills', 'report'), { recursive: true })
  await writeFile(
    join(root, 'AGENTS.md'),
    '# Sec Triage\n\n## Overview\n\nTriages security alerts and\nwrites up findings.\n\nMore prose.',
  )
  await writeFile(join(root, 'CHANGELOG.md'), '# 1.0.0\n\nInitial release')
  await writeFile(join(root, '.agents', 'skills', 'triage', 'SKILL.md'), '# triage')
  await writeFile(join(root, '.agents', 'skills', 'report', 'SKILL.md'), '# report')
  return agentPath
}

test('an eligible agent yields bounded metadata and sorted skill names', async () => {
  const agentPath = await seedAgent()
  const result = await inspectListableAgent({ driveDir, agentPath })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.origin.skills).toEqual(['report', 'triage'])
  expect(result.origin.changelogMd).toContain('Initial release')
  expect(result.entries).toBeGreaterThan(0)
  expect(result.bytes).toBeGreaterThan(0)

  // The heading-only block is skipped; the first prose block becomes the
  // summary, and the title is the display name rather than sliced prose.
  const derived = deriveListingMetadata({ ...result.origin, agentDisplayName: 'Sec Triage' })
  expect(derived).toEqual({
    title: 'Sec Triage',
    summary: 'Triages security alerts and writes up findings.',
    skills: ['report', 'triage'],
    changelog: '# 1.0.0\n\nInitial release',
    tags: [],
  })
})

test('refuses an oversized metadata file before reading it into memory', async () => {
  const agentPath = await seedAgent()
  await writeFile(
    join(driveDir, agentPath, 'CHANGELOG.md'),
    'x'.repeat(MAX_MARKETPLACE_CHANGELOG_UTF8_BYTES + 1),
  )
  await expect(inspectListableAgent({ driveDir, agentPath })).resolves.toEqual({
    ok: false,
    error: 'listing_too_large',
  })
})

/* Tags reach a THIRD-PARTY listing by the same path the seed uses — the
   inspector carries `agent.json` raw and the one projection reads it. An
   official agent and a stranger's agent with identical bytes must land on
   identical tags, or the vocabulary has forked. */
test('an agent.json contributes tags, and a folder without one simply has none', async () => {
  const agentPath = await seedAgent()
  await writeFile(
    join(driveDir, agentPath, 'agent.json'),
    JSON.stringify({ tags: ['customer-support', 'nonsense', 'product'] }),
  )

  const result = await inspectListableAgent({ driveDir, agentPath })
  expect(result.ok).toBe(true)
  if (!result.ok) return

  const derived = deriveListingMetadata({ ...result.origin, agentDisplayName: 'Sec Triage' })
  expect(derived).not.toHaveProperty('error')
  // Unknown value dropped; survivors in vocabulary order, not authored order.
  expect((derived as { tags: string[] }).tags).toEqual(['customer-support', 'product'])
})

test('a malformed agent.json costs the listing its tags and nothing else', async () => {
  const agentPath = await seedAgent()
  await writeFile(join(driveDir, agentPath, 'agent.json'), '{ not json')

  const result = await inspectListableAgent({ driveDir, agentPath })
  expect(result.ok).toBe(true)
  if (!result.ok) return

  const derived = deriveListingMetadata({ ...result.origin, agentDisplayName: 'Sec Triage' })
  expect(derived).not.toHaveProperty('error')
  expect((derived as { tags: string[]; summary: string }).tags).toEqual([])
  expect((derived as { summary: string }).summary).toContain('Triages security alerts')
})

test('a nested directory inside a skill is not itself a skill', async () => {
  const agentPath = await seedAgent()
  await mkdir(join(driveDir, agentPath, '.agents', 'skills', 'triage', 'reference'), {
    recursive: true,
  })
  const result = await inspectListableAgent({ driveDir, agentPath })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.origin.skills).toEqual(['report', 'triage'])
})

test('the serving floor and symlinks are excluded, inherited from the shared walker', async () => {
  const agentPath = await seedAgent()
  const root = join(driveDir, agentPath)
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true })
  await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1')
  await writeFile(join(root, '.env'), 'SECRET=1')
  await symlink(join(root, 'AGENTS.md'), join(root, 'link.md'))
  const withFloor = await inspectListableAgent({ driveDir, agentPath })
  expect(withFloor.ok).toBe(true)
  if (!withFloor.ok) return

  await rm(join(root, 'node_modules'), { recursive: true, force: true })
  await rm(join(root, '.env'), { force: true })
  await rm(join(root, 'link.md'), { force: true })
  const without = await inspectListableAgent({ driveDir, agentPath })
  expect(without.ok).toBe(true)
  if (!without.ok) return
  // Identical counts prove the floored paths were never counted in the first
  // place, so listing eligibility uses exactly the bytes a subscriber receives.
  expect(withFloor.entries).toBe(without.entries)
  expect(withFloor.bytes).toBe(without.bytes)
})

test('an agent over the entry bound is refused as too large, not truncated', async () => {
  const agentPath = await seedAgent()
  const bulk = join(driveDir, agentPath, 'data')
  await mkdir(bulk, { recursive: true })
  await Promise.all(
    Array.from({ length: MAX_RECURSIVE_FILE_ENTRIES + 10 }, (_, index) =>
      writeFile(join(bulk, `row-${index}.json`), '{}'),
    ),
  )
  expect(await inspectListableAgent({ driveDir, agentPath })).toEqual({
    ok: false,
    error: 'listing_too_large',
  })
})

test('a folder with no AGENTS.md, and a missing folder, are both invalid sources', async () => {
  await mkdir(join(driveDir, 'agents', 'bare'), { recursive: true })
  await writeFile(join(driveDir, 'agents', 'bare', 'notes.md'), 'nothing here')
  expect(await inspectListableAgent({ driveDir, agentPath: 'agents/bare' })).toEqual({
    ok: false,
    error: 'listing_source_invalid',
  })
  expect(await inspectListableAgent({ driveDir, agentPath: 'agents/ghost' })).toEqual({
    ok: false,
    error: 'listing_source_invalid',
  })
})

test('an AGENTS.md with only headings has no description to derive', async () => {
  const agentPath = await seedAgent()
  await writeFile(join(driveDir, agentPath, 'AGENTS.md'), '# Sec Triage\n\n## Overview\n')
  const result = await inspectListableAgent({ driveDir, agentPath })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  // A typed refusal at registration — not the 502 the old catalog service threw.
  expect(deriveListingMetadata({ ...result.origin, agentDisplayName: 'Sec Triage' })).toEqual({
    error: 'listing_missing_description',
  })
})

test('the gateway route speaks the same envelope for success and refusal', async () => {
  const { MarketplaceInspectionResponseSchema } = await import('@repo/contract')
  const agentPath = await seedAgent()
  const good = await inspectListableAgent({ driveDir, agentPath })
  // Both shapes must satisfy the wire union the API client parses; a bare
  // `{ error }` refusal would be indistinguishable from an unreachable gateway.
  expect(MarketplaceInspectionResponseSchema.safeParse(good).success).toBe(true)
  const bad = await inspectListableAgent({ driveDir, agentPath: 'agents/ghost' })
  expect(MarketplaceInspectionResponseSchema.safeParse(bad).success).toBe(true)
})
