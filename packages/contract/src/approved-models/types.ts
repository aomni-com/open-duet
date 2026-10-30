export type ApprovedModelKind = 'chat' | 'image' | 'video' | 'embedding'

export type ImagePricing = { perImage: number }
export type VideoPricing = { perSecond: number }

type ApprovedModelBase = {
  /** Stable role ID, or a concrete gateway ID carrying metadata without a public role. */
  id: string
  gatewayModelId: string
  kind: ApprovedModelKind
  isFree?: boolean
  internal?: boolean
  hidden?: boolean
  /**
   * Pins a model to its high-throughput providers so gateway routing cannot
   * fall back to a slow host. Order is significant and owned by this catalog.
   */
  providerLock?: string[]
}

export type ApprovedChatModel = ApprovedModelBase & {
  kind: 'chat'
  name?: string
  simpleName?: string
  description?: string
}

export type ApprovedImageModel = ApprovedModelBase & {
  kind: 'image'
  name: string
  simpleName: string
  description: string
  pricing: ImagePricing
}

export type ApprovedVideoModel = ApprovedModelBase & {
  kind: 'video'
  name: string
  simpleName: string
  description: string
  pricing: VideoPricing
}

export type ApprovedEmbeddingModel = ApprovedModelBase & {
  kind: 'embedding'
  name: string
  simpleName: string
  description: string
}

export type ApprovedModel =
  | ApprovedChatModel
  | ApprovedImageModel
  | ApprovedVideoModel
  | ApprovedEmbeddingModel

export type ApprovedModelCatalog = {
  readonly entries: readonly ApprovedModel[]
}
