import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import { SUBSCRIPTION_PLANS, VM_IMAGE_HEADROOM_GB } from '@repo/contract'

import { projectWorkspaceStorage } from '../convex/domains/credits/userBilling'

const DECIMAL_GB = 1_000_000_000
const originals = {
  starter: SUBSCRIPTION_PLANS.starter.storageGb,
  pro: SUBSCRIPTION_PLANS.pro.storageGb,
  max: SUBSCRIPTION_PLANS.max.storageGb,
}
beforeEach(() => {
  Object.assign(SUBSCRIPTION_PLANS.starter, { storageGb: 20 })
  Object.assign(SUBSCRIPTION_PLANS.pro, { storageGb: 50 })
  Object.assign(SUBSCRIPTION_PLANS.max, { storageGb: 100 })
})
afterEach(() => {
  for (const plan of ['starter', 'pro', 'max'] as const)
    Object.assign(SUBSCRIPTION_PLANS[plan], { storageGb: originals[plan] })
})

describe('billing workspace storage projection', () => {
  test('uses tier capacity without inventing a measurement for a VM-less trial workspace', () => {
    expect(
      projectWorkspaceStorage({
        plan: 'starter',
        hasVm: false,
        vmDiskGb: VM_IMAGE_HEADROOM_GB + 50,
        sample: { at: 10, fsUsedGb: 12 },
      }),
    ).toEqual({
      usableGb: 20,
      plan: 'starter',
      nextPlan: 'pro',
      nextUsableGb: 50,
    })
  })

  test('uses retained physical capacity and only the newest sample payload', () => {
    // A Starter payer retaining a 58GB disk already has pro-sized storage:
    // the upgrade step is suppressed because it would not grow usable space.
    expect(
      projectWorkspaceStorage({
        plan: 'starter',
        hasVm: true,
        vmDiskGb: VM_IMAGE_HEADROOM_GB + 50,
        sample: { at: 20 },
      }),
    ).toEqual({
      usableGb: 50,
      sampledAt: 20,
      plan: 'starter',
    })
  })

  test('offers the upgrade step only when it grows usable storage', () => {
    expect(
      projectWorkspaceStorage({
        plan: 'starter',
        hasVm: true,
        vmDiskGb: VM_IMAGE_HEADROOM_GB + 20,
      }),
    ).toMatchObject({
      usableGb: 20,
      nextPlan: 'pro',
      nextUsableGb: 50,
    })
    expect(
      projectWorkspaceStorage({ plan: 'pro', hasVm: true, vmDiskGb: VM_IMAGE_HEADROOM_GB + 100 }),
    ).toEqual({
      usableGb: 100,
      plan: 'pro',
    })
  })

  describe('the image is subtracted, because usableGb already excluded it', () => {
    // The provider reports whole-filesystem usage, which includes the ~7.4GB
    // image. `usableGb` is `provisioned - VM_IMAGE_HEADROOM_GB`, so measuring
    // raw against it would show a brand-new empty workspace as 37% full and
    // fire the 90% warning ~8GB early. Nothing errors; the bar just lies.
    const freshVm = (fsUsedGb: number) =>
      projectWorkspaceStorage({
        plan: 'starter',
        hasVm: true,
        vmDiskGb: VM_IMAGE_HEADROOM_GB + 20,
        sample: { at: 1, fsUsedGb },
      })

    test('usage below image headroom reads zero', () => {
      expect(freshVm(VM_IMAGE_HEADROOM_GB / 2)).toMatchObject({ usedBytes: 0 })
    })

    test('exactly at the headroom constant still reads zero', () => {
      expect(freshVm(VM_IMAGE_HEADROOM_GB)).toMatchObject({ usedBytes: 0 })
    })

    test('user data above the image is what gets counted', () => {
      expect(freshVm(VM_IMAGE_HEADROOM_GB + 1)).toMatchObject({ usedBytes: 1 * DECIMAL_GB })
      expect(freshVm(VM_IMAGE_HEADROOM_GB + 20)).toMatchObject({ usedBytes: 20 * DECIMAL_GB })
    })

    test('never goes negative on a VM smaller than the headroom', () => {
      expect(freshVm(0).usedBytes).toBe(0)
    })
  })

  test('reports the newest sample independently and omits the step above Max', () => {
    const first = projectWorkspaceStorage({
      plan: 'max',
      hasVm: true,
      vmDiskGb: VM_IMAGE_HEADROOM_GB + 100,
      sample: { at: 30, fsUsedGb: VM_IMAGE_HEADROOM_GB + 12.5 },
    })
    const second = projectWorkspaceStorage({
      plan: 'max',
      hasVm: true,
      vmDiskGb: VM_IMAGE_HEADROOM_GB + 100,
      sample: { at: 40, fsUsedGb: VM_IMAGE_HEADROOM_GB },
    })

    expect(first).toEqual({
      usableGb: 100,
      usedBytes: 12.5 * DECIMAL_GB,
      sampledAt: 30,
      plan: 'max',
    })
    expect(second).toEqual({
      usableGb: 100,
      usedBytes: 0,
      sampledAt: 40,
      plan: 'max',
    })
  })
})
