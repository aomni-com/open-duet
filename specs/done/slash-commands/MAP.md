# Slash commands in the compose bar — quadrant map

Walked 2026-08-08. Territory: `packages/contract/src/skills`, `packages/gateway`,
`apps/api`, `apps/web/spa`, `packages/ui/src/components/compose-bar`, plus two
upstream files the feature depends on but does not own — duet-agent's
`src/turn-runner/skill-context.ts` and Duet's `packages/ui/src/components/common/markdown.tsx`.

Shipped ahead of the walk as `fb9d1728`; the walk then overturned two decisions
and found four sharp edges. Outstanding work is the **build plan** at the end.

---

## 1 · Known knowns — the settled ground

| Fact | Evidence |
| --- | --- |
| The agent accepts **both** grammars: a bare `/name` token and `<Skill name="…" path="…" />`. Both parse to the same command list. | `duet-agent/src/turn-runner/skill-context.ts:190`, `:194` |
| Recognition reaches **real sessions**, not just the terminal UI — the RPC path expands it on every prompt and every answer. | `duet-agent/src/turn-runner/turn-runner.ts:1221`, `:1231` |
| `duet skills` prints `{skills:[{name,description,path,scope}], collisions:[]}`; scope is `user \| project \| temporary \| builtin`. | `duet-agent/src/cli/skills.ts` |
| Discovery walks **ancestors of the working directory**, then `~/.duet`, then built-ins; nearer wins collisions. Which folder you ask about changes the answer. | `duet-agent/src/turn-runner/skills.ts:49-63` |
| A session's cwd is the agent's anchor, and an agent can **move it mid-run**. | `spa/sessions/session-agent-picker.ts:11-15`; live value is `snapshot.cwd` |
| Sessions pass **no skills allowlist** — the picker's list is exactly the agent's list. Nothing can be offered that the agent would refuse. | `packages/gateway/src/runner/process-runner.ts` (`defaultRunnerFactory`) |
| Skills are files on the drive. Nothing mirrors them into the control plane. | no `skills` table in `packages/backend/convex/schema.ts` |
| Version safety: Duet pins `@duetso/agent` **0.3.8**. The tag alias landed in v0.1.149, `duet skills` in v0.1.100, `scope` in v0.1.8 — all far below the pin. | `package.json:10`; `git log` in duet-agent |
| Listing is **inert** — no shell execution. SKILL.md `` !`cmd` `` expansions run only in `readSkillInstructions`, when a skill is injected into a turn. | `duet-agent/src/turn-runner/skills.ts:184` vs `:226` |
| Production has exactly **one** `<ComposeBar>` mount, reached via `SessionsProduct`, which the agents-map panel reuses. "Everywhere" is a small set. | `spa/sessions/session-composer.tsx:75`; `spa/routes/agents-map.tsx:338` |
| Asking the VM costs a full agent-runtime spawn (~1s of CPU). The codebase already refuses to fold a comparable read into the polling rail. | `packages/gateway/README.md` (connected-providers) |

**Corrected during the walk:** idle VMs are *not* CPU-throttled. No such cap exists
in `packages/contract/src/resources/index.ts` or `packages/exe/src/exe.ts`;
workspaces get 4–10 vCPU. An earlier assumption to the contrary would have put a
fabricated latency number on this map.

---

## 2 · Known unknowns — the decision ledger

| # | Question | Decision | Closed by |
| --- | --- | --- | --- |
| D1 | When do we ask the VM for the list? | **Prefetch on composer mount**, shared per-cwd react-query cache, 5 min stale, refetch on picker open. | user |
| D2 | Which surfaces get `/`? | **Everywhere the compose bar appears** — make it the component default rather than opt-in per call site. | user |
| D3 | What does a *sent* message show where the skill was? | **A chip matching the composer.** Requires teaching the timeline renderer; `skipHtml` drops the tag today. | user |
| D4 | What shows when the skills read fails? | **A distinct "couldn't reach your workspace" line**, separate from the genuine empty state. | user |
| D5 | Picker layout | **Dense** — name + scope label + 2-line description. | user |
| D6 | Chip treatment | **Brand tint**, in composer and timeline. | user |
| D7 | Keyboard | **Tab completes as well as Enter.** | user |
| D8 | Is `/` one of a family? | **`@` is coming** — build the suggestion plumbing as one trigger among several. | user |
| D9 | What counts as done? | Merged to staging **plus an unprimed screenshot critique** before it is called verified. | user |
| D10 | Emitted form | The **XML tag**, not a bare slash — explicit, and carries `path` so the agent can open the SKILL.md. | user (original brief) |
| D11 | Public or private API? | **Private route** with an explicit owner reason; the shape is not final enough to publish. | assistant, stated |
| D12 | `collisions` on the wire | **Dropped** — nothing renders it. | assistant, stated |
| D13 | Can the picker offer a skill the agent can't run? | **No** — sessions pass no allowlist. | territory |
| D14 | Does the pinned agent understand the tag? | **Yes**, since v0.1.149; pin is 0.3.8. | territory |

Nothing OPEN.

---

## 3 · Unknown knowns — what got extracted

- **The built design was already the wanted design.** Four picker layouts and four
  chip treatments were rendered from the real `.claude/skills` list; the dense
  picker and the brand-tint chip won unchanged. Scope labels and descriptions
  both stay.
- **Tab matters.** Named unprompted. It was in the code but unproven; it is now
  pinned by a test that fails for the right reason — without the Tab branch the
  key leaves the editor entirely.
- **`@` is coming.** The decisive constraint, and it arrived only because the
  probe asked. It reshapes D8 from a shipping detail into an architecture
  choice: the trigger, the item source, and the chip node all become parameters
  rather than "skills" hardcoded three times.
- **Verification bar is visual, not just green tests.** An unprimed critique is
  part of done here — consistent with AGENTS.md, and stated rather than assumed.

---

## 4 · Unknown unknowns — landmine cards

**L1 · Unbounded spawn — DECIDED (build)**
`routes/skills.ts:40` → `spawnDuetCli` (`routes/memory.ts:90`) awaits `proc.exited`
with no timeout and no kill. A stalled `duet skills` hangs the request and leaves
the process running. Pre-existing for `/v1/memory`; D1's prefetch multiplies how
often it fires. → **10s cap in the shared helper**, 504 on expiry, picker shows the
D4 line. Fixes the memory route at the same time.

**L2 · A chip can outlive its skill — SHARP EDGE (accept)**
`skill-context.ts:111` — `if (!skill) continue`. The menu cannot offer a missing
skill, so this reduces to one reachable case: switching agents in the welcome
composer while a chip is already in the draft (`sessions.tsx:940` — the skills
list follows the agent, the draft text does not). History is *not* affected: the
timeline draws the chip from the tag, and an old message showing `/review` is
accurate, because it did run then. Validating historical chips against today's
list would invent a problem.

**L3 · Any bare `/token` is already a command — SHARP EDGE (no action)**
`skill-context.ts:200` splits the whole prompt on whitespace; anything matching
`^/[A-Za-z0-9_.-]+$` becomes a command, so "look at /review" injects that
SKILL.md. Pre-existing agent behavior, not introduced here — and an argument for
D10's explicit tag.

**L4 · The raw tag reaches the model, absolute VM path included — SHARP EDGE (no action)**
`skill-context.ts:130` passes the prompt through verbatim and appends the skill
block. `SECURITY.md` settles the exposure — one trust domain inside the VM — and
the path is useful there.

**Cleared by the sweep:** draft restore after a rejected send round-trips the chip
correctly (`sessions.tsx:228` feeds markdown back through the parse path the
seeded-draft test covers).

---

## Build plan — sorted by likelihood of tweaking

**1 · Generalize the trigger (D8) — the judgment call.**
`createSkillMentionExtensions` currently hardcodes `char: '/'`, a skills item
source, and one chip node. Turn those into parameters so `@` plugs in.
*Alternative if you'd rather not pay now:* ship skills-specific and accept a
retrofit — but the composer, the markdown codec, and the timeline renderer would
each need reshaping later, which is why this sits first.

**2 · Timeline chips (D3) — needs a call on mechanism.**
`markdown.tsx:81` sets `skipHtml`, which drops the tag before component mapping
can see it. Either a remark plugin that turns the tag into a node, or a
pre-transform of the message text before render. The plugin is cleaner and
composes with `@` later; the pre-transform is three lines.

**3 · Spawn timeout (L1).** 10s cap + kill in `spawnDuetCli`, 504 on expiry, both
routes. Small and mechanical once the number is agreed.

**4 · D1 prefetch + 5 min stale.** Currently lazy-on-open with a 30s window;
change `useSessionSkills` to fetch on mount and widen `WORKSPACE_SKILLS_STALE_MS`.

**5 · D2 surface default.** Hoist the capability into `SessionComposer` so all
three call sites get it, rather than passing it per call site.

**6 · D4 failure line.** One more picker state and two strings (en, es-419),
distinguishing "couldn't reach your workspace" from "no matching skills".

**7 · D9 screenshot critique.** Unprimed second opinion on the picker and chip
shots before calling the visual work verified.

Mechanical, no judgment needed: the strings, the ledger regeneration, the
baseline re-approval.
