import { describe, expect, test } from 'bun:test'

import {
  APPROVED_MODELS,
  createApprovedModelCatalog,
  gatewayModelIds,
  modelByGatewayId,
  modelByRole,
  renderModelsReference,
  visibleModels,
  type ApprovedModel,
} from './index'

const chatFree: ApprovedModel = {
  id: 'test:chat-free',
  gatewayModelId: 'test/chat-free',
  kind: 'chat',
  name: 'Free chat',
  simpleName: 'free',
  description: 'Synthetic free chat model',
  isFree: true,
}

describe('createApprovedModelCatalog', () => {
  test('rejects duplicate catalog ids', () => {
    expect(() =>
      createApprovedModelCatalog([chatFree, { ...chatFree, gatewayModelId: 'test/other' }]),
    ).toThrow(/duplicate catalog id/i)
  })

  test('rejects pricing that does not match the model kind', () => {
    const invalidEntries = [
      { ...chatFree, pricing: { perImage: 1 } },
      {
        ...chatFree,
        id: 'test:image',
        kind: 'image',
        pricing: {
          inputTokensPer1M: 1,
          outputTokensPer1M: 2,
          cachedInputTokensPer1M: 0.5,
        },
      },
      { ...chatFree, id: 'test:video', kind: 'video', pricing: { perImage: 1 } },
      { ...chatFree, id: 'test:embedding', kind: 'embedding', pricing: { perSecond: 1 } },
    ]

    for (const entry of invalidEntries) {
      expect(() => createApprovedModelCatalog([entry as ApprovedModel])).toThrow(/pricing.*kind/i)
    }
  })

  test('rejects divergent enforcement policy for a duplicate gateway slug', () => {
    const alias = { ...chatFree, id: 'test:alias', hidden: true }
    const divergentEntries = [
      {
        id: alias.id,
        gatewayModelId: alias.gatewayModelId,
        kind: 'embedding',
        name: alias.name,
        simpleName: alias.simpleName,
        description: alias.description,
        isFree: alias.isFree,
        hidden: true,
      },
      { ...alias, isFree: false },
      { ...alias, internal: true },
      { ...alias, providerLock: ['test-provider'] },
    ]

    for (const entry of divergentEntries) {
      expect(() => createApprovedModelCatalog([chatFree, entry as ApprovedModel])).toThrow(
        /gateway model id.*policy/i,
      )
    }

    expect(createApprovedModelCatalog([chatFree, alias]).entries).toEqual([chatFree, alias])

    // Policy comparison is semantic: an explicit `false` and an absent flag
    // are the same policy.
    const explicitFalse = { ...alias, id: 'test:alias-explicit', internal: false }
    expect(() => createApprovedModelCatalog([chatFree, explicitFalse])).not.toThrow()
  })

  test('accepts the pricing discriminant for every model kind', () => {
    const image: ApprovedModel = {
      id: 'test:image-valid',
      gatewayModelId: 'test/image-valid',
      kind: 'image',
      name: 'Image',
      simpleName: 'image',
      description: 'Synthetic image model',
      pricing: { perImage: 1 },
    }
    const video: ApprovedModel = {
      id: 'test:video-valid',
      gatewayModelId: 'test/video-valid',
      kind: 'video',
      name: 'Video',
      simpleName: 'video',
      description: 'Synthetic video model',
      pricing: { perSecond: 1 },
    }
    const embedding: ApprovedModel = {
      id: 'test:embedding-valid',
      gatewayModelId: 'test/embedding-valid',
      kind: 'embedding',
      name: 'Embedding',
      simpleName: 'embedding',
      description: 'Synthetic embedding model',
    }

    const catalog = createApprovedModelCatalog([chatFree, image, video, embedding])
    expect(catalog.entries).toEqual([chatFree, image, video, embedding])
  })

  test('accepts newer media pricing fields while validating the declared price', () => {
    expect(() =>
      createApprovedModelCatalog([
        {
          id: 'test:image',
          gatewayModelId: 'test/image',
          kind: 'image',
          name: 'Image',
          simpleName: 'image',
          description: 'Synthetic image model',
          pricing: { perImage: 1, futureDiscount: 0.25 },
        } as ApprovedModel,
      ]),
    ).not.toThrow()
  })
})

describe('catalog lookups', () => {
  test('a concrete media admission record does not become a selectable or advertised role', () => {
    const record: ApprovedModel = {
      id: 'test/prior-video',
      gatewayModelId: 'test/prior-video',
      kind: 'video',
      name: 'Prior video',
      simpleName: 'video',
      description: 'Admission for an earlier client request',
      pricing: { perSecond: 0.1 },
    }
    const catalog = createApprovedModelCatalog([record])
    expect(modelByGatewayId(catalog, record.gatewayModelId)).toEqual(record)
    expect(modelByRole(catalog, record.id)).toBeUndefined()
    expect(visibleModels(catalog)).toEqual([])
    expect(JSON.parse(renderModelsReference(catalog)).models).toEqual([])
  })

  test('stable memory roles advertise the same current internal target', () => {
    const memory = modelByRole(APPROVED_MODELS, 'memory')
    const luna = modelByRole(APPROVED_MODELS, 'memory:luna')
    expect(memory).toBeDefined()
    expect(luna?.gatewayModelId).toBe(memory?.gatewayModelId)
    expect(modelByGatewayId(APPROVED_MODELS, memory!.gatewayModelId)?.internal).toBe(true)
  })

  test('both quality video roles resolve to the same discoverable model metadata', () => {
    const pro = modelByRole(APPROVED_MODELS, 'video:pro')
    const seedance = modelByRole(APPROVED_MODELS, 'video:seedance')
    expect(pro).toBeDefined()
    if (pro === undefined || seedance === undefined) throw new Error('Missing quality video role')
    expect(seedance).toEqual({ ...pro, id: 'video:seedance' })
    expect(modelByGatewayId(APPROVED_MODELS, seedance.gatewayModelId)).toEqual(pro)
    const reference = JSON.parse(renderModelsReference(APPROVED_MODELS))
    expect(reference.models.find((entry: ApprovedModel) => entry.id === 'video:seedance')).toEqual(
      seedance,
    )
  })

  test('resolves media roles while enforcement-only chat ids remain gateway lookups', () => {
    const image: ApprovedModel = {
      id: 'test:image',
      gatewayModelId: 'test/image',
      kind: 'image',
      name: 'Image',
      simpleName: 'image',
      description: 'Synthetic image model',
      pricing: { perImage: 1 },
    }
    const catalog = createApprovedModelCatalog([chatFree, image])

    expect(modelByRole(catalog, chatFree.id)).toBeUndefined()
    expect(modelByRole(catalog, image.id)).toEqual(image)
    expect(modelByRole(catalog, 'test:missing')).toBeUndefined()
    expect(modelByGatewayId(catalog, chatFree.gatewayModelId)).toEqual(chatFree)
    expect(modelByGatewayId(catalog, 'test/missing')).toBeUndefined()
  })

  test('filters hidden models and optional kinds while retaining all unique gateway ids', () => {
    const visibleImage: ApprovedModel = {
      id: 'test:image',
      gatewayModelId: 'test/image',
      kind: 'image',
      name: 'Image',
      simpleName: 'image',
      description: 'Synthetic image model',
      pricing: { perImage: 1 },
    }
    const hiddenAlias = { ...chatFree, id: 'test:hidden-alias', hidden: true }
    const catalog = createApprovedModelCatalog([chatFree, visibleImage, hiddenAlias])

    expect(visibleModels(catalog)).toEqual([visibleImage])
    expect(visibleModels(catalog, 'image')).toEqual([visibleImage])
    expect(gatewayModelIds(catalog)).toEqual(new Set(['test/chat-free', 'test/image']))
  })
})

describe('renderModelsReference', () => {
  test('renders every entry in role order with hidden and kind-specific fields intact', () => {
    const hiddenEmbedding: ApprovedModel = {
      id: 'test:embedding',
      gatewayModelId: 'test/embedding',
      kind: 'embedding',
      name: 'Embedding',
      simpleName: 'embedding',
      description: 'Synthetic embedding model',
      internal: true,
      hidden: true,
    }
    const catalog = createApprovedModelCatalog([hiddenEmbedding, chatFree])

    expect(renderModelsReference(catalog)).toBe(
      `${JSON.stringify(
        {
          models: [hiddenEmbedding],
        },
        null,
        2,
      )}\n`,
    )
  })
})
