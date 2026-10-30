# CLI gate repair: test lifecycle and resource ownership

The root owning-package Docker run had 569 passing tests and 15 failures. All
15 failures were reviewed: twelve memory-query cases and one training-store
case shared PGlite's `window.location.pathname` initialization error; the
advisor-preview case had no stored session fixture; the shutdown process-group
case never reached readiness.

## Verified causes and corrections

The narrow renderer→database Docker pair reproduced the shared-state failure:
`bottom-pinned streaming caps live renderables` passed, then `returns all rows
newest-first when unfiltered` failed with the same PGlite browser-path exception.
OpenTUI's native renderer installs a partial global window shim. Destroying the
renderer leaves that shim behind. Injected renderers bypass the normal CLI
renderer acquisition path, so subsequent tests see a false browser environment.

The product already handles this in `src/tui/renderer-lifecycle.ts`: its real
renderer acquisition restores the prior window immediately after construction.
MemorySession can lazily reopen after idle, and `/clear` starts another Session;
those real paths continue to see normal Bun globals. No speculative production
guard was added. The existing restoration owner is now exported for the fixtures,
and its false claim that test renderers never install the shim is corrected.
The shared test snapshot helper restores the host descriptor through that owner,
plus the global animation callbacks and any pre-existing window animation
property. Its three concrete consumers use the renderer's native onDestroy
callback. Native transcript tests now destroy in finally; resume fixtures also
dispose their session and remove their scratch directory.

The shutdown subprocess still imported the removed Duet-local TurnRunner path.
It now resolves the owned agent entry through Bun's package resolver. It captures
stderr and reports an early child exit rather than disguising a fixture import
failure as a readiness timeout. The detached child and harness are cleaned up
on failures as well as success. Original budgets and signal/group assertions remain.

The advisor fixture's only executable consumer is the CLI route test. The actual
fixture moves from agent to Duet without duplication, and the test resolves it
relative to its module instead of the invoking working directory. Ownership map
correction for the parent's integration: source-inventory.json's
`test/fixtures/advisor-preview/session_fixture/state.json` destination becomes
`packages/duet/test/fixtures/advisor-preview/session_fixture/state.json`.
Fixture bytes are unchanged; SHA-256: `a81be1a1b71160b38209e7e7769b6fde41014b0e97a9ad06315926cfd1768520`.

## Review and gates

write-tests: the shutdown/advisor group reproduced 13 passes and 2 failures before
repair. The renderer/database pair reproduced 1 pass and 1 failure before repair.
The original 15 assertions are preserved and green. A new actual-native-renderer
case preserves an existing host window and animation property descriptors;
disabling its restoration fails for the expected reason, restoring it passes.
There are no skips, relaxed expected values, or increased timeout budgets.

Shape: one existing production restoration owner, one tiny test resource snapshot
helper used by three real fixture consumers; no new production state, auth rule,
factory flag, process registry, or environment knob. Diff review checked failure
cleanup, same-process reuse and original host values. Source README behavior is
unchanged; this receipt owns gate evidence rather than duplicating product docs.
No visible TUI design changed or visual screenshot claim was made. Configured
Codex CLI review remains unavailable; this is the repair owner's closeout review.

Final focused Docker group: 56 passes, 0 failures, 169 assertions across seven files.
Owning CLI types, changed-source/test lint, test formatting and diff checks pass.
Unrelated root WIP source/fixtures copied for testing are excluded from the commit.
Only the approved production export/comment, test repairs, fixture move and this
receipt are committed. The root owner must run the joined owning-package gate
after integration; no full root suite, paid eval, or live resource operation ran.

## Original full-gate failures

```text
(fail) installShutdownHandlers > reaps a TurnRunner-owned process group before RPC-style shutdown exits [5024.71ms]
(fail) duet train file-store management > unions repeatable sources and mutates the first store containing a slug [17.43ms]
(fail) runRouteCommand > prints a read-only advisor preview for the newest stored fixture session [4.72ms]
(fail) MemoryDb.queryObservations > returns all rows newest-first when unfiltered [6.80ms]
(fail) MemoryDb.queryObservations > filters by kind [8.74ms]
(fail) MemoryDb.queryObservations > filters by priority [17.94ms]
(fail) MemoryDb.queryObservations > filters by source kind [4.38ms]
(fail) MemoryDb.queryObservations > filters by sessionId [16.67ms]
(fail) MemoryDb.queryObservations > filters by an inclusive createdAt window [4.84ms]
(fail) MemoryDb.queryObservations > combines filters with AND semantics [17.87ms]
(fail) MemoryDb.queryObservations > returns an empty list when nothing matches [6.02ms]
(fail) duet memory query mode > emits a JSON array of canonical rows, newest-first [17.28ms]
(fail) duet memory query mode > echoes sessionId and filters JSON output by --session [5.36ms]
(fail) duet memory query mode > manual rows carry the manual-bias multiplier in their score [16.87ms]
(fail) duet memory query mode > prints a friendly message when no rows match (table mode) [5.57ms]
```

## Descriptor restoration disabled: red

```text
bun test v1.3.14 (0d9b296a)
$ bash ../../scripts/agent-tests.sh duet test/tui-transcript-cap.test.ts -t "existing host window"
Resolving dependencies
Resolved, downloaded and extracted [2]
$ tsc -p tsconfig.build.json && bun build src/memory/store/index.ts --target=node --format=esm --outfile dist/src/memory-store.js && bun scripts/build-workflow-fixtures.ts
$ rm -rf dist && bun build src/cli-entry.ts --target=bun --outdir=dist

test/tui-transcript-cap.test.ts:
127 |         width: 40,
128 |         height: 10,
129 |         onDestroy: snapshotRendererGlobals(),
130 |       })
131 |       renderer.destroy()
132 |       expect(properties.map(name => Object.getOwnPropertyDescriptor(globalThis, name))).toEqual(
                                                                                              ^
error: expect(received).toEqual(expected)

  [
    {
      "configurable": true,
      "enumerable": false,
      "value": {
        "requestAnimationFrame": [Function],
      },
      "writable": true,
    },
    {
      "configurable": true,
      "enumerable": false,
      "value": [Function],
      "writable": true,
    },
    {
      "configurable": true,
      "enumerable": false,
      "value": [Function],
      "writable": true,
    },
  ]

- Expected  - 0
+ Received  + 0

      at <anonymous> (/work/packages/duet/test/tui-transcript-cap.test.ts:132:89)
(fail) renderer teardown preserves existing host window and animation descriptors [30.43ms]

 0 pass
 2 filtered out
 1 fail
 1 expect() calls
Ran 1 test across 1 file. [1084.00ms]
error: script "test" exited with code 1

```

## Final focused group: green

```text
bun test v1.3.14 (0d9b296a)

test/cli-shutdown.test.ts:
(pass) installShutdownHandlers > calls dispose on SIGINT and exits with 130 [252.37ms]
(pass) installShutdownHandlers > calls dispose on SIGTERM and exits with 143 [204.82ms]
(pass) installShutdownHandlers > force-exits on a second signal without waiting for dispose [241.52ms]
(pass) installShutdownHandlers > reaps a TurnRunner-owned process group before RPC-style shutdown exits [1234.16ms]

test/tui-resume.test.ts:
[?2031h]10;?]11;?[>0q[?25l[s[6n[?1016$p[?2027$p[?2031$p[?1004$p[?2004$p[?2026$p[?u[H]66;w=1; \[6n[H]66;s=2; \[6n[u[s[?1049h[>4;1m[?2027h[?2004h[?1000h[?1002h[?1003h[?1006h[14t[?2026h[?25l[1;1H[38;2;55;65;81m[49m┌──────────────────────────────────────────┐┌──────────────────────────────────┐[2;1H[38;2;55;65;81m[49m│[0m[2;2H[38;2;255;255;255m[49m                                          [0m[2;44H[38;2;55;65;81m[49m││[0m[2;46H[38;2;255;255;255m[49m                                  [0m[2;80H[38;2;55;65;81m[49m│[3;1H[38;2;55;65;81m[49m│[0m[3;2H[38;2;255;255;255m[49m [0m[3;3H[38;2;52;211;153m[49mpackages/duet   ·   playground + [0m[3;36H[38;2;255;255;255m[49m      [0m[3;42H[38;2;255;255;255m[48;2;37;37;39m [0m[3;43H[38;2;255;255;255m[49m [0m[3;44H[38;2;55;65;81m[49m││[0m[3;46H[38;2;255;255;255m[49m [0m[3;47H[38;2;52;211;153m[49mtodos[0m[3;52H[38;2;255;255;255m[49m                            [0m[3;80H[38;2;55;65;81m[49m│[4;1H[38;2;55;65;81m[49m│[0m[4;2H[38;2;255;255;255m[49m [0m[4;3H[38;2;52;211;153m[49mplayground[0m[4;13H[38;2;255;255;255m[49m                             [0m[4;42H[38;2;255;255;255m[48;2;37;37;39m [0m[4;43H[38;2;255;255;255m[49m [0m[4;44H[38;2;55;65;81m[49m││[0m[4;46H[38;2;255;255;255m[49m [0m[4;47H[38;2;107;114;128m[49mEmpty for now. Fills with the [0m[4;77H[38;2;255;255;255m[49m   [0m[4;80H[38;2;55;65;81m[49m│[5;1H[38;2;55;65;81m[49m│[0m[5;2H[38;2;255;255;255m[49m [0m[5;3H[38;2;107;114;128m[49m [0m[5;4H[38;2;255;255;255m[49m                                      [0m[5;42H[38;2;255;255;255m[48;2;37;37;39m [0m[5;43H[38;2;255;255;255m[49m [0m[5;44H[38;2;55;65;81m[49m││[0m[5;46H[38;2;255;255;255m[49m [0m[5;47H[38;2;107;114;128m[49magent's in-turn checklist while [0m[5;79H[38;2;255;255;255m[49m [0m[5;80H[38;2;55;65;81m[49m│[6;1H[38;2;55;65;81m[49m│[0m[6;2H[38;2;255;255;255m[49m what should we work on today?          [0m[6;42H[38;2;255;255;255m[48;2;37;37;39m [0m[6;43H[38;2;255;255;255m[49m [0m[6;44H[38;2;55;65;81m[49m││[0m[6;46H[38;2;255;255;255m[49m [0m[6;47H[38;2;107;114;128m[49mit works on a multi-step task.[0m[6;77H[38;2;255;255;255m[49m   [0m[6;80H[38;2;55;65;81m[49m│[7;1H[38;2;55;65;81m[49m│[0m[7;2H[38;2;255;255;255m[49m [0m[7;3H[38;2;107;114;128m[49m [0m[7;4H[38;2;255;255;255m[49m                                      [0m[7;42H[38;2;255;255;255m[48;2;37;37;39m [0m[7;43H[38;2;255;255;255m[49m [0m[7;44H[38;2;55;65;81m[49m││[0m[7;46H[38;2;255;255;255m[49m                                  [0m[7;80H[38;2;55;65;81m[49m│[8;1H[38;2;55;65;81m[49m│[0m[8;2H[38;2;255;255;255m[49m [0m[8;3H[38;2;125;211;252m[49m   [1]  ▶  scaffold this idea into a [0m[8;40H[38;2;255;255;255m[49m  [0m[8;42H[38;2;255;255;255m[48;2;37;37;39m [0m[8;43H[38;2;255;255;255m[49m [0m[8;44H[38;2;55;65;81m[49m││[0m[8;46H[38;2;255;255;255m[49m                                  [0m[8;80H[38;2;55;65;81m[49m│[9;1H[38;2;55;65;81m[49m│[0m[9;2H[38;2;255;255;255m[49m [0m[9;3H[38;2;125;211;252m[49mworking app[0m[9;14H[38;2;255;255;255m[49m                            [0m[9;42H[38;2;255;255;255m[48;2;37;37;39m [0m[9;43H[38;2;255;255;255m[49m [0m[9;44H[38;2;55;65;81m[49m│└──────────────────────────────────┘[10;1H[38;2;55;65;81m[49m│[0m[10;2H[38;2;255;255;255m[49m [0m[10;3H[38;2;107;114;128m[49m    2   →  pick a tech stack for me[0m[10;38H[38;2;255;255;255m[49m    [0m[10;42H[38;2;255;255;255m[48;2;37;37;39m [0m[10;43H[38;2;255;255;255m[49m [0m[10;44H[38;2;55;65;81m[49m│┌──────────────────────────────────┐[11;1H[38;2;55;65;81m[49m│[0m[11;2H[38;2;255;255;255m[49m [0m[11;3H[38;2;107;114;128m[49m    3   →  audit my dependencies[0m[11;35H[38;2;255;255;255m[49m       [0m[11;42H[38;2;255;255;255m[48;2;37;37;39m [0m[11;43H[38;2;255;255;255m[49m [0m[11;44H[38;2;55;65;81m[49m││[0m[11;46H[38;2;255;255;255m[49m                                  [0m[11;80H[38;2;55;65;81m[49m│[12;1H[38;2;55;65;81m[49m│[0m[12;2H[38;2;255;255;255m[49m [0m[12;3H[38;2;107;114;128m[49m    4   →  what should I build first[0m[12;39H[38;2;255;255;255m[49m   [0m[12;42H[38;2;255;255;255m[48;2;37;37;39m [0m[12;43H[38;2;255;255;255m[49m [0m[12;44H[38;2;55;65;81m[49m││[0m[12;46H[38;2;255;255;255m[49m [0m[12;47H[38;2;52;211;153m[49mrelays[0m[12;53H[38;2;255;255;255m[49m                           [0m[12;80H[38;2;55;65;81m[49m│[13;1H[38;2;55;65;81m[49m│[0m[13;2H[38;2;255;255;255m[49m [0m[13;3H[38;2;107;114;128m[49m [0m[13;4H[38;2;255;255;255m[49m                                      [0m[13;42H[38;2;255;255;255m[48;2;37;37;39m [0m[13;43H[38;2;255;255;255m[49m [0m[13;44H[38;2;55;65;81m[49m││[0m[13;46H[38;2;255;255;255m[49m [0m[13;47H[38;2;107;114;128m[49mNo relay running. Long-running [0m[13;78H[38;2;255;255;255m[49m  [0m[13;80H[38;2;55;65;81m[49m│[14;1H[38;2;55;65;81m[49m│[0m[14;2H[38;2;255;255;255m[49m [0m[14;3H[38;2;107;114;128m[49mtype a number to run, ↑/↓ to highlight,[0m[14;42H[38;2;255;255;255m[48;2;37;37;39m [0m[14;43H[38;2;255;255;255m[49m [0m[14;44H[38;2;55;65;81m[49m││[0m[14;46H[38;2;255;255;255m[49m [0m[14;47H[38;2;107;114;128m[49mprompts (outreach, dev [0m[14;70H[38;2;255;255;255m[49m          [0m[14;80H[38;2;55;65;81m[49m│[15;1H[38;2;55;65;81m[49m│[0m[15;2H[38;2;255;255;255m[49m [0m[15;3H[38;2;107;114;128m[49mor just start typing.[0m[15;24H[38;2;255;255;255m[49m                  [0m[15;42H[38;2;255;255;255m[48;2;37;37;39m [0m[15;43H[38;2;255;255;255m[49m [0m[15;44H[38;2;55;65;81m[49m││[0m[15;46H[38;2;255;255;255m[49m [0m[15;47H[38;2;107;114;128m[49mlifecycle, triage) open one and [0m[15;79H[38;2;255;255;255m[49m [0m[15;80H[38;2;55;65;81m[49m│[16;1H[38;2;55;65;81m[49m│[0m[16;2H[38;2;255;255;255m[49m [0m[16;3H[38;2;107;114;128m[49m✦ 0 skills · /help[0m[16;21H[38;2;255;255;255m[49m                     [0m[16;42H[38;2;154;158;163m[48;2;37;37;39m▄[0m[16;43H[38;2;255;255;255m[49m [0m[16;44H[38;2;55;65;81m[49m││[0m[16;46H[38;2;255;255;255m[49m [0m[16;47H[38;2;107;114;128m[49mrun across sessions.[0m[16;67H[38;2;255;255;255m[49m             [0m[16;80H[38;2;55;65;81m[49m│[17;1H[38;2;55;65;81m[49m│[0m[17;2H[38;2;255;255;255m[49m                                          [0m[17;44H[38;2;55;65;81m[49m││[0m[17;46H[38;2;255;255;255m[49m                                  [0m[17;80H[38;2;55;65;81m[49m│[18;1H[38;2;55;65;81m[49m└──────────────────────────────────────────┘│[0m[18;46H[38;2;255;255;255m[49m                                  [0m[18;80H[38;2;55;65;81m[49m│[19;1H[38;2;255;255;255m[49m                                            [0m[19;45H[38;2;55;65;81m[49m└──────────────────────────────────┘[20;1H[38;2;107;114;128m[49mEnter: send · Shift+Enter: newline · PgUp/[0m[20;43H[38;2;255;255;255m[49m  [0m[20;45H[38;2;55;65;81m[49m┌──────────────────────────────────┐[21;1H[38;2;55;65;81m[49m┌──────────────────────────────────────────┐│[0m[21;46H[38;2;255;255;255m[49m [0m[21;47H[38;2;52;211;153m[49mcontext[0m[21;54H[38;2;255;255;255m[49m                          [0m[21;80H[38;2;55;65;81m[49m│[22;1H[38;2;55;65;81m[49m│[0m[22;2H[38;2;255;255;255m[49m [0m[22;3H[38;2;125;211;252m[49m> [0m[22;5H[38;2;102;102;102m[49mType a message… or hit Ctrl-G if [0m[22;38H[38;2;255;255;255m[49m      [0m[22;44H[38;2;55;65;81m[49m││[0m[22;46H[38;2;255;255;255m[49m [0m[22;47H[38;2;107;114;128m[49m[░░░░░░░░░░░░░░░░░░░░░░░░░]  --%[0m[22;79H[38;2;255;255;255m[49m [0m[22;80H[38;2;55;65;81m[49m│[23;1H[38;2;55;65;81m[49m│[0m[23;2H[38;2;255;255;255m[49m   [0m[23;5H[38;2;102;102;102m[49myou're bored 🦖[0m[23;20H[38;2;255;255;255m[49m                        [0m[23;44H[38;2;55;65;81m[49m││[0m[23;46H[38;2;255;255;255m[49m [0m[23;47H[38;2;251;191;36m[49m■[0m[23;48H[38;2;107;114;128m[49m sys  [0m[23;54H[38;2;125;211;252m[49m■[0m[23;55H[38;2;107;114;128m[49m msg  [0m[23;61H[38;2;167;139;250m[49m■[0m[23;62H[38;2;107;114;128m[49m loc  [0m[23;68H[38;2;52;211;153m[49m■[0m[23;69H[38;2;107;114;128m[49m glb[0m[23;73H[38;2;255;255;255m[49m       [0m[23;80H[38;2;55;65;81m[49m│[24;1H[38;2;55;65;81m[49m└──────────────────────────────────────────┘└──────────────────────────────────┘[0m]12;#ffffff[1 q[22;5H[?25h[?2026l(pass) TUI resume invariance > late attach rebuilds active task lanes without a last terminal [359.62ms]
(pass) TUI resume invariance > --resume <id> skips the starter menu entirely [29.75ms]
(pass) TUI resume invariance > bare boot renders the starter menu [60.17ms]

test/cli-train-store.test.ts:
(pass) duet train file-store management > normalizes store slugs before synthesis and persistence [15.04ms]
(pass) duet train file-store management > persists synthesis as a private store file while keeping source paths in the archive [7.08ms]
(pass) duet train file-store management > unions repeatable sources and mutates the first store containing a slug [4344.49ms]

test/tui-ctrl-c-exit.test.ts:
(pass) TUI Ctrl+C exit state machine > Ctrl+C while a turn is running interrupts instead of quitting [125.44ms]
(pass) TUI Ctrl+C exit state machine > Ctrl+C with text in the composer clears it and stays in the app [89.80ms]
(pass) TUI Ctrl+C exit state machine > Ctrl+C clears multiline composer content [84.29ms]
(pass) TUI Ctrl+C exit state machine > first Ctrl+C on an idle empty composer arms the exit prompt [61.89ms]
(pass) TUI Ctrl+C exit state machine > a second Ctrl+C confirms the exit [63.78ms]
(pass) TUI Ctrl+C exit state machine > Enter confirms the exit while the prompt is showing [62.50ms]
(pass) TUI Ctrl+C exit state machine > any other keystroke cancels the prompt and resumes editing [69.42ms]

test/cli-route.test.ts:
(pass) parseRouteArgs > parses tier, images, JSON, and a multi-word prompt [0.40ms]
(pass) parseRouteArgs > rejects unknown options and missing model values [0.76ms]
(pass) parseRouteArgs > parses transport explanation output without changing the default report [0.04ms]
(pass) parseRouteArgs > parses advisor-preview with an optional stored session id [0.09ms]
(pass) runRouteCommand > prints the stable JSON decision shape with a stubbed classifier [2.78ms]
(pass) runRouteCommand > explains the concrete transport without changing the default output shape [4.22ms]
(pass) runRouteCommand > prints the chat classifier's rationale instead of a distribution [1.78ms]
(pass) runRouteCommand > names both gateway credentials when neither is configured [1.00ms]
(pass) runRouteCommand > surfaces an unknown tier before calling the classifier [0.64ms]
(pass) runRouteCommand > prints a read-only advisor preview for the newest stored fixture session [40.04ms]
(pass) runConfigCommand > exports the built-in table and refuses overwrite without --force [4.01ms]

test/tui-transcript-cap.test.ts:
(pass) transcript renderable cap > bottom-pinned streaming caps live renderables [1148.81ms]
(pass) transcript renderable cap > eviction pauses while scrolled up so history is not yanked [338.91ms]
(pass) renderer teardown preserves existing host window and animation descriptors [2.11ms]

test/cli-memory-query.test.ts:
(pass) MemoryDb.queryObservations > returns all rows newest-first when unfiltered [1259.45ms]
(pass) MemoryDb.queryObservations > filters by kind [1047.01ms]
(pass) MemoryDb.queryObservations > filters by priority [1037.43ms]
(pass) MemoryDb.queryObservations > filters by source kind [1000.41ms]
(pass) MemoryDb.queryObservations > filters by sessionId [977.96ms]
(pass) MemoryDb.queryObservations > filters by an inclusive createdAt window [1114.95ms]
(pass) MemoryDb.queryObservations > combines filters with AND semantics [1030.40ms]
(pass) MemoryDb.queryObservations > returns an empty list when nothing matches [990.86ms]
(pass) duet memory query mode > emits a JSON array of canonical rows, newest-first [1058.82ms]
(pass) duet memory query mode > echoes sessionId and filters JSON output by --session [1076.59ms]
(pass) duet memory query mode > manual rows carry the manual-bias multiplier in their score [1233.17ms]
(pass) duet memory query mode > prints a friendly message when no rows match (table mode) [1193.21ms]
(pass) parseMemoryArgs > bare invocation stays in TUI mode (no query) [0.25ms]
(pass) parseMemoryArgs > --json or any filter flag switches to query mode [0.31ms]
(pass) parseMemoryArgs > parses --type/--kind as the same axis [0.03ms]
(pass) parseMemoryArgs > parses --session as a row filter [0.01ms]
(pass) parseMemoryArgs > accepts the expanded --source union [0.02ms]
(pass) parseMemoryArgs > parses a date-only --from as start-of-day UTC [0.02ms]
(pass) parseMemoryArgs > parses a date-only --to as end-of-day UTC [0.01ms]
(pass) parseMemoryArgs > parses a full datetime --from as UTC [0.11ms]
(pass) parseMemoryArgs > sets the --json flag [0.02ms]
(pass) parseMemoryArgs > parses --wait in seconds [0.03ms]
(pass) parseMemoryArgs > rejects missing or invalid flag values [2.92ms]
(pass) formatMemoryTable > renders a header and one row per observation [0.48ms]
(pass) formatMemoryTable > renders an empty-state line for no rows [0.02ms]

 56 pass
 0 fail
 169 expect() calls
Ran 56 tests across 7 files. [23.23s]

```
