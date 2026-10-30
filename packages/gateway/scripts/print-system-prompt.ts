// Print the system prompt a session would start with, so a person can read
// what the model reads. See `renderSystemPrompt` for what it does and does
// not carry.
//
//   bun scripts/print-system-prompt.ts --drive <dir> [options]
//
//   --drive <dir>        a drive: a real VM's /home/exedev/drive, a copy, or
//                        a seed such as ../seed-drive/content
//   --cwd <path>         drive-relative working directory (default: root)
//   --agent <slug>       scope to this agent: cwd defaults to its folder
//   --roster <file>      GatewayAgentConfig[] JSON; defaults to a roster built
//                        from every agent.json under the drive, plus root
//   --apps <file>        GatewayAppConfig[] JSON (default: none)
//   --workspace <slug>   workspace slug (default: workspace)
//   --onboarding         render the onboarding launch instead
//   --default-session    the agent's home conversation
//   --parent <id>        a child session started by this parent session
//   --home <dir>         home whose .agents/.duet/.claude skills are global
//                        (default: an empty scratch dir)
//   --state <dir>        where generated layer files go (default: scratch)
//   --out <file>         write the prompt here (default: stdout)
//
// The drive takes the same writes a launch makes: a memory-store directory
// under each agent folder, if missing.

import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { estimateTokens } from '@repo/agent/memory/observational'
import {
  GatewayAgentConfigSchema,
  GatewayAppConfigSchema,
  type GatewayAgentConfig,
} from '@repo/contract'
import { z } from 'zod'

import { renderSystemPrompt } from '../src/agents/render-system-prompt'

const flags = parseFlags(process.argv.slice(2))
const driveDir = resolve(required('drive'))
const scratch = mkdtempSync(join(tmpdir(), 'duet-system-prompt-'))
const roster =
  flags.roster === undefined
    ? rosterFromDrive(driveDir, flags.workspace ?? 'workspace')
    : z.array(GatewayAgentConfigSchema).parse(JSON.parse(readFileSync(flags.roster, 'utf8')))
const apps =
  flags.apps === undefined
    ? undefined
    : z.array(GatewayAppConfigSchema).parse(JSON.parse(readFileSync(flags.apps, 'utf8')))
const agent =
  flags.agent === undefined
    ? undefined
    : roster.find(
        (member): member is Extract<GatewayAgentConfig, { kind: 'agent' }> =>
          member.kind === 'agent' && member.slug === flags.agent,
      )
if (flags.agent !== undefined && agent === undefined) {
  fail(`No agent "${flags.agent}" in the roster (${roster.map(member => member.slug).join(', ')})`)
}

const rendered = await renderSystemPrompt({
  driveDir,
  stateDir: flags.state === undefined ? join(scratch, 'state') : resolve(flags.state),
  cwd: flags.cwd ?? agent?.anchorPath,
  workspaceSlug: flags.workspace ?? 'workspace',
  agents: roster,
  apps,
  onboarding: flags.onboarding === 'true',
  defaultSession: flags['default-session'] === 'true',
  createdBySessionId: flags.parent,
  skillsHome: flags.home === undefined ? join(scratch, 'home') : resolve(flags.home),
})

if (flags.out === undefined) {
  process.stdout.write(rendered.prompt)
  process.stdout.write('\n')
} else {
  writeFileSync(flags.out, `${rendered.prompt}\n`)
}
const width = Math.max(...rendered.layers.map(layer => layer.name.length))
const rows = rendered.layers.map(
  layer =>
    `  ${layer.name.padEnd(width)}  ${String(layer.chars).padStart(6)} chars  ~${String(estimateTokens('x'.repeat(layer.chars))).padStart(5)} tokens`,
)
console.error(
  [
    flags.out === undefined ? '' : `wrote ${flags.out}`,
    `total ${rendered.prompt.length} chars, ~${estimateTokens(rendered.prompt)} tokens`,
    ...rows,
  ]
    .filter(line => line.length > 0)
    .join('\n'),
)

function parseFlags(argv: readonly string[]): Record<string, string | undefined> {
  const parsed: Record<string, string | undefined> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`)
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) parsed[name] = 'true'
    else parsed[name] = argv[++i]
  }
  return parsed
}

function required(name: string): string {
  const value = flags[name]
  if (value === undefined || value === 'true') fail(`--${name} is required`)
  return value
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

/**
 * A roster the way vm-sync would send it, read off the drive: every folder
 * holding an `agent.json` is an agent, named and slugged after its folder.
 */
function rosterFromDrive(drive: string, workspaceSlug: string): GatewayAgentConfig[] {
  const rows: GatewayAgentConfig[] = [{ kind: 'root', slug: 'root', name: workspaceSlug }]
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.') || entry === 'node_modules') continue
      const path = join(dir, entry)
      if (!statSync(path).isDirectory()) continue
      if (existsSync(join(path, 'agent.json'))) {
        const anchorPath = relative(drive, path)
        rows.push({
          kind: 'agent',
          agentId: `agent_${entry}`,
          anchorId: `anchor_${entry}`,
          anchorPath,
          slug: entry,
          name: entry,
          onboardedAt: 1,
        })
      }
      walk(path)
    }
  }
  walk(drive)
  return rows
}
