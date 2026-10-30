# Archive default chat — quadrant map

A control in the agent surface's `CHAT` sub-header that demotes the current
default chat to an ordinary session and leaves the agent with a fresh one.

Walked 2026-08-17 on branch `worktree-reset-default-session`. **Not built.**
This map is the input to the build, not a record of one.

---

## Q1 · Known knowns — the settled ground

### "Default" is a pointer, not a property

There is no `isDefault`, `kind`, or `mode` column on `agentSessions`. The fact
lives on the **owner** row as one optional slot:

| owner | field | schema |
| --- | --- | --- |
| an agent | `agents.defaultSessionId` | `packages/backend/convex/schema.ts:633` |
| the drive root | `workspaces.rootDefaultSessionId` | `packages/backend/convex/schema.ts:301` |

Both are `v.optional(v.id('agentSessions'))`, neither is indexed. Uniqueness is
structural — one slot per owner, so two defaults are unrepresentable. The
contract states the omission is deliberate
(`packages/contract/src/sessions/index.ts:299-303`): *"a column on the session
would be a second owner of one fact."*

**Five readers, all deriving from the pointer, none caching it:**

- `getDefaultSessionImpl` — `domains/agentSessions/queries.ts:36-63`
- the `excludeDefault` list filter — `queries.ts:290-297`
- the delivery open-or-create branch — `delivery.ts:257-289`
- the per-dispatch flag — `delivery.ts:603-606`
- `defaultAgentSessionId` helpers — `queries.ts:65-72`, `delivery.ts:680-689`

**Two writers, and no endpoint for either:** delivery stamps
(`delivery.ts:380-391`) and sealing a session for deletion clears
(`sealSession` in `deletion.ts`).

### Clearing the pointer already produces the whole feature

| consequence | mechanism | evidence |
| --- | --- | --- |
| old chat appears in Jobs | the dialog passes `excludeDefault: true`, which drops *the currently-pointed id* and nothing else | `agent-jobs/use-agent-jobs.ts:117`, `queries.ts:290-297` |
| the surface shows an empty chat | `GET …/sessions/default` answers `{session: null}` on a **200** — "no chat yet" is its ordinary answer | `apps/api/src/routes/default-session.ts:107-114` |
| the empty state already exists | `defaultChatMount` has a `compose` branch; `SessionIntro` draws the day-one mascot | `spa/sessions/default-chat.ts:75-86`, `spa/sessions/session-intro.tsx` |
| the next message mints and stamps a new default atomically | the alias carries `defaultOwner`; delivery patches the pointer in the same transaction | `delivery.ts:380-391` |

### The UI slot already exists

`SectionHead` (`spa/routes/agents-map/agent-surface/parts.tsx:189`) is already
`flex items-baseline justify-between` with an optional right-hand `note` slot,
and has exactly **one** call site — `agent-surface/index.tsx:371`. Extending it
cannot disturb anything else.

This is why the header's door row was rejected as a home: `knowledge-map.css:1745-1786`
states that the beside-the-face layout survives only while the door row fits one
line **in every shipped locale**, and the `@container (max-width: 80rem)`
breakpoint is hand-tuned to the current three doors (244px in English, 280px in
es-419, which is the deciding locale).

### The confirm-dialog pattern

Radix `AlertDialog` from `@repo/ui/components/shadcn/alert-dialog`. Canonical
copy: `DeleteAgentDialog`, `spa/agents/agent-actions.tsx:242-273` — open state
derived from a target (`open={target !== null}`), `onOpenChange` refuses to
close while pending, failure stays *inside* the dialog with a retry, and the
confirm is a plain `<Button>` rather than `AlertDialogAction` precisely so it
does not auto-close.

The generic `<ConfirmDialog>` in `packages/ui/src/components/common/` is **not**
the product pattern — its only consumer is the primitives playground.

### Assumed settled unless contradicted

- The surface is the knowledge-map agent surface
  (`spa/routes/agents-map/agent-surface/`), not the older
  `spa/routes/agents/agent-detail-canvas.tsx` (which has no Settings or Jobs
  door and is not what the screenshot showed).
- Authorization is the existing `sessions` capability
  (`requireAuthedWorkspace(c, 'sessions')`) and Convex `editor` role — no new
  scope. Inside a workspace VM there is one trust domain (`SECURITY.md`).

---

## Q2 · Known unknowns — the decision ledger

| # | question | decision | closed by | why |
| --- | --- | --- | --- | --- |
| D1 | where does the control live | right-aligned in the `CHAT` sub-header | user | the door row costs a locale re-measure and a container-query change; `SectionHead` already has the slot |
| D2 | what does "archive" *do* | **demote only** — clear the pointer, `archiveState` untouched | user | real archiving hides it from Jobs *and* everywhere else; nothing in the SPA ever requests `archived: 'only'`, so there is no archived view to land in |
| D3 | mid-turn behaviour | let the turn keep running; never call `requestInterrupt` | user | `defaultSession` is recomputed per dispatch so nothing races; the work still lands, and the thread sits in Jobs under `running` |
| D4 | who gets the button | every agent **and** Duet/root; absent when there is no default chat yet | decided + reported | root is an owner like any agent (`ROOT_AGENT_SCOPE`); the CHAT section already inherits setup-mode and entitlement gating (`index.tsx:369`, `agents-map.tsx:1003`) |
| D5 | the wire | `PUT /v1/ws/{slug}/agents/{agentSlug}/sessions/default` body `{ sessionId: string \| null }` | user | reversible in the API, one-way in the product — **no "Make default" item in the Jobs ⋯ menu** |
| D6 | is a new session created at reset time | **no — lazy** | territory | the only insert path (`createSessionForInitialDelivery`, `creation.ts`) requires a prompt and dispatches a turn; an eager empty session would have to fabricate one |
| D7 | button weight | icon + text | user | — |
| D8 | dialog copy | plain mechanics, keeping the "it keeps running" line, normal (not red) confirm button | user | nothing is destroyed; red would say otherwise |
| D9 | after it lands | **no toast** — the chat panel simply empties | user | — |
| D10 | disabled while a first message is in flight | yes | decided + reported | otherwise the in-flight create re-stamps the pointer (see L8) |
| D11 | L2, the gateway's sticky flag | **accept, do not fix here** | user | see L2 |

### Copy to write (D8)

> **Archive this chat?**
> This conversation moves to **Jobs**, where you can still read it and reply to
> it. Anything {agentName} is working on right now keeps running. A new chat
> starts here. Nothing is deleted.
>
> `Cancel` · `Archive chat`

Button label: **Archive default chat**, with an archive-box icon.

---

## Q3 · Unknown knowns — what got extracted

- **Weight.** Icon + text, not a glass plate and not icon-only. The CHAT header
  has zero chrome today, and a plate there would compete with the door row a
  few pixels above it.
- **Tone.** Nothing is destroyed, so nothing should look destructive. Normal
  confirm button, mechanics-first copy, no red.
- **Silence after success.** No toast, no "View in Jobs" link. The empty chat
  is its own confirmation; the thread is one click away in Jobs.
- **Vocabulary.** The user's word for the gesture is *archive*, even though the
  mechanism deliberately is not `archiveState`. The label wins; D2 records the
  divergence so nobody later "fixes" the label into the column.

### Context probes — asked, not answered. Recorded as assumptions.

| probe | assumption in force | what would change if wrong |
| --- | --- | --- |
| who is this for — you, or every user? | a front-door affordance, so `es-419` copy is written properly rather than adequately | if it is a power-user hatch, the weight could drop to icon-only and the Spanish string matters less |
| what does done look like? | merged to staging with unit tests + the visual gate green; **no** live staging journey in `packages/test-harness` | AGENTS.md asks for a journey on "big enough" changes; this reads well under that bar, but it is the user's call |
| is the wedged 820-minute turn in the screenshot the actual motivation? | no — treated as housekeeping ("this conversation is done, give me a clean one") | if the real pain is *wedged* chats, archiving is the right hatch but not the whole fix, and an interrupt-adjacent problem is still open |

---

## Q4 · Unknown unknowns — landmines

Status: **must-fix** (this build), **decided** (answered above), **sharp edge**
(awareness only, pre-existing).

### L1 · `created` pins the old chat forever — must-fix

`sessions.tsx:365` holds `const [created, setCreated] = useState<{owner, sessionId}>()`,
and `default-chat.ts:82` returns it **before** consulting the query:

```ts
if (state.created !== undefined) return { kind: 'session', sessionId: state.created }
```

Nothing clears it. The panel is keyed by agent, not session
(`agents-map.tsx:1008`), so it does not remount. For the person who started the
chat in this tab, archiving refetches `null` and the panel keeps showing the
archived conversation until they fly to another agent or reload. No error, no
spinner — the `compose` branch is unreachable for them.

**Fix at the reset site: clear `created`.** Do *not* invert the precedence in
`defaultChatMount` — that reintroduces the blink its doc comment
(`default-chat.ts:74-79`) exists to prevent, and `default-chat.test.ts` pins it.

### L2 · The gateway never un-learns "I am the default" — decided: accept

`mergeGatewaySessionLaunch` (`packages/gateway/src/agent-sessions/ledger.ts:902-919`)
is `{...existing.launch, ...input}`. An absent key deletes nothing, and
`integrations` is the **only** field with a fail-closed delete. Convex correctly
stops sending `defaultSession` once the pointer clears (`delivery.ts:657`, whose
own comment asserts the opposite behaviour), but the persisted envelope keeps
it, so `agent-context.ts:397,482` keeps writing `default-session.md` — *"NEVER
create a state machine here"* — into the archived thread's system prompt
forever. `defaultSession` appears in **zero** gateway ledger tests.

Currently unreachable, because the only pointer-clearing path today destroys the
session. **This feature makes the bug live.** After archiving: ordinary session
in Convex, appears in Jobs, correct bucket — but on the VM it still has chat
manners and will refuse to create a state machine.

The one-line fix, if it is ever wanted:

```ts
// ledger.ts, beside the integrations delete
if (input.defaultSession === undefined) delete merged.defaultSession
```

It would ship with the api deploy via `apps/api/src/gateway/release.ts`'s baked
manifest and self-heal on the fleet's own poll — no pin, no migration.

### L3 · Invalidation is three families, not one — must-fix

`sessionKeys.default`/`defaults` and `sessionKeys.activity` sit **deliberately
outside** the `lists()` prefix (`spa/api/query-keys.ts:136-141`, and the note at
`spa/sessions/session-cache.ts:72-84`). Required after a successful PUT:

```ts
duetQueryKeys.workspaces.sessions.defaults(workspaceSlug)   // the alias — panel + ring share it
duetQueryKeys.workspaces.sessions.activity(workspaceSlug)   // the map's read
duetQueryKeys.workspaces.sessions.lists(workspaceSlug)      // the four Jobs buckets
```

`ring-freshness.ts:79-83` already does the first two — copy that shape.

**Invalidate all three in the same tick.** ~~The map's `activity` read has no
`excludeDefault`, so a split tick draws the session as a chat bead *and* a job
bead at once.~~ *(2026-08-20: that read answers each owner's `chat` separately
from its work, so the bead cannot double — but all three still carry the answer,
which is why all three are still invalidated together.)*

**And you cannot patch instead of invalidating**: ~~`sessionFiltersFromKey`~~ *(2026-08-20: it keeps `excludeDefault` now, and `defaultChatIds` supplies the withheld id)* `sessionFiltersFromKey`
(`session-cache.ts:295-310`) parses `search`/`archived`/`bucket`/`agentId` and
**drops `excludeDefault` entirely**, so the optimistic splicer is structurally
blind to the one dimension this feature changes.

### L4 · The playground fixture cannot represent a cleared pointer — must-fix

`defaultSessionOf` (`apps/web/components/playground/spa-fixture.ts:1688-1694`)
*derives* the default as "first session whose `agent.id` matches" — there is no
stored pointer. The fixture is genuinely type-checked (`spa-fixture.ts:302`
declares `: SpaApi`), so the moment the method is added to `SpaApi`
(`spa/context.ts:~74`) `apps/web` typecheck fails until it is implemented.

Honest fix: add a real pointer to the fixture store and have `defaultSessionOf`
read it, with the current derivation as the seed — so `getDefaultSession`,
`listSessions({excludeDefault})` and the new setter stay one rule. The file's own
comment argues against an inert stub.

### L5 · Three registry gates fail the instant the route exists — must-fix

- `packages/contract/src/endpoints/index.test.ts:34-59` — an **exact `toEqual`**
  over the 4-tuple list of every `/sessions/default` endpoint. Insert the new
  row in registry order.
- `apps/api/src/endpoint-metadata.test.ts:60-82` — fails in **both** directions:
  a route with no contract entry, and a contract entry with no route.
- `apps/docs/tests/endpoint-coverage.generated.json` — committed ledger,
  `endpointCount: 141`. Regenerate with
  `bun --cwd apps/docs run endpoint:coverage:write`.

The docs `/sessions` page is full-page screenshotted
(`apps/docs/tests/visual/docs.spec.ts:5-49`), so **two docs baselines move too**
(desktop + mobile).

Also enforced by `apps/docs/scripts/verify-endpoints.ts`: a non-GET/DELETE
endpoint **must** have a `requestSchema`, every endpoint **must** have a
`responseSchema`, and every schema must survive `toJSONSchema` — so keep the
body transform-free (`{ sessionId: z.string().min(1).nullable() }`).

### L6 · The visual gate is the expensive part — must-fix

Baselines needing re-approval, **desktop and mobile**:
`agent-surface`, `agent-surface-busy`, `agent-surface-quiet`,
`agent-surface-duet`, `agent-surface-app-frame`, `agent-surface-app-loading`
(+ `-dark`), `knowledge-map`, `knowledge-map-home`, `knowledge-map-zoom`,
`knowledge-map-jobs`, `knowledge-map-peek`.

Two hard assertions sit directly in the blast radius:

- `apps/web/tests/visual/playground.spec.ts:4447` — `scrollWidth <= innerWidth`.
  A right-aligned control in a `justify-between` header inside the narrow left
  column is exactly what overflows.
- `playground.spec.ts:4174` — `wellToChat` measured against `GAP_SKEW_PX = 0.5`.
  A control taller than the current `km-eyebrow` line moves `.km-chat`'s top and
  trips it. `.km-chat` is `grid-template-rows: auto minmax(0,1fr)`
  (`knowledge-map.css:1878-1881`); the header occupies the `auto` track, so
  growing it eats the conversation's.

**Cheap dodge:** add the action as an **optional prop on `SectionHead`**, not a
new exported component. A new exported visual symbol must be declared in
`apps/web/tests/visual/coverage.ts` or `verify-visual-coverage.ts` fails.

Two shots must stay unchanged: `playground.spec.ts:4131` and `:4277` assert
`.km-chat` has count 0 in setup mode.

### L7 · A missing Spanish string ships as English, silently — must-fix

`surface-copy.test.tsx` collects next-intl `onError` complaints and asserts
`[]`, so a label missing from `apps/web/messages/en/app.json` fails the suite.
But **the harness only loads `en`** — a key missing from
`apps/web/messages/es-419/app.json` fails nothing and ships the English word.
New keys go under `duetApp.agentSurface` (beside `"chat"`, en/app.json:1207).

`surface-copy.test.tsx`'s `renderSurface` (`:62-86`) does not pass any new prop,
so a **required** prop breaks every test in that file at compile time. Make it
optional.

### L8 · A send in flight re-stamps the pointer — decided: disable

`onCreated` (`sessions.tsx:784`) fires whenever the create mutation resolves,
re-setting `created` and re-pointing the agent at a brand-new session. The
button is disabled while `useSessionCreation` has a prompt in flight — the same
fail-closed shape as `DeleteAgentDialog`'s `del.isPending`.

### L9 · No realtime for the pointer, and the backstop is off where it matters — sharp edge

~~`chatBackstopInterval`~~ *(deleted 2026-08-20 with the per-face fan-out)* (`spa/knowledge-map-data/ring-freshness.ts:180-184`)
returns `false` while an agent is unfolded, and the alias query stops polling
entirely once it answers `null` (~~`use-default-chats.ts:98-100`~~ *(module deleted 2026-08-20)*). A second tab —
or a colleague — parked *inside* the agent panel holds the old conversation
indefinitely. Pre-existing; not caused here.

### L10 · A live-conversation draft is discarded on the swap — sharp edge

`useSubmissionDraft` has two independent instances (`sessions.tsx:700` for the
empty-chat composer, `:1057` for the live conversation) and nothing carries text
across the ternary at `sessions.tsx:526-564`. The one thing the confirm dialog
cannot warn about.

### L11 · No prior attempt — sharp edge (in the good sense)

The history carries no earlier reset/demote affordance. Greenfield; no dead body
to learn from, and no reverted design whose reason is the real landmine.

---

## Confirm before coding

Small facts the builder must verify rather than assume:

1. `SpaApi` is `Pick<DuetApiClient, …>` in `spa/context.ts:13-141` — the method
   name must be added there or no component can call it, and adding it is what
   breaks the fixture typecheck (L4). Do both in one pass.
2. `apps/web/app/api/duet/[...path]/route.ts:12` already exports `PUT = proxy`,
   so the BFF needs no change. Confirm it still does.
3. `defaultSessionOwnerValidator` (`domains/agentSessions/model.ts:129-133`) is
   the owner shape to reuse — do not invent a second one.
4. The new Convex mutation follows `setSessionArchived`
   (`model.ts:538-549` + `lifecycle.ts:16-51`): required `internalKey`,
   `requireApiInternalKey`, `assertActorRole(…, 'editor')`, optional `now`, and
   an exact `returns:` validator.
5. The PUT's set-direction must re-assert delivery's own owner guard
   (`delivery.ts:381-385`): root ⇒ `session.agentId === undefined`,
   agent ⇒ `session.agentId === thisAgent`, and `archiveState !== 'deleting'`.
6. `apps/api/src/sessions.test.ts:3458+` is where default-session route tests
   already live.

---

## Build plan

Sorted by **likelihood of being tweaked**, not execution order. The judgment
calls are first; the mechanical work is collapsed at the bottom.

### Most likely to be tweaked

1. **The `SectionHead` seam.** An optional prop (`action?: ReactNode`) versus a
   dedicated `ChatSectionHead`. The optional prop dodges the visual-coverage
   ledger (L6) and keeps `surface-copy.test.tsx` compiling (L7) — but the
   surface then needs the action passed down from `agents-map.tsx`, which is
   where `canUseSessions`, `agentScope` and the creation-pending flag all live.
2. **Where `created` gets cleared (L1).** Either lift the state out of
   `SessionsProduct` so the button can reach it, or hand the button an
   imperative `onArchived` callback that `sessions.tsx` owns. The second is
   smaller and keeps the state where its doc comment says it belongs.
3. **The confirm dialog's home.** Follow `useAgentActions` (a hook returning
   `{trigger, dialogs}`, mounted once) or inline it in the surface. Note the
   agent surface is inside the map's zoom overlay — `agents-map.tsx:1018-1029`
   records that mounting a dialog at the wrong level left its open flag flipping
   while the dialog was never in the tree.
4. **The fixture's pointer model (L4).** How much of the store to change.

### Mechanical — trust me on these

5. Contract: `SetDefaultSessionRequestSchema` in
   `packages/contract/src/sessions/index.ts` (transform-free), plus the endpoint
   entry beside `agents.defaultSession.message`
   (`packages/contract/src/endpoints/index.ts:1039-1048`).
6. Convex: `setDefaultSession` mutation in `model.ts`, impl in `lifecycle.ts`
   beside the existing clear.
7. API: the `PUT` handler in `apps/api/src/routes/default-session.ts`, reusing
   `resolveDefaultSessionOwner` and `defaultOwnerWire`.
8. SPA: client method, `SpaApi` entry, a `useArchiveDefaultChat` mutation hook
   with the three-family invalidation (L3).
9. i18n: `en` **and** `es-419` (L7).
10. Tests: convex mutation (pointer cleared, owner guard, idempotent), api route,
    contract tuple list (L5), `default-chat` mount after clear, and the
    endpoint-metadata pair.
11. Gates: `bun --cwd apps/docs run endpoint:coverage:write`, then the visual
    re-approval for the web playgrounds **and** the two docs `/sessions` shots
    (L5, L6).

---

## Start the build

```
Implement specs/archive-default-chat/MAP.md. Every decision D1–D11 is settled —
carry them verbatim, don't re-open them. Land L1, L3, L4, L5, L6, L7 as part of
the change; L2 is accepted as-is and must not be fixed here; L9, L10, L11 are
sharp edges to leave alone.

Work through the build plan in the order the map lists, checking the "confirm
before coding" list first. Follow the write-tests skill's red/green workflow for
the behaviour changes, and the ui-playground skill for the visual gate. Stop and
show me the diff before regenerating any baseline.
```
