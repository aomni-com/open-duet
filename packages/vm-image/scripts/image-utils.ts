import { spawn } from 'node:child_process'

/** Run a command, inheriting stdio. Rejects on non-zero exit. */
export function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
  })
}

/** Run a command and return its stdout (stderr still inherited). */
export function runCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', chunk => {
      out += String(chunk)
    })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) resolve(out)
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
  })
}

/** Resolve a tag's immutable manifest digest (sha256:…) from the registry. */
export async function resolveDigest(ref: string): Promise<string> {
  const out = await runCapture('docker', ['buildx', 'imagetools', 'inspect', ref])
  const digest = out.match(/Digest:\s*(sha256:[0-9a-f]{64})/)?.[1]
  if (!digest) throw new Error(`could not resolve a digest for ${ref}`)
  return digest
}

/**
 * Record a tagged image's immutable digest as DUET_VM_IMAGE_REF in `envFile`.
 * exe.dev caches images by tag, so a moved tag serves stale content to VMs —
 * the provisioner must boot by digest, not the moving tag. Returns the digest ref.
 */
export async function recordDigestRef(taggedRef: string, envFile: string): Promise<string> {
  const digest = await resolveDigest(taggedRef)
  const digestRef = `${taggedRef.replace(/:[^:/]+$/, '')}@${digest}`
  await run('bunx', ['dotenvx', 'set', 'DUET_VM_IMAGE_REF', digestRef, '-f', envFile])
  return digestRef
}
