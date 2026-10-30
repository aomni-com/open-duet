import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { GatewayTrainJobReport } from '@repo/contract'

for (const scenario of ['normal', 'lost-response', 'failed'])
  test(`training wakes a sleeping gateway and reports durable progress and terminal states (${scenario})`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'duet-train-report-sync-'))
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, '../../test-fixtures/train-sync.ts'),
        join(root, 'state'),
        join(root, 'drive'),
        scenario,
      ],
      {
        env: { PATH: process.env.PATH, HOME: root },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 15_000,
      },
    )
    const messages: {
      type: string
      url?: string
      reports?: GatewayTrainJobReport[]
      persistedReports?: GatewayTrainJobReport[]
    }[] = []
    const stderr = new Response(child.stderr).text()
    const reading = (async () => {
      let buffer = ''
      for await (const chunk of child.stdout) {
        buffer += new TextDecoder().decode(chunk)
        for (;;) {
          const index = buffer.indexOf('\n')
          if (index < 0) break
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          try {
            messages.push(JSON.parse(line))
          } catch {}
        }
      }
    })()
    async function waitFor(predicate: () => boolean) {
      const deadline = Date.now() + 2_000
      while (!predicate()) {
        if (Date.now() >= deadline)
          throw new Error(
            `Report did not arrive before idle heartbeat: ${JSON.stringify(messages)}`,
          )
        await Bun.sleep(5)
      }
    }
    try {
      await waitFor(
        () =>
          messages.some(message => message.type === 'ready') &&
          messages.some(message => message.type === 'sync'),
      )
      // Let the initial response settle into its real five-minute sleep.
      await Bun.sleep(50)
      if (scenario === 'lost-response') {
        expect(messages.find(message => message.type === 'sync')!.reports).toContainEqual(
          expect.objectContaining({
            jobId: 'previous-job',
            state: 'failed',
            error: 'gateway_restarted',
          }),
        )
      }
      const url = messages.find(message => message.type === 'ready')!.url!
      const start = await fetch(`${url}/v1/train`, {
        method: 'POST',
        headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
        body: JSON.stringify({ files: [{ filename: 'notes.txt', content: 'Fixture notes.' }] }),
      })
      expect(start.status).toBe(202)
      const { jobId } = (await start.json()) as { jobId: string }
      const reported = (phase: string) =>
        messages.find(message =>
          message.reports?.some(report => report.jobId === jobId && report.phase === phase),
        )
      await waitFor(() => reported('training') !== undefined)
      expect(reported('training')!.reports).toContainEqual(
        expect.objectContaining({ jobId, state: 'running', phase: 'training' }),
      )
      const runningReport = reported('training')!.reports!.find(
        report => report.jobId === jobId && report.phase === 'training',
      )!
      await Bun.sleep(50)
      child.stdin.write('finish\n')
      const terminalPhase = scenario === 'failed' ? 'failed' : 'done'
      await waitFor(() => reported(terminalPhase) !== undefined)
      expect(reported(terminalPhase)!.reports).toContainEqual(
        expect.objectContaining({ jobId, state: terminalPhase, phase: terminalPhase }),
      )
      if (scenario === 'failed') {
        expect(reported('failed')!.reports).toContainEqual(
          expect.objectContaining({
            jobId,
            error: expect.stringContaining('Training fixture failed'),
          }),
        )
        const retry = await fetch(`${url}/v1/train`, {
          method: 'POST',
          headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' },
          body: JSON.stringify({
            files: [{ filename: 'retry.txt', content: 'Replacement fixture notes.' }],
          }),
        })
        expect(retry.status).toBe(202)
        const retryJob = (await retry.json()) as { jobId: string }
        await waitFor(() =>
          messages.some(message =>
            message.reports?.some(
              report => report.jobId === retryJob.jobId && report.state === 'done',
            ),
          ),
        )
        expect(messages.flatMap(message => message.reports ?? [])).toContainEqual(
          expect.objectContaining({ jobId: retryJob.jobId, state: 'done', phase: 'done' }),
        )
      }
      if (scenario === 'lost-response') {
        await waitFor(
          () =>
            messages.filter(message =>
              message.reports?.some(report => report.generation === runningReport.generation),
            ).length >= 2,
        )
        expect(
          messages.filter(message =>
            message.reports?.some(report => report.generation === runningReport.generation),
          )[1]!.reports,
        ).toContainEqual(runningReport)
      }
      // Acknowledgements may finish one queued exchange, then the loop must sleep again.
      await Bun.sleep(50)
      const settledPolls = messages.filter(message => message.type === 'sync').length
      await Bun.sleep(100)
      expect(messages.filter(message => message.type === 'sync').length).toBe(settledPolls)
      for (const message of messages.filter(message => message.type === 'sync')) {
        for (const report of message.reports!)
          expect(message.persistedReports).toContainEqual(report)
      }
    } finally {
      child.kill()
      await child.exited
      await reading
      const errors = await stderr
      await rm(root, { recursive: true, force: true })
      if (child.exitCode !== 0 && child.signalCode === null) console.error(errors)
    }
  })
