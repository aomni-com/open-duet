# 12 — Skills: `start-session` and `schedule-task`

**Repo:** Duet, `packages/skills-registry`. Implements D6, D8, D11, D12′, D13,
D14. Depends on slices 08 and 09 — the skills document those exact routes.

## Contract unlocked

An agent can start a visible session and create a scheduled job using the
credentials already in its environment, with no new tool.

## Why skills and not tools

The runner's spawn env already carries `DUET_API_URL`, `DUET_API_KEY`, and
`DUET_SESSION_ID` (`packages/gateway/src/runtime/http.ts:947-956`,
`runner/process-runner.ts:341`), and that key is minted with
`ws:{slug}:sessions|agents|apps|services`
(`backend/convex/domains/apiKeys/model.ts:823`). `GET /v1/whoami` yields the
slug. Three shipped skills already work exactly this way — `duet`,
`manage-agents`, `publish`. A dedicated tool would be a second way to do what
curl already does.

## API seam

Two authored skills under `packages/skills-registry/skills/`, `target: sandbox`.

**`start-session`** — owns the create call and everything about reading another
session:

- `whoami` → slug; `POST /v1/ws/{slug}/agent/sessions/{sessionId}/sessions`
  with the parent in the path, `cwd`/`tier` omitted to inherit.
- Return the link to the user. That is the point of the feature.
- **Querying jobs, explicitly** (D12′): `GET /v1/ws/{slug}/agent/jobs?view=active&agentId=<id>`,
  where the literal string `root` selects sessions with no agent
  (`ROOT_AGENT_SCOPE`, `contract/src/sessions/index.ts:123`) and omitting
  `agentId` returns every job in the workspace.
- **The poll loop** (D13): `POST .../messages` with `behavior: "follow_up"`
  (**not** `note`, which deliberately does not wake the runner), then
  `GET .../history?cursor=<seq>` until a terminal event, reading `complete.result`.
  Terminal events are `complete | ask | interrupted | sleep`.
- `steer` is documented for "stop what you're doing" only.

**`schedule-task`** — owns recurrence, and points at `start-session` for the
create call rather than restating it:

- The canonical `timer → agent → timer` shape from D8, written out as JSON so
  every scheduled task looks the same in the Jobs list.
- **Absolute `wakeAt`, not relative `wakeAfterMs`**, for clock-anchored
  schedules, so a turn that runs early cannot drift the schedule.
- Interval floors: the wire enforces a minimum (slice 05); the skill documents a
  much higher practical floor — nothing under a few minutes without the user
  asking for it.
- How to cancel: a terminal state.
- Reading status: `relaySummary` via the session snapshot.

Both cross-reference `duet` for auth and docs discovery. `manage-agents` gains a
pointer to both.

## What the human can run or see

`bunx` the rendered skills from a live workspace; ask an agent to "check my
calendar every morning" and watch a job appear in the Jobs list.

## Verification gates

`bun run test` for the registry, including the bundle-hash and codegen tests.
**`packages/skills-registry/src/generated.ts` is checked in and a test asserts a
codegen rerun produces no diff — regenerate it in the same commit.**

## Must stay green

Existing skill bundle hash tests; skill installation on the gateway; the
`target` frontmatter contract.

## Fixed by this slice

Two skills, not one. `follow_up` as the interrogation default. Absolute `wakeAt`.
Job queries documented explicitly including the root scope.

## Delegated to the implementer

Prose and examples, within the trigger-quality constraint: the `description` is
the entire trigger, so it must cover the phrasings a user would actually use.
