import { describe, expect, test } from 'bun:test'

import { gatewayFilesUrl } from './client'

const API_PREFIX = 'https://ctl.example/v1/ws/demo/files'
const GATEWAY_ORIGIN = 'https://gateway.example'

describe('API files proxy absolute path contract', () => {
  test('copies the selected in-drive and outside-drive wires byte-for-byte with queries', () => {
    for (const suffix of ['/%2Fhome/exedev/drive/media/probe%20clip.mp4', '/%2Ftmp/outside.mp4']) {
      const apiUrl = `${API_PREFIX}${suffix}?v=7&probe=1`
      const gatewayUrl = gatewayFilesUrl(new Request(apiUrl))(GATEWAY_ORIGIN)

      expect(gatewayUrl).toBe(`${GATEWAY_ORIGIN}/v1/files${suffix}?v=7&probe=1`)
    }
  })
})
