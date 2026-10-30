# Draft C — Seam Quality

Bias: give each contract and transformation exactly one owner, then delete parallel vocabulary.

The draft identified these owners:

- shared contract: one identity-only sender union and request grammar;
- API: credential/path/source-session derivation;
- Convex: workspace validation, sequence/time, and durable input events;
- backend delivery: current identity resolution and prompt rendering;
- browser projection: durable/optimistic message shapes;
- browser presentation: current label/avatar resolution.

It proposed seven slices so each owner could land separately.

Useful pressure retained in synthesis:

- Remove the old shared `composeRunnerMessage`; prompt rendering has one runtime owner and does not belong in the cross-service contract.
- Carry whole durable rows into delivery instead of lossy `{seq,note}` projections.
- Keep history identity-only and build a page-local directory from existing member/app/session data rather than per-row fetching.
- Rewrite origin-based presentation directly instead of wrapping it in a sender adapter.
- Regenerate skill registry output and update the parent-session prompt as well as public docs.
- Precisely preserve runner task origin and non-input clocks.

Rejected during synthesis:

- Contract, API, backend, and projection changes cannot be green independent slices once sender is required; they form one atomic cutover.
- Model attribute names proposed by the draft were replaced by the user's settled `timestamp`, `user_full_name`, `user_email`, `app_id`, `app_slug`, and `session_id` grammar.
- UI resolution stays browser-owned; backend history does not acquire a second resolved-sender representation.
