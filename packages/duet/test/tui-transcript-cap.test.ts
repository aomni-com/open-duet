import { describe, expect } from 'bun:test'

import { createTestRenderer } from '@opentui/core/testing'

import { testIfDocker } from '../../agent/test/helpers/docker-only.js'
import { buildLayout } from '../src/tui/layout.js'
import { COLORS } from '../src/tui/theme.js'
import { MAX_TRANSCRIPT_RENDERABLES, TranscriptWriter } from '../src/tui/transcript-writer.js'
import { snapshotRendererGlobals } from './helpers/renderer-globals.js'

/**
 * Regression coverage for the v0.1.171 long-transcript scroll freeze.
 *
 * Root cause: the transcript ScrollBox kept one renderable per line with no
 * bound, and OpenTUI runs a full Yoga layout pass over every child each
 * frame. Once the tree grew to thousands of nodes a single append/render
 * cost ~1s, starving the event loop so mouse-wheel scroll stopped reacting —
 * and because a resumed session replays the whole transcript, it was frozen
 * from the first frame. `TranscriptWriter` now caps the live node count by
 * evicting the oldest renderables while pinned to the bottom.
 *
 * These tests assert the policy, not timing: node count stays bounded under
 * heavy bottom-pinned streaming, and eviction pauses while the user has
 * scrolled up so history they are reading is never yanked out from under them.
 */
describe('transcript renderable cap', () => {
  const CAP = MAX_TRANSCRIPT_RENDERABLES

  testIfDocker('bottom-pinned streaming caps live renderables', async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      onDestroy: snapshotRendererGlobals(),
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })
    try {
      const ui = buildLayout(renderer)
      const writer = new TranscriptWriter(renderer, ui.transcript, {
        getLastSelectionText: () => '',
      })

      // Stream far past the cap through the production append path. Render
      // periodically like a real turn so sticky-bottom geometry stays current.
      for (let i = 0; i < 8000; i++) {
        writer.appendBlock(null, `agent line ${i} the quick brown fox jumps`, COLORS.agent)
        if (i % 500 === 0) await renderOnce()
      }
      await renderOnce()

      expect(ui.transcript.getChildren().length).toBeLessThanOrEqual(CAP)
    } finally {
      renderer.destroy()
    }
  })

  testIfDocker('eviction pauses while scrolled up so history is not yanked', async () => {
    const { renderer, renderOnce } = await createTestRenderer({
      onDestroy: snapshotRendererGlobals(),
      width: 120,
      height: 40,
      kittyKeyboard: true,
    })
    try {
      const ui = buildLayout(renderer)
      const writer = new TranscriptWriter(renderer, ui.transcript, {
        getLastSelectionText: () => '',
      })

      // Fill to the cap while pinned to the bottom.
      for (let i = 0; i < CAP; i++) {
        writer.appendBlock(null, `line ${i}`, COLORS.agent)
        if (i % 500 === 0) await renderOnce()
      }
      await renderOnce()
      const atCap = ui.transcript.getChildren().length
      expect(atCap).toBeLessThanOrEqual(CAP)

      // Scroll up to read history, then append more. Eviction must not trim
      // while scrolled away from the bottom, so the node count exceeds the cap
      // rather than removing the lines the user is reading.
      ui.transcript.scrollTop = 0
      await renderOnce()
      for (let i = 0; i < 600; i++) {
        writer.appendBlock(null, `more ${i}`, COLORS.agent)
      }
      await renderOnce()

      expect(ui.transcript.getChildren().length).toBeGreaterThan(CAP)
    } finally {
      renderer.destroy()
    }
  })
})

testIfDocker(
  'renderer teardown preserves existing host window and animation descriptors',
  async () => {
    const restoreHost = snapshotRendererGlobals()
    const priorFrame = () => 41
    const priorCancel = () => {}
    const hostWindow = {}
    Object.defineProperty(hostWindow, 'requestAnimationFrame', {
      value: priorFrame,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    Object.defineProperty(globalThis, 'window', {
      value: hostWindow,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      value: priorFrame,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      value: priorCancel,
      writable: true,
      configurable: true,
      enumerable: false,
    })
    const properties = ['window', 'requestAnimationFrame', 'cancelAnimationFrame']
    const expectedGlobals = properties.map(name =>
      Object.getOwnPropertyDescriptor(globalThis, name),
    )
    const expectedWindowFrame = Object.getOwnPropertyDescriptor(hostWindow, 'requestAnimationFrame')
    try {
      const { renderer } = await createTestRenderer({
        width: 40,
        height: 10,
        onDestroy: snapshotRendererGlobals(),
      })
      renderer.destroy()
      expect(properties.map(name => Object.getOwnPropertyDescriptor(globalThis, name))).toEqual(
        expectedGlobals,
      )
      expect(Object.getOwnPropertyDescriptor(hostWindow, 'requestAnimationFrame')).toEqual(
        expectedWindowFrame,
      )
    } finally {
      restoreHost()
    }
  },
)
