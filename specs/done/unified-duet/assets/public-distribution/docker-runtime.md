# Public distribution Docker runtime prerequisite

The existing [agent-tests runner](../../../../../scripts/agent-tests.sh) uses one
cached [multi-stage Docker image](../../../../../scripts/agent-tests.Dockerfile).
Official Node supplies the actual npm executable; the exact Bun binary comes
from the existing official Bun image. Docker receives only the Dockerfile on
stdin, with no checkout build context. The returned image ID selects that exact
build even when other worktrees run tests concurrently. Docker owns cache
invalidation; no tag registry, host installer or second runner was added.

Node 24.14.0 is pinned together with its bundled npm 11.9.0, as recorded in the
[official Node release](https://nodejs.org/en/blog/release/v24.14.0). Bun stays
exactly 1.3.14. Image construction asserts all three versions and caches the
existing git prerequisite plus CA certificates. The runtime no longer performs
apt setup on every test call. The tested tools are:

```json
{"node":"v24.14.0","npm":"11.9.0","bun":"1.3.14","arch":"x64","platform":"linux","home":"/tmp/home","npmCache":"/tmp/home/synthetic-user"}
```

The original runner still owns package/mode selection, test arguments, complete
`test` and `src` coverage, eval/benchmark dispatch, the read-only source mount,
the disposable checkout, scratch HOME, shared Bun download cache and explicit
eval credential forwarding. Source env files remain excluded. This changes the
development verification image, with no VM deployment or package publication.

## Gates and limits

Source checkpoint: e8285fa0d. Publisher candidate 793b86c5d was cherry-picked as
9eda31960 solely for verification; it is excluded from this runner commit.
Temporary copied root files from prior passes were preserved separately, then
the managed checkout was aligned to the committed snapshot before this pass.

Red/green under write-tests: the unmodified Bun-only rail ran the publisher file
and all nine tests failed because actual npm was missing. With the new image,
all nine publisher cases and the public native tarball case pass: 10 tests,
61 assertions, no failures. These use an ephemeral local HTTP registry and real
npm pack/publish/install; no npmjs publication occurred. The public native test
also exercises the installed bundle's durable memory, RPC/tool/image paths,
patched subscription behavior and terminal render through its existing owner.

The narrow renderer/host-descriptor, PGlite query and TurnRunner process-reaper
probes pass: 4 tests, 6 assertions, no failures. This covers the native/glibc and
shared-process boundaries affected by the base-image change. A repeated build
shows cache hits for the runtime copy, prerequisite/version layer and workdir.
Shell syntax and diff checks pass. No full root suite, paid eval, live backend,
customer VM, host-global install or version/lockfile upgrade ran.

Review: shape remains one runner and one runtime recipe; no test assertion,
time budget, selected mode, default coverage or secret boundary changed. Image
build failures stop before test execution; subsequent calls use Docker's normal
cached recovery. Codex review under unchanged configured defaults ran and found
no actionable defects. Its Docker socket access was denied, so it only provides
static review; the executed gates above own runtime verification. The publisher
itself remains the other agent's scope. The parent owns joined closeout gates.

Exact transcripts are retained in the sibling compressed assets: red publisher,
green publisher/native, lifecycle probes, cached build and complete Codex review.
