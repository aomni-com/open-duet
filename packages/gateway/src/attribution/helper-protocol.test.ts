import { describe, expect, test } from 'bun:test'

import {
  HELPER_PROTOCOL_VERSION,
  encodeHelperCommand,
  encodeHelperEvent,
  parseHelperCommand,
  parseHelperLine,
  type HelperCommand,
  type HelperEvent,
} from './helper-protocol'

describe('helper event frames', () => {
  const events: HelperEvent[] = [
    { t: 'ready', pid: 4242, protocol: HELPER_PROTOCOL_VERSION },
    {
      t: 'fs',
      kind: 'write',
      path: 'notes/f.txt',
      pid: 512,
      unit: 'session-abc123',
      at: 1_700_000_000_000,
    },
    { t: 'fs', kind: 'read', path: 'f.txt', pid: 513, unit: null, at: 1 },
    {
      t: 'fs',
      kind: 'rename',
      entryKind: 'file',
      path: 'new.txt',
      fromPath: 'old.txt',
      pid: 514,
      unit: 'session-x1',
      at: 2,
    },
    { t: 'fs', kind: 'create', entryKind: 'folder', path: 'a', pid: 1, unit: null, at: 3 },
    { t: 'fs', kind: 'delete', entryKind: 'file', path: 'b', pid: 1, unit: null, at: 4 },
    { t: 'stats', overflow: 0, cgroupMisses: 7, at: 99 },
  ]

  test('round-trips every frame shape through one NDJSON line', () => {
    for (const event of events) {
      const line = encodeHelperEvent(event)
      expect(line).toBe(`${JSON.stringify(event)}\n`)
      expect(line.endsWith('\n')).toBe(true)
      expect(line.slice(0, -1).includes('\n')).toBe(false)
      expect(parseHelperLine(line.slice(0, -1))).toEqual(event)
    }
  })

  test('fs frames omit fromPath rather than carrying undefined', () => {
    const parsed = parseHelperLine(
      '{"t":"fs","kind":"write","path":"f","pid":1,"unit":null,"at":5}',
    )
    expect(parsed).toEqual({ t: 'fs', kind: 'write', path: 'f', pid: 1, unit: null, at: 5 })
  })

  const malformed: [string, string][] = [
    ['not json', 'garbage {'],
    ['empty line', ''],
    ['json scalar', '42'],
    ['json array', '[{"t":"ready","pid":1}]'],
    ['json null', 'null'],
    ['unknown t', '{"t":"boom","pid":1}'],
    ['missing t', '{"pid":1}'],
    ['ready without pid', '{"t":"ready"}'],
    ['ready pid zero', '{"t":"ready","pid":0}'],
    ['ready pid float', '{"t":"ready","pid":1.5}'],
    ['ready pid string', '{"t":"ready","pid":"7"}'],
    ['ready without protocol', '{"t":"ready","pid":7}'],
    ['ready protocol float', '{"t":"ready","pid":7,"protocol":1.5}'],
    ['ready protocol negative', '{"t":"ready","pid":7,"protocol":-1}'],
    ['fs unknown kind', '{"t":"fs","kind":"chmod","path":"f","pid":1,"unit":null,"at":1}'],
    ['fs missing path', '{"t":"fs","kind":"write","pid":1,"unit":null,"at":1}'],
    [
      'structural fs event missing entry kind',
      '{"t":"fs","kind":"create","path":"a","pid":1,"unit":null,"at":1}',
    ],
    [
      'non-structural fs event with entry kind',
      '{"t":"fs","kind":"write","entryKind":"file","path":"a","pid":1,"unit":null,"at":1}',
    ],
    ['fs empty path', '{"t":"fs","kind":"write","path":"","pid":1,"unit":null,"at":1}'],
    [
      'fs empty fromPath',
      '{"t":"fs","kind":"rename","entryKind":"file","path":"b","fromPath":"","pid":1,"unit":null,"at":1}',
    ],
    [
      'fromPath on a non-rename event',
      '{"t":"fs","kind":"delete","entryKind":"file","path":"b","fromPath":"a","pid":1,"unit":null,"at":1}',
    ],
    ['fs numeric unit', '{"t":"fs","kind":"write","path":"f","pid":1,"unit":9,"at":1}'],
    ['fs missing unit', '{"t":"fs","kind":"write","path":"f","pid":1,"at":1}'],
    ['fs at NaN', '{"t":"fs","kind":"write","path":"f","pid":1,"unit":null,"at":null}'],
    ['stats negative overflow', '{"t":"stats","overflow":-1,"cgroupMisses":0,"at":1}'],
    ['stats missing counter', '{"t":"stats","overflow":1,"at":1}'],
    ['stats float counter', '{"t":"stats","overflow":0.5,"cgroupMisses":0,"at":1}'],
  ]
  test.each(malformed)('malformed event line → null: %s', (_name, line) => {
    expect(parseHelperLine(line)).toBeNull()
  })
})

describe('helper command frames', () => {
  const commands: HelperCommand[] = [
    { t: 'suppress', on: true },
    { t: 'suppress', on: false },
    { t: 'exclude-pids', pids: [] },
    { t: 'exclude-pids', pids: [4242, 5150] },
    { t: 'shutdown' },
  ]

  test('round-trips every command shape', () => {
    for (const command of commands) {
      const line = encodeHelperCommand(command)
      expect(line).toBe(`${JSON.stringify(command)}\n`)
      expect(parseHelperCommand(line.slice(0, -1))).toEqual(command)
    }
  })

  const malformed: [string, string][] = [
    ['not json', '{{'],
    ['unknown t', '{"t":"pause"}'],
    ['suppress without on', '{"t":"suppress"}'],
    ['suppress string on', '{"t":"suppress","on":"true"}'],
    ['exclude-pids without pids', '{"t":"exclude-pids"}'],
    ['exclude-pids not array', '{"t":"exclude-pids","pids":42}'],
    ['exclude-pids with a zero pid', '{"t":"exclude-pids","pids":[0]}'],
    ['exclude-pids with a float pid', '{"t":"exclude-pids","pids":[1.5]}'],
    ['exclude-pids with a string pid', '{"t":"exclude-pids","pids":["42"]}'],
    ['array', '[]'],
  ]
  test.each(malformed)('malformed command line → null: %s', (_name, line) => {
    expect(parseHelperCommand(line)).toBeNull()
  })

  test('commands are not events and events are not commands', () => {
    expect(parseHelperLine('{"t":"suppress","on":true}')).toBeNull()
    expect(parseHelperCommand('{"t":"ready","pid":1,"protocol":1}')).toBeNull()
  })
})
