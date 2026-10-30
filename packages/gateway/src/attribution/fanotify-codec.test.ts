import { describe, expect, test } from 'bun:test'

import {
  createRenameJoiner,
  drivePrefixFilter,
  isContentRead,
  parseFanotifyBuffer,
  type FidRecordKind,
  type JoinedFsEvent,
  type RawFanEvent,
} from './fanotify-codec'

// ---------------------------------------------------------------------------
// Fixture builder
//
// Encodes fanotify wire bytes with layout constants derived independently
// from include/uapi/linux/fanotify.h and the spike report
// (specs/done/file-attribution/research/fanotify-fid-spike.md) — deliberately NOT
// imported from the codec, so a layout bug in the codec cannot cancel out in
// the fixtures. Little-endian, matching the x64 VM the spike ran on.
//
// struct fanotify_event_metadata (24 bytes):
//   u32 event_len; u8 vers(=3); u8 reserved; u16 metadata_len(=24);
//   u64 mask; s32 fd(=FAN_NOFD -1); s32 pid
// info record: { u8 info_type; u8 pad; u16 len } + fsid(2×s32) +
//   { u32 handle_bytes; s32 handle_type } + f_handle bytes +
//   NUL-terminated name (DFID_NAME kinds) + zero pad to 4-aligned len.
// ---------------------------------------------------------------------------

const MASK = {
  MODIFY: 0x00000002n,
  CLOSE_WRITE: 0x00000008n,
  CLOSE_NOWRITE: 0x00000010n,
  OPEN: 0x00000020n,
  MOVED_FROM: 0x00000040n,
  MOVED_TO: 0x00000080n,
  CREATE: 0x00000100n,
  DELETE: 0x00000200n,
  Q_OVERFLOW: 0x00004000n,
  RENAME: 0x10000000n,
  ONDIR: 0x40000000n,
} as const

const INFO = {
  FID: 1,
  DFID_NAME: 2,
  PIDFD: 4,
  OLD_DFID_NAME: 10,
  NEW_DFID_NAME: 12,
} as const

// Recorded values from the spike report's clean run.
const SPIKE_FSID: readonly [number, number] = [-31009542, -1731037055]
const SPIKE_DIR = '/home/exedev/drive/fid/nested'
const H = {
  nestedDir: 'fa0b040087892725',
  createdTxt: 'fb0b04008b78f7c6',
  renamed: 'fb0b040022aeaa0c',
  shellSaved: 'fc0b04004f6e03df',
  editorSaved: 'fd0b040089d2c1d8',
} as const

interface RecordSpec {
  infoType: number
  handle: string | Buffer
  name?: string | Buffer
  fsid?: readonly [number, number]
  handleType?: number
  /** Stamp a hostile declared len that disagrees with the real bytes. */
  lenOverride?: number
  /** Stamp a hostile handle_bytes claim. */
  handleBytesOverride?: number
}

function infoRecordBytes(spec: RecordSpec): Buffer {
  const handle = typeof spec.handle === 'string' ? Buffer.from(spec.handle, 'hex') : spec.handle
  const name =
    spec.name === undefined
      ? null
      : typeof spec.name === 'string'
        ? Buffer.from(spec.name, 'utf8')
        : spec.name
  const rawLen = 4 + 8 + 8 + handle.length + (name === null ? 0 : name.length + 1)
  const alignedLen = Math.ceil(rawLen / 4) * 4
  const buf = Buffer.alloc(alignedLen)
  buf.writeUInt8(spec.infoType, 0)
  buf.writeUInt16LE(spec.lenOverride ?? alignedLen, 2)
  const fsid = spec.fsid ?? SPIKE_FSID
  buf.writeInt32LE(fsid[0], 4)
  buf.writeInt32LE(fsid[1], 8)
  buf.writeUInt32LE(spec.handleBytesOverride ?? handle.length, 12)
  buf.writeInt32LE(spec.handleType ?? 1, 16)
  handle.copy(buf, 20)
  if (name !== null) name.copy(buf, 20 + handle.length)
  return buf
}

interface EventSpec {
  mask: bigint
  pid: number
  records?: Buffer[]
  version?: number
  eventLenOverride?: number
  metadataLenOverride?: number
}

function eventBytes(spec: EventSpec): Buffer {
  const records = Buffer.concat(spec.records ?? [])
  const buf = Buffer.alloc(24 + records.length)
  buf.writeUInt32LE(spec.eventLenOverride ?? buf.length, 0)
  buf.writeUInt8(spec.version ?? 3, 4)
  buf.writeUInt16LE(spec.metadataLenOverride ?? 24, 6)
  buf.writeBigUInt64LE(spec.mask, 8)
  buf.writeInt32LE(-1, 16) // FAN_NOFD: FID groups carry handles, not fds
  buf.writeInt32LE(spec.pid, 20)
  records.copy(buf, 24)
  return buf
}

function parseOne(buf: Buffer): RawFanEvent {
  const events = parseFanotifyBuffer(buf, buf.length)
  expect(events).toHaveLength(1)
  return events[0] as RawFanEvent
}

/** Simulate the helper's open_by_handle_at resolution step. */
function resolve(event: RawFanEvent, paths: Partial<Record<FidRecordKind, string>>): RawFanEvent {
  for (const record of event.records) {
    const objectPath = paths[record.kind]
    if (objectPath !== undefined) record.objectPath = objectPath
  }
  return event
}

function nameOf(record: { name: Uint8Array | null }): string | null {
  return record.name === null ? null : Buffer.from(record.name).toString('utf8')
}

// Spike create event: {"event":"OPEN|MODIFY|CLOSE_WRITE|CREATE","pid":462,
// records: [DFID_NAME(len 40, dir handle, "created.txt"), FID(len 28)]}.
function createEventBytes(): Buffer {
  return eventBytes({
    mask: MASK.OPEN | MASK.MODIFY | MASK.CLOSE_WRITE | MASK.CREATE,
    pid: 462,
    records: [
      infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, name: 'created.txt' }),
      infoRecordBytes({ infoType: INFO.FID, handle: H.createdTxt }),
    ],
  })
}

// Spike delete event: {"event":"DELETE","pid":464, records: [DFID_NAME
// (len 40, "created.txt"), FID(len 28, openByHandleErrno 116)]}.
function deleteEventBytes(): Buffer {
  return eventBytes({
    mask: MASK.DELETE,
    pid: 464,
    records: [
      infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, name: 'created.txt' }),
      infoRecordBytes({ infoType: INFO.FID, handle: H.createdTxt }),
    ],
  })
}

interface RenameSpec {
  pid: number
  from: string
  to: string
  child: string | Buffer
}

// Spike rename events: RENAME carries OLD_DFID_NAME + NEW_DFID_NAME + child
// FID; the same syscall also emits legacy MOVED_FROM and MOVED_TO events.
function renameEventBytes({ pid, from, to, child }: RenameSpec): Buffer {
  return eventBytes({
    mask: MASK.RENAME,
    pid,
    records: [
      infoRecordBytes({ infoType: INFO.OLD_DFID_NAME, handle: H.nestedDir, name: from }),
      infoRecordBytes({ infoType: INFO.NEW_DFID_NAME, handle: H.nestedDir, name: to }),
      infoRecordBytes({ infoType: INFO.FID, handle: child }),
    ],
  })
}

function movedEventBytes(
  side: 'from' | 'to',
  { pid, child }: { pid: number; child: string | Buffer },
  name: string,
): Buffer {
  return eventBytes({
    mask: side === 'from' ? MASK.MOVED_FROM : MASK.MOVED_TO,
    pid,
    records: [
      infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, name }),
      infoRecordBytes({ infoType: INFO.FID, handle: child }),
    ],
  })
}

const RESOLVE_ALL_IN_DIR: Partial<Record<FidRecordKind, string>> = {
  dfid_name: SPIKE_DIR,
  old_dfid_name: SPIKE_DIR,
  new_dfid_name: SPIKE_DIR,
}

describe('parseFanotifyBuffer', () => {
  test('decodes the spike create event: mask, pid, both records, names as bytes', () => {
    const dfidName = infoRecordBytes({
      infoType: INFO.DFID_NAME,
      handle: H.nestedDir,
      name: 'created.txt',
    })
    const fid = infoRecordBytes({ infoType: INFO.FID, handle: H.createdTxt })
    // Record lengths must reproduce the spike-reported lens exactly.
    expect(dfidName.length).toBe(40)
    expect(fid.length).toBe(28)

    const event = parseOne(
      eventBytes({
        mask: MASK.OPEN | MASK.MODIFY | MASK.CLOSE_WRITE | MASK.CREATE,
        pid: 462,
        records: [dfidName, fid],
      }),
    )
    expect(event.mask).toBe(0x12an)
    expect(event.pid).toBe(462)
    expect(event.overflow).toBe(false)
    expect(event.records).toHaveLength(2)
    const [parent, child] = event.records
    expect(parent?.kind).toBe('dfid_name')
    expect(parent?.handleKey).toBe(`1:${H.nestedDir}`)
    expect(parent?.fsid).toEqual(SPIKE_FSID)
    expect(nameOf(parent!)).toBe('created.txt')
    expect(child?.kind).toBe('fid')
    expect(child?.handleKey).toBe(`1:${H.createdTxt}`)
    expect(child?.name).toBeNull()
  })

  test('decodes both sides of the spike rename event', () => {
    const old = infoRecordBytes({
      infoType: INFO.OLD_DFID_NAME,
      handle: H.nestedDir,
      name: 'old.txt',
    })
    const next = infoRecordBytes({
      infoType: INFO.NEW_DFID_NAME,
      handle: H.nestedDir,
      name: 'new.txt',
    })
    expect(old.length).toBe(36)
    expect(next.length).toBe(36)

    const event = parseOne(
      eventBytes({
        mask: MASK.RENAME,
        pid: 462,
        records: [old, next, infoRecordBytes({ infoType: INFO.FID, handle: H.renamed })],
      }),
    )
    expect(event.records.map(record => record.kind)).toEqual([
      'old_dfid_name',
      'new_dfid_name',
      'fid',
    ])
    expect(nameOf(event.records[0]!)).toBe('old.txt')
    expect(nameOf(event.records[1]!)).toBe('new.txt')
    expect(event.records[2]?.handleKey).toBe(`1:${H.renamed}`)
  })

  test('decodes multiple events from one read buffer, honoring len', () => {
    const create = createEventBytes()
    const both = Buffer.concat([create, deleteEventBytes()])
    expect(parseFanotifyBuffer(both, both.length)).toHaveLength(2)
    expect(parseFanotifyBuffer(both, create.length)).toHaveLength(1)
  })

  test('surfaces an overflow frame as a variant, never swallowed', () => {
    const event = parseOne(eventBytes({ mask: MASK.Q_OVERFLOW, pid: 0 }))
    expect(event.overflow).toBe(true)
    expect(event.records).toEqual([])
  })

  test('drops a truncated trailing event without throwing', () => {
    const create = createEventBytes()
    const truncated = Buffer.concat([create, deleteEventBytes().subarray(0, 30)])
    const events = parseFanotifyBuffer(truncated, truncated.length)
    expect(events).toHaveLength(1)
    expect(events[0]?.pid).toBe(462)
    expect(parseFanotifyBuffer(create.subarray(0, 20), 20)).toEqual([])
  })

  test('stops at an unknown metadata version', () => {
    const bad = eventBytes({ mask: MASK.CREATE, pid: 1, version: 2 })
    const buf = Buffer.concat([bad, createEventBytes()])
    expect(parseFanotifyBuffer(buf, buf.length)).toEqual([])
  })

  test('stops on inconsistent metadata lengths instead of looping or throwing', () => {
    const zeroLen = eventBytes({ mask: MASK.CREATE, pid: 1, eventLenOverride: 0 })
    expect(parseFanotifyBuffer(zeroLen, zeroLen.length)).toEqual([])
    const metaTooBig = eventBytes({ mask: MASK.CREATE, pid: 1, metadataLenOverride: 200 })
    expect(parseFanotifyBuffer(metaTooBig, metaTooBig.length)).toEqual([])
    const eventTooBig = eventBytes({ mask: MASK.CREATE, pid: 1, eventLenOverride: 4096 })
    expect(parseFanotifyBuffer(eventTooBig, eventTooBig.length)).toEqual([])
  })

  test('skips unknown info-record types and keeps the known ones', () => {
    const event = parseOne(
      eventBytes({
        mask: MASK.OPEN,
        pid: 5,
        records: [
          infoRecordBytes({ infoType: INFO.PIDFD, handle: 'deadbeef' }),
          infoRecordBytes({ infoType: 200, handle: 'deadbeef' }),
          infoRecordBytes({ infoType: INFO.FID, handle: H.createdTxt }),
        ],
      }),
    )
    expect(event.records).toHaveLength(1)
    expect(event.records[0]?.kind).toBe('fid')
  })

  test('skips a record with an oversized handle claim without reading past it', () => {
    const event = parseOne(
      eventBytes({
        mask: MASK.OPEN,
        pid: 5,
        records: [
          infoRecordBytes({ infoType: INFO.FID, handle: H.renamed, handleBytesOverride: 4096 }),
          infoRecordBytes({ infoType: INFO.FID, handle: H.createdTxt }),
        ],
      }),
    )
    expect(event.records.map(record => record.handleKey)).toEqual([`1:${H.createdTxt}`])
  })

  test('stops the record walk when a declared record len overruns the event', () => {
    const event = parseOne(
      eventBytes({
        mask: MASK.OPEN,
        pid: 5,
        records: [
          infoRecordBytes({ infoType: INFO.FID, handle: H.createdTxt }),
          infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, lenOverride: 0xfff0 }),
        ],
      }),
    )
    expect(event.records).toHaveLength(1)
  })

  test('clamps a name missing its NUL terminator to the declared record len', () => {
    // Declared len cuts into the name: 20 fixed + 8 handle + 5 name bytes.
    const record = infoRecordBytes({
      infoType: INFO.DFID_NAME,
      handle: H.nestedDir,
      name: 'created.txt',
      lenOverride: 33,
    })
    const buf = eventBytes({ mask: MASK.CREATE, pid: 5, records: [record] })
    const events = parseFanotifyBuffer(buf, buf.length)
    expect(nameOf(events[0]!.records[0]!)).toBe('creat')
  })

  test('carries oversized names through as untrusted bytes', () => {
    const longName = 'n'.repeat(300)
    const event = parseOne(
      eventBytes({
        mask: MASK.CREATE,
        pid: 5,
        records: [
          infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, name: longName }),
        ],
      }),
    )
    expect(nameOf(event.records[0]!)).toBe(longName)
  })
})

describe('isContentRead', () => {
  test('classifies content reads only: no write bits, no FAN_ONDIR', () => {
    expect(isContentRead(MASK.OPEN)).toBe(true)
    expect(isContentRead(MASK.CLOSE_NOWRITE)).toBe(true)
    expect(isContentRead(MASK.OPEN | MASK.ONDIR)).toBe(false)
    expect(isContentRead(MASK.OPEN | MASK.MODIFY | MASK.CLOSE_WRITE)).toBe(false)
    expect(isContentRead(MASK.DELETE)).toBe(false)
  })
})

describe('createRenameJoiner', () => {
  function joinerAt(capacity = 64): {
    push(buf: Buffer, paths?: Partial<Record<FidRecordKind, string>>): JoinedFsEvent[]
  } {
    let tick = 0
    const joiner = createRenameJoiner({ capacity, now: () => ++tick })
    return {
      push(buf, paths = RESOLVE_ALL_IN_DIR) {
        return joiner.push(resolve(parseOne(buf), paths))
      },
    }
  }

  test('resolves a delete through the surviving parent handle', () => {
    const joiner = joinerAt()
    // The child FID is unresolvable after unlink (spike: openByHandleErrno
    // 116) — only the parent dfid_name record gets an objectPath.
    const events = joiner.push(deleteEventBytes(), { dfid_name: SPIKE_DIR })
    expect(events).toEqual([
      { kind: 'delete', entryKind: 'file', path: `${SPIKE_DIR}/created.txt`, pid: 464, at: 1 },
    ])
  })

  test('carries FAN_ONDIR as folder kind on structural events', () => {
    const joiner = joinerAt()
    const events = joiner.push(
      eventBytes({
        mask: MASK.CREATE | MASK.ONDIR,
        pid: 465,
        records: [
          infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, name: 'folder' }),
        ],
      }),
    )
    expect(events).toEqual([
      { kind: 'create', entryKind: 'folder', path: `${SPIKE_DIR}/folder`, pid: 465, at: 1 },
    ])
  })

  test('joins a shell mv atomic save into a write to the real filename', () => {
    // Spike sequence: printf > .tmp-x (pid 468) && mv .tmp-x report.md (pid 469).
    const joiner = joinerAt()
    const writeTemp = joiner.push(
      eventBytes({
        mask: MASK.OPEN | MASK.MODIFY | MASK.CLOSE_WRITE | MASK.CREATE,
        pid: 468,
        records: [
          infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, name: '.tmp-x' }),
          infoRecordBytes({ infoType: INFO.FID, handle: H.shellSaved }),
        ],
      }),
    )
    expect(writeTemp).toEqual([
      { kind: 'create', entryKind: 'file', path: `${SPIKE_DIR}/.tmp-x`, pid: 468, at: 1 },
      { kind: 'write', path: `${SPIKE_DIR}/.tmp-x`, pid: 468, at: 1 },
    ])

    const renamed = joiner.push(
      renameEventBytes({ pid: 469, from: '.tmp-x', to: 'report.md', child: H.shellSaved }),
    )
    // The retained writer proves this is replacement, not a move whose temp
    // identity should survive. Only the destination write crosses the seam.
    expect(renamed).toEqual([{ kind: 'write', path: `${SPIKE_DIR}/report.md`, pid: 468, at: 2 }])

    // The same syscall's legacy events dedupe to nothing.
    expect(
      joiner.push(movedEventBytes('from', { pid: 469, child: H.shellSaved }, '.tmp-x')),
    ).toEqual([])
    expect(
      joiner.push(movedEventBytes('to', { pid: 469, child: H.shellSaved }, 'report.md')),
    ).toEqual([])
  })

  test('joins a python os.replace atomic save (writer pid == rename pid)', () => {
    // Spike sequence: pid 475 writes editor.tmp then os.replace's it.
    const joiner = joinerAt()
    joiner.push(
      eventBytes({
        mask: MASK.OPEN | MASK.MODIFY | MASK.CLOSE_WRITE | MASK.CREATE,
        pid: 475,
        records: [
          infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, name: 'editor.tmp' }),
          infoRecordBytes({ infoType: INFO.FID, handle: H.editorSaved }),
        ],
      }),
    )
    const renamed = joiner.push(
      renameEventBytes({ pid: 475, from: 'editor.tmp', to: 'editor.md', child: H.editorSaved }),
    )
    expect(renamed).toEqual([{ kind: 'write', path: `${SPIKE_DIR}/editor.md`, pid: 475, at: 2 }])
    expect(
      joiner.push(movedEventBytes('from', { pid: 475, child: H.editorSaved }, 'editor.tmp')),
    ).toEqual([])
    expect(
      joiner.push(movedEventBytes('to', { pid: 475, child: H.editorSaved }, 'editor.md')),
    ).toEqual([])
  })

  test('pairs legacy MOVED_FROM/MOVED_TO when they arrive first, then swallows FAN_RENAME', () => {
    const joiner = joinerAt()
    expect(joiner.push(movedEventBytes('from', { pid: 9, child: H.renamed }, 'a.txt'))).toEqual([])
    expect(joiner.push(movedEventBytes('to', { pid: 9, child: H.renamed }, 'b.txt'))).toEqual([
      {
        kind: 'rename',
        entryKind: 'file',
        path: `${SPIKE_DIR}/b.txt`,
        fromPath: `${SPIKE_DIR}/a.txt`,
        pid: 9,
        at: 2,
      },
    ])
    expect(
      joiner.push(renameEventBytes({ pid: 9, from: 'a.txt', to: 'b.txt', child: H.renamed })),
    ).toEqual([])
  })

  test('evicts the replaced destination writer on rename-over', () => {
    const joiner = joinerAt()
    const oldInode = 'aaaaaaaaaaaaaaaa'
    const tmpInode = 'bbbbbbbbbbbbbbbb'
    joiner.push(
      eventBytes({
        mask: MASK.CLOSE_WRITE,
        pid: 11,
        records: [
          infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, name: 'report.md' }),
          infoRecordBytes({ infoType: INFO.FID, handle: oldInode }),
        ],
      }),
    )
    joiner.push(
      eventBytes({
        mask: MASK.CLOSE_WRITE,
        pid: 22,
        records: [
          infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, name: '.tmp' }),
          infoRecordBytes({ infoType: INFO.FID, handle: tmpInode }),
        ],
      }),
    )
    const replaced = joiner.push(
      renameEventBytes({ pid: 33, from: '.tmp', to: 'report.md', child: tmpInode }),
    )
    expect(replaced.filter(event => event.kind === 'write')).toEqual([
      { kind: 'write', path: `${SPIKE_DIR}/report.md`, pid: 22, at: 3 },
    ])
    // The replaced inode's stale writer entry is gone: a later rename
    // referencing it joins nothing.
    const stale = joiner.push(
      renameEventBytes({ pid: 44, from: 'x.txt', to: 'y.txt', child: oldInode }),
    )
    expect(stale.map(event => event.kind)).toEqual(['rename'])
  })

  test('bounds the writer cache at the configured capacity', () => {
    const joiner = joinerAt(2)
    for (const [index, inode] of [
      '1111111111111111',
      '2222222222222222',
      '3333333333333333',
    ].entries()) {
      joiner.push(
        eventBytes({
          mask: MASK.CLOSE_WRITE,
          pid: 100 + index,
          records: [
            infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, name: `f${index}` }),
            infoRecordBytes({ infoType: INFO.FID, handle: inode }),
          ],
        }),
      )
    }
    // Oldest writer (inode 1111…) was evicted; newest still joins.
    const evicted = joiner.push(
      renameEventBytes({ pid: 1, from: 'f0', to: 'g0', child: '1111111111111111' }),
    )
    expect(evicted.map(event => event.kind)).toEqual(['rename'])
    const kept = joiner.push(
      renameEventBytes({ pid: 1, from: 'f2', to: 'g2', child: '3333333333333333' }),
    )
    expect(kept.map(event => event.kind)).toEqual(['write'])
    expect(kept[0]?.pid).toBe(102)
  })

  test('surfaces overflow as an event, never swallowed', () => {
    const joiner = joinerAt()
    expect(joiner.push(eventBytes({ mask: MASK.Q_OVERFLOW, pid: 0 }))).toEqual([
      { kind: 'overflow', path: '', pid: 0, at: 1 },
    ])
  })

  test('emits reads for content opens only, never for FAN_ONDIR or open-for-write', () => {
    const joiner = joinerAt()
    const records = () => [
      infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, name: 'cgroup.txt' }),
      infoRecordBytes({ infoType: INFO.FID, handle: H.createdTxt }),
    ]
    expect(joiner.push(eventBytes({ mask: MASK.OPEN, pid: 482, records: records() }))).toEqual([
      { kind: 'read', path: `${SPIKE_DIR}/cgroup.txt`, pid: 482, at: 1 },
    ])
    expect(
      joiner.push(eventBytes({ mask: MASK.OPEN | MASK.ONDIR, pid: 482, records: records() })),
    ).toEqual([])
    const writeOpen = joiner.push(
      eventBytes({
        mask: MASK.OPEN | MASK.MODIFY | MASK.CLOSE_WRITE,
        pid: 482,
        records: records(),
      }),
    )
    expect(writeOpen.map(event => event.kind)).toEqual(['write'])
  })

  test('neutralizes a forged "/" in a dirent name instead of splicing paths', () => {
    const joiner = joinerAt()
    const events = joiner.push(
      eventBytes({
        mask: MASK.CREATE,
        pid: 7,
        records: [
          infoRecordBytes({ infoType: INFO.DFID_NAME, handle: H.nestedDir, name: 'evil/../up' }),
          infoRecordBytes({ infoType: INFO.FID, handle: H.createdTxt }),
        ],
      }),
    )
    expect(events[0]?.path).toBe(`${SPIKE_DIR}/evil�..�up`)
  })

  test('dedupes a 500-rename stream to exactly 500 joined renames', () => {
    // Spike load re-check: 500 rename syscalls emitted FAN_RENAME=500,
    // FAN_MOVED_FROM=500, FAN_MOVED_TO=500 with zero overflow.
    const chunks: Buffer[] = []
    for (let index = 0; index < 500; index += 1) {
      const child = Buffer.alloc(8)
      child.writeUInt32LE(index, 0)
      chunks.push(
        renameEventBytes({ pid: 500 + index, from: `f${index}.tmp`, to: `f${index}.md`, child }),
        movedEventBytes('from', { pid: 500 + index, child }, `f${index}.tmp`),
        movedEventBytes('to', { pid: 500 + index, child }, `f${index}.md`),
      )
    }
    const stream = Buffer.concat(chunks)
    const events = parseFanotifyBuffer(stream, stream.length)
    expect(events).toHaveLength(1500)

    const joiner = createRenameJoiner({ capacity: 1024, now: () => 1 })
    const joined = events.flatMap(event => joiner.push(resolve(event, RESOLVE_ALL_IN_DIR)))
    expect(joined).toHaveLength(500)
    expect(joined.every(event => event.kind === 'rename')).toBe(true)
    expect(new Set(joined.map(event => event.path)).size).toBe(500)
  })
})

describe('drivePrefixFilter', () => {
  const inDrive = drivePrefixFilter('/home/exedev/drive')

  test('accepts paths strictly inside the drive root', () => {
    expect(inDrive('/home/exedev/drive/fid/nested/created.txt')).toBe(true)
    expect(inDrive('/home/exedev/drive/a')).toBe(true)
  })

  test('rejects the root itself, outside paths, and prefix-sibling paths', () => {
    expect(inDrive('/home/exedev/drive')).toBe(false)
    expect(inDrive('/etc/passwd')).toBe(false)
    expect(inDrive('/home/exedev/drive2/x')).toBe(false)
    expect(inDrive('/usr/lib/x86_64-linux-gnu/libc.so.6')).toBe(false)
  })

  test('excludes gateway staging and anchor markers anywhere in the path', () => {
    expect(inDrive('/home/exedev/drive/.duet/staging/x')).toBe(false)
    expect(inDrive('/home/exedev/drive/project/.duet/x')).toBe(false)
    expect(inDrive('/home/exedev/drive/project/.duet-anchor')).toBe(false)
  })

  test('rejects non-canonical segments instead of interpreting them', () => {
    expect(inDrive('/home/exedev/drive/../etc/passwd')).toBe(false)
    expect(inDrive('/home/exedev/drive/./x')).toBe(false)
    expect(inDrive('/home/exedev/drive//x')).toBe(false)
  })

  test('normalizes a trailing slash on the drive root', () => {
    expect(drivePrefixFilter('/home/exedev/drive/')('/home/exedev/drive/x')).toBe(true)
  })
})
