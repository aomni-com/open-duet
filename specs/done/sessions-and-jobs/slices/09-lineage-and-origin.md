# 09 — Nested create, lineage, and message origin

**Repo:** Duet. Implements D18, D21, D23. Depends on slice 08.

## Contract unlocked

A session can start another session that the user can see; the child knows who
started it; and a message injected by another session no longer impersonates the
user.

## API seam — nested create

```text
POST /v1/ws/{slug}/agent/sessions/{sessionId}/sessions
```

Shares one handler with the flat `POST /agent/sessions`. The parent is
**structural, not remembered**: the precedent is the onboarding-completion route,
which exists in its session-keyed form because a live runner skipped the
derive-your-own-ids ceremony and stranded a user
(`apps/api/src/routes/agents.ts:131-136`).

- Omitted `cwd` and `tier` **inherit from the parent**. Inheriting `cwd` also
  inherits agent attribution, since attribution resolves from `cwd`.
- `createdBySessionId` is stamped by the route, never accepted from the body.
- No depth limit (D18). The Jobs list is the backstop against fan-out; nothing
  caps sessions per workspace, and that is recorded as a sharp edge, not fixed
  here.

Schema: `agentSessions.createdBySessionId: v.optional(v.id('agentSessions'))`,
mirrored onto `SessionSummary` in the contract. No new index — lineage is read
per-row, not queried.

## API seam — message origin

`AgentUserPromptEventSchema` (`contract/src/agent/index.ts:556-564`) has no
author field at all, so an injected message renders exactly like the human
typing. The onboarding kickoff has the same defect: it is written through the
same path as a plain `user_prompt` with `inputKind: 'initial'`
(`domains/agentSessions/delivery.ts:798-812`).

Add one field, used by both:

```ts
type SessionMessageOrigin = 'user' | 'system' | `session:${string}`
```

- On `AgentMessageRequestSchema` and on the `user_prompt` / `user_note` /
  `answer_submitted` events. Absent means `user`.
- The onboarding kickoff writes `system`.
- The nested-create and cross-session message paths write `session:<id>`
  structurally, from the credential's own session, not from the body.

## Gateway seam — launch projection

The loose launch envelope projects lineage and default identity on every
dispatch. `createdBySessionId` comes from the durable session row.
`defaultSession: true` is derived at dispatch by comparing that row with its
owner pointer (`workspaces.rootDefaultSessionId` or
`agents.defaultSessionId`); it is never stored on the session.

This closes a gap in the original slice plan: slice 11 needs both facts while
assembling prompt layers, so slice 09 must deliver them across the gateway
boundary even though it does not consume them.

## What the human can run or see

Start a child session from a parent by REST; open the child and see "started by
X" (slice 10 renders it); send it a question from the parent and see the bubble
attributed rather than shown as your own message.

## Verification gates

`bun run test` (contract + backend + api), `bun run check-types`. Convex
validators widened in the same commit with a NEW-shaped-payload test against the
real function.

## Must stay green

Flat session creation; spend preflight's 402 path
(`apps/api/src/routes/agent.ts:57`) — an agent-created session can be rejected on
billing and the error must reach the caller, not be swallowed; onboarding's
existing behavior with `origin: 'system'` added.

## Fixed by this slice

Parent in the path, not the body. Inheritance for `cwd` and `tier`. One `origin`
field covering both injected-message cases. No depth limit.

## Resolved during implementation

Delegation to a sub-agent falls out of inheritance rather than needing its own
seam: an explicit `cwd` re-resolves attribution from scratch, so a parent hands
work to another agent by naming that agent's folder, and the deepest enclosing
anchor wins. Pinned by `backend/src/agent-sessions.test.ts` ("a nested cwd hands
the child to the deepest agent"); `start-session` documents it.

The origin union serializes as its literal strings. A dangling
`createdBySessionId` remains on the child row and is projected verbatim; deleting
a parent neither cascades nor rewrites its children, so slice 10 can render the
missing lookup as "(deleted)".
