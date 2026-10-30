# Duet workspace backup — format version 1

This is a live capture, not an atomic snapshot. Files and records can change
between reads. Inspect manifest.json and warnings.ndjson before recovery;
partial means detected omissions or changes, and complete only means none were
detected. inventory.ndjson records captured byte hashes, Unix modes, mtimes and
link targets. The final ZIP checksum lives in the backup job record.

Copy drive/ into the receiving workspace's configured Drive root. Include hidden
files, dependencies and caches. Preserve symlinks as links and inspect absolute,
external and dangling targets before using them. Do not follow those links during
copy. The archive deliberately preserves file contents, including credentials
stored in Drive, so handle this download as private workspace data.

Use the receiving workspace's current, system-managed `DUET_API_URL` and
`DUET_API_KEY`. Resolve its workspace identity with `GET /v1/whoami`; never use
an archived workspace ID as the destination. The [current API reference](https://service.example.invalid/reference/)
and [workspace guide](https://service.example.invalid/workspaces/) describe the supported
operations. Discover those operations instead of inventing a restore endpoint.

After copying files, recreate agents before app registrations and integration
policies that refer to them. Read the portable records under workspace/, record
the new IDs returned by the API, and use that mapping when translating source
agent/server IDs and logical Drive paths. Slugs may collide. Reapply supported
workspace settings through their documented operations.
Assistant name, model selection and spending limit can be reapplied. Purpose can
only be filled through onboarding when the destination has no purpose yet;
otherwise retain it as historical context. Onboarding flags are context.
Reconnect OAuth/provider integrations. Stored static
MCP credentials accompany their definitions. Never overwrite current VM/platform
credentials with old IDs or invent an import endpoint.

Session events, transcripts, images, todos, follow-ups and machine definitions are
historical files for reference. Do not replay messages or promise native chat
import, execution restart, running processes, or scheduled task continuation.
Per-session metadata records the captured maximum event sequence.

Member directories and membership grants, personal read/archive state, platform
auth keys, billing balances, share/marketplace authority and external public URLs
are not restorable from this archive. No private VM state outside Drive is included
(memory/checkpoints, Chrome profiles and outside-Drive provider files are absent).
Hardlinks may become independent files and sparse files may occupy their full
logical size. ZIP timestamps have one-second precision (the inventory retains the
observed mtime); special filesystem nodes cannot be recreated and produce warnings.
