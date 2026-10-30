# Minimal desktop image probe

Date: 2026-08-12

## Verdict

Kill Gate 1 passes in the image verifier: the final amd64 image starts
authenticated KasmVNC on loopback, draws a non-uniform XFCE desktop, and reports
exactly 1440x900. The exe.dev cold-start leg is not measured because no remotely
pullable probe image was authorized; the attempted unique GHCR push was blocked
before any bytes left the machine.

## Local image evidence

- Image: `duet-vm-image:local`
- Image OCI index: `sha256:ada78e75a3ded743670ac832bdf9d2c47a860f6c7afe957513901e204fcb473d`
- Linux/amd64 image manifest: `sha256:dc12e793d6b7e20c72560484ada622240f97434f77b1af2fb47c8f5df53f7f42`
- Base OCI index: `sha256:8f6af869515701935fe1f3a836cfef2a8815136430e9989f6daf0ae3b3c647a1`
- Base linux/amd64 manifest: `sha256:77b1187c8329a8c38f6f02ccf3d0f1fdf75262d2f1017d2e321140409ef215d1`
- Image content size: 2,284,415,085 bytes (2,178.6 MiB)
- Base content size: 1,550,915,426 bytes (1,479.1 MiB)
- Desktop image delta: 733,499,659 bytes (699.5 MiB)
- Docker Desktop disk-usage estimate: 9.25 GB image vs 6.07 GB base
- KasmVNC start to rendered framebuffer under amd64-on-arm64 emulation: 10,662 ms
- HTTP: authenticated `200`; unauthenticated `401`
- X display: `1440x900 pixels`
- Xvnc: `-interface 192.0.2.1`, `-DLP_ClipSendMax 16777216`, and
  `-DLP_ClipAcceptMax 16777216`
- Framebuffer: 589,060 bytes, SHA-256
  `6f0c43b721bc624c93a89a01bb92f00f3ad12a9e52e09b1906b3b2cb95c6ea35`
- Leak check after the blocked remote leg: no `duet-test-*` VMs exist

An unprimed screenshot critique accepted the PNG as clear nonblank 1440x900
XFCE evidence: full-frame sharp wallpaper, readable Home and File System icons,
and no clipping or corruption. Its limitation is intentional at this slice: no
panel, application window, or cursor appears, so the shot alone does not prove
input or application launching; those remain the ingress/browser kill gates.

Comparison telemetry against the earlier decorated Chrome probe reported a
`0.69056` parity distance. The large difference is expected rather than a
regression: this checkpoint is the bare desktop before the browser, panel, dock,
theme, and fonts land in later slices.

Docker's content-size values are the local `.Size` values for the exact amd64
refs above. They are comparable on this Docker Desktop containerd store, but
they are neither registry transfer size nor live disk use inside an exe.dev VM.
The 10,662 ms render number includes Rosetta emulation and is not a substitute
for the still-unknown native exe.dev cold start.

## Remote leg

No VM was created. Run the package-owned `probe:desktop-stack` command with an
authorized, immutable, remotely pullable `IMAGE_REF`; it creates exactly one
`duet-test-desktop-stack-*` VM tagged `duet-probe`, captures the native timings
and framebuffer, deletes that exact VM, performs the fleet leak check, and
writes durable artifacts under `packages/exe/probe-results/reports/`.
