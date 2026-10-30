import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { syncRoot } from './daemon-status.js'

// Per-user launchd LaunchAgent for the always-on daemon (spec file-attribution
// slice 22). `install` and `uninstall` are symmetric and idempotent, and touch
// ONLY this one agent — a Syncthing or any other launch agent already on the
// machine is never read or rewritten. The agent runs `duet sync daemon` at
// login with keep-alive; the daemon itself waits out a missing login rather than
// exiting, so launchd never sees a crash loop before the user runs
// `duet login`.

export const LAUNCH_AGENT_LABEL = 'so.duet.sync'

export function launchAgentsDir(home: string): string {
  return join(home, 'Library', 'LaunchAgents')
}

export function launchAgentPlistPath(home: string): string {
  return join(launchAgentsDir(home), `${LAUNCH_AGENT_LABEL}.plist`)
}

export interface RenderPlistInput {
  label: string
  programArguments: string[]
  stdoutPath: string
  stderrPath: string
  path?: string
}

/**
 * Render the LaunchAgent plist. Pure and deterministic so it is unit-tested and
 * so re-installing over an identical config writes byte-identical XML.
 */
export function renderLaunchAgentPlist(input: RenderPlistInput): string {
  const args = input.programArguments
    .map(arg => `      <string>${xmlEscape(arg)}</string>`)
    .join('\n')
  const pathEntry =
    input.path === undefined
      ? ''
      : `    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${xmlEscape(input.path)}</string>
    </dict>
`
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(input.label)}</string>
    <key>ProgramArguments</key>
    <array>
${args}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
${pathEntry}    <key>StandardOutPath</key>
    <string>${xmlEscape(input.stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(input.stderrPath)}</string>
  </dict>
</plist>
`
}

export interface LaunchctlResult {
  code: number
  stderr: string
}

export type RunLaunchctl = (args: string[]) => Promise<LaunchctlResult>

export interface LaunchdEnv {
  home: string
  uid: number
  /** Node/Bun executable that runs the daemon script. */
  execPath: string
  /** The duet CLI entry (`dist/cli-entry.js`) the agent invokes. */
  scriptPath: string
  path?: string
  runLaunchctl?: RunLaunchctl
  log?: (fields: Record<string, unknown>) => void
}

export interface InstallResult {
  label: string
  plistPath: string
}

/** Install (or replace) the LaunchAgent and load it. Idempotent. */
export async function installLaunchAgent(env: LaunchdEnv): Promise<InstallResult> {
  const run = env.runLaunchctl ?? defaultRunLaunchctl
  const log = env.log ?? (() => {})
  const plistPath = launchAgentPlistPath(env.home)
  const logPath = join(syncRoot(env.home), 'daemon.log')

  await mkdir(launchAgentsDir(env.home), { recursive: true })
  await mkdir(syncRoot(env.home), { recursive: true, mode: 0o700 })
  const plist = renderLaunchAgentPlist({
    label: LAUNCH_AGENT_LABEL,
    programArguments: [env.execPath, env.scriptPath, 'sync', 'daemon'],
    stdoutPath: logPath,
    stderrPath: logPath,
    path: env.path,
  })
  await writeFile(plistPath, plist, { mode: 0o644 })

  // Replace any already-loaded copy: booting out first makes bootstrap idempotent
  // (bootstrap errors if the label is already loaded).
  await run(['bootout', `gui/${env.uid}/${LAUNCH_AGENT_LABEL}`])
  const bootstrap = await run(['bootstrap', `gui/${env.uid}`, plistPath])
  if (bootstrap.code !== 0) {
    log({ operation: 'launchctl_bootstrap_failed', code: bootstrap.code, stderr: bootstrap.stderr })
    throw new Error(`launchctl bootstrap failed (${bootstrap.code}): ${bootstrap.stderr.trim()}`)
  }
  return { label: LAUNCH_AGENT_LABEL, plistPath }
}

export interface UninstallResult {
  label: string
  plistPath: string
  wasLoaded: boolean
}

/** Boot out the agent and remove its plist. Idempotent — succeeds when nothing
 * is installed. */
export async function uninstallLaunchAgent(env: LaunchdEnv): Promise<UninstallResult> {
  const run = env.runLaunchctl ?? defaultRunLaunchctl
  const plistPath = launchAgentPlistPath(env.home)
  const bootout = await run(['bootout', `gui/${env.uid}/${LAUNCH_AGENT_LABEL}`])
  const wasLoaded = bootout.code === 0
  await rm(plistPath, { force: true })
  return { label: LAUNCH_AGENT_LABEL, plistPath, wasLoaded }
}

async function defaultRunLaunchctl(args: string[]): Promise<LaunchctlResult> {
  const proc = Bun.spawn(['launchctl', ...args], { stdout: 'ignore', stderr: 'pipe' })
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  return { code, stderr }
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
