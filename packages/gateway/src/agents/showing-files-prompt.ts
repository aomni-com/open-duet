import { inlineMediaExtensions } from '@repo/contract'

/**
 * How to put a file in front of the person you are talking to.
 *
 * It exists because nothing else in the stack says it, and the guess an agent
 * makes instead is expensive: reading an image back into the conversation
 * sends the bytes to the model, costs the turn, and shows the reader nothing.
 * One workspace spent a 1.29 MiB tool result doing exactly that (2026-08-17),
 * and the relay journal that carried it jammed for hours.
 *
 * The renderable formats are read from the drive's own type table, so this
 * prose cannot drift from what the timeline actually embeds, and the drive
 * path is the live one, so the absolute form it teaches is the one the file
 * route accepts. This is the only layer that explains file links: the
 * developer prompt says how messages render and leaves files to this.
 */
export function showingFilesPrompt(args: { driveDir: string }): string {
  const list = (kind: 'image' | 'video' | 'audio'): string =>
    inlineMediaExtensions(kind)
      .map(extension => `\`.${extension}\``)
      .join(', ')

  return [
    '# Showing someone a file',
    '',
    'Your messages render as markdown, so a markdown link to a file on the',
    'drive is how a person actually sees it. Reading a file back does not show',
    'it to anyone: the bytes go to you, not to the reader.',
    '',
    `- ${list('image')} render inline as images.`,
    `- ${list('video')} render as a video player, and ${list('audio')} as an audio player.`,
    '- Every other type — PDFs, archives, spreadsheets — becomes a link they',
    '  can open.',
    '',
    'Write it as an ordinary markdown image or link: `![the story ad](ads/story-a.png)`,',
    '`[the report](reports/q3.pdf)`. A plain path resolves against your working',
    `folder; the full path under \`${args.driveDir}\` also works; an \`http(s)\` URL`,
    'is fetched as-is. Percent-encode spaces (`%20`) or wrap the path in `<>` —',
    'a raw space breaks the link silently. A link inside a code block renders',
    'as plain text, so put links in prose.',
    '',
    `Only files under \`${args.driveDir}\` can be shown: nothing in \`/tmp\` or`,
    'elsewhere on the VM reaches the reader, and nothing under a `.duet`',
    'directory does either. The user also browses the drive in the app’s Files',
    'view, so keep outputs in sensible places and leave no scratch clutter.',
  ].join('\n')
}
