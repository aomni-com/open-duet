# v1 chat-app attachment UX — reference recon (2026-08-12)

The user's directive: chat attachments in Duet v2 "should feel like ../chat-app —
when the user sends a file, the user's own message should show that file
attachment as part of the user's message." This file records how v1 actually
does it, from commit `faf50f0af5b793da0461cf5b27410fee0dbf4c43` of
`/Users/synthetic-user/dev/chat-app`. It is the *feel* target;
Duet's wire model differs deliberately (drive paths, not Convex storage ids —
see README).

## Composer entry points (three)

| Path | v1 code |
|---|---|
| Paperclip button + ⌘U | `apps/web/components/chat/compose-bar/primitives/compose-bar-file-upload.tsx:57-77` (hidden `<input type="file">`); hotkey at `implementations/main-compose-bar.tsx:265` |
| Drag-drop, whole page | `primitives/compose-bar-root.tsx:88-201` — listeners on `document`, yields to nested `[data-files-dropzone]` zones, only the non-`aria-hidden` compose bar claims the drop; portaled full-screen scrim with dashed pill "Drop files to attach" (`:293-302`); editor refocused after drop (`:174`) |
| Paste | files via TipTap `FileHandler.onPaste` (`primitives/input/utils/editor-extensions.ts:168-174`); text pastes over 10,000 chars become a synthesized `.txt` attachment (`tip-tap-chat-editor.tsx:253-279`, `COMPOSE_INLINE_TEXT_LIMIT` in `packages/shared/src/chat/compose-text-overflow.ts`) |

Limits in v1: 50 MB/file + executable-extension denylist (`apps/web/lib/file-upload.ts:1-38`); no MIME filter on the picker; button is single-file, drop/paste are multi.

## Pending render (composer, before send)

Not chips — **cards, `w-40`** (`compose-bar-file-preview.tsx`):
- Images: `h-40` cover thumbnail from `URL.createObjectURL`, filename in a bottom gradient, X remove top-right.
- Non-images: `h-24` type-aware preview pane + meta strip (truncated name, `EXT · formatBytes(size)`). Pending files get **real local previews before upload finishes**: first 4096 bytes read client-side — monospace snippet for text/markdown, 4-row mini-table for CSV/TSV — plus a badge chip ("PDF", "CSV") and Phosphor icon fallback. Kind/color/badge map: `message/primitives/file-preview-utils.ts` (`FilePreviewKind` at `:14`, `getFileTypeConfig` at `:172`).

## Upload lifecycle (the part worth copying exactly)

- **Bytes go up before send, not with it.** Each file starts uploading the moment it's attached; explicit `status: 'reading' | 'uploading' | 'processing' | 'ready' | 'error'` per pending attachment (`compose-bar-context.tsx:31-52`), each status with its own copy.
- **Send is gated, not spinnered**: `hasPendingUploads` disables the send button, Enter-to-send, and edit-last shortcuts (`main-compose-bar.tsx:203,232,241,274,384`). A message can only be sent once every upload resolved.
- In-progress: `bg-background/50 backdrop-blur-sm` overlay + spinner + status label centered on the card.
- Failure: destructive overlay + "Upload failed" + a pill **Retry** that re-runs on the retained `File`; errors also toast.
- Cancel: per-upload `AbortController`; X aborts (`'user_cancel'`); leaving the channel aborts all in-flight uploads and clears attachments. Aborted items removed, object URLs revoked.
- Multiple files process in parallel; part order follows upload-completion order; a completion whose pending entry was removed is dropped, not appended.

## Sent message rendering

Attachments are **message parts in the same `parts: MessagePart[]` array as
text** (`packages/backend/convex/schema.ts:81-104,1064`) — no separate
attachment object. Own and AI messages share one renderer
(`message-parts-renderer.tsx`):
- Images: ≤3 → flex row of `max-h-80` `object-contain` thumbs; ≥4 → square grid. Click → image modal.
- Files: `FilePreviewGroup` → flex-wrap of `FilePreviewCard` (`w-44`, `h-28` type-aware thumbnail over meta strip) — essentially the composer card, slightly wider. Click opens an in-app `FilePreviewViewer` modal (PDF/markdown/CSV/text render inline; persistent Download CTA; download-only fallback).
- Wire shape per part: image `{type,storageId,fileName,width,height}`, file `{type,storageId,fileName,mimeType,fileSize}`. URLs derived from `storageId` via Convex HTTP routes.

## What Duet v2 adopts vs. replaces

Adopt the feel: cards (not bare chips) in composer and bubble, local pending
previews, upload-before-send gating with per-card status/retry/cancel,
document-level file intake that yields to the Files surface while only local
dropzones present drag affordances, and big-paste-to-file. Duet deliberately
keeps selection order instead of v1's completion-order parts.

Replace the plumbing: bytes land on the workspace drive in the agent's folder
(not Convex `_storage`); the reference is a drive path (not `storageId`);
click-through opens Duet's existing file viewer (not a ported
`FilePreviewViewer`); limits are drive quota + ~10/message count cap (not
50 MB). Images keep Duet's existing inline rail unchanged.

The analogous Duet playground coverage lives in
`apps/web/components/playground/compose-bar-playground.tsx` and
`attachment-cards-playground.tsx`, with committed desktop/mobile baselines.
