export interface DesktopSize {
  width: number
  height: number
}

export interface DesktopRect extends DesktopSize {
  x: number
  y: number
  scale: number
}

type DesktopContainerElement = Pick<HTMLElement, 'clientWidth' | 'clientHeight'>

/** Reads layout pixels, which remain stable while an ancestor is transformed. */
export function measureDesktopContainer(element: DesktopContainerElement): DesktopSize {
  return { width: element.clientWidth, height: element.clientHeight }
}

/** Fits a fixed-resolution desktop without distortion and never enlarges it. */
export function fitDesktop(container: DesktopSize, screen: DesktopSize): DesktopRect {
  if (container.width <= 0 || container.height <= 0 || screen.width <= 0 || screen.height <= 0) {
    return { x: 0, y: 0, width: 0, height: 0, scale: 0 }
  }

  const scale = Math.min(1, container.width / screen.width, container.height / screen.height)
  const width = screen.width * scale
  const height = screen.height * scale

  return {
    x: (container.width - width) / 2,
    y: (container.height - height) / 2,
    width,
    height,
    scale,
  }
}
