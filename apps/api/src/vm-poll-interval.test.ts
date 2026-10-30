import { expect, test } from 'bun:test'

// The ceiling below is only meaningful if it tracks the real sweep threshold,
// so the test imports the value the sweep itself uses rather than restating it.
import { VM_SYNC_STALE_MS } from '@repo/contract'

import {
  fastCadenceReason,
  MAX_VM_IDLE_SYNC_INTERVAL_SECONDS,
  vmSyncPollAfterMs,
  type FastCadenceReason,
  type VmSyncActivity,
} from './vm-poll-interval'

const quiet: VmSyncActivity = {
  hasPendingRunnerInput: false,
  credentialsRefused: false,
  deliveringModelCredentials: false,
}

const quietRequest = { needsModelCredentials: false } as Parameters<
  typeof vmSyncPollAfterMs
>[0]['request']

function pollAfterMs(
  overrides: {
    activity?: Partial<VmSyncActivity>
    request?: Record<string, unknown>
    now?: number
  } = {},
): number {
  return vmSyncPollAfterMs({
    now: overrides.now ?? 1_000,
    activeSeconds: 5,
    idleSeconds: 30,
    activity: { ...quiet, ...overrides.activity },
    request: { ...quietRequest, ...overrides.request } as Parameters<
      typeof vmSyncPollAfterMs
    >[0]['request'],
  })
}

test('a workspace with nothing outstanding is told to come back later', () => {
  expect(pollAfterMs()).toBe(30_000)
})

test.each([
  ['parked runner input', { activity: { hasPendingRunnerInput: true } }],
  ['credentials landing in this response', { activity: { deliveringModelCredentials: true } }],
  ['a credential request', { request: { needsModelCredentials: true } }],
  ['an app credential request', { request: { needsAppCredentials: ['notes'] } }],
  ['train reports in flight', { request: { trainReports: [{ jobId: 'j1' }] } }],
  ['app outcomes in flight', { request: { appReconciliationReports: [{ slug: 'notes' }] } }],
  ['marketplace pulls in flight', { request: { marketplacePullReports: [{ slug: 'a' }] } }],
  ['share sync reports in flight', { request: { shareSyncReports: [{ shareId: 's1' }] } }],
])('%s keeps the fast cadence', (_name, overrides) => {
  expect(pollAfterMs(overrides)).toBe(5_000)
})

// The cadence decision is also the diagnosis. Production shows more than half
// the fleet polling fast at 1 AM, and the only way to learn WHICH condition is
// pinning them is for the route to be able to name it — so the same function
// that decides the cadence hands back the clause that kept it fast.
const fastReasons: Array<[FastCadenceReason, Parameters<typeof reasonInput>[0]]> = [
  ['pending_runner_input', { activity: { hasPendingRunnerInput: true } }],
  ['delivering_model_credentials', { activity: { deliveringModelCredentials: true } }],
  ['needs_model_credentials', { request: { needsModelCredentials: true } }],
  ['needs_app_credentials', { request: { needsAppCredentials: ['notes'] } }],
  ['train_reports', { request: { trainReports: [{ jobId: 'j1' }] } }],
  ['app_reconciliation_reports', { request: { appReconciliationReports: [{ slug: 'notes' }] } }],
  ['marketplace_pull_reports', { request: { marketplacePullReports: [{ slug: 'a' }] } }],
  ['share_sync_reports', { request: { shareSyncReports: [{ shareId: 's1' }] } }],
]

test.each(fastReasons)('a fast poll names %s as its reason', (reason, overrides) => {
  expect(fastCadenceReason(reasonInput(overrides))).toBe(reason)
})

test('a quiet poll has no fast-cadence reason', () => {
  expect(fastCadenceReason(reasonInput())).toBeNull()
})

// Measured in production the first minute after quiesce stopped counting as
// activity: 124 of 128 fast polls were paused workspaces asking for model
// credentials they are refused. A request whose answer is always no is not
// an exchange, so it must not keep the fast cadence either.
test.each([
  ['model', { needsModelCredentials: true }],
  ['app', { needsAppCredentials: ['notes'] }],
])(
  'a %s credential request from a workspace refused credentials is not a reason',
  (_kind, request) => {
    expect(
      fastCadenceReason(reasonInput({ activity: { credentialsRefused: true }, request })),
    ).toBeNull()
  },
)

test('a blocked credential request is not a reason to poll fast', () => {
  expect(
    fastCadenceReason(
      reasonInput({
        now: 1_000,
        activity: { modelCredentialsRetryAt: 5_000 },
        request: { needsModelCredentials: true },
      }),
    ),
  ).toBeNull()
})

function reasonInput(
  overrides: {
    activity?: Partial<VmSyncActivity>
    request?: Record<string, unknown>
    now?: number
  } = {},
): Parameters<typeof fastCadenceReason>[0] {
  return {
    now: overrides.now ?? 1_000,
    activity: { ...quiet, ...overrides.activity },
    request: { ...quietRequest, ...overrides.request } as Parameters<
      typeof vmSyncPollAfterMs
    >[0]['request'],
  }
}

test('an empty report array is not activity', () => {
  expect(pollAfterMs({ request: { trainReports: [], appReconciliationReports: [] } })).toBe(30_000)
})

test('a credential request blocked on live-key capacity follows heartbeat cadence until capacity changes', () => {
  expect(
    pollAfterMs({
      activity: { modelCredentialsRetryAt: 86_401_000 },
      request: { needsModelCredentials: true },
      now: 1_000,
    }),
  ).toBe(30_000)
  expect(
    pollAfterMs({
      activity: { modelCredentialsRetryAt: 11_000 },
      request: { needsModelCredentials: true },
      now: 1_000,
    }),
  ).toBe(10_000)
})

test('the idle cadence never risks the unhealthy sweep', () => {
  // The poll is the heartbeat: a workspace whose last one is older than
  // VM_SYNC_STALE_MS is marked unhealthy. The ceiling is derived from that
  // window, so this guards the policy knob behind it — a value that let one
  // dropped poll strand a workspace would fail here.
  expect(MAX_VM_IDLE_SYNC_INTERVAL_SECONDS * 1_000 * 2).toBeLessThan(VM_SYNC_STALE_MS)
  expect(pollAfterMs()).toBeLessThanOrEqual(MAX_VM_IDLE_SYNC_INTERVAL_SECONDS * 1_000)
})

test('an idle interval configured past the ceiling is clamped, not obeyed', () => {
  expect(
    vmSyncPollAfterMs({
      now: 1_000,
      activeSeconds: 5,
      idleSeconds: 600,
      activity: quiet,
      request: quietRequest,
    }),
  ).toBe(MAX_VM_IDLE_SYNC_INTERVAL_SECONDS * 1_000)
})

test('an idle interval shorter than the active one never slows the fast path', () => {
  expect(
    vmSyncPollAfterMs({
      now: 1_000,
      activeSeconds: 5,
      idleSeconds: 2,
      activity: quiet,
      request: quietRequest,
    }),
  ).toBe(5_000)
})

// Version drift (a pinned CLI version the VM has not landed) is deliberately
// absent from VmSyncActivity: the rail on the VM paces its own installs, so
// drift must never hold the fleet on the fast cadence. The route-level claim
// lives in vm.test.ts ("version drift is the update rail`s schedule…").
