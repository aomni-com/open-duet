# Model refresh

Model families express durable user intent. Provider versions are replaceable
execution details. Duet and the standalone agent advance those details through independent update
paths, without asking existing users to reselect a model or abandon conversations.
The release evidence is in [evidence.md](evidence.md); decisions made within the
user's requirements are in [choices.md](choices.md).

## Why this shape

The product premise is that customers buy outcomes, not tokens. The upgrade preserves chat
prices, ratings and selection IDs while recording upstream cost separately.
A cheaper successor improves margin; a more expensive successor can still be the
right model. Existing services/media settlement was outside this pricing decision
and retains its prior policy. The frozen [billing baseline](assets/billing-baseline.json)
records the fixed tariffs and historical coverage used for this comparison.

Product roles need not match provider version names. Terra keeps its coding
intent through the selected Sol successor. Video role names also stay stable: the
quality roles advance together, while the default fast role stays on its fast
lane because qualification found no equivalent newer fast variant. A larger model
number alone is not evidence that it serves the same job.

The CLI and workspace gateway update independently. A family name recognized by both installed generations works
across that overlap, but old saved state can still contain a concrete name because
previous CLIs canonicalized user input. Recovery therefore belongs at the existing
saved-state and routing-file read boundaries. It does not require a database
migration, another updater, or executable copies of retired models.

A standalone package can reach clients before every hosted component updates. Backend
admission and accounting must recognize successor IDs before that package can emit
them. Accepting an old request remains separate from advertising an old default:
active calls and independently updated clients can legitimately send old IDs.

## Invariants

- User selections, provider intent and historical conversation rows survive an
  upgrade. Known replaced saved names advance through one recovery mapping;
  a different explicitly supplied choice retains its ordinary precedence.
- Fresh-session defaults belong to the normal creation path. Resuming and then
  clearing a session must not silently replace routing policy with a concrete model.
- The current agent catalog owns executable model mappings. Duet owns product
  selections and tariffs; gateway routing is exported from the pinned build dependency.
- Historical fixed-price coverage is additive. Existing media/services billing
  remains tied to actual upstream settlement, separate from display estimates.
- An SSE generation ID may arrive after its media payload. Billing scans a bounded
  rolling window as bytes are forwarded, preserving backpressure while the client
  remains connected. Cancellation drains only until the ID or end of stream;
  missing IDs retain the existing release policy.
- Distribution uses the established package, deployment, workspace update and
  official-content sync paths. Source edits alone are not proof of delivery.

## Code boundaries

The agent's [model resolution](../../../../duet-agent/src/model-resolution/)
owns model families and saved-name recovery. Its
[routing loader](../../../../duet-agent/src/model-routing/loader.ts),
[saved-state boundary](../../../../duet-agent/src/turn-runner/turn-state.ts), and
[CLI run boundary](../../../../duet-agent/src/cli/run.ts) apply that meaning.
Provider catalog gaps and connected-account availability remain at their existing
adapters rather than becoming another runtime catalog or refresh service.

Duet's [shared contract](../../../packages/contract/src/) owns product model
selections, internal/media roles and billing coverage. The
[gateway runner](../../../packages/gateway/src/runner/) composes the exported
routing policy. The [response-stream owner](../../../apps/model-gateway/src/extract-generation-id.ts)
collects SSE billing identity while forwarding bytes.

The [official content](../../../packages/official-agents-seed/) and
[skills registry](../../../packages/skills-registry/) remain the authored owners
of distributed app and skill bytes. The
[feature journey](../../../packages/test-harness/src/staging-e2e-synthetic)
checks installed runtime, dispatch, preserved history, settlement and those bytes.
Frozen old-client fixtures in the agent test tree pin upgrade behavior rather
than reconstructing old state from the new implementation.

## Approaches rejected by evidence

Sending new concrete model names through the gateway before the binary updated
failed on the old validator. Stable names solved that order, but a new CLI reading
an old gateway file exposed the reverse order. Stable family names handle old-agent/new-gateway overlap; saved-name recovery
handles new-agent/old-gateway overlap. Neither requires coordinated restarts.

Treating every resolved option as saved state caused fresh explicit overrides to
be upgraded again during execution. Recovery must happen where saved state enters,
not repeatedly during execution. Separately, omitting resume overrides must not
remove fresh-session defaults used after clearing a conversation.

A short response prefix missed billing metadata after inline video bytes. A second
unbounded reader would have preserved metadata at the cost of client backpressure;
the response owner instead scans a bounded rolling window.

The first Seedance journey's child deadline expired although upstream generation
succeeded. The bounded diagnostic retry used the observed duration to choose its
ceiling and verified output and settlement. This is compatibility evidence, not a
claim about general generation latency or creative quality.

Per-pass reviews missed interactions visible only in the final agent composition.
Reviewing the complete release composition is necessary because package tests do
not cover every interaction.

## Visual provenance

The frozen desktop and mobile [playground captures](assets/visuals/before/)
preserve the existing picker layout and saved selection appearance. The provider-picker captures reuse the prior provider-alias fixtures; they are
not deployed-product captures. [Candidate captures](assets/visuals/candidate/) show the
updated model disclosures. [Comparison evidence](assets/visuals/diff/),
[pixel bounds](assets/visuals/pixel-bounds.json), and the
[independent critique](assets/visuals/independent-critique.md) record the measured
change. The [visual review](assets/visuals/review.md) records the fixture scope and
comparison method. The user did not request a picker redesign; these images preserve the
standard against which the disclosure update was judged.
