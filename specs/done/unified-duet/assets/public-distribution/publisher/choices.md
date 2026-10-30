# Publication choices

The public package remains `@duetso/agent`; its executable remains `duet`.
The workspace manifest is a development input, and the existing public package
builder is the sole staging owner. Publication consumes that staged directory
and checks the actual packed manifest and entry before npm receives its tarball.
Native package platform selection stays with the already verified native owners.

Main promotion already owns the production app release, so main push owns the
public CLI publisher too. Public version absence is the release decision; a
version tag or second manual release process adds no useful state. Serializing
publisher jobs prevents two main pushes racing to claim the same version.
An existing immutable version skips; service/authentication failures stop.

Token authentication reuses the existing publishing model. npm provenance is
explicitly disabled because the source repository is private, as required by
[npm's provenance documentation](https://docs.npmjs.com/generating-provenance-statements/).
The workflow requires the destination repo's npm credential before live release.
No old publisher or npm deprecation is changed by this local tooling pass.

A release receipt belongs to one attempt. Removing the previous receipt before
starting prevents a failed retry reporting a stale success. Published success
requires registry tarball integrity plus a fresh install's reported CLI version;
the full native runtime contract is earned by the existing pre-publication gate.

The main-push npm job and Vercel promotion can run concurrently. The existing
public deployment identity reports both API code and the backend code actually
deployed by the Vercel rail. Requiring both to match the release Git revision
prevents the new login CLI from reaching npm before its backend. The canonical
API origin and shared field schemas remain their existing owners. Revision and
backend identity are the only fields needed for this check; transport identity
remains independent. Local actual publication also requires the release Git
revision. Dry-run and already-published-version skip do not wait for promotion.
