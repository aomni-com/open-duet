import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const scripts = ["../mac/provision.sh", "../mac/gold-check.sh", "../mac/score.sh"];

describe("SWE-bench Mac scripts", () => {
  for (const script of scripts) {
    test(`${script} has valid bash syntax`, () => {
      const result = Bun.spawnSync(["bash", "-n", fileURLToPath(new URL(script, import.meta.url))]);
      expect(result.exitCode).toBe(0);
      expect(result.stderr.toString()).toBe("");
    });
  }

  test("gold-check documents its manifest and one-instance entry points", () => {
    const result = Bun.spawnSync([
      "bash",
      fileURLToPath(new URL(scripts[1]!, import.meta.url)),
      "--help",
    ]);
    expect(result.exitCode).toBe(0);
    const output = result.stdout.toString();
    expect(output).toContain("--manifest PATH");
    expect(output).toContain("--instance-id ID");
  });
});
