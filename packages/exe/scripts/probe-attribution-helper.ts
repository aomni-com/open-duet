/**
 * Slice-09 GATE probe: the PRODUCTION privileged helper on a real exe.dev VM.
 *
 * Unlike the pre-probe (probe-fan-open-perm.ts, mechanism only), this runs the
 * actual `packages/gateway/src/attribution/helper-main.ts` — bundled with
 * `bun build --target=bun`, executed as root exactly like production
 * (`sudo bun helper-main.js <driveDir> <gatewayPid>`, stdout a pipe) — and
 * asserts the full slice-09 verification matrix through its NDJSON frames:
 *
 *   - create/delete/rename/atomic-save resolve to real (drive-relative) names;
 *   - 20/20 events from a long-lived cgroup member carry the right unit;
 *   - THE GATE: short-lived `sh -c 'cat/echo'` runs attributed via perm-event
 *     pid pinning — the case the first FID spike failed 0/20;
 *   - grandchildren + two parallel session bursts never cross-attribute;
 *   - 500 renames: exactly 500 rename frames (no FAN_RENAME/legacy double
 *     count), zero overflow;
 *   - self-pid and gateway-pid exclusion;
 *   - suppress/shutdown stdin commands; clean SIGTERM with final stats;
 *   - per-open overhead within the pre-probe budget (<1 ms added p99);
 *   - kill -9 mid-storm leaves VM I/O unwedged (kernel auto-allow);
 *   - RSS flat across an open storm (the slice-13 OOM landmine stays dead).
 *
 * Report: probe-results/reports/helper-probe.md. VM tagged duet-test,
 * deleted in finally; leak-check covers only this run's VM names.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { probeReportUrl } from './probe-artifacts.ts'
import { cleanup, createVm, makeContext, runOrThrow, vmName } from './probe-common.ts'

const WORK = '/tmp/duet-helper-probe'
const HELPER_ENTRY = new URL('../../gateway/src/attribution/helper-main.ts', import.meta.url)
const REPORT = probeReportUrl('helper-probe.md')

// ── VM-side open-latency bench (same shape as the pre-probe's): times ONLY the
// open()/close() syscalls via bun:ffi, path buffers pre-encoded outside the
// timed region. argv: [mode, n]. seq/storm → BENCH-JSON percentiles; victim →
// per-open {t,d} log (driver kills the helper mid-run to measure auto-allow);
// spin → sustained open load for the RSS flatness sample.
const bench = String.raw`import { dlopen, FFIType, ptr, read as ffiRead } from "bun:ffi";
const DRIVE="/home/exedev/drive";
const libc=dlopen("libc.so.6",{open:{args:[FFIType.cstring,FFIType.i32],returns:FFIType.i32},close:{args:[FFIType.i32],returns:FFIType.i32},__errno_location:{args:[],returns:FFIType.ptr}});
const errno=()=>ffiRead.i32(libc.symbols.__errno_location(),0);
const [mode,nArg]=process.argv.slice(2);const n=Number(nArg);
function pct(sorted:number[],p:number){if(sorted.length===0)return 0;const i=Math.min(sorted.length-1,Math.floor(p*(sorted.length-1)));return sorted[i]}
function timed(bufs:Buffer[]|Buffer,count:number){
  const samples=new Float64Array(count);const wall0=Bun.nanoseconds();
  for(let i=0;i<count;i++){const b=Array.isArray(bufs)?bufs[i]:bufs;const t0=Bun.nanoseconds();const fd=libc.symbols.open(b,0);const t1=Bun.nanoseconds();if(fd<0)throw new Error("open errno="+errno());libc.symbols.close(fd);samples[i]=t1-t0}
  const wallMs=(Bun.nanoseconds()-wall0)/1e6;const s=Array.from(samples).sort((a,b)=>a-b);
  console.log("BENCH-JSON:"+JSON.stringify({mode,count,p50ns:pct(s,0.5),p99ns:pct(s,0.99),p999ns:pct(s,0.999),maxNs:s[s.length-1],wallMs}));
}
if(mode==="seq")timed(Buffer.from(DRIVE+"/bench/seq.dat\0"),n);
else if(mode==="storm"){const bufs:Buffer[]=[];for(let i=0;i<n;i++)bufs.push(Buffer.from(DRIVE+"/bench/storm/f"+i+"\0"));timed(bufs,n)}
else if(mode==="victim"){
  const buf=Buffer.from(DRIVE+"/bench/storm/f0\0");const deadline=Date.now()+n;const log:{t:number,d:number}[]=[];
  while(Date.now()<deadline){const t0=Bun.nanoseconds();const fd=libc.symbols.open(buf,0);const t1=Bun.nanoseconds();if(fd<0)throw new Error("open errno="+errno());libc.symbols.close(fd);log.push({t:Date.now(),d:(t1-t0)/1e6})}
  console.log("BENCH-JSON:"+JSON.stringify({mode,count:log.length,samples:log}));
}else if(mode==="spin"){
  const buf=Buffer.from(DRIVE+"/bench/storm/f0\0");const deadline=Date.now()+n;let count=0;
  while(Date.now()<deadline){const fd=libc.symbols.open(buf,0);if(fd<0)throw new Error("open errno="+errno());libc.symbols.close(fd);count++}
  console.log("BENCH-JSON:"+JSON.stringify({mode,count}));
}else throw new Error("unknown mode "+mode);
`

// ── VM-side driver (runs as root). Spawns the PRODUCTION helper bundle with
// stdin/stdout pipes (production shape: stdout is a pipe, L12), builds session
// cgroup leaves, drives the matrix through cgroup-member bash processes, and
// emits one DRIVER-JSON blob. All helper output is consumed live by an async
// pump so the helper can never block on a full pipe while we measure it.
const driver = String.raw`import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const DRIVE="/home/exedev/drive";const RUN="/dev/shm/duet-helper-probe";
const WORK="/tmp/duet-helper-probe";const BUN=process.execPath;
const HELPER=WORK+"/helper-main.js";const BENCH=WORK+"/bench.ts";
const RUNNERS="/sys/fs/cgroup/runners";
const LEAF_A="session-alpha1",LEAF_B="session-beta2";
const N_SHORT=20,N_LONG=20,N_PAR=20,N_RENAMES=500,STORM=10000,SEQ=5000;
const SPIN_MS=5000,VICTIM_MS=2500,KILL_AT_MS=900;

type Frame={t:string,kind?:string,path?:string,fromPath?:string,pid?:number,unit?:string|null,at?:number,overflow?:number,cgroupMisses?:number};
const frames:Frame[]=[];let rawLines=0,badLines=0;
function pump(stream:ReadableStream<Uint8Array>){return (async()=>{const dec=new TextDecoder();let buf="";for await(const chunk of stream){buf+=dec.decode(chunk,{stream:true});let i;while((i=buf.indexOf("\n"))>=0){const line=buf.slice(0,i);buf=buf.slice(i+1);if(!line)continue;rawLines++;try{const f=JSON.parse(line);if(typeof f==="object"&&f!==null&&typeof f.t==="string")frames.push(f);else badLines++}catch{badLines++}}}})()}
async function waitFor(pred:(f:Frame)=>boolean,ms:number):Promise<Frame|null>{const end=Date.now()+ms;for(;;){const f=frames.find(pred);if(f)return f;if(Date.now()>end)return null;await Bun.sleep(25)}}
async function waitCount(pred:(f:Frame)=>boolean,want:number,ms:number):Promise<number>{const end=Date.now()+ms;for(;;){const got=frames.filter(pred).length;if(got>=want)return got;if(Date.now()>end)return got;await Bun.sleep(50)}}
const fs=(f:Frame)=>f.t==="fs";
const at=(p:string)=>(f:Frame)=>fs(f)&&f.path===p;
const kindAt=(k:string,p:string)=>(f:Frame)=>fs(f)&&f.kind===k&&f.path===p;

// Session-cgroup member: a long-lived bash whose stdin we feed. Children and
// grandchildren inherit its cgroup — exactly how runner sessions work.
let syncSeq=0;
function makeMember(leaf:string|null){const p=Bun.spawn(["bash"],{stdin:"pipe",stdout:"ignore",stderr:"ignore"});if(leaf!==null)writeFileSync(RUNNERS+"/"+leaf+"/cgroup.procs",String(p.pid));return p}
async function run(member:ReturnType<typeof makeMember>,cmd:string,timeoutMs=20000){const marker=RUN+"/done-"+(syncSeq++);member.stdin.write(cmd+"\n"+"echo ok > "+marker+"\n");member.stdin.flush();const end=Date.now()+timeoutMs;while(!existsSync(marker)){if(Date.now()>end)throw new Error("member cmd timeout: "+cmd);await Bun.sleep(20)}}
async function runBench(mode:string,n:number){const p=Bun.spawn([BUN,BENCH,mode,String(n)],{stdout:"pipe",stderr:"pipe"});const out=await new Response(p.stdout).text();const err=await new Response(p.stderr).text();if(await p.exited!==0)throw new Error("bench "+mode+" failed: "+err);const i=out.indexOf("BENCH-JSON:");if(i<0)throw new Error("no BENCH-JSON: "+out);return JSON.parse(out.slice(i+"BENCH-JSON:".length))}
function rssKb(pid:number):number{try{const parts=readFileSync("/proc/"+pid+"/statm","utf8").trim().split(/\s+/);return Math.round((Number(parts[1])*4096)/1024)}catch{return -1}}

// ── Setup: dirs, bench seeds, cgroup leaves — all BEFORE the helper starts.
mkdirSync(RUN,{recursive:true});
for(const d of ["m","s","p","l","r","bench/storm"])mkdirSync(DRIVE+"/"+d,{recursive:true});
writeFileSync(DRIVE+"/bench/seq.dat","seed");
for(let i=0;i<STORM;i++)writeFileSync(DRIVE+"/bench/storm/f"+i,"x");
mkdirSync(RUNNERS+"/"+LEAF_A,{recursive:true});
mkdirSync(RUNNERS+"/"+LEAF_B,{recursive:true});
const kernel=readFileSync("/proc/sys/kernel/osrelease","utf8").trim();

// Baseline open latency with NO helper (no marks exist yet).
const seqBase=await runBench("seq",SEQ);
const stormBase=await runBench("storm",STORM);

// Fake gateway: a live process whose pid the helper must exclude (L9).
const gw=makeMember(null);
// memberA exists BEFORE the helper starts — covered by the startup cgroup
// scan seed as well as by perm pinning.
const memberA=makeMember(LEAF_A);
const memberB=makeMember(LEAF_B);

function spawnHelper(){const p=Bun.spawn([BUN,HELPER,DRIVE,String(gw.pid)],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});pump(p.stdout);return p}
const helper=spawnHelper();
const helperErr=new Response(helper.stderr).text();
const ready=await waitFor(f=>f.t==="ready",10000);
if(!ready)throw new Error("helper never ready: "+await helperErr);
const helperPid=ready.pid as number;
await Bun.sleep(200);

// ── Phase 1: create/delete/rename/atomic-save → real filenames.
await run(memberA,"printf hello > "+DRIVE+"/m/created.txt");
await run(memberA,"rm "+DRIVE+"/m/created.txt");
await run(memberA,"printf r > "+DRIVE+"/m/old.txt && mv "+DRIVE+"/m/old.txt "+DRIVE+"/m/new.txt");
await run(memberA,"cd "+DRIVE+"/m && printf body > .tmp-save && mv .tmp-save report.md");
await run(memberA,'cd '+DRIVE+'/m && python3 -c "import os; open(\'editor.tmp\',\'w\').write(\'editor\'); os.replace(\'editor.tmp\',\'editor.md\')"');
await run(memberA,"cat "+DRIVE+"/m/new.txt > /dev/null");
await waitFor(kindAt("read","m/new.txt"),8000);
await Bun.sleep(700);
const phase1={
  create:frames.find(kindAt("create","m/created.txt"))??null,
  del:frames.find(kindAt("delete","m/created.txt"))??null,
  rename:frames.find(kindAt("rename","m/new.txt"))??null,
  renameCount:frames.filter(kindAt("rename","m/new.txt")).length,
  shellRename:frames.find(kindAt("rename","m/report.md"))??null,
  shellJoinedWrite:frames.find(kindAt("write","m/report.md"))??null,
  pyJoinedWrite:frames.find(kindAt("write","m/editor.md"))??null,
  read:frames.find(kindAt("read","m/new.txt"))??null,
};

// ── Phase 2: 20 long-lived cgroup-member writes (redirections opened by
// memberA itself — a long-lived pinned+seeded pid).
await run(memberA,"for i in $(seq 0 "+(N_LONG-1)+"); do printf x > "+DRIVE+"/l/f$i; done");
await waitCount(f=>fs(f)&&f.kind==="write"&&(f.path??"").startsWith("l/f"),N_LONG,8000);
await Bun.sleep(400);
const longAttributed=new Set(frames.filter(f=>fs(f)&&f.kind==="write"&&(f.path??"").startsWith("l/f")&&f.unit===LEAF_A).map(f=>f.path)).size;

// ── Phase 3: THE GATE — short-lived sh -c cat/echo children.
await run(memberA,"for i in $(seq 0 "+(N_SHORT-1)+"); do printf y > "+DRIVE+"/s/g$i; done");
await Bun.sleep(400);
await run(memberA,"for i in $(seq 0 "+(N_SHORT-1)+'); do sh -c "cat '+DRIVE+'/s/g$i > /dev/null"; done');
await run(memberA,"for i in $(seq 0 "+(N_SHORT-1)+'); do sh -c "echo x > '+DRIVE+'/s/e$i"; done');
await waitCount(f=>fs(f)&&f.kind==="read"&&(f.path??"").startsWith("s/g"),N_SHORT,10000);
await waitCount(f=>fs(f)&&f.kind==="write"&&(f.path??"").startsWith("s/e"),N_SHORT,10000);
await Bun.sleep(600);
const shortCat=new Set(frames.filter(f=>fs(f)&&f.kind==="read"&&(f.path??"").startsWith("s/g")&&f.unit===LEAF_A).map(f=>f.path)).size;
const shortEcho=new Set(frames.filter(f=>fs(f)&&f.kind==="write"&&(f.path??"").startsWith("s/e")&&f.unit===LEAF_A).map(f=>f.path)).size;
const shortNull=frames.filter(f=>fs(f)&&((f.path??"").startsWith("s/g")||(f.path??"").startsWith("s/e"))&&f.unit===null).length;

// ── Phase 4: grandchildren inherit the cgroup for free.
await run(memberA,"sh -c 'sh -c \"cat "+DRIVE+"/s/g0 > /dev/null; echo z > "+DRIVE+"/s/gc.txt\"'");
await waitFor(kindAt("write","s/gc.txt"),8000);
await Bun.sleep(300);
const grandWrite=frames.find(kindAt("write","s/gc.txt"))??null;

// ── Phase 5: parallel bursts from two sessions — never cross-attribute.
const parA=run(memberA,"for i in $(seq 0 "+(N_PAR-1)+'); do sh -c "echo p > '+DRIVE+'/p/a$i" & done; wait');
const parB=run(memberB,"for i in $(seq 0 "+(N_PAR-1)+'); do sh -c "echo p > '+DRIVE+'/p/b$i" & done; wait');
await Promise.all([parA,parB]);
await waitCount(f=>fs(f)&&f.kind==="write"&&(f.path??"").startsWith("p/"),N_PAR*2,12000);
await Bun.sleep(700);
const parFrames=frames.filter(f=>fs(f)&&(f.path??"").startsWith("p/")&&(f.kind==="write"||f.kind==="create"));
const parACorrect=new Set(parFrames.filter(f=>(f.path??"").startsWith("p/a")&&f.unit===LEAF_A).map(f=>f.path)).size;
const parBCorrect=new Set(parFrames.filter(f=>(f.path??"").startsWith("p/b")&&f.unit===LEAF_B).map(f=>f.path)).size;
const parCross=parFrames.filter(f=>((f.path??"").startsWith("p/a")&&f.unit===LEAF_B)||((f.path??"").startsWith("p/b")&&f.unit===LEAF_A)).length;

// ── Phase 6: 500 renames — exactly 500 rename frames, zero overflow. Each mv
// is a short-lived pid doing rename(2) with NO open, so its unit rides the
// racy live /proc fallback — REPORTED (a slice-10/11 input), not gated.
await run(memberA,"cd "+DRIVE+"/r && printf x > load-a && for i in $(seq 1 "+N_RENAMES+"); do if test -e load-a; then mv load-a load-b; else mv load-b load-a; fi; done",60000);
const renameFrames=await waitCount(f=>fs(f)&&f.kind==="rename"&&(f.path??"").startsWith("r/load-"),N_RENAMES,30000);
await Bun.sleep(800);
const renameTotal=frames.filter(f=>fs(f)&&f.kind==="rename"&&(f.path??"").startsWith("r/load-")).length;
const renameAttributed=frames.filter(f=>fs(f)&&f.kind==="rename"&&(f.path??"").startsWith("r/load-")&&f.unit===LEAF_A).length;
const renameWrong=frames.filter(f=>fs(f)&&f.kind==="rename"&&(f.path??"").startsWith("r/load-")&&f.unit!==null&&f.unit!==LEAF_A).length;
const mvUnits={attributed:renameAttributed,unitNull:renameTotal-renameAttributed-renameWrong,wrong:renameWrong};
// Same measure for the single phase-1 mv.
const p1RenameUnit=phase1.rename?.unit??null;

// ── Phase 7: gateway-pid exclusion (self-pid exclusion asserted at the end).
gw.stdin.write("echo x > "+DRIVE+"/m/gw-excluded.txt\n");gw.stdin.flush();
await Bun.sleep(1500);
const gwFrames=frames.filter(at("m/gw-excluded.txt")).length;

// ── Phase 8: suppress command.
helper.stdin.write(JSON.stringify({t:"suppress",on:true})+"\n");helper.stdin.flush();
await Bun.sleep(300);
await run(memberA,"echo s > "+DRIVE+"/m/sup1.txt");
await Bun.sleep(900);
const suppressedFrames=frames.filter(at("m/sup1.txt")).length;
helper.stdin.write(JSON.stringify({t:"suppress",on:false})+"\n");helper.stdin.flush();
await Bun.sleep(300);
await run(memberA,"echo s > "+DRIVE+"/m/sup2.txt");
const resumed=await waitFor(at("m/sup2.txt"),8000);

// ── Phase 9: per-open overhead with the production helper live.
const seqListen=await runBench("seq",SEQ);
const stormListen=await runBench("storm",STORM);

// ── Phase 10: RSS flatness under a sustained open storm (OOM landmine).
// Suppress fs frames so the pipe is not the bottleneck; perm handling, NOTIF
// decode, and O_PATH resolution — the landmine surface — all still run.
helper.stdin.write(JSON.stringify({t:"suppress",on:true})+"\n");helper.stdin.flush();
const rssSamples:number[]=[];
const sampler=(async()=>{for(;;){const kb=rssKb(helperPid);if(kb>=0)rssSamples.push(kb);await Bun.sleep(200);if(rssSamples.length>60)break}})();
const spin=await runBench("spin",SPIN_MS);
await Bun.sleep(400);
const spinSampleCount=rssSamples.length;
helper.stdin.write(JSON.stringify({t:"suppress",on:false})+"\n");helper.stdin.flush();

// ── Phase 11: clean SIGTERM — final stats frame, exit 0.
const statsBefore=frames.filter(f=>f.t==="stats").length;
helper.kill("SIGTERM");
const exitCode=await Promise.race([helper.exited,Bun.sleep(5000).then(()=>-1)]);
await Bun.sleep(200);
const statsFrames=frames.filter(f=>f.t==="stats");
const finalStats=statsFrames[statsFrames.length-1]??null;
const gotFinalStats=statsFrames.length>statsBefore;
const selfFrames=frames.filter(f=>fs(f)&&f.pid===helperPid).length;

// ── Phase 12: kill -9 mid-storm auto-allows (fresh helper instance).
const helper2=spawnHelper();
const ready2=await waitFor(f=>f.t==="ready"&&f.pid!==helperPid,10000);
if(!ready2)throw new Error("helper2 never ready");
const victim=Bun.spawn([BUN,BENCH,"victim",String(VICTIM_MS)],{stdout:"pipe",stderr:"pipe"});
await Bun.sleep(KILL_AT_MS);
const killWall=Date.now();
helper2.kill("SIGKILL");
let victimHung=false;
const victimOut=await Promise.race([new Response(victim.stdout).text(),Bun.sleep(10000).then(()=>{victimHung=true;return ""})]);
if(victimHung){try{victim.kill("SIGKILL")}catch{}}
let victimJson:{count:number,samples:{t:number,d:number}[]}={count:0,samples:[]};
const vi=victimOut.indexOf("BENCH-JSON:");if(vi>=0)victimJson=JSON.parse(victimOut.slice(vi+"BENCH-JSON:".length));
const after=victimJson.samples.filter(s=>s.t>=killWall);
let maxAfterStallMs=-1;for(const s of after)if(s.d>maxAfterStallMs)maxAfterStallMs=s.d;

// ── Phase 13: shutdown stdin command (fresh helper instance).
const helper3=spawnHelper();
await waitFor(f=>f.t==="ready"&&f.pid!==helperPid&&f.pid!==(ready2.pid as number),10000);
helper3.stdin.write(JSON.stringify({t:"shutdown"})+"\n");helper3.stdin.flush();
const shutdownExit=await Promise.race([helper3.exited,Bun.sleep(5000).then(()=>-1)]);

for(const p of [memberA,memberB,gw]){try{p.kill("SIGKILL")}catch{}}
await Promise.race([sampler,Bun.sleep(100)]);

console.log("DRIVER-JSON:"+JSON.stringify({
  kernel,bun:Bun.version,uid:process.getuid?.(),helperPid,rawLines,badLines,
  phase1:{
    create:phase1.create&&{path:phase1.create.path,unit:phase1.create.unit},
    del:phase1.del&&{path:phase1.del.path,unit:phase1.del.unit},
    rename:phase1.rename&&{path:phase1.rename.path,fromPath:phase1.rename.fromPath,unit:p1RenameUnit},
    renameCount:phase1.renameCount,
    shellJoinedWrite:phase1.shellJoinedWrite&&{path:phase1.shellJoinedWrite.path,unit:phase1.shellJoinedWrite.unit},
    pyJoinedWrite:phase1.pyJoinedWrite&&{path:phase1.pyJoinedWrite.path,unit:phase1.pyJoinedWrite.unit},
    read:phase1.read&&{path:phase1.read.path,unit:phase1.read.unit},
  },
  longLived:{expected:N_LONG,attributed:longAttributed},
  short:{expected:N_SHORT,cat:shortCat,echo:shortEcho,nullUnits:shortNull},
  grandchild:{write:grandWrite&&{path:grandWrite.path,unit:grandWrite.unit}},
  parallel:{expected:N_PAR,aCorrect:parACorrect,bCorrect:parBCorrect,cross:parCross},
  renames:{expected:N_RENAMES,frames:renameTotal,firstWait:renameFrames,mvUnits},
  exclusion:{gwFrames,selfFrames},
  suppress:{duringSuppression:suppressedFrames,resumed:resumed!==null},
  bench:{seqBase,seqListen,stormBase,stormListen},
  memory:{spinOpens:Number(spin.count??0),rssSamples,spinSampleCount},
  sigterm:{exitCode,gotFinalStats,finalStats},
  autoAllow:{victimHung,opensBefore:victimJson.samples.length-after.length,opensAfter:after.length,maxAfterStallMs},
  shutdownCmd:{exitCode:shutdownExit},
}));
process.exit(0);
`

interface Latency {
  count: number
  p50ns: number
  p99ns: number
  p999ns: number
  maxNs: number
  wallMs: number
}
interface FrameSummary {
  path?: string
  fromPath?: string
  unit?: string | null
}
interface DriverPayload {
  kernel: string
  bun: string
  uid?: number
  helperPid: number
  rawLines: number
  badLines: number
  phase1: {
    create: FrameSummary | null
    del: FrameSummary | null
    rename: FrameSummary | null
    renameCount: number
    shellJoinedWrite: FrameSummary | null
    pyJoinedWrite: FrameSummary | null
    read: FrameSummary | null
  }
  longLived: { expected: number; attributed: number }
  short: { expected: number; cat: number; echo: number; nullUnits: number }
  grandchild: { write: FrameSummary | null }
  parallel: { expected: number; aCorrect: number; bCorrect: number; cross: number }
  renames: {
    expected: number
    frames: number
    firstWait: number
    mvUnits: { attributed: number; unitNull: number; wrong: number }
  }
  exclusion: { gwFrames: number; selfFrames: number }
  suppress: { duringSuppression: number; resumed: boolean }
  bench: { seqBase: Latency; seqListen: Latency; stormBase: Latency; stormListen: Latency }
  memory: { spinOpens: number; rssSamples: number[]; spinSampleCount: number }
  sigterm: {
    exitCode: number
    gotFinalStats: boolean
    finalStats: { overflow: number; cgroupMisses: number } | null
  }
  autoAllow: {
    victimHung: boolean
    opensBefore: number
    opensAfter: number
    maxAfterStallMs: number
  }
  shutdownCmd: { exitCode: number }
}

function q(s: string): string {
  return `'${s.replaceAll("'", `'"'"'`)}'`
}
const us = (ns: number): string => `${(ns / 1000).toFixed(1)} µs`
const usAdd = (a: number, b: number): string => {
  const d = (a - b) / 1000
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)} µs`
}

/** Uploads text to the VM in base64 chunks (the helper bundle is ~0.7 MB). */
async function uploadFile(
  ctx: ReturnType<typeof makeContext>,
  dest: string,
  remotePath: string,
  content: string | Uint8Array,
  gzipped: boolean,
): Promise<void> {
  const bytes = typeof content === 'string' ? Buffer.from(content) : Buffer.from(content)
  const encoded = (gzipped ? Buffer.from(Bun.gzipSync(bytes)) : bytes).toString('base64')
  const b64Path = `${remotePath}.b64`
  await runOrThrow(ctx.ssh, dest, `rm -f ${b64Path}`)
  for (let offset = 0; offset < encoded.length; offset += 48_000) {
    const chunk = encoded.slice(offset, offset + 48_000)
    await runOrThrow(ctx.ssh, dest, `printf %s ${q(chunk)} >> ${b64Path}`)
  }
  const decode = gzipped
    ? `base64 -d ${b64Path} | gunzip > ${remotePath}`
    : `base64 -d ${b64Path} > ${remotePath}`
  await runOrThrow(ctx.ssh, dest, `${decode} && rm ${b64Path}`)
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
  const name = vmName('attribution-helper')
  let failure: unknown, cleanupFailure: Error | undefined
  try {
    await ctx.control.whoami()

    // Bundle the PRODUCTION helper — the exact artifact slice 10 will ship.
    const build = Bun.spawnSync(['bun', 'build', fileURLToPath(HELPER_ENTRY), '--target=bun'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    if (build.exitCode !== 0) throw new Error(`bun build failed: ${build.stderr.toString()}`)
    const helperBundle = build.stdout.toString()

    const createdVm = await createVm(ctx, {
      name,
      comment: 'duet slice-09 gate: production attribution helper',
    })
    const dest = createdVm.value.ssh_dest
    await ctx.ssh.waitUntilReady(dest, { timeoutMs: 180_000 })
    await runOrThrow(ctx.ssh, dest, "sudo -n true && echo 'sudo -n true: ok'")
    await runOrThrow(ctx.ssh, dest, 'curl -fsSL https://bun.sh/install | bash', 180_000)
    await runOrThrow(ctx.ssh, dest, `mkdir -p ${WORK}`)
    await uploadFile(ctx, dest, `${WORK}/helper-main.js`, helperBundle, true)
    await uploadFile(ctx, dest, `${WORK}/bench.ts`, bench, false)
    await uploadFile(ctx, dest, `${WORK}/driver.ts`, driver, false)

    const run = await ctx.ssh.exec(
      dest,
      `sudo /home/exedev/.bun/bin/bun ${WORK}/driver.ts`,
      420_000,
    )
    const jsonStart = run.stdout.indexOf('DRIVER-JSON:')
    if (jsonStart < 0) {
      throw new Error(
        `driver failed. exit=${run.exitCode}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
      )
    }
    const p = JSON.parse(run.stdout.slice(jsonStart + 'DRIVER-JSON:'.length)) as DriverPayload

    // ── Verdict logic ──
    const LEAF_A = 'session-alpha1'
    // Units on delete/rename are best-effort by mechanism: `rm`/`mv` are
    // short-lived exec'd binaries doing unlink/rename with NO open, so the
    // perm gate never pins them and the live /proc fallback races their
    // exit. The gate is: real filenames always, unit LEAF_A or null (never
    // wrong), and the pin-driven frames (writes, reads, atomic-save joins)
    // deterministically attributed.
    const bestEffort = (unit: string | null | undefined) => unit === LEAF_A || unit === null
    const filenamesOk =
      p.phase1.create?.path === 'm/created.txt' &&
      p.phase1.create.unit === LEAF_A &&
      p.phase1.del?.path === 'm/created.txt' &&
      bestEffort(p.phase1.del.unit) &&
      p.phase1.rename?.path === 'm/new.txt' &&
      p.phase1.rename.fromPath === 'm/old.txt' &&
      bestEffort(p.phase1.rename.unit) &&
      p.phase1.renameCount === 1 &&
      p.phase1.shellJoinedWrite?.unit === LEAF_A &&
      p.phase1.pyJoinedWrite?.unit === LEAF_A &&
      p.phase1.read?.unit === LEAF_A
    const longOk = p.longLived.attributed >= p.longLived.expected
    const shortOk = p.short.cat >= p.short.expected && p.short.echo >= p.short.expected
    const grandOk = p.grandchild.write?.unit === LEAF_A
    const parallelOk =
      p.parallel.aCorrect >= p.parallel.expected &&
      p.parallel.bCorrect >= p.parallel.expected &&
      p.parallel.cross === 0
    const renamesOk =
      p.renames.frames === p.renames.expected &&
      p.renames.mvUnits.wrong === 0 &&
      (p.sigterm.finalStats?.overflow ?? -1) === 0
    const exclusionOk = p.exclusion.gwFrames === 0 && p.exclusion.selfFrames === 0
    const suppressOk = p.suppress.duringSuppression === 0 && p.suppress.resumed
    const ONE_MS = 1_000_000
    const seqAddedP99 = p.bench.seqListen.p99ns - p.bench.seqBase.p99ns
    const stormAddedP99 = p.bench.stormListen.p99ns - p.bench.stormBase.p99ns
    const latencyOk = seqAddedP99 < ONE_MS && stormAddedP99 < ONE_MS
    const rss = p.memory.rssSamples
    const rssHalf = rss.slice(Math.floor(rss.length / 2))
    const steadyDrift = rssHalf.length ? Math.max(...rssHalf) - Math.min(...rssHalf) : -1
    const memoryOk = rss.length >= 5 && steadyDrift >= 0 && steadyDrift < 15_000
    const sigtermOk = p.sigterm.exitCode === 0 && p.sigterm.gotFinalStats
    const autoAllowOk =
      !p.autoAllow.victimHung && p.autoAllow.opensAfter > 0 && p.autoAllow.maxAfterStallMs < 1000
    const shutdownOk = p.shutdownCmd.exitCode === 0
    const protocolOk = p.badLines === 0
    const green =
      filenamesOk &&
      longOk &&
      shortOk &&
      grandOk &&
      parallelOk &&
      renamesOk &&
      exclusionOk &&
      suppressOk &&
      latencyOk &&
      memoryOk &&
      sigtermOk &&
      autoAllowOk &&
      shutdownOk &&
      protocolOk

    const pf = (b: boolean) => (b ? 'PASS' : 'FAIL')
    const fj = (f: FrameSummary | null) => (f ? `\`${JSON.stringify(f)}\`` : '**MISSING**')
    const report = `# Slice-09 gate probe: production attribution helper

Run: ${new Date().toISOString()} on VM \`${name}\` (deleted after capture).
Artifact under test: \`packages/gateway/src/attribution/helper-main.ts\` bundled
with \`bun build --target=bun\` (the slice-10 release shape), run as
\`sudo bun helper-main.js /home/exedev/drive <gatewayPid>\` with stdout a pipe
(L12) and commands on stdin. All numbers below are read from its production
NDJSON frames — no probe-side shims. Mechanism pre-probe:
[fan-open-perm-probe.md](fan-open-perm-probe.md) (GREEN).

## Environment

- Kernel: \`${p.kernel}\`, Bun: \`${p.bun}\`, uid: ${p.uid}
- Session cgroups: \`/sys/fs/cgroup/runners/session-alpha1\` (member A),
  \`…/session-beta2\` (member B) — canonical slice-08 leaves; the helper emits
  the leaf name as \`unit\`.
- Protocol lint: ${p.rawLines} stdout lines, ${p.badLines} unparseable → ${pf(protocolOk)}.

## 1. Real filenames: create / delete / rename / atomic save (${pf(filenamesOk)})

| Op | Frame |
| --- | --- |
| create | ${fj(p.phase1.create)} |
| delete | ${fj(p.phase1.del)} |
| rename (×${p.phase1.renameCount}, dedup wants 1) | ${fj(p.phase1.rename)} |
| shell atomic save → joined write | ${fj(p.phase1.shellJoinedWrite)} |
| python os.replace → joined write | ${fj(p.phase1.pyJoinedWrite)} |
| content read | ${fj(p.phase1.read)} |

Paths are drive-relative. Both atomic saves attribute the REAL filename to the
writer's unit via the codec's handle→writer join — the writer was pinned at its
open even though python had exited before the rename's NOTIF delivery.

Units on the delete/rename rows are best-effort by mechanism: \`rm\`/\`mv\`
are short-lived exec'd binaries whose unlink/rename syscalls involve NO open,
so the perm gate never pins them and the live \`/proc\` fallback races their
exit (measured rate in §5). The criterion here is: real filenames always,
never a WRONG unit, and every pin-reachable frame (create/write/read +
atomic-save joins) deterministically attributed.

## 2. Long-lived cgroup member: ${p.longLived.attributed}/${p.longLived.expected} (${pf(longOk)})

${p.longLived.expected} redirection writes by the session-cgroup bash itself —
every file carries \`unit: "session-alpha1"\`.

## 3. THE GATE — short-lived \`sh -c\` attribution (${pf(shortOk)})

The case the first FID spike lost 0/20: each opener is a distinct short-lived
process, pinned by the FAN_OPEN_PERM group while blocked in open(2).

| Workload | Attributed |
| --- | --- |
| \`sh -c 'cat f'\` × ${p.short.expected} | **${p.short.cat}/${p.short.expected}** |
| \`sh -c 'echo x > f'\` × ${p.short.expected} | **${p.short.echo}/${p.short.expected}** |
| frames with unit null in this phase | ${p.short.nullUnits} |

## 4. Grandchildren + parallel sessions (${pf(grandOk && parallelOk)})

- Grandchild (\`sh -c 'sh -c …'\`) write: ${fj(p.grandchild.write)} — cgroup
  inheritance needs no tracking.
- Two sessions bursting ${p.parallel.expected} concurrent short-lived writers each:
  A ${p.parallel.aCorrect}/${p.parallel.expected}, B ${p.parallel.bCorrect}/${p.parallel.expected},
  cross-attributed frames: **${p.parallel.cross}**.

## 5. 500 renames: count + overflow (${pf(renamesOk)})

| Metric | Value |
| --- | --- |
| rename frames (want exactly ${p.renames.expected}: FAN_RENAME vs legacy dedup) | ${p.renames.frames} |
| final stats overflow | ${p.sigterm.finalStats?.overflow ?? 'n/a'} |
| mv unit: attributed / null / WRONG | ${p.renames.mvUnits.attributed} / ${p.renames.mvUnits.unitNull} / ${p.renames.mvUnits.wrong} |

Each \`mv\` is a short-lived pid that performs rename(2) with NO open — the
perm gate never sees it, so its unit rides the racy live-\`/proc\` fallback:
${p.renames.mvUnits.attributed}/${p.renames.expected} attributed, never to a
wrong unit. Phase-1's single mv: unit \`${String(p.phase1.rename?.unit)}\`.
**Slice-10/11 input:** rename attribution for fork-per-rename workloads is
best-effort; the atomic-save join (§1) already carries the writer's unit, so
the loss is the standalone-\`mv\` audit row, not save attribution.

## 6. Exclusion, suppress, shutdown (${pf(exclusionOk && suppressOk && shutdownOk)})

| Check | Result |
| --- | --- |
| gateway-pid write → frames | ${p.exclusion.gwFrames} (want 0) |
| frames from the helper's own pid | ${p.exclusion.selfFrames} (want 0) |
| writes while suppressed → frames | ${p.suppress.duringSuppression} (want 0) |
| frame after suppress off | ${p.suppress.resumed ? 'yes' : 'NO'} |
| \`{"t":"shutdown"}\` on stdin → exit code | ${p.shutdownCmd.exitCode} |

## 7. Per-open overhead (kill criterion: +1 ms p99) (${pf(latencyOk)})

| Workload | p50 base → helper (added) | p99 base → helper (added) | p99.9 helper |
| --- | --- | --- | --- |
| Sequential (${p.bench.seqBase.count}) | ${us(p.bench.seqBase.p50ns)} → ${us(p.bench.seqListen.p50ns)} (${usAdd(p.bench.seqListen.p50ns, p.bench.seqBase.p50ns)}) | ${us(p.bench.seqBase.p99ns)} → ${us(p.bench.seqListen.p99ns)} (**${usAdd(p.bench.seqListen.p99ns, p.bench.seqBase.p99ns)}**) | ${us(p.bench.seqListen.p999ns)} |
| Storm (${p.bench.stormBase.count}) | ${us(p.bench.stormBase.p50ns)} → ${us(p.bench.stormListen.p50ns)} (${usAdd(p.bench.stormListen.p50ns, p.bench.stormBase.p50ns)}) | ${us(p.bench.stormBase.p99ns)} → ${us(p.bench.stormListen.p99ns)} (**${usAdd(p.bench.stormListen.p99ns, p.bench.stormBase.p99ns)}**) | ${us(p.bench.stormListen.p999ns)} |

Unlike the pre-probe's minimal listener this includes the full production path
(NOTIF decode + O_PATH resolution + joiner running concurrently).

## 8. Memory flatness — OOM landmine (${pf(memoryOk)})

${p.memory.spinOpens.toLocaleString('en-US')} gated opens in a ${(5000 / 1000).toFixed(0)}s spin
(fs frames suppressed so the stdout pipe is not the variable; decode, O_PATH
resolution, and perm handling all live). Helper RSS sampled every 200 ms:

- samples (KB): ${rss.join(' → ')}
- steady-state drift (2nd half): **${steadyDrift} KB** (bound 15000)

## 9. Crash safety + clean shutdown (${pf(sigtermOk && autoAllowOk)})

| Check | Result |
| --- | --- |
| SIGTERM → exit code | ${p.sigterm.exitCode} |
| final stats frame emitted | ${p.sigterm.gotFinalStats ? 'yes' : 'NO'} |
| final counters | overflow=${p.sigterm.finalStats?.overflow ?? '?'} cgroupMisses=${p.sigterm.finalStats?.cgroupMisses ?? '?'} |
| kill -9 mid-storm: victim hung | ${p.autoAllow.victimHung ? 'YES' : 'no'} |
| opens before / after kill | ${p.autoAllow.opensBefore} / ${p.autoAllow.opensAfter} |
| max post-kill stall | ${p.autoAllow.maxAfterStallMs.toFixed(2)} ms |

## Criteria

| Criterion | Result |
| --- | --- |
| create/delete/rename/atomic-save → real filenames | ${pf(filenamesOk)} |
| long-lived cgroup member 20/20 | ${pf(longOk)} (${p.longLived.attributed}/${p.longLived.expected}) |
| **short-lived sh -c cat/echo attributed (the gate)** | **${pf(shortOk)}** (cat ${p.short.cat}/${p.short.expected}, echo ${p.short.echo}/${p.short.expected}) |
| grandchildren attribute via inheritance | ${pf(grandOk)} |
| parallel bursts never cross-attribute | ${pf(parallelOk)} (cross=${p.parallel.cross}) |
| 500 renames, zero overflow, no double count | ${pf(renamesOk)} (${p.renames.frames}/${p.renames.expected}) |
| self/gateway-pid exclusion | ${pf(exclusionOk)} |
| suppress + shutdown commands | ${pf(suppressOk && shutdownOk)} |
| per-open added p99 < 1 ms (seq + storm) | ${pf(latencyOk)} |
| RSS flat across the storm | ${pf(memoryOk)} |
| clean SIGTERM with final stats | ${pf(sigtermOk)} |
| kill -9 auto-allows (no I/O wedge) | ${pf(autoAllowOk)} |
| every stdout line is a valid frame | ${pf(protocolOk)} |

Verdict: **${green ? 'GREEN' : 'RED'}** — ${
      green
        ? `the production helper reproduces the pre-probe mechanism end to end. Short-lived attribution ${p.short.cat}/${p.short.expected} + ${p.short.echo}/${p.short.expected} (the number that decides slice 10); atomic saves attribute the real filename to the pinned writer; two concurrent sessions never bleed into each other; overhead, memory, and crash behavior hold the pre-probe envelope. Slice 10 (supervision + packaging) can build on this helper unchanged. Known best-effort edge, measured above: unit attribution of open-less short-lived processes (\`rm\`/\`mv\` — unlink/rename with no open → no pin) — ${p.renames.mvUnits.attributed}/${p.renames.expected} renames via live fallback, 0 wrong; a slice-11 policy input, not a helper defect.`
        : `at least one criterion failed — see the table. Do not start slice 10 on this helper; reslice per the failing row.`
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
