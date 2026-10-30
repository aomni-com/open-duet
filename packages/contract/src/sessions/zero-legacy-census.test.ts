import { expect, test } from 'bun:test'
import { resolve } from 'node:path'

import {
  SessionArchiveRequestSchema,
  SessionEventResumeQuerySchema,
  SessionHistoryPageSchema,
  SessionHistoryQuerySchema,
  SessionListPageSchema,
  SessionListItemSchema,
  SessionSnapshotSchema,
} from './index'

const repoRoot = resolve(import.meta.dir, '../../../..')
const consumerRoots = [
  'apps/api/src',
  'apps/web/spa',
  'packages/gateway/src',
  'packages/contract/src/sessions',
  'apps/mcp/src',
  'packages/duet/src',
  'apps/docs/app',
  'packages/test-harness/src',
  'packages/skills-registry/skills',
  'packages/official-agents-seed/content',
  'packages/backend/scripts',
] as const

const canonicalTestSources = [
  'apps/api/src/sessions.test.ts',
  'packages/backend/src/agent-sessions/job-list.tests.ts',
  'packages/test-harness/src/staging-live-pagination.ts',
  'packages/test-harness/src/staging-live-agent-sessions.ts',
  'packages/test-harness/src/staging-live-agents.ts',
  'packages/test-harness/src/staging-live-browser-acceptance.ts',
  'packages/test-harness/src/staging-live-retrain-memory.ts',
  'packages/test-harness/src/staging-live-train.ts',
] as const

const forbiddenSourceRules = [
  { name: 'public SSE since query', pattern: /events\?[^\s'"`]*since=/ },
  { name: 'numeric history cursor', pattern: /history\?[^\s'"`]*cursor=\d/ },
  { name: 'numeric history before', pattern: /history\?[^\s'"`]*before=\d/ },
  {
    name: 'old archive body',
    pattern: /JSON\.stringify\(\{\s*archived\s*:|['"]\{["']archived["']\s*:/,
  },
  { name: 'old archive include filter', pattern: /archived(?:=|%3D)include/ },
  { name: 'removed jobs alias', pattern: /\/agent\/jobs(?:[?/'"`]|$)/ },
  {
    name: 'old agents/apps collection envelope',
    pattern: /\.(?:agents|apps)\[\]|\bagentsBody\.agents\b/,
  },
  { name: 'removed single-member writer', pattern: /\bsetSessionMemberGrant\b/ },
  { name: 'removed single-member fixture alias', pattern: /\bsetMemberGrantForTest\b/ },
  { name: 'legacy regex mutation mapper', pattern: /\blegacySessionMutationError\b/ },
  {
    name: 'old list page sessions access',
    pattern:
      /\b(?:response|page|result|data|body|payload)(?:\.sessions\b|\[['"]sessions['"]\])|\b(?:const|let|var)\s*{[^}]*\bsessions\b[^}]*}\s*=/,
  },
  {
    name: 'old history page events access',
    pattern:
      /\b(?:response|page|result|data|body|payload)(?:\.events\b|\[['"]events['"]\])|\b(?:const|let|var)\s*{[^}]*\bevents\b[^}]*}\s*=/,
  },
  {
    name: 'flat public userId access',
    pattern: /\b(?:snapshot|session|summary|item|row|created|result|data|body|payload)\.userId\b/,
  },
  {
    name: 'flat public archivedAt access',
    pattern:
      /\b(?:snapshot|session|summary|item|row|created|result|data|body|payload)\.archivedAt\b/,
  },
] as const

const intentionalDeployedNegativeProbes = new Map<string, number>([
  ['packages/gateway/src/sync/read-mode-enforcer.ts\0public SSE since query', 1],
  ['packages/test-harness/src/staging-live-specific-people-sessions.ts\0public SSE since query', 1],
  ['packages/test-harness/src/staging-live-specific-people-sessions.ts\0numeric history cursor', 1],
  ['packages/test-harness/src/staging-live-specific-people-sessions.ts\0numeric history before', 1],
  ['packages/test-harness/src/staging-live-specific-people-sessions.ts\0old archive body', 1],
  [
    'packages/test-harness/src/staging-live-specific-people-sessions.ts\0old archive include filter',
    1,
  ],
  ['packages/test-harness/src/staging-live-deployment.ts\0removed jobs alias', 1],
  ['apps/api/src/session-event-stream.ts\0old history page events access', 1],
  ['apps/api/src/routes/workspaces.ts\0flat public userId access', 3],
  ['apps/api/src/routes/oauth.ts\0flat public userId access', 3],
  ['apps/api/src/routes/analytics.ts\0flat public userId access', 1],
  ['apps/api/src/routes/device.ts\0flat public userId access', 1],
  ['apps/api/src/routes/users.ts\0flat public userId access', 15],
  ['apps/api/src/routes/billing.ts\0flat public userId access', 8],
  ['apps/web/spa/files/activity-feed.tsx\0flat public userId access', 1],
  ['apps/web/spa/files/activity-feed.tsx\0old history page events access', 1],
  ['apps/web/spa/files/attribution.tsx\0flat public userId access', 3],
  ['apps/web/spa/files/attribution.tsx\0old history page events access', 1],
  ['packages/gateway/src/agent-sessions/coordinator.ts\0old list page sessions access', 1],
  ['apps/web/spa/sessions/session-data.ts\0old history page events access', 3],
  [
    'packages/test-harness/src/staging-live-specific-people-sessions.ts\0flat public userId access',
    1,
  ],
])

const forbiddenTestSourceRules = [
  {
    name: 'test expects full list machine',
    pattern: /\b(?:definitionName|followingDefinitionState|orderedPath)\s*:/,
  },
  {
    name: 'test expects old history events page',
    pattern: /\bas\s*\{\s*events\s*:\s*SessionTimelineEntry\[\]\s*\}/,
  },
  {
    name: 'harness expects old training records page',
    pattern: /\b(?:before|after|list|rootRecords|agentRecords)\.records\b/,
  },
] as const

test('repo/runtime session seam census has zero frozen legacy surfaces', async () => {
  expect(SessionEventResumeQuerySchema.safeParse({ since: '0' }).success).toBe(false)
  expect(SessionHistoryQuerySchema.safeParse({ cursor: 1 }).success).toBe(false)
  expect(SessionHistoryQuerySchema.safeParse({ before: 1 }).success).toBe(false)
  expect(SessionListPageSchema.safeParse({ sessions: [], nextCursor: null }).success).toBe(false)
  expect(SessionHistoryPageSchema.safeParse({ events: [], nextCursor: null }).success).toBe(false)
  expect(SessionArchiveRequestSchema.safeParse({ archived: true }).success).toBe(false)

  expect(SessionListPageSchema.keyof().options).toEqual(['items', 'nextCursor'])
  expect(SessionHistoryPageSchema.keyof().options).toEqual(['items', 'nextCursor'])
  expect(SessionListItemSchema.keyof().options).not.toContain('userId')
  expect(SessionListItemSchema.keyof().options).not.toContain('archivedAt')
  expect(SessionSnapshotSchema.keyof().options).not.toContain('userId')
  expect(SessionSnapshotSchema.keyof().options).not.toContain('archivedAt')

  const publicSnapshot = SessionSnapshotSchema.parse(snapshotFixture())
  expect(publicSnapshot).not.toHaveProperty('userId')
  expect(publicSnapshot).not.toHaveProperty('archivedAt')

  const files = await consumerFiles()
  expect(files.length).toBeGreaterThan(100)
  const failures: string[] = []
  const deployedNegativeProbeCounts = new Map<string, number>()
  for (const path of files) {
    const relativePath = path.slice(repoRoot.length + 1)
    const source = await Bun.file(path).text()
    for (const [index, line] of source.split('\n').entries()) {
      for (const rule of forbiddenSourceRules) {
        if (rule.pattern.test(line)) {
          const probeKey = `${relativePath}\0${rule.name}`
          if (intentionalDeployedNegativeProbes.has(probeKey)) {
            deployedNegativeProbeCounts.set(
              probeKey,
              (deployedNegativeProbeCounts.get(probeKey) ?? 0) + 1,
            )
          } else {
            failures.push(`${rule.name}: ${relativePath}:${index + 1}`)
          }
        }
      }
    }
  }
  expect(failures).toEqual([])
  expect([...deployedNegativeProbeCounts].sort()).toEqual(
    [...intentionalDeployedNegativeProbes].sort(),
  )

  const staleTestExpectations: string[] = []
  for (const relativePath of canonicalTestSources) {
    const source = await Bun.file(resolve(repoRoot, relativePath)).text()
    for (const [index, line] of source.split('\n').entries()) {
      for (const rule of forbiddenTestSourceRules) {
        if (rule.pattern.test(line)) {
          staleTestExpectations.push(`${rule.name}: ${relativePath}:${index + 1}`)
        }
      }
    }
  }
  expect(staleTestExpectations).toEqual([])
})

async function consumerFiles(): Promise<string[]> {
  const files: string[] = []
  for (const root of consumerRoots) {
    for await (const path of new Bun.Glob('**/*.{ts,tsx,md,mdx}').scan({
      cwd: resolve(repoRoot, root),
      absolute: true,
    })) {
      if (path.endsWith('.test.ts') || path.endsWith('.test.tsx')) continue
      files.push(path)
    }
  }
  return files.sort()
}

function snapshotFixture() {
  return {
    id: 'session-census',
    workspaceId: 'workspace-census',
    userId: 'internal-attribution',
    archivedAt: 10,
    turnStatus: 'complete',
    bucket: 'done',
    prompt: 'Prompt',
    title: 'Title',
    titleOrigin: 'excerpt',
    titleStatus: 'complete',
    searchText: 'title\nprompt',
    archiveState: 'active',
    visible: true,
    lastEventSeq: 0,
    lastDeliveredInputSeq: 0,
    unread: false,
    audience: { kind: 'workspace' },
    archive: { globalArchivedAt: null, personalArchivedAt: null, reason: null },
    permissions: {
      send: true,
      answer: true,
      interrupt: true,
      rename: true,
      manageAudience: true,
      personalArchive: false,
      globalArchive: true,
      delete: true,
    },
    createdAt: 1,
    updatedAt: 1,
  }
}
