---
name: env-vars
target: sandbox
description: Manage environment variables and API keys in the sandbox. Use when the user asks to set, update, or manage environment variables, API keys, secrets, or credentials, or when you need to configure API keys or secrets for tools, scripts, or services you are running.
---

# Environment Variables & API Keys

Environment variables in the sandbox are managed through a `.env` file located in the home directory:

```
~/.env
```

## How It Works

The `.env` file is automatically sourced into the environment for all processes running in the sandbox, including the gateway, runners, and any shell commands you execute. Any variables you add or change will be picked up automatically.

## Setting Environment Variables

Edit `~/.env` directly to add or update variables:

```bash
# Open the file for editing
echo 'MY_API_KEY=sk-abc123' >> ~/.env
```

Or use a more precise approach to avoid duplicates:

```bash
# Check if the variable already exists
grep -q '^MY_API_KEY=' ~/.env 2>/dev/null && \
  sed -i 's/^MY_API_KEY=.*/MY_API_KEY=sk-abc123/' ~/.env || \
  echo 'MY_API_KEY=sk-abc123' >> ~/.env
```

## Format

The file uses standard dotenv format — one `KEY=VALUE` pair per line:

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://user:pass@host:5432/db
MY_CUSTOM_VAR=some_value
```

- Comments (lines starting with `#`) and blank lines are preserved.
- Do not quote values unless quotes are part of the value itself.

## Loading Updated Variables

After editing `~/.env`, new shell sessions will pick up the changes automatically. To apply changes in the current shell session, source the file:

```bash
set -a && source ~/.env && set +a
```

## Pre-configured Variables

The following variables are pre-configured and available by default:

| Variable                | Description                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| `DUET_API_KEY`          | Workspace API key used by Duet services and the model gateway        |
| `DUET_API_URL`          | Base URL for Duet's public API and service proxies                   |
| `DUET_GATEWAY_BASE_URL` | Base URL for the workspace's Duet model gateway                      |
| `FIRECRAWL_API_URL`     | Firecrawl-compatible alias for Duet's Firecrawl service proxy        |
| `FIRECRAWL_API_KEY`     | Firecrawl-compatible alias whose value is the workspace Duet API key |

Do **not** remove or overwrite these variables. The gateway injects them into
runner processes and refreshes them as system-managed workspace credentials.

## Best Practices

- **Never hardcode secrets** in source files. Always store them in `~/.env` and read from the environment at runtime.
- **Use descriptive names** for variables, e.g. `STRIPE_SECRET_KEY` rather than `KEY`.
- **Check before overwriting** — read the existing `.env` to avoid accidentally removing other variables.
- When a user provides an API key, add it to `~/.env` so it persists across sessions.
