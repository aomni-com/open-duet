import { describe, expect, test } from 'bun:test'

import { fitDesktop, measureDesktopContainer } from './desktop-fit'

const DESKTOP_SCREEN = { width: 1440, height: 900 }

test('container measurement ignores a transformed ancestor', () => {
  const container = {
    clientWidth: 1_054,
    clientHeight: 944,
    getBoundingClientRect: () => ({ width: 1_007, height: 902 }),
  }
  expect(measureDesktopContainer(container)).toEqual({ width: 1_054, height: 944 })
})

describe('fitDesktop', () => {
  test('pads left and right in a container wider than the desktop', () => {
    expect(fitDesktop({ width: 1800, height: 900 }, DESKTOP_SCREEN)).toEqual({
      x: 180,
      y: 0,
      width: 1440,
      height: 900,
      scale: 1,
    })
  })

  test('pads above and below in a container narrower than the desktop', () => {
    expect(fitDesktop({ width: 1440, height: 1100 }, DESKTOP_SCREEN)).toEqual({
      x: 0,
      y: 100,
      width: 1440,
      height: 900,
      scale: 1,
    })
  })

  test('fits small containers without distortion or upscaling', () => {
    for (const container of [
      { width: 720, height: 450 },
      { width: 320, height: 700 },
      { width: 1200, height: 400 },
      { width: 2000, height: 2000 },
    ]) {
      const rect = fitDesktop(container, DESKTOP_SCREEN)
      expect(rect.x).toBeGreaterThanOrEqual(0)
      expect(rect.y).toBeGreaterThanOrEqual(0)
      expect(rect.x + rect.width).toBeLessThanOrEqual(container.width)
      expect(rect.y + rect.height).toBeLessThanOrEqual(container.height)
      expect(rect.width / rect.height).toBe(DESKTOP_SCREEN.width / DESKTOP_SCREEN.height)
      expect(rect.scale).toBeLessThanOrEqual(1)
    }
  })

  test('returns an empty centered rect for an unmeasured container', () => {
    expect(fitDesktop({ width: 0, height: 0 }, DESKTOP_SCREEN)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      scale: 0,
    })
  })
})
