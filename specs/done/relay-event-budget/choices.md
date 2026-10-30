# Choices ledger

Every decision this build made where the spec was silent, re-audited against
the shipped code. Least-confident first.

## Provisional — worth revisiting

**A terminal event still relays its full runner state.** The control plane
drops that state before storing (`leanCanonicalEvent` keeps only marker
fields), so a 6.7 MB `complete` — the shape sitting in the live session's queue
today — travels in full to be discarded. The budget exempts `state`
deliberately, and nothing is broken by it: such a record relays and stores
fine. But it is the remaining pressure on the 16 MB queue cap, and trimming it
to the three fields the control plane actually projects (`stateMachine`,
`todos`, `followUpQueue`) would remove that pressure. Held back because the
same record feeds the live event stream, so it needs its own verification that
the timeline is unaffected. **If a session ever jams on queue capacity rather
than on one oversized event, build this first.**

**A relay id that returns with different content now settles, and logs.** The
refusal it replaces guarded a real bug class — a gateway minting one id for two
events, where settling silently loses the second. That refusal had to go: it
strands the record at the head of a queue nothing behind it can pass, which is
the failure this spec exists to end. The signal survives as a log line. **If
you see "reapplied with different content" in Convex logs and it is not a
normalized retry, an event was dropped.**

## Sound

**A backlog kill reports itself as a system event, not as a terminal.** The
approved design put the reason on an `interrupted` marker; the gateway cannot
author one, because a terminal folds its `state` into the ledger checkpoint and
the gateway has no state to fold except the real one it would destroy — the
only thing a later answer resumes from. So it reports the fact and Convex draws
the ending through `terminalizeSession`, the same owner that ends a turn for a
paused workspace. What you see is the approved wording either way. _Where to
look:_ the terminal is written in Convex, not the gateway.

**The budget measures an event without its `state`.** `state` rides on
`turn_started` and all four terminals, and the control plane drops it in every
case. Counting it would cut a turn's real state to fit a limit it never meets.

**The report is admitted past the very capacity that triggered it.** Capacity
stops a runner outrunning the control plane; refusing the record that reports
the stop is the one refusal that makes things worse. One record per killed turn
may exceed the cap, by design.

**The relay route answers 502, never 401, for anything its catch sees.** Every
authorization outcome on that route is an explicit answer before the try block.
A bad VM token still gets 401 — from the code that actually checked the token.

**The contract's media table is the gateway's old table, entry for entry.** No
format was added, removed or renamed in the move, which is what makes "changes
no behavior" provable: the renderer's 33-case suite and the gateway suite both
pass untouched. **Supporting new formats (HEIC, AVIF) is now one edit to one
table** — deliberately not done here.

**The showing-files prompt sits last, after the agent's persona and roster,**
before the onboarding contract which stays last as the immediate task. Prompt
order is reading order, and a note about how the product renders files does not
belong above who the agent is.

**The event budget lives in the gateway, not the contract.** The spec put it in
`@repo/contract`; the gateway is its only enforcer, and the ceiling it answers
to is Convex's, not ours.

**The Bun append guard's test moved down to the write primitive.** It used to
pin "a journal record past 2 MiB round-trips intact", which the 300 KB budget
deliberately makes false. Its durable claim — an append writes exactly the bytes
it was handed — now lives in `atomic-json.test.ts`, true regardless of any
budget.

## Needs the user

_(none — every decision above was made on evidence in the code, and the ten
ledger decisions in `MAP.md` shipped as agreed.)_
