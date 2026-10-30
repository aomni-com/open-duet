Summary:
Duet v1 has two memory systems: Convex `memories` for one editable personal user-memory string, and sandbox-side `@duetso/agent` memory behind `duet memory` / `duet train`.
The Train feature lives at `/train` and turns uploaded files / scraped URLs into sandbox built-in memory via `duet train`, not a Convex memory row.
The authoritative trained-memory store is the sandbox CLI store; this repo wraps it but does not contain its DB schema or retrieval algorithm.
Sandbox sessions inject `DUET.md`, `SOUL.md`, `IDENTITY.md`, and `MEMORY.md` directly into the runner system prompt; Convex personal memory is appended as plain text XML-ish prompt context.
Exact sandbox memory DB path/schema and semantic-ranking internals are NOT FOUND in this repo because they live in external `@duetso/agent`.

## 1. Train Feature

The web route is `/train`, registered as “ingest a corpus into Duet's durable memory” in the SPA router. `apps/web/spa/router.tsx:239-240`

`TrainRoute` owns selected `files`, `urls`, the train phase/result, and a memories panel for already-trained memories. `apps/web/spa/train/route.tsx:26-31`, `apps/web/spa/train/route.tsx:60-88`

Users add files and links through `SourceCollector`; links are kept as URLs until train time, while files are held in React state until staging. `apps/web/spa/train/components/source-collector.tsx:163-169`

Supported file types for Train are text, code, PDF, image, Word, Excel, and PowerPoint; audio, video, iWork, and unknown extensions are rejected. `apps/web/spa/files/utils/file-formats.ts:351-369`, `apps/web/spa/files/utils/file-formats.ts:371-380`

The client pipeline scrapes URLs to markdown, reads dropped files as UTF-8 or base64, rejects empty/oversized corpora, then calls Convex `trainCorpus`. `apps/web/spa/train/hooks/use-train-corpus.ts:68-80`, `apps/web/spa/train/hooks/use-train-corpus.ts:107-171`

The Convex action stages files into `/home/synthetic-user/.duet/train-staging/<slug>-<uuid>`, runs `duet train <folder> --slug <slug> --model ...`, returns redacted stdout/headline, and deletes the scratch folder afterward. `packages/backend/convex/domains/train/actions.ts:282-295`, `packages/backend/convex/domains/train/actions.ts:356-388`, `packages/backend/convex/domains/train/actions.ts:399-437`

What Train produces is a synthesized “observation” stored by the CLI: the UI types call it `content`, `memoryId`, `slug`, `createdAt`, `observedDate`, and archive metadata. `apps/web/spa/train/hooks/use-train-memories.ts:19-47`, `packages/backend/convex/domains/train/actions.ts:463-471`

Onboarding also bootstraps Train: the sources step reuses the Train collector, and its comments say everything added is trained into durable memory in the background. `apps/web/spa/onboarding/components/steps/sources-step.tsx:9-18`

## 2. Memory Data Model

Convex `memories` schema is only `{ type: 'text:user', userId, text, updatedAt }` with index `by_user_and_type`. `packages/backend/convex/schema.ts:1068-1073`

Convex memory access is one unique row per `(userId, 'text:user')`; upsert patches existing text or inserts a new row. `packages/backend/convex/model/memories.ts:6-14`, `packages/backend/convex/model/memories.ts:16-39`

Sandbox memory files include `MEMORY.md`, whose default says built-in memory holds raw chronology while `MEMORY.md` is curated long-term memory. `packages/backend/registry/sandbox/default-files/MEMORY.md:5-8`

The runner base prompt reads `DUET.md`, `SOUL.md`, `IDENTITY.md`, and `MEMORY.md` from `/home/synthetic-user` and embeds present file contents in the system prompt. `packages/agent-gateway/src/session-controller.ts:1294-1312`, `packages/agent-gateway/src/system-prompt.ts:75-91`

Sandbox built-in memory DB path/schema: NOT FOUND in checked-in source. The repo only proves there is a CLI-backed memory DB through tests/comments like “empty memory DB” and `duet memory add`. `packages/agent-gateway/src/scheduler-guard.docker.test.ts:32-57`

Authority: for trained/built-in memories, the repo explicitly treats the `duet-agent` CLI as source of truth for JSON payloads. `packages/backend/convex/domains/train/actions.ts:460-471`

## 3. Write Path

Personal Convex memory is written from Settings → Personalize via `PersonalMemoryCard`, which calls `updateTextMemory`. `apps/web/spa/settings/personalize/route.tsx:25-31`, `apps/web/components/memories/personal-memory-card.tsx:17-36`

`updateTextMemory` authenticates the current user and upserts their Convex `text:user` memory, then emits analytics. `packages/backend/convex/domains/memories/mutations.ts:8-27`

Train UI creates sandbox memory by calling `trainCorpus`, which executes `duet train`; the web app does not write Convex `memories` for trained corpora. `apps/web/spa/train/hooks/use-train-corpus.ts:165-181`, `packages/backend/convex/domains/train/actions.ts:388-431`

Onboarding writes `MEMORY.md` during config persistence by reading `IDENTITY.md`, `SOUL.md`, and `MEMORY.md`, asking a model to update them, then writing changed files back. `packages/backend/convex/domains/onboarding/actions.ts:587-599`, `packages/backend/convex/domains/onboarding/actions.ts:640-668`, `packages/backend/convex/domains/onboarding/actions.ts:696-704`

Onboarding sources also write trained memory by calling `scrapeUrlsToMarkdown` and `trainCorpus` in `trainOnboardingSources`. `packages/backend/convex/domains/onboarding/actions.ts:708-718`, `packages/backend/convex/domains/onboarding/actions.ts:767-793`

Agent runtime writes automatic observations in `@duetso/agent`; gateway only receives `memory` events and records counts of added observations/reflections and bumped prior memories. `packages/agent-gateway/src/session-controller.ts:250-260`, `packages/agent-gateway/src/session-controller.ts:1478-1486`

Explicit CLI memory writes are via the default `remember` skill using `duet memory add`; notes are stored as `kind: note` / `source: user`. `packages/backend/registry/sandbox/default-skills/remember/SKILL.md:15-19`, `packages/backend/registry/sandbox/default-skills/remember/SKILL.md:43-78`

HTTP API route for direct memory creation: NOT FOUND. The public API files found cover embeddings/search/messages/feedback, not memory mutation. `packages/backend/convex/domains/publicApi/actions.ts:45-70`, `packages/backend/convex/domains/publicApi/actions.ts:216-237`

## 4. Read Path

Convex personal memory is read by authenticated query `getUserTextMemory`, which fetches the current user and returns their `text:user` row. `packages/backend/convex/domains/memories/queries.ts:5-11`

Sandbox turns refresh user memory every turn via `buildTurnChannelContext`, then append it as `<user-memory>` plain text in the system prompt. `packages/backend/convex/domains/sandboxes/actions.ts:239-245`, `packages/backend/convex/domains/sandboxes/actions.ts:328-335`, `packages/backend/convex/domains/sandboxes/actions.ts:194-200`

The gateway combines base system prompt plus append prompt and passes it to the runner through `--system-prompt-file`. `packages/agent-gateway/src/session-controller.ts:520-536`, `packages/agent-gateway/src/session-controller.ts:1216-1238`

`MEMORY.md` is injected by direct file inclusion, not a vector lookup in this repo. `packages/agent-gateway/src/session-controller.ts:1296-1301`, `packages/agent-gateway/src/system-prompt.ts:84-90`

Built-in memory date-range reads happen through `duet memory --json --from ... --to ...`; daily heartbeat uses that to read observations and reflections. `packages/agent-gateway/src/built-in-cron-prompts.ts:37-53`

Relevance/recency internals for built-in memory retrieval: NOT FOUND in this repo. Evidence of ranking/recency exists only at the interface: JSON fixture rows include `score` and `lastUsedAt`, and gateway memory events count bumped `lastUsedAt` rows. `packages/ai-evals/src/evals/fixtures/daily-memory.json:3-14`, `packages/agent-gateway/src/session-controller.ts:1478-1486`

## 5. Memory Scope

Convex personal memory is per-user because the schema stores `userId` and queries by `userId,type`. `packages/backend/convex/schema.ts:1068-1073`, `packages/backend/convex/model/memories.ts:10-13`

Train and built-in sandbox memory are scoped to the organization’s default sandbox because train actions require `organizationId` and connect to that org’s default sandbox. `packages/backend/convex/domains/train/actions.ts:299-310`, `packages/backend/convex/domains/train/actions.ts:360-362`

Sharing semantics are therefore: sandbox memory/files are workspace/org-level in the default sandbox; Convex personal memory is user-level and appended for the current author. `packages/backend/convex/domains/sandboxes/actions.ts:151-155`, `packages/backend/convex/domains/sandboxes/actions.ts:194-200`

Per-channel trained memory scope: NOT FOUND. Train list/show/delete take only `organizationId` plus optional `slug`, not channel/agent ids. `packages/backend/convex/domains/train/actions.ts:512-557`

## 6. Dedup, Editing, Deletion, Size Limits

Train URL scrape batch limit is 25 URLs. `packages/backend/convex/domains/train/actions.ts:39-41`, `packages/backend/convex/domains/train/actions.ts:90-92`

Train corpus limit is 200 files and 10 MiB transmitted content. `packages/backend/convex/domains/train/actions.ts:136-137`, `packages/shared/src/constants/sandbox.ts:38-47`

Filenames/paths are deduped during scraping and staging. `packages/backend/convex/domains/train/actions.ts:42-64`, `packages/backend/convex/domains/train/actions.ts:198-223`

Each train creates a unique slug with a random suffix, so colliding names do not overwrite existing memories. `packages/backend/convex/domains/train/actions.ts:318-325`

Trained memories can be listed, shown, updated, and deleted through `duet train list/show/update/delete`; update replaces only observation text and preserves archive/headline/model/file-count. `packages/backend/convex/domains/train/actions.ts:463-471`, `packages/backend/convex/domains/train/actions.ts:560-575`

The Train memories UI exposes open, edit/save, and delete flows through `viewMemory`, `updateMemory`, and `deleteMemory`. `apps/web/spa/train/hooks/use-train-memories.ts:158-187`, `apps/web/spa/train/hooks/use-train-memories.ts:203-237`

`updateTrainMemory` rejects empty content and content over the 10 MiB train corpus cap. `packages/backend/convex/domains/train/actions.ts:586-592`

`MEMORY.md` maintenance guidance imposes a 15KB cap and tells the agent to prune or split specialized detail into subfiles. `packages/agent-gateway/src/built-in-cron-prompts.ts:66-72`

Built-in memory dedup/retention/deletion API beyond train delete and reflection compaction: NOT FOUND in checked-in source. `duet memory reflect` exists as daily shell compaction, but its internal algorithm is in `@duetso/agent`. `packages/agent-gateway/src/cron-config.ts:170-180`, `package.json:9-14`
