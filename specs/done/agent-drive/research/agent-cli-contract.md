# @duetso/agent CLI contract for Agent Drive

Status: shipped-contract record for `@duetso/agent@0.1.202`, verified against
`/Users/synthetic-user/dev/duet-agent` on 2026-07-07. Duet adapts to this CLI; this repo
does not change the agent source.

## Shared Rules

- Binary: `duet`.
- Memory JSON owner: `/Users/synthetic-user/dev/duet-agent/src/cli/memory-json.ts`.
- RPC protocol owner: `/Users/synthetic-user/dev/duet-agent/src/types/protocol.ts`.
- `--wait` values are seconds, not milliseconds.
- `--db <path>` selects the memory DB for memory and train commands.
- `duet capabilities` does not exist. Duet must not preflight it or refuse work
  based on advertised memory/schema/RPC versions.

## Memory JSON

Every memory command that emits an observation uses the canonical `MemoryJson`
shape:

```json
{
  "id": "mem_...",
  "content": "Enterprise discounts cap at 20 percent",
  "kind": "note",
  "source": "api",
  "priority": "medium",
  "createdAt": "2026-07-07T00:00:00.000Z",
  "lastUsedAt": "2026-07-07T00:00:00.000Z",
  "observedDate": "2026-07-07",
  "tags": [],
  "packScore": 1,
  "relevanceScore": 0.9
}
```

Optional fields are emitted only when present: `referencedDate`, `relativeDate`,
`timeOfDay`, `sessionId`, `packScore`, and `relevanceScore`. `source` is a flat
string: `user`, `agent`, `system`, `api`, or `import`. There is no `train`
source and no generic `score`; recall uses `relevanceScore`, and pack ranking
uses `packScore`.

## `duet memory add`

```text
duet memory add [--db <path>] [--priority <high|medium|low>] [--source <user|agent|system|api|import>] [--session <id>] [--tag <tag>] [--json] [--wait <seconds>] <content>
```

Content may also come from stdin. The stored row is always `kind: "note"`;
there is no `--type` flag. API-originated writes use `source: "api"` and should
pass `--session <id>` when a Duet session id is available.

With `--json`, stdout is one `MemoryJson` object.

## `duet memory recall`

```text
duet memory recall [--query <q> | <query...>] [--scope <session|global|all>] [--session <id>] [--expand] [--model <model>] [--limit <n>] [--db <path>] [--json] [--wait <seconds>]
```

`memory search` does not exist. With `--json`, stdout is a bare best-first array
of `MemoryJson` rows. Duet keeps its REST path `/memories/search` and MCP tool
`memory_search` stable, but both adapt to `memory recall` underneath and wrap
the bare array back into their Duet-facing response shape.

## `duet train`

Create:

```text
duet train <folder> [--slug <slug>] [--model <model>] [--db <path>] [--wait <seconds>]
```

Management readback:

```text
duet train show <slug> [--db <path>] [--json] [--wait <seconds>]
```

Create has no `--json` mode and no NDJSON progress stream. It prints human text
to stdout/stderr and exits `0` on success. It persists one `kind: "manual"`,
`source: "system"` memory row tagged for train. Duet treats create exit `0` as
success, then reads `duet train show <slug> --json` to confirm the memory row
and recover `memoryId`. Duet UI/backend progress during create is cosmetic.

`train show --json` returns the training record keyed by slug, including
`memoryId`, ISO `createdAt`, `observedDate`, archive metadata when present, and
the stored memory `content`.

## RPC

The real RPC process is started as:

```text
duet --rpc --session <id> --workdir <cwd>
```

`start` is setup only:

```json
{ "type": "start" }
```

The first user message is a separate prompt command:

```json
{ "type": "prompt", "message": "summarize the repo", "behavior": "follow_up" }
```

Prompts MAY carry image attachments (under-documented in the original
record; verified in `src/types/protocol.ts:384-399`):

```json
{
  "type": "prompt",
  "message": "what's in this?",
  "behavior": "follow_up",
  "images": [{ "data": "<base64 raw bytes>", "mimeType": "image/png" }]
}
```

`turn_started` is only:

```json
{ "type": "turn_started", "state": {} }
```

There is no `protocolVersion`, `turnId`, `sessionId`, or `startedAt` field on
that event. Terminal event types are `complete`, `ask`, `interrupted`, and
`sleep`. During-turn events include `step`, `todos`, `follow_up_queue`,
`state_machine`, `memory`, `usage`, and `system`.

## Deleted Frozen-Contract Assumptions

Duet must not depend on these stale surfaces:

- `duet capabilities --json`
- RPC `protocolVersion` negotiation or refusal
- `duet memory search`
- `duet memory add --type`
- `source: "train"` or `--source=train`
- `duet train <folder> --json`
- train NDJSON progress
