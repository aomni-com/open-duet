import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { DESKTOP_CDP_PORT, DESKTOP_CHROME_VERSION } from '@repo/contract'

import { PROBE_REPORTS_DIR, probeReportUrl } from './probe-artifacts.ts'
import {
  assertNoDuetTestVms,
  cleanup,
  createVm,
  makeContext,
  ms,
  runOrThrow,
  vmName,
} from './probe-common.ts'

const imageRef = process.env.IMAGE_REF
if (!imageRef) throw new Error('IMAGE_REF is required')

const reportUrl = probeReportUrl('vm-desktop-slice05-shared-chrome.md')
const ctx = makeContext()
const name = vmName('shared-chrome')
const evidence = {
  vmName: name,
  imageRef,
  createMs: 0,
  sshReadyMs: 0,
  chromeVersion: '',
  cdpBrowser: '',
  webSocketDebuggerUrl: '',
  wmClass: '',
  geometry: '',
  profileMarker: '',
  pageTitle: '',
  persistedCookie: '',
  deleted: [] as string[],
  noLeaks: false,
  failure: '',
}

function marker(output: string, name: string): string {
  const value = output.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]
  if (value === undefined) throw new Error(`shared Chrome probe omitted ${name}`)
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
    comment: 'vm-desktop slice 05 shared Chrome #duet-probe',
  })
  evidence.createMs = created.durationMs
  evidence.sshReadyMs = await ctx.ssh.waitUntilReady(created.value.ssh_dest, {
    timeoutMs: 300_000,
  })

  const output = await runOrThrow(
    ctx.ssh,
    created.value.ssh_dest,
    `set -euo pipefail
stage=target-start
site_pid=''
site_dir=''
cleanup_remote() {
  if [[ -n "$site_pid" ]]; then kill "$site_pid" >/dev/null 2>&1 || true; fi
  if [[ -n "$site_dir" ]]; then rm -rf "$site_dir"; fi
}
on_error() {
  rc=$?
  echo "FAILED_STAGE=$stage" >&2
  systemctl status --no-pager duet-desktop.target duet-desktop.service duet-desktop-browser.service >&2 || true
  exit "$rc"
}
trap on_error ERR
trap cleanup_remote EXIT
site_dir="$(mktemp -d)"
printf '%s\n' '<!doctype html><title>Duet shared Chrome probe</title><h1>Shared browser</h1>' > "$site_dir/index.html"
probe_port="$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1])
PY
)"
python3 -m http.server "$probe_port" --bind 127.0.0.1 --directory "$site_dir" >/tmp/duet-shared-chrome-http.log 2>&1 &
site_pid=$!
probe_url="http://127.0.0.1:$probe_port/"
sudo -n systemctl start duet-desktop.target
stage=first-cdp
for _ in {1..600}; do
  cdp="$(curl -fsS 'http://127.0.0.1:${DESKTOP_CDP_PORT}/json/version' 2>/dev/null || true)"
  if jq -e '.webSocketDebuggerUrl | startswith("ws://127.0.0.1:${DESKTOP_CDP_PORT}/")' <<<"$cdp" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
jq -e '.webSocketDebuggerUrl | startswith("ws://127.0.0.1:${DESKTOP_CDP_PORT}/")' <<<"$cdp" >/dev/null
stage=first-window
window_id=''
window_info=''
for _ in {1..300}; do
  window_id="$(DISPLAY=:1 xwininfo -root -tree | awk '/Google Chrome/ { print $1; exit }')"
  if [[ -n "$window_id" ]]; then
    window_info="$(DISPLAY=:1 xwininfo -id "$window_id")"
    if grep -F 'Map State: IsViewable' <<<"$window_info" >/dev/null; then break; fi
  fi
  sleep 0.1
done
test -n "$window_id"
grep -F 'Map State: IsViewable' <<<"$window_info" >/dev/null
grep -F 'Width: 1296' <<<"$window_info" >/dev/null
grep -F 'Height: 720' <<<"$window_info" >/dev/null
wm_class="$(DISPLAY=:1 xprop -id "$window_id" WM_CLASS)"
grep -E 'WM_CLASS.*"duet-browser"$' <<<"$wm_class" >/dev/null
stage=agent-cookie-write
PROBE_URL="$probe_url" python3 - <<'PY'
import os
import time
from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp('http://127.0.0.1:${DESKTOP_CDP_PORT}')
    context = browser.contexts[0]
    page = context.pages[0]
    page.goto(os.environ['PROBE_URL'], wait_until='domcontentloaded')
    context.add_cookies([{
        'name': 'duet_shared_login',
        'value': 'native-probe',
        'url': os.environ['PROBE_URL'],
        'expires': int(time.time()) + 3600,
        'sameSite': 'Lax',
    }])
    assert any(cookie['name'] == 'duet_shared_login' and cookie['value'] == 'native-probe'
               for cookie in context.cookies(os.environ['PROBE_URL']))
    print(f"AGENT_PAGE_TITLE={page.title()}")
PY
sleep 3
stage=profile-restart
profile_marker="duet-slice05-$(date +%s%N)"
printf '%s\n' "$profile_marker" > /home/exedev/.duet/chrome/.duet-profile-probe
stop_started="$(date +%s%3N)"
sudo -n systemctl stop duet-desktop.target
stop_finished="$(date +%s%3N)"
python3 - <<'PY'
import glob
import sqlite3

matches = []
for path in glob.glob('/home/exedev/.duet/chrome/**/Cookies', recursive=True):
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    rows = connection.execute(
        "select host_key, name, length(encrypted_value), expires_utc from cookies where name = ?",
        ('duet_shared_login',),
    ).fetchall()
    matches.extend((path, row) for row in rows)
print(f"COOKIE_ROWS_AFTER_STOP={matches}")
assert len(matches) == 1
PY
echo "TARGET_STOP_MS=$((stop_finished - stop_started))"
systemctl show duet-desktop-browser.service -p Result -p ExecMainStatus -p ExecMainCode
sudo -n systemctl start duet-desktop.target
stage=second-cdp
for _ in {1..600}; do
  cdp="$(curl -fsS 'http://127.0.0.1:${DESKTOP_CDP_PORT}/json/version' 2>/dev/null || true)"
  if jq -e '.webSocketDebuggerUrl | startswith("ws://127.0.0.1:${DESKTOP_CDP_PORT}/")' <<<"$cdp" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
jq -e '.webSocketDebuggerUrl | startswith("ws://127.0.0.1:${DESKTOP_CDP_PORT}/")' <<<"$cdp" >/dev/null
stage=durability
test "$(cat /home/exedev/.duet/chrome/.duet-profile-probe)" = "$profile_marker"
PROBE_URL="$probe_url" python3 - <<'PY'
import os
from playwright.sync_api import sync_playwright

with sync_playwright() as playwright:
    browser = playwright.chromium.connect_over_cdp('http://127.0.0.1:${DESKTOP_CDP_PORT}')
    context = browser.contexts[0]
    page = context.pages[0]
    page.goto(os.environ['PROBE_URL'], wait_until='domcontentloaded')
    cookies = context.cookies(os.environ['PROBE_URL'])
    cookie = next((cookie for cookie in cookies if cookie['name'] == 'duet_shared_login'), None)
    assert cookie is not None and cookie['value'] == 'native-probe'
    print(f"PERSISTED_COOKIE={cookie['name']}={cookie['value']}")
PY
test "$(dpkg-query -W -f='\${Version}' google-chrome-stable)" = '${DESKTOP_CHROME_VERSION}'
test "$(systemctl is-active duet-desktop.target)" = active
test "$(systemctl is-active duet-desktop.service)" = active
test "$(systemctl is-active duet-desktop-browser.service)" = active
test ! -e /etc/apt/sources.list.d/google-chrome.list
test ! -e /etc/apt/sources.list.d/google-chrome.sources
echo "CHROME_VERSION=$(dpkg-query -W -f='\${Version}' google-chrome-stable)"
echo "CDP_BROWSER=$(jq -r .Browser <<<"$cdp")"
echo "CDP_WEBSOCKET=$(jq -r .webSocketDebuggerUrl <<<"$cdp")"
echo "WM_CLASS=$wm_class"
echo "GEOMETRY=$(sed -n -e 's/^  Absolute upper-left X:  */x=/p' -e 's/^  Absolute upper-left Y:  */y=/p' -e 's/^  Width: /width=/p' -e 's/^  Height: /height=/p' <<<"$window_info" | paste -sd, -)"
echo "PROFILE_MARKER=$profile_marker"`,
    180_000,
  )

  evidence.chromeVersion = marker(output, 'CHROME_VERSION')
  evidence.cdpBrowser = marker(output, 'CDP_BROWSER')
  evidence.webSocketDebuggerUrl = marker(output, 'CDP_WEBSOCKET')
  evidence.wmClass = marker(output, 'WM_CLASS')
  evidence.geometry = marker(output, 'GEOMETRY')
  evidence.profileMarker = marker(output, 'PROFILE_MARKER')
  evidence.pageTitle = marker(output, 'AGENT_PAGE_TITLE')
  evidence.persistedCookie = marker(output, 'PERSISTED_COOKIE')
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error)
} finally {
  const cleaned = await cleanup(ctx)
  evidence.deleted = cleaned.deleted
  if (cleaned.deleteErrors.length > 0) {
    evidence.failure = `${evidence.failure}\n${cleaned.deleteErrors.join('\n')}`.trim()
  }
  try {
    await assertNoDuetTestVms(ctx.control)
    evidence.noLeaks = true
  } catch (error) {
    evidence.failure =
      `${evidence.failure}\n${error instanceof Error ? error.message : String(error)}`.trim()
  }
}

await mkdir(fileURLToPath(PROBE_REPORTS_DIR), { recursive: true })
await writeFile(
  reportUrl,
  `# Shared Chrome native probe

Date: ${new Date().toISOString()}

## Verdict

${evidence.failure ? `Failed: ${evidence.failure.split('\n')[0]}` : 'Passed: one systemd-owned headful Chrome uses the shared durable profile and loopback-only CDP on native exe.dev.'}

## Evidence

- VM: \`${evidence.vmName}\`
- Image: \`${evidence.imageRef}\`
- Control-plane create: ${ms(evidence.createMs)}
- Boot to SSH: ${ms(evidence.sshReadyMs)}
- Chrome: \`${evidence.chromeVersion || 'unmeasured'}\` / \`${evidence.cdpBrowser || 'unmeasured'}\`
- CDP: \`${evidence.webSocketDebuggerUrl || 'unmeasured'}\`
- Window class: \`${evidence.wmClass || 'unmeasured'}\`
- Geometry: \`${evidence.geometry || 'unmeasured'}\`
- Agent-driven visible page: \`${evidence.pageTitle || 'unmeasured'}\`
- Cookie after Chrome restart: \`${evidence.persistedCookie || 'unmeasured'}\`
- Profile restart witness: \`${evidence.profileMarker || 'unmeasured'}\`
- Deleted: ${evidence.deleted.map(vm => `\`${vm}\``).join(', ') || 'none'}
- Leak check: ${evidence.noLeaks ? 'no `duet-test-*` VMs remain' : 'failed'}
`,
)

console.log(`wrote ${fileURLToPath(reportUrl)}`)
if (evidence.failure) throw new Error(evidence.failure)
