import { expect, test } from 'bun:test'

import { showingFilesPrompt } from './showing-files-prompt'

test('the renderable formats come from the drive table, not from prose', () => {
  const prompt = showingFilesPrompt({ driveDir: '/home/exedev/drive' })

  // Named because the drive serves them as image/video/audio and the timeline
  // embeds exactly those.
  for (const extension of ['.png', '.svg', '.webp', '.mp4', '.mov', '.mp3', '.wav']) {
    expect(prompt).toContain(`\`${extension}\``)
  }
  // Served and linkable, never embedded — promising a PDF renders inline would
  // teach the agent to expect something the reader will not see.
  expect(prompt).not.toContain('`.pdf`')
})

test('the absolute form it teaches is the live drive path the file route accepts', () => {
  // A bare leading slash is a VM-absolute path on the wire, and the gateway
  // only serves one that starts with its drive directory.
  const prompt = showingFilesPrompt({ driveDir: '/srv/drive' })

  expect(prompt).toContain('`/srv/drive`')
  expect(prompt).not.toContain('/home/exedev')
})
