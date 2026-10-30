import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect } from "bun:test";
import { testIfDocker } from "../test/helpers/docker-only.js";

const processes: ReturnType<typeof Bun.spawn>[] = [];
const scratchDirs: string[] = [];
afterEach(async () => {
  const owned = processes.splice(0);
  for (const proc of owned) if (proc.exitCode === null) proc.kill();
  await Promise.all(owned.map((proc) => proc.exited));
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function scratchDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), "duet-model-"));
  scratchDirs.push(dir);
  return dir;
}

function spawnCommand(command: string[]) {
  const proc = Bun.spawn(command, {
    cwd: process.cwd(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  processes.push(proc);
  return Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
}

async function expectImageContainer(path: string): Promise<void> {
  const bytes = await readFile(path);
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp =
    bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP";
  expect(png || jpeg || webp, `No supported image container at ${path}`).toBe(true);
}

async function expectVideoContainer(path: string): Promise<void> {
  const bytes = await readFile(path);
  const mp4 = bytes.toString("ascii", 4, 8) === "ftyp";
  const webm = bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  expect(mp4 || webm, `No supported video container at ${path}`).toBe(true);
}

// `duet model` passes -m straight to the gateway, so evals use full gateway
// slugs, not pi shorthands. Defaults retain inexpensive text/image/fast-video lanes.
const textModel = process.env.EVAL_MODEL ?? "anthropic/claude-haiku-4.5";
const imageModel = process.env.EVAL_IMAGE_MODEL ?? "openai/gpt-image-1-mini";
const videoModel = process.env.EVAL_VIDEO_MODEL ?? "bytedance/seedance-2.0-fast";
const nanoBananaModel = process.env.EVAL_NANO_BANANA_MODEL ?? "google/gemini-3.1-flash-image";

/**
 * `duet model` talks to a gateway model directly through the AI SDK, bypassing
 * the agent harness. The text path streams a completion straight to stdout, so a
 * live round-trip is the cleanest proof the gateway provider, auth, and request
 * routing all line up: a real model must produce the requested word for a trivial
 * prompt. Routes through the duet gateway with DUET_API_KEY, which the docker
 * eval container forwards.
 */
describe("duet model direct CLI", () => {
  testIfDocker(
    "streams the requested text completion from the gateway",
    async () => {
      const [stdout, stderr, exitCode] = await spawnCommand([
        "bun",
        new URL("../../duet/src/cli-entry.ts", import.meta.url).pathname,
        "model",
        "-m",
        textModel,
        "Reply with the single word: pong",
      ]);
      expect(exitCode, stderr).toBe(0);
      expect(stdout.trim()).toBe("pong");
    },
    120_000,
  );

  testIfDocker(
    "generates an image file from a dedicated image model",
    async () => {
      const out = join(scratchDirectory(), "art.png");
      const [_stdout, stderr, exitCode] = await spawnCommand([
        "bun",
        new URL("../../duet/src/cli-entry.ts", import.meta.url).pathname,
        "model",
        "-m",
        imageModel,
        "--type",
        "image",
        "-o",
        out,
        "a red fox",
      ]);
      expect(exitCode, stderr).toBe(0);
      await expectImageContainer(out);
    },
    180_000,
  );

  // Nano-banana is a `language` model that emits images, so --type image routes
  // through generateText + result.files, and --image must inline the source so
  // the model edits it. Generate a source image, then edit it through that path.
  testIfDocker(
    "edits an image through a nano-banana language model with --image",
    async () => {
      const dir = scratchDirectory();
      const src = join(dir, "fox.png");
      const edited = join(dir, "edited.png");
      const [_generated, genError, genExit] = await spawnCommand([
        "bun",
        new URL("../../duet/src/cli-entry.ts", import.meta.url).pathname,
        "model",
        "-m",
        imageModel,
        "--type",
        "image",
        "-o",
        src,
        "a red fox",
      ]);
      expect(genExit, genError).toBe(0);

      const [_stdout, stderr, exitCode] = await spawnCommand([
        "bun",
        new URL("../../duet/src/cli-entry.ts", import.meta.url).pathname,
        "model",
        "-m",
        nanoBananaModel,
        "--type",
        "image",
        "--image",
        src,
        "-o",
        edited,
        "add a blue hat",
      ]);
      expect(exitCode, stderr).toBe(0);
      await expectImageContainer(src);
      await expectImageContainer(edited);
    },
    240_000,
  );

  testIfDocker(
    "generates a video file from a video model",
    async () => {
      const out = join(scratchDirectory(), "clip.mp4");
      const [_stdout, stderr, exitCode] = await spawnCommand([
        "bun",
        new URL("../../duet/src/cli-entry.ts", import.meta.url).pathname,
        "model",
        "-m",
        videoModel,
        "--type",
        "video",
        "-o",
        out,
        "slow pan over dunes",
      ]);
      expect(exitCode, stderr).toBe(0);
      await expectVideoContainer(out);
    },
    600_000,
  );
});
