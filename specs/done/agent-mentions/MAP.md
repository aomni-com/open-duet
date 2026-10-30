# Agent Mentions — Quadrant Map

The quadrant walk of 2026-08-14/15, kept as the record of how the thirteen
decisions below were reached. The feature shipped; `README.md` beside this file
is the rationale record, and `choices.md` the decision ledger.

> **Read this for the *why behind the givens*, not for instructions.** The
> walk's build-plan sections were dropped when the spec closed, along with the
> slice ladder they described. What remains is the reasoning: the settled
> ground, the D1–D13 decisions with who closed each, the taste the walk
> extracted, and the landmines — including three found after the walk, during
> slicing. Code citations are as of the walk and have since moved; the README's
> pointer table is the current map.

The feature: `@` mentions in the compose bar for the agents in the current
session's roster — the same parent + children set injected into the agent's
system prompt — emitting an `<Agent …/>` tag so the agent holds the slug it
needs to delegate or call APIs.

## Known knowns (territory, verified)

- The trigger plumbing was built for this. `ComposeBarTrigger` +
  `createMentionExtensions` take an array of triggers
  (`packages/ui/src/components/compose-bar/compose-bar-mention-extension.ts:39-131`);
  `skillTrigger` (`compose-bar-skill-trigger.ts:25-35`) is the ~10-line
  template. Binding invariants inherited from specs/done/slash-commands/:
  **one grammar both ends** (reuse `renderMentionTag`/`matchMentionTag` in
  `compose-bar-mention.ts` — no second parser) and **one shared Markdown
  bridge** (only one extension may own the `html` token; add to the trigger
  loop, never register a second bridge).
- The mentionable set is already computed by the only hierarchy algorithm:
  `groupAgentsByParent` (`packages/contract/src/agents/index.ts:436-466`),
  the same function behind `your-agents.md`
  (`packages/gateway/src/agents/your-agents-prompt.ts`). One layer each way
  (children + parent, self excluded) is the agent-delegation deadlock guard —
  an @ mention must never reach outside it.
- The address is the slug. The roster prompt and every delegation API speak
  slug (or cwd); `agentId` never rides the wire
  (`apps/api/src/routes/session-waits.ts:56-58`,
  `packages/contract/src/agent/index.ts:834-873`).
- No duet-agent change is needed: prompts reach the model verbatim; the tag
  is a pointer the model correlates with its injected roster + recipes.
- The timeline drops raw HTML (`skipHtml`,
  `packages/ui/src/components/common/markdown.tsx:81`, pinned by
  `markdown.test.tsx:29-34`); chips exist via the transform in
  `apps/web/spa/sessions/session-skill-chips.ts` applied at the single call
  site `session-markdown.tsx:42` — which serves **both** user input and agent
  text parts, so bidirectional chips are free.
- The agent page URL has one builder: `agentsMapUrl`
  (`apps/web/spa/drive/agents-map-url.ts:90`), route matched by the
  `agents/*` destination (`apps/web/spa/routes/product-destinations.ts:65`).
- Gateway routes follow the `createXRoutes(options): Hono` factory mounted in
  `packages/gateway/src/runtime/http.ts` (skills route at `:946-951` is the
  template); `agentIsLocked` + `resolveAgentConfig` are shared via contract.

## Known unknowns — decision ledger (all closed)

| # | Decision | Closed by |
|---|---|---|
| D1 | Mentions go by **display name**; tag = `<Agent name="…" slug="…" path="…" />`, `name` omitted when unset; label falls back to slug (`agentDisplayName` rule) | user |
| D2 | Timeline chips extend the fragment hack: `#duet-agent=<slug>` beside `#duet-skill=`; remark-plugin fix stays recorded debt for trigger #3 | user |
| D3 | Picker list = the gateway's roster **verbatim** (new endpoint), inheriting roster semantics: parent incl. root, self excluded, locked flagged, 30-cap, slug sort | user |
| D4 | Seam: `GET /v1/ws/:workspaceSlug/agents/:agentSlug/roster` (`root` answers first, like `resolveDefaultSessionOwner`) → api proxies (browser session + membership, skills.ts pattern) → gateway reads in-memory roster. Returns `{ parent: {slug,name,path?}\|null, children: [{slug,name,path,locked}] }`, names resolved | user |
| D5 | Tag is **referential-only** — no agent-side parsing/expansion, no duet-agent release | settled by silence |
| D6 | Picker: **flat list**, parent badged; rows = **name + slug**; locked children greyed + "awaiting setup" badge, **not insertable** (no strikethrough). Fallback if the plugin change turns hairy: hide locked children instead | user |
| D7 | Chips render **both directions** (user input and agent output) | user |
| D8 | Sent chip **opens the agent page** via `context.onLinkClicked` + `agentsMapUrl` | user |
| D9 | Closeout gate = `ui:check compose-bar` + unit tests; **no** staging e2e journey | user |
| D10 | Root session with zero agents: picker opens with an empty state ("No agents yet"), trigger never dormant | user |
| D11 | Teach the tag in `your-agents.md`: one line telling agents they may emit `<Agent name slug />` and it renders as a link (gateway-only change) | user |
| D12 | Agent-trigger ranking searches **name + slug** (extend `rankByName` with per-call keys; skills stay name-only) | user |
| D13 | Restrict `AgentNameSchema` (and its alias `WorkspaceDuetNameSchema`) with a small denylist of markup-breaking characters — `[` `]` `<` `>` `` ` `` and control chars — **no stricter** | user |

## Unknown knowns (extracted)

- Picker mirrors the product's existing skills picker taste: dense rows,
  brand-tint chips, Tab-or-Enter commit — reuse, don't restyle.
- Consistency with what the agent literally sees beats client-side liveness:
  D3 chose roster fidelity over Convex reactivity, accepting the skills-style
  loading/empty/unavailable states when the VM is unreachable.
- Duplicate display names are expected (names are non-unique); the slug in
  the row is the disambiguator, and slug search (D12) is the escape hatch.
- Done means the visual gate and unit tests — this feature does not warrant
  its own staging journey (D9).

## Unknown unknowns — landmines

- **L1 (decided → D6):** the suggestion plugin has no disabled-row concept —
  `activeIndex` wraps the full list, Enter/Tab commit unconditionally
  (`compose-bar-mention-extension.ts:230-245`), rows are live buttons
  (`compose-bar-mention-picker.tsx:88-92`). Non-insertable locked rows mean
  touching the Enter-contention-sensitive plugin; the fallback (hide locked)
  is pre-authorized.
- **L2 (decided → D11):** nothing tells agents the tag exists; without the
  prompt line, agent-side `<Agent …/>` output stays a silently-dropped tag.
- **L3 (decided → D12):** `rankByName` hardcodes Fuse keys to `['name']`
  (`compose-bar-mention.ts:78-87`).
- **L4 (decided → D13):** free-form names could break the `[@Name](#…)`
  markdown link; fixed at the schema. The transform should still escape
  `[`/`]` in labels as belt-and-braces for any pre-restriction rows.
- **Sharp edges (aware, no action):**
  - Baked-in tag names go stale on rename — accepted trade under D1 (the tag
    is self-contained; history elsewhere stays id-only).
  - Caps mismatch: picker slices at `MAX_SUGGESTIONS = 20`, roster caps at 30
    incl. parent — rows 21+ reachable only by typing. Same as skills.
  - `toRosterRow` (locked computation) is a closure inside
    `writeYourAgentsPrompt` (`agent-context.ts:262-272`) — lift it for the
    route; `readContainedDriveFile` stays gateway-private.
  - Deploy skew: stale web builds drop `<Agent>` tags invisibly. Transient.
  - Capability shape mirrors skills: required prop on `SessionComposer`
    (three mounts in `apps/web/spa/routes/sessions.tsx:930,1222,1639`),
    optional on the raw `ComposeBar`; `agent-surface-busy-fixture` stays
    bare.
  - Tag guard regex needs the same `(?=[\s/>])` lookahead so `<Agent` never
    matches `<AgentSomething`.

## Landmines found after the walk (during slicing)

Three the quadrant sweep missed, each verified in code and now owned by a
slice:

- **L5 — the picker keys rows by display name.**
  `compose-bar-mention-picker.tsx:81` uses `key={skill.name}`. Two agents may
  share a name (the roster expects it), so identity must stop being the name.
  Fixed: rows carry a stable `id`, which is the slug.
- **L6 — `renderMentionTag` writes every declared attribute, empty or not**
  (`compose-bar-mention.ts:23-28`). D1's "omit `name` when unset" and root's
  absent folder therefore need a codec change, not trigger config.
  Fixed: `renderMentionTag` omits an attribute with no value.
- **L7 — the D13 denylist has a read-path blast radius.** `AgentNameSchema`
  composes into `GatewayAgentConfigSchema` (the VM-sync roster wire) and
  `AgentSchema`, so one legacy bad name could fail a whole payload and blank
  every colleague. Enumerate parse sites and sweep data *before* restricting.
  Fixed: the VM-sync roster wire drops a violating row and keeps the rest.

