import {
  assertNoDuetTestVms,
  cleanup,
  createVm,
  fenced,
  makeContext,
  ms,
  runOrThrow,
  time,
  vmName,
  writeReport,
} from './probe-common.ts'

const DATE = '2026-07-06'
const PORT = 7444
const WORKDIR = '$HOME/probe-tunnel'

interface TunnelResult {
  vmAName: string
  vmBName: string
  url: string
  createAMs: number
  createBMs: number
  readyAMs: number
  readyBMs: number
  serverReadyMs: number
  tokenLabel: string
  positiveStatus: string
  positiveEchoes: string[]
  positiveLatenciesMs: number[]
  noHeaderStatus: string
  garbageHeaderStatus: string
  deleted: string[]
  leakCheck: 'none' | 'failed'
}

const serverScript = `#!/usr/bin/env python3
import base64
import hashlib
import socket
import struct
import threading

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

def recv_exact(conn, n):
    data = b""
    while len(data) < n:
        chunk = conn.recv(n - len(data))
        if not chunk:
            raise EOFError()
        data += chunk
    return data

def read_frame(conn):
    first = recv_exact(conn, 2)
    opcode = first[0] & 0x0F
    length = first[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", recv_exact(conn, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", recv_exact(conn, 8))[0]
    masked = bool(first[1] & 0x80)
    mask = recv_exact(conn, 4) if masked else b""
    payload = recv_exact(conn, length) if length else b""
    if masked:
        payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return opcode, payload

def send_frame(conn, opcode, payload):
    header = bytes([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header += bytes([length])
    elif length < 65536:
        header += bytes([126]) + struct.pack("!H", length)
    else:
        header += bytes([127]) + struct.pack("!Q", length)
    conn.sendall(header + payload)

def handle(conn):
    try:
        request = b""
        while b"\\r\\n\\r\\n" not in request:
            chunk = conn.recv(4096)
            if not chunk:
                return
            request += chunk
        headers = {}
        for line in request.decode("latin1").split("\\r\\n")[1:]:
            if ":" in line:
                key, value = line.split(":", 1)
                headers[key.lower()] = value.strip()
        accept = base64.b64encode(hashlib.sha1((headers["sec-websocket-key"] + GUID).encode()).digest()).decode()
        conn.sendall((
            "HTTP/1.1 101 Switching Protocols\\r\\n"
            "Upgrade: websocket\\r\\n"
            "Connection: Upgrade\\r\\n"
            f"Sec-WebSocket-Accept: {accept}\\r\\n\\r\\n"
        ).encode())
        while True:
            opcode, payload = read_frame(conn)
            if opcode == 8:
                send_frame(conn, 8, b"")
                return
            if opcode == 9:
                send_frame(conn, 10, payload)
                continue
            if opcode in (1, 2):
                send_frame(conn, opcode, payload)
    except Exception:
        return
    finally:
        try:
            conn.close()
        except Exception:
            pass

sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("0.0.0.0", ${PORT}))
sock.listen(50)
print("ready", flush=True)
while True:
    conn, _ = sock.accept()
    threading.Thread(target=handle, args=(conn,), daemon=True).start()
`

const clientScript = `#!/usr/bin/env python3
import base64
import json
import os
import socket
import ssl
import struct
import sys
import time
from urllib.parse import urlparse

target = sys.argv[1]
token_path = os.path.expanduser(sys.argv[2])
token = open(token_path).read().strip()
parsed = urlparse(target)
host = parsed.hostname
port = parsed.port or 443
path = parsed.path or "/"

def recv_until(sock, marker):
    data = b""
    while marker not in data:
        chunk = sock.recv(4096)
        if not chunk:
            break
        data += chunk
    return data

def ws_connect(mode):
    raw = socket.create_connection((host, port), timeout=15)
    sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host)
    key = base64.b64encode(os.urandom(16)).decode()
    headers = [
        f"GET {path} HTTP/1.1",
        f"Host: {host}:{port}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        "Sec-WebSocket-Version: 13",
        f"Sec-WebSocket-Key: {key}",
    ]
    if mode == "valid":
        headers.append(f"X-Exedev-Authorization: Bearer {token}")
    elif mode == "garbage":
        headers.append("X-Exedev-Authorization: Bearer exe1.garbage")
    request = "\\r\\n".join(headers) + "\\r\\n\\r\\n"
    sock.sendall(request.encode())
    response = recv_until(sock, b"\\r\\n\\r\\n")
    status = response.decode("latin1", errors="replace").split("\\r\\n", 1)[0]
    return sock, status

def send_frame(sock, payload):
    data = payload.encode()
    mask = os.urandom(4)
    header = bytes([0x81])
    length = len(data)
    if length < 126:
        header += bytes([0x80 | length])
    elif length < 65536:
        header += bytes([0x80 | 126]) + struct.pack("!H", length)
    else:
        header += bytes([0x80 | 127]) + struct.pack("!Q", length)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    sock.sendall(header + mask + masked)

def recv_frame(sock):
    first = sock.recv(2)
    if len(first) < 2:
        raise RuntimeError("short frame header")
    length = first[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", sock.recv(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", sock.recv(8))[0]
    payload = b""
    while len(payload) < length:
        payload += sock.recv(length - len(payload))
    return payload.decode()

positive_sock, positive_status = ws_connect("valid")
echoes = []
latencies = []
for payload in ("alpha", "beta"):
    start = time.perf_counter()
    send_frame(positive_sock, payload)
    echoes.append(recv_frame(positive_sock))
    latencies.append((time.perf_counter() - start) * 1000)
positive_sock.close()

try:
    no_header_sock, no_header_status = ws_connect("none")
    no_header_sock.close()
except Exception as exc:
    no_header_status = f"connection-error: {type(exc).__name__}"

try:
    garbage_sock, garbage_status = ws_connect("garbage")
    garbage_sock.close()
except Exception as exc:
    garbage_status = f"connection-error: {type(exc).__name__}"

print(json.dumps({
    "positiveStatus": positive_status,
    "positiveEchoes": echoes,
    "positiveLatenciesMs": latencies,
    "noHeaderStatus": no_header_status,
    "garbageHeaderStatus": garbage_status,
}, sort_keys=True))
`

async function installServer(sshDest: string): Promise<void> {
  const ctx = makeContext()
  await runOrThrow(ctx.ssh, sshDest, `mkdir -p ${WORKDIR}`)
  await runOrThrow(
    ctx.ssh,
    sshDest,
    `cat > ${WORKDIR}/ws_echo.py <<'PY'\n${serverScript}\nPY\nchmod +x ${WORKDIR}/ws_echo.py`,
  )
  await runOrThrow(
    ctx.ssh,
    sshDest,
    `nohup python3 ${WORKDIR}/ws_echo.py > ${WORKDIR}/server.out 2> ${WORKDIR}/server.err & echo $! > ${WORKDIR}/server.pid`,
  )
}

async function waitServer(sshDest: string): Promise<void> {
  const ctx = makeContext()
  const deadline = performance.now() + 60_000
  for (;;) {
    const ready = await runOrThrow(
      ctx.ssh,
      sshDest,
      `python3 - <<'PY'\nimport socket\ns=socket.socket(); s.settimeout(1)\ntry:\n s.connect(('127.0.0.1', ${PORT})); print('yes')\nexcept Exception:\n print('no')\nfinally:\n s.close()\nPY`,
    )
    if (ready === 'yes') return
    if (performance.now() >= deadline)
      throw new Error('WebSocket echo server did not listen in time')
    await Bun.sleep(500)
  }
}

async function installClient(sshDest: string, token: string): Promise<void> {
  const quietSsh = makeContext().ssh
  await runOrThrow(quietSsh, sshDest, `mkdir -p ${WORKDIR}`)
  await runOrThrow(
    quietSsh,
    sshDest,
    `cat > ${WORKDIR}/ws_client.py <<'PY'\n${clientScript}\nPY\nchmod +x ${WORKDIR}/ws_client.py`,
  )
  await runOrThrow(
    quietSsh,
    sshDest,
    `cat > ${WORKDIR}/vm-token <<'TOK'\n${token}\nTOK\nchmod 600 ${WORKDIR}/vm-token`,
  )
}

function report(result: TunnelResult | null, failure?: string): string {
  if (!result) {
    return `# exe.dev WebSocket tunnel proof

Date: ${DATE}
Marker: SLICE01B-PROBES-5T8V

## Verdict

Not measured. The probe failed before a complete positive and negative tunnel result.

Failure:

${fenced(failure ?? 'unknown failure')}
`
  }

  const bytesThrough =
    result.positiveStatus.includes('101') &&
    result.positiveEchoes.join(',') === 'alpha,beta' &&
    !result.noHeaderStatus.includes('101') &&
    !result.garbageHeaderStatus.includes('101')

  return `# exe.dev WebSocket tunnel proof

Date: ${DATE}
Marker: SLICE01B-PROBES-5T8V

## Verdict

${bytesThrough ? 'Bytes pass over the authenticated WebSocket tunnel, and unauthenticated requests are rejected' : 'Tunnel behavior did not match the expected authenticated-only contract'}.

VM B dialed VM A at \`${result.url}\` with \`X-Exedev-Authorization: Bearer <vm-scoped token>\`. The token was generated with \`ssh-key generate-api-key --vm=<vm-a> --label=<label> --exp=1d\` and was not written to this report.

## Evidence

- positive handshake: \`${result.positiveStatus}\`
- echoed payloads: \`${result.positiveEchoes.join(', ')}\`
- positive round-trip latencies: ${result.positiveLatenciesMs.map(v => ms(v)).join(', ')}
- no auth header: \`${result.noHeaderStatus}\`
- garbage auth header: \`${result.garbageHeaderStatus}\`

Key observed lines:

${fenced(
  [
    `url=${result.url}`,
    `header=X-Exedev-Authorization: Bearer <vm-scoped token>`,
    `positive=${result.positiveStatus}; echoes=${result.positiveEchoes.join(',')}`,
    `negative-no-header=${result.noHeaderStatus}`,
    `negative-garbage-header=${result.garbageHeaderStatus}`,
    `duet-test leak check=${result.leakCheck}`,
  ].join('\n'),
)}

## Mechanics pinned

- exe VMs expose private HTTPS proxy URLs as \`https_url\`; additional authenticated-only ports 3000-9999 are reached by adding the port to the VM hostname.
- For WebSocket transport, the URL form is \`wss://<vm>.exe.xyz:${PORT}/\`.
- The preferred VM proxy auth header is \`X-Exedev-Authorization: Bearer <token>\`.
- VM-scoped proxy tokens are generated through \`ssh-key generate-api-key --vm=<vm-name>\`; these are distinct from lobby \`/exec\` tokens.
- This probe pins the 2026-07-06 sharing-semantics conclusion as a repeatable transport check; it does not treat raw VM-to-VM TCP as available.

## Timings

- VM A create/ready: ${ms(result.createAMs)} / ${ms(result.readyAMs)}
- VM B create/ready: ${ms(result.createBMs)} / ${ms(result.readyBMs)}
- server listen readiness: ${ms(result.serverReadyMs)}

## Cleanup

- deleted: ${result.deleted.join(', ')}
- final \`duet-test-*\` leak check: ${result.leakCheck}
`
}

async function main(): Promise<void> {
  const ctx = makeContext()
  await ctx.control.whoami()

  const vmAName = vmName('tunnel-a')
  const vmBName = vmName('tunnel-b')
  let result: TunnelResult | null = null
  let failure: string | undefined
  /* Hoisted so cleanup can reach it: the generated API key leaves an account
     SSH-key entry behind, and an entry outlives the token's `--exp`. */
  let apiKeyLabel: string | null = null

  try {
    const vmA = await createVm(ctx, { name: vmAName, comment: `agent-drive ${DATE} tunnel VM A` })
    const vmB = await createVm(ctx, { name: vmBName, comment: `agent-drive ${DATE} tunnel VM B` })
    const readyA = await time(() =>
      ctx.ssh.waitUntilReady(vmA.value.ssh_dest, { timeoutMs: 180_000 }),
    )
    const readyB = await time(() =>
      ctx.ssh.waitUntilReady(vmB.value.ssh_dest, { timeoutMs: 180_000 }),
    )

    await installServer(vmA.value.ssh_dest)
    const serverReady = await time(() => waitServer(vmA.value.ssh_dest))

    const label = `duet-probe-${Date.now().toString(36)}`
    apiKeyLabel = label
    const token = await ctx.ssh.generateVmApiKey(vmA.value.vm_name, label, '1d')
    await installClient(vmB.value.ssh_dest, token)

    const host = new URL(vmA.value.https_url ?? `https://${vmA.value.ssh_dest}`).hostname
    const url = `wss://${host}:${PORT}/`
    const raw = await runOrThrow(
      makeContext().ssh,
      vmB.value.ssh_dest,
      `python3 ${WORKDIR}/ws_client.py ${JSON.stringify(url)} ${WORKDIR}/vm-token`,
      60_000,
    )
    const parsed = JSON.parse(raw) as Pick<
      TunnelResult,
      | 'positiveStatus'
      | 'positiveEchoes'
      | 'positiveLatenciesMs'
      | 'noHeaderStatus'
      | 'garbageHeaderStatus'
    >

    result = {
      vmAName,
      vmBName,
      url,
      createAMs: vmA.durationMs,
      createBMs: vmB.durationMs,
      readyAMs: readyA.durationMs,
      readyBMs: readyB.durationMs,
      serverReadyMs: serverReady.durationMs,
      tokenLabel: label,
      positiveStatus: parsed.positiveStatus,
      positiveEchoes: parsed.positiveEchoes,
      positiveLatenciesMs: parsed.positiveLatenciesMs,
      noHeaderStatus: parsed.noHeaderStatus,
      garbageHeaderStatus: parsed.garbageHeaderStatus,
      deleted: [],
      leakCheck: 'failed',
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    if (apiKeyLabel !== null) await ctx.ssh.removeSshKey(apiKeyLabel).catch(() => {})
    const cleaned = await cleanup(ctx)
    if (result) result.deleted = cleaned.deleted
    try {
      await assertNoDuetTestVms(ctx.control)
      if (result) result.leakCheck = 'none'
    } catch (error) {
      failure = [failure, error instanceof Error ? error.message : String(error)]
        .filter(Boolean)
        .join('\n')
    }
    await writeReport('probe-ws-tunnel.md', report(result, failure))
  }

  if (!result)
    throw new Error(
      'tunnel probe failed before completion. See probe-results/reports/probe-ws-tunnel.md',
    )
  const ok =
    result.positiveStatus.includes('101') &&
    result.positiveEchoes.join(',') === 'alpha,beta' &&
    !result.noHeaderStatus.includes('101') &&
    !result.garbageHeaderStatus.includes('101')
  if (!ok) throw new Error('tunnel probe did not prove bytes-through plus auth rejection')
  console.log(
    `tunnel works: echoes=${result.positiveEchoes.join(',')}, latencies=${result.positiveLatenciesMs.map(v => ms(v)).join('/')}, rejected=${result.noHeaderStatus}/${result.garbageHeaderStatus}`,
  )
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
