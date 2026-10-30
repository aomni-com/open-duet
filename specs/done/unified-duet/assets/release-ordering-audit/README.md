# Additive production deployment and runtime retirement

This is a read-only audit and a proposed invocation, not a deployment receipt.
Freeze the updated additive source ref when production is ready. The audited
ref was `78c79989bf94bbac78bb3c2badd16dc9074394a6`; later additive fixes must use
their own exact revision. Do not upload the held strict-source checkout.

## Ordinary production CLI path

Use a clean source checkout at the frozen additive revision, with no local
runtime/evidence artifact tree. Invoke the CLI from that repository root. The
existing Aomni API project has remote root `apps/api`, so its build loads
`apps/api/vercel.json` and runs the existing API-owned rail.

The installed CLI prefers explicit project environment IDs over local links;
pin the already inspected destination using those nonsecret IDs. Pin the same
source SHA separately for the remote build and the deployed function. The
[CLI documentation](https://vercel.com/docs/cli/deploy#build-env) distinguishes
build-time variables from [runtime variables](https://vercel.com/docs/cli/deploy#env).

Proposed invocation after the checkout has been frozen and reviewed:

```sh
ADDITIVE_CHECKOUT=/private/tmp/unified-duet-additive-api
ADDITIVE_REVISION=$(git -C "$ADDITIVE_CHECKOUT" rev-parse HEAD)

VERCEL_ORG_ID=team_I18zdvAznXXwqq1PcIampT1t \
VERCEL_PROJECT_ID=prj_XNhS93vciHGDEc8dZBHg2q4Kzo5o \
vercel deploy "$ADDITIVE_CHECKOUT" --scope aomni --prod --yes \
  --build-env "VERCEL_GIT_COMMIT_SHA=$ADDITIVE_REVISION" \
  --env "VERCEL_GIT_COMMIT_SHA=$ADDITIVE_REVISION"
```

Check that the checkout revision equals the frozen additive revision and that
tracked/untracked source changes are absent before executing. Do not use
`--prebuilt`: ordinary remote construction remains the release owner. The
Production project already has `CONVEX_DEPLOY_KEY`; its value was not read.
The rail publishes seed content and builds against the currently deployed
backend, then pushes compatible backend functions before API promotion.
No push to `main` occurs, so the GitHub npm-publication workflow is not triggered.

The source git branch and deployment metadata must remain honest. Current CLI
git metadata records the checkout's commit SHA, ref and dirty state; custom
`--meta githubCommitSha` is not a verified producer of runtime environment
variables. No fake `main` metadata or manual branch alias is needed for `--prod`.

The API's `/deployment` reads the SHA at runtime; the Convex rail bakes the build
SHA into source. Acceptance therefore requires the returned API revision and
backend revision both equal the frozen source SHA, on the immutable deployment
URL and production domain. CLI argument support is proved; an actual remote
runtime result has not been observed by this audit. The same probe binds the
served runtime manifest, which owns the image input and subsequent VM updates.

The uploader reads `.vercelignore`, not `.gitignore`. After this audit, root
`62ab80a60` added the missing `artifacts` exclusion to that existing owner and
proved the actual CLI upload closure contains no operational files. The
[upload-only receipt](../release-integration/deployment-upload-exclusion.json)
owns that proof. Carry the exclusion into the frozen additive source; verify
the selected source's ordinary CLI file-only dry inspection before upload.

## Two runtime activations

Wait for each required VM to run the first ordinary runtime R1 and certify it
healthy before the final cleanup release R2. At that point R1 is current, but
the held runtime can still be previous. The existing manager chooses a verified
current as the next previous and retains only that pair. A second distinct
activation therefore makes R2 current and R1 previous, retiring the held runtime.
If R2 fails probation, the retained complete R1 remains the rollback target.

API/schema revisions do not themselves change runtime identity. The constructor
hashes artifact content, modes and lengths; an identical desired runtime is a
no-op. Compare the actual served R1/R2 inventories and require distinct versions
before claiming retirement. An API-only cleanup with identical artifacts cannot
rotate the previous link. Verify the running R2 identity, certified boot state,
matched current/previous manifests and absence of the held release directory.
No manual link rewrite, provider restart, resize or reprovision is part of this
sequence. Ordinary activation waits for idle gateway work.

Existing row migrations and refreshed complete censuses still precede strict
schema deployment. R1 certification is an additional runtime settlement fact;
it does not substitute for the database predicates. Staging can finish strict
source while production's old API uses the independently preserved held payload.

[Audit evidence](receipt.json) records the installed sources and read-only project
observations. Remote build success, actual runtime env precedence and production
domain assignment remain ordinary deployment observations, not local proof.
