# Agent Drive — interview delta (post-map decisions)

Decisions made after `map.html` was frozen. These override the map where they conflict.
Dates: 2026-07-06.

## Identity & auth

- **Fresh start.** Separate Convex deployment; no data migration from chat-app; chat-app keeps running untouched.
- **WorkOS is dropped.** Auth substrate = **Convex Auth** (`@convex-dev/auth`): Google OAuth + magic links, sessions/JWTs in our own tables. Agent-native registration/device-code pairing built on top of our own session layer (research item feeds this).

## Launch line

- **Full product before launch** — the entire slice ladder including billing. No partial/alpha line.

## Apps model (revised from the map)

- An app is a **backend entity, not a file**: `{workspace, anchorPath, command/port, slug, visibility}`. Registered via one API call (`POST /apps {path}` from agent/CLI/MCP). No `public.config.json`-style manifest; run config is pushed down to the origin gateway from the backend.
- **Apps belong to folders** (anchored to a folder path). Sharing carries apps by **backend join**, not file sync: recipients of a folder share see its apps projected into their view.
- **One canonical instance**: an app runs only on the origin workspace's VM. Recipients never run copies — even a recipient-registered app (allowed with **write** share mode) is created on the origin workspace and runs on the origin VM, **origin pays** (company-covers-the-bill use case). Read-only sharees cannot register apps.
- **Live sync, no deploy gate**: synced file changes take effect in running apps immediately; every (re)deploy is an **audit-log** event. Accepted consequence (named, not hidden): the write-share graph is a code-deployment graph onto the origin VM; audit is the control.
- **App access mirrors folder access** (anyone who can read the anchor folder can visit the app URL), re-evaluated at request time; plus explicit `public` escalation settable only by the origin. Share revoke kills URL access.

## Publishing & URLs

- Published files/folders get a **stable, user-editable slug**, workspace-scoped: `service.example.invalid/{workspace}/{slug}`. Apps stay on subdomains (`{slug}--{workspace}.service.example.invalid`) because they need path space. Separate slug namespaces (app vs publish) sharing one reserved-word list.
- Published URLs serve **live content** (etag/short-TTL caching); moves preserve slugs and sharing settings via anchors. Slug edits leave no redirects.
- **Published folders are forward-inclusive** (everything under them, forever-forward): loud confirm at publish, `.env*` never served, new-file-in-published-folder is an audit event.
- **Workspace rename exists** but with a loud warning: it breaks all public URLs (no redirect machinery).

## Sharing semantics

- **Transitive re-sharing allowed** for both read and write recipients; a re-share grants at most the sharer's own mode. Revocation cascades through the re-share subtree.
- Share mounts cannot nest inside already-synced subtrees (sync-loop prevention).
- Per-share ignore patterns are user-editable; the only default entry is `.env*`. Deliberately NOT ignoring `node_modules/` or `.git/` — shared folders that are git repos are a supported use case.
- Conflict files (`.sync-conflict-*`) are not special-cased inside app folders.
- Sync transport between VMs (spike-proven 2026-07-06): **TCP-over-WebSocket tunnel** through exe's edge with VM-scoped tokens (`X-Exedev-Authorization`); no raw TCP exists between VMs (isolated netns, identical IPs). Fallback: external Syncthing relay.

## Named single-owner concepts (refactor-clean invariants)

- **Anchor**: one backend entity `(workspace, path, kind: app|publish|share-root)` with stable identity, rename tracking (gateway re-anchors obvious renames; anything else → loud `broken` state, never guess), and settings that survive moves. Apps, publishes, and share roots are its three consumers.
- **Audit log**: one per-workspace stream; writers include redeploy, publish, share create/revoke/re-share, visibility change, domain attach, workspace rename, recipient app registration (with provenance).

## Billing & attribution

- Credits/ledger/usage ported from chat-app per the reuse inventory (`scratchpad` report; distill into spec): micro-USD ledger, preflight gating, Stripe auto-topup, daily/monthly rollups. Org → workspace re-scoping; trial grant gets a new single owner; per-user API keys become usage attribution; reservation rows redesigned as hold/settle/release events unless a strong reason emerges.
- **No per-app spend caps** — workspace-level spend cap only (anti-feature-bloat).
- Per-app usage attribution by authenticated visitor appears in daily/monthly reports.

## Other

- CLI name: **duetfs** (bare npm free — register early).
- Taste rules from the interview: no feature bloat; simplest-most-proven; suggestions may be overridden when a better way exists but say so.
