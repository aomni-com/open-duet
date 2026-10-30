#!/usr/bin/env node
// Fan the shared secrets out to their targets. The dotenvx-encrypted .env.<env>
// file is the value source; secret-topology.mjs owns the target map and this
// script executes it.
//
//   bun run secrets:push:prod                 # dry-run plan, no writes
//   bun run secrets:push:prod -- --apply      # actually set them
//   bun run secrets:push:staging -- --apply
//
// Values arrive in process.env because the npm script wraps this in
// `dotenvx run -f .env.<env> -- node scripts/secrets-push.mjs <env>`.
//
// Policy (from the secrets-architecture map):
//   - upsert: set/overwrite every managed secret on its targets
//   - report orphans: list target-side vars we don't manage; NEVER delete them
//   - require the deployment-owned ones: unpushable, but fatal when absent
//   - never push a placeholder (REPLACE_ME) to real infrastructure

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  CONVEX_DEPLOYMENT_OWNED,
  KNOWN_TARGET_UNMANAGED,
  SECRETS,
  SOURCE_ONLY,
} from './secret-topology.mjs'

const CONVEX_DIR = 'packages/backend'
const PLACEHOLDER = 'REPLACE_ME'

const [env, ...flags] = process.argv.slice(2)
const APPLY = flags.includes('--apply')

if (env !== 'production' && env !== 'staging') {
  console.error('usage: secrets-push.mjs <production|staging> [--apply]')
  process.exit(2)
}

// production -> Vercel "production"        + Convex --prod
// staging    -> Vercel "preview" (built-in non-prod env; covers every branch/PR deploy
//               with one config) + Convex --deployment staging
const vercelTarget = env === 'production' ? 'production' : 'preview'
// A CONVEX_DEPLOY_KEY (the deploy rail, or a keyed local run) already selects the
// deployment, and Convex rejects an explicit --deployment/--prod alongside it.
// Without a key (plain local run) the flag is required to target the shared
// staging/prod deployment instead of the caller's personal dev deployment.
const convexFlags = process.env.CONVEX_DEPLOY_KEY
  ? []
  : env === 'production'
    ? ['--prod']
    : ['--deployment', 'staging']

const mask = v => (v == null ? '(unset)' : `set, ${v.length} chars`)
const dim = s => `\x1b[2m${s}\x1b[0m`
const bold = s => `\x1b[1m${s}\x1b[0m`
const warn = s => `\x1b[33m${s}\x1b[0m`
const green = s => `\x1b[32m${s}\x1b[0m`

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts })
}

// ---- guard: every secret in the env file must be consciously routed ----
// A key present in .env.<env> but in neither the managed map nor an explicit
// source-only/platform allowlist
// would be silently never pushed — the class of bug that left CONVEX_DEPLOYMENT
// unset on the deploys (every route 500s at cold start). Fail loudly instead of
// shipping a half-configured deploy.
const envKeys = readFileSync(resolve(process.cwd(), `.env.${env}`), 'utf8')
  .split('\n')
  .map(line => line.match(/^([A-Z][A-Z0-9_]*)=/)?.[1])
  .filter(Boolean)
const unrouted = envKeys.filter(
  k =>
    !Object.hasOwn(SECRETS, k) &&
    !KNOWN_TARGET_UNMANAGED.has(k) &&
    !SOURCE_ONLY.get(k)?.has(env) &&
    !k.startsWith('DOTENV_'),
)
if (unrouted.length > 0) {
  console.error(warn(`\nsecrets-push: ${unrouted.length} unrouted secret(s) in .env.${env}`))
  console.error(
    'Present in the env file but in neither the managed map nor an allowlist, so they\n' +
      'would be silently NOT pushed to any deploy target:\n' +
      unrouted.map(k => `  - ${k}`).join('\n') +
      '\nAdd each to SECRETS (to push it) or an explicit allowlist (to skip it).\n',
  )
  process.exit(2)
}

if (process.env.SITE_URL !== process.env.DUET_APP_URL) {
  console.error(
    warn(
      `\nsecrets-push: SITE_URL must equal DUET_APP_URL in .env.${env}; it is a fixed Convex Auth vendor alias.`,
    ),
  )
  process.exit(2)
}

// ---- build the plan ----
const plan = [] // { key, value, dest: 'vercel:api' | 'convex', proj: 'api' | null }
for (const [key, t] of Object.entries(SECRETS)) {
  if (t.environments && !t.environments.includes(env)) continue
  const value = process.env[t.valueFrom ?? key]
  for (const proj of t.vercel)
    plan.push({ key, value, dest: `vercel:${proj}`, proj, optional: t.optional })
  if (t.convex) plan.push({ key, value, dest: 'convex', proj: null, optional: t.optional })
}

console.log(bold(`\nsecrets push · env=${env} · ${APPLY ? green('APPLY') : warn('DRY-RUN')}`))
console.log(dim(`vercel target=${vercelTarget}   convex=${convexFlags.join(' ')}\n`))

// group plan by destination for a readable table
const byDest = {}
for (const p of plan) (byDest[p.dest] ??= []).push(p)

let missing = 0
let placeholders = 0
for (const dest of Object.keys(byDest).sort()) {
  console.log(bold(dest))
  for (const p of byDest[dest]) {
    let status = mask(p.value)
    if (p.value == null) {
      status = p.optional
        ? dim('optional bootstrap value not supplied')
        : warn('MISSING — not in source')
      if (!p.optional) missing++
    } else if (p.value === PLACEHOLDER) {
      status = warn('placeholder — will skip')
      placeholders++
    }
    console.log(`  ${p.key.padEnd(30)} ${dim(status)}`)
  }
  console.log('')
}

if (!APPLY) {
  console.log(
    dim(
      'dry-run only — re-run with `-- --apply` to write. Targets are read (names only), never modified.',
    ),
  )
  console.log(
    dim(
      `(would push ${plan.length} secret→target pairs across ${Object.keys(byDest).length} destinations)`,
    ),
  )
  if (missing) console.log(warn(`${missing} value(s) MISSING from the source file.`))
  if (placeholders)
    console.log(
      warn(
        `${placeholders} value(s) still ${PLACEHOLDER} — set them with \`dotenvx set\` before applying.`,
      ),
    )
  // A preflight that skipped the audit would stay silent about the one failure
  // that needs no write to diagnose: a deployment missing a secret only it owns.
  process.exit(missing || audit().length ? 1 : 0)
}

// ---- apply ----
let ok = 0
let skipped = 0
const fail = []

function setVercel(key, value, proj) {
  const cwd = `apps/${proj}`
  const { projectId, orgId } = JSON.parse(
    readFileSync(resolve(cwd, '.vercel/project.json'), 'utf8'),
  )
  const directory = mkdtempSync(join(tmpdir(), 'duet-vercel-env-'))
  try {
    const input = join(directory, 'input.json')
    writeFileSync(
      input,
      JSON.stringify({ type: 'encrypted', key, value, target: [vercelTarget] }),
      {
        mode: 0o600,
      },
    )
    try {
      sh('vercel', [
        'api',
        `/v10/projects/${encodeURIComponent(projectId)}/env?upsert=true&teamId=${encodeURIComponent(orgId)}`,
        '--method',
        'POST',
        '--input',
        input,
        '--silent',
        '--cwd',
        cwd,
      ])
    } catch {
      // API errors may echo the submitted value; keep diagnostics value-free.
      throw new Error('Vercel environment upsert failed')
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

function setConvex(key, value) {
  // convex env set overwrites in place — no rm needed.
  sh('bunx', ['convex', 'env', 'set', key, value, ...convexFlags], { cwd: CONVEX_DIR })
}

for (const p of plan) {
  if (p.value == null || p.value === PLACEHOLDER) {
    skipped++
    continue
  }
  try {
    if (p.dest === 'convex') setConvex(p.key, p.value)
    else setVercel(p.key, p.value, p.proj)
    ok++
    console.log(green(`  ✓ ${p.key} → ${p.dest}`))
  } catch (e) {
    fail.push({ ...p, err: (e.stderr || e.message || '').toString().trim().split('\n').pop() })
    console.log(warn(`  ✗ ${p.key} → ${p.dest}: ${fail.at(-1).err}`))
  }
}

const missingDeploymentOwned = audit()

console.log(
  bold(
    `\ndone · ${green(`${ok} set`)} · ${skipped ? warn(`${skipped} skipped (missing/placeholder)`) : '0 skipped'} · ${fail.length ? warn(`${fail.length} failed`) : '0 failed'}`,
  ),
)
process.exit(fail.length || missingDeploymentOwned.length ? 1 : 0)

function managedFor(dest) {
  return new Set(plan.filter(p => p.dest === dest).map(p => p.key))
}

// ---- target audit (report both directions of drift; never delete) ----
function audit() {
  console.log(
    bold(
      '\ntarget audit — vars this script does not manage (never deleted), and any required but absent:',
    ),
  )
  return auditTargets()
}

// Reads each target's own var list and reports both directions of drift:
// vars present that we don't manage, and vars we never push that must exist
// anyway. Returns the latter, which are fatal.
function auditTargets() {
  const dests = [...new Set(plan.map(p => p.dest))]
  const missingDeploymentOwned = []
  for (const dest of dests) {
    let names = []
    try {
      if (dest === 'convex') {
        names = sh('bunx', ['convex', 'env', 'list', '--names-only', ...convexFlags], {
          cwd: CONVEX_DIR,
        })
          .split('\n')
          .map(s => s.trim())
          .filter(Boolean)
      } else {
        const proj = dest.split(':')[1]
        // `vercel env ls <target>` prints a table; the first column is the name.
        names = sh('vercel', ['env', 'ls', vercelTarget, '--cwd', `apps/${proj}`])
          .split('\n')
          .map(l => l.trim().split(/\s+/)[0])
          .filter(n => n && /^[A-Z][A-Z0-9_]*$/.test(n))
      }
    } catch (e) {
      console.log(dim(`  ${dest}: could not list (${(e.message || '').split('\n')[0]})`))
      continue
    }
    if (dest === 'convex') {
      const absent = [...CONVEX_DEPLOYMENT_OWNED].filter(n => !names.includes(n))
      missingDeploymentOwned.push(...absent)
      if (absent.length) {
        const flag = env === 'production' ? ' --prod' : ''
        console.log(
          warn(
            `  ${dest}: MISSING deployment-owned → ${absent.join(', ')}\n` +
              `    Nobody can sign in against this deployment until they exist.\n` +
              `    Generate them with: bunx @convex-dev/auth${flag}`,
          ),
        )
      } else {
        const present = [...CONVEX_DEPLOYMENT_OWNED].join(', ')
        console.log(green(`  ${dest}: deployment-owned present → ${present}`))
      }
    }
    const managed = managedFor(dest)
    // Deployment-owned vars are reported above, by presence rather than as
    // incidental leftovers -- they are required, not merely tolerated.
    const reportedByPresence = dest === 'convex' ? CONVEX_DEPLOYMENT_OWNED : new Set()
    const orphans = names.filter(n => !managed.has(n) && !reportedByPresence.has(n))
    const unknown = orphans.filter(n => !KNOWN_TARGET_UNMANAGED.has(n))
    const expected = orphans.filter(n => KNOWN_TARGET_UNMANAGED.has(n))
    if (!orphans.length) {
      console.log(green(`  ${dest}: none`))
      continue
    }
    if (unknown.length)
      console.log(warn(`  ${dest}: ${unknown.length} unknown → ${unknown.join(', ')}`))
    if (expected.length)
      console.log(
        dim(
          `  ${dest}: ${expected.length} expected (config/tool-generated) → ${expected.join(', ')}`,
        ),
      )
  }
  return missingDeploymentOwned
}
