# Mac sync CLI choices

## Publish a complete certificate pair atomically

When: slice 05 Mac sync integration.
Decision: Generate the Mac's stock Syncthing identity in a scratch directory, then atomically rename that directory into the canonical identity home. Concurrent first starts read the published winner. The unbuilt alternative generated directly in the final directory, allowing concurrent commands to write different certificates there.
Gap: One Mac-wide peer identity was fixed, but the first-start publication mechanism was unspecified.
Rationale: Foreground sync and installation can run as separate processes. An in-process mutex would not cover that real caller pair. Atomic directory publication uses the filesystem's existing primitive without a lock service, retry protocol, or second identity registry. The concurrent-start fixture and real two-instance peer check passed.
Consequence: A complete identity is reused; an incomplete existing identity produces an error rather than silently rotating the computer's peer. Every workspace keeps independent config/database state and copies this same certificate pair.

## Treat foreground sync as explicit activation

When: slice 05 Mac sync integration.
Decision: Both foreground `duet sync run` and `duet sync install` register the Mac through the account endpoint. Background daemon reconciliation never registers it. The unbuilt alternative required installation before foreground sync could work.
Gap: Installation was the named re-enable path, but foreground activation behavior was not specified.
Rationale: Running foreground sync is an explicit human request to turn file mirroring on. Reusing the existing idempotent registration endpoint avoids a second setup command or hidden daemon resurrection. The same peer and stored machine ID survive repeated activation and key replacement.
Consequence: An explicit foreground run can enable a previously removed Mac. Uninstalling only stops the local launch agent; it preserves the account machine, user login, and mirrored directories.

## Use the computer hostname as its initial display name

When: slice 05 Mac sync integration.
Decision: Register the OS hostname as the Mac's name. The unbuilt alternative added another naming prompt or command flag during setup.
Gap: The API requires a display name, without prescribing how the CLI obtains it.
Rationale: The existing host name identifies the computer without another setup step. Machine identity remains the Syncthing peer and backend machine ID, so display naming cannot change access or duplicate a machine.
Consequence: The account list shows that hostname. A future naming control can update display metadata without changing the identity contract.

## Distinguish whole-Mac removal from a workspace outage

When: slice 05 Mac sync integration.
Decision: Read the existing account machine collection during reconciliation, paging until the stored ID is found or the collection ends. Removed/missing account machines stop all their mirrors. A workspace 404 closes that failed mirror and uses ordinary backoff/reconciliation. The unbuilt alternative treated every mirror 404 as permanent removal of the Mac.
Gap: The existing mirror endpoint intentionally uses the same 404 for an unavailable VM and an unavailable machine.
Rationale: The account collection is already the metadata owner and exposes removal directly. Using it avoids inventing another registry, new route, or permanent peer ban. Tests show another live Mac cannot mask the target's removal, and one workspace outage leaves the other running and later recovers.
Consequence: Reconciliation performs the existing account lookup as well as whoami. A removed Mac waits for explicit account activation. Network failures preserve normal bounded retries; there is no new continuous token-validation service.

## Refresh the shared login for daemon requests

When: slice 05 Mac sync integration.
Decision: The long-running daemon reloads canonical CLI config and creates the ordinary HTTP client on requests, retaining explicit key, API-origin, and command overrides. The unbuilt alternatives captured the startup key indefinitely or added a generic credential-provider framework.
Gap: The one saved login was fixed, but a running daemon's response to later key replacement was unspecified.
Rationale: Ordinary CLI login can replace that same stored key while the daemon is running. A small request closure uses the existing config and HTTP owners directly; it needs no second save path, timer, or credential cache. The actual command-registry test fails with the old captured client and passes with the new key/origin and with explicit overrides.
Consequence: Key replacement does not change the Mac certificate or machine ID. Explicit registration rereads current config at save time and merges only machineId, preserving a login changed while the request was in flight.

## Close rejected tunnels and let reconciliation recover

When: slice 05 Mac sync integration.
Decision: Auth, permission, and not-found refusals during remint close the old bridge and surface to daemon polling; temporary network errors keep the existing retry cadence. The unbuilt alternative kept an old bridge alive after an admission refusal or stopped retries permanently.
Gap: The old bridge only retried failed remints, without distinguishing an admission refusal.
Rationale: A rejected remint is no longer a usable connection. Machine/membership metadata determines whether to stop globally or recover that workspace; the bridge must not invent a permanent account decision. Focused bridge and daemon tests pin closure plus workspace recovery.
Consequence: Failed workspace starts and polling release their resources, including the already-started Syncthing process on registration failure. The native probe confirms that failure's local API port is gone. Existing tunnel framing and token lifetime remain unchanged.

## Resolve explicit activation by current person and Mac peer

When: account/origin-switch review after the initial slice 05 pass.
Decision: Account registration accepts only `{name, syncthingDeviceId}`. The
backend upserts through the existing authenticated-user/peer index. This
supersedes the initial optional cached machineId input; the response ID and
workspace mirror/tunnel IDs remain.
Gap: The initial optional ID made ordinary account or control-plane switching
fail when canonical config still held the preceding account's server ID.
Rationale: The user and peer already determine the row, including a removed row
that explicit activation restores. The optional ID could not rotate a peer and
had no independent consumer. Deleting it removes the refusal path without
adding account metadata, cache invalidation, or another auth lookup.
Consequence: Same-user key replacement and explicit re-enable retain the same
machine ID. A new user or control plane returns that account's ID while reusing
the Mac certificate. Background reconciliation still cannot register or restore
a removed machine.
