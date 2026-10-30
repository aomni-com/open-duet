import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { probeReportUrl } from './probe-artifacts.ts'
import {
  assertNoDuetTestVms,
  cleanup,
  createVm,
  fenced,
  makeContext,
  ms,
  runOrThrow,
  time,
  vmName,
  writeReport,
} from './probe-common.ts'

const PORT = 7331
const DATE = '2026-07-06'

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

interface Attempt {
  mode: string
  vmName: string
  createMs: number
  sshReadyMs?: number
  serviceReadyMs?: number
  restartMs?: number
  restartSshReadyMs?: number
  restartServiceReadyMs?: number
  pid1?: string
  systemdState?: string
  firstBody?: string
  restartBody?: string
  verdict: 'works' | 'failed'
  failure?: string
  deleted?: string[]
}

function execFileAsync(
  file: string,
  args: string[],
  timeoutMs = 600_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CommandResult> {
  return new Promise(resolve => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        const code =
          typeof (error as { code?: unknown } | null)?.code === 'number'
            ? (error as { code: number }).code
            : error
              ? 1
              : 0
        resolve({ stdout, stderr, exitCode: code })
      },
    )
  })
}

async function runLocal(
  command: string,
  args: string[],
  timeoutMs?: number,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await execFileAsync(command, args, timeoutMs, env)
  if (result.exitCode !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (exit ${result.exitCode})\n${result.stderr || result.stdout}`,
    )
  }
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
}

async function buildAndPushImage(): Promise<{ image: string; buildLog: string; pushLog: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'duet-test-image-'))
  try {
    const dockerConfig = join(dir, '.docker')
    await mkdir(dockerConfig)
    const dockerEnv = { ...process.env, DOCKER_CONFIG: dockerConfig }
    const image = `ttl.sh/duet-test-image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}:1h`

    await writeFile(
      join(dir, 'Dockerfile'),
      `FROM ubuntu:24.04
ENV container=docker
RUN apt-get update \\
  && apt-get install -y --no-install-recommends ca-certificates curl openssh-server python3 systemd systemd-sysv \\
  && rm -rf /var/lib/apt/lists/* \\
  && useradd -m -s /bin/bash exedev \\
  && mkdir -p /home/exedev/app /run/sshd \\
  && chown -R exedev:exedev /home/exedev/app
COPY hello-server.py /home/exedev/app/hello-server.py
COPY hello-exedev.service /etc/systemd/system/hello-exedev.service
RUN chmod 0644 /etc/systemd/system/hello-exedev.service \\
  && systemctl enable ssh.service hello-exedev.service
EXPOSE ${PORT}
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
`,
    )
    await writeFile(
      join(dir, 'hello-server.py'),
      `from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"hello from systemd\\n"
        self.send_response(200)
        self.send_header("content-type", "text/plain")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, fmt, *args):
        return

ThreadingHTTPServer(("0.0.0.0", ${PORT}), Handler).serve_forever()
`,
    )
    await writeFile(
      join(dir, 'hello-exedev.service'),
      `[Unit]
Description=Duet exe.dev probe HTTP service
After=network-online.target
Wants=network-online.target

[Service]
User=exedev
WorkingDirectory=/home/exedev/app
ExecStart=/usr/bin/python3 /home/exedev/app/hello-server.py
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
`,
    )

    const buildLog = await runLocal(
      'docker',
      ['build', '--platform', 'linux/amd64', '-t', image, dir],
      undefined,
      dockerEnv,
    )
    const pushLog = await runLocal('docker', ['push', image], undefined, dockerEnv)
    return { image, buildLog, pushLog }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function waitForHttp(
  ssh: typeof import('../src/exe.ts').ExeClient.prototype,
  sshDest: string,
): Promise<string> {
  const deadline = performance.now() + 120_000
  let last = ''
  for (;;) {
    const result = await ssh.exec(
      sshDest,
      `curl -fsS --max-time 2 http://127.0.0.1:${PORT}/`,
      5_000,
    )
    if (result.exitCode === 0) return result.stdout.trim()
    last = result.stderr || result.stdout
    if (performance.now() >= deadline) {
      throw new Error(`HTTP service did not answer on ${PORT}. Last output:\n${last}`)
    }
    await Bun.sleep(1_000)
  }
}

async function probeMode(image: string, mode: string, command: string): Promise<Attempt> {
  const ctx = makeContext()
  await ctx.control.whoami()
  const name = vmName(`image-${mode}`)
  let attempt: Attempt = { mode, vmName: name, createMs: 0, verdict: 'failed' }
  try {
    const created = await createVm(ctx, {
      name,
      image,
      command,
      comment: `agent-drive ${DATE} ${mode} image/systemd probe`,
    })
    attempt.createMs = created.durationMs

    const sshReady = await time(() =>
      ctx.ssh.waitUntilReady(created.value.ssh_dest, { timeoutMs: 180_000 }),
    )
    attempt.sshReadyMs = sshReady.durationMs

    const serviceReady = await time(() => waitForHttp(ctx.ssh, created.value.ssh_dest))
    attempt.serviceReadyMs = serviceReady.durationMs
    attempt.firstBody = serviceReady.value
    attempt.pid1 = await runOrThrow(ctx.ssh, created.value.ssh_dest, 'cat /proc/1/comm')
    attempt.systemdState = await runOrThrow(
      ctx.ssh,
      created.value.ssh_dest,
      'systemctl is-active hello-exedev.service 2>&1 || true',
    )

    const restarted = await time(() => ctx.control.restart(created.value.vm_name))
    attempt.restartMs = restarted.durationMs
    const restartReady = await time(() =>
      ctx.ssh.waitUntilReady(created.value.ssh_dest, { timeoutMs: 180_000 }),
    )
    attempt.restartSshReadyMs = restartReady.durationMs
    const restartServiceReady = await time(() => waitForHttp(ctx.ssh, created.value.ssh_dest))
    attempt.restartServiceReadyMs = restartServiceReady.durationMs
    attempt.restartBody = restartServiceReady.value

    attempt.verdict =
      attempt.firstBody === 'hello from systemd' &&
      attempt.restartBody === 'hello from systemd' &&
      attempt.pid1 === 'systemd' &&
      attempt.systemdState === 'active'
        ? 'works'
        : 'failed'
    if (attempt.verdict === 'failed') {
      attempt.failure = `service answered but systemd proof was incomplete: pid1=${attempt.pid1}, state=${attempt.systemdState}`
    }
  } catch (error) {
    attempt.failure = error instanceof Error ? error.message : String(error)
  } finally {
    const cleaned = await cleanup(ctx)
    attempt.deleted = cleaned.deleted
    if (cleaned.deleteErrors.length > 0) {
      attempt.failure =
        `${attempt.failure ?? ''}\nCleanup errors:\n${cleaned.deleteErrors.join('\n')}`.trim()
    }
  }
  return attempt
}

function report(
  image: string,
  buildLog: string,
  pushLog: string,
  attempts: Attempt[],
  noLeaks: boolean,
): string {
  const working = attempts.find(a => a.verdict === 'works')
  const fallback = attempts.find(a => a.firstBody && a.restartBody)
  const active = working ?? fallback
  const verdict = working
    ? `works: custom image boots with systemd as PID1 in ${working.mode} mode`
    : fallback
      ? `partial: service survives boot/restart, but systemd-as-PID1 was not proven in ${fallback.mode} mode`
      : 'failed: no attempted boot mode produced a reachable service'

  const attemptLines = attempts
    .map(
      a =>
        `- ${a.mode}: ${a.verdict}` +
        `, vm=${a.vmName}` +
        (a.pid1 ? `, pid1=${a.pid1}` : '') +
        (a.systemdState ? `, unit=${a.systemdState}` : '') +
        (a.createMs ? `, new=${ms(a.createMs)}` : '') +
        (a.sshReadyMs ? `, ssh-ready=${ms(a.sshReadyMs)}` : '') +
        (a.serviceReadyMs ? `, service-ready=${ms(a.serviceReadyMs)}` : '') +
        (a.restartMs ? `, restart=${ms(a.restartMs)}` : '') +
        (a.restartSshReadyMs ? `, restart-ssh-ready=${ms(a.restartSshReadyMs)}` : '') +
        (a.restartServiceReadyMs ? `, restart-service-ready=${ms(a.restartServiceReadyMs)}` : '') +
        (a.deleted?.length ? `, deleted=${a.deleted.join(',')}` : '') +
        (a.failure ? `\n  Failure: ${a.failure.split('\n')[0]}` : ''),
    )
    .join('\n')

  return (
    `# Custom image + systemd boot proof

Date: ${DATE}
Marker: SLICE01B-PROBES-5T8V

## Verdict

${verdict}.

The image was pushed anonymously to ttl.sh as \`${image}\`. The private-registry path is \`new --image <registry>/<image>:<tag> --registry-auth USERNAME:PASSWORD\`; the credential value is a single flag argument for the registry hosting \`--image\`. This probe did not log in to a registry and did not write registry credentials.

## Evidence

${attemptLines}

Key observed lines:

${fenced(
  [
    active?.pid1 ? `/proc/1/comm=${active.pid1}` : undefined,
    active?.systemdState
      ? `systemctl is-active hello-exedev.service=${active.systemdState}`
      : undefined,
    active?.firstBody ? `first boot curl=http 200 ${JSON.stringify(active.firstBody)}` : undefined,
    active?.restartBody
      ? `after restart curl=http 200 ${JSON.stringify(active.restartBody)}`
      : undefined,
    `duet-test leak check=${noLeaks ? 'none' : 'failed'}`,
  ]
    .filter(Boolean)
    .join('\n'),
)}

## Mechanics pinned

- ` +
    '`ssh exe.dev help new`' +
    ` exposes \`--command\` values \`auto\`, \`none\`, or a custom command, \`--image\`, \`--tag\`, \`--cpu\`, \`--memory\`, and \`--registry-auth USERNAME:PASSWORD\`.
- The systemd proof requires both an HTTP response on a 3000-9999 port and \`/proc/1/comm=systemd\` with the unit active after first boot and after \`restart\`.
- All VMs created by this probe used \`--cpu 1 --memory 2GB --tag duet-test\` and names starting \`duet-test-\`.

## Local image build

${fenced(
  [
    'docker build --platform linux/amd64 -t ttl.sh/<unique-name>:1h <generated-context>',
    'docker push ttl.sh/<unique-name>:1h',
    buildLog.split('\n').slice(-6).join('\n'),
    pushLog.split('\n').slice(-6).join('\n'),
  ].join('\n'),
)}
`
  )
}

// ── Slice-10 helper-supervision lifecycle probe ────────────────────────────
// Runs the REAL gateway helper supervisor (createHelperSupervisor + the
// production helper.js bundle) on a real exe.dev VM, under a systemd transient
// unit when systemd is PID1, and asserts the slice-10 lifecycle contract:
//   - the supervisor spawns the sudo helper child and it reaches `ready`;
//   - SIGKILL of the helper generation → supervised restart (helperRestarts++);
//   - stop()/unit teardown leaves NO orphaned helper process.
// Release-artifact swapping (index.js + helper.js + helperSha256 manifest) is
// covered by the gateway-update + release-build unit tests; this probe covers
// the live supervision that only a real VM can prove.
const HELPER_WORK = '/tmp/duet-helper-supervision'
const HELPER_ENTRY = new URL('../../gateway/src/attribution/helper-main.ts', import.meta.url)
const SUPERVISOR_ENTRY = new URL(
  '../../gateway/src/attribution/helper-supervisor.ts',
  import.meta.url,
)
const HELPER_REPORT = probeReportUrl('helper-supervision.md')

interface HelperLifecycle {
  readyOk: boolean
  firstPid: number | null
  killed: boolean
  restarted: boolean
  secondPid: number | null
  restarts: number
  orphanAfterStop: boolean
  systemd: boolean
  error: string | null
}

interface HelperProbeResult {
  vmName: string
  verdict: 'works' | 'failed'
  lifecycle?: HelperLifecycle
  failure?: string
  rawStdout?: string
  deleted?: string[]
}

function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Chunked base64 upload over `ssh exec` — no scp dependency (probe-common style). */
async function uploadFile(
  ssh: typeof import('../src/exe.ts').ExeClient.prototype,
  sshDest: string,
  remotePath: string,
  content: string | Uint8Array,
  gzipped: boolean,
): Promise<void> {
  const bytes = Buffer.from(content)
  const encoded = (gzipped ? Buffer.from(Bun.gzipSync(bytes)) : bytes).toString('base64')
  const b64Path = `${remotePath}.b64`
  await runOrThrow(ssh, sshDest, `rm -f ${b64Path}`)
  for (let offset = 0; offset < encoded.length; offset += 48_000) {
    const chunk = encoded.slice(offset, offset + 48_000)
    await runOrThrow(ssh, sshDest, `printf %s ${q(chunk)} >> ${b64Path}`)
  }
  const decode = gzipped
    ? `base64 -d ${b64Path} | gunzip > ${remotePath}`
    : `base64 -d ${b64Path} > ${remotePath}`
  await runOrThrow(ssh, sshDest, `${decode} && rm ${b64Path}`)
}

/**
 * The VM-side driver: the "gateway" stand-in. It uses the REAL slice-10
 * supervisor (imported from the repo by absolute path at bundle time) to manage
 * the REAL helper.js, then internally drives and reports the lifecycle so the
 * whole assertion is deterministic and self-contained.
 */
export function driverSource(): string {
  return String.raw`import { createHelperSupervisor, spawnHelperProcess } from ${JSON.stringify(
    fileURLToPath(SUPERVISOR_ENTRY),
  )}
import { mkdirSync, writeFileSync } from 'node:fs'

const WORK = ${JSON.stringify(HELPER_WORK)}
const DRIVE = '/home/exedev/drive'
mkdirSync(DRIVE + '/sub', { recursive: true })
writeFileSync(DRIVE + '/seed.txt', 'x')

function helperPids(): number[] {
  const r = Bun.spawnSync(['pgrep', '-f', 'helper.js'])
  return r.stdout
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(Number)
    .filter(n => Number.isInteger(n) && n !== process.pid)
}
async function waitFor(fn: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fn()) return true
    await Bun.sleep(200)
  }
  return false
}

const out = {
  readyOk: false,
  firstPid: null as number | null,
  killed: false,
  restarted: false,
  secondPid: null as number | null,
  restarts: 0,
  orphanAfterStop: true,
  systemd: process.env.INVOCATION_ID !== undefined,
  error: null as string | null,
}
const sup = createHelperSupervisor({
  helperPath: WORK + '/helper.js',
  driveDir: DRIVE,
  spawn: spawnHelperProcess,
  onEvent: () => {},
  onDown: () => {},
  backoff: { baseMs: 200, maxMs: 2000 },
  log: fields => console.error('SUP:' + JSON.stringify(fields)),
})
try {
  await Promise.race([
    sup.start(),
    new Promise((_r, rej) => setTimeout(() => rej(new Error('ready timeout')), 30000)),
  ])
  out.readyOk = true
  await waitFor(() => helperPids().length > 0, 10000)
  const firstGen = new Set(helperPids())
  out.firstPid = [...firstGen][0] ?? null
  Bun.spawnSync(['pkill', '-9', '-f', 'helper.js'])
  out.killed = true
  out.restarted = await waitFor(() => {
    const now = helperPids()
    return now.length > 0 && now.every(p => !firstGen.has(p))
  }, 15000)
  out.secondPid = helperPids()[0] ?? null
  out.restarts = sup.stats().helperRestarts
  await sup.stop()
  out.orphanAfterStop = !(await waitFor(() => helperPids().length === 0, 8000))
} catch (e) {
  out.error = e instanceof Error ? e.message : String(e)
} finally {
  try {
    await sup.stop()
  } catch {}
}
console.log('PROBE-JSON:' + JSON.stringify(out))
process.exit(0)
`
}

async function buildBundle(entry: string): Promise<string> {
  const build = Bun.spawnSync(['bun', 'build', entry, '--target=bun'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (build.exitCode !== 0) throw new Error(`bun build failed for ${entry}: ${build.stderr}`)
  return build.stdout.toString()
}

export async function runHelperLifecycleProbe(): Promise<HelperProbeResult> {
  const ctx = makeContext()
  const name = vmName('helper-supervision')
  const result: HelperProbeResult = { vmName: name, verdict: 'failed' }
  try {
    await ctx.control.whoami()

    // Bundle the production helper and a driver that imports the REAL supervisor.
    const helperBundle = await buildBundle(fileURLToPath(HELPER_ENTRY))
    const driverDir = await mkdtemp(join(tmpdir(), 'duet-supervisor-driver-'))
    let driverBundle: string
    try {
      const driverEntry = join(driverDir, 'driver.ts')
      await writeFile(driverEntry, driverSource())
      driverBundle = await buildBundle(driverEntry)
    } finally {
      await rm(driverDir, { recursive: true, force: true })
    }

    const created = await createVm(ctx, {
      name,
      comment: 'duet slice-10: helper supervision lifecycle',
    })
    const dest = created.value.ssh_dest
    await ctx.ssh.waitUntilReady(dest, { timeoutMs: 180_000 })
    await runOrThrow(ctx.ssh, dest, "sudo -n true && echo 'sudo -n true: ok'")
    await runOrThrow(ctx.ssh, dest, 'curl -fsSL https://bun.sh/install | bash', 180_000)
    await runOrThrow(ctx.ssh, dest, `mkdir -p ${HELPER_WORK}`)
    await uploadFile(ctx.ssh, dest, `${HELPER_WORK}/helper.js`, helperBundle, true)
    await uploadFile(ctx.ssh, dest, `${HELPER_WORK}/driver.js`, driverBundle, true)

    const bun = '/home/exedev/.bun/bin/bun'
    // Prefer real systemd supervision (transient unit) when systemd is PID1;
    // otherwise run the driver directly under sudo (still a real supervised
    // lifecycle, just parented by the ssh session). Either way the driver
    // self-reports the lifecycle verdict.
    const isSystemd =
      (await ctx.ssh.exec(dest, 'cat /proc/1/comm', 5_000)).stdout.trim() === 'systemd'
    const command = isSystemd
      ? `sudo systemd-run --unit=duet-helper-probe --collect --wait --pipe ${bun} ${HELPER_WORK}/driver.js`
      : `sudo ${bun} ${HELPER_WORK}/driver.js`
    const run = await ctx.ssh.exec(dest, command, 180_000)
    result.rawStdout = `${run.stdout}\n${run.stderr}`.slice(-4000)
    const marker = run.stdout.indexOf('PROBE-JSON:')
    if (marker < 0) {
      throw new Error(`driver produced no PROBE-JSON. exit=${run.exitCode}\n${result.rawStdout}`)
    }
    const lifecycle = JSON.parse(
      run.stdout.slice(marker + 'PROBE-JSON:'.length).split('\n')[0] ?? '{}',
    ) as HelperLifecycle
    result.lifecycle = lifecycle
    const ok =
      lifecycle.error === null &&
      lifecycle.readyOk &&
      lifecycle.firstPid !== null &&
      lifecycle.killed &&
      lifecycle.restarted &&
      lifecycle.secondPid !== null &&
      lifecycle.secondPid !== lifecycle.firstPid &&
      lifecycle.restarts >= 1 &&
      !lifecycle.orphanAfterStop
    result.verdict = ok ? 'works' : 'failed'
    if (!ok) {
      result.failure = `lifecycle assertion failed: ${JSON.stringify(lifecycle)}`
    }
  } catch (error) {
    result.failure = error instanceof Error ? error.message : String(error)
  } finally {
    const cleaned = await cleanup(ctx)
    result.deleted = cleaned.deleted
    if (cleaned.deleteErrors.length > 0) {
      result.failure =
        `${result.failure ?? ''}\nCleanup errors:\n${cleaned.deleteErrors.join('\n')}`.trim()
    }
  }
  return result
}

export function helperReport(result: HelperProbeResult): string {
  const l = result.lifecycle
  return `# Helper supervision lifecycle (slice 10)

Date: ${DATE}

## Verdict

${
  result.verdict === 'works'
    ? 'works: the real supervisor spawns the helper, restarts it after SIGKILL, and leaves no orphan on stop.'
    : `failed: ${result.failure ?? 'see evidence'}`
}

## Evidence

${fenced(
  [
    `vm=${result.vmName}`,
    l ? `systemd-supervised=${l.systemd}` : undefined,
    l ? `ready=${l.readyOk}` : undefined,
    l ? `firstHelperPid=${l.firstPid}` : undefined,
    l ? `sigkilled=${l.killed}` : undefined,
    l ? `restarted=${l.restarted} (helperRestarts=${l.restarts})` : undefined,
    l ? `secondHelperPid=${l.secondPid}` : undefined,
    l ? `orphanAfterStop=${l.orphanAfterStop}` : undefined,
    l?.error ? `driverError=${l.error}` : undefined,
    result.deleted?.length ? `deleted=${result.deleted.join(',')}` : undefined,
  ]
    .filter(Boolean)
    .join('\n'),
)}

${result.rawStdout ? `## Driver tail\n\n${fenced(result.rawStdout)}\n` : ''}`
}

async function main(): Promise<void> {
  const ctx = makeContext()
  await ctx.control.whoami()

  let image = ''
  let buildLog = ''
  let pushLog = ''
  const attempts: Attempt[] = []
  let noLeaks = false
  try {
    const built = await buildAndPushImage()
    image = built.image
    buildLog = built.buildLog
    pushLog = built.pushLog

    attempts.push(await probeMode(image, 'auto', 'auto'))
    if (!attempts.some(a => a.verdict === 'works')) {
      attempts.push(await probeMode(image, 'custom-/sbin/init', '/sbin/init'))
    }
    if (!attempts.some(a => a.firstBody && a.restartBody)) {
      attempts.push(
        await probeMode(
          image,
          'custom-direct-server',
          `/usr/bin/python3 /home/exedev/app/hello-server.py`,
        ),
      )
    }

    await assertNoDuetTestVms(ctx.control)
    noLeaks = true
  } finally {
    await writeReport('probe-image-systemd.md', report(image, buildLog, pushLog, attempts, noLeaks))
  }

  // Slice-10 gate: the live helper-supervision lifecycle on a real VM.
  const helperResult = await runHelperLifecycleProbe()
  await writeFile(fileURLToPath(HELPER_REPORT), helperReport(helperResult))

  const working = attempts.find(a => a.verdict === 'works')
  if (!working) {
    throw new Error(
      'Image/systemd probe did not prove systemd as PID1. See probe-results/reports/probe-image-systemd.md',
    )
  }
  if (helperResult.verdict !== 'works') {
    throw new Error(
      `Helper supervision probe failed: ${helperResult.failure ?? 'see probe-results/reports/helper-supervision.md'}`,
    )
  }
  console.log(
    `image/systemd works: mode=${working.mode}, pid1=${working.pid1}, restartService=${ms(working.restartServiceReadyMs ?? 0)}`,
  )
  console.log(
    `helper supervision works: restarts=${helperResult.lifecycle?.restarts}, ` +
      `firstPid=${helperResult.lifecycle?.firstPid}, secondPid=${helperResult.lifecycle?.secondPid}, ` +
      `orphanAfterStop=${helperResult.lifecycle?.orphanAfterStop}`,
  )
}

if (import.meta.main) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
