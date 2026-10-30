import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildWorkspaceBackup } from '../src/backups/archive'

const destination = resolve(process.argv[2] ?? '/tmp/duet-backup-fixture.zip')
const temporary = await mkdtemp(join(tmpdir(), 'duet-backup-fixture-'))
try {
  const drive = join(temporary, 'drive')
  await mkdir(join(drive, 'empty'), { recursive: true })
  await writeFile(join(drive, '.env'), 'EXAMPLE=fixture-only\n')
  await writeFile(join(drive, 'hello.txt'), 'Complete Drive backup fixture\n')
  await symlink('hello.txt', join(drive, 'hello-link'))
  const backup = buildWorkspaceBackup({
    driveDir: drive,
    capture: {
      backupId: 'fixture',
      workspace: { name: 'Fixture', slug: 'fixture' },
      createdAt: Date.now(),
    },
    records: (async function* () {
      yield {
        path: 'workspace/settings.json',
        body: (async function* () {
          yield Buffer.from('{"purpose":"Backup example"}\n')
        })(),
      }
    })(),
  })
  const sink = Bun.file(destination).writer()
  try {
    for await (const chunk of backup.body) {
      sink.write(chunk)
      await sink.flush()
    }
  } finally {
    await sink.end()
  }
  console.log(JSON.stringify({ destination, summary: await backup.completed }, null, 2))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
