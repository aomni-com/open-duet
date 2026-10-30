# Duet CLI

This workspace composes the duet command: local agent work, terminal UI, and
workspace/file/sync operations under one login. The npm
identity remains @duetso/agent.

External agents use the [consumer skill](../../skills/duet/SKILL.md) to
install and operate the released command from their own computer. The root
[agent setup](../../README.md#agent-setup) owns skill installation.

Install Bun 1.3.14 and Node 22 or newer before installing the public command:

```sh
npm install -g @duetso/agent
duet login
```

The command runs on Bun; npm supplies the external package. `duet login` saves
one human credential for workspace commands and Mac sync. Use `duet workspace
use <slug>` to choose a default workspace and `duet --help` for the command surface.

Harness runtime and protocol ownership belong to the private
[agent workspace](../agent/README.md). The CLI consumes that owner directly;
it owns dispatch and user configuration. Local memory and training remain
local unless --workspace explicitly selects a remote operation. A saved default
selects remote operation targets and model billing; it never changes execution
mode. Explicit file addresses and workspace flags must agree.

Remote agent output reads the shared [session timeline](../contract/README.md)
contract. JSON preserves received events through the terminal marker; human
output renders the events it knows how to present.

`duet app credentials` manages external runtime keys for an already registered
app using the same saved human login or process-provided VM key. Workspace and
app selections are explicit. Normal export puts the new key alone on stdout and
deployment metadata on stderr; `--json` returns one response object. Capture the
secret in memory and pass it through stdin to the host's server-side secret store.
The command never saves exported keys or retries an ambiguous mint. Inspect the
live inventory and revoke unwanted entries before explicitly exporting again.
Rotation uses a second export, host deployment and verification, then revocation
of the prior credential. `duet app credentials --help` owns the command surface.

The saved human login and default API/workspace live in config.json. Other
provider keys remain in provider env files, and connected subscriptions keep
their own store. Login approval identifies the person; access follows current
workspace memberships. Mac mirroring has its own non-secret machine identity,
so removing a Mac does not revoke the login.

Public packaging must inline private workspace code and preserve native assets
and the Pi patch. npm is an external distribution channel. VM commands use the
managed runtime release, including interactive shell invocation.

Use the package scripts for builds, checks and focused disposable-container
tests. This CLI remains Bun-native. The root lockfile owns dependencies, and
the root repository owns publication and VM release delivery.

[Mac sync](src/sync/README.md) keeps one computer identity across separate
workspace transfer instances, with account removal independent of user login.
