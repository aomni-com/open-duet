# Public packaging tooling choices

## Publish a staged package directory

**When:** public packaging tooling pass.

**Decision:** the builder produces a public manifest and bundle in an output
directory. The repository's release entrypoint packs or publishes that directory.
The development workspace keeps its private dependencies for source development.

**Gap:** the requested single-repo release did not prescribe how to remove private
workspace references from npm output.

**Rationale:** the original tarball actually fails installation on `workspace:*`.
A separate output manifest fixes the distribution boundary without editing the
checkout during release or maintaining another installer. The CLI embeds only
its name/version metadata, rather than its development dependency manifest.

**Consequence:** publication must target the builder's output, not the workspace
root. Ordinary VM delivery remains independent of publishing this directory.

## Bundle JavaScript, preserve native package owners

**When:** public packaging tooling pass.

**Decision:** private workspace code and patched Pi JavaScript are bundled;
OpenTUI, PGlite, Photon and ripgrep remain exact-version npm dependencies.
The builder reads their versions from the frozen installed closure. Syncthing's
existing optional packages remain optional dependencies when the composed CLI
manifest declares them.

**Gap:** the user requested native behavior preservation but did not prescribe
which files to place inside the CLI tarball.

**Rationale:** the dependency packages already select platform binaries and own
file-relative assets. Inlining Photon's CJS code embeds its build directory; its
fallback searches beside Bun, not beside an npm-installed entry. Keeping these
owners external avoids a new native distribution system. Bundled packages carry
their available license/notice texts collected from the actual bundle graph;
installed native packages retain their own license files.

**Consequence:** Bun is an explicit prerequisite, native optional dependencies
must be installed, and npm installs platform files through their existing owners.
Macx64 selection is recorded separately from actual runtime execution.

## Register the SDK's bundled OAuth flows at the core registry

**When:** public packaging tooling pass, after actual installed `connect` failed.

**Decision:** the shared connected-provider registry calls the SDK's existing
Bun registration function. Its static imports retain the OAuth implementations
and the pinned refresh patch for CLI and gateway consumers.

**Gap:** source development resolved SDK-relative OAuth modules; published bundles
must also resolve those flows without their original module layout.

**Rationale:** the SDK intentionally hides flow imports from ordinary bundlers and
already exposes a registration API for standalone Bun consumers. Registering at
the shared flow owner fixes the missing module instead of adding pack-only paths,
copying an SDK tree, or installing an unpatched SDK from npm. Actual installed and
compiled CLI device login now reach the controlled issuer/model HTTP edge.

**Consequence:** the bundle includes the SDK OAuth flows. The existing owned
Codex refresh function is preserved in this pass; the separate upstream refresh
request fixture proves the retained SDK scope patch.

## Keep tooling evidence narrower than release completion

**When:** public packaging tooling pass.

**Decision:** native runtime and packing proof are a focused checkpoint. Unified
login/files/import/sync verification and registry publication remain root-owned
integration gates.

**Gap:** the independent tooling lane starts before the composed CLI is committed.

**Rationale:** installing the actual tarball proves the package boundary, but its
older source baseline cannot prove commands added concurrently elsewhere. This
keeps the evidence useful without treating a partial artifact as a shipped major
release.

**Consequence:** the final release reruns the same builder/tests with the composed
CLI, including Syncthing ownership and notice, before publishing.
