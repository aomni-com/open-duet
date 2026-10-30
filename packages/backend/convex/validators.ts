import { v, type Validator } from 'convex/values'

import {
  AGENT_SESSION_STATUSES,
  ATTRIBUTION_TIER_IDS,
  RECORDED_ATTRIBUTION_TIER_IDS,
  RECORDED_MODEL_SELECTION_IDS,
  MODEL_SELECTION_IDS,
  RUNNER_DELIVERY_KINDS,
  SESSION_BUCKETS,
  type ActivitySessionSummary,
  type AgentFollowUpQueueEntry,
  type AgentIdentity,
  type AgentTodo,
  type ChatActivity,
  type GatewayBlock,
  type Machine,
  type MessagePreview,
  type MessagePreviewAuthor,
  type RunnerDeliveryAttempt,
  type SessionInputSender,
  type SessionActivityResponse,
  type SessionActivityMachine,
  type SessionListItem,
  type SessionAudienceMemberPreview,
  type SessionSummary,
} from '@repo/contract'

/**
 * A Convex union validator over a contract enum tuple, inferring its own arm type.
 *
 * The alternative — and what the codebase did until this existed — is to index
 * the tuple by hand, `v.literal(XS[0]), v.literal(XS[1]), …`. That compiles
 * clean forever: add a sixth arm to the contract and the validator silently
 * keeps accepting five, rejecting the new value at runtime only. Passing the
 * tuple itself makes the arm type follow the contract, so a widened enum either
 * works or fails to typecheck at the callers that narrow on it.
 */
export function contractEnumValidator<T extends string>(
  values: readonly [T, T, ...T[]],
): Validator<T, 'required', never> {
  const [first, second, ...rest] = values
  return v.union(
    v.literal(first),
    v.literal(second),
    ...rest.map(value => v.literal(value)),
  ) as Validator<T, 'required', never>
}

/**
 * `z.record(z.string(), z.unknown())`, spelled the only way Convex can spell it —
 * there is no `v.unknown()`. Not a gap to close: the interiors it guards are
 * owned by duet-agent, which the contract states outright (`agent/index.ts`).
 * Claiming a shape here would be inventing one.
 */
const unknownRecordValidator = v.record(v.string(), v.any())

export const hashedTokenFields = {
  tokenHash: v.string(),
  tokenPrefix: v.string(),
  activeKey: v.optional(v.string()),
}

export const upstreamGenerationMetadataValidator = v.object({
  provider: v.optional(v.string()),
  routeSource: v.optional(v.union(v.literal('vercel'), v.literal('configured_upstream'))),
  usage: v.optional(
    v.object({
      uncachedInputTokens: v.number(),
      cachedInputTokens: v.number(),
      outputTokens: v.number(),
    }),
  ),
  cacheCreationInputTokens: v.optional(v.number()),
})

export const modelSelectionIdValidator = contractEnumValidator(MODEL_SELECTION_IDS)
export const recordedModelSelectionIdValidator = contractEnumValidator(RECORDED_MODEL_SELECTION_IDS)
/**
 * What a generation records it billed as. Wider than the user tiers on purpose:
 * work under the `services` grant bills at the model's own cost, not a tier's
 * flat rate, and that claim has to survive to settlement. Sessions and workspace
 * defaults admit only selectable routers and provider aliases.
 */
export const attributionTierIdValidator = contractEnumValidator(ATTRIBUTION_TIER_IDS)
export const recordedAttributionTierIdValidator = contractEnumValidator(
  RECORDED_ATTRIBUTION_TIER_IDS,
)

export const usageRollupGranularityValidator = v.union(
  v.literal('daily'),
  v.literal('weekly'),
  v.literal('monthly'),
)

export const usageRollupFields = {
  workspaceId: v.id('workspaces'),
  granularity: usageRollupGranularityValidator,
  periodKey: v.string(),
  spendMicroUsd: v.number(),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  userId: v.optional(v.id('users')),
  appId: v.optional(v.id('apps')),
  appSlug: v.optional(v.string()),
  updatedAt: v.number(),
}

const reservationStatusValidator = v.union(
  v.literal('held'),
  v.literal('settled'),
  v.literal('released'),
)

const reservationEventValidator = v.union(
  v.literal('hold'),
  v.literal('settle'),
  v.literal('release'),
)

export const creditTransactionMetadataValidator = v.object({
  status: v.optional(reservationStatusValidator),
  event: v.optional(reservationEventValidator),
  walletAllocation: v.optional(
    v.object({
      monthlyDebitMicroUsd: v.number(),
      paidDebitMicroUsd: v.number(),
      monthlyCreditEpoch: v.optional(v.string()),
    }),
  ),
  estimateMicroUsd: v.optional(v.number()),
  actualCostMicroUsd: v.optional(v.number()),
  // The attribution, matching the generation this settles: a credit row for
  // services work records `services`, not a user-selected router or provider alias.
  tier: v.optional(recordedAttributionTierIdValidator),
  reservationId: v.optional(v.string()),
  releaseReason: v.optional(v.string()),
  balanceDeltaMicroUsd: v.optional(v.number()),
  forfeitedMonthlyMicroUsd: v.optional(v.number()),
  /* What KIND of `usage` this is. Model spend leaves this unset; the daily VM
     compute fee stamps `vm_compute`. A named field rather than `context`
     because the billing history reads it -- the difference between answering a
     confused user in one line and reconstructing a ledger to work out what
     charged them. */
  usageKind: v.optional(v.literal('vm_compute')),
  /* Caller-specific detail goes here, not as a named column. The 26 fields that
     used to sit below this were a compat shim for `v.any()` rows, added the same
     day the backup-first reset wiped those rows — and two of them (`modality`,
     `model`) shadowed values the live code writes under `context`. */
  context: v.optional(unknownRecordValidator),
})

export const agentTodoValidator = v.object({
  id: v.string(),
  content: v.string(),
  status: v.union(
    v.literal('pending'),
    v.literal('in_progress'),
    v.literal('completed'),
    v.literal('failed'),
  ),
}) satisfies Validator<AgentTodo, 'required', string>

const agentPromptImageValidator = v.object({
  data: v.string(),
  mimeType: v.string(),
})

export const agentFollowUpQueueEntryValidator = v.object({
  message: v.string(),
  images: v.optional(v.array(agentPromptImageValidator)),
}) satisfies Validator<AgentFollowUpQueueEntry, 'required', string>

export const agentStateMachineDefinitionValidator = v.object({
  name: v.string(),
  prompt: v.string(),
  states: v.array(unknownRecordValidator),
})

export const agentStateMachineSessionValidator = v.object({
  definition: agentStateMachineDefinitionValidator,
  prompt: v.string(),
  currentState: v.optional(v.string()),
  currentInput: v.optional(unknownRecordValidator),
  progress: v.optional(unknownRecordValidator),
  history: v.array(unknownRecordValidator),
  terminal: v.optional(unknownRecordValidator),
  terminalAcknowledged: v.optional(v.boolean()),
  createdAt: v.number(),
  updatedAt: v.number(),
})

const machinePathItemValidator = v.object({
  key: v.string(),
  index: v.number(),
  name: v.string(),
  kind: v.optional(v.string()),
  phase: v.union(
    v.literal('past'),
    v.literal('current'),
    v.literal('future'),
    v.literal('outcome'),
  ),
  terminalStatus: v.optional(
    v.union(
      v.literal('completed'),
      v.literal('failed'),
      v.literal('cancelled'),
      v.literal('error'),
    ),
  ),
})

export const machineValidator = v.object({
  definitionName: v.optional(v.string()),
  currentState: v.optional(v.string()),
  followingDefinitionState: v.optional(v.string()),
  progress: v.optional(v.object({ completed: v.number(), total: v.number() })),
  orderedPath: v.array(machinePathItemValidator),
  activity: v.union(
    v.literal('running'),
    v.literal('sleeping'),
    v.literal('waiting'),
    v.literal('idle'),
  ),
  nextWakeAt: v.optional(v.number()),
  outcome: v.optional(
    v.union(
      v.literal('interrupted'),
      v.literal('completed'),
      v.literal('failed'),
      v.literal('cancelled'),
      v.literal('error'),
    ),
  ),
}) satisfies Validator<Machine, 'required', string>

// Persisted enum vocabularies intentionally derive from @repo/contract so a
// contract change cannot silently leave Convex validation behind.
export const agentSessionStatusValidator = contractEnumValidator(AGENT_SESSION_STATUSES)
export const sessionBucketValidator = contractEnumValidator(SESSION_BUCKETS)

export const agentIdentityValidator = v.object({
  id: v.string(),
  name: v.string(),
}) satisfies Validator<AgentIdentity, 'required', string>

/**
 * The one session projection every list and mutation returns.
 *
 * Bound to the contract type rather than described beside it: `satisfies` is
 * what stops this drifting from `SessionSummarySchema`, since nothing else
 * cross-checks a Convex validator against its Zod twin.
 */
export const sessionSummaryValidator = v.object({
  id: v.string(),
  turnStatus: agentSessionStatusValidator,
  bucket: sessionBucketValidator,
  title: v.string(),
  titleOrigin: v.union(v.literal('excerpt'), v.literal('auto'), v.literal('manual')),
  titleStatus: v.union(v.literal('generating'), v.literal('complete'), v.literal('failed')),
  cwd: v.optional(v.string()),
  agent: v.optional(agentIdentityValidator),
  onboarding: v.optional(v.boolean()),
  createdBySessionId: v.optional(v.string()),
  machine: v.optional(machineValidator),
  createdAt: v.number(),
  updatedAt: v.number(),
  lastEventSeq: v.number(),
  unread: v.boolean(),
  audience: v.union(
    v.object({ kind: v.literal('workspace') }),
    v.object({
      kind: v.literal('specific'),
      count: v.number(),
      preview: v.array(
        v.object({
          memberId: v.string(),
          userId: v.string(),
          name: v.string(),
          email: v.string(),
          role: v.union(v.literal('owner'), v.literal('editor'), v.literal('viewer')),
        }),
      ),
    }),
  ),
  archive: v.object({
    globalArchivedAt: v.union(v.number(), v.null()),
    personalArchivedAt: v.union(v.number(), v.null()),
    reason: v.union(v.literal('global'), v.literal('personal'), v.null()),
  }),
  permissions: v.object({
    send: v.boolean(),
    answer: v.boolean(),
    interrupt: v.boolean(),
    rename: v.boolean(),
    manageAudience: v.boolean(),
    personalArchive: v.boolean(),
    globalArchive: v.boolean(),
    delete: v.boolean(),
  }),
}) satisfies Validator<SessionSummary, 'required', string>

export const sessionAudienceMemberPreviewValidator = v.object({
  memberId: v.string(),
  userId: v.string(),
  name: v.string(),
  email: v.string(),
  role: v.union(v.literal('owner'), v.literal('editor'), v.literal('viewer')),
}) satisfies Validator<SessionAudienceMemberPreview, 'required', string>

export const sessionAudiencePageValidator = v.object({
  items: v.array(sessionAudienceMemberPreviewValidator),
  nextCursor: v.union(v.string(), v.null()),
})

// Identity only, and every field the wire union carries: a closed arg
// validator that drifts from the shared schema rejects the payload before any
// handler runs.
export const sessionInputSenderValidator = v.union(
  v.object({ kind: v.literal('user'), userId: v.string() }),
  v.object({ kind: v.literal('app'), appId: v.string() }),
  v.object({ kind: v.literal('session'), sessionId: v.string() }),
  v.object({ kind: v.literal('system') }),
) satisfies Validator<SessionInputSender, 'required', string>

/* The four sender kinds plus the agent's own voice. Declared after
   `sessionInputSenderValidator` rather than re-listing its members, so a fifth
   sender kind cannot reach the wire without reaching this too. */
export const messagePreviewAuthorValidator = v.union(
  v.object({ kind: v.literal('agent') }),
  ...sessionInputSenderValidator.members,
) satisfies Validator<MessagePreviewAuthor, 'required', string>

/**
 * The last human-readable thing said in a conversation — see `messagePreviewOf`,
 * which is the only thing in the repo that decides what that is.
 */
export const messagePreviewValidator = v.object({
  text: v.string(),
  author: messagePreviewAuthorValidator,
}) satisfies Validator<MessagePreview, 'required', string>

/**
 * The conversation an owner *is*, which is the one session that carries a
 * preview. Built from the summary's own fields so the two cannot drift apart.
 */
export const sessionActivityMachineValidator = v.object({
  step: v.optional(v.string()),
  progress: v.optional(v.object({ completed: v.number(), total: v.number() })),
  activity: v.union(
    v.literal('running'),
    v.literal('sleeping'),
    v.literal('waiting'),
    v.literal('idle'),
  ),
  nextWakeAt: v.optional(v.number()),
  outcome: v.optional(
    v.union(
      v.literal('interrupted'),
      v.literal('completed'),
      v.literal('failed'),
      v.literal('cancelled'),
      v.literal('error'),
    ),
  ),
}) satisfies Validator<SessionActivityMachine, 'required', string>
export const activitySessionSummaryValidator = v.object({
  id: v.string(),
  title: v.string(),
  bucket: sessionBucketValidator,
  updatedAt: v.number(),
  unread: v.boolean(),
  machine: v.optional(sessionActivityMachineValidator),
}) satisfies Validator<ActivitySessionSummary, 'required', string>

export const chatActivityValidator = v.object({
  ...activitySessionSummaryValidator.fields,
  preview: v.optional(messagePreviewValidator),
}) satisfies Validator<ChatActivity, 'required', string>

export const sessionListPageValidator = v.object({
  items: v.array(
    v.object({
      ...sessionSummaryValidator.fields,
      machine: v.optional(sessionActivityMachineValidator),
    }) satisfies Validator<SessionListItem, 'required', string>,
  ),
  nextCursor: v.union(v.string(), v.null()),
})

/**
 * Every owner's prioritized recent work, in one read.
 *
 * An array rather than a record keyed by agent id: a record forces the reader to
 * know `ROOT_AGENT_SCOPE` is a key rather than an id, and it has no order — and
 * order is half of what this endpoint answers.
 */
export const sessionActivityResponseValidator = v.object({
  owners: v.array(
    v.object({
      agentId: v.string(),
      sessions: v.array(activitySessionSummaryValidator),
      truncated: v.boolean(),
      /* The conversation this owner *is*, kept out of the work beside it — see
         `AgentActivitySchema`, which owns the shape and its edges. */
      chat: v.optional(chatActivityValidator),
    }),
  ),
}) satisfies Validator<SessionActivityResponse, 'required', string>

export const runnerDeliveryAttemptValidator = v.object({
  attemptId: v.string(),
  throughSeq: v.number(),
  kind: contractEnumValidator(RUNNER_DELIVERY_KINDS),
  createdAt: v.number(),
}) satisfies Validator<RunnerDeliveryAttempt, 'required', string>

/**
 * One durable timeline row.
 *
 * `event` stays `v.any()` and cannot be anything else: its interior is
 * duet-agent-owned and the contract types it `unknown`, so there is no shape
 * here to bind to. Everything Duet *does* own — the sequence and the timestamp —
 * is pinned, which is the difference between this and a bare `v.any()` row.
 */
export const sessionTimelineEntryValidator = v.object({
  seq: v.number(),
  event: v.any(),
  createdAt: v.number(),
})

export const sessionHistoryPageValidator = v.object({
  items: v.array(sessionTimelineEntryValidator),
  nextCursor: v.union(v.string(), v.null()),
})

/**
 * The summary plus everything only the session's own reader needs.
 *
 * Deliberately not `satisfies Validator<SessionSnapshot>`: `requestedMachine` and
 * `machineState` bottom out in duet-agent-owned state interiors, which are
 * `unknown` in the contract and can only be `v.any()` here, so the structural
 * check cannot bind. Every field Duet does own is pinned.
 */
export const sessionSnapshotValidator = v.object({
  ...sessionSummaryValidator.fields,
  workspaceId: v.string(),
  tier: v.optional(modelSelectionIdValidator),
  lastDeliveredInputSeq: v.number(),
  deliveryAttempt: v.optional(runnerDeliveryAttemptValidator),
  todos: v.optional(v.array(agentTodoValidator)),
  followUpQueue: v.optional(v.array(agentFollowUpQueueEntryValidator)),
  requestedMachine: v.optional(agentStateMachineDefinitionValidator),
  machineState: v.optional(agentStateMachineSessionValidator),
})

export const gatewayBlockValidator = v.union(
  v.object({
    status: v.literal(401),
    body: v.object({
      error: v.literal('unauthorized'),
      code: v.union(
        v.literal('missing_api_key'),
        v.literal('invalid_api_key'),
        v.literal('expired_api_key'),
      ),
    }),
  }),
  v.object({
    status: v.literal(402),
    body: v.object({
      error: v.literal('insufficient_credits'),
      code: v.literal('insufficient_credits'),
      tier: v.literal('account'),
      balanceMicroUsd: v.number(),
      autoTopupScheduled: v.boolean(),
      billingUrl: v.string(),
    }),
  }),
  v.object({
    status: v.literal(402),
    body: v.object({
      error: v.literal('monthly_cap'),
      code: v.literal('monthly_cap'),
      tier: v.union(v.literal('account'), v.literal('workspace')),
      balanceMicroUsd: v.number(),
      autoTopupScheduled: v.boolean(),
      billingUrl: v.string(),
    }),
  }),
  v.object({
    status: v.literal(402),
    body: v.object({
      error: v.literal('subscription_required'),
      code: v.literal('subscription_required'),
      billingUrl: v.string(),
    }),
  }),
  v.object({
    status: v.literal(402),
    body: v.object({
      error: v.literal('subscription_inactive'),
      code: v.literal('subscription_inactive'),
      billingUrl: v.string(),
    }),
  }),
  v.object({
    status: v.literal(402),
    body: v.object({
      error: v.literal('payment_required'),
      code: v.literal('payment_required'),
      billingUrl: v.string(),
    }),
  }),
  v.object({
    status: v.literal(403),
    body: v.object({
      error: v.literal('model_not_allowed'),
      code: v.literal('model_not_allowed'),
    }),
  }),
  v.object({
    status: v.literal(409),
    body: v.object({
      error: v.literal('onboarding_required'),
      code: v.literal('onboarding_required'),
      onboardingUrl: v.string(),
    }),
  }),
  v.object({
    status: v.literal(403),
    body: v.object({
      error: v.literal('tier_not_allowed'),
      code: v.literal('tier_not_allowed'),
    }),
  }),
  v.object({
    status: v.literal(403),
    body: v.object({
      error: v.string(),
      code: v.literal('endpoint_not_available'),
    }),
  }),
  v.object({
    status: v.literal(403),
    body: v.object({
      error: v.literal('insufficient_scope'),
      code: v.literal('insufficient_scope'),
      scope: v.string(),
    }),
  }),
  v.object({
    status: v.literal(403),
    body: v.object({
      error: v.string(),
      code: v.union(v.literal('workspace_ambiguous'), v.literal('workspace_mismatch')),
    }),
  }),
  v.object({
    status: v.literal(404),
    body: v.object({
      error: v.string(),
      code: v.literal('service_not_found'),
    }),
  }),
  v.object({
    status: v.literal(503),
    body: v.object({
      error: v.string(),
      code: v.literal('service_unavailable'),
    }),
  }),
  v.object({
    status: v.literal(429),
    body: v.object({
      error: v.literal('rate_limited'),
      code: v.literal('rate_limited'),
      retryAfterSeconds: v.number(),
    }),
  }),
) satisfies Validator<GatewayBlock, 'required', string>
