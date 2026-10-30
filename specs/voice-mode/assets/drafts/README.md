# Independent planning drafts

The canonical plan synthesized four read-only drafts after the product
interview. These notes preserve the useful disagreements without turning draft
plans into alternate implementation authorities.

## Fewest-slices lens

This draft proposed five large rungs: production-backed call surface, runtime
spike, one combined secure call/Main record, complete LiveKit integration, and
staging closeout.

Useful pressure it contributed:

- keep Voice a platform runtime, never an agent entity;
- make the first checkpoint backend-free and production-backed;
- keep the browser response free of the worker ticket;
- avoid slicing infrastructure that has no independently judgeable artifact.

The canonical plan kept its topology and first checkpoint but split the broad
backend/integration rungs where the risk draft exposed independent stop/go
proofs.

## Risk-first lens

This draft proposed separate early proofs for provider latency, actually-heard
audio, and Main request correlation before building worker/browser integration.

Useful pressure it contributed:

- interruption retention and Main correlation are falsifiable proof
  obligations, not implementation details;
- no caller may infer that the latest Main output belongs to its request;
- every agent utterance needs a Main or closed runtime source;
- real staging audio and cleanup belong in one selectable closeout journey.

The canonical plan adopted both stop/go proofs and kept the total to ten slices
by combining only seams with one shared artifact.

## Seams-first lens

This draft traced the exact roster, default-session, durable-delivery, media,
credential, MCP, and staging owners.

Useful pressure it contributed:

- use `launchable && !locked`, not a Voice-specific eligibility model;
- inject the ASR reminder at the durable composition seam used for live and
  replay;
- do not broaden the image/base64 owner into audio;
- construct the MCP registry narrowly rather than enumerate broadly then
  filter;
- add a boundary firewall for `livekit-client` imports.

The draft preferred a `sessionKind` field on every session and a separate
contract slice. The canonical plan instead uses the one-to-one `voiceCalls`
record to avoid a data migration and places contracts with their owning
behavior slices.

## Operational/privacy lens (Claude Opus)

The mixed-model draft emphasized deployment, provider retention, endpoint
firewalls, credential audience, Python verification, and the currently
unreliable live Main staging path.

Useful pressure it contributed:

- LiveKit Inference ZDR does not disable agent observability; `record=False`
  must be executable configuration;
- explicit dispatch metadata is the clean ticket-delivery seam;
- the web boundary checker does not automatically notice third-party realtime
  clients;
- the Python worker needs first-class monorepo verification and deployment
  documentation;
- staging must preflight Main and never grow a Voice-specific fallback for an
  external agent-runtime failure.

It proposed more operational sub-slices and a semantic classifier with numeric
over-routing thresholds. The canonical plan keeps the privacy/operability gates
but uses a closed local-speech enum and a zero-under-routing policy corpus,
which more directly reflects the user's “small talk only” rule.

## Synthesis rule

Only [the spec README](../../README.md), [the unknowns map](../../MAP.md),
[the choices ledger](../../choices.md), and the slice files are authoritative.
These summaries are provenance, not alternate plans.
