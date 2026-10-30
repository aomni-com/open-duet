# Open model access

Duet's model catalog expresses product defaults and billing facts. It does not
control which upstream model IDs a caller can use. Gateway discovery preserves
upstream metadata, and direct CLI/MCP generation accepts upstream choices on the
operations those clients already support.

This separates a product recommendation from a permission boundary. Requiring a
local price entry blocked usable media models even though settlement already
reads actual upstream cost. Adding a second registry would recreate that gate
and make clients disagree as providers change their offerings.

## Selection and accounting invariants

- Upstream validates concrete IDs and operation support. Duet still enforces
  credentials, current workspace access, service spending, credits, rate limits
  and existing provider locks. Opening model choice does not weaken that boundary.
- An explicit raw ID stays exact. Text compounds and the selected workspace's
  effective text default use the existing general route, recursive resolution,
  model-family expansion and vision fallback. Direct generation invokes no
  classifier/advisor, and a failed default lookup never silently substitutes.
- A human credential must select its workspace; only a credential already bound
  to one workspace can infer that binding. Existing direct Vercel credentials
  retain their transport and runtime defaults without requiring Duet login.
- Image/video defaults remain media roles. Chat compounds do not select media
  generators, and discovery of a new type does not add a CLI operation.
- Chargeable direct generation is billed at upstream cost; existing free/internal
  catalog facts remain. Selecting a compound's backing model does not make a
  compound tariff claim. Explicitly attributed agent
  traffic retains its existing billing rules.
- Native image/video endpoints choose reservation billing before catalog hints,
  even for unknown IDs. Language endpoints retain existing media hints; newly
  discovered image-producing language models use post-response accounting.
  The media hold remains an estimate, not a cost or strict spending ceiling.
- Output bytes and settled accounting are separate evidence. A usable image or
  video does not establish that an upstream generation ID and actual charge
  reached the payer's ledger.

## Ownership and tradeoffs

The runtime owns route resolution and SDK generation; the contract owns product
alias composition; clients own workspace selection, I/O and result persistence.
The gateway retains filesystem preparation of managed routing. Moving only pure
alias composition let CLI and gateway use the same defaults without importing a
VM server into the public CLI.

MCP matches model availability and media operation selection. It reads upstream
capability metadata before image generation, including role-based calls, because
an image-producing model can be a language model. That read is bounded and
best-effort: a metadata outage retains native generation rather than becoming
another admission gate. This adds read latency but avoids provider-name
heuristics and duplicate capability facts. Full parameter parity and a new MCP
text-generation tool remain outside this feature.

Optional CLI retry and MCP video-size controls let automation bound paid work
through supported client inputs while retaining existing defaults. The focused
acceptance journey uses the built standalone CLI and official MCP client directly;
putting a paid agent between them would test another workflow and buy extra calls.
Its cleanup uses exact owned resources, so concurrent journeys remain intact.
Failed output gives existing accounting a bounded wait to settle or release
before deleting its payer, because an SDK download failure can follow a completed
billable generation. Timeout records missing accounting evidence and retains
resource teardown; it cannot pass acceptance.

The hosted SDK's Node downloader is loaded dynamically, which a single-file
bundler cannot discover. The function artifact retains that dependency beside
its entry file; a manifest declaration alone cannot satisfy runtime resolution.

[Implementation choices](choices.md) records these decisions and their alternatives.

## Compatibility

Successful command, role, credential, output and ResourceLink contracts remain.
No migration or compatibility layer is required. Concrete observable changes are:

- Invalid IDs reach upstream validation instead of local catalog-rejection errors.
- Discovery includes more entries and unfamiliar metadata types.
- Uncatalogued native media formerly misclassified as text now requires the
  existing media hold. A request with too little available credit can be refused.
- Failed text streams now exit nonzero and preserve an existing output file;
  the SDK's filtered error events previously produced empty success.

## Code and proof

- [Gateway discovery and request inspection](../../../apps/model-gateway/src/)
  own upstream envelope validation, endpoint classification and byte-preserving
  forwarding. `index.test.ts` and `video-generation-accounting.test.ts` exercise
  pinned SDK wire shapes and large trailing metadata.
- [Backend preflight](../../../packages/backend/convex/domains/modelGateway/preflight.ts)
  retains authorization and spending checks. Its adjacent tests and
  [real-local accounting tests](../../../packages/backend/src/model-gateway.test.ts)
  pin both at-cost billing rails.
- [CLI selection](../../../packages/duet/src/cli/model-selection.ts),
  [runtime resolution](../../../packages/agent/src/model-routing/resolve.ts),
  [alias composition](../../../packages/contract/src/model-tiers/index.ts) and
  [shared media generation](../../../packages/agent/src/model-resolution/generate-media.ts)
  own selection and execution. The public CLI tests verify final requests,
  complete outputs and failure recovery.
- [MCP media tools](../../../apps/mcp/src/tools/media.ts) own discovery pagination,
  role/raw-ID adaptation and durable Drive links; `index.test.ts` exercises them
  through the official client.
- [Consumer reference](../../../skills/duet/references/models.md) teaches external
  agents; [delivered skills](../../../packages/skills-registry/skills/) teach VM
  agents. Installed CLI help remains the command contract.
- [Focused staging journey](../../../packages/test-harness/src/staging-e2e-synthetic)
  joins public client output with exact terminal settlement. Its
  [accounting oracle](../../../packages/test-harness/src/staging-e2e-synthetic)
  rejects missing IDs, released charges and mismatched payer debits.

Local closeout ran the full build, type, lint and test gates. The full test run
exposed an outdated release fixture that replaced the entire contract module;
its repair retains the real routing owner and passed the complete gateway suite.
Affected packaging and failure-accounting tests passed after live repairs.
The [acceptance record](assets/staging/README.md) retains the focused deployment
receipt, costs, cleanup proof and the limits exposed by earlier failed attempts.

No visual UI change is part of this feature's acceptance. Public CLI packaging
is verified separately from the repository's automatic release workflows; the
focused journey targets staging. Main/staging alignment was requested explicitly.
