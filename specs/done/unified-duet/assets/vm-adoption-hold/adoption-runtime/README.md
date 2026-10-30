# Frozen adoption runtime

This is the held transition payload for the existing fleet. Its native gate runs
both the physical executable and `current/duet` against controlled local provider
responses in a disposable Linux container. The payload includes its own memory
and image-processing assets; neither execution mode relies on a checkout or an
npm installation. The manifest and receipt bind the exact constructed bytes.

The observed live old unit uses workspace Bun for the gateway. Alignment stages
the image-owned gateway Bun separately, preserving workspace Bun. That boot owner
is outside the application manifest, just as in the image; it is not a second
application updater.

The receipts prove the target payload. The full old-gateway service transition,
restoration, unchanged boot identity and live fleet outcomes remain separate gates.
