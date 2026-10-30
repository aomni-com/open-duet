// Convex documents are capped at 1 MiB before JSON export. Eight MiB leaves
// room for JSON escaping while preventing one malformed line from growing the
// streaming parser without bound.
const MAX_CONVEX_EXPORT_JSON_LINE_BYTES = 8 * 1024 * 1024

export async function listConvexExportEntries(snapshotPath: string): Promise<ReadonlySet<string>> {
  return new Set(
    (await run(['unzip', '-Z1', snapshotPath])).split('\n').filter(entry => entry.length > 0),
  )
}

export async function countConvexExportRows(snapshotPath: string, entry: string): Promise<number> {
  const child = Bun.spawn(['unzip', '-p', snapshotPath, entry], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let count = 0
  let trailingByte = 10
  for await (const chunk of child.stdout) {
    const bytes = chunk as Uint8Array
    for (const byte of bytes) if (byte === 10) count += 1
    if (bytes.length > 0) trailingByte = bytes[bytes.length - 1]!
  }
  await assertSuccess(
    new Response(child.stderr).text(),
    child.exited,
    `failed to read ${entry} from snapshot`,
  )
  return count + (trailingByte === 10 ? 0 : 1)
}

export async function* readConvexExportRows(
  snapshotPath: string,
  entry: string,
): AsyncGenerator<unknown> {
  const child = Bun.spawn(['unzip', '-p', snapshotPath, entry], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const decoder = new TextDecoder()
  let pending = ''
  let line = 0
  for await (const chunk of child.stdout) {
    pending += decoder.decode(chunk as Uint8Array, { stream: true })
    if (Buffer.byteLength(pending) > MAX_CONVEX_EXPORT_JSON_LINE_BYTES && !pending.includes('\n')) {
      child.kill()
      throw new Error(`${entry} contains a document above the snapshot line limit`)
    }
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      const document = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      line += 1
      if (document.length > 0) yield parseDocument(document, entry, line)
      newline = pending.indexOf('\n')
    }
  }
  pending += decoder.decode()
  if (pending.length > 0) yield parseDocument(pending, entry, line + 1)
  await assertSuccess(
    new Response(child.stderr).text(),
    child.exited,
    `failed to read ${entry} from snapshot`,
  )
}

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: 'pipe', stderr: 'pipe' })
  const stdout = await new Response(child.stdout).text()
  await assertSuccess(new Response(child.stderr).text(), child.exited, `${command[0]} failed`)
  return stdout
}

async function assertSuccess(
  stderrPromise: Promise<string>,
  exitCodePromise: Promise<number>,
  prefix: string,
): Promise<void> {
  const [stderr, exitCode] = await Promise.all([stderrPromise, exitCodePromise])
  if (exitCode !== 0) throw new Error(`${prefix} (${exitCode}): ${stderr.trim()}`)
}

function parseDocument(document: string, entry: string, line: number): unknown {
  if (Buffer.byteLength(document) > MAX_CONVEX_EXPORT_JSON_LINE_BYTES) {
    throw new Error(`${entry} line ${line} exceeds the snapshot line limit`)
  }
  try {
    return JSON.parse(document)
  } catch {
    throw new Error(`${entry} line ${line} is not valid JSON`)
  }
}
