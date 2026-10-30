# App domains

Apps can have one custom hostname. It becomes the standalone address once ready,
while the existing Duet address keeps serving. Workspace Settings calls this
**App domains**; each app's menu opens **Custom domains**. This carries the useful
DNS instructions, conflict evidence, verification and removal behavior from the
previous chat-app repository into Duet's existing app model.

The [final choices](choices.md) explain decisions made where the request left a
gap. The [live acceptance receipt](assets/live/README.md) separates deployed proof
from controlled reference and local regression evidence.

## Why the addresses differ

A standalone hostname belongs to the person sharing the app. An embedded view
belongs to Duet's product session. Every public and private embedded view uses the
Duet host, so customer DNS is never a dependency of the embedded experience.
Changing a domain changes addressing, not app files, commands, availability,
visibility or membership. The standard address is a permanent working alias,
without a forced redirect.

Private standalone document visits can use Duet's existing sign-in and return to
the same host/deep path. An iframe or API denial does not become an HTML login
redirect. Public custom-host content retains upstream indexing directives; the
standard hostname, private content and platform auth/error responses remain noindex.

## What must remain true

- One local app reserves one hostname, and a hostname cannot belong to two app
  bindings. Bindings use durable app identity and remain local when app content is
  shared or installed. Local editors manage their binding even when the app is
  broken, disabled or read-only; readers can inspect it.
- The original public host survives VM ingress, even when ingress replaces
  ordinary proxy headers. Apps receive the conventional forwarded-host value;
  the internal transport field is removed before app delivery.
- The existing app admission owner governs both hostname classes. Host lookup only
  supplies identity, and live admission rechecks the binding. There is one gateway
  byte path and no new identity service.
- Removal stops custom-host admission immediately, but does not release the
  hostname until captured-target cleanup succeeds. Parent deletion cannot forget
  a provider assignment or depend on surviving browser credentials.
- Interrupted provider writes are not proven complete by client cancellation,
  elapsed time or a later 404. An uncertain write keeps its reservation until an
  operator confirms remote settlement. Ordinary exhausted cleanup remains retryable.
- Recheck progress is separate from serving state. An active hostname keeps
  serving while its queued/running check is observed. Operational observation
  failure preserves the previous binding; authoritative absence or unreadiness
  can demote it. Mounted detail and inventory observe unsettled work and stop
  when it settles; active bindings have no recurring health monitor.
- An app-access grant names durable app ID and passes live admission before
  cookie installation. Reusing a hostname or slug cannot authorize a replacement.
  A former app cookie recovers through the replacement's guest policy; an old
  query grant remains refused.
- The provider team/project/branch is captured at attachment. Cleanup cannot
  silently follow changed environment configuration or delete a moved alias.
  Runtime domain credentials stay with Convex, separately from local deploy authority.
- An already-in-use provider response is a successful replay only when the
  captured project still has the assignment. A conflicting assignment needs an
  explicit release or move before Recheck can recover; attachment never takes
  over another project's hostname.
- Gateways echo app-address metadata in reconciliation reports. The Convex
  argument validator must accept that shared config metadata, so a domain change
  cannot reject workspace heartbeats or prevent health recovery.

## Evidence that changed the design

The reference's boolean token/state-machine vocabulary could not carry complete
DNS evidence or captured staging targets. The port keeps the actual provider and
handler oracle, with declared behavioral differences; it does not retain that
unused vocabulary or add migration/compatibility scaffolding.

Storing every full DNS payload with address projections exceeded Convex's read
budget at the app ceiling. Compact canonical slots reference separate diagnostic
rows, and visible pages remain bounded. This keeps one status owner without
copying an independently maintained URL projection.

A held fetch promise was insufficient evidence about alias cleanup: native HTTP
abort returns before a provider can finish its write. Releasing the reservation on
promise settlement, lease expiry or a missing read was rejected. Explicit repair
for uncertainty is the consequence of preserving one-domain ownership across time.

Composed workspace deletion hit Convex's one-paginated-query-per-transaction limit.
The parent seals admission immediately and schedules the first domain cleanup page
in a separate transaction; domain cleanup still uses the existing durable retry owner.

Recheck initially returned an unchanged active/failed status, leaving clients with
no reason to observe completion. The derived `checking` detail flag closes that
seam without another stored status. Inventory observes work after the manager closes,
so a progress label cannot remain stuck solely because its dialog unmounted.

No registrar editor, wildcard domains, www/apex pairing, published-file domain,
multi-domain selector, generic job engine, cookie sharing or legacy registration
migration ships. Existing public-only standalone Open/Copy menu availability remains.

## Code and behavioral owners

| Concern | Entry point / proof |
| --- | --- |
| Domain grammar, detail response and standalone URL | [contract domains](../../../packages/contract/src/domains/index.ts), [app addresses](../../../packages/contract/src/apps/index.ts) |
| Admission, captured target and canonical slot | [domain model](../../../packages/backend/convex/domains/customDomains/model.ts), [domain work](../../../packages/backend/convex/domains/customDomains/work.ts), [schema](../../../packages/backend/convex/schema.ts) |
| Provider transport and ownership observations | [Vercel adapter](../../../packages/backend/convex/services/vercelDomains.ts), [provider tests](../../../packages/backend/convex/services/vercelDomains.test.ts) |
| Existing app admission / hostname lookup | [app resolver](../../../packages/backend/convex/domains/apps/model.ts), [hostname owner](../../../packages/backend/convex/domains/customDomains/model.ts), [edge serving](../../../apps/edge/src/index.ts) |
| Management REST and internal delivery | [routes](../../../apps/api/src/routes/app-domains.ts), [real lifecycle trace](../../../apps/api/src/routes/app-domains-lifecycle.test.ts) |
| Private launch and protected return | [apps API](../../../apps/api/src/routes/apps.ts), [return route](../../../apps/web/app/w/[workspaceSlug]/apps/[slug]/open/route.ts), [private return tests](../../../apps/web/src/server/app-open.test.ts) |
| Shared management and inventory | [panel/status](../../../apps/web/spa/apps/app-domain-dialog.tsx), [query owner](../../../apps/web/spa/api/app-domains.ts), [Settings](../../../apps/web/spa/settings/workspace-app-domains.tsx) |
| Always-Duet embedded view | [frame owner](../../../apps/web/spa/apps/app-frame.tsx), [frame regression](../../../apps/web/spa/apps/app-frame-body.test.tsx) |
| Deployed acceptance and cleanup | [focused journey](../../../packages/test-harness/src/staging-e2e-synthetic), [cleanup owner](../../../packages/test-harness/src/staging-e2e-synthetic) |
| Developer contract guidance | [Apps docs](../../../apps/docs/app/apps/page.mdx) |

Names and wire schemas in code are authoritative. Research transcripts identify
exact measured boundaries, rather than serving as another production contract.

## Reference and visual provenance

The [reference record](research/reference.md) and
[frozen snapshots/oracle](assets/reference/README.md) come from
`~/dev/chat-app` at revision `3a9000f4f714c1c699df79cd608afc01ccd920c6`.
Its controlled request/output evidence preserves provider/action/storage decisions;
it does not claim legacy UI, live Convex, authentication or TLS parity.
[Candidate parity](research/provider-parity.md) records the constrained deltas.
Frozen reference bytes and identities remain unchanged after archive relocation.

The visual standard is Duet's production management surfaces, captured in pinned
Docker Chromium at desktop/mobile sizes. [App manager evidence](assets/visual/domains/README.md)
retains the previous app menu and initial manager beside the final states;
[Recheck evidence](assets/visual/domains/recheck/README.md) retains queued work,
closed-manager observation and the previous-error label correction;
[Settings evidence](assets/visual/settings/README.md) retains inventory, navigation,
long records and toast framing. [Docs evidence](assets/visual/docs/README.md) and
[Recheck docs](assets/visual/recheck-docs/README.md) preserve the previous page,
added copy, native card/footer crops and independent judgments.

[Control-fixture evidence](assets/visual/controls/README.md) records historical
baseline drift proven byte-identical before/after the production control change.
Unrelated Settings screenshot failures remain retained with their original baselines;
these are limits on a full-suite visual claim, not accepted feature regressions.
The [exploration map](visualizations/exploration-map.html) is historical requirement
context, with its superseded build instructions removed.
