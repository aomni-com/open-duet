import { describe, expect, test } from 'bun:test'

import { workspaceVmCapsForPlan } from './index'

describe('workspace VM floor', () => {
  test('uses the Starter floor without a subscription and increases resources for each paid step', () => {
    const starter = workspaceVmCapsForPlan('starter')
    const pro = workspaceVmCapsForPlan('pro')
    const max = workspaceVmCapsForPlan('max')
    expect(workspaceVmCapsForPlan(undefined)).toEqual(starter)
    expect(pro.cpu).toBeGreaterThan(starter.cpu)
    expect(max.cpu).toBeGreaterThan(pro.cpu)
    expect(Number.parseInt(pro.memory)).toBeGreaterThan(Number.parseInt(starter.memory))
    expect(Number.parseInt(max.memory)).toBeGreaterThan(Number.parseInt(pro.memory))
  })

  // Below two cores the gateway's one-core reservation collapses onto the same
  // core the runner is budgeted, so the cgroup limit stops meaning anything.
  // This keeps the gateway reservation from consuming the runner's whole CPU budget.
  test('leaves at least one core for the runner after the gateway reserves its own', () => {
    const GATEWAY_RESERVED_CORES = 1
    expect(workspaceVmCapsForPlan(undefined).cpu - GATEWAY_RESERVED_CORES).toBeGreaterThanOrEqual(1)
  })
})
