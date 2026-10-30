# 04 — API orchestration: publish route + hub-sync route copy media

**Contract unlocked:** the two moments a publisher VM is guaranteed awake —
community publish and official hub sync — copy description + media through
the seam end to end.

## API seam

`apps/api/src/routes/marketplace.ts` (publish):
1. Resolve the agent row's `icon` path from Convex BEFORE inspecting (new
   small internal query — icon identity is a row fact, not a filesystem
   fact); pass `iconPath` in the inspect request.
2. `inspectListableAgent` → snapshot with optional descriptionMd/media.
3. `deriveListingMetadata` (description with clamped fallback).
4. `storeListingAssets` action (tri-state args straight from the snapshot:
   old gateway omitted the fields → absent → untouched).
5. `registerListingFromAgent` with derived + refs.
6. On registration refusal after a store: best-effort delete the fresh blobs
   (recorded residue choice if the delete itself fails).

`apps/api/src/routes/internal-admin.ts` (sync): between converge and
`completeSync`, extract each agent's description/header/icon bytes from the
in-process plan files (manifest paths + `LISTING_HEADER_CANDIDATES`), call
`storeListingAssets` **once per agent** (never aggregated — 24 agents of
future designer art must not share one arg budget), pass refs + description
into `completeSync`'s seedAgent payloads.

`apps/api/src/gateway/client.ts`: inspection return type carries the new
optional fields; a parse failure still collapses to `gateway_unavailable` —
which is why the fields must be optional, never required.

## Human-visible

Local publish of a fixture agent with `header.png` + `DESCRIPTION.md` +
icon → catalog JSON carries working URLs; local hub sync → official listings
carry descriptions.

## Verification

- api route tests with a stubbed gateway: media stored + stamped; tri-state
  honored (stub omitting fields leaves existing refs; stub sending null
  clears); refusal path deletes fresh blobs.
- sync route test with a synthetic plan carrying an image + description.
- `internal-admin.test.ts` + `marketplace.test.ts` existing cases stay green.

## Delegated to implementer

The internal agents query shape; error phrasing; per-agent action-call
concurrency (serial is fine at 24).

## Must stay green

The sync's existing begin/converge/complete sequencing and its takedown-
outranks-sync rule; `deriveListingSourceUrl` untouched.

## Feedback that would change this slice

None expected; mechanics follow 00–03.
