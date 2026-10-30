# Mac sync

A person uses the same saved login for sync and ordinary Duet commands. A Mac
has a separate, nonsecret account machine ID and one Syncthing certificate pair.
Explicit foreground sync or installation registers that peer under the current
user, without sending a cached server ID. Switching account or control plane
saves the new account’s returned machine ID while preserving the Mac certificate.
Background reconciliation only reads it. Removing the Mac stops its mirrors,
and explicit activation can enable the same peer again without changing the
person's key.

Mirrored files and Syncthing state use one storage key derived from the API origin
and durable workspace ID. Defaults live under `~/duet/<storage-key>`; `duet sync
status` shows the workspace name and actual directory. Changing login or machine
keeps those files when it reaches the same workspace. An unrelated workspace
with the same name gets a separate directory and engine state. Foreground sync
can explicitly select a transfer directory while its engine state remains scoped
to the workspace.

Each workspace still needs its own Syncthing configuration and database: every
VM uses the same whole-drive folder ID, and one Syncthing instance cannot map
that ID to several directories. The instances copy the Mac's shared certificate
before generating their configurations, so adding a workspace never creates
another account machine. Certificate publication uses an atomic directory
rename to keep concurrent first starts on the same peer.

The daemon follows the server's current writable memberships and account machine
state. Each reconciliation reads the saved login, API origin and machine ID
together, keeping explicit environment and command overrides. When any of them
changes, it stops the previous mirrors before starting the new account's mirrors;
tunnel renewal keeps the credentials that started that mirror. Temporary network
or workspace failures use the existing backoff; a rejected tunnel closes its
connection before reconciliation decides whether the workspace or the whole Mac
has stopped.

Syncthing owns file transfer, conflict copies, and resumption. Duet supervises
that engine and the shared tunnel transport. Uninstalling the launch agent stops
sync while preserving mirrored directories, account metadata, and user login.
The [stock engine notice](NOTICE-syncthing.md) documents its distribution.
