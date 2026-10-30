# Inline Media + Developer System Prompt — Rationale Record

Closed 2026-07-23. Shipped to staging (merged via `55a5640c`, an ancestor of
`origin/staging`); the companion comment fix lives in the external duet-agent
repo as commit `c4fafc9`. Outcome at close: all code slices shipped, with
local gates green at build time; the VM image rebuild, production image
promotion, and live staging proof session were cancelled by Example User at closeout
(recorded here — the instruction lives only in the session conversation), and
he assigned the full staging e2e to a separate session. As of this close no
live staging session had demonstrated the feature end-to-end; the closed
state is "shipped, live verification not yet performed."

## What shipped

Every gateway-launched agent session receives a developer-owned base system
prompt teaching a pure-markdown inline-media convention, and the web session
surface renders that convention: `![desc](path)` becomes an inline image,
`<video controls>`, or `<audio controls>` by extension; `[name](path)`
becomes a file-download card when it names a drive path whose final segment
has an extension (extensionless and remote links stay ordinary anchors);
relative paths resolve against the session cwd;
VM-absolute paths are contained by the gateway; `http(s)` URLs hotlink
directly; everything unservable renders as a dead link.

`MAP.md` beside this file is the quadrant-walk decision record the build was
bound to; `choices.md` is the final audited ledger of the decisions made on
Example User's behalf *beyond* the map and slice files (map-level decisions were
Example User's own); `PROMPT-DRAFT.md` is the wording provenance for the prompt —
approved in the walk, later amended once (scheme-less origin; the original
wording and the reason are the first entry in `choices.md`), and superseded
by the code constant.

## The reason it works this way

- **The wire format is pure CommonMark, not a custom scheme.** v1 used
  `sandbox://` URLs; v2 deliberately doesn't. An agent that emits standard
  markdown degrades gracefully in any renderer, needs zero knowledge of the
  product's URL topology, and — decisively — react-markdown's default
  sanitizer *strips* unknown schemes, so `sandbox://` would have required
  renderer surgery just to survive.
- **The frontend resolves paths at render time; the backend never rewrites
  message markdown.** Three forces: session events stream token-by-token (a
  server-side rewriter would have to buffer or risk mangling half-emitted
  links), stored absolute URLs rot when hosts move (the edge-hosts cutover
  was fresh proof), and file access is authenticated (a baked URL either
  embeds an expiring token or points at the authed endpoint the client can
  already build).
- **Path resolution splits at the network boundary.** The SPA does
  drive-relative *string math only* (join cwd, classify remote/drive) and
  provably never learns the VM's filesystem layout; the gateway — the only
  component that knows the live `driveDir` — does *filesystem containment*.
  The client URL is the wire contract between them: a leading slash rides as
  `%2F` — several encodings survived the measured proxy hops, and `%2F` was
  selected as the single blessed format (one encoding layer, readable
  separators; see the probe tests named below) — and the gateway strips its
  live drive prefix before the shared normalizer judges the remainder.
- **The developer prompt is gateway source, not an agent default.** Standalone
  `duet` CLI keeps no product identity (a deliberate walk decision, P1); the
  gateway injects `DEVELOPER_SYSTEM_PROMPT` via the pre-existing
  `--system-prompt` argv seam. The layering (above the user's per-agent
  `AGENTS.md`) and subagent inheritance are enforced in the external
  duet-agent repo (`src/turn-runner/prompts.ts`); this repo proves only the
  argv injection.

## Invariants (what must stay true)

- The SPA contains no VM path knowledge: no `DRIVE_ROOT_PATH` import, no
  `/home/synthetic-user/drive` literal (pinned by
  `apps/web/spa/no-vm-layout-in-web.test.ts`).
- `normalizeDrivePath` stays pure, strict, and relative-only; runtime-dir
  containment lives in the gateway route. One decode policy owns both paths:
  the contract's private `decodePathSegments`, which the normalizer calls
  directly and the gateway reaches through its exported alias
  `decodeDrivePathBounded`.
- Absolute-path admission is read-only (GET/stat/list); writes and the
  anonymous publish surface stay drive-relative.
- Markdown component types are render-stable — inline-arrow component
  defaults remount whole subtrees on every streamed chunk and reset media
  playback. Guarded by the streaming node-identity Playwright test.
- The shared `Markdown` component stays media-agnostic; media semantics live
  only in `SessionMarkdown`. Today only session surfaces opt in (a
  convention, not a boundary-enforced rule); the no-`components` render is
  pinned byte-identical for everyone else.
- `DEVELOPER_SYSTEM_PROMPT` stays byte-stable to protect provider prompt
  caching — structurally, by being a plain module constant with no per-turn
  interpolation; drift is guarded by sentence pins and size bounds, not a
  full snapshot. It also stays scheme-less (`Duet (service.example.invalid)`): the
  `legacy-product-origin` boundary gate scans the on-disk `apps/api/` tree
  including its `dist/gateway-release` bundle (which vendors gateway code)
  and correctly rejects the v1 origin URL there.
- User and agent messages render through the same component: users' own
  `![]()` embeds too, deliberately.
- No `?v=` cache-busting on message media: unversioned browser-proxied reads
  are `private, no-store`, so staleness cannot occur.
- Remote media hotlinks (viewer-IP leak and host-death accepted); the
  expected upgrade path, if ever needed, is a camo-style proxy — a design
  note, not built.

## Pointers into the code

- Prompt text + injection: `packages/gateway/src/runner/developer-system-prompt.ts`,
  `defaultRunnerFactory` in `process-runner.ts` (+ its argv tests).
- Path resolvers (pure): `apps/web/spa/sessions/media-kind.ts`,
  `media-src.ts` (cwd canonicalization lives here) + table tests.
- Renderer/owner: `apps/web/spa/sessions/session-markdown.tsx`
  (`SessionMarkdown`, `FileCard`, the file-like-final-segment link rule);
  threading in `routes/sessions.tsx` (`sessionTimelineCwd`).
- Shared seam: `packages/ui/src/components/common/markdown.tsx`
  (`components` prop, module-stable defaults, memoized merge).
- Client URL: `workspaceFilePath` in `apps/web/spa/api/client.ts`
  (leading-slash → `%2F` branch).
- Gateway containment: `stripLiveDrivePrefix` in
  `packages/gateway/src/routes/files.ts`;
  `decodeDrivePathBounded` in `packages/contract/src/drive/index.ts`.
- Wire-format evidence: `files-absolute-path.probe.test.ts` (gateway),
  `client-absolute-path.probe.test.ts` (api),
  `duet-proxy-absolute-path.probe.test.ts` (web) — originally the slice-00
  measurement probes, flipped to pin the shipped contract.
- Visual standard: `session-inline-media` playground fixture + its
  desktop/mobile baselines under `apps/web/tests/visual/__screenshots__/` —
  the accepted rendering of every media form. The fixture, not an external
  image, is the visual provenance; the unprimed critique at acceptance is
  process history recorded in `choices.md`.

## Dead ends and divergences from the plan

- **v1's `sandbox://` scheme** — rejected in planning (see MAP ledger #2);
  reasons above.
- **Backend URL rewriting** — rejected (MAP ledger #3); reasons above.
- **Frontend prefix-stripping of VM-absolute paths** — the walk briefly held
  this shape; killed in favor of gateway-side containment when Example User asked
  why the frontend should know the VM layout at all.
- **`https://service.example.invalid` in the prompt** — the approved wording tripped the
  `legacy-product-origin` gate inside the built gateway bundle; shipped
  scheme-less rather than weakening the gate (needs-user entry in
  `choices.md`).
- **A session-local paragraph override for streaming stability** — the
  delegated implementer's working fix, replaced during pre-commit
  integration (so no intermediate exists in git) by fixing component
  identity in the shared owner, letting all consumers inherit it. The
  failure mode is worth remembering: an inline-arrow default component is a
  new React type every render.
- **A private copy of the bounded decoder in the gateway** — also replaced
  during pre-commit integration by the contract export; two byte-identical
  decoders are a drift seam.
- **Literal-`%` filenames** — surfaced by review as broken on the new path;
  found to be unservable product-wide by pre-existing decode policy;
  deliberately left alone.
- **Slice 06 as planned (image rebuild → prod promotion → live proof →
  e2e)** — cancelled/deferred by Example User at closeout: the prompt ships via the
  gateway release rail, making the rebuild optional (two build attempts had
  also died on a full host disk). At close, no live inline-image staging
  proof or e2e had run for this feature; Example User assigned that verification to
  a separate session.

## Environment findings at build time (already partly resolved upstream)

Three failures reproduced on the clean base during the build and were
documented as inherited, not this feature's: `agent-detail` playground
baseline drift, `lander#visual` under `ui:check --all`, and 3 local
`convexDev` harness failures. The first two were re-baselined upstream by
staging commit `b254fbc3` shortly after; the `convexDev` failures' current
status was not re-established at close.
