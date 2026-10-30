import { afterEach, beforeEach, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  DESKTOP_CDP_PORT,
  DESKTOP_CHROME_DEB_SHA256,
  DESKTOP_CHROME_PROFILE_REL,
  DESKTOP_CHROME_VERSION,
  DESKTOP_KASM_AUTH_PATH,
  DESKTOP_LOOPBACK_PORT,
  DESKTOP_SCREEN,
} from '@repo/contract'

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'duet-vm-image-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

test('gateway systemd unit validates current through the stable bundled bootstrap', async () => {
  const unit = await readFile(resolve(import.meta.dir, '../systemd/duet-gateway.service'), 'utf8')

  expect(unit).toContain(
    'ExecStartPre=/opt/duet/gateway-runtime/bin/bun /opt/duet/bin/runtime-bootstrap.js',
  )
  expect(unit).toContain('ExecStart=/opt/duet/gateway-runtime/bin/bun /opt/duet/current/index.js')
  expect(unit).toContain('Restart=always')
  expect(unit).toContain('StartLimitIntervalSec=0')
  expect(unit).toContain('DUET_WEB_APP_ORIGIN')
})

test('duet-browser follows the current gateway release instead of becoming a third update rail', async () => {
  const wrapper = await readFile(resolve(import.meta.dir, '../scripts/duet-browser'), 'utf8')
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')

  expect(wrapper).toContain(
    'exec /opt/duet/gateway-runtime/bin/bun /opt/duet/current/index.js --desktop-browser-cli "$@"',
  )
  expect(dockerfile).toContain(
    'COPY packages/vm-image/scripts/duet-browser /usr/local/bin/duet-browser',
  )
  expect(dockerfile).toContain('RUN chmod 755 /usr/local/bin/duet-browser')
})

test('gateway systemd unit puts the bun bin dir on PATH, matching the Dockerfile', async () => {
  // systemd services inherit neither Docker ENV nor /etc/profile.d, so the unit
  // must set PATH itself or gateway-spawned managed tools (`duet`) vanish
  // on a fresh VM. If the bun install dir moves in the Dockerfile, this fails.
  const bunBinDir = '/home/exedev/.bun/bin'
  const unit = await readFile(resolve(import.meta.dir, '../systemd/duet-gateway.service'), 'utf8')
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')

  expect(unit).toContain(
    `Environment=PATH=${bunBinDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
  )
  expect(dockerfile).toContain(`ENV PATH=${bunBinDir}:$PATH`)
})

test('runtime crash drill replays rollback and sustained recovery in temp dirs', async () => {
  const script = resolve(import.meta.dir, '../scripts/runtime-crash-drill.ts')
  const result = await Bun.$`bun run ${script}`.quiet()
  const report = JSON.parse(result.stdout.toString()) as Record<string, unknown>
  const { runtimeFixture } = await import('../../gateway/src/testing/runtime-release-fixture')
  const good = runtimeFixture('good-release').manifest.version
  const poisoned = runtimeFixture('poisoned-release').manifest.version

  expect(report).toEqual({
    simulatedCrashes: expect.any(Number),
    rolledBackTo: good,
    quarantinedVersion: poisoned,
    consecutiveFailuresBeforeHealth: 0,
    healthyVersion: good,
    healthyAfterMs: 37,
    consecutiveFailuresAfterHealth: 0,
  })
  expect(Number(report.simulatedCrashes)).toBeGreaterThan(0)
})

test('image staging preserves the whole shared runtime release and its identity', async () => {
  const { runtimeFixture } = await import('../../gateway/src/testing/runtime-release-fixture')
  const { stageRuntime } = await import('../scripts/stage-runtime')
  const release = runtimeFixture('shared-api-image')
  const source = join(tempDir, 'shared-output')
  const destination = join(tempDir, 'image/opt/duet')
  const bootstrap = join(tempDir, 'runtime-bootstrap.js')
  await release.write(source)
  await writeFile(bootstrap, 'stable bootstrap')
  await stageRuntime(source, bootstrap, destination)
  const current = join(destination, 'current')
  expect(await readlink(current)).toBe(`releases/${release.manifest.version}`)
  expect(JSON.parse(await readFile(join(current, 'manifest.json'), 'utf8'))).toEqual(
    release.manifest,
  )
  expect((await readdir(current)).sort()).toEqual(
    [...release.manifest.artifacts.map(artifact => artifact.name), 'manifest.json'].sort(),
  )
  for (const artifact of release.manifest.artifacts) {
    expect(await readFile(join(current, artifact.name))).toEqual(release.bytes.get(artifact.name)!)
    expect((await stat(join(current, artifact.name))).mode & 0o777).toBe(artifact.mode)
  }
  expect(await readFile(join(destination, 'bin/runtime-bootstrap.js'), 'utf8')).toBe(
    'stable bootstrap',
  )
})

test('Dockerfile installs the headless LibreOffice document conversion components', async () => {
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')

  for (const packageName of [
    'libreoffice-core-nogui',
    'libreoffice-writer-nogui',
    'libreoffice-calc-nogui',
    'libreoffice-impress-nogui',
    'libreoffice-draw-nogui',
  ]) {
    expect(dockerfile).toMatch(new RegExp(`^\\s*${packageName} \\\\$`, 'm'))
  }
  expect(dockerfile).toContain('--no-install-recommends')
})

test('Dockerfile bakes every required Python distribution at build time', async () => {
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')
  const { REQUIRED_TOOLS } = await import('./required-tools')

  expect(dockerfile).toMatch(/^\s*python-is-python3 \\$/m)
  for (const tool of REQUIRED_TOOLS.pythonModules) {
    expect(dockerfile.toLowerCase()).toContain(tool.distribution.toLowerCase())
  }
})

test('workspace-browser declares the CLI and Python client its workflow executes', async () => {
  const { REQUIRED_TOOLS } = await import('./required-tools')

  const browserCli = REQUIRED_TOOLS.binaries.find(tool => tool.name === 'duet-browser')
  expect(browserCli?.skills).toContain('workspace-browser')
  const pythonClient = REQUIRED_TOOLS.pythonModules.find(tool => tool.module === 'playwright')
  expect(pythonClient?.distribution).toBe('playwright')
  expect(pythonClient?.skills).toContain('workspace-browser')
})

test('Dockerfile pins a SHA-verified Syncthing release instead of the apt package', async () => {
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')

  // The unpinned apt syncthing (auto-upgrading, discovery-on) is gone.
  expect(dockerfile).not.toMatch(/^\s*syncthing \\$/m)
  expect(dockerfile).toMatch(/^ARG SYNCTHING_VERSION=v\d+\.\d+\.\d+$/m)
  expect(dockerfile).toMatch(/^ARG SYNCTHING_SHA256=[0-9a-f]{64}$/m)
  expect(dockerfile).toContain('sha256sum -c -')
  expect(dockerfile).toContain('install -m 0755')
  // The image configures watch capacity; its exact tuning value is owned by the image.
  expect(dockerfile).toMatch(/fs\.inotify\.max_user_watches=\d+/)
})

test('Dockerfile pins the official static-web-server Linux archive without a fallback server', async () => {
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')

  expect(dockerfile).toMatch(/^ARG STATIC_WEB_SERVER_VERSION=v\d+\.\d+\.\d+$/m)
  expect(dockerfile).toMatch(/^ARG STATIC_WEB_SERVER_SHA256=[0-9a-f]{64}$/m)
  expect(dockerfile).toContain(
    'static-web-server-${STATIC_WEB_SERVER_VERSION}-x86_64-unknown-linux-gnu.tar.gz',
  )
  expect(dockerfile).toContain(
    'echo "${STATIC_WEB_SERVER_SHA256}  /tmp/static-web-server.tar.gz" | sha256sum -c -',
  )
  expect(dockerfile).toContain(
    'install -m 0755 "/tmp/static-web-server-${STATIC_WEB_SERVER_VERSION}-x86_64-unknown-linux-gnu/static-web-server" /usr/bin/static-web-server',
  )
  expect(dockerfile).toContain(
    'rm -rf /tmp/static-web-server.tar.gz "/tmp/static-web-server-${STATIC_WEB_SERVER_VERSION}-x86_64-unknown-linux-gnu"',
  )
  expect(dockerfile).toContain('static-web-server --version')
  for (const flag of ['--page-fallback', '--port', '--root']) {
    expect(dockerfile).toContain(`static-web-server --help | grep -- ${flag}`)
  }

  expect(dockerfile).not.toMatch(/(?:bunx|npx)\s+(?:--bun\s+)?(?:serve|http-server)\b/)
  expect(dockerfile).not.toMatch(/npm\s+(?:install|i)\s+(?:-g\s+)?(?:serve|http-server)\b/)
  expect(dockerfile).not.toMatch(/python3?\s+-m\s+http\.server\b/)
  expect(dockerfile).not.toMatch(/^\s*(?:serve|http-server|webfs) \\$/m)
})

test('KasmVNC is always invoked through its absolute packaged path', async () => {
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')

  expect(dockerfile).toContain('/usr/bin/kasmvncserver -select-de xfce')
  expect(dockerfile).toContain('/usr/bin/kasmvncserver -kill :1')
  expect(dockerfile).not.toMatch(/(?:^|[;&|]\s*)kasmvncserver\s/m)
})

test('KasmVNC config serves the fixed desktop contract on loopback with bidirectional clipboard', async () => {
  const config = await readFile(resolve(import.meta.dir, '../desktop/kasmvnc.yaml'), 'utf8')
  const numberAfter = (key: string): number => {
    const value = config.match(new RegExp(`^\\s*${key}: (\\d+)$`, 'm'))?.[1]
    if (value === undefined) throw new Error(`missing numeric ${key} in KasmVNC config`)
    return Number(value)
  }
  const clipboardSizes = [...config.matchAll(/^\s*size: (\d+)$/gm)].map(match => Number(match[1]))

  expect(numberAfter('width')).toBe(DESKTOP_SCREEN.width)
  expect(numberAfter('height')).toBe(DESKTOP_SCREEN.height)
  expect(numberAfter('websocket_port')).toBe(DESKTOP_LOOPBACK_PORT)
  expect(config).toMatch(/^\s*allow_resize: false$/m)
  expect(config).toMatch(/^\s*interface: 127\.0\.0\.1$/m)
  expect(config).toMatch(/^\s*require_ssl: false$/m)
  expect(config).toContain('pem_certificate: /home/exedev/.vnc/pki/desktop.crt')
  expect(config).toContain('pem_key: /home/exedev/.vnc/pki/desktop.key')
  expect(clipboardSizes).toEqual([16 * 1024 * 1024, 16 * 1024 * 1024])
})

test('the browser-facing desktop transition is Duet branded', async () => {
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')
  const branding = await readFile(
    resolve(import.meta.dir, '../desktop/kasmvnc-branding.css'),
    'utf8',
  )
  const verifier = await readFile(resolve(import.meta.dir, '../scripts/verify-image.ts'), 'utf8')

  expect(dockerfile).toContain(
    'packages/vm-image/desktop/kasmvnc-branding.css /usr/share/kasmvnc/www/duet-branding.css',
  )
  expect(dockerfile).toContain(
    'apps/web/public/icons/duet-avatar.png /usr/share/kasmvnc/www/duet-avatar.png',
  )
  expect(dockerfile).toContain('<title>Duet</title>')
  expect(dockerfile).toContain('Duet encountered an error:')
  expect(dockerfile).toContain('<span>Duet Desktop</span>')
  expect(branding).toContain('#duet_desktop_brand')
  expect(branding).toContain('#duet_desktop_brand img')
  for (const selector of [
    '#noVNC_transition_text:empty',
    '\\.noVNC_logo',
    '\\.noVNC_version_wrapper',
  ]) {
    expect(branding).toMatch(new RegExp(`${selector}[^{}]*\\{[^}]*display\\s*:\\s*none\\s*;`))
  }
  expect(branding).toContain('@keyframes duet-desktop-loading')
  expect(branding).toMatch(/\.noVNC_spinner::before\s*{[^}]*animation:\s*duet-desktop-loading/s)
  expect(branding).not.toContain('Kasm')
  expect(verifier).toContain("grep -F '<span>Duet Desktop</span>'")
  expect(verifier).toContain("grep -F '@keyframes duet-desktop-loading'")
})

test('Dockerfile SHA-pins the noble desktop package and generates its build-time state', async () => {
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')

  expect(dockerfile).toMatch(/^ARG KASMVNC_VERSION=\d+\.\d+\.\d+$/m)
  expect(dockerfile).toMatch(/^ARG KASMVNC_SHA256=[0-9a-f]{64}$/m)
  expect(dockerfile).toContain('kasmvncserver_noble_${KASMVNC_VERSION}_amd64.deb')
  expect(dockerfile).toContain('echo "${KASMVNC_SHA256}  /tmp/kasmvncserver.deb" | sha256sum -c -')
  for (const packageName of [
    'dbus-x11',
    'pulseaudio',
    'pulseaudio-utils',
    'x11-utils',
    'xclip',
    'xfce4-session',
    'xfce4-settings',
    'xfdesktop4',
    'xfwm4',
  ]) {
    expect(dockerfile).toMatch(new RegExp(`^\\s*${packageName} \\\\$`, 'm'))
  }
  expect(dockerfile).toContain('openssl req -x509')
  expect(dockerfile).toContain('/home/exedev/.vnc/pki/desktop.key')
  expect(dockerfile).toContain('/home/exedev/.vnc/pki/desktop.crt')
  expect(dockerfile).toContain("grep -F 'exec xfce4-session' /home/exedev/.vnc/xstartup")
  expect(dockerfile).toContain('rm -f /etc/systemd/user/default.target.wants/pulseaudio.service')
  expect(dockerfile).not.toMatch(/systemctl enable[^\n]*kasm/i)
})

test('KasmVNC credentials are per-VM persisted state readable by the gateway user', async () => {
  const script = await readFile(
    resolve(import.meta.dir, '../scripts/ensure-kasm-credentials.sh'),
    'utf8',
  )
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')

  expect(script).toContain('auth_file="$state_dir/kasm-auth.json"')
  expect(script).toContain('openssl rand -base64 32')
  expect(script).toContain("'{username: $username, password: $password}'")
  expect(script).toContain('/usr/bin/kasmvncpasswd -u "$username" -w')
  expect(script).toContain('chmod 600 "$auth_file" "$password_file"')
  expect(dockerfile).toContain('/opt/duet/bin/ensure-kasm-credentials.sh')
  expect(dockerfile).toContain('rm -f /home/exedev/.kasmpasswd')
  expect(dockerfile).not.toContain('/home/exedev/.duet/desktop/kasm-auth.json')
})

test('desktop systemd wiring is demand-only and tracks Kasm plus its XFCE session as one daemon', async () => {
  const service = await readFile(
    resolve(import.meta.dir, '../systemd/duet-desktop.service'),
    'utf8',
  )
  const target = await readFile(resolve(import.meta.dir, '../systemd/duet-desktop.target'), 'utf8')
  const sudoers = await readFile(resolve(import.meta.dir, '../sudoers/duet-desktop'), 'utf8')
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')

  expect(service).toContain('Type=forking')
  expect(service).toContain('User=exedev')
  expect(service).toContain('Environment=HOME=/home/exedev')
  expect(service).toContain('PartOf=duet-desktop.target')
  expect(service).toContain('ExecStartPre=/opt/duet/bin/ensure-kasm-credentials.sh')
  expect(service).toContain('ExecStart=/usr/bin/kasmvncserver :1')
  expect(service).toContain('PIDFile=/home/exedev/.vnc/%H:1.pid')
  expect(service).toContain('ExecStop=/usr/bin/kasmvncserver -kill :1')
  expect(service.match(/xfce4-session/g) ?? []).toHaveLength(0)

  expect(target).toContain('Requires=duet-desktop.service')
  expect(target).toContain('Wants=duet-desktop-browser.service')
  expect(target).not.toContain('Requires=duet-desktop.service duet-desktop-browser.service')
  expect(target).toContain('After=duet-desktop.service')
  expect(target).not.toContain('WantedBy=multi-user.target')

  for (const action of ['start', 'stop', 'is-active']) {
    expect(sudoers).toContain(`/usr/bin/systemctl ${action} duet-desktop.target`)
  }
  expect(dockerfile).toContain('COPY --chmod=0440 sudoers/duet-desktop /etc/sudoers.d/duet-desktop')
  expect(dockerfile).toContain(
    'COPY systemd/duet-desktop.service /etc/systemd/system/duet-desktop.service',
  )
  expect(dockerfile).toContain(
    'COPY systemd/duet-desktop.target /etc/systemd/system/duet-desktop.target',
  )
  expect(dockerfile).not.toMatch(/multi-user\.target\.wants\/duet-desktop/)
})

test('the shared Chrome pin, launcher, and unit use one loopback CDP profile contract', async () => {
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')
  const launcher = await readFile(
    resolve(import.meta.dir, '../desktop/duet-browser.desktop'),
    'utf8',
  )
  const service = await readFile(
    resolve(import.meta.dir, '../systemd/duet-desktop-browser.service'),
    'utf8',
  )
  const verifier = await readFile(resolve(import.meta.dir, '../scripts/verify-image.ts'), 'utf8')
  const stopBrowser = await readFile(
    resolve(import.meta.dir, '../scripts/stop-shared-chrome.py'),
    'utf8',
  )
  const browserScript = await readFile(
    resolve(import.meta.dir, '../scripts/start-shared-chrome.sh'),
    'utf8',
  )
  const target = await readFile(resolve(import.meta.dir, '../systemd/duet-desktop.target'), 'utf8')

  expect(dockerfile).toContain(`ARG GOOGLE_CHROME_VERSION=${DESKTOP_CHROME_VERSION}`)
  expect(dockerfile).toContain(`ARG GOOGLE_CHROME_SHA256=${DESKTOP_CHROME_DEB_SHA256}`)
  expect(dockerfile).toContain('google-chrome-stable_${GOOGLE_CHROME_VERSION}_amd64.deb')
  expect(dockerfile).toContain('sha256sum -c -')
  expect(dockerfile).toContain('apt-mark hold google-chrome-stable')
  expect(dockerfile).toContain('/etc/apt/sources.list.d/google-chrome.list')
  expect(dockerfile).toContain('/etc/apt/sources.list.d/google-chrome.sources')
  expect(dockerfile).toContain('/usr/share/applications/google-chrome.desktop')
  expect(dockerfile).toContain('/usr/share/applications/com.google.Chrome.desktop')
  expect(dockerfile).toContain('/usr/share/applications/xfce4-web-browser.desktop')

  const launcherExec = launcher.match(/^Exec=(.+)$/m)?.[1]
  const serviceExec = service.match(/^ExecStart=(.+)$/m)?.[1]
  expect(launcherExec).toBe(serviceExec)
  expect(launcherExec).toBe('/opt/duet/bin/start-shared-chrome')
  expect(browserScript).toContain('--class=duet-browser')
  expect(browserScript).toContain(`--user-data-dir=/home/exedev/${DESKTOP_CHROME_PROFILE_REL}`)
  expect(browserScript).toContain('--remote-debugging-address=127.0.0.1')
  expect(browserScript).toContain(`--remote-debugging-port=${DESKTOP_CDP_PORT}`)
  expect(browserScript).toContain('--window-size=1296,720')
  expect(browserScript).toContain('--window-position=72,48')
  expect(launcher).toContain('StartupWMClass=duet-browser')
  expect(service).toContain('PartOf=duet-desktop.target')
  expect(service).not.toContain('Requires=duet-desktop.service')
  expect(service).toContain('After=duet-desktop.service')
  expect(service).toContain('Restart=always')
  expect(service).toContain('ExecStop=/opt/duet/bin/stop-shared-chrome.py')
  expect(service).toContain('KillMode=mixed')
  expect(service).toMatch(/^TimeoutStopSec=\d+$/m)
  expect(stopBrowser).toContain(`http://127.0.0.1:${DESKTOP_CDP_PORT}`)
  expect(stopBrowser).toContain('page.close(run_before_unload=True)')
  expect(stopBrowser).toMatch(/signal\.alarm\(\d+\)/)
  expect(dockerfile).toContain(
    'COPY packages/vm-image/scripts/stop-shared-chrome.py /opt/duet/bin/stop-shared-chrome.py',
  )
  expect(target).toContain('Requires=duet-desktop.service')
  expect(target).toContain('Wants=duet-desktop-browser.service')
  expect(target).toContain('After=duet-desktop.service duet-desktop-browser.service')
  expect(`${dockerfile}\n${browserScript}\n${launcher}\n${service}`).not.toContain(
    '--remote-allow-origins',
  )
  expect(verifier).toContain('http://127.0.0.1:${DESKTOP_CDP_PORT}/json/version')
  expect(verifier).toContain(
    "! grep -qx 'Requires=duet-desktop.service' /etc/systemd/system/duet-desktop-browser.service",
  )
  expect(verifier).toContain('test ! -e /etc/apt/sources.list.d/google-chrome.list')
  expect(verifier).toContain('test ! -e /etc/apt/sources.list.d/google-chrome.sources')
  expect(verifier).toContain("'--cap-add=SYS_ADMIN'")
  expect(verifier).toContain('WM_CLASS')
  expect(verifier).toContain('Map State: IsViewable')
  expect(verifier).toContain('Width: 1296')
  expect(verifier).toContain('Height: 720')
  expect(verifier).toContain('Absolute upper-left X:  72')
  expect(verifier).toContain('Absolute upper-left Y:  48')
})

test('the image force-installs one minimal browser window actuator behind one launcher', async () => {
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')
  const manifest = JSON.parse(
    await readFile(resolve(import.meta.dir, '../desktop/chrome-extension/manifest.json'), 'utf8'),
  ) as Record<string, unknown>
  const background = await readFile(
    resolve(import.meta.dir, '../desktop/chrome-extension/background.js'),
    'utf8',
  )
  const launcherScript = await readFile(
    resolve(import.meta.dir, '../scripts/start-shared-chrome.sh'),
    'utf8',
  )
  const desktopLauncher = await readFile(
    resolve(import.meta.dir, '../desktop/duet-browser.desktop'),
    'utf8',
  )
  const service = await readFile(
    resolve(import.meta.dir, '../systemd/duet-desktop-browser.service'),
    'utf8',
  )
  const verifier = await readFile(resolve(import.meta.dir, '../scripts/verify-image.ts'), 'utf8')

  expect(manifest).toMatchObject({
    manifest_version: 3,
    permissions: ['tabs', 'windows', 'debugger'],
    background: { service_worker: 'background.js' },
  })
  expect(manifest).not.toHaveProperty('content_scripts')
  expect(manifest).not.toHaveProperty('host_permissions')
  expect(background).toContain('chrome.debugger.getTargets()')
  expect(background).toContain(
    "const socketUrl = 'ws://127.0.0.1:3000/v1/desktop/browser-extension/socket'",
  )
  expect(background).toContain('new WebSocket(socketUrl)')
  expect(background).toContain('chrome.tabs.discard')
  expect(background).toContain('chrome.tabs.update(message.tabId, { active: true })')
  expect(background).toContain('chrome.tabs.move')
  expect(dockerfile).toContain('ExtensionInstallForcelist')
  expect(dockerfile).toContain('/opt/duet/browser-extension/extension.crx')
  expect(dockerfile).toContain('packages/vm-image/desktop/chrome-extension/')
  expect(dockerfile).toContain(
    'runuser -u exedev -- env HOME=/home/exedev timeout 30s /usr/bin/google-chrome-stable \\\n    --no-sandbox --disable-gpu',
  )
  expect(dockerfile).toContain('--mount=type=secret,id=browser-extension-key')
  expect(dockerfile).toContain('--pack-extension-key=/tmp/duet-browser-extension-key.pem')
  expect(launcherScript).toContain('--class=duet-browser')
  expect(launcherScript).toContain('--remote-debugging-address=127.0.0.1')
  expect(launcherScript).toContain('--remote-debugging-port=9222')
  expect(desktopLauncher).toContain('Exec=/opt/duet/bin/start-shared-chrome')
  expect(service).toContain('ExecStart=/opt/duet/bin/start-shared-chrome')
  expect(`${desktopLauncher}\n${service}`).not.toContain('/usr/bin/google-chrome-stable --class=')
  expect(verifier).toContain('/opt/duet/current/index.js')
  expect(verifier).toContain('/v1/desktop/browser-extension/status')
  expect(verifier).toContain('.connected == true')
})

test('the privileged Chrome updater accepts only a fixed Google version and digest', async () => {
  const helper = await readFile(
    resolve(import.meta.dir, '../scripts/update-shared-chrome.sh'),
    'utf8',
  )
  const sudoers = await readFile(resolve(import.meta.dir, '../sudoers/duet-desktop'), 'utf8')
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')

  const bin = join(tempDir, 'bin')
  const attemptedEffect = join(tempDir, 'attempted-effect')
  await mkdir(bin)
  // Refuse the first external side effect even if validation regresses.
  // Never let this probe reach the machine's installer or desktop state.
  await writeFile(
    join(bin, 'mktemp'),
    '#!/bin/sh\nprintf attempted > "$VM_UPDATER_EFFECT_RECEIPT"\nexit 77\n',
    { mode: 0o755 },
  )
  for (const [args, diagnostic] of [
    [[], 'usage:'],
    [['latest', 'a'.repeat(64)], 'invalid Chrome version'],
    [['141.0.7390.65-1', 'not-a-digest'], 'invalid Chrome SHA-256'],
  ] as const) {
    const child = Bun.spawn(
      ['bash', resolve(import.meta.dir, '../scripts/update-shared-chrome.sh'), ...args],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          VM_UPDATER_EFFECT_RECEIPT: attemptedEffect,
        },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 2_000,
      },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ exitCode, stdout }).toEqual({ exitCode: 64, stdout: '' })
    expect(stderr).toContain(diagnostic)
    expect(await Bun.file(attemptedEffect).exists()).toBe(false)
  }

  expect(helper).toContain(
    'https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/',
  )
  expect(helper).toContain('sha256sum -c -')
  expect(helper).toContain('apt-mark unhold google-chrome-stable')
  expect(helper).toContain('apt-mark hold google-chrome-stable')
  expect(helper).toContain('dpkg-query')
  for (const generatedPath of [
    '/etc/apt/sources.list.d/google-chrome.list',
    '/etc/apt/sources.list.d/google-chrome.sources',
    '/etc/cron.daily/google-chrome',
    '/opt/google/chrome/cron/google-chrome',
    '/usr/share/applications/com.google.Chrome.desktop',
    '/usr/share/applications/google-chrome.desktop',
    '/usr/share/applications/xfce4-web-browser.desktop',
  ]) {
    expect(helper).toContain(generatedPath)
  }
  expect(sudoers).toContain('/opt/duet/bin/update-shared-chrome *')
  for (const action of ['start', 'stop']) {
    expect(sudoers).toContain(`/usr/bin/systemctl ${action} duet-desktop-browser.service`)
  }
  expect(sudoers).toContain('/usr/bin/systemctl is-active --quiet duet-desktop-browser.service')
  expect(dockerfile).toContain(
    'COPY packages/vm-image/scripts/update-shared-chrome.sh /opt/duet/bin/update-shared-chrome',
  )
})

test('the desktop image applies the approved theme, furniture, and window composition', async () => {
  const dockerfile = await readFile(resolve(import.meta.dir, '../Dockerfile'), 'utf8')
  const xsettings = await readFile(
    resolve(import.meta.dir, '../desktop/xfce4/xsettings.xml'),
    'utf8',
  )
  const desktop = await readFile(
    resolve(import.meta.dir, '../desktop/xfce4/xfce4-desktop.xml'),
    'utf8',
  )
  const windowManager = await readFile(
    resolve(import.meta.dir, '../desktop/xfce4/xfwm4.xml'),
    'utf8',
  )
  const panel = await readFile(resolve(import.meta.dir, '../desktop/xfce4/xfce4-panel.xml'), 'utf8')
  const styleLauncher = await readFile(
    resolve(import.meta.dir, '../desktop/autostart/duet-desktop-style.desktop'),
    'utf8',
  )
  const styleScript = await readFile(
    resolve(import.meta.dir, '../scripts/start-desktop-style.sh'),
    'utf8',
  )
  const windowRule = await readFile(
    resolve(import.meta.dir, '../desktop/devilspie2/duet-browser.lua'),
    'utf8',
  )
  const browserUnit = await readFile(
    resolve(import.meta.dir, '../systemd/duet-desktop-browser.service'),
    'utf8',
  )
  const dockItems = await Promise.all(
    ['catfish', 'thunar', 'xfce4-terminal', 'duet-browser', 'xfce-settings-manager'].map(name =>
      readFile(resolve(import.meta.dir, `../desktop/plank/${name}.dockitem`), 'utf8'),
    ),
  )

  for (const packageName of [
    'catfish',
    'devilspie2',
    'fonts-inter',
    'fonts-noto-color-emoji',
    'fonts-noto-core',
    'plank',
    'thunar',
    'xfce4-panel',
    'xfce4-terminal',
  ]) {
    expect(dockerfile).toMatch(new RegExp(`^\\s*${packageName} \\\\$`, 'm'))
  }
  expect(dockerfile).toMatch(/^ARG WHITESUR_GTK_VERSION=\d{4}-\d{2}-\d{2}$/m)
  expect(dockerfile).toMatch(/^ARG WHITESUR_GTK_SHA256=[0-9a-f]{64}$/m)
  expect(dockerfile).toMatch(/^ARG WHITESUR_ICON_VERSION=\d{4}-\d{2}-\d{2}$/m)
  expect(dockerfile).toMatch(/^ARG WHITESUR_ICON_SHA256=[0-9a-f]{64}$/m)
  expect(dockerfile.match(/sha256sum -c -/g)?.length ?? 0).toBeGreaterThanOrEqual(5)
  expect(dockerfile).toContain('/usr/share/themes/WhiteSur-Light-solid')
  expect(dockerfile).toContain('/usr/share/icons/WhiteSur')
  expect(dockerfile).toContain('/usr/share/plank/themes/WhiteSur/dock.theme')
  expect(dockerfile).toContain("'s/^LineWidth=0$/LineWidth=4/'")
  expect(dockerfile).toContain(
    "'s/^FillEndColor=209;;209;;209;;150$/FillEndColor=209;;209;;209;;50/'",
  )
  expect(dockerfile).toContain('/usr/share/backgrounds/duet-wallpaper.png')
  expect(dockerfile).toContain("identify -format '%k'")

  expect(xsettings).toContain('name="ThemeName" type="string" value="WhiteSur-Light-solid"')
  expect(xsettings).toContain('name="IconThemeName" type="string" value="WhiteSur"')
  expect(xsettings).toContain('name="FontName" type="string" value="Inter 10"')
  expect(xsettings).toContain('name="Antialias" type="int" value="1"')
  expect(xsettings).toContain('name="HintStyle" type="string" value="hintslight"')

  expect(desktop).toContain('name="style" type="int" value="0"')
  expect(desktop).toContain(
    'name="last-image" type="string" value="/usr/share/backgrounds/duet-wallpaper.png"',
  )
  expect(windowManager).toContain('name="theme" type="string" value="WhiteSur-Light-solid"')
  expect(windowManager).toContain('name="title_font" type="string" value="Inter Semi-Bold 10"')
  expect(panel).toContain('name="size" type="uint" value="28"')
  expect(panel).toContain('value="clock"')

  expect(styleLauncher).toContain('Exec=/opt/duet/bin/start-desktop-style.sh')
  expect(styleScript).toContain("theme 'WhiteSur'")
  expect(styleScript).toContain(
    "dock-items \"['catfish.dockitem', 'thunar.dockitem', 'xfce4-terminal.dockitem', 'duet-browser.dockitem', 'xfce-settings-manager.dockitem']\"",
  )
  expect(styleScript).toContain('exec /usr/bin/plank --name dock1')
  expect(styleScript).toContain('/usr/bin/devilspie2 --folder /home/exedev/.config/devilspie2')
  expect(windowRule).toContain('set_window_geometry(72, 48, 1296, 720)')
  expect(browserUnit).toContain(
    'Environment=BAMF_DESKTOP_FILE_HINT=/usr/share/applications/duet-browser.desktop',
  )
  expect(browserUnit).toContain('Environment=CHROME_DESKTOP=duet-browser.desktop')
  expect(
    dockItems.some(item =>
      item.includes('file:///usr/share/applications/org.xfce.Catfish.desktop'),
    ),
  ).toBe(true)
  expect(dockItems.filter(item => item.includes('duet-browser.desktop'))).toHaveLength(1)
})

test('image verifier declares live styled-desktop observations', async () => {
  const verifier = await readFile(resolve(import.meta.dir, '../scripts/verify-image.ts'), 'utf8')

  expect(verifier).toContain("fc-match -f '%{family}' Inter")
  expect(verifier).toContain("fc-match -f '%{family}' 'Noto Sans'")
  expect(verifier).toContain('xfconf-query "$@"')
  expect(verifier).toContain('xfconf -c xsettings -p /Net/ThemeName')
  expect(verifier).toContain('xfconf -c xsettings -p /Net/IconThemeName')
  expect(verifier).toContain('xfconf -c xfce4-desktop -p /desktop-icons/style')
  expect(verifier).toContain('xfconf -c xfwm4 -p /general/theme')
  expect(verifier).toContain('pgrep -x xfce4-panel')
  expect(verifier).toContain('pgrep -x devilspie2')
  expect(verifier).toContain('pgrep -x plank')
  expect(verifier).toContain("grep -o 'duet-browser.dockitem'")
  expect(verifier).toContain('test "$dock_browser_count" = 1')
  expect(verifier).toContain("grep -Fx 'LineWidth=4'")
})

test('image verifier declares credential, geometry, and nonblank-framebuffer checks', async () => {
  const verifier = await readFile(resolve(import.meta.dir, '../scripts/verify-image.ts'), 'utf8')

  expect(verifier).toContain('/opt/duet/bin/ensure-kasm-credentials.sh')
  expect(verifier).toContain("-lname '*kasm*'")
  expect(verifier).toContain('test ! -e ${DESKTOP_KASM_AUTH_PATH}')
  expect(verifier).toContain('DESKTOP_KASM_AUTH_PATH')
  expect(verifier).toContain('${DESKTOP_KASM_AUTH_PATH}')
  expect(verifier).toContain("stat -c '%U:%a' ${DESKTOP_KASM_AUTH_PATH}")
  expect(verifier).toContain('test "$password" = "$persisted_password"')
  expect(verifier).toContain('/usr/bin/kasmvncserver :1')
  expect(verifier).toContain('-u "$username:$password"')
  expect(verifier).toContain('127.0.0.1:${DESKTOP_LOOPBACK_PORT}')
  expect(verifier).toContain("'${DESKTOP_SCREEN.width}x${DESKTOP_SCREEN.height} pixels'")
  expect(verifier).toContain('import -window root')
  expect(verifier).toContain('ImageChops.difference(image, flat).getbbox()')
  expect(verifier).toContain('desktop framebuffer remained blank')
  expect(verifier).toContain('/proc/$xvnc_pid/cmdline')
  expect(verifier).toContain('DESKTOP_FRAMEBUFFER_PATH')
  expect(DESKTOP_KASM_AUTH_PATH).toBe('/home/exedev/.duet/desktop/kasm-auth.json')
})

test('syncthing systemd unit pins the version and hardens before the first listen', async () => {
  const unit = await readFile(resolve(import.meta.dir, '../systemd/duet-syncthing.service'), 'utf8')

  expect(unit).toContain('Environment=STNOUPGRADE=1')
  expect(unit).toContain('ExecStartPre=/opt/duet/bin/syncthing-harden.sh')
  // The home stays inside the archived stateDir so identity + index survive
  // retire→restore (MAP-SYNC L16).
  expect(unit).toContain('--home=/home/exedev/.duet/syncthing')
})

test('syncthing-harden writes the full isolation set into an existing config before listen', async () => {
  const homeDir = join(tempDir, 'syncthing')
  await mkdir(homeDir, { recursive: true })
  // A default-shaped config (discovery/relays on, wildcard listener + GUI) —
  // the L20 unhardened first-boot state the ExecStartPre must fix before serve.
  await writeFile(
    join(homeDir, 'config.xml'),
    `<configuration version="37">
  <options>
    <globalAnnounceEnabled>true</globalAnnounceEnabled>
    <relaysEnabled>true</relaysEnabled>
    <listenAddress>default</listenAddress>
    <autoUpgradeIntervalH>12</autoUpgradeIntervalH>
  </options>
  <gui enabled="true">
    <address>0.0.0.0:8384</address>
  </gui>
</configuration>
`,
  )

  await runHardenScript(homeDir)

  const config = await readFile(join(homeDir, 'config.xml'), 'utf8')
  expect(config).toContain('<globalAnnounceEnabled>false</globalAnnounceEnabled>')
  expect(config).toContain('<localAnnounceEnabled>false</localAnnounceEnabled>')
  expect(config).toContain('<relaysEnabled>false</relaysEnabled>')
  expect(config).toContain('<natEnabled>false</natEnabled>')
  expect(config).toContain('<crashReportingEnabled>false</crashReportingEnabled>')
  expect(config).toContain('<urAccepted>-1</urAccepted>')
  expect(config).toContain('<autoUpgradeIntervalH>0</autoUpgradeIntervalH>')
  expect(config).toContain('<listenAddress>tcp://127.0.0.1:22000</listenAddress>')
  expect(config).toContain('<address>127.0.0.1:8384</address>')
  // The wildcard listener/GUI are gone — exactly one loopback listener remains.
  expect(config).not.toContain('0.0.0.0:8384')
  expect(config.match(/<listenAddress>/g)?.length).toBe(1)
})

test('the documented local image build verifies without publishing', async () => {
  const { runtimeFixture } = await import('../../gateway/src/testing/runtime-release-fixture')
  const releaseDir = join(tempDir, 'release')
  await runtimeFixture('local-image-command').write(releaseDir)
  const bootstrap = join(tempDir, 'bootstrap.js')
  await writeFile(bootstrap, 'fixture bootstrap')
  const bin = join(tempDir, 'bin')
  await mkdir(bin)
  const receipt = join(tempDir, 'docker-commands.jsonl')
  // The actual build and verifier execute; only Docker's external boundary is
  // controlled. No container, registry, or user configuration is touched.
  await writeFile(
    join(bin, 'docker'),
    `#!${process.execPath}
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
const args = process.argv.slice(2)
appendFileSync(process.env.VM_BUILD_RECEIPT, JSON.stringify(args) + '\\n')
if (args[0] === 'build') {
  const secret = args[args.indexOf('--secret') + 1]
  if (!secret?.startsWith('id=browser-extension-key,src=')) {
    console.error('image signing key must be supplied through a BuildKit secret')
    process.exit(81)
  }
  const context = args.at(-1)
  const keyPath = secret.slice(secret.indexOf('src=') + 4)
  const ignore = readFileSync(join(context, '.dockerignore'), 'utf8').trim().split('\\n')
  const source = join(context, 'packages/vm-image/desktop/chrome-extension')
  if (!existsSync(keyPath) || !ignore.includes(relative(context, keyPath)) ||
      existsSync(join(source, 'signing-key.pem')) || !existsSync(join(source, 'id'))) {
    console.error('image context must exclude the private key and include its generated public identity')
    process.exit(82)
  }
}
if (args[0] === 'manifest') process.exit(1)
if (args[0] === 'push') process.exit(77)
if (args[0] === 'run' && process.env.VM_BUILD_FAIL_VERIFY === '1') process.exit(23)
`,
    { mode: 0o755 },
  )
  const commands = async () =>
    (await readFile(receipt, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as string[])
  for (const failVerification of [false, true]) {
    await writeFile(receipt, '')
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../scripts/build.ts')], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        IMAGE_REF: 'duet-vm-image:local',
        DUET_RUNTIME_RELEASE_DIR: releaseDir,
        DUET_RUNTIME_BOOTSTRAP_PATH: bootstrap,
        VM_BUILD_RECEIPT: receipt,
        VM_BUILD_FAIL_VERIFY: failVerification ? '1' : '0',
        DESKTOP_FRAMEBUFFER_PATH: '',
        DUET_IMAGE_ENV_FILE: join(tempDir, 'must-not-write.env'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 10_000,
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const observed = await commands()
    const build = observed.find(args => args[0] === 'build')!
    expect(build).toBeDefined()
    expect(build).toContain('BASE_IMAGE=ghcr.io/boldsoftware/exeuntu:latest')
    expect(build).toContain('--secret')
    expect(observed.some(args => args[0] === 'run')).toBe(true)
    expect(
      observed.some(args => args[0] === 'push' || args[0] === 'pull' || args[0] === 'buildx'),
    ).toBe(false)
    expect(await Bun.file(join(tempDir, 'must-not-write.env')).exists()).toBe(false)
    expect(await Bun.file(build.at(-1)!).exists()).toBe(false)
    for (const command of observed.filter(args => args[0] === 'run')) {
      const mount = command.find(arg => arg.endsWith(':/verification-output'))!
      expect(await Bun.file(mount.split(':')[0]!).exists()).toBe(false)
    }
    if (failVerification) {
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('verification step failed (exit 23)')
      expect(stdout).not.toContain('built duet-vm-image:local locally')
    } else {
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
      expect(stdout).toContain('Verification complete!')
      expect(stdout).toContain('built duet-vm-image:local locally')
    }
  }
})

async function runHardenScript(homeDir: string): Promise<void> {
  const script = resolve(import.meta.dir, '../scripts/syncthing-harden.sh')
  await new Promise<void>((resolveRun, reject) => {
    const child = spawn('bash', [script, homeDir], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolveRun()
      else reject(new Error(`harden script exited ${code}: ${stderr}`))
    })
  })
}
