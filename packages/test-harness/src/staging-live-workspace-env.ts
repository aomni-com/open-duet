import path from 'node:path'

import { convexUrlsFromDeployment } from '@repo/contract'

import type { LiveEnv } from './staging-live-env.ts'

const REQUIRED_WORKSPACE_JOURNEY_ENV = [
  'DUET_API_URL',
  'CONVEX_DEPLOYMENT',
  'DUET_API_INTERNAL_KEY',
  'DUET_PROGRAMMATIC_LOGIN_SECRET',
  'VERCEL_AUTOMATION_BYPASS_SECRET',
  'AGENTMAIL_API_KEY',
  'DUET_E2E_AGENTMAIL_INBOX_ADDRESS',
] as const

export type WorkspaceJourneyEnv = Pick<
  LiveEnv,
  | 'apiUrl'
  | 'docsUrl'
  | 'convexUrl'
  | 'internalKey'
  | 'loginSecret'
  | 'vercelBypassSecret'
  | 'artifactRoot'
  | 'agentMailApiKey'
  | 'agentMailInboxId'
  | 'agentMailInboxAddress'
>

export function readWorkspaceJourneyEnv(
  source: NodeJS.ProcessEnv = process.env,
): WorkspaceJourneyEnv {
  const missing = REQUIRED_WORKSPACE_JOURNEY_ENV.filter(name => !source[name]?.trim())
  if (missing.length > 0) {
    throw new Error(`Missing required workspace journey env: ${missing.join(', ')}`)
  }
  const apiUrl = stagingUrl('DUET_API_URL', source.DUET_API_URL!)
  const docsUrl = stagingUrl(
    'DUET_DOCS_URL',
    source.DUET_DOCS_URL?.trim() || 'https://docs-staging.duet.so',
  )
  return {
    apiUrl,
    docsUrl,
    convexUrl: convexUrlsFromDeployment(source.CONVEX_DEPLOYMENT!).cloudUrl,
    internalKey: source.DUET_API_INTERNAL_KEY!,
    loginSecret: source.DUET_PROGRAMMATIC_LOGIN_SECRET!,
    vercelBypassSecret: source.VERCEL_AUTOMATION_BYPASS_SECRET!,
    artifactRoot: source.DUET_E2E_ARTIFACT_DIR?.trim() || path.resolve('artifacts/staging-live'),
    agentMailApiKey: source.AGENTMAIL_API_KEY!,
    // Resolved fresh per journey from the address below; mirrors LiveEnv, which
    // also carries the id empty until the inbox is looked up.
    agentMailInboxId: '',
    agentMailInboxAddress: source.DUET_E2E_AGENTMAIL_INBOX_ADDRESS!.trim().toLowerCase(),
  }
}

function stagingUrl(name: string, value: string): string {
  const normalized = value.trim().replace(/\/+$/, '')
  if (!new URL(normalized).hostname.includes('staging')) {
    throw new Error(`${name} must target a staging hostname`)
  }
  return normalized
}
