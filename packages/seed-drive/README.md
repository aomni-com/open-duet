# @repo/seed-drive

This package owns the starter drive given to each new Duet workspace. Its
`content/` directory is the drive tree verbatim: changing a file there changes
what the next workspace receives after the bundle is published.

## Boundary

Archive construction canonically sorts the authored tree beneath `drive/` and
zeros timestamps and ownership, so identical content produces identical tar
bytes and SHA-256 hashes. The app manifest stays outside the archive and uses
the shared `SeedAppRegistrationSchema`; backend publication and workspace birth
consume those two outputs in later slices.

## Development

Edit `content/`, run `bun run inspect` to review the exact archive entry list
and hash, then run `bun run publish` with a deployment-scoped Convex key to
publish the content-addressed bundle. Publication is idempotent by archive hash
and verifies the active storage bytes before succeeding; the API deployment rail
runs it before the Convex function push and API promotion. Its publication
interface must therefore remain compatible with the currently deployed backend.
Bundle changes affect newly created workspaces only.

The sample app can be previewed directly:

```bash
bun run content/welcome/hello-app/server.ts
```
