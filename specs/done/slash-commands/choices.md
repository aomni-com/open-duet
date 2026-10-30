# Choices ledger — slash commands

Every decision made where the spec was silent, re-audited against the **shipped
code** rather than the pass it landed in. The decisions *you* made during the
quadrant walk are in [`MAP.md`](MAP.md); this is the set an implementing agent
made on your behalf.

Ranked least-confident first, so the ones most worth overturning are at the top.

---

## Decided by you, after the close

**Matching is fuzzy, following chat-app.** You asked which sibling had the better
UX. They disagree: duet-agent's terminal picker filters skills on **prefix
alone** — `/spec` finds `write-spec` nowhere, let alone `/wsp` — while chat-app's
composer uses Fuse.js keyed on `name`. chat-app is the fuzzy one, and it is also
the closer sibling, so Duet now matches it (`fuse.js` 7.3.0, the version chat-app
pins). The objection that a fuzzy matcher buries a literal name under longer ones
is real, so it is pinned by test rather than assumed: typing `review` in full
still ranks `review` above `reviewer-notes` and `design-review`, because Fuse
scores a whole-string match at zero.

**A failed skills read still never retries.** You called it: these VMs do not
sleep, so the wake-from-sleep case that motivated the concern does not arise. One
failure shows "Couldn't reach your workspace" until the picker is reopened.

**Two audit findings were fixed** — the fixture now asserts the product's real
strings rather than hand-copied lookalikes, and the chip transform no longer
depends on backticks being balanced. Both are described below under Settled.

## Worth your eye

**The `/review` chip reads as highlighted text, not as an object.**
You picked the brand-tint treatment from four options during the walk, so it
shipped as chosen. But an unprimed critique flagged it at high confidence, in
both the composer and the message timeline: medium-blue on pale blue-lavender,
no border, so at normal reading size it looks like selected text rather than a
thing you inserted. It stands because you chose it — but if it ever grates, an
outline or a stronger fill is the fix, in one CSS rule.

**A timed-out memory save now answers 504 where it used to answer 502.**
The spawn cap covers the memory routes as well as the skills read, and a killed
process reports a timeout rather than a failure. Nothing in the product reads
that status code today, so this is invisible — listed because it changed a
response on a route this spec was never asked to touch.

**The disabled pending-create composer carries a live skills capability.**
It is permanently disabled, so `/` cannot be typed into it. It has the
capability because you asked for every surface to have it, and because making
the prop required leaves no quiet way to opt out. It costs no extra request: the
cache key is the folder, so it shares whatever the live composer already
fetched.

**Five minutes for the cached skill list.**
You chose prefetch-on-mount; the window length is mine. Long enough that opening
ten conversations costs one VM spawn per agent rather than ten, short enough
that a newly installed skill turns up without a reload — and opening the picker
refetches regardless, so the window only bounds the background copy.

**The chip travels through Markdown as a `#duet-skill=` fragment.**
It reads as a hack because it is one. The first attempt used a `duet-skill:`
URL scheme; the Markdown renderer sanitizes URLs, silently blanked the unknown
protocol, and turned the chip into an empty link. Fragments survive that
sanitizer. The principled version is a remark plugin producing a real node,
which becomes worth building when `@` triggers arrive and the transform has more
than one shape to carry.

**A chip can outlive the skill it names.**
The picker cannot offer a skill that does not exist, so this reduces to one
reachable case: switching agents in the welcome composer with a chip already in
the draft. The agent quietly ignores the tag. Accepted rather than built —
overturn it if you would rather the composer re-validate its chips when the
agent changes.

---

## Settled

**A visual fixture asserts the product's strings, not a copy of them.** The
compose-bar fixture hardcoded its own labels, and they drifted: the baseline
showed "No skills installed" while the product shipped "No matching skills", so
the screenshot gate was verifying text no user would ever read. The fixture now
imports the real message bundle. Worth knowing how it hid: plain `ui:check`
*passed* after the strings were corrected, because the pixel diff fell under
threshold — only a forced re-approval and a byte-diff of the PNG
(`24d569cd→dcea1d13`) proved the shot had changed at all.

**The chip transform does not assume balanced backticks.** Code spans are
protected by splitting on *closed* pairs rather than counting backticks and
taking every other segment: with an odd number, parity flipped and everything
after a stray backtick was treated as code, so a tag in ordinary prose was left
untransformed — and since the renderer drops raw HTML, the skill vanished
silently. Exactly the bug the transform exists to prevent, on odd input.

**`defineTrigger` widens a trigger's item type through `unknown`.** A trigger
both produces and consumes its items, so TypeScript will not let a `/skills`
trigger sit in a list beside a future `@files` one, even though each is
internally consistent. One widening, in one named function, with the reasoning
attached — but it is a real hole: a trigger whose `toAttributes` expects fields
its own `getItems` never produces would not be caught.

**Three modules were deleted rather than deprecated** — `compose-bar-skill.ts`,
`compose-bar-skill-mention.ts`, and their test. Nothing outside the compose bar
imported them.

**The picker shows at most 20 matches, with no "more" indicator.** A workspace
with forty skills and a broad query hides the tail silently.

**The listing is the agent CLI's own answer, not a second implementation.**
Skill discovery has real rules — ancestors of the working directory, then the
user's home, then built-ins, nearest wins collisions. A second copy of those
rules in the control plane would drift the moment the agent's changed. The VM
route runs `duet skills` and parses its JSON; it is a working-directory resolver
and nothing else.

**Nothing is mirrored into the backend.**
Skills are files on the drive that change without telling anyone, so the list is
read when someone opens a picker. A cached copy in the control plane would only
be a promise to go stale.

**One row that cannot be read is dropped; the listing survives.**
A VM runs whatever agent version is installed there. One unreadable entry must
not cost the user every other skill, and an unrecognized scope degrades to "no
label" rather than rejecting the skill.

**The cap lives at the spawn seam, so no route can forget it.**
`spawnDuetCli` moved out of the memory route — the skills route was already
importing its CLI seam from a sibling route, which said the seam belonged to
memory. It belongs to neither. The child is *killed*, not merely abandoned:
returning the request while leaving a wedged process is the half that costs
something.

**A trigger is a value, not a copy of the plumbing.**
`@` mentions are coming. The tag grammar, the keyboard handling, and the
ProseMirror-to-React selection handoff must agree exactly for a chip to survive
being saved and reopened, so a second trigger is a spec object rather than a
second copy. One constraint forced the shape: Markdown returns a bare `<Tag …/>`
as a raw `html` token and an extension can claim that token name only once, so
the bridge is shared and tries each trigger in turn. Duplication would have left
the last-registered trigger owning every tag — an `@` chip coming back from a
draft as the wrong node.

**Tag attributes are read by name, and a missing one reads as empty.**
A tag written by hand, or by an older build, can order its attributes
differently and still mean the same thing. Refusing the match would turn a
slightly-wrong tag into literal text inside someone's message.

**`skipHtml` stays on; the timeline transforms instead.**
Dropping raw HTML is the renderer's safety boundary for agent output. Relaxing
it globally so one tag could render would trade that boundary for a chip. The
rewrite happens in the session layer, where the text is already known to be a
Duet message — and it reuses the composer's own grammar, so what one end writes
and the other reads cannot drift.

**Code stays code.** Fenced blocks and inline spans pass through untouched, so a
message *about* the tag survives verbatim. "How do I invoke a skill" is a message
this product will actually carry.

**A failed read is a state, not a sentence.**
Different wording alone was not a distinction — an unprimed critique called the
two boxes visually identical and was right. The unreachable state is amber, has
a warning glyph, and announces itself as an alert; an empty list stays quiet,
because an empty list is an answer.

**The picker capability is a required prop, not a hook inside the composer.**
Deriving it internally would also have covered every surface, but it drags
app-level context into a presentational component and crashed a playground that
has no client. As a required prop the type checker enforces the same rule — it
immediately found two call sites the change had missed.

**Private API route, not a published endpoint.**
`GET /v1/ws/:slug/skills` has an explicit private-owner reason in the endpoint
registry. The shape is not final enough to promise to third parties.

**`collisions` is dropped at the wire.** The agent reports the name collisions it
resolved; nothing renders them, and a plumbed-but-unread field is a field that
rots.

---

## Recorded, not acted on

Findings from the unprimed critique that fall outside this spec: the quality
bar's square corners over a rounded card, its blurred gradient blob, and its
low-contrast meter dots; and a timeline sender name that does not read as a
label above its message. All pre-existing compose-bar and timeline styling this
spec did not touch.

The gap after a chip reads as a double space — the chip's own padding sits next
to the inserted trailing space. Left alone deliberately: tightening the padding
trades one flaw for a cramped chip.
