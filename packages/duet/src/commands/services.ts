import { readFile } from 'node:fs/promises'

import { X_DUET_GATEWAY_HEADER } from '@repo/contract'

import { parseNamedOptions, resolveWorkspace, writeJson, writeText, type CommandContext, type CommandRegistry } from '../cli-support.js'
import { CliError, EXIT_CODES, usageError } from '../exit-codes.js'
import { throwHttpError } from '../http.js'

export function registerServiceCommands(registry: CommandRegistry): void {
  registry.register('services', services)
}

async function services(args: string[], ctx: CommandContext): Promise<void> {
  const [operation, ...rest] = args
  if (operation === 'search') return await search(rest, ctx)
  if (operation === 'show') return await show(rest, ctx)
  if (operation === 'call') return await call(rest, ctx)
  throw usageError('Usage: duet services search|show|call ...')
}

async function search(args: string[], ctx: CommandContext): Promise<void> {
  const options = parseNamedOptions(args, ['category', 'cursor'])
  const query = options.positionals[0]
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (options.values.category?.[0]) params.set('category', options.values.category[0]!)
  if (options.values.cursor?.[0]) params.set('cursor', options.values.cursor[0]!)
  const result = await (await ctx.api.request(`/services${params.size ? `?${params}` : ''}`)).json()
  if (ctx.global.json) return writeJson(ctx.io.stdout, result)
  for (const item of (result as { items: Array<{ id: string; name: string; summary: string; category: string }> }).items) writeText(ctx.io.stdout, `${item.id}\t${item.category}\t${item.name}\t${item.summary}\n`)
}

async function show(args: string[], ctx: CommandContext): Promise<void> {
  const options = parseNamedOptions(args, [])
  const id = options.positionals[0]
  if (!id) throw usageError('services show requires a service id.')
  const result = await (await ctx.api.request(`/services/${encodeURIComponent(id)}`)).json()
  if (ctx.global.json) return writeJson(ctx.io.stdout, result)
  const service = result as { name: string; docsUrl: string; notes: string; proxyBaseUrl: string; routes: Array<{ method: string; path: string; billing: string }> }
  writeText(ctx.io.stdout, `${service.name}\nDocs: ${service.docsUrl}\nProxy: ${service.proxyBaseUrl}\n${service.notes}\n`)
  for (const route of service.routes.slice(0, 12)) writeText(ctx.io.stdout, `${route.method} ${route.path} (${route.billing})\n`)
  if (service.routes.length > 12) writeText(ctx.io.stdout, `… ${service.routes.length - 12} more (use --json for all)\n`)
}

async function call(args: string[], ctx: CommandContext): Promise<void> {
  const [id, method, path, ...rest] = args
  if (!id || !method || !path) throw usageError('Usage: duet services call <id> <METHOD> <path> [options]')
  const options = parseNamedOptions(rest, ['body', 'form', 'query', 'out', 'header'])
  const workspace = resolveWorkspace(ctx)
  const headers = new Headers({ 'x-duet-workspace': workspace })
  for (const value of options.values.header ?? []) {
    const equals = value.indexOf('=')
    if (equals <= 0) throw usageError('--header requires name=value.')
    headers.set(value.slice(0, equals), value.slice(equals + 1))
  }
  let body: RequestInit['body']
  const bodyValue = options.values.body?.[0]
  if (bodyValue) {
    const source = bodyValue.startsWith('@') ? await readFile(bodyValue.slice(1), 'utf8') : bodyValue
    body = source
    headers.set('content-type', 'application/json')
  }
  if (options.values.form?.length) {
    const form = new FormData()
    for (const value of options.values.form) {
      const equals = value.indexOf('=')
      if (equals <= 0) throw usageError('--form requires name=value.')
      const field = value.slice(0, equals)
      const content = value.slice(equals + 1)
      form.set(field, content.startsWith('@') ? new Blob([await readFile(content.slice(1))]) : content)
    }
    body = form
  }
  const query = new URLSearchParams()
  for (const value of options.values.query ?? []) {
    const equals = value.indexOf('=')
    if (equals <= 0) throw usageError('--query requires name=value.')
    query.set(value.slice(0, equals), value.slice(equals + 1))
  }
  const response = await ctx.api.request(`/services/${encodeURIComponent(id)}${path.startsWith('/') ? path : `/${path}`}${query.size ? `?${query}` : ''}`, { method, headers, body, errorMode: 'raw' })
  const contentType = response.headers.get('content-type') ?? ''
  const chargeUsd = response.headers.get('x-duet-charge-usd')
  if (!response.ok) {
    if (response.headers.get(X_DUET_GATEWAY_HEADER) === 'block') await throwHttpError(response)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const output = options.values.out?.[0]
    if (output) await Bun.write(output, bytes)
    else writeText(ctx.io.stdout, new TextDecoder().decode(bytes))
    writeText(ctx.io.stderr, `HTTP ${response.status}\n`)
    throw new CliError('service_error', `Service request failed with HTTP ${response.status}.`, EXIT_CODES.generic)
  }
  if (contentType.includes('application/json')) {
    const parsed = await response.json()
    if (ctx.global.json) return writeJson(ctx.io.stdout, { status: response.status, contentType, chargeUsd, body: parsed })
    return writeJson(ctx.io.stdout, parsed)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  const output = options.values.out?.[0]
  if (!output && !contentType.startsWith('text/')) throw new CliError('usage', 'Binary response requires --out <file>.', EXIT_CODES.usage)
  if (output) {
    await Bun.write(output, bytes)
    writeText(ctx.io.stdout, `wrote ${output} (${bytes.byteLength} bytes)${chargeUsd ? ` · billed $${chargeUsd}` : ''}\n`)
  } else writeText(ctx.io.stdout, new TextDecoder().decode(bytes))
}
