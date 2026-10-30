import assert from 'node:assert/strict'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  CallToolResultSchema,
  type CallToolResult,
  type ResourceLink,
} from '@modelcontextprotocol/sdk/types.js'

import {
  FileHistoryResponseSchema,
  FileListResponseSchema,
  driveFileExtensionForMimeType,
} from '@repo/contract'

import { safeRequestTarget, type StagingArtifactCollector } from './staging-live-artifacts.ts'
import { bearer, timedFetch } from './staging-live-http.ts'

type ExactFileResourceLink = ResourceLink &
  Required<Pick<ResourceLink, 'mimeType' | 'name' | 'size' | 'uri'>>

const GENERATED_MEDIA_PREFIX = 'mcp/generated-media'
// Stay below the deployed MCP function's 800-second ceiling.
const GENERATION_TIMEOUT_MS = 13 * 60 * 1000
const FILE_EVENT_FLUSH_SETTLE_MS = 6_500
const FILE_EVENT_POLL_TIMEOUT_MS = 60_000

export function extractFileResource(
  result: CallToolResult,
  expected: { name: string; mimeType: string; size: number; text?: string },
): ExactFileResourceLink {
  assert(result.isError === undefined, 'file operation returned an MCP tool error')
  assert(result._meta === undefined, 'file operation retained success _meta')
  assert(
    result.structuredContent === undefined,
    'file operation retained success structuredContent',
  )
  const expectedBlocks = expected.text === undefined ? 1 : 2
  assert.equal(
    result.content.length,
    expectedBlocks,
    `file operation did not return exactly ${expectedBlocks === 1 ? 'one block' : 'two blocks'}`,
  )
  if (expected.text !== undefined) {
    const text = result.content[0]
    assert(text !== undefined && text.type === 'text', 'text file did not start with inline text')
    assert.equal(text.text, expected.text, 'text file returned the wrong inline text')
  }
  const resource = result.content.at(-1)
  assert(resource !== undefined && resource.type === 'resource_link', 'file block was not a link')
  assert.deepEqual(Object.keys(resource).sort(), ['mimeType', 'name', 'size', 'type', 'uri'])
  assert.equal(resource.name, expected.name)
  assert.equal(resource.mimeType, expected.mimeType)
  assert.equal(resource.size, expected.size)
  let uri: URL
  try {
    uri = new URL(resource.uri)
  } catch {
    throw new Error('ResourceLink did not carry a valid URL')
  }
  assert.equal(uri.protocol, 'https:', 'ResourceLink was not HTTPS')
  assert.equal(
    uri.pathname,
    `/v1/files/${encodeDrivePath(expected.name)}`,
    'ResourceLink did not preserve the exact Drive path',
  )
  assert.deepEqual(
    [...uri.searchParams.keys()],
    ['grant'],
    'ResourceLink did not carry exactly one grant query',
  )
  assert.notEqual(uri.searchParams.get('grant'), '', 'ResourceLink carried an empty grant')
  return resource as ExactFileResourceLink
}

export function assertBareFileResponseHeaders(
  response: Response,
  expected: { mimeType: string; size: number; requireLastModified?: boolean },
): void {
  assert.equal(
    response.headers.get('content-type'),
    expected.mimeType,
    'bare ResourceLink response returned the wrong Content-Type',
  )
  assert.equal(
    response.headers.get('content-length'),
    String(expected.size),
    'bare ResourceLink response omitted or returned the wrong Content-Length',
  )
  assert.equal(
    response.headers.get('accept-ranges'),
    'bytes',
    'bare ResourceLink response omitted Accept-Ranges',
  )
  assert(response.headers.get('etag') !== null, 'bare ResourceLink response omitted ETag')
  if (expected.requireLastModified === true) {
    assert(
      response.headers.get('last-modified') !== null,
      'bare ResourceLink response omitted Last-Modified',
    )
  }
}

export async function runMcpFileResourceAcceptance(args: {
  apiUrl: string
  mcpUrl: string
  workspace: string
  token: string
  expectedActor: string
  runId: string
  artifacts: StagingArtifactCollector
}): Promise<void> {
  const textPath = `mcp/file-resource-${args.runId}.txt`
  const text = `Duet MCP file resource ${args.runId}`
  const textBytes = new TextEncoder().encode(text)
  await writeDriveFile(args, textPath, textBytes, 'text/plain; charset=utf-8')

  const path = `mcp/file-resource-${args.runId}.bin`
  const initialBytes = deterministicBytes(32 * 1024, 17)
  await writeDriveFile(args, path, initialBytes, 'application/octet-stream')

  const transport = new StreamableHTTPClientTransport(new URL(args.mcpUrl), {
    requestInit: { headers: bearer(args.token) },
  })
  const client = new Client({ name: 'duet-staging-resource-client', version: '1.0.0' })
  await client.connect(transport)
  try {
    const textResource = extractFileResource(await callReadFile(client, args.workspace, textPath), {
      name: textPath,
      mimeType: 'text/plain; charset=utf-8',
      size: textBytes.byteLength,
      text,
    })
    const first = extractFileResource(await callReadFile(client, args.workspace, path), {
      name: path,
      mimeType: 'application/octet-stream',
      size: initialBytes.byteLength,
    })
    const firstDownload = await verifyBareFileResource(first, initialBytes)

    const replacementBytes = deterministicBytes(8 * 1024 + 1, 91)
    await writeDriveFile(args, path, replacementBytes, 'application/octet-stream')
    const latest = await bareResourceFetch(first.uri, undefined, 'overwrite GET')
    assert.equal(latest.status, 200, 'existing ResourceLink failed after overwrite')
    assertBareFileResponseHeaders(latest, {
      mimeType: first.mimeType,
      size: replacementBytes.byteLength,
      requireLastModified: true,
    })
    await assertSameBytes(
      new Uint8Array(await latest.arrayBuffer()),
      replacementBytes,
      'existing ResourceLink did not serve the latest bytes',
    )
    assert.notEqual(
      latest.headers.get('etag'),
      firstDownload.etag,
      'overwrite did not change the file ETag',
    )

    const renewed = extractFileResource(await callReadFile(client, args.workspace, path), {
      name: path,
      mimeType: 'application/octet-stream',
      size: replacementBytes.byteLength,
    })
    assert(renewed.uri !== first.uri, 'read_file did not renew the resource URI')

    const generationStartedAt = performance.now()
    const generated = extractGeneratedVideoResource(
      await callTool(
        client,
        'generate_media',
        {
          workspace: args.workspace,
          kind: 'video',
          prompt: `A tiny monochrome circle moving once across a blank background, staging acceptance ${args.runId}`,
        },
        GENERATION_TIMEOUT_MS,
      ),
    )
    const generateAndPersistMs = Math.round(performance.now() - generationStartedAt)
    await assertGeneratedFileListed(client, args.workspace, generated)
    const rereadGenerated = extractFileResource(
      await callReadFile(client, args.workspace, generated.name),
      {
        name: generated.name,
        mimeType: generated.mimeType,
        size: generated.size,
      },
    )

    const generatedDownload = await verifyReadAttribution(args, generated)
    const renewedDownloadStartedAt = performance.now()
    const renewedDownload = await bareResourceFetch(
      rereadGenerated.uri,
      undefined,
      'renewed generated video GET',
    )
    assert.equal(renewedDownload.status, 200, 'renewed generated video ResourceLink GET failed')
    assertBareFileResponseHeaders(renewedDownload, {
      mimeType: rereadGenerated.mimeType,
      size: rereadGenerated.size,
      requireLastModified: true,
    })
    const renewedBytes = new Uint8Array(await renewedDownload.arrayBuffer())
    const renewedDownloadMs = Math.round(performance.now() - renewedDownloadStartedAt)
    await assertSameBytes(
      renewedBytes,
      generatedDownload.bytes,
      'renewed generated video ResourceLink returned different bytes',
    )

    await args.artifacts.writeJson('mcp-file-resources.json', {
      client: 'official-mcp-sdk',
      textResource: {
        type: textResource.type,
        target: safeRequestTarget(textResource.uri),
        name: textResource.name,
        mimeType: textResource.mimeType,
        size: textResource.size,
        inline: true,
      },
      resource: {
        type: renewed.type,
        target: safeRequestTarget(renewed.uri),
        name: renewed.name,
        mimeType: renewed.mimeType,
        size: renewed.size,
      },
      bareRequests: firstDownload,
      sha256: {
        initial: await sha256Hex(initialBytes),
        replacement: await sha256Hex(replacementBytes),
      },
      overwrite: {
        status: latest.status,
        contentLength: latest.headers.get('content-length'),
        renewed: true,
      },
      attribution: generatedDownload.attribution,
      generatedVideo: {
        resource: {
          type: generated.type,
          target: safeRequestTarget(generated.uri),
          name: generated.name,
          mimeType: generated.mimeType,
          size: generated.size,
        },
        reread: {
          sameName: rereadGenerated.name === generated.name,
          sameMimeType: rereadGenerated.mimeType === generated.mimeType,
          sameSize: rereadGenerated.size === generated.size,
          renewed: rereadGenerated.uri !== generated.uri,
        },
        platform: {
          outcome: 'completed',
          mcpResultBlocks: 1,
          inlineGeneratedBytes: false,
        },
        timings: {
          generateAndPersistMs,
          uploadMs: null,
          uploadMeasurement: 'included in the opaque generate_media tool duration',
          downloadMs: generatedDownload.durationMs,
          renewedDownloadMs,
        },
        download: {
          status: generatedDownload.status,
          renewedStatus: renewedDownload.status,
          contentLength: String(generatedDownload.bytes.byteLength),
          sha256: await sha256Hex(generatedDownload.bytes),
        },
      },
    })
  } finally {
    await client.close()
  }
}

async function writeDriveFile(
  args: {
    apiUrl: string
    workspace: string
    token: string
    artifacts: StagingArtifactCollector
  },
  path: string,
  bytes: Uint8Array,
  mimeType: string,
): Promise<void> {
  const response = await timedFetch(
    `${args.apiUrl}/v1/ws/${args.workspace}/files/${encodeDrivePath(path)}`,
    {
      method: 'PUT',
      headers: bearer(args.token, { 'content-type': mimeType }),
      body: bytes.slice().buffer as ArrayBuffer,
    },
    args.artifacts,
  )
  assert.equal(response.status, 200, `failed to seed Drive file ${path}`)
}

export function extractGeneratedVideoResource(result: CallToolResult): ExactFileResourceLink {
  assert.equal(result.content.length, 1, 'generated video did not return exactly one block')
  const candidate = result.content[0]
  assert(candidate?.type === 'resource_link', 'generated video result was not a ResourceLink')
  assert(candidate.mimeType !== undefined, 'generated video link omitted its MIME type')
  assert(candidate.size !== undefined, 'generated video link omitted its size')
  assert(candidate.size > 0, 'generated video was empty')
  assert(candidate.mimeType.startsWith('video/'), 'generated video link did not use a video MIME')
  const extension = driveFileExtensionForMimeType(candidate.mimeType)
  assert(extension !== undefined, 'generated video MIME had no canonical Drive extension')
  assert.match(
    candidate.name,
    /^mcp\/generated-media\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]+$/,
    'generated video did not use the durable UUID path',
  )
  assert(candidate.name.endsWith(`.${extension}`), 'generated video extension disagreed with MIME')
  return extractFileResource(result, {
    name: candidate.name,
    mimeType: candidate.mimeType,
    size: candidate.size,
  })
}

async function assertGeneratedFileListed(
  client: Client,
  workspace: string,
  generated: ExactFileResourceLink,
): Promise<void> {
  const result = await callTool(client, 'list_files', {
    workspace,
    path: GENERATED_MEDIA_PREFIX,
  })
  assert(result.isError === undefined, 'list_files rejected the generated-media folder')
  const content = result.content[0]
  assert(content?.type === 'text', 'list_files did not return its JSON text result')
  const listing = FileListResponseSchema.parse(JSON.parse(content.text))
  const entry = listing.items.find(candidate => candidate.path === generated.name)
  assert(entry !== undefined, 'generated video was absent from the ordinary Drive listing')
  assert.equal(entry.type, 'file')
  assert.equal(entry.size, generated.size)
}

async function verifyReadAttribution(
  args: {
    apiUrl: string
    workspace: string
    token: string
    expectedActor: string
    runId: string
    artifacts: StagingArtifactCollector
  },
  resource: ExactFileResourceLink,
): Promise<{
  status: number
  durationMs: number
  bytes: Uint8Array
  attribution: {
    writeCount: number
    writeSameAsMintingActor: boolean
    headReadCount: number
    getReadCount: number
    actorKind: string
    sameAsMintingActor: boolean
  }
}> {
  const written = await waitForFileHistory(
    args,
    resource.name,
    history => history.items.some(row => row.event.kind === 'write'),
    'generated video write attribution',
  )
  assert.equal(
    written.items.filter(row => row.event.kind === 'read').length,
    0,
    'generated-video reference minting emitted a file-read event',
  )
  const writes = written.items.filter(row => row.event.kind === 'write')
  await args.artifacts.writeJson('mcp-file-resource-write-attribution.json', {
    expectedActor: args.expectedActor,
    actors: [...new Set(writes.map(row => row.event.actor))],
    kinds: writes.map(row => row.event.kind),
  })
  assert(writes.length > 0, 'generated video upload did not emit a file-write event')
  assert(
    writes.every(row => row.event.actor === args.expectedActor),
    'generated video upload was not attributed to the minting credential',
  )

  const head = await bareResourceFetch(resource.uri, { method: 'HEAD' }, 'attribution HEAD')
  assert.equal(head.status, 200, 'attribution ResourceLink HEAD failed')
  await new Promise(resolve => setTimeout(resolve, FILE_EVENT_FLUSH_SETTLE_MS))
  const afterHead = await loadFileHistory(args, resource.name)
  const headReads = afterHead.items.filter(row => row.event.kind === 'read')
  assert.equal(headReads.length, 0, 'HEAD or reference minting emitted a file-read event')

  const getStartedAt = performance.now()
  const get = await bareResourceFetch(resource.uri, undefined, 'attribution GET')
  assert.equal(get.status, 200, 'attribution ResourceLink GET failed')
  assertBareFileResponseHeaders(get, {
    mimeType: resource.mimeType,
    size: resource.size,
    requireLastModified: true,
  })
  const bytes = new Uint8Array(await get.arrayBuffer())
  const durationMs = Math.round(performance.now() - getStartedAt)
  assert.equal(bytes.byteLength, resource.size, 'generated video GET size drifted')
  const afterGet = await waitForFileHistory(
    args,
    resource.name,
    history => history.items.some(row => row.event.kind === 'read'),
    'bare GET attribution',
  )
  const getReads = afterGet.items.filter(row => row.event.kind === 'read')
  assert(getReads.length > 0, 'bare GET did not emit a file-read event')
  assert(
    getReads.every(row => row.event.actor === args.expectedActor),
    'bare GET was not attributed to the link-minting credential',
  )
  return {
    status: get.status,
    durationMs,
    bytes,
    attribution: {
      writeCount: writes.length,
      writeSameAsMintingActor: true,
      headReadCount: headReads.length,
      getReadCount: getReads.length,
      actorKind: args.expectedActor.split(':', 1)[0] ?? 'unknown',
      sameAsMintingActor: true,
    },
  }
}

async function waitForFileHistory(
  args: {
    apiUrl: string
    workspace: string
    token: string
    artifacts: StagingArtifactCollector
  },
  path: string,
  predicate: (history: ReturnType<typeof FileHistoryResponseSchema.parse>) => boolean,
  label: string,
): Promise<ReturnType<typeof FileHistoryResponseSchema.parse>> {
  const deadline = Date.now() + FILE_EVENT_POLL_TIMEOUT_MS
  do {
    const history = await loadFileHistory(args, path)
    if (predicate(history)) return history
    await new Promise(resolve => setTimeout(resolve, 500))
  } while (Date.now() < deadline)
  throw new Error(`timed out waiting for ${label}`)
}

async function loadFileHistory(
  args: {
    apiUrl: string
    workspace: string
    token: string
    artifacts: StagingArtifactCollector
  },
  path: string,
): Promise<ReturnType<typeof FileHistoryResponseSchema.parse>> {
  const query = new URLSearchParams({ path, reads: '1' })
  const response = await timedFetch(
    `${args.apiUrl}/v1/ws/${args.workspace}/file-activity?${query}`,
    { headers: bearer(args.token) },
    args.artifacts,
  )
  assert.equal(response.status, 200, 'file activity query failed')
  return FileHistoryResponseSchema.parse(await response.json())
}

async function verifyBareFileResource(
  resource: ExactFileResourceLink,
  expectedBytes: Uint8Array,
): Promise<{
  headStatus: number
  getStatus: number
  rangeStatus: number
  contentType: string | null
  contentLength: string | null
  acceptRanges: string | null
  etag: string | null
  lastModified: string | null
}> {
  const head = await bareResourceFetch(resource.uri, { method: 'HEAD' }, 'HEAD')
  assert.equal(head.status, 200, 'bare ResourceLink HEAD failed')
  assert.equal((await head.arrayBuffer()).byteLength, 0, 'ResourceLink HEAD returned a body')
  assertBareFileResponseHeaders(head, {
    mimeType: resource.mimeType,
    size: expectedBytes.byteLength,
    requireLastModified: true,
  })

  const full = await bareResourceFetch(resource.uri, undefined, 'GET')
  assert.equal(full.status, 200, 'bare ResourceLink GET failed')
  assertBareFileResponseHeaders(full, {
    mimeType: resource.mimeType,
    size: expectedBytes.byteLength,
    requireLastModified: true,
  })
  await assertSameBytes(
    new Uint8Array(await full.arrayBuffer()),
    expectedBytes,
    'bare ResourceLink GET returned the wrong bytes',
  )

  const rangeEnd = Math.min(31, expectedBytes.byteLength - 1)
  const ranged = await bareResourceFetch(
    resource.uri,
    { headers: { range: `bytes=0-${rangeEnd}` } },
    'range GET',
  )
  assert.equal(ranged.status, 206, 'bare ResourceLink range GET failed')
  assertBareFileResponseHeaders(ranged, {
    mimeType: resource.mimeType,
    size: rangeEnd + 1,
    requireLastModified: true,
  })
  assert.equal(
    ranged.headers.get('content-range'),
    `bytes 0-${rangeEnd}/${expectedBytes.byteLength}`,
  )
  await assertSameBytes(
    new Uint8Array(await ranged.arrayBuffer()),
    expectedBytes.slice(0, rangeEnd + 1),
    'bare ResourceLink range GET returned the wrong bytes',
  )
  return {
    headStatus: head.status,
    getStatus: full.status,
    rangeStatus: ranged.status,
    contentType: head.headers.get('content-type'),
    contentLength: head.headers.get('content-length'),
    acceptRanges: head.headers.get('accept-ranges'),
    etag: head.headers.get('etag'),
    lastModified: head.headers.get('last-modified'),
  }
}

async function callReadFile(
  client: Client,
  workspace: string,
  path: string,
): Promise<CallToolResult> {
  return await callTool(client, 'read_file', { workspace, path })
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  timeout?: number,
): Promise<CallToolResult> {
  try {
    const parsed = CallToolResultSchema.safeParse(
      await client.callTool(
        { name, arguments: args },
        CallToolResultSchema,
        timeout === undefined ? undefined : { timeout },
      ),
    )
    if (parsed.success) return parsed.data
  } catch {
    // Replace SDK/network errors because they may include the credential-bearing URI.
  }
  throw new Error(`official MCP client rejected the ${name} result`)
}

async function bareResourceFetch(
  uri: string,
  init: RequestInit | undefined,
  operation: string,
): Promise<Response> {
  try {
    return await fetch(uri, init)
  } catch {
    throw new Error(`bare ResourceLink ${operation} request failed`)
  }
}

async function assertSameBytes(
  actual: Uint8Array,
  expected: Uint8Array,
  message: string,
): Promise<void> {
  assert.equal(actual.byteLength, expected.byteLength, message)
  assert.equal(await sha256Hex(actual), await sha256Hex(expected), message)
}

function encodeDrivePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function deterministicBytes(size: number, seed: number): Uint8Array {
  return Uint8Array.from({ length: size }, (_, index) => (index * 31 + seed) % 256)
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer)
  return Buffer.from(digest).toString('hex')
}
