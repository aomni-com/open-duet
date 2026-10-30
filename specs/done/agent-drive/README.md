# Agent Drive — Duet v2 (shipped record)

Duet v2 is **API-first infrastructure for agents**: a shared cloud drive that any
agent (Claude Code, Codex, OpenClaw) reaches through the `duetfs` CLI or the hosted
MCP server. One workspace = one always-on exe.dev VM; that VM's disk **is** the drive
and the single source of file truth. Files, memories, folder sharing with live sync,
hosted apps, published URLs, an agent-session harness, model/integration passthrough,
and prepaid billing all sit behind one authenticated API that the web app is just
another client of.

This document is the **why and the invariants**, not the how. The code is the source
of truth for mechanics; this points into it. Everything below is shipped and on
`main` (built as slices 00–20 over 2026-07-06; slice history collapsed into this
record). What is _not_ done is the deferred `@duetso/agent` CLI track and the launch
human-gates — both called out explicitly under "Not shipped" so no reader assumes
otherwise.

## Why it is shaped this way

- **Ride the agent ecosystem; don't compete with it.** v1 failed by asking users to
  adopt a new web app _and_ a new harness. So the agent-facing surface (CLI, MCP,
  memory, files) is the spine, and the web app + Duet's own harness are layers on top
  of the same `service.example.invalid/v1`. Priorities throughout favored the agent surface first.
- **The VM disk is truth, not a cache.** exe.dev VMs are always-on with a persistent
  disk and _no_ memory snapshot (a "resume" is a cold reboot). That single platform
  fact shaped everything: liveness is gateway heartbeats (never a lobby `ls`, which
  lies), backups are `cp`/tar not memory snapshots, and there is no wake-on-request
  logic anywhere.
- **Three separate truths, one owner each.** Convex owns metadata; the VM disk owns
  files; `@duetso/agent`'s SQLite owns memory. No second copy of any of the three.
  This is why memory is never stored in Convex and files are never mirrored to
  metadata.
- **Everything authenticates; capability-URLs are banned.** Every API/gateway/edge
  route checks its caller. Access to apps/publishes is re-evaluated per request, not
  granted by an unguessable URL. This was a direct correction of a v1 landmine
  (`cors()`-only gateway).
- **Ported, not reinvented, where v1 was sound.** Credits/ledger, usage rollups,
  Stripe, the app supervisor, redaction, and scrape mechanics were transplanted from
  the internal `chat-app` (re-scoped org→workspace) per
  `research/chat-app-reuse-inventory.md`. Greenfield only where v1 had no answer or a
  cautionary one. The end state reads as designed-today; a reader can't tell ported
  from new.

## Architecture (where the code lives)

Turborepo, Bun workspaces. Read `AGENTS.md` / the root README for commands.

- `packages/contract` — the ONE home for shared shapes: `scopes` (the
  `ws:{slug}:{capability}` grammar), `slug` (one reserved-word list for
  workspace/app/publish namespaces), `drive` (`DRIVE_ROOT_PATH`, `normalizeDrivePath`,
  `assertPathOutsideDriveRoot`), plus `anchors`/`apps`/`publishes`/`shares`/`edge`/
  `memory`/`agent`/`ledger`/`billing`/`model-gateway`/`redaction`/`resources`. CLI,
  MCP, API, gateway all import from here so shapes never drift.
- `packages/exe` — the ONLY exe.dev control-plane client (`ExeClient`) + probe
  scripts. Promoted from the v1 `exe-sandbox` benchmarks.
- `packages/backend` — Convex: `domains/{users,workspaces,apiKeys,audit,anchors,apps,
publishes,customDomains,shares,credits,modelGateway,train,agentSessions,edge}`.
  Metadata source of truth; `@convex-dev/auth` (Google + magic link).
- `packages/gateway` — in-VM Hono service (systemd unit). `routes/{files,memory,
anchors,apps,publishes,sync,tunnel,agentSessions}` + `runner-manager`,
  `runner-cpu-cap`, `orphan-runner-sweep`, `ensure-runner-binary`. Default-deny auth;
  only `GET /healthz` is open.
- `packages/vm-image` — Dockerfile (`FROM boldsoftware/exeuntu`, user `exedev`) +
  systemd units (`duet-gateway.service`, `duet-syncthing.service`) + build/push script.
- `packages/sync-tunnel` — TCP-over-WebSocket framing + `TunnelToken` (HMAC/nonce) for
  VM-to-VM traffic.
- `packages/duetfs` — the `duetfs` CLI (npm name registered). Thin client over
  `service.example.invalid/v1`; `ws:/path` address grammar; `~/.duet/config.json` at 0600.
- `packages/importers` — quarantined Claude Code / Codex / OpenClaw transcript parsers.
- `packages/test-harness` — `dockerCliEnv`, `exeVmPool`, `convexDev`, `mcpHarness`,
  and the `demo-60s` acceptance probe.
- `apps/api` (Hono/Vercel — the v1 front door), `apps/edge` (host routing + WS tunnel),
  `apps/mcp` (hosted MCP façade), `apps/web` (Next 16 landing + self-install + settings).

## Invariants (must keep holding)

These are the rules the code enforces; violating one silently breaks the product.

1. **Path identity has one owner: the anchor.** `anchors {workspace, path, kind:
app|publish|share-root, settings, state}` (`packages/backend/convex/domains/anchors`).
   A rename re-anchors ONLY when the gateway watcher reports a single candidate whose
   inode AND `.duet-anchor` marker file both match; every ambiguous case →
   `broken`, never a guess. Apps/publishes/share-roots consume anchors; none
   reimplements rename/settings tracking. (Pinned:
   `packages/backend/convex/domains/anchors/renameDecision.ts` +
   `packages/backend/src/anchors-rename-decision.test.ts`; the marker defeats ext4
   inode reuse — see Dead ends.)
2. **Audit log is the one provenance owner.** One per-workspace stream
   (`domains/audit`); every redeploy/publish/share/visibility-change/domain-attach/
   rename/takedown/key-mutation writes through the single `writeAuditEvent`. No inline
   inserts.
3. **The ledger is the only money mover.** All balance movement goes through the
   slice-09 primitives (`domains/credits/internal.ts`: `applyLedgerEntry` +
   `applyLedgerEntryWithDb`, `reserveCredits`, `settleReservation`,
   `releaseReservation`, `runPreflight`). Every _externally reachable_ ledger writer
   is internal-key-only (`assertLedgerWriter` throws without it); the one
   system-initiated write is the trial grant
   (`domains/credits/grants.ts:grantTrialCreditsForWorkspaceActivation`), fired only
   from workspace activation (not client-reachable). Spend surfaces (agent sessions,
   model gateway — `apps/api/src/index.ts:requirePreflightedSpendWorkspace`) are
   preflight-gated _before_ they act. The Stripe webhook (`apps/api/src/index.ts`
   route `/v1/stripe/webhook`) credits only via the same primitive, with double
   idempotency (event id + ledger `reference`). No parallel ledger writes anywhere.
4. **Drive-root containment.** User files live under `/home/synthetic-user/drive`; memory
   SQLite and `.duet/` gateway state live OUTSIDE it and are unreachable through the
   files API or any share root (`.duet`/outside-root → 404, no path oracle —
   `packages/gateway/src/routes/files.ts:safeExistingPath` +
   `packages/contract/src/drive`). `.env*` is excluded from PUBLIC serving (the edge
   app/publish paths) and from sync (`.stignore` default) — an authenticated
   `files:read` caller can still read its own `.env` through the files API, which is
   intended; the guarantee is "never served publicly, never synced," not "never
   readable by an authorized owner." Shares only mount under the drive root.
5. **Liveness is heartbeats, never the lobby.** `workspaces.lastHeartbeatAt`; stale
   > 2min ⇒ `unhealthy`. `ExeClient.stat`/`ls` is used only for metering, never to
   > decide a VM is alive. No wake-on-request.
6. **No raw TCP between VMs.** exe VMs have isolated netns/identical IPs; all VM-to-VM
   traffic (Syncthing sync) rides the `sync-tunnel` WS through exe's edge with
   `X-Exedev-Authorization` + a `TunnelToken`. Syncthing discovery (global/local/relay)
   is disabled.
7. **Human approval is non-bypassable in pairing.** RFC 8628 device flow
   (`domains/apiKeys`): polling before a human approves never yields a key; unknown
   device codes are indistinguishable from pending (no oracle); keys are
   `duet_sk_` with sha256-at-rest, `workspaceIds` pinned at issuance, and a live role
   recheck per request.
8. **One canonical app instance, on the origin VM.** Apps run only on the origin
   workspace's VM; recipients (write-share) can register but the entity+process live on
   the origin and the origin pays. Live sync = no deploy gate; every (re)deploy is an
   audit event. **This makes the write-share graph a code-deployment graph onto the
   origin VM — audit is the only control. SIGNED OFF by Example User 2026-07-07: accepted as
   the intended semantics** (user-facing docs should still tell a recipient that
   accepting a write share grants code-execution on the origin VM at the origin's
   expense).
9. **Read-only shares are enforced by filesystem permissions**, not Syncthing's
   receive-only mode (which is transport, not a guarantee).
10. **System secrets live in Convex, env-injected into VMs** — never baked into the
    image, checked into files, or shipped in the client bundle. This is about
    platform/provider secrets, not user content (an authorized caller writing its own
    files/memories is not a leak). The one place untrusted external text enters memory
    — session import — is scrubbed BEFORE write
    (`packages/importers/src/index.ts:scrubImportedSnippets`, pinned so a planted key
    never reaches a memory write).

## Measured platform facts (the evidence, in `research/`)

These are real measurements, not assumptions — they drove design and some corrected
the original plan:

- `probe-image-systemd.md` — custom images boot systemd as PID1 under `--command auto`
  (anonymous ttl.sh push proven; private via `--registry-auth`).
- `probe-cp-semantics.md` — `cp` of a running VM is ~1s and crash-consistent for
  **fsync'd writes only**; buffered writes can roll back → backups must fsync.
- `probe-ws-tunnel.md` — the VM-to-VM WS tunnel (and its slice-15b addendum: two real
  VMs sync a folder in ~2.5–3s through the tunnel).
- `device-pairing-auth.md`, `edge-ws-limits.md`, `custom-domains.md`,
  `agent-cli-contract.md`, `demo-60s-runbook.md` — the frozen contracts and
  experiments the deferred/launch work runs against.
- `chat-app-reuse-inventory.md` + `chat-app-port-landmines.md` — the transplant guide
  (what to copy, the numbered risks each ported domain had to fix).

**Corrections the build made to the plan:** the map assumed ~12s VM boot; a custom
image is **~72–79s** (image pull dominates — the 60s-demo long pole; image caching /
pre-warm is the path back). exe's HTTPS `/exec` 504s past 30s on custom-image creates
(production create needs async-create or image caching). Both are inputs to the open
exe.dev platform conversation.

## Dead ends (do not re-walk)

- **Inode-only rename detection.** The anchor watcher first used inode identity alone;
  a real-VM test caught ext4 **reusing a freed inode** so a `rm -rf`+recreate looked
  like a rename and silently re-anchored. Fixed with the `.duet-anchor` marker
  (survives `mv`, absent after delete+recreate). This is why reanchor needs inode AND
  marker.
- **convexDev startup concurrency "fixes."** Two attempts to make the test harness
  tolerate many parallel local-Convex cold-starts (a retry loop reusing reserved
  ports; a cap-3 slot semaphore) each made it _worse_ — the retry broke the
  single-instance case, the cap caused slot-wait timeouts — and were reverted. The
  known-good harness (`packages/test-harness/src/convex-dev.ts`: per-instance isolated
  project copy + reserved ports) stands. The residual flakiness is environmental
  (convex's startup network fetch failing on a degraded connection); every file passes
  in isolation. A durable fix belongs in the harness, not in retry band-aids.
- **MCP-last façade (draft 4).** Rejected in favor of shipping MCP early (slice 08)
  with a registry that grows tools as slices land — the ecosystem thesis wanted agent
  feedback sooner.
- **v1 parallel abstractions** — the half-built provider interface,
  `public.config.json` app manifests, and the eternal-unscoped `duet_gt_` token — were
  cautionary sources only, deliberately not ported.

## Visual provenance

The launch web surfaces (`apps/web`) were built to a "presentable launch site, not a
placeholder" bar and verified by rendering the running dev server, not by trusting the
generator. The screenshots in `assets/slice20/` **are** that standard — what "done"
had to look like — captured via Playwright against `next dev`:

- `landing-light.png` / `landing-dark.png` — the landing page in both themes; the bar
  was theme-aware, responsive, agent-first framing with the device-pairing-first
  install story. Drove acceptance of `apps/web/src/LandingPage.tsx`.
- `install-light.png` — the human self-install page; the security requirement it
  encodes (never print a raw key; human approves before the key exists) is visible in
  the copy block.
- `ui-device.png` — the device-approval gate showing requested scopes as chips before
  Approve/Deny; this image is the proof the non-bypassable-human-approval invariant is
  surfaced, not just enforced.
- `ui-billing.png`, `ui-apikeys.png`, `ui-members.png`, `ui-shares.png`, `ui-apps.png`,
  `ui-publishes.png`, `ui-audit.png`, `ui-session.png`, `ui-onboarding.png` — each
  settings/onboarding surface in a populated (`?mock=1`) state; they define the
  content and shape each surface had to render.

## Not shipped (deliberate; owners noted)

- **`@duetso/agent` CLI (separate repo, Example User owns timing).** `duet memory
add --json/--source`, `memory search --json`, `capabilities --json`, `train --json`,
  and the `--rpc` turn protocol do not exist yet. Slices 06/10/16/17 and the demo run
  their Duet side against mocks and are **one env flag from live** once the CLI ships;
  the exact frozen contract is `research/agent-cli-contract.md`.
- **Launch human-gates** (none code-blocking): billing/Stripe review before real money
  (before enabling prod Stripe keys) — OPEN; Vercel WS-limit go/no-go vs the
  Syncthing-relay fallback (after an edge deploy — `research/edge-ws-limits.md`) —
  OPEN; write-share = code-deployment sign-off (invariant 8) — **SIGNED OFF by Example User
  2026-07-07**; and the live 60-second demo (blocked on the agent CLI) — OPEN. The
  demo _spine_ is proven — `packages/test-harness/src/demo-60s.ts` ran the real spine
  green on a real VM through device-pairing; the **live-publish→fetch** leg was proven
  in the mock-agent run (~126s). The full live demo now runs against real
  `@duetso/agent@0.1.202` but is BLOCKED on **workspace-VM model credentials**: real
  `duet train`/`--rpc` call a model and the VM has none. Decision pending (owner):
  route VM agent model calls through the slice-18 model gateway (billed to the
  workspace ledger — the architecturally correct answer) vs. inject a raw provider
  key (unmetered). See the demo-blocked task.
  Billing gate — Stripe SDK swap DONE 2026-07-07: replaced the hand-rolled classic
  webhook + raw `fetch` with the `stripe` SDK (`constructEventAsync` + pinned
  `apiVersion`), and MOVED the webhook off Hono onto Convex `http.ts` (all Stripe code
  now in `packages/backend`). Closes the no-Stripe-Version drift gap. Deploy: repoint
  the Stripe dashboard webhook to `https://<CONVEX_SITE_URL>/v1/stripe/webhook`. The
  human billing _review_ (amounts/thresholds + a Stripe test-mode dry run) is still
  owed before prod keys.
- **Deploy + follow-ups:** Vercel deploy of `apps/api`/`apps/edge`/`apps/web`; a durable
  image registry (ttl.sh is test-only); production streaming archive storage; read-mode
  share materialization ACL (Syncthing-as-`exedev` vs a 0555 mount); registering the
  `expose_app`/`publish_file`/`share_folder` MCP tools for the now-shipped capabilities
  (the slice-08 stays-green pin lists them); train-scraper DNS-rebind SSRF hardening;
  and the convexDev-startup harness resilience above.

## Verification

Each domain is pinned by tests next to it (`packages/backend/src/*.test.ts`,
`packages/gateway/src/gateway.test.ts`, `apps/api/src/index.test.ts`, contract unit
pins). Real-VM behavior (provision/heartbeat/retire, files+Range, anchors follow/break,
apps-through-proxy, publish live content, two-VM sync, the demo spine) is gated behind
`EXE_TOKEN` + `DUET_REAL_VM_IMAGE_REF` and was each run green on real exe.dev VMs during
the build. `RUN_DOCKER_TESTS=1` gates the fresh-container CLI/import round-trips.
