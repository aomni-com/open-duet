# Installed-package capability qualification

This frozen fixture closes wire-level evidence gaps for the model refresh. It
imports only installed `@duetso/agent`0.3.29 `dist/src` and its production SDK.
Controlled fetch responses simulate model decisions. The actual serializers,
response parsers, structured argument validator, session runner, write tool and
bash tool execute. It is not a live provider or autonomous coding-quality eval.

`requests.json` retains the redacted successful wire captures. `receipt.json`
records exact package provenance, runtime versions, assertions, falsification
results, cleanup and evidence limits. No credentials or user content are stored.

To reproduce from this directory, copy the fixture to scratch output and run in
Docker (do not mount a working repository for writes):

```sh
probe_dir=$(mktemp -d)
cp capabilities.test.ts verify-package.mjs run.sh "$probe_dir/"
docker run --rm --cpus=2 --memory=2g \
  -v "$probe_dir:/receipt" -w /work \
  -e HOME=/tmp/home -e DUET_TEST_IN_DOCKER=1 \
  -e DUET_API_KEY=controlled-key \
  oven/bun:1.3.11 sh /receipt/run.sh
```

The recipe pins the observed SDK/TypeBox versions without changing the immutable
agent artifact. It verifies all installed agent files against the registry
tarball, then falsifies each contract and reruns green. Falsifications remove
actual outbound fields through the SDK's `onPayload` hook, return a wrong schema
type at the provider edge, or return wrong arithmetic code whose real bash check
fails. They do not replace production runtime modules.

GLM is text-only; no vision support is inferred for it. Actor effort is supplied
through the production `streamSimple` mapping. Structured calls exercise the
current Luna memory caller option shape through the shared structured-output helper (`reasoningEffort: low`); raw
Anthropic stream options use a different API-specific grammar. Exact plan-account
serviceability and live generation quality remain separate qualification facts.
