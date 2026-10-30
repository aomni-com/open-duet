import { describe, expect } from "bun:test";
import { runShellState } from "./helpers/run-shell-state.js";
import { testIfDocker } from "./helpers/docker-only.js";

// A poll succeeds from its exit status. Empty/plain/JSON stdout is output,
// never a second readiness condition.
describe("poll-state success contract", () => {
  for (const [name, command, output] of [
    ["empty stdout", "true", { stdout: "", parsed: {} }],
    ["plain-text stdout", "printf check-duet-inbox", { stdout: "check-duet-inbox", parsed: {} }],
    [
      "JSON stdout",
      'printf \'{"agent":"check-duet-inbox"}\'',
      { parsed: { agent: "check-duet-inbox" } },
    ],
  ] as const) {
    testIfDocker(`exit 0 with ${name} completes the poll and surfaces the output`, async () => {
      const terminal = await runShellState({
        kind: "poll",
        name: "check",
        intervalMs: 60_000,
        command,
      });
      expect(terminal).toMatchObject({ type: "complete", status: "completed" });
      expect(terminal.state.stateMachine?.history).toContainEqual(
        expect.objectContaining({
          type: "state_completed",
          state: "check",
          output: expect.objectContaining({ exitCode: 0, ...output }),
        }),
      );
    });
  }

  testIfDocker("non-success exit sleeps and re-arms the poll", async () => {
    const terminal = await runShellState({
      kind: "poll",
      name: "check",
      intervalMs: 60_000,
      command: "exit 1",
    });
    expect(terminal).toMatchObject({ type: "sleep", wakeAt: 61_000 });
    expect(
      terminal.state.stateMachine?.history.filter((entry) => entry.type === "state_completed"),
    ).toEqual([]);
  });

  testIfDocker("custom successCodes complete matching exits and re-arm other exits", async () => {
    const poll = { kind: "poll" as const, name: "check", intervalMs: 60_000, successCodes: [7] };
    const completed = await runShellState({ ...poll, command: "exit 7" });
    expect(completed).toMatchObject({ type: "complete", status: "completed" });
    expect(completed.state.stateMachine?.history).toContainEqual(
      expect.objectContaining({
        type: "state_completed",
        state: "check",
        output: expect.objectContaining({ exitCode: 7 }),
      }),
    );
    expect(await runShellState({ ...poll, command: "exit 0" })).toMatchObject({
      type: "sleep",
      wakeAt: 61_000,
    });
  });
});
