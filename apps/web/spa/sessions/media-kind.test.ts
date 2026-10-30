import { expect, test } from 'bun:test'

import { mediaKind } from './media-kind'

test.each([
  ['animation.gif', 'image'],
  ['photo.jpeg', 'image'],
  ['photo.jpg', 'image'],
  ['photo.png', 'image'],
  ['vector.svg', 'image'],
  ['photo.webp', 'image'],
  ['ANIMATION.GIF', 'image'],
  ['PHOTO.JPEG', 'image'],
  ['PHOTO.JPG', 'image'],
  ['PHOTO.PNG', 'image'],
  ['VECTOR.SVG', 'image'],
  ['PHOTO.WEBP', 'image'],
  ['nested/photo.JpEg?download=1#preview', 'image'],
  ['clip.mov', 'video'],
  ['clip.mp4', 'video'],
  ['clip.webm', 'video'],
  ['CLIP.MOV', 'video'],
  ['CLIP.MP4?download=1#play', 'video'],
  ['CLIP.WEBM', 'video'],
  ['recording.m4a', 'audio'],
  ['recording.mp3', 'audio'],
  ['recording.ogg', 'audio'],
  ['recording.wav', 'audio'],
  ['RECORDING.M4A', 'audio'],
  ['RECORDING.MP3?download=1#listen', 'audio'],
  ['RECORDING.OGG', 'audio'],
  ['RECORDING.WAV', 'audio'],
  ['archive.pdf', 'file'],
  ['README', 'file'],
  ['png', 'file'],
  ['.png', 'file'],
  ['nested/.gitignore?raw=1#top', 'file'],
  ['nested/.preview.png', 'file'],
] as const)('%s resolves to %s', (src, expected) => {
  expect(mediaKind(src)).toBe(expected)
})
