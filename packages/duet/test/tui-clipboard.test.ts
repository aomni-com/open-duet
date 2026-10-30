import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeClipboardText } from "../src/tui/clipboard.js";
import {
  parseCopyArgument,
  selectCopyText,
  type TranscriptEntry,
} from "../src/tui/transcript-log.js";

const sampleLog: TranscriptEntry[] = [
  { kind: "user", text: "hello" },
  { kind: "agent", text: "hi there" },
  { kind: "user", text: "what's up?" },
  { kind: "agent", text: "not much, you?" },
];

describe("parseCopyArgument", () => {
  test("empty argument resolves to 'last'", () => {
    expect(parseCopyArgument("")).toBe("last");
    expect(parseCopyArgument("   ")).toBe("last");
  });

  test("explicit 'last' and 'all' pass through", () => {
    expect(parseCopyArgument("last")).toBe("last");
    expect(parseCopyArgument("all")).toBe("all");
  });

  test("positive integer is parsed as a count", () => {
    expect(parseCopyArgument("3")).toBe(3);
    expect(parseCopyArgument("  10  ")).toBe(10);
  });

  test("malformed arguments return undefined", () => {
    expect(parseCopyArgument("0")).toBeUndefined();
    expect(parseCopyArgument("-1")).toBeUndefined();
    expect(parseCopyArgument("1.5")).toBeUndefined();
    expect(parseCopyArgument("nope")).toBeUndefined();
  });
});

describe("selectCopyText", () => {
  test("'last' returns the most recent agent reply", () => {
    expect(selectCopyText(sampleLog, "last")).toBe("not much, you?");
  });

  test("'last' falls back to the latest user message when no agent has replied", () => {
    const onlyUser: TranscriptEntry[] = [{ kind: "user", text: "hi" }];
    expect(selectCopyText(onlyUser, "last")).toBe("hi");
  });

  test("'all' joins every entry in order with role labels", () => {
    const result = selectCopyText(sampleLog, "all");
    expect(result).toBe(
      "you: hello\n\nagent: hi there\n\nyou: what's up?\n\nagent: not much, you?",
    );
  });

  test("numeric N selects the trailing slice", () => {
    expect(selectCopyText(sampleLog, 1)).toBe("agent: not much, you?");
    expect(selectCopyText(sampleLog, 2)).toBe("you: what's up?\n\nagent: not much, you?");
  });

  test("N larger than the log returns the whole log", () => {
    expect(selectCopyText(sampleLog, 99)).toBe(selectCopyText(sampleLog, "all"));
  });

  test("empty log returns undefined for every selector", () => {
    expect(selectCopyText([], "last")).toBeUndefined();
    expect(selectCopyText([], "all")).toBeUndefined();
    expect(selectCopyText([], 5)).toBeUndefined();
  });
});

describe("writeClipboardText", () => {
  async function withWriterFixture(run: (directory: string, captured: string) => Promise<void>) {
    const directory = await mkdtemp(join(tmpdir(), "duet-clipboard-"));
    const captured = join(directory, "captured.txt");
    const previousPath = process.env.PATH;
    try {
      for (const command of ["pbcopy", "wl-copy", "clip.exe"]) {
        const path = join(directory, command);
        await writeFile(
          path,
          `#!${process.execPath}\nawait Bun.write(${JSON.stringify(captured)}, await Bun.stdin.text());\n`,
        );
        await chmod(path, 0o700);
      }
      for (const command of ["pbpaste", "wl-paste"]) {
        const path = join(directory, command);
        await writeFile(
          path,
          `#!${process.execPath}\nprocess.stdout.write(await Bun.file(${JSON.stringify(captured)}).text());\n`,
        );
        await chmod(path, 0o700);
      }
      // Every candidate resolves in scratch; no real clipboard utility is reachable.
      process.env.PATH = directory;
      await run(directory, captured);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(directory, { recursive: true, force: true });
    }
  }

  test("writes exact text to the platform writer and verifies the readback", async () => {
    await withWriterFixture(async (_directory, captured) => {
      const text = "clipboard fixture: 界\nquotes ' and $() stay literal";
      const result = await writeClipboardText(text);
      expect(result.ok).toBe(true);
      expect(await readFile(captured, "utf8")).toBe(text);
    });
  });

  test("reports a successful writer whose readback does not match", async () => {
    await withWriterFixture(async (directory, captured) => {
      for (const command of ["pbpaste", "wl-paste"]) {
        await writeFile(
          join(directory, command),
          `#!${process.execPath}\nprocess.stdout.write("stale clipboard");\n`,
        );
      }
      const result = await writeClipboardText("new clipboard text");
      expect(result).toMatchObject({ ok: false, kind: "verification-failed" });
      expect(result.error).toContain("readback");
      expect(await readFile(captured, "utf8")).toBe("new clipboard text");
    });
  });

  test("surfaces a sensible error when no writer is on PATH", async () => {
    const empty = await mkdtemp(join(tmpdir(), "duet-clipboard-empty-"));
    const previousPath = process.env.PATH;
    process.env.PATH = empty;
    try {
      const result = await writeClipboardText("no-writer-on-path");
      expect(result).toMatchObject({ ok: false, kind: "no-writer" });
      expect(result.error).toBeDefined();
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(empty, { recursive: true, force: true });
    }
  });
});
