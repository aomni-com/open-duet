# Human identity test callers

These choices cover the shared test caller join for slices 02–04. The source contract lives in `SECURITY.md`; the shared issuer lives in `packages/test-harness/src/convex-testing.ts`. Gate results and limits are frozen in [the receipt](test-callers-receipt.json).

## Authorization fixtures

**When:** shared caller pass based on `667840376`.

**Decision:** A test that needs less access signs in a different person and gives that person the actual current viewer role, or no membership. The shared issuer accepts only key name and expiry. An owner key therefore exercises owner behavior. The alternative was to keep a helper that accepted scope lists and discarded them.

**Gap:** The request prescribed the new issuer but left the many existing restricted-key scenarios to classify.

**Rationale:** Human credentials identify a person; live membership owns authorization. A discarded scope argument could make a permission test pass while its fixture represented the wrong person. Real role and non-member fixtures exercise the authorization boundary through the HTTP routes without adding another policy layer.

**Consequence:** Read and refusal cases prove roles that people can actually hold. Managed VM credentials and third-party OAuth/app grants retain their own bound fixtures.

## Device login and sync ownership

**When:** shared caller pass based on `667840376`.

**Decision:** Device approval authenticates a person without requesting grants or a workspace. The tests preserve pending, denial, expiry, polling, audit, consumption and revocation behavior. Tests for a credential that doubles as a sync machine, file-only human ceilings, and one-workspace human grants are removed. The alternative was to translate those obsolete constraints into a new credential classification.

**Gap:** The request allowed either rewriting old grant-only cases or deleting them where their behavior no longer exists.

**Rationale:** Human login and machine registration have separate owners. Slice 02 proves human identity and current memberships; slice 04 proves durable machines and mirror ownership. Repeating a removed grant model would contradict the canonical policy and blur those boundaries.

**Consequence:** Device-origin keys appear in ordinary human key management. File activity from a human key names its credential; machine attribution requires an actual machine origin. This pass claims no replacement machine lifecycle proof.

## Workspace and payer selection

**When:** shared caller pass based on `667840376`.

**Decision:** Human service/model preflight calls specify the intended workspace. A test that needs a credential bound to another workspace mints a real VM model key. Account billing tests use the payer's human identity; viewers can read workspace data but cannot change another person's payer settings.

**Gap:** Some former fixtures used a narrowed owner key as an implicit workspace selector or a stand-in for a VM credential.

**Rationale:** Explicit selection is necessary because a human key can see more than one membership. The credential kind and payer identity determine the actual contract; manufactured human grants cannot represent either one.

**Consequence:** The tests preserve selection and payer refusal without adding a first-workspace fallback. Hosted billing reaches the local missing-Stripe configuration response; it does not prove a live checkout or payment.

## Verification boundary

**When:** shared caller closeout.

**Decision:** Run the affected local HTTP/backend suites and owning type gates. Keep the real VM provisioning and Docker demo journeys for the full spec closeout. The alternative was to invoke the root suite or external-resource journeys during the shared helper migration.

**Gap:** The request required narrow runners and prohibited live writes, while the helper also has callers in external-resource probes.

**Rationale:** The local suites exercise real loopback Convex authentication and HTTP routing. Source/type checks cover the remaining callers without spending on exe.dev, Stripe or model providers. The receipt records the split wide gate and focused repair rather than relabeling an earlier failing run as wholly green.

**Consequence:** The focused commit is ready for integration review. The root owner still owns unified CLI demo composition, the final root gate and live staging closeout.

## Fixture lifetime

**When:** independent review follow-up.

**Decision:** The API suite helper records the membership IDs it creates and removes those exact generations in the existing after-test reset. The alternative was to make every caller remember a cleanup step or to weaken directory pagination assertions.

**Gap:** The new role fixtures added people to a shared workspace; the existing reset cleaned only the suite owner's other workspaces.

**Rationale:** Fixture allocation and disposal belong to the same helper. The existing backend test deletion operation already owns membership and directory cleanup, so the suite reuses it. Independent review identified the cross-test failure, and the full billing file reproduced it before the repair.

**Consequence:** Tests can use actual viewers without changing later member-directory state. No production cleanup mechanism or new backend test endpoint is introduced.
