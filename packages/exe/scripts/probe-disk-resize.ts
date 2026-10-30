/**
 * Probe: can an exe.dev VM's disk change size in place, and what happens to a
 * VM that holds more data than its new size allows?
 *
 * Two unknowns behind per-tier storage (Starter 20GB / Pro 50GB / Max 100GB):
 *
 *   U1 — grow: does `resize --disk` change the *same* VM's disk, and does the
 *        guest filesystem actually see the space (block device vs. mounted fs),
 *        live or only after a reboot?
 *   U2 — shrink: what does the lobby do when asked to go smaller, and what is
 *        left to us for a downgrade whose drive is over the new tier?
 *
 * The workspace drive is `/home/exedev/drive` on the *root* filesystem
 * (`DRIVE_ROOT_PATH`), so the tier quota is the whole VM disk — there is no
 * separate volume to resize independently.
 *
 * Run: bun run --env-file=../../.env.local scripts/probe-disk-resize.ts
 */

import {
  authenticate,
  cleanup,
  createVm,
  fenced,
  makeContext,
  ms,
  runOrThrow,
  time,
  vmName,
  writeReport,
} from './probe-common.ts'

const START_DISK = '10GB'
const GROWN_DISK = '20GB'
const SHRUNK_DISK = '5GB'
/** Big enough to be a real over-quota payload, small enough to write quickly. */
const PAYLOAD_GB = 3

interface DiskView {
  df: string
  lsblk: string
}

async function readDisk(
  ssh: ReturnType<typeof makeContext>['ssh'],
  dest: string,
): Promise<DiskView> {
  return {
    df: await runOrThrow(ssh, dest, 'df -h / /home/exedev/drive 2>&1 || df -h /'),
    lsblk: await runOrThrow(ssh, dest, 'lsblk -b -o NAME,SIZE,TYPE,MOUNTPOINT 2>&1 || true'),
  }
}

/** Bytes of the filesystem backing `/`, as the guest reports it. */
async function rootFsBytes(
  ssh: ReturnType<typeof makeContext>['ssh'],
  dest: string,
): Promise<number> {
  const out = await runOrThrow(ssh, dest, "df -B1 --output=size / | tail -1 | tr -d ' '")
  return Number(out)
}

async function main(): Promise<void> {
  const ctx = makeContext()
  const name = vmName('diskresize')
  const notes: string[] = []
  const sections: string[] = []

  await authenticate(ctx)

  try {
    // ---- create at the "Starter" size -------------------------------------
    const created = await createVm(ctx, { name, disk: START_DISK })
    const dest = created.value.ssh_dest
    const sshReadyMs = await ctx.ssh.waitUntilReady(dest, { timeoutMs: 180_000 })
    notes.push(`create ${START_DISK}: ${ms(created.durationMs)}; ssh ready: ${ms(sshReadyMs)}`)

    const before = await readDisk(ctx.ssh, dest)
    const beforeBytes = await rootFsBytes(ctx.ssh, dest)
    sections.push(
      `### Baseline at ${START_DISK}\n\n${fenced(before.df)}\n\n${fenced(before.lsblk)}`,
    )

    // ---- put real data on the drive ---------------------------------------
    // Written into the drive root so the payload is exactly what a user's files
    // would be, and checksummed so we can prove the resize is non-destructive.
    await runOrThrow(
      ctx.ssh,
      dest,
      `mkdir -p /home/exedev/drive && dd if=/dev/urandom of=/home/exedev/drive/payload.bin bs=1M count=${PAYLOAD_GB * 1024} status=none`,
      600_000,
    )
    const payloadSum = await runOrThrow(
      ctx.ssh,
      dest,
      'sha256sum /home/exedev/drive/payload.bin',
      600_000,
    )
    const filled = await readDisk(ctx.ssh, dest)
    sections.push(`### After writing ${PAYLOAD_GB}GB to the drive\n\n${fenced(filled.df)}`)

    // ---- U1: grow in place, VM left running -------------------------------
    const grow = await time(() => ctx.control.resize(name, { disk: GROWN_DISK }))
    notes.push(`resize ${START_DISK} -> ${GROWN_DISK} (running): ${ms(grow.durationMs)}`)
    sections.push(
      `### resize --disk=${GROWN_DISK} response\n\n${fenced(JSON.stringify(grow.value, null, 2))}`,
    )

    // Poll for a live grow before falling back to a reboot, so we can tell
    // "online resize" apart from "reboot required".
    let liveGrowMs: number | null = null
    const deadline = performance.now() + 90_000
    while (performance.now() < deadline) {
      if ((await rootFsBytes(ctx.ssh, dest)) > beforeBytes) {
        liveGrowMs = performance.now() - (deadline - 90_000)
        break
      }
      await Bun.sleep(3_000)
    }
    const afterResizeNoReboot = await readDisk(ctx.ssh, dest)
    sections.push(
      `### Immediately after resize, no reboot (live grow: ${liveGrowMs === null ? 'NO' : `yes, ~${ms(liveGrowMs)}`})\n\n${fenced(afterResizeNoReboot.df)}\n\n${fenced(afterResizeNoReboot.lsblk)}`,
    )

    // ---- does a reboot settle it? -----------------------------------------
    const restart = await time(() => ctx.control.restart(name))
    await ctx.ssh.waitUntilReady(dest, { timeoutMs: 300_000 })
    const afterReboot = await readDisk(ctx.ssh, dest)
    const afterRebootBytes = await rootFsBytes(ctx.ssh, dest)
    notes.push(
      `restart after grow: ${ms(restart.durationMs)}; root fs ${beforeBytes} -> ${afterRebootBytes} bytes`,
    )
    sections.push(`### After reboot\n\n${fenced(afterReboot.df)}\n\n${fenced(afterReboot.lsblk)}`)

    // ---- data survived? ---------------------------------------------------
    const payloadSumAfter = await runOrThrow(
      ctx.ssh,
      dest,
      'sha256sum /home/exedev/drive/payload.bin',
      600_000,
    )
    notes.push(
      `payload checksum ${payloadSum === payloadSumAfter ? 'MATCHES' : 'CHANGED'} across the resize`,
    )

    // ---- U2: ask for a shrink ---------------------------------------------
    let shrinkOutcome: string
    try {
      const shrink = await ctx.control.resize(name, { disk: SHRUNK_DISK })
      shrinkOutcome = `ACCEPTED (!): ${JSON.stringify(shrink)}`
    } catch (error) {
      shrinkOutcome = `REJECTED: ${error instanceof Error ? error.message : String(error)}`
    }
    sections.push(`### resize --disk=${SHRUNK_DISK} (shrink attempt)\n\n${fenced(shrinkOutcome)}`)

    // A shrink to exactly the current size is the other boundary worth knowing:
    // a no-op downgrade must not error out the tier-change path.
    let sameSizeOutcome: string
    try {
      const same = await ctx.control.resize(name, { disk: GROWN_DISK })
      sameSizeOutcome = `ACCEPTED: ${JSON.stringify(same)}`
    } catch (error) {
      sameSizeOutcome = `REJECTED: ${error instanceof Error ? error.message : String(error)}`
    }
    sections.push(
      `### resize --disk=${GROWN_DISK} (same size, no-op downgrade)\n\n${fenced(sameSizeOutcome)}`,
    )

    // ---- how would we measure a user's usage from the control plane? ------
    let statOutcome: string
    try {
      statOutcome = JSON.stringify(await ctx.control.stat(name), null, 2)
    } catch (error) {
      statOutcome = `stat failed: ${error instanceof Error ? error.message : String(error)}`
    }
    sections.push(`### stat --json (control-plane usage reporting)\n\n${fenced(statOutcome)}`)

    // ---- cp as the shrink escape hatch ------------------------------------
    // If shrink is impossible, the only same-account path to a smaller disk is
    // a copy into a new VM. Does `cp --disk` accept a *smaller* target?
    let cpOutcome: string
    try {
      const copyName = `${name}-small`
      const copied = await ctx.control.copy(name, copyName, { disk: START_DISK })
      ctx.created.push(copyName)
      cpOutcome = `ACCEPTED: ${JSON.stringify(copied)}`
    } catch (error) {
      cpOutcome = `REJECTED: ${error instanceof Error ? error.message : String(error)}`
    }
    sections.push(
      `### cp --disk=${START_DISK} from a ${GROWN_DISK} VM holding ${PAYLOAD_GB}GB\n\n${fenced(cpOutcome)}`,
    )
  } finally {
    const { deleted, deleteErrors } = await cleanup(ctx)
    notes.push(`cleanup deleted: ${deleted.join(', ') || 'none'}`)
    if (deleteErrors.length > 0) notes.push(`cleanup errors: ${deleteErrors.join('; ')}`)
  }

  const report = [
    '# Probe: exe.dev disk resize (per-tier storage)',
    '',
    ...notes.map(n => `- ${n}`),
    '',
    ...sections,
    '',
  ].join('\n')

  await writeReport('disk-resize.md', report)
  process.stdout.write(`${report}\n`)
}

await main()
