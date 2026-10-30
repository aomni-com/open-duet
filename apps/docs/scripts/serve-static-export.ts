import { existsSync } from 'node:fs'
import path from 'node:path'

interface StaticExportServerOptions {
  readonly root?: string
  readonly hostname?: string
  readonly port?: number
}

const DEFAULT_ROOT = path.resolve(import.meta.dirname, '../out')

export function createStaticExportServer({
  root = DEFAULT_ROOT,
  hostname = process.env.HOST ?? '127.0.0.1',
  port = Number(process.env.PORT ?? 3001),
}: StaticExportServerOptions = {}): ReturnType<typeof Bun.serve> {
  const exportRoot = path.resolve(root)
  for (const requiredFile of ['index.html', '404.html']) {
    if (!existsSync(path.join(exportRoot, requiredFile))) {
      throw new Error(`docs static export is missing ${requiredFile}; run \`bun run build\` first`)
    }
  }

  return Bun.serve({
    hostname,
    port,
    fetch: request => serveStaticExport(request, exportRoot),
  })
}

async function serveStaticExport(request: Request, root: string): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { allow: 'GET, HEAD' },
    })
  }

  const pathname = decodePathname(new URL(request.url).pathname)
  const filePath = pathname === null ? null : await resolveExportedFile(root, pathname)
  const status = filePath === null ? 404 : 200
  const file = Bun.file(filePath ?? path.join(root, '404.html'))

  return new Response(request.method === 'HEAD' ? null : file, {
    status,
    headers: { 'content-type': file.type },
  })
}

function decodePathname(pathname: string): string | null {
  try {
    const decoded = decodeURIComponent(pathname)
    return decoded.includes('\0') ? null : decoded
  } catch {
    return null
  }
}

async function resolveExportedFile(root: string, pathname: string): Promise<string | null> {
  const relativePath = pathname.replace(/^\/+/, '')
  const candidates =
    relativePath === ''
      ? ['index.html']
      : path.extname(relativePath)
        ? [relativePath]
        : [path.join(relativePath, 'index.html')]

  for (const candidate of candidates) {
    const filePath = path.resolve(root, candidate)
    const relativeToRoot = path.relative(root, filePath)
    if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`)) continue
    if (await Bun.file(filePath).exists()) return filePath
  }
  return null
}

if (import.meta.main) {
  const server = createStaticExportServer()
  console.log(`Docs static export listening on ${server.url}`)
}
