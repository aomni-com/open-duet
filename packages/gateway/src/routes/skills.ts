import { Hono } from 'hono'

import { WorkspaceSkillsListingSchema } from '@repo/contract'

import { settledDuetCli, spawnDuetCli, type DuetCliRunner } from '../duet-cli'
import { resolveAgentCwd } from '../runner/process-runner'

const SKILLS_LISTING_MAX_ITEMS = 1_000
const SKILLS_LISTING_MAX_BYTES = 1024 * 1024

export interface SkillsRouteOptions {
  driveDir: string
  runner?: DuetCliRunner
}

/**
 * What skills the agent would actually see if it ran here.
 *
 * The gateway does not enumerate skill folders itself. Discovery is the agent
 * CLI's own rule — ancestors of the working directory, then the user's home,
 * then the ones built into the binary, with nearer directories winning name
 * collisions — and a second implementation of that rule in the control plane
 * would drift the moment the agent's changed. `duet skills` is that rule
 * printed as JSON, so this route is a working-directory resolver and nothing
 * more.
 *
 * `cwd` is the drive-relative folder the session runs in (an agent's anchor,
 * or the drive root for the default agent), resolved with the same containment
 * check the session runner uses.
 */
export function createSkillsRoutes(options: SkillsRouteOptions): Hono {
  const app = new Hono()
  const runner = settledDuetCli(options.runner ?? spawnDuetCli)

  app.get('/', async c => {
    let workDir: string
    try {
      workDir = resolveAgentCwd(options.driveDir, c.req.query('cwd'))
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }

    const result = await runner(['skills', '--workdir', workDir], {
      maxStdoutBytes: SKILLS_LISTING_MAX_BYTES,
      maxStderrBytes: SKILLS_LISTING_MAX_BYTES,
    })
    // An empty listing is a real answer — a workspace can genuinely have no
    // skills — so a failure must never be flattened into one. The picker
    // distinguishes "none installed" from "could not ask".
    if (
      result.outputTooLarge === true ||
      new TextEncoder().encode(result.stdout).byteLength > SKILLS_LISTING_MAX_BYTES ||
      new TextEncoder().encode(result.stderr).byteLength > SKILLS_LISTING_MAX_BYTES
    ) {
      return c.json({ error: 'skills_cli_listing_too_large' }, 502)
    }
    if (result.timedOut === true) {
      return c.json({ error: 'skills_cli_timeout' }, 504)
    }
    if (result.exitCode !== 0) {
      return c.json({ error: 'skills_cli_failed', exitCode: result.exitCode }, 502)
    }

    const listing = parseListing(result.stdout)
    if (listing === null) return c.json({ error: 'skills_cli_invalid_json' }, 502)
    if (listing.skills.length > SKILLS_LISTING_MAX_ITEMS) {
      return c.json({ error: 'skills_cli_listing_too_large' }, 502)
    }
    return c.json(listing)
  })

  return app
}

function parseListing(stdout: string) {
  try {
    const parsed = WorkspaceSkillsListingSchema.safeParse(JSON.parse(stdout))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
