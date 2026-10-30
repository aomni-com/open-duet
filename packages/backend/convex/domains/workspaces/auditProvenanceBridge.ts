import type { Infer } from 'convex/values'

import type { WorkspaceAuditProvenance } from '@repo/contract'

import type { auditProvenance } from '../../schema'

/**
 * Compile-time bridge between the Convex `auditProvenance` validator (the
 * write-time authority in schema.ts) and the public contract's
 * `WorkspaceAuditProvenanceSchema` (what `workspace-audit-list` promises on
 * the wire). Nothing here runs; it exists so `check-types` fails the moment
 * either schema gains, loses, or retypes a field the other doesn't.
 */
type ConvexAuditProvenance = Infer<typeof auditProvenance>

type AssertNever<T extends never> = T

// Neither side may declare a key the other lacks.
export type _ContractCoversEveryConvexKey = AssertNever<
  Exclude<keyof ConvexAuditProvenance, keyof WorkspaceAuditProvenance>
>
export type _ConvexCoversEveryContractKey = AssertNever<
  Exclude<keyof WorkspaceAuditProvenance, keyof ConvexAuditProvenance>
>

// Every provenance Convex accepts at write time must satisfy the contract
// type (Convex ids widen to the contract's plain strings).
export const _everyStoredProvenanceSatisfiesTheContract: (
  provenance: ConvexAuditProvenance,
) => WorkspaceAuditProvenance = provenance => provenance
