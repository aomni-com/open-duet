import { createHash } from 'node:crypto'

import { SkillsBundleSchema, type SkillsBundle, type SkillsBundleFile } from '@repo/contract'

export type BuiltSkillsBundle = {
  bundle: SkillsBundle
  bytes: string
  hash: string
}

export function buildSkillsBundle(files: readonly SkillsBundleFile[]): BuiltSkillsBundle {
  const bundle = SkillsBundleSchema.parse({
    version: 1,
    files: [...files].sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    ),
  })
  const bytes = JSON.stringify(bundle)
  const hash = createHash('sha256').update(bytes, 'utf8').digest('hex')
  return { bundle, bytes, hash }
}
