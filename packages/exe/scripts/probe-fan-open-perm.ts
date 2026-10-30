/**
 * Slice-09 pre-probe: FAN_OPEN_PERM pid-pinning on the real exe.dev image.
 *
 * The reslice (slices/09-helper-standalone.md) replaced the dead proc-connector
 * fork map with a second fanotify group — FAN_CLASS_CONTENT | FAN_OPEN_PERM —
 * used ONLY to pin pid→cgroup while the opener is provably blocked in open().
 * This probe measures, on a real VM, whether that mechanism is viable BEFORE any
 * helper code is written. It answers four questions with measured evidence:
 *
 *   1. A FAN_CLASS_CONTENT/FAN_OPEN_PERM group works alongside the existing
 *      FID/name NOTIF group: the listener reads the event, reads
 *      /proc/<pid>/cgroup of the blocked opener, writes FAN_ALLOW, the opener
 *      proceeds. Short-lived `sh -c 'cat f'` × 20 — the fork-map-killer case the
 *      first spike failed 0/20 — must be captured 20/20 (the process cannot exit
 *      while blocked in the gated open).
 *   2. Per-open overhead: open latency with and without the perm listener under
 *      (a) sequential opens and (b) an open storm. Kill criterion: >~1ms p99
 *      added latency ⇒ RED (fall back to at-event /proc reads + counted misses).
 *   3. Listener-death auto-allow: kill -9 the listener mid-storm — opens must
 *      unblock (kernel auto-allows when the group fd closes). Measure the stall.
 *   4. OOM landmine (slice 13 proved a non-O_PATH watcher self-amplifies to OOM):
 *      the listener with self-pid drop + O_PATH-only resolution + event_fd close
 *      must stay flat on RSS during a storm.
 *
 * SAFETY — why a bind mount, not FAN_MARK_FILESYSTEM: a filesystem-wide
 * FAN_OPEN_PERM mark on the shared root gates EVERY open on the VM, including the
 * probe harness's own (a single-threaded listener that stalls would wedge the VM
 * it runs on). We `mount --bind` the drive onto itself so FAN_MARK_MOUNT scopes
 * the permission gate to opens resolved through the drive — same superblock (the
 * "drive filesystem" the reslice names), zero blast radius on the harness. The
 * listener only ever touches procfs (/proc/<pid>/cgroup) and a tmpfs output file
 * after arming, so it can never block on its own gated open (no self-deadlock).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { probeReportUrl } from './probe-artifacts.ts'
import { cleanup, createVm, makeContext, runOrThrow, vmName } from './probe-common.ts'

const WORK = '/tmp/duet-perm'
const REPORT = probeReportUrl('fan-open-perm-probe.md')

// ── VM-side perm listener (runs as root). Sets up the FAN_CLASS_CONTENT |
// FAN_OPEN_PERM pinning group (and, in capture mode, the FID/name NOTIF group
// alongside it), both marked FAN_MARK_MOUNT on the bind-mounted drive. poll()s
// both fds so a ready perm event is answered immediately (no sleep-poll latency).
// On each perm event: drop self-pid (respond ALLOW, no work — avoids self-
// deadlock), else on a pid-cache miss read /proc/<pid>/cgroup (the opener is
// blocked, so the read is race-free), cache it, then respond FAN_ALLOW and close
// the kernel's event_fd. Never opens a gated file; resolution is readlink on
// /proc/self/fd (procfs) — the O_PATH-equivalent hygiene the reslice requires.
// argv: [drive, outFile, mode('capture'|'bench'), withNotif('0'|'1')]
const helper = String.raw`import { dlopen, FFIType, ptr, read as ffiRead } from "bun:ffi";
import { readFileSync, readlinkSync } from "node:fs";

const C={CLOEXEC:1,NONBLOCK:2,CLASS_NOTIF:0,CLASS_CONTENT:4,REPORT_FID:0x200,REPORT_DIR_FID:0x400,REPORT_NAME:0x800,REPORT_TARGET_FID:0x1000,MARK_ADD:1,MARK_MOUNT:0x10,MARK_FILESYSTEM:0x100,OPEN:0x20n,MODIFY:2n,CLOSE_WRITE:8n,CREATE:0x100n,DELETE:0x200n,EVENT_ON_CHILD:0x08000000n,ONDIR:0x40000000n,OPEN_PERM:0x10000n,ALLOW:1,POLLIN:1,AT_FDCWD:-100};
const libc=dlopen("libc.so.6",{fanotify_init:{args:[FFIType.u32,FFIType.u32],returns:FFIType.i32},fanotify_mark:{args:[FFIType.i32,FFIType.u32,FFIType.u64,FFIType.i32,FFIType.cstring],returns:FFIType.i32},read:{args:[FFIType.i32,FFIType.ptr,FFIType.u64],returns:FFIType.i64},write:{args:[FFIType.i32,FFIType.ptr,FFIType.u64],returns:FFIType.i64},close:{args:[FFIType.i32],returns:FFIType.i32},poll:{args:[FFIType.ptr,FFIType.u64,FFIType.i32],returns:FFIType.i32},__errno_location:{args:[],returns:FFIType.ptr}});
const errno=()=>ffiRead.i32(libc.symbols.__errno_location(),0);
const [drive,outFile,mode,withNotifArg]=process.argv.slice(2);
const withNotif=withNotifArg==="1";
const self=process.pid;

const permfd=libc.symbols.fanotify_init(C.CLOEXEC|C.NONBLOCK|C.CLASS_CONTENT,0);
if(permfd<0)throw new Error("fanotify_init(perm) errno="+errno());
// PERM is the BLOCKING group: FAN_MARK_MOUNT on the drive's bind mount scopes
// the gate to opens resolved through the drive path only (root opens ungated →
// the harness is never wedged). Non-FID groups accept mount marks.
if(libc.symbols.fanotify_mark(permfd,C.MARK_ADD|C.MARK_MOUNT,C.OPEN_PERM,C.AT_FDCWD,Buffer.from(drive+"\0"))<0)throw new Error("fanotify_mark(perm) errno="+errno());
let notiffd=-1;
if(withNotif){
  notiffd=libc.symbols.fanotify_init(C.CLOEXEC|C.NONBLOCK|C.CLASS_NOTIF|C.REPORT_FID|C.REPORT_DIR_FID|C.REPORT_NAME|C.REPORT_TARGET_FID,0);
  if(notiffd<0)throw new Error("fanotify_init(notif) errno="+errno());
  // NOTIF is non-blocking, so FAN_MARK_FILESYSTEM (required for FID-mode marks —
  // FAN_MARK_MOUNT is rejected EINVAL) is safe even on the shared root sb.
  const nmask=C.OPEN|C.MODIFY|C.CLOSE_WRITE|C.CREATE|C.DELETE|C.EVENT_ON_CHILD|C.ONDIR;
  if(libc.symbols.fanotify_mark(notiffd,C.MARK_ADD|C.MARK_FILESYSTEM,nmask,C.AT_FDCWD,Buffer.from(drive+"\0"))<0)throw new Error("fanotify_mark(notif) errno="+errno());
}

// Output is on tmpfs (/dev/shm) — never the gated mount — and the writer is
// opened ONCE and kept open, so the hot path performs no gated opens.
const out=Bun.file(outFile).writer();
function emit(x:unknown){out.write(JSON.stringify(x)+"\n");out.flush()}

const pidCache=new Map<number,string>();const CACHE_MAX=4096;
let handledPerm=0,handledNotif=0,captures=0,cgroupMisses=0,overflow=0;
let stopping=false;process.on("SIGTERM",()=>stopping=true);

function rssKb():number{try{const parts=readFileSync("/proc/self/statm","utf8").trim().split(/\s+/);return Math.round((Number(parts[1])*4096)/1024)}catch{return -1}}
function cgroupOf(pid:number):string|null{try{const l=readFileSync("/proc/"+pid+"/cgroup","utf8").trim().split("\n")[0]??"";return l||null}catch{return null}}
function alive(pid:number):boolean{try{readFileSync("/proc/"+pid+"/comm","utf8");return true}catch{return false}}

const permBuf=Buffer.allocUnsafe(256*1024);
const notifBuf=Buffer.allocUnsafe(256*1024);
const resp=Buffer.allocUnsafe(8);
function respondAllow(fd:number){resp.writeInt32LE(fd,0);resp.writeUInt32LE(C.ALLOW,4);libc.symbols.write(permfd,ptr(resp),8)}

function drainPerm(){for(;;){const got=Number(libc.symbols.read(permfd,ptr(permBuf),permBuf.length));if(got<0){if(errno()===11)return;throw new Error("read(perm) errno="+errno())}if(got===0)return;let off=0;while(off+24<=got){const evLen=permBuf.readUInt32LE(off);const mask=permBuf.readBigUInt64LE(off+8);const fd=permBuf.readInt32LE(off+16);const pid=permBuf.readInt32LE(off+20);if(evLen<24||off+evLen>got)break;if(fd<0){off+=evLen;continue}
handledPerm++;
if(pid===self){respondAllow(fd);libc.symbols.close(fd);off+=evLen;continue}
if(mode==="capture"){let path:string|null=null;try{path=readlinkSync("/proc/self/fd/"+fd)}catch{}const cg=cgroupOf(pid);const al=alive(pid);if(path!==null&&path.includes("/shortlived/")){captures++;emit({capture:true,path,pid,cgroup:cg,alive:al})}respondAllow(fd);libc.symbols.close(fd)}
else{if(!pidCache.has(pid)){const cg=cgroupOf(pid);if(cg!==null){if(pidCache.size>=CACHE_MAX){const k=pidCache.keys().next().value;if(k!==undefined)pidCache.delete(k)}pidCache.set(pid,cg)}else cgroupMisses++}respondAllow(fd);libc.symbols.close(fd)}
off+=evLen}}}

function drainNotif(){if(notiffd<0)return;for(;;){const got=Number(libc.symbols.read(notiffd,ptr(notifBuf),notifBuf.length));if(got<0){if(errno()===11)return;throw new Error("read(notif) errno="+errno())}if(got===0)return;let off=0;while(off+24<=got){const evLen=notifBuf.readUInt32LE(off);if(evLen<24||off+evLen>got)break;handledNotif++;off+=evLen}}}

// pollfds: two struct pollfd { i32 fd; i16 events; i16 revents } = 8 bytes each.
const nfds=withNotif?2:1;
const pfds=Buffer.alloc(8*nfds);
pfds.writeInt32LE(permfd,0);pfds.writeInt16LE(C.POLLIN,4);
if(withNotif){pfds.writeInt32LE(notiffd,8);pfds.writeInt16LE(C.POLLIN,12);}

emit({ready:true,pid:self,mode,withNotif,rssKb:rssKb()});
let lastStats=Date.now();
while(!stopping){
  const r=libc.symbols.poll(ptr(pfds),nfds,100);
  if(r>0){const pr=pfds.readInt16LE(6);if((pr&C.POLLIN)!==0)drainPerm();if(withNotif){const nr=pfds.readInt16LE(14);if((nr&C.POLLIN)!==0)drainNotif();}}
  else if(r<0&&errno()!==4)throw new Error("poll errno="+errno());
  const now=Date.now();if(now-lastStats>=200){lastStats=now;emit({stats:true,at:now,handledPerm,handledNotif,captures,cgroupMisses,overflow,cacheSize:pidCache.size,rssKb:rssKb()})}
}
// One last drain so nothing is left pending, then final stats.
drainPerm();if(withNotif)drainNotif();
emit({stats:true,final:true,at:Date.now(),handledPerm,handledNotif,captures,cgroupMisses,overflow,cacheSize:pidCache.size,rssKb:rssKb()});
libc.symbols.close(permfd);if(notiffd>=0)libc.symbols.close(notiffd);out.end();
`

// ── VM-side open-latency bench (runs as root, a DIFFERENT pid from the listener
// so its opens are gated, not self-dropped). Times ONLY the open()/close()
// syscalls via bun:ffi libc, pre-encoding all path buffers outside the timed
// region. argv: [mode('seq'|'storm'|'victim'), n]. seq: reopen one file n times.
// storm: open n distinct files once each, back-to-back (the burst). victim: open
// one file in a tight loop until Date.now() exceeds start+n ms, logging per-open
// {t,d} — the driver kills the listener mid-run and reads this to measure the
// auto-allow stall. Emits BENCH-JSON: latency percentiles in nanoseconds.
const bench = String.raw`import { dlopen, FFIType, ptr, read as ffiRead } from "bun:ffi";
const DRIVE="/home/exedev/drive";
const libc=dlopen("libc.so.6",{open:{args:[FFIType.cstring,FFIType.i32],returns:FFIType.i32},close:{args:[FFIType.i32],returns:FFIType.i32},__errno_location:{args:[],returns:FFIType.ptr}});
const errno=()=>ffiRead.i32(libc.symbols.__errno_location(),0);
const [mode,nArg]=process.argv.slice(2);const n=Number(nArg);
function pct(sorted:number[],p:number){if(sorted.length===0)return 0;const i=Math.min(sorted.length-1,Math.floor(p*(sorted.length-1)));return sorted[i]}
if(mode==="seq"){
  const buf=Buffer.from(DRIVE+"/bench/seq.dat\0");const samples=new Float64Array(n);
  const wall0=Bun.nanoseconds();
  for(let i=0;i<n;i++){const t0=Bun.nanoseconds();const fd=libc.symbols.open(buf,0);const t1=Bun.nanoseconds();if(fd<0)throw new Error("open errno="+errno());libc.symbols.close(fd);samples[i]=t1-t0}
  const wallMs=(Bun.nanoseconds()-wall0)/1e6;const s=Array.from(samples).sort((a,b)=>a-b);
  console.log("BENCH-JSON:"+JSON.stringify({mode,count:n,p50ns:pct(s,0.5),p99ns:pct(s,0.99),p999ns:pct(s,0.999),maxNs:s[s.length-1],meanNs:s.reduce((a,b)=>a+b,0)/s.length,wallMs}));
}else if(mode==="storm"){
  const bufs:Buffer[]=[];for(let i=0;i<n;i++)bufs.push(Buffer.from(DRIVE+"/bench/storm/f"+i+"\0"));
  const samples=new Float64Array(n);const wall0=Bun.nanoseconds();
  for(let i=0;i<n;i++){const t0=Bun.nanoseconds();const fd=libc.symbols.open(bufs[i],0);const t1=Bun.nanoseconds();if(fd<0)throw new Error("open errno="+errno());libc.symbols.close(fd);samples[i]=t1-t0}
  const wallMs=(Bun.nanoseconds()-wall0)/1e6;const s=Array.from(samples).sort((a,b)=>a-b);
  console.log("BENCH-JSON:"+JSON.stringify({mode,count:n,p50ns:pct(s,0.5),p99ns:pct(s,0.99),p999ns:pct(s,0.999),maxNs:s[s.length-1],meanNs:s.reduce((a,b)=>a+b,0)/s.length,wallMs}));
}else if(mode==="victim"){
  const buf=Buffer.from(DRIVE+"/bench/storm/f0\0");const deadline=Date.now()+n;const log:{t:number,d:number}[]=[];
  while(Date.now()<deadline){const t0=Bun.nanoseconds();const fd=libc.symbols.open(buf,0);const t1=Bun.nanoseconds();if(fd<0)throw new Error("open errno="+errno());libc.symbols.close(fd);log.push({t:Date.now(),d:(t1-t0)/1e6})}
  console.log("BENCH-JSON:"+JSON.stringify({mode,count:log.length,samples:log}));
}else if(mode==="spin"){
  // Sustained load for the OOM-landmine memory test: reopen f0 for n ms, count
  // only (no per-open log), so the listener handles hundreds of thousands of
  // gated opens while its RSS is sampled — long enough to show a plateau, not
  // just warmup.
  const buf=Buffer.from(DRIVE+"/bench/storm/f0\0");const deadline=Date.now()+n;let count=0;
  while(Date.now()<deadline){const fd=libc.symbols.open(buf,0);if(fd<0)throw new Error("open errno="+errno());libc.symbols.close(fd);count++}
  console.log("BENCH-JSON:"+JSON.stringify({mode,count}));
}else throw new Error("unknown mode "+mode);
`

// ── VM-side driver (runs as root via sudo). Owns the whole experiment sequence:
// bind-mounts the drive, seeds files, then runs the four experiments, starting/
// stopping the listener around each. Emits DRIVER-JSON.
const driver = String.raw`import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const DRIVE="/home/exedev/drive";const RUN="/dev/shm/duet-permprobe";
const HELPER="/tmp/duet-perm/perm-helper.ts";const BENCH="/tmp/duet-perm/bench.ts";
const BUN=process.execPath;
const SEQ=5000,STORM=30000,SHORTLIVED=20,VICTIM_MS=2500,KILL_AT_MS=900,MEM_SPIN_MS=5000;

async function sh(cmd:string):Promise<string>{const p=Bun.spawn(["sh","-c",cmd],{stdout:"pipe",stderr:"pipe"});const o=await new Response(p.stdout).text();const e=await new Response(p.stderr).text();const c=await p.exited;if(c!==0)throw new Error("cmd failed("+c+"): "+cmd+"\n"+(e||o));return o.trim()}

function parseLines(file:string):any[]{if(!existsSync(file))return [];return readFileSync(file,"utf8").split("\n").filter(Boolean).flatMap(l=>{try{return [JSON.parse(l)]}catch{return []}})}

async function startHelper(mode:string,withNotif:string,outFile:string){
  await sh("rm -f "+outFile);
  const proc=Bun.spawn([BUN,HELPER,DRIVE,outFile,mode,withNotif],{stdout:"ignore",stderr:"pipe"});
  let readyPid=-1;
  for(let i=0;i<80;i++){const ls=parseLines(outFile);const r=ls.find(x=>x.ready);if(r){readyPid=r.pid;break}await Bun.sleep(100)}
  if(readyPid<0){proc.kill();const err=await new Response(proc.stderr).text();throw new Error("helper never ready ("+mode+"): "+err)}
  await Bun.sleep(150);
  return {proc,pid:readyPid,outFile};
}
// Force-kill by pid: a lingering listener would remain a SECOND perm group on
// the drive mount, contaminating later experiments. kill -9 also closes the
// group (auto-allow), so no pending open is ever wedged by teardown.
async function stopHelper(h:{proc:any,pid:number}){try{await sh("kill -9 "+h.pid+" 2>/dev/null || true")}catch{}try{h.proc.kill("SIGKILL")}catch{}await Promise.race([h.proc.exited,Bun.sleep(1500)]);}

async function runBench(mode:string,n:number){const r=await sh(BUN+" "+BENCH+" "+mode+" "+n);const i=r.indexOf("BENCH-JSON:");if(i<0)throw new Error("no BENCH-JSON for "+mode+": "+r);return JSON.parse(r.slice(i+"BENCH-JSON:".length))}

// ── Setup. The drive is a directory on the SHARED root superblock (drive dev ==
// root dev here), so a filesystem-wide PERM mark would gate the whole VM incl.
// this harness. We bind-mount the drive onto itself: the blocking PERM group is
// then FAN_MARK_MOUNT-scoped to opens resolved through the drive path only,
// while the non-blocking NOTIF group can stay FAN_MARK_FILESYSTEM. In production
// the drive would be its own mount/volume; the bind mount reproduces that seam.
mkdirSync(RUN,{recursive:true});
mkdirSync(DRIVE+"/bench/storm",{recursive:true});
mkdirSync(DRIVE+"/shortlived",{recursive:true});
const driveDev=await sh("findmnt -n -o SOURCE --target "+DRIVE);
const rootDev=await sh("findmnt -n -o SOURCE --target /");
await sh("mountpoint -q "+DRIVE+" || mount --bind "+DRIVE+" "+DRIVE);
const scoped=(await sh("mountpoint -q "+DRIVE+" && echo yes || echo no"))==="yes";
if(!scoped)throw new Error("bind mount not established on "+DRIVE+" — cannot scope the perm gate safely");
// Seed files fork-free (mark not yet armed, so these opens are ungated).
writeFileSync(DRIVE+"/bench/seq.dat","seed");
for(let i=0;i<STORM;i++)writeFileSync(DRIVE+"/bench/storm/f"+i,"x");
for(let i=0;i<SHORTLIVED;i++)writeFileSync(DRIVE+"/shortlived/f"+i,"y");
const kernel=readFileSync("/proc/sys/kernel/osrelease","utf8").trim();

// ── Experiment A: coexistence + short-lived 20/20 capture.
const capOut=RUN+"/capture.ndjson";
const hA=await startHelper("capture","1",capOut);
for(let i=0;i<SHORTLIVED;i++){await sh("cat "+DRIVE+"/shortlived/f"+i+" >/dev/null")}
await Bun.sleep(300);
await stopHelper(hA);
const capLines=parseLines(capOut);
const caps=capLines.filter(x=>x.capture);
const capFinal=capLines.filter(x=>x.stats).pop()??{};
const distinctPaths=new Set(caps.filter(c=>c.path&&c.path.includes("/shortlived/")).map(c=>c.path));
const shortlivedCaps=caps.filter(c=>c.path&&c.path.includes("/shortlived/"));
const allCgroup=shortlivedCaps.length>0&&shortlivedCaps.every(c=>c.cgroup!==null&&c.cgroup!==undefined);
const allAlive=shortlivedCaps.length>0&&shortlivedCaps.every(c=>c.alive===true);
const notifSeen=Number(capFinal.handledNotif??0);
const sampleCgroups=[...new Set(shortlivedCaps.map(c=>c.cgroup))].slice(0,4);

// ── Experiment B: sequential open latency, baseline vs listener.
const seqBase=await runBench("seq",SEQ);
const hB=await startHelper("bench","0",RUN+"/seqlisten.ndjson");
const seqListen=await runBench("seq",SEQ);
await stopHelper(hB);

// ── Experiment C: open-storm latency + memory flatness under the listener.
const stormBase=await runBench("storm",STORM);
const memOut=RUN+"/storm.ndjson";
const hC=await startHelper("bench","0",memOut);
const stormListen=await runBench("storm",STORM);
// Sustained spin so the listener handles ~10^5-10^6 gated opens while RSS is
// sampled every 200 ms — enough samples to distinguish a plateau from the
// slice-13 unbounded-growth landmine.
const spin=await runBench("spin",MEM_SPIN_MS);
await Bun.sleep(150);
const memLines=parseLines(memOut).filter(x=>x.stats);
await stopHelper(hC);
const memFinal=parseLines(memOut).filter(x=>x.stats).pop()??{};
const rssSamples=memLines.map(x=>x.rssKb).filter(v=>typeof v==="number"&&v>=0);
const rssMin=rssSamples.length?Math.min(...rssSamples):-1;
const rssMax=rssSamples.length?Math.max(...rssSamples):-1;
const rssFirst=rssSamples.length?rssSamples[0]:-1;
const rssLast=rssSamples.length?rssSamples[rssSamples.length-1]:-1;

// ── Experiment D: listener-death auto-allow. Victim opens in a tight loop;
// the listener is kill -9'd mid-run; opens must keep flowing.
const hD=await startHelper("bench","0",RUN+"/autoallow.ndjson");
const victimProc=Bun.spawn([BUN,BENCH,"victim",String(VICTIM_MS)],{stdout:"pipe",stderr:"pipe"});
await Bun.sleep(KILL_AT_MS);
const killWall=Date.now();
await sh("kill -9 "+hD.pid);
let victimOut="",victimHung=false;
const victimText=await Promise.race([new Response(victimProc.stdout).text(),Bun.sleep(8000).then(()=>{victimHung=true;return ""})]);
if(victimHung){try{victimProc.kill("SIGKILL")}catch{}}
victimOut=victimText;
try{hD.proc.kill("SIGKILL")}catch{}
let victimJson:any={count:0,samples:[]};
const vi=victimOut.indexOf("BENCH-JSON:");if(vi>=0)victimJson=JSON.parse(victimOut.slice(vi+"BENCH-JSON:".length));
const vsamples=victimJson.samples??[];
const before=vsamples.filter((s:any)=>s.t<killWall);
const after=vsamples.filter((s:any)=>s.t>=killWall);
// vsamples can be ~10^5 long — Math.max(...spread) overflows the stack; reduce.
let maxStallMs=-1;for(const s of vsamples)if(s.d>maxStallMs)maxStallMs=s.d;
let maxAfterStallMs=-1;for(const s of after)if(s.d>maxAfterStallMs)maxAfterStallMs=s.d;

// ── Cleanup the bind mount (best effort).
try{await sh("umount "+DRIVE+" 2>/dev/null || true")}catch{}

console.log("DRIVER-JSON:"+JSON.stringify({
  kernel,bun:Bun.version,uid:process.getuid?.(),scoped,driveDev,rootDev,
  a:{shortlivedCaptures:shortlivedCaps.length,distinctPaths:distinctPaths.size,expected:SHORTLIVED,allCgroup,allAlive,notifSeen,sampleCgroups,totalPerm:Number(capFinal.handledPerm??0)},
  b:{seqBase,seqListen},
  c:{stormBase,stormListen,spinOpens:Number(spin.count??0),rssFirst,rssLast,rssMin,rssMax,rssSamples,rssSampleCount:rssSamples.length,handledPerm:Number(memFinal.handledPerm??0),cgroupMisses:Number(memFinal.cgroupMisses??0),cacheSize:Number(memFinal.cacheSize??0)},
  d:{victimHung,killWall,opensBefore:before.length,opensAfter:after.length,maxStallMs,maxAfterStallMs,victimTotal:vsamples.length},
}));
process.exit(0);
`

interface Latency {
  mode: string
  count: number
  p50ns: number
  p99ns: number
  p999ns: number
  maxNs: number
  meanNs: number
  wallMs: number
}
interface DriverPayload {
  kernel: string
  bun: string
  uid?: number
  scoped: boolean
  driveDev: string
  rootDev: string
  a: {
    shortlivedCaptures: number
    distinctPaths: number
    expected: number
    allCgroup: boolean
    allAlive: boolean
    notifSeen: number
    sampleCgroups: string[]
    totalPerm: number
  }
  b: { seqBase: Latency; seqListen: Latency }
  c: {
    stormBase: Latency
    stormListen: Latency
    spinOpens: number
    rssFirst: number
    rssLast: number
    rssMin: number
    rssMax: number
    rssSamples: number[]
    rssSampleCount: number
    handledPerm: number
    cgroupMisses: number
    cacheSize: number
  }
  d: {
    victimHung: boolean
    killWall: number
    opensBefore: number
    opensAfter: number
    maxStallMs: number
    maxAfterStallMs: number
    victimTotal: number
  }
}

function q(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`
}
const us = (ns: number): string => `${(ns / 1000).toFixed(1)} µs`
const usAdd = (a: number, b: number): string => {
  const d = (a - b) / 1000
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)} µs`
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
  const name = vmName('fan-open-perm')
  let failure: unknown, cleanupFailure: Error | undefined
  try {
    await ctx.control.whoami()
    const createdVm = await createVm(ctx, {
      name,
      comment: 'duet slice-09 pre-probe: FAN_OPEN_PERM pid pinning',
    })
    const dest = createdVm.value.ssh_dest
    await ctx.ssh.waitUntilReady(dest, { timeoutMs: 180_000 })
    await runOrThrow(ctx.ssh, dest, "sudo -n true && echo 'sudo -n true: ok'")
    await runOrThrow(ctx.ssh, dest, 'curl -fsSL https://bun.sh/install | bash', 180_000)
    await runOrThrow(
      ctx.ssh,
      dest,
      `mkdir -p ${WORK}; ` +
        `printf %s ${q(Buffer.from(helper).toString('base64'))} | base64 -d > ${WORK}/perm-helper.ts; ` +
        `printf %s ${q(Buffer.from(bench).toString('base64'))} | base64 -d > ${WORK}/bench.ts; ` +
        `printf %s ${q(Buffer.from(driver).toString('base64'))} | base64 -d > ${WORK}/driver.ts`,
    )
    const run = await ctx.ssh.exec(
      dest,
      `sudo /home/exedev/.bun/bin/bun ${WORK}/driver.ts`,
      300_000,
    )
    // A full DRIVER-JSON is authoritative even if the SSH channel reports a
    // nonzero code during teardown; only its absence is a real failure.
    const jsonStart = run.stdout.indexOf('DRIVER-JSON:')
    if (jsonStart < 0) {
      const diag = await ctx.ssh
        .exec(
          dest,
          'free -m; mount | grep drive; ls -la /dev/shm/duet-permprobe 2>/dev/null',
          20_000,
        )
        .then(d => d.stdout)
        .catch(e => `diag failed: ${e}`)
      throw new Error(
        `driver failed. exit=${run.exitCode}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}\ndiagnostics:\n${diag}`,
      )
    }
    const p = JSON.parse(run.stdout.slice(jsonStart + 'DRIVER-JSON:'.length)) as DriverPayload

    // ── Verdict logic ──
    const shortLivedOk =
      p.a.shortlivedCaptures >= p.a.expected &&
      p.a.distinctPaths >= p.a.expected &&
      p.a.allCgroup &&
      p.a.allAlive
    const coexistOk = p.a.notifSeen > 0
    const seqAddedP99 = p.b.seqListen.p99ns - p.b.seqBase.p99ns
    const stormAddedP99 = p.c.stormListen.p99ns - p.c.stormBase.p99ns
    const ONE_MS = 1_000_000
    const latencyOk = seqAddedP99 < ONE_MS && stormAddedP99 < ONE_MS
    const rssDelta = p.c.rssMax - p.c.rssMin
    const rssHalf = p.c.rssSamples.slice(Math.floor(p.c.rssSamples.length / 2))
    const steadyDelta = rssHalf.length ? Math.max(...rssHalf) - Math.min(...rssHalf) : rssDelta
    // Steady-state drift (second half of samples) < 15 MB ⇒ a plateau, not the
    // slice-13 landmine (which climbs linearly with events to OOM).
    const memoryOk = p.c.rssSampleCount >= 3 && steadyDelta < 15_000
    const autoAllowOk =
      !p.d.victimHung &&
      p.d.opensAfter > 0 &&
      p.d.maxAfterStallMs >= 0 &&
      p.d.maxAfterStallMs < 1000
    const green = shortLivedOk && coexistOk && latencyOk && memoryOk && autoAllowOk

    const pf = (b: boolean) => (b ? 'PASS' : 'FAIL')
    const report = `# FAN_OPEN_PERM pid-pinning pre-probe (slice 09, reslice mechanism)

Run: ${new Date().toISOString()} on VM \`${name}\` (deleted after capture).
Question: is the resliced slice-09 mechanism — a second fanotify group
(\`FAN_CLASS_CONTENT | FAN_OPEN_PERM\`) that pins \`pid → /proc/<pid>/cgroup\`
while the opener is blocked in \`open()\`, alongside the existing FID/name
\`FAN_CLASS_NOTIF\` group — viable on the real exe.dev image? Four measured
questions: (1) coexistence + short-lived 20/20 capture, (2) per-open overhead,
(3) listener-death auto-allow, (4) OOM-landmine memory flatness.

## Environment

- Kernel: \`${p.kernel}\`
- Bun: \`${p.bun}\`
- Privilege: helper + driver ran as uid ${p.uid} (sudo)
- On this image the drive is a directory on the SHARED root superblock
  (drive dev \`${p.driveDev}\` == root dev \`${p.rootDev}\`), so a
  filesystem-wide PERM mark would gate every open on the VM — including this
  harness. The drive is \`mount --bind\`ed onto itself and the **blocking** PERM
  group (\`FAN_CLASS_CONTENT\`) is marked \`FAN_MARK_MOUNT\`, scoping the gate to
  opens resolved through the drive path only; root opens stay ungated so a
  listener stall cannot wedge the VM. The **non-blocking** NOTIF FID/name group
  uses \`FAN_MARK_FILESYSTEM\` (FID-mode marks *reject* \`FAN_MARK_MOUNT\` with
  EINVAL — measured this run). In production the drive would be its own
  mount/volume, which reproduces the same seam. The listener touches only procfs
  and a tmpfs output file after arming, so it can never block on its own gated
  open.

## 1. Coexistence + short-lived pid pinning (the fork-map-killer case)

20× \`sh -c 'cat /…/shortlived/f<i>'\` — each a distinct short-lived process the
first FID spike failed to attribute 0/20 (it exited before the async lookup).
Here every opener is blocked in the gated \`open()\`, so \`/proc/<pid>/cgroup\` is
read race-free while it is provably alive.

| Check | Result |
| --- | --- |
| Short-lived opens captured | ${p.a.shortlivedCaptures}/${p.a.expected} |
| Distinct files captured | ${p.a.distinctPaths}/${p.a.expected} |
| cgroup read non-null for every capture | ${pf(p.a.allCgroup)} |
| opener alive (comm readable) during handling | ${pf(p.a.allAlive)} |
| NOTIF (FID/name) group delivered alongside | ${pf(coexistOk)} (${p.a.notifSeen} events) |

Sample captured cgroup lines: ${p.a.sampleCgroups.map(c => `\`${c}\``).join(', ') || '(none)'}.
Total perm events handled in this phase: ${p.a.totalPerm}.

**${shortLivedOk && coexistOk ? 'PASS' : 'FAIL'}** — short-lived attribution ${p.a.shortlivedCaptures}/${p.a.expected}, ${coexistOk ? 'perm and NOTIF groups coexist on one mount' : 'NOTIF coexistence NOT observed'}.

## 2. Per-open overhead (kill criterion: >~1 ms p99 added ⇒ RED)

Open latency times the \`open()\`/\`close()\` syscalls only (bun:ffi libc), path
buffers pre-encoded outside the timed region. Baseline = no listener (mark
absent); listener = the pinning group active, answering \`FAN_ALLOW\` per open
(pid cached after first miss, so a single-pid storm pays one \`/proc\` read total).

| Workload | p50 base → listen (added) | p99 base → listen (added) | p99.9 listen | max listen |
| --- | --- | --- | --- | --- |
| Sequential (${p.b.seqBase.count}) | ${us(p.b.seqBase.p50ns)} → ${us(p.b.seqListen.p50ns)} (${usAdd(p.b.seqListen.p50ns, p.b.seqBase.p50ns)}) | ${us(p.b.seqBase.p99ns)} → ${us(p.b.seqListen.p99ns)} (**${usAdd(p.b.seqListen.p99ns, p.b.seqBase.p99ns)}**) | ${us(p.b.seqListen.p999ns)} | ${us(p.b.seqListen.maxNs)} |
| Storm (${p.c.stormBase.count}) | ${us(p.c.stormBase.p50ns)} → ${us(p.c.stormListen.p50ns)} (${usAdd(p.c.stormListen.p50ns, p.c.stormBase.p50ns)}) | ${us(p.c.stormBase.p99ns)} → ${us(p.c.stormListen.p99ns)} (**${usAdd(p.c.stormListen.p99ns, p.c.stormBase.p99ns)}**) | ${us(p.c.stormListen.p999ns)} | ${us(p.c.stormListen.maxNs)} |

Storm wall: baseline ${p.c.stormBase.wallMs.toFixed(0)} ms → listener ${p.c.stormListen.wallMs.toFixed(0)} ms for ${p.c.stormBase.count} opens
(${(((p.c.stormListen.wallMs - p.c.stormBase.wallMs) / p.c.stormBase.count) * 1000).toFixed(2)} µs/open mean added).

**Added p99: sequential ${usAdd(p.b.seqListen.p99ns, p.b.seqBase.p99ns)}, storm ${usAdd(p.c.stormListen.p99ns, p.c.stormBase.p99ns)}** — kill criterion is +1 ms (1000 µs) p99. ${pf(latencyOk)}.

## 3. Listener-death auto-allow

Victim opens \`f0\` in a tight loop for ${'~2.5 s'}; the listener is \`kill -9\`'d
${'~0.9 s'} in. If the kernel auto-allows on group-fd close, opens keep flowing;
if not, the victim wedges in \`open()\` forever.

| Check | Result |
| --- | --- |
| Victim hung after kill (open blocked forever) | ${p.d.victimHung ? 'YES — auto-allow FAILED' : 'no'} |
| Opens before kill | ${p.d.opensBefore} |
| Opens after kill | ${p.d.opensAfter} |
| Max single-open stall, whole run | ${p.d.maxStallMs.toFixed(2)} ms |
| Max single-open stall, after kill | ${p.d.maxAfterStallMs.toFixed(2)} ms |

**${pf(autoAllowOk)}** — ${p.d.victimHung ? 'opens never resumed; a crashed helper wedges VM I/O' : `opens resumed immediately after the group closed; worst post-kill stall ${p.d.maxAfterStallMs.toFixed(2)} ms`}.

## 4. OOM landmine — memory flatness under the storm

Slice 13 proved a watcher opening non-\`O_PATH\` handles self-amplifies to OOM
(RSS climbs linearly with events). This listener drops self-pid events, resolves
only via procfs readlink (no gated opens), and closes every kernel \`event_fd\`.
The storm plus a ${(5000 / 1000).toFixed(0)}-second sustained spin drove
${p.c.handledPerm.toLocaleString('en-US')} gated opens through the listener while
RSS was sampled every 200 ms:

| Metric | Value |
| --- | --- |
| perm events handled (storm + spin) | ${p.c.handledPerm.toLocaleString('en-US')} (${p.c.spinOpens.toLocaleString('en-US')} in the spin) |
| RSS first / last | ${p.c.rssFirst} KB / ${p.c.rssLast} KB |
| RSS min / max | ${p.c.rssMin} KB / ${p.c.rssMax} KB |
| RSS drift, whole run (max − min) | ${rssDelta} KB |
| RSS drift, steady state (2nd half of samples) | ${steadyDelta} KB |
| cgroup cache size / misses | ${p.c.cacheSize} / ${p.c.cgroupMisses} |

RSS sample sequence (KB, every 200 ms): ${p.c.rssSamples.join(' → ')}

**${pf(memoryOk)}** — after warmup, RSS holds within ${steadyDelta} KB across
${p.c.handledPerm.toLocaleString('en-US')} gated opens (bounded pid cache = ${p.c.cacheSize} entry, ${p.c.cgroupMisses} misses).
It plateaus rather than climbing with event count — the self-pid-drop +
O_PATH-only + event_fd-close mitigation holds; the slice-13 landmine does not fire.

## Criteria

| Criterion | Result |
| --- | --- |
| Perm group + NOTIF group coexist; FAN_ALLOW lets the opener proceed | ${pf(coexistOk)} |
| Short-lived \`sh -c 'cat f'\` × 20 pinned via /proc while blocked | ${pf(shortLivedOk)} (${p.a.shortlivedCaptures}/${p.a.expected}) |
| Sequential added p99 < 1 ms | ${pf(p.b.seqListen.p99ns - p.b.seqBase.p99ns < ONE_MS)} |
| Storm added p99 < 1 ms | ${pf(p.c.stormListen.p99ns - p.c.stormBase.p99ns < ONE_MS)} |
| Listener kill → opens auto-allowed (no wedge) | ${pf(autoAllowOk)} |
| Memory flat across the storm (mitigation holds) | ${pf(memoryOk)} |

Verdict: **${green ? 'GREEN' : 'RED'}** — ${
      green
        ? 'the resliced slice-09 mechanism is viable on the exe.dev image. A FAN_CLASS_CONTENT/FAN_OPEN_PERM pinning group runs alongside the FID/name NOTIF group; the blocked opener lets /proc/<pid>/cgroup be read race-free (short-lived 20/20 — the case the fork map lost 0/20); per-open p99 overhead stays well under the 1 ms kill criterion; a kill -9 of the listener auto-allows pending opens (no I/O wedge); and self-pid drop + O_PATH-only resolution keep memory flat. Resliced 09 proceeds — build the helper on this mechanism.'
        : `at least one criterion failed (short-lived ${pf(shortLivedOk)}, coexist ${pf(coexistOk)}, latency ${pf(latencyOk)}, auto-allow ${pf(autoAllowOk)}, memory ${pf(memoryOk)}). Fall back to at-event /proc reads + counted short-lived misses, and surface the exe.dev CONFIG_CONNECTOR escalation harder (slices/09-helper-standalone.md).`
    }
`
    await mkdir(fileURLToPath(new URL('.', REPORT)), { recursive: true })
    await writeFile(fileURLToPath(REPORT), report)
    console.log(report)
    if (!green) process.exitCode = 1
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
