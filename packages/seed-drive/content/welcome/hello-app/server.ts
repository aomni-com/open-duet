import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type Task = {
  id: string
  title: string
  createdAt: number
}

type StoredTasks = {
  tasks: Task[]
}

type HelloAppOptions = {
  directory?: string
  port?: number
}

export function createHelloApp(options: HelloAppOptions = {}) {
  const sourceDirectory = dirname(fileURLToPath(import.meta.url))
  const directory = options.directory ?? sourceDirectory
  const storePath = join(directory, 'tasks.json')
  const page = Bun.file(join(sourceDirectory, 'page.html')).text()
  const tasks = createTaskRepository(storePath)
  const watchers = new Map<ReadableStreamDefaultController<Uint8Array>, () => void>()
  const encoder = new TextEncoder()

  function broadcast(task: Task): void {
    const frame = encoder.encode(`id: ${task.id}\ndata: ${JSON.stringify({ task })}\n\n`)
    for (const [controller, close] of watchers) {
      try {
        controller.enqueue(frame)
      } catch {
        close()
      }
    }
  }

  async function fetchRequest(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === '/api/tasks') {
      return Response.json(await tasks.read())
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      const title = await readTitle(request)
      if (title === undefined) {
        return Response.json(
          { error: 'Title must be between 1 and 160 characters.' },
          { status: 400 },
        )
      }
      const task = await tasks.add(title)
      broadcast(task)
      return Response.json({ task }, { status: 201 })
    }
    if (request.method === 'GET' && url.pathname === '/events') {
      let heartbeat: ReturnType<typeof setInterval> | undefined
      let controller: ReadableStreamDefaultController<Uint8Array>
      let closed = false
      const close = (): void => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        request.signal.removeEventListener('abort', abort)
        watchers.delete(controller)
      }
      const abort = (): void => {
        close()
        try {
          controller.close()
        } catch {
          // The stream may already be closing through cancellation.
        }
      }
      const stream = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController
          watchers.set(controller, close)
          request.signal.addEventListener('abort', abort, { once: true })
          controller.enqueue(encoder.encode(': connected\n\n'))
          heartbeat = setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': heartbeat\n\n'))
            } catch {
              close()
            }
          }, 15_000)
        },
        cancel: close,
      })
      return new Response(stream, {
        headers: {
          'cache-control': 'no-cache',
          'content-type': 'text/event-stream',
        },
      })
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(await page, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }
    return new Response('Not found', { status: 404 })
  }

  const server = Bun.serve({
    port: options.port ?? Number(Bun.env.PORT ?? 3000),
    idleTimeout: 255,
    fetch: fetchRequest,
  })

  return {
    url: server.url,
    stop: () => server.stop(true),
    watcherCount: () => watchers.size,
    fetch: fetchRequest,
  }
}

async function readTitle(request: Request): Promise<string | undefined> {
  try {
    const body = (await request.json()) as { title?: unknown }
    if (typeof body.title !== 'string') return undefined
    const title = body.title.trim()
    return title.length > 0 && title.length <= 160 ? title : undefined
  } catch {
    return undefined
  }
}

function createTaskRepository(path: string) {
  let stored: StoredTasks | undefined
  let writes = Promise.resolve()

  async function read(): Promise<StoredTasks> {
    stored ??= await readTaskStore(path)
    return structuredClone(stored)
  }

  async function add(title: string): Promise<Task> {
    const result = writes.then(async () => {
      const current = await read()
      const task = { id: crypto.randomUUID(), title, createdAt: Date.now() }
      const next = { tasks: [...current.tasks, task] }
      await writeTaskStore(path, next)
      stored = next
      return task
    })
    writes = result.then(
      () => undefined,
      () => undefined,
    )
    return await result
  }

  return { read, add }
}

async function readTaskStore(path: string): Promise<StoredTasks> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as StoredTasks
  } catch (error) {
    if (isMissingFile(error)) return { tasks: [] }
    throw error
  }
}

async function writeTaskStore(path: string, store: StoredTasks): Promise<void> {
  const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, path)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

if (import.meta.main) {
  const app = createHelloApp()
  console.log(`Workspace hello listening on ${app.url}`)
}
