import { open } from 'node:fs/promises'

import { parseScrapedUrlFrontmatter, type ScrapedUrlFrontmatter } from '@repo/contract'

/**
 * How much of a file to read looking for YAML frontmatter. A scrape's header
 * is a few hundred bytes; this ceiling is what keeps "is this a scraped page?"
 * a bounded question rather than a whole-file read.
 */
const FRONTMATTER_PREFIX_BYTES = 64 * 1024

/**
 * The URL a scraped page came from, or undefined for an ordinary file.
 *
 * Scrapes carry their own provenance in frontmatter rather than in a sidecar
 * or a manifest field, which is why a copy of one still knows where it came
 * from — the staging inbox and the training archive both rely on that, and
 * both read it through here.
 */
export async function readScrapeProvenance(
  path: string,
  size: number,
): Promise<ScrapedUrlFrontmatter | undefined> {
  const file = await open(path, 'r')
  try {
    const prefix = Buffer.alloc(Math.min(size, FRONTMATTER_PREFIX_BYTES))
    const { bytesRead } = await file.read(prefix, 0, prefix.byteLength, 0)
    return parseScrapedUrlFrontmatter(prefix.subarray(0, bytesRead).toString('utf8')) ?? undefined
  } finally {
    await file.close()
  }
}
