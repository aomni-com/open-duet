# Install and connect the local CLI

## Runtime and released package

Check `node --version`, `npm --version`, and `bun --version`. Duet's published
package is `@duetso/agent`; it installs the executable named `duet`, not `duetfs`.
Check the current published runtime requirements before installing:

```sh
npm view @duetso/agent version engines --json
```

Use Node 22 or newer and the Bun version required by that response. If a runtime
is missing, use the machine's existing runtime manager when available, or the
official [Node](https://nodejs.org/en/download) and
[Bun](https://bun.sh/docs/installation) installation instructions. Install the
public release rather than building or installing this monorepo:

```sh
npm install -g @duetso/agent
duet --version
duet --help
```

If npm succeeded but `duet` is absent from PATH, check `npm prefix -g` and the
global executable directory for this operating system. Use a user-owned npm
prefix or runtime manager rather than retrying with `sudo`. If an existing
installation runs, inspect its version and reuse it unless an upgrade is needed
or requested. Use its advertised `duet upgrade` command for an upgrade.

## Human login and workspace selection

Workspace access and Duet model billing use the person's own account. Check an
existing login with `duet whoami --json`. If authentication is required, run:

```sh
duet login
```

Keep the process alive while the person approves the displayed code at the
verification URL. Use `duet login --no-browser` when automatic browser opening
is unavailable. The person signs in and approves; do not substitute a VM key or
ask them to paste a saved token. If the code expires, start a fresh login.

After approval, verify account access and choose the intended workspace:

```sh
duet whoami --json
duet workspace ls --json
duet workspace use <actual-workspace-slug>
duet workspace status --json
```

Replace the placeholder with a slug from the account. If the person belongs to
several workspaces and the task does not identify one, ask which to use. Do not
create a workspace merely to make setup pass. `workspace use` saves a default;
prefer `--workspace <slug>` for a one-off target when no default change is needed.

`~/.duet/config.json` stores the saved login, API origin, and default workspace.
Use CLI commands to manage it and never print its credentials. For staging or
a custom server, keep the same origin through login and later commands:
`--api-url <url>` overrides `DUET_API_URL`, which overrides the saved origin.
Production is `https://ctl.duet.so`; staging is `https://ctl-staging.duet.so`.
Reuse explicit user configuration rather than silently switching environments.

## Readiness

Version and help prove the executable runs. A successful `whoami` proves the
login, and workspace status proves the intended workspace is reachable. Local
agent work with another configured provider may not need a Duet login; inspect
`duet connect --help` and `duet env --help` for provider setup when needed.
Only perform the user's requested operation after the relevant checks pass.
