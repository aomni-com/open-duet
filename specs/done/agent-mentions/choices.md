# Choices

Every decision this build made where the spec was silent, re-checked against
the code that actually shipped. Grouped by how much they want your eyes, least
confident first. Each entry stands alone — no reading order required.

## Wants your eyes

### Self is mentionable, but is not in the delegate list

Added after the spec closed, on request: the agent a session belongs to now
leads the `@` picker, badged "You", and inserts like any other mention.

**The line I drew.** It rides the roster as `self`, separate from `children`,
and it does **not** appear in the prompt's "agents you can delegate to" section.
Children are agents work can be handed to; an agent that read itself as one
would send work to its own default session and wait for a turn it cannot end —
the delegation deadlock the one-layer rule exists to prevent, aimed at itself.
The agent already knows who it is from its `who-you-are.md` layer, so nothing is
lost by keeping it out of the delegate list.

**What this softens.** The picker and the prompt's delegate list are no longer
the same set — the picker has one row the list does not. They are still one
projection with one owner; the two consumers read different parts of it. If you
would rather they stay identical, the alternative is to drop self from the
picker again.

### Agent mentions match more strictly than skill mentions do

Typing `@` and a name now requires a closer match than typing `/` and a skill
name does (Fuse threshold `0.4` on the agent trigger; skills keep the shipped
default). The two pickers therefore behave differently for the same keystrokes.

**Why.** `@` is a character people type in ordinary prose about people who are
*not* agents. At the shipped looseness a scattered-letter match was enough:
`@sarah` offered **Cartographer**, `@dave` offered **Duet**, `@alice` offered
**Librarian**. Because the picker opens with a row highlighted, a reflexive
Enter inserted a colleague nobody had named — a wrong mention that reads as
deliberate. `0.4` is the loosest setting at which those three stop matching
while every real abbreviation still works (`cart`, `lib`, `duet`, `sco`,
`scout-web`); `0.3` and `0.2` behave identically on those cases, so this sits at
the top of a stable plateau rather than on an edge. Pinned in
`compose-bar-mention.test.ts`.

**If you disagree:** raise it back toward `0.6` for consistency with `/`, and
accept the occasional wrong insertion — or tighten skills to match and accept
that `wsp` may stop finding `write-spec`.

### A picker owns the Enter key only when it has rows to offer

The guard the composer's send shortcut checks is no longer "is a picker open"
but "does the open picker have rows" (`pickerHasRowsRef`).

**Why.** The old guard stood down for *any* open picker, including one showing
nothing but a message. So on a workspace with no agents registered, typing `@`
opened the picker (correctly — the trigger is never dormant) and then swallowed
Enter into a line break, leaving the message unsent. With rows present the
behaviour is unchanged, including the case that matters: a list where every row
is locked still consumes Enter and inserts nothing, so a colleague awaiting
onboarding cannot be picked by reflex.

**Found by the closing audit, not by the build.** The spec's own invariant said
"Enter is consumed whenever a picker is open"; the code bailed earlier than that
for an empty list, and the stated consequence ("sends the half-written message")
was wrong in the other direction — it was never a send, always a line break.

### An unmatched mention closes the picker instead of showing an empty list

Type a word that names no agent and the picker gets out of the way, leaving the
text as prose.

**Why.** The picker holds the Enter key — the composer's send shortcut stands
down for any open picker — so a picker that stayed open over a non-match meant
Enter inserted a line break instead of sending the message. It also showed
"No agents yet" to workspaces that have plenty. The suggestion code always
*claimed* this behaviour ("an unmatched query closes it and leaves the typed
word as prose"); it never did it. Now it does, for `/` as well.

**Consequence for `/`:** typing `/zzz` used to show "No matching skills" and now
closes the picker. That matches the documented intent, but it is a visible
change to a shipped surface.

### Agent names now reject `[ ] < > ` ` and control characters

Free-form names lost five characters. Everything else — quotes, ampersands,
parentheses, accents, emoji, spaces — stays legal.

**Why.** A mention chip is built as a Markdown link, and a bracket in a name
ends the link early, so the message renders as broken markup. The regex is
`/^[^[\]<>`\p{Cc}]*$/u`: `\p{Cc}` (control) rather than `\p{C}`, so the
zero-width joiner that holds multi-person emoji together stays legal.

**The part that needed care:** this schema is not only a write-time validator —
it composes into the VM-sync roster wire. One legacy bad name would have failed
the parse of the *entire* sync payload, blanking every colleague in every
session's prompt. That one seam now drops the offending row and keeps the rest;
strictness is unchanged everywhere a name is written.

**Still outstanding, and yours:** nothing has swept staging or prod for existing
rows that violate the rule. The sharp one is `workspaces.duetName` — a violating
value there fails `whoami`, which is a boot failure, not a degraded list. Fix by
data surgery, not migration code.

## Decided, and I am confident

### The projection was extracted before anything served it

Rather than adding the roster endpoint beside the prompt writer and letting each
compute its own answer, the shared projection was lifted out first and the route
built on top of it. This cost an extra pass up front and is the reason the
README can state a single-owner invariant rather than a convention. (The
invariant itself lives in `README.md`; this entry records only that the ordering
was a deliberate choice, not an accident of build order.)

### "We could not ask" is never shown as "you have no colleagues"

The roster store starts as *unknown* rather than *empty*, so a gateway that has
not synced yet answers 503 and the picker says it could not reach the workspace.
An agent the roster does not carry is a 404. Only a genuinely empty roster
returns an empty list. Before this, the store started empty and a cold gateway
would have stated, as fact, that a workspace had no agents.

### Which row the keyboard may land on has exactly one owner

The suggestion engine decides; the picker displays that verdict and never
re-checks it. A locked colleague is listed (hiding it would read as "no such
colleague"), skipped by the arrows, and refused by both Enter and a click — the
refusal comes from the engine, not from the row being hard to hit, which is why
the browser test forces the click.

### A mention is a pointer, not a command

The tag names an agent so the reader can open its page. It does not send that
agent anything, and no agent-side code parses it. `your-agents.md` says both
halves, because an agent that read it as "this hands over the work" would mention
a colleague and expect the job to move.

### Rows are identified by slug, never by display name

Two colleagues may answer to the same name — the product expects it. Keying rows
by name collapsed them into each other, so every row carries a stable id, shows
its slug, and is searchable by it.

### The tag omits attributes it has no value for

An agent with no display name of its own emits `<Agent slug="scout" />` rather
than `name=""`, and the drive root emits no `path` because it has no folder. An
empty attribute claims a value; an absent one is already defined to mean "none".

### The chip is a real link; the skill chip stays inert

An agent is a destination, so its chip is an `<a>` with an href — middle-clickable,
and announced as a link. A skill names a capability, so its chip remains inert.
Both render in the sender's message *and* in an agent's reply, from one transform
at one call site.

### The browser computes nothing about the roster

It renders parent-then-children in the order the wire gave them. No sorting, no
capping, no re-deriving the lock flag, no hierarchy walk. The one client-side
limit is the pre-existing 20-row display slice shared with `/`.

### No `agentId` reaches the browser

Slugs address agents in the URL, the tag, the cache key, and the chip link. The
one place an id appears is the internal api→gateway hop, which already spoke
that language.

### Hard cutovers, no shims

`session-skill-chips.ts` became `session-mention-chips.ts` with no re-export.
`rankByName` became `rankItems` with the search keys required rather than
defaulted, so a future trigger cannot widen an existing one by omission. The
inline roster projection was deleted, not left beside its replacement.

## Fixed along the way, outside the plan

### The install dialog now says why a name was rejected

Tightening agent names made a previously rare state common: one bracket, and the
marketplace install button greyed out with no explanation. Both install flows now
state the rule.

### Two archived probe records were restored

A formatter sweep had rewritten frozen diagnostic JSON in a closed spec. Those
files are evidence of what a probe measured, not code to tidy, so they were put
back byte-identical.

## Not ours, but you should know

Three tests fail at the end of the root suite, and the `test-harness` package
fails typecheck. All four reproduce identically on a clean checkout of
`origin/staging`, so none come from this work:

- `packages/gateway` — a `process-runner` relay test times out.
- `apps/api` — `vm.test.ts`: a bad VM token answers `400` where the test expects
  `401`. Worth someone's attention on its own merits; it is an auth assertion.
- `packages/backend` — an `auth-workspaces` billing test expects 6 audit events
  and sees 7.
- `packages/test-harness` — three `staging-e2e-synthetic*.ts` files have `unknown`-typed
  event fields.

## Two environment traps that cost real time

- **A fresh worktree has no `node_modules`,** so `@repo/*` resolves *upward* to
  the main checkout. `apps/web` typechecked green against a copy of the UI
  package I had not edited. Run `bun install --frozen-lockfile` in the worktree
  first, and verify `node_modules/@repo/ui` points at `../../packages/ui`.
- **`bun ui:check` typechecks the whole repo before taking a screenshot,** so it
  fails on any package another agent is mid-edit in. Shared gates and parallel
  lanes do not mix.
