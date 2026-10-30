'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NextIntlClientProvider } from 'next-intl'
import { useState } from 'react'

import type {
  InternalAdminFleetHealth,
  InternalAdminInferenceMargin,
  UsageReportPeriod,
} from '@repo/contract'

import appEn from '../../messages/en/app.json'
import appEs from '../../messages/es-419/app.json'
import { DuetApiError } from '../../spa/api/client'
import { InternalAdminSurface, type InternalAdminApi } from '../../spa/routes/internal-admin'
import { CURRENT_RUNTIME_VERSION, PREVIOUS_RUNTIME_VERSION } from './runtime-fixture'

type Scenario =
  | 'workspace'
  | 'workspace-zero-sync'
  | 'fleet'
  | 'inference'
  | 'model-router'
  | 'feedback'
  | 'feedback-empty'
  | 'credits'
  | 'loading'
  | 'error'
  | 'denied'
  | 'spanish-workspace'
  | 'spanish-credits'

const WORKSPACE = {
  id: 'workspace_acme',
  slug: 'acme',
  name: 'Acme Studio',
  status: 'active' as const,
  servicingStatus: 'active' as const,
  suspended: false,
  billingUserId: 'user_owner',
  billingEmail: 'owner@acme.test',
  stripeCustomerId: 'cus_acme_fixture',
  servicingExemptAt: undefined as number | undefined,
  paidCreditBalanceMicroUsd: 117_320_000,
  monthlyCreditBalanceMicroUsd: 42_000_000,
  memberCount: 3,
  vmName: 'duet-acme',
  sshDest: 'duet-acme.exe.xyz',
  runtimeVersion: CURRENT_RUNTIME_VERSION,
  imageVersion: '2026.07.10',
  lastHeartbeatAt: Date.UTC(2026, 6, 11, 9, 25),
}

const FLEET_NOW = Date.UTC(2026, 8, 4, 19, 0)
// A snapshot with each highlight the view exists to show: runtime mid-rollout
// (two builds), one wedged VM (stale heartbeat + a whole core burning), one
// freshly provisioning VM with no sample yet.
const FLEET_HEALTH: InternalAdminFleetHealth = {
  generatedAt: FLEET_NOW,
  activeCount: 4,
  truncated: false,
  versions: {
    runtime: [
      { label: CURRENT_RUNTIME_VERSION, count: 3 },
      { label: PREVIOUS_RUNTIME_VERSION, count: 1 },
    ],
  },
  staleHeartbeatCount: 1,
  updates: { paused: false },
  telemetry: {
    withSample: 3,
    missing: 1,
    newestSampleAgeMs: 6 * 60 * 1000,
    oldestSampleAgeMs: 52 * 60 * 1000,
  },
  vms: [
    {
      workspaceId: 'workspace_wedged',
      slug: 'dan-test',
      vmName: 'duet-ws-9a1a4312',
      status: 'active',
      runtimeVersion: PREVIOUS_RUNTIME_VERSION,
      heartbeatAgeMs: 41 * 60 * 1000,
      cpuCores: 1.42,
      cpuPct: 14,
      memUsedMb: 5_700,
      memTotalMb: 24_576,
      sampleAgeMs: 8 * 60 * 1000,
    },
    {
      workspaceId: 'workspace_desktop',
      slug: 'jamar',
      vmName: 'duet-ws-db246b01',
      status: 'active',
      runtimeVersion: CURRENT_RUNTIME_VERSION,
      heartbeatAgeMs: 9 * 1000,
      cpuCores: 0.51,
      cpuPct: 5,
      memUsedMb: 1_300,
      memTotalMb: 8_192,
      sampleAgeMs: 6 * 60 * 1000,
    },
    {
      workspaceId: 'workspace_idle',
      slug: 'acme',
      vmName: 'duet-ws-0a30d000',
      status: 'active',
      servicingStatus: 'active',
      runtimeVersion: CURRENT_RUNTIME_VERSION,
      heartbeatAgeMs: 3 * 1000,
      cpuCores: 0.02,
      cpuPct: 0,
      memUsedMb: 900,
      memTotalMb: 8_192,
      sampleAgeMs: 52 * 60 * 1000,
    },
    {
      workspaceId: 'workspace_fresh',
      slug: 'newco',
      vmName: 'duet-ws-fresh0001',
      status: 'provisioning',
      runtimeVersion: CURRENT_RUNTIME_VERSION,
      heartbeatAgeMs: 14 * 1000,
    },
  ],
  auditId: 'audit_fleet',
}

// A week of folded spend with each highlight the view exists to show: tiers
// billing above cost, an untiered media row billed at cost, and one model whose
// flat tier rate sits below what the provider charged.
const INFERENCE_DAYS = [
  ['2026-09-17', 2140, 212_480_000, 468_310_000],
  ['2026-09-16', 3012, 264_900_000, 571_020_000],
  ['2026-09-15', 2877, 241_160_000, 540_770_000],
  ['2026-09-14', 1905, 150_330_000, 342_900_000],
  ['2026-09-13', 1622, 131_050_000, 301_480_000],
] as const

const INFERENCE_OLDER_THROUGH = Date.UTC(2026, 7, 19) - 1

function inferenceMargin(
  granularity: UsageReportPeriod,
  through: number | undefined,
): InternalAdminInferenceMargin {
  // The window before this one predates the fold: it reads empty, and pages
  // forward back to today.
  if (through !== undefined && through <= INFERENCE_OLDER_THROUGH) {
    return {
      granularity,
      window: { start: '2026-07-20', end: '2026-08-18' },
      olderThrough: Date.UTC(2026, 6, 20) - 1,
      newerThrough: Date.UTC(2026, 8, 17, 16, 40),
      totals: { calls: 0, upstreamCostMicroUsd: 0, billedCostMicroUsd: 0 },
      periods: [],
      models: [],
      truncated: false,
      auditId: 'audit_inference_margin_older',
    }
  }
  const periods = INFERENCE_DAYS.map(([period, calls, upstream, billed]) => {
    // Untiered calls bill at cost; frontier takes whatever the other rows leave,
    // so every period's tiers sum exactly to its totals.
    const share = (value: number, fraction: number) => Math.round(value * fraction)
    const balanced = {
      calls: share(calls, 0.42),
      upstreamCostMicroUsd: share(upstream, 0.15),
      billedCostMicroUsd: share(billed, 0.13),
    }
    const untiered = {
      calls: share(calls, 0.03),
      upstreamCostMicroUsd: share(upstream, 0.02),
      billedCostMicroUsd: share(upstream, 0.02),
    }
    const frontier = {
      calls: calls - balanced.calls - untiered.calls,
      upstreamCostMicroUsd:
        upstream - balanced.upstreamCostMicroUsd - untiered.upstreamCostMicroUsd,
      billedCostMicroUsd: billed - balanced.billedCostMicroUsd - untiered.billedCostMicroUsd,
    }
    return {
      period,
      calls,
      upstreamCostMicroUsd: upstream,
      billedCostMicroUsd: billed,
      tiers: [
        { tier: 'frontier' as const, ...frontier },
        { tier: 'balanced' as const, ...balanced },
        untiered,
      ],
    }
  })
  const sum = (key: 'calls' | 'upstreamCostMicroUsd' | 'billedCostMicroUsd') =>
    periods.reduce((total, period) => total + period[key], 0)
  const totals = {
    calls: sum('calls'),
    upstreamCostMicroUsd: sum('upstreamCostMicroUsd'),
    billedCostMicroUsd: sum('billedCostMicroUsd'),
  }
  const named: InternalAdminInferenceMargin['models'] = [
    {
      tier: 'balanced',
      model: 'openai/gpt-5.6-sol',
      provider: 'openai',
      routeSource: 'configured_upstream',
      calls: 20,
      upstreamCostMicroUsd: 0,
      billedCostMicroUsd: 3_000_000,
    },
    {
      tier: 'frontier',
      model: 'anthropic/claude-opus-5',
      provider: 'vertexAnthropic',
      calls: 2412,
      upstreamCostMicroUsd: 486_120_000,
      billedCostMicroUsd: 850_310_000,
    },
    {
      tier: 'frontier',
      model: 'openai/gpt-5.6-sol',
      provider: 'openai',
      calls: 4820,
      upstreamCostMicroUsd: 204_700_000,
      billedCostMicroUsd: 845_900_000,
    },
    {
      tier: 'balanced',
      model: 'anthropic/claude-fable-5.1',
      provider: 'anthropic',
      calls: 61,
      upstreamCostMicroUsd: 58_400_000,
      billedCostMicroUsd: 27_300_000,
    },
    {
      tier: 'balanced',
      model: 'openai/gpt-5.6-luna',
      provider: 'openai',
      calls: 3380,
      upstreamCostMicroUsd: 7_010_000,
      billedCostMicroUsd: 44_200_000,
    },
    {
      model: 'xai/grok-imagine-video-1.5',
      provider: 'xai',
      calls: 24,
      upstreamCostMicroUsd: 18_600_000,
      billedCostMicroUsd: 18_600_000,
    },
  ]
  // The window's remaining spend, so the model rows sum to the totals like the
  // server's do.
  const rest = (key: 'calls' | 'upstreamCostMicroUsd' | 'billedCostMicroUsd') =>
    totals[key] - named.reduce((total, model) => total + model[key], 0)
  return {
    granularity,
    window: { start: '2026-08-19', end: '2026-09-17' },
    olderThrough: INFERENCE_OLDER_THROUGH,
    totals,
    periods,
    // Most expensive first, the server's order.
    models: [
      ...named,
      {
        tier: 'frontier' as const,
        model: 'moonshotai/kimi-k3',
        provider: 'baseten',
        calls: rest('calls'),
        upstreamCostMicroUsd: rest('upstreamCostMicroUsd'),
        billedCostMicroUsd: rest('billedCostMicroUsd'),
      },
    ].sort((left, right) => right.upstreamCostMicroUsd - left.upstreamCostMicroUsd),
    truncated: false,
    updatedAt: Date.UTC(2026, 8, 17, 16, 40),
    auditId: 'audit_inference_margin',
  }
}

export function InternalAdminPlayground() {
  const [scenario, setScenario] = useState<Scenario>('workspace')
  const locale = scenario.startsWith('spanish-') ? 'es-419' : 'en'
  return (
    <NextIntlClientProvider locale={locale} messages={locale === 'es-419' ? appEs : appEn}>
      <nav className="sr-only" aria-label="Internal admin fixture scenarios">
        {(
          [
            'workspace',
            'workspace-zero-sync',
            'fleet',
            'inference',
            'model-router',
            'feedback',
            'feedback-empty',
            'credits',
            'loading',
            'error',
            'denied',
            'spanish-workspace',
            'spanish-credits',
          ] as const
        ).map(value => (
          <button key={value} onClick={() => setScenario(value)}>
            Admin scenario: {value}
          </button>
        ))}
      </nav>
      <AdminFixture key={scenario} scenario={scenario} />
    </NextIntlClientProvider>
  )
}

function AdminFixture({ scenario }: { scenario: Scenario }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  )
  const [api] = useState(() => fixtureApi(scenario))
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-[820px] overflow-hidden rounded-2xl border bg-background shadow-sm">
        <InternalAdminSurface
          api={api}
          allowed={scenario !== 'denied'}
          onOpenWorkspace={() => {}}
          initialSection={
            scenario.startsWith('feedback')
              ? 'feedback'
              : scenario === 'credits' || scenario === 'spanish-credits'
                ? 'credits'
                : scenario === 'fleet' || scenario === 'inference'
                  ? scenario
                  : scenario === 'model-router'
                    ? 'modelRouter'
                    : 'workspaces'
          }
          initialSearch={
            scenario === 'workspace' ||
            scenario === 'workspace-zero-sync' ||
            scenario === 'spanish-workspace'
              ? 'acme'
              : scenario === 'loading' || scenario === 'error'
                ? 'acme'
                : ''
          }
        />
      </div>
    </QueryClientProvider>
  )
}

function fixtureApi(scenario: Scenario): InternalAdminApi {
  let backupReads = 0
  let createdEmail: string | undefined
  let suspended = false
  let unpaused = false
  let servicingExempt =
    typeof window !== 'undefined' && new URL(window.location.href).searchParams.has('exempt')
  let billingUserId = WORKSPACE.billingUserId
  let billingEmail = WORKSPACE.billingEmail
  const wait = () => new Promise<never>(() => undefined)
  const fail = async () => {
    throw new Error('Fixture admin failure')
  }
  return {
    internalAdminCreateUser: async ({ email }) => {
      if (email === WORKSPACE.billingEmail) throw new DuetApiError(409, 'user_already_exists')
      createdEmail = email
      return {
        userId: 'user_new',
        email,
        workspaceId: 'workspace_new',
        workspaceSlug: 'new-workspace',
      }
    },
    internalAdminUserCleanupPreview: async () => ({
      user: { userId: 'user_owner', email: WORKSPACE.billingEmail }, selfTarget: false,
      alreadyRetired: false, canStart: true, workspaces: [], blockers: [],
      identity: { kind: 'retire_identity', userId: 'user_owner' },
      retainedHistory: { kind: 'retained_history', tables: [] }, auditId: 'cleanup_preview',
    }),
    internalAdminStartUserCleanup: async () => ({
      operationId: 'cleanup_fixture', targetUserId: 'user_owner', status: 'scheduled',
      canRetry: false, resources: [], auditId: 'cleanup_start',
    }),
    internalAdminCleanupStatus: async () => ({
      operationId: 'cleanup_fixture', targetUserId: 'user_owner', status: 'completed',
      canRetry: false, resources: [], auditId: 'cleanup_status',
    }),
    internalAdminRetryUserCleanup: async () => ({
      operationId: 'cleanup_fixture', targetUserId: 'user_owner', status: 'scheduled',
      canRetry: false, resources: [], auditId: 'cleanup_retry',
    }),
    internalAdminOpenOfficialHub: async () => ({
      token: 'duet_imp_fixture',
      prefix: 'duet_imp_fixt',
      expiresAt: Date.UTC(2026, 6, 11, 11),
      userId: 'user_official_owner',
      workspaceSlug: 'official-agents-hub',
      created: false,
    }),
    internalAdminSyncOfficialHub: async () => ({
      workspaceId: 'workspace_official_hub',
      workspaceSlug: 'official-agents-hub',
      publishId: 'publish_official_agents',
      // A sync that changed something — the case worth seeing in a shot, since
      // the empty-list case renders the quieter of the two messages.
      written: ['agents/research-assistant/AGENTS.md'],
      deleted: [],
      retiredAgents: [{ slug: 'recruiter', path: 'agents/recruiter' }],
    }),
    internalAdminSearch:
      scenario === 'loading'
        ? wait
        : scenario === 'error'
          ? fail
          : async identifier => ({
              workspaces: [
                createdEmail !== undefined && identifier === createdEmail
                  ? {
                      ...WORKSPACE,
                      id: 'workspace_new',
                      slug: 'new-workspace',
                      name: 'New Workspace',
                      billingEmail: createdEmail,
                    }
                  : WORKSPACE,
              ],
              auditId: 'audit_search',
            }),
    internalAdminWorkspace: async () => ({
      workspace: {
        ...WORKSPACE,
        billingUserId,
        billingEmail,
        memberCount: new URL(window.location.href).searchParams.has('controlled-payer')
          ? 4
          : WORKSPACE.memberCount,
        suspended,
        servicingExemptAt: servicingExempt ? FLEET_NOW : undefined,
        servicingStatus:
          !servicingExempt && !unpaused && new URL(window.location.href).searchParams.has('paused')
            ? 'paused'
            : 'active',
      },
      usage: {
        month: '2026-07',
        spendMicroUsd: 42_680_000,
        inputTokens: 8_420_000,
        outputTokens: 1_120_000,
        members: [
          ...(new URL(window.location.href).searchParams.has('controlled-payer')
            ? [
                {
                  userId: 'user_billing_owner',
                  email: 'billing@acme.test',
                  name: 'Morgan Reed',
                  role: 'owner' as const,
                  spendMicroUsd: 0,
                  inputTokens: 0,
                  outputTokens: 0,
                },
              ]
            : []),
          {
            userId: 'user_owner',
            email: 'owner@acme.test',
            name: 'Avery Chen',
            role: 'owner',
            spendMicroUsd: 31_200_000,
            inputTokens: 6_200_000,
            outputTokens: 820_000,
          },
          {
            userId: 'user_editor',
            email: 'ops@acme.test',
            name: 'Mina Park',
            role: 'editor',
            spendMicroUsd: 11_480_000,
            inputTokens: 2_220_000,
            outputTokens: 300_000,
          },
          {
            userId: 'user_viewer',
            email: 'finance@acme.test',
            role: 'viewer',
            spendMicroUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
          },
        ],
      },
      ledger: [
        {
          id: 'ledger_1',
          amountMicroUsd: -8_420_000,
          type: 'usage',
          reference: 'generation:session_live',
          createdAt: Date.UTC(2026, 6, 10, 18),
        },
        {
          id: 'ledger_2',
          amountMicroUsd: 20_000_000,
          type: 'topup',
          reference: 'stripe:pi_fixture',
          createdAt: Date.UTC(2026, 6, 8, 11),
        },
      ],
      syncHealth:
        scenario === 'workspace-zero-sync'
          ? { batches: 0, droppedReads: 0, overflow: 0 }
          : {
              batches: 42,
              droppedReads: 3,
              overflow: 0,
              lastRecordedAt: Date.UTC(2026, 6, 10, 18, 30),
            },
      auditId: 'audit_workspace',
    }),
    internalAdminFeedback: async () => ({
      feedback:
        scenario === 'feedback-empty'
          ? []
          : [
              {
                id: 'feedback_1',
                content:
                  'The session timeline is much easier to follow now. I would still love a compact density option.',
                source: 'web',
                createdAt: Date.UTC(2026, 6, 11, 7, 30),
              },
              {
                id: 'feedback_2',
                content:
                  'Train accepted the handbook and correctly retained the policy exceptions.',
                source: 'duet-agent-cli',
                createdAt: Date.UTC(2026, 6, 10, 15, 10),
              },
            ],
      auditId: 'audit_feedback',
    }),
    internalAdminMutateFeedback: async () => ({ ok: true, auditId: 'audit_feedback_mutation' }),
    internalAdminFreeCredits: async () => ({
      totalFreeCreditsMicroUsd: 842_000_000,
      unpaidUserCount: 18,
      usersWithBalanceCount: 12,
      auditId: 'audit_credits',
    }),
    internalAdminResetFreeCredits: async (reason, confirmation) => {
      if (
        scenario === 'spanish-credits' &&
        (reason !== 'Restablecimiento por política de créditos gratis' ||
          confirmation !== 'RESET FREE CREDITS')
      ) {
        throw new Error('The localized admin form did not preserve the API confirmation contract')
      }
      return { ok: true, auditId: 'audit_reset' }
    },
    internalAdminTakedownListing: async (listingId, reason) => {
      if (listingId.length === 0 || reason.length === 0) {
        throw new Error('takedown requires a listing and an audit reason')
      }
      // `remaining: true` so the fixture renders the drain-still-running copy —
      // the state that a one-shot takedown would never surface.
      return { ok: true, auditId: 'audit_takedown', detached: 100, remaining: true }
    },
    internalAdminMutateWorkspace: async (_workspaceId, input) => {
      if (input.operation === 'suspension') suspended = input.suspended
      if (input.operation === 'unpause') unpaused = true
      if (input.operation === 'servicing_exempt') servicingExempt = input.exempt
      // Browser tests opt into a held response; the interactive fixture succeeds locally.
      if (
        (input.operation === 'credit' || input.operation === 'payer') &&
        new URL(window.location.href).searchParams.has(`controlled-${input.operation}`)
      ) {
        const success = await new Promise<boolean>(resolve => {
          window.addEventListener(
            `playground-${input.operation}-response`,
            event => {
              resolve((event as CustomEvent<boolean>).detail)
            },
            { once: true },
          )
          window.dispatchEvent(
            new CustomEvent(`playground-${input.operation}-request`, { detail: input }),
          )
        })
        if (!success) throw new Error('Fixture workspace mutation failed')
      }
      if (input.operation === 'payer') {
        billingUserId = input.newBillingUserId
        billingEmail =
          input.newBillingUserId === 'user_billing_owner'
            ? 'billing@acme.test'
            : WORKSPACE.billingEmail
        unpaused = true
      }
      return { ok: true, auditId: 'audit_workspace_mutation' }
    },
    internalAdminVmUpdates:
      scenario === 'loading'
        ? wait
        : scenario === 'error'
          ? fail
          : async () => ({
              // Paused is the state worth a shot: it renders the badge, the
              // last-change line, and the resume button all at once.
              paused: true,
              reason: 'Runtime release paused',
              updatedAt: Date.UTC(2026, 7, 18, 21, 30),
              auditId: 'audit_vm_updates',
            }),
    internalAdminSetVmUpdates: async (_paused: boolean, reason: string) => {
      if (reason.trim().length < 3) throw new Error('the update brake requires an audit reason')
      return { ok: true, auditId: 'audit_vm_updates_flip' }
    },
    internalAdminFleetHealth:
      scenario === 'loading' ? wait : scenario === 'error' ? fail : async () => FLEET_HEALTH,
    internalAdminInferenceMargin: async (granularity, through) =>
      inferenceMargin(granularity, through),
    internalAdminModelRouterPolicy: async () => ({
      version: 1 as const,
      rules:
        scenario === 'model-router'
          ? [
              {
                id: 'tailscale-openai',
                enabled: true,
                modelGlob: 'openai/*',
                baseUrl: 'https://provider.example',
                headers: [{ name: 'authorization', value: 'Bearer route-secret' }],
              },
            ]
          : [],
      updatedAt: 0,
      auditId: 'audit_model_router',
    }),
    internalAdminSetModelRouterPolicy: async input => {
      if (new URLSearchParams(window.location.search).has('controlled-router')) {
        await new Promise<void>((resolve, reject) => {
          window.addEventListener(
            'playground-router-response',
            event => {
              if ((event as CustomEvent<boolean>).detail) resolve()
              else reject(new Error('Fixture route save failure'))
            },
            { once: true },
          )
          window.dispatchEvent(new CustomEvent('playground-router-request', { detail: input }))
        })
      }
      return {
        version: 1 as const,
        rules: input.rules,
        updatedAt: 0,
        auditId: 'audit_model_router_save',
      }
    },
    internalAdminVmStatus: async () => ({
      workspaceId: WORKSPACE.id,
      vmName: WORKSPACE.vmName,
      controlStatus: 'running',
      gateway: {
        reachable: true,
        runtimeVersion: WORKSPACE.runtimeVersion,
        imageVersion: WORKSPACE.imageVersion,
        uptimeSeconds: 93_420,
      },
      auditId: 'audit_vm',
    }),
    internalAdminVmOperation: async (_workspaceId, operation) =>
      operation === 'archive' || operation === 'reprovision'
        ? {
            ok: true,
            status: 'backup_pending',
            backupId: 'backup_acme_042',
            auditId: 'audit_vm_operation',
          }
        : { ok: true, status: 'completed', auditId: 'audit_vm_operation' },
    internalAdminVmBackup: async () => {
      backupReads += 1
      const failed = backupReads > 1
      return {
        id: 'backup_acme_042',
        workspaceId: WORKSPACE.id,
        purpose: 'archive',
        status: failed ? 'failed' : 'running',
        createdAt: 100,
        updatedAt: 200,
        progress: {
          processedFiles: 5,
          processedRecords: 20,
          capturedBytes: 1000,
          uploadedBytes: 0,
          warningCount: 0,
          warningSummary: [],
        },
        lifecycle: { kind: 'archive', status: failed ? 'failed' : 'capturing' },
        ...(failed
          ? { error: { code: 'capture_failed' as const, message: 'Drive capture was interrupted' } }
          : {}),
      }
    },
    internalAdminFiles: async (_workspaceId, path = '') => ({
      path,
      entries: path
        ? [{ name: 'report.md', path: `${path}/report.md`, kind: 'file', size: 1840 }]
        : [
            { name: 'projects', path: 'projects', kind: 'directory' },
            { name: 'README.md', path: 'README.md', kind: 'file', size: 940 },
          ],
      truncated: false,
      auditId: 'audit_files',
    }),
    internalAdminFile: async (_workspaceId, path) => ({
      path,
      content: '# Acme operations\n\nCustomer workspace health notes.\n',
      byteLength: 52,
      truncated: false,
      auditId: 'audit_file',
    }),
    internalAdminLogs: async (_workspaceId, source, anchorId) => ({
      source,
      ...(anchorId === undefined ? {} : { anchorId }),
      path: source === 'gateway' ? 'logs/gateway.log' : `logs/agents/${anchorId}.log`,
      content:
        '[2026-07-10T18:31:04Z] [apps] service "account-board" ready on port 41002\n[2026-07-10T18:31:08Z] sync completed\n',
      byteLength: 122,
      truncated: true,
      available: [
        { source: 'gateway', byteLength: 122 },
        { source: 'agent', anchorId: 'anchor_account_researcher', byteLength: 88 },
      ],
      auditId: 'audit_logs',
    }),
    internalAdminCommand: async (_workspaceId, command) => ({
      command,
      stdout:
        ' M README.md\n M projects/customer-success/weekly-report.md\n?? reports/2026-07-11-customer-health-summary-with-a-deliberately-long-name.md\n\nCredentials: [REDACTED]\n',
      stderr: '',
      exitCode: 0,
      durationMs: 84,
      truncated: false,
      auditId: 'audit_command',
    }),
  }
}
