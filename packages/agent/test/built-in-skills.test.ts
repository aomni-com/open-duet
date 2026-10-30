import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as builtIns from "../src/turn-runner/built-in-skills.js";
import { SkillContext } from "../src/turn-runner/skill-context.js";
import { discoverInstalledSkills, resolveSkillScope } from "../src/turn-runner/skills.js";

let tempDir: string;
let homeLookup: ReturnType<typeof spyOn>;
let instructionsLookup: ReturnType<typeof spyOn> | undefined;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "built-in-skills-"));
  homeLookup = spyOn(os, "homedir").mockReturnValue(tempDir);
});

afterEach(async () => {
  instructionsLookup?.mockRestore();
  instructionsLookup = undefined;
  homeLookup.mockRestore();
  await rm(tempDir, { recursive: true, force: true });
});

describe("built-in skills surface through discovery", () => {
  test("discoverInstalledSkills includes /relay with builtin scope", () => {
    const { skills } = discoverInstalledSkills(tempDir);
    const relay = skills.find((s) => s.name === "relay");
    expect(relay).toBeDefined();
    expect(resolveSkillScope(relay!, tempDir)).toBe("builtin");
  });

  test("SkillContext appends the relay skill block when /relay is in the prompt", async () => {
    instructionsLookup = spyOn(builtIns, "getBuiltInSkillInstructions").mockReturnValue(
      "Controlled builtin instructions.",
    );
    const ctx = new SkillContext({
      cwd: tempDir,
      skillDiscovery: { includeDefaults: false, cwd: tempDir },
    });
    await ctx.ensureLoaded();

    const resolved = ctx.resolveSlashSkillPrompt("monitor the inbox /relay every hour");

    // Token stays in the prompt verbatim.
    expect(resolved).toContain("monitor the inbox /relay every hour");
    // Skill block was injected with the relay instructions, including the
    // `path` attribute so the agent can read/edit the SKILL.md directly.
    expect(resolved).toMatch(/<skill name="relay" path="[^"]+">/);
    expect(resolved).toContain("Controlled builtin instructions.");
    expect(resolved).toContain("</skill>");
    // The legacy `<system-reminder>` wrapper is gone — the body must not
    // smuggle one in.
    expect(resolved).not.toContain("<system-reminder>");
  });

  test("discoverInstalledSkills includes /goal with builtin scope, advertised beside relay", () => {
    const { skills } = discoverInstalledSkills(tempDir);
    const goal = skills.find((s) => s.name === "goal");
    expect(goal).toBeDefined();
    expect(resolveSkillScope(goal!, tempDir)).toBe("builtin");
    const ctx = new SkillContext({
      cwd: tempDir,
      skillDiscovery: { includeDefaults: false, cwd: tempDir },
    });
    const menu = ctx.createSystemPromptWithAppendedLayers({ skills });
    expect(menu).toContain('<skill name="goal"');
    expect(menu).toContain('<skill name="relay"');
  });

  test("SkillContext appends the goal skill block when /goal is in the prompt", async () => {
    instructionsLookup = spyOn(builtIns, "getBuiltInSkillInstructions").mockReturnValue(
      "Controlled builtin instructions.",
    );
    const ctx = new SkillContext({
      cwd: tempDir,
      skillDiscovery: { includeDefaults: false, cwd: tempDir },
    });
    await ctx.ensureLoaded();

    const resolved = ctx.resolveSlashSkillPrompt("/goal get the flaky test green");

    expect(resolved).toContain("/goal get the flaky test green");
    expect(resolved).toMatch(/<skill name="goal" path="[^"]+">/);
    expect(resolved).toContain("Controlled builtin instructions.");
    expect(resolved).toContain("</skill>");
  });

  test("a user-installed skill named 'relay' shadows the built-in", async () => {
    const ctx = new SkillContext({
      cwd: tempDir,
      skills: [
        {
          name: "relay",
          description: "user override",
          filePath: `${tempDir}/SKILL.md`,
          baseDir: tempDir,
          sourceInfo: {
            path: tempDir,
            source: "test",
            scope: "temporary",
            origin: "top-level",
          },
          disableModelInvocation: false,
        },
      ],
      skillDiscovery: { includeDefaults: false, cwd: tempDir },
    });
    await ctx.ensureLoaded();
    const found = ctx.getSkills().filter((s) => s.name === "relay");
    expect(found).toHaveLength(1);
    expect(found[0]!.description).toBe("user override");
  });
});
