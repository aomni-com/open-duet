/**
 * Promote the current `:staging` image to `:production` — a remote tag copy of
 * the same digest, no rebuild — and record that immutable digest as
 * DUET_VM_IMAGE_REF in .env.production. Production runs the exact bytes verified
 * on staging, and VMs boot by digest (exe.dev caches the moving tag).
 */
import { run, recordDigestRef } from './image-utils'

const REPO = 'ghcr.io/aomni-com/duet-vm-image'
const envFile = process.env.DUET_IMAGE_ENV_FILE ?? '../../.env.production'

await run('docker', [
  'buildx',
  'imagetools',
  'create',
  '--tag',
  `${REPO}:production`,
  `${REPO}:staging`,
])
const digestRef = await recordDigestRef(`${REPO}:production`, envFile)
console.log(
  `promoted :staging -> :production and recorded DUET_VM_IMAGE_REF=${digestRef} in ${envFile}`,
)
