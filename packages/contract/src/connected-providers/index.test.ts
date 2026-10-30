import { describe, expect, test } from 'bun:test'

import { z } from 'zod'

import * as VmSchemas from '../vm/index'
import * as ConnectedProviderSchemas from './index'
import {
  ConnectedProviderStatusSchema,
  ConnectPollResponseSchema,
  ConnectStartRequestSchema,
  ConnectStartResponseSchema,
} from './index'

describe('connected-provider wire schemas', () => {
  test('round-trips connect start, polling, and connected status payloads', () => {
    const connection = {
      provider: 'openai-codex' as const,
      state: 'connected' as const,
      connectedAt: 1_753_248_600_000,
      connectedByUserId: 'user_1',
      connectedByLabel: 'David',
      eligibilityCheckedAt: 1_753_248_601_000,
    }
    const startRequest = { provider: 'openai-codex' as const }
    const startResponse = {
      sessionId: 'connect_1',
      intervalMs: 5_000,
    }

    expect(ConnectStartRequestSchema.parse(startRequest)).toEqual(startRequest)
    expect(ConnectStartResponseSchema.parse(startResponse)).toEqual(startResponse)
    expect(ConnectedProviderStatusSchema.parse(connection)).toEqual(connection)
    expect(ConnectPollResponseSchema.parse({ status: 'pending' })).toEqual({ status: 'pending' })
    expect(
      ConnectPollResponseSchema.parse({
        status: 'awaiting_code',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://example.test/device',
        expiresAt: 1_753_249_200_000,
      }),
    ).toEqual({
      status: 'awaiting_code',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://example.test/device',
      expiresAt: 1_753_249_200_000,
    })
    expect(ConnectPollResponseSchema.parse({ status: 'connected', connection })).toEqual({
      status: 'connected',
      connection,
    })
    expect(
      ConnectPollResponseSchema.parse({
        status: 'failed',
        reason: 'plan_ineligible',
        detail: 'A qualifying plan is required.',
      }),
    ).toEqual({
      status: 'failed',
      reason: 'plan_ineligible',
      detail: 'A qualifying plan is required.',
    })
  })

  test('requests and responses strip unknown fields for deploy skew', () => {
    expect(ConnectStartRequestSchema.parse({ provider: 'openai-codex', unexpected: true })).toEqual(
      { provider: 'openai-codex' },
    )

    const startResponse = ConnectStartResponseSchema.parse({
      sessionId: 'connect_1',
      intervalMs: 5_000,
      unexpected: true,
    })
    expect('unexpected' in startResponse).toBe(false)

    const status = ConnectedProviderStatusSchema.parse({
      provider: 'github-copilot',
      state: 'connected',
      connectedAt: 1_753_248_600_000,
      unexpected: true,
    })
    expect('unexpected' in status).toBe(false)

    const poll = ConnectPollResponseSchema.parse({ status: 'pending', unexpected: true })
    expect('unexpected' in poll).toBe(false)
  })

  test('exposes no token or credential fields in connected-provider and VM schemas', () => {
    const forbiddenFields = new Set(['access', 'refresh', 'token', 'secret', 'credential'])
    const schemaModules = [ConnectedProviderSchemas, VmSchemas]
    const violations: string[] = []

    for (const schemaModule of schemaModules) {
      for (const [schemaName, value] of Object.entries(schemaModule)) {
        if (!schemaName.endsWith('Schema') || !(value instanceof z.ZodType)) continue
        const jsonSchema = z.toJSONSchema(value, { unrepresentable: 'any' })
        walkJsonSchema(jsonSchema, schemaName, (path, field) => {
          if (forbiddenFields.has(field.toLowerCase())) violations.push(path)
        })
      }
    }

    expect(violations).toEqual([])
  })
})

function walkJsonSchema(
  value: unknown,
  path: string,
  visitField: (path: string, field: string) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkJsonSchema(item, `${path}[${index}]`, visitField))
    return
  }
  if (value === null || typeof value !== 'object') return

  const record = value as Record<string, unknown>
  const properties = record.properties
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const field of Object.keys(properties as Record<string, unknown>)) {
      visitField(`${path}.${field}`, field)
    }
  }
  for (const [key, child] of Object.entries(record)) {
    walkJsonSchema(child, `${path}.${key}`, visitField)
  }
}
