import { describe, expect, spyOn, test } from 'bun:test'

import { convexTest } from 'convex-test'

import type { DriveFileEvent } from '@repo/contract'

import {
  applyNamespaceEvents,
  resolveNamespacePath,
} from '../convex/domains/fileActivity/namespace'
import { projectWorkspaceChunk } from '../convex/domains/fileActivity/projection'
import schema from '../convex/schema'

const actor = 'session:namespace-test'

describe('file activity logical namespace', () => {
  test('rejects a folder rename into its own descendant', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const workspaceId = await workspace(ctx, 'self-descendant')
      await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 1,
        events: [event({ kind: 'write', path: 'folder/note.md' })],
      })
      await expect(
        applyNamespaceEvents(ctx, {
          workspaceId,
          firstSequence: 2,
          events: [
            event({
              kind: 'rename',
              entryKind: 'folder',
              fromPath: 'folder',
              path: 'folder/nested',
            }),
          ],
        }),
      ).rejects.toThrow('cannot rename a folder into itself or its descendant')
    })
  })

  test('a corrupt cyclic binding is skipped once instead of rescheduling forever', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)

    try {
      await t.run(async ctx => {
        const workspaceId = await workspace(ctx, 'cyclic-projection')
        await applyNamespaceEvents(ctx, {
          workspaceId,
          firstSequence: 1,
          events: [event({ kind: 'write', path: 'loop/note.md' })],
        })
        const loop = await resolveNamespacePath(ctx.db, workspaceId, 'loop', 'current')
        if (loop === null) throw new Error('loop folder missing')
        const binding = await ctx.db
          .query('fileActivityBindings')
          .withIndex('by_child_start', q =>
            q.eq('workspaceId', workspaceId).eq('epoch', 1).eq('childEntityId', loop.entityId),
          )
          .first()
        if (binding === null) throw new Error('loop binding missing')
        await ctx.db.patch(binding._id, { parentEntityId: loop.entityId })
        await ctx.db.insert('fileEvents', {
          workspaceId,
          seq: 1,
          kind: 'write',
          path: 'loop',
          entityId: loop.entityId,
          actorContext: actor,
          at: 1,
          isRead: false,
        })

        expect(await projectWorkspaceChunk(ctx, workspaceId)).toEqual({
          completedSeq: 1,
          projectionOperations: 1,
          pending: false,
        })
        const state = await ctx.db
          .query('fileEventProjectionState')
          .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
          .unique()
        expect(state).toMatchObject({ completedSeq: 1, lastSkippedSeq: 1 })
      })
      expect(errors).toHaveBeenCalledWith(
        '[file-activity-projection] ancestry limit reached',
        expect.objectContaining({ eventSeq: 1, reason: 'cycle' }),
      )
    } finally {
      errors.mockRestore()
    }
  })

  test('a rename chain keeps one entity and direct historical aliases', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const workspaceId = await workspace(ctx)
      const result = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 1,
        events: [
          event({ kind: 'write', path: 'a' }),
          event({ kind: 'rename', entryKind: 'file', fromPath: 'a', path: 'b' }),
          event({ kind: 'rename', entryKind: 'file', fromPath: 'b', path: 'c' }),
        ],
      })

      const [a, b, c] = await Promise.all([
        resolveNamespacePath(ctx.db, workspaceId, 'a', 'selectable'),
        resolveNamespacePath(ctx.db, workspaceId, 'b', 'selectable'),
        resolveNamespacePath(ctx.db, workspaceId, 'c', 'current'),
      ])
      expect(c).not.toBeNull()
      if (c === null) throw new Error('current path did not resolve')
      expect(result.transitions.map(transition => transition.entityId)).toEqual([
        c.entityId,
        c.entityId,
        c.entityId,
      ])
      expect(a?.entityId).toBe(c?.entityId)
      expect(b?.entityId).toBe(c?.entityId)
      expect(result.operations.bindingWrites).toBe(5)
    })
  })

  test('moving a folder preserves descendant identity with two binding writes', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const workspaceId = await workspace(ctx, 'folder-move')
      await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 1,
        events: [event({ kind: 'write', path: 'old/child/note.md' })],
      })
      const before = await resolveNamespacePath(ctx.db, workspaceId, 'old/child/note.md', 'current')
      const move = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 2,
        events: [event({ kind: 'rename', entryKind: 'folder', fromPath: 'old', path: 'new' })],
      })
      const current = await resolveNamespacePath(
        ctx.db,
        workspaceId,
        'new/child/note.md',
        'current',
      )
      const alias = await resolveNamespacePath(
        ctx.db,
        workspaceId,
        'old/child/note.md',
        'selectable',
      )

      expect(current?.entityId).toBe(before?.entityId)
      expect(alias?.entityId).toBe(before?.entityId)
      expect(move.operations.bindingWrites).toBe(2)
      expect(move.operations.entityWrites).toBe(0)
    })
  })

  test('rename-over retires the destination and path reuse shadows history', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const workspaceId = await workspace(ctx, 'rename-over')
      const seeded = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 1,
        events: [
          event({ kind: 'write', path: 'source' }),
          event({ kind: 'write', path: 'destination' }),
          event({
            kind: 'rename',
            entryKind: 'file',
            fromPath: 'source',
            path: 'destination',
          }),
        ],
      })
      const sourceEntity = seeded.transitions[0]?.entityId
      const overwrittenEntity = seeded.transitions[1]?.entityId
      if (sourceEntity === null || sourceEntity === undefined) {
        throw new Error('source write did not resolve an entity')
      }
      const destination = await resolveNamespacePath(ctx.db, workspaceId, 'destination', 'current')
      expect(destination?.entityId).toEqual(sourceEntity)
      expect(destination?.entityId).not.toBe(overwrittenEntity)

      const reuse = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 4,
        events: [event({ kind: 'create', entryKind: 'file', path: 'source' })],
      })
      const selectedSource = await resolveNamespacePath(ctx.db, workspaceId, 'source', 'selectable')
      const reusedEntity = reuse.transitions[0]?.entityId
      if (reusedEntity === null || reusedEntity === undefined) {
        throw new Error('reused path did not resolve an entity')
      }
      expect(selectedSource?.entityId).toBe(reusedEntity)
      expect(selectedSource?.entityId).not.toBe(sourceEntity)
    })
  })

  test('copy, delete/recreate, and a hard-link create mint separate identities', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const workspaceId = await workspace(ctx, 'new-identities')
      const result = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 1,
        events: [
          event({ kind: 'write', path: 'original' }),
          event({ kind: 'create', entryKind: 'file', path: 'copy' }),
          event({ kind: 'create', entryKind: 'file', path: 'hard-link' }),
          event({ kind: 'delete', entryKind: 'file', path: 'original' }),
          event({ kind: 'create', entryKind: 'file', path: 'original' }),
        ],
      })
      const identities = result.transitions.map(transition => transition.entityId)
      expect(new Set([identities[0], identities[1], identities[2], identities[4]]).size).toBe(4)
      expect(identities[3]).toBe(identities[0])
    })
  })

  test('ordered transitions observe prior operations in the same batch', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const workspaceId = await workspace(ctx, 'ordered')
      const result = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 1,
        events: [
          event({ kind: 'write', path: 'a' }),
          event({ kind: 'rename', entryKind: 'file', fromPath: 'a', path: 'b' }),
          event({ kind: 'write', path: 'b' }),
          event({ kind: 'delete', entryKind: 'file', path: 'b' }),
          event({ kind: 'create', entryKind: 'file', path: 'b' }),
        ],
      })
      expect(result.transitions[2]?.entityId).toBe(result.transitions[0]?.entityId)
      expect(result.transitions[3]?.entityId).toBe(result.transitions[0]?.entityId)
      expect(result.transitions[4]?.entityId).not.toBe(result.transitions[0]?.entityId)

      const swap = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 6,
        events: [
          event({ kind: 'write', path: 'left' }),
          event({ kind: 'write', path: 'right' }),
          event({ kind: 'rename', entryKind: 'file', fromPath: 'left', path: 'temporary' }),
          event({ kind: 'rename', entryKind: 'file', fromPath: 'right', path: 'left' }),
          event({ kind: 'rename', entryKind: 'file', fromPath: 'temporary', path: 'right' }),
        ],
      })
      const leftEntity = swap.transitions[0]?.entityId
      const rightEntity = swap.transitions[1]?.entityId
      if (
        leftEntity === null ||
        leftEntity === undefined ||
        rightEntity === null ||
        rightEntity === undefined
      ) {
        throw new Error('swap inputs did not resolve entities')
      }
      expect((await resolveNamespacePath(ctx.db, workspaceId, 'left', 'current'))?.entityId).toBe(
        rightEntity,
      )
      expect((await resolveNamespacePath(ctx.db, workspaceId, 'right', 'current'))?.entityId).toBe(
        leftEntity,
      )
    })
  })

  test('a summary adopts a folder rather than reusing a file at its noisy root', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const workspaceId = await workspace(ctx, 'summary-folder')
      const result = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 1,
        events: [
          event({ kind: 'write', path: 'node_modules' }),
          event({ kind: 'changed-summary', path: 'node_modules', count: 10 }),
        ],
      })
      expect(result.transitions[1]?.entityId).not.toBe(result.transitions[0]?.entityId)
      const summaryEntityId = result.transitions[1]?.entityId
      if (summaryEntityId === null || summaryEntityId === undefined) {
        throw new Error('summary did not resolve an entity')
      }
      const entity = await ctx.db.get(summaryEntityId)
      expect(entity?.kind).toBe('folder')
    })
  })

  test('missing rename sources lose lineage explicitly and restore starts a new epoch', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const workspaceId = await workspace(ctx, 'epochs')
      const before = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 1,
        events: [
          event({ kind: 'rename', entryKind: 'file', fromPath: 'missing', path: 'adopted' }),
          event({ kind: 'restore' }),
          event({ kind: 'write', path: 'adopted' }),
        ],
      })
      expect(before.transitions[0]?.lineageMiss).toBeTrue()
      expect(before.transitions[1]?.entityId).toBeNull()
      expect(before.transitions[2]?.entityId).not.toBe(before.transitions[0]?.entityId)
      expect(await resolveNamespacePath(ctx.db, workspaceId, 'missing', 'selectable')).toBeNull()
      const namespace = await ctx.db
        .query('fileActivityNamespaces')
        .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
        .unique()
      expect(namespace).toMatchObject({ currentEpoch: 2, lineageMisses: 1 })
    })
  })

  test('an unknown delete gets one immediately ended historical owner', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const workspaceId = await workspace(ctx, 'unknown-delete')
      const result = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 1,
        events: [event({ kind: 'delete', entryKind: 'file', path: 'gone' })],
      })
      const entityId = result.transitions[0]?.entityId
      if (entityId === null || entityId === undefined) throw new Error('delete has no owner')
      expect(await resolveNamespacePath(ctx.db, workspaceId, 'gone', 'current')).toBeNull()
      expect(
        (await resolveNamespacePath(ctx.db, workspaceId, 'gone', 'selectable'))?.entityId,
      ).toBe(entityId)
      expect(await ctx.db.get(entityId)).toMatchObject({
        createdSequence: 1,
        retiredSequence: 1,
      })
    })
  })

  test('contract overflow rejects the whole transition before namespace writes', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const workspaceId = await workspace(ctx, 'overflow')
      const tooDeep = `${Array.from({ length: 129 }, (_, index) => `p${index}`).join('/')}/leaf`
      await expect(
        applyNamespaceEvents(ctx, {
          workspaceId,
          firstSequence: 1,
          events: [event({ kind: 'write', path: tooDeep })],
        }),
      ).rejects.toThrow('path exceeds segment limit')
      await expect(
        applyNamespaceEvents(ctx, {
          workspaceId,
          firstSequence: 1,
          events: Array.from({ length: 501 }, () => event({ kind: 'restore' })),
        }),
      ).rejects.toThrow()
      const maximumTotalSegments = Array.from({ length: 128 }, (_, eventIndex) =>
        event({
          kind: 'write',
          path: Array.from(
            { length: 128 },
            (_, segmentIndex) => `e${eventIndex}s${segmentIndex}`,
          ).join('/'),
        }),
      )
      await expect(
        applyNamespaceEvents(ctx, {
          workspaceId,
          firstSequence: 1,
          events: [...maximumTotalSegments, event({ kind: 'write', path: 'one-extra' })],
        }),
      ).rejects.toThrow('batch exceeds path-segment limit')
      expect(
        await ctx.db
          .query('fileActivityNamespaces')
          .withIndex('by_workspace', q => q.eq('workspaceId', workspaceId))
          .unique(),
      ).toBeNull()
    })
  })

  test('the maximum event count is accepted as one ordered transition', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const workspaceId = await workspace(ctx, 'maximum-batch')
      const result = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 1,
        events: Array.from({ length: 500 }, (_, index) =>
          event({ kind: 'write', path: `entry-${index}` }),
        ),
      })
      expect(result.transitions).toHaveLength(500)
      expect(result.operations).toEqual({
        bindingReads: 1_000,
        bindingWrites: 500,
        entityWrites: 500,
      })
    })
  })

  test('prints the deterministic namespace transcript', async () => {
    const t = convexTest(schema, { '../convex/_generated/api.ts': async () => ({}) })

    await t.run(async ctx => {
      const workspaceId = await workspace(ctx, 'transcript')
      const aliases = new Map<string, string>()
      const label = (id: string | null | undefined) => {
        if (id === null || id === undefined) return null
        let alias = aliases.get(id)
        if (alias === undefined) {
          alias = `E${aliases.size + 1}`
          aliases.set(id, alias)
        }
        return alias
      }
      const resolve = async (path: string, mode: 'current' | 'selectable') => {
        const result = await resolveNamespacePath(ctx.db, workspaceId, path, mode)
        return result === null
          ? null
          : { entity: label(result.entityId), historical: result.historical, epoch: result.epoch }
      }

      const create = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 1,
        events: [event({ kind: 'write', path: 'a' })],
      })
      label(create.transitions[0]?.entityId)
      const beforeRename = { a: await resolve('a', 'current') }
      await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 2,
        events: [event({ kind: 'rename', entryKind: 'file', fromPath: 'a', path: 'b' })],
      })
      const afterRename = {
        a: await resolve('a', 'selectable'),
        b: await resolve('b', 'current'),
      }
      const overwrite = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 3,
        events: [
          event({ kind: 'write', path: 'destination' }),
          event({
            kind: 'rename',
            entryKind: 'file',
            fromPath: 'b',
            path: 'destination',
          }),
        ],
      })
      label(overwrite.transitions[0]?.entityId)
      const afterOverwrite = { destination: await resolve('destination', 'current') }
      const copies = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 5,
        events: [
          event({ kind: 'create', entryKind: 'file', path: 'copy' }),
          event({ kind: 'create', entryKind: 'file', path: 'a' }),
        ],
      })
      label(copies.transitions[0]?.entityId)
      label(copies.transitions[1]?.entityId)
      const afterCopyAndReuse = {
        copy: await resolve('copy', 'current'),
        reusedA: await resolve('a', 'selectable'),
      }
      await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 7,
        events: [event({ kind: 'write', path: 'old/child/note.md' })],
      })
      const beforeMove = await resolve('old/child/note.md', 'current')
      const move = await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 8,
        events: [event({ kind: 'rename', entryKind: 'folder', fromPath: 'old', path: 'new' })],
      })
      const afterMove = {
        oldAlias: await resolve('old/child/note.md', 'selectable'),
        current: await resolve('new/child/note.md', 'current'),
        sameDescendant:
          beforeMove?.entity === (await resolve('new/child/note.md', 'current'))?.entity,
      }
      await applyNamespaceEvents(ctx, {
        workspaceId,
        firstSequence: 9,
        events: [event({ kind: 'restore' }), event({ kind: 'write', path: 'destination' })],
      })
      const transcript = {
        beforeRename,
        afterRename,
        afterOverwrite,
        afterCopyAndReuse,
        afterMove,
        afterRestore: {
          preRestoreAlias: await resolve('b', 'selectable'),
          destination: await resolve('destination', 'current'),
        },
        folderMoveBindingWrites: {
          descendants0: move.operations.bindingWrites,
          descendants10: move.operations.bindingWrites,
          descendants100000: move.operations.bindingWrites,
        },
      }
      console.log(`NAMESPACE_TRANSCRIPT ${JSON.stringify(transcript, null, 2)}`)

      expect(transcript.afterRename.a).toEqual({ entity: 'E1', historical: true, epoch: 1 })
      expect(transcript.afterOverwrite.destination?.entity).toBe('E1')
      expect(transcript.afterCopyAndReuse.copy?.entity).not.toBe('E1')
      expect(transcript.afterCopyAndReuse.reusedA?.entity).not.toBe('E1')
      expect(transcript.afterMove.sameDescendant).toBeTrue()
      expect(transcript.afterRestore.preRestoreAlias).toBeNull()
      expect(transcript.afterRestore.destination?.epoch).toBe(2)
      expect(new Set(Object.values(transcript.folderMoveBindingWrites))).toEqual(new Set([2]))
    })
  })
})

type EventInput = DriveFileEvent extends infer Event
  ? Event extends { actor: string; at: number }
    ? Omit<Event, 'actor' | 'at'>
    : never
  : never

function event(value: EventInput): DriveFileEvent {
  return { ...value, actor, at: 1 } as DriveFileEvent
}

async function workspace(
  ctx: Parameters<Parameters<ReturnType<typeof convexTest>['run']>[0]>[0],
  slug = 'namespace',
) {
  const userId = await ctx.db.insert('users', {
    email: 'namespace@example.com',
    memberDirectoryRevision: 0,
    createdAt: 1,
    updatedAt: 1,
    paidCreditBalanceMicroUsd: 0,
    monthlyCreditBalanceMicroUsd: 0,
  })
  return await ctx.db.insert('workspaces', {
    slug,
    name: 'Namespace',
    status: 'active',
    createdAt: 1,
    billingUserId: userId,
  })
}
