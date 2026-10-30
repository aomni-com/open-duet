import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { createBrowserExtensionIdentity } from '@repo/vm-image/browser-extension-identity'

import {
  assessChromeTabSuspensionProbe,
  type ChromeTabSuspensionProbeResult,
} from './chrome-tab-suspension-probe-result.ts'
import {
  probeReportUrl,
  probeTranscriptUrl,
  PROBE_REPORTS_DIR,
  PROBE_TRANSCRIPTS_DIR,
} from './probe-artifacts.ts'
import {
  assertNoDuetTestVms,
  cleanup,
  createVm,
  makeContext,
  runOrThrow,
  vmName,
} from './probe-common.ts'

const imageRef = process.env.IMAGE_REF
if (!imageRef?.includes('@sha256:'))
  throw new Error('IMAGE_REF must be an immutable @sha256 digest')
const {
  id: PROBE_EXTENSION_ID,
  publicKey: PROBE_EXTENSION_PUBLIC_KEY,
  privateKey: PROBE_EXTENSION_SIGNING_KEY,
} = createBrowserExtensionIdentity()

const PORT = 18_766
const remote = await readFile(
  new URL('./probe-chrome-tab-suspension-remote.py', import.meta.url),
  'utf8',
)
const ctx = makeContext()
const name = vmName('chrome-tab-suspension')
const reportUrl = probeReportUrl('chrome-tab-suspension.md')
const resultUrl = probeTranscriptUrl('chrome-tab-suspension.json')

const manifest = JSON.stringify({
  manifest_version: 3,
  name: 'Duet tab suspension probe',
  version: '0.0.1',
  key: PROBE_EXTENSION_PUBLIC_KEY,
  permissions: ['tabs', 'windows', 'debugger'],
  background: { service_worker: 'background.js' },
})
const background = String.raw`
const endpoint='ws://127.0.0.1:${PORT}/extension'; let socket;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function targets(){ return chrome.debugger.getTargets(); }
async function snapshot(){ const [windows,allTabs,allTargets]=await Promise.all([chrome.windows.getAll({windowTypes:['normal']}),chrome.tabs.query({}),targets()]); return {windows:windows.map(w=>({id:w.id,focused:w.focused,state:w.state,tabs:allTabs.filter(t=>t.windowId===w.id).map(t=>({id:t.id,windowId:t.windowId,url:t.url,title:t.title,active:t.active,frozen:!!t.frozen,discarded:!!t.discarded,targetId:allTargets.find(x=>x.tabId===t.id&&x.type==='page')?.id||null}))}))}; }
async function identifyUrl(url){ const s=await snapshot(); const tab=s.windows.flatMap(w=>w.tabs).find(t=>t.url===url); if(!tab)throw new Error('URL not found: '+url); return {tabId:tab.id,windowId:tab.windowId,targetId:tab.targetId}; }
async function command(m){ switch(m.command){
case 'snapshot':return snapshot(); case 'identifyUrl':return identifyUrl(m.url);
case 'createControl':{const w=await chrome.windows.create({url:m.url,focused:true});for(let i=0;i<100;i++){const found=await identifyUrl(m.url).catch(()=>null);if(found)return {...found,url:m.url};await delay(50)}throw new Error('control did not load');}
case 'createWindow':{const w=await chrome.windows.create(m.tabId?{tabId:m.tabId,focused:false}:{url:m.url,focused:false});let t;
for(let i=0;i<100;i++){t=(await chrome.tabs.query({windowId:w.id})).find(x=>m.tabId?x.id===m.tabId:x.url===m.url);if(t?.status==='complete')break;await delay(50)}
const landing=await chrome.tabs.create({windowId:w.id,url:'about:blank',active:false});await chrome.tabs.update(landing.id,{active:true});const found=await identifyUrl(t.url);return {...found,url:t.url,landingTabId:landing.id};}
case 'createLanding':{const t=await chrome.tabs.create({windowId:m.windowId,url:'about:blank',active:false});return {tabId:t.id,windowId:t.windowId};}
case 'selectTab':{const t=await chrome.tabs.update(m.tabId,{active:true});return {tabId:t.id,windowId:t.windowId};}
case 'readState':{const target={tabId:m.tabId};await chrome.debugger.attach(target,'1.3');try{const evaluated=await chrome.debugger.sendCommand(target,'Runtime.evaluate',{expression:"({timer:window.__duetProbe?.ticks,navigation:window.__duetProbe?.navigationCount,memory:window.__duetProbe?.memoryMarker,dom:document.querySelector('#marker')?.textContent,session:sessionStorage.getItem('sessionMarker'),local:localStorage.getItem('localMarker')})",returnByValue:true});return evaluated.result.value}finally{await chrome.debugger.detach(target)}}
case 'freezeTab':{try{const t=await chrome.tabs.update(m.tabId,{frozen:true});return {tabId:t.id,frozen:!!t.frozen}}catch(e){return {error:String(e)}}}
case 'discardTab':{try{const t=await chrome.tabs.discard(m.tabId);return {tabId:t.id,discarded:!!t.discarded}}catch(e){return {error:String(e)}}}
case 'activateTab':{await chrome.windows.update(m.windowId,{state:'normal',focused:true});const t=await chrome.tabs.update(m.tabId,{active:true});return {tabId:t.id,frozen:!!t.frozen,discarded:!!t.discarded}}
default:throw new Error('unknown command');}}
function connect(){socket=new WebSocket(endpoint);socket.onopen=()=>socket.send(JSON.stringify({type:'hello',extensionId:chrome.runtime.id}));socket.onmessage=async e=>{const m=JSON.parse(e.data);let result;try{result=await command(m)}catch(error){result={error:String(error)}}socket.send(JSON.stringify({type:'response',requestId:m.requestId,result}))};socket.onclose=()=>setTimeout(connect,250)} connect();`
const broker = String.raw`
let extension;let n=0;const pending=new Map();const server=Bun.serve({hostname:'127.0.0.1',port:${PORT},fetch(req,server){const u=new URL(req.url);if(u.pathname==='/extension'){if(server.upgrade(req))return;return new Response('upgrade failed',{status:400})}if(u.pathname==='/update.xml')return new Response(Bun.file('/tmp/duet-tab-suspension/update.xml'));if(u.pathname==='/extension.crx')return new Response(Bun.file('/tmp/duet-tab-suspension/extension.crx'));if(u.pathname==='/status')return Response.json({connected:!!extension});if(u.pathname==='/command'&&req.method==='POST')return (async()=>{if(!extension)return Response.json({error:'disconnected'},{status:503});const body=await req.json(),requestId='r'+(++n);const answer=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('timeout')),10000);pending.set(requestId,value=>{clearTimeout(timer);resolve(value)})});extension.send(JSON.stringify({...body,requestId}));return Response.json(await answer)})();return new Response('not found',{status:404})},websocket:{open(ws){extension=ws},close(ws){if(extension===ws)extension=undefined},message(_ws,raw){const m=JSON.parse(String(raw));if(m.type==='response'){const done=pending.get(m.requestId);if(done){pending.delete(m.requestId);done(m)}}}}});console.log(server.url);`

let result: ChromeTabSuspensionProbeResult | undefined
let failure = ''
let deleted: string[] = []
try {
  await ctx.control.whoami()
  const created = await createVm(ctx, {
    name,
    image: imageRef,
    cpu: 2,
    memory: '8GB',
    tags: ['duet-probe'],
    comment: 'agent browser windows slice 00b tab suspension #duet-probe',
  })
  await ctx.ssh.waitUntilReady(created.value.ssh_dest, { timeoutMs: 300_000 })
  const encode = (value: string) => Buffer.from(value).toString('base64')
  await runOrThrow(
    ctx.ssh,
    created.value.ssh_dest,
    `set -euo pipefail
root=/tmp/duet-tab-suspension; install -d -o exedev -g exedev "$root/source"
printf %s '${encode(manifest)}'|base64 -d >"$root/source/manifest.json"
printf %s '${encode(background)}'|base64 -d >"$root/source/background.js"
printf %s '${encode(PROBE_EXTENSION_SIGNING_KEY)}'|base64 -d >"$root/probe.pem"
printf %s '${encode(broker)}'|base64 -d >"$root/broker.ts"
printf %s '${encode(remote)}'|base64 -d >"$root/probe.py"
chown -R exedev:exedev "$root"`,
  )
  const output = await runOrThrow(
    ctx.ssh,
    created.value.ssh_dest,
    `set -euo pipefail
root=/tmp/duet-tab-suspension
cleanup_remote(){ test ! -s "$root/broker.pid"||kill "$(cat "$root/broker.pid")" 2>/dev/null||true; sudo -n systemctl stop duet-desktop.target >/dev/null 2>&1||true; sudo -n rm -f /etc/opt/chrome/policies/managed/duet-tab-suspension-probe.json; }
trap cleanup_remote EXIT
sudo -n systemctl stop duet-gateway.service; sudo -n systemctl stop duet-desktop.target || true
env HOME=/home/exedev timeout 30s /usr/bin/google-chrome-stable --pack-extension="$root/source" --pack-extension-key="$root/probe.pem"
actual_id="$(openssl rsa -in "$root/probe.pem" -pubout -outform DER 2>/dev/null|sha256sum|cut -c1-32|tr 0123456789abcdef abcdefghijklmnop)"
test "$actual_id" = '${PROBE_EXTENSION_ID}'
mv "$root/source.crx" "$root/extension.crx"
cat >"$root/update.xml" <<XML
<?xml version='1.0'?><gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'><app appid='$actual_id'><updatecheck codebase='http://127.0.0.1:${PORT}/extension.crx' version='0.0.1'/></app></gupdate>
XML
sudo -n install -d -m755 /etc/opt/chrome/policies/managed
printf '{"ExtensionInstallForcelist":["%s;http://127.0.0.1:${PORT}/update.xml"]}\n' "$actual_id" | sudo -n tee /etc/opt/chrome/policies/managed/duet-tab-suspension-probe.json >/dev/null
env HOME=/home/exedev /home/exedev/.bun/bin/bun "$root/broker.ts" >"$root/broker.log" 2>&1 & echo $! >"$root/broker.pid"
for _ in {1..100};do curl -fsS http://127.0.0.1:${PORT}/status >/dev/null 2>&1&&break;sleep .1;done
sudo -n systemctl start duet-desktop.target
for _ in {1..600};do curl -fsS http://127.0.0.1:${PORT}/status 2>/dev/null|jq -e .connected >/dev/null&&break;sleep .1;done
curl -fsS http://127.0.0.1:${PORT}/status|jq -e .connected >/dev/null
IMAGE_REF='${imageRef}' DISPLAY=:1 python3 "$root/probe.py"`,
    240_000,
  )
  const line = output
    .split('\n')
    .reverse()
    .find(value => value.startsWith('{') && value.endsWith('}'))
  if (!line) throw new Error(`tab suspension probe returned no result:\n${output}`)
  result = JSON.parse(line) as ChromeTabSuspensionProbeResult
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
} finally {
  const cleaned = await cleanup(ctx)
  deleted = cleaned.deleted
  if (cleaned.deleteErrors.length) failure = `${failure}\n${cleaned.deleteErrors.join('\n')}`.trim()
}

let globalLeaks: string[] = []
try {
  globalLeaks = await assertNoDuetTestVms(ctx.control)
} catch (error) {
  failure = `${failure}\n${error instanceof Error ? error.message : String(error)}`.trim()
}
await mkdir(fileURLToPath(PROBE_REPORTS_DIR), { recursive: true })
await mkdir(fileURLToPath(PROBE_TRANSCRIPTS_DIR), { recursive: true })
if (result) await writeFile(fileURLToPath(resultUrl), JSON.stringify(result, null, 2) + '\n')
const assessment = result ? assessChromeTabSuspensionProbe(result) : undefined
await writeFile(
  fileURLToPath(reportUrl),
  `# Extension-native tab suspension kill gate

Date: ${new Date().toISOString()}

## Verdict

- Native tab freeze: **${assessment ? (assessment.freeze.passed ? 'MECHANISM PASS' : 'MECHANISM RED') : 'UNMEASURED'}**${assessment ? ` — ${(assessment.freeze.cpuReductionRatio * 100).toFixed(1)}% renderer CPU reduction; ${assessment.freeze.failures.join('; ') || 'identity, timers, state, restore, and protected active tab passed'}` : ''}
- Tab discard: **${assessment ? (assessment.discard.passed ? 'MECHANISM PASS' : 'MECHANISM RED') : 'UNMEASURED'}**${assessment ? ` — ${(assessment.discard.cpuReductionRatio * 100).toFixed(1)}% renderer CPU reduction; reload=${assessment.discard.reloadObserved}, in-memory loss=${assessment.discard.memoryLossObserved}; ${assessment.discard.failures.join('; ') || 'identity, restore, reload/loss boundary, and protected active tab passed'}` : ''}
- Product policy: **UNDECIDED.** A mechanism pass does not authorize production freeze or discard.

## Exact substrate

- Immutable image: \`${imageRef}\`
- Chrome: \`${result?.chromeVersion ?? 'unmeasured'}\`
- Extension: probe-only CRX, packed by exact-image Chrome and force-installed through the proven loopback update-policy channel
- Workload: ${result?.workload.candidateCount ?? 'unmeasured'} busy background tabs plus one quiet protected foreground control; ${result?.workload.sampleDurationMs ?? 'unmeasured'} ms CPU windows
- Full credential-free result: [chrome-tab-suspension.json](../transcripts/chrome-tab-suspension.json)

## CPU / memory telemetry

| phase | renderer cores | all-Chrome cores | renderer RSS | all-Chrome RSS |
| --- | ---: | ---: | ---: | ---: |
${['active', 'frozen', 'discarded']
  .map(key => {
    const s = result?.[key as 'active' | 'frozen' | 'discarded']
    return `| ${key} | ${s?.rendererCpuCores.toFixed(3) ?? '—'} | ${s?.totalChromeCpuCores.toFixed(3) ?? '—'} | ${s ? (s.rendererRssBytes / 1048576).toFixed(1) + ' MiB' : '—'} | ${s ? (s.totalChromeRssBytes / 1048576).toFixed(1) + ' MiB' : '—'} |`
  })
  .join('\n')}

## Identity and state boundary

Native freeze commands returned: ${result?.freeze.commands?.map(command => `\`${command.result?.error ?? JSON.stringify(command.result)}\``).join('; ') ?? 'unmeasured'}.

${result?.freeze.candidates.map(t => `- Freeze tab ${t.tabId} / window ${t.windowId}: URL \`${t.url}\`; target \`${t.targetIdBefore}\` → \`${t.targetIdFrozen}\` → \`${t.targetIdAfter}\`; nav ${t.navigationBefore} → ${t.navigationAfter}; timers ${t.timerBefore} → ${t.timerAfter} → ${t.timerAfterActivation}; DOM, memory, sessionStorage, and localStorage ${t.memoryMarkerAfter === t.memoryMarkerBefore && t.domMarkerAfter === t.domMarkerBefore && t.sessionStorageAfter === t.sessionStorageBefore && t.localStorageAfter === t.localStorageBefore ? 'survived' : 'did not all survive'}.`).join('\n') ?? '- Freeze unmeasured.'}

${result?.discard.candidates.map(t => `- Discard tab ${t.tabId} → replacement tab ${t.replacementTabId} / window ${t.windowId}: URL \`${t.url}\`; target \`${t.targetIdBefore}\` → \`${t.targetIdDiscarded ?? 'absent'}\` → \`${t.targetIdAfter}\`; nav ${t.navigationBefore} → ${t.navigationAfter}; memory \`${t.memoryMarkerBefore}\` → \`${t.memoryMarkerAfter}\`; session/local storage \`${t.sessionStorageBefore}\`/\`${t.localStorageBefore}\` → \`${t.sessionStorageAfter}\`/\`${t.localStorageAfter}\`.`).join('\n') ?? '- Discard unmeasured.'}

## Cleanup

- Exact VM deleted: ${deleted.map(value => `\`${value}\``).join(', ') || 'none'}
- Global \`duet-test-*\` leak check: ${globalLeaks.length === 0 ? 'PASS (none remain)' : `RED (${globalLeaks.join(', ')})`}
${failure ? `\n## Failure\n\n\`\`\`text\n${failure}\n\`\`\`\n` : ''}`,
)
console.log(`wrote ${fileURLToPath(reportUrl)}`)
if (failure) throw new Error(failure)
