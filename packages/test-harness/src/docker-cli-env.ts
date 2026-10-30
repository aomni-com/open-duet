import { execFileSync } from 'node:child_process'

const DEFAULT_IMAGE = 'oven/bun:1.3.14'
const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000

export interface DockerRunScriptOptions {
  image?: string
  script: string
  env?: Record<string, string>
  volumes?: string[]
  timeoutMs?: number
}

export interface DockerCliEnv {
  runScript(options: DockerRunScriptOptions): string
}

export function dockerTestsOptedIn(): boolean {
  return process.env.RUN_DOCKER_TESTS === '1'
}

function dockerDaemonAnswers(): boolean {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore', timeout: 10_000 })
    return true
  } catch {
    return false
  }
}

export function assertDockerCliReady(): void {
  if (!dockerTestsOptedIn()) {
    throw new Error('Docker-backed tests require RUN_DOCKER_TESTS=1.')
  }
  if (!dockerDaemonAnswers()) {
    throw new Error('RUN_DOCKER_TESTS=1 is set, but the Docker daemon did not answer.')
  }
}

export function dockerCliEnv(): DockerCliEnv {
  assertDockerCliReady()
  return {
    runScript({
      image = DEFAULT_IMAGE,
      script,
      env = {},
      volumes = [],
      timeoutMs = DEFAULT_TIMEOUT_MS,
    }: DockerRunScriptOptions): string {
      const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`])
      const volumeArgs = volumes.flatMap(volume => ['-v', volume])
      return execFileSync(
        'docker',
        ['run', '--rm', ...envArgs, ...volumeArgs, image, 'bash', '-lc', script],
        {
          encoding: 'utf-8',
          timeout: timeoutMs,
          maxBuffer: 16 * 1024 * 1024,
        },
      )
    },
  }
}
