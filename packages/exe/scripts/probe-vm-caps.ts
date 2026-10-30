// Probe: which cpu/memory sizes will exe.dev actually schedule?
//
// Creates one VM per size, in the pool real workspace VMs live in, and deletes
// it immediately. The pool is the whole point: an unpooled VM is capped by the
// ACCOUNT plan (8GB), while a pooled one is capped by the pool's own width in
// cpu (10 today) and not capped in memory at all. Probing outside the pool
// therefore answers a question nobody asked and reads as a cap on sizes that
// provision fine.
//
// Two failures look alike and are not: a 422 names a limit and is stable, while
// a 504 "command timed out" is transient — sizes that 504 on one run schedule in
// ~1.5s on the next. Never revert a cap on a 504 alone. The shipping sizes below
// double as the control: if those fail too, the provider is having a bad minute.
//
// Measured 2026-08-07: 4/8, 8/16 and 10/24 all schedule; 12/24 is rejected.
import { SubscriptionPlanIdSchema, WORKSPACE_VM_POOL, workspaceVmCapsForPlan } from '@repo/contract'

import { ExeClient } from '../src/exe.ts'
import { DUET_TAG } from './probe-common.ts'

// Read off the caps table rather than restated here, so this always measures
// what production actually asks for instead of certifying sizes nothing uses.
const SHIPPING_SIZES = [
  workspaceVmCapsForPlan(undefined),
  ...SubscriptionPlanIdSchema.options.map(workspaceVmCapsForPlan),
]
// Sizes we do NOT ship but want a current answer on, so raising a cap starts
// from a measurement instead of an assumption.
const ASPIRATIONAL_SIZES = [{ cpu: 12, memory: '24GB' }] as const

const exe = new ExeClient()
const stamp = Date.now().toString(36)
const seen = new Set<string>()

for (const { cpu, memory } of [...SHIPPING_SIZES, ...ASPIRATIONAL_SIZES]) {
  if (seen.has(`${cpu}/${memory}`)) continue
  seen.add(`${cpu}/${memory}`)
  const name = `capsprobe-${stamp}-${cpu}c${memory}`.toLowerCase()
  const started = Date.now()
  let created = false
  try {
    await exe.create({
      name,
      cpu,
      memory,
      pool: WORKSPACE_VM_POOL,
      tags: [DUET_TAG],
      comment: 'cap probe',
    })
    created = true
    console.log(`OK    ${cpu}c/${memory} scheduled in ${Date.now() - started}ms`)
  } catch (error) {
    console.log(
      `FAIL  ${cpu}c/${memory} after ${Date.now() - started}ms — ${String(error).slice(0, 180)}`,
    )
  }
  if (created) {
    try {
      await exe.remove(name)
      console.log(`      removed ${name}`)
    } catch (error) {
      console.log(`      REMOVE FAILED ${name} — ${String(error).slice(0, 140)}`)
    }
  }
}
