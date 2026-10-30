# Authoring a default agent

What separates an agent worth the word "official" from a preamble. The
mechanics of getting one into the hub are in [the package
README](README.md); this is the part that decides whether it should be there.

## Know what you are competing with

Not an empty agent. A blank Duet agent already carries the whole default skill
registry — live go-to-market data, web scraping, media generation, app
building, publishing. Against that baseline, "be thorough" and "prefer primary
sources" change nothing: a frontier model already does those things when asked.

An official agent earns its place only by doing something a blank one would
not. In practice that is a **refusal** — a rule that makes it stop, say no, or
report an honest failure where the blank agent would cheerfully continue. If
you cannot answer *"what does this refuse that a blank agent would happily
do?"* in one sentence, the agent is filler.

The structural gate in `seed.test.ts` enforces that the required sections
exist. It cannot tell whether the refusal is any good. Only reading can.

## Two rules about what an agent may be

**An agent is a role, not a task.** Name it for a job somebody holds — the
thing that would appear on a business card. A user installs an agent to fill a
seat, not to run a verb, and a browsing user scans the catalog for the job they
need done. The framing also brings scope with it: a task-named agent can only
do its task, where a role does the whole seat.

**An agent must not be something the product already is.** Duet builds apps,
schedules jobs, wires webhooks and publishes sites. An agent whose entire job
is to use those capabilities restates the product back at the user and implies
the product cannot do it alone. The tell: its delegation list would name only
platform skills.

## Who is reading it

Two audiences, and confusing them is the most common authoring mistake.

The **agent** reads `AGENTS.md` as a system prompt, every turn. It also reads
the bundled skills, which are written for engineers.

The **user** is usually not technical. They will not read the code, and often
cannot find it. Nothing the agent says to them should require knowing what a
framework, a build, a deploy or a repository is. When a bundled skill is
followed, its vocabulary stays on the agent's side of the conversation and only
its consequences reach the user.

The corollary that catches people: an agent that has made choices on the user's
behalf must say so, in terms of what those choices *mean* rather than what they
*are*. "Nothing here remembers who a visitor is — fine for a brochure, wrong
for anything with accounts" is a decision the user can act on. The name of the
session library is not.

## Guide the function, do not just perform it

The agent holds a seat the user does not. Its job is to carry them through the
work, which means saying what happens next and why, surfacing the decisions
that are theirs, and stopping where their judgment is genuinely required rather
than guessing on their behalf. An agent that silently produces a finished
artifact has skipped the part the user needed.

## When the agent has an app

**App data goes through the app; the agent's own material goes in its folder.**
Two things look alike and are not. An app's data — a scope, a board, a queue of
cards — stays inside the app and is changed through its HTTP API, because the
app validates the write and the open page is watching that API; an agent editing
the file directly can put it in a state neither survives. The agent's working
material — a brand kit, a voice profile, anything a skill defines the shape of
and the agent maintains — is ordinary drive content and belongs in the agent's
folder under `$DUET_AGENT_DIR`, where it syncs, is visible in Drive, and outlives
the app.

The test is who owns the schema. If the app does, the app owns the file and
hands out an API. If a skill does, it is the agent's file and the app is just
the thing that wrote it first.

**An app is a folder, not a module — so the scaffolding is copied on purpose.**
Every app ships standalone into the user's drive, where it can be read, forked,
and edited without the repo it came from, so it cannot import shared code from
this monorepo. That is why the credential seam in `duet.ts`, the atomic
`state.json` read/write, and the SSE responder are byte-identical across the
apps that have them. Copy them; do not invent a variant.

The cost is real and worth naming: a bug found in one of those blocks exists in
all of them, and fixing it means fixing every copy. Before editing one, grep the
others — `sseResponse` alone has five. The alternative, a published package each
app installs, would put a version pin between a user and an app they own, and
that trade has not been made.


Most agents should not have one — see the README's promotion notes for why a
decorative app is worse than none. When one is genuinely warranted:

**Teach it, then offer to drive it.** The agent explains what the app shows and
how to use it, and then offers to operate it directly. A user who would rather
say "move that one to review" than click is the normal case, not a fallback.
This is why an official app is a *live* app: the agent changes data through the
app's own API while the user's open page updates without a reload. The pattern
belongs to the `build-apps` skill; do not reinvent it, and never have an agent
edit app source to change app data.

**An action that spends the user's money belongs to the user.** Most of what an
agent does costs roughly the same whether or not the user was watching, and it
runs as part of the work. A few calls are an order of magnitude dearer than
everything around them — a phone-number lookup costs about ten times a work
email — and those are not the agent's to decide. Put them behind a button, in
the app, with the cost said in plain language beside it: *"a phone number costs
far more than the rest of this page, so it is only looked up when you ask."*
Then say in the prompt that the button is theirs, and that the agent presses it
only on their word.

That is what an app scope is for. An app declaring `services` can reach a
provider through Duet's proxy with its own `$DUET_APP_API_KEY`, so the click
and the charge happen in one place instead of the user asking the agent to go
and spend. Two rules follow: never quote a number the provider can change (say
"far more", not a credit count), and treat a result that came back empty as a
result — re-running a lookup that found nothing costs exactly the same as the
first one, so an `unfound` field is terminal, not a retry prompt.

**The user cannot edit a default app, and must be told the way out.** An
installed official app is managed content — their edits would be overwritten by
the next update. When they ask to change it, do not refuse and stop. Offer the
copy: the agent can make them their own version of the app, which is theirs to
change, and can then edit it with them. Say that in plain language — *"I can
make you your own copy of this board, and then we can change it however you
like"* — never as a lecture about managed content and sync.

State both behaviours in the agent's own `AGENTS.md`. A capability the agent
does not know it has is a capability the user never gets.

**An official app ships real artwork, never a placeholder.** The product's own
fallback for a missing or unloadable icon is a letter monogram on a plain tile —
so an `icon.png` that is itself a letter on a dark square is indistinguishable
from a broken one, and the app looks unfinished on every surface that draws it.
If the icon does not exist yet, that is unfinished work, not a placeholder to
ship. Draw one visual metaphor for what the app *shows* (not the agent behind
it): one light glyph on a flat near-black ground in the app's own hue, generous
margin, no text. Full-bleed square — every surface masks its own corner radius,
so baked-in rounded corners double-round against the tile. Size, format, and
the cache-refresh mechanics live in the `build-apps` skill's
`reference/app-icons.md`; its AI-image-generation styling prompt is for
user-built apps — official apps keep the flat glyph family so the catalog reads
as one product.

**Give every user-visible contract state a visual scenario.** The typed
registry under `tests/visual/` owns that inventory; do not copy it into this
guide or add screenshot metadata to the production manifest. Arrange the state
through the app's public HTTP API and use a stable visible assertion as the
readiness signal. External provider and command edges may be controlled, but
runtime JSON, sleeps, and `networkidle` are not substitutes for the app's real
contract.

Treat committed screenshots as an honest baseline, not an excuse to redesign
the app during harness work. Fix a real load failure, clipping/overflow, or an
obvious broken state; record ordinary polish for later. The package README owns
the check, approval, and stale-image cleanup workflow.

## Integrations, and where a file can go instead

Two things are true at once, and holding only one of them produces a bad agent.

**A person will not paste a queue in.** Some inputs have no file form: a support
queue, a pull request, this month's ad results, what a site ranks for. An agent
whose work is made of those does not function without the connection, and a
"drop a file instead" path for it is a fiction that lets the agent look
functional while being inert.

**But plenty of inputs are naturally files.** A CSV, a draft, a contract, a
resume, a handbook, one interview recording — these are things people already
have as documents and hand over without complaint. Ask for them as files and
delegate the intake mechanics to the `duet` skill, which owns where they land
and what the agent does next. Do not copy its links or send a person to the
Files screen for an ordinary handoff, especially during onboarding; a whole
folder tree that chat cannot carry is the sole fallback.

So the test is **not** "does this data live in a system?" It is: **does this
input have a file form a person would actually hand over?**

- **Yes** → no connection required. Take the file, and *offer* to connect the
  source when the work is recurring rather than one-off. Walk them through it;
  never block on it.
- **No** → the connection is the agent's input, and the agent requires it.

**Required means onboarding.** `agent.json` carries an `onboarding` block, and
the agent stays locked until it completes — which is the honest state, because
a conversation that ends in "I'd need access to your helpdesk" has wasted the
user's first impression.

Choose the kind by what the user has to do:

- **App onboarding** (`{"onboarding": {"kind": "app", "app": "apps/<slug>"}}`)
  when there is a **choice** to make — which repos, which accounts, which
  queues, which property. A picker beats a conversation whenever the answer is a
  selection. The app authorizes, lists what it found, lets them tick what is in
  scope, and reports completion; the agent unlocks with that scope already
  recorded.
- **Chat onboarding** (`{"onboarding": {"kind": "chat"}}`) when there is only a
  **grant** and nothing to pick.

Either way the ask is in the user's words — *"I'll need access to your helpdesk
so I can see the queue"* — never the name of the provider rail.

## Onboarding is for anything the seat cannot start without

A connection is the common case, not the only one. Some seats need a durable
artifact before their first real request — a recorded brand system, an approved
scope, a rubric — and the test is the same one: **would the agent's first
conversation end in a refusal without it?** If the prompt already says "do not
generate until this file exists", then without onboarding the user's opening
message buys them a no, and that is the first impression onboarding exists to
prevent.

### Never onboard a connection through an app

`onboarding: { kind: 'app' }` opens a page inside Duet's app frame, and **no
integration can be connected from there.** Every provider's authorization page
refuses to render in a frame, so the page has to open a real browser tab, and
that tab comes back to wherever the connect call said — which, from inside an
app, is the app's own edge URL. The user ends up looking at a bare second copy
of the app in a stray tab, with no way back into the product.

**A connection is always chat onboarding.** The interview holds the one thing
the app cannot: a return address inside the product. `redirectTo` accepts a path
relative to the web app, so the script hands the user a link built like this —

```bash
curl -sS -X POST "$DUET_API_URL/v1/ws/$WORKSPACE_SLUG/integrations/connect" \
  -H "Authorization: Bearer $DUET_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"integration\":\"help_scout\",\"redirectTo\":\"/w/$WORKSPACE_SLUG\"}" \
  | jq -r '.authorizeUrl'
```

— and the provider returns them to their own workspace. An absolute URL pointing
at an app host is what produced the stray tab; keep `redirectTo` a Duet path.
Tell the user in one line what they are approving before you give them the link,
and check `GET …/integrations/connections` first so someone who arrives already
connected is never sent through an authorization twice.

### What an app onboarding IS for

Settings, inputs, and uploads that a page handles better than a conversation:
writing samples to drag in, a tone dial, a rubric with twenty rows, a colour
picked from a swatch. The test is whether the page is doing something chat is
bad at. Ticking one of three inboxes is not that — chat asks it in a sentence.

Two obligations come with it. **Nothing but the completion call ends the lock**,
and no session is running to make it, so the app itself must call

```
POST /v1/ws/:slug/app/onboarded   {"onboarded": true}
```

with its own `$DUET_APP_API_KEY` (declare the `agents` capability in the
manifest). The credential is the whole address — the platform resolves which
agent's folder the app lives in — so the app needs no slug it does not have. An
app onboarding that never makes this call leaves the user staring at a locked
card whose only button they already pressed.

An onboarding app is not limited to what a page can read, either: it holds the
`services` scope, so it reaches the platform's service proxies AND the workspace
model gateway at `$DUET_GATEWAY_BASE_URL`, and the gateway attributes that spend
to the app rather than the workspace runner. Send `x-duet-tier: services` for
app calls so they bill at the chosen model's cost. Spending eligibility is
separate from model selection; see the [model gateway](../../apps/model-gateway/README.md).
Whatever it cannot derive, it names as open rather than inventing;
what it must never do is unlock the agent before the thing the agent needs
actually exists.

And **the app takes no `ONBOARDING.md`** — it opens a page, not a session.

### Scope belongs to the chat first, the app after

When a seat has both — an interview and a scope page — the interview sets the
initial scope by writing through the app's own HTTP API, and the app is where
the user changes it later. Do not finish onboarding having connected something
and pointed it at nothing: a seat with a live connection and no chosen scope
looks ready and answers nothing.

Weigh the lock honestly. An `onboarding` block locks the agent until it
completes, so a seat that could have answered *something* useful on day one
should not carry one. A seat that could only have said no should.

**Script the interview in `ONBOARDING.md`,** beside `AGENTS.md` in the agent's
folder. An onboarding session swaps its system prompt for that file — `AGENTS.md`
is deliberately **not** loaded, and neither are the apps, agents, session, or
parent layers, because a user who believes they are being onboarded must not get the
agent's ordinary persona instead. So the interview knows nothing the file does
not tell it: not the seat, not what the connection is for, not what it is
collecting.

The file is optional, and the omission is silent in the worst way. Without it the
whole system prompt is the generated completion contract, whose fallback is *"ask
the user what they want this agent to know"* — a generic interview that runs, and
completes, and never asks for the thing the seat actually requires. That is a
safety net for an agent nobody scripted, not a design. **Every official agent
that declares chat onboarding writes one**, and `seed.test.ts` holds it both
ways: a script with no block never runs, and a block with no script runs the
generic fallback. (App onboarding takes no script — it opens a page, not a
session.)

Three things belong in it that authors reliably leave out: what "enough to
finish" means, what to do when the user cannot supply something (record the gap
and finish — being stuck behind setup is worse than starting with a known gap),
and what the agent should collect but *not act on* yet. Do not write the
completion call into it; the runtime appends that instruction itself, and a
second copy is a second answer.

## The scope page is one house style

Four agents ship a page that shows what is connected and what the seat is
pointed at — the surface the user returns to in order to change it. They are
meant to be one product. A user normally meets only one of them, so nothing
about a single page reveals the drift; it only shows up when you put them side
by side, which is exactly what nobody does while authoring. So the style is
written down instead of inferred.

Copy the nearest existing page rather than starting from a blank file, and keep
all of it:

**Voice is third person, always.** *"Your code reviewer reads changes before
they ship"* — never *"Before I can review changes, I need…"*. The page is part
of the product, not a message from the agent, and a page that speaks as "I"
next to three that say "your agent" reads as a different company.

**One anatomy.** A serif `h1` naming the thing the page controls, in the user's
words — *"The queue your support agent works"* — a one-paragraph lede saying
what the agent does with it, then one `.card` per step. Each card head carries a
letterspaced `Step 1` / `Step 2` eyebrow in the accent colour, an `h2`, and a
`.hint`. No kicker above the `h1`, and no step markers of any other kind.

**Two steps, in this order.** The connection, then the scope. Step 1 is status
only: it reports what is connected and points at chat for the rest — *"Connecting
happens in chat — ask your agent and it will send you the link"* — because a
Connect button here can only open a stray tab. Step 2 stays visible and explains
its dependency while step 1 is outstanding — *"Once a helpdesk is connected, its
inboxes appear here"* — rather than hiding until it is reachable.

**One token set.** Copy `:root`, `:root[data-theme='dark']` and the
`prefers-color-scheme` block verbatim; they are identical across all four
pages. The accent is shared, and deliberately not green, because `--good` is
green and an accent equal to the connected colour turns the status into
decoration. `--accent` is for interactive things — buttons, the step eyebrow,
checkboxes. `--good` and `--warn` mean status and never change per page.

**Status is honest or it is not status.** `pill on` means connected *and*
readable. A provider that is connected but whose list could not be loaded gets
`pill waiting` and the reason beside it — never a green tick above a failure
sentence.

**The primary action is `Save my choice` / `Save my choices`,** singular or
plural by how many the step takes, and it is disabled until it would do
something — with the reason next to it, naming which step is outstanding. A
disabled button with nothing beside it is a dead end.

**Close with what the agent will not do.** One `footer` line, in plain
language, about what it only reads and what it never touches.

**Every option row names its own service.** A bare *"Support"* in a list beside
*"Everything in Zendesk"* leaves the user guessing which product it belongs to.

**The page tells the truth on open.** Compute live status on the first read
rather than replaying stored state, and bound re-checks by elapsed time — not
by "has this ever run". A once-ever check leaves a user who connects *after*
that check staring at a stale answer with no way to know it is stale.

## One user story, done properly

Every agent exists to make one sentence true: *someone in this seat wants to
<do a thing> so that <outcome>*. Write it into the agent's `AGENTS.md`, near the
top, in the user's words.

It is not a formality. It is the thing that keeps an agent from sprawling into a
department: the SEO Specialist can do many things, but it exists so that a
marketer gets an article that deserves to rank; the Sales Coach can talk about
anything, but it exists so that a rep learns what a call actually established.
When a request is adjacent, the agent still helps — and when a feature would
serve a different story, that is a signal it belongs to a different agent.

The **listing summary** — that first paragraph, which is store copy — should be
that same story said outward. A browsing user is scanning for their own job;
the summary that names it wins the install.

## Every agent stands alone

Installing is a choice. Somebody read one card, decided that seat was worth
filling, and installed **that agent** — possibly the only one they will ever
install. It has to do its job on its own.

That is stronger than "do not mention siblings". It means the user story has to
be deliverable end to end by this agent, with its own skills, in a workspace
where nothing else exists. An agent that completes 80% of its story and gestures
at a colleague for the rest has failed the person who installed it, because that
colleague may never arrive.

You can see the whole catalog while authoring. **The running agent cannot.** It
has its own `AGENTS.md`, its own skills, and the conversation — nothing else. It
does not know which other agents exist, which are installed in this workspace,
or how the catalog is arranged.

So an instruction it cannot act on is worse than no instruction: it spends
prompt on nothing and can mislead. Never write:

- **A reference to another agent.** "That's the Vendor Manager's seat" names
  something that may not exist in this workspace. Say what you do and do not do
  — *"I don't track renewal dates over time"* — and let the user decide who
  does.
- **A catalog-level rationale.** "Finance is out of scope for this catalog" is a
  fact about our tag vocabulary. The agent cannot use it. State the actual
  boundary in terms of the work: what it will say, what it will not, and who
  decides.
- **Authoring commentary.** Explaining why the file is arranged as it is, or
  that a bundled skill is "its own copy", teaches the agent nothing it will act
  on.

The test: read a line and ask *"what would the agent do differently because of
this?"* If the answer is nothing, it is not a system prompt, it is a note to
yourself. Cut it.

Scope still belongs in the prompt, but check it twice: a boundary that stops the
agent short of its own user story is not scope, it is a gap. State a real limit
as a limit of this seat — *"I don't send the emails"* — never as a pointer to
another agent, and never where finishing the job was the point.

## The four required parts

Every official `AGENTS.md` carries these; the gate checks that the sections
exist, and a reviewer checks that they mean something.

1. **A refusal.** See above. This is the one that decides whether to ship.
2. **A named artifact layout.** An explicit folder contract, so a second
   session builds on the first instead of starting over.
3. **Defaults that took judgment.** Concrete values a user will never supply.
4. **A deliverable template.** The output's shape, pre-decided.

Plus a delegation list naming the shared skills it uses and forbidding
reinventing them — without it, agents re-derive APIs that the shared skills
already document better, and two agents give different answers from the same
data.

## The suggested first message

`agent.json` carries a `suggestedFirstMessage`: what the agent's empty default
chat opens with, rendered as a message from the agent, and materialized into
history when the user answers it. The gate requires one on every official
agent, capped at 300 characters.

It is the agent's first contact with someone who knows nothing about it, so it
does the whole job alone: first person, in the seat's own voice, one line of
what the agent does for you, ending in the first concrete thing to hand over
("Who should we look at first?", "Paste a draft"). Warmth over spec-sheet — the
role line in `AGENTS.md` already states capabilities; this one starts the
conversation.

**Never ask for something onboarding already collected.** A seat with an
`onboarding` block is unlocked only after setup finishes, so by the time anyone
reads this message the site is chosen, the repos are picked, the helpdesk is
connected. "Share your site's address" reads as amnesia to a user who just typed
it in, and it wastes the one turn where the agent could be useful. Write the
opening against what the seat now KNOWS: propose the first piece of work and ask
which, not whether. The exception is anything setup deliberately left open — a
draft to edit, a prospect to research — which is a real ask, not a repeat.

## Two things that are quietly catalog copy

**The first paragraph of `AGENTS.md`** becomes the listing summary and renders
under a three-line clamp on the card. It is store copy; everything after it is
system prompt.

**Skill names.** The card shows only the first two, sorted alphabetically. Name
them for what they do for that agent, and remember which two that ordering puts
in front of a browsing user.

This is the one that bites when a bundled skill is copied in from the repo's own
process. Website Builder carried `audit-choices`, `close-spec`,
`explore-unknowns` and the rest under their engineering names, so its card
advertised *"audit-choices, close-spec"* to somebody shopping for a website.
Renamed for the job — `build-the-site`, `check-before-launch`, `what-to-build`,
`write-the-plan` — the card now leads with the two that describe the work. The
skill's contents are for the agent and can stay as they are; the directory name
is store copy. (Keep names short for a second reason: the seed bundle is a tar,
whose path field caps at 100 bytes, and a long skill name plus a long reference
filename is what hits it.)

## The long-form description (`DESCRIPTION.md`)

An optional file beside `AGENTS.md`. Nobody the agent runs for reads it — the
marketplace detail page and the agent's own settings page render it verbatim,
identically, in place of the whole `AGENTS.md` when it exists. Capped at
64KiB; write to that budget, not around it.

It addresses the buyer, not the model: what role the agent fills, what it
needs from you, how the work proceeds, what you get, and where it stops.
Ordinary business language — no skill names, no file paths, no
system-prompt vocabulary — read by someone deciding whether to install, not
someone who will run the agent. Every claim has to trace back to `AGENTS.md`
or a declared app; describing a capability the prompt does not actually grant
is a promise the agent cannot keep.

Shared skeleton, structural consistency rather than fill-in-the-blank:

```
# Name
<opening outcome paragraph>
## What it does
## How it works
## What you get
## Boundaries
```

Without one, both surfaces fall back to the whole `AGENTS.md` rendered as
prose — delegation lists and system-prompt vocabulary, on a page meant for a
shopper. Write `DESCRIPTION.md` for any official agent whose `AGENTS.md`
alone would say too much of the wrong thing to a buyer.

## Cost is a design constraint

Upstream services meter different units: some charge per result, some per
request, and some by elapsed time. Paging through results can multiply the
vendor units. An agent that loops over an API needs to say in its prompt how
that loop is bounded. Never quote a price in an agent; the service catalog and
its discovery endpoint own current billing facts.
