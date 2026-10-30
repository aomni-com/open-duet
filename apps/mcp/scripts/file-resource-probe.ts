import assert from 'node:assert/strict'

import { createApprovedModelCatalog } from '@repo/contract'
import { mcpHarness } from '@repo/test-harness'

import { createMcpServer } from '../src/index'

const workspace = 'file-resource-probe'
const apiOrigin = 'https://api.test'
const gatewayOrigin = 'https://gateway.test'
const vmOrigin = 'https://vm.test'
const calls: string[] = []
const models = [
  { id: 'probe/image', type: 'image' },
  { id: 'probe/video', type: 'video' },
]
const files = new Map<string, { bytes: Uint8Array; mimeType: string }>()

const approvedModelCatalog = createApprovedModelCatalog([
  {
    id: 'image',
    gatewayModelId: 'probe/image',
    kind: 'image',
    name: 'Probe image',
    simpleName: 'Probe image',
    description: 'Local probe image model',
    pricing: { perImage: 0 },
  },
  {
    id: 'video',
    gatewayModelId: 'probe/video',
    kind: 'video',
    name: 'Probe video',
    simpleName: 'Probe video',
    description: 'Local probe video model',
    pricing: { perSecond: 0 },
  },
])

const server = createMcpServer({
  apiBaseUrl: apiOrigin,
  modelGatewayBaseUrl: gatewayOrigin,
  approvedModelCatalog,
  bearerToken: 'duet_sk_probe',
  fetch: async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    calls.push(`${request.method} ${url.origin}${url.pathname}`)

    if (url.pathname === '/v1/whoami') {
      return Response.json({
        scopes: [
          `ws:${workspace}:services`,
          `ws:${workspace}:files:write`,
          `ws:${workspace}:files:read`,
        ],
      })
    }
    if (url.pathname === '/v1/models') {
      assert.equal(request.headers.get('authorization'), 'Bearer duet_sk_probe')
      assert.equal(request.headers.get('x-duet-workspace'), workspace)
      return Response.json({ data: models })
    }
    if (url.pathname === '/v4/ai/image-model') {
      assert.equal(request.headers.get('ai-model-id'), models[0]!.id)
      return Response.json({ images: ['aW1hZ2U='] })
    }
    if (url.pathname === '/v4/ai/video-model') {
      return new Response(
        'data: {"type":"result","videos":[{"type":"base64","data":"dmlkZW8=","mediaType":"video/mp4"}]}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    if (url.pathname === `/v1/ws/${workspace}/file-uploads`) {
      assert.deepEqual(await request.json(), { pathPrefix: 'mcp/generated-media' })
      return Response.json({
        vmBaseUrl: vmOrigin,
        uploadPath: '/v1/files/mcp/generated-media',
        uploadToken: 'upload-token',
        expiresAt: Date.now() + 60_000,
      })
    }
    if (url.origin === vmOrigin && request.method === 'PUT') {
      assert.equal(request.headers.get('authorization'), 'Bearer upload-token')
      const filename = decodeURIComponent(url.pathname.split('/').at(-1)!)
      files.set(`mcp/generated-media/${filename}`, {
        bytes: new Uint8Array(await request.arrayBuffer()),
        mimeType: request.headers.get('content-type') ?? 'application/octet-stream',
      })
      return Response.json({ ok: true })
    }
    if (url.pathname === `/v1/ws/${workspace}/file-downloads`) {
      const { path } = (await request.json()) as { path: string }
      const file = files.get(path)
      assert(file !== undefined)
      return Response.json({
        uri: `${vmOrigin}/v1/files/${path}?grant=download-token`,
        name: path,
        mimeType: file.mimeType,
        size: file.bytes.byteLength,
      })
    }
    throw new Error(`Unexpected probe request: ${request.method} ${url}`)
  },
})

const harness = await mcpHarness(server)
try {
  const discovery = await harness.callTool('list_models', { workspace })
  assert.equal(discovery.isError, undefined)
  assert.deepEqual(discovery.structuredContent, { data: models, nextCursor: null })
  const image = await harness.callTool('generate_media', {
    workspace,
    kind: 'image',
    model: models[0]!.id,
    prompt: 'probe image',
  })
  const video = await harness.callTool('generate_media', {
    workspace,
    kind: 'video',
    prompt: 'probe video',
  })

  for (const result of [image, video]) {
    assert.equal(result.isError, undefined, JSON.stringify({ result, calls }))
    assert.equal(result.content.length, 1)
    assert.equal(result.content[0]?.type, 'resource_link')
    assert.equal(result.structuredContent, undefined)
  }
  assert.deepEqual(
    calls.map(call => call.replace(/[0-9a-f-]{36}\.(png|mp4)$/, '<generated>.$1')),
    [
      `GET ${apiOrigin}/v1/whoami`,
      `GET ${gatewayOrigin}/v1/models`,
      `GET ${apiOrigin}/v1/whoami`,
      `GET ${gatewayOrigin}/v1/models`,
      `POST ${gatewayOrigin}/v4/ai/image-model`,
      `POST ${apiOrigin}/v1/ws/${workspace}/file-uploads`,
      `PUT ${vmOrigin}/v1/files/mcp/generated-media/<generated>.png`,
      `POST ${apiOrigin}/v1/ws/${workspace}/file-downloads`,
      `GET ${apiOrigin}/v1/whoami`,
      `POST ${gatewayOrigin}/v4/ai/video-model`,
      `POST ${apiOrigin}/v1/ws/${workspace}/file-uploads`,
      `PUT ${vmOrigin}/v1/files/mcp/generated-media/<generated>.mp4`,
      `POST ${apiOrigin}/v1/ws/${workspace}/file-downloads`,
    ],
  )

  console.log(
    JSON.stringify(
      { models: discovery.structuredContent, image: image.content[0], video: video.content[0] },
      null,
      2,
    ),
  )
} finally {
  await harness.close()
}
