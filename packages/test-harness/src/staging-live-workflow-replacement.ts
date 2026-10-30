import assert from 'node:assert/strict'

import {
  isKnownTimelineEvent,
  SessionCreateResponseSchema,
  SessionInputResponseSchema,
} from '@repo/contract'

import {
  deleteStagingSession,
  warmWorkflowRuntime,
  loadSessionSnapshot,
  waitForSessionHistory,
} from './staging-live-agent-sessions.ts'
import { fnQuery } from './staging-live-env.ts'
import { apiJson, bearer, bearerJson } from './staging-live-http.ts'
import { workspaceIsDeleted } from './staging-live-resource-ledger.ts'
import { readAnnouncedRuntime } from './staging-live-runtime'
import { record, waitForWorkflowRuntime } from './staging-live-workflow-evidence.ts'
import { runWorkspaceBrowserJourney } from './staging-live-workspace-browser.ts'

export async function runWorkflowReplacementJourney(
  options: { onProgress?: (stage: string) => void } = {},
) {
  return await runWorkspaceBrowserJourney({
    journey: 'workflow-replacement',
    label: 'Workflow replacement',
    onProgress: options.onProgress,
    run: async context => {
      const { env, workspace, apiToken, artifacts, ledger, runId, progress } = context
      const base = `${env.apiUrl}/v1/ws/${workspace.slug}/agent/sessions`
      const connection = (await context.convex.query(
        fnQuery('domains/workspaces/provisioning:gatewayConnectionBySlug'),
        {
          internalKey: env.internalKey,
          slug: workspace.slug,
        },
      )) as { vmToken: string; httpsUrl: string }
      assert(connection?.vmToken, 'workspace gateway connection missing')
      await warmWorkflowRuntime(context)
      const runtime = await waitForWorkflowRuntime({
        loadAnnouncement: () =>
          readAnnouncedRuntime({
            apiUrl: env.apiUrl,
            vmToken: connection.vmToken,
            artifacts,
            label: 'replacement runtime manifest',
          }),
        load: () =>
          apiJson<{ runtimeVersion?: string }>(
            `${connection.httpsUrl}/health`,
            { headers: bearer(connection.vmToken) },
            200,
            'replacement runtime health',
            artifacts,
          ),
      })
      await artifacts.writeJson('replacement-runtime.json', runtime)
      const marker = `replacement-completed-${runId}`
      progress('workflow-replacement:start-old-worker')
      const created = SessionCreateResponseSchema.parse(
        await apiJson(
          base,
          {
            method: 'POST',
            headers: bearerJson(apiToken),
            body: JSON.stringify({
              tier: 'balanced',
              prompt: `Create and start this workflow using create_state_machine_definition with exactly ${JSON.stringify(
                {
                  definition: {
                    name: 'Old workflow',
                    prompt: 'Run the hold state and wait for a user steer.',
                    states: [
                      { kind: 'script', name: 'old_hold', command: 'sleep 300' },
                      { kind: 'terminal', name: 'old_done', status: 'completed' },
                    ],
                  },
                  firstState: 'old_hold',
                },
              )}. Leave the script running; wait for my next steer. Do not stop it or finish the turn.`,
            }),
          },
          201,
          'replacement initial session',
          artifacts,
        ),
      )
      const id = created.session.sessionId
      ledger.record({
        kind: 'session',
        id,
        label: `${runId}:workflow-replacement:${id}`,
        cleanup: () => deleteStagingSession(env, workspace.slug, id, apiToken),
        verify: () => workspaceIsDeleted(context.convex, env.internalKey, workspace._id),
      })
      const started = await waitForSessionHistory(env, workspace.slug, id, apiToken, history =>
        history.events.some(
          row =>
            isKnownTimelineEvent(row.event) &&
            ((row.event.type === 'task_started' && row.event.task.name === 'old_hold') ||
              ['complete', 'interrupted', 'ask'].includes(row.event.type)),
        ),
      )
      await artifacts.writeJson('replacement-initial-history.json', started)
      const oldWorker = started.events.find(
        row =>
          isKnownTimelineEvent(row.event) &&
          row.event.type === 'task_started' &&
          row.event.task.name === 'old_hold',
      )
      assert(
        oldWorker &&
          isKnownTimelineEvent(oldWorker.event) &&
          oldWorker.event.type === 'task_started',
        'initial workflow did not start its old worker',
      )
      const oldTaskId = oldWorker.event.task.id
      const replacement = {
        definition: {
          name: 'Replacement workflow',
          prompt: `Run replacement_work, then select replacement_done. Preserve the script output ${marker} in your final answer.`,
          states: [
            { kind: 'script', name: 'replacement_work', command: `printf '%s\\n' '${marker}'` },
            { kind: 'terminal', name: 'replacement_done', status: 'completed' },
          ],
        },
        firstState: 'replacement_work',
        replaceActive: true,
      }
      const steerPrompt = `Change of plan. In this parent pass, first call task_stop with exactly ${JSON.stringify({ id: oldTaskId })}, then call create_state_machine_definition with exactly ${JSON.stringify(replacement)}. Do both calls in order. Do not select a terminal for the old machine. Let the replacement script finish, then select replacement_done. Do not ask questions or stop the new worker.`
      progress('workflow-replacement:stop-and-replace')
      SessionInputResponseSchema.parse(
        await apiJson(
          `${base}/${id}/messages`,
          {
            method: 'POST',
            headers: bearerJson(apiToken),
            body: JSON.stringify({
              behavior: 'steer',
              prompt: steerPrompt,
            }),
          },
          202,
          'replacement live steer',
          artifacts,
        ),
      )
      const history = await waitForSessionHistory(env, workspace.slug, id, apiToken, history =>
        history.events.some(
          row =>
            row.seq > oldWorker.seq && ['complete', 'interrupted', 'ask'].includes(row.event.type),
        ),
      )
      const snapshot = await loadSessionSnapshot(env, workspace.slug, id, apiToken)
      await artifacts.writeJson('replacement-history.json', history)
      await artifacts.writeJson('replacement-snapshot.json', snapshot)
      const stopped = history.events.find(
        row =>
          isKnownTimelineEvent(row.event) &&
          row.event.type === 'task_settled' &&
          row.event.settlement.id === oldTaskId &&
          row.event.settlement.status === 'stopped',
      )
      const installed = history.events.find(
        row =>
          isKnownTimelineEvent(row.event) &&
          row.event.type === 'state_machine' &&
          row.event.stateMachine.definition.name === replacement.definition.name,
      )
      const steer = history.events.find(
        row =>
          isKnownTimelineEvent(row.event) &&
          row.event.type === 'prompt_submitted' &&
          row.event.prompt === steerPrompt,
      )
      assert(steer, 'live steer was not durably recorded')
      const stopReceipt = history.events.find(
        row =>
          row.seq > steer.seq &&
          isKnownTimelineEvent(row.event) &&
          row.event.type === 'step' &&
          row.event.step.type === 'tool_call' &&
          row.event.step.toolName === 'task_stop' &&
          !row.event.step.isError &&
          record(row.event.step.input).id === oldTaskId,
      )
      const createReceipt = history.events.find(
        row =>
          row.seq > steer.seq &&
          isKnownTimelineEvent(row.event) &&
          row.event.type === 'step' &&
          row.event.step.type === 'tool_call' &&
          row.event.step.toolName === 'create_state_machine_definition' &&
          !row.event.step.isError &&
          record(record(row.event.step.input).definition).name === replacement.definition.name,
      )
      assert(
        stopReceipt && createReceipt && stopReceipt.seq < createReceipt.seq,
        'journey did not explicitly task_stop the old worker before replacement creation',
      )
      assert(
        stopped && installed && stopped.seq < installed.seq && createReceipt.seq < installed.seq,
        'journey did not stop the old worker before installing the replacement',
      )
      assert(
        !history.events.some(
          row =>
            row.seq > steer.seq &&
            row.seq < installed.seq &&
            ['complete', 'interrupted', 'ask', 'sleep'].includes(row.event.type),
        ),
        'stop and replacement crossed a turn boundary',
      )
      const replacementWorker = history.events.find(
        row =>
          row.seq > installed.seq &&
          isKnownTimelineEvent(row.event) &&
          row.event.type === 'task_started' &&
          row.event.task.name === 'replacement_work',
      )
      assert(
        replacementWorker &&
          isKnownTimelineEvent(replacementWorker.event) &&
          replacementWorker.event.type === 'task_started',
        'replacement state worker did not start',
      )
      const replacementTaskId = replacementWorker.event.task.id

      assert.equal(
        snapshot.turnStatus,
        'complete',
        'stopped old worker interrupted the replacement turn',
      )
      assert.equal(
        snapshot.machineState?.definition.name,
        replacement.definition.name,
        'final workflow identity changed',
      )
      assert.equal(
        snapshot.machineState?.currentState,
        'replacement_done',
        'replacement terminal state was skipped',
      )
      assert.equal(
        snapshot.machineState?.terminal?.status,
        'completed',
        'replacement workflow did not complete',
      )
      assert(
        history.events.some(
          row =>
            isKnownTimelineEvent(row.event) &&
            row.seq > replacementWorker.seq &&
            row.event.type === 'task_output' &&
            row.event.taskId === replacementTaskId &&
            row.event.chunk.includes(marker),
        ),
        'replacement script never produced its result',
      )
      assert(
        !history.events.some(row => row.seq > installed.seq && row.event.type === 'interrupted'),
        'old worker result interrupted the replacement',
      )
      assert(
        history.events.some(
          row =>
            row.seq > replacementWorker.seq &&
            isKnownTimelineEvent(row.event) &&
            row.event.type === 'task_settled' &&
            row.event.settlement.id === replacementTaskId &&
            row.event.settlement.status === 'completed' &&
            record(row.event.settlement.result).type === 'completed',
        ),
        'replacement state worker did not settle successfully',
      )
      progress('workflow-replacement:completed')
      return {
        sessionId: id,
        oldTaskId,
        replacementTaskId,
        runtimeVersion: runtime.health.runtimeVersion,
        stoppedSeq: stopped.seq,
        replacementSeq: installed.seq,
        marker,
        outcome: snapshot.machineState.terminal.status,
      }
    },
  })
}
