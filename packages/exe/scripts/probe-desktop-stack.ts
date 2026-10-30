/// <reference lib="dom" />

import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import { chromium, type Browser, type Page } from '@playwright/test'

import {
  DESKTOP_KASM_AUTH_PATH,
  DESKTOP_LOOPBACK_PORT,
  DESKTOP_SCREEN,
  desktopViewerPath,
} from '@repo/contract'

import { ExeClient } from '../src/exe.ts'
import { PROBE_REPORTS_DIR, probeReportUrl } from './probe-artifacts.ts'
import {
  assertNoDuetTestVms,
  cleanup,
  createVm,
  fenced,
  makeContext,
  ms,
  runOrThrow,
  vmName,
} from './probe-common.ts'

const imageRef = process.env.IMAGE_REF
if (!imageRef) {
  throw new Error('IMAGE_REF is required (use the pushed image tag or immutable digest)')
}

const baseImageRef =
  process.env.BASE_IMAGE_REF ??
  'ghcr.io/boldsoftware/exeuntu@sha256:77b1187c8329a8c38f6f02ccf3d0f1fdf75262d2f1017d2e321140409ef215d1'
const framebufferUrl = probeReportUrl('vm-desktop-slice04-public.png')
const reportUrl = probeReportUrl('vm-desktop-slice04.md')
const PUBLIC_IDLE_PROOF_MS = 260_000

interface ProbeEvidence {
  vmName: string
  imageRef: string
  baseImageRef: string
  createMs?: number
  sshReadyMs?: number
  desktopStartMs?: number
  coldStartMs?: number
  dimensions?: string
  imageBytes?: number
  baseImageBytes?: number
  imageDeltaBytes?: number
  framebufferBytes?: number
  framebufferSha256?: string
  publicUrl?: string
  publicCanvas?: string
  publicInput?: boolean
  clipboardUp?: boolean
  clipboardDown?: boolean
  windowMoved?: boolean
  publicIdleMs?: number
  publicSocketCount?: number
  publicSocketCloses?: number
  publicCpuPercent?: number
  targetReaped?: boolean
  deleted: string[]
  noLeaks: boolean
  failure?: string
}

function execFileAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${file} ${args.join(' ')} failed\n${stderr || stdout}`))
      } else {
        resolve(stdout.trim())
      }
    })
  })
}

async function imageSize(ref: string): Promise<number> {
  const raw = await execFileAsync('docker', ['image', 'inspect', '--format', '{{.Size}}', ref])
  const bytes = Number(raw)
  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error(`docker reported an invalid image size for ${ref}: ${raw}`)
  }
  return bytes
}

async function pullImage(ref: string): Promise<void> {
  await execFileAsync('docker', ['pull', '--platform', 'linux/amd64', ref])
}

function marker(output: string, name: string): string {
  const value = output.match(new RegExp(`^${name}=(.+)$`, 'm'))?.[1]
  if (value === undefined) throw new Error(`desktop probe output omitted ${name}`)
  return value
}

function desktopCommand(): string {
  return `set -euo pipefail
cleanup() {
  /usr/bin/kasmvncserver -kill :1 >/dev/null 2>&1 || true
  rm -f /tmp/duet-desktop-framebuffer.png
}
trap cleanup EXIT

started_at="$(date +%s%3N)"
/opt/duet/bin/ensure-kasm-credentials.sh
username="$(jq -er .username ${DESKTOP_KASM_AUTH_PATH})"
password="$(jq -er .password ${DESKTOP_KASM_AUTH_PATH})"
/usr/bin/kasmvncserver :1

status=''
for _ in {1..200}; do
  status="$(curl -sS -u "$username:$password" -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${DESKTOP_LOOPBACK_PORT}/' || true)"
  if [[ "$status" = 200 ]]; then break; fi
  if ! pgrep -x Xvnc >/dev/null; then
    cat /home/exedev/.vnc/*.log >&2
    exit 1
  fi
  sleep 0.1
done
test "$status" = 200
test "$(curl -sS -o /dev/null -w '%{http_code}' 'http://127.0.0.1:${DESKTOP_LOOPBACK_PORT}/')" = 401

display_info="$(DISPLAY=:1 xdpyinfo)"
dimensions="$(sed -n 's/^  dimensions:[[:space:]]*//p' <<<"$display_info")"
case "$dimensions" in
  '${DESKTOP_SCREEN.width}x${DESKTOP_SCREEN.height} pixels'*) ;;
  *) echo "unexpected display dimensions: $dimensions" >&2; exit 1 ;;
esac

framebuffer_ready=false
for _ in {1..100}; do
  DISPLAY=:1 import -window root /tmp/duet-desktop-framebuffer.png
  if FRAMEBUFFER=/tmp/duet-desktop-framebuffer.png python3 - <<'PY'
import os
from PIL import Image, ImageChops

with Image.open(os.environ['FRAMEBUFFER']).convert('RGB') as image:
    if image.size != (${DESKTOP_SCREEN.width}, ${DESKTOP_SCREEN.height}):
        raise SystemExit(f'unexpected framebuffer size: {image.size}')
    flat = Image.new('RGB', image.size, image.getpixel((0, 0)))
    if ImageChops.difference(image, flat).getbbox() is None:
        raise SystemExit('framebuffer is a single blank color')
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

xvnc_pid="$(pgrep -xo Xvnc)"
xvnc_argv="$(tr '\\0' ' ' < "/proc/$xvnc_pid/cmdline")"
grep -F -- '-interface 127.0.0.1' <<<"$xvnc_argv" >/dev/null
grep -F -- '-DLP_ClipSendMax 16777216' <<<"$xvnc_argv" >/dev/null
grep -F -- '-DLP_ClipAcceptMax 16777216' <<<"$xvnc_argv" >/dev/null

echo "DUET_DESKTOP_START_MS=$((ready_at - started_at))"
echo "DUET_DIMENSIONS=$dimensions"
echo "DUET_FRAMEBUFFER_SHA256=$(sha256sum /tmp/duet-desktop-framebuffer.png | cut -d ' ' -f1)"
echo "DUET_FRAMEBUFFER_BASE64=$(base64 -w0 /tmp/duet-desktop-framebuffer.png)"`
}

async function waitForHttp(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (
      await fetch(url)
        .then(response => response.ok)
        .catch(() => false)
    ) {
      return
    }
    await Bun.sleep(500)
  }
  throw new Error(`public gateway did not become healthy at ${new URL(url).origin}`)
}

async function waitForRemoteMarker(
  sshDest: string,
  path: string,
  markerText: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    const output = await ctx.ssh.exec(sshDest, `cat ${path} 2>/dev/null || true`, 15_000)
    if (output.stdout.includes(markerText)) return
    await Bun.sleep(250)
  }
  throw new Error(`remote input witness did not observe ${markerText}`)
}

async function expectPublicCanvas(page: Page): Promise<string> {
  await page.waitForFunction(
    ({ width, height }) => {
      for (const canvas of document.querySelectorAll<HTMLCanvasElement>(
        '#noVNC_container canvas',
      )) {
        if (canvas.width !== width || canvas.height !== height) continue
        const context = canvas.getContext('2d')
        if (context === null) continue
        const pixels = context.getImageData(0, 0, width, height).data
        const first = `${pixels[0]},${pixels[1]},${pixels[2]}`
        for (let offset = 0; offset < pixels.length; offset += 4 * 4096) {
          if (`${pixels[offset]},${pixels[offset + 1]},${pixels[offset + 2]}` !== first) {
            return true
          }
        }
      }
      return false
    },
    DESKTOP_SCREEN,
    { timeout: 60_000 },
  )

  const canvas = page
    .locator(
      `#noVNC_container canvas[width="${DESKTOP_SCREEN.width}"][height="${DESKTOP_SCREEN.height}"]`,
    )
    .first()
  await canvas.screenshot({ path: fileURLToPath(framebufferUrl) })
  return `${DESKTOP_SCREEN.width}x${DESKTOP_SCREEN.height}, nonuniform pixels`
}

async function desktopPoint(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  const canvas = page
    .locator(
      `#noVNC_container canvas[width="${DESKTOP_SCREEN.width}"][height="${DESKTOP_SCREEN.height}"]`,
    )
    .first()
  const box = await canvas.boundingBox()
  if (box === null) throw new Error('desktop canvas has no browser bounding box')
  return {
    x: box.x + (x / DESKTOP_SCREEN.width) * box.width,
    y: box.y + (y / DESKTOP_SCREEN.height) * box.height,
  }
}

function xWindowPosition(output: string): { x: number; y: number } {
  const x = Number(output.match(/Absolute upper-left X:\s+(-?\d+)/)?.[1])
  const y = Number(output.match(/Absolute upper-left Y:\s+(-?\d+)/)?.[1])
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error('xwininfo omitted window position')
  return { x, y }
}

async function runPublicBrowserProbe(
  sshDest: string,
  publicOrigin: string,
  vmToken: string,
  browserToken: string,
  grantId: string,
  evidence: ProbeEvidence,
): Promise<void> {
  const grantResponse = await fetch(`${publicOrigin}/v1/desktop/grants`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${vmToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      grantId,
      tokenDigest: createHash('sha256').update(browserToken).digest('hex'),
      expiresAt: Date.now() + 15 * 60 * 1000,
    }),
  })
  if (!grantResponse.ok) throw new Error(`desktop grant failed with HTTP ${grantResponse.status}`)

  const browser: Browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: DESKTOP_SCREEN })
  let socketCount = 0
  let socketCloses = 0
  page.on('websocket', socket => {
    if (!socket.url().includes('websockify')) return
    socketCount += 1
    socket.on('close', () => (socketCloses += 1))
  })

  try {
    await page.goto(new URL(desktopViewerPath(grantId, browserToken), publicOrigin).toString(), {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    })
    evidence.publicCanvas = await expectPublicCanvas(page)

    await runOrThrow(
      ctx.ssh,
      sshDest,
      'rm -f /tmp/duet-public-xev.log; nohup env DISPLAY=:1 xev -event keyboard -event button -geometry 420x240+480+280 >/tmp/duet-public-xev.log 2>&1 </dev/null &',
    )
    await Bun.sleep(1_000)
    const witness = await desktopPoint(page, 690, 430)
    await page.mouse.click(witness.x, witness.y)
    await page.keyboard.type('duet-public-input')
    await page.mouse.click(witness.x + 10, witness.y + 10)
    await waitForRemoteMarker(sshDest, '/tmp/duet-public-xev.log', 'KeyPress')
    await waitForRemoteMarker(sshDest, '/tmp/duet-public-xev.log', 'ButtonPress')
    evidence.publicInput = true

    await page
      .locator('#noVNC_clipboard_button')
      .evaluate(element => (element as HTMLElement).click())
    const clipboard = page.locator('#noVNC_clipboard_text')
    await clipboard.evaluate((element: HTMLTextAreaElement) => {
      element.value = 'browser-to-vm-duet'
    })
    await clipboard.dispatchEvent('change')
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const remote = await ctx.ssh.exec(
        sshDest,
        'DISPLAY=:1 xclip -selection clipboard -o 2>/dev/null || true',
        15_000,
      )
      if (remote.stdout.trim() === 'browser-to-vm-duet') {
        evidence.clipboardUp = true
        break
      }
      await Bun.sleep(250)
    }
    if (!evidence.clipboardUp) throw new Error('browser-to-VM clipboard did not arrive')

    await runOrThrow(
      ctx.ssh,
      sshDest,
      "printf '%s' 'vm-to-browser-duet' > /tmp/duet-public-clipboard; nohup env DISPLAY=:1 xclip -selection clipboard -i </tmp/duet-public-clipboard >/tmp/duet-public-xclip.log 2>&1 &",
    )
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLTextAreaElement>('#noVNC_clipboard_text')?.value ===
        'vm-to-browser-duet',
      undefined,
      { timeout: 15_000 },
    )
    evidence.clipboardDown = true
    await page
      .locator('#noVNC_clipboard_button')
      .evaluate(element => (element as HTMLElement).click())

    const before = xWindowPosition(
      await runOrThrow(ctx.ssh, sshDest, "DISPLAY=:1 xwininfo -name 'Event Tester'"),
    )
    const titleBar = await desktopPoint(page, before.x + 200, before.y - 12)
    const titleDragEnd = await desktopPoint(page, before.x + 360, before.y + 88)
    await page.mouse.move(titleBar.x, titleBar.y)
    await page.mouse.down()
    await page.mouse.move(titleDragEnd.x, titleDragEnd.y, { steps: 12 })
    await page.mouse.up()
    await Bun.sleep(500)
    const after = xWindowPosition(
      await runOrThrow(ctx.ssh, sshDest, "DISPLAY=:1 xwininfo -name 'Event Tester'"),
    )
    evidence.windowMoved = before.x !== after.x || before.y !== after.y
    if (!evidence.windowMoved) throw new Error('browser input did not move the remote X window')

    const cpuSample = runOrThrow(
      ctx.ssh,
      sshDest,
      `set -euo pipefail
pid="$(pgrep -xo Xvnc)"
ticks="$(getconf CLK_TCK)"
before="$(awk '{print $14 + $15}' "/proc/$pid/stat")"
sleep 10
after="$(awk '{print $14 + $15}' "/proc/$pid/stat")"
awk -v delta="$((after - before))" -v ticks="$ticks" 'BEGIN { printf "DUET_PUBLIC_CPU_PERCENT=%.2f\\n", delta * 10 / ticks }'`,
      30_000,
    )
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await page.mouse.wheel(0, attempt % 2 === 0 ? 240 : -240)
      await Bun.sleep(200)
    }
    evidence.publicCpuPercent = Number(marker(await cpuSample, 'DUET_PUBLIC_CPU_PERCENT'))

    const idleStartedAt = performance.now()
    await Bun.sleep(PUBLIC_IDLE_PROOF_MS)
    evidence.publicIdleMs = performance.now() - idleStartedAt
    evidence.publicSocketCount = socketCount
    evidence.publicSocketCloses = socketCloses
    if (socketCount !== 1 || socketCloses !== 0) {
      throw new Error(
        `public desktop socket continuity failed: opened=${socketCount} closed=${socketCloses}`,
      )
    }

    await runOrThrow(
      ctx.ssh,
      sshDest,
      'pkill -x xev || true; rm -f /tmp/duet-public-xev.log; nohup env DISPLAY=:1 xev -event keyboard -event button -geometry 420x240+480+280 >/tmp/duet-public-xev.log 2>&1 </dev/null &',
    )
    await Bun.sleep(1_000)
    const freshWitness = await desktopPoint(page, 690, 430)
    await page.mouse.click(freshWitness.x, freshWitness.y)
    await page.keyboard.type('after-public-idle')
    await waitForRemoteMarker(sshDest, '/tmp/duet-public-xev.log', 'KeyPress')
  } finally {
    await browser.close()
  }

  const deadline = performance.now() + 30_000
  while (performance.now() < deadline) {
    const state = await ctx.ssh.exec(
      sshDest,
      'sudo -n systemctl is-active duet-desktop.target 2>/dev/null || true',
      15_000,
    )
    if (state.stdout.trim() === 'inactive') {
      evidence.targetReaped = true
      return
    }
    await Bun.sleep(1_000)
  }
  throw new Error('desktop target did not reap after the public viewer detached')
}

function mib(bytes: number | undefined): string {
  return bytes === undefined ? 'unmeasured' : `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function report(evidence: ProbeEvidence): string {
  const verdict = evidence.failure
    ? `failed: ${evidence.failure.split('\n')[0]}`
    : `works: the public gateway delivered an exact ${DESKTOP_SCREEN.width}x${DESKTOP_SCREEN.height} KasmVNC desktop with live input`

  return `# Public desktop stack probe

Date: ${new Date().toISOString()}

## Verdict

${verdict}.

## Evidence

- VM: \`${evidence.vmName}\`
- Image: \`${evidence.imageRef}\`
- Base image: \`${evidence.baseImageRef}\`
- Control-plane create: ${evidence.createMs === undefined ? 'unmeasured' : ms(evidence.createMs)}
- Boot to SSH: ${evidence.sshReadyMs === undefined ? 'unmeasured' : ms(evidence.sshReadyMs)}
- In-VM KasmVNC start to rendered framebuffer: ${evidence.desktopStartMs === undefined ? 'unmeasured' : ms(evidence.desktopStartMs)}
- Cold create to desktop ready: ${evidence.coldStartMs === undefined ? 'unmeasured' : ms(evidence.coldStartMs)}
- Display: ${evidence.dimensions ?? 'unmeasured'}
- Image content size: ${mib(evidence.imageBytes)}
- Base content size: ${mib(evidence.baseImageBytes)}
- Desktop image delta: ${mib(evidence.imageDeltaBytes)}
- Framebuffer: ${evidence.framebufferBytes === undefined ? 'unmeasured' : `${evidence.framebufferBytes} bytes`}${evidence.framebufferSha256 ? `, SHA-256 \`${evidence.framebufferSha256}\`` : ''}
- Public origin: ${evidence.publicUrl ?? 'unmeasured'}
- Public canvas: ${evidence.publicCanvas ?? 'unmeasured'}
- Browser input: ${evidence.publicInput ? 'keyboard and pointer observed by xev' : 'unmeasured'}
- Clipboard: browser→VM ${evidence.clipboardUp ? 'passed' : 'unmeasured'}; VM→browser ${evidence.clipboardDown ? 'passed' : 'unmeasured'}
- Window movement: ${evidence.windowMoved ? 'passed' : 'unmeasured'}
- Static public connection: ${evidence.publicIdleMs === undefined ? 'unmeasured' : ms(evidence.publicIdleMs)}; ${evidence.publicSocketCount ?? 0} socket(s), ${evidence.publicSocketCloses ?? 0} close(s)
- Scroll workload Xvnc CPU: ${evidence.publicCpuPercent === undefined ? 'unmeasured' : `${evidence.publicCpuPercent.toFixed(2)}% of one core`}
- Demand stop after detach: ${evidence.targetReaped ? 'passed' : 'unmeasured'}
- Deleted: ${evidence.deleted.length > 0 ? evidence.deleted.map(name => `\`${name}\``).join(', ') : 'none'}
- Leak check: ${evidence.noLeaks ? 'no `duet-test-*` VMs remain' : 'failed'}

The size values are Docker's local \`.Size\` values for the two exact amd64 refs
above. On Docker Desktop's containerd image store they correspond to the content
size shown by \`docker image ls --tree\`; they are not live disk use inside a VM.

## Contract proof

${fenced(
  [
    `HTTP listener=127.0.0.1:${DESKTOP_LOOPBACK_PORT}`,
    `xdpyinfo=${evidence.dimensions ?? 'unmeasured'}`,
    `framebuffer=${evidence.framebufferSha256 ?? 'unmeasured'}`,
    'Xvnc argv contains -DLP_ClipSendMax 16777216',
    'Xvnc argv contains -DLP_ClipAcceptMax 16777216',
    `public websocket=${evidence.publicSocketCount ?? 'unmeasured'} opened / ${evidence.publicSocketCloses ?? 'unmeasured'} closed`,
    `systemctl target reaped=${evidence.targetReaped ?? 'unmeasured'}`,
  ].join('\n'),
)}
`
}

const ctx = makeContext()
const quietSsh = new ExeClient()
const name = vmName('desktop-stack')
const evidence: ProbeEvidence = {
  vmName: name,
  imageRef,
  baseImageRef,
  deleted: [],
  noLeaks: false,
}
const secrets: string[] = []
try {
  await ctx.control.whoami()
  await pullImage(imageRef)
  await pullImage(baseImageRef)
  evidence.imageBytes = await imageSize(imageRef)
  evidence.baseImageBytes = await imageSize(baseImageRef)
  evidence.imageDeltaBytes = evidence.imageBytes - evidence.baseImageBytes

  const coldStartedAt = performance.now()
  const created = await createVm(ctx, {
    name,
    image: imageRef,
    cpu: 2,
    memory: '8GB',
    tags: ['duet-probe'],
    comment: 'vm-desktop slice 04 #duet-probe',
  })
  evidence.createMs = created.durationMs
  evidence.sshReadyMs = await ctx.ssh.waitUntilReady(created.value.ssh_dest, {
    timeoutMs: 300_000,
  })

  const output = await runOrThrow(ctx.ssh, created.value.ssh_dest, desktopCommand(), 180_000)
  evidence.desktopStartMs = Number(marker(output, 'DUET_DESKTOP_START_MS'))
  evidence.dimensions = marker(output, 'DUET_DIMENSIONS')
  evidence.framebufferSha256 = marker(output, 'DUET_FRAMEBUFFER_SHA256')
  const framebuffer = Buffer.from(marker(output, 'DUET_FRAMEBUFFER_BASE64'), 'base64')
  evidence.framebufferBytes = framebuffer.byteLength
  evidence.coldStartMs = performance.now() - coldStartedAt

  await mkdir(fileURLToPath(PROBE_REPORTS_DIR), { recursive: true })
  await writeFile(probeReportUrl('vm-desktop-slice02-framebuffer.png'), framebuffer)

  const publicOrigin = created.value.https_url ?? `https://${created.value.ssh_dest}`
  const vmToken = randomBytes(32).toString('base64url')
  const browserToken = randomBytes(32).toString('base64url')
  const grantId = `public-${randomBytes(8).toString('hex')}`
  secrets.push(vmToken, browserToken, grantId)
  await runOrThrow(
    quietSsh,
    created.value.ssh_dest,
    `install -d -m 0700 /home/exedev/.duet; printf '%s\\n' '${vmToken}' > /home/exedev/.duet/vm-token; chmod 0600 /home/exedev/.duet/vm-token`,
  )
  await ctx.control.setSharePublic(name)
  await waitForHttp(`${publicOrigin}/healthz`)
  evidence.publicUrl = new URL(publicOrigin).origin
  await runPublicBrowserProbe(
    created.value.ssh_dest,
    publicOrigin,
    vmToken,
    browserToken,
    grantId,
    evidence,
  )
} catch (error) {
  evidence.failure = secrets.reduce(
    (message, secret) => message.replaceAll(secret, '[redacted]'),
    error instanceof Error ? error.message : String(error),
  )
} finally {
  const cleaned = await cleanup(ctx)
  evidence.deleted = cleaned.deleted
  if (cleaned.deleteErrors.length > 0) {
    evidence.failure = `${evidence.failure ?? ''}\n${cleaned.deleteErrors.join('\n')}`.trim()
  }
  try {
    await assertNoDuetTestVms(ctx.control)
    evidence.noLeaks = true
  } catch (error) {
    evidence.failure =
      `${evidence.failure ?? ''}\n${error instanceof Error ? error.message : String(error)}`.trim()
  }
}

await mkdir(fileURLToPath(PROBE_REPORTS_DIR), { recursive: true })
await writeFile(reportUrl, report(evidence))
console.log(`wrote ${fileURLToPath(reportUrl)}`)
if (!evidence.failure) console.log(`wrote ${fileURLToPath(framebufferUrl)}`)
if (evidence.failure) throw new Error(evidence.failure)
