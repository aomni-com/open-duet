# Repo-owned public CLI publisher

The [release script](../../../../../../packages/duet/scripts/release-public-cli.ts)
consumes the public builder's staged directory. An npm version is immutable:
only a verified registry E404 permits publication, and an existing version skips.
Authentication or service errors fail the attempt. Local invocation defaults to
npm's dry-run; the [main-push workflow](../../../../../../.github/workflows/public-cli-release.yml)
uses explicit publication after the existing external native packaging gate.
API and VM delivery have no dependency on this publisher or public CLI version.

The source repository is private, so token-based publication explicitly disables
provenance. npm requires a public source repository for provenance statements;
this does not change the existing package identity or native package ownership.
See [npm's provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).

[The fixture test](../../../../../../packages/duet/test/public-cli-release.test.ts)
uses actual npm against an ephemeral HTTP registry, including a real publish and
fresh external install. Run it through the existing owning container rail:

```sh
bash scripts/agent-tests.sh duet test/public-cli-release.test.ts
```

The rail must supply Node24/npm11 and Bun1.3.14. Missing npm in Docker fails the
prerequisite rather than skipping coverage. The [receipt](receipt.json) and
compressed logs distinguish local registry writes from the public-registry
read-only dry-run. The retained native winner has the same tarball hash under
npm pack. These results do not claim a composed CLI release, an authenticated
public publication, old-writer retirement, or duetfs registry deprecation.

A failed attempt clears its prior receipt. Publication succeeds only after
registry integrity and a fresh install's CLI version match the packed artifact.
GitHub and npm credentials are supplied by the existing release rails; neither
the package nor evidence contains credential values.

Before an actual new-version npm write, the publisher waits for the public
production deployment identity's API and backend revisions to match the Git
revision being released. The readiness check projects those canonical fields
from the shared deployment schema, so unrelated transport identity fields do
not become publication prerequisites. It stops after a bounded deployment wait.
Missing release revision, a stale backend, malformed identity, or unavailable
HTTP cannot produce an npm write or a success receipt. No workspace credentials
or additional deployment job are needed.

[Readiness and stock staging evidence](readiness/receipt.json) records the
existing owning-container gate, controlled failure/recovery cases and an
anonymous production deployment read.
