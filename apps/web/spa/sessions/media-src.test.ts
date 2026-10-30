import { expect, test } from 'bun:test'

import { resolveMediaSrc } from './media-src'

test.each([
  [
    { src: 'photo.png', cwd: '' },
    { mode: 'drive', drivePath: 'photo.png' },
  ],
  [
    { src: 'assets/photo.png', cwd: 'projects/demo' },
    { mode: 'drive', drivePath: 'projects/demo/assets/photo.png' },
  ],
  [
    { src: 'photo.png', cwd: undefined },
    { mode: 'drive', drivePath: 'photo.png' },
  ],
  [
    { src: '/absolute/project/photo.png?raw=1#preview', cwd: 'ignored' },
    { mode: 'drive', drivePath: '/absolute/project/photo.png?raw=1#preview' },
  ],
  [
    { src: 'http://example.com/photo.png?raw=1#preview', cwd: 'ignored' },
    { mode: 'remote', href: 'http://example.com/photo.png?raw=1#preview' },
  ],
  [
    { src: 'https://example.com/photo.png?raw=1#preview', cwd: 'ignored' },
    { mode: 'remote', href: 'https://example.com/photo.png?raw=1#preview' },
  ],
  [
    { src: 'my%20photo.png', cwd: 'projects' },
    { mode: 'drive', drivePath: 'projects/my%20photo.png' },
  ],
  [
    { src: './assets/./photo.png', cwd: './projects/./demo' },
    { mode: 'drive', drivePath: 'projects/demo/assets/photo.png' },
  ],
  // A schema-valid non-canonical cwd resolves like the directory the agent
  // actually ran in.
  [
    { src: 'chart.png', cwd: 'a/../b' },
    { mode: 'drive', drivePath: 'b/chart.png' },
  ],
  // An agent writing a sibling folder writes `../`, and the file it means is
  // an ordinary drive file. Leaving the `..` in produced a path no drive
  // surface can address, so the link died — and took its whole message with
  // it, since naming a file is a render, not a fetch.
  [
    { src: '../photo.png', cwd: 'projects/demo' },
    { mode: 'drive', drivePath: 'projects/photo.png' },
  ],
  [
    { src: '../releases/notes.md', cwd: 'app/engine' },
    { mode: 'drive', drivePath: 'app/releases/notes.md' },
  ],
  // Climbing past the root is NOT clamped to a drive file: the `..` survives,
  // so the path stays unaddressable instead of quietly naming a real one.
  [
    { src: '../../../photo.png', cwd: 'projects/demo' },
    { mode: 'drive', drivePath: '../photo.png' },
  ],
  [
    { src: '.duet/x.png', cwd: undefined },
    { mode: 'drive', drivePath: '.duet/x.png' },
  ],
] as const)('resolves $src from cwd $cwd', (input, expected) => {
  expect(resolveMediaSrc(input)).toEqual(expected)
})
