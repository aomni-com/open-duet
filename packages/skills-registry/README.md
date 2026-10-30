# @repo/skills-registry

This package is Duet's only owner of default skill content. It turns authored
skill files plus the approved-model catalog into the deterministic artifact that
the API may serve as bytes and the VM gateway may install; neither consumer owns
or edits the content.

## Boundary

`skills/` owns authored files. Code generation embeds those files into source so
deployment packaging cannot silently omit them. Rendering resolves the small set
of deployment placeholders and adds the media skill's generated model reference
through the catalog's `renderModelsReference` owner. Bundle construction then
validates paths, canonically orders and serializes the manifest, and hashes
exactly those UTF-8 bytes.

Media prose names stable roles. The generated reference is the only bundled map
from those roles to gateway slugs and access policy, so content must not copy
either into authored instructions.

The shared wire schema lives in [`@repo/contract`](../contract/README.md). Keep
cross-service validation there and keep skill bytes here.

Skills that depend on VM-local facilities name that dependency through the
image's machine-readable required-tools contract. In particular, the workspace
browser skill attaches to the already-running shared Chrome and selects the
gateway-issued target id; it never owns browser installation, profile creation,
or per-session tab allocation.

## Development

Use the scripts in `package.json` for code generation, tests, and type checking.
Generated source is checked in and must remain unchanged when code generation is
rerun without an authored-file change.
