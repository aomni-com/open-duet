# Suggested First Message

An agent can carry a `suggestedFirstMessage` in its `agent.json`. An agent
default chat that has never been written to opens on that text rendered as a
message from the agent; when the user answers, the client sends the same text
with the first message and creation materializes it as the session's first
agent-authored event, quoted to the model in its first envelope. All 23
official agents ship one. Shipped to staging 2026-08-13.

Planned via an explore-unknowns quadrant walk; the decision audit lives in
[choices.md](choices.md) — its needs-user entries (root-page picker greeting,
the 23 message copies) are the open items.

## Why this shape

- **It is a *suggestion*, renamed from "greeting" mid-walk.** The client that
  rendered it carries the text into the create request (`agentFirstMessage`
  on the default-session initial payload). Because the client controls
  materialization, another API consumer that never implements the field loses
  nothing, and history records exactly what was on screen even if
  `agent.json` changed between render and send. The rejected alternative —
  the server reading the drive at create time — added a VM round-trip to the
  create path and could record a greeting the user never saw.
- **The field rides the drive rail, not the database.** `agent.json` is
  parsed by `AgentConfigSchema`/`resolveAgentConfig`
  (`packages/contract/src/agents/index.ts`), which the browser reads straight
  off the drive (`apps/web/spa/drive/agent-config.ts`). No Convex column, no
  API read hop, non-deploy-ordered — the same rail as `trainable`, `tags`,
  and `onboarding`.
- **History gains one general event, `agent_message`** — a message authored
  by the agent outside any turn — rather than a greeting-specific type.
  It lands between `session_created` and the first `prompt_submitted`
  (`createSessionForInitialDelivery`,
  `packages/backend/convex/domains/agentSessions/creation.ts`). It is not
  deliverable input: the runner-input cursor tracks the prompt, and the first
  envelope quotes the row as a bare `<agent_first_message>` element
  (`runnerEnvelope.ts`) because the model needs its own prior words in
  context — the user's first reply is usually an answer to them.
- **Only an agent's own default chat greets.** Jobs, agent→agent delegation,
  and onboarding sessions never do. Every session surface is mounted on ONE
  owner resolved from its host (`resolveSessionOwner`,
  `apps/web/spa/sessions/session-owner.ts`) — the drive root or a launchable,
  unlocked agent — so a locked agent resolves unavailable and root, which has
  no `agent.json` home, structurally never greets. There is no agent picker
  in the composer: the compose bar's agent-select capability was deleted with
  the legacy new-session surface it served (choices.md #1).

## Invariants

- **One normalizer.** `normalizeAgentFirstMessage` (contract, agents module)
  is the only trim/clamp, used by the config read and the Convex write. The
  clamp exists at the *read* so an over-long authored suggestion shortens the
  bubble instead of tripping the wire cap and 400ing the user's first send.
  Bubble shown ≡ text sent ≡ event stored.
- **The redirect drops the field by construction.** A second racing
  `initial_prompt` through the default-owner alias is rewritten to an
  ordinary message via an explicit field-by-field copy (`delivery.ts`); a
  session that already exists can never gain a first message.
- **The greeting is quoted to the runner exactly once**, because the first
  delivery's tail read starts at cursor 0 and the cursor never rewinds.
  Anything that replays deliveries from an earlier cursor re-quotes it.
- **Tolerant read, strict write.** The timeline read union ends in a
  catch-all (`UnknownAgentSessionEventSchema`); readers gate on
  `isKnownTimelineEvent` and render nothing for unknown types, so a bundle
  survives event types minted after it shipped. `appendEvent` still parses
  the strict union. Wire schemas must stay transform-free — the docs render
  them as JSON Schema (`apps/docs`, `verify:endpoints`).
- **No timestamp on the unsent bubble.** The compose-state bubble is a
  suggestion, not an event; it gains a time only when materialized. An
  unprimed visual critique flagged the shape change on send; kept
  deliberately, matching the pending-bubble precedent.
- **Titles, search, and analytics ignore the event.** `session.prompt` and
  `searchText` carry only the user's prompt; `agent_session.message_sent`
  fires only for `prompt_submitted`.
- **Every official agent greets**, ≤300 chars, enforced through the resolver
  by `packages/official-agents-seed/seed.test.ts`; voice rules live in
  `AUTHORING.md` for the human reviewer. The `manage-agents` registry skill
  documents the field for in-product authoring.

## Divergences from the plan

- **Tolerant read was rebuilt once.** The first implementation filtered
  unknown events with a Zod `.transform()`; every schema reachable from a
  public endpoint is rendered to JSON Schema by the docs gate, which
  transforms cannot survive. Reworked as the catch-all union member — which
  also changed semantics: a *malformed known* event now parses opaquely and
  vanishes instead of failing the response (choices.md sound #1).
- **The empty surface changed under the build, twice.** `SessionIntro` (the
  day-one mascot) landed on staging mid-walk; decision D11: the suggestion
  bubble replaces the intro when present, the intro remains for agents
  without one. The onboarding congrats block D4 planned around turned out to
  be racy (its celebration state lost a router-state race, pre-existing) and
  was deleted at close on Example User's call — onboarding completion now shows as
  a confetti burst on its own latch (`confettiFor`) over the agent's
  greeting, with no text block.
- **The pending timeline gained agent identity** (avatar resolved from the
  pending cwd) so the bubble keeps the agent's face through the create
  handoff — a gap the map never named.

## Pointers

Contract: `packages/contract/src/agents/index.ts`
(`suggestedFirstMessage`, `normalizeAgentFirstMessage`,
`AGENT_FIRST_MESSAGE_MAX_LENGTH`), `packages/contract/src/agent/index.ts`
(`agent_message`, `AgentSessionTimelineEventReadSchema`,
`isKnownTimelineEvent`), `packages/contract/src/sessions/index.ts`
(`DefaultSessionMessageRequestSchema.agentFirstMessage`). Backend:
`creation.ts` (`createSessionForInitialDelivery`), `delivery.ts`
(`composeDelivery`),
`runnerEnvelope.ts` (`renderRunnerInput`). Web:
`apps/web/spa/routes/sessions.tsx` (`SessionEmptyChat`,
`useSessionCreation`), `apps/web/spa/sessions/projection/index.ts`
(`agentFirstMessageProjection`, `applyEvent`). Pinning tests:
`packages/backend/src/agent-sessions.test.ts` ("materializes the agent first
message"), `packages/contract/src/{agents,sessions}/index.test.ts`,
`apps/web/spa/sessions/projection/index.test.ts`, the seed gate, and the
`spa-shell` visual baselines (`sessions-agent-preselected`,
`sessions-agent-attribution`).

## Left open at close

Staging's hub serves the pre-greeting `agent.json` files until an admin
hub-sync (or per-agent `bun run try`); no dedicated staging e2e journey; prod
untouched. Plus the needs-user entries in [choices.md](choices.md).
