# Slice 07 staging image release

- Source commit: `d1035e328`
- Image: `ghcr.io/aomni-com/duet-vm-image@sha256:1d1dbcb4af6bd796ec28ba74fbea9f4c339717f9ca36bfa1d664d6e6f7731c93`
- Pinned Chrome: `151.0.7922.137-1`
- Build: `bun run build-image:staging`
- Exact-image verifier: PASS
- Extension policy id: `GENERATED_EXTENSION_ID`
- Desktop observation: fixed 1440x900 nonblank Kasm framebuffer; one `duet-browser`
  native window observed; extension update and CRX endpoints served from loopback.
- State/config: `.env.staging` records the immutable digest above.
- Config fanout: staging dry-run and apply were repeated for the final digest and
  completed with `79 set`, `7` optional values skipped, and `0` failures. The
  deploy rail is triggered only after this applied fanout so the API build consumes
  the new image ref.

The first feature build attempt exposed sandbox namespace failure while running the amd64
Chrome packer under arm64 emulation. The second proved the sandbox exception and
then correctly failed because the signing key was still inside the extension
payload. Commits `5e5115499` and `25460ea11` confined the no-sandbox flag to the
offline packer and moved the key outside the payload; the third build and verifier
passed before the image was pushed.

The live discard journey then proved that activating a keeper tab raises its
background Chrome window on the pinned image. Commit `cee4d71bd` restores the
previous foreground window after that discard transaction. A second live run
proved Chrome's delayed native event also restarted the discarded owner's cooling
grace even though the foreground stayed correct. Commit `d1035e328` ignores only
that serialized maintenance event while retaining the restored foreground event.
The image above is a fresh full rebuild containing both corrections; its verifier
passed before push and it supersedes the earlier `6357ed13…` and `687ab91a…`
candidates.

The matching staging API/web deploy completed and the focused live journey passed
on this digest; see [live acceptance](live-acceptance.md). Sixteen existing staging
VMs converged with state preservation. The final fleet dry-run still selects one
workspace whose archive exceeds Convex's hard 1 GiB single-file limit. Its old VM
and state were initially left untouched. The user subsequently confirmed the fleet
is prelaunch and authorized scratch reprovision for exact archive blockers. The
rail then recreated only that workspace without its old VM filesystem state, and
the final staging fleet dry-run reported no candidate.
