# Drive deep links

Drive folders and files have durable, refreshable URLs under
`/w/<workspace>/files/<path>` and under an opened agent's Files surface. The
router owns navigation history,
while the Files surface remains usable outside a router. Agent links, accepted
shares, and agent-authored messages can therefore land on the filesystem
object they name instead of dropping users at Drive root.

## Why this shape

Drive paths cross two different dialects. Stored anchors and API identities are
relative logical paths; browser paths are absolute and percent-encoded one
segment at a time. Keeping those dialects explicit prevents a literal filename
such as `a%2Fb` from becoming the nested path `a/b`.

The URL, rather than component state, is authoritative so refresh,
Back/Forward, copied links, and cold landings agree. `FilesSurface` is still a
controlled component because playground and dialog fixtures also own it
without React Router.

File URLs retain their file identity while presenting the parent folder and an
open preview. Closing a preview pushes the parent URL instead of calling
history back; this remains coherent after a cold file landing. Missing paths
retain their URL and recover one parent at a time rather than silently
redirecting.

## Invariants

- Each route grammar owns its Files URL: `drive-routes.ts` for the workspace
  Drive and `agents-map-url.ts` for an opened agent. Both consume the same path
  dialect seam, and parsing works from raw segments rather than a pre-decoded
  router splat.
- `apps/web/spa/files/lib/paths.ts` is the sole anchor-path ↔ browser-path
  dialect seam. Conversions preserve filename bytes and reject non-canonical
  inputs instead of repairing them into another identity.
- `apps/web/spa/files/lib/files-view.ts` owns stat/list branching and the
  `folder | file | not-found | error` result. Folder operations consume its
  resolved `folderPath`, never the untrusted URL path.
- Every folder represented by the open column chain remains an active view,
  not merely navigation history. Each column periodically revalidates its own
  cached listing so external writes appear in ancestors and the current folder
  without blanking the browser or requiring another navigation.
- `FilesSurface` receives `path` and `onNavigate`; it does not import router
  hooks or keep an authoritative current-path state.
- Logical Drive paths never decode percent signs. Raw URL segments decode
  exactly once, then pass through logical validation. Decoded separators,
  traversal, reserved paths, malformed escapes, and NUL bytes fail closed.
- VM-absolute file paths are a read-only compatibility transport. The gateway
  strips only the exact configured Drive root after one URL decode; PUT,
  DELETE, and JSON actions remain relative-only.
- A successful share acceptance can briefly retry only its returned mount
  path. Ordinary missing URLs do not become polling loops.
- Agent-authored links are root-relative and use the registered display name
  as text. The staging oracle independently derives the expected href instead
  of importing the web builder.

## Code and proof

The main mechanics live in:

- `apps/web/spa/drive/drive-routes.ts`
- `apps/web/spa/files/lib/paths.ts`
- `apps/web/spa/files/lib/files-view.ts`
- `apps/web/spa/files/files-surface.tsx`
- `apps/web/spa/files/files-not-found.tsx`
- `packages/contract/src/drive/index.ts`
- `packages/gateway/src/routes/files.ts`
- `packages/skills-registry/skills/manage-agents/SKILL.md`
- `packages/test-harness/src/staging-e2e-synthetic`

Behavior is pinned by the adjacent route/path/view tests, gateway route tests,
API and browser proxy tests, CLI/MCP tests, and
`staging-e2e-synthetic`.

The full implementation decision audit is preserved in
[choices.md](choices.md).

The product-derived desktop and mobile baselines are
`files-nested-folder.png`, `files-not-found.png`, `files-deep-file.png`,
`files-dotfile-folder.png`, `files-dotfile-file.png`, and
`agent-anchor-link.png` under
`apps/web/tests/visual/__screenshots__/<viewport>/playground.spec.ts/`. They
preserve the existing Drive presentation while adding addressable states; no
external reference image was used. The narrow agent-anchor shot deliberately
isolates the new affordance because the broad agent canvas carried unrelated
historical drift. Session-authored Drive links deliberately retain the shared
Markdown renderer's existing styling, so their visual standard is parity with
other authored links rather than a feature-specific treatment.

### Staging verification

The Drive journey is required by the complete `bun run e2e:staging` suite and
is also independently runnable:

```bash
bun run e2e:staging -- --journey drive-deep-links
```

The focused form provisions only the reusable workspace-browser fixture, then
emits the same journey evidence and verifies the same cleanup ledger as the
complete suite. Passing that slice is sufficient staging evidence for this
spec; the complete multi-journey run remains the broader periodic gate.

## Decisions and dead ends

- Query parameters were rejected because the route already has share-flow
  query state and path URLs express filesystem hierarchy directly.
- A discriminated folder/file navigation payload was rejected: both identities
  use the same byte-level URL grammar, and distinct builder names carry enough
  call-site intent.
- Importing the web URL builder into staging acceptance was rejected as
  self-confirming evidence; the harness keeps an independent grammar oracle.
- Global retry of missing paths was rejected. Only a just-accepted share has
  provenance that justifies bounded materialization retry.
- Recursive percent decoding was removed after it proved that distinct logical
  filenames could alias separators or traversal. Compatibility is handled at
  the raw route boundary with one decode, not by weakening logical identity.
- Reusing the publish viewer's history controller was rejected because Files
  already lives inside the product router; only its stat-then-branch resolution
  precedent transfers.

## Deliberate follow-ups

Drive rows and breadcrumbs remain buttons rather than anchors, so middle-click
and native copy-link affordances are separate work. Activity entries still
target a file's parent. Search text and hidden-file preference remain local UI
state. None of these weaken durable folder/file identity.
