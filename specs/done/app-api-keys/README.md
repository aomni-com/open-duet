# app-api-keys

Apps registered in a workspace call the Duet public API with their own
credential. An app **declares** the capabilities it needs at registration
(`apiScopes` on the app row); the **platform mints** one hidden
workspace-local key per (app row, workspace) and injects it into the app's
service process env as `DUET_APP_API_KEY` (with `DUET_API_URL`). No key
material exists at build time, so sharing or installing an app into another
workspace just works — the recipient workspace mints its own key for its
replica row. Shipped alongside: the capability vocabulary cleanup
(`agent`→`sessions`, `ai`→`services` with the metered service proxy folded
under it, `members` split out of `admin`), an allowlist-only app spawn
environment that ended the gateway-env leak (`DUET_PROVISIONING_TOKEN` was
reaching every app), and an integrations OAuth redirect guard loosened to
Duet-controlled origins.

The full decision audit — everything chosen where this spec was silent,
with verdicts — is [choices.md](choices.md). The one open call for Example User:
7-day key expiry / 24h refresh window (one-constant change to overrule).

## The reason it works this way

- **Declare, don't mint, at build time.** A key minted during an app build
  is a workspace-A artifact; installing that app elsewhere would smuggle or
  strand it. Declaration is plain data on the app row, so it replicates with
  shares and official seeding for free, and every workspace mints locally.
- **The drive is radioactive for secrets.** App folders sync to devices,
  render in file view, and can be shared or published. Keys therefore reach
  apps only through spawn env, never any drive path — the build-apps skill
  teaches this with the why.
- **Delivery is pull-only over the existing 5s vm-sync poll**
  (`needsAppCredentials` mirroring `needsModelCredentials`). A lost gateway
  store re-asks, and the ask itself rotates — so a leaked-then-lost key dies
  on redelivery.
- **Keys are keyed by app row id, not slug.** Delete/recreate under the same
  slug must never resurrect stale authority; `GatewayAppConfig` carries the
  non-secret `appId` as the store key.
- **7-day expiry, 24h refresh** — deliberate deviation from the VM model
  key's 24h: app-key rotation must restart the app process to re-inject env,
  so daily rotation would bounce every app daily. Weekly bounds the churn.
- **No install-time approval.** Scopes are displayed (elevated ones with
  warning treatment); the remedy is disable/uninstall. Example User explicitly
  rejected a consent gate.
- **`members` = invites create/list/revoke only**, owner-grantable,
  app-declarable — motivated by "apps invite users" needing a grant that is
  not the `admin` skeleton key. Everything else administrative stays
  `admin`, which remains the same-workspace wildcard and is never mintable
  for apps.
- **App keys authenticate like `system_vm`** (membership-free, exactly one
  workspace, `credentialKind: 'app'`, actor = workspace creator); auth
  revalidates the app row still exists, is enabled, and still declares the
  stored scopes.
- **The VM build key and an app key author differently.** The VM key holds
  `sessions` (`vmModelScopes`), and input sent with it is attributed to Duet
  (`{kind:"system"}`); a registered app's own key authors as that app.
  Declaring `sessions` in `apiScopes` is how an app gets truthful authorship,
  not an escalation workaround.

## Invariants

- No key material in `GatewayAppConfig`, reconciliation reports (they extend
  the config schema and echo to the backend — the standing trap), public App
  JSON, audit provenance, logs, URLs, drive folders, seeds, shares,
  publishes, or test artifacts. Plaintext at rest exists only in the
  gateway's private state file (`app-credentials.json`; 0600 enforced by the
  shared `persisted-store.ts`), registered for log redaction.
- No plaintext keys in Convex — hashed via the shared rail.
- `admin` is unrepresentable on app keys: `AppApiScopesSchema` (the request
  grammar) IS the ceiling, and mint re-parses through the same symbol.
- Spawn env is allowlist-only (`PATH`, `HOME`, `PORT` + injected extras);
  install commands never receive the key; injected extras can never
  override the supervisor-assigned `PORT`.
- The vm-sync credential envelope's `scopes` are declared capability names
  (`AppApiScopesSchema`), never ws-serialized key scopes — the gateway
  compares them against `GatewayAppConfig.apiScopes`, and violating this
  loops rotation+restart on every poll (it failed exactly this way once;
  the schema now rejects the wrong vocabulary at parse time).
- App restarts ride the supervisor's serialized per-app reconcile queue —
  never a bare signal — so credential delivery cannot race reconciliation.
- Key projection lives in `composeVmAppCredentials`, never in
  `runConfigForWorkspaceImpl`: run-config is a query and minting is a
  mutation; that boundary is why the credential envelope exists at all.
- Every destructive app lifecycle transition (delete, replica disable,
  share-convergence removal, official removal/disable) revokes in the same
  durable mutation; re-enable never resurrects — the delivery rail mints
  fresh.
- Exact-origin equality in the OAuth redirect rule; never suffix matching.

## Pointers

| Concept | Code |
|---|---|
| Capability list, scope grammar, `AppApiScopesSchema` ceiling, `ELEVATED_APP_CAPABILITIES`, `sameApiScopes` | `packages/contract/src/scopes/index.ts` |
| App schemas + `GatewayAppConfig` (+ config equality) | `packages/contract/src/apps/index.ts` |
| Key lifecycle: `mintAppKeyForApp` / `rotateAppKeyForApp` / `revokeAppKeysForApp`, shared `issueManagedWorkspaceKey`, expiry constants | `packages/backend/convex/domains/apiKeys/model.ts` |
| Authentication branch (`authorizedAppKeyPayload`) | `packages/backend/convex/domains/apiKeys/{model,api}.ts` |
| Delivery: `composeVmAppCredentials`, `needsAppCredentials`/`appCredentials` | `packages/backend/convex/domains/workspaces/vmSync.ts`, `packages/contract/src/vm/index.ts` |
| Gateway store + redaction | `packages/gateway/src/app-credentials.ts` |
| Spawn env allowlist + extras seam | `packages/gateway/src/apps/spawn-env.ts`, consumed by `AppSupervisor` (`restartApp` in `routes/apps.ts`) |
| OAuth redirect rule | `allowedIntegrationRedirect` / `parseEdgeAppHost` in `packages/contract/src/edge/index.ts` |
| Scope display (chips + warning tier) | `ApiScopeDeclaration` in `apps/web/spa/apps/app-actions.tsx` |
| Agent-facing contract | `packages/skills-registry/skills/build-apps/SKILL.md`; human docs in `SECURITY.md` and `apps/docs` |
| Live journey leg | `packages/test-harness/src/staging-e2e-synthetic{,.test}.ts` (boolean-only diagnostics fixture) |

Behavior pins: contract scope/edge/vm tests, `apiKeys` model tests,
`vm-sync.test.ts` delivery tests, the gateway injection/rotation integration
test in `gateway.test.ts`, the app-controls component tests, and the app-menu
visual baselines (the `apps-scopes-*` shots went with the workspace-level app
page).

## Dead ends

- **Push delivery on the direct POST/PATCH reconcile** (two blind drafts
  wanted it): rejected — a second delivery path buys ≤5s of latency over the
  poll and doubles the secret-bearing surface.
- **Deleting the OAuth redirect guard** (Example User asked): no — an OAuth
  callback redirecting to an arbitrary caller-supplied URL is a textbook
  open redirect. The guard was loosened to two origin classes instead.
- **Install-time approval/consent state**: explicitly rejected; display +
  disable/uninstall is the model. The UI must never resemble an approval
  prompt.
- **Bare-SIGTERM restart on key rotation**: shipped briefly, read as a
  startup crash and earned exponential backoff when a key arrived
  mid-startup; replaced by queueing through the reconcile machinery.
- **ws-serialized scopes in the delivery envelope**: each side's fixtures
  were green alone; the seam looped. See invariant above.

## Cutover provenance

Staging hard cutover (Example User, 2026-07-22: no migrations, no compat shims, no
aliases). Executed 2026-07-23: the required-`apiScopes` push failed against
743 pre-cutover apps rows as anticipated; Example User directed deleting the rows
outright (staging-disposable; seed/official apps re-materialize through
convergence with declared scopes), after which schema + functions deployed
clean. **The live `bun run e2e:staging` for this spec was explicitly waived by
Example User.** The app-api-keys journey leg is a required part of the harness and
rides every approved staging run.

## Draft provenance

Synthesized 2026-07-22 from three blind drafts (codex/fewest-slices,
codex/risk-first, claude/seam-quality). All three independently converged
on: separate credential envelope, lazy per-workspace mint,
allowlist-not-denylist spawn env, appId keying, no-alias hard cutover.
