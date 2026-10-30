import { SIGN_IN_CODE_TTL_SECONDS } from '@repo/contract'

import { productHref } from './config/origins'
import type { SiteConfig } from './site-config'

/**
 * The one step that is not a door. It sits above the fork because both doors
 * use the CLI — door A to sign in, door B to check the key afterwards — and a
 * door that ends by running the other door's first command is not its equal.
 */
export function cliInstallBlock(): string {
  return [
    '# Bun 1.3.14 and Node 22+ required.',
    '# Install on your own computer.',
    '# Duet VMs include the command.',
    'npm i -g @duetso/agent',
  ].join('\n')
}

/**
 * Door A. The human has a browser in front of them, so the approval happens
 * there and the CLI never handles an address.
 */
export function devicePairingBlock(config: SiteConfig): string {
  return [
    '# 1. Start device pairing. A human must approve the displayed code in the browser.',
    `duet --api-url ${config.apiBaseUrl} login`,
    '',
    '# 2. Inspect your current workspaces and roles. The key stays in ~/.duet/config.json.',
    'duet whoami',
  ].join('\n')
}

/**
 * Door B. Possession of the mailbox is the proof, and the human reads a code
 * back instead of clicking one — no browser anywhere in the loop.
 *
 * The exchange runs inside node rather than as a bare `curl` because the
 * response body carries the API key: piping it to a terminal would print a
 * bearer credential that belongs in the saved configuration, not the transcript.
 *
 * It ends on `duet whoami` because a path that stops at a `console.log`
 * offers no way to check it worked. Every line beyond door A's is a line
 * `duet login` would have run for you, so anything that can leave does — the
 * rest is the named follow-up's to remove, not prose's to excuse.
 *
 * Step 1 assigns and then exports on a separate line rather than
 * `export VAR=$(…)`: `export` always exits 0, so the one-liner would swallow
 * a failed `start` and leave step 2 posting an undefined request id.
 */
export function emailSignInBlock(config: SiteConfig): string {
  return [
    "# 1. Mail a sign-in code to your human's address, keeping the 202's request_id.",
    `DUET_API_URL="${config.apiBaseUrl}"`,
    'DUET_REQUEST_ID=$(curl -fsS -X POST \\',
    '  "$DUET_API_URL/v1/auth/email/start" \\',
    "  -H 'content-type: application/json' \\",
    "  -d '{",
    '    "email":"human@example.com",',
    '    "client_name":"Claude Code"',
    "  }' \\",
    "  | node -pe 'JSON.parse(",
    '      require("fs").readFileSync(',
    '        0, "utf8",',
    '      ),',
    "    ).request_id')",
    'export DUET_REQUEST_ID',
    '',
    '# 2. Exchange the code your human read back. Same shell as step 1, whose export it reads.',
    `DUET_API_URL="${config.apiBaseUrl}" DUET_CODE="<the code they read back>" \\`,
    "node --input-type=module <<'NODE'",
    'import {',
    '  chmodSync, existsSync, mkdirSync,',
    '  readFileSync, writeFileSync,',
    '} from "node:fs";',
    'import { join } from "node:path";',
    'const {',
    '  DUET_API_URL: apiUrl,',
    '  DUET_REQUEST_ID, DUET_CODE,',
    '} = process.env;',
    'const response = await fetch(',
    '  `${apiUrl}/v1/auth/email/verify`, {',
    '  method: "POST",',
    '  headers: { "content-type": "application/json" },',
    '  body: JSON.stringify({',
    '    request_id: DUET_REQUEST_ID,',
    '    code: DUET_CODE,',
    '  }),',
    '});',
    'const body = await response.json();',
    'if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body)}`);',
    'const duetDir = join(process.env.HOME, ".duet");',
    'mkdirSync(duetDir, { recursive: true, mode: 0o700 });',
    'const outPath = join(duetDir, "config.json");',
    'const config = existsSync(outPath)',
    '  ? JSON.parse(readFileSync(',
    '      outPath, "utf8",',
    '    ))',
    '  : {};',
    'Object.assign(config, {',
    '  apiKey: body.access_token,',
    '  defaultWorkspace:',
    '    body.workspace.slug,',
    '  apiUrl,',
    '});',
    'writeFileSync(',
    '  outPath,',
    '  JSON.stringify(config, null, 2)',
    '    + "\\n",',
    '  { mode: 0o600 },',
    ');',
    'chmodSync(outPath, 0o600);',
    'console.log(`Signed in to ${body.workspace.slug}. Wrote ${outPath}; key not printed.`);',
    'NODE',
    '',
    '# 3. Inspect your current workspaces and roles.',
    'duet whoami',
  ].join('\n')
}

/**
 * The step both doors converge on. It reads the key the door already wrote, so
 * it is written once rather than duplicated per door.
 */
export function mcpConfigBlock(config: SiteConfig): string {
  return [
    '# Prepare a local MCP config without printing the bearer token.',
    `DUET_MCP_PUBLIC_URL="${config.mcpUrl}" node <<'NODE'`,
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const duetDir = path.join(process.env.HOME, ".duet");',
    'const cfg = JSON.parse(',
    '  fs.readFileSync(',
    '    path.join(duetDir, "config.json"),',
    '    "utf8",',
    '  ),',
    ');',
    'if (typeof cfg.apiKey !== "string" || cfg.apiKey.length === 0) throw new Error("Sign in first.");',
    'const outPath = path.join(duetDir, "mcp.json");',
    'fs.writeFileSync(',
    '  outPath,',
    '  JSON.stringify(',
    '    {',
    '      name: "duet",',
    '      transport: "streamable-http",',
    '      url: process.env.DUET_MCP_PUBLIC_URL,',
    '      headers: { authorization: `Bearer ${cfg.apiKey}` },',
    '    },',
    '    null,',
    '    2,',
    '  ) + "\\n",',
    '  { mode: 0o600 },',
    ');',
    'fs.chmodSync(outPath, 0o600);',
    'console.log(`Wrote ${outPath}. Import it into your MCP client; bearer token not printed.`);',
    'NODE',
  ].join('\n')
}

export function agentInstallText(config: SiteConfig): string {
  return [
    '# Duet agent install',
    '',
    'Purpose: connect this coding agent to Duet, an API-first shared cloud drive. One Duet workspace maps to one always-on VM. The VM disk is the drive and source of truth. Agents use duet for files, memory, workspaces, and sign-in; MCP clients use the hosted Streamable HTTP server.',
    '',
    'There are two front doors and they are equal. Pick the one that matches the human you are working with:',
    '- Door A, device pairing: they can open a browser, and approve a code you show them.',
    '- Door B, email sign-in: they can read their email, and read a code back to you out of it.',
    '',
    'Both doors return a human identity key, saved at `~/.duet/config.json`, mode 0600. Current membership and role determine workspace access. The same saved login works for CLI commands and Mac sync. Then run the shared MCP step once.',
    '',
    `Never print the key. Keep it out of transcripts, logs and source. Manage it at ${productHref('/settings/api-keys')} or through the user API-key endpoints.`,
    '',
    '## Sign in: pick a door',
    '',
    'First the CLI, which both doors end up using — door A signs in with it, door B checks its key with it:',
    '',
    '```sh',
    cliInstallBlock(),
    '```',
    '',
    'Then take one of the two doors below. One of them, not both.',
    '',
    '### Door A: device pairing',
    '',
    'Take this one when your human can open a browser: they approve a code you show them.',
    '',
    '```sh',
    devicePairingBlock(config),
    '```',
    '',
    'Expected behavior:',
    '- `duet login` prints a user code and a verification URL.',
    '- The human opens that URL and approves the code.',
    '- The CLI polls until approval, then writes `~/.duet/config.json` with mode 0600.',
    '',
    '### Door B: email sign-in',
    '',
    'Take this one when your human can read their email: Duet mails them an eight-character code, they read it back to you, and you exchange it for the key.',
    '',
    '```sh',
    emailSignInBlock(config),
    '```',
    '',
    'Expected behavior:',
    `- \`POST /v1/auth/email/start\` answers 202 with \`{"request_id":"req_…","expires_in":${SIGN_IN_CODE_TTL_SECONDS}}\`. The answer is byte-identical whether or not that address already has an account: it proves possession of the mailbox and says nothing about who owns it.`,
    '- The code is `XXXX-XXXX`, upper-case letters and digits, read by a human out of an email Duet sent them.',
    '- `POST /v1/auth/email/verify` settles the account and the workspace, and answers with `access_token`, `prefix`, `scopes`, `workspace`, and `created`.',
    '- On a first sign-up, add `name` and `workspace_name` to the verify body. For a human who already has a workspace both are ignored, and nothing is renamed.',
    '- `409 workspace_ambiguous` lists the workspaces they belong to and does not consume the code. Ask which one, then call verify again with the same code plus `workspace_slug`.',
    '- `400 invalid_code` carries `attempts_remaining`; `410 expired` means start over from `start`; a 429 carries `retryAfterSeconds`.',
    '',
    '## Connect MCP, from whichever door you took',
    '',
    '```sh',
    mcpConfigBlock(config),
    '```',
    '',
    'MCP connection details:',
    `- URL: ${config.mcpUrl}`,
    '- Transport: Streamable HTTP',
    '- Header: Authorization: Bearer <apiKey from ~/.duet/config.json>',
    '- Local config helper: the block above writes `~/.duet/mcp.json` with mode 0600 and does not print the bearer token.',
    '',
    'Useful checks after either door:',
    '```sh',
    'duet whoami',
    'duet workspace ls --json',
    '```',
    '',
    '## Choose an operation target',
    '',
    'A workspace is an operation target, not a different login. Choose a default for remote commands with `duet workspace use <slug>`, or pass an explicit workspace address such as `demo:/notes.txt`.',
    'Local prompts, memory and training stay local. Add `--workspace <slug>` to memory or training to run the remote operation; a saved default does not change execution mode.',
    '',
    '```sh',
    'duet memory recall "project notes" --workspace demo',
    'duet sync install',
    '```',
    '',
    'Mac sync uses the same saved login and a separate non-secret computer identity. Its engine ships for both supported Mac architectures; it mirrors workspaces where your current role permits writing.',
    '',
  ].join('\n')
}
