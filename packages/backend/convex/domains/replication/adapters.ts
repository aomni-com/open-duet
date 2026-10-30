import type { MutationCtx } from '../../_generated/server'
import { agentSharedReplicaAdapter } from '../agents/replication'
import { appSharedReplicaAdapter } from '../apps/replication'
import type { SharedReplicaAdapter } from './shared'

export function sharedReplicaAdapters(ctx: MutationCtx): readonly SharedReplicaAdapter<unknown>[] {
  return [appSharedReplicaAdapter(ctx), agentSharedReplicaAdapter(ctx)]
}
