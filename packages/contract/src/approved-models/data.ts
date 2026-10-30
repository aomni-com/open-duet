import type { ApprovedModel } from './types'

export const APPROVED_MODEL_ROLE_IDS = {
  classifier: 'classifier',
  memory: 'memory',
  memoryLuna: 'memory:luna',
  embedding: 'embedding',
  image: 'image',
  imageGoogle: 'image:google',
  video: 'video',
  videoGrok: 'video:grok',
  videoPro: 'video:pro',
  videoSeedance: 'video:seedance',
  videoGoogle: 'video:google',
  videoKling: 'video:kling',
  videoKlingImage: 'video:kling:image',
} as const

const memory = {
  gatewayModelId: 'openai/gpt-6-luna',
  kind: 'chat',
  name: 'Memory',
  simpleName: 'memory',
  description: 'Duet internal memory model OpenAI GPT-6 Luna',
  internal: true,
  hidden: true,
} as const

const seedanceQuality = {
  gatewayModelId: 'bytedance/seedance-2.5',
  kind: 'video',
  name: 'Seedance 2.5',
  simpleName: 'video',
  description: 'ByteDance Seedance 2.5 for high-fidelity video generation',
  // Approximate 720p/24fps output without input video; token floors may apply.
  pricing: { perSecond: 0.23 },
} as const

export const APPROVED_MODEL_ENTRIES = [
  {
    // Routed sessions send a tier claim. Headerless classifier calls retain
    // unattributed housekeeping records rather than appearing as app services.
    id: APPROVED_MODEL_ROLE_IDS.classifier,
    gatewayModelId: 'typesafe-ai/jev',
    kind: 'chat',
    name: 'Classifier',
    simpleName: 'classifier',
    description: 'Duet internal route classifier TypeSafe AI Jev',
    internal: true,
    hidden: true,
  },
  { id: APPROVED_MODEL_ROLE_IDS.memory, ...memory },
  { id: APPROVED_MODEL_ROLE_IDS.memoryLuna, ...memory },
  // Earlier CLI housekeeping keeps its unattributed billing records. These IDs
  // are neither defaults nor fallback targets; current stable roles resolve above.
  {
    id: 'openai/gpt-5.4-mini',
    gatewayModelId: 'openai/gpt-5.4-mini',
    kind: 'chat',
    internal: true,
    hidden: true,
  },
  {
    id: 'openai/gpt-5.6-luna',
    gatewayModelId: 'openai/gpt-5.6-luna',
    kind: 'chat',
    internal: true,
    hidden: true,
  },
  {
    id: APPROVED_MODEL_ROLE_IDS.embedding,
    gatewayModelId: 'google/gemini-embedding-2',
    kind: 'embedding',
    name: 'Embedding',
    simpleName: 'embedding',
    description: 'Duet internal embedding model Google Gemini Embedding 2',
    internal: true,
    hidden: true,
  },
  // Earlier media requests remain admitted without advertising old models as roles.
  {
    id: 'google/gemini-3.1-flash-image-preview',
    gatewayModelId: 'google/gemini-3.1-flash-image-preview',
    kind: 'image',
    name: 'Nano Banana 2',
    simpleName: 'image',
    description: 'Google Gemini 3.1 Flash Image Preview for image generation',
    pricing: { perImage: 0.04 },
    hidden: true,
  },
  {
    id: 'xai/grok-imagine-video-1.5',
    gatewayModelId: 'xai/grok-imagine-video-1.5',
    kind: 'video',
    name: 'Grok Imagine Video 1.5',
    simpleName: 'video',
    description: 'xAI Grok Imagine Video 1.5 for video generation',
    pricing: { perSecond: 0.05 },
    hidden: true,
  },
  {
    id: 'bytedance/seedance-v1.5-pro',
    gatewayModelId: 'bytedance/seedance-v1.5-pro',
    kind: 'video',
    name: 'Seedance 1.5 Pro',
    simpleName: 'video',
    description: 'ByteDance Seedance 1.5 Pro for video generation',
    pricing: { perSecond: 0.03 },
    hidden: true,
  },
  {
    id: 'bytedance/seedance-2.0',
    gatewayModelId: 'bytedance/seedance-2.0',
    kind: 'video',
    name: 'Seedance 2.0',
    simpleName: 'video',
    description: 'ByteDance Seedance 2.0 for high-fidelity video generation',
    pricing: { perSecond: 0.08 },
    hidden: true,
  },
  {
    id: 'google/veo-3.0-generate-001',
    gatewayModelId: 'google/veo-3.0-generate-001',
    kind: 'video',
    name: 'Veo 3',
    simpleName: 'video',
    description: 'Google Veo 3 for video generation',
    pricing: { perSecond: 0.4 },
    hidden: true,
  },
  // Media prices are representative upstream estimates, not customer tariffs or
  // reservation amounts. Resolution, audio and input media can change actual cost.
  {
    // The default image role supports transparent output. Explicit gateway IDs
    // remain independent of this role and are never silently rewritten.
    id: APPROVED_MODEL_ROLE_IDS.image,
    gatewayModelId: 'openai/gpt-image-2.5-flare',
    kind: 'image',
    name: 'GPT Image 2.5 Flare',
    simpleName: 'image',
    description: 'OpenAI GPT Image 2.5 Flare for fast, general-purpose image generation',
    pricing: { perImage: 0.04 },
  },
  {
    id: APPROVED_MODEL_ROLE_IDS.imageGoogle,
    gatewayModelId: 'google/gemini-3.1-flash-image',
    kind: 'image',
    name: 'Nano Banana 2',
    simpleName: 'image',
    description: 'Google Gemini 3.1 Flash Image for image generation',
    // Default/1K image output, excluding text tokens.
    pricing: { perImage: 0.067 },
  },
  {
    // The `video` role is the default video model, and the default is Seedance
    // 2.0 Fast — the same one v1 shipped, escalating to `video:seedance` when
    // Fast is not good enough. A role only earns a `video:*` id when something
    // picks it deliberately.
    id: APPROVED_MODEL_ROLE_IDS.video,
    gatewayModelId: 'bytedance/seedance-2.0-fast',
    kind: 'video',
    name: 'Seedance 2.0 Fast',
    simpleName: 'video',
    description: 'ByteDance Seedance 2.0 Fast for fast video generation',
    pricing: { perSecond: 0.03 },
  },
  {
    id: APPROVED_MODEL_ROLE_IDS.videoGrok,
    gatewayModelId: 'spacexai/grok-imagine-video-1.5',
    kind: 'video',
    name: 'Grok Imagine Video 1.5',
    simpleName: 'video',
    description: 'xAI Grok Imagine Video 1.5 for video generation',
    // Representative 720p output; provider default resolution is not assumed.
    pricing: { perSecond: 0.14 },
  },
  {
    id: APPROVED_MODEL_ROLE_IDS.videoPro,
    ...seedanceQuality,
  },
  {
    id: APPROVED_MODEL_ROLE_IDS.videoSeedance,
    ...seedanceQuality,
  },
  {
    id: APPROVED_MODEL_ROLE_IDS.videoGoogle,
    gatewayModelId: 'google/veo-3.1-generate-001',
    kind: 'video',
    name: 'Veo 3.1',
    simpleName: 'video',
    description: 'Google Veo 3.1 for video generation',
    // Representative 720p output with audio; no provider default is assumed.
    pricing: { perSecond: 0.4 },
  },
  {
    id: APPROVED_MODEL_ROLE_IDS.videoKling,
    gatewayModelId: 'klingai/kling-v3.0-t2v',
    kind: 'video',
    name: 'Kling 3.0 Text to Video',
    simpleName: 'video',
    description: 'Kling 3.0 for text-to-video generation',
    pricing: { perSecond: 0.1 },
  },
  {
    id: APPROVED_MODEL_ROLE_IDS.videoKlingImage,
    gatewayModelId: 'klingai/kling-v3.0-i2v',
    kind: 'video',
    name: 'Kling 3.0 Image to Video',
    simpleName: 'video',
    description: 'Kling 3.0 for image-to-video generation',
    pricing: { perSecond: 0.1 },
  },
] as const satisfies readonly ApprovedModel[]
