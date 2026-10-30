import { MEMORY_CLI_CONTRACT, type MemoryRecord, type MemorySource } from '@repo/contract'

import type { DuetCliResult } from '../duet-cli'

export class MockMemoryCli {
  readonly calls: string[][] = []
  private readonly records: MemoryRecord[] = []
  private sequence = 0
  private lockDelayMs = 0

  simulateLockContention(delayMs: number): void {
    this.lockDelayMs = delayMs
  }

  runner = async (argv: string[]): Promise<DuetCliResult> => {
    this.calls.push(argv)
    if (argv[0] === 'memory' && argv[1] === 'add') return await this.add(argv)
    if (argv[0] === 'memory' && argv[1] === 'recall') return await this.recall(argv)
    return fail(MEMORY_CLI_CONTRACT.exitCodes.usage, `unsupported argv: ${argv.join(' ')}`)
  }

  private async add(argv: string[]): Promise<DuetCliResult> {
    const waitMs = Number(requiredFlag(argv, '--wait')) * 1000
    if (this.lockDelayMs > 0) {
      if (waitMs < this.lockDelayMs) {
        return fail(
          MEMORY_CLI_CONTRACT.exitCodes.lockTimeout,
          `memory database locked after ${waitMs}ms`,
        )
      }
      await Bun.sleep(this.lockDelayMs)
      this.lockDelayMs = 0
    }
    const source = sourceFlag(requiredFlag(argv, '--source'))
    const sessionId = optionalFlag(argv, '--session')
    const content = argv.at(-1)
    if (content === undefined || content.startsWith('--')) {
      return fail(MEMORY_CLI_CONTRACT.exitCodes.usage, 'memory add requires content')
    }
    const createdAt = new Date(1_700_000_000_000 + this.sequence).toISOString()
    const observedDate = createdAt.slice(0, 10)
    this.sequence += 1
    const record: MemoryRecord = {
      id: `mem_${this.sequence}`,
      content,
      kind: 'note',
      source,
      priority: 'medium',
      createdAt,
      lastUsedAt: createdAt,
      observedDate,
      ...(sessionId === undefined ? {} : { sessionId }),
      tags: allFlagValues(argv, '--tag'),
      packScore: 1,
    }
    this.records.push(record)
    return ok(record)
  }

  private async recall(argv: string[]): Promise<DuetCliResult> {
    const waitMs = Number(requiredFlag(argv, '--wait')) * 1000
    if (this.lockDelayMs > 0) {
      if (waitMs < this.lockDelayMs) {
        return fail(
          MEMORY_CLI_CONTRACT.exitCodes.lockTimeout,
          `memory database locked after ${waitMs}ms`,
        )
      }
      await Bun.sleep(this.lockDelayMs)
      this.lockDelayMs = 0
    }
    const query = requiredFlag(argv, '--query')
    const limit = Number(requiredFlag(argv, '--limit'))
    const results = this.records
      .map(record => ({
        ...record,
        relevanceScore: scoreMemory(record.content, query),
        lastUsedAt: new Date(1_700_000_100_000).toISOString(),
      }))
      .filter(record => record.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore || a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
    return ok(results)
  }
}

function ok(body: unknown): DuetCliResult {
  return {
    exitCode: MEMORY_CLI_CONTRACT.exitCodes.ok,
    stdout: `${JSON.stringify(body)}\n`,
    stderr: '',
  }
}

function fail(exitCode: number, stderr: string): DuetCliResult {
  return { exitCode, stdout: '', stderr }
}

function requiredFlag(argv: string[], flag: string): string {
  const index = argv.indexOf(flag)
  if (index === -1 || argv[index + 1] === undefined) throw new Error(`missing ${flag}`)
  return argv[index + 1]!
}

function optionalFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

function allFlagValues(argv: string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1] !== undefined) values.push(argv[index + 1]!)
  }
  return values
}

function sourceFlag(value: string): MemorySource {
  if (
    value === 'user' ||
    value === 'agent' ||
    value === 'system' ||
    value === 'api' ||
    value === 'import'
  )
    return value
  throw new Error(`invalid source ${value}`)
}

function scoreMemory(content: string, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const haystack = content.toLowerCase()
  return terms.reduce((score, term) => score + countOccurrences(haystack, term), 0)
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
