#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  backendReleaseRevisionSource,
  deploymentRailPlan,
  railMode,
  releaseRevisionForRail,
} from './vercel-deploy-rail.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plan = deploymentRailPlan(process.env.VERCEL_ENV)
const { mode, missing } = railMode(plan, process.env)

if (mode === 'skip-unbootstrapped' || mode === 'skip-preview') {
  if (mode === 'skip-preview') {
    console.log(
      'deployment rail: preview builds against the shared staging backend; only staging publishes it',
    )
  } else {
    console.warn(
      `deployment rail: NOT BOOTSTRAPPED (missing ${missing.join(', ')}) — ` +
        'skipping Convex deploy and seed publication; backend state can drift until bootstrapped',
    )
  }
  execFileSync('bun', ['run', '--cwd', 'apps/api', 'build:vercel'], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  })
  process.exit(0)
}
if (mode === 'fail') {
  throw new Error(`deployment rail: missing required environment variables: ${missing.join(', ')}`)
}

const releaseRevision = releaseRevisionForRail(process.env)
const backendRevisionPath = resolve(repoRoot, 'packages/backend/convex/deploymentRevision.ts')
const originalRevisionSource = readFileSync(backendRevisionPath, 'utf8')
writeFileSync(backendRevisionPath, backendReleaseRevisionSource(releaseRevision), 'utf8')

console.log(`deployment rail: Vercel ${process.env.VERCEL_ENV ?? '(unset)'} -> ${plan.environment}`)

try {
  for (const step of plan.steps) {
    execFileSync(step.command, step.args, {
      cwd: resolve(repoRoot, step.cwd),
      env: process.env,
      stdio: 'inherit',
    })
  }
} finally {
  writeFileSync(backendRevisionPath, originalRevisionSource, 'utf8')
}
