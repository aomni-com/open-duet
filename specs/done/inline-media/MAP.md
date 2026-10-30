# Inline Media + Developer System Prompt — Quadrant Map

> **CLOSED 2026-07-23.** The feature shipped; `README.md` beside this file is
> the rationale record. This map survives as the planning-decision provenance
> (who closed what, and why) — it no longer routes work.

Walked 2026-07-23 with Example User. This map was binding input for write-spec: every
decision below was a given, not a discussion to reopen. Feature = give the duet
agent a developer-owned base system prompt (main agent + all subagents) that
teaches the inline-media markdown convention, and make the web app's message
component render that convention (images, video, audio, file links) from both
drive paths and remote URLs.

## Quadrant 1 — Known knowns (settled ground)

- **No developer system prompt exists today.** `systemInstructions` is empty in
  production: the gateway never passes `--system-prompt`
  (`packages/gateway/src/runner/process-runner.ts:284`) and the RPC `start`
  payload carries only mode/state/mcpServers
  (`packages/gateway/src/agent-sessions/coordinator.ts:434`). The flag already
  parses on the agent side (`duet-agent/src/cli/rpc.ts:375`).
- **Layer order is already right.** `createSystemPromptWithAppendedLayers`
  (`duet-agent/src/turn-runner/prompts.ts:40`) puts `systemInstructions` above
  the AGENTS.md file layers — developer prompt outranks user prompt. State
  agents inherit `systemInstructions`, so subagents are covered by the same
  flag.
- **v1 template**: `chat-app/packages/agent-gateway/src/system-prompt.ts`
  (`buildBaseSystemPrompt`) — identity / language / data display / file
  handling / environment / integrations.
- **Renderer**: `packages/ui/src/components/common/markdown.tsx` —
  react-markdown + remark-gfm + remark-math, `skipHtml`, `a` and `p` overrides
  only. Relative URLs pass its sanitizer untouched; custom schemes (e.g. v1's
  `sandbox://`) would be stripped.
- **File serving is already sufficient**: gateway files route
  (`packages/gateway/src/routes/files.ts`) supports range requests (`:431`),
  correct MIME for video/audio (`:1168`), and sets
  `content-security-policy: sandbox` + `nosniff` on every response (`:1159`) —
  the stored-XSS question for SVG/HTML is already answered. The API proxy
  forwards `range` (`apps/api/src/gateway/client.ts:44`). `<img>` auth against
  this endpoint is proven in production (`apps/web/spa/apps/app-icon.tsx:50`).
- **Session cwd is already client-visible**: persisted
  (`packages/backend/convex/domains/agentSessions/model.ts:84`) and included in
  the session shape (`agentSessionsShared.ts:107`). Drive-relative by contract
  (`AgentCwdSchema`, `packages/contract/src/agent/index.ts:730`).
- **URL builder exists**: `workspaceFileDownloadUrl`
  (`apps/web/spa/api/client.ts:373`).
- **Drive root**: gateway env `DUET_DRIVE_DIR=/home/synthetic-user/drive`
  (`packages/vm-image/systemd/duet-gateway.service:14`); contract constant
  `DRIVE_ROOT_PATH` matches (`packages/contract/src/drive/index.ts:1`).
- **Stale comment to fix while in there**: `duet-agent` `prompts.ts:69` claims a
  production chat-assistant persona that does not exist.

## Quadrant 2 — Known unknowns (decision ledger)

| # | Question | Decision | Closed by |
|---|---|---|---|
| 1 | Which v1 prompt sections port | All six, adapted: identity rewritten for v2 (workspace/VM/drive), data-display + file-handling rewritten around relative paths, language verbatim, environment from the real Dockerfile, integrations rewritten, user-files block dropped (AGENTS.md layer owns it) | Example User |
| 2 | Media markdown contract | Standard markdown only: `![desc](path)` = embed inline (image/video/audio by extension), `[name](path)` = file reference; `http(s)` URLs pass through untouched; raw HTML stays stripped; no custom URL scheme | Example User (earlier in session) |
| 3 | Who resolves paths | Frontend at render time; backend never rewrites markdown (streaming would force buffering, absolute URLs rot, auth URLs expire) | Example User |
| 4 | Path anchors | Relative → frontend joins session cwd (pure drive-relative string math). Leading `/` = VM filesystem root, forwarded verbatim to the files endpoint; the **gateway** resolves-and-contains against its live `driveDir` (404 outside). Frontend never learns VM layout | Example User + one-owner altitude |
| 5 | Renderer scope | Full set in first cut: `<img>`, `<video controls>`, `<audio controls>` by extension sniff + file-card-styled links for other extensions | Example User |
| 6 | Delivery seam | Existing `--system-prompt` argv flag added in `defaultRunnerFactory`; no protocol change | Example User |
| 7 | Where prompt text lives | Gateway package in duet repo (developer-owned source), built per-session (static text; cwd/date layers already exist agent-side) | Settled assumption, unobjected |
| 8 | Environment section source | `packages/vm-image/Dockerfile` (Node 24, Bun, Python 3 + pip list at `:135`, apt list at `:51`) | Territory |
| 9 | Agent flag compatibility | `--system-prompt` parsed since duet-agent v0.1.66; VMs run 0.3.1 — no deploy-ordering hazard | Territory |

No OPEN items.

## Quadrant 3 — Unknown knowns (extracted context)

- **Prompt draft S1–S6 approved as drafted** (see `PROMPT-DRAFT.md` beside this
  map) with two amendments from the landmine sweep: S3 gains the
  percent-encode-spaces sentence, S4 regains v1's "don't put files in `.duet`"
  line.
- **P1 — standalone CLI**: `duet` run outside the product intentionally gets no
  Duet identity; prompt is gateway-injected only. No duet-agent default.
- **P2 — vocabulary**: "workspace / drive / sessions / Files view" is blessed
  agent-facing v2 vocabulary; "relays" for state machines (that layer already
  exists agent-side). `service.example.invalid` is the right self-description.
- **P3 — done bar**: VM image rebuild + live staging test. Prompt change itself
  rides the gateway release rail (no rebuild strictly required), but Example User
  wants the rebuild + staging session showing an inline image before done.

## Quadrant 4 — Unknown unknowns (landmine cards)

1. **DECIDED — normalizer rejects the new contract.** `normalizeDrivePath`
   returns `reason: 'absolute'` for leading-`/` paths
   (`packages/contract/src/drive/index.ts:23`); the files route runs everything
   through it (`files.ts:712`). Fix: gateway files route strips its **live
   `driveDir`** prefix (not the `DRIVE_ROOT_PATH` constant — env override could
   desync them) before normalizing; still-absolute paths 404. `..` and
   reserved-segment rejection stay as is.
2. **DECIDED — shared Markdown component, six consumers.** Overrides must be
   injected (optional resolver prop or `SessionMarkdown` wrapper), never baked
   into `packages/ui/.../markdown.tsx`. Consumers: session-message,
   ordered-agent-parts, files/markdown-preview, official-agents/detail-page,
   agents/agent-detail-canvas, playground demos. Follow-up (out of scope):
   markdown-preview could opt in with resolve-relative-to-md-file — GitHub
   README semantics.
3. **DECIDED — `.duet` is reserved/unservable** (`drive/index.ts:33`); prompt
   S4 warns the agent off it.
4. **DECIDED — spaces break image syntax silently**; prompt S3 tells the agent
   to percent-encode; gateway already percent-decodes segments.
5. **Sharp edge — streaming remounts media.** Key `<video>`/`<audio>` by `src`
   so playback survives re-renders while the message tail streams in.
6. **Sharp edge — user messages render through the same `MessageMarkdown`**
   (`session-message.tsx:87`): users' own `![](...)` embeds too. GitHub-like;
   deliberate, not a bug.
7. **Sharp edge — remote media is hotlinked**: viewer's browser fetches remote
   URLs directly (IP leak to linked host, dead images if host dies). Accepted
   for now; the known upgrade path is a camo-style proxy, and the markdown
   contract wouldn't change.

## Facts the builder must confirm before coding

> **SUPERSEDED 2026-07-23** — all three were answered during write-spec draft
> recon; the build has since shipped and `README.md` is the closed record
> (the slice ladder was collapsed at close).
> Answers: (1) `MessageMarkdown` is duplicated byte-identically in
> `session-message.tsx` and `ordered-agent-parts.tsx` — slice 04 unifies both
> into one `SessionMarkdown` owner. (2) Proxy leading-slash fidelity is
> unproven — the client strips leading slashes today — and slice 00 exists to
> measure it. (3) No `?v=` needed: unversioned browser-proxied reads are
> `private, no-store`, so regenerated media cannot go stale.
