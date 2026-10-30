import { describe, expect, test } from 'bun:test'

import { fetchModelCatalog } from './index'

describe('model catalog contract', () => {
  test('fetches and filters catalog entries', async () => {
    const catalog = await fetchModelCatalog(
      'https://gateway.example',
      'duet_sk_test',
      async input => {
        expect(String(input)).toBe('https://gateway.example/v1/models')
        return Response.json({
          data: [
            { id: 'openai/gpt-image-1', type: 'image' },
            { id: 'broken' },
            { id: 42, type: 'language' },
            { id: 'future', type: 'future' },
          ],
        })
      },
    )
    expect(catalog).toBeInstanceOf(Map)
    expect(catalog instanceof Map ? [...catalog.entries()] : []).toEqual([
      ['openai/gpt-image-1', 'image'],
    ])
  })
})
