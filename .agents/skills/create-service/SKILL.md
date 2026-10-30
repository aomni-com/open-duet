---
name: create-service
description: Add or maintain a catalogued vendor service. Use when admitting a new provider, adding routes, reconciling a vendor API change, or updating a service skill.
---

# Create a service

Treat the catalog as the contract and skills as clients. The catalog decision comes first; skills may only use routes the catalog already admits.

## Workflow

1. Start from the provider's official API reference, authentication guide, pricing/usage documentation, and resource lifecycle documentation—not from the current catalog or skill. Build an independent route inventory before editing code, record the source links and review date in the service README, and include every relevant method and path: read, poll, mutation, delete, and list routes. Reconcile that inventory against the existing definition only after the independent pass; an existing route list is evidence to check, never evidence of completeness.
2. Classify every route: admit it, or record the explicit security reason for excluding it. Exclude only routes that expose Duet subscription/user data, enumerate a shared resource that cannot be partitioned, or cross another security boundary. A vendor's list route is not automatically safe.
3. Decide ownership for shared resources before admitting routes. Track stable ids with the workspace creator, allow intended shared reads/uses, restrict mutation/deletion to the creator, and attach provider cleanup with a bounded TTL. Omit discovery when it would enumerate private ids; saved ids can still work.
4. Add the service definition under `packages/service-catalog/services/<id>/definition.ts`, its rationale under the matching service README, and route-lock/fixture/probe coverage. Keep `src/vendors.ts` as an index only.
5. Update every affected registry skill to use `$DUET_API_URL/v1/services/<id>` and only catalog-admitted paths. Do not copy vendor credentials into skills. Query strings are opaque unless the catalog auth scheme owns a credential parameter.
6. Regenerate embedded skills and run the catalog, API proxy, type, and route-coverage checks. Review the diff for any direct vendor URL, undocumented route, or route present in the official inventory without an explicit admit/exclude decision.

## Completion

A service is complete only when its official route inventory has an explicit admit/exclude decision, every admitted route has a catalog definition and useful verification signal, every skill example resolves to an admitted proxy path, and the focused checks pass.
