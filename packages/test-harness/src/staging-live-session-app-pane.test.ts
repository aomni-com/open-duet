import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { SessionInitialHistorySnapshotSchema } from '@repo/contract'

import { StagingArtifactCollector } from './staging-live-artifacts.ts'
import { StagingResourceLedger } from './staging-live-resource-ledger.ts'
import {
  buildSessionAppPaneMutationPrompt,
  captureAppSourceSnapshot,
  inspectSessionAppMutationHistory,
  recordSessionAppPaneSession,
  verifyRejectedCwdMoves,
} from './staging-live-session-app-pane.ts'

describe('session app pane staging journey', () => {
  test('asks a later session to change Hello data without injecting discovery mechanics', () => {
    const marker = 'SESSION_APP_PANE_AGENT_TASK_run123'

    expect(buildSessionAppPaneMutationPrompt(marker)).toBe(`Add a task named "${marker}" to Hello.`)
    for (const forbidden of ['README', '127.0.0.1', '/api/tasks', 'curl', 'edit', 'source']) {
      expect(buildSessionAppPaneMutationPrompt(marker)).not.toContain(forbidden)
    }
  })

  test('classifies successful ordered README and loopback tool evidence with later narration', () => {
    const marker = 'SESSION_APP_PANE_AGENT_TASK_run123'
    const history = SessionInitialHistorySnapshotSchema.parse({
      events: [
        timelineStep(1, {
          type: 'tool_call',
          toolName: 'exec_command',
          toolCallId: 'read-1',
          input: { cmd: 'sed -n 1,220p welcome/hello-app/README.md' },
          isError: false,
        }),
        timelineStep(2, {
          type: 'tool_call',
          toolName: 'exec_command',
          toolCallId: 'post-1',
          input: {
            cmd: `curl -X POST http://127.0.0.1:3000/api/tasks -d '{"title":"${marker}"}'`,
          },
          isError: false,
        }),
        timelineStep(3, { type: 'text', text: `Added ${marker}; it is visible in Hello.` }),
      ],
    })

    expect(
      inspectSessionAppMutationHistory(history, {
        readmePathSuffix: 'welcome/hello-app/README.md',
        loopbackUrl: 'http://127.0.0.1:3000/api/tasks',
        marker,
      }),
    ).toEqual({
      readReadme: true,
      calledLoopbackApi: true,
      readBeforeCall: true,
      narrated: true,
    })

    const implicitCurlPost = SessionInitialHistorySnapshotSchema.parse({
      events: [
        timelineStep(1, {
          type: 'tool_call',
          toolName: 'exec_command',
          toolCallId: 'read-implicit',
          input: { cmd: 'cat welcome/hello-app/README.md' },
          isError: false,
        }),
        timelineStep(2, {
          type: 'tool_call',
          toolName: 'exec_command',
          toolCallId: 'post-implicit',
          input: {
            cmd: `curl -sS http://127.0.0.1:3000/api/tasks --data '{"title":"${marker}"}'`,
          },
          isError: false,
        }),
        timelineStep(3, { type: 'text', text: 'Done — I added the task to Hello.' }),
      ],
    })
    expect(
      inspectSessionAppMutationHistory(implicitCurlPost, {
        readmePathSuffix: 'welcome/hello-app/README.md',
        loopbackUrl: 'http://127.0.0.1:3000/api/tasks',
        marker,
      }),
    ).toEqual({
      readReadme: true,
      calledLoopbackApi: true,
      readBeforeCall: true,
      narrated: true,
    })

    const failedCall = SessionInitialHistorySnapshotSchema.parse({
      events: [
        timelineStep(1, {
          type: 'tool_call',
          toolName: 'exec_command',
          toolCallId: 'read-1',
          input: { cmd: 'cat welcome/hello-app/README.md' },
          isError: false,
        }),
        timelineStep(2, { type: 'text', text: `Added ${marker}.` }),
        timelineStep(3, {
          type: 'tool_call',
          toolName: 'exec_command',
          toolCallId: 'post-1',
          input: { cmd: `curl -X POST http://127.0.0.1:3000/api/tasks -d '{"title":"${marker}"}'` },
          isError: true,
        }),
      ],
    })
    expect(
      inspectSessionAppMutationHistory(failedCall, {
        readmePathSuffix: 'welcome/hello-app/README.md',
        loopbackUrl: 'http://127.0.0.1:3000/api/tasks',
        marker,
      }),
    ).toEqual({
      readReadme: true,
      calledLoopbackApi: false,
      readBeforeCall: false,
      narrated: false,
    })

    const unrelatedReadme = SessionInitialHistorySnapshotSchema.parse({
      events: [
        timelineStep(1, {
          type: 'tool_call',
          toolName: 'exec_command',
          toolCallId: 'read-unrelated',
          input: { cmd: 'cat welcome/README.md' },
          isError: false,
        }),
        timelineStep(2, {
          type: 'tool_call',
          toolName: 'exec_command',
          toolCallId: 'post-1',
          input: {
            cmd: `curl -X POST http://127.0.0.1:3000/api/tasks -d '{"title":"${marker}"}'`,
          },
          isError: false,
        }),
        timelineStep(3, { type: 'text', text: `Added ${marker}.` }),
      ],
    })
    expect(
      inspectSessionAppMutationHistory(unrelatedReadme, {
        readmePathSuffix: 'welcome/hello-app/README.md',
        loopbackUrl: 'http://127.0.0.1:3000/api/tasks',
        marker,
      }),
    ).toEqual({
      readReadme: false,
      calledLoopbackApi: true,
      readBeforeCall: false,
      narrated: false,
    })

    const readTooLate = SessionInitialHistorySnapshotSchema.parse({
      events: [
        timelineStep(1, {
          type: 'tool_call',
          toolName: 'exec_command',
          toolCallId: 'post-1',
          input: {
            cmd: `curl -X POST http://127.0.0.1:3000/api/tasks -d '{"title":"${marker}"}'`,
          },
          isError: false,
        }),
        timelineStep(2, {
          type: 'tool_call',
          toolName: 'exec_command',
          toolCallId: 'read-late',
          input: { cmd: 'cat welcome/hello-app/README.md' },
          isError: false,
        }),
        timelineStep(3, { type: 'text', text: `Added ${marker}.` }),
      ],
    })
    expect(
      inspectSessionAppMutationHistory(readTooLate, {
        readmePathSuffix: 'welcome/hello-app/README.md',
        loopbackUrl: 'http://127.0.0.1:3000/api/tasks',
        marker,
      }),
    ).toEqual({
      readReadme: true,
      calledLoopbackApi: true,
      readBeforeCall: false,
      narrated: false,
    })
  })

  test('snapshots nested app source while excluding only the exact runtime data file', async () => {
    const entries = [
      fileEntry('server.ts'),
      fileEntry('page.html'),
      fileEntry('tasks.json'),
      fileEntry('src', 'directory'),
    ]
    const nestedEntries = new Map([
      [
        'welcome/hello-app/src',
        [
          fileEntry('src/client.ts'),
          fileEntry('src/tasks.json'),
          fileEntry('src/components', 'directory'),
        ],
      ],
      ['welcome/hello-app/src/components', [fileEntry('src/components/task-row.ts')]],
    ])
    const contents = new Map([
      ['welcome/hello-app/server.ts', 'server-v1'],
      ['welcome/hello-app/page.html', 'page-v1'],
      ['welcome/hello-app/tasks.json', '{"tasks":[]}'],
      ['welcome/hello-app/src/client.ts', 'client-v1'],
      ['welcome/hello-app/src/tasks.json', 'source-fixture-v1'],
      ['welcome/hello-app/src/components/task-row.ts', 'task-row-v1'],
    ])

    const snapshot = await captureAppSourceSnapshot(
      entries,
      async path => new TextEncoder().encode(contents.get(path)!),
      async directoryPath => nestedEntries.get(directoryPath) ?? [],
      new Set(['welcome/hello-app/tasks.json']),
    )

    expect(snapshot).toEqual([
      {
        path: 'welcome/hello-app/page.html',
        digest: '2773906d6aa669b18f3dd3e52c7ff6f7dba3758aaccbea431f3f3ab4c32b33b7',
      },
      {
        path: 'welcome/hello-app/server.ts',
        digest: 'f9d7baa4a3ebe82e727eb61f31c11553a569a1a65cc9f8ad85f387ca3a86c539',
      },
      { path: 'welcome/hello-app/src', digest: 'directory' },
      {
        path: 'welcome/hello-app/src/client.ts',
        digest: 'bd6270e8cd5ca7f49f3b938f1f013dfb5c2118af6efef184afb5c016241527b6',
      },
      { path: 'welcome/hello-app/src/components', digest: 'directory' },
      {
        path: 'welcome/hello-app/src/components/task-row.ts',
        digest: 'cc567ed865a21d236337e8c64e475d1d0c08a5b47d1756d73515516a6d89e8a6',
      },
      {
        path: 'welcome/hello-app/src/tasks.json',
        digest: '9443d96a855acc714542529a4cc407179e4760fa519f807b07701e697f4a2bfc',
      },
    ])
  })

  test('asserts the valid move before exact 422 rejections and preserves the valid cwd', async () => {
    const calls: string[] = []
    const cwd = 'welcome/hello-app'
    const evidence = await verifyRejectedCwdMoves({
      validCwd: cwd,
      garbageCwd: 'welcome/missing-run123',
      escapeCwd: 'outside-welcome',
      loadCwd: async label => {
        calls.push(`get:${label}`)
        return cwd
      },
      postCwd: async (candidate, label) => {
        calls.push(`post:${label}:${candidate}`)
        return label === 'garbage'
          ? { status: 422, body: { error: 'invalid_cwd', reason: 'missing' } }
          : {
              status: 422,
              body: { error: 'invalid_cwd', reason: 'outside_agent_anchor' },
            }
      },
    })

    expect(calls).toEqual([
      'get:valid',
      'post:garbage:welcome/missing-run123',
      'get:after-garbage',
      'post:bound-escape:outside-welcome',
      'get:after-bound-escape',
    ])
    expect(evidence).toEqual({
      garbageStatus: 422,
      cwdAfterGarbage: cwd,
    })
  })

  test('rejects a non-422 or the wrong invalid-cwd reason', async () => {
    const args = {
      validCwd: 'welcome/hello-app',
      garbageCwd: 'welcome/missing',
      escapeCwd: 'outside-welcome',
      loadCwd: async () => 'welcome/hello-app',
    }

    await expect(
      verifyRejectedCwdMoves({
        ...args,
        postCwd: async (_, label) =>
          label === 'garbage'
            ? { status: 409, body: { error: 'invalid_cwd', reason: 'missing' } }
            : {
                status: 422,
                body: { error: 'invalid_cwd', reason: 'outside_agent_anchor' },
              },
      }),
    ).rejects.toThrow('exact HTTP 422')

    await expect(
      verifyRejectedCwdMoves({
        ...args,
        postCwd: async (_, label) => ({
          status: 422,
          body: {
            error: 'invalid_cwd',
            reason: label === 'garbage' ? 'not_a_directory' : 'outside_agent_anchor',
          },
        }),
      }),
    ).rejects.toThrow('missing')

    await expect(
      verifyRejectedCwdMoves({
        ...args,
        postCwd: async (_, label) => ({
          status: 422,
          body: {
            error: 'invalid_cwd',
            reason: label === 'garbage' ? 'missing' : 'not_a_directory',
          },
        }),
      }),
    ).rejects.toThrow('outside_agent_anchor')
  })

  test('registers session disposal in the shared resource ledger', async () => {
    const cleaned: string[] = []
    const ledger = new StagingResourceLedger('run-session-disposal')
    recordSessionAppPaneSession({
      ledger,
      sessionId: 'session-disposal',
      label: 'run-session-disposal:session',
      cleanup: async () => cleaned.push('session-disposal'),
      verify: async () => cleaned.includes('session-disposal'),
    })
    const report = await ledger.cleanupAll()
    expect(report.status).toBe('pass')
    expect(cleaned).toEqual(['session-disposal'])
  })

  test('writes credential-free evidence through the shared artifact redactor', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'session-app-pane-artifacts-'))
    const secret = `duet_sk_${'s'.repeat(32)}`
    try {
      const artifacts = new StagingArtifactCollector(directory, [secret])
      await artifacts.writeJson('journey.json', {
        sessionId: 'session-1',
        mutationSessionId: 'session-2',
        appSlug: 'hello',
        appAnchorPath: 'welcome/hello-app',
        cwdBefore: 'welcome',
        cwdAfter: 'welcome/hello-app',
        garbageStatus: 422,
        cwdAfterGarbage: 'welcome/hello-app',
        terminalMarker: `SESSION_APP_PANE_RECOVERED ${secret}`,
        agentTaskMarker: 'SESSION_APP_PANE_AGENT_TASK_run123',
        timedTaskMarker: 'SESSION_APP_PANE_TIMED_TASK_run123',
        domLatencyMs: 123,
        domLatencyClock: 'response-201',
        paneUrlBefore: 'https://app-staging.duet.so/w/workspace/sessions/session-1',
        paneUrlAfter: 'https://app-staging.duet.so/w/workspace/sessions/session-1',
        sourceUnchanged: true,
        narrated: true,
        screenshotPaths: ['session-app-pane-desktop.png', 'session-app-pane-mobile-chip.png'],
      })

      const artifact = await readFile(path.join(directory, 'journey.json'), 'utf8')
      expect(artifact).not.toContain(secret)
      expect(artifact).toContain('[REDACTED]')
      expect(artifact).toContain('session-app-pane-desktop.png')
      expect(artifact).toContain('SESSION_APP_PANE_TIMED_TASK_run123')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})

function timelineStep(seq: number, step: Record<string, unknown>) {
  return { seq, createdAt: seq, event: { type: 'step', step } }
}

function fileEntry(path: string, type: 'file' | 'directory' = 'file') {
  return {
    name: path.split('/').at(-1)!,
    path: `welcome/hello-app/${path}`,
    type,
    size: 1,
    mtime: '2026-08-01T00:00:00.000Z',
  }
}
