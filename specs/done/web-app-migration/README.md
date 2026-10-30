# Product app and public-site ownership

## Overview

Duet has three independent web surfaces:

- `apps/web` is the authenticated product at `service.example.invalid` and
  `service.example.invalid`. The SPA owns the host root.
- `apps/lander` is the statically rendered public site at `service.example.invalid` and
  `service.example.invalid`; `service.example.invalid` is a permanent redirect host.
- `apps/docs` is the statically exported developer reference at `service.example.invalid`
  and `service.example.invalid`.

The split keeps product evolution, public publishing, and API documentation from
sharing a deployment or runtime owner. The later launch promotion made bare
`service.example.invalid` the public site's canonical production domain without changing that
ownership boundary.

## Why the split exists

The product and public site have opposing constraints. The product is an
authenticated API client whose navigation and state change frequently. The public
site needs stable, crawlable, bilingual HTML and independent editorial releases.
Keeping them in one Next.js application made either concern capable of breaking the
other and encouraged product routes, public SEO, authentication, and acquisition
telemetry to share accidental seams.

The developer reference is separate for the same ownership reason: its public API
contract comes from `packages/contract`, while its prose and examples can deploy as
plain static files without product runtime or secrets.

Clean ownership wins over compatibility because the replaced route shape had no
compatibility contract. There is no `/app` mount, old-host fallback, dual public owner,
or migration redirect.

## Invariants

### One deployable owner per surface

- Web owns product composition, authentication surfaces, browser-session transport,
  and internal administration. It does not own public content, SEO, public forms, or
  server-side advertising conversion delivery.
- Lander owns anonymous marketing, editorial, campaign, legal, install, form, and
  SEO behavior. It does not import product authentication, browser sessions, Convex,
  or product API clients.
- Docs owns developer prose and static reference rendering. Endpoint paths, scopes,
  and wire schemas remain owned by `packages/contract`.
- Cross-app reuse stops at backend-independent packages such as `@repo/ui`, shared
  Tailwind policy, contracts, and the deliberately small web-locale package.
  Runtime apps do not import one another.

The app-local boundary checkers in `apps/web/scripts` and `apps/docs/scripts`
enforce the high-risk ownership directions. Lander's own scripts additionally
guard public copy and static output. (A root `scripts/app-boundaries.ts` scan
existed until 2026-07-26, when it was deleted as unnecessary process.)

### The product is API-first

Ordinary product operations travel through the browser-session API proxy and the
public API; the SPA does not read or mutate Convex directly. Authentication bootstrap
is allowed to establish the browser session. Internal administration is the explicit
privileged exception and remains isolated from ordinary product capabilities.

The product data boundary is anchored in `apps/web/spa`, `apps/web/app/api/duet`,
`apps/api/src/routes`, and `packages/contract/src/endpoints`. The import firewall in
`apps/web/scripts/check-boundaries.ts` guards the client side of the rule.

### Public HTML is URL-owned

English and Spanish public URLs determine their own static HTML, canonical,
alternate-language links, structured data, and sitemap membership. A stored language
preference may choose the next navigation target, but it never changes the HTML for
the URL being rendered. This keeps static generation and SEO deterministic while a
person moves between the lander and product.

`packages/web-locale` owns only the `DUET_LOCALE` cookie and shared PostHog
persistence policy. On deployed sibling hosts the cookie is scoped to `.service.example.invalid`; in
local development it is host-only. Lander owns anonymous acquisition telemetry and
web identifies the authenticated user, preserving the same anonymous journey across
the handoff and resetting it on sign-out.

### Hosts are explicit configuration

Product callbacks, invitations, device approval, billing returns, and integration
returns use the product origin. Public canonicals, alternates, and sitemap entries use
the lander origin. Runtime code does not infer one from the other, and neither app
claims bare `service.example.invalid` under this architecture.

The origin policy lives in `apps/web/src/site-config.ts`, `apps/lander/src/config`,
`apps/api/src/config.ts`, `packages/backend/convex/config.ts`, and
`scripts/secret-topology.mjs`. Product, API, and lander staging hosts are required
acceptance inputs; docs has one explicit `service.example.invalid` default with an
override for alternate staging topologies. The lifecycle consumes these origins and
never repairs aliases.

### Static and visual coverage are inventories, not anecdotes

Each web surface owns a code-derived registry of routes and renderable states. New
exports or routes must be classified, rendered, or given an explicit nonvisual reason.
Static public verification covers every concrete URL, while screenshots cover distinct
templates and representative rich editorial bodies rather than duplicating every
generated post.

The product playground registry lives in `apps/web/app/playground/registry.ts`, the
public route registry in `apps/lander/src/public-route-manifest.ts`, and the docs
registry in `apps/docs/lib/docs.ts`. Their visual ledgers and gates live under each
app's `tests/visual` and `scripts` directories. Root scripts compose those independent
gates without creating a fourth owner.

### Deployed acceptance has one lifecycle owner

`packages/test-harness/src/staging-e2e-synthetic` is the sole deployed acceptance
orchestrator. It drives the real staging APIs and browser surfaces across the product,
lander, docs, control-plane services, and hosted provider redirects. Independently
cleanable external resources enter one run-tagged ledger before risky waits; compound
bootstrap resources remain covered by their parent cleanup until their own identifiers
are observable. Cleanup runs in `finally`, verifies deletion, and fails on residue.

Browser diagnostics are centralized in
`packages/test-harness/src/staging-e2e-synthetic`, resource accounting in
`packages/test-harness/src/staging-e2e-synthetic`, and request policy in
`packages/test-harness/src/staging-e2e-synthetic`. A second acceptance runner would
split both coverage and cleanup ownership and is therefore forbidden.

## Operational discoveries

The deployed system exposed several contracts that local happy-path tests could not:

- Gateway pinning is an explicit pre-acceptance operator gate: it validates one exact
  ready Vercel deployment before writing its desired release version. The lifecycle
  does not choose or mutate that pin; it separately verifies that the run's workspace
  VM resolves and runs the currently selected version. Deployment provenance therefore
  comes from the pin command's result, while VM rollout evidence comes from acceptance.
- Browser navigation stops at finite DOM readiness and then waits for page-specific
  semantic readiness. Full-load or `networkidle` waits are invalid on pages with
  analytics and long-lived requests.
- An HTTP 204 response is complete when its status is observed. Waiting for a body on
  that body-forbidden status can hang after the external action, including real email
  delivery, has already succeeded.
- An aborted browser request is excused only by causal evidence: a superseding or
  pending navigation, explicit prefetch, a responsive resource superseded by a marked
  viewport change, a completed bodyless response, the request's exact subframe
  detaching, or a later successful request to the exact full URL. Unresolved aborts
  surface during teardown. A known browser/provider exchange may instead own an exact,
  bounded method-origin-path-status budget; the budget is evidence for that exchange,
  never a status-wide exemption. HTTP failures remain actionable unless the same
  origin-scoped policy owns that exact response.
- UI actions that depend on hydration wait for their semantic handler and the exact API
  response. A visible server-rendered control is not yet proof that React owns it.

These rules explain the finite timeouts and response classification in the staging
harness. Removing them recreates false hangs or false browser-error verdicts without
improving product coverage.

The destructive staging lifecycle intentionally excludes Google OAuth because a real
Google identity cannot be run-tagged and deleted by its cleanup ledger. OAuth proof
selection and callback routing have focused local coverage; the generic deployed run
records the provider leg as an explicit policy skip.

## Rejected alternatives

- **A hybrid `/app` mount:** it preserved the coupling this split removes and offered
  compatibility for a product that had not launched.
- **A shared marketing React package:** it would make two deployables co-own public
  rendering and turn each editorial change into a coordinated product release.
- **Request-time locale for public HTML:** it makes one public URL emit different HTML
  and undermines deterministic static generation.
- **Dual owners, legacy redirects, and feature flags:** they create migration state
  without a live compatibility requirement.
- **A separate deployed test runner:** it would duplicate orchestration and make
  cleanup and coverage disagree.
- **Manual Vercel aliases:** they hide whether the staging branch produced the
  deployment being tested.
- **The incumbent live sitemap as the permanent oracle:** it is a moving product from
  another repository. The immutable extraction capture proved the transfer; current
  lander inventories now own the contract.

## Visual provenance

The transfer and redesign were judged against committed evidence rather than freshly
generated snapshots alone:

- [`evidence/public-baseline-summary.md`](evidence/public-baseline-summary.md) records
  the immutable Duet post-extraction baseline and the signals used to prove that the
  bilingual public surface moved atomically. The bulky executable capture was retired
  after ownership transferred; the summary preserves why the current lander is the
  oracle.
- `apps/web/tests/visual/references/chat-app` contains desktop and mobile screenshots
  from the predecessor product. They set the reference for the shell and shared UI
  primitives while the new session-and-events product was rebuilt.
- `apps/web/tests/visual/__screenshots__` contains the accepted desktop and mobile
  product states, including the rebuilt internal administration UI. These are the
  current regression standard for product presentation.
- `apps/lander/tests/visual/__screenshots__` contains accepted public templates,
  no-JavaScript renders, bilingual routes, and representative rich blog bodies. It
  protects template and static-rendering parity without snapshotting every post.
- `apps/docs/tests/visual/__screenshots__` contains the accepted desktop and mobile
  developer-reference surfaces and is the visual standard for the separate docs app.

These source screenshots were also assembled into temporary review contact sheets.
That review drove mobile navigation and scroll-state corrections in the product,
insurance-label corrections in public pages, and CTA-color corrections across the
handoff. The duplicate composites were retired to avoid storing a second copy of the
same pixels; the per-surface source screenshots above remain the regression evidence.

## Public-content synchronization is over

The predecessor repository was reconciled into `apps/lander` one last time and
is no longer a source. What that port found — why it could only ever be
per-hunk, and which classes of stale claim survive a green gate — is recorded
in [`specs/done/chat-app-public-sync/README.md`](../chat-app-public-sync/README.md).
