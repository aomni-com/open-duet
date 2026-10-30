import { readFile, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'

import { streamText, type ImagePart, type ModelMessage } from 'ai'

import { transportModelId, type TransportName } from '@repo/agent/model-resolution/catalog'
import { generateMedia } from '@repo/agent/model-resolution/generate-media'
import {
  createDuetModelGateway,
  fetchModelCatalog,
  type ModelType,
} from '@repo/agent/model-resolution/model-gateway'
import { resolveModelName } from '@repo/agent/model-resolution/resolver'
import { APPROVED_MODELS, modelByRole, ModelSelectionIdSchema } from '@repo/contract'

import { printModelHelp } from './help.js'
import { selectTextModel } from './model-selection.js'
import { fail, loadCliEnvFiles, resolveUserPath } from './shared.js'

/**
 * High-level capability the CLI routes a request to. The gateway catalog uses
 * `language` for text models; everything else maps straight through. `--type`
 * lets the user override routing when the catalog is missing or wrong.
 */
type RequestType = 'text' | 'image' | 'video'

/** Values OpenAI's image endpoint accepts for `background`. */
type ImageBackground = 'transparent' | 'opaque' | 'auto'

/** Parsed `duet model` flags. Prompt is positional or read from stdin. */
interface ModelArgs {
  model?: string
  /** Curated shorthand to inspect without issuing a model request. */
  resolve?: string
  /** Transport whose catalog mapping and resolved pi-ai spec should be inspected. */
  transport?: TransportName
  type?: RequestType
  imagePath?: string
  out?: string
  system?: string
  size?: string
  aspect?: string
  /**
   * OpenAI image models' `background` option. `transparent` returns an RGBA
   * PNG with the alpha channel populated; asking for transparency in the
   * prompt alone does not. Sent as `providerOptions.openai.background`, so
   * other providers ignore it.
   */
  background?: ImageBackground
  n?: number
  seed?: number
  duration?: number
  resolution?: string
  fps?: number
  maxRetries?: number
  envFile?: string
  prompt?: string
  help: boolean
}

/**
 * Map a gateway catalog capability to the CLI request type. `language` covers
 * text models, including the gemini `*-image` models that emit images as message
 * files; those are still text completions, so `--type image` is what reroutes
 * them. An unknown/missing catalog entry defaults to text.
 */
export function requestTypeForCapability(type: ModelType | undefined): RequestType {
  if (type === 'image') return 'image'
  if (type === 'video') return 'video'
  return 'text'
}

/** Image file extension -> media type, for inlining vision input parts. */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

/**
 * Generate a timestamped output filename like `model-20260629T141500-1.png`.
 * Used when the user does not pass `--out` for image/video generations so each
 * run lands a distinct, sortable file. Lives here so the image and video units
 * share one naming scheme.
 */
export function autoOutputFilename(extension: string, index = 1): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
  return `model-${stamp}-${index}${extension}`
}

/** Run `duet model` — call a gateway model directly via the AI SDK. */
export async function runModelCommand(args: string[]): Promise<void> {
  const parsed = parseArgs(args)
  if (parsed.help) {
    printModelHelp()
    return
  }
  await loadCliEnvFiles(process.cwd(), parsed.envFile)

  if (parsed.resolve || parsed.transport) {
    printResolvedTransportModel(parsed.resolve, parsed.transport)
    return
  }

  const prompt = parsed.prompt ?? (await readStdin())
  if (!prompt.trim()) fail('Missing prompt (pass as an argument or via stdin)')

  const model =
    parsed.type === 'image' || parsed.type === 'video'
      ? (parsed.model ?? modelByRole(APPROVED_MODELS, parsed.type)!.gatewayModelId)
      : await selectTextModel(parsed.model, Boolean(parsed.imagePath))

  // The catalog is only needed to auto-detect the type or to tell a dedicated
  // image model from a language model that emits images; forced text/video skip
  // it. Fetch at most once and thread the result into the image path.
  const inferType =
    parsed.type === undefined &&
    parsed.model !== undefined &&
    !ModelSelectionIdSchema.safeParse(parsed.model).success
  const capability =
    inferType || parsed.type === 'image' ? await lookupCapability(model) : undefined
  const requestType = parsed.type ?? (inferType ? requestTypeForCapability(capability) : 'text')
  if (requestType === 'image') {
    await runMediaPath({ ...parsed, model, prompt, capability }, 'image')
    return
  }
  if (requestType === 'video') {
    await runMediaPath({ ...parsed, model, prompt }, 'video')
    return
  }

  await runTextPath({ ...parsed, model, prompt })
}

/** Generate media through the shared SDK owner and keep filesystem output CLI-owned. */
async function runMediaPath(
  parsed: ModelArgs & { model: string; prompt: string; capability?: ModelType },
  kind: 'image' | 'video',
): Promise<void> {
  const result = await generateMedia({
    gateway: createDuetModelGateway({ mode: 'direct-generation' }),
    model: parsed.model,
    kind,
    capability: parsed.capability,
    prompt: parsed.prompt,
    system: parsed.system,
    ...(kind === 'image' && parsed.capability === 'language'
      ? { messages: [{ role: 'user', content: await buildContent(parsed) }] }
      : kind === 'image'
        ? { imagePrompt: await buildImagePrompt(parsed) }
        : { videoPrompt: await buildVideoPrompt(parsed) }),
    ...(kind === 'video'
      ? {
          aspectRatio: parseAspect(parsed.aspect),
          resolution: parseResolution(parsed.resolution),
          duration: parsed.duration,
          fps: parsed.fps,
        }
      : parsed.capability !== 'language'
        ? { size: parseSize(parsed.size), aspectRatio: parseAspect(parsed.aspect) }
        : {}),
    n: parsed.n,
    seed: parsed.seed,
    background: parsed.background,
    maxRetries: parsed.maxRetries,
  }).catch(failOnBillingError)
  if (kind === 'image' && parsed.capability === 'language' && result.files.length === 0) {
    fail(`Model ${parsed.model} returned no images`)
  }
  if (kind !== 'image' || parsed.capability !== 'language') {
    for (const warning of result.warnings)
      process.stderr.write(`warning: ${JSON.stringify(warning)}\n`)
  }
  const single = result.files.length === 1
  for (const [index, file] of result.files.entries()) {
    const path = resolveOutputPath(
      parsed.out,
      mediaTypeExtension(file.mediaType),
      index + 1,
      single,
    )
    await writeFile(path, file.uint8Array)
    process.stdout.write(`${path}\n`)
  }
}

/**
 * Video prompt: text alone for text->video, or `{ image, text }` when `--image`
 * supplies a still to animate. URL-only providers receive the URL unchanged;
 * local files use the SDK byte path.
 */
async function buildVideoPrompt(parsed: ModelArgs & { prompt: string }) {
  if (!parsed.imagePath) return parsed.prompt
  if (/^https?:\/\//i.test(parsed.imagePath)) {
    return { image: parsed.imagePath, text: parsed.prompt }
  }
  const source = await readFile(resolveUserPath(parsed.imagePath))
  return { image: new Uint8Array(source), text: parsed.prompt }
}

/**
 * Gateway billing gates (402 requires-payment, 403 forbidden) carry a
 * plain-English body; surface it verbatim so the user knows to pay rather than
 * seeing an opaque SDK stack. Shared by the image, language-image, and video
 * paths since any paid model can hit it. Anything else rethrows unchanged.
 */
function failOnBillingError(error: unknown): never {
  const status = (error as { statusCode?: number })?.statusCode
  if (status === 402 || status === 403) {
    const body = (error as { responseBody?: string }).responseBody
    const message = (error as { message?: string }).message ?? 'billing error'
    fail(`${status}: ${body ?? message}`)
  }
  throw error
}

/**
 * Image prompt: the text alone for text->image, or `{ text, images }` for
 * editing when `--image` supplies a source image to transform.
 */
async function buildImagePrompt(parsed: ModelArgs & { prompt: string }) {
  if (!parsed.imagePath) return parsed.prompt
  const source = await readFile(resolveUserPath(parsed.imagePath))
  return { text: parsed.prompt, images: [new Uint8Array(source)] }
}

/** Pick a single `--out` path, or auto-name; suffix the index when n>1. */
function resolveOutputPath(
  out: string | undefined,
  extension: string,
  index: number,
  single: boolean,
): string {
  if (out) return single ? resolveUserPath(out) : resolveUserPath(suffixIndex(out, index))
  return autoOutputFilename(extension, index)
}

/** Insert `-<index>` before the extension: `art.png` -> `art-2.png`. */
function suffixIndex(path: string, index: number): string {
  const extension = extname(path)
  return `${path.slice(0, path.length - extension.length)}-${index}${extension}`
}

/** `image/png` -> `.png`, `image/jpeg` -> `.jpg`; default to `.png`. */
function mediaTypeExtension(mediaType: string): string {
  const subtype = mediaType.split('/')[1] ?? 'png'
  return subtype === 'jpeg' ? '.jpg' : `.${subtype}`
}

/** Validate `--size` is `{width}x{height}`; AI SDK requires that exact shape. */
function parseSize(size: string | undefined): `${number}x${number}` | undefined {
  if (!size) return undefined
  if (!/^\d+x\d+$/.test(size)) fail(`Invalid --size: ${size} (expected {width}x{height})`)
  return size as `${number}x${number}`
}

/** Validate `--aspect` is `{width}:{height}`; AI SDK requires that exact shape. */
function parseAspect(aspect: string | undefined): `${number}:${number}` | undefined {
  if (!aspect) return undefined
  if (!/^\d+:\d+$/.test(aspect)) fail(`Invalid --aspect: ${aspect} (expected {width}:{height})`)
  return aspect as `${number}:${number}`
}

/** Validate `--resolution` is `{width}x{height}`; AI SDK requires that exact shape. */
function parseResolution(resolution: string | undefined): `${number}x${number}` | undefined {
  if (!resolution) return undefined
  if (!/^\d+x\d+$/.test(resolution)) {
    fail(`Invalid --resolution: ${resolution} (expected {width}x{height})`)
  }
  return resolution as `${number}x${number}`
}

/** Stream a text completion to stdout or the `--out` file. */
async function runTextPath(parsed: ModelArgs & { model: string; prompt: string }): Promise<void> {
  const gateway = createDuetModelGateway({ mode: 'direct-generation' })
  const messages: ModelMessage[] = [{ role: 'user', content: await buildContent(parsed) }]
  const result = streamText({
    model: gateway(parsed.model),
    system: parsed.system,
    messages,
    maxRetries: parsed.maxRetries,
  })

  let text = ''
  for await (const chunk of result.fullStream) {
    if (chunk.type === 'error') failOnBillingError(chunk.error)
    if (chunk.type !== 'text-delta') continue
    if (parsed.out) text += chunk.text
    else process.stdout.write(chunk.text)
  }
  if (parsed.out) {
    process.stdout.write(text)
    await writeFile(resolveUserPath(parsed.out), text)
  } else process.stdout.write('\n')
}

/**
 * Build the user message content: the prompt text plus, when `--image` is set,
 * an inline image part so vision models can see the picture.
 */
async function buildContent(parsed: ModelArgs & { prompt: string }) {
  if (!parsed.imagePath) return parsed.prompt
  const path = resolveUserPath(parsed.imagePath)
  const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()]
  if (!mediaType) fail(`Unsupported image type: ${path}`)
  const imagePart: ImagePart = { type: 'image', image: await readFile(path), mediaType }
  return [{ type: 'text' as const, text: parsed.prompt }, imagePart]
}

async function lookupCapability(model: string): Promise<ModelType | undefined> {
  try {
    return (await fetchModelCatalog()).get(model)
  } catch {
    return undefined
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8').trim()
}

export function parseArgs(args: string[]): ModelArgs {
  const out: ModelArgs = { help: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const next = () => {
      const value = args[++i]
      if (value === undefined || value.startsWith('-')) fail(`Missing value for ${arg}`)
      return value
    }
    switch (arg) {
      case '--resolve':
        out.resolve = next()
        break
      case '--transport':
        out.transport = parseTransport(next())
        break
      case '--model':
      case '-m':
        out.model = next()
        break
      case '--type':
        out.type = parseType(next())
        break
      case '--image':
        out.imagePath = next()
        break
      case '--out':
      case '-o':
        out.out = next()
        break
      case '--system':
        out.system = next()
        break
      case '--size':
        out.size = next()
        break
      case '--aspect':
        out.aspect = next()
        break
      case '--background':
        out.background = parseBackground(next())
        break
      case '--n':
        out.n = Number(next())
        break
      case '--seed':
        out.seed = Number(next())
        break
      case '--duration':
        out.duration = Number(next())
        break
      case '--resolution':
        out.resolution = next()
        break
      case '--fps':
        out.fps = Number(next())
        break
      case '--max-retries': {
        const value = next()
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
          fail('Invalid --max-retries: expected a non-negative integer')
        out.maxRetries = Number(value)
        break
      }
      case '--env-file':
        out.envFile = next()
        break
      case '--help':
      case '-h':
        out.help = true
        break
      default:
        if (arg.startsWith('-')) fail(`Unknown model option: ${arg}`)
        out.prompt = out.prompt ? `${out.prompt} ${arg}` : arg
    }
  }
  return out
}

function parseTransport(value: string): TransportName {
  switch (value) {
    case 'duet-gateway':
    case 'vercel-ai-gateway':
    case 'openrouter':
    case 'openai-codex':
    case 'github-copilot':
      return value
    default:
      fail(`Invalid --transport: ${value}`)
  }
}

function printResolvedTransportModel(
  shorthand: string | undefined,
  transport: TransportName | undefined,
): void {
  if (!shorthand) fail('--transport requires --resolve <shorthand>')
  if (!transport) fail('--resolve requires --transport <name>')
  const modelId = transportModelId(transport, shorthand)
  if (!modelId) fail(`Transport ${transport} does not serve ${shorthand}`)
  const reference = `${transport}:${modelId}`
  const model = resolveModelName(reference)
  if (!model) fail(`No model spec resolves for ${reference}`)
  process.stdout.write(
    `${JSON.stringify(
      {
        model: reference,
        api: model.api,
        baseUrl: model.baseUrl,
        cost: model.cost,
      },
      null,
      2,
    )}\n`,
  )
}

function parseBackground(value: string): ImageBackground {
  if (value === 'transparent' || value === 'opaque' || value === 'auto') return value
  fail(`Invalid --background: ${value} (expected transparent|opaque|auto)`)
}

function parseType(value: string): RequestType {
  if (value === 'text' || value === 'image' || value === 'video') return value
  fail(`Invalid --type: ${value} (expected text|image|video)`)
}
