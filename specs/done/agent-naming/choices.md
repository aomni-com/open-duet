# Choices ledger — agent-naming

Every decision this build made that the spec did not. Rewritten from scratch at
close and re-audited against the **final shipped code**, so entries a later pass
superseded are gone rather than left reading as open.

Grouped by verdict, least-confident first within each group. The `slice NN`
markers say where in the build a choice landed; the slice files themselves were
folded into [`README.md`](README.md) at close, so follow the file pointer beside
each marker rather than looking for them.

Nothing here is waiting on you: the three entries that were open have all been
decided and are recorded first, with what shipped. The rest are calls made
without you, ranked so the least confident come first.

---

## Decided by you

### The default agent's green "Active" dot stays hardcoded

Every agent's page shows a coloured dot beside its name — green "Active", grey
"Disabled", red "Unavailable". For a registered agent it is *derived*:
`agentDisplayStatus` reads the agent's row and its folder's anchor state, so a
missing folder turns the dot red. Duet has no row and no folder, so there was
nothing to derive from and I hardcoded green.

**Your call:** fine as is. The drive root cannot be disabled, deleted, or
unshared, so three of the four states are impossible; the only real one is
"unreachable", and the workspace shell already surfaces VM trouble above this
page. If that ever stops being true, the honest source is
`workspace.servicingStatus` on the identity, and it is a one-line change in the
`subject` block of `apps/web/spa/routes/agents.tsx`.

(The neighbouring `updatedAt: 0` is inert — it only cache-busts a custom icon's
URL, and the root has none.)


### One name length, 32, for every agent

Was: registered agents at 64, the default agent at 32, because the default
agent's name reused the workspace-onboarding schema that already existed.

**Your call:** standardize on 32. Done — `AgentNameSchema` is now the one rule at
32 characters, `WorkspaceDuetNameSchema` is an alias of it rather than a second
declaration, and the constant lives with agents because that is whose name it is.
The two can no longer drift, because there is only one.

The reasoning that survives in the code: the shortest surface decides. Both kinds
of name render in the knowledge map's centre label and the mobile header, so the
tighter bound was always the honest one.

### Naming at install is offered, never demanded

Was: a name required on the wire, the dialog pre-filled with the listing's title,
and Install disabled until the field was non-empty.

**Your call:** always show the dialog so the choice is always there, but let a
lazy user skip it and fall back to the slug. Done — the field starts empty with
the listing's slug as a greyed placeholder, the hint reads "Leave blank to use
research.", Install is never disabled for an empty field, and a blank submit
omits `name` from the request entirely.

This deleted a whole concept rather than adding one. There is now a single
fallback rule — absent name means the listing's slug — shared by the lazy user
and the unattended campaign install alike. The title-preference helper
(`defaultMarketplaceAgentInstallName`), its "what if the title is too long"
edge case, and the two-different-requiredness-rules seam are all gone.

---

## Sound, but you may disagree

### A publish slug you *ask for* is refused; one the system *derives* steps aside

**Where:** slice 00, `packages/backend/convex/domains/publishes/model.ts`.

Reserving `root` meant deciding what happens when a publish wants it.

Publishing works two ways. You can name the slug — "publish this at `/api`" — or
leave it out and the system derives one from the folder's name. Those now differ:
an explicitly requested reserved word is refused with an error, while a *derived*
one that lands on a reserved word quietly becomes `root-2`, exactly as it already
becomes `root-2` when `root` is merely taken.

My first version made both step aside, so asking to publish at `api` silently gave
you `api-2`. An existing test caught it.

**The gap:** the spec asked for the allocator to stop throwing; it never said what
a caller-supplied reserved slug should do.

**The reach:** this is now the house rule for reserved words anywhere — a request
gets an answer, a proposal gets the next free option. Future reserved words
inherit it.

**Why you might disagree:** you could argue a derived reserved name should also
error, so the user renames the folder rather than getting a URL they did not
choose.

**Confidence:** medium-high.

### The folder-clash retry's name is restored by the route, not carried by the dialog

**Where:** slice 04, `apps/web/spa/routes/marketplace.tsx`.

Installing can hit a folder clash: `agents/<name>` already exists, so a second
dialog opens asking where to put it instead. That dialog rebuilds the install
request from scratch — and knows only the listing's title, not the name you typed
in the first dialog.

So naming an agent "Mary" and then hitting a clash would have installed it as
"Research": succeeding, under the wrong name, with no error. The route now
remembers your chosen name and puts it back on any request carrying a folder path,
since only a retry has one.

**The gap:** the spec called out that the name must survive the clash, but not
how, and the detail page shares one callback between the Install click and the
retry.

**The reach:** anything that ever re-submits an install goes through that callback
and inherits the name automatically — or, if it submits a path for some new
reason, is silently treated as a retry.

**Why you might disagree:** branching on "does this request have a path" is
implicit where a second, named callback would be explicit.

**Confidence:** medium-high.

### Renaming the default agent lives in the agents code, though it writes a workspace field

**Where:** slice 02, `packages/backend/convex/domains/agents/model.ts`.

The backend is organised by domain: agent things in the agents folder, workspace
things in the workspaces folder. Renaming Duet writes `workspaces.duetName`, so
workspaces was the obvious home. I put it in agents, next to the existing
`updateAgent`.

Renaming an agent is one idea. It happens to be stored in two places depending on
whether the agent is the drive root or a real folder, but someone asking "where do
agents get renamed?" should find one answer.

It also picks up the agents folder's permission rule for free — editors may rename
— whereas the workspaces folder's own settings are owner-only, which would have
made renaming Duet stricter than renaming any other agent for no statable reason.

**The gap:** the spec named the endpoint and its shape, not which module owns it.

**The reach:** the agents domain now writes to the workspaces table. If you hold
domains to owning their own tables strictly, this is the exception.

**Why you might disagree:** the alternative is exporting the agents permission
helper and putting the mutation in workspaces.

**Confidence:** high.

### Three of four visual-critique findings were dismissed

**Where:** slice 04.

An unprimed reviewer raised four things about the install dialog. I fixed one: on
mobile the subtitle wrapped so "any time." sat alone on its own line. That was my
copy, so I shortened it.

I dismissed three — buttons ~36px tall (small for a thumb), the close "×" having
no visible edge to aim at, and the dialog being rounded and floating on desktop
but square and edge-to-edge on mobile. All three come from the shared dialog and
button components every dialog uses, so they are equally true of the rename,
delete, and folder-clash dialogs that already ship.

**The gap:** the spec required an unprimed critique but not what to do with
findings about shared components.

**The reach:** they may well be worth fixing — as one deliberate pass over the
shared primitives, judged against every dialog at once.

**Confidence:** high.

---

## Sound

### The live journey does not prove a name survives a publisher's update

**Where:** slice 06.

The most important property of install-time naming is that a publisher pushing an
update never renames *your* copy. The staging journey does not test it.

To test it live, the journey would need a marketplace listing it controls and can
push a change to. It owns none — it would have to borrow a real publisher's, and
the run would then depend on someone else's content. The property is pinned in
`packages/backend/src/marketplace.test.ts` instead, which drives a real pull
report through the real apply path, and the journey's docstring says the leg is
missing rather than implying coverage.

**The reach:** if this journey ever gains a listing of its own, that is the first
leg to add.

**Confidence:** medium — a backend test is genuinely weaker than a live pull.

### The `root` literal is spelled out in the reserved list rather than imported

**Where:** slice 00, `packages/contract/src/slug/index.ts`.

`root` means "the default agent" in three places — session filters, job filters,
and the `/agents/root` URL — all importing one constant, `ROOT_AGENT_SCOPE`. The
reserved-slug list does not; it contains the bare string `'root'`.

Importing the constant would make the slug module depend on the sessions module,
which already depends on slugs — a cycle. Instead a contract test asserts the slug
schema rejects `ROOT_AGENT_SCOPE` itself, so changing either spelling alone fails
loudly.

**Confidence:** high.

### Two slug generators were audited and left alone

**Where:** slice 00.

Reserving a word can break code that *generates* slugs, since a generator promises
an available slug and a reserved one is not available. I checked all four. One was
broken and is fixed (the publish one, above). The others:

- The workspace-name generator already copes — someone named "Root" gets the
  workspace `root-2` — though by accident of a `try/catch` rather than by design.
- The marketplace install generator cannot produce `root`: it validates the folder
  name first and falls back to the listing's slug, which is itself slug-validated.
- The shared-replica generator *could* return a reserved slug unvalidated, but only
  if an existing row already held one. The census found none, and reserving the
  word means none can be created. Guarding it would defend a state nothing reaches.

**Confidence:** high.

### No HTTP-level test for the registration-preserves-metadata fix

**Where:** slice 01.

The slice asked for the fix to be proven through the real `POST /agents` route,
not just the database function underneath. I tested only the database function.

The route between them hands the request body straight through (`...body.data`). A
test at that layer would be testing that spreading an object works. The rule this
bends exists for helpers production never calls; production calls this one on the
very next line.

**Confidence:** high.

### The map's "which zoom am I on" key uses the real root token

**Where:** slice 00, `apps/web/spa/routes/agents-map.tsx`.

A small internal value remembering which agent you had zoomed into. It used the
literal `'core'`; it now uses `ROOT_AGENT_SCOPE`. Any stable string would work —
using the real one removes the last place in that file inventing a second name for
the same agent.

**Confidence:** high.

### Three layout tests now import a product constant they don't conceptually need

**Where:** slice 00.

Three knowledge-map tests measure where things are drawn, not what they are
called, so their agent id is arbitrary. A review flagged all five fixtures still
using the old `'core'` id as stale; I updated all five rather than only the two
standing in for production, because a mixed convention is worse than either.

**Confidence:** high.

---

## Superseded during the build

Banked earlier, no longer choices — recorded so a reader of an older revision
knows they were resolved rather than forgotten.

- **"The dead roster projection was left in place."** Deleted in the closing
  review pass, along with the card type only it used and its own test. Its live
  neighbour `agentMenuShape` moved in beside the menu table, so one module now
  owns the ⋯ menu vocabulary.
- **"The canvas gained a flat `kind` prop rather than a discriminated subject."**
  Half-superseded. The canvas still takes `kind` plus flat fields, but the *route*
  now builds a properly discriminated subject whose absence is the not-found case,
  which removed twelve unchecked `agent!` assertions. The canvas's own props stay
  flat deliberately: four surfaces render it.

---

## Trivial discretion, not itemised

Internal naming (`subject`, `present`, `isRoot`), where the new dialog file sits,
the Spanish wording, the fixture app added to the agent-detail playground so its
Apps card demonstrates something, and the test-helper fix truncating generated
workspace slugs so a long prefix plus a two-digit counter stops overflowing the
40-character limit.
