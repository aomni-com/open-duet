---
name: duet
description: Install and operate the Duet CLI on the user's own computer. Use to access remote Duet files, call upstream text, image, and video models, set up login, run local or workspace agents, manage workspace knowledge or Mac sync, and troubleshoot the CLI outside a Duet VM.
---

# Duet

Carry out the user's task with the released `duet` command on their computer.
It provides access to the user's remote Duet workspace files and a broad model
catalog across providers, including text, image, and video generation. Use
`duet model` for direct model calls through the same Duet login.
Use the installed CLI's help as the command contract. This skill is self-contained;
it does not require a Duet VM, repository checkout, or another Duet skill.

## Setup

Check `command -v duet`, `duet --version`, and `duet --help`. If the command or
runtime is missing, follow [installation](references/installation.md) to install
the published package and verify it. That reference also owns human login,
workspace selection, API-origin configuration, and upgrade recovery.

Authenticate when the task needs workspace access or Duet model billing. Reuse
a working login; otherwise run `duet login` and let the person approve the device
code in their browser. No VM-provided environment or credential is assumed.

## Workflow

### Services

Use the service catalog for paid third-party APIs without vendor keys:
`duet services search <need>`, `duet services show <id>`, then
`duet services call <id> <METHOD> <path>`. Read the vendor docs linked by
`show`; Duet injects authentication. Use `--out` for binary media and select a
workspace explicitly when the account has more than one.

For voiceover, use ElevenLabs through this catalog workflow rather than local
speech synthesis or `say`:

```sh
duet services search audio
duet services show elevenlabs
duet services call elevenlabs POST /v1/text-to-speech/CPEHCHnlRsWkpvhbDlfn \
  --body '{"text":"SCRIPT","model_id":"eleven_flash_v2_5"}' \
  --out voiceover.mp3
```

Confirm the MP3 exists and is non-empty after the call.

1. **Discover the command.** Read `duet --help` and relevant
   `duet <command> --help` output before operating. Some command groups return
   the shared top-level help. Use only advertised syntax; a missing command is
   not permission to run the user's prose as a bare agent prompt. Consult the
   [public docs](https://docs.duet.so/) for capability details when help is
   insufficient. If no CLI operation supports the task, state the gap and use
   the documented public API only when it fits the user's request.
2. **Choose execution and target explicitly.** Local agent prompts run on this
   computer in the selected working directory. `duet agent` controls remote
   workspace sessions. `duet memory` and `duet train` stay local unless
   `--workspace <slug>` selects remote mode. A saved default workspace selects
   remote targets and Duet model billing; it never moves a local prompt into
   the VM. Resolve workspace membership with `duet whoami --json` and
   `duet workspace ls --json`; use the intended slug rather than the first
   workspace returned.
3. **Operate through the CLI.** Use `--json` where the command advertises it,
   and inspect both the process exit status and returned result. For file
   operations, `workspace:/path` identifies a remote Drive path; the local
   operand of `push` or `pull` is a path on this computer. Slash-prefixed remote
   paths resolve against the selected default workspace. Keep an explicit
   address and `--workspace` consistent. Follow returned cursors for complete
   listings. `duet agent run` streams session events itself; consume that
   stream through its terminal result rather than treating session creation
   as completion.
4. **Verify the outcome.** Read back the affected file or workspace state, check
   the delivered local artifact, or inspect the terminal session result as
   appropriate. Report the actual target and result. Login success, session
   creation, and a started sync daemon are intermediate states.

For direct text, image or video generation, model discovery or MCP media tools,
read [models and media](references/models.md). It owns selection precedence,
compound/default behavior, output verification and paid retry handling.

## Common choices

Run local agent work in the user's intended project:

```sh
duet --workdir ./my-project "review this project"
```

Start workspace agent work remotely, using a slug discovered from the account:

```sh
duet agent run "summarize the workspace notes" --workspace acme --json
```

Read or download a remote file without starting an agent:

```sh
duet cat acme:/notes/today.md
duet pull acme:/reports/latest.md ./latest.md
```

### Call the model catalog directly

Read `duet model --help` and choose a current model ID for the requested
capability. This command calls a model directly; use it when the task needs
text, an image, or a video rather than an agent session. Select the intended
workspace for Duet model billing using the setup reference.

```sh
duet model -m <text-model-id> --type text "summarize these notes"
duet model -m <image-model-id> --type image -o illustration.png "a fox in snow"
duet model -m <video-model-id> --type video -o clip.mp4 "slow pan over dunes"
```

Replace the placeholders with supported model IDs from current help or the
gateway catalog. Check model-specific input and generation options before
using them; `--image` can supply vision context, an image-edit source, or a
still to animate when the selected model supports that operation. Text streams
to stdout; image and video calls write local files and print their paths.
Inspect the generated artifact before delivering it. A model-access or billing
error is a failed call, not proof that a file was generated.

### Mirror files on a Mac

For Mac mirroring, read [Sync to your Mac](https://docs.duet.so/sync) before
`duet sync install`. Sync is macOS-only, runs in the background, and transfers
workspace files in both directions; it is broader than a one-file `push` or
`pull`. Verify convergence with `duet sync status --json`. Installing the CLI
alone does not request mirroring.

## Failure and recovery

- On authentication failure, recheck the selected API origin and human login.
  On denied access, inspect current membership; another workspace's slug does
  not grant access. Never print saved credentials or read them into chat.
- On usage errors, return to installed help instead of guessing flags. On a
  version mismatch, inspect the advertised upgrade command before upgrading.
- After an ambiguous network failure during a write, inspect the destination
  before retrying. A disconnected stream does not prove remote work failed.
  Retain a returned session ID so the task can be followed or answered. If
  installed help has no command to inspect that session, consult the public
  session API docs; do not invent a CLI status or resume command.
- Prefer terminal results and fresh state to success messages. If login needs
  human approval or an operation remains pending, report that specific state.
