# Choices ledger — app-api-keys (final, consolidated)

Every decision made where the spec was silent, re-audited against the
shipped code at spec close. Grouped by verdict, least-confident first
within each group. This ledger — not the diff — is the review surface for
what was decided on the user's behalf.

## Needs-user

### App keys live 7 days and refresh in the last 24 hours (slice 04; spec decision flagged for Example User)

- **The choice:** an app's key expires 7 days after mint, and the gateway
  starts asking for a replacement once the key is within 24 hours of
  expiry. The platform's own VM model key uses 24-hour expiry instead.
  The deviation exists because replacing an app's key must restart the
  app process (its key arrives via process environment, which cannot
  change while running): daily expiry would restart every declared app
  every day, dropping whatever connections it held; weekly bounds that
  churn to once a week.
- **Provisional call:** ship 7d/24h (`APP_KEY_EXPIRES_MS`,
  `APP_KEY_REFRESH_WINDOW_MS` in
  `packages/backend/convex/domains/apiKeys/model.ts`). Reversal is a
  one-constant change; nothing else depends on the values.
- **Confidence the call stands:** medium — the spec recorded the
  rationale, but the tradeoff (credential lifetime vs. restart churn) is
  a product-risk judgment that belongs to Example User.

## Unsound

_None at close. Two earlier implementation choices were redone during
integration and their corrected forms appear under Sound: the delivery
envelope's scope vocabulary, and the app-restart mechanic._

## Sound

### Composio proxy routes now demand the `integrations` capability (slice 00)

- **The choice:** slice 00 gave `requireWorkspaceFromKey` (the helper that
  resolves which workspace a multi-workspace API key is acting in) a
  required capability check, naming one caller: the metered service proxy
  passes `services`. The helper's other callers — the Composio execute and
  MCP proxy routes (`/v1/composio/*`, which run third-party integration
  actions) — were not named. They now pass `integrations`. Before this, a
  key could call Composio routes with mere workspace membership.
- **The gap:** "one helper, one rule" named the capability for only one of
  the helper's callers.
- **The reach:** any existing key reaching Composio without an
  `integrations` scope loses access after deploy (the staging cutover
  accepts this by design). Every future route through this helper must
  name a capability — the signature forces the decision.
- **Verdict:** sound — Composio is the integrations execution surface; a
  scope-free path would preserve exactly the membership-only hole the
  slice was closing.
- **Confidence:** medium-high.

### Spawn-env allowlist shipped without a `static-web-server` leg through the spawn path (slice 01)

- **The choice:** the new app spawn environment is exactly PATH, HOME, and
  the supervisor-assigned PORT. The slice's proof matrix ran every leg
  except `static-web-server` (the static-file server available inside the
  VM image): the binary does not exist on this host, and its image probe
  runs it directly rather than through the gateway's spawn path. That one
  leg ships unproven locally.
- **The gap:** the slice assumed the whole matrix was locally runnable.
- **The reach:** if `static-web-server` secretly needs an env var beyond
  the allowlist, static apps break at spawn on staging.
- **Verdict:** sound with a follow-up — a static file server needs no
  exotic env, and the slice-09 live staging e2e (whose harness leg now
  exists, run pending Example User's gate) exercises real apps end-to-end as the
  designated catch-point. The remedy on failure is adding the proven
  variable with evidence, never a spread.
- **Confidence:** medium-high.

### An absent app-credential request is an empty ask (slice 05)

- **The choice:** `needsAppCredentials` is optional on the strict vm-sync
  request; a poll that omits it (every pre-slice-06 gateway) is treated
  exactly like `[]` — no app keys minted or returned. Requiring the field
  would have rejected every poll from the unchanged gateway inside the
  slice that was explicitly banned from touching the gateway.
- **The gap:** the slice fixed the field name and pull gate but not how
  the producer treats polls from the older gateway.
- **The reach:** omission can never trigger credential delivery; request
  parsing stays strict about unknown fields.
- **Verdict:** sound — absence is the natural representation of "no ask."
- **Confidence:** medium-high.

### The vm-sync credential envelope carries declared capabilities, not key scopes (slice 06 integration; corrected decision)

- **The choice:** the delivery envelope's `scopes` field
  (`VmAppCredentialsSchema`) is typed `AppApiScopesSchema` — bare declared
  capability names (`['members','sessions']`) — not the key's
  ws-serialized scope strings (`ws:<slug>:members`). As first implemented,
  slice 05 sent the ws-serialized form while slice 06's gateway compared
  against bare capabilities; the vocabularies never matched, so every 5s
  poll would have evicted the stored key, re-asked, rotated, and restarted
  every declared app forever. Each sandboxed pass was green because each
  side's fixtures used its own vocabulary; only the unsandboxed cross-seam
  run caught it.
- **The gap:** the spec's envelope sketch never pinned the vocabulary.
- **The reach:** the gateway stays ignorant of the ws-scope grammar, and
  the schema rejects ws-serialized strings at parse time — a future
  regression fails loudly instead of looping silently.
- **Verdict:** sound — the field exists for the gateway's staleness
  comparison against `GatewayAppConfig.apiScopes`, which speaks capability
  names; authority lives in the key itself.
- **Confidence:** high.

### App restarts ride the supervisor's serialized reconcile queue (slice 06 integration; corrected decision)

- **The choice:** key delivery/rotation triggers `restartApp`, which
  enqueues through `activeAppReconciles` — the same per-app queue config
  changes use — and reuses the existing stop → wait-for-port → respawn
  replace path. As first implemented it sent a bare SIGTERM; a key
  arriving while the app was still binding read as a startup crash and
  earned exponential backoff.
- **The gap:** the slice delegated the restart mechanic with "reuse the
  existing respawn path."
- **The reach:** restarts serialize with spawns and config replaces for
  the same app, so credential delivery can never race reconciliation.
- **Verdict:** sound — pinned by the injection/rotation integration test.
- **Confidence:** high.

### Restore keeps the VM's current app keys, never keys from the archive (slice 06)

- **The choice:** workspace archives include the gateway state directory,
  so an archive can contain `app-credentials.json`. Restore preserves the
  destination VM's current app-key file and discards the archived copy
  (removing it outright when the destination has none), mirroring the
  model-key rule. The alternative would let an older snapshot install
  authority minted for the archive's source state.
- **The gap:** the slice required state-directory persistence but not how
  that secret-bearing file participates in archive restore.
- **The reach:** backup/restore cannot roll app authority backward or
  transplant it; a lost cache re-asks through the ordinary pull rail.
- **Verdict:** sound — credentials describe the live VM, not portable
  workspace content.
- **Confidence:** high.

### Stale and empty declarations evict the cached key before respawn (slice 06)

- **The choice:** when the desired app list changes, the gateway
  immediately deletes a cached key whose stored scopes no longer match the
  app's declaration (or whose declaration became empty). The app respawns
  keyless while the next poll asks for replacement authority; it never
  briefly runs with the old key. The alternative kept injecting the old
  key until the replacement arrived.
- **The gap:** the slice required stale keys be re-requested but not
  whether they stay spawn-eligible meanwhile.
- **The reach:** scope reductions take effect locally before the new key
  exists.
- **Verdict:** sound — brief loss of API access beats extending stale
  authority.
- **Confidence:** high.

### Empty app-key delivery omits the credential envelope (slice 05)

- **The choice:** a quiet poll, quiesced workspace, or ask containing only
  ineligible apps gets no `appCredentials` field at all, rather than
  `appCredentials: []`; the field appears only when it carries plaintext.
- **The gap:** the slice delegated the batching shape.
- **The reach:** `private, no-store` applies exactly when plaintext is
  present; the gateway treats a missing envelope as zero deliveries.
- **Verdict:** sound — mirrors the optional model-credential envelope.
- **Confidence:** high.

### App identity is a named object on authenticated app credentials (slice 04)

- **The choice:** successful app authentication adds `app: { id, slug }`
  beside `credentialKind: 'app'`; the credential document id stays
  `credentialId`, so app identity and credential row cannot be confused.
- **The gap:** the slice required "the app identity" without a shape.
- **The reach:** consumers attribute the caller to the durable app row
  without parsing audit provenance.
- **Verdict:** sound.
- **Confidence:** high.

### App API declarations normalize once at the contract boundary (slice 03)

- **The choice:** `AppApiScopesSchema` accepts any order, deduplicates,
  and stores a lexicographically sorted capability array; registration,
  PATCH, backend mutations, reconciliation reports, and rollback all parse
  through that one symbol. `admin` and unknown names still fail rather
  than being filtered.
- **The gap:** the slice delegated normalize-vs-reject (recommending
  normalize).
- **The reach:** every persisted, replicated, returned, and compared
  declaration is canonical, which is what makes element-wise equality set
  equality everywhere.
- **Verdict:** sound.
- **Confidence:** high.

### Injected extras can never override the supervisor-assigned `PORT` (slice 01)

- **The choice:** `buildAppSpawnEnv` merges `{ ...allowlist, ...extras,
  PORT }` — the port wins last, so credential injection can never re-point
  an app at another app's port.
- **The gap:** the slice defined the extras seam but not its precedence.
- **Verdict:** sound — pinned by a test.
- **Confidence:** high.

### Full-suite verdicts come only from completed task sets; off-slice bind/timeout failures retry solo (process, orchestrator)

- **The choice:** two rules governed verification. (1) When a full-suite
  run failed in a package the slice never touched with a port-bind or
  timeout shape — this host also ran other sessions' suites and a
  benchmark concurrently — the package was re-run alone and the solo
  result taken as authoritative; every such re-run was green. (2) After
  discovering that turbo aborts remaining tasks when one fails — so "full
  run + solo re-run of the named failure" can leave cancelled tasks
  silently unverified (one never-run test with a phantom error expectation
  survived five "green" runs this way) — full-suite verdicts were redrawn
  from completed task sets only (`--continue`, plus turbo's cache of
  genuinely passed tasks).
- **The gap:** no spec guidance on adjudicating shared-machine
  interference or on turbo's abort semantics.
- **The reach:** the evidence ledger's "green" claims rest on these rules;
  future runs on this host should assume both hazards.
- **Verdict:** sound — the corrected process caught a real test bug the
  original process had certified around.
- **Confidence:** high.

## Trivial discretion (compressed)

Parameter order on `requireWorkspaceFromKey` (capability before optional
slug); the 403 body reuses the repo's existing
`{ error: 'insufficient_scope', scope }` shape; shared host parser named
`parseEdgeAppHost`; app-origin redirects reject explicit ports (URL
normalization makes `:443` implicit, so only non-standard ports refuse);
the single-caller `allowedRedirect` wrapper was inlined away; slice 03's
failed-reconcile rollback restores the prior `apiScopes` with the other
runtime fields; replica-deletion adapters receive the owning transition's
`now` so revocation and its audit trail share one timestamp; scope-chip
styling per the recorded slice-07 checkpoint resolution (amber
informational treatment, dashed empty-state pill); the slice-09 harness
reuses the existing shared-app fixture, probes `GET /v1/whoami` (allowed)
vs the apps list (denied), disables the recipient replica (disable is
replica-only), and persists only boolean proof so shutdown cannot erase
revocation evidence; test-table layouts per slice files.
