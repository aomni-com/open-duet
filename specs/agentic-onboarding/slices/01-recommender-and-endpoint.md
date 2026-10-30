# 01 — Recommender core, Convex action, REST endpoint

Retires the two scariest unknowns first: the server-side LLM seam and its
latency. No UI in this slice.

## Contract unlocked

Given a purpose paragraph, the platform returns exactly 4 validated official
agent recommendations with personalized reasons — or an empty list. Never an
error the client must interpret, never a partial list, never a blocked
onboarding.

## API seam

**`packages/contract/src/onboarding/` (new module):**

```ts
WorkspacePurposeSchema = z.string().trim().min(1).max(1000)   // lives beside WorkspaceDuetNameSchema in src/workspaces, re-exported here
OnboardingRecommendationsRequestSchema = z.object({
  purpose: WorkspacePurposeSchema,
  tagHints: z.array(AgentTagSchema).max(3).optional(),
})
OnboardingRecommendationSchema = z.object({
  agentName: MarketplaceAgentNameSchema,
  reason: z.string().trim().min(1).max(200),
})
OnboardingRecommendationsResponseSchema = z.object({
  recommendations: z.array(OnboardingRecommendationSchema).length(4)
    .or(z.array(OnboardingRecommendationSchema).length(0)),
})
```

(Express the "4 or 0" rule however zod reads cleanest; the invariant is the
contract, the encoding is delegated.) Register the endpoint wherever the
contract registers endpoints today.

**`packages/backend/convex/domains/onboarding/recommendationsCore.ts`** —
pure, mirroring `campaigns/fitClassifier.ts`:

- `buildRecommendationPrompt(purpose, tagHints, catalog) → {system, prompt}`
- output zod schema for `Output.object` (accept 1–6 items from the model;
  sanitization enforces the wire rule)
- `sanitizeRecommendations(raw, catalog)` — drop names not in the verified
  catalog, dedupe, trim/clamp reasons, cap at 4; **< 4 survivors ⇒ empty**
- `recommendAgents({purpose, tagHints, catalog, generate}) → {recommendations}`
  — any throw/timeout inside ⇒ `{recommendations: []}`

**`packages/backend/convex/domains/onboarding/recommend.ts`** — public
`action` (`'use node'`) guarded by `requireApiInternalKey`: loads the
verified catalog via the existing `domains/marketplace/listings:catalog`
handler (same projection the UI sees — no second catalog shape), calls the
core with the real `generateText` + `Output.object` + `gateway(MODEL)`,
`temperature: 0`, `AbortSignal.timeout(10_000)`. `MODEL = 'openai/gpt-5.4-mini'`,
a constant beside the prompt.

**`apps/api/src/routes/onboarding.ts`** (new file — the marketplace route
file already does too much): `POST /v1/ws/:workspaceSlug/onboarding/recommendations`.
Guards: `requireAuthedWorkspace`, `role === 'owner'`,
`onboardedAt === undefined` (409 otherwise). Body = request schema (400 on
invalid). Proxies to the action via `runtime.convex.action(fnAction(...))`.
Always 200 with the response schema once guards pass. This slice touching
apps/api is also what rides the deploy rail — a packages/backend-only change
does not deploy to staging by itself.

## Prompt sketch (refine freely; keep the invariants)

System: you assemble a starting team of AI agents for a new workspace owner.
Catalog given as one line per agent: `agentName | title | tags | summary`.
Pick exactly 4 distinct agents from the catalog that will help this person
most. One reason each, ≤140 chars, second person, echoing the user's own
words where natural; never invent an agent or a capability beyond its
summary; reply in the language of the purpose. User: the purpose paragraph,
then `Emphasis: <tagHints>` when present.

## Playable deliverable

A probe script (scratchpad or uncommitted dev script — not product) that
runs six sample purposes (one per goal, composed by hand from the slice-03
copy) against the real gateway and prints the four picks, reasons, and
per-call latency.

## Verification

- `write-tests` red first. Core tests with a fake `generate`: happy path;
  fabricated names dropped; duplicates deduped; <4 survivors ⇒ empty;
  timeout ⇒ empty; empty catalog ⇒ empty; reason clamping.
- Route tests with a stubbed Convex runtime: 200 shape, 400, 403 non-owner,
  409 already-onboarded.
- Narrowest runners only (backend package, api package).

## Human review checkpoint (non-blocking)

Post the probe output — the reasons for one sample purpose and the latency
table — for the user. Wait ~5 min; if silent, judge on the evidence
(reasons personalized and non-generic, p95 comfortably under the 10s
timeout), record the verdict here, and proceed. If p95 exceeds ~6s, swap the
model constant here, not later.

## Delegated to the implementer

Exact zod encoding of "4 or 0"; prompt wording; probe script location;
whether `WorkspacePurposeSchema` physically lives in `src/workspaces` or
`src/onboarding` (follow whichever reads as one owner with the workspace
schemas).

## Stays green

Everything — this slice adds a route and a domain module nobody calls yet.
