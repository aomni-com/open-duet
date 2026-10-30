import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir as mkdirLocal, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  FileHistoryResponseSchema,
  FileListResponseSchema,
  SeenByResponseSchema,
} from '@repo/contract'

import {
  ensureArgCount,
  filePath,
  parseNamedOptions,
  printJsonOrHuman,
  printResult,
  resolveAddress,
  responseJson,
  writeChunk,
  writeJson,
  type CommandContext,
  type CommandRegistry,
  type WritableSink,
} from '../cli-support.js'
import { EXIT_CODES, CliError, usageError } from '../exit-codes.js'

export function registerFileCommands(registry: CommandRegistry): void {
  registry.register('ls', listFiles)
  registry.register('cat', catFile)
  registry.register('pull', pullFile)
  registry.register('push', pushFile)
  registry.register('rm', removeFile)
  registry.register('mkdir', makeDirectory)
  registry.register('history', fileHistory)
  registry.register('seen-by', fileSeenBy)
}

async function listFiles(args: string[], ctx: CommandContext): Promise<void> {
  const { positionals, values } = parseNamedOptions(args, ['cursor', 'limit'])
  ensureArgCount(positionals, 1, 'ls <workspace:/path> [--cursor <cursor>] [--limit <n>]')
  const address = resolveAddress(
    positionals[0]!,
    ctx.env.DUET_WORKSPACE ?? ctx.config.defaultWorkspace,
    true,
    ctx.global.workspace,
  )
  const params = new URLSearchParams({ list: '1' })
  const cursor = values.cursor?.at(-1)
  if (cursor !== undefined) params.set('cursor', cursor)
  const limit = values.limit?.at(-1)
  if (limit !== undefined) params.set('limit', limit)
  const response = await ctx.api.request(`${filePath(address)}?${params}`)
  await printJsonOrHuman(response, ctx, body => {
    const page = FileListResponseSchema.parse(body)
    const lines = page.items.map(entry => entry.name)
    if (page.nextCursor !== null) lines.push(`next: ${page.nextCursor}`)
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`
  })
}

async function catFile(args: string[], ctx: CommandContext): Promise<void> {
  ensureArgCount(args, 1, 'cat <workspace:/path>')
  const address = resolveAddress(
    args[0]!,
    ctx.env.DUET_WORKSPACE ?? ctx.config.defaultWorkspace,
    false,
    ctx.global.workspace,
  )
  const response = await ctx.api.request(filePath(address))
  if (ctx.global.json) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    writeJson(ctx.io.stdout, {
      workspace: address.workspaceSlug,
      path: address.path,
      contentBase64: Buffer.from(bytes).toString('base64'),
    })
    return
  }
  await writeResponseBody(response, ctx.io.stdout)
}

async function pullFile(args: string[], ctx: CommandContext): Promise<void> {
  ensureArgCount(args, 2, 'pull <workspace:/path> <local>')
  const address = resolveAddress(
    args[0]!,
    ctx.env.DUET_WORKSPACE ?? ctx.config.defaultWorkspace,
    false,
    ctx.global.workspace,
  )
  const local = args[1]!
  const response = await ctx.api.request(filePath(address))
  await mkdirLocal(dirname(local), { recursive: true })
  const bytes = await writeResponseToFile(response, local)
  printResult(
    ctx,
    { ok: true, workspace: address.workspaceSlug, path: address.path, local, bytes },
    `Pulled ${bytes} bytes to ${local}\n`,
  )
}

async function pushFile(args: string[], ctx: CommandContext): Promise<void> {
  ensureArgCount(args, 2, 'push <local> <workspace:/path>')
  const local = args[0]!
  const address = resolveAddress(
    args[1]!,
    ctx.env.DUET_WORKSPACE ?? ctx.config.defaultWorkspace,
    false,
    ctx.global.workspace,
  )
  const info = await stat(local).catch(() => {
    throw new CliError('not_found', `Local file not found: ${local}`, EXIT_CODES.notFound)
  })
  if (!info.isFile()) throw usageError(`Local path is not a file: ${local}`)
  const response = await ctx.api.request(filePath(address), {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: createReadStream(local) as unknown as RequestInit['body'],
  })
  const body = await responseJson(response)
  printResult(
    ctx,
    {
      ok: true,
      workspace: address.workspaceSlug,
      path: address.path,
      bytes: info.size,
      result: body,
    },
    `Pushed ${info.size} bytes to ${address.workspaceSlug}:${address.path}\n`,
  )
}

async function removeFile(args: string[], ctx: CommandContext): Promise<void> {
  ensureArgCount(args, 1, 'rm <workspace:/path>')
  const address = resolveAddress(
    args[0]!,
    ctx.env.DUET_WORKSPACE ?? ctx.config.defaultWorkspace,
    false,
    ctx.global.workspace,
  )
  const response = await ctx.api.request(filePath(address), { method: 'DELETE' })
  const body = await responseJson(response)
  printResult(
    ctx,
    { ok: true, workspace: address.workspaceSlug, path: address.path, result: body },
    `Removed ${address.workspaceSlug}:${address.path}\n`,
  )
}

async function makeDirectory(args: string[], ctx: CommandContext): Promise<void> {
  ensureArgCount(args, 1, 'mkdir <workspace:/path>')
  const address = resolveAddress(
    args[0]!,
    ctx.env.DUET_WORKSPACE ?? ctx.config.defaultWorkspace,
    false,
    ctx.global.workspace,
  )
  const response = await ctx.api.request(
    `/ws/${encodeURIComponent(address.workspaceSlug)}/files/actions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operation: 'mkdir', path: address.path.slice(1), recursive: false }),
    },
  )
  const body = await responseJson(response)
  printResult(
    ctx,
    { ok: true, workspace: address.workspaceSlug, path: address.path, result: body },
    `Created ${address.workspaceSlug}:${address.path}\n`,
  )
}

const HISTORY_USAGE = 'history <workspace:/path> [--cursor <cursor>] [--limit <n>] [--reads 0|1]'

async function fileHistory(args: string[], ctx: CommandContext): Promise<void> {
  const { positionals, values } = parseNamedOptions(args, ['cursor', 'limit', 'reads'])
  ensureArgCount(positionals, 1, HISTORY_USAGE)
  const address = resolveAddress(
    positionals[0]!,
    ctx.env.DUET_WORKSPACE ?? ctx.config.defaultWorkspace,
    false,
    ctx.global.workspace,
  )
  const params = new URLSearchParams({ path: address.path.slice(1) })
  const cursor = values.cursor?.at(-1)
  if (cursor !== undefined) params.set('cursor', cursor)
  const limit = values.limit?.at(-1)
  if (limit !== undefined) params.set('limit', limit)
  const reads = values.reads?.at(-1)
  if (reads !== undefined) {
    if (reads !== '0' && reads !== '1') throw usageError(`--reads must be 0 or 1`)
    params.set('reads', reads)
  }
  const response = await ctx.api.request(
    `/ws/${encodeURIComponent(address.workspaceSlug)}/file-activity?${params}`,
  )
  await printJsonOrHuman(response, ctx, body => {
    const page = FileHistoryResponseSchema.parse(body)
    const lines = page.items.map(row => {
      const event = row.event
      const path =
        event.kind === 'rename'
          ? `${String(event.fromPath)} -> ${String(event.path)}`
          : 'path' in event && typeof event.path === 'string'
            ? event.path
            : '(workspace)'
      return `${row.seq}\t${String(event.kind)}\t${path}\t${String(event.actor)}\t${isoTime(event.at)}`
    })
    if (page.nextCursor !== null) lines.push(`next: ${page.nextCursor}`)
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`
  })
}

async function fileSeenBy(args: string[], ctx: CommandContext): Promise<void> {
  const { positionals, values } = parseNamedOptions(args, ['cursor', 'limit'])
  ensureArgCount(positionals, 1, 'seen-by <workspace:/path> [--cursor <cursor>] [--limit <n>]')
  const address = resolveAddress(
    positionals[0]!,
    ctx.env.DUET_WORKSPACE ?? ctx.config.defaultWorkspace,
    false,
    ctx.global.workspace,
  )
  const params = new URLSearchParams({ path: address.path.slice(1) })
  const cursor = values.cursor?.at(-1)
  if (cursor !== undefined) params.set('cursor', cursor)
  const limit = values.limit?.at(-1)
  if (limit !== undefined) params.set('limit', limit)
  const response = await ctx.api.request(
    `/ws/${encodeURIComponent(address.workspaceSlug)}/file-activity/seen-by?${params}`,
  )
  await printJsonOrHuman(response, ctx, body => {
    const page = SeenByResponseSchema.parse(body)
    const lines = page.items.map(
      row =>
        `${String(row.actor)}\treads=${String(row.readCount)}\twrites=${String(row.writeCount)}\tlast=${isoTime(row.lastAt)}`,
    )
    if (page.nextCursor !== null) lines.push(`next: ${page.nextCursor}`)
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`
  })
}

function isoTime(at: unknown): string {
  return typeof at === 'number' ? new Date(at).toISOString() : String(at)
}

async function writeResponseBody(response: Response, sink: WritableSink): Promise<void> {
  if (response.body === null) return
  const reader = response.body.getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return
    writeChunk(sink, chunk.value)
  }
}

async function writeResponseToFile(response: Response, local: string): Promise<number> {
  if (response.body === null) {
    await writeFile(local, new Uint8Array())
    return 0
  }
  let bytes = 0
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength
      controller.enqueue(chunk)
    },
  })
  await pipeline(
    Readable.fromWeb(response.body.pipeThrough(counted) as never),
    createWriteStream(local),
  )
  return bytes
}
