# @repo/gateway

`@repo/gateway` is the service that runs inside each Duet workspace VM. It is the
owner of VM-local behavior: drive file access, memory CLI calls, agent runner
processes, app supervision, public publish serving, sync mounts, tunnel acceptors,
control-plane reconciliation, and self-update.

## Boundary

The gateway is where metadata decisions become local side effects. The backend
decides what a workspace is allowed to do; the gateway executes inside the VM
using a VM token and the local drive root. Keep filesystem and process behavior
here so the public API remains a control plane rather than a remote shell.

App supervision owns the entire process group started by an app command, including
servers launched through shell scripts or package managers. Stopping or losing the
wrapper must retire its children too: a surviving listener can answer health checks
while preventing every replacement from binding. Cleanup is bounded; the existing
retry loop then restores service and reports readiness through VM sync. A listener
outside that owned group remains a port conflict, never evidence of app readiness.

Runtime releases are manifest-verified artifact sets. One release manager owns
inspection, repair, installation, activation, rollback, and retention so runtime
updates and pre-start recovery cannot disagree about what is bootable. OS packages,
systemd units, Bun, and other image-level dependencies remain with
[`@repo/vm-image`](../vm-image/README.md). Release versions are opaque
content-stamped equality tokens.

The gateway, CLI and native assets activate and roll back together. Child
commands use the executing physical release, including their shell PATH, so
changing the interactive current link cannot mix application versions inside
a live process. Installed VM application updates never use a registry installer.

Authenticated health and operator status distinguish the gateway process from
its VM boot. The process instance changes on a gateway service restart; the
cached Linux OS boot identity does not. This lets in-place adoption receipts
prove that application release changes kept the existing VM running. Non-Linux
development omits the OS identity. The reader lives in
[src/runtime/boot-identity.ts](src/runtime/boot-identity.ts).

Regular VM sync is an authoritative desired snapshot, including the complete
machine set. Registration can return its committed token without a complete
snapshot when post-commit projection fails; the gateway waits for its next
authenticated sync before applying that fallback.

Saved App keys survive gateway startup before the authoritative app roster arrives.
Asking which credentials need refresh is read-only; only an accepted app snapshot
retires credentials for removed apps or changed scopes. The supervisor's initially
empty process map cannot decide that an installed app lost its credential.

Direct browser uploads opt into gateway CORS only under the Drive write route or
the root and validated agent Train upload subtrees. The provisioner forwards the
environment's configured product-app origin as `DUET_WEB_APP_ORIGIN`. Train
credentials bind to one root-or-anchor inbox; Drive credentials bind to one path
prefix and admit only PUT and DELETE. Both are short-lived; a Drive prefix may
be the drive root, which every path is inside. Drive PUTs disable Bun's
per-request timeout while the existing file handler streams the body, so the
server's `idleTimeout: 255` does not impose a file-size-by-uplink ceiling.

Neither does the body cap. Both server-level ceilings live in
`src/runtime/serve-limits.ts` precisely because they cut a request off before
any route can answer it: Bun refuses an oversize body on its declared
`Content-Length` alone, ahead of `fetch`, so that refusal is never stamped by
the CORS policy and a browser reads it as an unexplained network failure rather
than a status. The ceiling is therefore _derived_ from the Drive's published
per-file cap and kept strictly above it, so the route — which can say why —
always answers first. That direction is the invariant; inverting it resurrects
the unreadable refusal.

A Drive `PUT` is then refused in two steps, both weighed before a byte is read:
the declared size against the per-file cap (`413 file_too_large`, carrying the
limit), then free space (`507 storage_full`). Size goes first so a file no disk
could hold hears the thing its owner can act on. A request that declares no
length is deliberately not counted mid-stream — free space remains its only
bound, which makes the cap exact for browsers and advisory for a hand-rolled
chunked client. Note also that the free-space guard fails _open_: when its probe
throws, the cap is the only bound left, and it bounds one file rather than the
drive.

The desktop stream also enters through this one public gateway port. A
short-lived browser credential lives in the inherited URL path prefix so the
Kasm client, its relative assets, and its WebSocket share one authenticated
origin. `src/routes/desktop.ts` strips that prefix before forwarding to the
loopback-only Kasm server, injects Kasm's VM-local Basic credential only on the
upstream leg, and bounds both idle and slow-viewer relay behavior. Each grant
also binds one exact parent origin; the proxy replaces upstream frame policy
with that grant's `frame-ancestors`. Expiry closes new HTTP and WebSocket
admissions but never installs a timer on a socket that was already admitted.
Chrome profiles are private VM state and do not survive VM replacement. The
Drive-only recovery boundary is described with the [restore consumer](#workspace-recovery).

Agent browser ownership is default selection, not isolation. Stable agent
identities own Chrome windows while browsing invocations own fresh batch tabs;
all windows still share one process, profile, default context, and browser-level
CDP view. `duet-browser` proves its session to the gateway, which resolves the
owner, places the tab through the image-owned extension, and returns an opaque
gateway CDP lease plus the exact target id. The proxy stays transparent except
for operations that would escape the one-window or one-context contract.

Logical ownership lives in private VM state. Chrome window, tab, and target ids
are generation-local evidence: each claimed native window carries an exact
tab/target witness, gateway-only restart revalidates those witnesses, and a
Chrome generation change destructively resets them before root can adopt the
sole bootstrap window. The ledger is private VM state and is recreated after VM replacement.

Desktop status projects one row per stable browser owner rather than per temporary
session. Focus requests validate the native identity witness and raise the exact
window without selecting a tab; missing or stale claims are cleaned up and never
create browser state. Batch-attributed counts deliberately exclude human-created
tabs, which remain visible and operable in the same shared trust domain.

Chrome patching is serialized behind the audited internal-admin operation. The
gateway refuses an already-live agent and temporarily closes the existing
runner and desktop start gates before touching the browser, so neither an agent
nor a fresh human viewer can enter between the busy check and the stop. The work
also shares the desktop supervisor's operation queue, so an already-starting
target finishes before the activity probe. An active browser is restored after
the pinned install; a demand-idle desktop stays idle. Runner maintenance is a
pause, not a drop: durable wake timers are re-armed when starts resume.

A desktop that will not start is treated as a lasting condition rather than a
transient one, because its commonest causes are lasting. An X display lock
outlives the server that made it and then refuses every later start. Chrome
leaks a memory-mapped metrics file per launch and reaps them only once a launch
completes, so a Chrome that keeps dying fills the disk — and a full disk is
exactly what stops Chrome creating its profile socket. Left alone, either cycle
sustains itself and costs a workspace real CPU indefinitely.

Four things bound it, and none latches off permanently, so a workspace recovers
on its own once the underlying cause clears. Unattended start attempts back off
exponentially to a ceiling while an explicit request still tries. Every start
first reaps the leaked metrics and clears an orphaned display lock, which is
what lets a release heal a workspace that is already wedged. A failed start
stops the browser unit, because systemd's own `Restart=always` would otherwise
relaunch Chrome every second through the gap the backoff just opened. And
Chrome is never left running while the target is down at all: the target only
`Wants` the browser unit, so systemd starts Chrome even when KasmVNC failed,
and a Chrome with no display is precisely the thing that leaks a metrics file
per second. That last one is a reconciliation latched on the down-transition,
not a per-tick command, because re-issuing it on a schedule would cost twelve
needless sudo calls a minute on every idle workspace in the fleet.

All of it runs from the gateway, over permissions the shipped image already
grants — deliberately, because the units and sudoers only move on an image
rebuild while the gateway reaches every VM on the next release.

None of this cures the underlying fragility, and it is not meant to. KasmVNC
takes around 23 seconds to start against the unit's `TimeoutStartSec=30`, so
under CPU contention systemd kills a server that was going to succeed — and the
killed server is what leaves the display lock behind. Bigger VMs are the real
answer; until then the point is that a desktop which cannot start stays cheap
and keeps trying, rather than wedging the workspace.

## Pointers

- `src/connected-providers/connect-session.ts` owns VM-side subscription
  connects: it spawns `duet connect --device-code --json`, parses only the
  agent CLI's NDJSON grammar, and never opens the credential store itself. A
  connect request returns a pollable session before the CLI emits anything;
  polling owns device-code readiness and the terminal result, so a control-plane
  request never waits on provider startup or human approval.
  Credentials live in the agent's `~/.duet` and require reconnection after VM
  replacement; no backend schema or sync message parses or projects them.
  Status is read when someone asks, never folded into the sync rail: the CLI
  owns a store that can change out of band, and asking it costs a full runtime
  spawn — on a rail that runs for the life of the VM that is a permanent bill
  for an answer nobody is reading. The control plane calls this route when a
  person opens the page. A short freshness window and one shared in-flight probe
  exist only so repeated looks cannot spawn a runtime each; an answer whose
  generation has moved on (a connect or disconnect landing mid-probe) is
  returned to its caller but never cached.
- `src/duet-cli.ts` is the single seam for one-shot agent-CLI invocations —
  memory reads and writes, the skill listing behind the composer's `/` picker.
  Every call is something a person is waiting on, so no invocation may outlive
  its cap: the child is killed, and the caller reports a gateway timeout rather
  than the CLI's own failure. Abandoning the promise without the kill would
  answer the request and leave a wedged process for the life of the VM. Listing
  callers also apply streamed stdout and stderr ceilings before buffering: a
  CLI-owned collection must fail explicitly when it crosses its product bound,
  never fill gateway memory before the public API can page it. A binary that
  cannot be spawned at all is one more CLI result, not an exception: the seam
  settles it to the CLI's own `unavailable` exit code once, so a route has a
  response to write and a rail keeps working through the targets queued behind
  the failed one, and no caller carries its own copy of that guard.
- Skills bundles are reinstallable control-plane state, not durable workspace
  state. Archives omit the release tree together with its active link and hash
  stamp; after restore, the next sync materializes the bundle again. The
  installer also treats a stamp without its release directory as stale, so a
  partial restore converges instead of blocking every agent start.
- `src/index.ts` is the composition root. Runtime config and HTTP wiring live
  under `src/runtime/`; VM phone-home and archive/restore live under `src/vm/`.
- `src/gateway-logger.ts` is the single local logging boundary. Components hand
  it structured fields and original `Error` objects; it owns error serialization,
  secret redaction, and capped persistence.
- A safety ceiling that drops work, disconnects a stream, or terminates a process logs once when
  it changes the outcome. The owning component supplies identity, which ceiling fired, and the
  recovery action; payload contents never become diagnostic fields. Ordinary pagination and
  product-capacity boundaries use their response contracts instead of warning logs.
- `src/runtime/process-guards.ts` is the process backstop: Bun exits on an
  unhandled rejection or uncaught throw, and one gateway process hosts every
  rail of the workspace, so a stray failure in any rail is logged (`process`
  label, with stack) and the process stays up. Each rail still contains its own
  failures; this is for the one that did not, never a reason to skip that.
- `src/vm/sync-client.ts` owns the sole recurring control-plane request. Its one
  directive sink projects each accepted snapshot into anchors, credentials,
  desired component state, boot health, and update checks; registration reuses
  that same sink so initial state cannot drift from polled state. Scheduled sync
  and explicit refreshes run in one queue, so an older response cannot overwrite
  a refresh requested after a mutation. A failed attempt releases the queue. The API directs
  the next poll interval; transport retries use bounded backoff without creating
  a second timer or state source. Train job transitions and app reconciliation
  outcomes share this request as acknowledged outboxes, so a lost response
  causes safe redelivery instead of lost state. An acknowledged app outcome
  stays drained until its desired config or observed result changes. App
  outcomes carry the exact desired runtime config that was applied; the backend
  rejects them if that config has since changed. Direct mutations name the slugs
  that must become ready and share any in-flight work for those apps; unrelated
  installs continue on the background loop without blocking or poisoning the
  mutation.
  Anchor projection remains awaited before release-health success: healthy rosters
  use direct path probes, while missing entries trigger one filtered mover search.
  Generated/noisy roots are pruned and ordinary authored trees may use up to 40,960 entries.
  A completed search, or reaching that deliberately abnormal ceiling, is a conclusive verdict:
  positive identity evidence reanchors the folder and a traceless absence reaps it, so the same
  full search cannot restart on every sync. A report that fails transport is journaled with the
  anchor snapshot and replayed without another walk. Local filesystem uncertainty skips the verdict
  rather than manufacturing absence. Only adjacent recurring-sync requests coalesce. Direct API
  pushes stay one-for-one because their committed snapshots are an observable
  control-plane result. Registration and pending-sync restore share one structural
  restore window, so neither path can manufacture deletion evidence during a drive swap.
  The train record index rebuilds on that same anchor projection but is a feature
  rail, not health evidence: a memory file the store cannot read is quarantined and
  reported (`record_skipped`), and no index failure fails the sync cycle, because a
  failed cycle is what marks a workspace unhealthy and closes its Files pane and apps.
  VM-token-authenticated `/health` includes a bounded liveness diagnostic snapshot:
  attribution counters, the latest 32 raw scan-nudge paths, the most recent anchor
  reconcile telemetry, restore-window state, and whether this running release has
  been certified by boot health. The internal diagnostic restore-window probe runs
  the real reconciler while that same suppression window is active and returns its
  `skipped: restore_in_flight` telemetry. It is an operator/journey health check,
  not a restore substitute, and does not change files or durable anchor state.
  Content generations are part of app runtime identity: an upstream content-only
  advance must rerun installation even when commands are unchanged, while ordinary
  apps omit the field and retain their existing reconciliation behavior.
- `src/agent-sessions/` owns session runners under one governing principle:
  **a runner is a turn runner — terminal means terminal.** Sessions are
  ephemeral and most `ask` questions are never answered (a workspace
  routinely accumulates pages of "waiting for input" sessions that sit for
  hours, months, or forever), so no process may ever wait on a human. Every
  terminal event — `ask` included — kills its runner; the durable checkpoint
  in the session ledger is the _only_ continuation state, and answers, wakes,
  and crash recovery rehydrate a fresh spawn from it. Stopping an absent runner
  cancels its durable wake and commands without spawning model work. The ledger
  records that stop separately from the native checkpoint so explicit new input
  can still resume it; a delayed stop report cannot consume newer input.
  Startup also reconciles stopped checkpoints with the backend. This observation
  checks both the input cursor and the backend event sequence: timer turns can
  reuse the same input cursor. It never replays work, repairs over queued input,
  or lets API availability block restoring unrelated runners. The
  corollaries: a live runner always means a turn actually running (liveness
  gates like the update rail may rely on that), cold-start latency on an
  answer is an accepted cost, and any future "keep the process warm" idea is
  a regression of this principle, not an optimization (it was tried; it bred
  stale-state hazards and hostage fleet updates). The kill site and the
  hydration path both live in `coordinator.ts`. Each start explicitly applies
  the latest accepted tier through RPC options: a checkpoint restores history,
  while the launch envelope owns the current user selection. A CLI model flag
  alone is a fallback and loses to the model saved in the checkpoint. The same
  rule governs follow-ups, answers, wakes, and crash recovery.
  Persisted launch selections may outlive a tier: the ledger resolves retired
  selections to the current entry default without discarding continuation state.
  A valid retired-selection snapshot quarantined by an earlier gateway is restored
  only when no newer session or discard tombstone exists.
  A `sleep` is the one terminal
  that promises a relaunch, so it is held to one rule: its wake time must still
  lie ahead when it lands. A checkpoint that sleeps on a time it already fired
  (a killed run rehydrated with a stale timer task) would otherwise relaunch
  after zero delay and sleep again, forever; the gateway ends that turn instead
  and says so. Foreground and background inputs
  use the same ingress. When the serialized ledger records an event, its relay
  item freezes the accepted input boundary at that moment so later inputs cannot
  change the event's causal coverage. Pending relays live in an append-only local
  journal. Private recovery checkpoints persist independently of API uploads;
  older public events queued behind an upload cannot overwrite a newer snapshot.
  Snapshots retain the materialized journal sequence independently of the input
  cursor: autonomous wakes share a cursor, so input ordering alone cannot stop
  an old terminal from erasing newly accepted work. Older unsequenced journals
  use input and checkpoint revision evidence; an ambiguous autonomous wake stays
  blocked until explicit new input or stop resolves it, without replaying work.
  Public event publication remains ordered so live deltas retain their durable
  message boundaries. Stable relay ids preserve order and retry identity, acknowledgements
  materialize checkpoint state before compacting a delivered prefix, and bounded
  capacity stops the producing runner until the control plane catches up. That
  journal is retryable state, never authority — a record it cannot parse is
  dropped and reported rather than failing the read, since an unreadable event
  can never be relayed and losing the session along with it would strand every
  route that reads the session. Nor may a record weigh more than the control
  plane can store, which is the same rule read forwards: runner state travels
  only as the slice the control plane reads (the contract owns that slice,
  `relayedTurnState`), image data never travels, and tool inputs, details,
  outputs and task diagnostics are small human-readable previews rather than
  copies of the agent's working data. Each payload's preview budget covers its
  encoded value, including its truncation marker. Object previews keep small
  fields where possible; structures that cannot fit become explicit omissions.
  Full results remain in the local recovery transcript.
  Oversized prose is cut even inside nested tool arguments, and each removal
  leaves a marker naming what went. If tool-input structure alone exceeds the
  budget, its display copy becomes an omission marker; execution
  arguments and the local recovery checkpoint retain their full contents. The
  budget applies to records on the way in and again to records read back, so a
  journal an older gateway jammed heals on restart rather than needing surgery.
  A turn stopped because the journal filled says so, because a
  killed runner the control plane never hears about goes on reading as a live
  turn — which is also true when the process dies on its own (a crash, an OOM
  kill, a signal) with no journal involved at all: the coordinator watches for
  the runner's death for the rest of the turn's life, not just at launch, so a
  silent death gets reported the same way a journal-capacity kill does. Death
  is the runner's stdout closing, never the process handle's own exit report:
  the kernel closes a dead process's pipes and never a live one's, whereas the
  runtime's verdict can be wrong. The handle's report is logged as
  `runner_process_handle_exit` and otherwise ignored. The verdict is also
  passed only after everything the runner said has been processed: the runner
  exits on its own the instant its terminal is written, so a closed pipe with
  a terminal still queued behind ledger writes is a clean end, not a crash. A
  runner that is alive but never acknowledges an input counts as dead too: no
  event loop is reading its RPC, so nothing it is doing can finish, and left
  alone it reads as a running turn until someone presses stop. The coordinator
  reaps it (logged as `runner_unresponsive`), reports it the way a crash is
  reported, and still refuses the input, so the control plane's retry hydrates
  a fresh runner from the checkpoint.
  Durable writes go through `src/atomic-json.ts`,
  whose `write` documents the platform quirk that makes any other append
  primitive unsafe here. Runner
  creation requires a
  current, unexpired model credential; missing or expired authority leaves the
  durable input queued for a later control-plane drain instead of burning the
  turn on an authentication failure. The runner's integrations MCP server is
  addressed at this gateway, not at ctl: a runner opens every server with
  `initialize`, `notifications/initialized` and `tools/list`, serially, and
  three tunnel round trips before the model is asked anything were the largest
  slice of a turn's time to first token. The exchange depends on nothing the
  runner will say (the provider session is conversation-scoped and stateless),
  so the gateway performs it against ctl the moment the spawn's MCP config is
  built — overlapping the process boot — and answers the runner from memory
  (`src/agent-sessions/integrations-handshake.ts`); anything else is forwarded
  to ctl with the transport headers intact. What the exchange could not
  establish is not answered here, and the runner's own request goes upstream
  as before. Live event delivery follows downstream
  demand rather than eagerly filling the HTTP stream — except for its first
  byte, which the stream sends the moment it opens: the API subscribes before
  the runner has spawned and gives the connect far less time than a spawn
  takes, and a response whose first byte is its first event holds its headers
  back for that whole spawn. Retained hints and each
  subscriber's combined replay/live tail have independent count and byte
  ceilings. Overflow detaches a subscriber after its already accepted frames
  drain; one oversized frame detaches every affected subscriber without erasing
  those finite tails. Hint loss is safe because Convex, not this buffer, owns the
  canonical timeline.
  Recovery consumes coherent, private runner snapshots rather than rebuilding
  model state from timeline events. A display-only relay-state update must not
  advance the saved execution state ahead of its tasks and conversation.
  Snapshots are coalesced while work changes; replay of an interrupted input is
  at least once, so recovered workers inspect existing results before repeating
  side effects. Checkpoint revisions keep an older undelivered journal entry
  from rolling recovery back after a newer private snapshot has reached disk.

- `src/routes/` owns VM-local route families for files, memory, agent sessions,
  apps, publishes, sync, and tunnels. Route files should stay thin at protocol
  boundaries and delegate local process, sync, and training behavior to their
  owning folders. The app proxy preserves the downstream request lifecycle when
  it opens the loopback request, so cancelling a public stream reaches the app's
  own request signal. VM ingress may replace ordinary forwarded-host metadata;
  the proxy restores the edge-stamped original app host at the loopback boundary
  and removes that internal transport header before authored app code receives it.
  File and publish routes apply the
  [contract's two Drive path dialects](../contract/README.md#boundary) at their
  provenance boundary: raw URL suffixes decode once, while logical action and
  header paths preserve percent signs as filename bytes. A file's `ETag` is its
  **stat identity**, not a hash of its bytes: device, inode, size and both
  nanosecond timestamps. Writes are temp-file-plus-rename, so every write mints
  a new inode — and so does any rewrite or metadata touch by anything else on
  the VM, including one that restores identical content. `If-Match` therefore
  answers "is this the same file object I read?", never "did the content
  change"; a client that reports a rejected precondition as a user-facing
  conflict without reading the bytes back will accuse a lone author of racing
  themselves. App processes receive
  only the environment allowlisted by
  `src/apps/spawn-env.ts`; service-only injected extras never cross into install
  commands. The public publish endpoint has exactly three anonymous read
  operations, all confined to the resolved publish anchor subtree and all
  bounded by one serving floor (`isPublishExcludedDrivePath`: `.env*`, `.git`,
  `node_modules`, `.duet-anchor` — never served at any depth; ordinary
  dotfiles serve, hiding them is viewer presentation): `?list` (directory
  JSON, paths projected into the publish-root namespace), `?raw` (file bytes;
  text-like extensions per the shared classifier — including SVG — forced to
  `text/plain` so published source is shown, never rendered; media keeps its
  real type), and `?zip` (the served folder subtree as one `application/zip`
  stream — floor and symlinks omitted — with a stat-derived tree `ETag`
  honoring `If-None-Match` so pollers detect change without a download). List
  and raw reuse `serveDriveGet` through injected policy objects, zip rides
  `serveDriveZip` beside it; the authenticated `/v1/files` behavior is
  untouched. Authenticated file reads (GET/stat/list) additionally admit a
  VM-absolute path when it resolves under the live `driveDir`: the route
  strips that prefix (decoding with the contract's one bounded decoder,
  `decodeDrivePathBounded`) and the shared relative-only normalizer still
  judges the remainder, so traversal/reserved/outside-drive requests fail
  closed; writes stay strictly drive-relative. A frozen publish swaps only the serving root to a durable snapshot
  under gateway state; missing or corrupt frozen state fails closed. Zip and
  snapshot creation share one bounded subtree walker, so their floor and symlink
  policy cannot drift.
  Capacity-growing file operations and fresh agent turns share one VM-filesystem
  free-space guard. It is deliberately fail-open and policy-blind: deletes,
  same-filesystem moves, Syncthing writes, and already-running turns remain escape
  hatches rather than becoming quota or servicing decisions. Gateway boot also
  sweeps abandoned `upload-*` staging files; cleanup failures are diagnostic and
  never make the file route unavailable.
- `src/marketplace/` owns the subscription pull rail. Each subscription arrives
  with its OWN publisher origin (`sourceUrl`) — there is no single hub — and the
  puller re-validates that URL against the compiled `EDGE_HOSTS` allow-list before
  fetching, with `redirect: 'manual'` so a 30x cannot walk the VM off an edge
  host. Metadata inspection uses the shared subtree walk but checks the few catalog
  files against their own stat ceilings before materializing them; an authored
  field that does not fit is refused, never clipped into different copy.
  A subscription is pulled the moment the sync first hands it over (or a
  restarted process finds it never applied) — the API's post-install push is
  best effort and misses a VM still booting. Thereafter the rail runs as TWO
  jobs with the cached `snapshot.zip` as the boundary, each on its own timer and
  persisted clock. Revalidating (`?zip` with `If-None-Match`, deterministic ±10%
  jitter) owns one claim — the snapshot holds the publisher's current bytes —
  and is the only half that opens a socket or reports. Convergence owns the
  other — the drive matches the snapshot — and needs no network, so a user's
  deleted file is repaired while the origin is unreachable or merely quiet.
  Separating them is what lets either cadence move without paying on the other
  axis; fused, every repair costs a request — and it is what lets the network
  half be GATED. The control plane projects an opaque content token; while the
  token it last pulled at still matches, a subscriber stretches to the long
  interval the same projection carries, so the steady state costs one request
  every twelve hours rather than every thirty minutes. A token it has not pulled
  at is a directed fetch, spread uniformly across a window — a revision change
  is a herd, and the subscribers whose bytes actually moved cannot short-circuit
  to a 304 — and triggered once per distinct value, because the projection is a
  level that arrives every few seconds forever. The gate chooses between two
  intervals and never between polling and not, and the VM clamps whatever it is
  handed: a wrong token then costs at most today's traffic or one safety
  interval of staleness, and absence of a token is exactly today's behaviour. One function serves both the timer
  and the post-download path so the two cannot drift, and a pass that finds the
  snapshot gone or unreadable drops the ETag so the next fetch is unconditional
  — the boundary is repaired through the network leg, never around it. One
  download, headers through last byte, has a two-minute ceiling: pulls run one
  at a time, so a stalled body would otherwise hold every install behind it,
  and past the ceiling it is a retryable failure like any other. `active` means
  the files landed; the agent's apps reconcile behind the pull, one at a time,
  and an app that will not come up is the app's status, not the install's. The
  materializer applies three-way repair through a quarantine journal that
  never unlinks a live inode before a hash-checked sweep and grace-period
  reap, so a concurrent writer's bytes survive as conflict copies. Conflict
  names come from the contract's one `formatSyncConflictName` owner; pull
  bounds are the serving bounds (`MAX_RECURSIVE_FILE_*`). What the publisher
  never shipped is the user's, with one exception the manifest cannot express:
  DERIVED content (`isDerivedContentPath`) is installed here rather than
  authored here, so it belongs to the files that produced it and goes when the
  publisher removes them — swept only out of directories the publisher emptied
  completely, so a live app keeps what it installed. That is a different
  question from the serving floor above, which asks what may be SERVED;
  `node_modules` is on both lists for opposite reasons, and confusing the two
  is what once left an uninstalled app as a folder holding only its
  dependencies. Pull failures keep
  their stable control-plane codes while the redacted gateway log records the
  failing phase and original exception for operator diagnosis.
- `src/runner/`, `src/sync/`, and `src/train/` own process runner mechanics,
  sync mount/Syncthing behavior, and in-VM training. The developer base
  system prompt is gateway-owned (`src/runner/developer-system-prompt.ts`)
  and injected on every runner spawn via `--system-prompt`, layering above the
  user's per-agent prompt file (`--system-prompt-file`); the constant is
  byte-stable to protect provider prompt caching, and standalone `duet` runs
  get no Duet identity. Which prompt file that is depends on the session: an
  onboarding launch layers the agent's **optional** `ONBOARDING.md` and then a
  generated completion block, and never falls back to `AGENTS.md` — a missing or
  drive-escaping `ONBOARDING.md` yields no authored layer rather than the
  agent's ordinary persona. Every launch opens with the generated who-you-are
  layer, which names the session's own agent and slug. Nothing else in the
  stack does: the roster layer withholds the reader's own row, the authored
  prompt is optional, and the runner envelope names only senders — leaving an
  agent asked who it is with nothing but the folder it woke up in. It leads the
  stack as the frame the authored persona fills in, it is the one generated
  layer an onboarding interview keeps, and it is regenerated per launch because
  a rename lands between turns. A scope the roster does not carry gets no
  identity layer rather than a name guessed from its folder. A your-folder
  layer follows it, because both of an agent's durable homes default outward: a
  flagless `duet memory add` writes to the nearest ancestor folder that owns
  `.agents`, and a skill installed the way its own ecosystem documents
  (`bunx skills add -g`) lands in the machine's home — so an agent with no
  store of its own teaches the whole workspace, a skill installed for one agent
  reaches none, and both report success. Owning a store is therefore a property
  of being a registered agent rather than of having been talked to: every
  anchor reconcile creates one per active agent folder and for the drive root,
  and a launch creates its own again for a folder that synced since. The layer
  names those folders, says which of them the workspace shares, and routes what
  an agent learns by kind — observed memory for the ordinary, where ranking by
  relevance is the feature a pinned copy would trade away; `AGENTS.md` for what
  changes how the agent works, because the user can read and edit that; the
  pinned store for what a person trained it on, training being the person's
  tool rather than the agent's. Then it stops: those rules are all it can say
  that the `memory` and `add-skill` skills cannot, and a launch pays for every
  line it carries. Onboarding launches also exclude the your-apps and
  your-agents layers: the first's cwd-moving teaching sent a live interview
  wandering into an app folder, and an interview must stay under the anchor it
  is onboarding rather than discovering colleagues to delegate to. The
  completion block asks for exactly one session-scoped call — everything it
  references is already in the runner's environment, because a live runner
  skipped the previous derive-your-own-slugs ceremony outright and stranded
  the user behind a locked card. A showing-files layer closes the stack: an agent with
  something to show links it in markdown, because reading a file back sends the
  bytes to the model and shows the reader nothing — the habit that jammed a
  workspace's relay journal with a 1.3 MB image. It reads the renderable
  formats from the drive's own type table, so the prose cannot promise an embed
  the timeline will not produce. One containment-checked resolver in
  `src/agents/agent-context.ts` picks the layers, so no caller builds a prompt
  path of its own, and `bun run prompt:print --drive <dir>` renders the whole
  prompt a session would start with — the gateway's layers wrapped by the agent
  runtime's — so a change to any layer is read in the company it keeps; the
  completion block is written into the per-agent state
  directory outside the drive, so it never syncs and the agent cannot edit it.
  Ordinary launches also receive generated session layers there: which session
  this is — the agent's home conversation or one of its other sessions — with
  a pointer to the session API; every non-onboarding launch receives its
  parent and children, rebuilt each turn from the accepted roster, with
  siblings counted rather than listed. The recipes for reaching, naming and
  listing other agents live in the `duet` skill's agents reference, which a
  session reads when it needs them; the layer keeps only the policy and the
  reply rule: a sender that is blocked waiting on this session's turn is
  answered by ending the turn with an ask — its wait resolves with the
  question. Onboarding completion and reset request an immediate sync after the
  durable write, with a short response deadline; periodic sync recovers an
  unavailable VM without undoing completion. Child sessions receive stable
  parent lineage so they can reach the session that launched them. The
  authored `AGENTS.md` is the last layer of all, after the agent runtime's own
  rules: the developer prompt names it as the one that overrides, and the
  order makes that true. Keeping these conditional policies out of the
  byte-stable developer prompt preserves the provider's cached prefix. Runner stdout is an NDJSON protocol: any record
  that exceeds its byte budget terminates the turn; an incomplete record cannot
  be repaired safely by dropping bytes. Stderr keeps a marked bounded tail so
  a failed turn retains its newest diagnostic without growing indefinitely.
  The train job ledger is
  the sole running-state owner: its crash-durable ledger drives concurrency,
  boot recovery, and update deferral rather than process-local counters. New
  reports wake the existing VM sync loop after the durable write; an idle
  heartbeat must never hold up training progress. Acknowledgements drain the
  same outbox without waking the loop again. Train
  process diagnostics are third-party text, so this adapter alone may retain a
  scalar-safe bounded prefix; authored record metadata must validate intact.
  Train scope is the root agent or one projected agent anchor; the same scope binds
  its upload inbox, jobs, own memory store, and nearest-first ancestor view.
  Ancestor records are readable but immutable at this boundary; the public API
  owns translating anchor ids into user-facing agent slugs.
  Provider model aliases are stable launch selections. The gateway owns the
  complete `.duet/models.json` at each resolved runner cwd and replaces it before
  spawning; a nearer user-authored file cannot shadow the product's selection.
  Existing runners keep their loaded table. The next spawn reads the current
  gateway release, so backing-model updates travel through the existing bundle
  hash and update rail without rewriting saved selections. The routing owner is
  [`src/runner/routing-config.ts`](src/runner/routing-config.ts); its ordinary
  policies come from a checked-in CLI export so source tests work before a build.
  The build regenerates that export from the pinned agent, and `routing:check`
  verifies its provenance after dependency updates. Alias metadata and pure table augmentation belong to the
  contract, so CLI and VM selections share one product policy.
  Agent-session launch state is tier-native with no compatibility reader:
  pre-tier local envelopes are moved aside atomically, and the durable API
  delivery must retry before the session is recreated.
  Syncthing consumers start as one boot cohort only after configuration
  hardening and projection from the authoritative mount store both succeed; a
  failure retries the complete initialization lifecycle instead of exposing
  partially initialized consumers. Filesystem attribution keeps the last
  confirmed Syncthing process exclusion when PID discovery is temporarily
  uncertain and replaces it on the next successful lookup.
- `src/memory-reflect.ts` folds each memory store's aged observations into
  durable rows on a nightly pass. Memory is per agent, so the unit of work is
  one database rather than one VM: the drive root's store plus one per agent
  anchor, run one at a time so a workspace full of agents cannot start a model
  call apiece. The clock is persisted and per database, because the gateway
  restarts for every release and a schedule counted from process start would
  never fire on a VM that updates daily. A store is stamped when it is first
  seen rather than folded on sight — a new agent has nothing old enough to
  condense — and again before each attempt, so a pass killed mid-fold has spent
  its slot instead of repeating on every boot. Any failure, a held lock
  included, waits for the next day: reflection only ever reads rows that are
  already days old, so a missed night costs nothing while an hourly retry would
  cost a model call per agent per hour. A VM holding no model credentials keeps
  its slot rather than spending it, because folding is a model call and a
  workspace that cannot reach one has not skipped a night — it has not had one
  yet.
- `src/agents/memory-warmup.ts` builds memory databases before the first turn
  that would otherwise pay for them. A fresh store is a full PGlite bootstrap
  plus every migration — seconds of CPU on a workspace VM, which turned the
  first turn of a named agent, and of a new workspace's default agent, into a
  hydrate several times longer than every turn after it. Agents are created
  long before anyone speaks to them and a workspace boots before its owner has
  finished signing up, so every anchor reconcile (the boot one included) starts
  the missing builds in the background, off the sync cycle — the drive root's
  store first, then one per active agent anchor — through the memory
  contract's `open` command on the same agent-CLI seam the reflect rail takes.
  The CLI builds into a scratch directory beside the real path and the finished
  store is renamed into place only if nothing else got there first, so a runner
  that spawns mid-build never opens a half-migrated store and a build that
  loses the race is discarded rather than clobbering real memories. Builds run
  one at a time and wait while any runner or train job is active, because the
  CPU they burn is the same CPU a live turn is using. A store is tried once per
  process whatever the result: one that cannot be built is the runner's problem
  to report on the first turn, not a reason to spend CPU every cycle.
- `src/agents/agent-roster-view.ts` is the one answer to "who can this session
  reach": hierarchy, lock verdict, slug order, and the row cap together. The
  generated prompt and the HTTP route the browser's mention picker reads both
  consume it and neither recomputes any part of it, so two surfaces listing the
  same colleagues cannot describe different sets — what a person can address and
  what the agent was told are one list. It is also allowed to have no answer: a
  roster that has never synced, and one that does not carry this session's
  agent, each yield nothing rather than an empty roster, because a session told
  it has no colleagues and a session nobody looked up are different claims. Over
  HTTP that difference is carried by the status, not the body — the unsynced
  case is transient and says so, an unknown agent is a miss — so neither can
  arrive as the empty list a new workspace honestly deserves.
- `src/runtime-release.ts` owns the runtime release filesystem contract;
  `src/boot-health.ts` owns release-scoped probation and the persisted boot state
  that the stable bootstrap consumes;
  `src/runtime-bootstrap.ts` owns pre-start recovery; `src/runtime-update.ts`
  and `src/update-gate.ts` own runtime activation and deferral. An update closes
  new agent, Train, backup and desktop admission before its final inclusive idle check.
  Existing work is never forced to end at the deferral deadline. Cancellation
  or failure reopens admission; successful activation holds it closed until
  restart. The same manager validates every artifact during install and repair,
  while boot probation certifies the complete application before retaining it.
- `src/persisted-store.ts` and adjacent stores own state persisted under the VM
  state directory. A staged component activates only while its exact version
  is still the unpaused desired one — nothing else that changed during the
  install matters. A cancelled activation leaves the executing application
  available and retains no independent CLI version to reconcile.

The [workspace backup encoder](src/backups/README.md) owns complete Drive ZIP64
capture and accepts streamed portable records without staging the archive.

## Workspace recovery

The [restore consumer](src/vm/archive.ts) installs only Drive entries from a
workspace backup; portable metadata remains reference material and Convex stays
authoritative. VM-private Chrome profiles, provider credentials, checkpoints,
and private memory/training state are not recovered. Birth seeds retain their
separate immutable tar decoder. Pending descriptors survive failed downloads;
only control-plane restore requests receive VM credentials. Each workspace restore
claims a persisted attempt and reports actual bytes or entries processed across
download, indexing, extraction, and installation. Progress, rather than ordinary
VM sync, keeps that attempt alive while bootstrap waits. A local stall aborts
work and awaits cleanup before reporting failure; successful installation is
recorded locally before acknowledgement, so a lost response retries settlement
without replacing Drive again. Deleting a failed recovery explicitly abandons its
authoritative reference; the next authenticated claim retires the local descriptor
so ordinary sync can resume. Missing bytes or temporary control-plane errors alone
do not abandon recovery. Birth seeds do not participate in this protocol.

Restore verifies the downloaded checksum and validates ZIP directory metadata
before extracting. Directory metadata grows with entry count, as in the encoder;
file payloads stream through bounded buffers. Scratch capacity must accommodate the download and
expanded content while the current Drive remains intact. The mount root stays
in place; staged child replacements retain old children until the swap succeeds,
with Syncthing and file attribution suppressed across installation. ZIP links
remain links, including external and dangling targets, and are never followed
while extracting. The decoder bundles with the gateway and uses the VM's Python
standard library for ZIP content validation and CRC checking.
