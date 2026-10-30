# Managed VM image rehearsal

The image consumes a frozen output from the API's full runtime constructor and
the matching stable bootstrap. The receipt identifies the exact local image and
input bytes; it is a rehearsal, not a published image or a live VM rollout.
The final provisioning candidate must be built from strict source after the
transition wire fields are removed.

`verification.txt.gz` is the successful complete image gate: separate gateway
and workspace Bun versions, stream garbage collection, installed tools,
LibreOffice conversions, full runtime bootstrap, real registration against
controlled old/new API responses, sustained boot certification, delivered model
credentials, CLI RPC continuation, semantic memory reopen, image resize, grep,
native terminal initialization, shared Chrome desktop, and Syncthing. The CLI
probe uses only the delivered fixture model key; no real provider is contacted.

`build.txt.gz` preserves the image construction and the first verification
attempt. That attempt hit the existing 45-second memory timeout while a separate
first-boot probe was also running. The successful sequential rerun kept that
budget. `stage-inventory-red.txt.gz` records removal of the Photon asset from
staging; `missing-model-credentials-red.txt.gz` records a real registration
response that omits the model credential and fails receipt verification.

Independent review found five integration defects in the delegate checkout's
borrowed contract versus its older gateway source: outgoing sync serialization,
runtime reporting, desired-state acceptance, registration reporting, and health
reporting. Root's runtime join owns and fixes these paths. The supplied root
payload passed the actual image probes. The image's default constructor path
must be verified on that joined source before final publication.

The framebuffer is compared to the approved same-viewport desktop capture in
`specs/done/vm-desktop/assets/kasmvnc-slice08-desktop.png`. The difference is
confined to the clock and the right side of Chrome's new-tab header; the layout,
wallpaper, browser geometry and dock composition are unchanged. Pixel metrics
locate that difference; unprimed visual critique remains separately required.

No GHCR push, digest promotion, secret update, provisioning reference change,
paid VM creation, or existing VM mutation occurred in this pass.
