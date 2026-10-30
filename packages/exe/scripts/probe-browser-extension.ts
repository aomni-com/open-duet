import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { DESKTOP_CDP_PORT, DESKTOP_CHROME_VERSION } from '@repo/contract'
import { createBrowserExtensionIdentity } from '@repo/vm-image/browser-extension-identity'

import {
  PROBE_REPORTS_DIR,
  PROBE_SCREENSHOTS_DIR,
  probeReportUrl,
  probeScreenshotUrl,
} from './probe-artifacts.ts'
import { cleanup, createVm, makeContext, ms, runOrThrow, vmName } from './probe-common.ts'

const imageRef = process.env.IMAGE_REF
if (!imageRef) throw new Error('IMAGE_REF is required')

const {
  id: EXTENSION_ID,
  publicKey: EXTENSION_PUBLIC_KEY,
  privateKey: PROBE_SIGNING_KEY,
} = createBrowserExtensionIdentity()

const BROKER_PORT = 18_765
const KEEPALIVE_MS = 20_000
const SUSPEND_IDLE_MS = 60_000

const manifest = JSON.stringify({
  manifest_version: 3,
  name: 'Duet native browser probe',
  version: '0.0.1',
  key: EXTENSION_PUBLIC_KEY,
  update_url: `http://127.0.0.1:${BROKER_PORT}/update.xml`,
  permissions: ['tabs', 'windows', 'debugger', 'alarms'],
  background: { service_worker: 'background.js' },
})

const background = String.raw`
const endpoint = 'ws://127.0.0.1:${BROKER_PORT}/extension';
const keepaliveMs = ${KEEPALIVE_MS};
const suspendIdleMs = ${SUSPEND_IDLE_MS};
const workerStartedAt = Date.now();
let socket;
let keepalive;
let transientFocusTimer;

function send(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function event(type, detail = {}) { send({ type: 'event', event: type, ...detail }); }

async function snapshot() {
  const [windows, targets] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    chrome.debugger.getTargets(),
  ]);
  return windows.map(window => ({
    id: window.id,
    focused: window.focused,
    state: window.state,
    tabs: (window.tabs || []).map(tab => ({
      id: tab.id,
      active: tab.active,
      title: tab.title,
      targetId: targets.find(target => target.tabId === tab.id && target.type === 'page')?.id,
    })),
  }));
}

async function command(message) {
  switch (message.command) {
    case 'snapshot': return snapshot();
    case 'createWindow': {
      const window = await chrome.windows.create({ url: 'about:blank', focused: false });
      return { windowId: window.id };
    }
    case 'createTab': {
      const tab = await chrome.tabs.create({ windowId: message.windowId, url: message.url, active: true });
      for (let attempt = 0; attempt < 100; attempt++) {
        const target = (await chrome.debugger.getTargets()).find(candidate => candidate.tabId === tab.id && candidate.type === 'page');
        if (target) return { tabId: tab.id, targetId: target.id };
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error('exact tab target did not appear');
    }
    case 'minimize':
      await chrome.windows.update(message.windowId, { state: 'minimized' });
      return { windowId: message.windowId };
    case 'focus':
      await chrome.windows.update(message.windowId, { state: 'normal' });
      await chrome.windows.update(message.windowId, { focused: true });
      return { windowId: message.windowId };
    case 'suspend':
      chrome.alarms.create('reconnect', { when: Date.now() + suspendIdleMs });
      setTimeout(() => { clearInterval(keepalive); socket.close(4000, 'probe suspension'); }, 25);
      return { reconnectAfterMs: suspendIdleMs };
    default: throw new Error('unknown command: ' + message.command);
  }
}

function connect() {
  if (socket && socket.readyState < WebSocket.CLOSING) return;
  socket = new WebSocket(endpoint);
  socket.onopen = () => {
    send({ type: 'hello', extensionId: chrome.runtime.id, workerStartedAt });
    clearInterval(keepalive);
    keepalive = setInterval(() => send({ type: 'keepalive', at: Date.now() }), keepaliveMs);
  };
  socket.onmessage = async eventMessage => {
    const message = JSON.parse(eventMessage.data);
    try { send({ type: 'response', requestId: message.requestId, result: await command(message) }); }
    catch (error) { send({ type: 'response', requestId: message.requestId, error: String(error) }); }
  };
  socket.onclose = () => { clearInterval(keepalive); };
}

chrome.windows.onFocusChanged.addListener(windowId => {
  clearTimeout(transientFocusTimer);
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    event('focusTransient', { windowId });
    transientFocusTimer = setTimeout(async () => {
      const focused = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      event('focusSettled', { windowId: focused.id });
    }, 250);
    return;
  }
  event('focusSettled', { windowId });
});
chrome.tabs.onCreated.addListener(tab => event('tabCreated', { tabId: tab.id, windowId: tab.windowId }));
chrome.tabs.onActivated.addListener(info => event('tabActivated', info));
chrome.tabs.onRemoved.addListener((tabId, info) => event('tabRemoved', { tabId, windowId: info.windowId }));
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'reconnect') connect(); });
connect();
`

const broker = String.raw`
const port = ${BROKER_PORT};
const extensionId = '${EXTENSION_ID}';
const root = '/tmp/duet-browser-extension-probe';
let extension;
let requestNumber = 0;
let connectionCount = 0;
const pending = new Map();
const events = [];

const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/extension') {
      if (server.upgrade(request)) return;
      return new Response('upgrade failed', { status: 400 });
    }
    if (url.pathname === '/update.xml') return new Response(Bun.file(root + '/update.xml'));
    if (url.pathname === '/extension.crx') return new Response(Bun.file(root + '/extension.crx'));
    if (url.pathname === '/status') return Response.json({ connectionCount, connected: !!extension, events });
    if (url.pathname === '/command' && request.method === 'POST') {
      if (!extension) return Response.json({ error: 'extension disconnected' }, { status: 503 });
      const body = await request.json();
      const requestId = 'probe-' + (++requestNumber);
      const reply = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('extension command timeout')); }, 10_000);
        pending.set(requestId, value => { clearTimeout(timeout); resolve(value); });
      });
      extension.send(JSON.stringify({ ...body, requestId }));
      try { return Response.json(await reply); }
      catch (error) { return Response.json({ error: String(error) }, { status: 504 }); }
    }
    return new Response('not found', { status: 404 });
  },
  websocket: {
    open(ws) { extension = ws; },
    close(ws) { if (extension === ws) extension = undefined; },
    message(ws, raw) {
      const message = JSON.parse(String(raw));
      if (message.type === 'hello') {
        if (message.extensionId !== extensionId) { ws.close(4003, 'wrong extension'); return; }
        connectionCount++;
        events.push(message);
      } else if (message.type === 'response') {
        const resolve = pending.get(message.requestId);
        if (resolve) { pending.delete(message.requestId); resolve(message); }
      } else events.push(message);
    },
  },
});
console.log('BROKER_READY=' + server.url);
`

const reportUrl = probeReportUrl('agent-browser-extension-focus.md')
const screenshotUrl = probeScreenshotUrl('agent-browser-extension-focus.png')
const failureTranscriptUrl = new URL('agent-browser-extension-focus-failure.txt', PROBE_REPORTS_DIR)
const ctx = makeContext()
const name = vmName('browser-extension')
const evidence = {
  vmName: name,
  imageRef,
  createMs: 0,
  sshReadyMs: 0,
  chromeVersion: '',
  policy: '',
  extensionId: '',
  initialGeneration: '',
  restartedGeneration: '',
  tabId: '',
  targetId: '',
  chromeWindowId: '',
  x11WindowId: '',
  x11Title: '',
  reconnects: '',
  eventCount: '',
  deleted: [] as string[],
  noLeaks: false,
  failure: '',
}

function encoded(value: string): string {
  return Buffer.from(value).toString('base64')
}

function marker(output: string, name: string): string {
  const value = output.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]
  if (value === undefined) throw new Error(`browser extension probe omitted ${name}`)
  return value
}

try {
  await ctx.control.whoami()
  const created = await createVm(ctx, {
    name,
    image: imageRef,
    cpu: 2,
    memory: '8GB',
    tags: ['duet-probe'],
    comment: 'agent-browser-windows slice 00 extension/focus #duet-probe',
  })
  evidence.createMs = created.durationMs
  evidence.sshReadyMs = await ctx.ssh.waitUntilReady(created.value.ssh_dest, {
    timeoutMs: 300_000,
  })

  const focusToken = `DUET_FOCUS_${Date.now()}`
  await runOrThrow(
    ctx.ssh,
    created.value.ssh_dest,
    `set -euo pipefail
probe_root=/tmp/duet-browser-extension-probe
install -d -o exedev -g exedev "$probe_root/source"
printf %s '${encoded(PROBE_SIGNING_KEY)}' | base64 -d > "$probe_root/probe.pem"
printf %s '${encoded(manifest)}' | base64 -d > "$probe_root/source/manifest.json"
printf %s '${encoded(background)}' | base64 -d > "$probe_root/source/background.js"
printf %s '${encoded(broker)}' | base64 -d > "$probe_root/broker.ts"
chown -R exedev:exedev "$probe_root"`,
  )
  const output = await runOrThrow(
    ctx.ssh,
    created.value.ssh_dest,
    `set -euo pipefail
stage=setup
probe_root=/tmp/duet-browser-extension-probe
cleanup_remote() {
  if [[ -s "$probe_root/broker.pid" ]]; then kill "$(cat "$probe_root/broker.pid")" >/dev/null 2>&1 || true; fi
  sudo -n systemctl stop duet-desktop.target >/dev/null 2>&1 || true
  if [[ -d /etc/opt/chrome/policies/managed ]]; then
    sudo -n find /etc/opt/chrome/policies/managed -maxdepth 1 -name 'duet-browser-extension-probe.json' -delete
  fi
}
on_error() {
  rc=$?
  echo "FAILED_STAGE=$stage" >&2
  systemctl status --no-pager duet-desktop.target duet-desktop-browser.service >&2 || true
  test ! -e "$probe_root/broker.log" || cat "$probe_root/broker.log" >&2
  exit "$rc"
}
trap on_error ERR
trap cleanup_remote EXIT
sudo -n systemctl stop duet-gateway.service
sudo -n systemctl stop duet-desktop.target || true
stage=pack-crx
env HOME=/home/exedev timeout 30s /usr/bin/google-chrome-stable \
  --pack-extension="$probe_root/source" \
  --pack-extension-key="$probe_root/probe.pem"
mv "$probe_root/source.crx" "$probe_root/extension.crx"
actual_id="$(openssl rsa -in "$probe_root/probe.pem" -pubout -outform DER 2>/dev/null | sha256sum | cut -c1-32 | tr '0123456789abcdef' 'abcdefghijklmnop')"
test "$actual_id" = '${EXTENSION_ID}'
cat > "$probe_root/update.xml" <<'XML'
<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${EXTENSION_ID}'>
    <updatecheck codebase='http://127.0.0.1:${BROKER_PORT}/extension.crx' version='0.0.1'/>
  </app>
</gupdate>
XML
sudo -n install -d -m 755 /etc/opt/chrome/policies/managed
cat > /tmp/duet-browser-extension-probe-policy.json <<'JSON'
{
  "ExtensionInstallForcelist": ["${EXTENSION_ID};http://127.0.0.1:${BROKER_PORT}/update.xml"]
}
JSON
sudo -n install -m 644 /tmp/duet-browser-extension-probe-policy.json \
  /etc/opt/chrome/policies/managed/duet-browser-extension-probe.json
env HOME=/home/exedev /home/exedev/.bun/bin/bun "$probe_root/broker.ts" \
  >"$probe_root/broker.log" 2>&1 &
echo $! > "$probe_root/broker.pid"
for _ in {1..100}; do curl -fsS "http://127.0.0.1:${BROKER_PORT}/status" >/dev/null 2>&1 && break; sleep 0.1; done
curl -fsS "http://127.0.0.1:${BROKER_PORT}/status" >/dev/null
stage=forced-install
sudo -n systemctl start duet-desktop.target
for _ in {1..600}; do
  status="$(curl -fsS "http://127.0.0.1:${BROKER_PORT}/status" 2>/dev/null || true)"
  jq -e '.connected and .connectionCount >= 1' <<<"$status" >/dev/null 2>&1 && break
  sleep 0.1
done
jq -e '.connected and .connectionCount >= 1' <<<"$status" >/dev/null
initial_generation="$(curl -fsS 'http://127.0.0.1:${DESKTOP_CDP_PORT}/json/version' | jq -r .webSocketDebuggerUrl | sed 's#.*/##')"
test "$(dpkg-query -W -f='\${Version}' google-chrome-stable)" = '${DESKTOP_CHROME_VERSION}'
browser_main_pid="$(systemctl show duet-desktop-browser.service -p MainPID --value)"
test "$browser_main_pid" -gt 0
browser_main_argv="$(tr '\\0' ' ' < "/proc/$browser_main_pid/cmdline")"
grep -F -- '--user-data-dir=/home/exedev/.duet/chrome' <<<"$browser_main_argv" >/dev/null
! grep -F -- '--type=' <<<"$browser_main_argv"
stage=exact-tab-target
snapshot="$(curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"command":"snapshot"}' "http://127.0.0.1:${BROKER_PORT}/command")"
bootstrap_window="$(jq -er '.result[0].id' <<<"$snapshot")"
created_window="$(curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"command":"createWindow"}' "http://127.0.0.1:${BROKER_PORT}/command")"
chrome_window_id="$(jq -er .result.windowId <<<"$created_window")"
focus_url="data:text/html;charset=utf-8,%3Ctitle%3E${focusToken}%3C%2Ftitle%3E%3Ch1%3EExact%20focus%20oracle%3C%2Fh1%3E"
created_tab="$(jq -cn --argjson windowId "$chrome_window_id" --arg url "$focus_url" \
  '{command:"createTab",windowId:$windowId,url:$url}' | \
  curl -fsS -X POST -H 'content-type: application/json' --data-binary @- \
    "http://127.0.0.1:${BROKER_PORT}/command")"
tab_id="$(jq -er .result.tabId <<<"$created_tab")"
target_id="$(jq -er .result.targetId <<<"$created_tab")"
cdp_target="$(curl -fsS 'http://127.0.0.1:${DESKTOP_CDP_PORT}/json/list' | jq -er --arg id "$target_id" '.[] | select(.id == $id) | .id')"
test "$target_id" = "$cdp_target"
stage=focus-oracle
jq -cn --argjson windowId "$bootstrap_window" '{command:"focus",windowId:$windowId}' | \
  curl -fsS -X POST -H 'content-type: application/json' --data-binary @- \
    "http://127.0.0.1:${BROKER_PORT}/command" >/dev/null
jq -cn --argjson windowId "$chrome_window_id" '{command:"minimize",windowId:$windowId}' | \
  curl -fsS -X POST -H 'content-type: application/json' --data-binary @- \
    "http://127.0.0.1:${BROKER_PORT}/command" >/dev/null
jq -cn --argjson windowId "$chrome_window_id" '{command:"focus",windowId:$windowId}' | \
  curl -fsS -X POST -H 'content-type: application/json' --data-binary @- \
    "http://127.0.0.1:${BROKER_PORT}/command" >/dev/null
for _ in {1..100}; do
  x11_window_id="$(DISPLAY=:1 xprop -root _NET_ACTIVE_WINDOW | grep -o '0x[0-9a-fA-F]*' | head -1)"
  x11_title="$(DISPLAY=:1 xprop -id "$x11_window_id" _NET_WM_NAME 2>/dev/null || true)"
  grep -F '${focusToken}' <<<"$x11_title" >/dev/null && break
  sleep 0.1
done
test -n "$x11_window_id"
grep -F '${focusToken}' <<<"$x11_title" >/dev/null
for _ in {1..100}; do
  if pgrep -x xfdesktop >/dev/null && pgrep -x plank >/dev/null; then break; fi
  sleep 0.1
done
pgrep -x xfdesktop >/dev/null
pgrep -x plank >/dev/null
sleep 1
DISPLAY=:1 import -window root "$probe_root/focus.png"
stage=worker-suspension
for _ in {1..250}; do
  status="$(curl -fsS "http://127.0.0.1:${BROKER_PORT}/status")"
  jq -e '.events | any(.type == "keepalive")' <<<"$status" >/dev/null 2>&1 && break
  sleep 0.1
done
jq -e '.events | any(.type == "keepalive")' <<<"$status" >/dev/null
curl -fsS -X POST -H 'content-type: application/json' \
  -d '{"command":"suspend"}' "http://127.0.0.1:${BROKER_PORT}/command" >/dev/null
for _ in {1..750}; do
  status="$(curl -fsS "http://127.0.0.1:${BROKER_PORT}/status")"
  jq -e '.connected and .connectionCount >= 2' <<<"$status" >/dev/null 2>&1 && break
  sleep 0.1
done
jq -e '.connected and .connectionCount >= 2' <<<"$status" >/dev/null
jq -e '[.events[] | select(.type == "hello") | .workerStartedAt] | unique | length >= 2' <<<"$status" >/dev/null
stage=chrome-restart
sudo -n systemctl restart duet-desktop-browser.service
for _ in {1..600}; do
  status="$(curl -fsS "http://127.0.0.1:${BROKER_PORT}/status")"
  jq -e '.connected and .connectionCount >= 3' <<<"$status" >/dev/null 2>&1 && break
  sleep 0.1
done
jq -e '.connected and .connectionCount >= 3' <<<"$status" >/dev/null
restarted_generation="$(curl -fsS 'http://127.0.0.1:${DESKTOP_CDP_PORT}/json/version' | jq -r .webSocketDebuggerUrl | sed 's#.*/##')"
test "$initial_generation" != "$restarted_generation"
event_count="$(jq '.events | length' <<<"$status")"
test "$event_count" -gt 2
echo "CHROME_VERSION=$(dpkg-query -W -f='\${Version}' google-chrome-stable)"
echo "POLICY_PATH=/etc/opt/chrome/policies/managed/duet-browser-extension-probe.json"
echo "EXTENSION_ID=${EXTENSION_ID}"
echo "INITIAL_GENERATION=$initial_generation"
echo "RESTARTED_GENERATION=$restarted_generation"
echo "TAB_ID=$tab_id"
echo "TARGET_ID=$target_id"
echo "CHROME_WINDOW_ID=$chrome_window_id"
echo "X11_WINDOW_ID=$x11_window_id"
echo "X11_TITLE=$x11_title"
echo "RECONNECTS=$(jq -r .connectionCount <<<"$status")"
echo "EVENT_COUNT=$event_count"`,
    240_000,
  )

  evidence.chromeVersion = marker(output, 'CHROME_VERSION')
  evidence.policy = marker(output, 'POLICY_PATH')
  evidence.extensionId = marker(output, 'EXTENSION_ID')
  evidence.initialGeneration = marker(output, 'INITIAL_GENERATION')
  evidence.restartedGeneration = marker(output, 'RESTARTED_GENERATION')
  evidence.tabId = marker(output, 'TAB_ID')
  evidence.targetId = marker(output, 'TARGET_ID')
  evidence.chromeWindowId = marker(output, 'CHROME_WINDOW_ID')
  evidence.x11WindowId = marker(output, 'X11_WINDOW_ID')
  evidence.x11Title = marker(output, 'X11_TITLE')
  evidence.reconnects = marker(output, 'RECONNECTS')
  evidence.eventCount = marker(output, 'EVENT_COUNT')

  const screenshotBase64 = await runOrThrow(
    ctx.ssh,
    created.value.ssh_dest,
    'base64 -w0 /tmp/duet-browser-extension-probe/focus.png',
  )
  await mkdir(fileURLToPath(PROBE_SCREENSHOTS_DIR), { recursive: true })
  await writeFile(fileURLToPath(screenshotUrl), Buffer.from(screenshotBase64, 'base64'))
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error)
} finally {
  const cleaned = await cleanup(ctx)
  evidence.deleted = cleaned.deleted
  if (cleaned.deleteErrors.length > 0) {
    evidence.failure = `${evidence.failure}\n${cleaned.deleteErrors.join('\n')}`.trim()
  }
  const exactVmStillExists = (await ctx.control.list()).some(vm => vm.vm_name === name)
  evidence.noLeaks = !exactVmStillExists
  if (exactVmStillExists)
    evidence.failure = `${evidence.failure}\nExact probe VM still exists: ${name}`.trim()
}

await mkdir(fileURLToPath(PROBE_REPORTS_DIR), { recursive: true })
if (evidence.failure) await writeFile(fileURLToPath(failureTranscriptUrl), evidence.failure)
await writeFile(
  fileURLToPath(reportUrl),
  `# Slice 00 gates A+B — forced extension, exact channel, and focus

Date: ${new Date().toISOString()}

## Verdict

${evidence.failure ? `**FAIL:** ${evidence.failure.split('\n')[0]}` : '**PASS:** the pinned Chrome supports deterministic forced MV3 installation, exact window/tab/target commands over the loopback channel, suspension/restart reconnect, and independently verified native focus.'}

## Exact substrate

- Image: \`${evidence.imageRef}\`
- Chrome: \`${evidence.chromeVersion || 'unmeasured'}\` (expected \`${DESKTOP_CHROME_VERSION}\`)
- Extension id: \`${evidence.extensionId || 'unmeasured'}\`
- Manifest public key: \`${EXTENSION_PUBLIC_KEY}\`
- Install policy: \`${evidence.policy || 'unmeasured'}\`
- Update manifest: \`http://127.0.0.1:${BROKER_PORT}/update.xml\`
- CRX: probe-only RSA key + exact Chrome \`--pack-extension\`; no Web Store or interactive install
- Live Chrome launch bytes: unchanged image-owned systemd command; no extension command-line flags

## Channel and generation evidence

- Exact mapping: Chrome window \`${evidence.chromeWindowId || 'unmeasured'}\`, tab \`${evidence.tabId || 'unmeasured'}\`, CDP target \`${evidence.targetId || 'unmeasured'}\`
- Initial browser generation: \`${evidence.initialGeneration || 'unmeasured'}\`
- Restarted browser generation: \`${evidence.restartedGeneration || 'unmeasured'}\`
- Extension connections: \`${evidence.reconnects || 'unmeasured'}\` (initial, after natural 60-second worker suspension, after Chrome restart)
- Native events retained by broker: \`${evidence.eventCount || 'unmeasured'}\`
- Keepalive: ${KEEPALIVE_MS / 1_000}s; explicit suspension alarm: ${SUSPEND_IDLE_MS / 1_000}s

## Independent focus oracle

- Chrome window id (actuator): \`${evidence.chromeWindowId || 'unmeasured'}\`
- X11 \`_NET_ACTIVE_WINDOW\` (oracle only): \`${evidence.x11WindowId || 'unmeasured'}\`
- X11 \`_NET_WM_NAME\`: \`${evidence.x11Title || 'unmeasured'}\`
- Screenshot: \`${fileURLToPath(screenshotUrl)}\`
- The extension debounces transient \`WINDOW_ID_NONE\` for 250ms and emits only a settled focus after independently querying Chrome.

## Lifecycle and cleanup

- VM: \`${evidence.vmName}\`
- Control-plane create: ${ms(evidence.createMs)}
- Boot to SSH: ${ms(evidence.sshReadyMs)}
- Deleted: ${evidence.deleted.map(vm => `\`${vm}\``).join(', ') || 'none'}
- Exact cleanup: ${evidence.noLeaks ? `probe VM \`${evidence.vmName}\` is absent` : `probe VM \`${evidence.vmName}\` still exists`}
- Full failure command/stderr: ${evidence.failure ? `\`${fileURLToPath(failureTranscriptUrl)}\`` : 'not applicable'}

## Accepted boundary

${
  evidence.failure
    ? 'No architectural conclusion is accepted from this failed run; rerun the exact probe after resolving the reported infrastructure or mechanism failure.'
    : `The forced policy plus loopback update source is viable on the pinned image. The
extension is an actuator only; the gateway owns commands and generations. X11
proves focus but supplies no persisted id. The probe-only alarm permission exists
only to force a suspension/reconnect observation and is not required by the final
20-second WebSocket keepalive design.`
}
`,
)

console.log(`wrote ${fileURLToPath(reportUrl)}`)
if (!evidence.failure) console.log(`wrote ${fileURLToPath(screenshotUrl)}`)
if (evidence.failure) throw new Error(evidence.failure)
