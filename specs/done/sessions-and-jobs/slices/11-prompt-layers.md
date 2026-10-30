# 11 — Prompt layers: default-session and parent-lineage

**Repo:** Duet, gateway. Implements D11a, D20, D22. Depends on slices 08 and 09.

## Contract unlocked

The default session knows to delegate trackable and scheduled work to other
sessions, and a child session knows who started it and how to ask.

## Why a prompt layer and not a skill

A skill only enters context when its description matches what the user said.
"Don't do this here — spawn a session" must fire *before* the model knows it
needs a skill. Skills own the **how**; the layer owns the **when**.

## API seam

Two new generated layers, siblings of `your-apps-prompt.ts`, resolved through
the one containment-checked resolver in
`packages/gateway/src/agents/agent-context.ts` — no caller builds a prompt path
of its own. Each is written atomically to the per-agent state directory
(`agent-context.ts:162-176`) and regenerated at every launch, which means every
turn, since every turn is a fresh spawn.

- **`default-session-prompt.ts`** — rendered only for a default session, scoped
  `{kind:'agent'} | {kind:'root'}` like the apps layer.
- **`parent-session-prompt.ts`** — rendered only when `createdBySessionId` is
  set. Stable bytes for the session's life, so it costs no prompt-cache churn.

Do **not** edit `DEVELOPER_SYSTEM_PROMPT` (`runner/developer-system-prompt.ts`)
— it is deliberately byte-stable for provider prompt caching. Conditional
content is a sibling file.

## The default-session layer's content

The load-bearing prose of this feature. It must say:

- This is the user's home conversation for this agent; keep it responsive and
  keep its context clean.
- Work the user should be able to watch, return to, or track → start a separate
  session and give them the link. Prefer this over a subagent whenever the user
  would want to see the work.
- Anything recurring or scheduled → create it as a job; never run a recurring
  loop here.
- **Machines are discouraged, not banned** (D22). A machine whose states only
  poll and report on *other* sessions is the sanctioned exception — "tell me
  whenever any outreach job gets a reply". A machine that does the work itself
  belongs in its own session.
- Point at `start-session` and `schedule-task` by name.

## The parent-lineage layer's content

Names the parent session and its title, and gives the exact call to ask it a
question — `POST .../messages` with `behavior: "follow_up"` (D14: `note` does
not wake the runner and we want an answer), then poll history. Notes that the
user may also be reading this session, so address them normally.

**No jobs list in any layer** (D12 reverted): context cost, and it churns the
cached prefix on every state transition. The skills document how to query jobs
on demand instead.

## What the human can run or see

Launch a default session and a child session; read the rendered layer files in
the per-agent state directory; confirm the child's layer names the right parent.

## Verification gates

`bun run test` (gateway suite), including a test that the default layer renders
only for default sessions and the lineage layer only when a parent exists.
`bun run check-types`, `bun run lint`.

## Must stay green

`your-apps-prompt` rendering and its tests; onboarding's layer selection, which
must not gain either new layer (`agent-context.ts` already excludes the
your-apps layer for onboarding, and the same reasoning applies).

## Fixed by this slice

Two layers, one resolver, no edit to the byte-stable base prompt. Supervision is
the named exception. No jobs list injected.

## Delegated to the implementer

Exact wording, subject to the review checkpoint below.

## Human review checkpoint — non-blocking

The default-session layer's prose decides whether the feature works at all.
Show the rendered text, allow ~5 minutes, then decide on the evidence, record
the decision here, and proceed. Expect to iterate against real sessions later.
