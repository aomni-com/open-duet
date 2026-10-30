# Model Gateway — service.example.invalid (closed 2026-07-10)

A Vercel-AI-Gateway-compatible passthrough proxy (`apps/model-gateway`) so
`@duetso/agent` and every other Duet surface make model calls that are
authenticated (`duet_sk_`), credit-preflighted (402), and billed to the
workspace ledger. Ported from chat-app's production proxy, org→workspace.
Companion track shipped in the same spec: VM software updates (version pins,
self-update, archive/reprovision), because the fleet previously had no path to
new in-VM code that preserved agent memory.

This closed the decision the agent-drive record left pending
(`specs/done/agent-drive/README.md`): VM model calls route through the model
gateway — never a raw provider key.

## Why this shape

- **Passthrough proxy, not a bespoke API**: the agent already speaks the
  Vercel AI Gateway wire protocol, so the gateway forwards it verbatim and
  interposes only auth + billing. The frozen wire contract lives in
  [`research/gateway-wire-contract.md`](research/gateway-wire-contract.md) —
  authoritative for the protocol, with shipped deviations noted at its top.
  Two paths are refused: `/v1/credits` (`BLOCKED_UPSTREAM_PATHS` in
  `packages/contract/src/gateway`) and `/v1/generation`
  (`LOCALLY_BLOCKED_UPSTREAM_PATHS` in `apps/model-gateway/src/index.ts` —
  the gateway itself polls generations server-side for reconcile). Catalog
  GETs never mint generations.
- **Billing copies chat-app exactly** because that pipeline is
  production-proven: preflight → proxy → generation id → reconcile with
  backoff [15,30,60,120]s → settle, scheduled via `@vercel/functions`
  `waitUntil`, never fire-and-forget. Lifecycle gained a `reconciling` state.
- **One Convex round-trip pre-upstream** (`gatewayPreflight`) keeps added
  latency to a single query.
- **Hidden system-minted VM key** (`ws:{slug}:ai`), delivered only through
  register/heartbeat responses — no create-time env, no dedicated fetch
  endpoint (adjudicated against a dedicated GET). Keys are hashed at rest in
  Convex, so the server can hand out plaintext only at mint (the VM persists
  its own copy in `model-credentials.json`); heartbeats rotate a key only
  when the VM sets `needsModelCredentials: true` and no live key can be
  re-delivered — a valid cached credential file survives gateway restarts
  without key churn.
- **Delivery is config-gated**: apps/api delivers model credentials only when
  `DUET_MODEL_GATEWAY_URL` is set; without it, register/heartbeat behavior is
  unchanged rather than minting plaintext it cannot point at a gateway.
- **Update track**: heartbeat-delivered version pins; the gateway release is a
  single-file bundle served by apps/api (rejected: npm installs and Convex
  blobs — npm needs registry auth on VMs, blobs bloat Convex); symlink swap
  with `ExecStartPre` self-revert for rollback safety; state-dir archive fixes
  the one organic reprovision path that lost agent memory, with an explicit
  `reprovisionWorkspace` lever.

## Invariants

- **Money moves only through the `domains/credits` primitives**
  (`internal.ts`, `ledger.ts`, `reservations.ts`) — no ledger writes exist
  outside the credits domain; external entry points are internal-key-only.
  Billing tests assert the ledger reconciles: sum of `creditTransactions`
  matches the balance.
- **One API key ↔ one workspace**, enforced at every issuance path
  (`packages/contract/src/api-keys` owns key shapes + credential extraction,
  consumed by both apps/api and apps/model-gateway).
- **One model-call HTTP surface**: `apps/model-gateway`. The bespoke
  `apps/api` `/ai/*` routes and `AiGatewayUpstream` seam were deleted when
  duetfs/MCP migrated to the AI SDK; a reader today cannot tell they existed.
- **Generation lifecycle + reconcile** is owned by `domains/modelGateway`
  (upstream fetcher: `services/aiGateway.ts`). Reconcile reads
  `AI_GATEWAY_BASE_URL` from env because it runs inside the Convex process.
- **VM-delivered env vars carry hop-by-hop tests** (see
  `packages/gateway/src/gateway.test.ts` and the vmAttach spawn-env list) —
  a discipline, not an enforced mechanism, adopted after this repo shipped a
  silent drop (`DUET_GATEWAY_EXTRA_HEADERS_JSON`). Extend it when adding a
  delivered variable.
- **Hermetic tests use the fake VAG** (`packages/test-harness/src/fake-vag.ts`,
  `serveFakeVag` for cross-process reach) — never a real provider in CI.
- `servicingStatus` gates at workspace level; per-workspace fixed-window rate
  limit.
- **~~No model allowlist; media classification is AI-SDK-header-based~~
  (reversed 2026-07-16 by `specs/models-and-skills`).** This gateway
  originally forwarded any model the caller named and classified modality from
  incidental request headers — correct when the model set was not product
  policy. The models-and-skills work made the *approved-model catalog*
  (`packages/contract/src/approved-models`) the single authority: every
  generation is now allowlist- and payment-checked at preflight before any
  spend, and modality is read from the catalog entry's `kind`, not headers.
  Two forces drove the reversal: (1) the catalog became product policy
  (role→slug, `paidOnly`/`isFree`/`providerLock`), so "forward anything" would
  let a caller bill a paid model as free; (2) the header-based path was a live
  bypass — the Vercel gateway routes by the `ai-model-id` header over the body,
  so enforcement and execution could disagree. The fix parses the body as the
  source of truth (`apps/model-gateway/src/request-inspection.ts`), pins the
  model header to the inspected slug, and injects `providerLock`. Role ids stay
  control-plane-only; the VM and this gateway see slugs only. The roster lives
  in the catalog module — not duplicated here.

## Acceptance evidence (live, deployed staging, 2026-07-10)

Probe: `packages/test-harness` `live:staging`
(`cd packages/test-harness && bunx dotenvx run -f ../../.env.staging -- bun run live:staging`)
against service.example.invalid + Convex `chatty-llama-452` +
service.example.invalid + a real exe.dev VM (image `sha256:a7c404d6…`,
agent 0.2.0). Real train + real `duet --rpc` turn; model calls carried
heartbeat-delivered `ws:{slug}:ai` credentials through the deployed gateway to
the real Vercel AI Gateway; the ledger settled a reconciled usage debit of
−44,654 µUSD against upstream generation `gen_01KX5XYG0TNM6YC9H31W69ZGTZ`;
15 `gatewayGenerations` rows all reached `settled`/`reconciling`; teardown was
clean. Production (service.example.invalid) is deliberately a separate ops step
(deploy `main`, `secrets:push:prod`), not a spec item.

## Dead ends & divergences

- **The planned live gate was structurally impossible as specced**: pointing
  the hermetic demo probe (local Convex) at a deployed gateway can never
  bill, because the gateway preflights against _its own_ Convex where the
  probe's workspace does not exist. The staging live probe replaced it,
  running wholly against the deployed stack via `POST /v1/admin/login-as`
  (programmatic impersonation key) plus internal-key testing fixtures in
  `packages/backend/convex/testing/` (paid-by-email, delete-workspace-by-id,
  bounded by-id reads). Workspace identity is id-keyed throughout — slug
  collides across runs because login-as derives it from the display name.
- **Reconcile-in-Convex vs fetch-injected fakes**: slice-02's reconcile
  hardcoded the upstream URL and the fake VAG was fetch-injected only, but
  reconcile runs inside the Convex process, which reaches a fake only over
  real HTTP. Fix: `reconcileGeneration` honors `AI_GATEWAY_BASE_URL`;
  the fixture gained `serveFakeVag()` (Bun.serve).
- **duetfs/MCP keep a `/v1/whoami` scope pre-check** before direct gateway
  calls: the gateway bills the _key's_ workspace, while duetfs/MCP carry a
  configured target workspace — the pre-check surfaces key↔workspace
  mismatches the gateway cannot see and preserves the CLI's
  `insufficient_scope` exit-code contract.
- **Defect found by the closing smoke — two layers, both fixed 2026-07-11,
  probe fully green after**: the agent's in-VM memory recall missed the
  seeded fact. Not an endpoint issue — `POST /v1/embeddings` with the VM's
  heartbeat-delivered credentials returns 200 (3072-dim vectors) from the VM.
  Layer 1 (duet-agent, fixed in 0.2.1): train/memory-add inserted
  observations without embeddings (vectors only came from the runner's async
  backfill), and `vectorSearchSucceeded = hits > 0` mislabeled an empty index
  as "semantic search unavailable"; keyword AND-semantics over verbose model
  queries hid the gap. Layer 2 (this repo, the load-bearing one): the VM
  gateway defaulted its memory DB to `stateDir/memory.sqlite` and passed it
  as `--db` to train/memory CLI spawns, while the RPC agent spawn got no
  `--db` and used the CLI default `~/.duet/memory.db` — trained memories
  lived in a file the agent never read (live evidence: API search hit=1,
  agent DB obs=0). Fix: one `memoryDbPath` (`memory.db`) flows from
  `runtime/env.ts` to train routes, memory routes, AND the RPC runner argv
  (`--db`); the shared-path invariant is pinned in `gateway.test.ts`.

## Pointers

- Proxy: `apps/model-gateway/src/index.ts` (+ `extract-generation-id.ts`)
- Lifecycle/billing: `packages/backend/convex/domains/modelGateway/`,
  `domains/credits/internal.ts`
- Key shapes: `packages/contract/src/api-keys`; wire constants:
  `packages/contract/src/gateway`
- VM credentials + updates: `packages/gateway` (heartbeat consumer),
  `apps/api` register/heartbeat routes, `packages/backend` `versionPins`
- Tests that pin behavior: `apps/model-gateway/src/index.test.ts`,
  `packages/test-harness/src/{fake-vag,demo-60s,staging-e2e-synthetic}.ts`,
  gateway release serving tests in `apps/api`
