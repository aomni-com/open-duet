import type { DriveFileEvent, FileEventBatch } from '../../../../packages/contract/src'
import { createFileEventPipeline } from '../../../../packages/gateway/src/attribution/pipeline'

const actor = 'session:watcher-checkpoint'
const rawTap: DriveFileEvent[] = []
const sealed: FileEventBatch[] = []
const fixture: DriveFileEvent[] = [
  {
    kind: 'rename',
    entryKind: 'file',
    fromPath: 'draft.md',
    path: 'final.md',
    actor,
    at: 1,
  },
  { kind: 'write', path: 'note.md', actor, at: 2 },
  {
    kind: 'rename',
    entryKind: 'folder',
    fromPath: 'old-folder',
    path: 'new-folder',
    actor,
    at: 3,
  },
  { kind: 'create', entryKind: 'folder', path: 'copied-folder', actor, at: 4 },
  { kind: 'write', path: '.git/objects/a', actor, at: 5 },
  { kind: 'write', path: '.git/objects/b', actor, at: 6 },
  { kind: 'read', path: '.git/HEAD', actor, at: 7 },
]

const pipeline = createFileEventPipeline({
  apiUrl: 'http://fixture.invalid',
  getVmToken: async () => 'fixture-token',
  fetch: async (_input, init) => {
    sealed.push(JSON.parse(String(init?.body)) as FileEventBatch)
    return Response.json({ ok: true })
  },
  now: () => 10,
  flushMs: 60_000,
  createBatchId: () => 'watcher-checkpoint-1',
})
pipeline.onEvent(event => rawTap.push(structuredClone(event)))
fixture.forEach(pipeline.emit)
await pipeline.flush()

console.log('FIXTURE OPERATIONS')
console.log('1 explicit Files move: draft.md -> final.md (rename)')
console.log('2 atomic replacement: note.md destination survives (write only)')
console.log('3 folder move: old-folder -> new-folder (folder rename)')
console.log('4 copied folder root: copied-folder (folder create)')
console.log('5-7 noisy .git descendants: two changes plus one view')
console.log('\nRAW OPERATIONAL TAP')
rawTap.forEach((event, index) => console.log(`${index + 1}. ${JSON.stringify(event)}`))
console.log('\nSEALED PERSISTENCE BATCH')
const batch = sealed[0]!
console.log('{')
console.log(`  "batchId": ${JSON.stringify(batch.batchId)},`)
console.log('  "events": [')
batch.events.forEach((event, index) => {
  const comma = index === batch.events.length - 1 ? '' : ','
  console.log(`    ${JSON.stringify(event)}${comma}`)
})
console.log('  ],')
console.log(`  "droppedReads": ${batch.droppedReads},`)
console.log(`  "overflow": ${batch.overflow}`)
console.log('}')
