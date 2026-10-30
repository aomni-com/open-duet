# model-gateway

`model-gateway` is the Duet-controlled proxy in front of Vercel AI Gateway. It
accepts Duet model credentials from VMs and hosted tools, asks the backend whether
the generation may spend credits, forwards the request upstream, and reports the
generation result back for ledger reconciliation.

## Boundary

The gateway is a billing and credential boundary, not a model provider SDK. It
keeps caller keys away from the upstream provider, strips hop-by-hop and caller
auth headers, blocks upstream paths that would bypass Duet accounting, and lets
the backend own credit policy.

A human key identifies the caller; `x-duet-workspace` selects where a model
request spends. The backend checks current membership and its spending role
before forwarding. Each accepted generation retains that workspace, so changing
the CLI's default cannot redirect a pending charge. Managed credentials retain
their bound workspace and reject a conflicting selector. The selector stays
inside Duet, with the [security model](../../SECURITY.md) owning access policy
and the existing ledger owning payer resolution.

The product model catalog owns roles, free/internal facts, and Vercel provider
locks; it does not admit or deny model IDs. Catalog provider locks replace caller
routing choices. The Convex model-router policy owns optional configured endpoint
routing, after the exact tier billing closure has been checked. Discovery
preserves the full upstream list and metadata, while rejecting malformed
successful envelopes. Upstream validates concrete model IDs and operation
support. A listed model type does not add a new Duet generation operation;
hiding local roles remains a presentation concern.

Chat and embedding generations may carry an `x-duet-tier` claim. Without one,
ordinary requests use `services` attribution and bill at provider cost. The claim is
billing attribution, never an entitlement: no model is gated on the payer's plan,
and a tier-attributed request may name any model, catalogued or not. Inspection
parses the claim once, passes the tier to preflight, and strips the header before
forwarding; settlement bills a tier's flat rate only for the models that rate was
priced against (its closure) and upstream cost for anything else, so a cheap tier
claim never buys an expensive model below cost and a new upstream model needs no
change here. Catalog entries marked internal retain their unattributed housekeeping
path. Native image and video requests select the reservation rail from their
endpoint, including IDs outside the product catalog. They retain the fixed $2
hold and settle at upstream cost; the hold is an estimate, not a cost ceiling.
Known language models with media catalog hints retain their reservation behavior.
Other language requests, including new image-producing models, use post-response
at-cost billing.

A refusal this gateway authors and a refusal from upstream are different facts,
and the status code is the only way a caller tells them apart. Preflight runs
before anything is forwarded, so an upstream 401 or 402 can only ever be Duet's
own platform credential or provider balance — forwarding either verbatim would
let a Duet-side outage read to a caller as their own funding problem, and send a
fully funded person to a billing page with nothing to fix. Upstream refusals
become `502 upstream_failed`; a 402 reaching a caller is always one preflight
wrote.

Configured OpenAI and Anthropic routes normalize native JSON or SSE usage through
the model-router adapter. The response is preserved when it has begun; missing
usage releases the generation instead of retrying bytes through Vercel. Vercel
streaming responses are inspected as the client reads each chunk, retaining a
bounded text window for billing metadata after inline media. After cancellation,
extraction drains only until the generation ID or EOF. These extraction paths are
isolated because providers surface usage and generation ids in different shapes.

Configured-route HTTP failures, including 4xx responses, fall back to Vercel
before the response begins. The gateway emits structured fallback logs with the
route id, failure class, and Vercel result status; request bodies, credentials,
and provider response text stay out of logs. A configured SSE stream has a
bounded startup grace period; if it stays silent or closes before content, the
gateway falls back to Vercel instead of holding the request open.

## Pointers

- `src/index.ts` owns the proxy, preflight spend call, header policy, response
  forwarding, and billing callbacks.
- `src/extract-generation-id.ts` owns non-consuming generation id extraction.
- `src/provider-lock.ts` owns request-side provider routing enforcement.
- `src/model-router-gateway.ts` owns configured route classification, policy reads,
  header isolation, and the OpenAI/Anthropic request seam.
- `src/model-router-usage.ts` owns configured provider JSON/SSE usage
  normalization.
- `src/tier-attribution.ts` owns tier header parsing.
- `src/model-list.ts` owns the shape-preserving upstream discovery validation.
- Shared gateway constants and block response shapes live in
  `packages/contract/src/gateway`.
- Deployment details live in the root
  [Deployment (Vercel)](../../README.md#deployment-vercel) section.
