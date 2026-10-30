import { expect, test } from 'bun:test'

import { DEFAULT_TRIAL_GRANT_MICRO_USD } from '@repo/contract'

import { findVmAtCapacity, newResizeScheduleEvents } from './staging-live-storage-tier.ts'
import { assertIsolatedLifecycleTrial, lifecycleAddress } from './staging-live-subscriptions.ts'

test('storage resize capacity proof selects the lifecycle VM at the exact raw size', () => {
  const vms = [
    { vm_name: 'other', disk_capacity_bytes: 58 * 1024 ** 3 },
    { vm_name: 'lifecycle', disk_capacity_bytes: 28 * 1024 ** 3 },
  ]

  expect(findVmAtCapacity(vms, 'lifecycle', 28 * 1024 ** 3)?.vm_name).toBe('lifecycle')
  expect(findVmAtCapacity(vms, 'lifecycle', 58 * 1024 ** 3)).toBeUndefined()
})

test('downgrade resize proof rejects only newly scheduled resize events', () => {
  const beforeIds = new Set(['audit-before'])
  const events = [
    { id: 'audit-before', event: 'workspace.vm_disk_resize_scheduled' },
    { id: 'audit-unrelated', event: 'workspace.subscription_plan_changed' },
    { id: 'audit-after', event: 'workspace.vm_disk_resize_scheduled' },
  ]

  expect(newResizeScheduleEvents(events, beforeIds)).toEqual([
    { id: 'audit-after', event: 'workspace.vm_disk_resize_scheduled' },
  ])
})

test('SUBS-IMPL-12 lifecycle identity is distinct even when the inbox already has a plus tag', () => {
  expect(lifecycleAddress('acceptance+primary@agentmail.to', 'staging-e2e-run')).toBe(
    'acceptance+primary.staging-e2e-run-subscription@agentmail.to',
  )
})

test('SUBS-IMPL-12 rejects the general acceptance grant on the lifecycle account', () => {
  const isolated = {
    trial: { status: 'available' as const },
    paidCreditBalanceMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD,
    monthlyCreditBalanceMicroUsd: 0,
    subscription: null,
  }
  expect(() => assertIsolatedLifecycleTrial(isolated)).not.toThrow()
  expect(() =>
    assertIsolatedLifecycleTrial({ ...isolated, paidCreditBalanceMicroUsd: DEFAULT_TRIAL_GRANT_MICRO_USD + 10_000_000 }),
  ).toThrow('lifecycle account did not receive exactly the real trial grant')
})
