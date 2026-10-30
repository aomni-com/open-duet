# Externally hosted apps

When the user requests Vercel or another host, use that host's existing deployment
workflow. Finish Duet registration, credential export, host configuration and
deployment yourself with the available access. No human Duet key setup or extra
consent step is required: the workspace agent's bearer has `apps` authority.

## Keep a visible Duet identity

Inspect the app list and reuse its existing row. Put a small static `index.html`
in the app's tracking folder, keep its normal icon, and register it with the
ordinary static-server command from the main skill. Declare the capabilities the
external server actually needs, including `services` for models. Exports inherit
the app's full `apiScopes` and use ordinary Duet scope checks, just like its
managed key. They are bound to the app's workspace and cannot declare `admin`.
Keep the tracking folder and row when editing or redeploying. Preserve an existing
external source/deployment project; the tracking folder only needs its page and
icon, not a relocated server.

The page says **externally hosted**, what the app does, and links to its actual
deployed URL when known with `target="_blank" rel="noreferrer"`. Before the URL
exists, say deployment is pending and update the page afterwards. This is an
intentional inventory page; the publish-early warning against placeholders only
concerns pages made to hide a registration failure. The page never reads or
serves its injected managed key. The external app remains hosted by its chosen
provider; no Duet proxy or external app type is needed.

## Export and configure before deployment

Default production exports to explicit `--expiration never`; honor a requested
finite lifetime in seconds. Capture stdout in memory, never directly in a tool
transcript. The actual command is:

`duet app credentials export --workspace <slug> --app <slug> --expiration never --json`

Check `duet app credentials export --help` for that command's actual usage first;
older releases may return generic help successfully. If this installed CLI does
not support the command, use the API below. A failed export is not evidence that the
CLI is unavailable: do not follow it with another issuing POST. The API is
`POST /v1/ws/{workspaceSlug}/apps/{appSlug}/credentials/export` with
`{"expiration":"never"}` or `{"expiration":{"seconds":2592000}}`.

Store returned `key` as `DUET_APP_API_KEY` and returned `apiUrl` and
`gatewayBaseUrl` as `DUET_API_URL` and `DUET_GATEWAY_BASE_URL` in the host's
server-side configuration. Pass values through the host CLI's stdin, never
arguments, files, logs or browser/public variables. Preserve the selected
project and environment; configure before deploying to that environment.
The URLs returned by export identify the deployment, including staging.

This Bun example runs from the **already linked Vercel project directory**, with
its host authentication available. Set non-secret `WORKSPACE_SLUG`, `APP_SLUG`
and `HOST_ENVIRONMENT` (`production` or `preview`) for the selected deployment;
the sandbox already supplies `DUET_API_URL` and `DUET_API_KEY`. Adapt the host
commands to another provider's existing secret/deployment workflow. This example
only configures credentials for an app row you have already registered.

```typescript
async function main() {
  const workspace = process.env.WORKSPACE_SLUG;
  const app = process.env.APP_SLUG;
  const environment = process.env.HOST_ENVIRONMENT;
  if (!workspace || !app || !['production', 'preview'].includes(environment ?? '')) {
    throw new Error('Select the workspace, app and host environment before exporting.');
  }
  const command = ['duet', 'app', 'credentials', 'export'];
  let supported = false;
  if (Bun.which('duet')) {
    const help = Bun.spawn([...command, '--help'], { stdout: 'pipe', stderr: 'ignore' });
    const [usage, status] = await Promise.all([new Response(help.stdout).text(), help.exited]);
    supported = status === 0 && usage.includes('duet app credentials export');
  }
  let exported;
  if (supported) {
    const child = Bun.spawn([...command, '--workspace', workspace, '--app', app,
      '--expiration', 'never', '--json'], { stdout: 'pipe', stderr: 'ignore' });
    const [output, status] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    if (status !== 0) throw new Error('Export failed; inspect credential inventory before an explicit retry.');
    try { exported = JSON.parse(output); }
    catch { throw new Error('Export returned invalid JSON; inspect credential inventory before an explicit retry.'); }
  } else {
    const origin = process.env.DUET_API_URL;
    const bearer = process.env.DUET_API_KEY;
    if (!origin || !bearer) throw new Error('The build environment is missing Duet API access.');
    const response = await fetch(`${origin.replace(/\/+$/, '')}/v1/ws/${encodeURIComponent(workspace)}/apps/${encodeURIComponent(app)}/credentials/export`, {
      method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ expiration: 'never' }),
    });
    if (!response.ok) throw new Error(`Export failed with HTTP ${response.status}; inspect credential inventory before an explicit retry.`);
    try { exported = await response.json(); }
    catch { throw new Error('Export returned invalid JSON; inspect credential inventory before an explicit retry.'); }
  }
  console.log(JSON.stringify({ credentialId: exported.credentialId }));
  for (const [name, value] of Object.entries({
    DUET_APP_API_KEY: exported.key,
    DUET_API_URL: exported.apiUrl,
    DUET_GATEWAY_BASE_URL: exported.gatewayBaseUrl,
  })) {
    if (typeof value !== 'string' || !value) throw new Error('Export response is missing runtime configuration.');
    const child = Bun.spawn(['vercel', 'env', 'add', name, environment, '--force', '--yes'], {
      stdin: new Blob([value]), stdout: 'ignore', stderr: 'ignore',
    });
    if (await child.exited !== 0) throw new Error(`Host configuration failed for ${name}; do not deploy.`);
  }
  const deploy = Bun.spawn(['vercel', 'deploy', '--yes', ...(environment === 'production' ? ['--prod'] : [])], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
  });
  const [receipt, status] = await Promise.all([new Response(deploy.stdout).text(), deploy.exited]);
  if (status !== 0) throw new Error('Deployment failed; retain the credential ID for recovery.');
  console.log(JSON.stringify({ credentialId: exported.credentialId, deployment: receipt.trim() }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
```

Never substitute a human API key or read the VM's private managed app credential.
The workspace VM is trusted: if local testing or host tooling needs a file or
`.env` value, save it as private, untracked runtime configuration. Keep it out
of source, public assets, browser variables, logs, tool transcripts and command
output. The deployed app must read the key server-side, and the external host
should use its own server-side environment or secret store. If host
authentication is unavailable, report that concrete host-access blocker; do not
send the human away to perform Duet credential setup.

## Runtime requests and verification

Read those three variables in **server code**. Ordinary Duet REST paths include
the workspace slug; model calls use `DUET_GATEWAY_BASE_URL` and standard
`Authorization: Bearer <DUET_APP_API_KEY>` authentication. Preserve the app's
model selection and request body, and never expose its bearer to browser code.

After deployment, verify the external server can authenticate as the expected
app/workspace, then perform one bounded operation through the deployed app and
confirm it uses the returned API/gateway origins. Verify its normal visible
page too. A configured environment value alone does not prove the deployed
server received it: host environment changes apply to the next deployment.

## Rotation and recovery

Use `duet app credentials ls --workspace <slug> --app <slug> --json` for the live
metadata inventory; the API alternative is `GET .../credentials`. When the live export inventory is full, list and deliberately revoke an identified
obsolete credential before exporting. Never loop, discard all keys, or revoke an unknown deployment's key.

For rotation, export a replacement, configure and deploy the host, confirm the
new deployment works, then run
`duet app credentials revoke <credentialId> --workspace <slug> --app <slug> --json`
or `DELETE .../credentials/{credentialId}` for the selected old ID. Revoking
one export preserves siblings and the separately managed VM key.

An export creates a fresh secret and cannot recover earlier plaintext. An
ambiguous network failure may have minted a key: inspect inventory and revoke
any unwanted issuance before explicitly trying again. Neither CLI nor API
export should retry automatically. If host configuration fails after export,
retain only its safe credential ID for cleanup/recovery.

A real `apiScopes` change permanently revokes existing exports, including a
later change back. Reconfigure the external host with a fresh export after
changing scope; normalized no-op updates preserve it. App deletion or existing
disable/removal lifecycles revoke both purposes. Removing the person who
exported the key does not: authority belongs to the app row. A shared/installed
copy in another workspace gets its own app identity and credentials.
