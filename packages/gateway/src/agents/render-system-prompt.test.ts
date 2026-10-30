import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEVELOPER_SYSTEM_PROMPT } from '../runner/developer-system-prompt'
import { renderSystemPrompt } from './render-system-prompt'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('renders the prompt a launch in an agent folder would start with', async () => {
  const root = mkdtempSync(join(tmpdir(), 'duet-render-prompt-'))
  roots.push(root)
  const driveDir = join(root, 'drive')
  mkdirSync(join(driveDir, 'agents', 'scout'), { recursive: true })
  mkdirSync(join(root, 'home'))
  const authored = 'You are Scout. Mention a colleague as `<Agent name="Duet" slug="root" />`.'
  writeFileSync(join(driveDir, 'agents', 'scout', 'AGENTS.md'), authored)

  const rendered = await renderSystemPrompt({
    driveDir,
    stateDir: join(root, 'state'),
    skillsHome: join(root, 'home'),
    cwd: 'agents/scout',
    workspaceSlug: 'acme',
    agents: [
      { kind: 'root', slug: 'root', name: 'Acme' },
      {
        kind: 'agent',
        agentId: 'agent_scout',
        anchorId: 'anchor_scout',
        anchorPath: 'agents/scout',
        slug: 'scout',
        name: 'Scout',
        onboardedAt: 1,
      },
    ],
  })

  // The developer prompt opens; the gateway's layers follow, each as its own
  // block; the author's text arrives exactly as written; the runtime closes
  // with the working directory the session actually runs in.
  expect(rendered.prompt.startsWith(DEVELOPER_SYSTEM_PROMPT)).toBe(true)
  expect(rendered.prompt).toContain(`<system_prompt_file path="AGENTS.md">\n${authored}\n`)
  expect(rendered.prompt).toContain(`Current working directory: ${join(driveDir, 'agents', 'scout')}.`)
  // Most general first, most specific last: the runtime's own rules, then the
  // gateway's layers, then the author's instructions, then only the date.
  const at = (marker: string) => rendered.prompt.indexOf(marker)
  expect(at('<cwd>')).toBeLessThan(at('who-you-are.md'))
  expect(at('showing-files.md')).toBeLessThan(at('path="AGENTS.md"'))
  expect(at('path="AGENTS.md"')).toBeLessThan(at('<current_date>'))

  // Every layer is accounted for, in order, and the sizes add up to the whole.
  expect(rendered.layers.map(layer => layer.name)).toEqual([
    'developer-system-prompt',
    'who-you-are.md',
    'your-folder.md',
    'your-agents.md',
    'your-session.md',
    'showing-files.md',
    'AGENTS.md',
    'agent runtime (tools, cwd, skills, routing guidance)',
  ])
  expect(rendered.layers.reduce((total, layer) => total + layer.chars, 0)).toBe(
    rendered.prompt.length,
  )
})
