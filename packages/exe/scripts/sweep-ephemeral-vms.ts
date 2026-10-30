/**
 * Deletes every VM tagged `duet-ephemeral` — the throwaway workspaces that e2e
 * journeys and diagnostic probes leave behind.
 *
 * Why this exists: one exe.dev account backs staging AND prod, and each
 * workspace VM is named `duet-ws-<sha256(workspaceId)[:24]>`, so nothing in the
 * VM list says whether a hash is a paying customer or a dead test run. Sweeping
 * used to mean cross-referencing two Convex deployments, and a mistake deletes
 * a real user's drive. The tag is applied at create time for workspaces born
 * from the secret-gated programmatic-login path, so this sweep only ever sees
 * VMs that were disposable by construction.
 *
 * Leaked VMs are not merely untidy: they compete for the account's shared CPU.
 * Ten leaked probe VMs held the fleet's per-VM CPU share at 4.3%; deleting them
 * took it to 27.5% and cut agent turn-start from 446s to 29s.
 *
 * Usage:
 *   bun packages/exe/scripts/sweep-ephemeral-vms.ts            # list only
 *   bun packages/exe/scripts/sweep-ephemeral-vms.ts --delete   # actually sweep
 */
import { EPHEMERAL_VM_TAG } from '@repo/contract'

import { ExeClient } from '../src/exe'

async function main(): Promise<void> {
  const shouldDelete = process.argv.includes('--delete')
  const exe = new ExeClient()
  const all = await exe.list()
  const ephemeral = all.filter(vm => vm.tags?.includes(EPHEMERAL_VM_TAG) === true)

  console.log(`${all.length} VMs on the account, ${ephemeral.length} tagged ${EPHEMERAL_VM_TAG}`)
  for (const vm of ephemeral) {
    console.log(`  ${vm.vm_name}  ${vm.allocated_cpus ?? '?'} cpu`)
  }
  if (ephemeral.length === 0) return
  if (!shouldDelete) {
    console.log('\nDry run. Re-run with --delete to remove them.')
    return
  }

  // Sequential and individually guarded: one VM that refuses to delete must not
  // strand the rest, and a half-swept account is the state this script exists to
  // clean up.
  let removed = 0
  for (const vm of ephemeral) {
    try {
      await exe.remove(vm.vm_name)
      removed += 1
      console.log(`removed ${vm.vm_name}`)
    } catch (error) {
      console.error(`FAILED ${vm.vm_name}: ${String(error)}`)
    }
  }
  console.log(`\nremoved ${removed}/${ephemeral.length}`)
  if (removed < ephemeral.length) process.exitCode = 1
}

await main()
