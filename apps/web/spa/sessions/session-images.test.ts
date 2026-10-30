import { describe, expect, test } from 'bun:test'

import { AgentInputImageSchema } from '@repo/contract'

import { encodeSessionImage } from './session-images'

describe('session image attachments', () => {
  test('encodes an accepted browser file into the agent image contract', async () => {
    const file = new File([new Uint8Array([0, 255, 16])], 'diagram.png', {
      type: 'image/png',
    })

    const encoded = await encodeSessionImage(file)

    expect(encoded).toEqual({ data: 'AP8Q', mimeType: 'image/png' })
    expect(AgentInputImageSchema.safeParse(encoded).success).toBe(true)
  })
})
