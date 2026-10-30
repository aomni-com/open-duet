---
name: memory
target: sandbox
description: Decide where something the user wants kept belongs — ordinary observed memory, the agent's AGENTS.md, or its pinned memory store — and write it there. Use when asked to remember, save, note, pin, memorize, learn, train on, or stop remembering something, or to check what is already remembered.
---

# Memory

Three places hold what an agent knows, and most of what it learns belongs in
the one that files itself.

## Where it goes

**A preference, an event, a fact about the user or the work → observational
memory.** The conversation is already written there and recalled when it is
relevant. Ranking by relevance is the feature: it surfaces what matters to the
turn instead of holding everything at once, and it ages gracefully as facts
change. Copying such things into a pinned store buys permanence nobody asked
for and costs that ranking.

If it merely came up, leave it — the observer has it. If the user asked you in
so many words to remember it, write it down as well:

```bash
duet memory add --db "$DUET_SESSION_MEMORY_DB" --session "$DUET_SESSION_ID" \
  "Prefers metric units in reports"
```

`$DUET_SESSION_MEMORY_DB` is this session's own database, already in your
environment; without it the command would file the note under the drive root's
memory instead of yours. Writing what the observer also recorded is not a problem —
the reflector condenses duplicates across sessions — and an explicit ask
deserves a row that says exactly what the user said, not the observer's
paraphrase of it. Read it back with
`duet memory --db "$DUET_SESSION_MEMORY_DB" --json`.

**Something that changes how you work → your `AGENTS.md`.** Role, procedure,
standing rules, the way this user wants things done, a correction you must not
repeat. Your `your-folder` system prompt names your folder; `AGENTS.md` sits at
its root, is read at the start of every session, and the user can open and edit
it. Prefer it for anything core — it is the readable, editable version of the
same permanence.

**Source material a person hands you → a training job, and only when they ask
for one.** Training is the user's tool, driven from the Train page. Do not
start a job because material came up in conversation; start one when the user
says to train on something.

If the user explicitly asks for a pinned memory rather than an instruction,
write to the store — see below.

## Writing to AGENTS.md

Edit the file, do not rewrite it. Add the rule as its own line or short
section, in the imperative, in the voice of the rest of the file, and keep it
short enough that it earns its place in every future session. Say back what you
added, since the user is now living with it every turn.

Never write behavior into `agent.json` — that file is config, not instruction.

## The memory store

Reserved for what training installs, and for a fact the user explicitly asks
you to pin. One markdown file per entry, in your own store, pinned into every
session in full:

```bash
duet memory add "Enterprise discounts cap at 20%"
duet memory add --store <your store> "Enterprise discounts cap at 20%"
```

Always through the command — never create or edit a file in the store
yourself, not with a heredoc and not by copying a markdown file in. The command
gives the entry its id and creation time and writes the frontmatter the
workspace's index reads; a file you compose has none of that.

With no backend flag the note lands in the nearest ancestor folder that owns
`.agents` — your own folder while you are working inside it. Pass `--store`
with the path from your `your-folder` prompt whenever your working directory
might be elsewhere: a note in the wrong store teaches the wrong agent, and the
command reports success either way. The store at the drive root belongs to the
workspace and every agent reads it; write there only for something the whole
workspace should know.

A successful add prints the entry's slug and the store it landed in. Read that
path back — `ls` it, or `cat` the file it names — and report success only once
the fact is there. Each backend answers to its own reader: `duet memory --json`
reads the observation database and will never show a stored note, however well
the write worked.

## Training on sources, when asked

The job archives every source, synthesizes a record, and installs it in your
store. Resolve `<workspaceSlug>` with `GET /v1/whoami` and your own
`<agentSlug>` from `GET /v1/ws/<workspaceSlug>/agents`, matching `anchorPath`
to the folder named in your `your-folder` prompt rather than assuming folder
name and slug match.

```bash
curl -sS -X POST "$DUET_API_URL/v1/ws/<workspaceSlug>/agents/<agentSlug>/train" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"urls":["https://example.com/page"]}'
```

It answers with a `jobId`. Poll
`GET $DUET_API_URL/v1/ws/<workspaceSlug>/agents/<agentSlug>/train/<jobId>`
until it reports a terminal state, then tell the user what was learned and
where it lives. Files already in the drive train the same way through
`driveFiles`. The same routes without `/agents/<agentSlug>` train the
workspace instead of you — only when the user asks for that.

## Checking and correcting

`ls` the store from your `your-folder` prompt to see what is pinned, read
`AGENTS.md` for what is instructed, and
`duet memory --db "$DUET_SESSION_MEMORY_DB" --json` for what is observed. When the user says something you hold is wrong,
fix it where it lives — edit the `AGENTS.md` line, delete the store file —
rather than adding a second entry that contradicts the first.
