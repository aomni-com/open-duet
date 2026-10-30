import type { Skill } from "@earendil-works/pi-coding-agent";
import dedent from "dedent";
import { systemReminder } from "../lib/system-reminder.js";
import { toXML } from "../lib/xml.js";
import { ADVISOR_EXECUTOR_GUIDANCE_LAYER } from "../model-routing/prompts.js";
import { RELAY_ORCHESTRATION_RULES } from "./built-in-skills.js";
import type { TurnRunnerConfig } from "../types/config.js";
import type { TurnMode, TurnQuestion, TurnState } from "../types/protocol.js";
import type { StateMachineDefinition } from "../types/state-machine.js";

function cwdSystemPrompt(cwd: string): string {
  return dedent`
    <cwd>
    Current working directory: ${cwd}.
    Before responding to a request that touches files, code, or project state, spend a tool call or two exploring this directory (e.g. \`ls\`, \`rg\`, \`read\`) so your answer reflects what is actually here rather than assumptions. Skip exploration only for requests that are clearly unrelated to the workspace.
    </cwd>
  `;
}

function currentDateSystemPrompt(): string {
  // Day-level resolution keeps the prompt stable for the whole UTC day so prompt
  // caching is not invalidated on every turn. Agents that need finer-grained
  // time should shell out via bash (e.g. `date`).
  const today = new Date().toISOString().slice(0, 10);
  return dedent`
    <current_date>
    Today's date (UTC): ${today}. Resolution is intentionally limited to the day to preserve prompt caching. If you need finer-grained time, run \`date\` via bash.
    </current_date>
  `;
}

const TOOL_EXECUTION_SYSTEM_PROMPT = dedent`
  <use_parallel_tool_calls>
  For maximum efficiency, whenever you perform multiple independent operations, invoke all relevant tools simultaneously rather than sequentially. Prioritize calling tools in parallel whenever possible. For example, when reading 3 files, run 3 tool calls in parallel to read all 3 files into context at the same time. When running multiple read-only commands like \`ls\` or \`list_dir\`, always run all of the commands in parallel. Err on the side of maximizing parallel tool calls rather than running too many tools sequentially.
  </use_parallel_tool_calls>

  <bash_timeout>
  Bash commands are task-backed. The optional \`timeout\` argument is a foreground wait budget in seconds: when it expires, the command keeps running in the background and you receive a task id. It never kills the command. Use \`run_in_background\` to return immediately, \`task_output\` to inspect or wait for a task, and \`task_stop\` to stop one explicitly. Scope commands carefully — only task_stop, interrupt, or scope closure aborts their process groups.
  </bash_timeout>
`;

export function createSystemPromptWithAppendedLayers(input: {
  config: TurnRunnerConfig;
  skills: readonly Skill[];
  systemPromptFiles: string[];
  // Layers placed before the host's systemInstructions, so they establish the
  // agent's primary role ahead of host-provided instructions.
  prepend?: Array<string | undefined>;
  // Layers placed after the base prompt (files/tools/cwd/skills).
  append: Array<string | undefined>;
}): string {
  // Most general first: the host's base prompt, the runtime's own working
  // rules, then the host's per-session files — which end with the agent's own
  // authored instructions, the most specific layer and the one that overrides.
  return [
    ...(input.prepend ?? []),
    input.config.systemInstructions,
    TOOL_EXECUTION_SYSTEM_PROMPT,
    dedent`
      <completion_reporting>
      Match completion claims to the evidence. Distinguish implemented changes, checks with observed results, and relevant behavior that remains unverified. Describe code inspection as inspection. Leave unobserved failure causes unknown, or label a proposed cause as a hypothesis. Mention relevant limitations briefly; they do not by themselves justify expanding the user's requested scope.
      </completion_reporting>
    `,
    cwdSystemPrompt(input.config.cwd ?? process.cwd()),
    createSkillsSystemPrompt(input.skills),
    ...input.append,
    ...input.systemPromptFiles,
    currentDateSystemPrompt(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Identity-anchoring layer prepended to every state-machine *sub-agent*
 * (agent-state) system prompt.
 *
 * A state agent is created in `agent` mode and inherits the host's full
 * `systemInstructions` layer — in production, the Duet gateway's developer
 * base prompt (passed via `--system-prompt`), which frames the agent as a
 * conversational assistant inside the Duet product. Nothing else in the base
 * prompt tells the sub-agent it is *not* a live chat assistant, so when its
 * task involves empty threads, missing messages, or repro fixtures about
 * absent user input, the sub-agent can stop treating that material as its
 * *subject* and start treating it as its *own* situation. It then flips into
 * chat-agent mode, hunts for a "missing" user message, and gives up with
 * "I don't see a new message to act on" instead of finishing its task — and a
 * parent that believes that report can cancel the whole relay.
 *
 * This layer re-anchors the sub-agent's identity: its task lives entirely in
 * the prompt it was handed, there is no live thread to service, and any
 * empty-/missing-message material it sees is data to operate on, never a
 * reason to stand down. It is placed *before* `systemInstructions` so the
 * worker identity is the sub-agent's primary role and the inherited product
 * persona reads as secondary context, not the top-level instruction.
 */
export function createStateAgentSystemPromptLayer(context?: {
  definition: StateMachineDefinition;
  currentState: string;
}): string {
  const identity = dedent`
    <state_agent_identity>
    You are a sub-agent executing a single state of a state machine, not a chat assistant in a live conversation. Your complete and only task is the instruction you were handed in this turn's prompt. There is no separate "latest user message" to look for, no thread to pull, and no one to wait on — the prompt IS the task.

    Carry that identity all the way through. If your task references an empty thread, a missing or blank user message, zero tool calls, a quiet channel, or any other kind of absent input — whether in instructions, fixtures, transcripts, logs, or test data — that material is the SUBJECT you are working on, never a description of your own situation. Do not adopt it as your own context, do not conclude there is "nothing to act on," and never reply that you don't see a message to respond to. You always have a task: the one in this prompt.

    Do the task and report what you did and what you found as your final message. If you are genuinely blocked, say exactly what blocked you and what you tried — that is itself completing the task. Standing down because your context resembles an empty chat is the one failure mode that is never correct here.
    </state_agent_identity>
  `;

  const machineContext = context ? createStateAgentMachineContext(context) : undefined;
  return [identity, machineContext].filter(Boolean).join("\n\n");
}

/**
 * Reminder injected at the head of a forked agent state's tail user turn. When
 * `forkContext` is on, the sub-agent is seeded with a verbatim copy of the
 * parent (orchestrator) agent's transcript, so the model opens onto a full
 * conversation it can mistake for its own — concluding it is the parent still
 * mid-turn and continuing that thread instead of running this state. This block
 * draws the line explicitly: everything above is inherited parent context to
 * read, the task is only what follows, and the sub-agent cannot route. It rides
 * in the user turn (not the system prompt) so the forked system prompt stays
 * byte-identical to the parent's and preserves the provider prompt-cache prefix.
 */
export function createForkContextReminder(): string {
  return systemReminder(dedent`
    <system-reminder>
    The conversation above is a copy of the parent (orchestrator) agent's transcript, handed to you only as background context. You are NOT the parent agent and you are not continuing that conversation — you are now a fresh sub-agent running a single state of the state machine. Read the transcript above as reference material about what has happened; do not treat its last message as something you just said or were about to answer. Your one task is the instruction that follows this reminder. Do that task, report what you did and found, and remember you cannot select or route to other states — the orchestrator does that after reading your report.
    </system-reminder>
  `);
}

/** Keep an ask from becoming a terminal while process-bound work is still live. */
export function withheldAskReminder(questions: readonly TurnQuestion[]): string {
  const summary = questions.map((question) => `- ${question.question}`).join("\n");
  return systemReminder(dedent`
    Earlier this turn you called ask_user_question, but the question was NOT
    delivered to the user because background tasks were still running:

    ${summary}

    Those tasks have now settled (details in this message). If the question is
    still relevant, ask it again now; if the settlements answered it, continue
    without asking.
  `);
}

/**
 * Gentle last-chance reminder spent on one extra parent pass when a turn is
 * about to end completed while the machine is still parked. A park that ends
 * the turn is legitimate when the parent is genuinely waiting on the user, but
 * it is also what "I forgot to select the next state" looks like — and the
 * parent is the only one who can tell the two apart. The pass is delivered
 * alongside the standard {@link parkNudge}, which names the parked state, so
 * this text only has to supply the "your turn is ending" framing.
 */
export const PARK_END_OF_TURN_NUDGE = systemReminder(dedent`
  <system-reminder>
  Your turn is about to end with the state machine still parked. If you were
  waiting on the user, that is correct — just reply and end the turn. If you
  meant to keep going and have not selected the next state yet, select it now.
  </system-reminder>
`);

/** Binding reminder attached wherever a parent turn enters or remains in a park. */
export function parkNudge(stateName: string): string {
  return systemReminder(dedent`
    <system-reminder>
    The state machine is parked at "${stateName}". If the purpose of this
    park is fulfilled, select the next state with select_state_machine_state; otherwise
    you may end your turn and the machine stays parked.
    </system-reminder>
  `);
}

/**
 * Situates the sub-agent inside the larger state machine so it scopes its work
 * to the current state instead of trying to deliver the whole process.
 *
 * Without this, a sub-agent only sees its own prompt and the worker identity,
 * so it has no idea other states exist to carry the work forward. A planning
 * state ("draft a plan", "scope the change") then over-reaches and starts
 * implementing — a failure observed most on smaller models — because nothing
 * told it that implementation is a separate downstream state owned by a fresh
 * sub-agent. Listing the machine's overall goal, every state by name and kind,
 * and marking which one is current makes the boundary explicit: do this state's
 * job, report back, and let the orchestrator route to the next state.
 */
function createStateAgentMachineContext(context: {
  definition: StateMachineDefinition;
  currentState: string;
}): string {
  const stateList = context.definition.states
    .map((state) => {
      const marker = state.name === context.currentState ? " ← YOU ARE HERE" : "";
      const when = state.when ? ` — ${state.when}` : "";
      return `- ${state.name} (${state.kind})${when}${marker}`;
    })
    .join("\n");

  return dedent`
    <state_machine_context>
    You are one state in a larger state machine called "${context.definition.name}". Its overall goal is:

    ${context.definition.prompt}

    The full set of states, in definition order, is:
    ${stateList}

    You are executing ONLY the "${context.currentState}" state. Do that state's job and nothing more — the other states exist precisely so that later work is handled by their own fresh sub-agents, and an orchestrator routes between them after reading each report. Do not try to complete downstream states' work yourself: if this state is to plan, scope, or research, stop at planning and report your findings; do not start implementing what a later state is meant to build. Staying inside your state's boundary is what keeps the machine's plan visible and its steps verifiable.

    Treat any instruction in your prompt to "pass through to", "hand off to", "proceed to", "then implement", or otherwise move on to a later step as a cue to FINISH this state and report that it is ready — never as license to perform that later step yourself. The handoff is the orchestrator's job, not yours: you cannot select or run another state, so doing the next state's work here only collapses two states into one and breaks the machine. When your prompt blurs this state into the next, resolve the ambiguity by doing only the part that matches "${context.currentState}" and reporting readiness for what comes after.
    </state_machine_context>
  `;
}

/**
 * The layers appended to the parent (chat) agent's system prompt, after the
 * base prompt and the host's files. Routing guidance travels with the tools it
 * describes: each tool keeps its own description lean and the "when to reach
 * for it" guidance lives here.
 *
 * One function so a rendered preview of the prompt and the live runner can
 * never disagree about which layers a session carries.
 */
export function parentSystemPromptLayers(input: {
  mode: TurnMode;
  session?: TurnState;
  /** Durable memory is wired up, so `recall_memory` exists to reach for. */
  recallMemory: boolean;
  /** The session's tier runs an advisor beside the executor. */
  advisor: boolean;
}): string[] {
  return [
    // `auto` mode is the case that matters most: the agent must decide
    // between todo_write and create_state_machine_definition.
    input.mode === "agent"
      ? undefined
      : createStateMachineSystemPromptLayer({ mode: input.mode, session: input.session }),
    // Description-only steering measurably under-triggers consults on hard
    // tasks.
    input.advisor ? `<advisor>\n${ADVISOR_EXECUTOR_GUIDANCE_LAYER}\n</advisor>` : undefined,
    createMemoryLookupSystemPromptLayer({ recallMemory: input.recallMemory }),
  ].filter((layer): layer is string => Boolean(layer));
}

export function createStateMachineSystemPromptLayer(input: {
  mode: TurnMode;
  session?: TurnState;
}): string {
  const definition =
    typeof input.mode === "object" ? input.mode : input.session?.stateMachine?.definition;
  // A session with no machine gets the routing rule and a pointer: the
  // `relay` skill owns how a machine is built and driven, and is read when one
  // is about to be. A session that is orchestrating gets the rules inline,
  // because it wakes into them turn after turn and would otherwise have to
  // re-read the skill on every wake.
  return [
    "<state_machines>",
    "Use state-machine tools only for explicit time/wait work or when the user explicitly requests a relay/state machine — by asking for one, or by invoking `/relay`, `/goal`, or any skill whose instructions build one; durable execution by itself is not permission to create one.",
    'Use a state machine proactively only for work with an explicit time or waiting requirement: recurring or unbounded tasks ("monitor X", "watch for Y", "every N minutes do Z"), a request to run later, or a fixed future wake. Use a poll for repeating checks and a timer for a single future wake. For ordinary work, including complex, broad, or multi-step investigation and implementation, stay inline or use todo_write unless the user explicitly asks for a relay/state machine. The same explicit relay request permits agent/script states for durable multi-step work. Do not treat "this may take a while" or "do all of X" as permission to create a relay.',
    'In the UI, state machines are surfaced to the user as "relays" — refer to them that way in user-facing replies, while keeping the underlying tool and concept names (state machine, state, transition) intact when discussing implementation.',
    ...(definition === undefined
      ? [
          "Before creating a relay or selecting one of its states, read the `relay` skill: it holds the orchestration rules, the goal loop, and the schedule pattern.",
        ]
      : [
          RELAY_ORCHESTRATION_RULES,
          ...(typeof input.mode === "object"
            ? [
                "You must stay constrained to the explicit state-machine definition unless no state fits.",
              ]
            : []),
          dedent`
            Explicit state-machine definition:

            ${JSON.stringify(definition, null, 2)}

            Only select states by name from this definition. Do not invent state names.
          `,
        ]),
    "</state_machines>",
  ].join("\n\n");
}

/**
 * Where a fact comes from when it is not already in the conversation: a live
 * source, or durable memory through `recall_memory`. One layer because the two
 * halves share a rule — look something up before answering, never invent —
 * and the live source outranks memory wherever both could answer.
 *
 * Motivating failures: the agent confirmed an unsubscribe from a stale
 * rendered observation that was itself a prior hallucination, when the
 * connected CLI would have refuted it instantly; and it answered "I don't
 * remember" to named referents that one `recall_memory` call would have found.
 * The recall half is only rendered when durable memory is wired up, so a
 * session without a store is never told to reach for a tool it lacks.
 */
export function createMemoryLookupSystemPromptLayer(input: { recallMemory: boolean }): string {
  const recall = input.recallMemory
    ? [
        "- `recall_memory`: past conversations with this user. The observations block above carries only headlines; details, exact identifiers, older threads and most of yesterday's work live in the durable store and are only reachable through this tool. Recall BEFORE answering when the user refers to past work (\"what did you do yesterday\", \"didn't we ship Y already?\", a past decision, PR or commitment you see no context for), when they drop a name you are expected to know — a person, a pet, a project or codename, a branch, \"my starter\" — without defining it in this turn, or when a good answer depends on a personal fact you would otherwise have to assume. Never say \"I don't remember\" or \"I don't have access to past sessions\" without querying at least once; if the first query misses, try another phrasing or `expand: true`. Choose `scope`: \"global\" for other sessions, \"session\" for earlier in this conversation, \"all\" when unsure. Skip recall for general world knowledge and for referents the user defines in the current message.",
      ]
    : [];
  return [
    "<memory_lookup>",
    "When you need a fact that is not already in this conversation, never make it up: some lookup comes before the answer. Two kinds exist.",
    "- Live sources: a connected tool, a skill, a file in the working folder. Anything that can change outside this conversation — account state, payments, deploys, file contents, ticket status, integration data, CRM rows — is read from its live source, and a yes/no question about such state (\"did we ship Y?\", \"is Z unsubscribed?\") is never answered from memory alone. When a skill names itself the lookup path for a topic, read its SKILL.md at the listed `path` and run the lookup it documents before answering in that domain. A file in the working folder that plainly holds the ground truth — a data file, a config, a CSV — outranks anything remembered about it.",
    ...recall,
    "A live source outranks memory whenever both could answer. An observation can be stale or wrong, including one you wrote yourself in an earlier turn; if it disagrees with the live source, the live source wins.",
    "</memory_lookup>",
  ].join("\n\n");
}

function createSkillsSystemPrompt(skills: readonly Skill[]): string | undefined {
  // `disableModelInvocation` means "the model may not reach for this on its
  // own", so such a skill is never advertised here. It stays fully usable
  // through the paths that name it explicitly — the user typing `/name`, or a
  // state prompt containing it — because those are invocations, not choices.
  const advertised = skills.filter((skill) => !skill.disableModelInvocation);
  if (advertised.length === 0) {
    return undefined;
  }

  return dedent`
    Available skills (metadata only — \`read\` the SKILL.md at the listed \`path\` to load full instructions when a skill's description matches the task at hand, or to edit the skill itself). A path under \`<duet-builtin>\` is a skill built into Duet rather than a file on disk; \`read\` opens it all the same. Typing \`/<name>\` in a message inlines a skill's instructions for that turn, which is the shortcut:
    ${toXML({
      skills: advertised.map((skill) => ({
        skill: {
          _attrs: { name: skill.name, path: skill.filePath },
          description: skill.description,
        },
      })),
    })}
  `;
}
