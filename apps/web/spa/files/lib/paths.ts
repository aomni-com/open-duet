/** Why a segment cannot appear in a browser path, or `undefined` if it can. */
function rejectedSegment(part: string): string | undefined {
  if (part === '') return 'an empty segment'
  if (part === '.' || part === '..') return `a "${part}" segment`
  if (part === '.duet') return 'a ".duet" segment, which is not part of the drive'
  if (part.includes('\0')) return 'a NUL byte'
  return undefined
}

export function normalizeBrowserFilePath(path: string, allowRoot = false): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (normalized.length === 0) {
    if (allowRoot) return ''
    throw new Error('A file path is required')
  }
  const parts = normalized.split('/')
  /* The path is in the message, because this throws on agent-authored strings
     and on VM-absolute paths that only look like drive paths — and a bare
     "Invalid file path" in a browser console names neither. */
  for (const part of parts) {
    const reason = rejectedSegment(part)
    if (reason !== undefined) {
      throw new Error(`Invalid file path ${JSON.stringify(path)}: ${reason}`)
    }
  }
  return parts.join('/')
}

/**
 * Whether the drive can address this path at all.
 *
 * For callers that are handed agent-authored text and must degrade rather
 * than fail — naming a file is part of rendering a message, so a path the
 * drive cannot address has to stay ordinary text, not throw mid-render.
 */
export function isBrowserFilePath(path: string): boolean {
  return path
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .every(part => rejectedSegment(part) === undefined)
}

export function encodeBrowserFilePath(path: string): string {
  return normalizeBrowserFilePath(path).split('/').map(encodeURIComponent).join('/')
}

/**
 * Converts the absolute browser dialect to the relative wire/anchor dialect.
 * Percent signs are file-name bytes here; raw-URL decoding belongs to the route parser.
 */
export function anchorPathFromBrowserPath(browserPath: string): string {
  if (!browserPath.startsWith('/') || browserPath.includes('\\')) {
    throw new Error('A browser path must be absolute and use forward-slash separators')
  }
  const anchorPath = normalizeBrowserFilePath(browserPath, true)
  const canonicalBrowserPath = anchorPath.length === 0 ? '/' : `/${anchorPath}`
  if (canonicalBrowserPath !== browserPath) throw new Error('Invalid browser path')
  return anchorPath
}

/** Converts the relative wire/anchor dialect to the absolute browser dialect. */
export function browserPathFromAnchorPath(anchorPath: string): string {
  if (anchorPath.startsWith('/') || anchorPath.includes('\\')) {
    throw new Error('An anchor path must be relative and use forward-slash separators')
  }
  const normalized = normalizeBrowserFilePath(anchorPath)
  if (normalized !== anchorPath) throw new Error('Invalid anchor path')
  return `/${normalized}`
}

export function joinBrowserFilePath(parent: string, name: string): string {
  const parentPath = normalizeBrowserFilePath(parent, true)
  const child = normalizeBrowserFilePath(name)
  if (child.includes('/')) throw new Error('A name cannot contain path separators')
  return `/${parentPath.length === 0 ? child : `${parentPath}/${child}`}`
}

export function parentBrowserFilePath(path: string): string {
  const normalized = normalizeBrowserFilePath(path, true)
  if (normalized.length === 0) return '/'
  const parts = normalized.split('/')
  parts.pop()
  return parts.length === 0 ? '/' : `/${parts.join('/')}`
}

export function fileName(path: string): string {
  return normalizeBrowserFilePath(path).split('/').at(-1)!
}
