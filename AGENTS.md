# Working in this repo

Read [`README.md`](README.md) first: what the product is, how the repo fits together, and how to build and check it. Active plans live with their specs, and each one says what to do next. If a folder you're working in has a readme, read it before continuing. The readmes are written for you.

These are the principles. Commands, flags and paths live with the code that owns them: the readmes, the manifests, and each tool's own usage text.

## Talking to the user

The user is very technical but doesn't read the code day to day. Pointing at code is fine; introduce a variable, function or module briefly the first time you mention it.

Lead with contracts. When work touches an interface between components (an endpoint, a message shape, a database schema, a module boundary), say what the contract looks like and how it changed before anything else.

Answer routine questions from the evidence. Ask the user only when the answer changes a decision that matters and can't be settled any other way.

## Proving a change

Optimize for iteration speed. The measure is the time to feedback you can trust, not the amount of process you ran.

Run the narrowest check that answers your question: one test, then one file, then the tests your edit can reach, then one package. That is the proof for everyday work, including a commit, a merge and a push.

**Run everything once, when a spec's implementation is finished.** Running everything is slow, saturates the machine and starves every other session sharing it. Until then a change is checked by what it can move: its own tests and the output it touches. That is enough for a commit, a merge, a push and a finished feature. A failure that only the full run finds is fixed at the end; that is cheaper than gating every step.

A change that reaches the whole system (a database schema, a package every app imports) does not bring that run forward on its own. While more work is coming, the full run still waits for the end. Run it sooner only when the next piece of work can't be trusted without it.

Every expensive run must answer a question a cheaper one can't. The integration tests, which boot real local deployments of the backend, and the journeys against live staging, which consume real staging resources, are the expensive runs here; do only the ones a change can move. Reuse a result that is still valid, and rerun only what a change could have invalidated. Docs and data that no code reads need no run at all.

A large change (a full spec, a major feature) ships with its own staging journey where possible, and ends by running that one journey against live staging, once, before the work is called done. The full staging run belongs to dedicated sessions. The [test harness](packages/test-harness/README.md) owns how.

Write the test first. Before changing behaviour or fixing a bug, invoke [`write-tests`](.agents/skills/write-tests/SKILL.md) and follow its red/green workflow. Test what the product does and how it fails, not how the code is shaped.

A change that shouldn't alter behaviour (a refactor, a performance change) must leave the output unchanged, or be a named decision.

Never loosen a requirement to make a check pass. A narrow pass proves a narrow claim: say what you verified, what you assumed and what is unfinished.

Don't wait on a long run. Start it in the background and keep working. Give it a visible sign of progress and a point where you stop, and never repeat a failure unchanged.

## What the user sees

Look at the actual screen. A passing check is not evidence that something reads well to the person in front of it.

Before a visual UI change, invoke [`ui-playground`](.agents/skills/ui-playground/SKILL.md) and follow its reproduction and visual verification workflow.

For any visual change:
- get an unprimed second opinion with [`screenshot-critique`](.agents/skills/screenshot-critique/SKILL.md);
- judge before against after, and our output against references, with [`compare-screenshots`](.agents/skills/compare-screenshots/SKILL.md);
- show the user with [`preview-shots`](.agents/skills/preview-shots/SKILL.md).

## Security decisions

[`SECURITY.md`](SECURITY.md) is the canonical security model. Read it before deciding anything security-shaped (auth, scopes, capabilities, credentials, trust boundaries) and before reporting a security finding in a design or review. It settles most of these questions already. Raising one it has answered costs the user a correction and invites the over-engineering it explicitly rejects. In particular, inside a workspace's machine there is one trust domain.

## One owner per concept

Use what the repo already chose before writing your own. Find the existing owner of a concept before creating another. A fact has one home too: when something is explained in two places, one of them becomes a link.

Prefer one general rule to a special case, and a simple structure to an abstraction nobody needs yet.

Spend margin on simplicity. When something has room to spare against its budget (response time, startup, memory, bandwidth), use that room to keep the design simple. Don't add machinery to make a thing faster than it needs to be, and take such machinery out when the margin shows it wasn't needed. When something replaces an old mechanism, delete the old one. When a change exposes a duplicate or a stale owner, invoke [`refactor-clean`](.agents/skills/refactor-clean/SKILL.md).

## Parallel work stays cheap

Every parallel checkout is a full copy, and installed dependencies and build output multiply with each one.

- Share what doesn't change between checkouts. Don't make another copy.
- Never share build output between checkouts whose sources differ. They overwrite each other's builds, and the symptom is an error from someone else's change.
- Remove a checkout and its build output when its branch is merged.

## Skills

Skills hold the procedures behind these principles. Load the one that covers your work before you start.

Before changing this file, invoke [`audit-agents`](.agents/skills/audit-agents/SKILL.md).
