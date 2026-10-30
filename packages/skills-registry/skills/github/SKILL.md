---
name: github
target: both
description: 'Interact with GitHub using the `gh` CLI. Use `gh issue`, `gh pr`, `gh run`, and `gh api` for issues, PRs, CI runs, and advanced queries.'
---

# GitHub Skill

Use the `gh` CLI to interact with GitHub. Always specify `--repo owner/repo` when not in a git directory, or use URLs directly.

## Authentication

Before using `gh`, check if you're already authenticated:

```bash
gh auth status
```

If not authenticated, ask the user which method they prefer:

1. **OAuth (default, recommended)** — `gh` opens a browser link and gives you a one-time code. The user pastes the code in the browser to complete login. Credentials are stored in `~/.config/gh`.
2. **Personal access token** — For power users who already have a token.

Always confirm the user's preference before proceeding. Default to OAuth if they have no preference.

OAuth login:

```bash
gh auth login --web
```

Token login (the user will be prompted to paste their token):

```bash
gh auth login --with-token
```

## Pull Requests

Check CI status on a PR:

```bash
gh pr checks 55 --repo owner/repo
```

List recent workflow runs:

```bash
gh run list --repo owner/repo --limit 10
```

View a run and see which steps failed:

```bash
gh run view <run-id> --repo owner/repo
```

View logs for failed steps only:

```bash
gh run view <run-id> --repo owner/repo --log-failed
```

## API for Advanced Queries

The `gh api` command is useful for accessing data not available through other subcommands.

Get PR with specific fields:

```bash
gh api repos/owner/repo/pulls/55 --jq '.title, .state, .user.login'
```

## JSON Output

Most commands support `--json` for structured output. You can use `--jq` to filter:

```bash
gh issue list --repo owner/repo --json number,title --jq '.[] | "\(.number): \(.title)"'
```
