# edge

`edge` is Duet's public routing layer for workspace apps, publishes, and tunnel
traffic. It resolves a public host or path through the Convex backend, then
dispatches: app traffic proxies to the workspace VM with its workspace-scoped
gateway bearer; publish traffic branches on the reserved request selectors
(`@repo/contract`'s `classifyPublishRequest`). Standard app and publish traffic live under
the dedicated edge hosts — apps as subdomains
(`{app}--{workspace}.edge.duet.so`), publishes as paths
(`edge.duet.so/{workspace}/{publish}`) — never bare `duet.so`, whose other
subdomains are unrelated deployments. The `edge-staging.duet.so` deployment
accepts the same grammar for staging. Active custom app domains reach the same
admission and VM proxy. The binding is resolved before app-cookie exchange and
revalidated with the durable app identity at admission; it is never cached in the
edge process. A cookie for a deleted app becomes anonymous if its address is
reused; a fresh launch grant for that former app is refused. Credential provenance
is carried to the existing resolver so an obsolete cookie cannot obstruct public
access or private sign-in recovery. Removing the binding therefore stops custom-host admission without
redirecting or disabling the standard address. Embedded apps always launch on the
standard Duet host, so customer DNS cannot become a dependency of the product pane.

Only public custom-host origin content retains the app’s indexing directives.
Standard hosts, private content, authentication exchanges, and errors remain
excluded from indexing. Domain attachment changes an address, never visibility.

App requests carry the resolved original host across VM ingress in a Duet-owned
header. The gateway restores `x-forwarded-host` before forwarding to the app,
because VM ingress replaces ordinary proxy headers with its own hostname. Both
standard and custom hosts use this rail; it carries addressing, not admission.

Publish is a read-only public viewer, not hosting. A bare publish URL (any
ordinary query) serves the anonymous viewer page from the configured apps/web
origin (`DUET_WEB_ORIGIN` / `viewerOrigin` — typed config, never derived from
the inbound `Host`), as do `/_next/*` viewer assets, which are relayed before
publish route parsing can misparse them. Exactly one of `?raw`/`?list`/`?zip`
routes to the gateway's public publish endpoint; more than one at once is a
`400`. The two branches carry disjoint credentials — the credential firewall:
viewer-bound requests are stripped of `cookie`, `authorization`, `host`, and
every caller `x-duet-*` header and carry only the validated viewer descriptor
header, while the gateway bearer rides only the raw/list/zip branch and never
reaches apps/web.
Every publish response keeps `x-robots-tag: noindex` and the bounded cache.
Served-path reporting fires only for successful nested `?raw` files and one
folder-level row per successful `?zip`; viewer, list, conditional, and failed
responses never report.

## App freshness

The edge owns browser and CDN freshness for apps because their addresses and
asset filenames can be edited in place. Proxied app content disables HTTP caching,
regardless of the origin server's caching defaults; publishes keep their separate
bounded policy. Signed launches clear only the app origin's browser cache before
redirecting, preserving cookies and local app data.

Clearing HTTP cache does not reliably evict scripts already held in Chromium's
renderer memory. Apps migrating from long-lived caching must change the URLs of
changed assets; the [build-apps skill](../../packages/skills-registry/skills/build-apps/SKILL.md)
teaches this alongside cache-enabled iframe verification. This limitation applies
to bytes cached before the edge policy, not subsequent edits served under it.

The browser gate (`test:browser`) exercises a warmed iframe document through
the production grant exchange, then edits scripts at the same URL with caching
enabled. It requires the Playwright Chromium binary; ordinary tests stay browser
independent.

## Boundary

The edge app should stay thin. It decides where a public request goes and strips
or adds proxy headers; it does not own app state, publish authorization, or the
gateway routes that ultimately serve bytes from the VM. Those decisions live in
[`@repo/backend`](../../packages/backend/README.md) and
[`@repo/gateway`](../../packages/gateway/README.md).

Long-lived app SSE remains app-owned, but the edge owns its public transport
lifecycle. It ends each public segment before the hosting function ceiling and
cancels the upstream request; native `EventSource` reconnects using the app's
event ids. Ordinary downstream cancellation follows the same path through the
gateway, so an abandoned pane cannot leave an app writer alive. The relay and
its segment policy live beside the app proxy in `src/index.ts`.

It is a raw Web fetch handler for public HTTP routing. The future sync-tunnel
upgrade path still requires the deployed frame-level validation linked from the
root [Deployment (Vercel)](../../README.md#deployment-vercel) section; response
streaming alone is not WebSocket support.

Published responses and the branded paused page intentionally keep the existing
`max-age=30, s-maxage=30` cache bound. A workspace pause/resume or publish
freeze/unfreeze can therefore take up to 30 seconds to replace a warmed edge
response; the resolver is checked again after that bound, without adding a second
backend lookup to the serving hot path. A `?zip` is answered whole: the origin streams the archive with its 200 already committed and no length, so the edge reads it to the end before replying — a stream that breaks is a `502` with `no-store`, never a short body the cache would hand to every installer for the bound's duration — and a whole one carries its exact `content-length` (past 32 MB it streams as before).

## Pointers

- `src/index.ts` owns route parsing, origin resolution, proxy header policy, and
  publish served-path reporting.
- `scripts/build-vercel-output.ts` bundles `src/vercel-entry.ts` into a Build
  Output API function so Node never resolves monorepo TypeScript at runtime.
- `vercel.json` selects that custom build boundary.
