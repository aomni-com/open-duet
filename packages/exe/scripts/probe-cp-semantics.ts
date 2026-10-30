import {
  assertNoDuetTestVms,
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

const DATE = '2026-07-06'
const WORKDIR = '$HOME/probe-cp'

interface FileStats {
  path: string
  bytes: number
  lines: number
  lastSeq: number
  monotonic: boolean
  duplicates: number
  tornLines: number
  hasTrailingNewline: boolean
}

interface ProbeResult {
  sourceName: string
  cloneName: string
  createMs: number
  sourceReadyMs: number
  cpMs: number
  cloneReadyMs: number
  sourceBefore: Record<'fsync' | 'buffered', FileStats>
  sourceAfter: Record<'fsync' | 'buffered', FileStats>
  clone: Record<'fsync' | 'buffered', FileStats>
  writerAliveAfterCp: boolean
  sourceAdvancedDuringCp: boolean
  cloneBooted: boolean
  deleted: string[]
  leakCheck: 'none' | 'failed'
}

const writerScript = `#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME/probe-cp"
fsync_file="$HOME/probe-cp/fsync.log"
buffered_file="$HOME/probe-cp/buffered.log"
seq=0
while true; do
  seq=$((seq + 1))
  printf "%012d\\n" "$seq" >> "$fsync_file"
  python3 - "$fsync_file" <<'PY'
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(fd)
finally:
    os.close(fd)
PY
  printf "%012d\\n" "$seq" >> "$buffered_file"
  sleep 0.01
done
`

const analyzer = `python3 - <<'PY'
import json, os, re

def stats(path):
    try:
        data = open(os.path.expanduser(path), 'rb').read()
    except FileNotFoundError:
        data = b''
    text = data.decode('ascii', errors='replace')
    raw_lines = text.splitlines()
    trailing = data.endswith(b'\\n') or len(data) == 0
    last = 0
    prev = 0
    duplicates = 0
    torn = 0
    monotonic = True
    for line in raw_lines:
        if not re.fullmatch(r'[0-9]{12}', line):
            torn += 1
            monotonic = False
            continue
        value = int(line)
        if value <= prev:
            monotonic = False
            if value == prev:
                duplicates += 1
        prev = value
        last = value
    if not trailing:
        torn += 1
        monotonic = False
    return {
        "path": path,
        "bytes": len(data),
        "lines": len(raw_lines),
        "lastSeq": last,
        "monotonic": monotonic,
        "duplicates": duplicates,
        "tornLines": torn,
        "hasTrailingNewline": trailing,
    }

print(json.dumps({
    "fsync": stats("~/probe-cp/fsync.log"),
    "buffered": stats("~/probe-cp/buffered.log"),
}, sort_keys=True))
PY`

async function installWriter(sshDest: string): Promise<void> {
  const ctx = makeContext()
  await runOrThrow(ctx.ssh, sshDest, `mkdir -p ${WORKDIR}`)
  await runOrThrow(
    ctx.ssh,
    sshDest,
    `cat > ${WORKDIR}/writer.sh <<'SH'\n${writerScript}\nSH\nchmod +x ${WORKDIR}/writer.sh`,
  )
  await runOrThrow(
    ctx.ssh,
    sshDest,
    `nohup bash ${WORKDIR}/writer.sh > ${WORKDIR}/writer.out 2> ${WORKDIR}/writer.err & echo $! > ${WORKDIR}/writer.pid`,
  )
}

async function readStats(sshDest: string): Promise<Record<'fsync' | 'buffered', FileStats>> {
  const ctx = makeContext()
  return JSON.parse(await runOrThrow(ctx.ssh, sshDest, analyzer)) as Record<
    'fsync' | 'buffered',
    FileStats
  >
}

async function waitForLines(sshDest: string, minLines: number): Promise<void> {
  const ctx = makeContext()
  const deadline = performance.now() + 60_000
  for (;;) {
    const lineCount = Number(
      await runOrThrow(
        ctx.ssh,
        sshDest,
        `test -f ${WORKDIR}/fsync.log && wc -l < ${WORKDIR}/fsync.log || echo 0`,
      ),
    )
    if (lineCount >= minLines) return
    if (performance.now() >= deadline) throw new Error(`writer did not reach ${minLines} lines`)
    await Bun.sleep(500)
  }
}

function crashConsistent(stats: Record<'fsync' | 'buffered', FileStats>): boolean {
  return Object.values(stats).every(
    file => file.monotonic && file.duplicates === 0 && file.tornLines === 0,
  )
}

function report(result: ProbeResult | null, failure?: string): string {
  if (!result) {
    return `# exe.dev cp snapshot semantics

Date: ${DATE}
Marker: SLICE01B-PROBES-5T8V

## Verdict

Not measured. The probe failed before producing a complete source/clone comparison.

Failure:

${fenced(failure ?? 'unknown failure')}
`
  }

  const cloneConsistent = crashConsistent(result.clone)
  const sourceConsistent = crashConsistent(result.sourceAfter)
  const bufferedRolledBack =
    result.sourceBefore.buffered.lastSeq > 0 &&
    result.clone.buffered.lastSeq < result.sourceBefore.buffered.lastSeq
  const verdict =
    cloneConsistent && result.cloneBooted
      ? bufferedRolledBack
        ? 'clone boots; copied files are line-consistent, but non-fsynced writes can roll back'
        : 'clone boots and copied files are line-consistent snapshots'
      : 'clone boot or copied-file consistency failed'

  return (
    `# exe.dev cp snapshot semantics

Date: ${DATE}
Marker: SLICE01B-PROBES-5T8V

## Verdict

${verdict}. The copy took ${ms(result.cpMs)}; the clone became SSH-ready in ${ms(result.cloneReadyMs)} after \`cp\` returned. The source writer ${result.writerAliveAfterCp ? 'remained alive' : 'was not alive'} after copy and source sequence numbers ${result.sourceAdvancedDuringCp ? 'advanced' : 'did not advance'} during the operation.

## Sequence evidence

| VM/file | lines | last seq | monotonic | duplicates | torn lines | trailing newline |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| source before fsync | ${result.sourceBefore.fsync.lines} | ${result.sourceBefore.fsync.lastSeq} | ${result.sourceBefore.fsync.monotonic} | ${result.sourceBefore.fsync.duplicates} | ${result.sourceBefore.fsync.tornLines} | ${result.sourceBefore.fsync.hasTrailingNewline} |
| source before buffered | ${result.sourceBefore.buffered.lines} | ${result.sourceBefore.buffered.lastSeq} | ${result.sourceBefore.buffered.monotonic} | ${result.sourceBefore.buffered.duplicates} | ${result.sourceBefore.buffered.tornLines} | ${result.sourceBefore.buffered.hasTrailingNewline} |
| clone fsync | ${result.clone.fsync.lines} | ${result.clone.fsync.lastSeq} | ${result.clone.fsync.monotonic} | ${result.clone.fsync.duplicates} | ${result.clone.fsync.tornLines} | ${result.clone.fsync.hasTrailingNewline} |
| clone buffered | ${result.clone.buffered.lines} | ${result.clone.buffered.lastSeq} | ${result.clone.buffered.monotonic} | ${result.clone.buffered.duplicates} | ${result.clone.buffered.tornLines} | ${result.clone.buffered.hasTrailingNewline} |
| source after fsync | ${result.sourceAfter.fsync.lines} | ${result.sourceAfter.fsync.lastSeq} | ${result.sourceAfter.fsync.monotonic} | ${result.sourceAfter.fsync.duplicates} | ${result.sourceAfter.fsync.tornLines} | ${result.sourceAfter.fsync.hasTrailingNewline} |
| source after buffered | ${result.sourceAfter.buffered.lines} | ${result.sourceAfter.buffered.lastSeq} | ${result.sourceAfter.buffered.monotonic} | ${result.sourceAfter.buffered.duplicates} | ${result.sourceAfter.buffered.tornLines} | ${result.sourceAfter.buffered.hasTrailingNewline} |

## Timings

- source create returned: ${ms(result.createMs)}
- source SSH-ready: ${ms(result.sourceReadyMs)}
- \`cp\` returned: ${ms(result.cpMs)}
- clone SSH-ready after \`cp\`: ${ms(result.cloneReadyMs)}

## Mechanics pinned

- ` +
    '`ssh exe.dev help cp`' +
    ` accepts \`cp <source-vm> [new-name]\` plus \`--cpu\`, \`--memory\`, \`--disk\`, and \`--copy-tags\`.
- Source VM: \`${result.sourceName}\`; clone VM: \`${result.cloneName}\`.
- Both VMs used names beginning \`duet-test-\`; the source was created with \`--cpu 1 --memory 2GB --tag duet-test\`, and \`cp\` copied the tag by default.
- Source files are ${sourceConsistent ? 'line-consistent after copy' : 'not line-consistent after copy'}; clone files are ${cloneConsistent ? 'line-consistent' : 'not line-consistent'}.
- The fsynced file is the reliable backup signal. The buffered file ${bufferedRolledBack ? 'rolled back in the clone despite visible source lines before copy' : 'did not roll back in this run'}, so backup code must not assume non-fsynced writes are captured.
- Final \`duet-test-*\` leak check: ${result.leakCheck}.

## Cleanup

- deleted: ${result.deleted.join(', ')}
- final \`duet-test-*\` leak check: ${result.leakCheck}

Key observed lines:

${fenced(
  [
    `cp duration=${ms(result.cpMs)}`,
    `clone booted=${result.cloneBooted}`,
    `source writer alive after cp=${result.writerAliveAfterCp}`,
    `source fsync last after=${result.sourceAfter.fsync.lastSeq}, clone fsync last=${result.clone.fsync.lastSeq}`,
    `source buffered last after=${result.sourceAfter.buffered.lastSeq}, clone buffered last=${result.clone.buffered.lastSeq}`,
    `clone crash-consistent=${cloneConsistent}`,
  ].join('\n'),
)}
`
  )
}

async function main(): Promise<void> {
  const ctx = makeContext()
  await ctx.control.whoami()

  const sourceName = vmName('cp-src')
  const cloneName = vmName('cp-clone')
  let result: ProbeResult | null = null
  let failure: string | undefined

  try {
    const created = await createVm(ctx, {
      name: sourceName,
      comment: `agent-drive ${DATE} cp semantics probe`,
    })
    const ready = await time(() =>
      ctx.ssh.waitUntilReady(created.value.ssh_dest, { timeoutMs: 180_000 }),
    )
    await installWriter(created.value.ssh_dest)
    await waitForLines(created.value.ssh_dest, 100)
    const sourceBefore = await readStats(created.value.ssh_dest)

    const copied = await time(() =>
      ctx.control.copy(sourceName, cloneName, { cpu: 1, memory: '2GB' }),
    )
    ctx.created.push(cloneName)
    const cloneVm = (await ctx.control.list()).find(vm => vm.vm_name === cloneName)
    if (!cloneVm) throw new Error(`cp returned but clone ${cloneName} was not listed`)

    const cloneReady = await time(() =>
      ctx.ssh.waitUntilReady(cloneVm.ssh_dest, { timeoutMs: 180_000 }),
    )
    const cloneStats = await readStats(cloneVm.ssh_dest)
    const sourceAfter = await readStats(created.value.ssh_dest)
    const writerAlive =
      (await runOrThrow(
        ctx.ssh,
        created.value.ssh_dest,
        `kill -0 "$(cat ${WORKDIR}/writer.pid)" 2>/dev/null && echo yes || echo no`,
      )) === 'yes'

    result = {
      sourceName,
      cloneName,
      createMs: created.durationMs,
      sourceReadyMs: ready.durationMs,
      cpMs: copied.durationMs,
      cloneReadyMs: cloneReady.durationMs,
      sourceBefore,
      sourceAfter,
      clone: cloneStats,
      writerAliveAfterCp: writerAlive,
      sourceAdvancedDuringCp:
        sourceAfter.fsync.lastSeq > sourceBefore.fsync.lastSeq &&
        sourceAfter.buffered.lastSeq > sourceBefore.buffered.lastSeq,
      cloneBooted: true,
      deleted: [],
      leakCheck: 'failed',
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    const cleaned = await cleanup(ctx)
    if (result) result.deleted = cleaned.deleted
    try {
      await assertNoDuetTestVms(ctx.control)
      if (result) result.leakCheck = 'none'
    } catch (error) {
      failure = [failure, error instanceof Error ? error.message : String(error)]
        .filter(Boolean)
        .join('\n')
    }
    await writeReport('probe-cp-semantics.md', report(result, failure))
  }

  if (!result)
    throw new Error(
      'cp probe failed before completion. See probe-results/reports/probe-cp-semantics.md',
    )
  console.log(
    `cp measured: duration=${ms(result.cpMs)}, cloneBooted=${result.cloneBooted}, cloneCrashConsistent=${crashConsistent(result.clone)}`,
  )
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
