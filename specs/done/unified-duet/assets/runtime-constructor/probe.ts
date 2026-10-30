import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, cp, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run only in a disposable Linux container. The candidate run mounts no checkout or dependencies.
const rpcOnly = process.env.PROBE_RPC_ONLY === '1';
const argv = JSON.parse(process.env.PROBE_COMMAND ?? '["/release/duet"]') as string[];
const evidence = process.env.PROBE_EVIDENCE ?? "/evidence";
const root = await mkdtemp(join(tmpdir(), "duet-packaging-"));
const requests: Array<{ path: string; body: unknown }> = [];
const results: Record<string, unknown> = {};
let releaseFirstModel!: () => void;
const firstModelGate = new Promise<void>((resolve) => { releaseFirstModel = resolve; });
const note = "The harbor lighthouse is violet.";
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const body = await request.json() as Record<string, unknown>;
    requests.push({ path, body });
    if (path.endsWith("/embeddings")) {
      const inputs = body.input as string[];
      return Response.json({ model: body.model, data: inputs.map(() => ({ embedding: [1, ...Array(3071).fill(0)] })) });
    }
    assert(path.endsWith("/messages"), `Unexpected transport: ${path}`);
    if (requests.filter((r) => r.path.endsWith("/messages")).length === 1) await firstModelGate;
    return actorResponse(requests.filter((r) => r.path.endsWith("/messages")).length);
  },
});
const env = {
  PATH: process.env.PATH!, HOME: join(root, "home"), TERM: "xterm-256color",
  DUET_API_KEY: "duet_packaging_fixture", DUET_GATEWAY_BASE_URL: server.url.origin,
};
await mkdir(env.HOME, { recursive: true });
await mkdir(join(root, "work"));
await writeFile(join(root, "work", "needle.txt"), note + "\n");
await writeFile(join(root, "work", "wide.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAEAAAAAAECAYAAAAO7PrPAAAAZ0lEQVR4nO3cMQEAAAQAQdFEEUVzYjDccPsn+MjqAQAAAAAAAAAAAAAAAAAAAG7FdQAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAvGAAAAAAAAAAAAAAAAAAAAADAAwtHNcfq7VpTkAAAAABJRU5ErkJggg==", "base64"));
async function run(args: string[], command = argv) {
  const began = performance.now();
  const proc = Bun.spawn([...command, ...args], { cwd: join(root, "work"), env, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 45_000);
  let peakRssKiB = 0;
  const sample = setInterval(async () => {
    try { peakRssKiB = Math.max(peakRssKiB, Number((await readFile(`/proc/${proc.pid}/status`, "utf8")).match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0)); } catch {}
  }, 20);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code, elapsedMs: Math.round(performance.now() - began), sampledPeakRssKiB: peakRssKiB };
  } finally { clearTimeout(timer); clearInterval(sample); }
}
async function success(args: string[]) {
  const result = await run(args);
  assert.equal(result.code, 0, JSON.stringify({ args, ...result }));
  return result;
}
try {
  results.version = await success(["--version"]);
  results.help = await success(["--help"]);
  assert((results.help as { stdout: string }).stdout.includes("duet —"));
  results.skills = await success(["skills"]);
  const skills = JSON.parse((results.skills as { stdout: string }).stdout);
  assert(skills.skills.some((s: { name: string }) => s.name === "relay"));
  results.provider = await success(["connect", "--status", "--json"]);

  if (!rpcOnly) {
  const db = join(root, "memory.db");
  const added = await success(["memory", "add", note, "--db", db, "--json"]);
  assert.equal(JSON.parse(added.stdout).content, note);
  const listed = await success(["memory", "--db", db, "--json"]);
  assert(JSON.parse(listed.stdout).some((row: { content: string }) => row.content === note));
  // No shared words: a hit requires the pgvector semantic path, not keyword fallback.
  const recalled = await success(["memory", "recall", "semantic-probe", "--db", db, "--json"]);
  assert(JSON.parse(recalled.stdout).some((row: { content: string }) => row.content === note));
  assert(requests.some((r) => r.path.endsWith("/embeddings")));
  results.memory = { added, reopened: listed, semanticRecall: recalled };

  }
  const proc = Bun.spawn([...argv, "--rpc", "--incognito", "--workdir", join(root, "work"), "--model", "duet:anthropic/claude-haiku-4-5", "--no-system-prompt-files"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill("SIGKILL"), 45_000);
  const events: Array<Record<string, unknown>> = [];
  const stderrPromise = new Response(proc.stderr).text();
  let remainder = "";
  try {
    // The fixture keeps stdin open; flush each buffered command explicitly.
    proc.stdin.write(JSON.stringify({ type: "start" }) + "\n");
    await proc.stdin.flush();
    proc.stdin.write(JSON.stringify({ type: "prompt", requestId: "first", message: "First controlled turn.", behavior: "follow_up" }) + "\n");
    await proc.stdin.flush();
    for await (const chunk of proc.stdout) {
      remainder += new TextDecoder().decode(chunk);
      const lines = remainder.split("\n");
      remainder = lines.pop()!;
      for (const line of lines.filter(Boolean)) {
        const event = JSON.parse(line);
        events.push(event);
        if (event.type === "command_accepted" && event.requestId === "first") {
          proc.stdin.write(JSON.stringify({ type: "prompt", requestId: "second", message: "Continue the controlled turn.", behavior: "follow_up" }) + "\n");
          await proc.stdin.flush();
        }
        if (event.type === "command_accepted" && event.requestId === "second") releaseFirstModel();
        if (event.type === "complete") { assert.equal(event.status, "completed", JSON.stringify(event)); proc.stdin.end(); }
      }
    }
    assert.equal(await proc.exited, 0, await stderrPromise);
    for (const requestId of ["first", "second"]) assert(events.some((e) => e.type === "command_accepted" && e.requestId === requestId), JSON.stringify(events.map((e) => ({type:e.type, requestId:e.requestId}))));
    assert.equal(events.filter((e) => e.type === "complete").length, 1);
    assert(requests.filter((r) => r.path.endsWith("/messages")).length >= 4);
    const toolResults = requests.filter((r) => r.path.endsWith("/messages")).flatMap((r) =>
      (r.body as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages.flatMap((m) => m.content),
    ).filter((c) => c.type === "tool_result");
    if (!rpcOnly) assert(toolResults.some((c) => c.is_error === false && c.content === `needle.txt:${note}\n`), JSON.stringify(toolResults));
    assert(JSON.stringify(toolResults).includes("original 4096x4, displayed at 2000x2"), "PHOTON_INLINE_IMAGE_REQUIRED: " + JSON.stringify(toolResults));
    results.rpc = { accepted: events.filter((e) => e.type === "command_accepted"), completions: events.filter((e) => e.type === "complete").map((e) => ({ status: e.status, result: e.result })), requests: requests.filter((r) => r.path.endsWith("/messages")), stderr: await stderrPromise };
  } finally { clearTimeout(timer); proc.kill(); }

  if (argv.length === 1 && !rpcOnly) {
    const failures = [];
    for (const asset of ["pglite.data", "pglite.wasm", "initdb.wasm", "vector.tar.gz"]) {
      const broken = join(root, `missing-${asset}`);
      await cp("/release", broken, { recursive: true });
      await unlink(join(broken, asset));
      const result = await run(["memory", "--db", join(root, `db-${asset}`), "--json"], [join(broken, "duet")]);
      assert.notEqual(result.code, 0, `Missing ${asset} unexpectedly succeeded`);
      assert(result.stderr.includes(`Compiled PGlite runtime is missing sidecars: ${asset}`), result.stderr);
      failures.push({ asset, ...result });
      await rm(broken, { recursive: true, force: true });
    }
    results.missingSidecars = failures;
    const corruptions = [];
    for (const asset of ["pglite.data", "pglite.wasm", "initdb.wasm", "vector.tar.gz"]) {
      const broken = join(root, `corrupt-${asset}`);
      await cp("/release", broken, { recursive: true });
      await writeFile(join(broken, asset), "invalid-runtime-sidecar");
      const result = await run(["memory", "--db", join(root, `corrupt-db-${asset}`), "--json"], [join(broken, "duet")]);
      assert.notEqual(result.code, 0, `Corrupt ${asset} unexpectedly succeeded`);
      assert.match(result.stderr, /pglite|vector|WebAssembly|gzip|wasm/i);
      corruptions.push({ asset, ...result });
      await rm(broken, { recursive: true, force: true });
    }
    results.corruptSidecars = corruptions;
  }
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, "runtime.json"), JSON.stringify({ command: argv, bun: Bun.version, network: "Docker --network none; controlled loopback fixtures", results, requests }, null, 2) + "\n");
  console.log(rpcOnly ? "PASS controlled RPC and image resize" : "PASS version/help, skills/provider init, durable memory reopen, semantic pgvector recall, RPC continuation/image/grep, missing/corrupt required sidecar failures");
} finally {
  releaseFirstModel();
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
function actorResponse(requestNumber: number) {
  const toolCall = requestNumber <= 2;
  const name = requestNumber === 1 ? "read" : "bash";
  const input = requestNumber === 1 ? { path: "wide.png" } : { command: "rg --with-filename harbor needle.txt" };
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: "anthropic/claude-haiku-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: toolCall ? { type: "tool_use", id: `tool_fixture_${requestNumber}`, name, input: {} } : { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: toolCall ? { type: "input_json_delta", partial_json: JSON.stringify(input) } : { type: "text_delta", text: "packaging parity response" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: toolCall ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
}
