import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import {
  type BashOperations,
  createCodingTools,
  createLocalBashOperations,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { Ajv } from "ajv";
import dedent from "dedent";
import { systemReminder } from "../lib/system-reminder.js";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { toXML } from "../lib/xml.js";
import { parseDurationToMs, parseWakeAtToMs } from "./duration.js";
import type { TurnMode, TurnQuestion, TurnTodo } from "../types/protocol.js";
import type {
  StateMachineSession,
  StateMachineSessionEvent,
  StateMachineAgentState,
  StateMachineDefinition,
  StateMachinePollState,
  StateMachineParkState,
  StateMachineProgress,
  StateMachineScriptState,
  StateMachineState,
  StateMachineTimerState,
  StateMachineTerminalResult,
} from "../types/state-machine.js";
import { INTERRUPTED_STATE_MACHINE_STATE } from "../types/state-machine.js";
import type { EmbedFn } from "../memory/embedding.js";
import { recallMemoryExpanded, type RecallScope } from "../memory/recall.js";
import {
  buildAdvisorContext,
  type AdvisorExecutorContext,
} from "../model-routing/advisor-context.js";
import {
  ADVISOR_MAX_OUTPUT_TOKENS,
  callAdvisor,
  type AdvisorResult,
  type CallAdvisorInput,
} from "../model-routing/advisor.js";
import type { LanguageModelUsage } from "ai";
import { ASK_ADVISOR_TOOL_DESCRIPTION } from "../model-routing/prompts.js";
import type { AdvisorGate } from "../model-routing/router.js";
import type { Observation } from "../types/memory.js";
import type { MemorySession } from "../memory/session.js";
export type ActiveStateOutput =
  | { state?: string; kind: "agent"; output?: { assistantText?: string } }
  | { state: string; kind: "script" | "poll"; output?: ShellPartialOutput };
import { applyStateOverride } from "./state-machine-decisions.js";
import { withBundledRipgrep } from "./bundled-ripgrep.js";
import { SystemRuntimeClock, type RuntimeClock } from "./runtime-clock.js";
import { parkNudge } from "./prompts.js";
import { getBuiltInSkillInstructions } from "./built-in-skills.js";
import type { ShellPartialOutput } from "./shell-state-handle.js";

const jsonSchemaValidator = new Ajv({ strictSchema: false });

/**
 * Remove pi's kill-timeout input at the execution boundary. The public bash
 * `timeout` field is consumed by the task wrapper as a foreground wait budget;
 * only explicit task_stop, interrupt, or scope closure may abort the command.
 */
export function withoutBashKillTimeout(base: BashOperations): BashOperations {
  return {
    exec: (command, cwd, options) => base.exec(command, cwd, { ...options, timeout: undefined }),
  };
}

const questionOptionSchema = Type.Object(
  {
    label: Type.String({ description: "Answer text shown to the user." }),
    description: Type.Optional(
      Type.String({ description: "Optional context explaining this choice." }),
    ),
  },
  { additionalProperties: false },
);

const questionSchema = Type.Object(
  {
    question: Type.String({ description: "Question to ask the user." }),
    header: Type.Optional(
      Type.String({ description: "Optional section heading for this question." }),
    ),
    options: Type.Array(questionOptionSchema, {
      minItems: 1,
      description:
        "Answer options the user can choose from. Each question must have at least one option so the user has something to select.",
    }),
    multiSelect: Type.Optional(
      Type.Boolean({ description: "Whether the user may select more than one option." }),
    ),
  },
  { additionalProperties: false },
);

const askUserQuestionSchema = Type.Object(
  {
    questions: Type.Array(questionSchema, {
      description: "Structured multiple-choice questions that must be answered before continuing.",
    }),
  },
  { additionalProperties: false },
);

type AskUserQuestionParams = Static<typeof askUserQuestionSchema>;

const todoStatusSchema = Type.Union(
  [
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ],
  {
    description:
      "pending = not started; in_progress = actively being worked on (keep at most one); completed = done; failed = could not finish, leave a note in content if useful.",
  },
);

const todoItemSchema = Type.Object(
  {
    id: Type.String({
      description:
        "Stable unique identifier used to edit this todo in later calls. Pick something short and memorable so you can reuse it with merge=true to flip status.",
    }),
    content: Type.String({
      description:
        "Imperative description of the task, such as 'Run tests' or 'Update README model section'. One sentence; no narration.",
    }),
    status: todoStatusSchema,
  },
  { additionalProperties: false },
);

const todoWriteSchema = Type.Object(
  {
    merge: Type.Boolean({
      description:
        "false = replace the entire list (use this when you first plan the work). true = upsert by id (use this to flip a single todo's status without re-sending the rest).",
    }),
    todos: Type.Array(todoItemSchema, {
      description:
        "Todo items to write. With merge=false, pass the full desired list. With merge=true, pass only the items being added or updated.",
    }),
  },
  { additionalProperties: false },
);

type TodoWriteParams = Static<typeof todoWriteSchema>;

export interface TodoWriteToolStorage {
  getTodos(): TurnTodo[];
  setTodos(todos: TurnTodo[]): void;
}

const agentOverrideSchema = Type.Partial(
  Type.Object(
    {
      prompt: Type.String({ description: "Replacement user prompt for this agent state." }),
      systemPrompt: Type.String({
        description: "Replacement system prompt appended for this sub-agent only.",
      }),
      allowedSkills: Type.Array(Type.String(), {
        description:
          "Skill names to inject into this sub-agent. Omit to inject all available skills.",
      }),
      cwd: Type.String({
        description:
          "Replacement working directory for this sub-agent's coding tools (bash, read, write, edit). A relative path resolves against the session cwd; the directory must exist.",
      }),
      inputSchema: Type.Record(Type.String(), Type.Any(), {
        description:
          'Replacement valid JSON Schema object for transition input accepted by this state, such as { "type": "object", "properties": { "email": { "type": "string" }, "followUpCount": { "type": "integer" } }, "required": ["email"] }. Fields omitted from required are optional.',
      }),
      forkContext: Type.Boolean({
        description:
          "When true, this sub-agent starts with a verbatim copy of the parent runner's full conversation context instead of a fresh empty transcript. Defaults to false. Copies the entire parent transcript.",
      }),
    },
    { additionalProperties: false },
  ),
);

const scriptOverrideSchema = Type.Partial(
  Type.Object(
    {
      command: Type.String({ description: "Replacement shell command for this script state." }),
      cwd: Type.String({
        description: "Replacement working directory for the command.",
      }),
      timeoutMs: Type.Number({ description: "Replacement command timeout in milliseconds." }),
      successCodes: Type.Array(Type.Number(), {
        description: "Replacement exit codes treated as successful completion.",
      }),
      inputSchema: Type.Record(Type.String(), Type.Any(), {
        description:
          'Replacement valid JSON Schema object for transition input accepted by this state, such as { "type": "object", "properties": { "email": { "type": "string" }, "followUpCount": { "type": "integer" } }, "required": ["email"] }. Fields omitted from required are optional.',
      }),
    },
    { additionalProperties: false },
  ),
);

const pollOverrideSchema = Type.Partial(
  Type.Object(
    {
      intervalMs: Type.Union([Type.Number(), Type.String()], {
        description:
          'Replacement recurring delay between poll wake attempts. Accepts a duration string like "3h" or "5d", or a raw number of milliseconds.',
      }),
      timeoutMs: Type.Number({ description: "Replacement maximum poll-state runtime." }),
      command: Type.String({
        description: "Replacement shell command for one poll attempt.",
      }),
      cwd: Type.String({
        description: "Replacement working directory for the poll command.",
      }),
      successCodes: Type.Array(Type.Number(), {
        description: "Replacement exit codes that mean this poll attempt found a result.",
      }),
      inputSchema: Type.Record(Type.String(), Type.Any(), {
        description:
          'Replacement valid JSON Schema object for transition input accepted by this state, such as { "type": "object", "properties": { "messageId": { "type": "string" } }, "required": ["messageId"] }. Fields omitted from required are optional.',
      }),
    },
    { additionalProperties: false },
  ),
);

const timerOverrideSchema = Type.Partial(
  Type.Object(
    {
      wakeAt: Type.Union([Type.Number(), Type.String()], {
        description:
          'Replacement absolute wake time for this timer state. Accepts an ISO 8601 date string like "2026-05-24T18:00:00Z" or a Unix-epoch millisecond number.',
      }),
      wakeAfterMs: Type.Union([Type.Number(), Type.String()], {
        description:
          'Replacement relative duration measured from the moment the parent selects this timer state. Accepts a duration string like "3h" or "5d", or a raw number of milliseconds. Mutually exclusive with wakeAt.',
      }),
      inputSchema: Type.Record(Type.String(), Type.Any(), {
        description:
          'Replacement valid JSON Schema object for transition input accepted by this state, such as { "type": "object", "properties": { "scheduledAt": { "type": "number" } }, "required": ["scheduledAt"] }. Fields omitted from required are optional.',
      }),
    },
    { additionalProperties: false },
  ),
);

const parkOverrideSchema = Type.Partial(
  Type.Object(
    {
      inputSchema: Type.Record(Type.String(), Type.Any(), {
        description:
          "Replacement valid JSON Schema object for transition input accepted by this park state.",
      }),
    },
    { additionalProperties: false },
  ),
);

const stateOverrideSchema = Type.Union([
  Type.Object(
    { kind: Type.Literal("agent"), state: agentOverrideSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("script"), state: scriptOverrideSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("poll"), state: pollOverrideSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("timer"), state: timerOverrideSchema },
    { additionalProperties: false },
  ),
  Type.Object(
    { kind: Type.Literal("park"), state: parkOverrideSchema },
    { additionalProperties: false },
  ),
]);

const baseStateSchema = {
  name: Type.String({ description: "State name used by select_state_machine_state." }),
  when: Type.Optional(
    Type.String({ description: "Guidance for when the parent runner should select this state." }),
  ),
  inputSchema: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description:
        'Valid JSON Schema object for the input the parent must pass when selecting this state, such as { "type": "object", "properties": { "email": { "type": "string" }, "followUpCount": { "type": "integer" } }, "required": ["email"] }. Fields omitted from required are optional. Template strings read values from this object.',
    }),
  ),
};

const agentStateSchema = Type.Object(
  {
    ...baseStateSchema,
    kind: Type.Literal("agent", { description: "Run a sub-agent for this state." }),
    prompt: Type.String({
      description: "User prompt sent to the sub-agent. May use templates like {{ input.email }}.",
    }),
    systemPrompt: Type.Optional(
      Type.String({ description: "Optional system prompt appended for this sub-agent only." }),
    ),
    allowedSkills: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Skill names to inject into this sub-agent. Omit to inject all available skills.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description:
          "Working directory for this sub-agent's coding tools (bash, read, write, edit). Defaults to the state-machine session cwd; a relative path resolves against it. Must exist when the definition is created — for a directory an earlier state will create, set it on selection via decision.override.state.cwd instead.",
      }),
    ),
    forkContext: Type.Optional(
      Type.Boolean({
        description:
          "When true, the sub-agent starts with a verbatim copy of the parent runner's full conversation context instead of a fresh empty transcript. Defaults to false. Copies the entire parent transcript.",
      }),
    ),
  },
  { additionalProperties: false },
);

const scriptStateSchema = Type.Object(
  {
    ...baseStateSchema,
    kind: Type.Literal("script", { description: "Run a shell command for this state." }),
    command: Type.String({
      description: "Shell command to execute. May use templates like {{ input.email }}.",
    }),
    cwd: Type.Optional(
      Type.String({
        description:
          "Working directory for the command. Defaults to the state-machine session cwd.",
      }),
    ),
    timeoutMs: Type.Optional(Type.Number({ description: "Command timeout in milliseconds." })),
    successCodes: Type.Optional(
      Type.Array(Type.Number(), {
        description: "Exit codes treated as successful completion. Defaults to [0].",
      }),
    ),
  },
  { additionalProperties: false },
);

const pollStateSchema = Type.Object(
  {
    ...baseStateSchema,
    kind: Type.Literal("poll", { description: "Perform one external wait/check attempt." }),
    intervalMs: Type.Union([Type.Number(), Type.String()], {
      description:
        'Recurring delay before the next scheduled poll attempt. Accepts a duration string like "3h" or "5d", or a raw number of milliseconds. Minimum 30 seconds.',
    }),
    timeoutMs: Type.Optional(
      Type.Number({ description: "Maximum time this state may remain polling." }),
    ),
    command: Type.String({
      description:
        "Shell command for one poll attempt. It must exit with a success code (default 0) ONLY when the awaited condition is actually met; any other exit schedules the next attempt after intervalMs. An always-succeeding command reads as done on the first tick. Stdout is surfaced as the state output.",
    }),
    cwd: Type.Optional(
      Type.String({
        description:
          "Working directory for the poll command. Defaults to the state-machine session cwd.",
      }),
    ),
    successCodes: Type.Optional(
      Type.Array(Type.Number(), {
        description: "Exit codes that mean this poll attempt found a result.",
      }),
    ),
  },
  { additionalProperties: false },
);

const timerStateSchema = Type.Object(
  {
    ...baseStateSchema,
    kind: Type.Literal("timer", {
      description:
        "Sleep until a future time, then resume with elapsedMs and timestamp output. Specify exactly one of wakeAt (absolute) or wakeAfterMs (relative).",
    }),
    wakeAt: Type.Optional(
      Type.Union([Type.Number(), Type.String()], {
        description:
          'Absolute wake time when this timer state should complete. Accepts an ISO 8601 date string like "2026-05-24T18:00:00Z" or a Unix-epoch millisecond number. At least 30 seconds ahead. Mutually exclusive with wakeAfterMs.',
      }),
    ),
    wakeAfterMs: Type.Optional(
      Type.Union([Type.Number(), Type.String()], {
        description:
          'Relative duration measured from the moment the parent selects this timer state, after which the timer should complete. Accepts a duration string like "3h" or "5d", or a raw number of milliseconds. Minimum 30 seconds. Mutually exclusive with wakeAt.',
      }),
    ),
  },
  { additionalProperties: false },
);

const parkStateSchema = Type.Object(
  {
    ...baseStateSchema,
    kind: Type.Literal("park", {
      description:
        "Hold the machine without running work or scheduling a wake while the parent drives.",
    }),
  },
  { additionalProperties: false },
);

const terminalStateSchema = Type.Object(
  {
    ...baseStateSchema,
    kind: Type.Literal("terminal", { description: "Finalize the state-machine session." }),
    status: Type.Union([
      Type.Literal("completed", { description: "The state machine completed successfully." }),
      Type.Literal("failed", { description: "The state machine failed." }),
      Type.Literal("cancelled", { description: "The state machine was cancelled." }),
    ]),
    reason: Type.Optional(Type.String({ description: "Optional final explanation for the user." })),
  },
  { additionalProperties: false },
);

const stateMachineStateSchema = Type.Union([
  agentStateSchema,
  scriptStateSchema,
  pollStateSchema,
  timerStateSchema,
  parkStateSchema,
  terminalStateSchema,
]);

export type StateMachineAgentStateOverride = Partial<
  Pick<
    StateMachineAgentState,
    "prompt" | "systemPrompt" | "allowedSkills" | "cwd" | "inputSchema" | "forkContext"
  >
>;

export type StateMachineScriptStateOverride = Partial<
  Pick<StateMachineScriptState, "command" | "cwd" | "timeoutMs" | "successCodes" | "inputSchema">
>;

export type StateMachinePollStateOverride = Partial<
  Pick<
    StateMachinePollState,
    "intervalMs" | "timeoutMs" | "command" | "cwd" | "successCodes" | "inputSchema"
  >
>;
export type StateMachineTimerStateOverride = Partial<
  Pick<StateMachineTimerState, "wakeAt" | "wakeAfterMs" | "inputSchema">
>;
export type StateMachineParkStateOverride = Partial<Pick<StateMachineParkState, "inputSchema">>;

export type StateMachineStateOverride =
  | { kind: "agent"; state: StateMachineAgentStateOverride }
  | { kind: "script"; state: StateMachineScriptStateOverride }
  | { kind: "poll"; state: StateMachinePollStateOverride }
  | { kind: "timer"; state: StateMachineTimerStateOverride }
  | { kind: "park"; state: StateMachineParkStateOverride };

const stateMachineDefinitionSchema = Type.Object(
  {
    name: Type.String({ description: "Human-readable state-machine name." }),
    prompt: Type.String({
      description: "Routing guidance explaining when this state-machine definition applies.",
    }),
    states: Type.Array(stateMachineStateSchema, {
      description:
        'Available states the parent runner may select. At least one terminal with status "completed" is required; "failed" and "cancelled" terminals are added automatically when omitted.',
    }),
  },
  {
    additionalProperties: false,
    description:
      "State-machine definition. Use inputSchema plus {{ input.foo }} templates for state prompts and commands that need transition input.",
  },
);

const createDefinitionSchema = Type.Object(
  {
    definition: stateMachineDefinitionSchema,
    firstState: Type.String({
      description:
        "Name of the state in `definition.states` to run first after creating the definition.",
    }),
    replaceActive: Type.Optional(
      Type.Boolean({
        description:
          "Cancel the currently active state machine and start this one in its place. Without it, creating a definition while a machine is active is rejected.",
      }),
    ),
  },
  { additionalProperties: false },
);

type CreateDefinitionParams = Static<typeof createDefinitionSchema>;
type ToolStateMachineDefinition = CreateDefinitionParams["definition"];

const selectStateSchema = Type.Object(
  {
    decision: Type.Object(
      {
        state: Type.String({
          description:
            "Name of the state to advance to. Must exactly match one of the names declared in the active definition (including the auto-injected `failed` and `cancelled` terminals). Selecting a terminal ends the state machine; terminal selections accept only `state` and `reason`.",
        }),
        reason: Type.Optional(
          Type.String({
            description:
              "Free-form explanation attached to the resulting terminal when `state` names a terminal state. Ignored for non-terminal states.",
          }),
        ),
        override: Type.Optional(
          Type.Union(stateOverrideSchema.anyOf, {
            description:
              "Replacement fields for the selected state, applied before it runs. `kind` must match the state's declared kind. A poll override must keep intervalMs set; a timer override sets exactly one of wakeAt or wakeAfterMs.",
          }),
        ),
        persistOverride: Type.Optional(
          Type.Boolean({
            description:
              "When `override` is set: true (default) merges it into the active definition so every future run of this state uses it; false applies it to this transition only. Ignored when `override` is omitted.",
          }),
        ),
        input: Type.Optional(
          Type.Record(Type.String(), Type.Any(), {
            description:
              "Input object for the selected state. Required when the state inputSchema requires fields; templates read values as {{ input.field }}.",
          }),
        ),
      },
      {
        additionalProperties: false,
        description:
          "State transition decision. Use `input` when selecting states with inputSchema or {{ input.foo }} templates; `reason` carries through to terminal states.",
      },
    ),
  },
  { additionalProperties: false },
);

export interface CurrentStateMachineStateResult {
  currentState?: string;
  currentInput?: Record<string, unknown>;
  terminal?: StateMachineTerminalResult;
  /** Compact per-state counters for obvious progress questions. */
  progress?: StateMachineProgress;
  /** Total state-machine history records; `history` below is only the recent tail. */
  historyCount: number;
  /** Transient output from the currently running state, if one is active. */
  activeOutput?: ActiveStateOutput;
  history: StateMachineSessionEvent[];
}

// A runner decision is simply "go to this state, optionally with these
// transition extras". The state's own `kind` (agent/script/poll/timer/terminal)
// in the definition drives dispatch; the decision does not need to restate it.
// To end the machine in failure, select the auto-injected `failed` terminal
// (and optionally attach a `reason`) — there is no separate fail verb.
export interface StateMachineRunnerDecision {
  state: string;
  reason?: string;
  override?: StateMachineStateOverride;
  /**
   * When true (the default), an `override` is merged into the active
   * state-machine definition so future runs of the same state see the
   * tuned prompt/command/schedule. When false, the override applies only
   * to this transition and the stored definition is unchanged. Ignored
   * when `override` is undefined or when the target state is terminal.
   */
  persistOverride?: boolean;
  input?: Record<string, unknown>;
}

export type TurnRunnerControlResult =
  | { type: "none" }
  | ({
      type: "ask_user_question";
      questions: TurnQuestion[];
    } & AskUserQuestionParams)
  | ({
      type: "create_state_machine_definition";
      definition: ToolStateMachineDefinition;
    } & Pick<CreateDefinitionParams, "firstState">)
  | { type: "select_state_machine_state"; decision: StateMachineRunnerDecision };

export function isTurnRunnerControlResult(value: unknown): value is TurnRunnerControlResult {
  if (!value || typeof value !== "object" || !("type" in value)) return false;
  const type = value.type;
  return (
    type === "none" ||
    type === "ask_user_question" ||
    type === "create_state_machine_definition" ||
    type === "select_state_machine_state"
  );
}

interface TurnRunnerToolsInput {
  cwd: string;
  mode: TurnMode;
  todoStorage: TodoWriteToolStorage;
  getDefinition?: () => StateMachineDefinition | undefined;
  getStateMachine?: () => StateMachineSession | undefined;
  /** Persist an edited definition without selecting it; reject states with live execution or a scheduled wake. */
  updateStateDefinition?: (state: StateMachineState) => void;
  getActiveStateOutput?: () => ActiveStateOutput | undefined;
  skills?: readonly Skill[];
  recallStorage?: RecallMemoryToolStorage;
  advisorStorage?: AskAdvisorToolStorage;
  clock?: RuntimeClock;
  minimumScheduledDelayMs?: number;
}

export interface RecallMemoryToolStorage {
  /**
   * Returns the memory session backing the runner's durable memory, or
   * undefined when memory persistence is disabled (one-shot tools, tests).
   * The recall_memory tool no-ops when undefined so the model never sees a
   * tool whose backing store is missing. The session is fetched per call
   * so recall sees the runner's current persistence handle even after a
   * lazy load completes mid-session.
   */
  getSession: () => MemorySession | undefined;
  /**
   * Embedding callable. Optional: when undefined or when calls fail,
   * recall falls back to keyword-only retrieval. Built once per runner
   * by the embedding client so connection reuse amortizes TLS setup.
   */
  embed?: EmbedFn;
  /** Current session id for scope filtering. */
  sessionId?: string;
  /**
   * Model used by the optional `expand` flag to generate paraphrases.
   * Resolved by the runner so query expansion shares the same memory
   * model as the observer/reflector — typically a cheap model like
   * Haiku or Gemini Flash.
   */
  expansionModel?: string;
}

/** Lazy runtime inputs and router actions used by the parent-only advisor tool. */
export interface AskAdvisorToolStorage {
  /** Captures and policy-bounds executor context for the resolved advisor's hard window. */
  getContext: (contextWindowTokens: number) => Promise<AdvisorExecutorContext>;
  /** Resolves the advisor identity and hard model window lazily at tool execution. */
  resolveModel: () => {
    /** Gateway-native `provider/model` identifier passed to the shared gateway. */
    modelName: string;
    /** Advertised input-plus-output context window used as the final safety ceiling. */
    contextWindowTokens: number;
    /** Whether this concrete provider model accepts image request parts. */
    acceptsImages: boolean;
  };
  /** Reasoning effort selected by the routed tier. */
  thinkingLevel: ThinkingLevel;
  /** Atomically checks the floor and reserves the router's advisor slot when allowed. */
  advisorGate: () => AdvisorGate;
  /** Releases the reserved slot; false never stamps the floor or requests classification. */
  noteAdvisorConsult: (success?: boolean) => void;
  /** Attributes a completed advisor request to the running turn before the tool returns. */
  recordUsage: (usage: LanguageModelUsage) => void;
  /** Reports accounting failures without discarding advice the provider already returned. */
  onUsageError?: (error: unknown) => void;
  /** Reports a failed consultation while allowing the executor to continue. */
  onAdvisorError?: (error: unknown) => void;
  /** Network seam for deterministic tool tests; production uses callAdvisor. */
  callAdvisor?: (input: CallAdvisorInput) => Promise<AdvisorResult>;
}

/**
 * Built-in skills are advertised in the skills list at a virtual path
 * (`<duet-builtin>/<name>/SKILL.md`) that exists only in memory, and the
 * prompt tells the model to read a skill before acting on it. So the read
 * tool answers that path with the skill body instead of ENOENT; every other
 * path goes to the filesystem as before.
 */
function withBuiltInSkillReads(tool: AgentTool): AgentTool {
  return {
    ...tool,
    async execute(...args: Parameters<AgentTool["execute"]>) {
      const path = (args[1] as { path?: unknown }).path;
      const builtIn = typeof path === "string" ? getBuiltInSkillInstructions(path) : undefined;
      if (builtIn !== undefined) {
        return { content: [{ type: "text", text: builtIn }], details: undefined };
      }
      return tool.execute(...args);
    },
  };
}

export function createDefaultTurnRunnerTools(
  cwd: string,
  todoStorage: TodoWriteToolStorage,
  recallStorage?: RecallMemoryToolStorage,
  advisorStorage?: AskAdvisorToolStorage,
): AgentTool[] {
  const tools: AgentTool[] = [
    ...createCodingTools(cwd, {
      bash: {
        operations: withBundledRipgrep(withoutBashKillTimeout(createLocalBashOperations())),
      },
    }).map((tool) => (tool.name === "read" ? withBuiltInSkillReads(tool) : tool)),
    createTodoWriteTool(todoStorage),
    createAskUserQuestionTool(),
  ];
  if (recallStorage) {
    tools.push(createRecallMemoryTool(recallStorage));
  }
  if (advisorStorage) {
    tools.push(createAskAdvisorTool(advisorStorage));
  }
  return tools;
}

export function createTurnRunnerTools(input: TurnRunnerToolsInput): AgentTool[] {
  const tools = [
    ...createDefaultTurnRunnerTools(
      input.cwd,
      input.todoStorage,
      input.recallStorage,
      input.advisorStorage,
    ),
  ];
  if (input.mode === "agent") {
    return tools;
  }

  if (input.mode === "auto") {
    tools.push(
      createStateMachineDefinitionTool(input.getStateMachine, input.cwd, {
        clock: input.clock ?? new SystemRuntimeClock(),
        minimumScheduledDelayMs: input.minimumScheduledDelayMs ?? MINIMUM_STATE_MACHINE_DELAY_MS,
      }),
    );
  }

  const getDefinition = () =>
    input.getDefinition?.() ?? (typeof input.mode === "object" ? input.mode : undefined);
  tools.push(createSelectStateTool(getDefinition, input.cwd));
  if (input.updateStateDefinition) {
    tools.push(
      createUpdateStateTool(input.getStateMachine, input.updateStateDefinition, input.cwd),
    );
  }
  tools.push(createCurrentStateMachineStateTool(input.getStateMachine, input.getActiveStateOutput));
  return tools;
}

const askAdvisorSchema = Type.Object({}, { additionalProperties: false });

/** Build the no-parameter, non-terminating advisor consultation tool. */
export function createAskAdvisorTool(
  storage: AskAdvisorToolStorage,
): AgentTool<typeof askAdvisorSchema> {
  return {
    name: "ask_advisor",
    label: "Ask advisor",
    description: ASK_ADVISOR_TOOL_DESCRIPTION,
    parameters: askAdvisorSchema,
    async execute(...args) {
      const signal = args[2];
      const gate = storage.advisorGate();
      const endConsult = (success: boolean) => storage.noteAdvisorConsult(success);
      if (!gate.allowed) {
        const text = gate.inFlight
          ? "An advisor consultation is already in progress. Continue without starting another."
          : `The advisor was consulted too recently. Continue for ${gate.stepsUntilAllowed} more assistant step${gate.stepsUntilAllowed === 1 ? "" : "s"} before asking again.`;
        return {
          content: [{ type: "text", text }],
          details: {
            type: "ask_advisor",
            rateLimited: true,
            stepsUntilAllowed: gate.stepsUntilAllowed,
            ...(gate.inFlight ? { inFlight: true } : {}),
          },
          terminate: false,
        };
      }

      let resolvedModel: ReturnType<AskAdvisorToolStorage["resolveModel"]>;
      try {
        resolvedModel = storage.resolveModel();
        if (!resolvedModel.modelName) throw new Error("advisor model unavailable");
      } catch {
        endConsult(false);
        return {
          content: [
            {
              type: "text",
              text: "The advisor model is unavailable for the configured providers.",
            },
          ],
          details: { type: "ask_advisor", unavailable: true },
          terminate: false,
        };
      }
      try {
        const advisorContext = buildAdvisorContext({
          context: await storage.getContext(resolvedModel.contextWindowTokens),
          contextWindowTokens: resolvedModel.contextWindowTokens,
          reservedOutputTokens: ADVISOR_MAX_OUTPUT_TOKENS,
        });
        if (advisorContext.images.length > 0 && !resolvedModel.acceptsImages) {
          throw new Error(
            `Advisor model ${resolvedModel.modelName} cannot inspect ${advisorContext.images.length} image attachment(s).`,
          );
        }
        const result = await (storage.callAdvisor ?? callAdvisor)({
          contextText: advisorContext.text,
          images: advisorContext.images,
          modelName: resolvedModel.modelName,
          thinkingLevel: storage.thinkingLevel,
          signal,
        });
        try {
          storage.recordUsage(result.usage);
        } catch (error) {
          try {
            storage.onUsageError?.(error);
          } catch {
            // Logging is best-effort; valid advisor output still wins.
          }
        }
        endConsult(true);
        return {
          content: [{ type: "text", text: result.advice }],
          details: {
            type: "ask_advisor",
            model: resolvedModel.modelName,
            context: advisorContext.metadata,
          },
          terminate: false,
        };
      } catch (error) {
        endConsult(false);
        if (signal?.aborted) throw error;
        try {
          storage.onAdvisorError?.(error);
        } catch {
          // Logging is best-effort; the executor must still continue.
        }
        return {
          content: [
            {
              type: "text",
              text: "The advisor consultation failed. Continue using the available context.",
            },
          ],
          details: { type: "ask_advisor", failed: true },
          terminate: false,
        };
      }
    },
  };
}

/**
 * Builds the agent-facing error thrown when `create_state_machine_definition`
 * is called while a machine is still running and `replaceActive` was not set.
 * The message names the active machine and its current state so the agent —
 * which may not have realized a machine was running — can decide whether to
 * advance/end it with select_state_machine_state or deliberately replace it
 * with `replaceActive: true`.
 */
function activeStateMachineCreateError(session: StateMachineSession): string {
  const name = session.definition.name;
  const currentState = session.currentState ?? "unknown";
  const kind = session.definition.states.find((state) => state.name === currentState)?.kind;
  const stateDescription = kind ? `${currentState} (${kind})` : currentState;
  return dedent`
    Cannot create a new state machine: a state machine is already active.

    Active machine: "${name}", currently at state "${stateDescription}".

    Advance or end it with select_state_machine_state before creating a new one. If you instead intend to abandon this machine and run a different one in its place, call create_state_machine_definition again with replaceActive: true to cancel the active machine and replace it.
  `;
}

function createAskUserQuestionTool(): AgentTool<typeof askUserQuestionSchema> {
  return {
    name: "ask_user_question",
    executionMode: "sequential",
    label: "Ask user question",
    description:
      "Ask the user one or more structured multiple-choice questions. Use this when progress requires user input before continuing.",
    parameters: askUserQuestionSchema,
    async execute(_toolCallId, params) {
      // The schema declares minItems: 1 on options, but defend at runtime too:
      // some providers will still emit an empty options array, which would
      // leave the user with no answers to pick and stall the turn.
      const emptyIndex = params.questions.findIndex((question) => question.options.length === 0);
      if (emptyIndex !== -1) {
        throw new Error(
          `ask_user_question rejected: questions[${emptyIndex}] has no options. Each question must include at least one option.`,
        );
      }
      const result: TurnRunnerControlResult = {
        type: "ask_user_question",
        questions: params.questions,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
        terminate: true,
      };
    },
  };
}

const recallMemorySchema = Type.Object(
  {
    query: Type.String({
      description:
        "Free-text description of what to recall. Use proper nouns, code symbols, or short paraphrases of the user's prior statements; the search is hybrid (vector + keyword), so both fuzzy and exact matches work.",
    }),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 20,
        description: "Maximum results to return. Default 8.",
      }),
    ),
    scope: Type.Optional(
      Type.Union([Type.Literal("session"), Type.Literal("global"), Type.Literal("all")], {
        description:
          "'session' restricts to the current conversation, 'global' to every other session, 'all' (default) searches both.",
      }),
    ),
    expand: Type.Optional(
      Type.Boolean({
        description:
          "When true, the agent runs the original query plus two paraphrased variants and fuses the result sets. Useful when the first call returned weak results; off by default to keep latency low.",
      }),
    ),
  },
  { additionalProperties: false },
);

function createRecallMemoryTool(
  storage: RecallMemoryToolStorage,
): AgentTool<typeof recallMemorySchema> {
  return {
    name: "recall_memory",
    label: "Recall memory",
    description: dedent`
      Search the user's durable memory for facts, decisions, and prior context from past conversations.

      Hybrid retrieval (vector embeddings + keyword) ranks results by reciprocal rank fusion. Use \`scope: "global"\` to look only at other sessions, \`"session"\` for the current one, or \`"all"\` (default) when unsure. Pass \`expand: true\` to run paraphrased variants alongside the original query when a first pass returned weak results.
    `,
    parameters: recallMemorySchema,
    async execute(_toolCallId, params) {
      const session = storage.getSession();
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: "Memory persistence is disabled for this session, so there is nothing to recall.",
            },
          ],
          details: { type: "recall_memory", disabled: true },
        };
      }
      const scope: RecallScope = params.scope ?? "all";
      const limit = params.limit ?? 8;

      const { observations, vectorSearchAttempted, vectorSearchSucceeded, expanded } =
        await recallMemoryExpanded({
          session,
          ...(storage.embed ? { embed: storage.embed } : {}),
          query: params.query,
          limit,
          scope,
          ...(storage.sessionId ? { sessionId: storage.sessionId } : {}),
          // Only expand when the model asked for it and a paraphrase model is
          // configured; otherwise stay on the cheap single-query path.
          ...(params.expand && storage.expansionModel
            ? { expansionModel: storage.expansionModel }
            : {}),
        });

      const summary = observations.length
        ? observations.map(formatRecallHit).join("\n\n")
        : "(no matches)";
      // Degraded only when the vector path actually failed (embed threw
      // or the query errored). Zero vector hits from a healthy index are
      // a successful search and render the normal header.
      const header =
        vectorSearchAttempted && !vectorSearchSucceeded
          ? "# Memory recall (keyword-only fallback; semantic search unavailable)"
          : "# Memory recall";

      return {
        content: [{ type: "text", text: `${header}\n\n${summary}` }],
        details: {
          type: "recall_memory",
          query: params.query,
          scope,
          expanded,
          hits: observations.length,
          vectorSearchSucceeded,
        },
      };
    },
  };
}

function formatRecallHit(observation: Observation): string {
  // Mirror the rendering used in the static memory section so the
  // model sees one consistent shape across the prompt prefix and the
  // tool's tool-result payload.
  const time = observation.timeOfDay ? ` ${observation.timeOfDay}` : "";
  const referenced = observation.referencedDate ? ` [ref: ${observation.referencedDate}]` : "";
  const session = observation.sessionId ? ` (session ${observation.sessionId})` : "";
  const priority =
    observation.priority === "high" ? "HIGH" : observation.priority === "medium" ? "MED" : "LOW";
  return `- ${priority} ${observation.kind} ${observation.observedDate}${time}${referenced}${session}\n  ${observation.content}`;
}

export function createTodoWriteTool(
  storage: TodoWriteToolStorage,
): AgentTool<typeof todoWriteSchema> {
  return {
    name: "todo_write",
    label: "Write todos",
    description: dedent`
      Keep a visible todo list for multi-step work you are doing yourself in this conversation. The user sees it update in real time, so it is the shared record of what was agreed and where things stand.

      Use it when the user's message carries more than one independent ask you will handle yourself, when the work needs three or more non-trivial steps (research, edit, test, commit), when you are about to spend several tool calls and the user should be able to see and correct the plan first, or when you resume interrupted work and want its state explicit. Skip it for a one-shot answer or a single edit.

      Write the whole plan first with merge=false, with exactly one item in_progress. As each item finishes, call again with merge=true carrying only the items that changed: the finished one as completed and the next one as in_progress. When the plan changes, update the list at once so it stays honest. Once every item is completed or failed the list clears itself when your turn ends; clear it yourself (merge=false, empty todos) only when the plan is abandoned.
    `,
    parameters: todoWriteSchema,
    async execute(_toolCallId, params) {
      const todos = params.merge
        ? mergeTodos(storage.getTodos(), params.todos)
        : normalizeTodos(params.todos);
      storage.setTodos(todos);

      return {
        content: [{ type: "text", text: formatTodoWriteResult(todos) }],
        details: todos,
      };
    },
  };
}

function mergeTodos(existing: TurnTodo[], incoming: TodoWriteParams["todos"]): TurnTodo[] {
  const merged = existing.map((todo) => ({ ...todo }));
  const indexes = new Map(merged.map((todo, index) => [todo.id, index]));

  for (const todo of normalizeTodos(incoming)) {
    const index = indexes.get(todo.id);
    if (index === undefined) {
      indexes.set(todo.id, merged.length);
      merged.push(todo);
    } else {
      merged[index] = todo;
    }
  }

  return merged;
}

function normalizeTodos(todos: TodoWriteParams["todos"]): TurnTodo[] {
  return todos.map((todo) => ({ ...todo }));
}

function formatTodoWriteResult(todos: TurnTodo[]): string {
  if (todos.length === 0) return "Current task list is empty.";
  const lines = todos.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`);
  const body = ["Current task list:", ...lines].join("\n");
  const hasOpenTodos = todos.some(
    (todo) => todo.status === "pending" || todo.status === "in_progress",
  );
  if (!hasOpenTodos) return body;
  const reminder = dedent`
    <system-reminder>
    The todo list still has unfinished items. As you complete each one, call todo_write again with merge=true to flip its status to completed (and advance the next item to in_progress). Keep calling todo_write until every item is in a terminal state.
    </system-reminder>
  `;
  return `${body}\n\n${reminder}`;
}

/**
 * Build the prompt body delivered to the parent on its acknowledgment
 * turn — the extra parent prompt run by the turn runner after every
 * state-machine terminal so the parent gets to react to the outcome in
 * natural language before control returns to the user.
 *
 * The framing is deliberately neutral on "decided vs runtime failure":
 * the parent's own transcript already shows whether it selected the
 * terminal (its preceding `select_state_machine_state` tool call) or
 * whether the state machine ended on its own, and the terminal
 * `status`/`reason` carry the rest of what the parent needs to phrase
 * the reply. The prompt steers the parent toward a plain-text summary
 * and, by default, away from a control action on this turn: the machine
 * has ended, so the parent normally summarizes and returns control
 * rather than proactively starting more work. Follow-up work (new
 * machine or reactivation) is user-driven — it waits for the user's
 * request or a standing instruction to keep going, not the parent's own
 * initiative.
 */
export function formatStateMachineTerminalAcknowledgmentPrompt(input: {
  session: StateMachineSession;
}): string {
  const { session } = input;
  const terminal = session.terminal;
  if (!terminal) {
    throw new Error("formatStateMachineTerminalAcknowledgmentPrompt requires a terminal session.");
  }
  return systemReminder(dedent`
    The state machine "${session.definition.name}" has reached a terminal state and is no longer running.

    ${toXML({
      state_machine_terminal: {
        state: terminal.state,
        status: terminal.status,
        reason: terminal.reason ?? null,
      },
    })}

    Usually: reply to the user in plain text — summarize what happened and recommend what to do next, then let control return to them. Don't proactively spin up new work or resume this machine just because the tools are available.

    The exception is a standing instruction the user already gave: if they told you to keep going until the work is finished (or asked for follow-up this terminal does not yet satisfy), continuing is fine — call create_state_machine_definition for new work, or select a non-terminal state to reactivate and continue this machine. Absent that signal, default to summarizing and handing back.
  `);
}

export function formatCarriedTodosReminder(todos: TurnTodo[] | undefined): string | undefined {
  if (!todos || todos.length === 0) return undefined;
  const openTodos = todos.filter(
    (todo) => todo.status === "pending" || todo.status === "in_progress",
  );
  if (openTodos.length === 0) return undefined;
  const lines = todos.map((todo) => `- [${todo.status}] ${todo.id}: ${todo.content}`);
  return systemReminder(dedent`
    <system-reminder>
    You have an existing todo list from earlier in this conversation:
    ${lines.join("\n")}
    This list is shown to the user, so it must accurately reflect what you are actually working on right now. Update it with todo_write (merge=true) as you make progress, and keep calling todo_write until every item is in a terminal state. If the list is no longer relevant to the current request, call todo_write with merge=false and an empty todos array to clear it.
    </system-reminder>
  `);
}

function createStateMachineDefinitionTool(
  getStateMachine: (() => StateMachineSession | undefined) | undefined,
  // Base directory used to resolve a relative state `cwd` before checking it
  // exists, matching the resolution used when the state actually runs.
  baseCwd: string,
  scheduleValidation: {
    clock: RuntimeClock;
    minimumScheduledDelayMs: number;
  },
): AgentTool<typeof createDefinitionSchema> {
  return {
    name: "create_state_machine_definition",
    executionMode: "sequential",
    label: "Create state machine definition",
    description: dedent`
      Create a state machine and run its first state. Read the \`relay\` skill (its SKILL.md path is in your skills list) before your first call: it says when a machine is warranted and how to drive one. One state per independent unit of work, never one state for a whole phase; a state sees only its own prompt and the input passed to it. The parameters below say what each field means.

      Call shape (top-level keys are \`definition\`, \`firstState\`, and optional \`replaceActive\` ONLY — every state goes inside \`definition.states\`, never at the top level):
      {
        "definition": {
          "name": "<human-readable state-machine name>",
          "prompt": "<routing guidance for when this state machine applies>",
          "states": [
            { "name": "step-1", "kind": "agent", "prompt": "..." },
            { "name": "step-2", "kind": "script", "command": "..." },
            { "name": "done", "kind": "terminal", "status": "completed" }
          ]
        },
        "firstState": "step-1"
      }

      State \`kind\` is one of \`agent\` (a sub-agent runs the state), \`script\` (a shell command), \`poll\` (a command retried on an interval until it succeeds), \`timer\` (a single future wake), \`park\` (the machine holds while you drive), \`terminal\` (the machine ends). State prompts and script commands may use \`{{ input.foo }}\` templates, read from the \`input\` passed when the state is selected and declared by that state's \`inputSchema\`. The call ends your turn; the runner runs the first state and wakes you with its result.
    `,
    parameters: createDefinitionSchema,
    async execute(_toolCallId, params) {
      // Reject create-while-active unless the agent explicitly opts into
      // replacing the running machine. The control tools terminate the worker
      // turn after one call, so the agent could not end the old machine in this
      // same turn — requiring replaceActive forces it to acknowledge the active
      // machine instead of clobbering one it may not know is running. Throwing
      // (rather than returning) keeps the worker turn alive so the agent can
      // react to the error and either advance the active machine or retry with
      // replaceActive: true.
      const active = getStateMachine?.();
      if (active && !active.terminal && params.replaceActive !== true) {
        throw new Error(activeStateMachineCreateError(active));
      }
      assertValidDefinition(params.definition, baseCwd, scheduleValidation);
      const firstState = requireDefinedState(params.definition, params.firstState);
      const result: TurnRunnerControlResult = {
        type: "create_state_machine_definition",
        definition: params.definition,
        firstState: params.firstState,
      };
      const text =
        firstState.kind === "park"
          ? `${JSON.stringify(result, null, 2)}\n\n${parkNudge(firstState.name)}`
          : JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text", text }],
        details: result,
        terminate: true,
      };
    },
  };
}

function createSelectStateTool(
  getDefinition: (() => StateMachineDefinition | undefined) | undefined,
  // Base directory used to resolve a relative state/override `cwd` before
  // checking it exists. Mirrors how the runner resolves a per-state cwd
  // (`cwdOverride ?? config.cwd ?? process.cwd()`) so validation rejects the
  // same missing directory the sub-agent's tools would otherwise start in.
  baseCwd: string,
): AgentTool<typeof selectStateSchema> {
  return {
    name: "select_state_machine_state",
    executionMode: "sequential",
    label: "Select state machine state",
    description: dedent`
      Advance the active state machine to a named state, optionally overriding that state's fields and passing it input. Pass every selection field inside \`decision\`: {"decision":{"state":"work","input":{"email":"…"},"override":{"kind":"agent","state":{"prompt":"Updated task","cwd":"/absolute/worktree"}}}}. Top-level override/input/persistOverride fields are invalid. The call ends your turn; the runner runs the selected state and wakes you with its result. Selecting a terminal ends the machine and wakes you once more with the terminal details.
    `,
    parameters: selectStateSchema,
    async execute(_toolCallId, params) {
      const definition = getDefinition?.();
      const decision: StateMachineRunnerDecision = {
        state: params.decision.state,
        reason: params.decision.reason,
        override: params.decision.override as StateMachineStateOverride | undefined,
        persistOverride: params.decision.persistOverride,
        input: params.decision.input,
      };
      assertValidSelectedState(decision, definition, baseCwd);

      const result: TurnRunnerControlResult = { type: "select_state_machine_state", decision };
      const selectedState = definition?.states.find((state) => state.name === decision.state);
      const text =
        selectedState?.kind === "park"
          ? `${JSON.stringify(result, null, 2)}\n\n${parkNudge(selectedState.name)}`
          : JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text", text }],
        details: result,
        terminate: true,
      };
    },
  };
}

const updateStateSchema = Type.Object(
  {
    state: Type.String({ description: "Name of an existing state to edit without executing it." }),
    override: stateOverrideSchema,
  },
  { additionalProperties: false },
);

function createUpdateStateTool(
  getStateMachine: (() => StateMachineSession | undefined) | undefined,
  updateStateDefinition: (state: StateMachineState) => void,
  baseCwd: string,
): AgentTool<typeof updateStateSchema> {
  return {
    name: "update_state_machine_state",
    executionMode: "sequential",
    label: "Update state machine state",
    description: dedent`
      Change a state's fields in the active definition without selecting or running it. The current
      state, its input, running tasks, and scheduled wake stay unchanged, and the call does not end
      your turn. The override has the same shape as in select_state_machine_state. A state with a
      running task or scheduled wake, and any terminal state, cannot be edited here.
    `,
    parameters: updateStateSchema,
    async execute(_toolCallId, params) {
      const session = getStateMachine?.();
      if (!session) throw new Error("No state machine exists to edit.");
      const selected = session.definition.states.find((state) => state.name === params.state);
      if (!selected) throw new Error(`Unknown state: ${params.state}.`);
      if (selected.kind === "terminal") throw new Error("Terminal states cannot be edited.");
      const updated = validatedStateOverride(selected, params.override, baseCwd);
      updateStateDefinition(updated);
      const details = { type: "state_definition_updated", state: updated };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };
}

function createCurrentStateMachineStateTool(
  getStateMachine: (() => StateMachineSession | undefined) | undefined,
  getActiveStateOutput: (() => ActiveStateOutput | undefined) | undefined,
): AgentTool {
  return {
    name: "get_current_state_machine_state",
    label: "Get current state-machine state",
    description:
      "Read the active state machine: current state and input, terminal, progress, history, and the output of background work that ran after a state was selected. Takes no parameters.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() {
      const stateMachine = getStateMachine?.();
      const activeOutput = getActiveStateOutput?.();
      const result: CurrentStateMachineStateResult = {
        currentState: stateMachine?.currentState,
        currentInput: stateMachine?.currentInput,
        terminal: stateMachine?.terminal,
        progress: stateMachine?.progress,
        historyCount: stateMachine?.history.length ?? 0,
        history: stateMachine?.history.slice(-10) ?? [],
      };
      if (activeOutput) {
        result.activeOutput = activeOutput;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

function requireDefinedState(definition: StateMachineDefinition, name: string): StateMachineState {
  const state = definition.states.find((state) => state.name === name);
  if (!state) {
    throw new Error(
      `Unknown state: ${name}. Valid states: ${definition.states.map((state) => state.name).join(", ")}`,
    );
  }
  return state;
}

function assertValidSelectedState(
  decision: StateMachineRunnerDecision,
  definition: StateMachineDefinition | undefined,
  baseCwd: string,
): void {
  if (!definition) return;

  const selectedState = requireDefinedState(definition, decision.state);

  // A minimal terminal selection always escapes a broken state's inputs/cwd.
  // Extra control fields must not look accepted when no work will consume them.
  if (selectedState.kind === "terminal") {
    if (
      decision.override !== undefined ||
      decision.input !== undefined ||
      decision.persistOverride !== undefined
    ) {
      throw new Error(
        "Terminal states accept only decision.state and decision.reason; omit override, input, and persistOverride.",
      );
    }
    return;
  }

  const effectiveState = validatedStateOverride(selectedState, decision.override, baseCwd);
  assertValidStateInput(effectiveState, decision.input);
}

function validatedStateOverride(
  selectedState: StateMachineState,
  override: StateMachineStateOverride | undefined,
  baseCwd: string,
): StateMachineState {
  // applyStateOverride ignores kind mismatches, so reject rather than report an edit it dropped.
  if (override && override.kind !== selectedState.kind) {
    throw new Error(
      `Override kind "${override.kind}" does not match state "${selectedState.name}", which is a "${selectedState.kind}" state. Set the override kind to "${selectedState.kind}" so the override is applied instead of silently dropped.`,
    );
  }
  const effectiveState = applyStateOverride(selectedState, override);
  assertValidStateInputSchema(effectiveState);
  assertValidStateSchedule(effectiveState);
  assertValidStateCwd(effectiveState, baseCwd, SELECT_CWD_GUIDANCE);
  return effectiveState;
}

// Appended to the "cwd does not exist" error depending on where validation
// runs. At selection time the directory should already exist (an earlier
// state had a chance to create it). At creation time it often does not exist
// yet, so the right move is usually to omit cwd now and set it via
// decision.override.state.cwd on select_state_machine_state once the directory is created.
const SELECT_CWD_GUIDANCE =
  "Set the overridden state's cwd to a directory that exists — typically the worktree or clone an earlier state created.";
const CREATE_CWD_GUIDANCE =
  "If an earlier state creates this directory at runtime, omit cwd here and set it via decision.override.state.cwd on select_state_machine_state once the directory exists. Otherwise point it at a directory that already exists.";

// Resolve a per-state `cwd` (from a state definition or an override) against
// the runner's base cwd. A relative path resolves against `baseCwd` — the
// runner's config.cwd, set by --workDir, falling back to process.cwd() — so it
// lands in the directory the `<cwd>` system-prompt block advertises rather than
// the launching process's cwd, which Node would otherwise use. Used by both the
// runtime (agent/script/poll execution) and the select/create validators so a
// cwd is resolved identically wherever it is checked or run. `undefined`
// (no per-state cwd) falls back to the base.
export function resolveStateCwd(cwd: string | undefined, baseCwd: string): string {
  if (cwd === undefined) return resolve(baseCwd);
  return isAbsolute(cwd) ? cwd : resolve(baseCwd, cwd);
}

// A per-state `cwd` (from the definition or an override) becomes the working
// directory the sub-agent's coding tools start in. A path that does not exist
// or is not a directory lands the sub-agent in a broken/empty tree where it
// finds none of the files it was told to work on and reports "nothing to do".
function assertValidStateCwd(state: StateMachineState, baseCwd: string, guidance: string): void {
  const cwd =
    state.kind === "agent" || state.kind === "script" || state.kind === "poll"
      ? state.cwd
      : undefined;
  if (!cwd) return;

  const resolved = resolveStateCwd(cwd, baseCwd);
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(resolved);
  } catch {
    throw new Error(
      `cwd "${cwd}" for state "${state.name}" does not exist (resolved to "${resolved}"). ${guidance}`,
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(
      `cwd "${cwd}" for state "${state.name}" is not a directory (resolved to "${resolved}").`,
    );
  }
}

function assertValidStateInput(state: StateMachineState, input: unknown): void {
  if (!state.inputSchema) return;

  const candidate = input ?? {};
  if (Value.Check(state.inputSchema as never, candidate)) return;

  const errors = [...Value.Errors(state.inputSchema as never, candidate)];
  const first = errors[0] as { path?: string; message?: string } | undefined;
  const path = first?.path ?? "/";
  const message = first?.message ?? "does not match schema";
  throw new Error(`Invalid input for state "${state.name}" at ${path}: ${message}`);
}

// Minimum poll/timer cadence. State machines are for long-running lifecycle
// work that survives sleeps, wakes, and background execution; anything shorter
// than this should be performed directly in the parent turn rather than paid
// for with the orchestration overhead of a state machine.
export const MINIMUM_STATE_MACHINE_DELAY_MS = 30_000;

function assertValidDefinition(
  definition: StateMachineDefinition,
  baseCwd: string,
  scheduleValidation: { clock: RuntimeClock; minimumScheduledDelayMs: number },
): void {
  for (const state of definition.states) {
    if (state.name === INTERRUPTED_STATE_MACHINE_STATE) {
      throw new Error(`State name "${INTERRUPTED_STATE_MACHINE_STATE}" is reserved.`);
    }
    assertValidStateInputSchema(state);
    assertValidStateSchedule(state);
    assertValidStateScheduleMinimum(state, scheduleValidation);
    assertValidStateCwd(state, baseCwd, CREATE_CWD_GUIDANCE);
  }
  injectMissingTerminalEscapeHatches(definition);
  assertHasCompletedTerminal(definition);
}

// The author defines the happy-path exit; failed/cancelled escape hatches are
// added automatically so every definition can always be aborted or finalized
// without forcing the caller to remember boilerplate terminal states.
function injectMissingTerminalEscapeHatches(definition: StateMachineDefinition): void {
  const existingNames = new Set(definition.states.map((state) => state.name));
  if (!existingNames.has("failed")) {
    definition.states.push({ kind: "terminal", name: "failed", status: "failed" });
  }
  if (!existingNames.has("cancelled")) {
    definition.states.push({ kind: "terminal", name: "cancelled", status: "cancelled" });
  }
}

function assertHasCompletedTerminal(definition: StateMachineDefinition): void {
  const hasCompletedTerminal = definition.states.some(
    (state) => state.kind === "terminal" && state.status === "completed",
  );
  if (!hasCompletedTerminal) {
    throw new Error(
      'State-machine definition must include at least one terminal state with status "completed" representing successful completion of the lifecycle.',
    );
  }
}

function assertValidStateInputSchema(state: StateMachineState): void {
  if (!state.inputSchema) return;

  if (jsonSchemaValidator.validateSchema(state.inputSchema)) return;

  const message = jsonSchemaValidator.errorsText(jsonSchemaValidator.errors, {
    dataVar: `inputSchema for state "${state.name}"`,
  });
  throw new Error(`Invalid inputSchema for state "${state.name}": ${message}`);
}

// Shape validation: intervalMs / wakeAt must be present and parseable. Runs at
// both definition creation and state selection so malformed overrides are
// rejected too. Duration strings like "3h" / "5d" are accepted alongside raw
// millisecond numbers; ISO 8601 strings are accepted for absolute wakeAt.
function assertValidStateSchedule(state: StateMachineState): void {
  if (state.kind === "poll") {
    parseDurationToMs(
      state.intervalMs,
      `Invalid poll schedule for state "${state.name}": intervalMs`,
    );
  }
  if (state.kind === "timer") {
    const hasWakeAt = state.wakeAt !== undefined;
    const hasWakeAfter = state.wakeAfterMs !== undefined;
    if (hasWakeAt === hasWakeAfter) {
      throw new Error(
        `Invalid timer schedule for state "${state.name}": specify exactly one of wakeAt or wakeAfterMs.`,
      );
    }
    if (hasWakeAt) {
      parseWakeAtToMs(state.wakeAt, `Invalid timer schedule for state "${state.name}": wakeAt`);
    } else {
      parseDurationToMs(
        state.wakeAfterMs,
        `Invalid timer schedule for state "${state.name}": wakeAfterMs`,
      );
    }
  }
}

// Minimum-cadence guidance: enforced only when a new definition is being
// created. Existing definitions handed to the runner via `mode:` may legitimately
// have shorter cadences from configuration the agent did not author, and the
// runtime should run them as-is rather than re-litigating the boundary.
function assertValidStateScheduleMinimum(
  state: StateMachineState,
  input: { clock: RuntimeClock; minimumScheduledDelayMs: number },
): void {
  if (state.kind === "poll" && state.intervalMs !== undefined) {
    const intervalMs = parseDurationToMs(
      state.intervalMs,
      `Invalid poll schedule for state "${state.name}": intervalMs`,
    );
    if (intervalMs < input.minimumScheduledDelayMs) {
      throw new Error(
        `Invalid poll schedule for state "${state.name}": intervalMs must be at least ${scheduleFloorDescription(input.minimumScheduledDelayMs, true)}. Anything shorter should run directly in the parent turn instead of through a state machine.`,
      );
    }
  }
  if (state.kind === "timer" && state.wakeAt !== undefined) {
    const wakeAt = parseWakeAtToMs(
      state.wakeAt,
      `Invalid timer schedule for state "${state.name}": wakeAt`,
    );
    const minWakeAt = input.clock.now() + input.minimumScheduledDelayMs;
    if (wakeAt < minWakeAt) {
      throw new Error(
        `Invalid timer schedule for state "${state.name}": wakeAt must be at least ${scheduleFloorDescription(input.minimumScheduledDelayMs)} in the future. Anything shorter should run directly in the parent turn instead of through a state machine.`,
      );
    }
  }
  if (state.kind === "timer" && state.wakeAfterMs !== undefined) {
    const wakeAfterMs = parseDurationToMs(
      state.wakeAfterMs,
      `Invalid timer schedule for state "${state.name}": wakeAfterMs`,
    );
    if (wakeAfterMs < input.minimumScheduledDelayMs) {
      throw new Error(
        `Invalid timer schedule for state "${state.name}": wakeAfterMs must be at least ${scheduleFloorDescription(input.minimumScheduledDelayMs, true)}. Anything shorter should run directly in the parent turn instead of through a state machine.`,
      );
    }
  }
}

function scheduleFloorDescription(delayMs: number, includeMilliseconds = false): string {
  if (delayMs === MINIMUM_STATE_MACHINE_DELAY_MS) {
    return includeMilliseconds ? `30 seconds (${delayMs} ms)` : "30 seconds";
  }
  return `${delayMs} ms`;
}
