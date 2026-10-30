import { describe, expect, test } from 'bun:test'

import { appNodeId, jobNodeId, jobsMoreNodeId, moreNodeId, nearestDrawnNode } from './layout'

/* The rail can point at anything on a row. The ring draws three apps and five
   jobs per agent and folds the rest behind a mark, so plenty of what the list
   shows has no node of its own. Rather than let those point at nothing, the map
   answers with the nearest thing it did draw — which is exactly where the
   reader would have to look for it anyway. */
describe('resolving what the rail points at against what the ring drew', () => {
  const drawn = (ids: readonly string[]) => (candidate: string) => ids.includes(candidate)

  test('a node that is on the map answers for itself', () => {
    const id = appNodeId('analyst', 'metrics')
    expect(nearestDrawnNode(id, drawn([id]))).toBe(id)
  })

  test('an app folded behind the mark lights the mark', () => {
    expect(nearestDrawnNode(appNodeId('analyst', 'ledger'), drawn([moreNodeId('analyst')]))).toBe(
      moreNodeId('analyst'),
    )
  })

  test('a job past the fan lights the jobs mark', () => {
    expect(
      nearestDrawnNode(jobNodeId('analyst', 'sweep'), drawn([jobsMoreNodeId('analyst')])),
    ).toBe(jobsMoreNodeId('analyst'))
  })

  test('with no mark either, it falls back to the agent carrying it', () => {
    expect(nearestDrawnNode(appNodeId('analyst', 'ledger'), drawn(['analyst']))).toBe('analyst')
    expect(nearestDrawnNode(jobNodeId('analyst', 'sweep'), drawn(['analyst']))).toBe('analyst')
  })

  test('an agent the ring is not drawing at all lights nothing', () => {
    // Rather than lighting something adjacent and wrong.
    expect(nearestDrawnNode('ghost', drawn(['analyst']))).toBe(null)
    expect(nearestDrawnNode(appNodeId('ghost', 'metrics'), drawn(['analyst']))).toBe(null)
  })
})
