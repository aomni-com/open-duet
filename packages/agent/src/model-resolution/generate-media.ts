import {
  createGateway,
  experimental_generateVideo as generateVideo,
  generateImage,
  generateText,
  type ModelMessage,
} from 'ai'

import type { ModelType } from './model-gateway.js'

type ImageOptions = Parameters<typeof generateImage>[0]
type VideoOptions = Parameters<typeof generateVideo>[0]

/** Generation only: hosts select the model/transport and persist the returned bytes. */
export type GenerateMediaOptions = Pick<
  ImageOptions,
  'size' | 'aspectRatio' | 'n' | 'seed' | 'maxRetries'
> &
  Pick<VideoOptions, 'resolution' | 'duration' | 'fps'> & {
    gateway: ReturnType<typeof createGateway>
    model: string
    kind: 'image' | 'video'
    capability?: ModelType
    prompt: string
    system?: string
    messages?: ModelMessage[]
    imagePrompt?: ImageOptions['prompt']
    videoPrompt?: VideoOptions['prompt']
    background?: 'transparent' | 'opaque' | 'auto'
  }

export async function generateMedia(options: GenerateMediaOptions) {
  const { gateway, model, prompt, aspectRatio, n, seed, maxRetries } = options
  if (options.kind === 'video') {
    const result = await generateVideo({
      model: gateway.video(model),
      prompt: options.videoPrompt ?? prompt,
      aspectRatio,
      n,
      seed,
      maxRetries,
      resolution: options.resolution,
      duration: options.duration,
      fps: options.fps,
    })
    return { files: result.videos, warnings: result.warnings }
  }
  if (options.capability === 'language') {
    const result = await generateText({
      model: gateway(model),
      system: options.system,
      messages: options.messages ?? [{ role: 'user', content: prompt }],
      providerOptions: { google: { responseModalities: ['TEXT', 'IMAGE'] } },
      maxRetries,
    })
    return {
      files: result.files.filter(file => file.mediaType.startsWith('image/')),
      warnings: result.warnings ?? [],
    }
  }
  const result = await generateImage({
    model: gateway.imageModel(model),
    prompt: options.imagePrompt ?? prompt,
    size: options.size,
    aspectRatio,
    n,
    seed,
    maxRetries,
    ...(options.background && { providerOptions: { openai: { background: options.background } } }),
  })
  return { files: result.images, warnings: result.warnings }
}
