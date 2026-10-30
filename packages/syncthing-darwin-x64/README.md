# @duetso/syncthing-darwin-x64

The stock Syncthing v2.1.2 macOS **x64** (amd64) binary, bundled as a platform
package for [`duet`](https://www.npmjs.com/package/@duetso/agent). You do not install
this directly — `duet` declares it in `optionalDependencies` with `os`/`cpu`
constraints, so npm installs only the package matching your machine.

The binary is unmodified and executed as a child process by `duet sync`. See
[NOTICE.md](./NOTICE.md) for licensing (MPL-2.0) and provenance.

Stock binary staging belongs to [Duet's staging script](../duet/scripts/stage-syncthing-packages.ts).
It verifies the pinned archive and executable before checking npm's packed files.
It does not publish or require republishing an existing pinned platform version
when the public Duet CLI changes.
