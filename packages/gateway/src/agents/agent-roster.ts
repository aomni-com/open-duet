import type { GatewayAgentConfig } from '@repo/contract'

export interface AgentRoster {
  accept(agents: readonly GatewayAgentConfig[] | undefined): void
  /** `undefined` until the first defined roster arrives — never an empty array. */
  snapshot(): GatewayAgentConfig[] | undefined
}

/**
 * The gateway's copy of the last accepted agent roster, beside the app
 * supervisor and the anchor registry as the third leg of sync state. Not part
 * of `DesiredStateSnapshot` on purpose: that store is the persisted
 * update-control record, and roster data is repopulated by the next poll —
 * losing it across a restart costs one sync interval, not correctness.
 *
 * `undefined` preserves the previous snapshot: an absent field is what an
 * older API sends, and stripping the roster because the producer predates it
 * would blank every session's colleagues on the next turn. An explicit empty
 * array clears — that is what a quiesced workspace sends.
 *
 * Before the first defined roster the snapshot is `undefined`, not `[]`:
 * "nobody has told us yet" and "this workspace has no agents" are different
 * answers, and a reader that cannot tell them apart reports a cold gateway as
 * an empty workspace.
 */
export function createAgentRoster(): AgentRoster {
  let agents: GatewayAgentConfig[] | undefined
  return {
    accept(next) {
      if (next === undefined) return
      agents = structuredClone(next) as GatewayAgentConfig[]
    },
    snapshot() {
      return agents === undefined ? undefined : structuredClone(agents)
    },
  }
}
