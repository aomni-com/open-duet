/**
 * Verifies that a built VM image has the expected toolchain installed, by
 * running probe commands inside a throwaway container.
 *
 * This mirrors the verification the E2B template build does
 * (chat-app/packages/sandbox-build) — build the image, then boot it and check
 * every CLI and library is actually present and runnable. E2B-specific checks
 * (the /home/user↔/home/app symlink, passwordless sudo, disk size) are dropped;
 * this is about "are the packages installed correctly".
 *
 * Usage (standalone):
 *   IMAGE_REF=duet-vm-image:local bun run scripts/verify-image.ts
 *
 * `scripts/build.ts` calls verifyImage() after building and before pushing.
 */
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DESKTOP_CDP_PORT,
  DESKTOP_CHROME_VERSION,
  DESKTOP_KASM_AUTH_PATH,
  DESKTOP_LOOPBACK_PORT,
  DESKTOP_SCREEN,
} from '@repo/contract'

import { REQUIRED_TOOLS } from '../src/required-tools'

interface VerificationStep {
  name: string
  command: string
  dockerArgs?: string[]
}

/** The pinned Syncthing release (MAP-SYNC V1) — kept in lockstep with the
 * Dockerfile ARG SYNCTHING_VERSION and the gateway/Mac bundles. */
export const EXPECTED_SYNCTHING_VERSION = 'v2.1.2'

const REQUIRED_BINARY_STEPS: VerificationStep[] = REQUIRED_TOOLS.binaries.map(tool => ({
  name: `Required CLI: ${tool.name}`,
  command: `set -euo pipefail
command -v ${tool.name}
${tool.probe}`,
}))

const REQUIRED_PYTHON_STEPS: VerificationStep[] = REQUIRED_TOOLS.pythonModules.map(tool => ({
  name: `Required Python module: ${tool.module}`,
  command: `set -euo pipefail
python3 -c "import ${tool.module}; print('${tool.module} OK')"`,
}))

const VERIFICATION_STEPS: VerificationStep[] = [
  {
    name: 'Base runtime tools',
    command: `set -euo pipefail
npm --version
test "$(bun --version)" = 1.3.14
test "$(/opt/duet/gateway-runtime/bin/bun --version)" = 1.4.2
python3 -m pip --version
rg --version | sed -n '1p'`,
  },
  {
    name: 'Errored response streams survive garbage collection',
    command: '/opt/duet/gateway-runtime/bin/bun /tmp/bun-stream-gc-probe.ts',
    dockerArgs: [
      '-v',
      `${join(import.meta.dir, 'bun-stream-gc-probe.ts')}:/tmp/bun-stream-gc-probe.ts:ro`,
    ],
  },
  ...REQUIRED_BINARY_STEPS,
  ...REQUIRED_PYTHON_STEPS,
  {
    name: 'Additional baked Python packages',
    command: `set -euo pipefail
python3 -c "import numpy; print('numpy', numpy.__version__)"
python3 -c "import matplotlib; print('matplotlib', matplotlib.__version__)"
python3 -c "import imageio; print('imageio', imageio.__version__)"`,
  },
  {
    name: 'LibreOffice real document conversions',
    command: `set -euo pipefail
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT
WORKDIR="$workdir" python3 - <<'PY'
import os
from docx import Document
from pptx import Presentation

workdir = os.environ['WORKDIR']
document = Document()
document.add_paragraph('Duet DOCX conversion probe')
document.save(os.path.join(workdir, 'fixture.docx'))

presentation = Presentation()
slide = presentation.slides.add_slide(presentation.slide_layouts[0])
slide.shapes.title.text = 'Duet PPTX conversion probe'
presentation.save(os.path.join(workdir, 'fixture.pptx'))
PY
soffice --headless --convert-to pdf --outdir "$workdir" "$workdir/fixture.docx"
test -s "$workdir/fixture.pdf"
rm "$workdir/fixture.pdf"
soffice --headless --convert-to pdf --outdir "$workdir" "$workdir/fixture.pptx"
test -s "$workdir/fixture.pdf"
echo 'soffice DOCX and PPTX conversions OK'`,
  },
  {
    name: 'npm CLI tools',
    command: `set -euo pipefail
tsc --version
eslint --version
prettier --version
skills --version
firecrawl --help | sed -n '1p'`,
  },
  {
    name: 'Managed runtime bootstrap and CLI',
    command: `set -euo pipefail
state="$(mktemp -d)"
trap 'rm -rf "$state"' EXIT
chown exedev:exedev "$state"
runuser -u exedev -- env DUET_STATE_DIR="$state" /opt/duet/gateway-runtime/bin/bun /opt/duet/bin/runtime-bootstrap.js
case "$(readlink /opt/duet/current)" in releases/*) ;; *) exit 1 ;; esac
test "$(readlink /usr/local/bin/duet)" = /opt/duet/current/duet
test "$(command -v duet)" = /usr/local/bin/duet
runuser -u exedev -- test -w /opt/duet/releases
runuser -u exedev -- duet -v
! command -v duetfs
test ! -e /home/exedev/.duet/cli-rail`,
  },
  {
    name: 'Fresh registration and model credential handoff',
    dockerArgs: [
      '--network',
      'none',
      '--volume',
      `${join(import.meta.dir, 'fresh-runtime-probe.ts')}:/tmp/fresh-runtime-probe.ts:ro`,
    ],
    command: `set -euo pipefail
bun /tmp/fresh-runtime-probe.ts`,
  },
  {
    name: 'Controlled CLI RPC, image, grep, and durable memory',
    dockerArgs: [
      '--network',
      'none',
      '--volume',
      `${join(import.meta.dir, '../../..', 'specs/done/unified-duet/assets/runtime-constructor/probe.ts')}:/tmp/runtime-probe.ts:ro`,
    ],
    command: `set -euo pipefail
PROBE_COMMAND='["/usr/bin/env","/usr/local/bin/duet"]' PROBE_EVIDENCE=/verification-output timeout 150s bun /tmp/runtime-probe.ts`,
  },
  {
    name: 'Native CLI terminal initialization',
    dockerArgs: [
      '--network',
      'none',
      '--volume',
      `${join(import.meta.dir, '../../..', 'specs/done/unified-duet/assets/packaging/compare.py')}:/tmp/compare-tui.py:ro`,
    ],
    command: `set -euo pipefail
set +e
HOME=/tmp TERM=xterm-256color timeout 8s script -q -c 'stty cols 120 rows 40; duet --incognito --no-auto-upgrade --model duet:anthropic/claude-haiku-4-5' /verification-output/tui.ansi >/verification-output/tui.stdout 2>/verification-output/tui.stderr
code=$?
set -e
test "$code" = 124
python3 /tmp/compare-tui.py --tui /verification-output/tui.ansi`,
  },
  {
    name: 'static-web-server HTTP behavior',
    command: `set -euo pipefail
workdir="$(mktemp -d)"
server_pid=''
server_log="$workdir/server.log"
response_body="$workdir/response-body"

stop_server() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    server_pid=''
  fi
}

cleanup() {
  stop_server
  rm -rf "$workdir"
}
trap cleanup EXIT

choose_port() {
  python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    print(sock.getsockname()[1])
PY
}

wait_for_status() {
  local path="$1"
  local expected="$2"
  local status=''
  for _ in {1..50}; do
    status="$(curl -sS -o "$response_body" -w '%{http_code}' "http://127.0.0.1:$port$path" || true)"
    if [[ "$status" = "$expected" ]]; then
      return
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      cat "$server_log" >&2
      return 1
    fi
    sleep 0.1
  done
  cat "$server_log" >&2
  echo "timed out waiting for $path to return $expected (last status: $status)" >&2
  return 1
}

index_body='Duet static-web-server index'
nested_body='Duet nested route'
mkdir -p "$workdir/site/nested/route" "$workdir/empty"
printf '%s' "$index_body" > "$workdir/site/index.html"
printf '%s' "$nested_body" > "$workdir/site/nested/route/page.html"

cd "$workdir/site"
port="$(choose_port)"
static-web-server -p "$port" -d . >"$server_log" 2>&1 &
server_pid=$!
wait_for_status "/nested/route/page.html" 200
test "$(cat "$response_body")" = "$nested_body"
wait_for_status "/missing-route" 404
stop_server

port="$(choose_port)"
static-web-server -p "$port" -d . --page-fallback ./index.html >"$server_log" 2>&1 &
server_pid=$!
wait_for_status "/missing-route" 200
test "$(cat "$response_body")" = "$index_body"
stop_server

cd "$workdir/empty"
port="$(choose_port)"
static-web-server -p "$port" -d . >"$server_log" 2>&1 &
server_pid=$!
wait_for_status "/" 404
echo 'static-web-server static, SPA fallback, and empty-root 404 probes OK'`,
  },
  {
    name: 'KasmVNC desktop framebuffer',
    // Docker Desktop blocks the user namespace Chrome's sandbox creates by
    // default. These capabilities belong only to the disposable verifier
    // container; the shipped browser keeps its sandbox and needs no flags.
    dockerArgs: ['--shm-size=1g', '--cap-add=SYS_ADMIN', '--security-opt=seccomp=unconfined'],
    command: `set -euo pipefail
# The verifier starts services directly; systemd normally supplies this at boot.
if [[ ! -s /etc/machine-id ]]; then dbus-uuidgen > /etc/machine-id; fi
workdir="$(mktemp -d)"
chown exedev:exedev "$workdir"
gateway_log="$workdir/gateway.log"
gateway_pid=''

cleanup() {
  pkill -TERM -x chrome >/dev/null 2>&1 || true
  test -z "$gateway_pid" || kill "$gateway_pid" >/dev/null 2>&1 || true
  runuser -u exedev -- env HOME=/home/exedev /usr/bin/kasmvncserver -kill :1 >/dev/null 2>&1 || true
  rm -rf "$workdir"
}
trap cleanup EXIT

printf '%s\n' verification-vm-token > /home/exedev/.duet/vm-token
chown exedev:exedev /home/exedev/.duet/vm-token
chmod 600 /home/exedev/.duet/vm-token
runuser -u exedev -- env \
  HOME=/home/exedev \
  PORT=3000 \
  DUET_STATE_DIR=/home/exedev/.duet \
  DUET_DRIVE_DIR=/home/exedev/drive \
  /opt/duet/gateway-runtime/bin/bun /opt/duet/current/index.js >"$gateway_log" 2>&1 &
gateway_pid=$!
for _ in {1..300}; do
  if curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1; then break; fi
  if ! kill -0 "$gateway_pid" 2>/dev/null; then cat "$gateway_log" >&2; exit 1; fi
  sleep 0.1
done
curl -fsS http://127.0.0.1:3000/healthz >/dev/null

started_at="$(date +%s%3N)"
test -z "$(find /etc/systemd/system /usr/lib/systemd/system -type l -lname '*kasm*' -print -quit)"
! grep -qx 'Requires=duet-desktop.service' /etc/systemd/system/duet-desktop-browser.service
grep -qx 'Requires=duet-desktop.service' /etc/systemd/system/duet-desktop.target
grep -qx 'Wants=duet-desktop-browser.service' /etc/systemd/system/duet-desktop.target
test ! -e ${DESKTOP_KASM_AUTH_PATH}
test ! -e /home/exedev/.kasmpasswd
runuser -u exedev -- /opt/duet/bin/ensure-kasm-credentials.sh
username="$(jq -er .username ${DESKTOP_KASM_AUTH_PATH})"
password="$(jq -er .password ${DESKTOP_KASM_AUTH_PATH})"
test "$(stat -c '%U:%a' ${DESKTOP_KASM_AUTH_PATH})" = 'exedev:600'
runuser -u exedev -- /opt/duet/bin/ensure-kasm-credentials.sh
persisted_password="$(jq -er .password ${DESKTOP_KASM_AUTH_PATH})"
test "$password" = "$persisted_password"
runuser -u exedev -- env HOME=/home/exedev /usr/bin/kasmvncserver :1

status=''
for _ in {1..100}; do
  status="$(curl -sS -u "$username:$password" -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${DESKTOP_LOOPBACK_PORT}/' || true)"
  if [[ "$status" = 200 ]]; then
    break
  fi
  if ! pgrep -x Xvnc >/dev/null; then
    cat /home/exedev/.vnc/*.log >&2
    exit 1
  fi
  sleep 0.1
done
test "$status" = 200
test "$(curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${DESKTOP_LOOPBACK_PORT}/')" = 401
desktop_html="$(curl -fsS -u "$username:$password" 'http://127.0.0.1:${DESKTOP_LOOPBACK_PORT}/')"
grep -F '<title>Duet</title>' <<<"$desktop_html" >/dev/null
grep -F '<span>Duet Desktop</span>' <<<"$desktop_html" >/dev/null
grep -F 'href="./duet-branding.css"' <<<"$desktop_html" >/dev/null
! grep -F 'href="./assets/368_kasm_logo_only_' <<<"$desktop_html"
branding_css="$(curl -fsS -u "$username:$password" 'http://127.0.0.1:${DESKTOP_LOOPBACK_PORT}/duet-branding.css')"
grep -F '@keyframes duet-desktop-loading' <<<"$branding_css" >/dev/null
curl -fsS -u "$username:$password" -o /dev/null \
  'http://127.0.0.1:${DESKTOP_LOOPBACK_PORT}/duet-avatar.png'

display_info="$(runuser -u exedev -- env HOME=/home/exedev DISPLAY=:1 xdpyinfo)"
dimensions="$(sed -n 's/^  dimensions:[[:space:]]*//p' <<<"$display_info")"
case "$dimensions" in
  '${DESKTOP_SCREEN.width}x${DESKTOP_SCREEN.height} pixels'*) ;;
  *) echo "unexpected display dimensions: $dimensions" >&2; exit 1 ;;
esac

framebuffer="$workdir/framebuffer.png"
framebuffer_ready=false
for _ in {1..100}; do
  runuser -u exedev -- env HOME=/home/exedev DISPLAY=:1 import -window root "$framebuffer"
  if FRAMEBUFFER="$framebuffer" python3 - <<'PY'
import os
from PIL import Image, ImageChops

with Image.open(os.environ['FRAMEBUFFER']).convert('RGB') as image:
    if image.size != (${DESKTOP_SCREEN.width}, ${DESKTOP_SCREEN.height}):
        raise SystemExit(f'unexpected framebuffer size: {image.size}')
    flat = Image.new('RGB', image.size, image.getpixel((0, 0)))
    if ImageChops.difference(image, flat).getbbox() is None:
        raise SystemExit('framebuffer is a single blank color')
print('framebuffer PNG is ${DESKTOP_SCREEN.width}x${DESKTOP_SCREEN.height} and nonblank')
PY
  then
    framebuffer_ready=true
    break
  fi
  if ! pgrep -x xfce4-session >/dev/null; then
    cat /home/exedev/.vnc/*.log >&2
    exit 1
  fi
  sleep 0.1
done
if [[ "$framebuffer_ready" != true ]]; then
  echo 'desktop framebuffer remained blank after 10 seconds' >&2
  exit 1
fi
ready_at="$(date +%s%3N)"

test "$(fc-match -f '%{family}' Inter | cut -d, -f1)" = Inter
test "$(fc-match -f '%{family}' 'Noto Sans' | cut -d, -f1)" = 'Noto Sans'
for _ in {1..100}; do
  if pgrep -x xfce4-panel >/dev/null \
    && pgrep -x devilspie2 >/dev/null \
    && pgrep -x plank >/dev/null; then
    break
  fi
  sleep 0.1
done
pgrep -x xfce4-panel
pgrep -x devilspie2
pgrep -x plank

xfconf() {
  runuser -u exedev -- env HOME=/home/exedev DISPLAY=:1 xfconf-query "$@"
}
test "$(xfconf -c xsettings -p /Net/ThemeName)" = 'WhiteSur-Light-solid'
test "$(xfconf -c xsettings -p /Net/IconThemeName)" = 'WhiteSur'
test "$(xfconf -c xsettings -p /Gtk/FontName)" = 'Inter 10'
test "$(xfconf -c xfwm4 -p /general/theme)" = 'WhiteSur-Light-solid'
test "$(xfconf -c xfce4-desktop -p /desktop-icons/style)" = 0
test "$(xfconf -c xfce4-desktop -p /backdrop/screen0/monitorVNC-0/workspace0/last-image)" = '/usr/share/backgrounds/duet-wallpaper.png'

dock_items="$(runuser -u exedev -- env HOME=/home/exedev DISPLAY=:1 \
  gsettings get net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/ dock-items)"
dock_browser_count="$(grep -o 'duet-browser.dockitem' <<<"$dock_items" | wc -l)"
test "$dock_browser_count" = 1
test "$(runuser -u exedev -- env HOME=/home/exedev DISPLAY=:1 \
  gsettings get net.launchpad.plank.dock.settings:/net/launchpad/plank/docks/dock1/ hide-mode)" = "'none'"
grep -Fx 'LineWidth=4' /usr/share/plank/themes/WhiteSur/dock.theme
grep -Fx 'FillEndColor=209;;209;;209;;50' /usr/share/plank/themes/WhiteSur/dock.theme

xvnc_pid="$(pgrep -xo Xvnc)"
xvnc_argv="$(tr '\\0' ' ' < "/proc/$xvnc_pid/cmdline")"
echo "$xvnc_argv"
grep -F -- '-interface 127.0.0.1' <<<"$xvnc_argv"
grep -F -- '-DLP_ClipSendMax 16777216' <<<"$xvnc_argv"
grep -F -- '-DLP_ClipAcceptMax 16777216' <<<"$xvnc_argv"

test "$(dpkg-query -W -f='\${Version}' google-chrome-stable)" = '${DESKTOP_CHROME_VERSION}'
apt-mark showhold | grep -Fx google-chrome-stable
test ! -e /etc/apt/sources.list.d/google-chrome.list
test ! -e /etc/apt/sources.list.d/google-chrome.sources
test ! -e /etc/cron.daily/google-chrome
test ! -e /usr/share/applications/com.google.Chrome.desktop
test ! -e /usr/share/applications/google-chrome.desktop
test ! -e /usr/share/applications/xfce4-web-browser.desktop
test -e /usr/share/applications/duet-browser.desktop
test -x /opt/duet/bin/start-shared-chrome
test -s /opt/duet/browser-extension/extension.crx
extension_id="$(jq -r '.ExtensionInstallForcelist[0] | split(";")[0]' /etc/opt/chrome/policies/managed/duet-browser-extension.json)"
grep -Ex '[a-p]{32}' <<<"$extension_id"
grep -F "$extension_id;http://127.0.0.1:3000/v1/desktop/browser-extension/update.xml" \
  /etc/opt/chrome/policies/managed/duet-browser-extension.json
curl -fsS http://127.0.0.1:3000/v1/desktop/browser-extension/update.xml \
  | grep -F "$extension_id"
test "$(curl -fsS http://127.0.0.1:3000/v1/desktop/browser-extension/extension.crx | wc -c)" -gt 1000

browser_log="$workdir/chrome.log"
runuser -u exedev -- env HOME=/home/exedev DISPLAY=:1 \
  BAMF_DESKTOP_FILE_HINT=/usr/share/applications/duet-browser.desktop \
  CHROME_DESKTOP=duet-browser.desktop \
  /opt/duet/bin/start-shared-chrome >"$browser_log" 2>&1 &
browser_pid=$!

cdp=''
for _ in {1..600}; do
  cdp="$(curl -fsS 'http://127.0.0.1:${DESKTOP_CDP_PORT}/json/version' 2>/dev/null || true)"
  if jq -e '.webSocketDebuggerUrl | startswith("ws://127.0.0.1:${DESKTOP_CDP_PORT}/")' <<<"$cdp" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$browser_pid" 2>/dev/null; then
    cat "$browser_log" >&2
    exit 1
  fi
  sleep 0.1
done
if ! jq -e '.webSocketDebuggerUrl | startswith("ws://127.0.0.1:${DESKTOP_CDP_PORT}/")' <<<"$cdp" >/dev/null; then
  cat "$browser_log" >&2
  echo 'Chrome CDP did not become ready on loopback' >&2
  exit 1
fi

extension_status=''
for _ in {1..600}; do
  extension_status="$(curl -fsS \
    -H 'Authorization: Bearer verification-vm-token' \
    http://127.0.0.1:3000/v1/desktop/browser-extension/status 2>/dev/null || true)"
  if jq -e '.connected == true and (.snapshot.windows | type == "array")' \
    <<<"$extension_status" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$browser_pid" 2>/dev/null; then cat "$browser_log" >&2; exit 1; fi
  sleep 0.1
done
if ! jq -e '.connected == true and (.snapshot.windows | type == "array")' \
  <<<"$extension_status" >/dev/null 2>&1; then
  cat "$gateway_log" >&2
  cat "$browser_log" >&2
  echo 'Duet browser extension did not connect and execute snapshot' >&2
  exit 1
fi

window_id=''
window_info=''
for _ in {1..300}; do
  window_id="$(runuser -u exedev -- env DISPLAY=:1 xwininfo -root -tree | awk '/Google Chrome/ { print $1; exit }')"
  if [[ -n "$window_id" ]]; then
    window_info="$(runuser -u exedev -- env DISPLAY=:1 xwininfo -id "$window_id")"
    if grep -F 'Map State: IsViewable' <<<"$window_info" >/dev/null \
      && grep -F 'Width: 1296' <<<"$window_info" >/dev/null \
      && grep -F 'Height: 720' <<<"$window_info" >/dev/null \
      && grep -F 'Absolute upper-left X:  72' <<<"$window_info" >/dev/null \
      && grep -F 'Absolute upper-left Y:  48' <<<"$window_info" >/dev/null; then
      break
    fi
  fi
  sleep 0.1
done
test -n "$window_id"
grep -F 'Map State: IsViewable' <<<"$window_info"
grep -F 'Width: 1296' <<<"$window_info"
grep -F 'Height: 720' <<<"$window_info"
grep -F 'Absolute upper-left X:  72' <<<"$window_info"
grep -F 'Absolute upper-left Y:  48' <<<"$window_info"
wm_class="$(runuser -u exedev -- env DISPLAY=:1 xprop -id "$window_id" WM_CLASS)"
# X11's second WM_CLASS string is the launcher-matching class set by
# --class; Chrome derives the first (instance) string from its profile.
grep -E 'WM_CLASS.*"duet-browser"$' <<<"$wm_class"
sleep 1
runuser -u exedev -- env HOME=/home/exedev DISPLAY=:1 import -window root "$framebuffer"
cp "$framebuffer" /verification-output/framebuffer.png

echo "KasmVNC ready in $((ready_at - started_at)) ms on 127.0.0.1:${DESKTOP_LOOPBACK_PORT}; $dimensions"`,
  },
  {
    // MAP-SYNC V1: the SHA-pinned Syncthing must be exactly the expected
    // version — never the auto-upgrading apt package (a drifted pin breaks the
    // slice-18 event-shape contract). mirror convergence check.
    name: 'Syncthing pin',
    command: `set -euo pipefail
version="$(syncthing --version | sed -n '1p' | awk '{print $2}')"
echo "syncthing $version"
test "$version" = "${EXPECTED_SYNCTHING_VERSION}"`,
  },
]

export async function verifyImage(imageRef: string, framebufferPath?: string): Promise<void> {
  const outputDir = await mkdtemp(join(tmpdir(), 'duet-image-verification-'))
  try {
    console.log(`Verifying image ${imageRef}...`)
    for (const step of VERIFICATION_STEPS) {
      console.log(`  Checking ${step.name}...`)
      const output = await runInImage(imageRef, step.command, outputDir, step.dockerArgs)
      for (const line of output.trim().split('\n')) {
        if (line) console.log(`    ${line}`)
      }
    }
    if (framebufferPath) {
      await mkdir(dirname(framebufferPath), { recursive: true })
      await copyFile(join(outputDir, 'framebuffer.png'), framebufferPath)
      console.log(`Saved framebuffer to ${framebufferPath}`)
    }
    console.log('Verification complete!')
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
}

function runInImage(
  imageRef: string,
  command: string,
  outputDir: string,
  dockerArgs: string[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Override the systemd entrypoint so we run a plain login shell; the image's
    // ENV PATH already carries workspace Bun, so `bun`/`duet` resolve here.
    const child = spawn(
      'docker',
      [
        'run',
        '--rm',
        ...dockerArgs,
        '--volume',
        `${outputDir}:/verification-output`,
        '--entrypoint',
        'bash',
        imageRef,
        '-lc',
        command,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolve(stdout)
      else
        reject(
          new Error(
            `verification step failed (exit ${code}):\n${stderr}${stderr && stdout ? '\n' : ''}${stdout}`,
          ),
        )
    })
  })
}

if (import.meta.main) {
  const imageRef = process.env.IMAGE_REF
  if (!imageRef) {
    throw new Error('IMAGE_REF is required, for example IMAGE_REF=duet-vm-image:local')
  }
  await verifyImage(imageRef, process.env.DESKTOP_FRAMEBUFFER_PATH)
}
