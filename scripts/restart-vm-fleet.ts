/**
 * Reboot workspace VMs in one environment, a few at a time.
 *
 * Restart only — this script never calls `rm`, so disks and their drives
 * survive. Reprovisioning is a different, destructive operation and is not
 * reachable from here.
 *
 * Two safety rules, both learned from the 2026-08-17 rollout that saturated the
 * shared CPU pool:
 *
 *   1. One exe.dev account holds BOTH environments. Every VM must be selected
 *      by its environment tag and the tag is required on the command line —
 *      there is no default and no "all". A VM missing an environment tag is
 *      never touched, and is reported so someone can go and tag it.
 *   2. Restarting the whole fleet at once is the same mistake as updating it at
 *      once: the pool is shared, so the batch size is small by default and each
 *      wave waits for its VMs to come back before the next starts.
 */
import { PRODUCTION_VM_TAG, STAGING_VM_TAG, WORKSPACE_VM_TAG } from '@repo/contract'
import { ExeClient, type ExeVm } from '@repo/exe'

export type FleetEnvironment = 'staging' | 'production'

export interface RestartFleetOptions {
  environment: FleetEnvironment
  /** Reboot at most this many VMs. Absent means every selected VM. */
  limit?: number
  /**
   * VM names to leave alone. Holding one VM back across a fleet reboot keeps a
   * live specimen of whatever state you are investigating — reboot everything
   * and the evidence goes with it.
   */
  except?: readonly string[]
  /** VMs rebooted concurrently. The pool is shared; keep this small. */
  concurrency: number
  /** Reboot for real. Absent lists what would happen and changes nothing. */
  apply: boolean
}

export interface FleetSelection {
  selected: ExeVm[]
  /** Running VMs in the other environment — never touched, counted for sanity. */
  otherEnvironment: number
  /** Workspace VMs carrying no environment tag. Never touched; needs a human. */
  untagged: ExeVm[]
  /** VMs held back by `--except`, confirmed present so a typo cannot pass silently. */
  spared: string[]
}

const ENVIRONMENT_TAGS: Record<FleetEnvironment, string> = {
  staging: STAGING_VM_TAG,
  production: PRODUCTION_VM_TAG,
}

/**
 * Which VMs a run would reboot. Pure so the selection — the part that can
 * reboot the wrong environment — is testable without an account.
 */
export function selectFleet(vms: ExeVm[], options: RestartFleetOptions): FleetSelection {
  const wanted = ENVIRONMENT_TAGS[options.environment]
  const other = ENVIRONMENT_TAGS[options.environment === 'staging' ? 'production' : 'staging']
  const workspaces = vms.filter(
    vm => vm.status === 'running' && vm.tags?.includes(WORKSPACE_VM_TAG),
  )
  const spared = new Set(options.except ?? [])
  const selected = workspaces.filter(vm => vm.tags?.includes(wanted) && !spared.has(vm.vm_name))
  return {
    selected: options.limit === undefined ? selected : selected.slice(0, options.limit),
    spared: workspaces.filter(vm => spared.has(vm.vm_name)).map(vm => vm.vm_name),
    otherEnvironment: workspaces.filter(vm => vm.tags?.includes(other)).length,
    untagged: workspaces.filter(vm => !vm.tags?.includes(wanted) && !vm.tags?.includes(other)),
  }
}

export interface RestartOutcome {
  vmName: string
  status: 'rebooted' | 'failed'
  /** Milliseconds from restart to the lobby reporting `running` again. */
  elapsedMs?: number
  error?: string
}

/**
 * Reboot the selection in waves. One VM failing never stops the rest: a fleet
 * pass that aborts on the first unreachable VM leaves the remainder in whatever
 * state the incident put them.
 */
export async function restartFleet(
  exe: Pick<ExeClient, 'list' | 'restart' | 'waitUntilRunning'>,
  options: RestartFleetOptions,
  log: (line: string) => void = console.log,
): Promise<{ selection: FleetSelection; outcomes: RestartOutcome[] }> {
  const selection = selectFleet(await exe.list(), options)
  log(
    `${options.environment}: ${selection.selected.length} to reboot ` +
      `(${selection.otherEnvironment} in the other environment, untouched)`,
  )
  const missing = (options.except ?? []).filter(name => !selection.spared.includes(name))
  if (missing.length > 0) {
    throw new Error(
      `--except named VMs that are not running ${options.environment} workspaces: ` +
        `${missing.join(', ')}. Fix the name rather than rebooting the fleet on a typo.`,
    )
  }
  if (selection.spared.length > 0) {
    log(`holding back ${selection.spared.length}: ${selection.spared.join(', ')}`)
  }
  if (selection.untagged.length > 0) {
    log(
      `WARNING ${selection.untagged.length} workspace VMs carry no environment tag and are ` +
        `excluded: ${selection.untagged.map(vm => vm.vm_name).join(', ')}`,
    )
  }
  if (!options.apply) {
    for (const vm of selection.selected) log(`would reboot ${vm.vm_name}`)
    log(`\nDry run. Re-run with --apply to reboot these ${selection.selected.length} VMs.`)
    return { selection, outcomes: [] }
  }

  const outcomes: RestartOutcome[] = []
  for (let index = 0; index < selection.selected.length; index += options.concurrency) {
    const wave = selection.selected.slice(index, index + options.concurrency)
    const results = await Promise.all(
      wave.map(async (vm): Promise<RestartOutcome> => {
        try {
          await exe.restart(vm.vm_name)
          const elapsedMs = await exe.waitUntilRunning(vm.vm_name, { timeoutMs: 300_000 })
          return { vmName: vm.vm_name, status: 'rebooted', elapsedMs }
        } catch (error) {
          return {
            vmName: vm.vm_name,
            status: 'failed',
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }),
    )
    for (const result of results) {
      log(
        result.status === 'rebooted'
          ? `rebooted ${result.vmName} in ${Math.round((result.elapsedMs ?? 0) / 1000)}s`
          : `FAILED ${result.vmName}: ${result.error}`,
      )
    }
    outcomes.push(...results)
  }
  const failed = outcomes.filter(outcome => outcome.status === 'failed')
  log(`\n${outcomes.length - failed.length} rebooted, ${failed.length} failed.`)
  return { selection, outcomes }
}

export function parseCommandLine(args: string[]): RestartFleetOptions {
  let environment: FleetEnvironment | undefined
  let limit: number | undefined
  let concurrency = 4
  let apply = false
  let except: string[] | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--env') {
      const value = args[++index]
      if (value !== 'staging' && value !== 'production') {
        throw new Error('--env must be staging or production')
      }
      environment = value
    } else if (argument === '--limit') {
      limit = positiveInteger(args[++index], '--limit')
    } else if (argument === '--concurrency') {
      concurrency = positiveInteger(args[++index], '--concurrency')
    } else if (argument === '--except') {
      const value = args[++index]
      if (value === undefined || value.length === 0) throw new Error('--except needs VM names')
      except = value
        .split(',')
        .map(name => name.trim())
        .filter(name => name.length > 0)
    } else if (argument === '--apply') {
      apply = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (environment === undefined) {
    throw new Error(
      'Usage: bun scripts/restart-vm-fleet.ts --env <staging|production> [--limit N] ' +
        '[--concurrency N] [--apply]',
    )
  }
  return {
    environment,
    concurrency,
    apply,
    ...(limit === undefined ? {} : { limit }),
    ...(except === undefined ? {} : { except }),
  }
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return parsed
}

if (import.meta.main) {
  try {
    const options = parseCommandLine(process.argv.slice(2))
    await restartFleet(new ExeClient(), options)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
