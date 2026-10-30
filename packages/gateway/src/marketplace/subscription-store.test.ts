import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMarketplaceAgentSubscriptionStore } from './subscription-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true })))
})

describe('marketplace subscription store', () => {
  test('persists an accepted subscription snapshot and reloads it', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-official-agent-store-'))
    temporaryDirectories.push(stateDir)
    const store = createMarketplaceAgentSubscriptionStore(stateDir)
    const subscription = {
      subscriptionId: 'subscription-1',
      agentName: 'research-assistant',
      listingId: 'listing-1',
      sourceUrl: 'https://edge.duet.so/golden/official-agents/research?zip',
      path: 'agents/research-assistant',
      anchorId: 'anchor-1',
      etag: '"tree-1"',
      manifest: { files: { 'AGENTS.md': { sha256: 'a'.repeat(64) } } },
      lastRevalidatedAt: 1234,
      lastConvergedAt: 5678,
    }

    store.replace([subscription])

    expect(createMarketplaceAgentSubscriptionStore(stateDir).current()).toEqual([subscription])
    expect(
      JSON.parse(await readFile(join(stateDir, 'marketplace-subscriptions.json'), 'utf8')),
    ).toEqual([subscription])
  })

  // The two jobs used to be one event, so a file written before the split
  // carries one `lastAppliedAt`. It seeds both clocks — otherwise every upgraded
  // VM would read as never-applied and re-pull its whole subscription list at
  // boot, which is the one thing this release must not do to the fleet.
  test('a state file from the previous release seeds both clocks and upgrades in place', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'duet-official-agent-store-'))
    temporaryDirectories.push(stateDir)
    const legacy = {
      subscriptionId: 'subscription-1',
      agentName: 'research-assistant',
      listingId: 'listing-1',
      sourceUrl: 'https://edge.duet.so/golden/official-agents/research?zip',
      path: 'agents/research-assistant',
      anchorId: 'anchor-1',
      etag: '"tree-1"',
      manifest: { files: { 'AGENTS.md': { sha256: 'a'.repeat(64) } } },
      lastAppliedAt: 1234,
    }
    await writeFile(
      join(stateDir, 'marketplace-subscriptions.json'),
      JSON.stringify([legacy], null, 2),
    )

    const store = createMarketplaceAgentSubscriptionStore(stateDir)
    const [loaded] = store.current()

    const { lastAppliedAt: _legacyClock, ...identity } = legacy
    expect(loaded).toEqual({ ...identity, lastRevalidatedAt: 1234, lastConvergedAt: 1234 })
    // ...and the legacy key is gone the moment anything writes the file back.
    store.replace(store.current())
    expect(
      JSON.parse(await readFile(join(stateDir, 'marketplace-subscriptions.json'), 'utf8')),
    ).toEqual([{ ...identity, lastRevalidatedAt: 1234, lastConvergedAt: 1234 }])
  })
})
