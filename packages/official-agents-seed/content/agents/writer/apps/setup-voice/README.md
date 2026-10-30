# Voice Setup

The Writer's onboarding app. It takes two or three things the author has already
written and records **what an edit must preserve** — then unlocks the agent.

This seat's whole refusal is "never flatten voice", and without this it can only
infer voice from the draft in front of it, which is the draft it was asked to
change. Reading finished work once, up front, is what makes "preserve this" name
something specific instead of a good intention.

`state.json` is runtime data, created on first read and persisted atomically
beside the app; the profile itself lives in the agent's folder, because it is the
agent's working material rather than this app's state. Sample text is held in
memory only until the author confirms — nothing is written to the drive before
they say to.

## What it collects

**Writing**, attached or pasted. Files and paste count the same. Below about 150
words the app refuses rather than guessing, because a profile read from one
paragraph is invented rather than observed. It shows each sample's word count and
first line back, so a mis-attached file is obvious before anything is written.

**One setting**, because reading cannot settle it: how far an edit may go.

| Licence | What the agent does |
| --- | --- |
| `light` | Copyedit only. No restructuring, no cutting a paragraph without asking |
| `balanced` | Two passes — structure, then line. Hands back anything past a third rewritten |
| `firm` | Restructures freely when the argument needs it; still never changes what the piece claims |

Adding more writing never resets a licence the author already chose.

## What it writes

`POST /api/confirm` reads the samples with one model call, then writes:

- `voice/author-voice.md` — the licence as a rule the agent can act on, plus
  **Register**, **Preserve**, and **Tics to leave alone**. The Preserve section
  quotes real examples from the samples, because "keep their voice" is not an
  instruction and "keep the three-word sentences used as full stops" is.
- `voice/samples/` — the writing itself, which is the evidence behind every
  "I left this alone" in a later editorial note.

Only then does it mark the agent onboarded. That order is the contract: unlocking
a seat whose profile was never written opens the card onto a writer that has
nothing to preserve. If the model is unreachable the profile is still written —
licence intact, the read sections marked open — and the agent asks the author
before its first edit.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Samples read so far, the licence, and whether setup is complete |
| `POST` | `/api/samples` | `multipart/form-data` with one or more `sample` parts — files or text |
| `PUT` | `/api/licence` | `{licence}` — one of `light`, `balanced`, `firm` |
| `POST` | `/api/confirm` | Reads the voice, writes the profile and samples, ends onboarding |
| `GET` | `/events` | SSE invalidations after committed changes; native `EventSource` reconnects |

A later session changes the profile by editing `voice/author-voice.md` directly —
ordinary agent work that does not come back through this app.

## Where the real calls live

`duet.ts` is the app's entire outward edge; every call carries the app's own
runtime key.

- **`services`** — the workspace model gateway at `$DUET_GATEWAY_BASE_URL`. The
  gateway attributes that generation to *this app*, so it authenticates with its
  own key and never receives the runner's workspace-wide `DUET_API_KEY`.
  The `services` tier bills the concrete model at upstream cost.
- **`files:write`** — the profile and the samples, written under
  `$DUET_AGENT_DIR`. The app never assumes that path: an installed copy is named
  by whoever installed the agent. Absent means the platform has not said yet, and
  the app refuses to write rather than guessing.
- **`agents`** — `POST /v1/ws/:slug/app/onboarded`, the only thing that ends
  onboarding. No session runs during an app onboarding.

Run it with `bun run server.ts`; Duet injects `$PORT`, `$DUET_API_URL`,
`$DUET_APP_API_KEY`, `$DUET_GATEWAY_BASE_URL`, `$DUET_APP_DIR`, and
`$DUET_AGENT_DIR`.
