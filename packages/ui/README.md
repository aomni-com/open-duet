# ui

`@repo/ui` owns backend-independent visual primitives shared by Duet apps. Components accept data and callbacks; they do not own identity, persistence, product routing, or network access.

Product-specific composition stays in the consuming app. If a component cannot render in a hermetic playground without backend providers, split its presentation from its data owner rather than widening this package.

Portaled overlays inherit `OverlaySuspendedContext` from their owning surface. A suspended scope
removes overlays and their focus traps while preserving the parent form state. This complements
DOM `inert`, which cannot reach a portal mounted elsewhere in the document; product code decides
when to suspend a scope.

Information density is a static default owned by the shadcn primitives. Consumers may override a
specific component through `className`; a global density preference or provider does not belong in
this package unless the product gains an actual runtime density setting.

Shared primitives keep an independent code-derived coverage ledger, but their
screenshots remain owned by one real consuming-app fixture or route. This proves
every export without creating a second baseline corpus for the same pixels.

Quality selection stays one primitive across compose and settings so option semantics and
mobile/desktop interaction cannot drift; each surface chooses only its trigger presentation.

Component contracts with their own integration rules:

- [Compose bar](src/components/compose-bar/README.md) — a controlled, provider-agnostic message composition surface.
