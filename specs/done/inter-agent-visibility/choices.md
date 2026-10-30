# Choices — inter-agent visibility

Decisions made during the build that [`MAP.md`](MAP.md) did not settle. D1–D14
there are givens and are not re-listed. Every entry below has been re-checked
against the code as it finally shipped, not as it stood when the choice was
made. Grouped by verdict, least-confident first.

**Review these first:** the Spanish wording for the two new badges, and the fact
that the prompt states a relationship in English while the picker states it
translated.

---

## Needs your decision

### Spanish for the two new badges: *Par* and *Subordinado*

**What happens.** The `@` picker in the composer badges every row with that
agent's relationship to the session you are in. English gets `You` / `Parent` /
`Sibling` / `Child`. The product also ships Latin-American Spanish (`es-419`),
which already had `Tú` for self and `Superior` for parent. I added `Par` for
sibling and `Subordinado` for child, chosen to sit with the manager-ish register
`Superior` had already set.

**The unbuilt alternative** is the literal family register — `Hermano` for
sibling, `Hijo` for child — closer to the English words but odd for software,
and clashing with `Superior` unless that changed too.

**The gap.** The map flagged this as "confirm before coding"; I proceeded so the
pass could finish rather than block on it.

**The reach.** Four strings in one locale file. No code depends on them.

**Provisional call:** shipped as *Par* / *Subordinado*. Reverse by editing two
lines in `apps/web/messages/es-419/app.json` — no code, no test, and no visual
baseline moves, because the gate renders English.

**Confidence:** low. This is register taste in a language the audit cannot judge
for the product's voice.

### The prompt says the relationship in English; the picker says it translated

**What happens.** One fact — "this agent is your sibling" — is now stated in two
places. The agent's system prompt renders the literal word `sibling`, always
English, because generated prompt layers are not localized. The composer's
picker renders a translated badge. So a Spanish-speaking user reads `Par` in the
UI while the agent reading the same roster reads `sibling`.

**The unbuilt alternative** is localizing the prompt layer, which means the
gateway learning the workspace's locale and every prompt string becoming a
translation key — and it would make the byte-pinned prompt samples
locale-dependent.

**The gap.** The map treated the badge word and the prompt word as one
vocabulary (D10) without noticing they sit on opposite sides of a localization
boundary.

**The reach.** This sets the precedent that generated prompt layers stay English
while UI chrome localizes. Every future prompt layer inherits it.

**Provisional call:** left as-is. Reversing means taking on prompt localization
as a project, not an edit.

**Confidence:** medium — probably what you want, but nobody chose it out loud.

---

## Sound — the architecture you now own

### The one recipe may be written against the parent, so its payload is `<message>` and not `<task>`

**What happens.** `your-agents.md` ends with a worked `curl` an agent can copy
verbatim to reach a colleague. There is exactly one such recipe now, because
there is exactly one mechanism underneath — a message into an agent's home chat
— and it is written against a single example agent whose slug is baked into the
URL. A ranking picks that agent: a child first, a sibling next, the parent only
when there is nobody else.

That last case is real. Consider a leaf agent: no children, no peers, only a
parent. The recipe must be written against the parent, because reporting upward
runs down the same wire as delegating downward — and an agent given a roster
with no instructions is worse off than one given a slightly awkward example.
But the policy says work never goes up. So the payload placeholder is
direction-neutral:

```bash
REQUEST_BODY="$(jq -n … '{prompt:"<message>", …}')"
```

and the paragraph directly above it is the only place a direction is asserted:
*"A task for a child, or for a sibling when the work belongs to no child of
yours; for your parent, a report or a question and never a task."*

**How it nearly shipped wrong, and why that is worth recording.** The first
version kept the old `<task>` placeholder. That put the forbidden action — send
a task to your parent — into the one copyable artifact a leaf agent has, with
only prose above it saying otherwise. Nothing in the code enforces the policy,
so the example *is* the enforcement. This was caught by the closing decision
audit, not by the plan and not by any test; the test that now pins it
(`the worked example never names a direction its own prose forbids`) was written
afterward.

**The gap.** The map specified the policy (D6) and the section layout (D7), but
not what the payload is called once one recipe serves three directions.

**The reach.** The general property: **no worked example may demonstrate an
action its own surrounding prose forbids for the agent receiving it.** A fourth
relationship, or a broadcast direction, inherits this constraint.

**Verdict:** sound as shipped.

**Confidence:** medium — the end state is right, but the plan gave no signal
that this was a decision at all.

### The relationship words in the prompt are the enum values themselves

**What happens.** `AgentRelationship` is a union in `packages/contract` —
`'self' | 'parent' | 'sibling' | 'child'`. Rather than mapping those to display
strings, the prompt renderer writes the value straight into the line an agent
reads:

```
- **Research** (`research`) — parent — `agents/research`
```

So `row.relationship` is simultaneously a type, a wire value, and agent-facing
copy.

**The unbuilt alternative** is a lookup table from enum value to prompt wording,
letting the two drift on purpose (the enum says `child`, the prompt says
"reports to you").

**The gap.** The map said the relationship becomes a field; it did not say
whether the field's value is also the words.

**The reach.** Renaming a relationship now rewrites every agent's system prompt
in every workspace. It cannot happen silently — `assets/your-agents-samples.md`
is pinned to the renderer by `your-agents-samples.test.ts` — but it is a prompt
change wearing a refactor's clothes.

**Verdict:** sound. One vocabulary across the projection, the prompt and the
badge is the property that stops two surfaces describing one roster differently,
which is what this whole area exists to protect.

**Confidence:** high.

### "Only the drive root may omit a folder" survived the collapse to one row type

**What happens.** Every agent lives in a drive folder except the drive root,
which is addressable but has none. The old wire encoded this with two row
shapes: children required `path`, the parent row did not. Collapsing to one row
type made `path` optional for everyone, which would have let a sibling or child
ship without a folder and nothing would have complained.

I kept the guarantee as a schema refinement: a row may omit `path` only when its
relationship is `self` or `parent` — the only two a root row can ever wear.

**The unbuilt alternative** is trusting the producer, since the gateway only
omits `path` when the agent genuinely has none.

**The gap.** The map said "one row type" without saying what becomes of the
asymmetry the two types encoded.

**The reach.** A gateway bug emitting a pathless child now surfaces as a 502
from the api proxy instead of a chip linking nowhere. The refinement sits on an
endpoint-reachable schema and `verify:endpoints` still passes, so it did not
break JSON-Schema rendering.

**Verdict:** sound — not letting an existing gate weaken by accident.

**Confidence:** high.

### The picker's relationship badge gained an outline, which also changes the `/` skills picker

**What happens.** The badge beside a picker row was a filled grey pill
(`bg-muted`). The highlighted row's background (`bg-accent`) is the same value,
so on the active row the fill vanished and the label read as bare text — and
beside the amber "awaiting setup" pill, which does have a visible fill, the two
looked like different sizes. Latent before, because only self and parent were
badged and neither is usually the highlighted row; ordinary once every row is.

The fix adds a border so the pill holds its shape on any background. That pill
is shared: the `/` skills picker uses the same slot for its scope label
("Global"), so its rows now carry the outline too.

**The unbuilt alternative** is branching the pill's style on whether its row is
active — no change to the skills picker, one more conditional in a component
whose stated rule is that it "displays a verdict and never re-decides it".

**The gap.** Nothing anticipated a styling collision; it only appears once every
row is badged.

**The reach.** One shared component, two pickers, one treatment. Both baselines
moved and were re-approved together.

**Verdict:** sound — an unconditional treatment beats a state-dependent one in a
component whose whole job is rendering what it is handed.

**Confidence:** high.

### The playground fixture is capped at five rows, and that cap is load-bearing

**What happens.** The visual gate photographs a fake picker built from a
hand-written row list. The production picker scrolls past five rows. Two of the
five are deliberately both named "Scout" — that pair is the only visual evidence
that the slug on each row's second line is what tells same-named colleagues
apart.

A sixth row (an unlocked sibling, added to show every relationship in its
unlocked state) pushed the second "Scout" out of frame and silently removed that
evidence from the accepted baseline. The sixth row was removed and the
constraint written into a comment above the fixture.

**The unbuilt alternative** is a second fixture scene for the overflow case —
more shots to maintain for a state the production `max-h` already makes routine.

**The gap.** The map named the fixture as something to update, not as something
with a row budget.

**The reach.** Anyone adding a row silently loses a covered case. The comment is
the only guard.

**Verdict:** sound, with the caveat that a comment is a weak guard.

**Confidence:** high.

### Two closed rationale records got superseded-by banners rather than edits

**What happens.** `specs/done/agent-delegation/README.md` and
`specs/done/agent-mentions/README.md` state invariants this change makes false —
"one layer each way", the 30-row cap, the `{self, parent, children}` seam. They
are records of why things were built, so rewriting the bodies would destroy the
reasoning. Each got a short banner at the top pointing here and naming exactly
which claims no longer hold.

**The unbuilt alternative** is editing the bodies to match today's code, which
turns a rationale record into a second copy of the current design.

**The gap.** The map listed the samples asset as needing regeneration and said
nothing about the prose around it.

**The reach.** Sets the pattern for marking a closed spec that a later one
partly overturns.

**Verdict:** sound.

**Confidence:** high.

### The prompt-samples asset moved to this spec, and the generator moved with it

**What happens.** `your-agents-samples.md` is a generated file showing the
prompt layer rendered for several scopes, pinned byte-for-byte to the renderer
by a test. It lived under `specs/done/agent-delegation/assets/`. Since this
change rewrote nearly every line of that prompt, the artifact now documents this
spec rather than that one, so it moved here and the generator script, the
renderer's docstring, the test's path, and both READMEs' links were repointed.

**The unbuilt alternative** is regenerating it in place — the map's original
call — which leaves a closed spec's assets folder describing a prompt that spec
no longer explains.

**The gap.** Close-spec time; the map made the in-place call before the prompt
turned out to be rewritten rather than amended.

**The reach.** The generator writes across spec folders, so the path is a real
coupling: moving this file again means four edits, and the test is what catches
a missed one.

**Verdict:** sound.

**Confidence:** high.

### The repo's outstanding formatter drift was absorbed as its own commit

**What happens.** `bun run format:check` was red on 26 files; 22 had nothing to
do with this change. Rather than committing a feature on top of a red gate, or
mixing reflow into the feature's diff, the reformat landed first as
`ed7d3981c`, whose message records that `git diff -w` accounts for every
remaining line.

**The gap.** Not a spec question — a standing instruction to fix drift found in
passing.

**The reach.** `format:check` is green repo-wide.

**Verdict:** sound.

**Confidence:** high.

---

## Trivial discretion, not itemized

Internal naming (`parentRows`, `group`, `bySlug`, `rowsFor`), the fourth scope
added to the prompt samples, test fixture helper shapes, and the non-null
assertion on the self row (whose invariant is proven eight lines above it).
