import { describe, expect, test } from 'bun:test'

import { assertPathOutsideDriveRoot } from '../drive/index'
import { MEMORY_CLI_CONTRACT, MemoryAddRequestSchema } from './index'

describe('memory CLI contract', () => {
  test('builds the exact argv the gateway and mock share', () => {
    expect(
      MEMORY_CLI_CONTRACT.add.argv({
        dbPath: '/home/exedev/.duet/memory.sqlite',
        content: 'Enterprise discounts cap at 20%',
        source: 'api',
        sessionId: 'sess_123',
        waitMs: 5000,
      }),
    ).toEqual([
      'memory',
      'add',
      '--db',
      '/home/exedev/.duet/memory.sqlite',
      '--json',
      '--source',
      'api',
      '--session',
      'sess_123',
      '--wait',
      '5',
      'Enterprise discounts cap at 20%',
    ])
    expect(
      MEMORY_CLI_CONTRACT.recall.argv({
        dbPath: '/home/exedev/.duet/memory.sqlite',
        query: 'discount',
        limit: 10,
        waitMs: 5000,
      }),
    ).toEqual([
      'memory',
      'recall',
      '--db',
      '/home/exedev/.duet/memory.sqlite',
      '--query',
      'discount',
      '--json',
      '--limit',
      '10',
      '--wait',
      '5',
    ])
  })

  test('keeps memory DB paths outside the drive root', () => {
    expect(assertPathOutsideDriveRoot('/home/exedev/.duet/memory.sqlite')).toBe(
      '/home/exedev/.duet/memory.sqlite',
    )
    expect(() => assertPathOutsideDriveRoot('/home/exedev/drive/memory.sqlite')).toThrow(
      'path must be outside the drive root',
    )
  })

  test('validates memory text without rewriting its bytes', () => {
    expect(
      MemoryAddRequestSchema.parse({
        content: '\n  preserve this spacing  \n',
        source: 'api',
        sessionId: ' session_1 ',
      }),
    ).toEqual({
      content: '\n  preserve this spacing  \n',
      source: 'api',
      sessionId: ' session_1 ',
    })
  })
})
