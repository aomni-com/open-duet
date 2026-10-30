/**
 * Slice-13 probe (a): fanotify FID/name semantics for symlinks and hardlinks.
 *
 * Extends the proven fanotify-fid-spike group (FAN_CLASS_NOTIF | FAN_REPORT_FID
 * | FAN_REPORT_DFID_NAME | FAN_REPORT_TARGET_FID, FAN_MARK_FILESYSTEM) — which
 * only exercised regular files/dirs — with link scenarios on a real exe.dev VM:
 * symlink create/delete/rename/retarget, write/read *through* a link, dangling
 * links, hardlink create, and writes via the second hardlinked name. Records
 * raw events, which names surface, and open_by_handle_at behavior on link
 * inodes (O_PATH vs plain O_RDONLY). Evidence only — MAP-SYNC L11.
 *
 * The helper drops events that don't resolve under the drive prefix (the same
 * scoping production uses): a FAN_MARK_FILESYSTEM mark sees the whole root
 * superblock, and on a busy VM the unfiltered OPEN stream can flood the
 * tmpfs capture file.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { probeReportUrl } from './probe-artifacts.ts'
import { cleanup, createVm, fenced, makeContext, runOrThrow, vmName } from './probe-common.ts'

const DRIVE = '/home/exedev/drive'
const LINKS = `${DRIVE}/links`
const WORK = '/tmp/duet-links'
const REPORT = probeReportUrl('fanotify-links-probe.md')

// Same decoder as the fanotify-fid spike, fixed to the proven group, plus a
// second open_by_handle_at attempt WITHOUT O_PATH so link-inode behavior is
// recorded (`openPlainErrno`; expect ELOOP=40 on symlink inodes).
const helper = String.raw`import { dlopen, FFIType, ptr, read as ffiRead } from "bun:ffi";
import { openSync, readlinkSync } from "node:fs";

const C={CLOEXEC:1,NONBLOCK:2,CLASS_NOTIF:0,REPORT_FID:0x200,REPORT_DIR_FID:0x400,REPORT_NAME:0x800,REPORT_TARGET_FID:0x1000,MARK_ADD:1,MARK_FILESYSTEM:0x100,MODIFY:2n,CLOSE_WRITE:8n,OPEN:0x20n,MOVED_FROM:0x40n,MOVED_TO:0x80n,CREATE:0x100n,DELETE:0x200n,Q_OVERFLOW:0x4000n,EVENT_ON_CHILD:0x08000000n,RENAME:0x10000000n,ONDIR:0x40000000n};
const libc=dlopen("libc.so.6",{fanotify_init:{args:[FFIType.u32,FFIType.u32],returns:FFIType.i32},fanotify_mark:{args:[FFIType.i32,FFIType.u32,FFIType.u64,FFIType.i32,FFIType.cstring],returns:FFIType.i32},open_by_handle_at:{args:[FFIType.i32,FFIType.ptr,FFIType.i32],returns:FFIType.i32},read:{args:[FFIType.i32,FFIType.ptr,FFIType.u64],returns:FFIType.i64},close:{args:[FFIType.i32],returns:FFIType.i32},__errno_location:{args:[],returns:FFIType.ptr}});
const errno=()=>ffiRead.i32(libc.symbols.__errno_location(),0);
const [root,output]=process.argv.slice(2);
const fanfd=libc.symbols.fanotify_init(C.CLOEXEC|C.NONBLOCK|C.CLASS_NOTIF|C.REPORT_FID|C.REPORT_DIR_FID|C.REPORT_NAME|C.REPORT_TARGET_FID,0);
if(fanfd<0)throw new Error("fanotify_init errno="+errno());
const mask=C.CREATE|C.DELETE|C.MOVED_FROM|C.MOVED_TO|C.RENAME|C.EVENT_ON_CHILD|C.ONDIR|C.OPEN|C.MODIFY|C.CLOSE_WRITE;
if(libc.symbols.fanotify_mark(fanfd,C.MARK_ADD|C.MARK_FILESYSTEM,mask,-100,Buffer.from(root+"\0"))<0)throw new Error("fanotify_mark errno="+errno());
const mountfd=openSync(root,0); // O_RDONLY: open_by_handle_at rejects O_PATH mount fds with EBADF.
await Bun.write(output,"");const out=Bun.file(output).writer();const buf=Buffer.allocUnsafe(1024*1024);let stopping=false;
process.on("SIGTERM",()=>stopping=true);function emit(x:unknown){out.write(JSON.stringify(x)+"\n");out.flush()}
emit({ready:true,pid:process.pid});
function parseInfo(base:number,len:number){const records:any[]=[];let p=base+24;while(p+4<=base+len){const type=buf.readUInt8(p),ilen=buf.readUInt16LE(p+2);if(ilen<4||p+ilen>base+len)break;const rec:any={type,len:ilen};if([1,2,3,10,12].includes(type)&&ilen>=20){rec.fsid=[buf.readInt32LE(p+4),buf.readInt32LE(p+8)];const hb=buf.readUInt32LE(p+12),ht=buf.readInt32LE(p+16);rec.handleType=ht;rec.handle=buf.subarray(p+20,p+20+hb).toString("hex");rec.handleKey=ht+":"+rec.handle;const nameStart=p+20+hb;if([2,3,10,12].includes(type)&&nameStart<p+ilen){const z=buf.indexOf(0,nameStart);rec.name=buf.toString("utf8",nameStart,z>=0&&z<p+ilen?z:p+ilen)}const fh=Buffer.alloc(8+hb);fh.writeUInt32LE(hb,0);fh.writeInt32LE(ht,4);buf.copy(fh,8,p+20,p+20+hb);const fd=libc.symbols.open_by_handle_at(mountfd,ptr(fh),0x200000);rec.openByHandleErrno=fd<0?errno():0;if(fd>=0){try{rec.objectPath=readlinkSync("/proc/self/fd/"+fd)}catch{}libc.symbols.close(fd)}const plain=libc.symbols.open_by_handle_at(mountfd,ptr(fh),0);rec.openPlainErrno=plain<0?errno():0;if(plain>=0)libc.symbols.close(plain);if(rec.name!==undefined)rec.resolvedPath=(rec.objectPath??"<unresolved-parent>").replace(/\/$/,"")+"/"+rec.name}records.push(rec);p+=ilen}return records}
while(!stopping){const got=Number(libc.symbols.read(fanfd,ptr(buf),buf.length));if(got<0){const e=errno();if(e===11){await Bun.sleep(1);continue}throw new Error("read errno="+e)}let off=0;while(off+24<=got){const eventLen=buf.readUInt32LE(off),mask=buf.readBigUInt64LE(off+8),eventFd=buf.readInt32LE(off+16),pid=buf.readInt32LE(off+20);if(eventLen<24||off+eventLen>got){emit({decodeError:true,eventLen,got,off});break}if(pid===process.pid){if(eventFd>=0)libc.symbols.close(eventFd);off+=eventLen;continue} // self-pid drop: our plain O_RDONLY handle opens emit FAN_OPEN and would self-amplify (production drops watcher-pid events the same way)
const records=parseInfo(off,eventLen);const overflow=(mask&C.Q_OVERFLOW)!==0n;const inDrive=records.some(r=>((r.objectPath??r.resolvedPath)??"").startsWith(root));if(inDrive||overflow)emit({mask:Number(mask),pid,records,overflow});if(eventFd>=0)libc.symbols.close(eventFd);off+=eventLen}}
libc.symbols.close(mountfd);libc.symbols.close(fanfd);out.end();
`

// Runs ON the VM as root (sudo bun): for each scenario, starts the fanotify
// helper, runs the scenario shell command, stops the helper, and collects the
// raw NDJSON events. Emits one JSON document on stdout. No nested
// interpolation — the scenario list arrives base64-encoded in argv[2].
const driver = `
import { existsSync, mkdirSync, readFileSync } from 'node:fs'

const DRIVE = '/home/exedev/drive'
const LINKS = DRIVE + '/links'
const RUN = '/dev/shm/duet-links-run' // tmpfs: helper output must not hit the watched superblock
const HELPER = '/tmp/duet-links/helper.ts'
const scenarios = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString()) as Array<{
  stem: string
  title: string
  command: string
}>

async function sh(cmd: string): Promise<string> {
  const proc = Bun.spawn(['sh', '-c', cmd], { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) throw new Error('command failed (' + code + '): ' + cmd + '\\n' + (stderr || stdout))
  return stdout.trim()
}

mkdirSync(RUN, { recursive: true })
await sh('mkdir -p ' + LINKS + ' && printf seed-one > ' + LINKS + '/target.txt && printf seed-two > ' + LINKS + '/target2.txt')

const out: Array<{ stem: string; title: string; command: string; events: unknown[] }> = []
for (const s of scenarios) {
  console.error('PROGRESS ' + Date.now() + ' start ' + s.stem)
  const file = RUN + '/' + s.stem + '.ndjson'
  const proc = Bun.spawn([process.execPath, HELPER, DRIVE, file], { stdout: 'ignore', stderr: 'pipe' })
  let ready = false
  for (let i = 0; i < 40; i++) {
    if (existsSync(file) && readFileSync(file, 'utf8').includes('"ready":true')) { ready = true; break }
    await Bun.sleep(250)
  }
  if (!ready) {
    proc.kill()
    const stderr = await new Response(proc.stderr).text()
    throw new Error('helper never became ready for ' + s.stem + ': ' + stderr)
  }
  await Bun.sleep(200)
  await sh(s.command)
  await Bun.sleep(400)
  proc.kill('SIGTERM')
  await proc.exited
  await Bun.sleep(100)
  const events = readFileSync(file, 'utf8')
    .split('\\n')
    .filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    .filter(e => !(e as { ready?: boolean }).ready)
  out.push({ stem: s.stem, title: s.title, command: s.command, events })
}
const inodeEvidence = await sh("cd " + LINKS + " && stat -c '%i %h %F %N' target.txt target2.txt hard1")
console.log('DRIVER-JSON:' + JSON.stringify({
  kernel: readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim(),
  bun: Bun.version,
  uid: process.getuid?.(),
  scenarios: out,
  inodeEvidence,
}))
`

interface RecordInfo {
  type: number
  len: number
  name?: string
  objectPath?: string
  resolvedPath?: string
  handleKey?: string
  openByHandleErrno?: number
  openPlainErrno?: number
}
interface Event {
  mask?: number
  pid?: number
  records?: RecordInfo[]
  overflow?: boolean
}
interface Scenario {
  stem: string
  title: string
  command: string
  events: Event[]
}

const MASK = {
  MODIFY: 2,
  CLOSE_WRITE: 8,
  OPEN: 0x20,
  MOVED_FROM: 0x40,
  MOVED_TO: 0x80,
  CREATE: 0x100,
  DELETE: 0x200,
  RENAME: 0x10000000,
} as const
const CONTENT = MASK.OPEN | MASK.MODIFY | MASK.CLOSE_WRITE

const SCENARIOS = [
  {
    stem: 's1-symlink-create',
    title: 'Symlink create (`ln -s target.txt link1`)',
    command: `cd ${LINKS} && ln -s target.txt link1`,
  },
  {
    stem: 's2-through-link',
    title: 'Read + write through the link (`cat link1; printf >> link1`)',
    command: `cd ${LINKS} && cat link1 >/dev/null && printf -- -through >> link1`,
  },
  {
    stem: 's3-symlink-rename',
    title: 'Symlink rename (`mv link1 link1r`)',
    command: `cd ${LINKS} && mv link1 link1r`,
  },
  {
    stem: 's4-symlink-retarget',
    title: 'Symlink retarget (`ln -sfn target2.txt link1r`)',
    command: `cd ${LINKS} && ln -sfn target2.txt link1r`,
  },
  {
    stem: 's5-symlink-delete',
    title: 'Symlink delete (`rm link1r`)',
    command: `cd ${LINKS} && rm link1r`,
  },
  {
    stem: 's6-dangling',
    title: 'Dangling link: create, failed read, delete',
    command: `cd ${LINKS} && ln -s missing.txt dangle && { cat dangle || true; } >/dev/null 2>&1 && rm dangle`,
  },
  {
    stem: 's7-hardlink-create',
    title: 'Hardlink create (`ln target.txt hard1`)',
    command: `cd ${LINKS} && ln target.txt hard1`,
  },
  {
    stem: 's8-hardlink-write',
    title: 'Write via the second hardlinked name (`printf >> hard1`)',
    command: `cd ${LINKS} && printf -- -viahard >> hard1`,
  },
]

function q(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`
}
function eventName(mask = 0): string {
  return (
    Object.entries(MASK)
      .filter(([, bit]) => (mask & bit) !== 0)
      .map(([n]) => n)
      .join('|') || `0x${mask.toString(16)}`
  )
}
function line(e: Event): string {
  return JSON.stringify({ event: eventName(e.mask), pid: e.pid, records: e.records })
}
function inLinksDir(e: Event): boolean {
  return (e.records ?? []).some(
    r => r.objectPath?.startsWith(LINKS) || r.resolvedPath?.startsWith(LINKS),
  )
}
function hasBit(events: Event[], bit: number): boolean {
  return events.some(e => ((e.mask ?? 0) & bit) !== 0)
}
function hasName(events: Event[], name: string): boolean {
  return events.some(e => e.records?.some(r => r.name === name))
}

/** Leak-check only the VMs this run created — other agents run their own duet-test VMs. */
async function assertOwnVmsDeleted(ctx: ReturnType<typeof makeContext>): Promise<void> {
  let leaked: string[] = []
  for (let attempt = 0; attempt < 10; attempt++) {
    const names = new Set((await ctx.control.list()).map(vm => vm.vm_name))
    leaked = ctx.created.filter(name => names.has(name))
    if (leaked.length === 0) return
    await Bun.sleep(1_000)
  }
  throw new Error(`This run's duet-test VMs remain: ${leaked.join(', ')}`)
}

async function main() {
  const ctx = makeContext()
  const name = vmName('fanotify-links')
  let failure: unknown, cleanupFailure: Error | undefined
  try {
    await ctx.control.whoami()
    const createdVm = await createVm(ctx, {
      name,
      comment: 'duet slice-13 fanotify link-semantics probe',
    })
    const dest = createdVm.value.ssh_dest
    await ctx.ssh.waitUntilReady(dest, { timeoutMs: 180_000 })
    await runOrThrow(ctx.ssh, dest, "sudo -n true && echo 'sudo -n true: ok'")
    await runOrThrow(ctx.ssh, dest, 'curl -fsSL https://bun.sh/install | bash', 180_000)
    const scenariosB64 = Buffer.from(JSON.stringify(SCENARIOS)).toString('base64')
    await runOrThrow(
      ctx.ssh,
      dest,
      `mkdir -p ${WORK}; printf %s ${q(Buffer.from(helper).toString('base64'))} | base64 -d > ${WORK}/helper.ts; printf %s ${q(Buffer.from(driver).toString('base64'))} | base64 -d > ${WORK}/driver.ts`,
    )
    const run = await ctx.ssh.exec(
      dest,
      `sudo /home/exedev/.bun/bin/bun ${WORK}/driver.ts ${scenariosB64}`,
      300_000,
    )
    const jsonStart = run.stdout.indexOf('DRIVER-JSON:')
    if (run.exitCode !== 0 || jsonStart < 0) {
      const diag = await ctx.ssh
        .exec(dest, 'free -m; ls -la /dev/shm/duet-links-run 2>/dev/null', 20_000)
        .then(d => d.stdout)
        .catch(e => `diag failed: ${e}`)
      throw new Error(
        `driver failed. exit=${run.exitCode}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}\ndiagnostics:\n${diag}`,
      )
    }
    const payload = JSON.parse(run.stdout.slice(jsonStart + 'DRIVER-JSON:'.length)) as {
      kernel: string
      bun: string
      uid?: number
      scenarios: Scenario[]
      inodeEvidence: string
    }
    const scenarios = payload.scenarios.map(s => ({ ...s, events: s.events.filter(inLinksDir) }))
    if (scenarios.length !== 8) throw new Error(`expected 8 scenarios, got ${scenarios.length}`)
    const [s1, s2, s3, s4, s5, s6, s7, s8] = scenarios as [
      Scenario,
      Scenario,
      Scenario,
      Scenario,
      Scenario,
      Scenario,
      Scenario,
      Scenario,
    ]

    // --- Analysis ---
    const symlinkObject = s1.events
      .filter(e => ((e.mask ?? 0) & MASK.CREATE) !== 0)
      .flatMap(e => e.records ?? [])
      .find(r => r.type === 1)
    const createOk = hasBit(s1.events, MASK.CREATE) && hasName(s1.events, 'link1')
    const symlinkOPathOk =
      symlinkObject?.openByHandleErrno === 0 && symlinkObject.objectPath?.endsWith('/link1')
    const symlinkPlainErrno = symlinkObject?.openPlainErrno
    const contentEvents = (s: Scenario) => s.events.filter(e => ((e.mask ?? 0) & CONTENT) !== 0)
    const resolvesTo = (events: Event[], suffix: string) =>
      events.some(e => e.records?.some(r => r.objectPath?.endsWith(suffix)))
    const throughTargetOk =
      resolvesTo(contentEvents(s2), '/target.txt') && !resolvesTo(contentEvents(s2), '/link1')
    const throughName =
      contentEvents(s2)
        .flatMap(e => e.records ?? [])
        .find(r => r.name !== undefined)?.name ?? '<none>'
    const renameOk =
      hasBit(s3.events, MASK.RENAME) && hasName(s3.events, 'link1') && hasName(s3.events, 'link1r')
    const retargetKinds = [...new Set(s4.events.map(e => eventName(e.mask)))].join(', ')
    const deleteOk = hasBit(s5.events, MASK.DELETE) && hasName(s5.events, 'link1r')
    const dangleCreateOk = hasBit(s6.events, MASK.CREATE) && hasName(s6.events, 'dangle')
    const dangleDeleteOk = hasBit(s6.events, MASK.DELETE) && hasName(s6.events, 'dangle')
    const dangleContent = contentEvents(s6).filter(e =>
      e.records?.some(r => r.name === 'dangle' || r.objectPath?.endsWith('/dangle')),
    )
    const hardCreateOk = hasBit(s7.events, MASK.CREATE) && hasName(s7.events, 'hard1')
    const hardCreateObject = s7.events
      .filter(e => ((e.mask ?? 0) & MASK.CREATE) !== 0)
      .flatMap(e => e.records ?? [])
      .find(r => r.type === 1)
    const targetHandle = contentEvents(s2)
      .flatMap(e => e.records ?? [])
      .find(r => r.type === 1)?.handleKey
    const hardWriteRecord = contentEvents(s8)
      .flatMap(e => e.records ?? [])
      .find(r => r.type === 1)
    const hardSharesInode =
      hardWriteRecord?.handleKey !== undefined && hardWriteRecord.handleKey === targetHandle
    const hardWritePath = hardWriteRecord?.objectPath ?? '<unresolved>'
    const overflow = scenarios.some(s => s.events.some(e => e.overflow))

    const green =
      createOk &&
      renameOk &&
      deleteOk &&
      throughTargetOk &&
      symlinkOPathOk === true &&
      dangleCreateOk &&
      dangleDeleteOk &&
      hardCreateOk &&
      !overflow
    const pf = (b: boolean) => (b ? 'PASS' : 'FAIL')
    const scenarioSections = scenarios
      .map(
        s =>
          `### ${s.title}\n\n${fenced(s.events.map(line).join('\n') || '(no events under ' + LINKS + ')')}`,
      )
      .join('\n\n')
    const report = `# fanotify link-semantics probe (slice 13, MAP-SYNC L11)

Run: ${new Date().toISOString()} on VM \`${name}\` (deleted after capture).
Group: the proven FID/name group from
[fanotify-fid-spike.md](fanotify-fid-spike.md) — \`FAN_CLASS_NOTIF |
FAN_REPORT_FID | FAN_REPORT_DFID_NAME | FAN_REPORT_TARGET_FID\`, one
\`FAN_MARK_FILESYSTEM\` mark on \`${DRIVE}\` with dirent + content mask.
Events below are filtered to records under \`${LINKS}\`; each record carries
two \`open_by_handle_at\` attempts: \`openByHandleErrno\` (O_PATH) and
\`openPlainErrno\` (plain O_RDONLY).

## Environment

- Kernel: \`${payload.kernel}\`
- Bun: \`${payload.bun}\`
- Privilege: helper ran as uid ${payload.uid} (sudo)

## Raw captures

${scenarioSections}

### Inode evidence after the run

${fenced(payload.inodeEvidence)}

## Observations

- Symlink create surfaces as a named dirent CREATE (\`link1\`): **${pf(createOk)}**.
  The TARGET_FID object record is the symlink inode itself; \`open_by_handle_at\`
  with \`O_PATH\` ${symlinkOPathOk ? `resolves it (errno 0, path \`${symlinkObject?.objectPath}\`)` : `did NOT resolve it (errno ${symlinkObject?.openByHandleErrno ?? 'n/a'})`};
  plain \`O_RDONLY\` on the same handle returns errno ${symlinkPlainErrno ?? 'n/a'}${symlinkPlainErrno === 40 ? ' (ELOOP — you cannot open a symlink inode for content, only O_PATH it)' : ''}.
- Read/write **through** the link produce content events on the **target**
  inode only (no content event references \`link1\`): **${pf(throughTargetOk)}**.
  The DFID_NAME on those content events is \`${throughName}\` — the kernel
  reports the resolved target's own parent+name, so through-link content
  attribution needs no link awareness at all.
- Symlink rename is a normal FAN_RENAME with both names: **${pf(renameOk)}**.
- Retarget via \`ln -sfn\` surfaced as: ${retargetKinds || '(nothing)'} —
  ${
    hasBit(s4.events, MASK.RENAME)
      ? 'coreutils created a temp symlink and renamed it over the old one, so retarget is dirent CREATE+RENAME of the link name, never a MODIFY.'
      : hasBit(s4.events, MASK.DELETE) && hasBit(s4.events, MASK.CREATE)
        ? 'coreutils unlinked and re-created the link, so retarget is dirent DELETE+CREATE of the link name, never a MODIFY.'
        : 'see the raw capture above; no MODIFY is emitted for the link inode.'
  }
- Symlink delete is a named dirent DELETE: **${pf(deleteOk)}**.
- Dangling link: create **${pf(dangleCreateOk)}**, delete **${pf(dangleDeleteOk)}**,
  content events from the failed \`cat\`: ${dangleContent.length} (open of a
  dangling link fails before any fanotify content event exists).
- Hardlink create surfaces as a named dirent CREATE (\`hard1\`): **${pf(hardCreateOk)}**,
  whose object FID is the *existing* inode (handleKey \`${hardCreateObject?.handleKey ?? 'n/a'}\`).
- Write via the second hardlinked name emits content events keyed by that same
  shared inode handle (matches the target's content handle: **${hardSharesInode ? 'yes' : 'no'}**);
  \`open_by_handle_at\` + \`/proc/self/fd\` readlink resolved it to
  \`${hardWritePath}\` — the kernel picks one alias, so per-name hardlink
  attribution is impossible from FID events (consistent with MAP-SYNC Q14:
  hardlinks are content copies, no inode fidelity promised).
- Queue overflow during the run: ${overflow ? 'YES' : 'none'}.

## Implications for slices 09 / 11 / 16

- Link *name* operations (create/delete/rename/retarget) arrive as ordinary
  named dirent events — the slice-07 codec and slice-11 resolver need no
  special symlink path beyond kind-tagging; the parent-dir + name join from
  the FID spike covers them unchanged.
- Content through a link attributes to the target file's real path — exactly
  what attribution wants; never resolve through the link yourself.
- When the watcher needs to distinguish "symlink created" from "file created",
  \`open_by_handle_at(O_PATH)\` + \`fstatat\`/\`readlinkat\` on the object handle
  works; plain opens of link inodes fail with ELOOP by design.

## Criteria

| Criterion | Result |
| --- | --- |
| Symlink create/delete/rename surface as named dirent events | ${pf(createOk && deleteOk && renameOk)} |
| Retarget observable via dirent events | ${pf(s4.events.length > 0)} |
| Through-link content resolves to the target FID/path | ${pf(throughTargetOk)} |
| Symlink object handle resolvable with O_PATH | ${pf(symlinkOPathOk === true)} |
| Dangling link create/delete visible | ${pf(dangleCreateOk && dangleDeleteOk)} |
| Hardlink create visible; second-name write shares the inode handle | ${pf(hardCreateOk && hardSharesInode)} |
| No queue overflow | ${pf(!overflow)} |

Verdict: **${green ? 'GREEN' : 'RED'}** — ${
      green
        ? 'link operations are attributable through the existing FID/name group: named dirent events for link-name ops, target-FID resolution for through-link content, O_PATH handle resolution for link inodes. No fallback needed; 09/11/16 can trust link events.'
        : 'link events did not meet the attribution criteria above; adopt the pre-decided fallback (links surface via parent-dir dirent events only; content-through-link attributes to the target) per slices/13-kernel-probe-pack.md.'
    }
`
    await mkdir(fileURLToPath(new URL('.', REPORT)), { recursive: true })
    await writeFile(fileURLToPath(REPORT), report)
    console.log(report)
  } catch (e) {
    failure = e
  } finally {
    const result = await cleanup(ctx)
    if (result.deleteErrors.length) cleanupFailure = new Error(result.deleteErrors.join('; '))
    try {
      await assertOwnVmsDeleted(ctx)
    } catch (e) {
      cleanupFailure = e instanceof Error ? e : new Error(String(e))
    }
    console.error(
      cleanupFailure
        ? `Cleaned ${result.deleted.join(', ')}; verification failed`
        : `Cleaned ${result.deleted.join(', ') || 'none'}; this run's VMs are gone`,
    )
  }
  if (cleanupFailure) throw cleanupFailure
  if (failure) throw failure
}

await main()
