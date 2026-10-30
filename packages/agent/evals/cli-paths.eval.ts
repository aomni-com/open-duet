import { afterEach, describe, expect } from "bun:test";
import dedent from "dedent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CLI_MEMORY_MODEL } from "../src/model-resolution/resolver.js";
import type { TurnEvent } from "../src/types/protocol.js";
import { testIfDocker } from "../test/helpers/docker-only.js";

const children = new Set<ReturnType<typeof Bun.spawn>>();
afterEach(async () => {
  for (const child of children) child.kill();
  await Promise.all([...children].map((child) => child.exited));
  children.clear();
});

const model = process.env.EVAL_MODEL ?? "sonnet-5";
const memoryModel = process.env.EVAL_MEMORY_MODEL ?? DEFAULT_CLI_MEMORY_MODEL;

describe("CLI production paths", () => {
  testIfDocker(
    "observes memory through the JSONL CLI path",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-cli-memory-"));
      try {
        const marker = "cli-memory-marker-742";
        const result = await runCliEvents([
          "--workdir",
          workDir,
          "--db",
          join(workDir, "memory.db"),
          "--model",
          model,
          "--memory-model",
          memoryModel,
          dedent`
            Remember that ${marker} belongs to the CLI memory eval.
            Reply in one sentence that you have noted the marker.
          `,
        ]);

        expect(result.exitCode).toBe(0);
        expect(findLastTerminal(result.events)?.type).toBe("complete");
        const observations = result.events.flatMap((event) =>
          event.type === "memory" && event.phase === "observation" && event.status === "completed"
            ? (event.observations ?? [])
            : [],
        );
        expect(observations.some((entry) => entry.content.includes(marker))).toBe(true);
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    180_000,
  );

  testIfDocker(
    "runs a script state machine through the JSONL CLI path",
    async () => {
      const workDir = await mkdtemp(join(tmpdir(), "duet-cli-state-machine-"));
      try {
        const marker = "cli-script-marker-913";
        const result = await runCliEvents([
          "--workdir",
          workDir,
          "--model",
          model,
          "--incognito",
          "--system-prompt",
          dedent`
            This is a live eval. Use the state-machine tools, not a plain answer.
            Create a state machine named cli_script_eval with exactly these states:
            1. script state render_marker with command: printf 'marker=${marker}\\nstatus=script-ran\\n'
            2. terminal state done with status completed.
            Start with render_marker. After render_marker completes, select done.
            Do not ask the user questions.
          `,
          `Run the CLI script state-machine eval for marker ${marker}.`,
        ]);

        expect(result.exitCode).toBe(0);
        const terminal = findLastTerminal(result.events);
        expect(terminal?.type).toBe("complete");
        expect(terminal?.state.stateMachine?.terminal?.status).toBe("completed");
        const execution = terminal?.state.stateMachine?.history.find(
          (entry) => entry.type === "state_completed" && entry.state === "render_marker",
        );
        expect(execution?.type === "state_completed" ? execution.output : undefined).toMatchObject({
          stdout: `marker=${marker}\nstatus=script-ran`,
          stderr: "",
          exitCode: 0,
        });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

async function runCliEvents(args: string[]): Promise<{ exitCode: number; events: TurnEvent[] }> {
  // --no-skill-sync skips the service.example.invalid default-skill fetch the CLI normally runs
  // at startup when DUET_API_KEY is set. The eval asserts CLI behavior, not
  // that side effect; disabling it keeps the temp workdir and JSONL stream
  // focused on the path under test without dropping gateway auth.
  const proc = Bun.spawn(
    [
      "bun",
      new URL("../../duet/src/cli-entry.ts", import.meta.url).pathname,
      "--no-skill-sync",
      ...args,
    ],
    {
      cwd: args[args.indexOf("--workdir") + 1]!,
      env: { ...process.env, HOME: args[args.indexOf("--workdir") + 1]! },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  children.add(proc);
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  try {
    const [out, errors, exitCode] = await Promise.all([stdout, stderr, proc.exited]);
    if (exitCode !== 0) throw new Error(`CLI failed (${exitCode}): ${errors}`);
    return { exitCode, events: parseJsonEvents(out) };
  } finally {
    proc.kill();
    await Promise.all([stdout, stderr, proc.exited]);
    children.delete(proc);
  }
}

function parseJsonEvents(stdout: string): TurnEvent[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TurnEvent);
}

function findLastTerminal(
  events: TurnEvent[],
): Extract<TurnEvent, { type: "complete" | "ask" | "interrupted" | "sleep" }> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (
      event?.type === "complete" ||
      event?.type === "ask" ||
      event?.type === "interrupted" ||
      event?.type === "sleep"
    ) {
      return event;
    }
  }
  return undefined;
}
