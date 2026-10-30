import { describe, expect, test } from 'bun:test'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { AgentConfigSchema, APPROVED_MODELS } from '@repo/contract'

import { buildSkillsBundle } from './bundle'
import { generatedSkills } from './generated'
import { renderDefaultSkills } from './render'

const packageRoot = path.resolve(import.meta.dir, '..')
const skillsDir = path.join(packageRoot, 'skills')

async function readAuthoredFiles(
  dir = skillsDir,
): Promise<Array<{ path: string; content: string }>> {
  const files: Array<{ path: string; content: string }> = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await readAuthoredFiles(fullPath)))
    if (entry.isFile()) {
      files.push({
        path: path.relative(skillsDir, fullPath).split(path.sep).join('/'),
        content: await readFile(fullPath, 'utf8'),
      })
    }
  }
  return files
}

describe('default skill roster', () => {
  test('every shipped skill directory carries its SKILL.md entry point', async () => {
    const entries = await readdir(skillsDir, { withFileTypes: true })
    const directories = entries
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()

    expect(directories.length).toBeGreaterThan(0)
    for (const skill of directories) {
      expect((await stat(path.join(skillsDir, skill, 'SKILL.md'))).isFile()).toBe(true)
    }
  })

  test('checked-in generated output is fresh', async () => {
    expect(generatedSkills).toEqual(
      (await readAuthoredFiles()).sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      ),
    )
  })

  test('ships the required Impeccable Apache-2.0 attribution', async () => {
    const notice = await readFile(path.join(skillsDir, 'impeccable/NOTICE.md'), 'utf8')

    expect(notice).toContain('Anthropic')
    expect(notice).toContain('frontend-design')
    expect(notice).toMatch(/Apache License,\s+Version 2\.0/)
  })

  test('manage-agents teaches an authorable agent config without identity fields', async () => {
    const skill = await readFile(path.join(skillsDir, 'manage-agents/SKILL.md'), 'utf8')
    const example = skill.match(/### `agent\.json`[\s\S]*?```json\n([\s\S]*?)\n```/)

    expect(example).not.toBeNull()
    const authoredConfig: unknown = JSON.parse(example![1]!)
    const config = AgentConfigSchema.parse(authoredConfig as never)
    // The documented example must be exactly what a parser produces — a skill
    // that teaches a config the product would reject or rewrite is worse than
    // no example.
    expect(config as unknown).toEqual(authoredConfig)
    for (const field of ['slug', 'id', 'agentId', 'anchorId', 'path']) {
      expect(config).not.toHaveProperty(field)
    }
  })

  /* One list, one route. `/agent/jobs` was deleted, and a skill that still
     taught it would send every agent in every VM at a 404 with no schema error
     to explain it — which is exactly what happened, green, for as long as the
     assertion pinning that string lived beside the prose it pinned. Roster-wide
     so a *new* skill cannot reintroduce it either. */
  test('no shipped skill teaches the deleted jobs route', async () => {
    for (const file of await readAuthoredFiles()) {
      /* Prose only. A test beside a skill is allowed to name the dead route —
         explaining why it is dead is the point of it — and it is not shipped
         into a VM. */
      if (!file.path.endsWith('.md')) continue
      expect(file.content).not.toMatch(/\/agent\/jobs\b/)
      expect(file.content).not.toMatch(/[?&]view=(active|history)\b/)
    }
  })

  test('contains no stale command, URL, or retired placeholder syntax', async () => {
    const files = await readAuthoredFiles()
    const banned = [
      /\bnpx /,
      /\/api\/v1\/ai-gateway/,
      /\bapp\.duet\b/i,
      /\{\{(?!APP_URL\}\})[^{}\r\n]+\}\}/,
      /\{\{(?:GATEWAY_PORT|ORG_SLUG|AVAILABLE_MODELS)\}\}/,
    ]

    for (const file of files) {
      for (const pattern of banned) expect(file.content).not.toMatch(pattern)
    }

    const portedPrefixes = [
      'branded-content/',
      'composio-credentials/',
      'firecrawl/',
      'go-to-market/',
    ]
    for (const file of files.filter(file =>
      portedPrefixes.some(prefix => file.path.startsWith(prefix)),
    )) {
      expect(file.content).not.toContain('/api/v1/')
    }
  })

  test('keeps production gateway slugs out of adapted prose', async () => {
    const adaptedPrefixes = ['ai-gateway/', 'env-vars/', 'media-creation/', 'remember/']
    const adaptedFiles = (await readAuthoredFiles()).filter(file =>
      adaptedPrefixes.some(prefix => file.path.startsWith(prefix)),
    )

    for (const file of adaptedFiles) {
      for (const model of APPROVED_MODELS.entries) {
        expect(file.content).not.toContain(model.gatewayModelId)
      }
    }
  })

  test('renders the full roster with its models reference under the bundle size limit', () => {
    const rendered = renderDefaultSkills({
      appUrl: 'https://fixture.test/w/workspace',
      catalog: APPROVED_MODELS,
    })
    const built = buildSkillsBundle(rendered)

    expect(rendered.some(file => file.path === 'media-creation/reference/models.json')).toBe(true)
    expect(rendered.every(file => !/\{\{[^{}\r\n]+\}\}/.test(file.content))).toBe(true)
    expect(built.bytes.length).toBeLessThan(2_000_000)
    console.info(`skills bundle: ${built.bytes.length} bytes sha256:${built.hash}`)
  })
})
