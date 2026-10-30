import { VmVersionMetadataSchema } from '@repo/contract'

/** Select destination bytes; the workspace's realized image is historical state. */
export function resolveVmImageRef(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  const imageRef = override ?? env.DUET_VM_IMAGE_REF
  if (!imageRef?.trim()) throw new Error('DUET_VM_IMAGE_REF is required')
  return VmVersionMetadataSchema.parse(imageRef)
}
