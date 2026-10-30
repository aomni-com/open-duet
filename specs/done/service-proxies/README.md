# Service proxies + coupled default skills — shipped record

**Status: shipped to staging and live-verified 2026-07-16.** Every vendor a
chat-app default skill calls is reachable from duet VMs and deployed apps
through duet-owned endpoints that inject the upstream key server-side and meter
credits; agents reach Composio through an MCP passthrough; the four previously
blocked skills (`firecrawl`, `go-to-market`, `branded-content`,
`composio-credentials`) ship on the existing skills rail. The done-condition
was discharged **live**: every proxy surface and every skill's documented
workflow ran on a staging VM against real vendors with real credits.

**Open item (user-gated): prod promotion.** The deploy source still carries the
encrypted vendor values, while catalog credentials are seeded into the Convex
service vault for the target deployment. Promote only after the production
vault rows are present and the service probes pass; then deploy the API.

The pre-build decision record is [`MAP.md`](MAP.md) — the quadrant map holds
every landmine (L1–L15) and API-audit finding with its evidence. This README
is the durable subset: why it works this way, what must stay true, and where
the code is.

## The reason it works this way

Vendor keys must never reach a VM or a browser. Everything else follows:

- **Skills address the proxy via `$DUET_API_URL/v1/…`** (env var seeded into
  the runner's spawn env), not a rendered `{{APP_URL}}` placeholder. The proxy
  lives on the api host, not the web app — and the web app's duet-proxy strips
  caller credentials, so a web-origin URL could never carry `DUET_API_KEY`.
  *Rejected*: redefining `{{APP_URL}}` to the api origin.
- **Agent MCP access is a passthrough proxy** at the Duet-session resource
  (`/v1/ws/:workspaceSlug/agent/sessions/:sessionId/integrations/mcp`), because
  the Tool Router session's auth header must stay server-side. Agents
  authenticate with their workspace key; apps/api rehydrates the provider
  Session already owned by that Duet session and injects its current transport
  header. Session creation and permission updates finish before dispatch, so
  the MCP proxy normally only forwards bytes. If the provider has lost that
  temporary Session, the conversation lifecycle owner replaces it invisibly;
  see [per-agent integration access](../integration-agent-access/README.md).
  *Rejected*: handing provider headers to the VM.
- *Superseded by [service-catalog](../../done/service-catalog/README.md):
  pricing becomes vendor cost × one standard margin, and `pathBlacklist`
  becomes a catalog allowlist (unlisted routes still return the same bodyless,
  unmarked 404).*
- **Pricing is chat-app verbatim**: flat 50,000 µUSD per 2xx; firecrawl
  variable ($0.005/credit, deferred async settles, browser $0.002/sec, 4xx
  free); composio execute unmetered. No reservations/clamping — deferred
  settles may overdraw (pinned parity semantics).
- **The blacklist 404 is bodyless AND unmarked** — the single documented
  exception to "every duet-originated block carries the `x-duet-gateway`
  marker." Camouflage wins: marking it would concede duet blocked the path.
- **Workspace addressing on keyed surfaces**: explicit `workspace` param
  honored iff the key grants it; else single-workspace inference; else 403
  `workspace_ambiguous`. Durable user keys are single-workspace by
  construction; the explicit hint exists for apps/mcp's `use_integration`.
- **MCP config shape is http-only** (`{type:'http', url, headers?}`) — the
  installed `@duetso/agent` start frame does not accept SSE. Revisit only when
  the agent package does.

## Principles & invariants

- **One owner per concept** — the shipped ledger; violating any row reintroduces
  the drift this spec existed to prevent:

| Concept | Single owner | Consumers |
|---|---|---|
| Block vocabulary + marker convention (`x-duet-gateway`, `x-duet-gateway-code`) | `packages/contract/src/gateway` (schema + header consts + `applyGatewayBlockMarker`) | model-gateway, service proxy, composio route, keyed-workspace helpers |
| Servicing gate + credit preflight + $1 floor | `packages/backend/convex/domains/credits` (+ `workspaces:servicingStatus`) | proxy preflight mutation, model-gateway |
| Charge application (reference-deduped ledger) | `domains/credits/ledger.ts` `applyLedgerEntryWithDb` | proxy settle |
| Charge computation (amount + reference) | `apps/api/src/routes/services/config.ts` | proxy route only |
| Fixed-window rate limit (60 rpm free / 600 paid) | `domains/serviceProxy/rateLimit.ts` (mechanism: `domains/shared/fixedWindowRateLimit.ts`, `workspaceRateLimits` endpoint `'services'`) | proxy preflight mutation |
| Keyed-surface workspace derivation | `apps/api/src/shared.ts` `requireWorkspaceFromKey` | proxy, composio execute |
| `mcpServers` start-frame shape + `integrations` prefix | `packages/contract` | gateway composition, runner protocol |
| Tool Router SDK request translation (`COMPOSIO_API_KEY` is apps/api-only) | `apps/api/src/providers/composio.ts` | conversation lifecycle owner |
| Conversation → Tool Router Session lifecycle (no Duet TTL) | `apps/api/src/composio-session.ts` | session-readiness routes, MCP passthrough proxy |
| Runner MCP config composition (in-VM, local state) | `packages/gateway/src/agent-sessions/coordinator.ts` (`mcpServers` option) | runner `startTurn` |
| Skills content + render invariant + bundle cache | `packages/skills-registry` + `SkillsBundlesByOrigin` (`apps/api/src/routes/vm.ts`) | vm sync skills descriptor |
| Proxy base URL for agents | gateway spawn env `DUET_API_URL` | ported skills (`$DUET_API_URL/v1/…`) |

- **`{{APP_URL}}` renders to the bare app origin** (never a per-workspace
  path), so the bundle cache keyed by rendered origin stays bounded. Pinned by
  the two-slugs → byte-identical-bundle guard in `apps/api/src/index.test.ts`
  (the registry test proves the inverse: different origins → different hashes).
- **The gateway sync consumer parses tolerantly** and salvages
  `gatewayRelease` from a minimal envelope even when the full response won't
  validate — so a gateway can always self-update across response-shape changes.
  This (slice 08, added mid-build) is the root-cause fix for landmine L1, where
  a `.strict()` schema bricked the only staging VM against a newer server.
- **Direct Firecrawl callers stay direct** (apps/api train scraper, lander
  growth brief) — never routed through the proxy.
- **No compat shims**: the old `/integrations/use` route died with no
  forwarder; the old MCP-tool envelope is not emulated.

## Dead ends (do not re-walk)

- **Handing Tool Router session URLs to VMs** — the session header is the org
  key; any design that ships `session.mcp` to a sandbox leaks it (MAP L15).
- **Delivering MCP config via the VM sync schema** — forced an image rebuild
  and fleet recreate for a worse freshness contract; the passthrough proxy
  removed the machinery entirely.
- **"Fleet recreate requires a VM image build first"** — dropped once the
  slice-06 redesign removed the sync-schema change. The user's
  staging-fleet-is-disposable authorization (MAP L1) stands recorded for any
  future strict-schema change.
- **Marking the blacklist 404** — defeats the camouflage; see the exception
  above.

## Incident provenance

The build surfaced a bricked staging VM (sync failing for hours on
`Unrecognized key: "skills"` — L1 manifested). The one-time manual roll-forward
lives at [`unblock-staging-vm.sh`](unblock-staging-vm.sh); slice 08's tolerant
consumer makes the class impossible going forward (forward-only: any gateway
already stuck still needs the one-time roll-forward).

## Pointers into the code

- Proxy routes + charge config: `apps/api/src/routes/services/` (`config.ts`
  is the one pricing owner); composio execute + MCP passthrough:
  `apps/api/src/routes/composio.ts`.
- Preflight/settle: `packages/backend/convex/domains/serviceProxy/model.ts`
  (`proxyPreflight`, `chargeServiceCall`; shared credit logic delegated to
  `domains/credits`). Preflight order servicing → entitlement → rate → credit
  is pinned by `packages/backend/src/service-proxy.test.ts`.
- Skills: `packages/skills-registry/skills/{firecrawl,go-to-market,branded-content,composio-credentials}/`.
- Runner wiring: `packages/gateway/src/agent-sessions/coordinator.ts`
  (`mcpServers` start frame), spawn env seeding of `DUET_API_URL`.
- Sync tolerance: `packages/gateway/src/vm/sync-client.ts` (gatewayRelease
  rescue).
- Vendor secret topology: `scripts/secret-topology.mjs` (catalog vendor keys
  are source-only for vault seeding; `FIRECRAWL_API_KEY` additionally reaches
  `vercel:lander` for the direct growth-brief caller).
