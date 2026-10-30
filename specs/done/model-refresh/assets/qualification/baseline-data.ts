import type { ApprovedModel } from '../../../../../packages/contract/src/approved-models/types'

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

export const APPROVED_MODEL_ENTRIES = [
  {
    // The agent's route classifier, an evaluation model. Routed sessions send
    // a tier claim, but `duet route` and other headerless calls rely on this
    // internal entry to reach it.
    id: APPROVED_MODEL_ROLE_IDS.classifier,
    gatewayModelId: 'typesafe-ai/jev',
    kind: 'chat',
    name: 'Classifier',
    simpleName: 'classifier',
    description: 'Duet internal route classifier TypeSafe AI Jev',
    internal: true,
    hidden: true,
  },
  {
    id: APPROVED_MODEL_ROLE_IDS.memory,
    gatewayModelId: 'openai/gpt-5.4-mini',
    kind: 'chat',
    name: 'Memory',
    simpleName: 'memory',
    description: 'Duet internal memory model OpenAI GPT-5.4 Mini',
    internal: true,
    hidden: true,
  },
  {
    // The agent's low-effort memory default (DEFAULT_CLI_MEMORY_MODEL) since
    // 0.3.4; the gateway does not pin --memory-model, so recordObservations
    // requests this directly. Approved so those turns don't 403.
    id: APPROVED_MODEL_ROLE_IDS.memoryLuna,
    gatewayModelId: 'openai/gpt-5.6-luna',
    kind: 'chat',
    name: 'Memory',
    simpleName: 'memory',
    description: 'Duet internal memory model OpenAI GPT-5.6 Luna',
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
  // Media pricing: estimate pending OPEN-2.
  {
    // The `image` role is the default image model: GPT Image 2.5 Flare,
    // OpenAI's fast everyday model. It replaced GPT Image 2 on 2026-09-09, and
    // the old slug left the catalog with it — a caller still naming
    // `openai/gpt-image-2` gets `model_not_allowed`, not a silent downgrade.
    // Flare also covers transparent output via `duet model --background
    // transparent`, which retired the `image:mini` (GPT Image 1.5) role.
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
    gatewayModelId: 'google/gemini-3.1-flash-image-preview',
    kind: 'image',
    name: 'Nano Banana 2',
    simpleName: 'image',
    description: 'Google Gemini 3.1 Flash Image Preview for image generation',
    pricing: { perImage: 0.04 },
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
    gatewayModelId: 'xai/grok-imagine-video-1.5',
    kind: 'video',
    name: 'Grok Imagine Video 1.5',
    simpleName: 'video',
    description: 'xAI Grok Imagine Video 1.5 for video generation',
    pricing: { perSecond: 0.05 },
  },
  {
    id: APPROVED_MODEL_ROLE_IDS.videoPro,
    gatewayModelId: 'bytedance/seedance-v1.5-pro',
    kind: 'video',
    name: 'Seedance 1.5 Pro',
    simpleName: 'video',
    description: 'ByteDance Seedance 1.5 Pro for video generation',
    pricing: { perSecond: 0.03 },
  },
  {
    id: APPROVED_MODEL_ROLE_IDS.videoSeedance,
    gatewayModelId: 'bytedance/seedance-2.0',
    kind: 'video',
    name: 'Seedance 2.0',
    simpleName: 'video',
    description: 'ByteDance Seedance 2.0 for high-fidelity video generation',
    pricing: { perSecond: 0.08 },
  },
  {
    id: APPROVED_MODEL_ROLE_IDS.videoGoogle,
    gatewayModelId: 'google/veo-3.0-generate-001',
    kind: 'video',
    name: 'Veo 3',
    simpleName: 'video',
    description: 'Google Veo 3 for video generation',
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
