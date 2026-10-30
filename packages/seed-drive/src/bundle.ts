import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildDeterministicArchive, type DeterministicArchive } from './deterministic-bundle'

const CONTENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'content')

export interface SeedArchive {
  bytes: Uint8Array
  sha256: string
}

interface InspectedSeedArchive extends SeedArchive {
  entries: string[]
}

export async function buildSeedArchive(): Promise<SeedArchive> {
  const { bytes, sha256 } = await buildSeedArchiveFromContent(CONTENT_DIR)
  return { bytes, sha256 }
}

export function inspectSeedArchive(): Promise<InspectedSeedArchive> {
  return buildSeedArchiveFromContent(CONTENT_DIR)
}

export function buildSeedArchiveFromContent(contentDir: string): Promise<DeterministicArchive> {
  return buildDeterministicArchive(contentDir, 'drive')
}
