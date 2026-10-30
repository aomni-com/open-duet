# Third-party notice: Syncthing

`duet sync` runs **Syncthing**, the file-transfer engine, as an unmodified,
stock, official binary. Syncthing is not forked, patched, or statically linked
into duet — the pinned per-arch binaries ship in separate npm
`optionalDependencies` platform packages and are executed as a child process.

- Project: Syncthing — https://syncthing.net
- Source: https://github.com/syncthing/syncthing
- Pinned release: **v2.1.2** (must match the VM image pin in
  `packages/vm-image`; see `src/sync/binary.ts` `SYNCTHING_PIN`)
- License: **Mozilla Public License 2.0 (MPL-2.0)** —
  https://github.com/syncthing/syncthing/blob/main/LICENSE

The macOS binaries duet bundles are the upstream Developer-ID signed and
notarized releases, sha256-verified on resolve against the values recorded from
the official signed `sha256sum.txt.asc` for v2.1.2:

| Platform    | Archive sha256                                                     | Binary sha256                                                      |
| ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| macOS arm64 | `fa2002f320170b64f226ff65831ccec516b59d7bba365acb51731dd079e52d1a` | `0325655f864024e0eecd78df07bdedbad46cefc91f480503ff615b6211081869` |
| macOS x64   | `f04b3d7f1492457e929119b91561f0ddc6bada070f46b68bd2464cda04983424` | `24cd4219041087bf67a2773fe0aa8ad976b8e579b4768c31df365a58058f1743` |

Under MPL-2.0, the corresponding source is available at the URL above. This
notice is distributed with the duet package.
