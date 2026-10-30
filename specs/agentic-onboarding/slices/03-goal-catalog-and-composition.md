# 03 — Goal catalog, follow-up copy, purpose composition

Headless: no step components yet. This slice owns ALL the words and the
paragraph they compose into.

## Contract unlocked

A typed, single-owner catalog of 3 goals × 1 question × 3–5 chips (one
default each, per-goal tag hints), and a pure `composePurpose` that turns
any answer state into the stored paragraph. Defaults-only taps produce a
rich purpose — this function is where the no-typing guarantee is proven.

## API seam

- `apps/web/spa/onboarding/onboarding-goals.ts` — the catalog: goal ids,
  question ids, chip ids, `defaultChipId` per question, tag hints per goal
  (values from the contract's `AGENT_TAGS`). Structure only; display labels
  are i18n keys in `messages/{en,es-419}/app.json` under `duetOnboarding`,
  keyed by the same ids.
- `apps/web/spa/onboarding/onboarding-purpose.ts` — pure:
  - `composePurpose({goalId, answers, details}) → string` — preset path:
    `"Goal: <goal label lowercased>. <sentence per question>."` using each
    question's sentence template; a non-empty optional detail appends in
    parentheses: `"Replacing: a pile of spreadsheets (three sheets and a
    Zapier chain)."`
  - `customPurpose(text) → string` — trimmed, clamped to the schema max,
    verbatim otherwise.
  - Composition uses the **localized labels the user actually saw**
    (what-you-tapped-is-what-you-stored). Tests fixture the en catalog.

## The copy (draft for user review — edit freely, keep ids stable)

▸ marks the pre-selected default, wherever it sits — chip order is reading
order, not a ranking. Sentence template in *italics*.

Three goals, not six. At six, the goal line barely discriminates — "grow my
business" and "increase sales" recommend nearly the same team — so the tiles
were widened and the follow-up made to carry the signal instead. Each tile
also carries a one-line description, since three broad labels leave the grid
roomy.

One follow-up per goal, not three. The wizard is goal, question, team: that is
what a first run can carry before the reader stops reading and starts tapping
to get through. So the single surviving question inherits all the weight the
set used to share, and the stored purpose is two sentences.

### The bar the goal's one follow-up has to clear

A question earns the goal's only slot only if it does all four. Anything that
fails one is market research wearing a recommender's clothes — pleasant to
read, useless to act on.

1. **It changes which four agents come back.** If both answers produce the
   same team, the question is decoration. This is the test that cut
   `driver` ("what's pushing you to change?"): a support desk needs the same
   agents whether it is too expensive or nobody uses it.
2. **It builds a model of the user, not a record of an event.** Who they are,
   what they run, what they are aiming at — things still true next month.
3. **It points forward.** Ask what someone wants to happen, not what went
   wrong. Same answers, better input: *"first job: SEO and content"* is an
   instruction an agent can act on; *"growth stalls at: not enough people
   find us"* is a complaint it has to translate first.
4. **It names something an agent can be pointed at, not the person asking.**
   The job to take on, the part that is hardest, the thing being replaced.
   This is the test with only one slot to give: a question about who somebody
   is shapes a pitch, a question about what needs doing shapes a team, and
   only one of those is what this wizard is for.

`replacing` is the one question exempt from (3) — grounding beats aspiration
when the goal label alone is thin. A recommender that only knows what someone
wants will hand a person who has not built anything a plan for finding their
first hundred customers.

**Grow my business** (`grow-business`) — hints: sales, marketing, operations
*It's running already — you want more of it.*
- `first-job` "What should {name} take on first?" — *First job: …* —
  Finding and researching leads · Writing the outreach · ▸ SEO and content ·
  Talking to customers · Reports and admin

The chips are five different teams from one tap: prospecting pulls research,
outreach pulls sales copy, content pulls SEO, conversations pull support,
admin pulls operations. It defaults to content rather than prospecting
because that is the most common real answer, and because being findable is
the job that precedes the rest.

**Launch my project** (`launch-project`) — hints: product, engineering, marketing
*You're starting something and want it out in the world.*
- `hardest-part` "What's the hardest part for you?" — *Hardest part: …* —
  ▸ Actually building it · Making it look right · Explaining what it does ·
  Finding the first users · Keeping it running

The skill-gap question, and the reason it takes the slot: builder vs.
designer vs. growth agent for two people launching the identical thing at
the identical stage. What is being launched, and how far along it is, both
narrow the team far less than which part the person cannot do.

**Replace my existing software** (`replace-software`) — hints: operations, customer-support, marketing
*Something you pay for, or do by hand, should just run itself.*
- `replacing` "What are you replacing?" — *Replacing: …* —
  ▸ A pile of spreadsheets · A sales or CRM tool · A support desk ·
  A reporting or analytics tool · An agency or freelancer

It carries almost all the signal here: the goal label alone is thin input,
"replacing a support desk" is rich. Spreadsheets defaults deliberately — the
most common real answer, and the least intimidating, which quietly widens the
goal past people shopping for a vendor swap.

Composed examples, all defaults:

- `Goal: grow my business. First job: SEO and content.`
- `Goal: launch my project. Hardest part: actually building it.`
- `Goal: replace my existing software. Replacing: a pile of spreadsheets.`

## Playable deliverable

Unit tests with golden composed paragraphs: defaults-only for each of the
three goals; with chip changes; with details; custom verbatim; every path
within the schema max. Runnable file-scoped.

## Verification

`write-tests` red first; file-scoped `bun test`. es-419 keys land in the
same pass (es419-copy-voice conventions) — the locale must not trail.

## Human review checkpoint (non-blocking)

The copy above IS the review artifact — the user reviews it in this spec.
If edits arrive before the slice starts, apply them here first. If not,
implement as written; label copy is reversible.

## Delegated to the implementer

Sentence-template phrasing polish; chip label tweaks that keep ids stable;
how the catalog types are expressed.

## Stays green

Everything — nothing imports these modules yet.
