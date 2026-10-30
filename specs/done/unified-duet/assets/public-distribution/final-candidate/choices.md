# External acceptance choices

## Preserve Pi's optional native clipboard owner

**When:** composed public CLI acceptance pass.

**Decision:** the public package keeps Pi's existing clipboard package as an
optional dependency at the installed frozen version. This extends the earlier
native-owner packaging decision to a dependency loaded dynamically. The main
alternative was leaving the lookup absent and accepting runtime downloads or
missing native behavior.

**Gap:** the original packaging inventory covered statically visible native
owners but did not name this dynamic optional lookup.

**Rationale:** its own npm package already owns platform selection and native
files. Retaining that owner preserves the SDK behavior without copying binaries,
changing the SDK or building another installer. It stays optional because the
upstream SDK deliberately tolerates an unavailable native clipboard.

**Consequence:** external installs acquire the matching native optional package
during installation. This adds no VM installer, runtime release artifact or
new version pin in the source lockfile.

## Exercise installed sync with a modeled launcher

**When:** composed public CLI acceptance pass.

**Decision:** the installed CLI uses actual stock Syncthing for certificate and
device identity generation, while a scratch executable models launchctl. The
alternative was installing a real login-time service on the developer's Mac.

**Gap:** the platform gate needed actual optional-engine behavior without
interfering with user services or taking desktop focus.

**Rationale:** the launcher is the external service boundary. Modeling it keeps
the real dispatch, credential, registration, identity and plist code under test
while avoiding a user-visible background service. Live transfer remains owned
by the dedicated staging journey.

**Consequence:** this acceptance snapshot proves initialization and preservation,
not OS login scheduling or live file convergence. Those claims require their own
operational evidence.
