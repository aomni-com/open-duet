import { describe, expect, test } from 'bun:test'
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AppDeclarationSchema } from '@repo/contract'

import { seedAppRegistrations } from './manifest'

const contentDir = join(dirname(fileURLToPath(import.meta.url)), 'content')

describe('seed app manifest', () => {
  test('declares valid registrations rooted in authored content', async () => {
    for (const authored of seedAppRegistrations) {
      const registration = AppDeclarationSchema.parse(authored)
      expect((await stat(join(contentDir, registration.path))).isDirectory()).toBe(true)
    }
  })
})
