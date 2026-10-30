# Slash commands in the compose bar

Typing `/` in Duet's composer lists the skills the workspace can actually run.
Picking one leaves a chip in the message, and the message ships as the
`<Skill name="…" path="…" />` tag the agent runtime already understands. A sent
message shows the same chip back, so the history says which skill was invoked.

Shipped 2026-08-08. [`MAP.md`](MAP.md) is the quadrant walk that shaped it —
the settled ground with citations, and the decisions you made.
[`choices.md`](choices.md) is everything decided *for* you, ranked by how much
it deserves a second look.

## Why it works this way

**The agent was already listening.** `duet-agent` reads both a bare `/name`
token and a `<Skill …/>` tag as the same command
(`skill-context.ts`, `SKILL_TAG_PATTERN` / `parseSlashCommands`), and expands it
on every prompt and every answer. So this feature adds no agent-side protocol:
it is a picker over a grammar that already existed. The tag form was chosen over
the bare slash because it is unambiguous — the agent treats *any* whitespace-
delimited `/token` as a command, so "look at /review" already invokes a skill —
and because it carries `path`, letting the agent open a SKILL.md without a
discovery step.

**The VM owns the answer.** Skills are files on the drive that a person can
install, edit, or delete without the control plane hearing about it. Mirroring
the list into the backend would only be a promise to go stale, so the list is
read live, from the workspace, when a picker opens.

**Discovery is not reimplemented.** The agent's own rules — ancestors of the
working directory, then `~/.duet`, then built-ins, nearest wins collisions —
are printed as JSON by `duet skills`. A second copy of those rules in the
control plane would drift the moment the agent's changed, so the gateway route
is a working-directory resolver and nothing more.

**The list is scoped to where the session runs.** A skill installed under one
agent is not one another agent can run, so the request carries that agent's
anchor folder. Sessions pass no skills allowlist
(`runner/process-runner.ts`, `defaultRunnerFactory`), which is what makes the
picker's list *exactly* the agent's list — nothing can be offered that the
agent would refuse.

**A trigger is a value.** `@` mentions are coming, so the tag grammar, keyboard
handling, and the ProseMirror-to-React selection handoff are generic, and a
trigger is a spec object. One constraint forced this: Markdown returns a bare
`<Tag …/>` as a raw `html` token, and a TipTap extension can claim that token
name only once — so the Markdown bridge must be shared and try each trigger in
turn. Duplicating it per trigger would leave the last one registered owning
every tag, and a chip restored from a draft would come back as the wrong node.

## Invariants

These must keep holding; each would break something silently.

- **What the composer writes, the timeline reads — through one grammar.** Both
  ends go through `compose-bar-mention.ts`. A second parser at either end is the
  divergence the shared codec exists to prevent.
- **`skipHtml` stays on in the shared Markdown renderer.** It is the safety
  boundary for agent output. The skill chip is produced by transforming the
  message text in the session layer, never by letting raw HTML through.
- **An empty list and an unreachable workspace are different states.** An empty
  list is an answer; a sleeping VM is not. They must never collapse into one
  message — different wording alone does not count, which an unprimed critique
  established by calling two differently-worded boxes visually identical.
- **No agent-CLI invocation outlives its cap, and the child is killed.**
  Returning the request while leaving a wedged process is the half that costs
  something.
- **A failed listing is never flattened into an empty one.** A workspace can
  genuinely have no skills; that answer and a failure must stay distinguishable
  all the way from the gateway to the picker.
- **The skills capability is required on `SessionComposer`.** A call site that
  could omit it is one that will.

## Where it lives

| Concern | Code |
| --- | --- |
| Wire shape, tolerant parsing | `packages/contract/src/skills/index.ts` |
| VM route running `duet skills` | `packages/gateway/src/routes/skills.ts` |
| Capped, killable CLI seam | `packages/gateway/src/duet-cli.ts` |
| API proxy (private route) | `apps/api/src/routes/skills.ts`, `gateway/client.ts` (`listSkills`) |
| Tag grammar + ranking | `packages/ui/src/components/compose-bar/compose-bar-mention.ts` |
| Trigger plumbing (nodes, suggestion, bridge) | `…/compose-bar-mention-extension.ts` |
| The `/` trigger itself | `…/compose-bar-skill-trigger.ts` |
| The picker | `…/compose-bar-mention-picker.tsx` |
| Fetch policy | `apps/web/spa/sessions/session-skills.ts` |
| Chip in a sent message | `apps/web/spa/sessions/session-mention-chips.ts` (renamed when `@` mentions joined it — see `specs/done/agent-mentions/`) |

Behaviour is pinned by `compose-bar-mention.test.ts` (grammar and ranking),
`duet-cli.test.ts` (the cap kills a real 30-second process),
`routes/skills.test.ts` (containment, 502, 504), `session-markdown.test.tsx`
(the chip, and code staying code), and the browser gate
`bun ui:check compose-bar`, which drives the real editor end to end: `/rev`,
Enter, Tab, two chips in one message, and the submitted Markdown.

## Dead ends

- **A `duet-skill:` URL scheme for the chip.** The Markdown renderer sanitizes
  URLs and silently blanks unknown protocols, turning the chip into an empty
  link. A `#duet-skill=` fragment survives the sanitizer. The principled fix — a
  remark plugin producing a real node — is worth building when `@` arrives.
- **Deriving the skills capability inside `SessionComposer`.** It covers every
  surface, but drags app-level context into a presentational component and
  crashes any playground without a client. A required prop enforces the same
  rule through the type checker.
- **Rendering the chip in the timeline against a live skill list.** Wrong: the
  timeline draws from the tag, and an old message naming a since-deleted skill
  is *accurate* — it did run then. Validating history against today's list
  invents a problem.
- **A Markdown bridge per trigger.** Only one extension can own the `html`
  token; see above.

## Visual provenance

The look was chosen from four rendered picker layouts and four chip treatments,
built from the repo's real `.claude/skills` list so the only variable was the
design. The dense picker and the brand-tint chip won unchanged, along with scope
labels and descriptions. That comparison was a throwaway artifact of the walk and
was not kept in-tree; what it settled is recorded as D5–D7 in [`MAP.md`](MAP.md).

The standing baselines are the review surface:

- `apps/web/tests/visual/__screenshots__/{desktop,mobile}/playground.spec.ts/compose-bar-skills.png`
  — the composer chip and all three picker states (list, empty, unreachable).
- `apps/web/tests/visual/__screenshots__/mobile/playground.spec.ts/session-authored-messages.png`
  — the same chip in a sent message.

Both were judged by an unprimed critique before the spec closed, after being
byte-diffed against their pre-change versions so a no-op could not pass as
verified. Its findings, acted on and not, are in [`choices.md`](choices.md).
