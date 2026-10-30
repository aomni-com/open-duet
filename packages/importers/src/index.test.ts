import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importSessionSnippets, scrubImportedSnippets } from './index'

const PLANTED_KEY = 'sk-proj-' + 'A'.repeat(48)

describe('session importers', () => {
  test('scrubs import snippets before they are handed to a memory writer', () => {
    const [snippet] = scrubImportedSnippets([
      {
        text: `Use ${PLANTED_KEY} for the staging client.`,
        sourceRef: 'fixture.jsonl:1',
      },
    ])

    expect(snippet?.scrubbedText).toContain('[REDACTED]')
    expect(snippet?.scrubbedText).not.toContain(PLANTED_KEY)
    expect(snippet?.scrubbed).toBe(true)
  })

  test('quarantines malformed transcripts and skips known non-dialogue records', async () => {
    const home = await tempHome()
    try {
      const claudeDir = join(home, '.claude', 'projects', 'demo')
      await mkdir(claudeDir, { recursive: true })
      await writeFile(
        join(claudeDir, 'session.jsonl'),
        [
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: 'remember the renewal note' },
          }),
          '{malformed',
          JSON.stringify({ type: 'metadata', value: 123 }),
          JSON.stringify({ event: 'surprise', value: 123 }),
        ].join('\n'),
      )

      const warnings: string[] = []
      const [result] = await importSessionSnippets({
        home,
        sources: ['claude-code'],
        warn: warning => warnings.push(warning),
      })

      expect(result?.snippets).toEqual([
        {
          text: 'remember the renewal note',
          sourceRef: join(claudeDir, 'session.jsonl') + ':1',
        },
      ])
      expect(warnings).toEqual([
        `claude-code: quarantined malformed JSONL record at ${join(claudeDir, 'session.jsonl')}:2`,
        `claude-code: quarantined unknown transcript shape at ${join(claudeDir, 'session.jsonl')}:4`,
      ])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('reads Codex payload-wrapped message records', async () => {
    const home = await tempHome()
    try {
      const codexDir = join(home, '.codex', 'sessions', '2026', '07', '06')
      await mkdir(codexDir, { recursive: true })
      await writeFile(
        join(codexDir, 'session.jsonl'),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'payload wrapped codex note' }],
          },
        }),
      )

      const [result] = await importSessionSnippets({ home, sources: ['codex'] })

      expect(result?.snippets).toEqual([
        {
          text: 'payload wrapped codex note',
          sourceRef: join(codexDir, 'session.jsonl') + ':1',
        },
      ])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('skips Codex response items that are not user or assistant messages', async () => {
    const home = await tempHome()
    try {
      const codexDir = join(home, '.codex', 'sessions', '2026', '07', '06')
      await mkdir(codexDir, { recursive: true })
      await writeFile(
        join(codexDir, 'session.jsonl'),
        [
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'message', role: 'developer', content: 'do not import' },
          }),
          JSON.stringify({
            type: 'response_item',
            payload: { type: 'reasoning', content: 'do not import' },
          }),
          JSON.stringify({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'real assistant note' }],
          }),
        ].join('\n'),
      )
      const warnings: string[] = []
      const [result] = await importSessionSnippets({
        home,
        sources: ['codex'],
        warn: warning => warnings.push(warning),
      })

      expect(result?.snippets.map(snippet => snippet.text)).toEqual(['real assistant note'])
      expect(warnings).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('skips Claude meta and local-command records', async () => {
    const home = await tempHome()
    try {
      const claudeDir = join(home, '.claude', 'projects', 'demo')
      await mkdir(claudeDir, { recursive: true })
      await writeFile(
        join(claudeDir, 'session.jsonl'),
        [
          JSON.stringify({
            type: 'user',
            isMeta: true,
            message: { role: 'user', content: 'meta' },
          }),
          JSON.stringify({
            type: 'user',
            message: {
              role: 'user',
              content: '<local-command-stdout>secret</local-command-stdout>',
            },
          }),
          JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: 'dialogue' },
          }),
        ].join('\n'),
      )
      const warnings: string[] = []
      const [result] = await importSessionSnippets({
        home,
        sources: ['claude-code'],
        warn: warning => warnings.push(warning),
      })

      expect(result?.snippets.map(snippet => snippet.text)).toEqual(['dialogue'])
      expect(warnings).toEqual([])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  test('keeps Claude dialogue text from mixed text and tool records', async () => {
    const home = await tempHome()
    try {
      const claudeDir = join(home, '.claude', 'projects', 'demo')
      await mkdir(claudeDir, { recursive: true })
      await writeFile(
        join(claudeDir, 'session.jsonl'),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'keep this dialogue' },
              { type: 'tool_use', name: 'Bash', input: { command: 'echo secret' } },
            ],
          },
        }),
      )
      const [result] = await importSessionSnippets({ home, sources: ['claude-code'] })

      expect(result?.snippets.map(snippet => snippet.text)).toEqual(['keep this dialogue'])
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})

async function tempHome(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'duet-importers-'))
}
