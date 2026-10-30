/**
 * Slice-13 probe (b): netlink proc-connector over bun:ffi — pass/fail only.
 *
 * The README's "only load-bearing piece no spike has proven": can a Bun
 * process (via bun:ffi libc calls, no native addon) open an AF_NETLINK /
 * NETLINK_CONNECTOR socket, subscribe with PROC_CN_MCAST_LISTEN, and receive
 * fork/exec/exit events for a spawned process tree on a real exe.dev VM?
 * Needs root (CAP_NET_ADMIN) — the VM-side helper runs under sudo, like the
 * fanotify spike; an unprivileged control run records where the privilege
 * requirement bites. Full helper integration stays in slice 09.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { probeReportUrl } from './probe-artifacts.ts'
import { cleanup, createVm, fenced, makeContext, runOrThrow, vmName } from './probe-common.ts'

const WORK = '/tmp/duet-proc'
const REPORT = probeReportUrl('proc-connector-probe.md')

// VM-side helper. Wire layout on x86_64 (all unaligned-safe Buffer reads):
//   nlmsghdr (16B: len u32, type u16, flags u16, seq u32, pid u32)
//   cn_msg   (20B: cb_id{idx u32, val u32}, seq u32, ack u32, len u16, flags u16)
//   payload  — send: proc_cn_mcast_op u32 (LISTEN=1)
//              recv: proc_event { what u32 @+0, cpu u32 @+4, timestamp u64 @+8,
//                                 event data @+16 } (u64 alignment inside the
//                                 struct), i.e. absolute offsets what@36, data@52.
const helper = String.raw`import { dlopen, FFIType, ptr, read as ffiRead } from "bun:ffi";

const AF_NETLINK=16,SOCK_DGRAM=2,NETLINK_CONNECTOR=11,CN_IDX_PROC=1,CN_VAL_PROC=1,NLMSG_DONE=3,PROC_CN_MCAST_LISTEN=1,MSG_DONTWAIT=0x40,EAGAIN=11;
const WHAT={0:"none(ack)",1:"fork",2:"exec",4:"uid",0x40:"gid",0x80:"sid",0x100:"ptrace",0x200:"comm",0x40000000:"coredump",0x80000000:"exit"} as Record<number,string>;
const libc=dlopen("libc.so.6",{socket:{args:[FFIType.i32,FFIType.i32,FFIType.i32],returns:FFIType.i32},bind:{args:[FFIType.i32,FFIType.ptr,FFIType.u32],returns:FFIType.i32},sendto:{args:[FFIType.i32,FFIType.ptr,FFIType.u64,FFIType.i32,FFIType.ptr,FFIType.u32],returns:FFIType.i64},recv:{args:[FFIType.i32,FFIType.ptr,FFIType.u64,FFIType.i32],returns:FFIType.i64},close:{args:[FFIType.i32],returns:FFIType.i32},__errno_location:{args:[],returns:FFIType.ptr}});
const errno=()=>ffiRead.i32(libc.symbols.__errno_location(),0);
const emit=(x:unknown)=>console.log(JSON.stringify(x));
function die(step:string):never{emit({fatal:step,errno:errno(),uid:process.getuid?.()});process.exit(1)}
const fd=libc.symbols.socket(AF_NETLINK,SOCK_DGRAM,NETLINK_CONNECTOR);if(fd<0)die("socket");
const sa=Buffer.alloc(12);sa.writeUInt16LE(AF_NETLINK,0);sa.writeUInt32LE(process.pid,4);sa.writeUInt32LE(CN_IDX_PROC,8);
if(libc.symbols.bind(fd,ptr(sa),12)<0)die("bind");
emit({step:"bind",ok:true,uid:process.getuid?.(),nlPid:process.pid,groups:CN_IDX_PROC});
const msg=Buffer.alloc(40);msg.writeUInt32LE(40,0);msg.writeUInt16LE(NLMSG_DONE,4);msg.writeUInt32LE(process.pid,12);msg.writeUInt32LE(CN_IDX_PROC,16);msg.writeUInt32LE(CN_VAL_PROC,20);msg.writeUInt16LE(4,32);msg.writeUInt32LE(PROC_CN_MCAST_LISTEN,36);
const dst=Buffer.alloc(12);dst.writeUInt16LE(AF_NETLINK,0);
if(Number(libc.symbols.sendto(fd,ptr(msg),40,0,ptr(dst),12))<0)die("sendto PROC_CN_MCAST_LISTEN");
emit({step:"mcast-listen-sent",ok:true});
const buf=Buffer.allocUnsafe(65536);
const events:{what:string,pids:number[]}[]=[];
let ackSeen=false;
function drain(){for(;;){const n=Number(libc.symbols.recv(fd,ptr(buf),buf.length,MSG_DONTWAIT));if(n<0){if(errno()===EAGAIN)return;die("recv")}let off=0;while(off+16<=n){const nlen=buf.readUInt32LE(off),type=buf.readUInt16LE(off+4);if(nlen<16||off+nlen>n)break;if(type===NLMSG_DONE&&nlen>=56){const what=buf.readUInt32LE(off+36);const d=off+52;const pids:number[]=[];if(what===1)pids.push(buf.readUInt32LE(d),buf.readUInt32LE(d+4),buf.readUInt32LE(d+8),buf.readUInt32LE(d+12));else if(what===2)pids.push(buf.readUInt32LE(d),buf.readUInt32LE(d+4));else if(what===0x80000000)pids.push(buf.readUInt32LE(d),buf.readUInt32LE(d+4),buf.readUInt32LE(d+8));if(what===0)ackSeen=true;events.push({what:WHAT[what]??("0x"+what.toString(16)),pids})}off+=(nlen+3)&~3}}}
const ackDeadline=Date.now()+800;while(Date.now()<ackDeadline&&!ackSeen){drain();await Bun.sleep(5)}
emit({step:"listen-ack",ackSeen});
const child=Bun.spawn(["/bin/sh","-c","sleep 0.2; /bin/echo one >/dev/null; /bin/sh -c '/bin/echo two >/dev/null'; sleep 0.1"],{stdout:"ignore",stderr:"ignore"});
emit({step:"spawned",pid:child.pid});
const collectUntil=Date.now()+5000;while(Date.now()<collectUntil){drain();await Bun.sleep(10)}
await child.exited;drain();libc.symbols.close(fd);
const spawned=child.pid;
const tree=new Set([spawned]);
for(const e of events)if(e.what==="fork"&&tree.has(e.pids[1]??-1))tree.add(e.pids[3]??-1);
const treeForks=events.filter(e=>e.what==="fork"&&tree.has(e.pids[1]??-1)).length;
const treeExecs=events.filter(e=>e.what==="exec"&&tree.has(e.pids[1]??-1)).length;
const treeExits=events.filter(e=>e.what==="exit"&&tree.has(e.pids[1]??-1)).length;
const sawSpawnedExec=events.some(e=>e.what==="exec"&&e.pids[1]===spawned);
const sawSpawnedExit=events.some(e=>e.what==="exit"&&e.pids[1]===spawned);
const counts:Record<string,number>={};for(const e of events)counts[e.what]=(counts[e.what]??0)+1;
const pass=ackSeen&&treeForks>=1&&treeExecs>=1&&treeExits>=1&&sawSpawnedExec&&sawSpawnedExit;
const treeEvents=events.filter(e=>e.pids.some(p=>tree.has(p)));
emit({summary:true,result:pass?"pass":"fail",ackSeen,spawnedPid:spawned,treePids:[...tree],counts,treeForks,treeExecs,treeExits,sawSpawnedExec,sawSpawnedExit,totalEvents:events.length});
for(const e of treeEvents.slice(0,40))emit({tree:true,...e});
process.exit(pass?0:1);
`

interface Summary {
  summary: true
  result: 'pass' | 'fail'
  ackSeen: boolean
  spawnedPid: number
  treePids: number[]
  counts: Record<string, number>
  treeForks: number
  treeExecs: number
  treeExits: number
  sawSpawnedExec: boolean
  sawSpawnedExit: boolean
  totalEvents: number
}

function q(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`
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
  const name = vmName('proc-connector')
  let failure: unknown, cleanupFailure: Error | undefined
  try {
    await ctx.control.whoami()
    const createdVm = await createVm(ctx, {
      name,
      comment: 'duet slice-13 netlink proc-connector bun:ffi probe',
    })
    const dest = createdVm.value.ssh_dest
    await ctx.ssh.waitUntilReady(dest, { timeoutMs: 180_000 })
    const kernel = await runOrThrow(ctx.ssh, dest, 'uname -r')
    const sudoEvidence = await runOrThrow(ctx.ssh, dest, "sudo -n true && echo 'sudo -n true: ok'")
    await runOrThrow(ctx.ssh, dest, 'curl -fsSL https://bun.sh/install | bash', 180_000)
    const bunVersion = await runOrThrow(ctx.ssh, dest, '/home/exedev/.bun/bin/bun --version')
    await runOrThrow(
      ctx.ssh,
      dest,
      `mkdir -p ${WORK}; printf %s ${q(Buffer.from(helper).toString('base64'))} | base64 -d > ${WORK}/helper.ts`,
    )
    // Root run (the real question) plus an unprivileged control run to record
    // where the privilege requirement bites (expect EPERM at socket/bind).
    const rootRun = await ctx.ssh.exec(
      dest,
      `sudo /home/exedev/.bun/bin/bun ${WORK}/helper.ts`,
      60_000,
    )
    const unprivRun = await ctx.ssh.exec(
      dest,
      `/home/exedev/.bun/bin/bun ${WORK}/helper.ts`,
      30_000,
    )
    // Independent evidence: is the connector present in this kernel at all?
    // (a) python3 control — same socket() via a different runtime, so a
    // failure is not a bun:ffi artifact; (b) kernel config + /proc surface.
    const pyControl = await ctx.ssh.exec(
      dest,
      `sudo python3 -c 'import socket; s = socket.socket(16, socket.SOCK_DGRAM, 11); print("py-socket-ok")'`,
      30_000,
    )
    const kernelConfig = await ctx.ssh.exec(
      dest,
      'ls -la /proc/net/connector 2>&1; { zcat /proc/config.gz 2>/dev/null || cat "/boot/config-$(uname -r)" 2>/dev/null; } | grep -E "CONFIG_(CONNECTOR|PROC_EVENTS)" || echo "no CONFIG_CONNECTOR/CONFIG_PROC_EVENTS lines found in kernel config"',
      30_000,
    )
    const summary = rootRun.stdout
      .split('\n')
      .filter(Boolean)
      .flatMap(l => {
        try {
          return [JSON.parse(l) as Record<string, unknown>]
        } catch {
          return []
        }
      })
      .find(x => x.summary === true) as Summary | undefined
    const pass = rootRun.exitCode === 0 && summary?.result === 'pass'
    const kernelLacksConnector =
      rootRun.stdout.includes('"fatal":"socket","errno":93') &&
      pyControl.exitCode !== 0 &&
      (pyControl.stderr.includes('Protocol not supported') ||
        pyControl.stderr.includes('EPROTONOSUPPORT'))
    const report = `# netlink proc-connector over bun:ffi probe (slice 13)

Run: ${new Date().toISOString()} on VM \`${name}\` (deleted after capture).
Question (pass/fail only): can a sudo-run Bun process, using nothing but
\`bun:ffi\` libc calls (\`socket\`/\`bind\`/\`sendto\`/\`recv\`), open
\`AF_NETLINK\`/\`NETLINK_CONNECTOR\`, subscribe with \`PROC_CN_MCAST_LISTEN\`,
and receive fork/exec/exit events for a process tree it spawns? Full helper
integration (pid→session map at scale) stays in slice 09.

## Environment

- Kernel: \`${kernel}\`
- Bun: \`${bunVersion}\`
- Privilege: \`${sudoEvidence}\`

## Root run (sudo) — raw output

Exit code: ${rootRun.exitCode}

${fenced(rootRun.stdout || rootRun.stderr || '(no output)')}

## Unprivileged control run (plain exedev user)

Netlink connector needs CAP_NET_ADMIN; recording where it fails without root.
Exit code: ${unprivRun.exitCode}

${fenced(unprivRun.stdout || unprivRun.stderr || '(no output)')}

## Kernel-surface evidence (runtime-independent)

python3 control (\`socket.socket(AF_NETLINK, SOCK_DGRAM, NETLINK_CONNECTOR)\`
as root — a failure here proves the result is not a bun:ffi artifact), exit
code ${pyControl.exitCode}:

${fenced(pyControl.stdout || pyControl.stderr || '(no output)')}

Kernel config / proc surface:

${fenced(kernelConfig.stdout || kernelConfig.stderr || '(no output)')}

## Result

| Check | Result |
| --- | --- |
| socket + bind (nl_pid=self, groups=CN_IDX_PROC) | ${summary ? 'PASS' : 'FAIL'} |
| PROC_CN_MCAST_LISTEN acked (proc_event none/ack) | ${summary?.ackSeen ? 'PASS' : 'FAIL'} |
| fork events for the spawned tree | ${(summary?.treeForks ?? 0) >= 1 ? `PASS (${summary?.treeForks})` : 'FAIL'} |
| exec events for the spawned tree (incl. the spawned pid) | ${summary?.sawSpawnedExec ? `PASS (${summary?.treeExecs})` : 'FAIL'} |
| exit events for the spawned tree (incl. the spawned pid) | ${summary?.sawSpawnedExit ? `PASS (${summary?.treeExits})` : 'FAIL'} |

Verdict: **${pass ? 'GREEN' : 'RED'}** — ${
      pass
        ? 'a bun:ffi netlink proc-connector works end-to-end on the exe.dev kernel; slice 09 can build the pid→session fork map on this mechanism as designed.'
        : kernelLacksConnector
          ? 'socket(AF_NETLINK, SOCK_DGRAM, NETLINK_CONNECTOR) fails with EPROTONOSUPPORT (errno 93) even as root, and the python3 control fails identically — the exe.dev kernel is built without CONFIG_CONNECTOR/CONFIG_PROC_EVENTS, so NO userspace runtime can use the proc connector on this image. This also kills step one of the pre-decided fallback chain (python3-ctypes uses the same kernel interface). Per slices/13-kernel-probe-pack.md: escalate first (a kernel-config request to exe.dev is the cheapest cure), then reslice 09 to a non-connector mechanism (blocking FAN_OPEN_PERM, or cgroup-based attribution without a live fork map) before 07/08 assumptions bake in.'
          : 'the bun:ffi netlink proc-connector did NOT deliver the required events; per slices/13-kernel-probe-pack.md, escalate first, then reslice 09 to the pre-decided fallback chain (python3-ctypes helper subprocess, else blocking FAN_OPEN_PERM) before 07/08 assumptions bake in.'
    }
`
    await mkdir(fileURLToPath(new URL('.', REPORT)), { recursive: true })
    await writeFile(fileURLToPath(REPORT), report)
    console.log(report)
    if (!pass) process.exitCode = 1
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
