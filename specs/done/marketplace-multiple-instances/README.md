# Marketplace multiple agent instances

## Overview

A workspace may install several independently named agents from one marketplace
listing. A team can therefore keep separate Website Builder agents for a customer
portal and a marketing site without duplicating the catalog listing or introducing
a second kind of installed agent.

This feature exposes a relationship the marketplace already had:

```text
one catalog listing ──< many workspace subscriptions ── one installed agent each
```

An additional instance is an ordinary `subscribe` subscription at a distinct
explicit path. It receives the same publishing updates as its siblings while
retaining its own agent identity, name, files, chat, onboarding state, and health.

## Why this shape

Catalog identity and installed identity answer different questions. The listing
identifies the publisher's product; a subscription identifies one workspace-local
installation. Reusing that boundary keeps publishing, pull reconciliation,
uninstall, and install counting on the existing marketplace rail.

The first pathless install remains idempotent at the canonical
`agents/<listing agentName>` path. Onboarding and campaign retries depend on that
replay contract. A user-requested additional instance instead supplies a human name
and an explicit derived path, which makes a new subscription without weakening
canonical retries.

The UI deliberately stays small. Gallery is a browsing surface and reports the
listing's installed count, issues, or one listing-level update signal. Listing
detail is the instance manager: it lists the installed agents and offers **Add
another**. Ordinary agent pages continue to own renaming, deletion, configuration,
chat, and onboarding.

## Invariants

- One marketplace listing remains one catalog row regardless of install count.
- Every live installed instance is a distinct subscription and distinct agent row.
- A pathless canonical replay returns the existing live canonical subscription; a
  detached tombstone does not prevent a later fresh install.
- The SPA's additional-instance ceremony always carries a nonblank name and explicit
  normalized path. The public API remains permissive for existing callers. Paths
  and agent slugs remain workspace-unique.
- A requested-path collision is user-mediated. The form proposes an editable
  numeric name, but never silently retries, changes the requested path, or exposes a
  raw path editor. Backend agent registration may still disambiguate the separate
  workspace slug when another agent already owns it.
- Successful installs navigate only through the returned `subscription.agentId`
  after the roster refresh. The client never guesses from listing, path, or name.
- Per-instance rows report health only. Update availability and changelog receipt
  belong to the listing; opening the changelog attempts to acknowledge every unread
  live sibling through the existing per-subscription endpoint.
- Owners and editors may install or acknowledge. Viewers and unresolved roles are
  read-only; server authorization remains authoritative.
- In steady state for an available listing, each live subscription contributes one
  to `listing.installs`; canonical replay contributes none, and uninstall reverses
  its own contribution. Listing takedown intentionally zeros the public count before
  its bounded subscription drain finishes.
- Initial workspace onboarding remains listing-set based. Additional instances are
  created afterward through marketplace detail.

## Code map

- Wire contract: `MarketplaceAgentInstallRequestSchema` and
  `MarketplaceAgentSubscriptionResponseSchema` in
  `packages/contract/src/marketplace/index.ts`.
- Subscription identity, canonical replay, collision refusal, and count increment:
  `createSubscription` in
  `packages/backend/convex/domains/marketplace/model.ts`. Every ordinary live-to-
  detached transition, including uninstall and direct agent deletion, flows through
  `detachMarketplaceAgentSubscription` in
  `packages/backend/convex/domains/marketplace/ownership.ts`, which owns the matching
  decrement.
- Human name to explicit additional-install request:
  `marketplaceNamedInstallRequest` and `nextMarketplaceInstanceName` in
  `apps/web/spa/marketplace/instance-name.ts`.
- Grouping, roster join, aggregate status, health, and changelog receipts:
  `marketplaceListingInstances` and `marketplaceUnreadAcknowledgements` in
  `apps/web/spa/marketplace/instance-projection.ts`.
- Naming, consent, mutation, and collision ceremony:
  `useMarketplaceInstallFlow` in
  `apps/web/spa/marketplace/install-flow.ts`.
- Gallery/detail composition and exact-agent arrival:
  `MarketplaceAgentsRoute`, `MarketplaceListingDetailRoute`, and
  `navigateToInstalledAgent` in `apps/web/spa/routes/marketplace.tsx`.
- Roster/subscription refresh before the arrival callback: the marketplace install
  mutation options in `apps/web/spa/api/query-options.ts`.

The primary behavioral proofs are in
`packages/backend/src/marketplace.test.ts`,
`apps/web/spa/marketplace/instance-name.test.ts`,
`apps/web/spa/marketplace/instance-projection.test.ts`, and
`apps/web/spa/routes/marketplace.test.tsx`. Cache refresh timing is pinned separately
in `apps/web/spa/api/marketplace.test.ts`. The live contract is exercised by the
registered `marketplace` journey in
`packages/test-harness/src/staging-e2e-synthetic`.

## Rejected alternatives

- **Duplicate listings or a marketplace-specific instance table.** They conflate
  publisher identity with installation identity and duplicate lifecycle state the
  subscription already owns.
- **Remove canonical idempotency.** That would make ordinary retry paths create
  accidental agents.
- **Derive identity from display name.** Names are editable metadata and need not be
  unique; subscription and agent IDs are the stable identities.
- **Automatically retry collisions.** A rare collision does not justify hidden
  allocation or client request recovery machinery. The editable suggestion keeps
  the decision explicit and reversible.
- **Per-instance update labels.** All siblings follow the same listing release, so
  repeating the signal on rows implies a distinction that does not exist.
- **Marketplace-owned rename/delete/configuration controls.** Those already have one
  owner on the ordinary Agents surface.
- **Onboarding redesign.** Multi-instance creation is post-onboarding, avoiding a
  larger change to the listing-based picker and campaign retry semantics.

## Visual provenance

No external mockup or uploaded baseline defined this feature. It extends the
existing marketplace visual language and was judged against the pre-change
marketplace route. The durable regression frames live in the
`desktop/playground.spec.ts/` and `mobile/playground.spec.ts/` directories under
`apps/web/tests/visual/__screenshots__/`:

- `marketplace-detail-multiple-en.png` and
  `marketplace-detail-multiple-es.png` pin the compact instance list, simple
  listing-level summary, and row health in both locales.
- `marketplace-install-collision-naming.png` pins the explicit collision recovery
  and read-only agent-folder preview.

These are regression evidence for the shipped composition, not a separate design
system or a reason to broaden marketplace styling.
