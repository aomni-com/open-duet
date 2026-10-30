import dedent from "dedent";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent";

/**
 * Synthetic marker prefix for built-in skill `filePath`/`baseDir`. Real
 * skills live under a discoverable `baseDir` on disk; built-ins ship
 * inside the package, so the prefix is a virtual sentinel that keeps
 * their paths from colliding with anything on the filesystem and gives
 * humans a clear hint when they appear in logs or `duet skills` output.
 * Built-in detection itself goes through the `BUILT_IN_BY_PATH` map, not
 * a prefix match.
 */
const BUILTIN_PATH_PREFIX = "<duet-builtin>";

export interface BuiltInSkill {
  /** Skill metadata exposed through the standard discovery API. */
  skill: Skill;
  /** Inline SKILL.md body. Returned by `readSkillInstructions`. */
  instructions: string;
}

/**
 * When a relay is built and how it is driven: dividing work into states,
 * carrying facts between them, verifying what a state reports, waiting and
 * human gates, what the user sees, cancelling and finishing. Policy only; the
 * exact call shapes and field meanings are on the tools and their parameters,
 * which this text points at rather than repeats. One owner: the `relay` skill
 * body includes it for a session about to build a machine, and the runtime
 * renders it inline for a session that is orchestrating one.
 */
export const RELAY_ORCHESTRATION_RULES: string = [
  "The tool descriptions and their parameter docs are the exact contract for every call shape and field; read them when building a definition or an override. What follows is when and how to use them.",
  "**You are the orchestrator and you alone route.** You select states; the runner runs each one outside your turn — agent states in a fresh sub-agent context, scripts as commands — then wakes you with a compact result, and you decide every transition. Sub-agents and scripts never route: tell each state what to do and what to report back, and map its report to the next state yourself. Never write a state prompt that says \"route to X if approved\" or \"go to state Y\"; it has no way to do that.",
  "**Dividing the work.** One state per independent unit: when a phase contains several (\"carve ten controller modules\", \"write thirty tests across five files\"), each unit is its own state, not one \"do phase 2\". The machine's states are the visible plan, so do not mirror them in todo_write; todo_write is only for work you will finish yourself this turn. Do not start a long list, do part of it, and hand the rest to \"a fresh session\": when a relay is warranted and the work will not fit one turn, build the machine up front with one state per remaining unit. Size alone never warrants one.",
  "**Carrying facts forward.** Each agent state starts fresh: it sees only the rendered prompt and the input you pass, never a prior state's transcript or output, and neither your reasoning nor your reply text reaches it. So put everything the next state needs — paths, IDs, errors, decisions, summaries — into `decision.input` (when its inputSchema has matching fields) or `decision.override.state.prompt`, on the FIRST select into that state; \"using the findings from the previous step\" means nothing to it. The working directory is the most-missed case: whenever a state works anywhere other than the session cwd (a worktree, clone, sub-package or scratch dir, usually a path an earlier state printed), set that path as the state's `cwd`; writing \"cd into /path\" in the prompt leaves its tools in the wrong tree. Prefer an absolute path for anything outside the session cwd. Set `forkContext: true` only when the state genuinely needs the parent thread's prior discussion and restating it would be lossy.",
  "**A sub-agent's result is a claim, not truth.** It may hallucinate success, skip steps, swallow errors, or report itself lost. Before transitioning, verify: read the files it claims to have changed, run the build/test/lint it claims passed, confirm IDs, paths and counts. If it is wrong or unverifiable, re-select the same state with a corrected prompt or pick a different state; never propagate an unverified claim or relay it as finished. The opposite error too: a self-deprecating result (\"nothing to do here\", \"I don't see a request\") is a claim about the sub-agent's confusion, not proof the state did not run — the runner recorded it as executed when you selected it. Call get_current_state_machine_state, confirm, then advance or re-run with a corrected prompt; never cancel or hand back to the user on the strength of such prose alone. When the user contradicts something you relayed, the user is right and the sub-agent was wrong: restart with a tuned prompt rather than making excuses or taking the work over by hand.",
  "**Tuning a state.** An override on select persists by default, so a tightened sub-agent prompt, a fixed command, or an adjusted cadence sticks for every future run; turn persistence off only for a one-shot probe. To change a future state without running it, use update_state_machine_state; a running or scheduled state is changed by selecting it with an override, because that changes live execution.",
  "**Waiting: poll, timer, park.** A poll is for a checkable condition and must set intervalMs; its command succeeds only when the condition is met, otherwise an always-succeeding command hot-loops instead of waiting. A timer is for a single fixed future wake. A human approval or reply is an event, not a pollable condition: never gate it with a poll and never delegate the question to a state agent — select a park state, ask the user yourself with ask_user_question, and route their later answer to the next state. Park holds the machine without running work or scheduling a wake; re-selecting the same park is legal and keeps it parked. Agent and script states run immediately whenever selected, so never re-select one as an idle loop. Any wait-then-do promise — \"I'll wait N minutes then X\", \"after CI finishes I'll triage Z\" — must be backed by a timer or poll with a follow-up state that does the work, set up before the turn ends; a pure-agent machine runs immediately and skips the wait. For a wait shorter than the schedule floor, wait in your own turn.",
  "**What the user sees.** Only your messages — never a sub-agent's output, the files it touched, or the values it returned. Whenever a state produces something the user should see, restate it yourself in plain text, then advance. While states run in the background the user can keep messaging you: answer questions, status checks and side conversations in plain text without waiting for the machine, and call select_state_machine_state only when the user actually wants to redirect the running work, since selecting a state while another runs replaces it. A \"steer\" message interrupts you immediately; a \"follow_up\" is queued until your turn settles.",
  "**Stopping and finishing.** If the user says stop, cancel, clear, or discontinue the relay, select the auto-injected \"cancelled\" terminal with a reason at once. A machine is one piece of work the session holds, not a mode the session is in: unrelated work the user brings while it runs is simply done inline, and the machine keeps running; new relay-worthy work replaces it with replaceActive. After a terminal you are woken once more with its details: summarize the outcome to the user and let control return to them rather than starting more work. Follow-up is user-driven: when they ask to redo or continue (a standing \"keep going until it is done\" counts), reactivate by selecting a non-terminal state, which clears the prior terminal and runs it live again.",
  "**Before you select,** call get_current_state_machine_state when resuming, after an interruption, when unsure of progress, and before answering any user question about progress, background work or wake status. If currentState is \"interrupted\", find the interrupted state in history and rerun it when appropriate.",
].join("\n\n");

/**
 * Body of the built-in `/relay` skill. Renders into the prompt verbatim
 * inside the standard `<skill>` wrapper when the user types `/relay`
 * anywhere in their message.
 */
const RELAY_INSTRUCTIONS = dedent`
  A relay is a state machine of agent, script, poll, timer, park and terminal
  states, built with \`create_state_machine_definition\` and driven with
  \`select_state_machine_state\`. The system prompt's \`<state_machines>\`
  rule says when one is allowed; \`/relay\` in the user's message is the
  explicit request it names.

  A session holds at most one machine at a time, and the machine never owns the
  conversation: while it runs you keep answering the user normally, and a new
  relay-worthy request replaces it (\`replaceActive: true\`) rather than
  waiting for it.

  - If no state machine is active, create one with states sized to the request.
  - If one is active and the request is about its work, select the next state.
  - If one is active and the request is new relay-worthy work, create the new
    machine with \`replaceActive: true\`.
  - Anything else is answered inline, machine or no machine.

  ## Driving the machine

  ${RELAY_ORCHESTRATION_RULES}

  ## When the request is a goal, not a process

  Some requests have no process to model — just an outcome that must hold
  ("get the suite green", "make this page load under a second"). Those want
  a loop, not a pipeline: a \`park\` state where you do the work yourself,
  an \`agent\` state holding an evaluator sub-agent that judges the result
  against written criteria and answers \`VERDICT: complete\` or
  \`VERDICT: incomplete\` plus the specific gaps, and a terminal you select
  only after a pass you spot-checked. Incomplete sends the machine back to
  the park for another round. Give the evaluator fresh context and the
  criteria — never a summary of what you did, which only teaches it to
  accept your account.

  The built-in \`/goal\` skill is the full write-up of that loop: how to fix
  criteria before you start, how to prompt the judge, and how to stop a loop
  that will not converge. Suggest \`/goal\` when the user's request is
  shaped that way.

  ## Running multiple scheduled tasks (cron-style) in ONE state machine

  Only one state machine can be active per session, so when the user wants
  several recurring jobs ("replace my crons", "run these N tasks on
  different cadences"), do NOT try to spin up one relay per task. Build a
  single master relay that multiplexes them all. This pattern is proven
  in production.

  ### Architecture

  - **Schedule file** (e.g. \`~/.duet/relay/schedule.json\`):
    \`{ "<task>": { "interval": <ms>, "next": <unix-ms>, "kind": "agent"|"script" } }\`.
    This is the only source of truth for "what's due when."
  - **Dispatcher script** (e.g. \`~/.duet/relay/dispatch.sh\`): reads
    \`schedule.json\`, sorted by \`next\` ascending. For every due task:
      - If \`kind: "script"\` (shell-only): run inline inside the dispatcher,
        append output to a bounded log, then bump \`next += interval\` and
        keep looking. The orchestrator never wakes for these.
      - If \`kind: "agent"\` (needs an LLM): write the task name to
        \`next-agent.txt\` and \`exit 0\` (or another code in the poll's
        \`successCodes\`) so the poll completes and the orchestrator wakes.
        Stdout is captured and surfaced as the state output, so echoing
        the task name (or a JSON payload) is a useful debugging signal,
        but the *exit code is what makes the poll succeed*.
      - For known-noisy agents (e.g. inbox triage), pre-check cheaply
        from shell first (e.g. count IMAP unread). If there's nothing to
        do, skip the wake and just bump \`next\`.
    If no due task needed a wake: \`exit 1\` (poll keeps polling).
  - **Log file**: always size-bounded (\`tail -n 500\` rotate, or similar).
    Long-running relays will fill any unbounded log.

  ### State machine shape

  - One \`poll\` state with \`intervalMs\` ≥ the platform floor that runs
    the dispatcher script. \`successCodes: [0]\` so it only wakes the
    orchestrator when an agent task is queued.
  - One \`agent\` state **per agent task** (\`run-inbox\`,
    \`run-growth-report\`, etc.). Each prompt is narrow — just that one
    task's instructions — and ends with the same footer:
      1. Bump \`schedule.json\` for this task (\`while next <= now: next += interval\`).
      2. \`rm -f next-agent.txt\` to clear the signal.
      3. Reply with one terse line of result.
  - A \`stop\` terminal so the operator can cancel cleanly.

  ### Orchestrator loop

  On wake: read \`next-agent.txt\` (the dispatcher wrote which agent is due),
  select the matching \`run-*\` state. After the agent completes, re-select
  \`poll\`. That's it — no scheduling logic in the orchestrator; the
  dispatcher and the agent footers own the math.

  ### Why this works

  - The orchestrator only consumes parent-context tokens when there is
    actual agent work to do. Quiet hours cost zero.
  - Shell tasks and zero-work agent checks run silently inside the poll.
  - Bumping \`next\` with the \`while\` loop catches up automatically if a
    task fell several intervals behind (e.g. after sandbox downtime).
  - One file (\`schedule.json\`) plus one script (\`dispatch.sh\`) is the
    whole surface area; adding a new cron is a single JSON entry and a
    branch in the dispatcher (plus, for agent tasks, one new \`run-*\`
    state).
`;

const RELAY_DESCRIPTION =
  "How to build and drive a relay: a state machine of sub-agent, script, poll, timer and park states. Read before creating one or selecting its states. Ordinary multi-step work stays inline unless it schedules or waits.";

/**
 * Body of the built-in `/goal` skill. A reference pattern, not a prebuilt
 * machine: it teaches the agent to build its own work/evaluate loop so
 * the definition, criteria, and state names fit the goal at hand.
 */
const GOAL_INSTRUCTIONS = dedent`
  The user gave you a goal to drive to completion, not a task to perform
  once, and typing \`/goal\` is their explicit request for a state machine.
  Build one whose loop is: you do the work, an independent sub-agent judges
  whether the goal is actually met, and the machine terminates only when
  that judge says yes. Do not do the work inline and skip the machine: the
  judged loop is what they asked for.

  This is a pattern to instantiate with
  \`create_state_machine_definition\`, not a fixed machine to invoke.
  Name the states, write the criteria, and size the loop to this goal.

  ## The two states (plus a terminal)

  1. **work** — a \`park\` state. Park runs nothing itself; it records that
     you, the main agent, own the next move, so the work happens in your own
     turn with your own tools and full context. Start here, take a complete
     pass at the goal, then select \`evaluate\`. This is also where the
     machine sits whenever a turn ends mid-goal — out of rounds, or waiting
     on the user — so the next turn resumes into the work phase. (If the
     work is better delegated — heavy, isolated, or parallelizable — make
     this an \`agent\` state instead; the loop is identical.)
  2. **evaluate** — an \`agent\` state. A sub-agent that judges, and only
     judges. It never does the work, and it never fixes what it finds.
  3. **goal_met** — a \`terminal\` with status \`"completed"\`, selected
     only on a verified pass.

  \`\`\`json
  {
    "name": "<goal in a few words>",
    "prompt": "Drive <the goal> to completion: work, then evaluate, until the evaluator passes.",
    "states": [
      { "name": "work", "kind": "park",
        "when": "Start here, and return here after every incomplete verdict, to do or fix the work." },
      { "name": "evaluate", "kind": "agent",
        "when": "After each work pass, to judge the goal against its criteria.",
        "prompt": "<the goal verbatim + criteria + verdict format>" },
      { "name": "goal_met", "kind": "terminal", "status": "completed" }
    ]
  }
  \`\`\`

  ## Criteria come first

  Before creating the definition, decide what "done" means, as checks
  someone else could run: the command that must exit 0, the file that must
  contain X, the behavior the user must be able to observe. Subjective
  goals ("make it feel faster", "clean this up") still need observable
  proxies — pick them now, because an unfalsifiable criterion makes the
  loop unterminable. If you cannot state a check for a criterion that
  matters, ask the user before you start.

  ## Writing the evaluator

  - **Fresh context, not forked.** Leave \`forkContext\` off. The judge
    must grade the artifact that exists, not your account of it — your
    narration of your own work is exactly the thing most likely to be
    wrong.
  - **Carry criteria, not history.** Its prompt restates the goal verbatim
    and lists the criteria. It gets no summary of what you tried; that
    only teaches it to accept your framing.
  - **Make it verify.** Instruct it to read the files, run the
    build/tests/command, and reproduce the user's scenario. A verdict
    reached by reading a diff is a guess.
  - **Fix the verdict shape** so the loop can branch on it:
    - \`VERDICT: complete\` — nothing left against the criteria.
    - \`VERDICT: incomplete\` — followed by a numbered list of gaps, each
      naming what is wrong, where, and what would satisfy it. "Needs
      polish" is not a gap; "src/cli/run.ts:88 still ignores --json" is.
  - **Bias it toward finding gaps.** Tell it to look for what a skeptical
    reviewer would reject, and to report a gap when unsure rather than
    passing on the benefit of the doubt.

  ## The loop

  Create the definition with \`firstState: "work"\`, then do a full work
  pass in that same turn and select \`evaluate\` when the pass is done —
  parking is not a reason to stop. From there:

  - **incomplete** → fix every gap, then select \`evaluate\` again. A state
    that completes hands you a pass that must end in a transition, so do the
    fixing in that pass rather than parking first for it — you already hold
    the gaps in your context, and nothing needs threading through state
    input.
  - **complete** → check one or two criteria yourself before you
    terminate. A pass verdict is a claim like any other sub-agent output;
    a judge can hallucinate a pass the same way a worker hallucinates a
    finish. Then select \`goal_met\`.
  - **blocked on the user** → this is what \`work\` is for. Select it, ask
    your question, and end the turn; the machine holds at \`work\` and the
    user's reply resumes the loop.

  ## Don't let the loop spin

  - Keep the criteria fixed across rounds. Re-scoping mid-loop is how a
    loop "passes" without the goal being met; change criteria only with
    the user.
  - If the same gap survives two rounds, your approach is the problem, not
    the effort. Change approach rather than retrying harder.
  - After a few rounds with no pass, or if the verdicts flip-flop, park at
    \`work\` and ask the user with \`ask_user_question\` — the criteria are
    wrong, the goal is underspecified, or the work is blocked.
  - A goal that turns out to be unachievable ends at a \`failed\` terminal
    with the reason recorded. That is a real outcome; an endless loop is
    not.
`;

const GOAL_DESCRIPTION =
  "How to drive a goal to completion: a state machine that loops your own work against an independent sub-agent evaluator and ends only when the evaluator verifies the success criteria. Read it when the user types /goal or asks for a work-and-judge loop; never start one on your own, as with relay.";

function buildBuiltIn(name: string, description: string, instructions: string): BuiltInSkill {
  const baseDir = `${BUILTIN_PATH_PREFIX}/${name}`;
  const filePath = `${baseDir}/SKILL.md`;
  return {
    skill: {
      name,
      description,
      filePath,
      baseDir,
      sourceInfo: createSyntheticSourceInfo(filePath, {
        source: "duet:builtin",
        scope: "user",
        origin: "top-level",
        baseDir,
      }),
      disableModelInvocation: false,
    },
    instructions,
  };
}

/**
 * Registry of built-in skills shipped with the turn runner. They appear
 * in skill discovery alongside user/project skills and can be shadowed
 * by a same-named skill installed under any discovery root.
 */
export const BUILT_IN_SKILLS: readonly BuiltInSkill[] = [
  buildBuiltIn("relay", RELAY_DESCRIPTION, RELAY_INSTRUCTIONS),
  buildBuiltIn("goal", GOAL_DESCRIPTION, GOAL_INSTRUCTIONS),
];

const BUILT_IN_BY_PATH = new Map(
  BUILT_IN_SKILLS.map(({ skill, instructions }) => [skill.filePath, instructions]),
);

/**
 * Return the in-memory SKILL.md body for a built-in skill, or `undefined`
 * when the skill is not a built-in (so the caller can fall back to
 * reading from disk).
 */
export function getBuiltInSkillInstructions(filePath: string): string | undefined {
  return BUILT_IN_BY_PATH.get(filePath);
}

export function isBuiltInSkill(skill: Skill): boolean {
  return BUILT_IN_BY_PATH.has(skill.filePath);
}

/** Snapshot of built-in skills as plain `Skill` records for merging into discovery results. */
export function listBuiltInSkills(): Skill[] {
  return BUILT_IN_SKILLS.map(({ skill }) => skill);
}
