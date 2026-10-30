# Open Duet

Duet is an AI workspace where agents have a computer, a browser, persistent
memory, and shared files. They can research, write, work in connected apps,
generate images and video, and publish the tools they build. You can work with
them in the web app or connect your own agents through the CLI, REST API, and MCP.

This repository contains the platform's source: the agent runtime and CLI,
web app, backend, workspace VM tooling, and public website. It is released under
the [MIT License](LICENSE).

## What you can build with it

- **Agents that keep their context.** Instructions, skills, memory, and files
  persist between sessions and can be shared across a workspace.
- **Work that runs beyond a chat.** Agents use a browser, run commands, connect
  to external tools, and work on schedules or in response to events.
- **One interface to models and services.** A shared gateway connects text,
  image, video, and voice models alongside research and data providers.
- **A workspace for people and agents.** Shared files, conversations, hosted
  apps, and access controls live together rather than in separate tools.

## Getting started

### Requirements

- [Bun](https://bun.sh) 1.3.14
- Node.js 22.20 or newer
- Docker for the container-based test and visual workflows

### Setup

```sh
git clone https://github.com/aomni-com/open-duet.git
cd open-duet
bun install
```

From here, choose the part of the system you want to work on:

- [CLI and local agents](packages/duet/README.md)
- [Agent runtime and memory](packages/agent/README.md)
- [Web application](apps/web/README.md)
- [Backend](packages/backend/README.md)
- [Public website](apps/lander/README.md)

Each workspace's README explains its boundaries; its `package.json` owns the
available commands. You can read and modify individual components without
deploying the whole platform.

### Running your own deployment

The hosted Duet service and this source release are separate. Installing the
dependencies does not provision a working cloud deployment: you will need your
own Convex project, authentication configuration, provider credentials, and
workspace VM infrastructure. Features such as billing and email also need their
corresponding services.

Start with the [backend](packages/backend/README.md),
[API](apps/api/README.md), and [VM image](packages/vm-image/README.md) docs.
The source retains hosted-service defaults, domains, and operational scripts;
configure them for your infrastructure before using deployment or release
commands. In particular, the backend's `setup` shortcut selects the original
Convex project, so configure your own project with the Convex CLI instead.

### Secrets & environment

All `.env*` files and private deployment credentials are excluded from this
repository. Supply your own configuration; keep environment files out of source
control.

Service defaults live in each package's `config.ts`, with environment overrides.
The development command loads `.env.local` and `.env.staging`; deployment tooling
uses [dotenvx](https://dotenvx.com)-encrypted `.env.staging` / `.env.production`
files with private keys in `.env.keys`. The
[secret topology](scripts/secret-topology.mjs) describes which credentials each
service consumes, and the [secrets editor](tools/secrets-editor/server.ts) owns
the local editing UI.

## Repository guide

This is a TypeScript monorepo using Bun workspaces and Turborepo. The web app
consumes the public API; Convex owns metadata and policy; the workspace gateway
owns access to files and running processes on each VM. The agent runtime is
shared by local CLI sessions and managed workspaces.

### Applications

- [api](apps/api/README.md) — REST API and runtime release delivery
- [web](apps/web/README.md) — product UI and browser authentication
- [mcp](apps/mcp/README.md) — hosted MCP interface
- [model-gateway](apps/model-gateway/README.md) — model-provider proxy
- [edge](apps/edge/README.md) — public apps and published-file routing
- [lander](apps/lander/README.md) — marketing, blog, and campaign pages
- [docs](apps/docs/README.md) — developer documentation site

### Core packages

- [agent](packages/agent/README.md) — agent execution, memory, and protocol
- [duet](packages/duet/README.md) — CLI, terminal UI, and distribution
- [backend](packages/backend/README.md) — Convex state, identity, and policy
- [contract](packages/contract/README.md) — shared API shapes and capabilities
- [gateway](packages/gateway/README.md) — workspace VM runtime and file access
- [vm-image](packages/vm-image/README.md) — workspace operating-system image
- [exe](packages/exe/README.md) — exe.dev provisioning and infrastructure probes
- [sync-tunnel](packages/sync-tunnel/README.md) — file-sync transport
- [importers](packages/importers/README.md) — conversation import formats
- [service-catalog](packages/service-catalog/README.md) — provider routes and pricing

### Content, UI, and tooling

- [ui](packages/ui/README.md), [tailwind-config](packages/tailwind-config/README.md),
  and [typescript-config](packages/typescript-config/README.md) — shared UI and build configuration
- [web-locale](packages/web-locale/README.md) — locale and browser analytics policy
- [email](packages/email/README.md) — transactional email rendering
- [seed-drive](packages/seed-drive/README.md),
  [official-agents-seed](packages/official-agents-seed/README.md), and
  [skills-registry](packages/skills-registry/README.md) — starter content and agent skills
- [test-harness](packages/test-harness/README.md) and
  [fake-oauth-issuer](packages/fake-oauth-issuer/README.md) — integration fixtures
- [syncthing-darwin-arm64](packages/syncthing-darwin-arm64/README.md) and
  [syncthing-darwin-x64](packages/syncthing-darwin-x64/README.md) — macOS file-sync binaries

The [security model](SECURITY.md) explains the platform's trust boundaries.
[Specs](specs/README.md) hold design rationale and implementation plans;
[positioning](positioning.md) explains the product's intended audience.

## Development

### Common commands

```sh
bun run dev           # start configured development services
bun run build         # build the workspaces
bun run check-types   # check TypeScript
bun run lint          # lint source
bun run format        # format source
```

Prefer the owning workspace's commands while iterating. For example,
`bun run --cwd apps/lander check-types` checks the public site without checking
every service. Root commands and workspace scripts are defined in
[package.json](package.json).

### Tests

Run the smallest relevant test first, then broaden coverage as needed.
`bun run test` is the full repository gate: some suites start real local Convex
deployments, and others use Docker, so it is much more expensive than a focused
check. Live staging journeys require separately configured infrastructure and
credentials. The [test harness](packages/test-harness/README.md) explains the
integration and staging workflows.

Visual changes have a Docker-based screenshot gate and component playgrounds;
see the [UI playground workflow](.agents/skills/ui-playground/SKILL.md).
Contributor and coding-agent conventions live in [AGENTS.md](AGENTS.md).

### Deployment (Vercel)

Each application deploys separately. The API build is the sole owner of backend
publication and shared runtime delivery; the other applications build their own
artifacts. This ordering prevents competing writers and keeps the API compatible
with the backend during promotion. The
[deployment rail](scripts/vercel-deploy-rail.mjs) owns that orchestration, with
backend details in the [backend README](packages/backend/README.md).

Vercel's function builder uses a different TypeScript environment from ordinary
checks. The function apps' explicit compiler settings and streaming exports are
deployment requirements; their own configuration files explain the constraints.
Environment fanout is a separate operation, and Vercel environment changes take
effect on the next deployment.

## Agent setup

The [Duet skill](skills/duet/SKILL.md) teaches coding agents how to install and
use the CLI. To install it for Codex or Claude Code:

```sh
npx --yes skills@1.7.0 add https://github.com/aomni-com/open-duet/tree/main/skills/duet \
  --skill duet --agent codex claude-code --global --yes
```

Select the agents you use; omit `--global` for a project-local installation.
The skill's [installation reference](skills/duet/references/installation.md)
owns runtime requirements, CLI installation, and login. Its default connection
is the hosted Duet service; see the [CLI docs](packages/duet/README.md) when
configuring another deployment.

## Contributing

Issues and pull requests are welcome. For a substantial change, describe the
problem and proposed approach in an issue first. Keep changes focused, follow
the owning workspace's conventions, and include the checks relevant to the
behavior you changed. Do not include credentials or environment files.

## License

[MIT](LICENSE). Third-party components retain their accompanying licenses and
notices, including Syncthing's MPL-2.0 license.
