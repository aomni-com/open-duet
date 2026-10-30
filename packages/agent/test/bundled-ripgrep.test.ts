import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate optional dependency fixtures from the wrapper's process cache.
async function executeFixture(available: boolean, withPath = true) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "bundled-rg-")));
  try {
    const rgPath = join(cwd, "bundle", "rg");
    const systemBin = join(cwd, "system");
    await mkdir(join(cwd, "bundle"));
    await mkdir(systemBin);
    await writeFile(join(systemBin, "rg"), '#!/bin/sh\nprintf "system-rg"\n', { mode: 0o755 });
    await writeFile(rgPath, '#!/bin/sh\nprintf "fixture-rg:%s:%s" "$FOO" "$PWD"\n', {
      mode: 0o755,
    });
    const source = new URL("../src/turn-runner/bundled-ripgrep.ts", import.meta.url).href;
    const script = [
      'import { mock } from "bun:test";',
      'mock.module("@vscode/ripgrep", () => ({ rgPath: ' +
        (available ? JSON.stringify(rgPath) : "undefined") +
        " }));",
      "const { withBundledRipgrep } = await import(" + JSON.stringify(source) + ");",
      "const calls = [];",
      "const base = { exec: async (command, cwd, options) => {",
      "  calls.push({ command, cwd, env: options.env });",
      '  const proc = Bun.spawn(["/bin/sh", "-c", command], { cwd, env: options.env, stdout: "pipe", stderr: "pipe" });',
      "  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);",
      "  return { stdout, stderr, exitCode };",
      "} };",
      "const wrapped = withBundledRipgrep(base);",
      "const command = " + JSON.stringify("rg") + ";",
      "const env = " +
        JSON.stringify(withPath ? { PATH: systemBin, FOO: "bar" } : { FOO: "bar" }) +
        ";",
      "const cwd = " + JSON.stringify(cwd) + ";",
      "const first = await wrapped.exec(command, cwd, { onData() {}, env });",
      "const second = await wrapped.exec(command, cwd, { onData() {}, env: calls[0].env });",
      "console.log(JSON.stringify({ cwd, first, second, calls }));",
    ].join("\n");
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: systemBin },
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill(), 5_000);
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode, stderr).toBe(0);
      return JSON.parse(stdout) as {
        cwd: string;
        first: { stdout: string; stderr: string; exitCode: number };
        second: { stdout: string; stderr: string; exitCode: number };
        calls: Array<{ command: string; cwd: string; env: NodeJS.ProcessEnv }>;
      };
    } finally {
      clearTimeout(timeout);
      child.kill();
      await child.exited;
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("withBundledRipgrep", () => {
  test("the supplied bundled binary wins over PATH while preserving cwd and environment", async () => {
    const result = await executeFixture(true);
    expect(result.first).toEqual({
      stdout: "fixture-rg:bar:" + result.cwd,
      stderr: "",
      exitCode: 0,
    });
  });
  test("repeat calls retain one PATH entry and still execute the bundled binary", async () => {
    const result = await executeFixture(true);
    expect(result.calls[1]?.env.PATH).toBe(result.calls[0]?.env.PATH);
    expect(result.second).toEqual(result.first);
    expect(result.second.stdout).toBe("fixture-rg:bar:" + result.cwd);
  });
  test("missing optional binary preserves shell operation; absent PATH still finds an available bundle", async () => {
    const missing = await executeFixture(false);
    expect(missing.first).toEqual({ stdout: "system-rg", stderr: "", exitCode: 0 });
    expect(missing.calls[0]?.env).toEqual({ PATH: join(missing.cwd, "system"), FOO: "bar" });
    const noPath = await executeFixture(true, false);
    expect(noPath.first).toEqual({
      stdout: "fixture-rg:bar:" + noPath.cwd,
      stderr: "",
      exitCode: 0,
    });
  });
});
