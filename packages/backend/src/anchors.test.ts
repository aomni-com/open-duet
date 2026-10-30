import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type ConvexHttpClient } from 'convex/browser'

import { MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE, type GatewayAnchor } from '@repo/contract'
import {
  convexDev,
  generateAuthKeys,
  mutate,
  query,
  signInWithMagicLink,
  TEST_AUTH_CODE,
  uniqueEmail,
  type ConvexDevFixture,
} from '@repo/test-harness'

import { resolveAgentContext } from '../../gateway/src/agents/agent-context'
import { resolveSessionAgent } from '../convex/domains/agents/resolution'

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const INTERNAL_KEY = 'test-api-internal-key'
const IMAGE_REF = 'ttl.sh/duet-test-slice12:1h'

let convex: ConvexDevFixture
let owner: SignedInUser
let recipient: SignedInUser
let downstream: SignedInUser
let sequence = 0

describe('anchors backend domain', () => {
  beforeAll(async () => {
    convex = await convexDev(BACKEND_DIR, {
      env: {
        ...generateAuthKeys(),
        DUET_API_INTERNAL_KEY: INTERNAL_KEY,
        DUET_TEST_AUTH_CODE: TEST_AUTH_CODE,
        DUET_TEST_AUTH_EMAIL: '1',
        DUET_TEST_AUTH_GOOGLE: '1',
        DUET_APP_URL: 'http://localhost:3000',
      },
      reset: true,
    })
    owner = await signInWithMagicLink<UserRow>(convex, uniqueEmail('anchor-owner'), 'Anchor Owner')
    recipient = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('anchor-recipient'),
      'Anchor Recipient',
    )
    downstream = await signInWithMagicLink<UserRow>(
      convex,
      uniqueEmail('anchor-downstream'),
      'Anchor Downstream',
    )
  }, 240_000)

  afterAll(async () => {
    await convex?.stop()
  })

  test('createAnchor is queryable by normalized path and writes one audit event', async () => {
    const workspaceId = await createWorkspace('anchor-create')
    const before = await auditEvents(workspaceId)
    const anchor = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId,
      path: 'apps/site',
      kind: 'app',
      settings: {},
      now: 1_000,
    })) as AnchorRow

    const byPath = (await query(owner.client, 'domains/anchors/model:getByPath', {
      workspaceId,
      path: 'apps/site',
    })) as AnchorRow | null

    expect(byPath).toMatchObject({
      id: anchor.id,
      workspaceId,
      path: 'apps/site',
      kind: 'app',
      state: 'active',
      settings: {},
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    await expectAuditDelta(workspaceId, before, 'anchor.created')
  })

  test('anchor creation and lookup preserve literal percent identities', async () => {
    const workspaceId = await createWorkspace('anchor-percent')
    const literalPercent = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId,
      path: 'documents/100%',
      kind: 'publish',
      settings: { kind: 'folder' },
    })) as AnchorRow
    const percentLooking = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId,
      path: 'documents/a%2Fb',
      kind: 'publish',
      settings: { kind: 'folder' },
    })) as AnchorRow

    expect([literalPercent.path, percentLooking.path]).toEqual([
      'documents/100%',
      'documents/a%2Fb',
    ])
    expect(literalPercent.id).not.toBe(percentLooking.id)
    expect(
      await Promise.all(
        ['documents/100%', 'documents/a%2Fb'].map(path =>
          query(owner.client, 'domains/anchors/model:getByPath', { workspaceId, path }),
        ),
      ),
    ).toEqual([
      expect.objectContaining({ id: literalPercent.id, path: 'documents/100%' }),
      expect.objectContaining({ id: percentLooking.id, path: 'documents/a%2Fb' }),
    ])
  })

  test('applyRename keeps kind and settings while moving the path', async () => {
    const registered = await provisionRegisteredWorkspace('anchor-rename')
    const anchor = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: registered.workspaceId,
      path: 'apps/site',
      kind: 'publish',
      settings: { kind: 'folder' },
      now: 2_000,
    })) as AnchorRow
    const before = await auditEvents(registered.workspaceId)

    await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      reports: [
        {
          anchorId: anchor.id,
          candidates: [
            {
              fromPath: 'apps/site',
              toPath: 'apps/site-renamed',
              confidence: 0.91,
              inodeMatch: true,
              markerMatch: true,
            },
          ],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['apps/site-renamed'],
        },
      ],
      now: 2_500,
    })

    const moved = (await query(owner.client, 'domains/anchors/model:getByPath', {
      workspaceId: registered.workspaceId,
      path: 'apps/site-renamed',
    })) as AnchorRow | null
    expect(moved).toMatchObject({
      id: anchor.id,
      path: 'apps/site-renamed',
      kind: 'publish',
      settings: { kind: 'folder' },
      state: 'active',
      updatedAt: 2_500,
    })
    await expectAuditDelta(registered.workspaceId, before, 'anchor.reanchored_by_rename')
  })

  test('marker-backed rename preserves an agent anchor and it can be broken then repaired', async () => {
    const registered = await provisionRegisteredWorkspace('agent-anchor')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: registered.workspaceId,
      path: 'agents/research',
      slug: 'research',
    })) as { anchorId: string }
    await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      reports: [
        {
          anchorId: agent.anchorId,
          candidates: [
            {
              fromPath: 'agents/research',
              toPath: 'teams/research',
              confidence: 0.9,
              inodeMatch: true,
              markerMatch: true,
            },
          ],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['teams/research'],
        },
      ],
      now: 3_000,
    })
    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: agent.anchorId }),
    ).toMatchObject({ path: 'teams/research', kind: 'agent', state: 'active' })

    await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
      anchorId: agent.anchorId,
      reason: 'agent_test',
    })
    await mutate(owner.client, 'domains/anchors/model:reanchor', {
      anchorId: agent.anchorId,
      path: 'teams/research-restored',
    })
    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: agent.anchorId }),
    ).toMatchObject({ path: 'teams/research-restored', kind: 'agent', state: 'active' })
  })

  test('listForVm joins an enabled agent id onto its active anchor projection', async () => {
    const registered = await provisionRegisteredWorkspace('agent-vm-projection')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: registered.workspaceId,
      path: 'shared/reviewer',
      slug: 'reviewer',
    })) as { id: string; anchorId: string }
    await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: registered.workspaceId,
      path: 'apps/plain',
      kind: 'app',
      settings: {},
    })

    const anchors = (await query(owner.client, 'domains/anchors/model:listForVm', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
    })) as Array<{ id: string; agentId?: string }>

    expect(anchors.find(anchor => anchor.id === agent.anchorId)?.agentId).toBe(agent.id)
    expect(anchors.find(anchor => anchor.id !== agent.anchorId)).not.toHaveProperty('agentId')
  })

  test('VM topology reads workspace agents once while joining every anchor', async () => {
    const registered = await provisionRegisteredWorkspace('agent-vm-bounded-read')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: registered.workspaceId,
      path: 'agents/reviewer',
      slug: 'reviewer',
    })) as { id: string; anchorId: string }
    const app = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: registered.workspaceId,
      path: 'apps/plain',
      kind: 'app',
      settings: {},
    })) as { id: string }

    const topology = (await convex.query('testing/anchors:gatewayTopologyForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
    })) as {
      anchors: Array<{ id: string; agentId?: string }>
      agents: Array<{ kind: 'root' | 'agent'; agentId?: string }>
      agentLookupQueries: number
    }

    expect(topology.anchors.find(anchor => anchor.id === agent.anchorId)?.agentId).toBe(agent.id)
    expect(topology.anchors.find(anchor => anchor.id === app.id)).not.toHaveProperty('agentId')
    expect(topology.agents.filter(entry => entry.kind === 'agent')).toEqual([
      expect.objectContaining({ agentId: agent.id }),
    ])
    expect(topology.agentLookupQueries).toBe(1)
  })

  test('one live-anchor ceiling governs create, orphan revival, topology, and rename', async () => {
    const registered = await provisionRegisteredWorkspace('anchor-workspace-ceiling')
    await mutate(convex, 'testing/anchors:seedAnchorStatesForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      active: MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE - 2,
      broken: 1,
      orphaned: 1_000,
    })

    await mutate(convex, 'testing/anchors:reviveAnchorForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
      path: 'orphaned/0000',
      actorId: owner.user._id,
      now: 10_000,
    })
    const topology = (await convex.query('testing/anchors:gatewayTopologyForTest', {
      internalKey: INTERNAL_KEY,
      workspaceId: registered.workspaceId,
    })) as { anchors: Array<{ id: string; path: string }> }
    expect(topology.anchors).toHaveLength(MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE)
    expect(topology.anchors.some(anchor => anchor.path === 'orphaned/0999')).toBe(false)

    await expect(
      mutate(convex, 'testing/anchors:reviveAnchorForTest', {
        internalKey: INTERNAL_KEY,
        workspaceId: registered.workspaceId,
        path: 'orphaned/0001',
        actorId: owner.user._id,
        now: 10_001,
      }),
    ).rejects.toThrow('Workspace anchor limit exceeded')
    await expect(
      mutate(owner.client, 'testing/anchors:createAnchorForTest', {
        workspaceId: registered.workspaceId,
        path: 'apps/overflow',
        kind: 'app',
        settings: {},
      }),
    ).rejects.toThrow('Workspace anchor limit exceeded')

    const finalActivePath = `active/${String(MAX_NON_ORPHANED_ANCHORS_PER_WORKSPACE - 3).padStart(
      4,
      '0',
    )}`
    await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      reports: [
        {
          anchorId: topology.anchors.find(anchor => anchor.path === finalActivePath)!.id,
          candidates: [
            {
              fromPath: finalActivePath,
              toPath: 'active/moved-last',
              confidence: 1,
              inodeMatch: true,
              markerMatch: true,
            },
          ],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['active/moved-last'],
        },
      ],
    })
    expect(
      await query(owner.client, 'domains/anchors/model:getByPath', {
        workspaceId: registered.workspaceId,
        path: 'active/moved-last',
      }),
    ).not.toBeNull()
  }, 120_000)

  test('Convex attribution and gateway runtime agree on one projected anchor set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'duet-dual-agent-resolution-'))
    try {
      const driveDir = join(root, 'drive')
      const stateDir = join(root, 'state')
      mkdirSync(join(driveDir, 'agents', 'reviewer', 'security', 'audit'), { recursive: true })
      const anchors = [
        projectedAgentAnchor('anchor_outer', 'agents/reviewer', 'agent_outer'),
        projectedAgentAnchor(
          'anchor_inner',
          'agents/reviewer/security',
          'agent_inner',
          'share-mount',
        ),
      ]
      const agents = anchors.map(anchor => ({
        _id: anchor.agentId!,
        workspaceId: 'workspace_1',
        anchorId: anchor.id,
        slug: anchor.agentId!,
        createdAt: 1,
        updatedAt: 1,
      }))
      const ctx = {
        db: {
          query(table: string) {
            if (table !== 'agents') throw new Error(`unexpected table: ${table}`)
            return { withIndex: () => ({ take: async () => agents }) }
          },
          get: async (anchorId: string) => anchors.find(anchor => anchor.id === anchorId) ?? null,
        },
      }
      const cwd = 'agents/reviewer/security/audit'

      const durable = await resolveSessionAgent(ctx as never, {
        workspaceId: 'workspace_1' as never,
        cwd,
      })
      const runtime = resolveAgentContext({
        cwd,
        driveDir,
        stateDir,
        defaultMemoryDbPath: join(stateDir, 'memory.db'),
        anchors,
      })

      expect(runtime.agentId).toBe(durable?.agentId)
      expect(runtime.agentId).toBe('agent_inner')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('applyRename marks broken instead of failing when the rename target is already anchored', async () => {
    const registered = await provisionRegisteredWorkspace('anchor-conflict')
    const moving = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: registered.workspaceId,
      path: 'apps/moving',
      kind: 'app',
      settings: {},
    })) as AnchorRow
    await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: registered.workspaceId,
      path: 'apps/taken',
      kind: 'publish',
      settings: { kind: 'folder' },
    })
    const before = await auditEvents(registered.workspaceId)

    const result = (await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      reports: [
        {
          anchorId: moving.id,
          candidates: [
            {
              fromPath: 'apps/moving',
              toPath: 'apps/taken',
              confidence: 0.95,
              inodeMatch: true,
              markerMatch: true,
            },
          ],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['apps/taken'],
        },
      ],
      now: 2_750,
    })) as { changed: Array<{ action: string; anchorId: string; path: string; reason: string }> }

    expect(result.changed).toEqual([
      { action: 'broken', anchorId: moving.id, path: 'apps/moving', reason: 'target_conflict' },
    ])
    const broken = (await query(owner.client, 'domains/anchors/model:getById', {
      anchorId: moving.id,
    })) as AnchorRow
    expect(broken).toMatchObject({
      path: 'apps/moving',
      state: 'broken',
      settings: {},
    })
    await expectAuditDelta(registered.workspaceId, before, 'anchor.broken_by_rename')
  })

  test('applyRename allows a target owned by another anchor moving away in the same report', async () => {
    const registered = await provisionRegisteredWorkspace('anchor-batch-rename')
    const first = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: registered.workspaceId,
      path: 'apps/first',
      kind: 'app',
      settings: {},
    })) as AnchorRow
    const second = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: registered.workspaceId,
      path: 'apps/second',
      kind: 'publish',
      settings: { kind: 'folder' },
    })) as AnchorRow
    const before = await auditEvents(registered.workspaceId)

    await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      reports: [
        {
          anchorId: first.id,
          candidates: [
            {
              fromPath: 'apps/first',
              toPath: 'apps/second',
              confidence: 0.95,
              inodeMatch: true,
              markerMatch: true,
            },
          ],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['apps/second'],
        },
        {
          anchorId: second.id,
          candidates: [
            {
              fromPath: 'apps/second',
              toPath: 'apps/third',
              confidence: 0.95,
              inodeMatch: true,
              markerMatch: true,
            },
          ],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['apps/third'],
        },
      ],
      now: 2_900,
    })

    const firstMoved = (await query(owner.client, 'domains/anchors/model:getById', {
      anchorId: first.id,
    })) as AnchorRow
    const secondMoved = (await query(owner.client, 'domains/anchors/model:getById', {
      anchorId: second.id,
    })) as AnchorRow
    expect(firstMoved).toMatchObject({
      path: 'apps/second',
      state: 'active',
      settings: {},
    })
    expect(secondMoved).toMatchObject({
      path: 'apps/third',
      state: 'active',
      settings: { kind: 'folder' },
    })
    const after = await auditEvents(registered.workspaceId)
    expect(newAuditEvents(before, after).map(event => event.event)).toEqual([
      'anchor.reanchored_by_rename',
      'anchor.reanchored_by_rename',
    ])
  })

  test('ambiguous applyRename marks broken, then reanchor repairs and clears broken', async () => {
    const registered = await provisionRegisteredWorkspace('anchor-broken')
    const anchor = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId: registered.workspaceId,
      path: 'shares/docs',
      kind: 'share-root',
      settings: {},
      now: 3_000,
    })) as AnchorRow

    await expectOneAudit(registered.workspaceId, 'anchor.broken_by_rename', async () =>
      mutate(owner.client, 'domains/anchors/model:applyRename', {
        internalKey: INTERNAL_KEY,
        vmTokenHash: await sha256Hex(registered.vmToken),
        reports: [
          {
            anchorId: anchor.id,
            candidates: [
              {
                fromPath: 'shares/docs',
                toPath: 'shares/docs-a',
                confidence: 0.95,
                inodeMatch: true,
                markerMatch: true,
              },
              {
                fromPath: 'shares/docs',
                toPath: 'shares/docs-b',
                confidence: 0.95,
                inodeMatch: true,
                markerMatch: true,
              },
            ],
            anchorPathExists: false,
            consecutiveMissingPolls: 1,
            markerMatches: ['shares/docs-a', 'shares/docs-b'],
          },
        ],
        now: 3_500,
      }),
    )

    const broken = (await query(owner.client, 'domains/anchors/model:getById', {
      anchorId: anchor.id,
    })) as AnchorRow
    expect(broken.state).toBe('broken')
    expect(broken.path).toBe('shares/docs')

    await expectOneAudit(registered.workspaceId, 'anchor.reanchored', () =>
      mutate(owner.client, 'domains/anchors/model:reanchor', {
        anchorId: anchor.id,
        path: 'shares/docs-human',
        now: 4_000,
      }),
    )
    const repaired = (await query(owner.client, 'domains/anchors/model:getByPath', {
      workspaceId: registered.workspaceId,
      path: 'shares/docs-human',
    })) as AnchorRow | null
    expect(repaired).toMatchObject({
      id: anchor.id,
      path: 'shares/docs-human',
      state: 'active',
      settings: {},
    })
  })

  // A deleted folder never passes through "needs repair" on its way out. There
  // is nothing to repair about a folder the user deleted, and an app that spent
  // the seconds before its own deletion telling the user to fix its folder link
  // would be offering a fix for a choice they just made. So the anchor is left
  // untouched until the drive has said the same thing enough times, and then the
  // row goes: active straight to reaped.
  test('an app whose folder is gone waits untouched, then is reaped', async () => {
    const registered = await provisionRegisteredWorkspace('anchor-reap')
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: registered.workspaceId,
      path: 'agents/fired/apps/board',
      slug: 'reaped-board',
      command: 'bun run server.ts',
      apiScopes: [],
    })) as { id: string; anchorId: string }
    const missingReport = (consecutiveMissingPolls: number) => ({
      internalKey: INTERNAL_KEY,
      reports: [
        {
          anchorId: app.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls,
          markerMatches: [],
        },
      ],
    })

    await mutate(owner.client, 'domains/anchors/model:applyRename', {
      ...missingReport(1),
      vmTokenHash: await sha256Hex(registered.vmToken),
      now: 5_000,
    })
    // Untouched: still active, still at its path, still listing its app.
    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: app.anchorId }),
    ).toMatchObject({ state: 'active', path: 'agents/fired/apps/board' })
    expect(
      (
        (await query(owner.client, 'domains/apps/model:listByWorkspace', {
          workspaceId: registered.workspaceId,
        })) as Array<{ slug: string }>
      ).map(row => row.slug),
    ).toEqual(['reaped-board'])

    await mutate(owner.client, 'domains/anchors/model:applyRename', {
      ...missingReport(3),
      vmTokenHash: await sha256Hex(registered.vmToken),
      now: 6_000,
    })

    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: registered.workspaceId,
      }),
    ).toEqual([])
    // Orphaned, not broken: the anchor retires from both reconciled sets so the
    // same verdict is not re-decided on every poll from here on.
    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: app.anchorId }),
    ).toMatchObject({ state: 'orphaned' })
  })

  test('one conclusive mover search reaps without waiting for another VM poll', async () => {
    const registered = await provisionRegisteredWorkspace('anchor-conclusive-reap')
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: registered.workspaceId,
      path: 'agents/fired/apps/board',
      slug: 'conclusive-reap-board',
      command: 'bun run server.ts',
      apiScopes: [],
    })) as { anchorId: string }

    await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      reports: [
        {
          anchorId: app.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: [],
          missingIsConclusive: true,
        },
      ],
      now: 5_000,
    })

    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: registered.workspaceId,
      }),
    ).toEqual([])
    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: app.anchorId }),
    ).toMatchObject({ state: 'orphaned' })
  })

  // The residue that started all this: an anchor that is ALREADY broken. It used
  // to leave the VM projection the instant it broke, so nothing ever looked at it
  // again and no verdict could change — "folder link needs repair" was a state
  // with no exit. A broken anchor is a claim about the filesystem, and claims get
  // rechecked.
  test('an anchor that is already broken is still examined, and reaped', async () => {
    const registered = await provisionRegisteredWorkspace('anchor-reap-broken')
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: registered.workspaceId,
      path: 'apps/stranded',
      slug: 'stranded-app',
      command: 'bun run server.ts',
      apiScopes: [],
    })) as { anchorId: string }
    await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
      anchorId: app.anchorId,
      reason: 'pre_existing_residue',
    })

    await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      reports: [
        {
          anchorId: app.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 3,
          markerMatches: [],
        },
      ],
      now: 8_000,
    })

    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: registered.workspaceId,
      }),
    ).toEqual([])
    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: app.anchorId }),
    ).toMatchObject({ state: 'orphaned' })
  })

  // The extreme case, and the one that proves the rule is uniform rather than a
  // pile of cases: wipe the drive and the whole control plane follows it. There
  // is nothing special about "everything" here — each anchor reaches the same
  // verdict on its own evidence, so the batch needs no rule of its own.
  test('wiping the drive collects every app and agent row', async () => {
    const registered = await provisionRegisteredWorkspace('anchor-reap-all')
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: registered.workspaceId,
      path: 'agents/lead',
      slug: 'wiped-lead',
      apps: [
        {
          path: 'agents/lead/apps/board',
          slug: 'wiped-board',
          command: 'bun run server.ts',
          apiScopes: [],
        },
      ],
    })) as { anchorId: string }
    const standalone = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: registered.workspaceId,
      path: 'apps/solo',
      slug: 'wiped-solo',
      command: 'bun run server.ts',
      apiScopes: [],
    })) as { anchorId: string }
    const anchors = (await query(owner.client, 'domains/anchors/model:listByWorkspace', {
      workspaceId: registered.workspaceId,
    })) as Array<{ id: string }>
    expect(anchors.length).toBe(3)

    // One report per anchor, all missing, exactly as an emptied drive produces.
    await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(registered.vmToken),
      reports: anchors.map(anchor => ({
        anchorId: anchor.id,
        candidates: [],
        anchorPathExists: false,
        consecutiveMissingPolls: 3,
        markerMatches: [],
      })),
      now: 7_000,
    })

    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: registered.workspaceId,
      }),
    ).toEqual([])
    expect(
      await query(owner.client, 'domains/agents/model:listByWorkspace', {
        workspaceId: registered.workspaceId,
      }),
    ).toEqual([])
    for (const anchorId of [agent.anchorId, standalone.anchorId]) {
      expect(
        await query(owner.client, 'domains/anchors/model:getById', { anchorId }),
      ).toMatchObject({ state: 'orphaned' })
    }
  })

  // A replica whose own folder vanishes is removed, and the Files delete dialog
  // says so out loud: "Duet will remove the replica app automatically after it
  // detects the missing folder." A replica deeper than the share mount carries
  // its OWN app-kind anchor, so it reaches the same reap path an origin does —
  // but a replica is a projection, not a thing this workspace owns, so it goes
  // out through the replica rail rather than an origin teardown.
  test('a replica app whose folder is gone is removed through the replica rail', async () => {
    const originId = await createWorkspace('replica-reap-origin')
    const recipient = await provisionRegisteredWorkspace('replica-reap-recipient')
    const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: originId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string } }
    // Deeper than the share root on purpose: a replica AT the mount path reuses
    // the share-mount anchor, which the share rail owns. This one gets its own.
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: originId,
      path: 'project/board',
      command: 'bun run start',
      apiScopes: [],
      slug: 'board',
    })
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: created.share.id,
      toWorkspaceId: recipient.workspaceId,
      mountPath: 'shared/project',
    })
    const replica = (
      (await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipient.workspaceId,
      })) as AppRow[]
    )[0]!
    const replicaAnchor = (await query(owner.client, 'domains/anchors/model:getById', {
      anchorId: replica.anchorId,
    })) as AnchorRow
    expect(replicaAnchor.kind).toBe('app')

    await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(recipient.vmToken),
      reports: [
        {
          anchorId: replica.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 3,
          markerMatches: [],
        },
      ],
      now: 9_000,
    })

    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipient.workspaceId,
      }),
    ).toEqual([])
  })

  test('marking an anchor broken writes exactly one audit event', async () => {
    const workspaceId = await createWorkspace('anchor-manual-broken')
    const anchor = (await mutate(owner.client, 'testing/anchors:createAnchorForTest', {
      workspaceId,
      path: 'apps/manual',
      kind: 'app',
      settings: {},
    })) as AnchorRow

    await expectOneAudit(workspaceId, 'anchor.broken', () =>
      mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
        anchorId: anchor.id,
        reason: 'operator_test',
      }),
    )
    const broken = (await query(owner.client, 'domains/anchors/model:getById', {
      anchorId: anchor.id,
    })) as AnchorRow
    expect(broken.state).toBe('broken')
  })

  test('origin app renames reconcile replicas out of and back into a share as fresh rows', async () => {
    const recipientId = await createWorkspace('anchor-app-recipient')
    const origin = await provisionRegisteredWorkspace('anchor-app-fanout')
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: origin.workspaceId,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })) as AppRow
    const createdShare = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: origin.workspaceId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string } }
    const share = createdShare.share
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: share.id,
      toWorkspaceId: recipientId,
      mountPath: 'shared/project',
    })
    await mutate(owner.client, 'domains/apps/model:setReplicaDisabled', {
      workspaceId: recipientId,
      slug: 'web',
      disabled: true,
    })
    const firstReplica = (
      (await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipientId,
      })) as AppRow[]
    )[0]!

    await reportRename(origin, app.anchorId, 'project/web', 'private/web')

    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipientId,
      }),
    ).toEqual([])
    expect(
      await query(owner.client, 'domains/anchors/model:getById', {
        anchorId: firstReplica.anchorId,
      }),
    ).toBeNull()
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: recipientId,
      path: 'local/web',
      command: 'bun run local',
      apiScopes: [],
      slug: 'web',
    })

    await reportRename(origin, app.anchorId, 'private/web', 'project/web')

    const apps = (await query(owner.client, 'domains/apps/model:listByWorkspace', {
      workspaceId: recipientId,
    })) as AppRow[]
    const recreated = apps.find(candidate => candidate.sourceShareId === share.id)!
    expect(recreated).toMatchObject({
      slug: 'web-2',
      anchorPath: 'shared/project/web',
      sourceAppId: app.id,
    })
    expect(recreated.id).not.toBe(firstReplica.id)
    expect(recreated.disabledAt).toBeUndefined()
  })

  test('renaming app and agent anchors with their shared parent reconciles both replicas', async () => {
    const recipientId = await createWorkspace('rename-pair-b')
    const origin = await provisionRegisteredWorkspace('rename-pair-a')
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: origin.workspaceId,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })) as AppRow
    const agent = (await mutate(owner.client, 'domains/agents/model:registerAgent', {
      workspaceId: origin.workspaceId,
      path: 'project/research',
      slug: 'research',
    })) as { id: string; anchorId: string }
    const createdShare = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: origin.workspaceId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string; anchorId: string } }
    const share = createdShare.share
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: share.id,
      toWorkspaceId: recipientId,
      mountPath: 'shared/project',
    })
    const replica = (
      (await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipientId,
      })) as AppRow[]
    )[0]!
    const agentReplica = (
      (await query(owner.client, 'domains/agents/model:listByWorkspace', {
        workspaceId: recipientId,
      })) as Array<{ id: string; sourceAgentId?: string; sourceShareId?: string }>
    )[0]!

    await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(origin.vmToken),
      reports: [
        renameReport(app.anchorId, 'project/web', 'renamed/web'),
        renameReport(agent.anchorId, 'project/research', 'renamed/research'),
        renameReport(share.anchorId, 'project', 'renamed'),
      ],
    })

    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipientId,
      }),
    ).toEqual([
      expect.objectContaining({
        id: replica.id,
        sourceAppId: app.id,
        sourceShareId: share.id,
      }),
    ])
    expect(
      await query(owner.client, 'domains/agents/model:listByWorkspace', {
        workspaceId: recipientId,
      }),
    ).toEqual([
      expect.objectContaining({
        id: agentReplica.id,
        sourceAgentId: agent.id,
        sourceShareId: share.id,
      }),
    ])
  })

  test('share-mount waits for one miss, then auto-unlinks through the existing detach path', async () => {
    const originId = await createWorkspace('share-mount-miss-a')
    const recipient = await provisionRegisteredWorkspace('share-mount-miss-b')
    const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: originId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'write',
    })) as { share: { id: string } }
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: created.share.id,
      toWorkspaceId: recipient.workspaceId,
      mountPath: 'shared/project',
    })
    const accepted = (
      (await query(owner.client, 'testing/shares:rawSharesForTest', {
        internalKey: INTERNAL_KEY,
      })) as Array<{
        id: string
        state: string
        mountAnchorId?: string
      }>
    ).find(share => share.id === created.share.id)!
    expect(accepted.mountAnchorId).toBeDefined()
    const mountAnchorId = accepted.mountAnchorId!

    const first = (await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(recipient.vmToken),
      reports: [
        {
          anchorId: mountAnchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: [],
        },
      ],
      now: 5_000,
    })) as { changed: unknown[] }
    expect(first.changed).toEqual([])
    expect(
      await query(owner.client, 'domains/anchors/model:listForVm', {
        internalKey: INTERNAL_KEY,
        vmTokenHash: await sha256Hex(recipient.vmToken),
      }),
    ).toContainEqual(expect.objectContaining({ id: mountAnchorId, state: 'active' }))

    const second = (await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(recipient.vmToken),
      reports: [
        {
          anchorId: mountAnchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 2,
          markerMatches: [],
        },
      ],
      now: 5_001,
    })) as { changed: Array<{ action: string; anchorId: string; shareId?: string }> }
    expect(second.changed).toEqual([
      { action: 'unlinked', anchorId: mountAnchorId, shareId: created.share.id },
    ])
    const after = (
      (await query(owner.client, 'testing/shares:rawSharesForTest', {
        internalKey: INTERNAL_KEY,
      })) as Array<{ id: string; state: string; mountAnchorId?: string }>
    ).find(share => share.id === created.share.id)
    expect(after).toMatchObject({ state: 'unlinked' })
    expect(after?.mountAnchorId).toBeUndefined()
  })

  test('one marker elsewhere relocates a share-mount and patches its private mount path', async () => {
    const originId = await createWorkspace('share-mount-move-a')
    const recipient = await provisionRegisteredWorkspace('share-mount-move-b')
    const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: originId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'write',
    })) as { share: { id: string } }
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: created.share.id,
      toWorkspaceId: recipient.workspaceId,
      mountPath: 'shared/project',
    })
    const accepted = (
      (await query(owner.client, 'testing/shares:rawSharesForTest', {
        internalKey: INTERNAL_KEY,
      })) as Array<{ id: string; mountAnchorId?: string }>
    ).find(share => share.id === created.share.id)!

    const result = (await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(recipient.vmToken),
      reports: [
        {
          anchorId: accepted.mountAnchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['archive/project'],
        },
      ],
      now: 5_100,
    })) as { changed: Array<Record<string, unknown>> }

    expect(result.changed).toEqual([
      {
        action: 'reanchor',
        anchorId: accepted.mountAnchorId,
        fromPath: 'shared/project',
        toPath: 'archive/project',
      },
    ])
    const movedShare = (
      (await query(owner.client, 'testing/shares:rawSharesForTest', {
        internalKey: INTERNAL_KEY,
      })) as Array<{ id: string; mountPath?: string }>
    ).find(share => share.id === created.share.id)
    expect(movedShare?.mountPath).toBe('archive/project')
    expect(
      await query(owner.client, 'domains/anchors/model:getById', {
        anchorId: accepted.mountAnchorId,
      }),
    ).toMatchObject({ path: 'archive/project', state: 'active' })
  })

  test('moving a share-mount inside another linked root auto-unlinks the moved share', async () => {
    const originId = await createWorkspace('share-mount-nested-a')
    const recipientWorkspace = await provisionRegisteredWorkspace('share-mount-nested-b')
    const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: originId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'write',
    })) as { share: { id: string } }
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: created.share.id,
      toWorkspaceId: recipientWorkspace.workspaceId,
      mountPath: 'shared/project',
    })
    const accepted = (
      (await query(owner.client, 'testing/shares:rawSharesForTest', {
        internalKey: INTERNAL_KEY,
      })) as Array<{ id: string; mountAnchorId?: string }>
    ).find(share => share.id === created.share.id)!
    const containing = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: recipientWorkspace.workspaceId,
      toEmail: downstream.user.email,
      path: 'archive',
      mode: 'read',
    })) as { share: { anchorId: string } }

    const result = (await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(recipientWorkspace.vmToken),
      reports: [
        {
          anchorId: accepted.mountAnchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['archive/project'],
        },
      ],
      now: 5_150,
    })) as { changed: Array<Record<string, unknown>> }

    expect(result.changed).toEqual([
      {
        action: 'unlinked',
        anchorId: accepted.mountAnchorId,
        shareId: created.share.id,
      },
    ])
    expect(
      await query(owner.client, 'domains/anchors/model:getById', {
        anchorId: containing.share.anchorId,
      }),
    ).toMatchObject({ path: 'archive', state: 'active' })
    const shares = (await query(owner.client, 'testing/shares:rawSharesForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ id: string; state: string }>
    expect(shares.find(share => share.id === created.share.id)?.state).toBe('unlinked')
  })

  test('one marker elsewhere relocates an origin share root without inode evidence', async () => {
    const origin = await provisionRegisteredWorkspace('share-root-move-a')
    const recipientWorkspaceId = await createWorkspace('share-root-move-b')
    const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: origin.workspaceId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'write',
    })) as { share: { id: string; anchorId: string } }
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: created.share.id,
      toWorkspaceId: recipientWorkspaceId,
      mountPath: 'shared/project',
    })

    const result = (await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(origin.vmToken),
      reports: [
        {
          anchorId: created.share.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['archive/project'],
        },
      ],
      now: 5_175,
    })) as { changed: Array<Record<string, unknown>> }

    expect(result.changed).toEqual([
      {
        action: 'reanchor',
        anchorId: created.share.anchorId,
        fromPath: 'project',
        toPath: 'archive/project',
      },
    ])
    const shares = (await query(owner.client, 'testing/shares:rawSharesForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ id: string; state: string }>
    expect(shares.find(share => share.id === created.share.id)?.state).toBe('active')
  })

  test('moving an origin share root inside a share-mount ends only the moved root', async () => {
    const sourceWorkspaceId = await createWorkspace('share-root-nested-a')
    const targetWorkspace = await provisionRegisteredWorkspace('share-root-nested-b')
    const incoming = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: sourceWorkspaceId,
      toEmail: owner.user.email,
      path: 'source',
      mode: 'write',
    })) as { share: { id: string } }
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: incoming.share.id,
      toWorkspaceId: targetWorkspace.workspaceId,
      mountPath: 'shared/source',
    })
    const outgoing = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: targetWorkspace.workspaceId,
      toEmail: downstream.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string; anchorId: string } }

    const result = (await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(targetWorkspace.vmToken),
      reports: [
        {
          anchorId: outgoing.share.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['shared/source/project'],
        },
      ],
      now: 5_180,
    })) as { changed: Array<Record<string, unknown>> }

    expect(result.changed).toContainEqual({
      action: 'revoked',
      anchorId: outgoing.share.anchorId,
      shareId: outgoing.share.id,
    })
    const shares = (await query(owner.client, 'testing/shares:rawSharesForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ id: string; state: string }>
    expect(shares.find(share => share.id === incoming.share.id)?.state).toBe('active')
    expect(shares.find(share => share.id === outgoing.share.id)?.state).toBe('revoked')
  })

  test('simultaneous share-root moves cannot create nested final roots', async () => {
    const workspace = await provisionRegisteredWorkspace('share-root-batch-nested')
    const first = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: workspace.workspaceId,
      toEmail: recipient.user.email,
      path: 'first',
      mode: 'read',
    })) as { share: { id: string; anchorId: string } }
    const second = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: workspace.workspaceId,
      toEmail: downstream.user.email,
      path: 'second',
      mode: 'read',
    })) as { share: { id: string; anchorId: string } }

    const result = (await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(workspace.vmToken),
      reports: [
        {
          anchorId: first.share.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['archive'],
        },
        {
          anchorId: second.share.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['archive/nested'],
        },
      ],
      now: 5_185,
    })) as { changed: Array<Record<string, unknown>> }

    expect(result.changed).toContainEqual({
      action: 'revoked',
      anchorId: first.share.anchorId,
      shareId: first.share.id,
    })
    expect(result.changed).toContainEqual({
      action: 'revoked',
      anchorId: second.share.anchorId,
      shareId: second.share.id,
    })
    const shares = (await query(owner.client, 'testing/shares:rawSharesForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ id: string; state: string }>
    expect(shares.find(share => share.id === first.share.id)?.state).toBe('revoked')
    expect(shares.find(share => share.id === second.share.id)?.state).toBe('revoked')
  })

  test('simultaneous share-root moves cannot double-claim a vacated linked path', async () => {
    const workspace = await provisionRegisteredWorkspace('share-batch-dupe')
    const first = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: workspace.workspaceId,
      toEmail: recipient.user.email,
      path: 'first',
      mode: 'read',
    })) as { share: { id: string; anchorId: string } }
    const second = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: workspace.workspaceId,
      toEmail: downstream.user.email,
      path: 'second',
      mode: 'read',
    })) as { share: { id: string; anchorId: string } }
    const vacating = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: workspace.workspaceId,
      toEmail: owner.user.email,
      path: 'vacated',
      mode: 'read',
    })) as { share: { id: string; anchorId: string } }

    const result = (await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(workspace.vmToken),
      reports: [
        {
          anchorId: first.share.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['vacated'],
        },
        {
          anchorId: second.share.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['vacated'],
        },
        {
          anchorId: vacating.share.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: ['elsewhere'],
        },
      ],
      now: 5_190,
    })) as { changed: Array<Record<string, unknown>> }

    expect(result.changed).toContainEqual({
      action: 'revoked',
      anchorId: first.share.anchorId,
      shareId: first.share.id,
    })
    expect(result.changed).toContainEqual({
      action: 'revoked',
      anchorId: second.share.anchorId,
      shareId: second.share.id,
    })
    expect(result.changed).toContainEqual({
      action: 'reanchor',
      anchorId: vacating.share.anchorId,
      fromPath: 'vacated',
      toPath: 'elsewhere',
    })
  })

  test('confirmed origin deletion unlinks its share, revokes reshares, and preserves replica apps as local', async () => {
    const origin = await provisionRegisteredWorkspace('share-root-delete-a')
    const recipientWorkspaceId = await existingOrCreateWorkspaceFor(
      recipient,
      'share-root-delete-b',
    )
    const originApp = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: origin.workspaceId,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })) as AppRow
    const created = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: origin.workspaceId,
      toEmail: recipient.user.email,
      path: 'project',
      mode: 'write',
    })) as { share: { id: string; anchorId: string } }
    await mutate(recipient.client, 'domains/shares/model:acceptShare', {
      shareId: created.share.id,
      toWorkspaceId: recipientWorkspaceId,
      mountPath: 'shared/project',
    })
    const child = (await mutate(recipient.client, 'testing/shares:reshareForTest', {
      internalKey: INTERNAL_KEY,
      parentShareId: created.share.id,
      fromWorkspaceId: recipientWorkspaceId,
      toEmail: downstream.user.email,
      mode: 'read',
      now: 5_200,
    })) as { share: { id: string } }
    const replicaBefore = (
      (await query(recipient.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipientWorkspaceId,
      })) as AppRow[]
    )[0]!
    expect(replicaBefore).toMatchObject({
      sourceAppId: originApp.id,
      sourceShareId: created.share.id,
    })

    const first = (await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(origin.vmToken),
      reports: [
        {
          anchorId: created.share.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 1,
          markerMatches: [],
        },
      ],
      now: 5_201,
    })) as { changed: unknown[] }
    expect(first.changed).toEqual([])
    expect(
      await query(owner.client, 'domains/anchors/model:listForVm', {
        internalKey: INTERNAL_KEY,
        vmTokenHash: await sha256Hex(origin.vmToken),
      }),
    ).toContainEqual(expect.objectContaining({ id: created.share.anchorId, state: 'active' }))

    const second = (await mutate(owner.client, 'domains/anchors/model:applyRename', {
      internalKey: INTERNAL_KEY,
      vmTokenHash: await sha256Hex(origin.vmToken),
      reports: [
        {
          anchorId: created.share.anchorId,
          candidates: [],
          anchorPathExists: false,
          consecutiveMissingPolls: 2,
          markerMatches: [],
        },
      ],
      now: 5_202,
    })) as { changed: Array<Record<string, unknown>> }
    expect(second.changed).toContainEqual({
      action: 'unlinked',
      anchorId: created.share.anchorId,
      shareId: created.share.id,
    })
    expect(second.changed).toContainEqual({
      action: 'broken',
      anchorId: created.share.anchorId,
      path: 'project',
      reason: 'share_transition',
    })

    const shares = (await query(owner.client, 'testing/shares:rawSharesForTest', {
      internalKey: INTERNAL_KEY,
    })) as Array<{ id: string; state: string }>
    expect(shares.find(share => share.id === created.share.id)?.state).toBe('unlinked')
    expect(shares.find(share => share.id === child.share.id)?.state).toBe('revoked')
    const replicaAfter = (
      (await query(recipient.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipientWorkspaceId,
      })) as AppRow[]
    )[0]!
    expect(replicaAfter).toMatchObject({
      id: replicaBefore.id,
      anchorId: replicaBefore.anchorId,
    })
    expect(replicaAfter.sourceAppId).toBeUndefined()
    expect(replicaAfter.sourceShareId).toBeUndefined()
  })

  test('breaking an origin app anchor deletes every replica and its anchor', async () => {
    const originId = await createWorkspace('app-break-a')
    const recipientId = await createWorkspace('app-break-b')
    const createdShare = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: originId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string } }
    const share = createdShare.share
    const app = (await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: originId,
      path: 'project',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })) as AppRow
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: share.id,
      toWorkspaceId: recipientId,
      mountPath: 'shared/project',
    })
    const replica = (
      (await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipientId,
      })) as AppRow[]
    )[0]!

    await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
      anchorId: app.anchorId,
    })

    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipientId,
      }),
    ).toEqual([])
    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: replica.anchorId }),
    ).toMatchObject({ kind: 'share-mount', path: 'shared/project', state: 'active' })

    await mutate(owner.client, 'domains/anchors/model:reanchor', {
      anchorId: app.anchorId,
      path: 'project',
    })
    const recreated = (
      (await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipientId,
      })) as AppRow[]
    )[0]!
    expect(recreated).toMatchObject({ sourceAppId: app.id, anchorPath: 'shared/project' })
    expect(recreated.id).not.toBe(replica.id)
  })

  test('breaking a recipient replica anchor deletes the replica instead of leaving it broken', async () => {
    const originId = await createWorkspace('rep-break-a')
    const recipientId = await createWorkspace('rep-break-b')
    await mutate(owner.client, 'domains/apps/model:registerApp', {
      workspaceId: originId,
      path: 'project/web',
      command: 'bun run start',
      apiScopes: [],
      slug: 'web',
    })
    const createdShare = (await mutate(owner.client, 'testing/shares:createShareForTest', {
      internalKey: INTERNAL_KEY,
      fromWorkspaceId: originId,
      toEmail: owner.user.email,
      path: 'project',
      mode: 'read',
    })) as { share: { id: string } }
    const share = createdShare.share
    await mutate(owner.client, 'domains/shares/model:acceptShare', {
      shareId: share.id,
      toWorkspaceId: recipientId,
      mountPath: 'shared/project',
    })
    const replica = (
      (await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipientId,
      })) as AppRow[]
    )[0]!

    await mutate(owner.client, 'testing/anchors:markAnchorBrokenForTest', {
      anchorId: replica.anchorId,
      reason: 'folder_removed',
    })

    expect(
      await query(owner.client, 'domains/apps/model:listByWorkspace', {
        workspaceId: recipientId,
      }),
    ).toEqual([])
    expect(
      await query(owner.client, 'domains/anchors/model:getById', { anchorId: replica.anchorId }),
    ).toBeNull()
  })
})

async function createWorkspace(prefix: string): Promise<string> {
  return await createWorkspaceFor(owner, prefix)
}

async function createWorkspaceFor(user: SignedInUser, prefix: string): Promise<string> {
  await mutate(user.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  const workspaceId = (await mutate(user.client, 'testing/workspaces:createWorkspaceForTest', {
    internalKey: INTERNAL_KEY,
    slug: uniqueSlug(prefix),
    name: `${prefix} Workspace`,
  })) as string
  await mutate(user.client, 'testing/workspaces:markWorkspaceLiveForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now: Date.now(),
  })
  return workspaceId
}

async function existingOrCreateWorkspaceFor(user: SignedInUser, prefix: string): Promise<string> {
  const existing = (await query(user.client, 'domains/workspaces/queries:listMine', {})) as Array<{
    workspace: { _id: string }
  }>
  if (existing[0] === undefined) return await createWorkspaceFor(user, prefix)
  const workspaceId = existing[0].workspace._id
  await mutate(user.client, 'testing/workspaces:markWorkspaceLiveForTest', {
    internalKey: INTERNAL_KEY,
    workspaceId,
    now: Date.now(),
  })
  return workspaceId
}

async function provisionRegisteredWorkspace(
  prefix: string,
): Promise<{ workspaceId: string; vmToken: string }> {
  await mutate(owner.client, 'testing/workspaces:activateCurrentUserSyntheticSubscriptionForTest', {
    internalKey: INTERNAL_KEY,
  })
  const slug = uniqueSlug(prefix)
  const provisioningToken = `token-${slug}`
  const now = Date.now()
  const begun = (await mutate(owner.client, 'testing/workspaces:prepareWorkspaceForRegistration', {
    internalKey: INTERNAL_KEY,
    actorId: owner.user._id,
    slug,
    name: `${prefix} Workspace`,
    imageRef: IMAGE_REF,
    provisioningTokenHash: await sha256Hex(provisioningToken),
    provisioningTokenExpiresAt: now + 60_000,
    now,
  })) as { workspaceId: string }
  const registered = (await mutate(owner.client, 'domains/workspaces/provisioning:registerVm', {
    internalKey: INTERNAL_KEY,
    provisioningTokenHash: await sha256Hex(provisioningToken),
    workspaceHint: begun.workspaceId,
    vmName: `vm-${slug}`,
    sshDest: `exedev@vm-${slug}.exe.xyz`,
    httpsUrl: `https://${slug}.exe.xyz`,
    now: now + 1,
  })) as { vmToken: string }
  return { workspaceId: begun.workspaceId, vmToken: registered.vmToken }
}

async function reportRename(
  workspace: { workspaceId: string; vmToken: string },
  anchorId: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  await mutate(owner.client, 'domains/anchors/model:applyRename', {
    internalKey: INTERNAL_KEY,
    vmTokenHash: await sha256Hex(workspace.vmToken),
    reports: [renameReport(anchorId, fromPath, toPath)],
  })
}

function renameReport(anchorId: string, fromPath: string, toPath: string) {
  return {
    anchorId,
    candidates: [
      {
        fromPath,
        toPath,
        confidence: 0.99,
        inodeMatch: true,
        markerMatch: true,
      },
    ],
    anchorPathExists: false,
    consecutiveMissingPolls: 1,
    markerMatches: [toPath],
  }
}

async function expectOneAudit(
  workspaceId: string,
  eventName: string,
  mutateOnce: () => Promise<unknown>,
): Promise<void> {
  const before = await auditEvents(workspaceId)
  await mutateOnce()
  await expectAuditDelta(workspaceId, before, eventName)
}

async function expectAuditDelta(
  workspaceId: string,
  before: AuditRow[],
  eventName: string,
): Promise<void> {
  const after = await auditEvents(workspaceId)
  expect(after).toHaveLength(before.length + 1)
  expect(newAuditEvents(before, after)).toEqual([
    expect.objectContaining({ event: eventName, actorId: owner.user._id }),
  ])
}

async function auditEvents(workspaceId: string): Promise<AuditRow[]> {
  return (await query(owner.client, 'domains/workspaces/queries:getAuditEvents', {
    workspaceId,
  })) as AuditRow[]
}

function newAuditEvents(before: AuditRow[], after: AuditRow[]): AuditRow[] {
  const existingIds = new Set(before.map(event => event.id))
  return after.filter(event => !existingIds.has(event.id))
}

async function sha256Hex(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

function uniqueSlug(prefix: string): string {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

function projectedAgentAnchor(
  id: string,
  path: string,
  agentId: string,
  kind: GatewayAnchor['kind'] = 'agent',
): GatewayAnchor {
  return {
    id,
    agentId,
    workspaceId: 'workspace_1',
    path,
    kind,
    settings: {},
    state: 'active',
    createdAt: 1,
    updatedAt: 1,
    markerNonce: `nonce-${id}`,
  }
}

interface SignedInUser {
  client: ConvexHttpClient
  user: UserRow
}

interface UserRow {
  _id: string
  email: string
  name?: string
}

interface AnchorRow {
  id: string
  workspaceId: string
  path: string
  kind: 'app' | 'agent' | 'publish' | 'share-root' | 'share-mount'
  settings: unknown
  state: 'active' | 'broken' | 'orphaned'
  createdAt: number
  updatedAt: number
}

interface AppRow {
  id: string
  anchorId: string
  anchorPath: string
  slug: string
  sourceShareId?: string
  sourceAppId?: string
  disabledAt?: number
}

interface AuditRow {
  id: string
  event: string
  actorId: string
}
