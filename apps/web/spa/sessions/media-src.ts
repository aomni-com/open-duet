export type ResolvedMediaSrc =
  | { mode: 'remote'; href: string }
  | { mode: 'drive'; drivePath: string }

/**
 * Resolve `segments` onto `base`, collapsing `.` and `..`.
 *
 * `..` that climbs past the drive root is kept rather than dropped. Dropping
 * it would clamp an escaping path onto whatever real file sits at that name;
 * keeping it leaves a path no drive surface can address, which is the honest
 * answer for a link that points outside the drive.
 *
 * `cwd` is drive-relative by contract (AgentCwdSchema rejects a leading "/"
 * and guarantees the path never escapes the root), so a schema-valid cwd like
 * `a/../b` resolves media exactly like `b` — where the agent actually ran.
 */
function resolveSegments(base: readonly string[], segments: readonly string[]): string[] {
  const resolved = [...base]
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') {
      resolved.push(segment)
      continue
    }
    const last = resolved.at(-1)
    if (last === undefined || last === '..') resolved.push('..')
    else resolved.pop()
  }
  return resolved
}

function joinDrivePath(cwd: string, src: string): string {
  return resolveSegments(resolveSegments([], cwd.split('/')), src.split('/')).join('/')
}

export function resolveMediaSrc(input: { src: string; cwd: string | undefined }): ResolvedMediaSrc {
  if (/^https?:\/\//i.test(input.src)) {
    return { mode: 'remote', href: input.src }
  }
  if (input.src.startsWith('/')) {
    return { mode: 'drive', drivePath: input.src }
  }
  return { mode: 'drive', drivePath: joinDrivePath(input.cwd ?? '', input.src) }
}
