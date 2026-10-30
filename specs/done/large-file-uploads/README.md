# Large file uploads

A person picks a file in the compose bar or drops one on the Drive, and the
bytes go straight to the workspace VM. The Drive publishes a per-file limit,
refuses anything above it before a byte is sent, and says why in words. An
upload already running can be stopped.

## The bug this came from, and why it hid

A 7 GB pick died with a CORS error and an unreadable `413`. Neither message was
the truth. The VM's Bun server ran with `maxRequestBodySize` sized for the Train
inbox — about a gigabyte — which had quietly become the ceiling for Drive
uploads too.

The mechanism is the thing worth remembering: **Bun refuses an oversize body on
the declared `Content-Length` alone, before `fetch` is called.** No handler runs,
so no middleware runs, so the CORS policy never stamps the response. A browser
receives a refusal it is not allowed to read and reports the only thing it can
see — a CORS failure. The `413` in the console is Chrome's label for a status it
could not obtain.

That is why the limit does not live in the transport. A transport-level cap
cannot explain itself to a browser, so it must never be the thing that decides a
legitimate upload's fate.

## How the limit is arranged

`DRIVE_UPLOAD_MAX_BYTES` (`packages/contract/src/drive/index.ts`) is a **product**
rule, and `gatewayServeLimits` (`packages/gateway/src/runtime/serve-limits.ts`)
**derives** the transport ceiling from it as `cap + 1 GiB`. The direction is the
invariant: the route, which can speak, always answers before Bun, which cannot.
Inverting them resurrects the unreadable refusal.

`serve-limits.test.ts` pins the window with a raw socket — a declaration just
over the cap must reach the app; one just over the ceiling must get Bun's
headerless `413`.

A Drive `PUT` is then refused in two steps, both weighed before a byte is read
(`packages/gateway/src/routes/files.ts`, `app.put('/*')`): the declared size
against the cap (`413 file_too_large`, carrying `limitBytes`), then free space
(`507 storage_full`). Size goes first so a file no disk could hold hears the
thing its owner can act on.

### Why 32 GB, decimal, per file

The number is arbitrary and deliberately so — it bounds a wait nobody can
abandon, since there is no resume. Three properties are not arbitrary:

- **Decimal**, 32 × 10⁹. The files surfaces render base-1000 (`apps/web/spa/format.ts`),
  so a binary cap would print as "34.4 GB" — a confusing thing to be told about a
  33 GB file.
- **Per file.** The VM sees one `PUT` at a time, so per-file is the only rule the
  browser and the server can enforce identically.
- It sits **above a Starter workspace's whole disk** (20 GB storage, 28 GB
  provisioned). Starter users always meet `storage_full` first and never see
  `file_too_large`. This is why the refusal copy gives no advice: anything
  plan-shaped would be wrong for the plan the limit fires on least.

## Invariants

Break any of these and the failure is quiet.

- **The transport ceiling stays strictly above the cap.** Derived, never written
  twice. `serve-limits.test.ts`.
- **The size check precedes the free-space check** in the Drive `PUT`. The more
  specific reason must win. `files-put-refusals.test.ts`.
- **A request with no `Content-Length` is not counted mid-stream.** Free disk is
  its only bound. Deliberate: no shipping client sends one, and counting bytes to
  close a hole nobody stands in would trade an up-front refusal for one arriving
  after minutes of transfer. Held open by a test whose name says so.
- **The cap is a property of the upload route, not of the Drive.** Browser, public
  API, MCP `write_file` and `duetfs` all converge on `routes/files.ts`; agents,
  device sync and marketplace pulls write the filesystem directly and stay bounded
  by disk alone. A 40 GB file an agent generates is nobody's six-hour wait.
- **The browser names no actor.** The API stamps the authenticated caller into the
  grant itself (`DriveGrants.mintUpload`), so a direct upload can neither claim an
  identity nor forget to carry one.
- **Grant reuse is by closure identity.** `VmUploadClient` caches against the exact
  function it was handed, so a fresh closure per call re-mints for every file and
  *nothing fails*. `DriveUploadSessions` holds one mint per folder, keyed by prefix. Pinned one
  layer up, through its caller, in `apps/web/spa/files/lib/upload.test.ts` — there
  is no unit test of the class itself.
- **`upload` and `write` cannot share a transport.** `write` takes bytes already in
  memory; a picked file's may be gigabytes, and materializing one is what kills the
  tab — before any request limit is reached.
- **A severed upload publishes nothing.** The request-body stream errors, the temp
  is unlinked, and the rename never runs. Probed, then pinned, because the
  alternative — a clean EOF resolving the pipeline — would have renamed half a file
  into the Drive under the name its owner chose.

## Pointers

| Concept | Where |
|---|---|
| Cap value and comparison | `packages/contract/src/drive/index.ts` — `DRIVE_UPLOAD_MAX_BYTES`, `exceedsDriveUploadLimit` |
| Refusal reason and wire body | `packages/contract/src/files/index.ts` — `FILE_TOO_LARGE_ERROR`, `FileTooLargeErrorSchema`, `FileWriteErrorSchema` |
| Transport ceilings | `packages/gateway/src/runtime/serve-limits.ts` |
| Server refusal, all transports | `packages/gateway/src/routes/files.ts` — `app.put('/*')` |
| Free-space rule | `packages/gateway/src/vm/disk-guard.ts` — caches free *bytes*, so one probe answers both "any room" and "room for these seven gigabytes" |
| Grant mint | `apps/api/src/routes/workspaces.ts` — `app.post('/v1/ws/:workspaceSlug/file-uploads')`, published as `files.uploads.create` in `packages/contract/src/endpoints/index.ts`; minted by `DriveGrants.mintUpload` in `packages/gateway/src/auth/drive-grants.ts` |
| Browser grant ownership | `apps/web/spa/api/drive-upload-sessions.ts` |
| Drop loop, progress, cancel | `apps/web/spa/files/drive-upload-run.ts` |
| Upload error classification | `apps/web/spa/api/vm-uploads.ts` — `uploadErrorCode`, `uploadErrorStatus` |
| Live proxy probe | `packages/test-harness/src/staging-e2e-synthetic` |

## What live staging established

Run 2026-08-26 UTC (the evening of the 25th local), three declarations with
bodies never sent — the `STAGING_LIVE_UPLOAD_CEILING` line in the journey log:

| declared | verdict | elapsed |
|---|---|---|
| 2 GiB | admitted | 6.0 s |
| 32 GB + 1 | admitted | 6.0 s |
| 200 GB | refused in front, bare `413` | **15 ms** |

**exe.dev's public proxy imposes no ceiling below 32 GB.** The 200 GB reading is
what makes the other two mean anything: declare-time refusals arrive in
milliseconds and nothing in the path buffers, so the two admissions are real
results rather than timeouts. Together they also confirm the transport ceiling is
deployed where the design puts it — 200 GB above it and cut, 32 GB + 1 below it
and let through so the route can answer.

Two limits of that evidence, recorded so nobody mistakes it for more than it is.

**The probe design cannot reach the route-level `413`.** Bun waits for the body
before invoking the handler, so a zero-byte declaration only ever exercises
transport-level refusals. A real client sends its body immediately, which is why
the typed refusal fires in practice; the live proof of that specific path is not
among the readings above, and a probe that sends a few real bytes after an
over-cap declaration is what would produce it.

**Throughput past 1 GiB is not among the readings either.** That leg sits behind a
`chat-attachments:send` failure older than this work — established by running the
identical journey at the pre-push staging commit and getting the same failure at
the same stage.

## Divergences from the plan

- **The endpoint this spec built was deleted before it shipped.** Staging landed
  the same seam for MCP file resources while this was in flight —
  `files.uploads.create` at `POST /v1/ws/{slug}/file-uploads`, plus a generalized
  `DriveGrants` minting downloads as well as uploads. Publishing a second route
  minting one grant would have been exactly the duplication this spec forbade, so
  theirs survived and ours was removed. Everything above that seam carried over
  untouched.
- **The attribution fix was replaced by a better one.** This work found that
  Files-tab uploads landed as `system` and fixed it by stamping a header in the
  browser. Staging independently fixed it server-side by putting the actor in the
  grant. That cannot be forgotten or spoofed by a client, so the browser-side
  stamping was deleted.
- **Two gaps had to be re-landed on the adopted shape.** Their upload grant could
  not name the drive root — where the Files tab lands whenever nobody has
  navigated into a folder — so `mintUpload`, the persisted-grant reader, and the
  request schema learned it, and their contract test was re-specced: a *download*
  names a file and no file is the root, but an upload names a folder and the root
  is one. Their `driveFilePath('')` also returned a trailing slash, which would
  have built `/v1/files//name` and been refused by the path normalizer.
- **The `serve-limits` assertion was re-specced, not deleted.** It claimed the
  transport admits the largest plan disk, which was right while free space was the
  only thing that could refuse an upload and became meaningless once a product cap
  existed below Pro and Max disks.
- **The endpoint retirement was larger than the sweep predicted.** It also took a
  documented docs section with a validated schema example, an entry in the docs
  schema registry, four Convex-booting integration tests that were the *only*
  route-level grant coverage in the API, and a dead MCP allowlist entry that
  nothing would have caught — an allowlist line for a name that no longer exists
  is inert, not red.

## Dead ends

- **Counting bytes mid-stream for undeclared bodies.** Real complexity for a caller
  that does not exist, and it would replace an up-front refusal with one arriving
  after minutes of transfer.
- **Trimming the trailing `.0` from `formatBytes`.** Would read better everywhere,
  but the function has ten call sites inside committed screenshot baselines, so it
  is a repo-wide visual change unrelated to this feature. Three independent
  drafters reached this conclusion separately. Still open — see `choices.md`.
- **Refusing only the offending file in a drop.** Rejected: "zero bytes sent" is
  only meaningful if the whole gesture is refused at pick time. The compose bar is
  deliberately asymmetric, refusing per chip, because it has one chip per file with
  its own status.
- **Placing the size guard in `SessionAttachmentDraftOwner.add`.** Retry re-enters
  `upload` directly, so a check at pick time would leave the Retry button on a
  refused chip free to start a doomed transfer.

## Nothing left open

`choices.md` carries every decision made without the user, each re-audited against
the shipped code. The two that were his to settle — whether the refusal reads
`"32.0 GB"` or `"32 GB"`, and the Spanish decimal separator — were both accepted
as they stand. The trailing `.0` is the price of deriving the copy from the
constant instead of writing the number twice, and that trade was taken knowingly.
