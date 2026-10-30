# App credentials for externally hosted applications

Externally hosted apps use their registered Duet app identity instead of a
person's workspace key. A build agent can register the app, export its credential,
configure the host's server-side secrets and deploy as part of the requested work.
The complete managed runtime delivers the command and build-app instructions;
public npm publication uses the existing, separate release workflow.

## Why app identity

A Vercel deployment outlives the person who configured it. Binding its access to
that person's membership makes ordinary workspace changes an outage risk. The
existing app credential already represents the right authority: one durable app
row, one workspace and declared non-admin capabilities. Export transfers a new
instance of that identity; it does not introduce another credential kind.

The VM and external host have different renewal owners. Managed refresh must
remain automatic without revoking the external deployment's key. Missing purpose
is permanently managed, preserving existing credentials without a migration.
Explicit exports are independent; the five-live limit allows replacement overlap
and bounds inventory. Expired history does not lengthen capacity or per-app revocation work.

No rotation vault, cron or grace timer is necessary. The host gets plaintext once
and keeps it in its server secret manager. The backend stores only the hash.
An ambiguous issuance cannot recover plaintext; inventory and explicit revoke
provide recovery before another deliberate issuance.

## Authority and lifecycle invariants

Ordinary `apps` capability and app-management access authorize export/revoke;
viewers may list. Workspace agents can complete a requested build without a
human key-copy or additional Duet consent step. HTTP admission is rechecked by
the existing durable authentication owner before issuance commits. The stored
app actor remains the workspace VM actor; exporter attribution is audit only.

Managed rotation and redelivery preserve exports. Each export requires an explicit
finite lifetime or `never`; agent teaching chooses `never` for production unless
asked otherwise. App deletion, existing disable/removal paths and a real scope
set change revoke access. Changing scopes away and back cannot revive an export,
including write-share propagation and reconciliation rollback. Removing the
exporter's membership does not revoke the app identity; workspace/account
teardown still applies.

Each app credential binds its workspace. External model requests carry the
app key through standard bearer [REDACTED] REST calls
use ordinary workspace paths. Server-only runtime configuration uses the API and
gateway origins returned by export; browser code never receives the key.
Secret-bearing operations use private/no-store responses. The CLI refuses
redirects, prints no failed response bodies and never retries an ambiguous mint.

## Visible inventory and agent workflow

The Duet registration is an ordinary app serving a short static page. It says
externally hosted, explains the app's purpose, and links its actual URL when
known. This keeps configured deployments visible in the app list without a new
hosting type or metadata table. Its tracking folder and row are durable identity;
deleting them can invalidate the external deployment.

The build agent preserves the external project, exports in memory, passes host
configuration through stdin, deploys, verifies, then retires an identified old
export. Host login/access is an execution prerequisite. It is not a separate
human Duet credential setup workflow.

## Owners and proof

The executable contracts live with their owners:

- [App credential schemas](../../../packages/contract/src/apps/credentials.ts)
  and [endpoint registry](../../../packages/contract/src/endpoints/index.ts)
  define export, live metadata inventory and idempotent targeted revoke.
- [Backend app export operations](../../../packages/backend/convex/domains/apiKeys/appExports.ts)
  reuse the [issuer/lifecycle owner](../../../packages/backend/convex/domains/apiKeys/model.ts)
  and existing authentication. App declaration writers call the shared
  transactional scope-change revocation owner.
- [API routes](../../../apps/api/src/routes/app-credentials.ts) own HTTP
  projection and safe errors; [actual CLI commands](../../../packages/duet/src/commands/apps.ts)
  reuse the unified command context and HTTP client.
- [Build-app skill](../../../packages/skills-registry/skills/build-apps/SKILL.md)
  links its [external-hosting reference](../../../packages/skills-registry/skills/build-apps/reference/external-hosting.md).
  The existing skills bundle carries those instructions to workspace agents.
- [Domain lifecycle tests](../../../packages/backend/convex/domains/apiKeys/appCredentials.test.ts),
  backend API-key/app/VM-sync/model-gateway integration suites,
  [HTTP tests](../../../apps/api/src/routes/app-credentials.test.ts),
  [CLI executable tests](../../../packages/duet/test/cli-app-credentials.test.ts),
  and [joined staging journey](../../../packages/test-harness/src/staging-e2e-synthetic)
  pin the user-visible contracts.

The [staging receipt](assets/staging/receipt.json) joins the matching API/backend
release to installed CLI1.0.1, served skill identity, lifecycle outcomes and
verified cleanup. The public tarball was separately extracted and exercised;
its receipt distinguishes built/tested from published. Staging used catalog
admission without model generation; backend integration owns generation
attribution. [Implementation choices](choices.md) explain the decisions filled
in while building.

## Divergences and visual provenance

Planning inspected a checkout predating unified Duet and incorrectly assigned
CLI work to a sibling repository. Current main owns the public command in
`packages/duet`, the private harness in `packages/agent`, and complete VM runtime
delivery. The obsolete sibling prototype was not published.

The earlier owner-only human export proposal was explicitly superseded by
ordinary app-management access. Human workspace keys and a new services-key
kind were rejected because the existing app identity already supplies stable,
bounded authority. A special external-app type was deferred in favor of the
visible static registration.

The [fresh-agent acceptance evidence](assets/agent-acceptance/README.md) preserves
new-app and full-capacity replacement outcomes. Its desktop/mobile light/dark
screenshots were judged against the requested short, readable external-host
inventory page; there was no uploaded design reference. The
[docs visual evidence](assets/docs-visual/README.md) compares prior production
content with the intended additions and retains a mobile tail supplement where
the existing full-page screenshot height cap truncates the page.

Full-suite verification required plain Bun processes per agent/CLI test file:
shared native renderer state hung later subprocess work. Stdin must also be
isolated so a TUI test cannot consume the runner's remaining file list. Containers
use host-native Linux architecture rather than forcing x64 emulation on ARM
computers; pinned tool versions and x64 CI execution remain unchanged. Existing
focused/eval/benchmark invocation and default file coverage remain intact.

## NewEra remains a separate rollout

[The NewEra handoff](newera-handoff.md) is an executable workspace-agent prompt
using the verified contract and known `https://jointhenewera.com` URL. Platform
implementation and staging proof do not establish the cause of its reported
incident or authorize new production requests/member-content inspection.
No NewEra credential, permission, model, billing or deployment changed here.
