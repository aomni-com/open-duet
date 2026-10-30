import { afterEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { connectMcpServers } from "../src/turn-runner/mcp.js";
import { waitFor } from "./helpers/async.js";
import { startMcpHttpServer } from "./helpers/mcp-http-server.js";

const runtimes = new Set<Awaited<ReturnType<typeof connectMcpServers>>>();

async function connectFixture(...args: Parameters<typeof connectMcpServers>) {
  const runtime = await connectMcpServers(...args);
  runtimes.add(runtime);
  return runtime;
}

afterEach(async () => {
  for (const runtime of runtimes) await runtime.dispose();
  runtimes.clear();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("connectMcpServers", () => {
  test("returns an empty runtime when no servers are configured", async () => {
    const runtime = await connectFixture({}, { onWarn: () => {} });
    expect(runtime.tools).toEqual([]);
    await runtime.dispose();
  });

  test("warns and skips servers with invalid urls", async () => {
    const warnings: string[] = [];
    const runtime = await connectFixture(
      { broken: { type: "http", url: "not a url" } },
      { onWarn: (m) => warnings.push(m) },
    );
    expect(runtime.tools).toEqual([]);
    expect(warnings.some((m) => m.includes("invalid url"))).toBe(true);
    await runtime.dispose();
  });

  test("warns and skips servers with non-http protocols", async () => {
    const warnings: string[] = [];
    const runtime = await connectFixture(
      { weird: { type: "http", url: "ftp://example.com/mcp" } },
      { onWarn: (m) => warnings.push(m) },
    );
    expect(runtime.tools).toEqual([]);
    expect(warnings.some((m) => m.includes("unsupported protocol"))).toBe(true);
    await runtime.dispose();
  });

  test("warns and skips servers that fail to connect", async () => {
    const warnings: string[] = [];
    // 127.0.0.1:1 is reserved and should fail fast.
    const runtime = await connectFixture(
      { offline: { type: "http", url: "http://127.0.0.1:1/mcp" } },
      { onWarn: (m) => warnings.push(m) },
    );
    expect(runtime.tools).toEqual([]);
    expect(warnings.some((m) => m.includes("failed to connect"))).toBe(true);
    await runtime.dispose();
  });

  test("aborting the signal cancels an in-flight tool call promptly and connection disposal is idempotent", async () => {
    let handlerStarted = false;
    const release = deferred();
    const finished = deferred();
    const server = await startMcpHttpServer(() => {
      const mcp = new McpServer({ name: "hang-test-mcp", version: "0.0.0" });
      mcp.registerTool(
        "wait_forever",
        { description: "Wait for fixture release.", inputSchema: {} },
        async () => {
          handlerStarted = true;
          try {
            await release.promise;
            return { content: [{ type: "text", text: "fixture released" }] };
          } finally {
            finished.resolve();
          }
        },
      );
      return mcp;
    });
    let runtime: Awaited<ReturnType<typeof connectMcpServers>> | undefined;
    let pending: Promise<unknown> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      runtime = await connectFixture(
        { hang: { type: "http", url: server.url } },
        { onWarn: () => {} },
      );
      const tool = runtime.tools.find((t) => t.name === "hang__wait_forever");
      if (!tool) throw new Error("hang__wait_forever tool not exposed");
      const controller = new AbortController();
      pending = tool.execute("call-1", {}, controller.signal);
      const outcome = pending.then(
        () => ({ kind: "resolved" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      await waitFor(() => handlerStarted);
      controller.abort(new Error("Interrupted"));
      const result = await Promise.race([
        outcome,
        new Promise<{ kind: "hung" }>((resolve) => {
          deadline = setTimeout(() => resolve({ kind: "hung" }), 3000);
        }),
      ]);
      expect(result.kind).toBe("rejected");
      if (result.kind === "rejected") expect(String(result.error)).toContain("Interrupted");
      await runtime.dispose();
      await runtime.dispose();
    } finally {
      if (deadline) clearTimeout(deadline);
      release.resolve();
      await runtime?.dispose();
      await pending?.catch(() => {});
      await server.close();
      // Only wait for a handler that was actually reached, including setup failures.
      if (handlerStarted) await finished.promise;
    }
  }, 10000);
});
