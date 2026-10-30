import assert from 'node:assert/strict'
import path from 'node:path'

import { chromium } from '@playwright/test'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import {
  isActionableBrowserError,
  runRouteSweeps,
  type StagingBrowserEnv,
} from './staging-live-browser.ts'
import type { LiveEnv } from './staging-live-env.ts'
import { errorMessage } from './staging-live-http.ts'
import { verifyPublicForms } from './staging-live-public-site.ts'

export type PublicHttpEnv = Pick<LiveEnv, 'landerUrl' | 'vercelBypassSecret' | 'artifactRoot'>

export type PublicBrowserEnv = StagingBrowserEnv & Pick<LiveEnv, 'artifactRoot' | 'headless'>

export interface PublicJourneyResult<T> {
  journey: string
  runId: string
  artifactDirectory: string
  evidence: T
}

export function readPublicHttpEnv(source: NodeJS.ProcessEnv = process.env): PublicHttpEnv {
  const [landerUrl, vercelBypassSecret] = requireStagingEnv(source, [
    'DUET_LANDER_URL',
    'VERCEL_AUTOMATION_BYPASS_SECRET',
  ])
  return {
    landerUrl: stagingUrl('DUET_LANDER_URL', landerUrl),
    vercelBypassSecret,
    artifactRoot: source.DUET_E2E_ARTIFACT_DIR?.trim() || path.resolve('artifacts/staging-live'),
  }
}

export function readPublicBrowserEnv(source: NodeJS.ProcessEnv = process.env): PublicBrowserEnv {
  const publicHttp = readPublicHttpEnv(source)
  const [apiUrl, appUrl] = requireStagingEnv(source, ['DUET_API_URL', 'DUET_APP_URL'])
  const docsUrl = source.DUET_DOCS_URL?.trim() || 'https://docs-staging.duet.so'
  return {
    ...publicHttp,
    apiUrl: stagingUrl('DUET_API_URL', apiUrl),
    appUrl: stagingUrl('DUET_APP_URL', appUrl),
    docsUrl: stagingUrl('DUET_DOCS_URL', docsUrl),
    headless: source.DUET_E2E_HEADLESS !== '0',
  }
}

export async function runPublicFormsJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<PublicJourneyResult<{ validations: number }>> {
  const env = readPublicHttpEnv()
  return await runPublicJourney({
    journey: 'public-forms',
    env,
    onProgress: options.onProgress,
    run: async artifacts => {
      await verifyPublicForms(env, artifacts)
      return { validations: 2 }
    },
  })
}

export async function runPublicRoutesJourney(
  options: { onProgress?: (stage: string) => void } = {},
): Promise<PublicJourneyResult<{ lander: number; docs: number }>> {
  const env = readPublicBrowserEnv()
  return await runPublicJourney({
    journey: 'public-routes',
    env,
    onProgress: options.onProgress,
    run: async artifacts => {
      const browser = await chromium.launch({ headless: env.headless })
      try {
        const evidence = await runRouteSweeps(env, browser, artifacts)
        const actionable = artifacts.browserErrors.filter(isActionableBrowserError)
        assert.equal(
          actionable.length,
          0,
          `public route sweep emitted ${actionable.length} console/network error(s)`,
        )
        return evidence
      } finally {
        await browser.close()
      }
    },
  })
}

async function runPublicJourney<T>(args: {
  journey: string
  env: PublicHttpEnv
  run: (artifacts: StagingArtifactCollector) => Promise<T>
  onProgress?: (stage: string) => void
}): Promise<PublicJourneyResult<T>> {
  const runId = `staging-e2e-${args.journey}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`
  const artifactDirectory = path.join(args.env.artifactRoot, runId)
  const artifacts = new StagingArtifactCollector(artifactDirectory, [args.env.vercelBypassSecret])
  let evidence: T | undefined
  let failure: unknown

  await artifacts.initialize()
  try {
    args.onProgress?.('acceptance')
    evidence = await args.run(artifacts)
  } catch (error) {
    failure = error
    throw error
  } finally {
    args.onProgress?.('artifacts')
    await Promise.all([
      artifacts.flushDiagnostics(),
      artifacts.writeJson('journey.json', {
        journey: args.journey,
        runId,
        artifactDirectory,
        evidence,
        ...(failure === undefined ? {} : { error: errorMessage(failure) }),
      }),
    ])
  }

  assert(evidence !== undefined, 'public journey completed without evidence')
  return { journey: args.journey, runId, artifactDirectory, evidence }
}

function requireStagingEnv<const Names extends readonly string[]>(
  source: NodeJS.ProcessEnv,
  names: Names,
): { [Index in keyof Names]: string } {
  const missing = names.filter(name => !source[name]?.trim())
  if (missing.length > 0) {
    throw new Error(`Missing required public staging env: ${missing.join(', ')}`)
  }
  return names.map(name => source[name]!.trim()) as { [Index in keyof Names]: string }
}

function stagingUrl(name: string, value: string): string {
  const normalized = value.replace(/\/+$/, '')
  if (!new URL(normalized).hostname.includes('staging')) {
    throw new Error(`${name} must target a staging hostname`)
  }
  return normalized
}
