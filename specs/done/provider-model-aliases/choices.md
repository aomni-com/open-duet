# Implementation choices

All choices below are retained in the final implementation. They fill engineering
or presentation details that the product request left open.

## Selection and presentation

**Keep provider choices outside the subscription ladder.** During the contract
pass (`3cf933e60`), I kept the three automatic routers as their own type and added
a broader type for saved selections. Both use the existing database fields and
request names. Treating provider aliases as higher subscription tiers would let
plan changes overwrite a person's provider choice. The consequence is an additive
selection contract with no new column or migration.

**Use one Advanced group in the existing selector.** The shared control owns
submenu, drawer, selection, and focus behavior; product metadata owns labels,
model names, and the user-approved comparison ratings. A separate provider picker
would duplicate these mechanics. Every option uses the existing required score
contract after the user requested scores for provider aliases too.

**Reopen mobile Advanced when it contains the saved choice.** The request did not
specify this state. I chose it so the checked option is immediately discoverable,
instead of hiding the user's selection behind a collapsed group. The UI pass
(`f041eb156`) also allows the drawer up to 90% of viewport height, preserving
scrolling on short screens, and keeps desktop submenus eight pixels from viewport
edges. After the user added ratings, I widened the desktop settings control
and tightened the mobile metric spacing so the full provider label stays
readable alongside its points. These are reversible layout choices within the
existing control.

## Routing maintenance

**Export standard routing policy from the pinned agent.** In the gateway pass
(`1182b57d5`), I used the installed CLI's export during builds rather than copying
its three router policies by hand. A checked-in export permits ordinary source
imports, while a provenance check detects stale data. This leaves automatic
routing policy with the agent and product aliases with the contract metadata;
agent dependency updates refresh the export through the same build.

**Avoid rewriting an identical managed file.** The gateway compares complete
serialized content and atomically replaces it only when needed. Missing files are
created; unexpected read or write errors fail preparation. Rewriting every time
would create needless file activity; accepting a failed refresh could execute a
stale target. The consequence is unchanged files remain untouched, while a
failed preparation must be retried before a runner starts.

## Evidence boundary

**Reuse existing runtime receipts.** In the staging harness pass (`6c74646d6`),
I used gateway health plus its existing bounded operator file reader. Health
identifies the running release; the file reader shows the actual nested routing
file. Adding a diagnostic endpoint or SSH dependency would create another surface
to maintain. The recorded manifest hash is explicitly the announced hash, not a
claim that the harness read the running bundle's bytes. Concrete model generations
and ledger debits independently establish execution and billing.

**Keep the file-projection regression deterministic.** During closeout
(`99e0569d6`), the full suite exposed a race between the real scheduler and a
fixture that expected projection to remain pending. I added an optional pause to
the existing test-only recorder: it cancels only that transaction's projection
job, then the test explicitly runs projection. Waiting longer would make the
pending-state assertion less reliable. The production scheduler is unchanged;
the test still rejects scanning raw activity while projection is pending.
