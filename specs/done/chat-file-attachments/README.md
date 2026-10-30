# Chat file attachments

Duet chat accepts ordinary files alongside inline images. A file begins landing
on the workspace drive as soon as it is attached, the composer remains blocked
until every selected item is usable, the sent user message retains linked
preview cards, and the agent receives canonical drive paths in its runner input.
This removes the old detour where an agent asked a person to upload through the
Files page before continuing the conversation.

The feature shipped to shared staging on 2026-08-12. The focused live journey
passed as run `staging-e2e-synthetic` against staging
commit `7dd4325d`; it created and then deleted every user, workspace, VM, agent,
session, subscription, and file it owned, with zero orphans. See
[live acceptance](assets/live-acceptance-2026-08-12.md).

## Why it has this shape

### Files belong to the agent, not to chat storage

A non-image attachment lands under `<agent cwd>/uploads/<filename>` (or root
`uploads/`) through the same durable Drive write path as the Files surface.
The path—not a second blob identifier—is persisted with the input. The agent can
read, rename, and organize the bytes with its normal tools, while a person can
open the same object in the existing Files viewer. A per-message blob store or
deep inbox tree would have made chat own data that semantically belongs to the
workspace.

The landing convention and filename grammar live in
`packages/contract/src/agent/attachments.ts`. Drive write semantics remain in
`packages/gateway/src/routes/files.ts`; chat did not fork them.

### Direct upload avoids the application body-size bottleneck

Large browser bodies cannot reliably traverse browser → web → API → VM. The API
therefore mints a short-lived capability restricted to one Drive path prefix,
and the browser sends bytes directly to the VM gateway. The grant is hashed at
rest, expires after fifteen minutes, permits only the required file methods,
and does not widen workspace trust. The browser-provided actor context is
preserved so file history attributes the write to the signed-in user.

The neutral grant contract is `packages/contract/src/vm/uploads.ts`; minting is
owned by `apps/api/src/routes/agent.ts`; browser transport by
`apps/web/spa/api/vm-uploads.ts`; authorization by
`packages/gateway/src/auth/drive-grants.ts`. Train uploads adapt to the same
transport without sharing their credential store, because their concurrency
and scope rules differ.

### Images deliberately keep their existing rail

Small supported images remain inline image inputs. Ordinary files—including
overflow images—use Drive paths. This dual rail was an explicit product choice:
it preserves vision behavior while adding files without a migration or a new
image probe. The composer state is shared so count limits, readiness, removal,
and request identity cannot drift even though the wire representations differ.

`apps/web/spa/sessions/session-attachments.ts` owns that draft lifecycle.
`packages/contract/src/agent/attachments.ts` owns the durable file shape; the
existing image contract remains separate.

### Upload before send makes readiness visible

Selection starts work immediately. File cards show upload progress; inline
images show preparation; failures retain the source file for retry. Send is
disabled until all items are ready. Changing the target agent moves landed files
to the new agent folder and rewrites the draft paths. This costs some orphan
risk, handled by best-effort deletion and gateway temp-file sweeping, but avoids
hiding a long transfer behind an apparently stuck Send action.

Submission and deletion are intentionally different events. A confirmed client
rejection returns files to draft cleanup ownership. A timeout or dropped
response is ambiguous: the server may have accepted the turn, so submitted paths
stay pinned and are never moved or deleted by later draft teardown. Retry
identity includes text, tier, behavior, canonical cwd, images, and attachments.

### One visual language, product-owned effects

The shared `AttachmentCard` in `packages/ui` owns the card hierarchy. The web
composer adds progress, retry, and removal; the transcript adds Drive links and
best-effort previews. This keeps presentation aligned without teaching the UI
package about workspaces or network clients. Cards use compact first-4-KiB text
and table thumbnails, image thumbnails when safe, and glyph fallbacks.

The visual direction came from the earlier Duet chat application, recorded in
[the v1 UX reference](assets/chat-app-ux-reference.md). The interactive
[attachment look](visualizations/attachment-look.html) presented the visual and
folder options; the [quadrant map](visualizations/quadrant-map.html) records the
walk that selected rich preview cards and a flat `uploads/` inbox. These are
inspiration and decision provenance, not pixel baselines.

## Invariants

- A durable attachment is `{ path, name, bytes, mimeType? }`, in input order,
  with at most ten attachments on every prompt, message, note, or answer.
- Persisted paths are already canonical, workspace-relative Drive paths.
- The model sees attachments only through the manifest rendered beside their
  owning input event by `renderRunnerInput`; queued notes keep their own files.
- The direct-upload capability cannot escape its exact normalized prefix, and
  expiry or malformed credentials fail before Drive filesystem access.
- Ready means bytes are durable: the Drive PUT uses temp + rename + fsync and
  disables the normal request timeout for a streaming body.
- Send never snapshots a partially prepared attachment set.
- Server idempotency fingerprints include ordered attachment metadata at every
  input entry point. Explicit session creation also fingerprints cwd; default
  routes fingerprint the owning agent identity from which cwd is derived.
- Removing an unsent attachment updates the draft immediately; remote cleanup
  is best effort. Paths from an ambiguously accepted submission are retained.
- Inline images and Drive files share a ten-item composer cap, while images keep
  their existing four-image and five-megabyte inline limits.
- Transcript attachment cards open the existing Drive viewer. The optimistic
  echo stays text-only and reconciles to durable media.
- A document-level drop target yields to `[data-files-dropzone]`, and very large
  pasted text becomes a `.txt` attachment instead of flooding the editor.

## Code and verification map

- Contract and filename/path rules:
  `packages/contract/src/agent/attachments.ts`,
  `packages/contract/src/vm/uploads.ts`.
- Durable model and idempotency:
  `packages/backend/convex/domains/agentSessions/model.ts`,
  `packages/backend/convex/domains/agentSessions/delivery.ts`,
  `packages/backend/convex/domains/agentSessions/agentSessionsShared.ts`, and
  `fingerprintAgentInput` in `apps/api/src/agent-runner.ts`.
- Model-visible manifest:
  `packages/backend/convex/domains/agentSessions/runnerEnvelope.ts`.
- API mint and input forwarding:
  `apps/api/src/routes/agent.ts`, `apps/api/src/routes/default-session.ts`,
  `apps/api/src/routes/session-waits.ts`, and `apps/api/src/agent-runner.ts`.
- Gateway authorization and file writes:
  `packages/gateway/src/auth/drive-grants.ts`,
  `packages/gateway/src/routes/files.ts`, and
  `packages/gateway/src/runtime/http.ts`.
- Browser transport and draft state:
  `apps/web/spa/api/vm-uploads.ts`,
  `apps/web/spa/api/session-attachment-uploads.ts`,
  `apps/web/spa/sessions/session-attachments.ts`.
- Composer and transcript surfaces:
  `apps/web/spa/routes/sessions.tsx`,
  `apps/web/spa/sessions/session-message.tsx`,
  `apps/web/spa/sessions/session-attachment-cards.tsx`,
  `packages/ui/src/components/compose-bar/compose-bar-attachment.tsx`,
  `packages/ui/src/components/compose-bar/compose-bar.tsx`,
  `packages/ui/src/components/compose-bar/compose-bar-editor.tsx`, and
  `packages/ui/src/components/compose-bar/compose-text-overflow.ts`.
- Pixel coverage: `apps/web/tests/visual/playground.spec.ts` and the committed
  desktop/mobile `attachment-cards.png` and `compose-bar-attachments-*.png`
  baselines under `apps/web/tests/visual/__screenshots__/`.
- Deployed acceptance:
  `packages/test-harness/src/staging-e2e-synthetic` and its focused
  oracle test.

## Dead ends and corrections

- Proxying file bodies through web and API was rejected because the application
  hops impose the very body-size limit this feature must escape.
- Upload-on-submit avoided orphan bytes but lost visible progress and made Send
  appear hung; eager upload plus metadata moves won.
- Per-message/date directories were rejected in favor of one human-readable
  agent inbox.
- Bare chips were rejected after visual exploration; preview cards matched the
  established chat feel and made pending state legible.
- Giving every ready card a `Ready` label was not the shipped contract: file
  cards show the badge, while inline images become ready when `Preparing`
  disappears. The staging journey now follows those two observable states.
- An English accessible-name locator for durable images drifted from localized
  product copy. Durable inline media now exposes `data-message-inline-image` as
  the stable test boundary.
