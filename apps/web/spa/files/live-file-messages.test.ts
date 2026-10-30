import { expect, test } from 'bun:test'

import en from '../../messages/en/app.json'
import es from '../../messages/es-419/app.json'

test('live file status and recovery copy is present in English and Spanish', () => {
  for (const messages of [en, es]) {
    for (const key of ['live', 'updated', 'reconnecting', 'missing', 'backToFolder'] as const) {
      expect(messages.duetApp.filesSurface.liveFile[key].trim().length).toBeGreaterThan(0)
    }
  }
})
