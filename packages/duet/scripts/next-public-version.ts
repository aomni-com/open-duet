const STABLE_VERSION = /^(\d+)\.(\d+)\.(\d+)$/

function parseVersion(value: string): [number, number, number] {
  const match = STABLE_VERSION.exec(value.trim())
  if (!match) throw new Error(`Expected a stable semver, got ${JSON.stringify(value)}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareVersion(a: [number, number, number], b: [number, number, number]): number {
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

/** Keeps an intentional local major/minor release; otherwise advances npm by one patch. */
export function nextReleaseVersion(localVersion: string, publishedVersion: string): string {
  const local = parseVersion(localVersion)
  const published = parseVersion(publishedVersion)
  if (compareVersion(local, published) > 0) return `${local[0]}.${local[1]}.${local[2]}`
  return `${published[0]}.${published[1]}.${published[2] + 1}`
}

if (import.meta.main) {
  const local = process.argv[2]
  const published = process.argv[3]
  if (!local || !published) throw new Error('Usage: next-public-version <local> <published>')
  console.log(nextReleaseVersion(local, published))
}
