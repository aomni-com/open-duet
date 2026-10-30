## 1. Slice Graph

Deviation from map order: I move auth before workspace provisioning, and I move edge WS tunnel before sharing. The map’s nominal order puts control plane first and sharing later; with the delta’s “every gateway route authenticated” and “no raw TCP, sync tunnels over WebSocket” constraints, those are prerequisite contracts, not later features.

### 0. Test Harness + Platform Spikes

Contract unlocked: every later slice has a runnable, behavior-pinning test environment before product work lands.

API seam: `packages/test-harness` owns `DockerCliEnv`, `ConvexDevEnv`, `ExeVmProbe`, `McpClientHarness`; `packages/exe-sandbox` remains the exe.dev control-plane client.

Runnable artifact: `bun run test:harness`, `bun run exe:spike:sync`, `bun run exe:spike:image`, `bun run exe:spike:cp`.

Verification: docker fresh-machine CLI install; real exe VM gateway hello-world; Convex dev deployment smoke; MCP client list/call; cp snapshot crash-consistency probe.

Dependencies: none.

Portable sources:

- [packages/exe-sandbox/src/exe.ts](/Users/synthetic-user/dev/duet/packages/exe-sandbox/src/exe.ts)
- [packages/exe-sandbox/scripts/benchmark-lifecycle.ts](/Users/synthetic-user/dev/duet/packages/exe-sandbox/scripts/benchmark-lifecycle.ts)
- [packages/agent-gateway/src/scheduler-guard.docker.test.ts](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/scheduler-guard.docker.test.ts)

Scope firewall: no product schema, no UI, no CLI UX beyond harness commands.

### 1. Convex Auth, Sessions, API Keys, Device Pairing

Contract unlocked: human and agent callers can authenticate without WorkOS.

API seam: `packages/backend/convex/domains/auth`, `domains/apiKeys`, `domains/deviceCodes`; `ApiPrincipal = user | apiKey | vm | edge`; scoped key grammar `duet_sk_...`, scopes like `ws:{workspaceSlug}:files:write`.

Runnable artifact: `duetfs login --device` prints code; web confirms; CLI receives scoped key.

Verification: Convex tests for expired/used device codes, scope denial, key rotation, viewer/editor/owner enforcement.

Dependencies: 0.

Portable sources:

- v1 auth idea only, not token shape: [domains/publicApi/auth.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/publicApi/auth.ts)
- v1 CLI code pattern only: [schema.ts cliLoginCodes](/Users/synthetic-user/dev/chat-app/packages/backend/convex/schema.ts)

Scope firewall: no WorkOS compatibility; no workspace provisioning; no billing.

### 2. Core Domain Model: Workspaces, Anchors, Audit

Contract unlocked: backend owns stable workspace, anchor, sharing, app, publish, and audit identities.

API seam: `packages/backend/convex/schema.ts` with tables:
`workspaces`, `workspaceMembers`, `workspaceVms`, `anchors`, `auditEvents`, `apiKeys`.
`Anchor = {workspaceId, path, kind: "app"|"publish"|"share-root", status: "active"|"broken", settings}`.

Runnable artifact: `bunx convex run devSeed:createWorkspace` then `curl /v1/workspaces`.

Verification: rename preserves anchor id; ambiguous move marks `broken`; every publish/share/app mutation writes one audit event.

Dependencies: 1.

Portable sources:

- schema style and usage validators: [schema.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/schema.ts)
- audit is new, inferred from delta.

Scope firewall: no VM creation yet; no Syncthing; no app processes.

### 3. Exe Provisioning, Image, Gateway Phone-Home

Contract unlocked: `POST /v1/workspaces` creates an always-on exe VM and marks it active only after gateway phone-home.

API seam: `packages/exe-control` wraps `ExeClient`; `packages/vm-image` owns Dockerfile/systemd; backend owns `ProvisioningToken`, `VmHeartbeat`.

Runnable artifact: `duetfs workspace create acme` returns workspace slug; `duetfs workspace status` shows `active`, gateway version, heartbeat age.

Verification: real exe create-to-heartbeat probe; stale heartbeat marks unhealthy; restart does not assume wake-on-request; no SSH except break-glass.

Dependencies: 0, 2.

Portable sources:

- [packages/exe-sandbox/src/exe.ts](/Users/synthetic-user/dev/duet/packages/exe-sandbox/src/exe.ts)
- e2b abstraction to replace, not port: [packages/services/src/e2b-sandbox/client.ts](/Users/synthetic-user/dev/chat-app/packages/services/src/e2b-sandbox/client.ts)
- v1 setup lock ideas: [domains/sandboxes/actions.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/sandboxes/actions.ts)

Scope firewall: no files API; no app proxy; no sharing.

### 4. Authenticated Gateway + Files API + Range Downloads

Contract unlocked: API can read/write/list/delete workspace disk through authenticated gateway; downloads support Range/206.

API seam: `packages/agent-gateway` owns `/v1/files/*`, `/internal/health`, `/internal/config`; `packages/workspace-client` owns `WorkspaceFileClient`; `FileStat = {path,type,size,mtime,etag}`.

Runnable artifact: `curl -H "Authorization: Bearer [REDACTED]" /v1/ws/acme/files/docs/readme.md`.

Verification: route auth required for every gateway route; path traversal rejected; `.duet/` and memory DB outside drive root; Range returns 206; behavior tests at API boundary, not internals.

Dependencies: 1, 3.

Portable sources:

- gateway Hono shell, but fix auth hole: [agent-gateway/src/app.ts](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/app.ts)
- file upload/download warnings: [routes/files.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/routes/files.ts)
- sandbox URL upload behavior: [sandbox-files.ts](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/sandbox-files.ts)

Scope firewall: no CLI sync; no sharing; no publish.

### 5. `duetfs` CLI Core

Contract unlocked: agent/human can operate files and workspaces from a fresh machine.

API seam: `packages/cli` exports `duetfs`; `packages/api-types` owns generated OpenAPI client; address grammar `workspace:/path`.

Runnable artifact:
`duetfs login`, `duetfs ls acme:/`, `duetfs push ./docs acme:/docs`, `duetfs pull acme:/docs ./docs`.

Verification: docker install from packed tarball; auth/device flow; binary exits and stdout stable for agent use; no reliance on host config.

Dependencies: 1, 4.

Scope firewall: no sync daemon; no app registration beyond later command stubs.

### 6. Memory + Train API Front Door

Contract unlocked: API exposes VM-local `@duetso/agent` memory/train without Convex personal memory.

API seam: backend routes `/v1/ws/{ws}/memory/*`, `/v1/ws/{ws}/train`; gateway `MemoryService` runs `duet memory`/`duet train`; backend persists `trainJobs` status only, not memory contents.

Runnable artifact:
`duetfs memory add acme "..."`; `POST /train` returns `{jobId}`; `duetfs train status <jobId>` shows synthesized record.

Verification: noninteractive JSON contract; corpus path sanitization; byte caps; unique staging dirs; redacted stdout/stderr; job survives HTTP disconnect.

Dependencies: 4, 5.

Portable sources:

- [convex/domains/train/actions.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/train/actions.ts)
- agent declarations: [protocol.d.ts](/Users/synthetic-user/dev/chat-app/node_modules/@duetso/agent/dist/src/types/protocol.d.ts), [memory.d.ts](/Users/synthetic-user/dev/chat-app/node_modules/@duetso/agent/dist/src/cli/memory.d.ts), [train.d.ts](/Users/synthetic-user/dev/chat-app/node_modules/@duetso/agent/dist/src/cli/train.d.ts)

Scope firewall: no session runner; no sharing of SQLite; no web memory editor.

### 7. Hosted MCP

Contract unlocked: agents can use Duet from MCP over hosted HTTP.

API seam: `apps/mcp` exposes tools: `list/read/write files`, `memory add/search`, `share_folder`, `expose_app`, `publish_file`, `run_agent`, `use_integration`, `generate_media`.

Runnable artifact: MCP harness connects to `mcp.localhost` and writes a file into an exe-backed workspace.

Verification: real MCP client harness; each tool enforces same API scopes as REST; tool errors are structured and agent-readable.

Dependencies: 1, 4, 5, 6.

Portable sources:

- v1 Composio MCP shape: [services/composio.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/services/composio.ts)
- agent MCP config type: [protocol.d.ts](/Users/synthetic-user/dev/chat-app/node_modules/@duetso/agent/dist/src/types/protocol.d.ts)

Scope firewall: no tool-specific business logic bypassing REST/domain services.

### 8. Edge Proxy + WebSocket Tunnel Substrate

Contract unlocked: one public HTTPS origin per VM plus authenticated WS tunnels for VM-to-VM sync traffic.

API seam: `apps/edge-proxy` owns host parsing, request-time access checks, Upgrade handling; `packages/sync-tunnel` owns `TunnelToken`, `TunnelOpenRequest`, `TcpOverWebSocketFrame`.

Runnable artifact: two test VMs exchange bytes over `wss://edge/tunnel/{workspaceVmId}` with `X-Exedev-Authorization`.

Verification: no raw TCP; invalid VM token denied; reconnect/backpressure test; Vercel WS duration/idle probe; proxy routes preserve streaming body.

Dependencies: 1, 3.

Portable sources:

- v1 edge proxy parsing/retry/favicon/noindex: [apps/sandbox-gateway/app/[[...path]]/route.ts](/Users/synthetic-user/dev/chat-app/apps/sandbox-gateway/app/[[...path]]/route.ts)

Scope firewall: no Syncthing config yet; no public apps authorization beyond resolve stubs.

### 9. Folder Sharing + Syncthing Orchestration

Contract unlocked: folder shares sync between origin and recipient VMs through the WS tunnel, with cascading re-share and revoke.

API seam: `domains/shares`, `packages/sync-control`; `Share = {originWorkspaceId, anchorId, mode:"read"|"write", mountPath, ignorePatterns:[".env*"], parentShareId?}`.

Runnable artifact: workspace A shares `/client` to B; B edits under write share; A sees it; revoke removes access and tunnel credentials.

Verification: read-only enforced by FS permissions; no nested mount inside synced subtree; re-share grants at most sharer mode; revoke cascades; `.env*` not synced; `.git/` and `node_modules/` allowed.

Dependencies: 2, 8.

Scope firewall: no smart markdown merge; no conflict-file special cases; no app publication changes.

### 10. Agent Sessions API

Contract unlocked: full turn protocol through API: create session, prompt, answer, interrupt, SSE/reconnect, sleep/wake.

API seam: `domains/agentSessions`, gateway `SessionController`; data shapes mirror `TurnState`, terminal states `complete|ask|interrupted|sleep|failed`; SSE is a view over persisted events.

Runnable artifact:
`duetfs agent run acme:/ "summarize repo" --json-events`; web session page streams and reconnects.

Verification: one runner per turn; duplicate prompt id idempotency; interrupt live runner; sleep schedules wake; SSE reconnect reads Convex state; per-session mutation queues.

Dependencies: 4, 6.

Portable sources:

- [session-controller.ts](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/session-controller.ts)
- [runner-manager.ts](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/runner-manager.ts)
- [session-registry.ts](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/session-registry.ts)
- [runner-cpu-cap.ts](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/runner-cpu-cap.ts)
- [orphan-runner-sweep.ts](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/orphan-runner-sweep.ts)

Scope firewall: no chat/channel schema port; no WorkOS; no app hosting.

### 11. Apps Runtime Model

Contract unlocked: app is backend entity anchored to a folder; origin VM runs canonical instance; access mirrors folder access.

API seam: `domains/apps`, gateway `AppSupervisor`; `App = {workspaceId, anchorId, slug, command, port, visibility:"private"|"public", createdByShareId?}`.

Runnable artifact:
`duetfs apps register acme:/demo -- bun run dev --port 5173`; URL `{slug}--{workspace}.service.example.invalid` serves from origin VM.

Verification: read-only sharee cannot register; write-share app is created on origin and origin pays; app access re-evaluated per request; redeploy writes audit event.

Dependencies: 2, 8, 9.

Portable sources:

- process supervisor/retry only: [public-app-service.ts](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/public-app-service.ts)
- config validation to replace, not authority: [public-config.ts](/Users/synthetic-user/dev/chat-app/packages/agent-gateway/src/public-config.ts)

Scope firewall: no `public.config.json`; no recipient app copies; no per-app spend caps.

### 12. Publishing, Slugs, Custom Domains

Contract unlocked: live published files/folders and apps have stable public URLs.

API seam: `domains/publishing`, `domains/customDomains`; separate app and publish slug namespaces with shared reserved-word list. `Publish = {workspaceId, anchorId, slug, visibility:"public"}`.

Runnable artifact:
`duetfs publish acme:/docs --slug handbook`; `service.example.invalid/acme/handbook` serves live content; app custom domain verifies.

Verification: `.env*` never served; published folder forward-inclusive audit event on new file; slug edit leaves no redirect; workspace rename breaks URLs with loud warning.

Dependencies: 8, 11.

Portable sources:

- [customDomains/actions.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/customDomains/actions.ts)
- [routes/sandbox.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/routes/sandbox.ts)
- [apps/sandbox-gateway route.ts](/Users/synthetic-user/dev/chat-app/apps/sandbox-gateway/app/[[...path]]/route.ts)

Scope firewall: no static deploy pipeline; no redirects; no hidden deploy gate.

### 13. Onboarding, Session Import, Landing Page

Contract unlocked: agent-led setup reaches the done-demo: install, pair, bootstrap company memory, produce on-brand output.

API seam: `apps/web`, `domains/onboarding`, `packages/importers`; import records `source:"import"` and are bulk-reviewable/deletable.

Runnable artifact: fresh Claude/Codex user follows website instructions; agent installs `duetfs`, pairs, imports selected sessions, trains company URL.

Verification: secret scrub before memory write; opt-in per source; prompt-injection-resistant human approval for pairing; Playwright onboarding flow.

Dependencies: 1, 5, 6, 10.

Portable sources:

- onboarding scrape ideas: [domains/onboarding/actions.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/onboarding/actions.ts)
- train staging from slice 6.

Scope firewall: no launch until billing slice green; no importing secrets; no silent OAuth by agent.

### 14. Integrations, Model Gateway, Billing, Launch Gate

Contract unlocked: full paid product can launch with Composio, AI/media gateway, Stripe prepaid credits, usage attribution, reports.

API seam: `domains/integrations`, `domains/modelGateway`, `domains/credits`, `domains/billing`; rescope v1 org fields to `workspaceId`; ledger in micro-USD; per-user API key and app visitor attribution.

Runnable artifact: app visitor triggers model generation; ledger debits workspace; daily/monthly usage page shows workspace/user/app attribution; Stripe auto-topup works.

Verification: preflight blocks below floor/monthly cap; auto-topup idempotency; reservation hold/settle/release for media; daily rollup avoids Convex read-limit scans; Stripe webhook idempotency.

Dependencies: 1, 10, 11, 12.

Portable sources:

- [credits/internal.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/credits/internal.ts)
- [credits/actions.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/credits/actions.ts)
- [credits/queries.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/domains/credits/queries.ts)
- [services/aiGateway.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/services/aiGateway.ts)
- [services/composio.ts](/Users/synthetic-user/dev/chat-app/packages/backend/convex/services/composio.ts)
- [schema.ts creditTransactions/creditDailyUsage/monthlyUsage](/Users/synthetic-user/dev/chat-app/packages/backend/convex/schema.ts)

Scope firewall: no free tier until abuse/caps/retire policy is live; no per-app spend caps.

## 2. Monorepo Layout

`apps/web`: Next app for landing, auth, onboarding, workspace browser, billing, session viewer.

`apps/api`: Hono/Vercel REST API at `service.example.invalid/v1`; owns OpenAPI surface and auth middleware.

`apps/edge-proxy`: Vercel/fluid-compute proxy for app/publish/custom-domain traffic and WS tunnels.

`apps/mcp`: hosted streamable-HTTP MCP server.

`packages/backend`: Convex schema, domains, crons, HTTP actions.

`packages/api-types`: shared OpenAPI/zod validators and generated typed clients.

`packages/auth`: shared principal/scope parsing, key hashing, request auth helpers.

`packages/exe-sandbox`: existing exe.dev benchmark/client package, promoted to test/probe support.

`packages/exe-control`: production exe.dev control-plane wrapper around `ExeClient`.

`packages/agent-gateway`: Hono gateway baked into VM image; files, memory/train, sessions, app supervisor, Syncthing control.

`packages/vm-image`: Dockerfile, systemd units, install scripts, gateway phone-home.

`packages/workspace-client`: server-side client for talking to workspace gateway through edge.

`packages/sync-tunnel`: TCP-over-WebSocket framing, token validation, reconnect/backpressure.

`packages/cli`: `duetfs` binary.

`packages/test-harness`: docker CLI envs, Convex dev harness, exe VM probes, MCP harness.

`packages/ui`: shared web UI components after `apps/scaffold` is replaced.

Inference: keep `apps/scaffold` only until `apps/web` exists, then delete it rather than carrying starter code.

## 3. `@duetso/agent` Change List

Required contracts for API front door:

- Add `duet --version --json` returning `{agentVersion, rpcProtocolVersion, memorySchemaVersion, trainSchemaVersion}`; gateway refuses unsupported versions before spawning work.
- Make `duet memory add --json --db <path> [--priority] [--tag]` return `{id, kind:"note", priority, tags, createdAt}` and never open TUI.
- Add `duet memory search --json --db <path> --query <q> --limit <n>` returning `Observation[]` with `{id, kind, source, content, tags, score}`.
- Keep `duet memory --json` filters from current declarations: `kind/type`, `priority`, `source`, `from`, `to`, `--wait`.
- Add train JSON modes: `duet train <folder> --slug <slug> --model <model> --db <path> --json --events`, emitting progress lines and final `TrainRecord`.
- Keep train CRUD JSON: `duet train list|show|update|delete --json`, using `TrainListEntry`, `TrainRecord`, `TrainManifest`.
- Guarantee all memory/train commands honor DB open wait budget and structured JSON errors.
- Keep memory DB default outside drive/share root: `~/.duet/memory.db`; gateway may pass an explicit VM path.
- Keep RPC command/event shapes from current `TurnRunnerCommand` / `TurnEvent`; add protocol versioning, not a second runner protocol.
- Require gateway-provided envs for model calls: `DUET_API_KEY`, `AI_GATEWAY_BASE_URL`, `DUET_APP_BASE_URL`.

Current package references:

- [@duetso/agent package.json](/Users/synthetic-user/dev/chat-app/node_modules/@duetso/agent/package.json)
- [protocol.d.ts](/Users/synthetic-user/dev/chat-app/node_modules/@duetso/agent/dist/src/types/protocol.d.ts)
- [memory.d.ts](/Users/synthetic-user/dev/chat-app/node_modules/@duetso/agent/dist/src/cli/memory.d.ts)
- [memory-add.d.ts](/Users/synthetic-user/dev/chat-app/node_modules/@duetso/agent/dist/src/cli/memory-add.d.ts)
- [train.d.ts](/Users/synthetic-user/dev/chat-app/node_modules/@duetso/agent/dist/src/cli/train.d.ts)
- [train/types.d.ts](/Users/synthetic-user/dev/chat-app/node_modules/@duetso/agent/dist/src/train/types.d.ts)

## 4. Risks And Scope Firewalls

Global risks:

- Gateway auth regression: every route, including health/config/session/app control routes, must authenticate except a deliberately public liveness route with no sensitive fields.
- Hot SQLite sync: memory DB and `.duet/` state must never live under shareable drive roots.
- Vercel WS beta limits: tunnel code must be portable; tests must record idle/duration behavior.
- Always-on VM drift: gateway self-update, version reporting, and schema migrations are launch requirements.
- Write-share app deployment: write shares are code-deploy rights onto origin VM; audit is the control.
- Public URL abuse: launch gate includes workspace caps, cgroups, metering, and takedown/admin tools.
- Convex OCC hotspots: preserve jittered rollup writes from v1 billing.

Slice firewalls:

- 0 must not build product features.
- 1 must not add WorkOS compatibility.
- 2 must not guess anchor moves; ambiguous means `broken`.
- 3 must not depend on laptop SSH for production.
- 4 must not expose capability URLs.
- 5 must not hide browser-only flows from agents.
- 6 must not copy memory into Convex.
- 8 must not rely on raw TCP.
- 9 must not special-case `.sync-conflict-*`.
- 11 must not reintroduce manifest authority.
- 12 must not add redirects for slug edits.
- 14 must not add per-app spend caps.

## 5. Human Review Checkpoints

After slice 0: review spike reports for VM image, WS tunnel feasibility, and `cp` snapshot semantics.

After slice 1: approve auth/device-code UX and API scope grammar.

After slice 2: review schema diagram for workspace, anchor, share, app, publish, audit ownership.

After slice 4: run files API manually against an exe VM and inspect Range/download behavior.

After slice 8: review WS tunnel telemetry before Syncthing work starts.

After slice 9: inspect share/re-share/revoke demo, especially write-share deployment implications.

After slice 11: register an app from origin and from a write-share recipient; confirm origin-only runtime is visible and unsurprising.

After slice 12: publish a folder, add a file, rename workspace, and confirm warnings/audit events match product intent.

After slice 13: run the 60-second done-demo from a fresh environment.

After slice 14: review billing ledger, Stripe topup, daily/monthly reports, and abuse controls before launch.
