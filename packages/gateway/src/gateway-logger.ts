import { resolve } from 'node:path'

import { CappedLogWriter } from './capped-log-writer'
import { redactLogFields } from './redaction'

const SYSTEM_ERROR_FIELDS = ['code', 'errno', 'syscall', 'path', 'dest', 'address', 'port'] as const

export interface GatewayLogger {
  log(label: string, fields: Record<string, unknown>): void
}

export function createGatewayLogger(stateDir: string): GatewayLogger {
  const writer = new CappedLogWriter(resolve(stateDir, 'logs', 'gateway.log'))
  return {
    log(label, fields) {
      writer.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          label,
          ...redactLogFields(serializeLogFields(fields)),
        })}\n`,
      )
    },
  }
}

function serializeLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, serializeLogField(key, value)]),
  )
}

function serializeLogField(key: string, value: unknown): unknown {
  if (value instanceof Error) return serializeError(value)
  if (key === 'exception') return { name: 'NonError', message: String(value) }
  return value
}

function serializeError(error: Error): Record<string, unknown> {
  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  }
  for (const field of SYSTEM_ERROR_FIELDS) {
    const value = Reflect.get(error, field)
    if (typeof value === 'string' || typeof value === 'number') {
      details[field] = value
    }
  }
  return details
}
